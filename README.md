# XAUUSD AI Trading Assistant

Cloudflare-based, advisory-only XAUUSD decision support. The current Worker receives TradingView webhook payloads from Prophet R38, Prophet R37 SSOT, and GMI v12.70, stores candle evidence in D1/KV, runs Analyst → Counselor → Reasoner, and can send a Telegram summary.

**Important status (updated 2026-11-02):** The production AI and news-ingestion Workers remain deployed; the evidence-fusion changes are under review and have not been deployed to production. The last recorded live preflight (2026-11-01) showed HTTP 200 health responses but a TradingView MCP quota cooldown and a failed scheduled ingest; that provider state was not revalidated during this update. The feature branch now enforces one-hour article/analysis freshness, per-payload and persistent deduplication, one hourly ingestion at minute 5, and AI analysis at minute 6 to reuse the cache. CI tests and isolated preview checks pass, but the complete AI chain with fresh live news and Pine-parity outputs is not tested. Production D1 `xauusd-signals` still lacks `analysis_runs`. Local Mizan/Prophet/GMI calculation engines and Pine parity are not implemented/verified by this repository. Do not mark the product production-complete until every gate in [Production Definition of Done](docs/PRODUCTION_DEFINITION_OF_DONE.md) passes with recorded evidence.

## Physical Worker deployment plan

The target is **9 physical Cloudflare Workers total: 8 core Workers plus the separately retained `xauusd-fundamental-news-ingestion` Worker**. Core Workers are `xauusd-tradingview-pull-adapter`, `xauusd-pull-orchestrator`, `xauusd-market-data-normalizer`, `xauusd-mizan-engine`, `xauusd-prophet-engine`, `xauusd-gmi-engine`, `xauusd-confluence-controller`, and the existing `xauusd-ai-trading-assistant` (#8). The existing AI Worker retains its `AI`, `DB`, and three KV bindings and the Analyst → Counselor → Reasoner chain. Seven core Workers are planned, not deployed; capability, quota, parity and preview gates must pass before production. No containers and no deprecated per-timeframe Worker fleet. See [Architecture Baseline](docs/ARCHITECTURE_BASELINE.md) and [Deployment Blueprint](docs/DEPLOYMENT_BLUEPRINT.md).

## Architecture and deployment SSOT

These documents are the baseline for future implementation and deployment:

- [Architecture Baseline](docs/ARCHITECTURE_BASELINE.md) — canonical Confluence Controller and immutable architectural constraints.
- [Deployment Blueprint](docs/DEPLOYMENT_BLUEPRINT.md) — phased implementation, preview, production rollout and rollback.
- [Production Definition of Done](docs/PRODUCTION_DEFINITION_OF_DONE.md) — mandatory release acceptance gates.
- [Evidence Contracts](docs/EVIDENCE_CONTRACTS.md) — versioned local-calculation contract, freshness rules, provenance allowlists, and degraded behavior.
- [Local Calculation Source Baseline](docs/LOCAL_CALCULATION_SOURCE_BASELINE.md) — exact Pine hashes, Mizan dependency-version mismatch, and outstanding parity blockers.

The canonical convergence point is **Confluence & Data-Request Controller**, positioned after source ingestion/local calculations and before the AI Engine. It must combine and validate:
1. TradingView webhook evidence.
2. Fundamental news evidence and timestamped news-analysis output.
3. Local deterministic Mizan, Prophet and GMI calculation outputs.

The target explicitly uses **8 core physical Workers plus 1 separate news-ingestion Worker = 9 physical Workers total**. The Confluence & Data-Request Controller is a separate core Worker upstream of the existing AI Engine Worker. No container and no deprecated per-timeframe CTA Worker fleet are part of this baseline. The AI chain remains Analyst → Counselor → Reasoner, and output remains advisory only; no broker integration or automatic execution.

## Existing Cloudflare resources

- AI Worker: `xauusd-ai-trading-assistant`
- AI custom domain: `ai.cryptophys.work`
- TradingView MCP gateway Worker: `xauusd-fundamental-news-ingestion`. The name is historical. It serves fundamental news over HTTP `/pull` and cron, and OHLCV for local engines through the RPC entrypoint `TvGateway`.
- Gateway custom domain: `news.cryptophys.work`. It is kept because it is the registered TradingView OAuth redirect host.
- Market-data / local-engine Worker: `xauusd-tradingview-pull-adapter` (see `docs/MARKET_DATA_INGESTION.md`)
- D1: `xauusd-signals` (ID is in `wrangler.jsonc`)
- KV bindings: `SIGNAL_CACHE`, `WEBHOOK_BUFFER`, `KNOWLEDGE_BASE`

Existing resources and IDs must be reused. Do not recreate them. Keep preview resources separate from production. Binding/configuration names are part of the current contract and must not be changed without a reviewed migration. Secret values must never be committed.

## Current pipeline contract

1. `POST /webhook` accepts a configured indicator source.
2. The request must include the shared secret in `secret` or the `X-Webhook-Secret` header.
3. The payload is recorded in D1 and cached in KV.
4. Current analysis starts after Prophet R38, Prophet R37 SSOT and GMI v12.70 have supplied payloads for the same candle key.
5. Evidence Fusion validates the three webhook payloads, the latest completed fundamental news analysis in D1, and local Mizan/Prophet/GMI results received through `POST /evidence/local-calculation`.
6. Analyst → Counselor → Reasoner receive the versioned fused evidence bundle. Missing/stale local calculations or completed news analysis force a `WAIT` decision with null risk/price fields.
7. Outputs and fusion diagnostics are stored in D1/KV; optional Telegram delivery failure does not invalidate persisted results.

**Implementation/target gap:** the current PR implementation still hosts the initial fusion receiver and `/evidence/local-calculation` endpoint inside `xauusd-ai-trading-assistant`. The approved target in this SSOT moves canonical fusion to the separate planned `xauusd-confluence-controller`; that extraction and authenticated handoff to the AI Worker have not yet been implemented or deployed.

The evidence-fusion implementation on the feature branch adds the local calculation contract and consumes the most recent completed fundamental-news analysis. The endpoint validates/authenticates and stores outputs only when per-engine source and implementation SHA-256 hashes are explicitly allowlisted; production currently has no approved allowlist. The source audit found Mizan v1/v4 dependency mismatch and missing exact GMI/Prophet R37 baselines. Local engine implementation, approved source matrix, parity fixtures, and live end-to-end acceptance remain mandatory blockers. Preserve the existing three-source webhook gate until a reviewed schema/policy migration defines any change to required sources.

## AI model configuration

Use the currently reviewed `wrangler.jsonc` and active Cloudflare binding configuration as the operational reference; do not rely on stale model names in historical documentation. The existing variables are:

- `AI_MODEL_ANALYST`
- `AI_MODEL_COUNSELOR`
- `AI_MODEL_REASONER`

Model availability, quotas, limits and billing must be verified for the intended account and runtime before production acceptance. Do not assume Free-tier fit or add unapproved paid dependencies.

## Required secrets

Set secrets in Cloudflare; never commit their values:

- AI Worker: `WEBHOOK_SECRET`, `INGEST_SECRET`, and Telegram secrets if notifications are enabled.
- News ingestion Worker: `INGEST_SECRET` and the TradingView MCP OAuth client credentials required by the configured authentication method.

The news Worker uses `OAUTH_STORE` for OAuth state/token storage. Configure only variables required by the current Worker implementation and verify them against live bindings.

## Deploy safely

Deployment is controlled by the approved release process. Before production:
1. Review the architecture baseline and current open PRs.
2. Complete source contracts, local-calculation parity and fusion implementation.
3. Pass CI and preview acceptance.
4. Obtain explicit production-release approval.
5. Deploy the reviewed immutable commit SHA using the approved Wrangler/GitHub Actions path.
6. Verify active Worker version, domains, bindings, D1/KV IDs, cron schedules, runtime health and an end-to-end real-data cycle.
7. Record test evidence and rollback target.

A successful `npx wrangler deploy`, merged PR, or `/health` response alone does not mean the product is complete. Follow [Production Definition of Done](docs/PRODUCTION_DEFINITION_OF_DONE.md).

## Webhook payload example

Configure the intended TradingView alert to POST JSON to `https://ai.cryptophys.work/webhook`. This is a schema illustration only; never use placeholder metrics in production.

```json
{
  "secret": "<shared-webhook-secret>",
  "source": "prophet_r38",
  "ticker": "OANDA:XAUUSD",
  "timeframe": "60",
  "candle_time": "2026-10-31T10:00:00Z",
  "candle_key": "OANDA:XAUUSD:60:2026-10-31T10:00:00Z",
  "metrics": {
    "bias": "<actual indicator output>",
    "close": "<actual numeric close>"
  }
}
```

The three current source alerts must use the same canonical `candle_key` for the same closed candle. Future source contracts must be versioned and validated before local calculations/news-analysis output becomes a required fusion input.

## Product completion status

Current status is **IN PROGRESS — PRODUCTION COMPLETE NOT ESTABLISHED**. The registered Worker deployment and bindings have been verified through Cloudflare inventory, but runtime health/end-to-end acceptance was not established by this documentation update. The missing integration and all mandatory criteria in `docs/PRODUCTION_DEFINITION_OF_DONE.md` must pass before the release can be declared **PRODUCTION COMPLETE**.
