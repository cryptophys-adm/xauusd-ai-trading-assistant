# Production Definition of Done

- Status: Mandatory acceptance gate
- Baseline date: 2026-11-01

## Principle

**All deployment work is complete only when every applicable requirement below is implemented, tested, deployed to the intended environment, and backed by recorded evidence.** A successful build, merged PR, successful Wrangler deployment, or HTTP `/health` response alone does not constitute product completion.

No production release may be declared complete while a mandatory requirement is missing, failing, unverified, or waived without an explicit documented approval.

## Gate A — Architecture and scope
- [ ] The physical Worker topology is explicit: target 9 total (8 core Workers + 1 separate news-ingestion Worker), with 2 existing Workers retained and 7 core Workers planned.
- [ ] Core Worker names are explicit: `xauusd-tradingview-pull-adapter`, `xauusd-pull-orchestrator`, `xauusd-market-data-normalizer`, `xauusd-mizan-engine`, `xauusd-prophet-engine`, `xauusd-gmi-engine`, `xauusd-confluence-controller`, and `xauusd-ai-trading-assistant`.
- [ ] `xauusd-fundamental-news-ingestion` remains a separate ninth Worker; `xauusd-ai-trading-assistant` remains core Worker #8 with all existing AI/D1/KV bindings and model/source contracts preserved.
- [ ] Every required Worker is listed by exact name, purpose, environment, active version, bindings/secrets, quota budget, health status, and rollback target.
- [ ] No unapproved extra Worker or deprecated per-timeframe Worker fleet is deployed.

- [ ] `xauusd-confluence-controller` is the canonical convergence point for webhook evidence, news evidence/news-analysis output, and local calculation outputs; it passes validated evidence to the existing AI Engine.
- [ ] Analyst → Counselor → Reasoner sequence is wired as specified; Counselor sees fused evidence, not merely an isolated summary.
- [ ] The eight logical responsibilities and no-container baseline are respected; no deprecated per-timeframe Worker fleet is reintroduced.
- [ ] Advisory-only behavior is enforced; there is no broker integration or automatic order execution.
- [ ] All source/tool limitations and unsupported Pine features are documented.

## Gate B — Source contracts and data integrity
- [ ] Versioned schemas exist for webhook, news, completed news analysis, and local calculation outputs.
- [ ] Symbol, timeframe, UTC candle timestamps, correlation key, source/version, provenance and freshness are validated.
- [ ] Same-candle evidence is matched correctly; late, duplicated, conflicting, stale and malformed records are handled deterministically.
- [ ] Required evidence policy and degraded/wait behavior are explicit.
- [ ] Timeframe candle-age windows and news/local-calculation freshness thresholds are explicitly approved against actual source timestamp semantics; provisional implementation values do not count as approval.
- [ ] Local calculation results have reproducible parameters and version identifiers.
- [ ] Pine parity is demonstrated for every feature claimed as supported; unsupported features are not misrepresented as parity.
- [ ] No invented, placeholder, or stale values can silently become production evidence.

## Gate C — AI decision quality and output contract
- [ ] Analyst identifies missing or contradictory evidence and does not fabricate facts.
- [ ] Counselor returns evidence summary, bullish/bearish/neutral scenarios, confirmations, invalidation, risks and missing data.
- [ ] Reasoner uses fused evidence plus Analyst and Counselor outputs and returns schema-valid advisory decisions.
- [ ] Prices are null when exact verified price evidence is absent.
- [ ] Invalid model JSON, model timeout, quota rejection and unavailable models produce explicit safe outcomes.
- [ ] The decision and rationale are traceable to the evidence bundle and model identifiers.

## Gate D — Security
- [ ] All webhook/internal endpoints are authenticated and unauthorized requests are rejected.
- [ ] Secrets exist only in the approved secret store and never appear in logs, fixtures, commits or API responses.
- [ ] Input size/schema/range validation, rate limits, bounded retries and timeout limits are in place.
- [ ] D1/KV access and production/preview separation are verified.
- [ ] No credentials or privileged order-execution capability are introduced.

## Gate E — Reliability and observability
- [ ] Idempotency and concurrency tests prove duplicate arrivals cannot create duplicate final decisions for one correlation key.
- [ ] Status transitions and errors are persisted with correlation IDs and timestamps.
- [ ] Health/diagnostic endpoints report meaningful dependency/configuration state without exposing secrets.
- [ ] Logs/metrics make ingestion gaps, stale sources, model failures, quota issues, latency and failed notifications observable.
- [ ] Recovery, retry, cooldown and rollback procedures have been exercised or demonstrated in a controlled test.
- [ ] Notification delivery failure does not corrupt the system of record or falsely mark analysis complete.

## Gate F — CI, tests and review
- [ ] TypeScript typecheck passes.
- [ ] Unit, schema/contract, integration, concurrency/idempotency, security and failure-injection tests pass.
- [ ] Local calculation parity tests pass for the declared supported feature set.
- [ ] All required GitHub Actions checks for the release commit are green; no unresolved blocking review threads or unaddressed critical/high-risk findings remain.
- [ ] Deployment configuration and migrations are reviewed; no resource IDs are recreated or silently replaced.
- [ ] Test evidence records commit SHA, environment, test command, result and timestamp.

## Gate G — Cloudflare deployment and live acceptance
- [ ] Preview acceptance passes before production deployment.
- [ ] Active production Worker version/commit is verified after deployment.
- [ ] Custom domains/routes, bindings, secrets presence, D1/KV resource IDs, cron triggers and compatibility date are verified against the approved baseline.
- [ ] Real authorized webhook, news and local-calculation evidence completes a full end-to-end cycle through fusion → Analyst → Counselor → Reasoner → persistence.
- [ ] The end-to-end result is checked against expected evidence; source timestamps and correlation key are recorded.
- [ ] Model availability, quotas, actual consumption and any cost exposure are measured and accepted; no unapproved paid dependency is introduced.
- [ ] No unexpected 4xx/5xx responses, runtime exceptions, missing evidence, duplicate decisions or sustained quota failures during the agreed canary window.
- [ ] Rollback to the last known-good release is available and documented.
- [ ] Final smoke-test report and production deployment record are saved.

## Gate H — Product readiness and handover
- [ ] README, architecture baseline, deployment blueprint, runbook and source contracts reflect the deployed implementation.
- [ ] Known limitations, supported Pine parity scope, model behavior, resource ownership and operational responsibilities are documented.
- [ ] Release notes identify source commit SHA, active Worker version IDs, migration/version, acceptance report and rollback target.
- [ ] All required product requirements have an owner and a verifiable pass result.
- [ ] Final status is explicitly recorded as **PRODUCTION COMPLETE** only after every mandatory gate passes.

## Final status vocabulary

- **NOT STARTED** — no implementation evidence.
- **IN PROGRESS** — implementation or validation remains.
- **BLOCKED** — a dependency or failed gate prevents progress.
- **PREVIEW ACCEPTED** — preview gates pass; production release still pending.
- **PRODUCTION DEPLOYED / ACCEPTANCE PENDING** — deployed, but live acceptance or documentation evidence remains.
- **PRODUCTION COMPLETE** — every mandatory gate has passed with recorded evidence.
- **ROLLED BACK** — release reverted; completion status is not retained.

## Current baseline status

As of 2026-11-02, the evidence-fusion release was merged to `main` (release commit `3244dc3dab2504801fe0d39bacb71ea2bb61d6dd`). Contract tests, typecheck, bundle validation and isolated preview E2E passed. The additive `analysis_runs` table and `idx_analysis_runs_status_updated` index were applied to production D1 `xauusd-signals` (`ff99b940-254e-4d44-ac1d-bccb9ed18f6e`) and verified through the Cloudflare D1 API. The first production Worker rollout passed build but failed `/ready` with HTTP 503 because `LOCAL_CALC_PROVENANCE_ALLOWLIST` was not configured. That Worker version was rolled back to the previous version `a0b59f78-ba92-4b12-aed1-16a964ff9b8c`; live `/health` returned HTTP 200 after rollback and `/ready` is absent on the restored version. The production AI Worker therefore remains on its previous schedule `*/30 * * * *`, while the news ingestion Worker remains at `5 * * * *`. A release workflow gate is being added so future deploys stop before changing production until explicit per-engine source and implementation SHA-256 allowlists are approved. Exact Prophet R37/GMI source identity, deterministic local engine implementations, Pine parity, provider quota recovery and full live AI-chain acceptance remain unresolved. **Do not mark PRODUCTION COMPLETE or redeploy the new AI Worker until those blockers are resolved.**

### Read-only reconciliation (2026-11-02, late)

- **Production AI Worker is NOT on the rolled-back version.** The script currently served for `xauusd-ai-trading-assistant` (read via the Cloudflare API) contains `/ready`, `LOCAL_CALC_PROVENANCE_ALLOWLIST`, `analysis_runs` and `/evidence/local-calculation`, i.e. the evidence-fusion code from `main`, not version `a0b59f78-ba92-4b12-aed1-16a964ff9b8c`. The script's `modified_on` (2026-11-02T10:38:05Z) falls inside the GitHub Actions run for `6103324` that stopped at the provenance gate.
- **Cloudflare Workers Builds (Git integration) is connected** to this repository for both `xauusd-ai-trading-assistant` and `xauusd-fundamental-news-ingestion` (check runs "Workers Builds: …" appear on PRs).
  - **News Worker — confirmed:** after merge `d01c216` the production `xauusd-fundamental-news-ingestion` script changed at 22:35:17Z, before the Actions "Deploy Worker" step started (22:35:21Z); Actions then deployed again at 22:35:26Z. Every merge to `main` deploys the news Worker through Workers Builds, regardless of path filters.
  - **AI Worker — not confirmed:** after merge `8e163fb` the AI Worker script was not modified (still 10:38:05Z) while the Actions provenance gate blocked deployment. How the evidence-fusion code reached production at 10:38:05Z (during the gated Actions run for `6103324`) is unresolved; check the Worker's Deployments history in the Cloudflare dashboard.
- Consequence today: production `/ready` returns 503 (no allowlist) and analysis waits for all three local engines, so no decision can complete. Production D1 `xauusd-signals` showed 0 rows in `webhook_sources`, `news_analyses`, `trade_decisions` and `analysis_runs`.
- Required owner action: decide whether Workers Builds or GitHub Actions is the single production deploy path for each Worker (Cloudflare dashboard → Worker → Settings → Builds), and make the provenance gate apply to that path. Confirm in Deployments which mechanism produced the AI Worker version live since 10:38:05Z.

### Provenance model change (2026-11-03, owner decision)

- `local_computation` is the primary technical lane and remains required. The 1H TradingView webhook lane is its comparator.
- The operator-approved `LOCAL_CALC_PROVENANCE_ALLOWLIST` and its deploy gate are removed. The AI Worker autonomously promotes or revokes local-engine identities through the deterministic parity registry ([AUTONOMOUS_PROVENANCE.md](AUTONOMOUS_PROVENANCE.md)).
- Gate B's "Pine parity is demonstrated" is therefore met per identity and per field set by registry status `approved`, not by a manual sign-off.
