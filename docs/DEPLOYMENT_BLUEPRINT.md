# Deployment Blueprint — Evidence Fusion Production Path

- Status: Baseline for implementation; not a claim of production completion.
- Date: 2026-11-01
- Target repository: `cryptophys-adm/xauusd-ai-trading-assistant`

## Objective

Deliver a reliable, auditable XAUUSD decision-support product that converges TradingView webhook data, fundamental news and deterministic local calculations into one validated evidence bundle before the AI Counselor and final Reasoner. The existing Cloudflare AI Worker and news-ingestion Worker are retained. No container and no deprecated per-timeframe Worker fleet.

## Existing deployment inventory (verified from Cloudflare account API on 2026-11-01)

- `xauusd-ai-trading-assistant` — production Worker, custom domain `ai.cryptophys.work`, latest listed deployment at 100% traffic.
- `xauusd-fundamental-news-ingestion` — production Worker, custom domain `news.cryptophys.work`, cron configured every minute.
- AI Worker cron configured every 30 minutes.
- AI Worker has bindings `AI`, `DB`, `SIGNAL_CACHE`, `WEBHOOK_BUFFER`, `KNOWLEDGE_BASE`; model vars for Analyst/Counselor/Reasoner; source and news URL vars.
- D1 `xauusd-signals` and preview D1/preview KV resources are present.
- Live preflight (2026-11-01): AI Worker `/health` returned HTTP 200 with D1/KV/Workers AI bindings present. News Worker `/health` returned HTTP 200 but reports `provider_cooldown_reason=provider_quota_exceeded`; its latest scheduled ingest returned HTTP 503 and zero articles. This is a blocking upstream quota condition, not a healthy ingestion cycle. End-to-end fusion remains unverified.

## Phased rollout

### Phase 0 — Freeze and inventory the baseline
- Treat `ARCHITECTURE_BASELINE.md` as the architecture authority.
- Capture current `main` SHA, Worker active version IDs, resource IDs, vars/bindings names, cron schedules, domains, D1 schema, open PRs, and source-code hashes.
- Keep secrets out of repository artifacts and logs.
- Review all open PRs that could change ingestion, quota/cooldown behavior, model configuration, or deployment workflows before merging overlapping changes.

### Phase 1 — Specify the source/evidence contracts
- Define JSON schemas and versioning for webhook, news evidence, completed news analysis, and local calculation results. Implemented on feature branch: `docs/EVIDENCE_CONTRACTS.md` and `cryptophys.evidence-fusion.v1` / `cryptophys.local-calculation.v1`.
- Define UTC timestamp/candle semantics, symbol/timeframe normalization, correlation key, freshness thresholds, required-source policy, provenance, idempotency, and degraded outcomes.
- Confirm exact Pine source files/versions and data/tool capabilities. Do not assume MCP supports unverified market-data features.
- Create fixture datasets from known closed candles; prohibit synthetic fixture values from being used as production data.

### Phase 2 — Build and test deterministic local calculations
- Establish Python reference calculations and fixture corpus.
- Implement one calculation slice at a time; TypeScript or Rust/WASM according to measured constraints.
- Run numeric and signal parity tests against source Pine outputs for every feature claimed as supported.
- Mark unsupported Pine features and data dependencies as explicit gaps.
- Verify Worker CPU, memory, bundle size, and request budget before choosing Rust/WASM production kernels.

### Phase 3 — Implement Evidence Fusion
- Add local calculation output as a first-class, authenticated/versioned evidence source or internal module output. The feature branch implements authenticated `POST /evidence/local-calculation`, a 64 KiB body cap, version/freshness/provenance validation, a per-engine SHA-256 allowlist, KV storage, and a trigger when all configured webhook and local engine records are present. It is a contract receiver, not the actual Mizan/Prophet/GMI calculation engines. See [Local Calculation Source Baseline](LOCAL_CALCULATION_SOURCE_BASELINE.md): Mizan v1/v4 differ, the audited GMI baseline hash is not available as an exact source file, and the exact Prophet R37 producer source remains unidentified. Do not configure production provenance allowlists until these discrepancies and parity fixtures are resolved.
- Add the completed fundamental news-analysis result to the same fusion contract; preserve article evidence and analysis timestamps.
- Keep the current webhook source gate compatible until a reviewed migration specifies the new required-source policy.
- Validate source schemas, same-candle identity, freshness, provenance, duplicate handling, conflicts, and retry limits.
- Persist fusion status, evidence references, validation errors, and decision lineage to D1/KV without storing secrets.

### Phase 4 — Wire the AI chain
- Analyst receives only the fused evidence bundle and must explicitly identify gaps.
- Counselor receives the full validated evidence bundle and Analyst output; it must generate scenarios, confirmations, invalidations, risks, and missing data.
- Reasoner receives fused evidence, Analyst output, and Counselor output and returns a schema-validated advisory decision.
- Reject malformed model output; exact price fields are null if verified price evidence is absent.
- Never execute trades or connect a broker.

### Phase 5 — Preview and acceptance
- Use preview-only D1/KV resources and preview Worker routes/domains.
- Run unit, contract, integration, concurrency/idempotency, stale/missing-data, security, and failure-injection tests. A PR workflow runs Node contract tests, TypeScript typecheck, and Wrangler dry-run. End-to-end and concurrency acceptance still require successful preview runtime tests.
- Verify actual news ingestion and actual webhook/calculation evidence end-to-end using authorized real data. Record source timestamps and request/response correlation IDs without secrets.
- Confirm model availability and quota/cost behavior; avoid deployment that depends on unverified or paid capabilities.
- Test Telegram as an optional notification sink, not as the system of record.
- Produce a test report with evidence, versions, pass/fail, and known limitations.

### Phase 6 — Controlled production rollout
- Production deployment requires explicit approval after preview acceptance.
- Deploy immutable/reviewed commit SHA through the approved GitHub Actions/Wrangler workflow. The workflow runs unit tests, TypeScript typecheck and Wrangler dry-run before deploying and smoke-testing. The additive D1 migration must be applied and verified through an authorized Cloudflare D1 session before merging/releasing this code; the current GitHub Actions API token is not authorized for the D1 query/import endpoints. Do not merge this release until `analysis_runs` exists in production D1. If deployment fails, roll back Worker code to the prior known-good version; the additive table can remain because the previous code does not depend on it.
- Verify active deployment version, bindings, D1/KV targets, custom domain, cron, and Worker health.
- Run a bounded canary with known evidence and compare output against expected fixtures.
- Check logs/metrics for errors, model failures, ingestion gaps, duplicate decisions, latency and quota consumption.
- Roll back to the last known-good version if any mandatory gate fails.
- Update operational documentation and release notes with the deployed SHA/version and acceptance evidence.

## Security and reliability requirements

- Authenticate webhook and internal ingestion paths; use constant-time secret comparison where available and never echo secrets.
- Validate body size, schema, allowed source, timestamp range, and numeric bounds.
- Apply rate limits, bounded retries, timeout budgets, and provider cooldown rules.
- Make ingestion and analysis idempotent; concurrent arrivals for the same candle must not trigger duplicate final decisions.
- Use explicit status transitions: `received`, `waiting_for_evidence`, `validating`, `ready`, `analyzing`, `complete`, `degraded`, `failed`.
- Persist failures and retryability without exposing credentials or sensitive payloads.
- Keep preview and production resources strictly separated.
- No automatic trade execution, broker credentials, or order-placement endpoints.

## Production acceptance evidence

A deployment is not complete merely because Wrangler reports success or the Worker responds to `/health`. Completion requires the full definition of done in `PRODUCTION_DEFINITION_OF_DONE.md`, with recorded proof for every applicable criterion.
