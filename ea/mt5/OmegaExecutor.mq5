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
#property version   "1.00"

#include <Trade/Trade.mqh>

input long MagicNumber       = 920200; // Magic number for OmegaExecutor orders & positions
input int  SlippagePoints    = 30;     // Max price deviation in points for market execution
input int  StateEverySeconds = 1;      // How often omega/state.json is refreshed on timer (seconds)
input int  MinTickIntervalMs = 250;    // Minimum interval between tick-driven state.json writes (ms)
input int  MaxIntentsAgeSeconds = 30;  // ignore an intents.txt older than this (bridge down, terminal restarted)

//--- Profit Protection & Local Risk Management (Owner Approved)
input bool   AutoBreakEvenEnabled   = true;  // Auto SL+ (Break-Even) enabled
input int    BreakEvenTriggerPoints = 150;   // Profit points to lock SL+ (150 pts = $1.50)
input int    BreakEvenLockPoints    = 20;    // Profit points secured in SL+ (20 pts = $0.20)
input bool   TrailingStopEnabled    = true;  // Micro Trailing Stop enabled
input int    TrailingStartPoints    = 250;   // Profit points before trailing activates (250 pts = $2.50)
input int    TrailingDistancePoints = 150;   // Distance of trailing stop from current price
input int    TrailingStepPoints     = 30;    // Minimum step to modify trailing SL

const string OMEGA_FOLDER    = "omega";
const string STATE_TMP_PATH  = "omega/state.tmp";
const string STATE_JSON_PATH = "omega/state.json";
const string INTENTS_PATH    = "omega/intents.txt";
const string PROCESSED_PATH  = "omega/processed.txt";
const string RESULTS_PATH    = "omega/results.txt";

CTrade   trade;
string   g_processedIds[];
string   g_tradeSymbol = "";
datetime g_lastStateAt = 0;
ulong    g_lastTickWriteMs = 0;
double   g_lastBid = 0.0;
double   g_lastAsk = 0.0;
long     g_lastWriteMs = 0;

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

void AppendResult(const string id, const bool ok, const ulong ticket, const string errorMsg, const long executedMs)
  {
   int h = FileOpen(RESULTS_PATH, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   string ticketField = ticket > 0 ? StringFormat("%I64u", ticket) : "";
   string errField = ok ? "" : CleanCsvField(errorMsg);
   string line = StringFormat("%s;%d;%s;%s;%I64d\n", id, ok ? 1 : 0, ticketField, errField, executedMs);
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
   string out = "[";
   int count = 0;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   long serverMinusUtcSec = (long)(TimeCurrent() - TimeGMT());

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;

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
         "%s{\"ticket\":%I64u,\"side\":\"%s\",\"volume\":%.4f,\"open_price\":%s,\"sl\":%s,\"tp\":%s,\"profit\":%.2f,\"intent_id\":\"%s\",\"opened_ms\":%I64d}",
         count > 0 ? "," : "",
         ticket,
         side,
         volume,
         DoubleToString(openPrice, digits),
         DoubleToString(sl, digits),
         DoubleToString(tp, digits),
         profit,
         intentId,
         openedUtcMs
      );
      count++;
     }
   return out + "]";
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

   string positionsJson = BuildPositionsJson();
   long receivedMs = NowUtcMs();

   string json = StringFormat(
      "{\"connected\":%s,\"server\":\"%s\","
      "\"account\":{\"trade_mode\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"day_start_balance\":%.2f,\"day_realized_pl\":%.2f},"
      "\"symbol\":{\"name\":\"%s\",\"digits\":%d,\"point\":%s,\"tick_size\":%s,\"tick_value\":%s,\"volume_min\":%.4f,\"volume_max\":%.4f,\"volume_step\":%.4f,\"stops_level_points\":%d,\"bid\":%s,\"ask\":%s,\"spread_points\":%d},"
      "\"positions\":%s,\"trade_allowed\":%s,\"received_ms\":%I64d}",
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
      positionsJson,
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

   bool ok = (side == "BUY")
             ? trade.Buy(volume, sym, 0.0, normSl, normTp, id)
             : trade.Sell(volume, sym, 0.0, normSl, normTp, id);

   long executedMs = NowUtcMs();
   if(ok)
     {
      ulong posTicket = ResolveOpenedPositionTicket(id);
      AppendResult(id, true, posTicket, "", executedMs);
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
   if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
     {
      AppendResult(id, false, ticket, "foreign_magic", nowMs);
      return;
     }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   bool ok = trade.PositionClose(ticket, SlippagePoints);
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
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);

   bool allOk = true;
   string lastErr = "";

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
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
      if(OrderGetInteger(ORDER_MAGIC) != MagicNumber) continue;
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
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(sym);
   EventSetTimer(1);
   WriteStateJson();
   g_lastStateAt = TimeGMT();
   PrintFormat("OmegaExecutor initialized on %s (chart=%s, magic=%I64d)", sym, _Symbol, MagicNumber);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
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
         if(AutoBreakEvenEnabled && profitPoints >= BreakEvenTriggerPoints)
           {
            double beSl = NormalizeDouble(openPrice + (BreakEvenLockPoints * point), digits);
            if(currentSl < beSl - (point * 0.5))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, beSl, currentTp))
                 {
                  PrintFormat("Auto SL+ triggered for BUY #%I64d: moved SL to %.2f (profit=%.1f pts)", ticket, beSl, profitPoints);
                  currentSl = beSl;
                 }
              }
           }
         // 2. Trailing Stop
         if(TrailingStopEnabled && profitPoints >= TrailingStartPoints)
           {
            double targetSl = NormalizeDouble(bid - (TrailingDistancePoints * point), digits);
            if(targetSl > currentSl + (TrailingStepPoints * point))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, targetSl, currentTp))
                 {
                  PrintFormat("Trailing Stop adjusted for BUY #%I64d: SL moved to %.2f", ticket, targetSl);
                 }
              }
           }
        }
      else if(posType == POSITION_TYPE_SELL)
        {
         double profitPoints = (openPrice - ask) / point;
         // 1. Auto Break-Even (SL+)
         if(AutoBreakEvenEnabled && profitPoints >= BreakEvenTriggerPoints)
           {
            double beSl = NormalizeDouble(openPrice - (BreakEvenLockPoints * point), digits);
            if(currentSl == 0.0 || currentSl > beSl + (point * 0.5))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, beSl, currentTp))
                 {
                  PrintFormat("Auto SL+ triggered for SELL #%I64d: moved SL to %.2f (profit=%.1f pts)", ticket, beSl, profitPoints);
                  currentSl = beSl;
                 }
              }
           }
         // 2. Trailing Stop
         if(TrailingStopEnabled && profitPoints >= TrailingStartPoints)
           {
            double targetSl = NormalizeDouble(ask + (TrailingDistancePoints * point), digits);
            if(currentSl == 0.0 || targetSl < currentSl - (TrailingStepPoints * point))
              {
               trade.SetExpertMagicNumber(MagicNumber);
               trade.SetDeviationInPoints(SlippagePoints);
               if(trade.PositionModify(ticket, targetSl, currentTp))
                 {
                  PrintFormat("Trailing Stop adjusted for SELL #%I64d: SL moved to %.2f", ticket, targetSl);
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
   ProcessIntentsFile();
  }
//+------------------------------------------------------------------+
