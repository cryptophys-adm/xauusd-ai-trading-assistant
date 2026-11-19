//+------------------------------------------------------------------+
//| OmegaExecutor.mq5                                                |
//| Local file-exchange Expert Advisor for the Cryptophys Omega      |
//| Broker Bridge (owner decisions 2026-11-09).                      |
//|                                                                  |
//| What it does:                                                    |
//|   - Exchanges files in MQL5/Files/omega/ with the host's         |
//|     omega-bridge daemon (no WebRequest, no DLL imports).         |
//|   - Writes omega/state.json (via omega/state.tmp + FileMove)     |
//|     with terminal connection, account mode/balances, symbol      |
//|     specification, and open positions of this MagicNumber;       |
//|     never includes the account login/number (1.15: an opaque     |
//|     SHA-256 of server and login, account.login_hash, only).      |
//|   - Reads omega/intents.txt and executes each unseen intent id   |
//|     once (tracked in omega/processed.txt across restarts),       |
//|     appending results to omega/results.txt. An id is recorded    |
//|     before its order is sent (at most once), and an intents.txt  |
//|     older than MaxIntentsAgeSeconds is ignored.                  |
//|                                                                  |
//| Authority and sizing:                                            |
//|   - The Omega server (nexus.cryptophys.work/omega) decides when  |
//|     to enter/exit and sizes every trade from the state reported  |
//|     by this executor. This EA performs no strategy or risk       |
//|     sizing of its own, only validating broker volume limits.     |
//|   - Since 1.15 (docs/RFC_ACCOUNT_PROFILES.md §2) it is the last  |
//|     gate: before each open it checks the symbol's trade mode,    |
//|     the stops level, the margin (OrderCalcMargin) and the broker |
//|     (OrderCheck), and before each stop or target change the      |
//|     freeze level. On a failure it refuses with a reason          |
//|     ("refused: margin", ...); it never resizes, never moves a    |
//|     stop.                                                        |
//|                                                                  |
//| WARNING — Do NOT run alongside CryptophysXAUUSD.mq5:             |
//|   - Never attach OmegaExecutor.mq5 on the same trading account   |
//|     as CryptophysXAUUSD.mq5; doing so would cause double         |
//|     execution of H1 decisions.                                   |
//|                                                                  |
//| How it is attached:                                              |
//|   - Automatically via the [StartUp] section of                   |
//|     terminal_gateway.ini managed by omega-bridge                 |
//|     (Expert=OmegaExecutor, Symbol=<the server's gold>, Period=M1)|
//|     manually on a chart profile when OMEGA_TAKE_STARTUP=false.   |
//+------------------------------------------------------------------+
#property copyright "Cryptophys"
#property version   "1.20"

#include <Trade/Trade.mqh>

input long MagicNumber       = 920200; // Magic number for OmegaExecutor orders & positions
input int  SlippagePoints    = 30;     // Max price deviation in points for market execution
input int  StateEverySeconds = 1;      // How often omega/state.json is refreshed on timer (seconds)
input int  MinTickIntervalMs = 250;    // Minimum interval between tick-driven state.json writes (ms)
input int  MaxIntentsAgeSeconds = 30;  // ignore an intents.txt older than this (bridge down, terminal restarted)
// Corpus Oracle (owner 2026-11-11): the broker's closed M1 bars of the traded symbol for the local lane.
input bool CorpusOracleEnabled = true; // write omega/corpus.json once per closed M1 bar
input int  CorpusBars          = 120;  // closed M1 bars kept in corpus.json (10 to 240)
// MT5 fallback, stage 2 (owner 2026-11-11: the AI Worker's input as with TradingView): the broker's M1 bars
// of the macro symbols (silver, oil, the six pairs of the dollar index) and the USD economic calendar.
// Each entry is a base name; "|" lists alternatives (the first that exists at this broker is used, with the
// gold symbol's prefix and suffix, e.g. ".m", tried first). The first name is the base the server knows.
// Off by default since 1.13 (owner 2026-11-12: "seharusnya memang tidak perlu selain XAUUSD saja", "data makro
// dimatikan di mt5"): the broker supplies XAUUSD only. True again writes the macro bars beside it.
input bool   CorpusMacroEnabled = false; // write omega/corpus_macro.json once per closed M1 bar
input string CorpusMacroSymbols = "XAGUSD,USOIL|XTIUSD|WTI|USOUSD|WTIUSD|CL-OIL,EURUSD,USDJPY,GBPUSD,USDCAD,USDSEK,USDCHF";
input int    CorpusMacroBars    = 240;   // closed M1 bars per macro symbol (10 to 240)
input bool   CalendarEnabled    = true;  // write omega/calendar.json (USD, moderate and high importance) every 5 minutes

//--- Profit Protection & Local Risk Management
// Off by default since 1.11 (owner 2026-11-12: "semua dikontrol dari omega bukan EA"): the Omega server
// moves the stop and the target from the key levels and the Decision Engine's quorum power. Turning these
// on again makes this EA move stops on its own, beside Omega.
input bool   AutoBreakEvenEnabled   = false; // Auto SL+ (Break-Even) enabled
input int    BreakEvenTriggerPoints = 150;   // Profit points to lock SL+ (150 pts = $1.50)
input int    BreakEvenLockPoints    = 20;    // Profit points secured in SL+ (20 pts = $0.20)
input bool   TrailingStopEnabled    = false; // Micro Trailing Stop enabled
input int    TrailingStartPoints    = 250;   // Profit points before trailing activates (250 pts = $2.50)
input int    TrailingDistancePoints = 150;   // Distance of trailing stop from current price
input int    TrailingStepPoints     = 30;    // Minimum step to modify trailing SL

//--- Dynamic Volatility & ATR Sizing (Tier-1 SOTA)
input bool   DynamicAtrStopEnabled  = true;  // Adaptive ATR-based SL+ and Trailing Stop
input double AtrMultiplierTrigger   = 1.0;   // Break-even trigger multiplier of ATR (1.0 = 1x ATR)
input double AtrMultiplierTrailing  = 1.5;   // Trailing distance multiplier of ATR (1.5 = 1.5x ATR)

const string OMEGA_EXECUTOR_VERSION = "1.20"; // keep equal to #property version
const string OMEGA_FOLDER    = "omega";
const string STATE_TMP_PATH  = "omega/state.tmp";
const string STATE_JSON_PATH = "omega/state.json";
const string INTENTS_PATH    = "omega/intents.txt";
// 1.17: a gold symbol name the owner set with the connection (omega-bridge 1.4.0+). Since 1.19 only a hint tried
// first, under the same checks as any other symbol.
const string TRADE_SYMBOL_PATH = "omega/trade_symbol.txt";
// 1.19: the reference gold price in USD, written by omega-bridge from each sync. First line "<price>;<ms>" (bridge 1.5.0:
// the time it wrote the file; 1.6.0+: the price's own time, the close of its 5-minute bar). 1.20: then one line per past
// H4 close of the reference, "<close_ms>;<close>", oldest first (bridge 1.6.0+). The server sends none of it while its
// feed runs on this broker's own bars (the MT5 fallback): a broker is never checked against itself.
const string REFERENCE_PATH = "omega/reference.txt";
const string PROCESSED_PATH  = "omega/processed.txt";
const string RESULTS_PATH    = "omega/results.txt";
const string CORPUS_TMP_PATH  = "omega/corpus.tmp";
const string CORPUS_JSON_PATH = "omega/corpus.json";
const string CORPUS_MACRO_TMP_PATH  = "omega/corpus_macro.tmp";
const string CORPUS_MACRO_JSON_PATH = "omega/corpus_macro.json";
const string CALENDAR_TMP_PATH  = "omega/calendar.tmp";
const string CALENDAR_JSON_PATH = "omega/calendar.json";

CTrade   trade;
string   g_processedIds[];
string   g_tradeSymbol = "";
datetime g_lastStateAt = 0;
ulong    g_lastTickWriteMs = 0;
double   g_lastBid = 0.0;
double   g_lastAsk = 0.0;
long     g_lastWriteMs = 0;
datetime g_lastCorpusBar = 0;
datetime g_lastMacroBar = 0;
datetime g_lastCalendarAt = 0;
int      g_atrHandle = INVALID_HANDLE;

//+------------------------------------------------------------------+
//| Gold priced in USD on any broker, found by what it is (1.19)     |
//+------------------------------------------------------------------+
// Owner 2026-11-19: "Harusnya bisa universal apapun broker, nama pair maupun servernya". Until 1.18 a symbol counted
// only when its name was on a list of 13 gold names; a broker that named gold otherwise needed the owner to type it.
// Since 1.19 no name decides. The EA scans every symbol the server offers and a symbol counts only when:
//   1. its profit currency is USD (gold priced in another currency is another instrument);
//   2. its contract is 1 to 100 troy ounces a lot;
//   3. it is not disabled for trading and it has a price;
//   4. its price lies within 2% of the reference gold price the server sends (REFERENCE_PATH). The price is what tells
//      gold from silver, oil, an index or gold in grams; with no fresh reference nothing is chosen.
//   5. (1.20) it has no expiry (a future is not spot gold), and its own past prices follow the reference's past H4
//      closes (PricePathProblem): one price near gold fits other instruments; a price path does not.
// The owner's symbol (TRADE_SYMBOL_PATH) and the chart symbol are tried first, under the same checks. When several
// symbols pass, the one with the smallest spread (relative to its price) is kept, unless their contracts differ (1.20:
// then none is chosen until the owner names one). A chosen symbol is checked against the reference price whenever a
// fresh one exists (1.20) and is dropped when it fails. When none passes, the EA trades nothing
// and opens nothing: state.json carries "symbol_error" with the reason, the symbol block is empty, the corpus is not
// written, and every open intent is refused (closes and stop changes on existing tickets still run).
const double GOLD_CONTRACT_SIZE_MIN = 1.0;
const double GOLD_CONTRACT_SIZE_MAX = 100.0;
const double GOLD_PRICE_TOLERANCE   = 0.02;
const int    REFERENCE_MAX_AGE_SEC  = 1200;  // 1.20: a price whose own time is more than 20 minutes old is no reference
const int    SCAN_EVERY_SEC         = 30;    // an unresolved server is scanned at most every 30 seconds
const double PATH_TOLERANCE         = 0.005; // 1.20: each past close, relative to the newest, within 0.5% of the reference's
const int    PATH_MIN_POINTS        = 6;     // 1.20: at least six matched past closes to accept a price path
const int    PATH_WINDOW_SEC        = 4500;  // 1.20: the symbol's M5 closes within 75 minutes of each reference close
                                             // (covers a server clock an hour off across a DST change)
const int    PATH_MIN_SPAN_SEC      = 43200; // 1.20: the matched points span at least 12 hours (several sessions)
// 1.20: the symbol verified by the full check, kept across restarts (an EA restart without a reference, in the MT5
// fallback, the daily break or the weekend, keeps trading the symbol it had): "<login hash>;<symbol>;<contract>;<utc>".
const string VERIFIED_PATH          = "omega/verified_symbol.txt";
string g_symbolError = "";
string g_ownerSymbol = "";        // 1.17: the owner-set gold symbol (TRADE_SYMBOL_PATH), or ""
datetime g_ownerSymbolReadAt = 0;
double   g_refPrice = 0.0;        // 1.19: the reference gold price in USD, 0 when none or stale
datetime g_refReadAt = 0;
datetime g_lastScanAt = 0;
string   g_scanSelected = ";";    // 1.19: symbols the scan added to Market Watch (";A;B;"), removed again when not gold
long     g_refT[];                // 1.20: the reference's past H4 closes: their times (UTC ms), oldest first
double   g_refC[];                // 1.20: and their prices
bool     g_restoreTried = false;  // 1.20: the verified symbol is restored once per EA run

// Reads REFERENCE_PATH at most every 10 seconds. 1.20: a price whose time (the second field) is more than
// REFERENCE_MAX_AGE_SEC old is dropped, with its past closes; the closes follow on the next lines.
void LoadReferencePrice()
  {
   if(g_refReadAt != 0 && TimeGMT() - g_refReadAt < 10) return;
   g_refReadAt = TimeGMT();
   double price = 0.0;
   long priceMs = 0;
   ArrayResize(g_refT, 0);
   ArrayResize(g_refC, 0);
   if(FileIsExist(REFERENCE_PATH))
     {
      int h = FileOpen(REFERENCE_PATH, FILE_READ | FILE_TXT | FILE_ANSI);
      if(h != INVALID_HANDLE)
        {
         int lineNo = 0;
         while(!FileIsEnding(h) && lineNo < 64)
           {
            string line = FileReadString(h);
            string parts[];
            if(StringSplit(line, ';', parts) >= 2)
              {
               if(lineNo == 0)
                 {
                  price = StringToDouble(parts[0]);
                  priceMs = StringToInteger(parts[1]);
                 }
               else
                 {
                  long t = StringToInteger(parts[0]);
                  double c = StringToDouble(parts[1]);
                  if(t > 0 && c > 0.0)
                    {
                     int k = ArraySize(g_refC);
                     ArrayResize(g_refT, k + 1);
                     ArrayResize(g_refC, k + 1);
                     g_refT[k] = t;
                     g_refC[k] = c;
                    }
                 }
              }
            lineNo++;
           }
         FileClose(h);
        }
     }
   long nowMs = (long)TimeGMT() * 1000;
   bool fresh = price > 0.0 && priceMs > 0 && nowMs - priceMs <= (long)REFERENCE_MAX_AGE_SEC * 1000;
   g_refPrice = fresh ? price : 0.0;
   if(!fresh) { ArrayResize(g_refT, 0); ArrayResize(g_refC, 0); }
  }

// 1.20: "" when the symbol's own past prices follow the reference's, else the reason. For each past H4 close of the
// reference, the symbol's M5 closes within PATH_WINDOW_SEC of it give a range; a point without any (the broker closed,
// or its history is still loading) is skipped. With at least PATH_MIN_POINTS points over PATH_MIN_SPAN_SEC: the
// symbol's level is the median of range-middle / reference (within 2% of 1), and each reference close at that level
// must fall in its range (widened by PATH_TOLERANCE). One price near gold fits other instruments; a path does not
// (orchestrator review of 1.19 and of 1.20).
string PricePathProblem(const string sym)
  {
   int n = ArraySize(g_refC);
   if(n < PATH_MIN_POINTS) return "no_reference_path";
   long offsetSec = (long)(TimeTradeServer() - TimeGMT());   // the server's clock against UTC, today's
   double lo[], hi[], rc[];
   long rt[];
   ArrayResize(lo, n); ArrayResize(hi, n); ArrayResize(rc, n); ArrayResize(rt, n);
   int m = 0;
   for(int i = 0; i < n; i++)
     {
      datetime t = (datetime)(g_refT[i] / 1000 + offsetSec);
      double closes[];
      int got = CopyClose(sym, PERIOD_M5, t - PATH_WINDOW_SEC, t + PATH_WINDOW_SEC, closes);
      if(got <= 0) continue;
      double l = closes[0], h = closes[0];
      for(int j = 1; j < got; j++) { l = MathMin(l, closes[j]); h = MathMax(h, closes[j]); }
      if(l <= 0.0) continue;
      lo[m] = l; hi[m] = h; rc[m] = g_refC[i]; rt[m] = g_refT[i];
      m++;
     }
   if(m < PATH_MIN_POINTS || (rt[m - 1] - rt[0]) / 1000 < PATH_MIN_SPAN_SEC) return "no_history";
   double k[];
   ArrayResize(k, m);
   for(int i = 0; i < m; i++) k[i] = ((lo[i] + hi[i]) / 2.0) / rc[i];
   ArraySort(k);
   double scale = (m % 2 == 1) ? k[m / 2] : (k[m / 2 - 1] + k[m / 2]) / 2.0;
   if(MathAbs(scale - 1.0) > GOLD_PRICE_TOLERANCE) return "price_path_mismatch";
   for(int i = 0; i < m; i++)
     {
      double x = rc[i] * scale;
      if(x < lo[i] * (1.0 - PATH_TOLERANCE) || x > hi[i] * (1.0 + PATH_TOLERANCE)) return "price_path_mismatch";
     }
   return "";
  }

// 1.20: remember the symbol the full check verified, for this login only (its hash, never the login).
void SaveVerifiedSymbol(const string sym)
  {
   int h = FileOpen(VERIFIED_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, AccountLoginHash() + ";" + sym + ";" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 4) + ";" + IntegerToString((long)TimeGMT()) + "\n");
   FileClose(h);
  }

// 1.20: the verified symbol of this login when it still exists with the same contract and passes the checks that need
// no reference; "" otherwise. It is then kept under the keep rule and checked again at the first fresh reference.
// `retry` is set while the answer cannot be known yet (right after a restart: the terminal not connected, no tick yet),
// so the one restore of the run is not spent then.
string RestoreVerifiedSymbol(bool &retry)
  {
   retry = false;
   if(!FileIsExist(VERIFIED_PATH)) return "";
   int h = FileOpen(VERIFIED_PATH, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return "";
   string line = FileIsEnding(h) ? "" : FileReadString(h);
   FileClose(h);
   string parts[];
   if(StringSplit(line, ';', parts) < 3) return "";
   string login = AccountLoginHash();
   if(login == "" || parts[0] != login) return "";
   string sym = parts[1];
   if(sym == "" || !SymbolInfoInteger(sym, SYMBOL_EXIST)) return "";
   if(MathAbs(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE) - StringToDouble(parts[2])) > 1e-6) return "";
   string p = GoldSymbolProblem(sym, false, false);
   if(p == "no_price") { retry = true; return ""; }
   if(p != "") return "";
   return sym;
  }

// 1.17: reads TRADE_SYMBOL_PATH at most every 10 seconds. A name with characters MT5 never uses is ignored.
void LoadOwnerSymbol()
  {
   if(g_ownerSymbolReadAt != 0 && TimeGMT() - g_ownerSymbolReadAt < 10) return;
   g_ownerSymbolReadAt = TimeGMT();
   string name = "";
   if(FileIsExist(TRADE_SYMBOL_PATH))
     {
      int h = FileOpen(TRADE_SYMBOL_PATH, FILE_READ | FILE_TXT | FILE_ANSI);
      if(h != INVALID_HANDLE)
        {
         if(!FileIsEnding(h)) name = FileReadString(h);
         FileClose(h);
        }
     }
   StringTrimLeft(name);
   StringTrimRight(name);
   bool safe = StringLen(name) >= 1 && StringLen(name) <= 32;
   for(int i = 0; safe && i < StringLen(name); i++)
     {
      ushort c = StringGetCharacter(name, i);
      safe = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' || c == '#' || c == '+';
     }
   if(!safe) name = "";
   if(name != g_ownerSymbol)
     {
      PrintFormat("OmegaExecutor: owner gold symbol %s", name == "" ? "(none: found by contract and price)" : name);
      g_ownerSymbol = name;
      g_tradeSymbol = "";   // resolve again
     }
  }

// "" when `sym` is gold priced in USD that this EA may trade, else the reason it is refused. No name is checked.
// checkPrice: the bid against the reference price; checkPath (1.20): the symbol's own past prices against the
// reference's (PricePathProblem), required to choose a symbol. A chosen symbol is checked again with the price whenever
// a fresh reference exists, and keeps its place only while there is none (a feed outage, a weekend, the MT5
// fallback), because its contract has not changed. The server also refuses every open whose broker price is more than
// 2% from the signal's price.
string GoldSymbolProblem(const string sym, const bool checkPrice = true, const bool checkPath = true)
  {
   if(sym == "") return "no_symbol";
   if(!SymbolInfoInteger(sym, SYMBOL_EXIST)) return "not_on_server";
   if(SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT) != "USD") return "profit_currency_not_usd";
   double size = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   if(size < GOLD_CONTRACT_SIZE_MIN || size > GOLD_CONTRACT_SIZE_MAX) return "contract_size_out_of_range";
   if(SymbolInfoInteger(sym, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) return "trade_disabled";
   // 1.20: a contract with an expiry (a future) is not spot gold: its price drifts from spot and it rolls.
   if(SymbolInfoInteger(sym, SYMBOL_EXPIRATION_TIME) > 0) return "expiring_contract";
   if(!SymbolInfoInteger(sym, SYMBOL_SELECT)) SymbolSelect(sym, true); // a price needs Market Watch
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   if(bid <= 0.0) return "no_price";
   if(!checkPrice) return "";
   LoadReferencePrice();
   if(g_refPrice <= 0.0) return "no_reference_price";
   if(MathAbs(bid - g_refPrice) / g_refPrice > GOLD_PRICE_TOLERANCE) return "price_not_gold";
   if(!checkPath) return "";
   return PricePathProblem(sym);
  }

// The spread relative to the price, to choose between several symbols that pass (smaller is better).
double RelativeSpread(const string sym)
  {
   double bid = SymbolInfoDouble(sym, SYMBOL_BID), ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   return bid > 0.0 && ask >= bid ? (ask - bid) / bid : 1.0;
  }

// The gold symbol to trade, or "" (then g_symbolError says why). Never falls back to a symbol that fails the checks.
string ResolveGoldSymbol()
  {
   LoadOwnerSymbol();
   // 1.20: after a restart, the symbol verified before (this login, same contract), unless the owner names another.
   if(g_tradeSymbol == "" && !g_restoreTried && TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      bool retry = false;
      string r = RestoreVerifiedSymbol(retry);
      if(!retry) g_restoreTried = true;   // tried again on a later call while the symbol has no price yet
      if(r != "" && (g_ownerSymbol == "" || g_ownerSymbol == r))
        {
         g_tradeSymbol = r;
         PrintFormat("OmegaExecutor: %s restored (verified before this restart; checked again at the next fresh reference)", r);
        }
     }
   // 1.20: a chosen symbol is checked against the reference price whenever a fresh one exists (orchestrator review of
   // 1.19: it was never checked again); without one it keeps its place.
   LoadReferencePrice();
   string keepProblem = g_tradeSymbol != "" ? GoldSymbolProblem(g_tradeSymbol, g_refPrice > 0.0, false) : "no_symbol";
   if(g_tradeSymbol != "" && keepProblem == "")
     {
      g_symbolError = "";
      return g_tradeSymbol;
     }
   // A passing state (no tick yet, trading paused for broker maintenance) keeps the symbol in memory: nothing opens
   // meanwhile (the refusal says why), and it trades again when the state passes, with or without a reference.
   if(g_tradeSymbol != "" && (keepProblem == "no_price" || keepProblem == "trade_disabled"))
     {
      g_symbolError = "no_usd_gold_symbol (" + g_tradeSymbol + ":" + keepProblem + ")";
      return "";
     }
   // The verified symbol is forgotten only when it is shown not to be gold any more (its price against a fresh
   // reference, or its contract), never for a passing state such as no tick yet or trading paused.
   if(g_tradeSymbol != "" && (keepProblem == "price_not_gold" || keepProblem == "not_on_server" || keepProblem == "profit_currency_not_usd"
      || keepProblem == "contract_size_out_of_range" || keepProblem == "expiring_contract"))
      FileDelete(VERIFIED_PATH);

   string lastProblem = "no_usd_gold_symbol";
   // The owner's symbol first (a hint), then the chart symbol, under the same checks.
   string firsts[2];
   firsts[0] = g_ownerSymbol;
   firsts[1] = _Symbol;
   for(int f = 0; f < 2; f++)
     {
      if(firsts[f] == "") continue;
      string p = GoldSymbolProblem(firsts[f]);
      if(p == "")
        {
         g_tradeSymbol = firsts[f];
         g_symbolError = "";
         SaveVerifiedSymbol(g_tradeSymbol);
         return g_tradeSymbol;
        }
      lastProblem = firsts[f] + ":" + p;
     }
   // Then every symbol on the server, at most every SCAN_EVERY_SEC seconds while none is found. Without a reference
   // price nothing can be told apart, so nothing is scanned (and nothing is added to Market Watch).
   LoadReferencePrice();
   if(g_refPrice <= 0.0)
      lastProblem = "no_reference_price";
   else if(g_lastScanAt == 0 || TimeGMT() - g_lastScanAt >= SCAN_EVERY_SEC)
     {
      g_lastScanAt = TimeGMT();
      string best = "";
      double bestSpread = 0.0;
      // 1.20: every symbol that passes, with its contract: several with different contracts are not told apart by
      // spread; the owner names one (the account's gold symbol with the connection, tried first above).
      int passed = 0;
      double firstSize = 0.0;
      bool sizesDiffer = false;
      string passing = "";
      int total = SymbolsTotal(false);
      for(int i = 0; i < total; i++)
        {
         string c = SymbolName(i, false);
         if(c == "" || c == firsts[0] || c == firsts[1]) continue;
         // Cheap checks first, so only plausible symbols are added to Market Watch for a price.
         if(SymbolInfoString(c, SYMBOL_CURRENCY_PROFIT) != "USD") continue;
         double size = SymbolInfoDouble(c, SYMBOL_TRADE_CONTRACT_SIZE);
         if(size < GOLD_CONTRACT_SIZE_MIN || size > GOLD_CONTRACT_SIZE_MAX) continue;
         if(SymbolInfoInteger(c, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) continue;
         if(!(bool)SymbolInfoInteger(c, SYMBOL_SELECT) && StringFind(g_scanSelected, ";" + c + ";") < 0)
            g_scanSelected += c + ";";   // GoldSymbolProblem adds it to Market Watch for a price
         string p = GoldSymbolProblem(c);
         if(p == "")
           {
            passed++;
            if(passed == 1) firstSize = size;
            else if(MathAbs(size - firstSize) > 1e-9) sizesDiffer = true;
            if(StringLen(passing) < 120) passing += (passing == "" ? "" : ",") + c + ":" + DoubleToString(size, 0);
            double sp = RelativeSpread(c);
            if(best == "" || sp < bestSpread) { best = c; bestSpread = sp; }
           }
         else if((p == "price_not_gold" || p == "price_path_mismatch") && StringFind(g_scanSelected, ";" + c + ";") >= 0)
           {
            // Not gold, and the scan added it: leave Market Watch as it was. A symbol without a price yet
            // ("no_price") stays until the next scan has its price.
            SymbolSelect(c, false);
            StringReplace(g_scanSelected, ";" + c + ";", ";");
           }
        }
      if(best != "" && sizesDiffer)
        {
         lastProblem = "ambiguous_gold_symbols (" + passing + "): name one with the connection";
         best = "";
        }
      if(best != "")
        {
         if(best != g_tradeSymbol) PrintFormat("OmegaExecutor: gold priced in USD on this server is %s (found by its contract, price and price path)", best);
         g_tradeSymbol = best;
         g_symbolError = "";
         SaveVerifiedSymbol(g_tradeSymbol);
         return g_tradeSymbol;
        }
     }
   if(g_tradeSymbol != "")
      PrintFormat("OmegaExecutor: %s no longer passes the gold check (%s); trading stops", g_tradeSymbol, lastProblem);
   g_tradeSymbol = "";
   g_symbolError = "no_usd_gold_symbol (" + lastProblem + ")";
   return "";
  }

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
long NowUtcMs()
  {
   long base = (long)TimeGMT() * 1000;
   if(base <= g_lastWriteMs && (g_lastWriteMs - base) < 999)
      g_lastWriteMs = g_lastWriteMs + 1;
   else
      g_lastWriteMs = base;
   return g_lastWriteMs;
  }

string EscapeJson(const string s)
  {
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   return out;
  }

string CleanCsvField(const string s)
  {
   string out = s;
   StringReplace(out, ";", ",");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   return out;
  }

string AccountTradeModeString()
  {
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode == ACCOUNT_TRADE_MODE_REAL)    return "real";
   if(mode == ACCOUNT_TRADE_MODE_CONTEST) return "contest";
   return "demo";
  }

//+------------------------------------------------------------------+
//| Since 1.15: the account and symbol spec, and the last gate       |
//+------------------------------------------------------------------+
// docs/RFC_ACCOUNT_PROFILES.md §1-2 (owner 2026-11-18). The server stores this spec with a hash and opens nothing
// while a changed spec has not validated; this EA refuses any order the broker would refuse, and says why.
string AccountMarginModeString()
  {
   long mode = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(mode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) return "hedging";
   if(mode == ACCOUNT_MARGIN_MODE_RETAIL_NETTING) return "netting";
   if(mode == ACCOUNT_MARGIN_MODE_EXCHANGE)       return "exchange";
   return "unknown";
  }

string SymbolTradeModeString(const string sym)
  {
   if(sym == "") return "unknown";
   long mode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   if(mode == SYMBOL_TRADE_MODE_FULL)      return "full";
   if(mode == SYMBOL_TRADE_MODE_LONGONLY)  return "long_only";
   if(mode == SYMBOL_TRADE_MODE_SHORTONLY) return "short_only";
   if(mode == SYMBOL_TRADE_MODE_CLOSEONLY) return "close_only";
   if(mode == SYMBOL_TRADE_MODE_DISABLED)  return "disabled";
   return "unknown";
  }

// An opaque account reference: SHA-256 of "omega|<server>|<login>" in hex. The login itself never leaves the terminal.
string AccountLoginHash()
  {
   string text = "omega|" + AccountInfoString(ACCOUNT_SERVER) + "|" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   uchar data[], key[], digest[];
   StringToCharArray(text, data, 0, StringLen(text), CP_UTF8);
   ArrayResize(key, 0);
   if(CryptEncode(CRYPT_HASH_SHA256, data, key, digest) <= 0) return "";
   string hex = "";
   for(int i = 0; i < ArraySize(digest); i++) hex += StringFormat("%02x", digest[i]);
   return hex;
  }

// The margin one lot needs at the current price (the buy side; 0 when the terminal cannot say).
double MarginPerLot(const string sym)
  {
   if(sym == "") return 0.0;
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double margin = 0.0;
   if(ask <= 0.0 || !OrderCalcMargin(ORDER_TYPE_BUY, sym, 1.0, ask, margin)) return 0.0;
   return margin;
  }

// The filling mode CTrade.SetTypeFillingBySymbol picks: fill-or-kill, else immediate-or-cancel, else return.
ENUM_ORDER_TYPE_FILLING FillingFor(const string sym)
  {
   uint filling = (uint)SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) return ORDER_FILLING_FOK;
   if((filling & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

// Before an open: "" when the order may go, else the reason ("refused: <what>"). Nothing is resized or moved.
string OpenRefusal(const string sym, const string side, const double volume, const double sl, const double tp)
  {
   bool buy = (side == "BUY");
   string mode = SymbolTradeModeString(sym);
   if(mode == "disabled" || mode == "close_only" || mode == "unknown") return "refused: trade_mode_" + mode;
   if(buy && mode == "short_only") return "refused: trade_mode_short_only";
   if(!buy && mode == "long_only") return "refused: trade_mode_long_only";

   double price = buy ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   if(price <= 0.0) return "refused: no_price";
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   long stopsLevel = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = (double)stopsLevel * point;
   // A stop on the wrong side, or inside the stops level, is refused: the server sends both, the EA never moves them.
   if(sl > 0.0)
     {
      double d = buy ? price - sl : sl - price;
      if(d <= 0.0) return "refused: sl_wrong_side";
      if(minDist > 0.0 && d < minDist) return "refused: stops_level";
     }
   if(tp > 0.0)
     {
      double d = buy ? tp - price : price - tp;
      if(d <= 0.0) return "refused: tp_wrong_side";
      if(minDist > 0.0 && d < minDist) return "refused: stops_level";
     }

   // The margin is computed first: a terminal that cannot price it (OrderCalcMargin false) opens nothing, with the
   // error code. A margin of 0 is a valid answer (1.16, 2026-11-18): under unlimited leverage (FxPro demo, 1:2,000,000,000)
   // 0.01 lot needs about USD 0.004, which the terminal rounds to 0.00; 1.15 refused every open there as margin_unknown.
   // Whether the account can carry the order is OrderCheck's answer below, which also counts a hedged opposite position.
   double margin = 0.0;
   ResetLastError();
   if(!OrderCalcMargin(buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, sym, volume, price, margin)) return StringFormat("refused: margin_unknown_%d", GetLastError());
   if(margin < 0.0) return "refused: margin_negative";

   MqlTradeRequest req;
   MqlTradeCheckResult check;
   ZeroMemory(req);
   ZeroMemory(check);
   req.action = TRADE_ACTION_DEAL;
   req.symbol = sym;
   req.volume = volume;
   req.type = buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   req.price = price;
   req.sl = sl;
   req.tp = tp;
   req.deviation = (ulong)SlippagePoints;
   req.magic = (ulong)MagicNumber;
   req.type_filling = FillingFor(sym);
   if(!OrderCheck(req, check))
     {
      if(check.retcode == TRADE_RETCODE_NO_MONEY) return "refused: margin";
      if(check.retcode == TRADE_RETCODE_INVALID_STOPS) return "refused: stops_level";
      if(check.retcode == TRADE_RETCODE_INVALID_VOLUME) return "refused: volume";
      if(check.retcode == TRADE_RETCODE_MARKET_CLOSED) return "refused: market_closed";
      if(check.retcode == TRADE_RETCODE_TRADE_DISABLED) return "refused: trade_disabled";
      return StringFormat("refused: order_check_%u", check.retcode);
     }
   return "";
  }

// Before a stop or target change on an open position: "" when it may go, else the reason. A level inside the freeze
// level (the old one or the new one) cannot be changed at the broker; the EA says so instead of sending it.
// 1.18 (owner 2026-11-19, "Human AI interaction"): the owner's own edit from Nexus ("manual:" ids) and a manual
// position the owner delegated to Omega ("d:" ids) may act on a position or order without this EA's magic number.
bool MayActOnForeign(const string id)
  {
   return StringFind(id, "manual:") == 0 || StringFind(id, "d:") == 0;
  }

string ModifyRefusal(const string sym, const bool buy, const double oldLevel, const double newLevel)
  {
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   long freeze = SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL);
   if(freeze <= 0 || point <= 0.0) return "";
   // A buy closes at the bid, a sell at the ask: its stop and target are measured from there.
   double px = buy ? SymbolInfoDouble(sym, SYMBOL_BID) : SymbolInfoDouble(sym, SYMBOL_ASK);
   if(px <= 0.0) return "";
   double f = (double)freeze * point;
   if(oldLevel > 0.0 && MathAbs(px - oldLevel) <= f) return "refused: freeze_level";
   if(newLevel > 0.0 && MathAbs(px - newLevel) <= f) return "refused: freeze_level";
   return "";
  }

bool IsProcessed(const string id)
  {
   for(int i = ArraySize(g_processedIds) - 1; i >= 0; i--)
      if(g_processedIds[i] == id) return true;
   return false;
  }

void MarkProcessed(const string id)
  {
   if(id == "" || IsProcessed(id)) return;
   int n = ArraySize(g_processedIds);
   ArrayResize(g_processedIds, n + 1);
   g_processedIds[n] = id;

   int h = FileOpen(PROCESSED_PATH, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h != INVALID_HANDLE)
     {
      FileSeek(h, 0, SEEK_END);
      FileWriteString(h, id + "\n");
      FileClose(h);
     }
  }

void LoadProcessedIds()
  {
   ArrayResize(g_processedIds, 0);
   if(!FileIsExist(PROCESSED_PATH)) return;
   int h = FileOpen(PROCESSED_PATH, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(line == "" || StringGetCharacter(line, 0) == '#') continue;
      if(!IsProcessed(line))
        {
         int n = ArraySize(g_processedIds);
         ArrayResize(g_processedIds, n + 1);
         g_processedIds[n] = line;
        }
     }
   FileClose(h);
  }

void AppendResult(const string id, const bool ok, const ulong ticket, const string errorMsg, const long executedMs, const double fillPrice = 0.0, const double slippagePts = 0.0)
  {
   int h = FileOpen(RESULTS_PATH, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   string ticketField = ticket > 0 ? StringFormat("%I64u", ticket) : "";
   string errField = ok ? "" : CleanCsvField(errorMsg);
   string line = "";
   if(fillPrice > 0.0)
      line = StringFormat("%s;%d;%s;%s;%I64d;%.2f;%.1f\n", id, ok ? 1 : 0, ticketField, errField, executedMs, fillPrice, slippagePts);
   else
      line = StringFormat("%s;%d;%s;%s;%I64d\n", id, ok ? 1 : 0, ticketField, errField, executedMs);
   FileWriteString(h, line);
   FileClose(h);
  }

//+------------------------------------------------------------------+
//| State writer (omega/state.tmp -> omega/state.json)               |
//+------------------------------------------------------------------+
double ComputeTodayRealizedPl()
  {
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   t.hour = 0;
   t.min  = 0;
   t.sec  = 0;
   datetime dayStart = StructToTime(t);
   double realized = 0.0;
   if(HistorySelect(dayStart, TimeCurrent()))
     {
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         if(d == 0) continue;
         long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
         if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) continue;
         realized += HistoryDealGetDouble(d, DEAL_PROFIT)
                   + HistoryDealGetDouble(d, DEAL_SWAP)
                   + HistoryDealGetDouble(d, DEAL_COMMISSION);
        }
     }
   return realized;
  }

string BuildPositionsJson()
  {
   string sym = ResolveGoldSymbol();
   int defaultDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   long serverMinusUtcSec = (long)(TimeCurrent() - TimeGMT());
   string out = "[";
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;

      string posSym = PositionGetString(POSITION_SYMBOL);
      int posDigits = (int)SymbolInfoInteger(posSym, SYMBOL_DIGITS);
      if(posDigits <= 0) posDigits = defaultDigits;

      long magic = PositionGetInteger(POSITION_MAGIC);
      string source = "external";
      if(magic == MagicNumber)
         source = "omega";
      else if(magic == 0)
         source = "manual";

      string side = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL";
      double volume = PositionGetDouble(POSITION_VOLUME);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double profit = PositionGetDouble(POSITION_PROFIT);
      string intentId = EscapeJson(PositionGetString(POSITION_COMMENT));
      long posTimeMsc = PositionGetInteger(POSITION_TIME_MSC);
      long openedUtcMs = posTimeMsc > 0
                         ? (posTimeMsc - serverMinusUtcSec * 1000)
                         : (((long)PositionGetInteger(POSITION_TIME) - serverMinusUtcSec) * 1000);

      out += StringFormat(
         "%s{\"ticket\":%I64u,\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":%.4f,\"open_price\":%s,\"sl\":%s,\"tp\":%s,\"profit\":%.2f,\"intent_id\":\"%s\",\"magic\":%I64d,\"source\":\"%s\",\"opened_ms\":%I64d}",
         count > 0 ? "," : "",
         ticket,
         EscapeJson(posSym),
         side,
         volume,
         DoubleToString(openPrice, posDigits),
         DoubleToString(sl, posDigits),
         DoubleToString(tp, posDigits),
         profit,
         intentId,
         magic,
         source,
         openedUtcMs
      );
      count++;
     }
   return out + "]";
  }

string BuildOrdersJson()
  {
   string sym = ResolveGoldSymbol();
   int defaultDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   long serverMinusUtcSec = (long)(TimeCurrent() - TimeGMT());
   string out = "[";
   int count = 0;

   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket)) continue;

      string orderSym = OrderGetString(ORDER_SYMBOL);
      int orderDigits = (int)SymbolInfoInteger(orderSym, SYMBOL_DIGITS);
      if(orderDigits <= 0) orderDigits = defaultDigits;

      long orderType = OrderGetInteger(ORDER_TYPE);
      string typeStr = "OTHER";
      if(orderType == ORDER_TYPE_BUY_LIMIT) typeStr = "BUY_LIMIT";
      else if(orderType == ORDER_TYPE_SELL_LIMIT) typeStr = "SELL_LIMIT";
      else if(orderType == ORDER_TYPE_BUY_STOP) typeStr = "BUY_STOP";
      else if(orderType == ORDER_TYPE_SELL_STOP) typeStr = "SELL_STOP";
      else if(orderType == ORDER_TYPE_BUY_STOP_LIMIT) typeStr = "BUY_STOP_LIMIT";
      else if(orderType == ORDER_TYPE_SELL_STOP_LIMIT) typeStr = "SELL_STOP_LIMIT";

      double volInit = OrderGetDouble(ORDER_VOLUME_INITIAL);
      double volCurr = OrderGetDouble(ORDER_VOLUME_CURRENT);
      double priceOpen = OrderGetDouble(ORDER_PRICE_OPEN);
      double sl = OrderGetDouble(ORDER_SL);
      double tp = OrderGetDouble(ORDER_TP);
      long magic = OrderGetInteger(ORDER_MAGIC);
      string comment = EscapeJson(OrderGetString(ORDER_COMMENT));

      string source = "external";
      if(magic == MagicNumber) source = "omega";
      else if(magic == 0) source = "manual";

      long setupTimeMsc = OrderGetInteger(ORDER_TIME_SETUP_MSC);
      long placedUtcMs = setupTimeMsc > 0
                        ? (setupTimeMsc - serverMinusUtcSec * 1000)
                        : (((long)OrderGetInteger(ORDER_TIME_SETUP) - serverMinusUtcSec) * 1000);

      out += StringFormat(
         "%s{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"volume_initial\":%.4f,\"volume_current\":%.4f,\"price_open\":%s,\"sl\":%s,\"tp\":%s,\"comment\":\"%s\",\"magic\":%I64d,\"source\":\"%s\",\"placed_ms\":%I64d}",
         count > 0 ? "," : "",
         ticket,
         EscapeJson(orderSym),
         typeStr,
         volInit,
         volCurr,
         DoubleToString(priceOpen, orderDigits),
         DoubleToString(sl, orderDigits),
         DoubleToString(tp, orderDigits),
         comment,
         magic,
         source,
         placedUtcMs
      );
      count++;
     }
   return out + "]";
  }

string BuildDealsJson()
  {
   string defaultSym = ResolveGoldSymbol();
   int defaultDigits = (int)SymbolInfoInteger(defaultSym, SYMBOL_DIGITS);
   long serverMinusUtcSec = (long)(TimeCurrent() - TimeGMT());
   datetime fromTime = TimeCurrent() - 30 * 86400; // last 30 days
   string out = "[";
   int count = 0;
   int maxDeals = 100;

   if(HistorySelect(fromTime, TimeCurrent()))
     {
      int total = HistoryDealsTotal();
      for(int i = total - 1; i >= 0 && count < maxDeals; i--)
        {
         ulong dealTicket = HistoryDealGetTicket(i);
         if(dealTicket == 0) continue;

         long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
         if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) continue;

         ulong posId = (ulong)HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
         long dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
         string side = (dealType == DEAL_TYPE_SELL) ? "BUY" : "SELL";

         string dealSym = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
         int dealDigits = (int)SymbolInfoInteger(dealSym, SYMBOL_DIGITS);
         if(dealDigits <= 0) dealDigits = defaultDigits;

         double volume = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
         double exitPrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
         double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
         double comm = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
         double swap = HistoryDealGetDouble(dealTicket, DEAL_SWAP);

         long magic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
         string source = "external";
         if(magic == MagicNumber) source = "omega";
         else if(magic == 0) source = "manual";

         long dealReason = HistoryDealGetInteger(dealTicket, DEAL_REASON);
         string reason = "closed";
         if(dealReason == DEAL_REASON_CLIENT) reason = "manual";
         else if(dealReason == DEAL_REASON_EXPERT) reason = "expert";
         else if(dealReason == DEAL_REASON_TP) reason = "tp";
         else if(dealReason == DEAL_REASON_SL) reason = "sl";
         else if(dealReason == DEAL_REASON_SO) reason = "stop_out";

         string comment = EscapeJson(HistoryDealGetString(dealTicket, DEAL_COMMENT));

         long closedTimeMsc = HistoryDealGetInteger(dealTicket, DEAL_TIME_MSC);
         long closedUtcMs = closedTimeMsc > 0
                           ? (closedTimeMsc - serverMinusUtcSec * 1000)
                           : (((long)HistoryDealGetInteger(dealTicket, DEAL_TIME) - serverMinusUtcSec) * 1000);

         double entryPrice = exitPrice;
         long openedUtcMs = closedUtcMs;
         for(int j = 0; j < total; j++)
           {
            ulong inTicket = HistoryDealGetTicket(j);
            if((ulong)HistoryDealGetInteger(inTicket, DEAL_POSITION_ID) == posId &&
               HistoryDealGetInteger(inTicket, DEAL_ENTRY) == DEAL_ENTRY_IN)
              {
               entryPrice = HistoryDealGetDouble(inTicket, DEAL_PRICE);
               long inTimeMsc = HistoryDealGetInteger(inTicket, DEAL_TIME_MSC);
               openedUtcMs = inTimeMsc > 0
                             ? (inTimeMsc - serverMinusUtcSec * 1000)
                             : (((long)HistoryDealGetInteger(inTicket, DEAL_TIME) - serverMinusUtcSec) * 1000);
               long inType = HistoryDealGetInteger(inTicket, DEAL_TYPE);
               if(inType == DEAL_TYPE_BUY) side = "BUY";
               else if(inType == DEAL_TYPE_SELL) side = "SELL";
               break;
              }
           }

         out += StringFormat(
            "%s{\"deal_ticket\":%I64u,\"position_ticket\":%I64u,\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":%.4f,\"entry_price\":%s,\"exit_price\":%s,\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f,\"reason\":\"%s\",\"signal_id\":\"%s\",\"magic\":%I64d,\"source\":\"%s\",\"opened_ms\":%I64d,\"closed_ms\":%I64d}",
            count > 0 ? "," : "",
            dealTicket,
            posId,
            EscapeJson(dealSym),
            side,
            volume,
            DoubleToString(entryPrice, dealDigits),
            DoubleToString(exitPrice, dealDigits),
            profit,
            comm,
            swap,
            reason,
            comment,
            magic,
            source,
            openedUtcMs,
            closedUtcMs
         );
         count++;
        }
     }
   return out + "]";
  }

double GetCurrentAtr(const string sym)
  {
   if(g_atrHandle == INVALID_HANDLE && sym != "")
      g_atrHandle = iATR(sym, PERIOD_M15, 14);
   if(g_atrHandle == INVALID_HANDLE) return 0.0;
   double buffer[1];
   if(CopyBuffer(g_atrHandle, 0, 0, 1, buffer) > 0)
      return buffer[0];
   return 0.0;
  }

void WriteStateJson()
  {
   bool connected = (TerminalInfoInteger(TERMINAL_CONNECTED) != 0) && (AccountInfoInteger(ACCOUNT_LOGIN) > 0);
   string server = EscapeJson(AccountInfoString(ACCOUNT_SERVER));
   string tradeMode = AccountTradeModeString();
   string currency = EscapeJson(AccountInfoString(ACCOUNT_CURRENCY));
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double dayRealizedPl = ComputeTodayRealizedPl();
   double dayStartBalance = balance - dayRealizedPl;

   string sym = ResolveGoldSymbol();
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0.0) tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double volumeMin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double volumeMax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double volumeStep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   int stopsLevelPoints = (int)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   int spreadPoints = (int)SymbolInfoInteger(sym, SYMBOL_SPREAD);
   double atrValue = GetCurrentAtr(sym);
   int atrPoints = (point > 0.0 && atrValue > 0.0) ? (int)MathRound(atrValue / point) : 0;

   // Since 1.14 (PR #405): the contract the server checks before any entry, and the EA's own refusal.
   string profitCcy = sym != "" ? SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT) : "";
   // Since 1.15 (docs/RFC_ACCOUNT_PROFILES.md §1): the spec the server hashes, and what the EA's last gate checks.
   long leverage = AccountInfoInteger(ACCOUNT_LEVERAGE);
   double marginFree = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   int freezeLevelPoints = sym != "" ? (int)SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL) : 0;
   double marginPerLot = MarginPerLot(sym);
   string baseCcy = sym != "" ? SymbolInfoString(sym, SYMBOL_CURRENCY_BASE) : "";
   double contractSize = sym != "" ? SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE) : 0.0;

   string positionsJson = BuildPositionsJson();
   string ordersJson = BuildOrdersJson();
   string dealsJson = BuildDealsJson();
   long receivedMs = NowUtcMs();

   string json = StringFormat(
      "{\"connected\":%s,\"server\":\"%s\","
      "\"account\":{\"trade_mode\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"day_start_balance\":%.2f,\"day_realized_pl\":%.2f,"
      "\"leverage\":%I64d,\"margin_mode\":\"%s\",\"margin_free\":%.2f,\"login_hash\":\"%s\",\"company\":\"%s\"},"
      "\"symbol\":{\"name\":\"%s\",\"digits\":%d,\"point\":%s,\"tick_size\":%s,\"tick_value\":%s,\"volume_min\":%.4f,\"volume_max\":%.4f,\"volume_step\":%.4f,\"stops_level_points\":%d,\"bid\":%s,\"ask\":%s,\"spread_points\":%d,\"atr_value\":%.2f,\"atr_points\":%d,"
      "\"chart\":\"%s\",\"currency_profit\":\"%s\",\"currency_base\":\"%s\",\"contract_size\":%.4f,"
      "\"freeze_level_points\":%d,\"trade_mode\":\"%s\",\"margin_per_lot\":%.2f},",
      connected ? "true" : "false",
      server,
      tradeMode,
      currency,
      balance,
      equity,
      dayStartBalance,
      dayRealizedPl,
      leverage,
      AccountMarginModeString(),
      marginFree,
      AccountLoginHash(),
      EscapeJson(AccountInfoString(ACCOUNT_COMPANY)),
      EscapeJson(sym),
      digits,
      DoubleToString(point, digits),
      DoubleToString(tickSize, digits),
      DoubleToString(tickValue, 8),
      volumeMin,
      volumeMax,
      volumeStep,
      stopsLevelPoints,
      DoubleToString(bid, digits),
      DoubleToString(ask, digits),
      spreadPoints,
      atrValue,
      atrPoints,
      EscapeJson(_Symbol),
      EscapeJson(profitCcy),
      EscapeJson(baseCcy),
      contractSize,
      freezeLevelPoints,
      SymbolTradeModeString(sym),
      marginPerLot
   );
   // No allowed USD gold symbol on this server: said, never hidden behind another symbol.
   json += g_symbolError != "" ? StringFormat("\"symbol_error\":\"%s\",", EscapeJson(g_symbolError)) : "\"symbol_error\":null,";
   json += "\"positions\":" + positionsJson + ",";
   json += "\"orders\":" + ordersJson + ",";
   json += "\"deals\":" + dealsJson + ",";
   // Since 1.12 (owner 2026-11-12: "tambahkan versi EA dan status input ke server"): the server checks that
   // this EA leaves the stop and the target to Omega (its local break-even and trailing off).
   json += StringFormat("\"executor\":{\"name\":\"OmegaExecutor\",\"version\":\"%s\",\"auto_break_even\":%s,\"trailing_stop\":%s,\"dynamic_atr_stop\":%s},",
      OMEGA_EXECUTOR_VERSION,
      AutoBreakEvenEnabled ? "true" : "false",
      TrailingStopEnabled ? "true" : "false",
      DynamicAtrStopEnabled ? "true" : "false"
   );
   json += StringFormat("\"trade_allowed\":%s,\"received_ms\":%I64d}",
      (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) ? "true" : "false",
      receivedMs
   );

   int h = FileOpen(STATE_TMP_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   FileMove(STATE_TMP_PATH, 0, STATE_JSON_PATH, FILE_REWRITE);
  }

//+------------------------------------------------------------------+
//| Corpus Oracle writer (omega/corpus.tmp -> omega/corpus.json)     |
//| The broker's closed M1 bars of the traded symbol, oldest first:  |
//| [t_ms UTC, open, high, low, close, tick_volume, spread]. The     |
//| bridge sends the bars after the server's cursor with each sync.  |
//| No login and no account number: server name, symbol and bars.    |
//+------------------------------------------------------------------+
int ServerUtcOffsetSeconds()
  {
   // Broker bar times are server time; brokers sit on whole quarter hours from UTC.
   long diff = (long)(TimeTradeServer() - TimeGMT());
   return (int)(MathRound(diff / 900.0) * 900);
  }

void WriteCorpusJson()
  {
   if(!CorpusOracleEnabled) return;
   string sym = ResolveGoldSymbol();
   if(sym == "") return; // no USD gold symbol: no broker bars for the local lane either
   datetime lastClosed = iTime(sym, PERIOD_M1, 1);
   if(lastClosed == 0 || lastClosed == g_lastCorpusBar) return;
   int n = (int)MathMax(10, MathMin(240, CorpusBars));
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int got = CopyRates(sym, PERIOD_M1, 1, n, rates); // from shift 1: closed bars only, oldest first
   if(got <= 0) return;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   int offset = ServerUtcOffsetSeconds();
   string bars = "";
   for(int i = 0; i < got; i++)
     {
      long tMs = ((long)rates[i].time - offset) * 1000;
      if(i > 0) bars += ",";
      bars += StringFormat("[%I64d,%s,%s,%s,%s,%I64d,%d]", tMs,
                           DoubleToString(rates[i].open, digits), DoubleToString(rates[i].high, digits),
                           DoubleToString(rates[i].low, digits), DoubleToString(rates[i].close, digits),
                           rates[i].tick_volume, rates[i].spread);
     }
   string json = StringFormat("{\"server\":\"%s\",\"symbol\":\"%s\",\"timeframe\":\"M1\",\"digits\":%d,\"utc_offset_s\":%d,\"written_ms\":%I64d,\"bars\":[%s]}",
                              EscapeJson(AccountInfoString(ACCOUNT_SERVER)), EscapeJson(sym), digits, offset, NowUtcMs(), bars);
   int h = FileOpen(CORPUS_TMP_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   if(FileMove(CORPUS_TMP_PATH, 0, CORPUS_JSON_PATH, FILE_REWRITE)) g_lastCorpusBar = lastClosed;
  }

//+------------------------------------------------------------------+
//| MT5 fallback, stage 2: macro symbols and the economic calendar   |
//+------------------------------------------------------------------+
// The broker's name for a base: the gold symbol's prefix and suffix around it first (XAUUSD.m -> EURUSD.m),
// then the base itself. Empty when the broker has none of the alternatives.
string ResolveMacroSymbol(const string alternatives)
  {
   string gold = ResolveGoldSymbol();
   string upGold = gold;
   StringToUpper(upGold);
   int p = StringFind(upGold, "XAUUSD");
   string prefix = (p > 0) ? StringSubstr(gold, 0, p) : "";
   string suffix = (p >= 0) ? StringSubstr(gold, p + 6) : "";
   string alts[];
   int n = StringSplit(alternatives, '|', alts);
   for(int i = 0; i < n; i++)
     {
      string name = alts[i];
      StringTrimLeft(name);
      StringTrimRight(name);
      if(name == "") continue;
      string candidates[2];
      candidates[0] = prefix + name + suffix;
      candidates[1] = name;
      for(int k = 0; k < 2; k++)
        {
         if(k == 1 && candidates[1] == candidates[0]) continue;
         if((bool)SymbolInfoInteger(candidates[k], SYMBOL_EXIST))
           {
            SymbolSelect(candidates[k], true);
            return candidates[k];
           }
        }
     }
   return "";
  }

void WriteCorpusMacroJson()
  {
   if(!CorpusMacroEnabled) return;
   string gold = ResolveGoldSymbol();
   if(gold == "") return;
   datetime lastClosed = iTime(gold, PERIOD_M1, 1);
   if(lastClosed == 0 || lastClosed == g_lastMacroBar) return;
   int n = (int)MathMax(10, MathMin(240, CorpusMacroBars));
   int offset = ServerUtcOffsetSeconds();
   string entries[];
   int count = StringSplit(CorpusMacroSymbols, ',', entries);
   string series = "";
   int written = 0;
   for(int e = 0; e < count; e++)
     {
      string alternatives = entries[e];
      StringTrimLeft(alternatives);
      StringTrimRight(alternatives);
      if(alternatives == "") continue;
      string parts[];
      StringSplit(alternatives, '|', parts);
      string base = parts[0];
      StringToUpper(base);
      string sym = ResolveMacroSymbol(alternatives);
      if(sym == "") continue;
      MqlRates rates[];
      ArraySetAsSeries(rates, false);
      int got = CopyRates(sym, PERIOD_M1, 1, n, rates); // closed bars only, oldest first
      if(got <= 0) continue;
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      string bars = "";
      for(int i = 0; i < got; i++)
        {
         long tMs = ((long)rates[i].time - offset) * 1000;
         if(i > 0) bars += ",";
         bars += StringFormat("[%I64d,%s,%s,%s,%s,%I64d,%d]", tMs,
                              DoubleToString(rates[i].open, digits), DoubleToString(rates[i].high, digits),
                              DoubleToString(rates[i].low, digits), DoubleToString(rates[i].close, digits),
                              rates[i].tick_volume, rates[i].spread);
        }
      if(written > 0) series += ",";
      series += StringFormat("{\"base\":\"%s\",\"symbol\":\"%s\",\"digits\":%d,\"bars\":[%s]}", EscapeJson(base), EscapeJson(sym), digits, bars);
      written++;
     }
   if(written == 0) { g_lastMacroBar = lastClosed; return; }
   string json = StringFormat("{\"server\":\"%s\",\"timeframe\":\"M1\",\"utc_offset_s\":%d,\"written_ms\":%I64d,\"series\":[%s]}",
                              EscapeJson(AccountInfoString(ACCOUNT_SERVER)), offset, NowUtcMs(), series);
   int h = FileOpen(CORPUS_MACRO_TMP_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   if(FileMove(CORPUS_MACRO_TMP_PATH, 0, CORPUS_MACRO_JSON_PATH, FILE_REWRITE)) g_lastMacroBar = lastClosed;
  }

string CalendarNumber(const bool has, const double value)
  {
   if(!has) return "null";
   return DoubleToString(value, 6);
  }

// The terminal's USD economic calendar (MQL5 Calendar): 7 days back, 2 ahead, moderate and high
// importance, with the released, forecast and previous values. Times are converted to UTC.
void WriteCalendarJson()
  {
   if(!CalendarEnabled) return;
   datetime nowGmt = TimeGMT();
   if(g_lastCalendarAt != 0 && (nowGmt - g_lastCalendarAt) < 300) return;
   g_lastCalendarAt = nowGmt;
   int offset = ServerUtcOffsetSeconds();
   datetime serverNow = TimeTradeServer();
   MqlCalendarValue values[];
   int got = CalendarValueHistory(values, serverNow - 7 * 86400, serverNow + 2 * 86400, "US", "USD");
   if(got <= 0) return;
   string events = "";
   int written = 0;
   for(int i = 0; i < got && written < 400; i++)
     {
      MqlCalendarEvent ev;
      if(!CalendarEventById(values[i].event_id, ev)) continue;
      if(ev.importance != CALENDAR_IMPORTANCE_HIGH && ev.importance != CALENDAR_IMPORTANCE_MODERATE) continue;
      long tMs = ((long)values[i].time - offset) * 1000;
      int importance = (ev.importance == CALENDAR_IMPORTANCE_HIGH) ? 3 : 2;
      if(written > 0) events += ",";
      events += StringFormat("{\"value_id\":\"%I64u\",\"title\":\"%s\",\"currency\":\"USD\",\"time_ms\":%I64d,\"importance\":%d,\"actual\":%s,\"forecast\":%s,\"previous\":%s,\"unit\":\"%d\"}",
                             values[i].id, EscapeJson(ev.name), tMs, importance,
                             CalendarNumber(values[i].HasActualValue(), values[i].GetActualValue()),
                             CalendarNumber(values[i].HasForecastValue(), values[i].GetForecastValue()),
                             CalendarNumber(values[i].HasPreviousValue(), values[i].GetPreviousValue()),
                             (int)ev.unit);
      written++;
     }
   string json = StringFormat("{\"server\":\"%s\",\"written_ms\":%I64d,\"events\":[%s]}", EscapeJson(AccountInfoString(ACCOUNT_SERVER)), NowUtcMs(), events);
   int h = FileOpen(CALENDAR_TMP_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   FileMove(CALENDAR_TMP_PATH, 0, CALENDAR_JSON_PATH, FILE_REWRITE);
  }

//+------------------------------------------------------------------+
//| Intent execution                                                 |
//+------------------------------------------------------------------+
bool IsValidVolume(const double volume)
  {
   string sym = ResolveGoldSymbol();
   if(sym == "") return false;
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(volume <= 0.0 || vmin <= 0.0 || vmax <= 0.0 || step <= 0.0) return false;
   if(volume < vmin - 1e-8 || volume > vmax + 1e-8) return false;
   double stepsFromMin = (volume - vmin) / step;
   double nearest = MathRound(stepsFromMin);
   if(MathAbs(stepsFromMin - nearest) > 1e-5) return false;
   return true;
  }

ulong ResolveOpenedPositionTicket(const string intentId)
  {
   ulong deal = trade.ResultDeal();
   if(deal > 0 && HistoryDealSelect(deal))
     {
      ulong posId = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(posId > 0) return posId;
     }
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetInteger(POSITION_MAGIC) == MagicNumber && PositionGetString(POSITION_COMMENT) == intentId)
         return t;
     }
   return trade.ResultOrder();
  }

void ExecuteOpenIntent(const string id, const string side, const double volume, const double sl, const double tp)
  {
   long nowMs = NowUtcMs();
   if(side != "BUY" && side != "SELL")
     {
      AppendResult(id, false, 0, "invalid_side", nowMs);
      return;
     }
   // Fail closed (PR #405): no allowed USD gold symbol, no order, whatever the intent says.
   if(ResolveGoldSymbol() == "")
     {
      AppendResult(id, false, 0, "symbol_error", nowMs);
      return;
     }
   if(!IsValidVolume(volume))
     {
      AppendResult(id, false, 0, "invalid_volume", nowMs);
      return;
     }

   string sym = ResolveGoldSymbol();
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double normSl = sl > 0.0 ? NormalizeDouble(sl, digits) : 0.0;
   double normTp = tp > 0.0 ? NormalizeDouble(tp, digits) : 0.0;

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(sym);

   // The last gate (1.15): what the broker would refuse is refused here, with the reason; never resized, never moved.
   string refusal = OpenRefusal(sym, side, volume, normSl, normTp);
   if(refusal != "")
     {
      AppendResult(id, false, 0, refusal, nowMs);
      return;
     }

   double preAsk = SymbolInfoDouble(sym, SYMBOL_ASK);
   double preBid = SymbolInfoDouble(sym, SYMBOL_BID);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);

   bool ok = (side == "BUY")
             ? trade.Buy(volume, sym, 0.0, normSl, normTp, id)
             : trade.Sell(volume, sym, 0.0, normSl, normTp, id);

   long executedMs = NowUtcMs();
   if(ok)
     {
      ulong posTicket = ResolveOpenedPositionTicket(id);
      ulong deal = trade.ResultDeal();
      double fillPrice = 0.0;
      if(deal > 0 && HistoryDealSelect(deal))
         fillPrice = HistoryDealGetDouble(deal, DEAL_PRICE);
      if(fillPrice <= 0.0)
         fillPrice = trade.ResultPrice();

      double slippagePts = 0.0;
      if(fillPrice > 0.0 && point > 0.0)
        {
         if(side == "BUY" && preAsk > 0.0)
            slippagePts = (fillPrice - preAsk) / point;
         else if(side == "SELL" && preBid > 0.0)
            slippagePts = (preBid - fillPrice) / point;
        }
      AppendResult(id, true, posTicket, "", executedMs, fillPrice, slippagePts);
     }
   else
     {
      AppendResult(id, false, 0, trade.ResultRetcodeDescription(), executedMs);
     }
  }

void ExecuteCloseIntent(const string id, const ulong ticket)
  {
   long nowMs = NowUtcMs();
   if(ticket == 0 || !PositionSelectByTicket(ticket))
     {
      AppendResult(id, false, ticket, "position_not_found", nowMs);
      return;
     }
   long posMagic = PositionGetInteger(POSITION_MAGIC);
   if(posMagic != MagicNumber)
     {
      if(StringFind(id, "manual") < 0 && StringFind(id, "kill") < 0 && StringFind(id, "force") < 0 && !MayActOnForeign(id))
        {
         AppendResult(id, false, ticket, "foreign_magic", nowMs);
         return;
        }
     }

   trade.SetExpertMagicNumber(posMagic == MagicNumber ? MagicNumber : 0);
   trade.SetDeviationInPoints(SlippagePoints);
   bool ok = trade.PositionClose(ticket, SlippagePoints);
   long executedMs = NowUtcMs();
   if(ok)
      AppendResult(id, true, ticket, "", executedMs);
   else
      AppendResult(id, false, ticket, trade.ResultRetcodeDescription(), executedMs);
  }

void ExecutePartialCloseIntent(const string id, const ulong ticket, const double closeVolume)
  {
   long nowMs = NowUtcMs();
   if(ticket == 0 || !PositionSelectByTicket(ticket))
     {
      AppendResult(id, false, ticket, "position_not_found", nowMs);
      return;
     }
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber && !MayActOnForeign(id))
     {
      AppendResult(id, false, ticket, "foreign_magic", nowMs);
      return;
     }

   double currentVol = PositionGetDouble(POSITION_VOLUME);
   double volToClose = (closeVolume > 0.0 && closeVolume < currentVol) ? closeVolume : (currentVol / 2.0);
   volToClose = NormalizeDouble(volToClose, 2);

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   bool ok = trade.PositionClosePartial(ticket, volToClose, SlippagePoints);
   long executedMs = NowUtcMs();
   if(ok)
      AppendResult(id, true, ticket, "", executedMs);
   else
      AppendResult(id, false, ticket, trade.ResultRetcodeDescription(), executedMs);
  }

void ExecuteModifySlIntent(const string id, const ulong ticket, const double newSl)
  {
   long nowMs = NowUtcMs();
   if(ticket == 0 || !PositionSelectByTicket(ticket))
     {
      AppendResult(id, false, ticket, "position_not_found", nowMs);
      return;
     }
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber && !MayActOnForeign(id))
     {
      AppendResult(id, false, ticket, "foreign_magic", nowMs);
      return;
     }
   double tp = PositionGetDouble(POSITION_TP);
   double currentSl = PositionGetDouble(POSITION_SL);
   if(newSl == currentSl)
     {
      AppendResult(id, true, ticket, "already_at_sl", nowMs);
      return;
     }
   string slRefusal = ModifyRefusal(PositionGetString(POSITION_SYMBOL), PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY, currentSl, newSl);
   if(slRefusal != "")
     {
      AppendResult(id, false, ticket, slRefusal, nowMs);
      return;
     }
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   bool ok = trade.PositionModify(ticket, newSl, tp);
   long executedMs = NowUtcMs();
   if(ok)
      AppendResult(id, true, ticket, "", executedMs);
   else
      AppendResult(id, false, ticket, trade.ResultRetcodeDescription(), executedMs);
  }

void ExecuteModifyTpIntent(const string id, const ulong ticket, const double newTp)
  {
   long nowMs = NowUtcMs();
   if(ticket == 0 || !PositionSelectByTicket(ticket))
     {
      AppendResult(id, false, ticket, "position_not_found", nowMs);
      return;
     }
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber && !MayActOnForeign(id))
     {
      AppendResult(id, false, ticket, "foreign_magic", nowMs);
      return;
     }
   double sl = PositionGetDouble(POSITION_SL);
   double currentTp = PositionGetDouble(POSITION_TP);
   if(newTp == currentTp)
     {
      AppendResult(id, true, ticket, "already_at_tp", nowMs);
      return;
     }
   string tpRefusal = ModifyRefusal(PositionGetString(POSITION_SYMBOL), PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY, currentTp, newTp);
   if(tpRefusal != "")
     {
      AppendResult(id, false, ticket, tpRefusal, nowMs);
      return;
     }
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   bool ok = trade.PositionModify(ticket, sl, newTp);
   long executedMs = NowUtcMs();
   if(ok)
      AppendResult(id, true, ticket, "", executedMs);
   else
      AppendResult(id, false, ticket, trade.ResultRetcodeDescription(), executedMs);
  }

// 1.18: a position's stop and target in one request (the owner's edit from Nexus). 0 removes a level.
void ExecuteModifySlTpIntent(const string id, const ulong ticket, const double newSl, const double newTp)
  {
   long nowMs = NowUtcMs();
   if(ticket == 0 || !PositionSelectByTicket(ticket))
     {
      AppendResult(id, false, ticket, "position_not_found", nowMs);
      return;
     }
   long posMagic = PositionGetInteger(POSITION_MAGIC);
   if(posMagic != MagicNumber && !MayActOnForeign(id))
     {
      AppendResult(id, false, ticket, "foreign_magic", nowMs);
      return;
     }
   string sym = PositionGetString(POSITION_SYMBOL);
   bool buy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
   double curSl = PositionGetDouble(POSITION_SL), curTp = PositionGetDouble(POSITION_TP);
   if(newSl == curSl && newTp == curTp)
     {
      AppendResult(id, true, ticket, "already_set", nowMs);
      return;
     }
   string refusal = ModifyRefusal(sym, buy, curSl, newSl);
   if(refusal == "") refusal = ModifyRefusal(sym, buy, curTp, newTp);
   if(refusal != "")
     {
      AppendResult(id, false, ticket, refusal, nowMs);
      return;
     }
   trade.SetExpertMagicNumber(posMagic == MagicNumber ? MagicNumber : 0);
   bool ok = trade.PositionModify(ticket, newSl, newTp);
   trade.SetExpertMagicNumber(MagicNumber);
   long executedMs = NowUtcMs();
   if(ok)
      AppendResult(id, true, ticket, "", executedMs);
   else
      AppendResult(id, false, ticket, trade.ResultRetcodeDescription(), executedMs);
  }

// 1.18: a pending order's price, stop and target (the owner's edit from Nexus); its expiry stays. 0 removes SL/TP.
void ExecuteModifyOrderIntent(const string id, const ulong ticket, const double newPrice, const double newSl, const double newTp)
  {
   long nowMs = NowUtcMs();
   if(ticket == 0 || !OrderSelect(ticket))
     {
      AppendResult(id, false, ticket, "order_not_found", nowMs);
      return;
     }
   long ordMagic = OrderGetInteger(ORDER_MAGIC);
   if(ordMagic != MagicNumber && !MayActOnForeign(id))
     {
      AppendResult(id, false, ticket, "foreign_magic", nowMs);
      return;
     }
   double price = newPrice > 0.0 ? newPrice : OrderGetDouble(ORDER_PRICE_OPEN);
   ENUM_ORDER_TYPE_TIME typeTime = (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
   datetime expiry = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
   double stopLimit = OrderGetDouble(ORDER_PRICE_STOPLIMIT);
   trade.SetExpertMagicNumber(ordMagic == MagicNumber ? MagicNumber : 0);
   bool ok = trade.OrderModify(ticket, price, newSl, newTp, typeTime, expiry, stopLimit);
   trade.SetExpertMagicNumber(MagicNumber);
   long executedMs = NowUtcMs();
   if(ok)
      AppendResult(id, true, ticket, "", executedMs);
   else
      AppendResult(id, false, ticket, trade.ResultRetcodeDescription(), executedMs);
  }

void ExecuteCloseAllIntent(const string id)
  {
   trade.SetDeviationInPoints(SlippagePoints);

   bool allOk = true;
   string lastErr = "";

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      trade.SetExpertMagicNumber(PositionGetInteger(POSITION_MAGIC));
      if(!trade.PositionClose(ticket, SlippagePoints))
        {
         allOk = false;
         lastErr = trade.ResultRetcodeDescription();
        }
     }

   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong orderTicket = OrderGetTicket(i);
      if(orderTicket == 0 || !OrderSelect(orderTicket)) continue;
      trade.SetExpertMagicNumber(OrderGetInteger(ORDER_MAGIC));
      if(!trade.OrderDelete(orderTicket))
        {
         allOk = false;
         lastErr = trade.ResultRetcodeDescription();
        }
     }

   long executedMs = NowUtcMs();
   AppendResult(id, allOk, 0, allOk ? "" : lastErr, executedMs);
  }

void ProcessIntentsFile()
  {
   if(!FileIsExist(INTENTS_PATH)) return;
   int h = FileOpen(INTENTS_PATH, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;

   string lines[];
   long writtenMs = 0;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringFind(line, "#v1;") == 0) { writtenMs = StringToInteger(StringSubstr(line, 4)); continue; }
      if(line == "" || StringGetCharacter(line, 0) == '#') continue;
      int n = ArraySize(lines);
      ArrayResize(lines, n + 1);
      lines[n] = line;
     }
   FileClose(h);

   // Only a fresh file from the bridge: a stale one (bridge down, terminal just restarted) is ignored.
   if(writtenMs <= 0 || NowUtcMs() - writtenMs > (long)MaxIntentsAgeSeconds * 1000) return;

   for(int i = 0; i < ArraySize(lines); i++)
     {
      string fields[];
      int count = StringSplit(lines[i], ';', fields);
      if(count < 2) continue;

      string id = fields[0];
      string kind = fields[1];
      string side = count > 2 ? fields[2] : "";
      double volume = (count > 3 && fields[3] != "") ? StringToDouble(fields[3]) : 0.0;
      double sl = (count > 4 && fields[4] != "") ? StringToDouble(fields[4]) : 0.0;
      double tp = (count > 5 && fields[5] != "") ? StringToDouble(fields[5]) : 0.0;
      ulong ticket = (count > 6 && fields[6] != "") ? (ulong)StringToInteger(fields[6]) : 0;

      if(id == "" || IsProcessed(id)) continue;

      // At most once: the id is recorded before the order is sent, so a crash never sends it twice.
      MarkProcessed(id);
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
        {
         AppendResult(id, false, 0, "algo_trading_disabled", NowUtcMs());
         continue;
        }

      if(kind == "open")
         ExecuteOpenIntent(id, side, volume, sl, tp);
      else if(kind == "close")
         ExecuteCloseIntent(id, ticket);
      else if(kind == "partial_close")
         ExecutePartialCloseIntent(id, ticket, volume);
      else if(kind == "close_all")
         ExecuteCloseAllIntent(id);
      else if(kind == "modify_sl")
         ExecuteModifySlIntent(id, ticket, sl);
      else if(kind == "modify_tp")
         ExecuteModifyTpIntent(id, ticket, tp);
      else if(kind == "modify_sltp")
         ExecuteModifySlTpIntent(id, ticket, sl, tp);
      // 1.18: the bridge's line has no price field; a modify_order carries the order's new price in the volume field.
      else if(kind == "modify_order")
         ExecuteModifyOrderIntent(id, ticket, volume, sl, tp);
      else
         AppendResult(id, false, 0, "unknown_intent_kind", NowUtcMs());
     }
  }

//+------------------------------------------------------------------+
//| Lifecycle                                                        |
//+------------------------------------------------------------------+
int OnInit()
  {
   FolderCreate(OMEGA_FOLDER, 0);
   LoadProcessedIds();
   string sym = ResolveGoldSymbol();
   // Without a USD gold symbol the EA still starts: it reports symbol_error in state.json and trades nothing.
   if(sym != "") g_atrHandle = iATR(sym, PERIOD_M15, 14);
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   if(sym != "") trade.SetTypeFillingBySymbol(sym);
   EventSetTimer(1);
   WriteStateJson();
   g_lastStateAt = TimeGMT();
   if(sym == "")
      PrintFormat("OmegaExecutor %s: NO USD GOLD SYMBOL on %s (chart=%s): %s. Nothing will be traded.", OMEGA_EXECUTOR_VERSION, AccountInfoString(ACCOUNT_SERVER), _Symbol, g_symbolError);
   else
      PrintFormat("OmegaExecutor %s initialized on %s (chart=%s, profit=%s, contract=%.2f, magic=%I64d, dynamic_atr=%s)", OMEGA_EXECUTOR_VERSION, sym, _Symbol,
                  SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT), SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), MagicNumber, DynamicAtrStopEnabled ? "true" : "false");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_atrHandle != INVALID_HANDLE)
     {
      IndicatorRelease(g_atrHandle);
      g_atrHandle = INVALID_HANDLE;
     }
  }

//+------------------------------------------------------------------+
//| Manage Local SL+ (Break-Even) and Micro Trailing Stop            |
//+------------------------------------------------------------------+
void ManageTrailingAndBreakEven()
  {
   if(!AutoBreakEvenEnabled && !TrailingStopEnabled) return;

   string sym = ResolveGoldSymbol();
   if(sym == "") return;
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   if(point <= 0.0 || digits <= 0) return;

   double atr = DynamicAtrStopEnabled ? GetCurrentAtr(sym) : 0.0;
   int beTriggerPts = BreakEvenTriggerPoints;
   int trailingDistPts = TrailingDistancePoints;
   if(DynamicAtrStopEnabled && atr > 0.0 && point > 0.0)
     {
      int atrPts = (int)MathRound(atr / point);
      beTriggerPts = (int)MathMax((double)BreakEvenTriggerPoints, MathRound(atrPts * AtrMultiplierTrigger));
      trailingDistPts = (int)MathMax((double)TrailingDistancePoints, MathRound(atrPts * AtrMultiplierTrailing));
     }

   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      if(PositionGetString(POSITION_SYMBOL) != sym) continue;

      long posType = PositionGetInteger(POSITION_TYPE);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSl = PositionGetDouble(POSITION_SL);
      double currentTp = PositionGetDouble(POSITION_TP);

      if(posType == POSITION_TYPE_BUY)
        {
         double profitPoints = (bid - openPrice) / point;
         // 1. Auto Break-Even (SL+)
         if(AutoBreakEvenEnabled && profitPoints >= beTriggerPts)
           {
            double beSl = NormalizeDouble(openPrice + (BreakEvenLockPoints * point), digits);
            if(currentSl < beSl - (point * 0.5))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, beSl, currentTp))
                 {
                  PrintFormat("Auto SL+ triggered for BUY #%I64d: moved SL to %.2f (profit=%.1f pts, trigger=%d pts)", ticket, beSl, profitPoints, beTriggerPts);
                  currentSl = beSl;
                 }
              }
           }
         // 2. Trailing Stop
         if(TrailingStopEnabled && profitPoints >= TrailingStartPoints)
           {
            double targetSl = NormalizeDouble(bid - (trailingDistPts * point), digits);
            if(targetSl > currentSl + (TrailingStepPoints * point))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, targetSl, currentTp))
                 {
                  PrintFormat("Trailing Stop adjusted for BUY #%I64d: SL moved to %.2f (distance=%d pts)", ticket, targetSl, trailingDistPts);
                 }
              }
           }
        }
      else if(posType == POSITION_TYPE_SELL)
        {
         double profitPoints = (openPrice - ask) / point;
         // 1. Auto Break-Even (SL+)
         if(AutoBreakEvenEnabled && profitPoints >= beTriggerPts)
           {
            double beSl = NormalizeDouble(openPrice - (BreakEvenLockPoints * point), digits);
            if(currentSl == 0.0 || currentSl > beSl + (point * 0.5))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, beSl, currentTp))
                 {
                  PrintFormat("Auto SL+ triggered for SELL #%I64d: moved SL to %.2f (profit=%.1f pts, trigger=%d pts)", ticket, beSl, profitPoints, beTriggerPts);
                  currentSl = beSl;
                 }
              }
           }
         // 2. Trailing Stop
         if(TrailingStopEnabled && profitPoints >= TrailingStartPoints)
           {
            double targetSl = NormalizeDouble(ask + (trailingDistPts * point), digits);
            if(currentSl == 0.0 || targetSl < currentSl - (TrailingStepPoints * point))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, targetSl, currentTp))
                 {
                  PrintFormat("Trailing Stop adjusted for SELL #%I64d: SL moved to %.2f (distance=%d pts)", ticket, targetSl, trailingDistPts);
                 }
              }
           }
        }
     }
  }

void OnTick()
  {
   ManageTrailingAndBreakEven();
   ulong nowTick = GetTickCount64();
   string sym = ResolveGoldSymbol();
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if((bid != g_lastBid || ask != g_lastAsk) &&
      (g_lastTickWriteMs == 0 || (nowTick - g_lastTickWriteMs) >= (ulong)MathMax(50, MinTickIntervalMs)))
     {
      WriteStateJson();
      g_lastBid = bid;
      g_lastAsk = ask;
      g_lastTickWriteMs = nowTick;
      g_lastStateAt = TimeGMT();
     }
   ProcessIntentsFile();
  }

void OnTimer()
  {
   ManageTrailingAndBreakEven();
   datetime nowGmt = TimeGMT();
   if(g_lastStateAt == 0 || (nowGmt - g_lastStateAt) >= MathMax(1, StateEverySeconds))
     {
      string sym = ResolveGoldSymbol();
      WriteStateJson();
      g_lastBid = SymbolInfoDouble(sym, SYMBOL_BID);
      g_lastAsk = SymbolInfoDouble(sym, SYMBOL_ASK);
      g_lastTickWriteMs = GetTickCount64();
      g_lastStateAt = nowGmt;
     }
   WriteCorpusJson();
   WriteCorpusMacroJson();
   WriteCalendarJson();
   ProcessIntentsFile();
  }
//+------------------------------------------------------------------+
