# Changelog (canonical change log)

This file is the single source of truth for repository changes. Topology and
deployment rules live in `docs/SSOT.md` and `AGENTS.md`; this file records only
what changed and when, by merge commit and PR.

## 2026-11-04

- feat(phase2): real multi-agent bus (shadow, flag off in production): `src/multi-agent-bus.mjs`, queue task `multi_agent_bus`, `GET /api/bus`, Beam + glm-4.7-flash fallback, strict JSON schema + validation, hourly/180 s budgets that fail closed, idempotent per run; 20 tests with node:sqlite D1 + fake `env.AI`; preview-e2e proves 5 real model messages + consensus. Supersedes PR #53.
- (PR #57) docs: RFC Phase 3 — Nexus agent social view (news threads + live 5m trading room), `docs/RFC_NEXUS_AGENT_SOCIAL.md`.
- `40bee90` (PR #56) fix(nexus): dashboard local-lane panel, parity streak in status, m5 fetch guards; no auto-override of the user's selection.
- `350f593` (PR #55) fix(nexus): restore dashboard scripts — escaped quote in `loadTechnicalDecision` onclick (from PR #43, `7535188`) was a JS syntax error that left every panel on "Loading…"; adds `test/nexus-dashboard-html.test.mjs`.
- `0e6eb85` (PR #54) hotfix: regressions from #52 (backfill failure recorded, REQUIRED_SOURCES from env, real >2h test).

- `096e5fb` (PR #51) hotfix: H1 analysis trigger + news lookback 75 min.
- (PR #50) fix(phase1): m5 context validation/freshness helper, tests, docs.
- `1f37a7c` (PR #48) feat(evidence): add informational (untrusted) 5m context field to fusion bundle.
- `663b411` (PR #47) docs: RFC informational (non-trusted) 5m engine in evidence bundle.
- `8e664f4` (PR #46) feat(engines): informational 5m prophet context producer (B1).
- `dd291fe` (PR #45) feat(nexus): surface 5m OHLCV context in technical decision view.
- `ed49480` (PR #44) docs: RFC multi-agent communication bus (proposal).
- `770ff3d` (PR #43) feat(nexus): surface technical decision debate in dashboard.
- `4fe4b7e` (PR #42) docs: add canonical changelog; reference from SSOT.
- `2f3930a` (PR #41) fix(parity): scheduled reconcile sweep + local-lane diagnostics.
- `f515beb` (PR #40) canonical SSOT + AGENTS.md rules; mark stale docs historical; topology guard test.
- `553548e` (PR #39) fix(agents): token budgets for reasoning models; never store raw response objects.
- `78ecef1` (PR #38) decommission six legacy Workers; document local computation ownership.
- `136ef34` (PR #37) fix TradingView OAuth PKCE cookie fallback.

## 2026-11-03

- `81f3452` (PR #35) knowledge base v4; fix news RPC entrypoint; chart smoke test.
- `5dff8c9` (PR #34) XAUUSD candlestick chart on Nexus dashboard.
- `ba5f613` (PR #33) fix garbage agent output; bring dashboard API and Nexus Worker into git.
- `0ee3993` (PR #31) identities changed (parity streaks reset).
- `22a1752` (PR #27) H1 local_computation producer + publisher.
- `7f7e6c3` (PR #26) autonomous parity registry replaces operator hash allowlist.
- `ec38530` (PR #25) keep webhook lane; three distinct AI input lanes.
- `817963a` (PR #24) TradingView MCP as the only market-data source for local engines.
- `1faab4b` (PR #23) (merge).
- `8e163fb` (PR #22) Prophet R37/R38 local engine, market-data ingestion, shadow deploy workflow.

(Older entries: see `git log`.)
