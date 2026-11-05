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
   - Trust is earned only through the autonomous parity registry: 24 consecutive candles that match TradingView. There is no manual allowlist and no operator approval.
   - The chain starts as soon as the parity-approved (`localcalc:`) records of a closed H1 candle exist. It does not wait for any webhook.
   - The indicator values the agents read (`source_payloads`, `origin: "local_computation"`) are the approved records' comparable fields. These are the same field names and codes the TradingView alerts carry.
   - A candle whose approved local records do not arrive within 30 minutes of the close is recorded as a fail-closed WAIT. A revoked or never-approved identity therefore never trades.
2. **TradingView webhook** (calibration only). The sources are `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70`, on H1 and 5m.
   - Webhooks are stored and compared field by field with the local records. They never start the chain and are never decision evidence (`input_lanes.tradingview_webhook.role: "calibration_only"`).
   - Approval persists while no webhook arrives. A mismatch during a calibration run revokes the identity, and the chain then fails closed until it re-earns 24/24.
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
- **Nexus layout (owner decision 2026-11-05, Live War Room).** The main panel is the War Room conclusion, with the H1 decision shown as its constraint. Below it, the Live War Room 15m shows the latest discussion only, with no history. The right panel holds only the Threads 1H TLDR and the News Thread TLDR (`GET /api/tldr`). The left panel lists the War Room agents and the worker status.
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
  1. **Communication bus.** Each agent posts one opening claim from its own data only: the H1 Desk (the H1 chain and the H1 TradingView reading), the News Analyst, the Technical Analyst (15m candles and the 5m execution read), the Risk Manager, and one agent per computed 15m HUD (13).
  2. **Debate.** Agents whose stance differs from the bus majority (at most 7, by confidence) and the Risk Manager rebut named agents. The debate is open for at most 3 minutes, then closed.
  3. **Conclusion.** The moderator concludes for the Nexus main panel: stance, summary, up to 3 reasons and the agents that still disagree.
  - The H1 decision is the constraint: a conclusion that differs must say "H1 decision: X". Price levels come only from the validated H1 chain.
  - **Calibration status once** (owner decision 2026-11-05, option A).
    - The brief stores each agent's evidence status: verified lines out of total for a HUD agent, otherwise the source label. Nexus shows it once, as a badge next to the agent.
    - Agents never mention calibration in their text.
    - A HUD agent with no verified statement speaks at confidence ≤ 0.4.
    - The bus shows each agent's evidence, and the moderator weighs verified evidence above uncalibrated readings.
  - **No confirmation, no entry** (owner rule 2026-11-05).
    - BUY needs a confirmed buy signal: the H1 Prophet R38 confirmation from the approved record behind the latest H1 decision, or a VERIFIED 5m Prophet R38 confirmation candle. SELL needs a confirmed sell signal.
    - Without the matching confirmation the stance is WAIT, or HOLD / CLOSE for an open position.
    - The Risk Manager sees the confirmations, applies the rule in its opening, and rebuts every entry proposed without one.
    - A BUY or SELL conclusion without the matching confirmation is rejected (`entry_without_confirmation`).
    - Nexus shows the confirmation state under the conclusion.
  - Primary model only, within `WAR_ROOM_MAX_CALLS_PER_HOUR = 112` (about 27 calls per close). Messages are stored in `agent_thread_messages` (thread `warroom:<day>`, steps `brief`, `open:*`, `debate:*` and `conclusion`).
  - Read API: `GET /api/war-room/latest[?bar=<iso>]`.
  - When on, it replaces the legacy live room and the per-H1 HUD agents (their budget moves here). Turning it `"false"` restores both.
- Live: C0, C2, C3, C5, C6 and C7 are built. `HUD_AGENTS_ENABLED` is `"true"` in `wrangler.jsonc` (owner approval 2026-11-05, after the #94 preview-e2e proof). After each H1 synthesis, one agent per computed HUD (13) and a moderator post in Threads 1H, within `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`. At each 15m close, Trade Management, Kinetic Engine, Fabio AMT and Aegis Footprint speak in the live room, within `LIVE_ROOM_MAX_CALLS_PER_HOUR = 48`. Turning the flag to `"false"` stops new HUD posts at once.
- Backlog (owner, 2026-11-05): B4 (merge the GMI core copy, needs a new H1 GMI approval in a calibration window) and the Grid Bot Protocol HUD. See `docs/BRIEF_HUD_AGENTS.md`.

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
