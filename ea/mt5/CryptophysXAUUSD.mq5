//+------------------------------------------------------------------+
//| CryptophysXAUUSD.mq5                                             |
//| Expert Advisor for the Cryptophys XAUUSD H1 decision             |
//| (owner decisions 2026-11-09: "Langsung siap live"; execution on  |
//| the owner's own MetaTrader 5 terminal).                          |
//|                                                                  |
//| It polls GET <ApiUrl> (src/ea-signal.mjs, one flat JSON object)  |
//| through Cloudflare Access with a service token, and:             |
//|   - opens one position per new BUY or SELL signal, sized from    |
//|     RiskPercent of equity and the signal's stop distance;        |
//|   - applies the signal's stop and target as DISTANCES from this  |
//|     broker's price (the feed is OANDA; brokers differ);          |
//|   - never trades when the signal is old, expired, in an event    |
//|     blackout, when the spread is too wide, when the daily loss   |
//|     limit is reached, or on a live account unless               |
//|     AllowLiveAccount is true;                                     |
//|   - closes its positions and stops when the server says "kill".  |
//| Credentials stay in this terminal's inputs. Allow the URL in     |
//| Tools > Options > Expert Advisors > Allow WebRequest.            |
//+------------------------------------------------------------------+
#property copyright "Cryptophys"
#property version   "1.00"

#include <Trade/Trade.mqh>

input string ApiUrl                = "https://ai.cryptophys.work/api/ea/signal";   // signal endpoint
input string HeartbeatUrl          = "https://ai.cryptophys.work/api/ea/heartbeat"; // heartbeat endpoint ("" = off)
input string CfAccessClientId      = "";      // Cloudflare Access service token: Client ID
input string CfAccessClientSecret  = "";      // Cloudflare Access service token: Client Secret
input string TradeSymbol           = "";      // broker symbol ("" = the chart's symbol), e.g. XAUUSD or GOLD
input double RiskPercent           = 0.5;     // risk per trade, % of equity
input double MaxDailyLossPercent   = 2.0;     // no new trade after this loss today, % of the day's starting balance
input int    MaxSpreadPoints       = 60;      // no entry above this spread (points)
input int    MaxSignalAgeMinutes   = 45;      // no entry this long after the H1 bar closed
input double MaxChaseFraction      = 0.5;     // market entry only within this fraction of the stop distance from the planned entry
input int    SlippagePoints        = 30;      // max deviation for market orders
input bool   UseBrokerOffset       = true;    // shift limit levels by (broker price - feed price)
input bool   CloseOnOpposite       = true;    // close an open position when the opposite signal arrives
input int    MaxPositions          = 1;       // positions of this EA at once
input bool   AllowLiveAccount      = false;   // must be true to trade on a REAL account
input long   MagicNumber           = 920111;  // this EA's positions and orders
input int    PollSeconds           = 30;      // how often the signal is read
input int    HeartbeatMinutes      = 5;       // how often the state is reported

CTrade   trade;
string   g_symbol = "";
string   g_lastSignal = "";
datetime g_lastHeartbeat = 0;
string   g_note = "";

//+------------------------------------------------------------------+
//| Minimal flat-JSON readers (the server sends one flat object)     |
//+------------------------------------------------------------------+
int JsonValueStart(const string json, const string key)
  {
   string needle = "\"" + key + "\":";
   int p = StringFind(json, needle);
   if(p < 0) return -1;
   p += StringLen(needle);
   while(p < StringLen(json) && StringGetCharacter(json, p) == ' ') p++;
   return p;
  }

string JsonString(const string json, const string key)
  {
   int p = JsonValueStart(json, key);
   if(p < 0 || StringGetCharacter(json, p) != '"') return "";
   int q = StringFind(json, "\"", p + 1);
   if(q < 0) return "";
   return StringSubstr(json, p + 1, q - p - 1);
  }

double JsonNumber(const string json, const string key)
  {
   int p = JsonValueStart(json, key);
   if(p < 0) return 0.0;
   int q = p;
   while(q < StringLen(json))
     {
      ushort c = StringGetCharacter(json, q);
      if(c == ',' || c == '}' || c == ' ' || c == '\n' || c == '\r') break;
      q++;
     }
   return StringToDouble(StringSubstr(json, p, q - p));
  }

bool JsonBool(const string json, const string key)
  {
   int p = JsonValueStart(json, key);
   if(p < 0) return false;
   return StringSubstr(json, p, 4) == "true";
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
string AccessHeaders()
  {
   string h = "Accept: application/json\r\n";
   if(CfAccessClientId != "" && CfAccessClientSecret != "")
      h += "CF-Access-Client-Id: " + CfAccessClientId + "\r\nCF-Access-Client-Secret: " + CfAccessClientSecret + "\r\n";
   return h;
  }

bool HttpGet(const string url, string &body)
  {
   char data[], result[];
   string headers;
   ResetLastError();
   int status = WebRequest("GET", url, AccessHeaders(), 5000, data, result, headers);
   if(status == -1)
     {
      PrintFormat("Cryptophys EA: WebRequest failed (error %d). Allow %s in Tools > Options > Expert Advisors.", GetLastError(), url);
      return false;
     }
   if(status != 200)
     {
      PrintFormat("Cryptophys EA: signal HTTP %d (check the Access service token)", status);
      return false;
     }
   body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
  }

void HttpPostJson(const string url, const string json)
  {
   if(url == "") return;
   char data[], result[];
   string headers;
   StringToCharArray(json, data, 0, StringLen(json), CP_UTF8);
   WebRequest("POST", url, AccessHeaders() + "Content-Type: application/json\r\n", 5000, data, result, headers);
  }

//+------------------------------------------------------------------+
//| Account and positions                                            |
//+------------------------------------------------------------------+
string AccountMode()
  {
   long m = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(m == ACCOUNT_TRADE_MODE_REAL) return "live";
   if(m == ACCOUNT_TRADE_MODE_CONTEST) return "contest";
   return "demo";
  }

bool TradingAllowedHere()
  {
   if(AccountMode() == "live" && !AllowLiveAccount) { g_note = "live account: set AllowLiveAccount to trade"; return false; }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) { g_note = "algo trading is off in the terminal"; return false; }
   return true;
  }

int MyPositions(int &buys, int &sells)
  {
   buys = 0; sells = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber || PositionGetString(POSITION_SYMBOL) != g_symbol) continue;
      if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) buys++; else sells++;
     }
   return buys + sells;
  }

void CloseMine(const int type) // type: -1 all, POSITION_TYPE_BUY or POSITION_TYPE_SELL
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber || PositionGetString(POSITION_SYMBOL) != g_symbol) continue;
      if(type >= 0 && PositionGetInteger(POSITION_TYPE) != type) continue;
      trade.PositionClose(ticket, SlippagePoints);
     }
  }

void DeleteMyOrders()
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket)) continue;
      if(OrderGetInteger(ORDER_MAGIC) != MagicNumber || OrderGetString(ORDER_SYMBOL) != g_symbol) continue;
      trade.OrderDelete(ticket);
     }
  }

// Today's realised and floating result of this EA, as a % of the balance at the day's start (negative = loss).
double TodayResultPercent()
  {
   MqlDateTime t; TimeToStruct(TimeCurrent(), t);
   t.hour = 0; t.min = 0; t.sec = 0;
   datetime dayStart = StructToTime(t);
   double realised = 0.0;
   if(HistorySelect(dayStart, TimeCurrent()))
     {
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         if(d == 0 || HistoryDealGetInteger(d, DEAL_MAGIC) != MagicNumber) continue;
         realised += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP) + HistoryDealGetDouble(d, DEAL_COMMISSION);
        }
     }
   double floating = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket) || PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      floating += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
     }
   double startBalance = AccountInfoDouble(ACCOUNT_BALANCE) - realised;
   if(startBalance <= 0) return 0.0;
   return 100.0 * (realised + floating) / startBalance;
  }

//+------------------------------------------------------------------+
//| Sizing                                                           |
//+------------------------------------------------------------------+
double LotsForRisk(const double stopDistance)
  {
   double tickSize  = SymbolInfoDouble(g_symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(g_symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0) tickValue = SymbolInfoDouble(g_symbol, SYMBOL_TRADE_TICK_VALUE);
   double step = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MAX);
   if(tickSize <= 0 || tickValue <= 0 || step <= 0 || stopDistance <= 0) return 0.0;
   double riskMoney = AccountInfoDouble(ACCOUNT_EQUITY) * RiskPercent / 100.0;
   double lossPerLot = (stopDistance / tickSize) * tickValue;
   if(lossPerLot <= 0) return 0.0;
   double lots = MathFloor((riskMoney / lossPerLot) / step) * step;
   if(lots < vmin) return 0.0;   // the risk budget is too small for the minimum volume: no trade
   return MathMin(lots, vmax);
  }

//+------------------------------------------------------------------+
//| The signal                                                       |
//+------------------------------------------------------------------+
void ProcessSignal(const string json)
  {
   if(JsonBool(json, "kill"))
     {
      g_note = "kill switch from the server: positions closed";
      CloseMine(-1); DeleteMyOrders();
      return;
     }
   string id = JsonString(json, "signal_id");
   string side = JsonString(json, "side");
   if(id == "" || (side != "BUY" && side != "SELL")) { g_note = "no BUY or SELL signal"; return; }
   if(id == g_lastSignal) return;                        // already handled
   if(GlobalVariableCheck("CPX_LAST_" + (string)MagicNumber) && GlobalVariableGet("CPX_LAST_" + (string)MagicNumber) == JsonNumber(json, "issued_ms")) { g_lastSignal = id; return; }

   double serverMs = JsonNumber(json, "server_ms");
   double issuedMs = JsonNumber(json, "issued_ms");
   double expiresMs = JsonNumber(json, "expires_ms");
   if(serverMs - issuedMs > MaxSignalAgeMinutes * 60000.0 || serverMs >= expiresMs) { g_note = "signal too old"; g_lastSignal = id; return; }
   if(JsonBool(json, "blackout")) { g_note = "event blackout: " + JsonString(json, "blackout_reason"); return; }  // retried until the blackout ends or the signal expires

   double entry = JsonNumber(json, "entry"), stop = JsonNumber(json, "stop"), tp = JsonNumber(json, "tp1");
   bool isBuy = side == "BUY";
   if(entry <= 0 || stop <= 0 || tp <= 0 || (isBuy && !(stop < entry && entry < tp)) || (!isBuy && !(tp < entry && entry < stop))) { g_note = "invalid levels"; g_lastSignal = id; return; }
   double stopDist = MathAbs(entry - stop), tpDist = MathAbs(tp - entry);

   if(!TradingAllowedHere()) return;
   if(-TodayResultPercent() >= MaxDailyLossPercent) { g_note = "daily loss limit reached"; return; }
   long spread = SymbolInfoInteger(g_symbol, SYMBOL_SPREAD);
   if(spread > MaxSpreadPoints) { g_note = StringFormat("spread %d above %d", (int)spread, MaxSpreadPoints); return; }

   int buys, sells;
   MyPositions(buys, sells);
   if(CloseOnOpposite) { if(isBuy && sells > 0) CloseMine(POSITION_TYPE_SELL); if(!isBuy && buys > 0) CloseMine(POSITION_TYPE_BUY); }
   if(MyPositions(buys, sells) >= MaxPositions) { g_note = "position limit reached"; g_lastSignal = id; return; }

   double lots = LotsForRisk(stopDist);
   if(lots <= 0) { g_note = "risk too small for the minimum volume"; g_lastSignal = id; return; }
   int digits = (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS);
   double ask = SymbolInfoDouble(g_symbol, SYMBOL_ASK), bid = SymbolInfoDouble(g_symbol, SYMBOL_BID);
   double feed = JsonNumber(json, "market_price");
   double offset = (UseBrokerOffset && feed > 0) ? ((ask + bid) / 2.0 - feed) : 0.0;
   double minStop = SymbolInfoInteger(g_symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(g_symbol, SYMBOL_POINT);
   if(stopDist <= minStop || tpDist <= minStop) { g_note = "stop or target inside the broker's stop level"; g_lastSignal = id; return; }
   bool ok = false;
   string comment = "cpx " + StringSubstr(id, StringLen(id) - 13);

   if(JsonString(json, "action") == "ENTER_LIMIT")
     {
      double price = NormalizeDouble(entry + offset, digits);
      double sl = NormalizeDouble(isBuy ? price - stopDist : price + stopDist, digits);
      double tpp = NormalizeDouble(isBuy ? price + tpDist : price - tpDist, digits);
      datetime expiry = (datetime)(expiresMs / 1000.0);
      if(isBuy && price < ask) ok = trade.BuyLimit(lots, price, g_symbol, sl, tpp, ORDER_TIME_SPECIFIED, expiry, comment);
      else if(!isBuy && price > bid) ok = trade.SellLimit(lots, price, g_symbol, sl, tpp, ORDER_TIME_SPECIFIED, expiry, comment);
      else { g_note = "limit price already passed: entering at market is not allowed for a limit plan"; g_lastSignal = id; return; }
     }
   else
     {
      double px = isBuy ? ask : bid;
      if(MathAbs(px - (entry + offset)) > MaxChaseFraction * stopDist) { g_note = "price moved too far from the planned entry"; g_lastSignal = id; return; }
      double sl = NormalizeDouble(isBuy ? px - stopDist : px + stopDist, digits);
      double tpp = NormalizeDouble(isBuy ? px + tpDist : px - tpDist, digits);
      ok = isBuy ? trade.Buy(lots, g_symbol, 0.0, sl, tpp, comment) : trade.Sell(lots, g_symbol, 0.0, sl, tpp, comment);
     }

   if(ok)
     {
      g_note = StringFormat("%s %.2f lots on %s", side, lots, id);
      g_lastSignal = id;
      GlobalVariableSet("CPX_LAST_" + (string)MagicNumber, issuedMs);
     }
   else
      g_note = StringFormat("order refused: %d %s", trade.ResultRetcode(), trade.ResultRetcodeDescription());
   Print("Cryptophys EA: ", g_note);
  }

void Heartbeat()
  {
   if(HeartbeatUrl == "" || TimeCurrent() - g_lastHeartbeat < HeartbeatMinutes * 60) return;
   g_lastHeartbeat = TimeCurrent();
   int buys, sells;
   int n = MyPositions(buys, sells);
   string note = g_note;
   StringReplace(note, "\"", "'");
   string json = StringFormat("{\"ea\":\"cryptophys-xauusd\",\"version\":\"1.00\",\"mode\":\"%s\",\"trading_allowed\":%s,\"positions\":%d,\"last_signal_id\":\"%s\",\"daily_loss_pct\":%.2f,\"spread_points\":%d,\"note\":\"%s\"}",
                              AccountMode(), TradingAllowedHere() ? "true" : "false", n, g_lastSignal, -TodayResultPercent(), (int)SymbolInfoInteger(g_symbol, SYMBOL_SPREAD), note);
   HttpPostJson(HeartbeatUrl, json);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   g_symbol = TradeSymbol == "" ? _Symbol : TradeSymbol;
   if(!SymbolSelect(g_symbol, true)) { PrintFormat("Cryptophys EA: symbol %s not available", g_symbol); return INIT_FAILED; }
   if(RiskPercent <= 0 || RiskPercent > 5) { Print("Cryptophys EA: RiskPercent must be above 0 and at most 5"); return INIT_PARAMETERS_INCORRECT; }
   if(CfAccessClientId == "" || CfAccessClientSecret == "") Print("Cryptophys EA: no Access service token set; the signal endpoint will refuse the request");
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(g_symbol);
   EventSetTimer(MathMax(10, PollSeconds));
   PrintFormat("Cryptophys EA started on %s (%s account%s)", g_symbol, AccountMode(), AccountMode() == "live" && !AllowLiveAccount ? ", trading disabled until AllowLiveAccount" : "");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
  {
   string body;
   if(HttpGet(ApiUrl, body)) ProcessSignal(body);
   Heartbeat();
  }
//+------------------------------------------------------------------+
