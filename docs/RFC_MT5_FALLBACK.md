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
   - The TradingView gateway is down (the pull answers `mcp_quota_cooldown_active`, `mcp_quota_exceeded`,
     `gateway_unavailable` or `daily_budget_exhausted`), or the M1 series is more than 10 minutes behind.

   It stops at the first native M1 pull that succeeds. While a series carries the fallback mark, the
   pull adapter tries that pull once every 5 minutes (`healPlan`), so a cooldown does not spend the
   daily budget.

4. **Scale: the broker's raw price** (owner choice 2026-11-11).
   - The broker's bars go in as they are, without a basis adjustment.
   - Levels can step by the broker-to-OANDA offset when a fallback starts and ends.
   - The Corpus Oracle keeps measuring that offset while both feeds run (`GET /api/corpus/status`).
     Each fallback record carries the last measured basis, so an outcome scored across a switch can
     be read with it.

5. **The series.**
   - Fallback bars are merged into `OANDA:XAUUSD|1m` with `src: "mt5"`. M5 and M15 derive as today.
   - H1 is a native pull today. During a fallback, its bars are aggregated from M1
     (`aggregateCandles`), also marked `src: "mt5"`.
   - H4 and D1 (since 2026-11-11, owner: no regression in the AI Worker's input) aggregate from M1 on
     the grid of their last native bar, OANDA's session start (22:00 UTC in winter), not the broker's
     server midnight; only a bucket the 1m series (about 50 hours) covers from its start. W1 waits for
     TradingView. All heal at the next native pull.
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
   - It carries a caution (`MT5_FALLBACK_CAUTION`): "Market data comes from the broker's MT5 bars
     because TradingView is down; news and the macro series are stale."
   - It trades as usual (owner choice 2026-11-11): the same guardrails, no cap, executed by Omega and
     the EA.

8. **Execution.** Omega already trades on the broker's price and converts the plan into distances from
   it. On fallback bars the plan is already on the broker's scale.

9. **Visibility.**
   - A `market_data_fallback` alert is open while the M1 series carries the mark. Telegram reports
     its start and its end.
   - The 5m context (`context:m5:latest`) and every decision record carry `feed`. A Nexus badge is a
     follow-up.

10. **Cost.** No TradingView call during a fallback. The pull adapter's daily budget is untouched.

## Switch

The owner's switch in the War Room (2026-11-11), through Omega (`/omega/api/feed-fallback`, Access, a
person, a reason; audited and sent to Telegram), stored in KV `market-data:v2:feed-fallback-mode`, wins
over the pull adapter's `FEED_FALLBACK_MODE`:
- `off`: no fallback.
- `auto` (production since this change): replace the M1 source while TradingView is down.

A fallback can only use bars the Corpus Oracle has collected (`CORPUS_ORACLE_MODE = shadow` since
#256). Until the corpus holds bars after the last TradingView minute, the step answers
`no_broker_bars` and changes nothing. A separate `shadow` mode was not built: the owner chose to trade
as usual, and the fallback is measured by its records (`feed`) and the corpus basis.

## Implementation

- AI Worker: `readCorpusBars` (`src/corpus-oracle.mjs`) behind `LocalComputationIngress.corpusBars`;
  `src/feed.mjs` (`feedAt`, from the 1m series' `fallback.since_sec` in the shared KV); records and the
  5m context store `feed`; the parity sweep answers `fallback_skipped`; the Decision Engine adds the
  caution and `feed`; health alert `market_data_fallback`.
- Pull adapter: `market-data-ingestion/src/mt5-fallback.mjs` (`applyMt5Fallback`, after each pull and
  before the bundle); `healPlan` and the derived re-aggregation in `tradingview-source.mjs`; the bundle
  says `feed`.

## Owner choices (decided 2026-11-11)

1. **What a fallback decision may do:** trade as usual.
2. **Scale:** the broker's raw price.
3. **Collection:** `CORPUS_ORACLE_MODE = shadow` from #256. The MT5 host runs the #243 bridge and
   executor, with `CorpusOracleEnabled` on.

## Out of scope

- Computing the engines on broker bars all the time (Corpus Oracle phase 2, parity per broker
  identity).
- Any other broker feed for macro symbols.
