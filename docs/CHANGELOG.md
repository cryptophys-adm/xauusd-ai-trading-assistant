# Changelog (canonical change log)

This file is the single source of truth for repository changes. Topology and
deployment rules live in `docs/SSOT.md` and `AGENTS.md`; this file records only
what changed and when, by merge commit and PR.

## 2026-11-05

- feat(live-room): Phase C6. Four HUD agents (Trade Management, Kinetic Engine, Fabio AMT, Aegis Footprint) speak in the live 15m room from the 15m HUD snapshot, behind `HUD_AGENTS_ENABLED`. `LIVE_ROOM_MAX_CALLS_PER_HOUR` goes from 36 to 48.
- feat(hud): Phase C5/C7. HUD agents in Threads 1H, behind `HUD_AGENTS_ENABLED` (off in production, on in preview).
  - One agent per computed HUD posts after each H1 synthesis, then a moderator. Agents run on the primary model only, within 30 calls per hour, and each sees only its own verified or not-yet-calibrated reading.
  - Nexus shows them by HUD name with a parity badge.
  - pi's scaffolds are replaced.
- `8caa888` (PR #92) feat(hud): Phase C2/C3 HUD snapshots and readings.
- feat(hud): Phase C2/C3. HUD snapshots per closed H1 and 15m bar from the local engines, covering 13 of the 14 HUDs (Grid Bot not computed).
  - Transport is the RPC `submitHud`, and the snapshots are served at `/api/hud/*`.
  - Each field is verified against the approved local record.
  - Plain-language readings per HUD, with a verified flag per line.
  - pi's empty HUD producer scaffolds are removed.
- `78682a3` (PR #91) feat(chain): local-primary H1 chain, webhooks are calibration only.
- feat(chain): local-primary architecture (owner decision). Parity-approved local records start and drive the H1 chain; TradingView webhooks are calibration only and never start the chain or count as decision evidence.
  - `INDICATOR_SOURCE` (`local`, or `webhook` for rollback) and `CALIBRATION_INTERVAL_DAYS` (30).
  - `/api/status` reports the calibration status per approved identity, and `local_lane.fresh` now means approved local records for a recent candle.
  - A candle without approved local records 30 minutes after the close is recorded as a fail-closed WAIT.
- `b90b2a9` (PR #90) fix(market-data): import publishM5LocalComputation in the cron path.
- fix(market-data): the cron called `publishM5LocalComputation` without importing it (#88). The ReferenceError was swallowed as `local_computation_publish_m5_failed`, so no 5m record was published. A new test runs `scheduled()` end to end and fails on any swallowed publish failure.
- `14b4f99` (PR #89) feat(live-room): C0 step 4.
- `4e42267` (PR #88) feat(parity): C0 step 3.
- feat(live-room): C0 step 4. The live room labels the 5m read **VERIFIED 5m** while `prophet_m5` and `gmi_m5` are parity-approved and the bar's observed 5m records come from those implementations; otherwise it stays UNVERIFIED 5m. `/api/live` returns `m5_verified`, and the Nexus badge follows it.
- feat(parity): C0 step 3. The pull adapter publishes full mizan, prophet and gmi records for every closed 5m bar (`m5-local-producer.mjs`, `M5_PARITY_PUBLISH`). GMI 5m uses `gmi-core-tf.mjs`, a timeframe-parameterised copy proven equal to `computeGmi` on H1. There are new provenance entries `prophet_m5` and `gmi_m5`. The H1 hashes are unchanged.
- `4927dbf` (PR #87) fix(parity): C0 step 2.
- fix(parity): C0 step 2. Registry engine ids are timeframe-scoped (`prophet_m5`, `gmi_m5`, `mizan_m5`, `*_m15`), and H1 keeps the bare ids and its approval. The sweep also reconciles the last six closed 5m candles. Reconcile tasks start the AI chain only on `ANALYSIS_TIMEFRAMES`, so a 5m local record can never run the H1 chain.
- fix(chain): `trade_plan` is requested from the Reasoner and validated against the decision prices (`src/trade-plan.mjs`). PR #74 only passed the raw object through, and the Reasoner was never asked for it.
- fix(webhook): only `ANALYSIS_TIMEFRAMES` start the AI chain (`"60"` in production). Before this, a 5m or 15m alert would have run the full chain, the bus and Telegram on every bar. Other timeframes are stored only, for parity.
- docs: C0 "verified 5m lane" added before C1 (owner decision).
- `3584e19` (PR #70) docs(hud-agents): Phase C plan.
- docs(hud-agents): Phase C plan recorded.
  - Owner decisions: Aegis joins the live 15m room, HUD data is verified through a Pine candidate comparator, and the candidate plus `*_hud` webhook ingestion ship first.
- `a8f6cc3` (PR #69) docs: Phase B HUD agents RFC.
- `73a0a98` (PR #68) docs(hud-agents): owner answers to the Phase A open questions.
- docs(hud-agents): owner answers to the Phase A open questions:
  - 15m HUD agents with parity-verified data (Pine candidate comparator for H1 and 15m);
  - non-reproducible HUD rows become H1 decision-reasoning output;
  - the funnel is read per current candle;
  - `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`.
- `75c4bbb` (PR #66) docs: Phase A HUD agents assessment.
- `6e49eb2` (PR #67) fix(chain): plain-language H1 decision text.
- fix(chain): the H1 decision text (reasoning, confirmation, invalidation) is written in plain language.
  - The Reasoner prompt carries a natural-language rule, and there is a one-call rewrite of code-like text by the bus model.
  - The decision, prices and conditions are never changed, and a rewrite that adds a number is rejected.
  - Prompted by the first complete H1 analyses after Prophet and GMI were parity-approved (2026-11-05 01:00 UTC).
- `8436980` (PR #65) docs(hud-agents): owner decisions recorded.
- docs(hud-agents): owner decisions recorded in `docs/BRIEF_HUD_AGENTS.md`:
  - the Prophet R38 top-right HUD agent is named "Prophet";
  - Matrix & Omega Sensors gets one agent per titled section (Tactical Muscles, Macro & Aether Sensors, GABFX Price Action, Playbook Execution, Decision Matrix, Grid Bot Protocol);
  - that makes 14 HUD agents.
- `d4e8e60` (PR #64) feat(live-room,nexus): 15m live room; old debate/raw dashboard retired; HUD-agent brief.

## 2026-11-04

- feat(live-room,nexus): the live room meets at every 15m candle close. The closed 15m candles are the setup; the 5m local-lane data is the execution read. The AI Worker's old `/dashboard` (debate chat timeline and raw output) is retired and redirects to Nexus, so only the threads and the live room are shown.
- `818b730` (PR #63) feat(agents,nexus): TradingView webhooks decoded into plain language for agents and dashboard.
- feat(agents,nexus): the three TradingView webhook alerts are decoded into plain language (`src/webhook-interpretation.mjs`, codes per the Pine sources). The reading feeds the technical agent, which must interpret Prophet R38, Prophet R37 and GMI v12.70 by name; it is shown as "TradingView signals (H1)" on the decision card and the Threads 1H post. The H1 decision is unchanged (still fail-closed).
- fix(agents): news-thread and live-room answers that fail only the natural-language check get one budgeted correction call. The natural-language rule no longer shows a literal key path as its counter-example.
- fix(synthesis): `ai_syntheses.prophet_metrics`/`gmi_metrics` store the alert's indicator fields; an alert that also carried a `metrics` object used to lose them (`storedIndicatorMetrics`).
- `5049369` (PR #62) feat(nexus): Threads 1H, natural-language agent output, agent names only.
- feat(nexus): Threads 1H replaces the old debate card; agents are shown by name only (no model names); agent output must be natural language (validated); the WAIT reasoning and 5m context read as plain sentences.
- `2341164` (PR #61) feat(phase4): bus, news threads and live 5m room enabled in production.
- feat(phase4): enable the multi-agent bus, news threads and the live 5m room in production (owner approval); shadow/advisory only.
- `8f62aed` (PR #60) feat(phase3): agent threads per news analysis and a live 5m trading room.
- feat(phase3): agent threads per news analysis and a live 5m room (`src/agent-threads.mjs`, migration 0004, `/api/threads`, `/api/live`, `POST /evidence/m5-context`, Nexus cards); the 5m context carries `recent_bars`; flags are on in preview, off in production.
- `b930221` (PR #59) fix(news,ohlcv): generic HTTP 429 opens a shared rate-limit cooldown.
- fix(news,ohlcv): a generic HTTP 429 from TradingView MCP (without the TOOL_QUOTA_EXCEEDED text) now opens a short shared cooldown (`provider_rate_limited`, Retry-After clamped to 30 s..15 min) and is not retried; a shorter cooldown never overwrites a longer quota suspension.
- `015d0b4` (PR #58) feat(phase2): real multi-agent bus on `@cf/zai-org/glm-5.3-flash`, shadow only, flag off in production.
- bus: primary model is `@cf/zai-org/glm-5.3-flash` (owner decision; Beam needs AI Gateway Unified Billing credits); moderator `reasoning_effort` is `high` (`medium` maps to `max` on GLM-5.3), agent token budget is 3072.
- fix(preview-e2e): allow 300 s for the five sequential multi-agent model calls; the fallback model exceeded the previous 180 s budget before moderator consensus.
- feat(phase2): real multi-agent bus (shadow, flag off in production): `src/multi-agent-bus.mjs`, queue task `multi_agent_bus`, `GET /api/bus`, Beam + glm-4.7-flash fallback, strict JSON schema + validation, hourly/300 s budgets that fail closed, idempotent per run; 20 tests with node:sqlite D1 + fake `env.AI`; preview-e2e proves 5 real model messages + consensus. Supersedes PR #53.
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
