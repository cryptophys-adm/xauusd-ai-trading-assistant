# XAUUSD AI Trading Assistant

Cloudflare-based, advisory-only XAUUSD decision support. The current Worker receives TradingView webhook payloads from Prophet R38, Prophet R37 SSOT, and GMI v12.70, stores candle evidence in D1/KV, runs Analyst → Counselor → Reasoner, and can send a Telegram summary.

**Important status:** Cloudflare inventory confirms that the AI Worker and fundamental-news ingestion Worker are deployed. This is not proof of end-to-end product readiness. Local calculation outputs and the completed standalone news-analysis output are not yet proven to be integrated into the technical evidence pipeline. Do not mark the product production-complete until every gate in [Production Definition of Done](docs/PRODUCTION_DEFINITION_OF_DONE.md) passes with recorded evidence.

## Architecture and deployment SSOT

These documents are the baseline for future implementation and deployment:

- [Architecture Baseline](docs/ARCHITECTURE_BASELINE.md) — canonical Evidence Fusion & Orchestration point and immutable architectural constraints.
- [Deployment Blueprint](docs/DEPLOYMENT_BLUEPRINT.md) — phased implementation, preview, production rollout and rollback.
- [Production Definition of Done](docs/PRODUCTION_DEFINITION_OF_DONE.md) — mandatory release acceptance gates.

The canonical convergence point is **Evidence Fusion & Orchestration**, positioned after source ingestion/local calculations and before Analyst/Counselor. It must combine and validate:
1. TradingView webhook evidence.
2. Fundamental news evidence and timestamped news-analysis output.
3. Local deterministic Mizan, Prophet and GMI calculation outputs.

The target describes eight logical responsibilities, not a requirement to deploy eight separate physical Workers. No container and no deprecated per-timeframe CTA Worker fleet are part of this baseline. The existing news-ingestion Worker remains an upstream producer. The AI chain remains Analyst → Counselor → Reasoner, and output remains advisory only; no broker integration or automatic execution.

## Existing Cloudflare resources

- AI Worker: `xauusd-ai-trading-assistant`
- AI custom domain: `ai.cryptophys.work`
- News ingestion Worker: `xauusd-fundamental-news-ingestion`
- News custom domain: `news.cryptophys.work`
- D1: `xauusd-signals` (ID is in `wrangler.jsonc`)
- KV bindings: `SIGNAL_CACHE`, `WEBHOOK_BUFFER`, `KNOWLEDGE_BASE`

Existing resources and IDs must be reused. Do not recreate them. Keep preview resources separate from production. Binding/configuration names are part of the current contract and must not be changed without a reviewed migration. Secret values must never be committed.

## Current pipeline contract

1. `POST /webhook` accepts a configured indicator source.
2. The request must include the shared secret in `secret` or the `X-Webhook-Secret` header.
3. The payload is recorded in D1 and cached in KV.
4. Current analysis starts after Prophet R38, Prophet R37 SSOT and GMI v12.70 have supplied payloads for the same candle key.
5. `runAnalysis()` fetches news evidence and calls Analyst, Counselor and Reasoner.
6. Outputs are stored in D1/KV and a Telegram message is sent when configured.

This is the current implementation, not the complete target architecture. The fusion work must explicitly bring local calculation results and the completed fundamental-news analysis into a validated evidence bundle. Preserve the current webhook gate until a reviewed schema/policy migration defines how new evidence becomes mandatory.

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
