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

## 5. Phase C: implementation (small PRs, each green)

1. The HUD data contract and the computation of the HUD fields that are reproducible today. This lives in the local engines or producers, with parity where a TradingView comparator exists, and the data is informational otherwise.
2. The deterministic HUD readings, with tests covering every code path.
3. The HUD agents behind `HUD_AGENTS_ENABLED`: off in production, on in preview. They need unit tests with a fake `env.AI` and a preview-e2e proof that every HUD agent answers on the primary model in natural language.
4. Nexus: show HUD agents by their HUD name in Threads 1H (and in the live room if they are scheduled there). Never show model names.

## 6. Phase D: production

Production is enabled only after the owner approves, by a PR that sets the flag in `wrangler.jsonc`.

## 7. How to report

Report in Indonesian to the owner. For each step, give:

- what you did, the PR link and the CI result;
- what is blocked, and on what;
- the next step.

Do not claim a deploy or a verification that you did not observe.
