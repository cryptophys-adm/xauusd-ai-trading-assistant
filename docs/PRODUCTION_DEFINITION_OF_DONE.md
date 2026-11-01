# Production Definition of Done

- Status: Mandatory acceptance gate
- Baseline date: 2026-11-01

## Principle

**All deployment work is complete only when every applicable requirement below is implemented, tested, deployed to the intended environment, and backed by recorded evidence.** A successful build, merged PR, successful Wrangler deployment, or HTTP `/health` response alone does not constitute product completion.

No production release may be declared complete while a mandatory requirement is missing, failing, unverified, or waived without an explicit documented approval.

## Gate A — Architecture and scope
- [ ] Evidence Fusion & Orchestration is the canonical convergence point for webhook evidence, news evidence/news-analysis output, and local calculation outputs.
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

As of 2026-11-01, the existing AI and news Workers and their Cloudflare resources are registered/deployed, but the full fusion of local calculation outputs and completed news-analysis output has not been proven. End-to-end runtime health could not be verified from the inspection environment. Therefore, **the product must not be marked PRODUCTION COMPLETE** until the missing integration and all acceptance gates above are verified.
