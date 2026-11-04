> **HISTORICAL / SUPERSEDED (2026-11-04).** This document describes earlier plans or states. The canonical, current topology and deployment rules are in [docs/SSOT.md](SSOT.md) and [AGENTS.md](../AGENTS.md). Where this document disagrees with them, it is wrong. In particular, the "8 core + 1" Worker plan (pull-orchestrator, normalizer, mizan/prophet/gmi engines, confluence-controller) is cancelled and those Workers were removed. Do not deploy anything described here.

# OpenCode CLI — Continuation Mandate (XAUUSD AI Trading Assistant)

## 0. Current objective
Continue the existing work in `cryptophys-adm/xauusd-ai-trading-assistant` on branch `feat/evidence-fusion-contracts` and PR #12. Refresh the live PR head and repository state before editing; do not rely on a remembered SHA. This file supplements, and does not replace, the current repository docs, PR discussion, CI workflows, or the owner’s explicit decisions.

## 1. Pine Script SSOT uploads — mandatory source handling
The owner supplied three Pine Script text artifacts and designated them as the intended final TradingView SSOT set. They are stored verbatim in source content (line-ending normalization may occur in Git):
- `pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt`
- `pinescript/ssot/The-Prophet-v7.02-R38.txt`
- `pinescript/ssot/CryptophysMizanLib-uploaded.txt`

Do not edit, reformat, “fix”, rename internally, or generate substitutes for these source artifacts. Treat them as immutable inputs. The repository text upload uses LF line endings; original uploaded-file SHA-256 values below are for the raw attachments (CRLF), so compare normalized text or normalize line endings before checking content identity. Do not treat Git blob SHA as the source-file SHA-256. Do not treat the filename alone as proof of implementation identity.

Original uploaded artifact SHA-256:
- `Global Multiverse Interpreter(1).txt`: `32d21b2429af502e9a894027b0160ec85ea7022fe93d2a4263b705ab261974d7`
- `The Prophet(1).txt`: `c1d2c698056b12b559762eb99c27ed328d783ebd7e5f2b9f1c9d910772325f6b`
- `CryptophysMizanLib(8).txt` (superseded, incorrect content): `2cd6e9727238ba1ed6ab41cfe272aafbb62b9dd5cebb7ef06c39e8f1871cc2fe`
- `CryptophysMizanLib(9).txt` (corrected replacement supplied 2026-11-02): `252139fc8b5bb056af817deab152da6376923ae5647cba3b0413dc2abd024f89`

### Source integrity discrepancy — must be resolved before parity claims
The prior `CryptophysMizanLib(8).txt` artifact was incorrect and is superseded. The owner supplied corrected `CryptophysMizanLib(9).txt`; `pinescript/ssot/CryptophysMizanLib-uploaded.txt` now contains that library source. Raw attachment SHA-256 is `252139fc8b5bb056af817deab152da6376923ae5647cba3b0413dc2abd024f89`. Do not use the superseded (8) artifact. See `docs/LOCAL_CALCULATION_SOURCE_BASELINE.md` for provenance and the remaining dependency/parity caveat. The uploaded GMI source still contains a comment at line 26 saying: “VALIDATION: static transformation only. TradingView compilation, replay, and regression NOT yet verified.” This conflicts with the owner’s statement that the final TV scripts compile successfully. Preserve the GMI source as supplied and do not claim GMI parity until the compile-passing source is confirmed against authoritative TradingView/repository evidence. Surface this remaining discrepancy in the final report; request the GMI source only if it cannot be verified from authoritative evidence.

## 2. Architecture is fixed unless owner approves a change
Target is 8 core Cloudflare Workers plus the separate existing news ingestion Worker (9 physical Workers total):
1. `xauusd-tradingview-pull-adapter`
2. `xauusd-pull-orchestrator`
3. `xauusd-market-data-normalizer`
4. `xauusd-mizan-engine`
5. `xauusd-prophet-engine`
6. `xauusd-gmi-engine`
7. `xauusd-confluence-controller`
8. Existing `xauusd-ai-trading-assistant`
9. Separate existing `xauusd-fundamental-news-ingestion`

No containers, no per-timeframe worker fleet, no invented TradingView MCP capabilities, no automatic execution or broker integration. The confluence controller must own evidence validation/fusion/data-request policy and hand off authenticated, versioned evidence to the AI worker. Do not claim the planned seven workers are deployed until deployment evidence proves it.

## 3. Preserve existing AI contract
- Models in order: Analyst `@cf/zai-org/glm-4.7-flash`, Counselor `@cf/google/gemma-4-26b-a4b-it`, Reasoner `@cf/nvidia/nemotron-3-120b-a12b`.
- Preserve bindings `AI`, `DB`, `SIGNAL_CACHE`, `WEBHOOK_BUFFER`, `KNOWLEDGE_BASE`.
- Required source identifiers: `prophet_r38,prophet_r37_ssot,gmi_v12_70` until the owner explicitly approves a contract change.
- Advisory only. Missing/stale/conflicting/unverified evidence must fail closed to `WAIT` / `NO_TRADE`; unsupported confidence, price, and risk values remain null. Never invent market data.

## 4. Continue implementation, not audit-only loops
1. Refresh PR #12, branch head, changed files, Actions checks, reviews, and unresolved threads. Confirm all writes target the current branch and not `main`.
2. Read `README.md`, `docs/ARCHITECTURE_BASELINE.md`, `docs/DEPLOYMENT_BLUEPRINT.md`, `docs/PRODUCTION_DEFINITION_OF_DONE.md`, `docs/LOCAL_CALCULATION_SOURCE_BASELINE.md`, and `docs/EVIDENCE_CONTRACTS.md` before design changes.
3. Reconcile the Pine SSOT discrepancy above first. Build deterministic engines only from verified source semantics; do not hand-translate an unknown library from a duplicate indicator file.
4. Extract the canonical fusion and data-request policy into `xauusd-confluence-controller`; define authenticated, versioned handoff to the existing AI Worker. Avoid duplicate policy ownership.
5. Build the seven planned core Workers with real contracts and tests; avoid placeholder workers and fake source hashes.
6. Fix and regression-test all review findings, including concurrent duplicate candle claims/AI runs/notifications; stale or reused news digests; future timestamps; stale underlying candles with fresh computed_at; secret-field leakage; identical degraded replay duplication while permitting recovery when evidence changes; streaming request body limits; retry fingerprints; H2 freshness; preview D1 migration/readiness; preview provenance allowlist; invalid fixture source_hash/implementation_hash; and case-insensitive SHA normalization.
7. News ingestion: both `fundamental-news-ingestion/src/index.mjs` and `src/news-filter.mjs` must filter to timestamped, unique articles from the preceding 1 hour, including cached results and historical analysis evidence. The intended branch schedule is ingestion at `5 * * * *` and AI news analysis at `6 * * * *`, so the AI Worker reuses the ingestion cache rather than issuing a second upstream request. `package.json` must run both root and ingestion-worker tests. Keep regression tests for old/future/untimestamped items, duplicate URLs/IDs, and epoch timestamps. Never label an unchanged/stale digest fresh. Verify provider cooldown has recovered before production release.
8. Reconcile the two previously observed D1 IDs `ff99b940-254e-4d44-ac1d-bccb9ed18f6e` and `90f53f14-ff7b-46c1-b146-a1efd4e13018` against active bindings. Do not guess or migrate production D1 without explicit proof of the correct resource and required permissions. Preview D1 must be isolated.
9. Keep all production provenance allowlists empty/unapproved until exact verified source and implementation hashes are available. Never use placeholder hashes.
10. Run tests, typecheck, Wrangler dry-run, isolated preview E2E, readiness checks, and acceptance gates. Record exact commands, commit SHA, outputs, and any blockers.

## 5. Release safety
- Do not merge PR #12 or deploy production until source integrity, parity, freshness policy, provider quota recovery, provenance, D1 migration, and full acceptance gates pass.
- Do not change production Worker settings, production D1 schema/data, secrets, or traffic as part of preview validation.
- Do not resolve review threads merely to make the PR appear clean; resolve only after the actual finding is fixed and verified.
- Do not stop after repeated audits. Implement, test, commit coherent changes, and report hard blockers with evidence.

## 6. Final report format
Report:
1. Current branch/head SHA and PR status.
2. Files committed and commit SHAs.
3. Pine SSOT inventory and the MizanLib/GMI discrepancies.
4. Implemented changes and tests with actual results.
5. Worker deployment state, distinguishing deployed from planned.
6. Remaining release blockers and the specific evidence needed to clear each.
7. Explicit release status: `READY FOR REVIEW`, `READY FOR PREVIEW ACCEPTANCE`, `PRODUCTION RELEASE BLOCKED`, or `PRODUCTION DEPLOYED AND VERIFIED`.
