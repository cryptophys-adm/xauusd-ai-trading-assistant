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
//|     never includes the account login/number.                     |
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
//|                                                                  |
//| WARNING — Do NOT run alongside CryptophysXAUUSD.mq5:             |
//|   - Never attach OmegaExecutor.mq5 on the same trading account   |
//|     as CryptophysXAUUSD.mq5; doing so would cause double         |
//|     execution of H1 decisions.                                   |
//|                                                                  |
//| How it is attached:                                              |
//|   - Automatically via the [StartUp] section of                   |
//|     terminal_gateway.ini managed by omega-bridge                 |
//|     (Expert=OmegaExecutor, Symbol=XAUUSD, Period=M1), or         |
//|     manually on a chart profile when OMEGA_TAKE_STARTUP=false.   |
//+------------------------------------------------------------------+
#property copyright "Cryptophys"
#property version   "1.13"

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

const string OMEGA_EXECUTOR_VERSION = "1.13"; // keep equal to #property version
const string OMEGA_FOLDER    = "omega";
const string STATE_TMP_PATH  = "omega/state.tmp";
const string STATE_JSON_PATH = "omega/state.json";
const string INTENTS_PATH    = "omega/intents.txt";
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
//| Automatic Gold / XAUUSD symbol discovery across brokers          |
//+------------------------------------------------------------------+
bool IsGoldSymbolName(const string name)
  {
   string up = name;
   StringToUpper(up);
   return (StringFind(up, "XAUUSD") == 0 || StringFind(up, "GOLD") == 0);
  }

string ResolveGoldSymbol()
  {
   if(g_tradeSymbol != "" && SymbolInfoInteger(g_tradeSymbol, SYMBOL_EXIST))
     {
      SymbolSelect(g_tradeSymbol, true);
      if(SymbolInfoDouble(g_tradeSymbol, SYMBOL_BID) > 0.0)
         return g_tradeSymbol;
     }

   if(IsGoldSymbolName(_Symbol) && SymbolInfoInteger(_Symbol, SYMBOL_EXIST))
     {
      SymbolSelect(_Symbol, true);
      if(SymbolInfoDouble(_Symbol, SYMBOL_BID) > 0.0)
        {
         g_tradeSymbol = _Symbol;
         return g_tradeSymbol;
        }
     }

   string candidates[] = {
      "XAUUSD", "XAUUSD.m", "XAUUSDm", "GOLD",
      "XAUUSD.s", "XAUUSD.v", "XAUUSD.pro", "XAUUSD.r",
      "XAUUSD.ecn", "XAUUSDc", "XAUUSDz", "GOLD.m", "GOLDm"
   };
   string firstExisting = "";
   for(int i = 0; i < ArraySize(candidates); i++)
     {
      string c = candidates[i];
      if(SymbolInfoInteger(c, SYMBOL_EXIST))
        {
         SymbolSelect(c, true);
         if(firstExisting == "") firstExisting = c;
         if(SymbolInfoDouble(c, SYMBOL_BID) > 0.0)
           {
            g_tradeSymbol = c;
            return g_tradeSymbol;
           }
        }
     }

   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
     {
      string s = SymbolName(i, false);
      if(!IsGoldSymbolName(s)) continue;
      SymbolSelect(s, true);
      if(firstExisting == "") firstExisting = s;
      if(SymbolInfoDouble(s, SYMBOL_BID) > 0.0)
        {
         g_tradeSymbol = s;
         return g_tradeSymbol;
        }
     }

   if(firstExisting != "")
     {
      g_tradeSymbol = firstExisting;
      return g_tradeSymbol;
     }
   g_tradeSymbol = _Symbol;
   return g_tradeSymbol;
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

   string positionsJson = BuildPositionsJson();
   string ordersJson = BuildOrdersJson();
   string dealsJson = BuildDealsJson();
   long receivedMs = NowUtcMs();

   string json = StringFormat(
      "{\"connected\":%s,\"server\":\"%s\","
      "\"account\":{\"trade_mode\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"day_start_balance\":%.2f,\"day_realized_pl\":%.2f},"
      "\"symbol\":{\"name\":\"%s\",\"digits\":%d,\"point\":%s,\"tick_size\":%s,\"tick_value\":%s,\"volume_min\":%.4f,\"volume_max\":%.4f,\"volume_step\":%.4f,\"stops_level_points\":%d,\"bid\":%s,\"ask\":%s,\"spread_points\":%d,\"atr_value\":%.2f,\"atr_points\":%d},",
      connected ? "true" : "false",
      server,
      tradeMode,
      currency,
      balance,
      equity,
      dayStartBalance,
      dayRealizedPl,
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
      atrPoints
   );
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
      if(StringFind(id, "manual") < 0 && StringFind(id, "kill") < 0 && StringFind(id, "force") < 0)
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
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
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
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
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
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
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
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   bool ok = trade.PositionModify(ticket, sl, newTp);
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
   g_atrHandle = iATR(sym, PERIOD_M15, 14);
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(sym);
   EventSetTimer(1);
   WriteStateJson();
   g_lastStateAt = TimeGMT();
   PrintFormat("OmegaExecutor initialized on %s (chart=%s, magic=%I64d, dynamic_atr=%s)", sym, _Symbol, MagicNumber, DynamicAtrStopEnabled ? "true" : "false");
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
