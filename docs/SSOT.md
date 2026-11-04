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
- Code: `src/multi-agent-bus.mjs`. Production `wrangler.jsonc` sets the flag to `"false"`; only `wrangler.preview.jsonc` sets `"true"`.
- After the H1 synthesis is persisted (degraded or complete), the AI Worker enqueues a `multi_agent_bus` task on the existing queue. The task reads that synthesis, runs agents `technical` and `news` for 2 rounds, then a `moderator` consensus. That is at most 5 model calls, with a 90 s wall budget and the `MULTI_AGENT_MAX_CALLS_PER_HOUR` cap; the cap fails closed.
- Model: `MULTI_AGENT_MODEL` = `reflection-ai/beam-1.0-501b-a23b` (third-party via Workers AI, $0 per the catalog on 2026-11-04, strict `json_schema`). On a Beam error the call is retried once with `MULTI_AGENT_FALLBACK_MODEL` = `@cf/zai-org/glm-4.7-flash`, and `fallback_used` is recorded. The H1 chain models are unchanged.
- The bus **never** writes into the chain's evidence, prompts or decision. Its output lives only in D1 `bus_messages` (migration `0003_bus_messages.sql`; the schema is also ensured at runtime for the preview D1), and it is read through `GET /api/bus?candle_key=` (messages, consensus, `agreement_with_chain`).

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
