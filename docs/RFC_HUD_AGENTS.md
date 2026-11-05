# RFC: one agent per Pine HUD (Phase B)

> Design document only — no runtime change. Builds on `docs/HUD_AGENTS_ASSESSMENT.md` (Phase A) and `docs/BRIEF_HUD_AGENTS.md`. Canonical documents `docs/SSOT.md` and `AGENTS.md` win over anything here.

## 0. Scope and sources

- **Phase A inventory and decisions:** `docs/HUD_AGENTS_ASSESSMENT.md` (14 agents, 76 HUD rows).
- **Owner decisions applied:** Prophet name; one agent per Matrix & Omega titled section; 14 agents total; `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`; Prophet and GMI parity-approved 24/24 (2026-11-05 01:00 UTC); Mizan trusted through approved engines.
- **Live 15m decision (owner):** Option B with verified data — build a 15m HUD producer plus a 15m Pine candidate alert so **Trade Management**, **Kinetic Engine (TVA)**, **Fabio AMT Sensors** and optionally **Aegis Footprint Matrix** also speak in the live 15m room; values stay UNVERIFIED until the 15m identity is approved.
- **Pine sources (read-only):** `pinescript/ssot/The-Prophet-v7.02-R38.txt`, `pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt`. Any Pine change goes to `pinescript/candidates/` and is installed by the owner.
- **Patterns to follow:** `src/webhook-interpretation.mjs` (deterministic decoder), `src/multi-agent-bus.mjs`, `src/agent-threads.mjs`, `src/natural-language.mjs`.

---

## 1. HUD data contracts

### 1.1 General rules

- One versioned schema per HUD: `cryptophys.hud.<agent_id>.v1`.
- Values are **numbers, booleans and codes only** — never rendered strings (brief §4). Pine HUD text (`*_txt`) is never carried; the deterministic reading (§5) produces the human sentences.
- Every field carries a `source` tag: `webhook` (authoritative `tradingview_webhook` lane), `local_approved` (parity-approved local engine), or `local_unverified` (diagnostics / new computation without a comparator).
- Two timeframes:
  - **H1** — authoritative. All 14 HUD agents have H1 contracts.
  - **15m** — verified path (owner decision: Option B with verified data). A 15m Pine candidate alert (§2.3) carries the 15m HUD fields; per-timeframe 15m registry identities start at 0/24 under the unchanged 24/24 rule. Values stay labelled UNVERIFIED only until that identity is approved, never permanently.

### 1.2 Per-HUD field sets (H1)

| HUD (agent_id) | Fields (codes/numbers/booleans) | Current source |
|---|---|---|
| `r37_funnel` | `confirmed`, `high_quality` (per-bar booleans) | `prophet_r38` webhook (a); `candidate`, `price_pass`, `structure_pass`, `volume_pass` need local computation verified through the candidate comparator (c) |
| `prophet` | `cshi_score`, `regime_er`, `regime_vol`, `cycle_intensity`, `intensity_dir`, `d_enc`, `structure_subtype`, `t_enc`, `momentum_delta` | `prophet_r38` webhook for `d_enc`/`structure_subtype`/`t_enc` (a); rest local_unverified (b/c) |
| `trade_management` | `zone_state_code`, `cycle_intensity`, `kww_zscore`, `macro_bull`, `prophet_dir`, `gmi_dir`, `conflict`, `gate` | (a) for alignment; (b) for zone/cycle/macro. Action/entry/TP/exit levels are H1 decision reasoning output (§7), not HUD fields. |
| `interstellar_eyes` | `band` (code 1..9), `level_high`, `level_low`, `timeframe` (code) | (c) camarilla_extended, local_unverified |
| `kinetic_engine` | `theta`, `omega0/1/2`, `alpha`, `jerk_status_code`, `est_rev_bars`, `spacetime_warp`, `entropy`, `is_chaos`, `kin_phase_code` | (b) for θ/ω/α/entropy/phase; (c) for jerk/reversal/warp exposure |
| `fabio_amt` | `poc`, `val`, `vah`, `lvn_bull_1/2`, `lvn_bear_1/2`, `hvn_bull`, `hvn_bear`, `fp_status_code`, `mml_liq`, `bull_mass_pct`, `bear_mass_pct`, `fab_mod_code` | (b) for poc/val/vah/squeeze; (c) for the rest. Progressive SL is H1 decision reasoning output (§7). |
| `chronos_matrix` | `active_sessions_code`, `asian_high`, `asian_low`, `weekly_cpr_status_code`, `daily_cpr_*`, `cpr_width_code`, `verdict` | (a) for `verdict`; (c) for sessions/CPR |
| `aegis_footprint` | `buy_vol`, `sell_vol`, `bar_delta`, `delta_pct`, `osc_cvd`, `true_cvd`, `vol_surge`, `whale_count`, `pa_state_code`, `d_enc` | (a) for `d_enc`; (c) unverified for intrabar volume |
| `tactical_muscles` | `pct_rank`, `jma_proj_bars`, `vpt_status_code`, `tva_status_code` | (b) for `pct_rank`; (c) for the rest. SMC buy/sell zone is H1 decision reasoning output (§7). |
| `macro_aether` | `global_h`, `global_z`, `cg_net_pull`, `kww_width`, `kww_width_pct`, `macro_state_code`, `est_macro_bars`, `grav_state_code`, `grav_vec`, `g_scale`, `smri` | (b) for Hurst/consol gravity; (c) for the rest |
| `gabfx_price_action` | `qm_zone_code`, `rbs_sbr_status_code` | (b) `diagnostics.zones` |
| `playbook_execution` | `htf_state_code`, `mtf_state_code`, `ltf_state_code`, `ext_state_code` | (b) |
| `decision_matrix` | `burst_score`, `verdict`, `gate`, `conflict`, `branch_code`, `is_chaos` | (a) for verdict/gate/conflict; (b) for branch/is_chaos; (c) for burst_score |
| `grid_bot_protocol` | `cshi_viability_code`, `deploy_status_code` | (c). Grid range/trigger/quantity/TP-SL are H1 decision reasoning output (§7). |

### 1.3 15m contract (live-room subset only)

- Agents with 15m contracts: `trade_management`, `kinetic_engine`, `fabio_amt`, (optional) `aegis_footprint`.
- Fields are the **same schema names** as §1.2 (excluding the H1 decision-reasoning rows in §7), produced by the 15m producer (§4).
- **Verified path (owner decision):** a 15m Pine candidate alert (§2.3) carries these fields; per-timeframe 15m registry identities (`prophet_hud_m15`, `gmi_hud_m15`) start at 0/24 under the unchanged 24/24 rule. Values stay labelled UNVERIFIED **until** that identity is approved, then become `local_approved`.

---

## 2. Pine candidate (`pinescript/candidates/`)

### 2.1 Purpose

Provide the **parity comparator** for HUD fields that are not in `PARITY_FIELDS` today. The candidate is installed by the owner on TradingView; the repository only ships the candidate file. It does **not** carry the H1 decision-reasoning rows (action/entry/TP/exit, progressive SL, SMC zone, grid levels) — those are Reasoner output (§7).

### 2.2 H1 candidate

- File: `pinescript/candidates/The-Prophet-v7.02-R38.hud.v1.txt` (and a GMI companion for GMI HUDs), derived from the ssot sources without editing them.
- Alert payload (`alert()` JSON) carries, per closed H1 bar:
  - All `PARITY_FIELDS` already present (unchanged) — today's `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70` payloads are emitted unchanged.
  - HUD field codes/levels from §1.2 as **numbers, booleans and small integer codes** — never `*_txt` strings.
  - It does **not** carry `action_code`, `entry_price`, `invalidation_price`, `candidate_rr`/`ttl`/`conf`, `tp_price`, `tp_reached`, `exit_reason_code`, `sl_level`, `sl_state_code`, `smc_zone_*`, `smc_side_code` or `grid_*` (§7).

### 2.3 15m candidate (owner decision: verified data)

- A Pine candidate (`pinescript/candidates/`) whose alert also runs on the **15m chart**, carrying the 15m HUD fields for `trade_management`, `kinetic_engine`, `fabio_amt` (and `aegis_footprint` if included).
- Owner installs it for 15m as well as H1.
- Per-timeframe 15m registry identities start at 0/24 under the unchanged 24/24 rule; values stay UNVERIFIED until approved.

### 2.4 Owner install step

1. Owner copies the candidate into TradingView (Pine Editor → Save → Add to chart).
2. Owner creates/updates the H1 alert ("Any alert() function call") pointing at `https://ai.cryptophys.work/webhook`, secret unchanged (and the 15m alert on the 15m chart).
3. Register the new HUD fields for the **separate HUD identity** (§3); that identity then needs 24 consecutive matching candles to be approved. Approval follows registration, not the other way round.

---

## 3. Parity-registry changes (safety: separate identities)

- File: `src/parity-registry.mjs` (`PARITY_FIELDS`, `INPUT_FIELDS`, `identityOf`).
- **Rule unchanged:** 24 consecutive matching candles per engine identity before `approved_by_parity`; idempotent per candle; no manual allowlist.
- **Do not touch approved identities.** An identity is `engine + source_hash + implementation_hash`. Prophet and GMI are approved (31/31) and the whole H1 chain depends on them. Adding HUD computation to those engines, or HUD fields to their `PARITY_FIELDS`, would change their identity/comparison, restart them at 0/24 and force the H1 decision into fail-closed WAIT for ≥ 24 hours.
- **Separate HUD identities:** use `prophet_hud` and `gmi_hud` per timeframe (e.g. `prophet_hud_h1`, `prophet_hud_m15`, `gmi_hud_h1`, `gmi_hud_m15`). The approved `prophet`/`gmi` identities, their `PARITY_FIELDS` and today's `prophet_r38`/`prophet_r37_ssot`/`gmi_v12_70` payloads stay unchanged.
- **Separate webhook sources:** use `prophet_r38_hud` and `gmi_v12_70_hud` for HUD fields. Candidate payloads (§2.2) keep emitting today's sources unchanged.
- **Decision lane untouched:** the existing engines, their field sets and the H1 decision lane are not modified. HUD parity never affects the H1 decision.
- **15m identities** start at 0/24 under the unchanged 24/24 rule and never affect the H1 decision.

---

## 4. 15m local HUD producer

- New producer: `local-engines/producer/src/m15-hud-producer.mjs` (Phase C), invoked by the pull adapter on every closed 15m candle.
- Inputs: closed M15 bars. `market-data-ingestion` pulls M5 and M1 (`tradingview-source.mjs`); closed M15 bars are obtained by **aggregating closed M5 bars** (as the live room does for `m15`), or, if added, a dedicated M15 series. State which in the implementation PR.
- Computes HUD snapshots for `trade_management`, `kinetic_engine`, `fabio_amt`, (optional) `aegis_footprint` using the same computation as H1 but on M15 bars.
- Storage: KV `hud:m15:<agent_id>:latest` (TTL 900 s), plus the snapshot embedded in the live-room task payload.
- Tag: `source = local_unverified` until the 15m identity is approved, then `local_approved`; never written into the H1 chain, never changes the H1 decision.
- Cost: computation only, no model calls at produce time. Model calls happen in the live room (§6.2).

---

## 5. Deterministic HUD readings

- One decoder function per HUD in a new module `src/hud-reading.mjs`, following `src/webhook-interpretation.mjs`.
- Input: the HUD data contract (§1). Output: plain English sentences, one per row, with no `snake_case`, no dotted paths, no `key=value`.
- Agents receive the reading, never raw codes alone, so the model interprets meaning instead of echoing identifiers.
- Unit tests cover every code path (brief §5, Phase C step 2).

---

## 6. Agent contract and schedule

### 6.1 Threads 1H (every closed H1 bar)

- All **14 HUD agents** post in Threads 1H after the H1 synthesis is persisted, then a **moderator** summarises.
- Order (informational only; execution is parallel fan-out):
  1. R37 Funnel
  2. Prophet
  3. Trade Management
  4. The Interstellar Eyes
  5. Kinetic Engine (TVA)
  6. Fabio AMT Sensors
  7. Chronos Matrix
  8. Aegis Footprint Matrix
  9. Tactical Muscles
  10. Macro & Aether Sensors
  11. GABFX Price Action
  12. Playbook Execution
  13. Decision Matrix
  14. Grid Bot Protocol
  15. Moderator
- Each agent's evidence is strictly its own HUD reading (§5) plus the authoritative H1 decision. No HUD agent sees another HUD's fields.
- Agent ids are lowercase (`r37_funnel`, `prophet`, …); display names are the HUD names.

### 6.2 Live 15m room (owner-approved Option B)

- Runs only behind `LIVE_ROOM_ENABLED` and the new `HUD_AGENTS_ENABLED` flag.
- At every 15m close, the existing `technical` + `risk` + `moderator` still run, plus the subset:
  - `trade_management` (UNVERIFIED 15m HUD snapshot)
  - `kinetic_engine`
  - `fabio_amt`
  - (optional, owner toggle) `aegis_footprint`
- Each speaks only from its own 15m HUD reading plus the H1 decision/TradingView reading as backdrop. No HUD agent issues entry/SL/TP/size (those are `trade_plan` from §7).
- Primary model only (never the paid fallback), per live-room rule.
- These live-room HUD calls count against `LIVE_ROOM_MAX_CALLS_PER_HOUR` (proposed 48), not against `HUD_AGENTS_MAX_CALLS_PER_HOUR`.

### 6.3 Natural language and correction rule

- Output is strict JSON schema + natural language; validated by `src/natural-language.mjs`.
- One correction call per failing answer, capped at **3 correction calls per run** (§8), counted against `HUD_AGENTS_MAX_CALLS_PER_HOUR`. A second failure stays `invalid_output`.

---

## 7. H1 decision reasoning output (`trade_plan`)

- The Reasoner already owns entry, SL, TP and R:R. The rows that cannot be recomputed locally — Trade Management action/entry/TP/exit, Fabio Progressive SL, the Tactical Muscles SMC buy/sell zone and the Grid Bot levels — become **output of the H1 decision reasoning**, not HUD fields or Pine payload.
- Extend the Reasoner output schema with a `trade_plan` object:
  - `action` (code), `entry`, `invalidation`, `take_profit`, `exit_reason` (code), `progressive_stop`, `zone` (low/high/side code), and, if kept, `grid` (bot/top/trigger/qty/tp/sl).
- Rules:
  - produced only from verified evidence;
  - `null` on WAIT or NO_TRADE;
  - validated in `parseDecision` like the existing price fields;
  - advisory only (no broker execution).
- How HUD agents refer to it: Trade Management, Fabio AMT, Tactical Muscles and Grid Bot agents may quote these levels attributed to the decision ("the H1 decision sets …"). They never produce these levels themselves.
- The following HUD rows remain **already part of the H1 decision's evidence** and are described, not changed, by HUD agents:
  - Prophet `STRUCTURE` (`d_enc`, `structure_subtype`) and `MOMENTUM` (`t_enc`).
  - Trade Management `Prophet–GMI` (`prophet_dir`, `gmi_dir`, `conflict`, `gate`).
  - Decision Matrix `ACTION VERDICT`/`EXECUTE` (`verdict`, `gate`, `conflict`).
  - Aegis `PA STRUCTURE` (`d_enc`).
- All other HUD rows are descriptive context only and must never be presented as a decision input, level, or instruction.

---

## 8. Budgets

- New variable: `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30` (own cap; never shared with `MULTI_AGENT_MAX_CALLS_PER_HOUR = 20` or `LIVE_ROOM_MAX_CALLS_PER_HOUR = 36`).
- Per H1 run: 14 (agents) + 1 (moderator) = 15 base; 14 + 3 (capped corrections) + 1 = 18 worst case.
- 30 calls/hour covers one worst-case run plus redelivery/backfill headroom. Fails closed when exhausted.
- Live-room subset adds at most 4 extra calls per 15m close (16/hour) on primary model only. These count against `LIVE_ROOM_MAX_CALLS_PER_HOUR`, which must be raised from 36 to 48 to keep headroom above the existing 12 calls/hour. They do **not** count against `HUD_AGENTS_MAX_CALLS_PER_HOUR`.

---

## 9. Flags, fail-closed rules and preview-e2e proof

- Feature flag: `HUD_AGENTS_ENABLED` — `"false"` in `wrangler.jsonc` (production), `"true"` in `wrangler.preview.jsonc`.
- All runtime code lives in the existing AI Worker (`src/`); no new Worker, no topology change (SSOT §1).
- Fail-closed: missing budget, missing HUD snapshot, or a schema validation failure skips that agent and records `invalid_output`; the run continues with the remaining agents. The H1 decision is never blocked or changed.
- Idempotency: stored messages keyed by `(candle_key, agent_id)`; redelivery reuses stored valid messages without re-spending the budget.
- Preview-e2e proof required before any production enablement PR: every HUD agent answers on the primary model in natural language (unit tests with a fake `env.AI` + preview-e2e), and `npm test` + `tsc --noEmit` + dry-run deploy pass.

---

## 10. Open questions for the owner

Answered by the owner on 2026-11-05 (see "Phase C plan and owner decisions" in `docs/BRIEF_HUD_AGENTS.md`):

1. `aegis_footprint` **is included** in the live 15m room (4 HUD agents).
2. The Pine candidate ships **first, in its own PR (C1)**, together with the webhook ingestion of the `*_hud` sources, so the 24-candle parity clock can start as early as possible.

---

## Appendix — 14 HUD agents (unchanged from Phase A)

See `docs/HUD_AGENTS_ASSESSMENT.md` Appendix B.
