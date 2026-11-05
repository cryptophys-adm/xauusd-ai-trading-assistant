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

### Informational (non-trusted) 5m context
- A separate, **informational_unverified** evidence key `informational_5m_context` may be
  surfaced in the fusion bundle. It is built by `local-engines/producer/src/m5-producer.mjs`
  (`buildM5ProphetContext`) from closed M5 bars.
- It is **never** part of `fusion.complete`, never changes decision, entry/SL/TP, risk/reward,
  position size or confidence, and is labelled "UNVERIFIED 5m" in the UI and prompts.
- **5m parity records (C0 step 3).** The pull adapter also publishes full mizan, prophet and gmi records for every closed 5m bar (`local-engines/producer/src/m5-local-producer.mjs`, behind `M5_PARITY_PUBLISH`). They have timeframe `"5"` and candle key `OANDA:XAUUSD:5:<open ms>`.
  - The records earn their own approval under the timeframe-scoped ids `prophet_m5`, `gmi_m5` and `mizan_m5`, separate from the approved H1 ids. The parity sweep revisits the last six closed 5m candles.
  - GMI on the 5m chart runs `local-engines/gmi/src/gmi-core-tf.mjs`, a timeframe-parameterised copy of `gmi-core.mjs`. `gmi-core.mjs` stays byte-identical, because it is part of the approved H1 hash. A test proves the copy equals `computeGmi` on H1.
  - The provenance has its own `prophet_m5` and `gmi_m5` entries, so 5m code changes never change the H1 hashes.

- Transport: the pull adapter calls `AI_WORKER.submitContext(record)` on the
  AI Worker's `LocalComputationIngress` RPC entrypoint (no shared secret).
- Storage: KV key `context:m5:latest` (TTL 900 s) on the AI Worker.
- Read API: `GET /api/m5-context` returns the latest stored 5m context.
- **Analysis timeframes.** `POST /webhook` starts the AI chain only for `ANALYSIS_TIMEFRAMES`: `"60"` (H1) in production, and `"60,5"` in preview for the M5 fixture. Webhooks on other timeframes, such as 5m or 15m parity comparators, are stored only and answer `analysis_status: "stored_only"`.
- **Verified 5m lane (C0).** Per-timeframe parity identities and the full 5m producer are in place. Comparison starts once the owner installs the existing alerts on the 5m chart. The label switch is step 4. While `prophet_m5` and `gmi_m5` are both approved, and the observed 5m records for the bar come from those approved implementations, the live room's 5m read is labelled **VERIFIED 5m** (`trust_status: approved_by_parity`). It is then read in plain language with the same reading as the H1 webhooks (`src/m5-verification.mjs`).
  - Otherwise the read stays UNVERIFIED 5m, and the label switches by itself.
  - `GET /api/live` returns `m5_verified`, and the Nexus live badge follows it.
  - The decision card's 5m context stays UNVERIFIED: it is the separate informational `buildM5ProphetContext` read. See `docs/BRIEF_HUD_AGENTS.md`. Until then the 5m context stays UNVERIFIED.
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
- The Nexus dashboard shows three cards: **Threads 1H** (it replaces the old Analyst/Counselor/Reasoner debate card), **News Threads** and **Live Room 15m**.
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

### Next phase: one agent per Pine HUD (planned, not built)
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
- Nothing in this section is live yet.

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
