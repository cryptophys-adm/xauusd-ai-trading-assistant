# RFC: MT5 fallback feed when TradingView stops

Owner, 2026-11-11: "ya rancang jalur cadangan dari bar MT5".

## Why

On 2026-11-11 at 13:05 UTC the TradingView provider quota ran out. The gateway paused every pull until
00:00 UTC. For about 11 hours of an open market the system had no price:
- The XAUUSD series stood at the 13:00 bar (4044.14) while the broker quoted 4022.
- No 5m context reached the AI Worker, so no 15m War Room met. The 1H room of 14:00 did not meet.
- News stopped at 13:07 and parity at 13:10.
- The Decision Engine kept deciding from the sweep, and its `fresh` guardrail held every bar at WAIT.

Meanwhile the owner's MT5 terminal, through the Omega bridge, kept syncing every few seconds with the
broker's live price. The broker's bars were at hand, but nothing read them.

## What the fallback is

When TradingView stops, the broker's closed M1 bars stand in for TradingView's `OANDA:XAUUSD` M1 bars.
Everything downstream stays as it is:
- M5 and M15 are already aggregated from M1 (`derived-series.mjs`).
- The local engines run their own code on those bars.
- The 5m context, the rooms and the Decision Engine follow.

When TradingView comes back, its native bars overwrite the fallback bars. The series merge keeps the
newer data, and the gap re-pull covers the outage, so the series heals itself.

## Design

1. **Source: the Corpus Oracle (phase 1, already built).**
   - The Omega executor writes the broker's closed M1 bars. The bridge sends them with each sync.
   - The AI Worker keeps them in D1 `corpus_bars`, but only from Omega's active broker, pair and
     user.
   - Prerequisites:
     - `CORPUS_ORACLE_MODE = "shadow"` (today `off`, so nothing is kept).
     - `CorpusOracleEnabled = true` in OmegaExecutor on the MT5 host.
     - The bridge and executor from #243 installed on the host.

2. **Transport.** A read-only RPC on the AI Worker's `LocalComputationIngress`:
   - `corpusBars({ since_ms, limit })` returns the active source's M1 bars after a time.
   - The pull adapter calls it over its existing `AI_WORKER` Service Binding. No new secret is needed.

3. **When the fallback starts.** At a pull, the pull adapter switches the M1 chart source to the
   broker when both of these hold:
   - The market trades.
   - The TradingView gateway is in cooldown (`TvGateway`'s pull answers `mcp_quota_cooldown_active`
     or `daily_budget_exhausted`), or the M1 series is more than 10 minutes behind.

   It stops at the first native M1 pull that succeeds.

4. **Scale (the basis).** The broker's price is not OANDA's price. While both feeds run, the Corpus
   Oracle measures the offset (broker minus TradingView) on the overlapping minutes
   (`GET /api/corpus/status`).
   - At the start of a fallback, the median offset of the last 24 hours is frozen and subtracted
     from the broker bars. Levels, zones and the rooms' memory then stay on one scale.
   - With fewer than 120 overlapping minutes, the bars go in unadjusted, and the records say so.

5. **The series.**
   - Fallback bars are merged into `OANDA:XAUUSD|1m` with `src: "mt5"`. M5 and M15 derive as today.
   - H1, H4 and D1 are native pulls today. During a fallback, their bars are aggregated from M1
     (`aggregateCandles`), also marked `src: "mt5"`.
   - USOIL, DXY, US10Y, XAGUSD and USDT dominance have no broker source. They stay stale, and their
     witnesses drop out (the Macro room, macro drivers, correlations).
   - News stays stale, so News Daily drops out. Weights renormalise as they already do.

6. **Local engines and parity.**
   - The engines run unchanged, so their implementation identities and their parity trust do not
     change.
   - Every record built on fallback bars carries `feed: "mt5_fallback"`.
   - The parity registry skips fallback candles. They neither earn nor cost an approval, because
     TradingView's own output for those candles may never come.

7. **The decision.**
   - The rooms meet again, and the `fresh` guardrail passes.
   - Every decision made on fallback bars records `feed: "mt5_fallback"`.
   - It carries a caution: "market data from the broker (MT5 fallback); news and macro are stale".
   - Owner choice 1 below decides what such a decision may do.

8. **Execution.** Omega already trades on the broker's price and converts the plan into distances from
   it. On fallback bars the plan sits on the basis-adjusted broker scale, so the conversion stays the
   same.

9. **Visibility.**
   - The `market_data_stale` alert (#256) says when the fallback is on and with which basis.
   - The 5m context and Nexus show a "Broker feed (MT5 fallback)" badge.
   - Telegram reports the start and the end.

10. **Cost.** No TradingView call during a fallback. The pull adapter's daily budget is untouched.

## Switch

`FEED_FALLBACK_MODE` on the pull adapter:
- `off`: no fallback.
- `shadow`: build the fallback series under a separate key, measured only.
- `auto`: replace the M1 source while TradingView is down.

Rollout:
1. `CORPUS_ORACLE_MODE = shadow`, for at least one trading day, to collect bars and the basis.
2. `FEED_FALLBACK_MODE = shadow`.
3. `FEED_FALLBACK_MODE = auto`.

## Owner choices

1. **What a fallback decision may do:**
   - (a) Trade as usual.
   - (b) Trade with its confidence capped.
   - (c) Advisory only: decided and shown, never executed by Omega or the EA.
2. **Scale:** basis-adjusted (recommended, so levels stay continuous) or the broker's raw price.
3. **Start collecting now:** `CORPUS_ORACLE_MODE = shadow` today. Also confirm that the MT5 host runs
   the #243 bridge and executor, with `CorpusOracleEnabled` on.

## Out of scope

- Computing the engines on broker bars all the time (Corpus Oracle phase 2, parity per broker
  identity).
- Any other broker feed for macro symbols.
