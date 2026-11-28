//+------------------------------------------------------------------+
//| OmegaFeed.mq5                                                    |
//| F3 (OF1; owner 2026-11-27 "Setuju"): a DATA-ONLY exporter for a  |
//| second MT5 terminal (the feed bridge, OMEGA_ROLE=feed). It has   |
//| no trade code at all: it never opens, closes or modifies an      |
//| order or a position, and reads no intents file.                  |
//|   - Writes omega/state.json (connected, server, the gold         |
//|     symbol's quote and contract; no account amount, no login)    |
//|   - Writes omega/corpus.json once per closed M1 bar (the gold    |
//|     symbol's closed M1 bars, the same format OmegaExecutor uses) |
//|   - 1.01 (macro export, owner 2026-11-27): writes                |
//|     omega/corpus_macro.json once per closed gold M1 bar, the     |
//|     closed M1 bars of the macro symbols named in MacroSymbols    |
//|     (BASE=SYMBOL, explicit names: nothing is guessed), in the    |
//|     executor's corpus_macro format.                              |
//|   - 1.02 (BF1 c, backfill): when the bridge writes               |
//|     omega/corpus_from.json { from_ms }, corpus.json holds the    |
//|     closed M1 bars from there to the last closed bar (at most    |
//|     600, the server's 10-hour window) and echoes backfill_from_ms;|
//|     without the file it is 1.01's last CorpusBars bars.          |
//|   - 1.03 (feed incident 2026-11-28 10:25:58Z): corpus.json and   |
//|     corpus_macro.json are written only while the terminal is     |
//|     connected and its server offset has stayed the same for      |
//|     TIME_BASE_STABLE_TICKS (60) timer ticks in a row, about a    |
//|     minute (a logged-out terminal takes its own clock for the    |
//|     server's: bars two hours off; after a weekend login the      |
//|     server time can sit stale for a while). Any change of the    |
//|     offset or a disconnect starts the count again. state.json as |
//|     before.                                                      |
//| The gold symbol is the input FeedSymbol, else the chart's symbol |
//| (OANDA: "XAUUSD.sml"). Its contract is recorded, never checked.  |
//+------------------------------------------------------------------+
#property copyright "Cryptophys"
#property version   "1.03"
#property strict

input string FeedSymbol   = "";   // the gold symbol on this server (empty: the chart's symbol)
input int    CorpusBars   = 120;  // closed M1 bars kept in corpus.json (10 to 240)
input int    StateSeconds = 5;    // how often state.json is refreshed (seconds)
// Macro export (1.01): BASE=SYMBOL pairs, comma separated. The bases are the server's (silver, WTI oil, the dollar
// index's pairs); the symbols are this server's exact names (OANDA: the ".sml" suffix where it has one). USDSEK is
// not offered by OANDA's feed, so it is not listed; Brent has no reader.
input bool   MacroEnabled = true;
input string MacroSymbols = "XAGUSD=XAGUSD,USOIL=USOIL.sml,EURUSD=EURUSD.sml,GBPUSD=GBPUSD.sml,USDJPY=USDJPY.sml,USDCAD=USDCAD,USDCHF=USDCHF";
input int    MacroBars    = 240;  // closed M1 bars per macro symbol (10 to 240)

const string OMEGA_FEED_VERSION = "1.03"; // keep equal to #property version
const string STATE_JSON_PATH  = "omega/state.json";
const string STATE_TMP_PATH   = "omega/state.tmp";
const string CORPUS_JSON_PATH = "omega/corpus.json";
const string CORPUS_TMP_PATH  = "omega/corpus.tmp";
const string CORPUS_MACRO_JSON_PATH = "omega/corpus_macro.json";
const string CORPUS_MACRO_TMP_PATH  = "omega/corpus_macro.tmp";
const string CORPUS_FROM_JSON_PATH  = "omega/corpus_from.json"; // 1.02: written by the bridge, read only here
const int    BACKFILL_MAX_BARS      = 600;
const int    TIME_BASE_STABLE_TICKS = 60;   // 1.03: ticks (EventSetTimer(1): seconds) of one unchanged offset while connected

datetime g_lastCorpusBar = 0;
datetime g_lastMacroBar  = 0;
long     g_lastFromMs    = -1;   // 1.02: the backfill start the last corpus.json answered (0: none)
long     g_lastStateMs   = 0;
// 1.03: the time base. Ready only while connected and after TIME_BASE_STABLE_TICKS ticks of one unchanged offset.
bool     g_timeBaseReady  = false;
int      g_offsetStableTicks = 0;
int      g_offsetLast     = 0;
int      g_timeBaseOffset = 0;

string EscapeJson(const string s)
  {
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   return out;
  }

long NowUtcMs() { return (long)TimeGMT() * 1000; }

string FeedGoldSymbol()
  {
   string s = FeedSymbol;
   StringTrimLeft(s);
   StringTrimRight(s);
   if(s == "") s = _Symbol;
   SymbolSelect(s, true);
   return s;
  }

int ServerUtcOffsetSeconds()
  {
   // Broker bar times are server time; brokers sit on whole quarter hours from UTC.
   long diff = (long)(TimeTradeServer() - TimeGMT());
   return (int)(MathRound(diff / 900.0) * 900);
  }

// 1.03: once per timer tick. A disconnect or any change of the offset starts the count again; the corpus files wait
// until the offset has stayed the same for TIME_BASE_STABLE_TICKS ticks in a row while connected.
void UpdateTimeBase()
  {
   if(!(bool)TerminalInfoInteger(TERMINAL_CONNECTED)) { g_offsetStableTicks = 0; g_timeBaseReady = false; return; }
   int offset = ServerUtcOffsetSeconds();
   if(g_offsetStableTicks == 0 || offset != g_offsetLast) { g_offsetLast = offset; g_offsetStableTicks = 1; g_timeBaseReady = false; return; }
   if(g_offsetStableTicks < TIME_BASE_STABLE_TICKS) g_offsetStableTicks++;
   g_timeBaseReady = g_offsetStableTicks >= TIME_BASE_STABLE_TICKS;
   if(g_timeBaseReady) g_timeBaseOffset = offset;
  }

void WriteStateJson()
  {
   string sym = FeedGoldSymbol();
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double contract = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   string profitCcy = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
   bool connected = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   string json = StringFormat(
      "{\"feed\":true,\"feed_version\":\"%s\",\"connected\":%s,\"server\":\"%s\",\"received_ms\":%I64d,\"symbol\":{\"name\":\"%s\",\"bid\":%s,\"ask\":%s,\"digits\":%d,\"contract_size\":%s,\"currency_profit\":\"%s\"}}",
      OMEGA_FEED_VERSION, connected ? "true" : "false", EscapeJson(AccountInfoString(ACCOUNT_SERVER)), NowUtcMs(),
      EscapeJson(sym), DoubleToString(bid, digits), DoubleToString(ask, digits), digits,
      DoubleToString(contract, 2), EscapeJson(profitCcy));
   int h = FileOpen(STATE_TMP_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   FileMove(STATE_TMP_PATH, 0, STATE_JSON_PATH, FILE_REWRITE);
  }

// 1.02: the backfill start the bridge asks for (UTC ms), or 0. Accepted only inside the last 11 hours and before now.
long BackfillFromMs()
  {
   if(!FileIsExist(CORPUS_FROM_JSON_PATH)) return 0;
   int h = FileOpen(CORPUS_FROM_JSON_PATH, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return 0;
   string text = "";
   while(!FileIsEnding(h) && StringLen(text) < 512) text += FileReadString(h);
   FileClose(h);
   int k = StringFind(text, "\"from_ms\"");
   if(k < 0) return 0;
   int c = StringFind(text, ":", k);
   if(c < 0) return 0;
   string digitsText = "";
   for(int i = c + 1; i < StringLen(text) && StringLen(digitsText) < 16; i++)
     {
      ushort ch = StringGetCharacter(text, i);
      if(ch == ' ') { if(digitsText == "") continue; break; }
      if(ch < '0' || ch > '9') break;
      digitsText += ShortToString(ch);
     }
   long fromMs = StringToInteger(digitsText);
   long nowMs = NowUtcMs();
   if(fromMs <= 0 || fromMs >= nowMs || fromMs < nowMs - 11 * 3600 * (long)1000) return 0;
   return fromMs - (fromMs % 60000);
  }

void WriteCorpusJson()
  {
   if(!g_timeBaseReady) return; // 1.03: never a bar on an unconfirmed clock
   string sym = FeedGoldSymbol();
   datetime lastClosed = iTime(sym, PERIOD_M1, 1);
   long fromMs = BackfillFromMs();
   if(lastClosed == 0 || (lastClosed == g_lastCorpusBar && fromMs == g_lastFromMs)) return;
   int n = (int)MathMax(10, MathMin(240, CorpusBars));
   int offset = g_timeBaseOffset;
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int got = 0;
   if(fromMs > 0)
     {
      // From the asked minute (server time) to the last closed bar, oldest first; the newest 600 if more.
      datetime fromServer = (datetime)(fromMs / 1000 + offset);
      got = CopyRates(sym, PERIOD_M1, fromServer, lastClosed, rates);
     }
   else
      got = CopyRates(sym, PERIOD_M1, 1, n, rates); // from shift 1: closed bars only, oldest first
   if(got <= 0) return;
   int first = (fromMs > 0 && got > BACKFILL_MAX_BARS) ? got - BACKFILL_MAX_BARS : 0;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string bars = "";
   for(int i = first; i < got; i++)
     {
      long tMs = ((long)rates[i].time - offset) * 1000;
      if(i > first) bars += ",";
      bars += StringFormat("[%I64d,%s,%s,%s,%s,%I64d,%d]", tMs,
                           DoubleToString(rates[i].open, digits), DoubleToString(rates[i].high, digits),
                           DoubleToString(rates[i].low, digits), DoubleToString(rates[i].close, digits),
                           rates[i].tick_volume, rates[i].spread);
     }
   string echo = fromMs > 0 ? StringFormat(",\"backfill_from_ms\":%I64d", fromMs) : "";
   string json = StringFormat("{\"server\":\"%s\",\"symbol\":\"%s\",\"timeframe\":\"M1\",\"digits\":%d,\"utc_offset_s\":%d,\"written_ms\":%I64d%s,\"bars\":[%s]}",
                              EscapeJson(AccountInfoString(ACCOUNT_SERVER)), EscapeJson(sym), digits, offset, NowUtcMs(), echo, bars);
   int h = FileOpen(CORPUS_TMP_PATH, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, json);
   FileClose(h);
   if(FileMove(CORPUS_TMP_PATH, 0, CORPUS_JSON_PATH, FILE_REWRITE)) { g_lastCorpusBar = lastClosed; g_lastFromMs = fromMs; }
  }

// Once per closed gold M1 bar: the macro symbols' closed M1 bars, oldest first, one series per base, in the same
// format as OmegaExecutor's corpus_macro.json (the bridge's readCorpusMacro reads both). A symbol this server does not
// have, or with no bars yet, is left out; nothing else is tried in its place.
void WriteCorpusMacroJson()
  {
   if(!MacroEnabled || !g_timeBaseReady) return; // 1.03: as the gold corpus
   string gold = FeedGoldSymbol();
   datetime lastClosed = iTime(gold, PERIOD_M1, 1);
   if(lastClosed == 0 || lastClosed == g_lastMacroBar) return;
   int n = (int)MathMax(10, MathMin(240, MacroBars));
   int offset = g_timeBaseOffset;
   string entries[];
   int count = StringSplit(MacroSymbols, ',', entries);
   string series = "";
   int written = 0;
   for(int e = 0; e < count; e++)
     {
      string pair[];
      if(StringSplit(entries[e], '=', pair) != 2) continue;
      string base = pair[0];
      string sym = pair[1];
      StringTrimLeft(base);
      StringTrimRight(base);
      StringTrimLeft(sym);
      StringTrimRight(sym);
      StringToUpper(base);
      if(base == "" || sym == "") continue;
      if(!SymbolSelect(sym, true)) continue;
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

int OnInit()
  {
   FolderCreate("omega");
   EventSetTimer(1);
   WriteStateJson();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
  {
   UpdateTimeBase();
   long nowMs = NowUtcMs();
   if(nowMs - g_lastStateMs >= (long)MathMax(1, StateSeconds) * 1000)
     {
      WriteStateJson();
      g_lastStateMs = nowMs;
     }
   WriteCorpusJson();
   WriteCorpusMacroJson();
  }
//+------------------------------------------------------------------+
