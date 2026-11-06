# SSOT — XAUUSD AI Trading Assistant (canonical, current state)

This is the single source of truth for the system's topology, ownership and deployment. If any other document disagrees with this one, this one wins and the other document is historical. Last reconciled: 2026-11-04. Change log: docs/CHANGELOG.md.

## 1. Production topology: exactly four Workers
| Worker | Source | Deployed by (only on push to `main`) | Role |
|---|---|---|---|
| `xauusd-ai-trading-assistant` | `src/`, `wrangler.jsonc` | `deploy-worker.yml` | Webhooks, evidence fusion, autonomous parity registry, the Analyst → Counselor → Reasoner chain, the dashboard read API (`/api/*`) and Telegram |
| `xauusd-fundamental-news-ingestion` | `fundamental-news-ingestion/` | `deploy-fundamental-news-ingestion.yml` (Workers Builds also builds it) | Owns the single TradingView MCP OAuth grant at `news.cryptophys.work/oauth/start`. Serves news (`/pull`, cron `:05`, RPC `NewsIngestionService`) and OHLCV (RPC `TvGateway`) |
| `xauusd-tradingview-pull-adapter` | `market-data-ingestion/`, `local-engines/` | `deploy-market-data-ingestion.yml` | The only owner of local computation for MizanLib, Prophet and GMI (see §3). Serves chart data (RPC `MarketDataReader`) |
| `xauusd-nexus-dashboard` | `workers/xauusd-nexus-dashboard/` | `deploy-nexus-dashboard.yml` | `nexus.cryptophys.work` serves the UI. `/api/ohlcv` comes from `MarketDataReader`; every other `/api/*` request is proxied to the AI Worker |

Removed on 2026-11-04 and **never to be redeployed**:
- `xauusd-mizan-engine`, `xauusd-prophet-engine` and `xauusd-gmi-engine`: stubs that reported `production_ready: true` without computing anything.
- `xauusd-market-data-normalizer` and `xauusd-pull-orchestrator`.
- `xauusd-confluence-controller`: its `/v1/fuse` endpoint was unauthenticated and signed whatever "verified" evidence the caller sent.

The earlier "8 + 1 Workers" plan in older documents is **cancelled**.

`test/ssot-topology.test.mjs` fails if a Wrangler config in this repository declares any other Worker name.

## 2. Inter-Worker calls (RPC Service Bindings, no shared secrets)
- The AI Worker calls `NEWS_INGESTION` → news Worker `NewsIngestionService.pull()`.
- The pull adapter calls:
  - `TV_GATEWAY` → news Worker `TvGateway.ohlcv()`;
  - `AI_WORKER` → AI Worker `LocalComputationIngress.submit()`.
- The dashboard calls `MARKET_DATA` → pull adapter `MarketDataReader.candles()`.
- The AI Worker calls `AGENTS` → Cryptophys Platform `cryptophys-ai-kernel` `AgentRpc` (owner approval 2026-11-05, RFC_INDICATOR_AGENT_PLATFORM P4). This is the only binding to a Worker outside this repository, and it adds no Worker to the topology above.
  - **Identity:** the binding pins `props.host_worker = "xauusd-ai-trading-assistant"`, and there is no secret or token. The kernel lets this Worker act only as the 21 XAUUSD agents registered with that `host_worker` (platform migration 0016), each with `tier_max = 1`. No other Worker, and not the preview config, may carry this binding. `host_worker` never takes another value. `test/ssot-topology.test.mjs` guards both rules.
  - **What is sent** (`src/platform-reports.mjs`, in the parity sweep cron): one advisory report per meaningful event, never per tick.
    - `xauusd-reasoner` (`xauusd_digest`): every new H1 chain decision. A BUY↔SELL flip is `warning`.
    - `xauusd-moderator` (`xauusd_digest`): the War Room 15m conclusion when its stance changes, otherwise at most once an hour.
    - `hud-*` (`hud_digest`): a HUD agent's War Room stance when it moves into or out of BUY or SELL.
    - `xauusd-risk-manager` (`xauusd_digest`, `src/health-alerts.mjs`, owner decision 2026-11-06): system health alerts.
      - **Detected problems:** a revoked parity identity, an input bar that differs from TradingView, a missing local H1 record, a timeframe room without a conclusion 45 minutes after the close, 10+ calls lost to the Workers AI rate limit in an hour, a stale News Daily, and a stale War Room 15m.
      - **Reports:** a `warning` when an alert opens, and an `info` when a lasting alert resolves. At most 3 reports an hour.
      - **Where they live:** D1 `health_alerts` (migration 0009). Nexus shows them as its Priority Queue (`GET /api/health/alerts`).
      - An alert never changes a decision, a room or a parity status.
  - **Rules:**
    - Observations only: decision and confidence, never size, lots, levels or order wording.
    - `critical` is never sent, because the platform opens a GitHub issue for it.
    - A denial (rate limit, kill switch, suspension) or a kernel rejection is recorded and not retried. Only a transport failure is retried, once, by the next sweep.
    - Every failure is non-fatal: the chain runs whether the kernel is up or not.
  - **Cursors and status:** cursors live in D1 `platform_publications` (migration `0007`). `GET /api/platform/status` shows `whoami("xauusd-moderator")`, cached for 5 minutes, and the publications.
  - The platform reads this Worker only through `GET /api/decisions`, and it never writes here.

## 3. Three AI input lanes (local-primary)
Owner decision, 2026-11-05: the architecture does not depend on webhooks. Approved local records drive the chain, and TradingView webhooks only calibrate the local engines. `INDICATOR_SOURCE` controls this: `"local"` is the default; `"webhook"` restores the legacy webhook-driven chain as a rollback.

1. **Local computation** (decision lane). MizanLib (record id `mizan`), Prophet and GMI are computed by the pull adapter from closed TradingView bars.
   - Since 2026-11-05 (owner decision, TradingView MCP budget 800 calls a day), the pull adapter pulls XAUUSD M1, H1, H4, D1 and W1, USOIL 5m, and DXY and USDT 4h.
   - It aggregates XAUUSD M5 and M15 from M1, and USOIL M15 and H1 from USOIL 5m. A daily check compares them with native bars.
   - See docs/MARKET_DATA_INGESTION.md.
   - Trust is earned only through the autonomous parity registry: 24 consecutive candles that match TradingView. There is no manual allowlist and no operator approval.
   - The chain starts as soon as the parity-approved (`localcalc:`) records of a closed H1 candle exist. It does not wait for any webhook.
   - The indicator values the agents read (`source_payloads`, `origin: "local_computation"`) are the approved records' comparable fields. These are the same field names and codes the TradingView alerts carry.
   - A candle whose approved local records do not arrive within 30 minutes of the close is recorded as a fail-closed WAIT. A revoked or never-approved identity therefore never trades.
2. **TradingView webhook** (calibration only). The sources are `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70`, on H1 and 5m.
   - **Prophet is read as one indicator** (owner decision 2026-11-06).
     - Prophet R38 (the standalone indicator) and Prophet R37 (the core inside GMI, which sends `prophet_r37_ssot`) share one MizanLib structure core: their `d_enc` and subtype are identical in production.
     - Every reading therefore decodes them as a single "Prophet": R38's signal and trade management, R37's consensus direction and confirmation candle, and the shared structure once. This covers the TradingView reading of the H1 chain, the H1 bus, the timeframe desks and the Prophet HUD agent.
     - The Prophet HUD agent reads, in order:
       1. its signal (R38 confirmations);
       2. its direction, from the R37 consensus (GMI's `prophet_dir`, equal to the R37 alert's direction);
       3. its structure;
       4. its trade management;
       5. its setup (setup gate and cycles);
       6. its regime.
     - The signal, direction, structure and management lines are each verified by parity.
     - The direction is Prophet's bias.
     - The two alerts stay separate in TradingView for calibration, because the R37 alert proves that GMI's structure equals Prophet's.
   - Webhooks are stored and compared field by field with the local records. They never start the chain and are never decision evidence (`input_lanes.tradingview_webhook.role: "calibration_only"`).
   - Approval persists while no webhook arrives. A mismatch during a calibration run revokes the identity, and the chain then fails closed until it re-earns 24/24.
   - **Input mismatch** (owner decision 2026-11-06). When only the input bar differs (open, high, low, close or volume) and every indicator field agrees, the comparison is `input_mismatch`.
     - It neither counts nor revokes.
     - That candle's records stay out of the trusted lane, so the H1 chain reads the TradingView evidence for it.
     - The pull adapter rebuilds an H1 candle whose bar TradingView revised after publication. It cuts the bundle at that close and publishes once more (`republishRevisedH1`). The new comparison replaces the open one and counts.
     - `INPUT_MISMATCH_REVOKE_AFTER` (3) input mismatches in a row on different candles mean the data pipeline is wrong, so they revoke like a mismatch.
     - One-time reconciliation (owner approval 2026-11-06): `reclassifyOnce` reclassifies the earlier input-only mismatches and restores the identities they revoked (the H1 `prophet` and `gmi` revocations of 2026-11-06). It runs once per database, guarded by a KV marker.
   - **Calibration runbook (for example monthly).**
     1. Install the existing alerts on the H1 chart, and on the 5m chart for the 5m lane.
     2. Leave them on for at least a few candles.
     3. Check `GET /api/status` → `ai_worker.local_lane.calibration`. It shows the last calibration per identity and `calibration_due` after `CALIBRATION_INTERVAL_DAYS`, which defaults to 30.
     4. Remove the alerts again.
   - Any change to a hashed engine file creates a new identity. That identity needs a calibration run of 24/24 before it is trusted.
   - The per-event reconcile and the cron (`10-59/15 * * * *`) are idempotent, so a candle is counted at most once.
3. **Fundamental news**: TradingView MCP news. The AI Worker analyses it at cron `:06`.

Coverage per Pine parameter is in `docs/LOCAL_COMPUTATION_OWNERSHIP.md`.

The parity sweep cron also backfills `runAnalysis` for any closed H1 candle within the last 2 hours that has no `analysis_runs` row. It does so when the candle's approved local records exist, or as a fail-closed WAIT 30 minutes after the close. Analysis stays idempotent via `claimAnalysisRun`.

### 5m execution context
- The evidence key `informational_5m_context` may be surfaced in the fusion bundle. Since B2 it is the
  5m parity record of the bar, reshaped (`local-engines/producer/src/m5-context.mjs`): the pull adapter
  sends it once per closed 5m bar, right after publishing that bar's 5m records. `buildM5ProphetContext`
  (a second, separate 5m computation) is retired.
- The context always declares `informational_unverified`. The AI Worker labels it **VERIFIED 5m**
  (`verification.verified`, `approved_by_parity`) only while `prophet_m5` and `gmi_m5` are approved and that
  bar's observed 5m records come from them (`verifiedM5Reading`); otherwise **UNVERIFIED 5m**.
- Either way it is execution timing only: it is **never** part of `fusion.complete`, and never changes the
  decision, entry/SL/TP, risk/reward, position size or confidence.
- **5m parity records (C0 step 3).** The pull adapter also publishes full mizan, prophet and gmi records for every closed 5m bar (`local-engines/producer/src/m5-local-producer.mjs`, behind `M5_PARITY_PUBLISH`). They have timeframe `"5"` and candle key `OANDA:XAUUSD:5:<open ms>`.
  - The records earn their own approval under the timeframe-scoped ids `prophet_m5`, `gmi_m5` and `mizan_m5`, separate from the approved H1 ids. The parity sweep revisits the last six closed 5m candles.
  - GMI on the 5m chart runs `local-engines/gmi/src/gmi-core-tf.mjs`, a timeframe-parameterised copy of `gmi-core.mjs`. `gmi-core.mjs` stays byte-identical, because it is part of the approved H1 hash. A test proves the copy equals `computeGmi` on H1.
  - The provenance has its own `prophet_m5` and `gmi_m5` entries, so 5m code changes never change the H1 hashes.
- **Verified 15m lane** (owner decision 2026-11-05, same design as 5m).
  - The pull adapter publishes mizan, prophet and gmi records for every closed 15m bar. The producer is `local-engines/producer/src/m15-local-producer.mjs`, behind `M15_PARITY_PUBLISH`, with timeframe `"15"` and candle key `OANDA:XAUUSD:15:<open ms>`, the same key as the 15m HUD snapshot.
  - The records earn their own approval as `prophet_m15` and `gmi_m15`, with their own provenance entries. The H1 and 5m hashes are unchanged. The parity sweep revisits the last two closed 15m candles.
  - Calibration needs the existing Prophet R38 and GMI alerts installed on the 15m chart until both identities are approved (24 matches). After that, the alerts may be removed, as with 5m ("pilihan 1").
  - Once approved, the 15m HUD fields that are alert fields read as verified by parity in the War Room. Engine internals stay uncalibrated until a Pine candidate comparator exists (C1).
- **H4 and D1 lane** (owner decision 2026-11-05: Threads per timeframe D1, H4, H1 and 15m).
  - **Records:** the pull adapter publishes mizan, prophet and gmi records for every closed H4 and D1 bar. The producer is `local-engines/producer/src/htf-local-producer.mjs`, behind `HTF_PARITY_PUBLISH`.
  - **Timeframes and keys:** the timeframes are `"240"` and `"1D"`, as Pine v6 `timeframe.period` reports them. The candle keys are `OANDA:XAUUSD:240:<open ms>` and `OANDA:XAUUSD:1D:<open ms>`.
  - **GMI engine:** GMI runs on `local-engines/gmi/src/gmi-core-htf.mjs`, a copy of `gmi-core-tf.mjs` that adds the H4 and D1 charts and Pine's `dyn_ltf` intrabars (M5 on H4, M15 on D1).
    - `gmi-core-tf.mjs` stays byte-identical, so the `gmi_m5` and `gmi_m15` hashes do not move.
    - A test proves the copy equals `gmi-core-tf.mjs` on M15 and H1.
  - **Identities:** the records earn their own approvals as `prophet_h4`, `gmi_h4`, `prophet_d1` and `gmi_d1`, each with its own provenance entry. No other hash changed.
  - **Sweep:** OANDA H4 and D1 bars open at 17:00 New York, not on epoch multiples. The parity sweep therefore takes the last two closed H4 and D1 keys from the cached native bars (`closedHtfCandleKeys`), never from the clock.
  - **Calibration:** the owner installs the Prophet R38 and GMI alerts on the 4-hour and daily charts, set to "Any alert() function call" with the same webhook.
    - 24 matches take about 4 trading days on H4 and about 5 weeks on D1.
    - Until then, H4 and D1 readings are unverified.
  - **Timeframe War Rooms (owner decision 2026-11-06; supersedes the five-desk H4/D1 threads of step 4):** every Thread, D1, 4H, 1H and 15m, is the consensus of all agents, as in the Live War Room. 15m is the Live War Room; `src/timeframe-threads.mjs` runs the 1H, 4H and D1 rooms.
    - **Phases:** each closed bar of that chart runs the same three phases: every agent opens on the bus, the minority (by confidence) and the Risk Manager debate for at most 3 minutes, and the moderator writes the TLDR.
    - **Agents:** the desks plus one agent per HUD computed on that chart.
      - Desks:
        - The room's own timeframe desk analyses only its chart (owner decision 2026-11-06; `src/timeframe-desk.mjs`):
          - The 1H Desk reads the H1 decision chain plus the local 1-hour reading.
          - The 4H Desk and the D1 Desk read the local Prophet R38, R37 and GMI records of the bar, decoded into plain sentences.
          - A desk whose records parity has not approved is labelled so and speaks at confidence 0.4 or lower.
          - A room without local records for its bar has no own desk.
        - The other desks: the Higher-Timeframe Desk (the conclusion of the 4H Thread on 1H, of the D1 Thread on 4H), the News Analyst (News Daily), the Technical Analyst and the Risk Manager.
      - HUD agents come from that bar's HUD snapshot. The pull adapter now also publishes H4 and D1 HUD snapshots (`hud-snapshot.mjs`, timeframes `"240"` and `"1D"`, GMI from `gmi-core-htf.mjs`).
        - Fresh windows after the close: H1 25 minutes, M15 9, H4 30, D1 60.
        - **Catch-up (owner decision 2026-11-06):** an H4 or D1 bar whose snapshot was never sent in that window is sent once while it is still the chart's latest close (H4 up to 4 hours, D1 up to 72 hours, which covers the weekend). It is built on the bundle cut at the bar's close, so it is the snapshot that bar would have had. The marker `market-data:v2:hud-published:<candle_key>` (4 days) keeps every bar to one send. H1 and M15 have no catch-up: their rooms move on with every bar.
        - The pull adapter's `GET /health` shows `last_hud_publish`: each chart's status and candle key, and `catch_up` when a bar was sent late.
    - **No webhook dependency:** the rooms run on local computation only: closed bars, the HUD snapshot and the local Prophet R38 record of the bar.
    - **Calibration:** a HUD statement is verified only where it equals a parity-approved record, and computed from verified bars only where the bar's parity comparison matched (see "Calibration status once"). On 4H and D1 there are none until the alerts are installed there, so those HUD agents speak at confidence 0.4 or lower.
    - **No confirmation, no entry:** a BUY or SELL conclusion needs that chart's Prophet R38 confirmation, read from the local record of the bar. The 1H conclusion names the H1 decision when it differs.
    - **Schedule:** the rooms run from the parity sweep cron in their own `waitUntil`, one after another, the higher timeframe first (D1, 4H, 1H), so each Higher-Timeframe Desk reads the conclusion just written and the model sees one room's burst at a time. They run behind `TF_THREADS_ENABLED`, within `TF_THREADS_MAX_CALLS_PER_HOUR` (production 120, preview 150; about 26 calls per room).
      - A bar waits up to 20 minutes for its HUD snapshot, then runs with the desks only.
      - **Re-convene:** a room that concluded without its HUD snapshot meets once more, for the same bar, when the snapshot arrives late (the catch-up above). The second session is stored as run `<bar open>#hud`, which sorts after the first, so the tab, the Global Conclusion and the room below read it. The API reports the bar open without the suffix and `reconvened: true`.
      - Rooms of one sweep are 65 seconds apart: one room spends about 22 calls within a minute, and the Workers AI per-minute limit is shared.
      - A room concludes only when at least half of its agents spoke. Otherwise the next sweep retries the failed openings. Two hours after the close, it concludes with whoever spoke.
      - Each room runs once per bar, plus at most that one re-convene.
    - **Storage and API:** messages are stored in `agent_thread_messages` (thread `tf:H1` / `tf:H4` / `tf:D1`, run = bar open; steps `brief`, `open:*`, `debate:*` and `conclusion`). Read API: `GET /api/threads/timeframe?chart=H1|H4|D1` (also `1H`, `4H`).
- **News Daily** (owner decision 2026-11-06): `src/news-daily.mjs`, run by the hourly news cron after the hourly analysis, behind `NEWS_DAILY_ENABLED`, within `NEWS_DAILY_MAX_CALLS_PER_HOUR` (production 6, preview 12).
  - **Input:** the unique articles of the last 24 hours, taken from the stored hourly analyses (no extra TradingView pull), plus the 24-hour moves of gold, the dollar index, WTI oil and the USDT dominance from the cached closed bars.
  - **Per headline:** each headline gets a gold bias (BULLISH, BEARISH or NEUTRAL) and one plain sentence why. A tag is cached for 3 days, so each run tags only new headlines.
  - **TLDR:** the News Analyst writes the TLDR: one bias for the day, a summary and one to three reasons. A run is skipped while the 24-hour headline set is unchanged.
  - **Consumers:** every News Analyst desk reads it, in the Live War Room and the timeframe rooms. Read API: `GET /api/news/daily`.

- Transport: the pull adapter calls `AI_WORKER.submitContext(record)` on the
  AI Worker's `LocalComputationIngress` RPC entrypoint (no shared secret).
- Storage: KV key `context:m5:latest` (TTL 900 s) on the AI Worker.
- Read API: `GET /api/m5-context` returns the latest stored 5m context.
- **Analysis timeframes.** `POST /webhook` starts the AI chain only for `ANALYSIS_TIMEFRAMES`: `"60"` (H1) in production, and `"60,5"` in preview for the M5 fixture. Webhooks on other timeframes, such as 5m or 15m parity comparators, are stored only and answer `analysis_status: "stored_only"`.
- **Verified 5m lane (C0).** Per-timeframe parity identities and the full 5m producer are in place. Comparison starts once the owner installs the existing alerts on the 5m chart. The label switch is step 4. While `prophet_m5` and `gmi_m5` are both approved, and the observed 5m records for the bar come from those approved implementations, the live room's 5m read is labelled **VERIFIED 5m** (`trust_status: approved_by_parity`). It is then read in plain language with the same reading as the H1 webhooks (`src/m5-verification.mjs`).
  - Otherwise the read stays UNVERIFIED 5m, and the label switches by itself.
  - `GET /api/live` returns `m5_verified`, and the Nexus live badge follows it.
  - **5m alerts after approval (owner decision "pilihan 1", 2026-11-05).** Once `prophet_m5` and `gmi_m5` are both approved, the owner may delete the two 5m TradingView alerts. The approval persists while the 5m source and implementation hashes are unchanged; a 5m engine change needs the 5m alerts again for a calibration run, like the monthly H1 calibration.
  - The H1 chain and the bus read the same verification (B2), so every consumer of the 5m data follows one label.
- Freshness rule for use in `runAnalysis`: accepted only when both
  `now - Date.parse(candle_time) <= 15 min` and
  `now - Date.parse(received_at) <= 10 min`.
- Diagnostics: `GET /api/local-lane` (proxied by the Nexus dashboard to the pull adapter's
  `MarketDataReader.diagnostics()`) exposes the pull adapter's last refresh, latest closed bar
  per series, last publish and quota budget.

### Multi-agent bus (Phase 2, shadow only, `MULTI_AGENT_BUS_ENABLED`)
- Code: `src/multi-agent-bus.mjs`. **Enabled in production since Phase 4 (owner approval 2026-11-04)**: `MULTI_AGENT_BUS_ENABLED` and `LIVE_ROOM_ENABLED` are `"true"` in both `wrangler.jsonc` and `wrangler.preview.jsonc`. Turning a flag back to `"false"` stops new runs at once; stored messages stay readable.
- After the H1 synthesis is persisted (degraded or complete), the AI Worker enqueues a `multi_agent_bus` task on the existing queue. The task reads that synthesis, runs agents `technical` and `news` for 2 rounds, then a `moderator` consensus. That is at most 5 model calls, with a 300 s wall budget and the `MULTI_AGENT_MAX_CALLS_PER_HOUR` cap; the cap fails closed.
- Model: `MULTI_AGENT_MODEL` = `@cf/zai-org/glm-5.3-flash` (owner decision 2026-11-04; the same model as the production Counselor, so already proven on this account; strict `json_schema`, `reasoning_effort` low/high). On an error (or a 60 s timeout) the call is retried once with `MULTI_AGENT_FALLBACK_MODEL` = `@cf/zai-org/glm-4.7-flash`, `fallback_used` is recorded, and the primary error is stored as `primary_error` on every message of that run. After the first primary failure in a run, the remaining steps go straight to the fallback. The H1 chain models are unchanged. Beam (`reflection-ai/beam-1.0-501b-a23b`) was evaluated and rejected: it needs AI Gateway Unified Billing credits.
- The bus **never** writes into the chain's evidence, prompts or decision. Its output lives only in D1 `bus_messages` (migration `0003_bus_messages.sql`; the schema is also ensured at runtime for the preview D1), and it is read through `GET /api/bus?candle_key=` (messages, consensus, `agreement_with_chain`).

### Agent threads and live 15m room (Phase 3, `docs/RFC_NEXUS_AGENT_SOCIAL.md`)
- Code: `src/agent-threads.mjs`. Tables `agent_threads` and `agent_thread_messages` (migration `0004_agent_threads.sql`; new tables only, `0003` is never altered; the schema is also ensured at runtime for the preview D1).
- **News threads** (behind `MULTI_AGENT_BUS_ENABLED`):
  - After each news analysis, a `news_thread` queue task makes the analysis a post.
  - `news` and `technical` reply, each then replies to the other's reply (`parent_id`), and a `moderator` posts the consensus.
  - At most 5 calls, using the bus model with the bus fallback.
- **Live 15m room** (behind `LIVE_ROOM_ENABLED`, owner decision 2026-11-04):
  - Every 5m context submission (RPC `submitContext`, or the authenticated `POST /evidence/m5-context`) refreshes the 5m execution context in KV.
  - Only a submission whose closed 5m bar also closes a 15m candle (:00, :15, :30, :45 UTC) enqueues a `live_room` task. The task carries the context itself.
  - At every 15m close, `technical` and `risk` (a reply to technical) post, then a `moderator`, using stances BUY/SELL/HOLD/WAIT/CLOSE. There is no "nothing changed" skip.
  - Evidence:
    - `m15`: the closed 15m candles built from the last 12 closed 5m bars; a candle counts only when all three of its bars are present. This is the setup.
    - `m5`: the local-lane 5m read and bars, labelled VERIFIED 5m when parity-approved on 5m (C0), otherwise UNVERIFIED 5m. This is the execution timing.
    - `h1`: the H1 decision and the H1 TradingView reading.
    - `news`: the latest news-thread consensus.
  - The moderator must state the H1 decision whenever its stance differs from it.
  - Primary model only, never the paid fallback. The `LIVE_ROOM_MAX_CALLS_PER_HOUR` cap fails closed: 4 rooms an hour × 3 calls, well under 36.
  - Thread ids are `live15m:<day>`. `GET /api/live` also returns the older `live5m:` history.
  - The 5m context carries the last 12 closed bars (`recent_bars`). The H1 chain strips them.
- Read APIs: `GET /api/threads?kind=news|h1`, `GET /api/threads/:id` (nested replies; `h1:<candle_key>` serves the H1 bus debate as a thread) and `GET /api/live?since=`.
- **Nexus layout (owner decisions 2026-11-05 and 2026-11-06).**
  - **Center, under the chart:** the living War Rooms of every timeframe in one card. Its top is the tab bar `News | 15m | 1H | 4H | D1`, and every page load opens on News (no 5m tab for now).
  - **Each tab** starts with its conclusion directly under the tab bar: the stance in large type, confidence, summary, reasons, dissent, and what binds it.
    - On 15m: the H1 constraint and the entry confirmations.
    - On 1H, 4H and D1: that chart's Prophet R38 confirmation.
    - Under the conclusion come the communication bus and the debate.
  - **Sources:** 15m reads `GET /api/war-room/latest`; 1H, 4H and D1 read `GET /api/threads/timeframe`. The News tab shows the News Daily TLDR and each headline with its bias (`GET /api/news/daily`).
  - **No separate 15m cards:** they repeated the 15m tab.
  - **The active tab drives the page.**
    - The left panel lists the desks and HUD agents of that tab's room, with their stance and calibration. On the News tab it shows the News Analyst.
    - The level ladder and regime radar on the right show that tab's chart. News uses the 1-hour chart.
- **Trading assistant panel (right, owner decision 2026-11-06; charts only).** It is display-only: every number comes from the rooms, News Daily and the 5m context. Nothing is computed outside the parity lane.
  - *Global Conclusion* (first; `GET /api/conclusion/global`, `src/global-conclusion.mjs`, deterministic, no model call). One multi-timeframe summary of the D1, 4H, 1H and 15m War Rooms and News Daily:
    - the global bias from the weighted room leans (below);
    - a heat strip of the five leans, with stale rooms faded;
    - how many timeframes agree;
    - a summary;
    - the action.
    - The action is the authoritative H1 decision. A BUY or SELL becomes WAIT when the global bias leans against it. The validated H1 levels show only when it is BUY or SELL.
  - *Market sentiment:* a semicircle gauge from −100 (bearish) to +100 (bullish): the Global Conclusion's score.
    - It shows the weighted mean of each room's lean: D1 30, 4H 25, 1H 20, 15m 15, News 10. A missing input drops out and the rest renormalise.
    - A room's lean is the confidence-weighted mean direction of its agents (BUY +1, SELL −1, WAIT, HOLD and CLOSE 0). News lean is (bullish − bearish) over all tagged headlines.
    - Under the gauge, a donut shows the headline biases of the last 24 hours.
  - *Trend by timeframe:* one diverging bar per timeframe: D1 macro trend, 4H intraday trend, 1H swing trend, 15m structure, 5m confirmation.
    - Each bar carries the room's lean, the moderator's action and one line of interpretation.
    - The 5m row uses the 5m context bias, at full weight when a confirmation printed.
  - *Levels* (`GET /api/hud/levels?tf=15|60|240|1D`, `src/hud-levels.mjs`): a vertical Camarilla ladder from H6 to L6 for the active tab's chart.
    - Shaded zones: the H3–L3 range, the H4–H5 breakout zone and the L4–L5 breakdown zone.
    - Chips switch between the 15-minute, 1-hour, 4-hour, daily and weekly sets.
    - The daily and weekly pivot ranges show as bands, or as edge markers with their price when far away. The close is a marker.
    - It reads "from verified bars" when the candle's bar is verified (see the three calibration tiers).
  - *Regime:* a radar of six engine sensors of that chart, each scaled 0–100: trend (Hurst), efficiency, stretch (|z| of 3), volume (of 2× average), cycle agreement and order (1 − entropy). A chaos flag is shown. It is not yet calibrated.
  - *Agent consensus:* one stacked bar per room of its agents' stances.
  - *Macro drivers 24h:* diverging bars for gold, DXY, WTI oil and USDT dominance, with whether the gold–dollar inverse link holds.
  - *Session clock:* a 24-hour ring of the Tokyo, London and New York sessions in New York time, as the Chronos Matrix defines them, with a needle at now.
- **Nexus UI (owner decision 2026-11-06).** Nexus uses the obsidian design of the Cerebrum Console (`cryptophys-cloud-platform` `workers/console/ui`), because it will merge into the Console control panel. The `nexus` subdomain will later replace `home`.
  - **Stack:** the same as the Console: React 18, Vite, Tailwind with the obsidian palette, lucide-react, framer-motion, and three.js for the neural-mesh background. The chart uses lightweight-charts.
  - **Build and serving:** the source is in `workers/xauusd-nexus-dashboard/ui`. It is built into `ui/dist` and served as Workers Static Assets (`run_worker_first`). The deploy workflow builds it; `validate-nexus-dashboard.yml` builds it on pull requests.
  - **Layout:**
    - Same header, nav row, glass panels and status footer as the Console.
    - Left: Priority Queue, War Room agents and Worker status.
    - Center: the chart, then the War Rooms card with its tab bar `News | 15m | 1H | 4H | D1`.
    - Right: the trading assistant panel (charts).
    - On narrower screens, the side panels move under the center instead of hiding.
    - Shadow versions are at `#/shadow`; `/shadow` redirects there.
  - **Read-only:** the Worker forwards only GET/HEAD `/api/*` calls to the AI Worker.
- The AI Worker's old `/dashboard` page (Analyst/Counselor/Reasoner chat timeline and raw output) is retired. `GET /dashboard` redirects (302) to the Nexus dashboard (`NEXUS_DASHBOARD_URL`, default `https://nexus.cryptophys.work/`).
- The dashboard shows agents by name only: Technical Analyst, News Analyst, Risk Manager and Moderator. It never shows model names.
- Agent text must be natural language: validators reject snake_case field names, dotted evidence paths and key=value pairs in insights, summaries and dissent (`src/natural-language.mjs`). Evidence paths stay in `refs`.
- The fail-closed WAIT reasoning is plain language too (`describeDegradedEvidence`).
- **H1 `trade_plan`** (`src/trade-plan.mjs`, RFC_HUD_AGENTS §7):
  - The Reasoner prompt (`TRADE_PLAN_RULE`) asks for `trade_plan` on BUY or SELL. It covers action, entry, invalidation, take profit, exit reason, progressive stop and zone.
  - `parseDecision` validates the plan with `validateTradePlan`:
    - the prices must be positive, correctly ordered for the side, and equal to the decision's validated `entry_price`, `stop_loss` and `take_profit`;
    - the progressive stop must lie between invalidation and take profit;
    - the zone needs `low <= high` and a side of DEMAND or SUPPLY;
    - unknown keys, such as grid levels, are dropped.
  - An invalid plan becomes null, with `trade_plan_errors` recorded. The decision itself is never changed. WAIT and NO_TRADE never carry a plan.
- **H1 decision text is plain language too** (`src/plain-decision.mjs`):
  - The Reasoner prompt carries `DECISION_TEXT_RULE`.
  - When the reasoning, confirmation or invalidation text still reads like code (field names, key paths, `key = value`, `==`), one call to the bus model rewrites only those fields.
  - The decision, confidence, prices and conditions never change.
  - A rewrite that still reads like code, or that adds a new standalone number, is rejected, and the original text stays.
  - `decision.text_rewritten` lists the rewritten fields. The raw reasoner output stays in the synthesis.
- In news threads and the live room, an answer that fails only the natural-language check gets one correction call (`corrections` in the message body). That call is counted by the hourly budget and never runs past the budget or the wall deadline. A second failure stays `invalid_output`.
- TradingView webhook reading (`src/webhook-interpretation.mjs`):
  - It decodes the three alerts of each H1 candle into plain sentences: Prophet R38, Prophet R37 and GMI v12.70.
    - It covers signal, trade-management state, divergence or structure break, confirmation candle, GMI verdict and confluence gate.
    - It also gives an overall lean.
  - The codes follow the Pine sources exactly.
  - It is deterministic, never a model output, and never changes the H1 decision.
  - It is served by `GET /api/decision/:key` (`tradingview_reading`) and in the Threads 1H post (`post.tradingview`). Nexus shows it as "TradingView signals (H1)".
  - It is fed to the bus technical agent (evidence key `tradingview`, no underscore so the model does not echo a field name), which must interpret each indicator by name, even on WAIT.
  - It is also fed to the bus moderator, to news threads (technical side) and to the live room (as the H1 backdrop).
- Neither feature writes into the H1 chain's evidence, prompts or decision. Stances are discussion only: no orders.
- `POST /preview/news-analysis-fixture` exists only when `PREVIEW_FIXTURES_ENABLED` is `"true"` (set only in `wrangler.preview.jsonc`), so preview-e2e can prove a news thread.

### HUD agents (Phase C, `HUD_AGENTS_ENABLED`, on in production since 2026-11-05)
- Owner request, 2026-11-04: every HUD in the installed Pine indicators becomes its own agent.
  - Each agent is named after its HUD.
  - Each agent analyses only the data its HUD produces.
- The brief for the VPS agent is `docs/BRIEF_HUD_AGENTS.md`. It covers the HUD inventory, the rules, and an assessment → RFC → flagged implementation sequence.
- Owner decisions, 2026-11-05:
  - the untitled Prophet R38 top-right HUD is named "Prophet";
  - Matrix & Omega Sensors gets one agent per titled section.
  - That makes 14 agents in total.
- Phase A assessment: `docs/HUD_AGENTS_ASSESSMENT.md` (PR #66). The owner's answers (2026-11-05) are in `docs/BRIEF_HUD_AGENTS.md`:
  - HUD agents also speak in the live 15m room, on 15m HUD data that must be parity-verified like H1.
  - Verification uses a Pine candidate alert that carries the HUD fields, installed by the owner for H1 and 15m.
  - Rows that cannot be recomputed locally become output of the H1 decision reasoning.
  - The R37 Funnel is read per current candle.
  - `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`.
- RFC: `docs/RFC_HUD_AGENTS.md` (PR #69).
- Owner decisions, 2026-11-05:
  - Aegis joins the live 15m room;
  - HUD data must be verified through a Pine candidate comparator;
  - the candidate ships first (C1).
- The Phase C order (C1–C7) is in `docs/BRIEF_HUD_AGENTS.md`.
- **Live War Room 15m** (`src/war-room.mjs`, behind `WAR_ROOM_ENABLED`, on in production; owner decision 2026-11-05). At every 15m close, every agent discusses in one room, in three phases:
  1. **Communication bus.** Each agent posts one opening claim from its own data only. The agents (owner decision 2026-11-06: the 15m room has no H1 Desk):
     - **15m Desk:** the parity-approved 15m Prophet R38, R37 and GMI records of the candle, in plain sentences. It speaks at 0.4 or lower when they are not approved.
     - **Higher-Timeframe Desk:** the H1 chain, its TradingView reading and the latest 1H War Room conclusion. The H1 decision still binds the moderator.
     - **News Analyst.**
     - **Technical Analyst:** the 15m candles and the 5m execution read.
     - **Risk Manager.**
     - **One agent per computed 15m HUD** (13).
  2. **Debate.** At most 8 speakers rebut named agents. The debate is open for at most 3 minutes, then closed.
     - **Who speaks** (owner decision 2026-11-06: decision and bias are different things):
       - agents whose action differs from the bus majority;
       - agents whose bias leans against the room's bias (the confidence-weighted bias of the bus, NEUTRAL inside ±0.1; against a NEUTRAL room every leaning agent counts), by confidence;
       - when anyone dissents against a BULLISH or BEARISH room, its strongest holder, to defend it;
       - the Risk Manager.
     - **Why:** production 13:30, 2026-11-06: all 18 agents said WAIT, 11 leaned bearish and 3 bullish, and only the Risk Manager debated, because speakers were chosen by action alone.
     - When the action is unanimous but the bias is split, the debaters argue the bias.
     - Every rebuttal gives its bias too. A dissenter the bus persuaded may concede instead: its stance or bias changes, it may name nobody, and it is kept as `conceded: true` (2026-11-06).
  3. **Conclusion.** The moderator concludes for the Nexus main panel: the **decision** (`stance`: what to do now, under the confirmation rule), the room's **bias** (`bias`: where the weight of the evidence leans, BULLISH, BEARISH or NEUTRAL, even when the decision is WAIT), a summary that states both first ("Decision WAIT, bias bearish: …"), up to 3 reasons, and the agents that still disagree.
     - A BULLISH or BEARISH bias needs at least one agent holding it (`bias_without_support`, one correction call). A missing bias is the room's computed bias, stored as `majority_bias`.
     - Nexus shows the decision and the bias side by side. The 1H, 4H and D1 rooms follow the same rules.
  - **Bias beside the action** (owner decision 2026-11-06, Prophet audit).
    - Every opening states its action (BUY, SELL, HOLD, WAIT or CLOSE) and its `bias` (BULLISH, BEARISH or NEUTRAL): the direction its own data leans, even when the action is WAIT for lack of a confirmation.
    - Room leans (Trend by timeframe, Global Conclusion) read the bias. Openings stored before the bias existed use the action.
    - Nexus shows the action with "bias …" next to it.
  - **A BUY or SELL conclusion needs support** (owner decision 2026-11-06).
    - At least one agent on the bus or in the debate must hold that stance; a confirmation alone never overrules the whole room.
    - A conclusion that breaks this rule, or "no confirmation, no entry", gets one correction call telling the moderator which rule it broke, then is rejected. The same applies in the 1H, 4H and D1 rooms.
  - The H1 decision is the constraint: a conclusion that differs must say "H1 decision: X". Price levels come only from the validated H1 chain.
  - **Calibration status once** (owner decision 2026-11-05, option A).
    - The brief stores each agent's evidence status: for a HUD agent, its verified lines, its lines computed from verified bars and its total lines; otherwise the source label. Nexus shows it once, as a badge next to the agent.
    - **Three tiers per HUD statement** (`src/hud-reading.mjs`, owner decision 2026-11-06, option 1):
      - *Verified by parity:* every field it uses is a TradingView alert field equal to the parity-approved record of the candle.
      - *Computed from verified bars:* a pure formula of closed bars, with no engine internal behind it: the Camarilla levels and bands (The Interstellar Eyes), the daily and weekly central pivot ranges and the trading sessions (Chronos Matrix). It applies only when the candle is in the trusted lane (an approved record exists) and its parity comparison matched, which includes the input bar (open, high, low, close, volume), with no `input_mismatch` (`barsVerified` in `src/hud-store.mjs`). The higher-timeframe bars behind Camarilla and the pivots come from the same TradingView feed and are not compared separately.
      - *Not yet calibrated:* an engine internal no TradingView comparator has checked.
    - Agents never mention calibration in their text.
    - A HUD agent with no statement in the first two tiers speaks at confidence ≤ 0.4.
    - The bus shows each agent's evidence, and the moderator weighs verified and bar-computed evidence above uncalibrated readings.
  - **No confirmation, no entry** (owner rule 2026-11-05).
    - BUY needs a confirmed buy signal: the H1 Prophet R38 confirmation from the approved record behind the latest H1 decision, or a VERIFIED 5m Prophet R38 confirmation candle. SELL needs a confirmed sell signal.
    - Without the matching confirmation the stance is WAIT, or HOLD / CLOSE for an open position.
    - The Risk Manager sees the confirmations, applies the rule in its opening, and rebuts every entry proposed without one.
    - A BUY or SELL conclusion without the matching confirmation is rejected (`entry_without_confirmation`).
    - Nexus shows the confirmation state under the conclusion.
  - **Quorum (2026-11-06):** within 5 minutes of the close (`WAR_ROOM_QUORUM_WAIT_MS`), a room with fewer than half of its agents heard does not conclude. The queue task is redelivered after 60 seconds (`WarRoomQuorumPending`), and only the failed openings are asked again. Past the wait, the room concludes with whoever spoke. Production 13:15 that day: Workers AI 3021 and 3040 failed 14 of 18 openings, and the room concluded on four agents.
  - Primary model only, within `WAR_ROOM_MAX_CALLS_PER_HOUR = 112` (about 27 calls per close). Messages are stored in `agent_thread_messages` (thread `warroom:<day>`, steps `brief`, `open:*`, `debate:*` and `conclusion`).
  - Read API: `GET /api/war-room/latest[?bar=<iso>]`.
  - When on, it replaces the legacy live room and the per-H1 HUD agents (their budget moves here). Turning it `"false"` restores both.
- Live: C0, C2, C3, C5, C6 and C7 are built. `HUD_AGENTS_ENABLED` is `"true"` in `wrangler.jsonc` (owner approval 2026-11-05, after the #94 preview-e2e proof). After each H1 synthesis, one agent per computed HUD (13) and a moderator post in Threads 1H, within `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`. At each 15m close, Trade Management, Kinetic Engine, Fabio AMT and Aegis Footprint speak in the live room, within `LIVE_ROOM_MAX_CALLS_PER_HOUR = 48`. Turning the flag to `"false"` stops new HUD posts at once.
- Backlog (owner, 2026-11-05): B4 (merge the GMI core copy, needs a new H1 GMI approval in a calibration window) and the Grid Bot Protocol HUD. See `docs/BRIEF_HUD_AGENTS.md`.
- **Macro & Aether Sensors complete** (owner decision 2026-11-05: every TradingView metric becomes agent data). `local-engines/producer/src/macro-aether.mjs` computes every row of the Pine HUD for the H1 and M15 snapshots:
  - **Rows:** CONSOL. GRAVITY (TDM profile gravity), Z3 KINETIC SPREAD, MACRO CYCLE (DXY and USDT ROC), EST. MACRO SHIFT (macro kinematics on DXY and USDT 4h), ASSET GRAVITY (WTI RSI14 at the chart timeframe, from the USOIL M15 and H1 series), Q-GRAVITY PULL and MACRO SMR (the FVG reservoir).
  - **MTF HURST and MTF Z-SCORE** were already in the snapshot.
  - **Lookahead off:** the other series are read as last closed at the chart bar's close. TradingView's realtime bar can show a developing 4h DXY or USDT bar, so the macro rows may lag by one 4h bar.
  - **Unverified:** no row is a webhook field, so every row reads as unverified. A missing series leaves its rows absent.

### Outcome scoring and stuck states (RFC_INDICATOR_AGENT_PLATFORM P1)
- Code: `src/outcome-scoring.mjs`. Tables `outcome_scores`, `outcome_runs` and `stuck_states` (migrations `0005_outcome_scores.sql` and `0006_outcome_runs_version.sql`; also ensured at runtime). Rows carry `scoring_version`: candles scored by an older version are scored again within the lookback, and scorecards read only the current version. Owner approval 2026-11-05 for the definition.
- It is deterministic and reads prices only: the pull adapter's closed TradingView bars, from the same KV namespace (`SIGNAL_CACHE` = `MARKET_DATA_CACHE`). It never changes a decision, prompt or evidence.
- **What is scored, per closed candle, once its horizon has closed:**
  - **H1:** the chain decision (`chain:h1`), the bus round-2 agents and the moderator (`bus:*`), the HUD agents (`hud:*`), and the parity-approved indicator directions (`indicator:prophet_r38`, `indicator:prophet_r37`, `indicator:gmi_v12_70`).
  - **15m:** the live-room posts (`room:*`).
- **How:**
  - The entry is the statement candle's close, and the threshold is `0.5 × ATR(14)`, a simple average of the true range. The horizon is the next 4 closed candles.
  - BUY or SELL is a hit when the favourable excursion reaches the threshold first, a miss when the adverse excursion does (both in the same bar counts as a miss), and neutral otherwise.
  - WAIT (and NO_TRADE) is a `missed_opportunity` only when a 2:1 trade would have won: price reaches `1 × ATR` (`waitTargetAtr`) on one side before touching `0.5 × ATR` on the other, bar by bar. A bar touching both counts as the stop. The record keeps the winning direction. Otherwise WAIT is a hit, including in a whipsaw or a 1:1 move. This is scoring v3, owner approval 2026-11-05.
    - v1 counted any touch, and nearly every WAIT read as missed.
    - v2 counted any 1:1 win, and still marked H1 WAIT right on only 1 of 35 candles, because over 4 H1 candles some side almost always reaches `0.5 × ATR` first.
  - HOLD and CLOSE are not scored.
  - A Brier score is computed when the statement has a confidence.
- **Stuck states:** once an hour, over the approved H1 records of the last 24 candles. A Prophet or GMI state field (subtype, `b_enc`, `d_enc`, `t_enc`, gate, verdict, conflict) is stuck when it is unchanged for ≥ 8 candles while the high-low range of those candles exceeds `3 × ATR(14)`. Episodes open, extend and clear in `stuck_states`.
- **When:** in the parity sweep cron (`10-59/15`), after the backfill. Stuck-state detection runs in the first sweep of each hour.
- **Read APIs:** `GET /api/scorecards?days=30` (per subject: directional hit rate, WAIT accuracy, missed opportunities, Brier and sessions, plus the open stuck states) and `GET /api/stuck-states`.

### Shadow indicator versions (RFC_INDICATOR_AGENT_PLATFORM P3)
- Code: `src/shadow-versions.mjs`. Table `shadow_outputs` (migration `0008_shadow_outputs.sql`; also ensured at runtime).
- **What runs.** Once an hour, in the first parity sweep after the H1 close, every version is replayed over the pull adapter's cached H1 bars (`SIGNAL_CACHE`).
  - **Control** for each engine family (`prophet_r37@active`, `prophet_r38@active`): the active, parity-approved code with its default parameters.
  - **Candidates**: the same pure engine functions with different parameters. The engine files and their provenance hashes do not change.
- **Storage.** An output is stored only with at least 300 bars of history behind it. The first computation is final.
- **Scoring.** Every output is scored by the outcome scoring as `shadow:<version>` (`source = "shadow"`) once its horizon has closed.
- **Isolation.** Nothing here reaches a room, a prompt, the evidence or a decision.
- **Comparison is like for like.** A candidate is compared with its control only on bars scored for both.
  - **Accuracy:** right calls over decided calls. A directional hit and a WAIT hit are right; a miss and a missed opportunity are wrong; a directional neutral is undecided.
  - **Criteria:** a higher score that is significant, meaning a one-sided exact sign test with p < 0.05 on the bars where the two versions disagree and exactly one is right; no more stuck time (candles inside stuck episodes, § above: ≥ 8 candles with range > 3 × ATR); and a minimum sample of 200 bars. Brier does not apply, because indicator directions carry no confidence. Reference parity applies only to a Pine candidate (RFC decision 1).
  - **Control check:** the control is also checked against the approved local records of the last 24 candles (`matches_approved_local_records`).
- **Read model.** `GET /api/shadow-versions?days=30` (cached for 5 minutes) and the Nexus page `/shadow`.
- **Candidates (P5, 2026-11-05):** `prophet_r37@latch8`, `prophet_r37@latch12` and `prophet_r38@latch8`. The ±3 structure latch expires after 8 or 12 closed H1 bars instead of 50. They are local-only: owner decision 1 (2026-11-05) is that a local-only version is enough, so an improvement is proven by outcome first.
- **GMI "Prophet risk hold" candidates** (`gmi_v12_70@latch8`, `gmi_v12_70@latch12`). These test the latch where it acts on the chain.
  - **How they work.** GMI needs M1, M15 and higher-timeframe bars, so it is not replayed. Each bar starts from the approved local GMI record of that candle (`localcalc:<key>:gmi`, kept 14 days, last 72 bars tried). `src/gmi-regate.mjs` recomputes only the two points the Prophet structure feeds: `mtf_state` in the initial verdict cascade, and the R10 gate with its risk hold (subtype 1).
  - **Exactness.** With the active structure, the re-gate reproduces GMI's comparable fields exactly (`test/gmi-regate.test.mjs`). In production the control is checked against the approved records.
  - **Sample.** Bars accumulate from the local records forward, so the 200-bar sample takes about a week.
- **Promotion** is never automatic. The verdict `better_than_active: ready for owner review` is a proposal; the owner approves a separate promotion PR.

## 4. Sources and knowledge
- **Pine sources:** `pinescript/ssot/`. Verified against the installed TradingView indicators; see `docs/PINE_SOURCE_VERIFICATION.md`. Never edit these files.
- **Agent knowledge base:** v4, generated from Pine with line citations and bundled into the AI Worker. See `docs/KNOWLEDGE_BASE_V4.md`.
- **Models:** the values in `wrangler.jsonc` are authoritative. Reasoning-model token budgets are `MAX_TOKENS` in `src/model-text.mjs`.

## 5. Deployment rules (mandatory for every human and agent)
1. Production changes reach production **only** by merging a PR into `main`. The workflows in §1 then deploy it.
2. **Never** run `wrangler deploy`, `wrangler delete` or `wrangler secret put` against production by hand or from a VPS. **Never** create a new Worker outside this repository. A manual deploy on 2026-11-03 replaced the pull adapter with a stub and stopped the local lane for about 6 hours.
3. Work from the latest `main`. Branches cut from an old base must not be merged or deployed.
4. A PR is mergeable only when CI is green (`test`, `preview-e2e`, Workers Builds) and the change is described against this SSOT.
5. A topology change requires editing this file, `AGENTS.md` and `test/ssot-topology.test.mjs` in the same PR, and the owner's explicit approval.

## 6. Owner-only actions
- TradingView OAuth re-authorization at `https://news.cryptophys.work/oauth/start`.
- Rotation of `WEBHOOK_SECRET` (in the AI Worker and the Pine "CTA Webhook Secret" input).
- TradingView alerts: the Prophet R38 and GMI v12.70 alerts on OANDA:XAUUSD 1H, set to "Any alert() function call", with the webhook pointing to `https://ai.cryptophys.work/webhook`.
