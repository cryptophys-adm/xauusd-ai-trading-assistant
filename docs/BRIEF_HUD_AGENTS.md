# Brief: one agent per Pine HUD (for the VPS agent "agy")

Owner request (2026-11-04): turn every HUD in the installed Pine indicators into its own agent. Each agent:

- is named after its HUD, and that name is what the dashboard shows;
- analyses only the data that its own HUD produces.

This brief tells you what to study, what to deliver and which rules hold. It does not change the canonical documents: `docs/SSOT.md` and `AGENTS.md` win over anything here.

## 0. Rules (from `AGENTS.md`, non-negotiable)

1. **Deploys.**
   - Deploy only by merging a PR into `main`.
   - Never run `wrangler deploy`, `wrangler delete` or `wrangler secret put` against production, by hand or from the VPS.
   - Do not create any Worker beyond the four in `docs/SSOT.md`.
   - Never recreate the removed engine Workers.
2. **Branches.** Start every branch from the latest `main`.
3. **Pine sources.**
   - Do not edit `pinescript/ssot/*`.
   - Local engine trust comes only from the autonomous parity registry. Never mark anything verified or production-ready by hand.
   - A Pine change, for example a richer alert payload, goes into `pinescript/candidates/`, and the owner installs it on TradingView.
4. **Inter-Worker calls** use RPC Service Bindings, never shared secrets.
5. **Advisory only.** No broker integration and no automatic execution.
   - HUD agents never issue their own entry, stop loss, take profit or position size.
   - They may report a level that the HUD itself shows, clearly attributed to the HUD ("the Fabio AMT HUD shows a progressive stop near …"). They never present it as an instruction.
6. **Natural language.** Agent text must pass `src/natural-language.mjs`: no field names, no `snake_case`, no key paths. The dashboard shows agent names only, never model names.
7. **Before every PR**, run:
   - `npm test`;
   - `npx tsc --noEmit -p .`;
   - a dry-run of each affected Worker.

   The PR must be green, including preview-e2e. Claude reviews and merges, and you do not merge your own PR.
8. **Feature flags.** Anything that calls a model ships behind a flag that is off in `wrangler.jsonc` (production) and on in `wrangler.preview.jsonc`. It needs a preview-e2e proof, and production is enabled only with the owner's approval.

## 1. Study first

Read these files in order:

1. `docs/SSOT.md`
2. `AGENTS.md`
3. `docs/LOCAL_COMPUTATION_OWNERSHIP.md`: what the local engines compute today, and what they leave out (HUD and rendering are mostly not computed).
4. `docs/EVIDENCE_CONTRACTS.md`: the three input lanes and the parity rules.
5. `src/webhook-interpretation.mjs`: the pattern to follow. It is a deterministic, code-to-sentence decoder of Pine outputs with tests.
6. `src/multi-agent-bus.mjs` and `src/agent-threads.mjs`: how agents, budgets, validation, the correction call, the Threads 1H view and the live 15m room work.
7. The Pine sources in `pinescript/ssot/`, especially the HUD tables listed below.
8. `local-engines/` (Prophet R38 core, GMI, the producers) and `market-data-ingestion/`: where the OHLCV comes from and what is already computed.

## 2. HUD inventory (verify against the source; line numbers are from `main` on 2026-11-04)

**The Prophet v7.02 R38** (`pinescript/ssot/The-Prophet-v7.02-R38.txt`):

| HUD (agent name) | Table | Rows |
|---|---|---|
| **R37 Funnel** | `funnel_table` (line 505) | Candidates, Price, Structure, Volume, Confirmed, High Quality (funnel counts) |
| **Prophet** (the top-right table has no title; owner decision 2026-11-05) | `hud` (line 1074) | Market, Harmonic, Structure, Momentum |
| **Trade Management** | `trade_management_hud` (line 1075) | Zone, cycle, macro, Prophet–GMI alignment, action, entry candidate, TP, exit |

**Global Multiverse Interceptor v12.70** (`pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt`):

| HUD (agent name) | Table | Rows |
|---|---|---|
| **The Interstellar Eyes** | `hud_main`, column 0 (line 221) | Price bands from +MAX > H6 down to −MAX < L6 |
| **Kinetic Engine (TVA)** | `hud_main`, column 7 | Channel angle, velocity, momentum force, anomaly jerk, estimated time to reversal, spacetime warp, market entropy, kinetic phase |
| **Fabio AMT Sensors** | `hud_main`, column 9 | POC, value area, LVN 1 and 2, HVN, squeeze state, liquidity (MML), active SMR, model status, progressive SL |
| **Chronos Matrix** | `hud_aegis`, top (line 223) | Active sessions, Asian range, weekly CPR, daily CPR and S/R, CPR width × GMI |
| **Aegis Footprint Matrix** | `hud_aegis`, lower block | Buy/sell volume, bar delta, CVD, volume surge, PA structure, whale activity |

**Matrix & Omega Sensors** (`hud_tdm`, line 224) is one table with six titled sections. Owner decision, 2026-11-05: **one agent per titled section**. Each section agent sees only its own section's rows.

| HUD section (agent name) | Rows |
|---|---|
| **Tactical Muscles** | JMA PPO ranking, VPT volume trend, TVA regression |
| **Macro & Aether Sensors** | MTF Hurst (trend), MTF Z-score (KWW), consolidation gravity, Z3 kinetic spread, macro cycle, estimated macro shift, asset gravity, Q-gravity pull, macro SMR (SMRI) |
| **GABFX Price Action** | Quasimodo (QM) zone, RBS / SBR retest |
| **Playbook Execution** | Phase 1 HTF (macro), Phase 2 MTF (Prophet), Phase 3 LTF (Aegis/Kinetic), Phase 4 exit (KTS/TP) |
| **Decision Matrix** | Scalp burst index, action verdict, execute, system guard |
| **Grid Bot Protocol** | CSHI viability, deploy status, grid range, trigger price, grid quantity, take profit / stop loss |

The Grid Bot Protocol and Decision Matrix agents describe what their section shows, attributed to the HUD. They never turn it into an order, a size or an instruction (rule 5).

**Total: 14 agents.**
- Prophet R38: R37 Funnel, Prophet, Trade Management.
- GMI v12.70 (5): The Interstellar Eyes, Kinetic Engine (TVA), Fabio AMT Sensors, Chronos Matrix, Aegis Footprint Matrix.
- Matrix & Omega Sensors (6): the six sections above.

## 3. Phase A: assessment (documents only, no runtime change)

Deliver `docs/HUD_AGENTS_ASSESSMENT.md` in a PR. It must contain:

1. **A matrix with one row per HUD row.** For each row, give:
   - the Pine variable(s) that produce it (file:line);
   - whether a webhook field carries it today, and which one;
   - whether a local engine computes it today, and in which file;
   - the parity status.
2. **A data-source decision for every HUD row.** Pick one of:
   - (a) an existing webhook field;
   - (b) a local engine output, which is trusted only when parity-approved and is otherwise labelled unverified;
   - (c) new local computation, needing an implementation plus a parity comparator;
   - (d) a richer alert payload from a Pine candidate in `pinescript/candidates/`, which the owner must install.

   Prefer (a) and (b). Say plainly which HUD rows cannot be reproduced locally.
3. **Cost.** Estimate the model calls per H1 candle and per hour for the 14 agents plus a moderator, and propose a budget variable, for example `HUD_AGENTS_MAX_CALLS_PER_HOUR`. The current budgets are:
   - the bus: 20 an hour, about 5 calls per H1 candle;
   - the live room: 36 an hour, 12 used at 4 rooms × 3 calls.
4. **Schedule.** Say which HUD agents speak per H1 candle (in Threads 1H). Also say whether any of them, for example Trade Management, Kinetic Engine or Aegis Footprint, should also speak in the live 15m room.
5. **Risks and open questions for the owner.**

## Owner decisions on the Phase A open questions (2026-11-05)

These answer §5.2 of `docs/HUD_AGENTS_ASSESSMENT.md`, and Phase B must follow them.

1. **Live 15m room: Option B, with verified data.** Build a 15m local HUD producer, so that Trade Management, Kinetic Engine (TVA) and Fabio AMT Sensors (and optionally Aegis Footprint Matrix) also speak in the live 15m room. Their HUD data must become **verified**, not stay informational.
   - **What "verified" means here.** It uses the same autonomous parity registry as H1: 24 consecutive field-by-field matches against TradingView. That needs a TradingView comparator for every HUD field and for each timeframe.
   - **The comparator.** Today's alerts carry only the `PARITY_FIELDS`, and `pinescript/ssot/*` must not be edited. The comparator is therefore a Pine candidate in `pinescript/candidates/` whose alert payload adds the HUD fields as numbers, booleans and codes. The owner installs it on TradingView for H1 and for 15m.
   - **The registry.** It needs per-timeframe identities (H1 and 15m) and HUD field sets.
   - **Until approval.** Until a HUD field set reaches 24/24, its values stay labelled UNVERIFIED, and they never become trusted by hand.
2. **Rows that cannot be recomputed locally become output of the decision reasoning.** These rows are Trade Management action/entry/TP/exit, Progressive SL, the SMC buy/sell zone and the Grid Bot levels.
   - They are neither reproduced by HUD agents nor carried by a Pine candidate.
   - The authoritative H1 decision chain (Reasoner), which already owns entry, stop loss, take profit and risk/reward, produces them from the verified evidence.
   - HUD agents report only their reproducible rows. For these rows they may refer to the decision's levels, attributed to the decision.
3. **R37 Funnel:** the agent reads the funnel stages for the current candle (candidate, price, structure, volume, confirmed, high quality: pass or fail on that bar), not the cumulative counters.
4. **Budget:** `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`, separate from the bus and live-room budgets.

## 4. Phase B: design (an RFC, still no runtime change)

Write `docs/RFC_HUD_AGENTS.md`, covering:

- **The HUD data contract.** Define a versioned schema per HUD, for example `cryptophys.hud.<name>.v1`. Values are plain numbers, booleans and codes, never rendered strings.
- **A deterministic HUD reading.** Following `src/webhook-interpretation.mjs`, write one function per HUD that turns its data into plain sentences. Agents interpret that reading, so the model never sees raw codes without their meaning.
- **The agent contract.**
  - Agent ids are lowercase.
  - Display names are the HUD names.
  - Each agent's evidence is limited to its own HUD plus the authoritative H1 decision.
  - Output is the strict JSON schema plus natural language, with the existing validators and the one-correction rule.
- **Placement.**
  - HUD agents post as replies in Threads 1H, with the moderator summarising them.
  - Optionally, a subset speaks in the live 15m room.
- **Flags, budgets, fail-closed behaviour, idempotency per (candle, run) and the preview-e2e proof.**

## Phase C plan and owner decisions (2026-11-05)

- **Aegis Footprint Matrix joins the live 15m room**, so four HUD agents speak there: Trade Management, Kinetic Engine (TVA), Fabio AMT Sensors and Aegis Footprint Matrix.
- **HUD data must be verified**, using the Pine candidate alert as the TradingView comparator.
  - The local lane computes the HUD values. Its inputs are raw TradingView OHLCV, but the indicator logic is our own port.
  - The comparator proves that the port matches TradingView's own output: 24/24 consecutive matches per timeframe.
- **The Pine candidate ships first**, in its own PR, because the 24-candle clock starts only once the owner installs the alerts.

Phase C order (one small PR each, reviewed by Claude, CI green):

0. **C0: verified 5m lane** (owner decision 2026-11-05, done before C1). The 5m execution data strongly influences the agents, so it must be parity-verified like H1.
   - **Step 1 (done by Claude).** `POST /webhook` starts the AI chain only for `ANALYSIS_TIMEFRAMES`: `"60"` in production, and `"60,5"` in preview for the M5 fixture. Webhooks on any other timeframe are stored for parity only (`analysis_status: "stored_only"`).
   - **Step 2 (done by Claude): timeframe-aware parity identities.** Registry engine ids are scoped by the record's timeframe (`scopedEngine` in `src/parity-registry.mjs`): H1 keeps the bare id (`prophet`, `gmi`, `mizan`), 5m uses `prophet_m5`, `gmi_m5`, `mizan_m5`, and 15m uses `*_m15`. They never share a streak with the approved H1 identities, and existing H1 rows keep their approval. Mizan is trusted per timeframe. The parity sweep also revisits the last six closed 5m candles, and reconcile tasks start the AI chain only on `ANALYSIS_TIMEFRAMES`.
   - **Step 3 (done by Claude): full 5m local producer.** `m5-local-producer.mjs` computes the complete `PARITY_FIELDS` for `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70` on every closed 5m bar. The pull adapter publishes them with timeframe 5 (`M5_PARITY_PUBLISH`), and they are compared against stored 5m webhooks. GMI uses `gmi-core-tf.mjs`, and the approved H1 files and hashes are unchanged.
   - **Step 4 (done by Claude for the live room): the 5m context becomes verified.** While the `*_m5` identities are approved, `informational_5m_context` and the live room label the 5m data verified. Otherwise it stays labelled UNVERIFIED, and the label switches automatically.
   - **B2 (done by Claude): one 5m read.** The 5m context is the bar's 5m parity record, reshaped (`m5-context.mjs`); the separate `buildM5ProphetContext` read is retired. The H1 chain, the bus and the live room all follow the same VERIFIED/UNVERIFIED label.
   - **Step 5: the owner installs the existing alerts on the 5m chart (done 2026-11-05).** No Pine change is needed, because the payloads already carry the timeframe. 24 consecutive matching 5m candles take about 2 hours.
   - **After approval (owner decision "pilihan 1", 2026-11-05):** once both `prophet_m5` and `gmi_m5` are approved, the owner may delete the two 5m alerts. The approval persists while the 5m source and implementation hashes are unchanged. A 5m engine change needs the 5m alerts again for a calibration run, like the monthly H1 calibration.
1. **C1: candidate and ingestion only.**
   - Add Pine candidates in `pinescript/candidates/` for Prophet R38 and GMI v12.70. They keep today's payloads byte-for-byte and add separate `prophet_r38_hud` and `gmi_v12_70_hud` alerts carrying the §1.2 HUD fields (numbers, booleans, codes) on H1 and 15m.
   - `POST /webhook` accepts and stores these `*_hud` sources for timeframes 60 and 15.
   - They are **not** in `REQUIRED_SOURCES`, not in the evidence fusion and not in the H1 decision lane.
   - Ship install instructions for the owner.
2. **C2: local HUD snapshots (done by Claude, replaces pi's scaffolds).**
   - `local-engines/producer/src/hud-snapshot.mjs` builds one snapshot per closed H1 and 15m bar from the same local engines: Prophet R38 core, the R37 core, and GMI via `gmi-core-tf.mjs`. Camarilla and CPR use the Mizan formulas.
   - It covers 13 of the 14 HUDs. Grid Bot Protocol is declared `not_computed`, not invented.
   - The pull adapter publishes the snapshots through the RPC `submitHud` (`HUD_SNAPSHOT_PUBLISH`). The AI Worker stores them under `hud:<tf>:<candle_key>` and `hud:<tf>:latest`, and serves them at `GET /api/hud/latest?tf=60|15` and `GET /api/hud/<candle_key>`.
   - **Verification per field, local-primary.** A HUD field that is a TradingView alert field (d_enc, subtype, t_enc, confirmations, verdict, gate, directions, conflict) is marked verified only when it equals the parity-approved local record of the same candle. Every other field is an engine internal that is shown as not yet calibrated.
   - Calibrating the internals needs a Pine candidate comparator in a later calibration run. pi's candidates only add `cshi_score` and `cycle_intensity`.
   - The approved `prophet`/`gmi` identities and their hashed files are untouched.
3. **C3: `src/hud-reading.mjs` (done by Claude).** Deterministic plain-language readings for the 13 HUDs, one line per row, each line carrying `verified`. Every enum token is decoded, and the tests validate every reading with the natural-language validator.
4. **C4: `trade_plan`** in the Reasoner output (RFC §7), validated in `parseDecision`, null on WAIT.
5. **C5: HUD agents in Threads 1H (done by Claude)**, behind `HUD_AGENTS_ENABLED`: on in preview, and on in production since the owner's approval of 2026-11-05.
   - After every H1 synthesis, a `hud_agents` queue task runs one agent per computed HUD (13 today), named after the HUD, then a moderator.
   - Each agent sees only its own reading, with every statement marked "verified by parity" or "not yet calibrated", plus the authoritative H1 decision. Stances are BUY, SELL or WAIT. Agents never give levels or size.
   - The agents run on the primary model only, and messages are idempotent per candle and HUD.
   - The budget is capped by `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`.
   - Missing snapshots and syntheses are retried, never invented.
   - The preview-e2e proves them on an H1 candle (#94), and the owner approved production on 2026-11-05.
6. **C6: the four HUD agents in the live 15m room (done by Claude).** Trade Management, Kinetic Engine (TVA), Fabio AMT Sensors and Aegis Footprint Matrix post after technical and risk, and before the moderator.
   - They speak from the 15m HUD snapshot of the bar that just closed, behind `HUD_AGENTS_ENABLED`. All their statements read as not yet calibrated, because no 15m comparator exists.
   - Stances are BUY, SELL, HOLD, WAIT or CLOSE, on the primary model only, and they count against `LIVE_ROOM_MAX_CALLS_PER_HOUR`, now 48.
   - Nexus shows them by HUD name.
7. **C7: Nexus (done by Claude).** The H1 thread lists the HUD agents by HUD name, with a badge "N of M verified by parity" per agent, and the moderator last. Model names are never shown.

## 5. Phase C: implementation (small PRs, each green)

1. The HUD data contract and the computation of the HUD fields that are reproducible today. This lives in the local engines or producers, with parity where a TradingView comparator exists, and the data is informational otherwise.
2. The deterministic HUD readings, with tests covering every code path.
3. The HUD agents behind `HUD_AGENTS_ENABLED`: off in production, on in preview. They need unit tests with a fake `env.AI` and a preview-e2e proof that every HUD agent answers on the primary model in natural language.
4. Nexus: show HUD agents by their HUD name in Threads 1H (and in the live room if they are scheduled there). Never show model names.

## 6. Phase D: production

Production is enabled only after the owner approves, by a PR that sets the flag in `wrangler.jsonc`. Done: the owner approved on 2026-11-05, and `HUD_AGENTS_ENABLED` is `"true"` in `wrangler.jsonc`.

### Backlog (owner, 2026-11-05)

- **B4: remove the GMI core duplication.** `gmi-core-tf.mjs` repeats the approved H1 GMI core. Merging them changes the GMI implementation hash, so the H1 `gmi` identity needs a new 24-candle approval. Schedule it in a calibration window, with the H1 GMI alert active.
- **Grid Bot Protocol HUD.** The only HUD that is not computed (`not_computed`). It can be ported from the Pine source, but its statements stay "not yet calibrated" until a Pine candidate comparator exists.

## 7. How to report

Report in Indonesian to the owner. For each step, give:

- what you did, the PR link and the CI result;
- what is blocked, and on what;
- the next step.

Do not claim a deploy or a verification that you did not observe.
