# MetaTrader 5 Expert Advisor (owner decisions 2026-11-09)

The owner's MT5 terminal executes the H1 decision. The server only publishes the signal; it never holds a broker credential and never sizes a position. Source: `ea/mt5/CryptophysXAUUSD.mq5` (version 1.10). Signal: `src/ea-signal.mjs`. Monitoring and control: **Omega**, `https://omega.cryptophys.work` (below).

## What the EA does
- Every `PollSeconds` (30) it reads `GET https://ai.cryptophys.work/api/ea/signal`, one flat JSON object: `kill` (with `kill_source`: env or omega), `paused`, `blackout`, `signal_id`, `side`, `action`, `entry`, `stop`, `tp1`, `issued_ms`, `expires_ms`, `market_price`, `server_ms`.
- A new BUY or SELL signal opens one position:
  - **Size:** `RiskPercent` of equity divided by the loss at the stop (the broker's tick value); below the broker's minimum volume there is no trade.
  - **Levels as distances:** the stop and target keep the signal's distances from the entry, applied to this broker's price (the feed is OANDA; brokers quote differently). A limit plan's price is shifted by (broker mid − feed price).
  - **Market plan:** only while the broker's price is within `MaxChaseFraction` (0.5) of the stop distance from the planned entry.
  - **Limit plan:** a pending order that expires with the signal (the next H1 close).
- **It never enters** when:
  - the signal is older than `MaxSignalAgeMinutes` (45) after the H1 close, or has expired;
  - the event gate is active (`blackout`, 2 hours before to 30 minutes after a High-impact USD event);
  - the spread is above `MaxSpreadPoints`;
  - today's result of this EA is a loss of `MaxDailyLossPercent` (2) of the day's starting balance or more;
  - it already holds `MaxPositions` (1);
  - the account is **real** and `AllowLiveAccount` is false.
- An opposite signal closes its open position first (`CloseOnOpposite`).
- `kill: true` closes every position and order of the EA (`MagicNumber`) and stops it from entering.
- `paused: true` (set in Omega): no new entry and no pending order; the EA deletes its pending orders, and open positions keep their stop and target.
- Every `HeartbeatMinutes` (5) it posts its state to `POST /api/ea/heartbeat`: mode (demo, live, contest), whether it may trade, the control it applies, the number of positions and each open position (ticket, side, volume, entry, stop, target, floating P&L, open time, signal), the floating and today's P&L in the account currency, last signal, today's loss, spread and a note. No account number.
- Every position it closes is reported once to `POST /api/ea/deal` (side, volume, entry and exit, stop and target, profit, commission, swap, the reason: tp, sl, opposite, kill, manual, stopout, other; the signal; open and close times). Reports wait in a queue of 50 and are retried at the next poll when the server cannot be reached. `GET /api/ea/status` shows the signal, the control and the last heartbeat.

## Install (owner)
1. **Service token:** Cloudflare Zero Trust → Access → Service Auth → Create a service token named `cryptophys-agent-mt5-ea` (the name must start with `cryptophys-agent-`). Keep the Client ID and Client Secret in a password manager. Never paste them in a chat.
2. **Admit the token:** in `cryptophys-cloud-platform`, run the workflow **Provision Cloudflare Access** (input `PROVISION`). It adds every `cryptophys-agent-*` token to the `external-agents` policy of the Access application, which covers `ai.cryptophys.work/api/*`.
3. **MetaTrader 5:** copy `CryptophysXAUUSD.mq5` into `MQL5/Experts/`, then compile it in MetaEditor (F7).
4. **Allow the URL:** Tools → Options → Expert Advisors → enable "Allow WebRequest for listed URL" and add `https://ai.cryptophys.work`. (Version 1.10 also posts to `/api/ea/deal`; `DealUrl` empty turns that off.)
5. **Attach the EA** to an XAUUSD chart (any timeframe), enable Algo Trading, and set the inputs:
   - `CfAccessClientId` and `CfAccessClientSecret`: the service token.
   - `TradeSymbol`: the broker's symbol if it is not the chart's (for example `GOLD`).
   - `RiskPercent`, `MaxDailyLossPercent`, `MaxSpreadPoints`: the risk limits.
   - `AllowLiveAccount`: true only on the real account, after a run on a demo account.
6. **Check:** the Experts tab says "Cryptophys EA started …", and Omega (`https://omega.cryptophys.work`) shows "EA connected" with the heartbeat.

## Omega Execution Engine (`https://omega.cryptophys.work`)
Owner decisions of 2026-11-09: a page separate from Nexus and Aether, on its own subdomain, to monitor and control the EA.
- **Shows:** the signal, the control, the EA's heartbeat (connected when younger than 15 minutes), its open positions, the closed deals with today's, 7-day and 30-day statistics (net P&L, win rate, profit factor, maximum drawdown) and the control audit.
- **Controls:** **Pause entries** (no new entry; open positions keep their stop and target), **Resume**, and **Kill** (the EA closes its positions and orders and stops; type `KILL` to confirm). Pausing or killing needs a reason. Only a signed-in person can change the control, never a service token; each change is recorded with the person's Access email (D1 `ea_control_events`). The EA applies it at its next poll (30 seconds).
- **Access:** behind the platform's Cloudflare Access application (owner sign-in). The Worker also verifies the Access JWT itself, including its audience, and serves no data without the audience, so it stays closed even before Access covers the hostname. Only a signed-in person sees positions, deals and P&L; a service token (CI, an external agent, the EA's own token) reads only the control mode and whether the EA is connected.
- The server-wide switch `EA_SIGNALS_ENABLED = "false"` stays above Omega: while it is on, Omega's control has no effect.

## Stopping
- **From Omega:** Pause entries, or Kill (close all).
- **Everything, from the server:** set `EA_SIGNALS_ENABLED = "false"` (a reviewed PR to `wrangler.jsonc`, deployed by merge). Every EA closes its positions at its next poll.
- **One terminal:** remove the EA from the chart or switch off Algo Trading.
