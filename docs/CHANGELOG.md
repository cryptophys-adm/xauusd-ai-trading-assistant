# Changelog (canonical change log)

This file is the single source of truth for repository changes. Topology and
deployment rules live in `docs/SSOT.md` and `AGENTS.md`; this file records only
what changed and when, by merge commit and PR.

## 2026-11-05

- fix(market-data): TradingView MCP daily budget 1200 → 800 (owner decision 2026-11-05).
  - **Why.** TradingView suspended the account's MCP access until 00:00 UTC for suspicious volume, which also stopped the pull adapter. It warned that continued volume could mean a one-week suspension.
  - **Demand cut.** Steady-state demand was about 1000 calls a day. `TVC:USOIL`, which no local engine reads, now refreshes every 4 hours (`refresh_seconds`) instead of every 5 minutes. That brings demand to about 720 a day, under the new cap.
  - **Unchanged.** The XAUUSD series keep their cadence.

- feat(shadow): GMI "Prophet risk hold" candidates `gmi_v12_70@latch8` and `gmi_v12_70@latch12`.
  - **How they work.** `src/gmi-regate.mjs` recomputes the two points of GMI v12.70 that the Prophet structure feeds: `mtf_state`, and the R10 gate with its risk hold. It starts from the approved local GMI record's diagnostics, so the hashed engine is not forked.
  - **Exactness.** With the active structure it reproduces GMI's comparable fields exactly (42 cases across two branches).
  - **Shadow family.** `gmi_v12_70` is a new shadow family. Its control is checked against the approved records.
- docs(rfc): owner decisions 2026-11-05. Decision 1: a local-only improved version is enough to prove it first. Decision 6: no limit on agents per room.

- ci(preview-e2e): a War Room proof draws its random 15m bar only when the shared preview D1 has no room for it yet. Run 42080341191 drew a bar an earlier run had used and read that run's room.
- ci(preview-e2e): transport errors between the runner and the preview edge (`ECONNRESET`, timeouts, socket errors) are retried up to 5 times. Every e2e request is idempotent. Run 42079728424 died on one reset right after a passing War Room proof.
- fix(war-room): blank conclusion reasons are dropped before validation. A preview run on 2026-11-05 returned three reasons and an empty string, which failed the whole conclusion as `reasons_invalid`. A list with no non-blank reason still fails.
- feat(shadow): RFC_INDICATOR_AGENT_PLATFORM P5, the first improvement candidates: structure-latch expiry.
  - **Candidates.** `prophet_r37@latch8`, `prophet_r37@latch12` and `prophet_r38@latch8`. The ±3 structure latch expires after 8 or 12 closed H1 bars instead of 50.
  - **Local-only.** They are option (b); owner decision 1 decides whether a promotion also needs a Pine candidate. They run in shadow only.
  - **Stricter criteria.**
    - A higher accuracy must pass a paired one-sided sign test (p < 0.05) on the bars where the versions disagree.
    - Stuck time is compared in candles, not episodes, because expiring a latch can split one episode in two.
  - **Real-data replay** (696 scored H1 bars, 2026-09-19 to 2026-11-05):

    | Version | Accuracy | Control | Bars that differ | Paired result |
    |---|---|---|---|---|
    | `prophet_r37@latch8` | 0.431 | 0.433 | 21 | 3 vs 4 |
    | `prophet_r37@latch12` | 0.434 | 0.433 | 6 | 3 vs 2 (p 0.5) |
    | `prophet_r38@latch8` | — | — | 0 | — |

    - `prophet_r38@latch8` changes no direction: R38 confirmed only 4 times in 696 bars.
    - Expiry alone is not yet an improvement. Its main effect would be on GMI's "Prophet risk hold", which needs a GMI variant: a future candidate.

- feat(shadow): RFC_INDICATOR_AGENT_PLATFORM P3, shadow indicator versions.
  - **Framework.** `src/shadow-versions.mjs` replays a control (the active Prophet R37 and R38 code with defaults) and candidate versions over the same cached H1 bars, once an hour. Outputs are stored after a 300-bar warm-up, and the first computation is final (`shadow_outputs`, migration `0008`).
  - **Scoring.** Outputs are scored as `shadow:<version>`.
  - **Comparison.** Candidates are compared with the control on the same bars using the RFC criteria: higher accuracy, no new stuck episodes, and at least 200 bars.
  - **Read model.** `GET /api/shadow-versions` and the Nexus `/shadow` page.
  - **Isolation.** Nothing reaches a room, a prompt or a decision, and the engine files are unchanged. P3 ships no candidate; P5 adds the first.

- feat(platform): RFC_INDICATOR_AGENT_PLATFORM P4, owner instruction 2026-11-05.
  - **Binding.** The AI Worker binds `AGENTS` to the Cryptophys Platform `cryptophys-ai-kernel` `AgentRpc` entrypoint. The binding pins `host_worker` and carries no secret. It is production only; preview has no binding, so the code is a no-op there.
  - **Reports.** One advisory report per meaningful event, sent from the parity sweep cron:
    - `xauusd-reasoner`: each new H1 decision; a BUY↔SELL flip is a `warning`.
    - `xauusd-moderator`: the War Room conclusion when its stance changes, otherwise at most once an hour.
    - `hud-*`: a HUD stance moving into or out of BUY or SELL.
  - **Failure handling.** A denial or a kernel rejection is recorded and never retried. Only a transport failure is retried, by the next sweep. Nothing is ever fatal to the chain.
  - **Storage and API.** Migration `0007_platform_publications.sql` adds the cursors. `GET /api/platform/status` shows them.
  - **Topology.** The topology test pins the binding to the production AI Worker.
  - **Platform-side auditor.** The Indicator Auditor of RFC §6 lives in the platform (owner decision 5); no platform change is needed.

- fix(scoring): scoring v3 (owner approval 2026-11-05). WAIT is missed only when a 2:1 trade would have won: `1 × ATR` on one side before `0.5 × ATR` on the other. In production, v2 still marked H1 WAIT right on only 1 of 35 candles, because over 4 H1 candles some side almost always reaches `0.5 × ATR` first. BUY and SELL scoring is unchanged. Rows are rescored within the lookback.
- feat(15m,war-room): owner decisions A and B.
  - **A: calibration status once.**
    - Each agent's evidence status is stored once in the War Room brief and shown once on Nexus. Agents never repeat calibration disclaimers; 12 of 17 openings at 16:00 had led with "not yet calibrated".
    - Uncalibrated HUD agents are capped at confidence 0.4.
    - The bus and the moderator weigh verified evidence above uncalibrated readings.
    - Agent ids written with spaces are accepted. The 16:00 opening of `interstellar_eyes` had failed as `agent_mismatch`.
    - Agents are named, not referred to by id, in debate text. The 16:00 Risk Manager rebuttal had failed the natural-language check over `kinetic_engine`.
  - **B: verified 15m lane.**
    - `m15-local-producer.mjs` and `publishM15LocalComputation` publish 15m records (`M15_PARITY_PUBLISH`).
    - New identities `prophet_m15` and `gmi_m15` have their own provenance; the H1 and 5m hashes are unchanged.
    - The parity sweep covers the last two closed 15m candles.
- fix(scoring): scoring v2 (owner approval 2026-11-05).
  - WAIT is a missed opportunity only when a BUY or a SELL on the same candle would have been a hit. A whipsaw counts as a hit for WAIT.
  - Under v1, a 0.5 × ATR touch within 4 candles marked nearly every WAIT as missed: the chain was right on 1 of 35 candles and the room on 0 of 56.
  - Older rows are rescored within the lookback, and scorecards read only v2. Migration `0006_outcome_runs_version.sql`.
- feat(war-room): Live War Room 15m (owner decision).
  - **Room.** At every 15m close, all agents open on a communication bus with one role each: H1 Desk, News, Technical, Risk and 13 HUD agents. The minority and the Risk Manager then debate for at most 3 minutes, and the moderator concludes for the Nexus main panel. The H1 decision stays the constraint.
  - **Rollout.** Behind `WAR_ROOM_ENABLED` (on), with `WAR_ROOM_MAX_CALLS_PER_HOUR = 112`. It replaces the legacy live room and the per-H1 HUD agents.
  - **APIs.** `GET /api/war-room/latest` and `GET /api/tldr`.
  - **No confirmation, no entry** (owner rule): the Risk Manager enforces it from the H1 and VERIFIED 5m Prophet R38 confirmations, and a BUY or SELL conclusion without the matching confirmation is rejected.
  - **Nexus.** The main panel is the conclusion, the War Room shows the latest discussion only, and the right panel holds only the Threads 1H and News Thread TLDR. The left panel lists the War Room agents.
- feat(scoring): RFC_INDICATOR_AGENT_PLATFORM P1 (owner approval of the scoring definition and the stuck-state thresholds).
  - Deterministic outcome scoring of the H1 chain, bus, HUD-agent, indicator and live-room stances: horizon 4 candles, threshold `0.5 × ATR(14)`.
  - A stuck-state detector: a field unchanged for 8 H1 candles while the range exceeds `3 × ATR`.
  - New migration `0005_outcome_scores.sql`, run in the parity sweep cron, and new read APIs `GET /api/scorecards` and `GET /api/stuck-states`.
- feat(m5): B2. The 5m execution context is the bar's 5m parity record, reshaped (`m5-context.mjs`), sent once per closed 5m bar; `buildM5ProphetContext` is retired. The H1 chain and the bus label it VERIFIED 5m while `prophet_m5` and `gmi_m5` are approved, otherwise UNVERIFIED 5m. It still never changes the H1 decision or prices.
- fix(agents): a retried thread step (HUD agents, live room, news threads) replaces its stored failure instead of being ignored. Stored ok messages stay final, and the row keeps its id. Before, `INSERT OR IGNORE` kept the first `invalid_output` forever while each retry still spent a model call (preview-e2e on PR #95).
- fix(agents): prompts for answers without a `refs` field (moderators, HUD agents) no longer ask the model to back claims with refs; they ask it to name sources in plain words. The HUD moderator had written the evidence paths into its summary and failed the natural-language check (preview-e2e on PR #95).
- fix(fusion): a local record's freshness is judged from its candle's close (computed within 30 minutes of it), not from when the analysis runs. Retries and backfills after a Workers AI timeout no longer degrade the candle with `calculation_stale` (the 11:00 and 12:00 UTC candles of 2026-11-05). Ingest still rejects records that are old now.
- fix(bus): the fallback model (a reasoning model whose hidden trace shares `max_tokens`) gets twice the token budget, and an answer cut off by the limit is recorded as `finish_reason_length` instead of malformed output. Found by preview-e2e on PR #95: the primary timed out and the fallback's round-2 answer stopped mid-JSON at 3072 tokens.
- feat(hud): HUD agents on in production (`HUD_AGENTS_ENABLED`, owner approval 2026-11-05). Docs record owner decision "pilihan 1" (the 5m alerts may be deleted once `prophet_m5` and `gmi_m5` are approved) and the backlog (B4, Grid Bot Protocol).
- test(worker): `test/worker-scheduled.test.mjs` bundles `src/index.ts` with esbuild and runs the real `scheduled()` handlers. The parity sweep cron approves a candle's local records and the backfill runs its analysis; the news cron fails into a logged error.
- feat(live-room): Phase C6. Four HUD agents (Trade Management, Kinetic Engine, Fabio AMT, Aegis Footprint) speak in the live 15m room from the 15m HUD snapshot, behind `HUD_AGENTS_ENABLED`. `LIVE_ROOM_MAX_CALLS_PER_HOUR` goes from 36 to 48.
  - Preview only: the hourly model-call caps count rows in the preview D1 that every preview-e2e run shares, so several runs in one hour exhausted them (all bus messages `budget_exhausted`). Preview caps are now 150 (bus and live room) and 60 (HUD agents); production caps are unchanged.
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
