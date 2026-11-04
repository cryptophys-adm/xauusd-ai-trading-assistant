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

## 3. Three AI input lanes
1. **TradingView webhook** (`POST /webhook`, once per closed 1H bar). The sources are `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70`. This lane is the comparator.
2. **Local computation** (primary). The engines are MizanLib (record id `mizan`), Prophet and GMI, computed by the pull adapter from closed TradingView bars. Trust is earned only through the autonomous parity registry: 24 consecutive candles that match the webhook. There is no manual allowlist and no operator approval. Because the per-event reconcile runs within seconds of evidence arrival and can miss a candle while KV is still settling, the AI Worker also reconciles the last closed H1 candles on a cron (`10-59/15 * * * *`); the reconcile is idempotent, so a candle is counted at most once.
3. **Fundamental news**: TradingView MCP news. The AI Worker analyses it at cron `:06`.

Coverage per Pine parameter is in `docs/LOCAL_COMPUTATION_OWNERSHIP.md`.

The parity sweep cron also backfills `runAnalysis` for any closed H1 candle within the last 2 hours that has complete webhook evidence in D1 but no `analysis_runs` row, keeping analysis idempotent via `claimAnalysisRun`.

### Informational (non-trusted) 5m context
- A separate, **informational_unverified** evidence key `informational_5m_context` may be
  surfaced in the fusion bundle. It is built by `local-engines/producer/src/m5-producer.mjs`
  (`buildM5ProphetContext`) from closed M5 bars.
- It is **never** part of `fusion.complete`, never changes decision, entry/SL/TP, risk/reward,
  position size or confidence, and is labelled "UNVERIFIED 5m" in the UI and prompts.
- Trust remains H1-only via the autonomous parity registry; no parity exists for 5m.

- Transport: the pull adapter calls `AI_WORKER.submitContext(record)` on the
  AI Worker's `LocalComputationIngress` RPC entrypoint (no shared secret).
- Storage: KV key `context:m5:latest` (TTL 900 s) on the AI Worker.
- Read API: `GET /api/m5-context` returns the latest stored 5m context.
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

### Agent threads and live 5m room (Phase 3, `docs/RFC_NEXUS_AGENT_SOCIAL.md`)
- Code: `src/agent-threads.mjs`. Tables `agent_threads` and `agent_thread_messages` (migration `0004_agent_threads.sql`; new tables only, `0003` is never altered; the schema is also ensured at runtime for the preview D1).
- **News threads** (behind `MULTI_AGENT_BUS_ENABLED`):
  - After each news analysis, a `news_thread` queue task makes the analysis a post.
  - `news` and `technical` reply, each then replies to the other's reply (`parent_id`), and a `moderator` posts the consensus.
  - At most 5 calls, using the bus model with the bus fallback.
- **Live 5m room** (behind `LIVE_ROOM_ENABLED`):
  - Each 5m context submission (RPC `submitContext`, or the authenticated `POST /evidence/m5-context`) enqueues a `live_room` task that carries the context itself.
  - When the picture changed (bias/flags/H1 decision/news), `technical` and `risk` (a reply to technical) post, then a `moderator`, using stances BUY/SELL/HOLD/WAIT/CLOSE.
  - The moderator must state the H1 decision whenever its stance differs from it.
  - Primary model only, never the paid fallback. The `LIVE_ROOM_MAX_CALLS_PER_HOUR` cap fails closed.
  - Everything is labelled UNVERIFIED 5m.
  - The 5m context now carries the last 12 closed bars (`recent_bars`) for the room. The H1 chain strips them.
- Read APIs: `GET /api/threads?kind=news|h1`, `GET /api/threads/:id` (nested replies; `h1:<candle_key>` serves the H1 bus debate as a thread) and `GET /api/live?since=`.
- The Nexus dashboard shows three cards: **Threads 1H** (it replaces the old Analyst/Counselor/Reasoner debate card), **News Threads** and **Live Room 5m**.
- The dashboard shows agents by name only: Technical Analyst, News Analyst, Risk Manager and Moderator. It never shows model names.
- Agent text must be natural language: validators reject snake_case field names, dotted evidence paths and key=value pairs in insights, summaries and dissent (`src/natural-language.mjs`). Evidence paths stay in `refs`.
- The fail-closed WAIT reasoning is plain language too (`describeDegradedEvidence`).
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
