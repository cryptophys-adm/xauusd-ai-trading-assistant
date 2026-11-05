# HUD Agents Assessment (Phase A)

> Owner request 2026-11-04, updated with owner decisions 2026-11-05 (brief `docs/BRIEF_HUD_AGENTS.md`). Documents only — no runtime change.
> Canonical documents `docs/SSOT.md` and `AGENTS.md` win over anything here.

## 0. Scope, method and sources

This assessment walks every HUD table and row of the two installed Pine indicators and decides, for each row, where its data comes from today and where it should come from for the **14 per-HUD agents** defined in `docs/BRIEF_HUD_AGENTS.md` §2.

Sources inspected (line numbers as in `main` on 2026-11-05):

- `pinescript/ssot/The-Prophet-v7.02-R38.txt` — `funnel_table` (line 505, agent **R37 Funnel**), `hud` (line 1074, agent **Prophet**), `trade_management_hud` (line 1075, agent **Trade Management**).
- `pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt` — `hud_main` (line 221): column 0 **The Interstellar Eyes**, column 7 **Kinetic Engine (TVA)**, column 9 **Fabio AMT Sensors**; `hud_aegis` (line 223): top **Chronos Matrix**, lower block **Aegis Footprint Matrix**; `hud_tdm` (line 224, Matrix & Omega Sensors): one agent per titled section (**Tactical Muscles**, **Macro & Aether Sensors**, **GABFX Price Action**, **Playbook Execution**, **Decision Matrix**, **Grid Bot Protocol**).
- `src/parity-registry.mjs` (`PARITY_FIELDS`, `INPUT_FIELDS`) — the only trust gate for local computations.
- `docs/LOCAL_COMPUTATION_OWNERSHIP.md`, `docs/LOCAL_GMI_ENGINE.md` — honest coverage.
- `local-engines/producer/src/h1-producer.mjs`, `local-engines/gmi/src/gmi-core.mjs`, `local-engines/gmi/src/mizan.mjs`, `local-engines/prophet-r38/src/core.mjs`.
- `src/webhook-interpretation.mjs` — the deterministic reading pattern to follow.
- `src/multi-agent-bus.mjs`, `src/agent-threads.mjs` — budgets, validators, correction rule.

Parity status legend used throughout:

- **TradingView output; local engine: parity-approved** — the field is carried in the trusted `tradingview_webhook` lane (TradingView's own output) and is listed in `PARITY_FIELDS` (`src/parity-registry.mjs`), so it is compared field by field with the local engine on every closed H1 bar.
  - The `prophet` and `gmi` engines have been **parity-approved since 2026-11-05 01:00 UTC**: 24/24 consecutive matches, and 31/31 by 08:00 UTC.
  - MizanLib has no webhook of its own and is trusted through the approved engines' declared Mizan dependency.
  - Approval covers only the `PARITY_FIELDS`, never the engines' `diagnostics`.
- **Computed (unverified)** — ported from Pine and run locally, appears in `diagnostics` or engine internals, not compared in `PARITY_FIELDS`.
- **Not ported** — not computed locally today.

Data-source decision legend (brief §3.2):

- **(a)** existing webhook field (authoritative `tradingview_webhook` lane);
- **(b)** existing local engine output. Only the engine's `PARITY_FIELDS` are trusted, and only while it is parity-approved (`approved_by_parity`). Every other output (`diagnostics`, internals) stays labelled UNVERIFIED even for an approved engine.
- **(c)** new local computation + parity comparator;
- **(d)** richer alert payload from a Pine candidate in `pinescript/candidates/`, carrying numeric levels, booleans and codes (never rendered strings), which the owner must install.

Preference order: (a) > (b) > (c) > (d).

---

## 1. HUD Row-by-Row Inventory & Coverage Matrix

### 1.1 R37 Funnel — `funnel_table` (Prophet R38, line 505)

Table is 2 columns × 7 rows (1 header row + 6 counter rows), rendered only when `show_funnel` is on. Counters are cumulative `var int` diagnostic tallies across chart history, not per-bar signals.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `R37 FUNNEL` (row 0 header) | table title only (line 507) | None | None | Not applicable (rendering) | (b) informational label |
| 2 | `Candidates` (row 1) | `funnel_candidates` incremented on `buy_candidate or sell_candidate` (lines 483–484, 509) | None | None | Not ported | (c) new local computation |
| 3 | `Price` (row 2) | `funnel_price` incremented on `buy/sell_window_active and bullish/bearish_price_confirm` (lines 489–492, 510) | None | None | Not ported | (c) |
| 4 | `Structure` (row 3) | `funnel_structure` on price+structure confirm (lines 493–496, 511) | None | None | Not ported | (c) |
| 5 | `Volume` (row 4) | `funnel_volume` on price+structure+volume pass (lines 497–500, 512) | None | None | Not ported | (c) |
| 6 | `Confirmed` (row 5) | `funnel_confirmed` on `buy_confirmed or sell_confirmed` (lines 501–502, 513) | Per-bar `buy_confirmed` / `sell_confirmed` (`prophet_r38`); cumulative count is not in webhook | Per-bar `confirmation.buy_confirmed` / `sell_confirmed` in `local-engines/prophet-r38/src/core.mjs` (line 522) | TradingView output; local engine: parity-approved (per-bar flags) | (a) per-bar confirmation via webhook |
| 7 | `High Quality` (row 6) | `funnel_hq` on `buy_high_quality or sell_high_quality` (lines 503–504, 514) | Per-bar `buy_high_quality` / `sell_high_quality` (`prophet_r38`); cumulative count is not in webhook | Per-bar `confirmation.buy_high_quality` / `sell_high_quality` (line 523) | TradingView output; local engine: parity-approved (per-bar flags) | (a) per-bar HQ confirmation via webhook |

Note: the funnel counters themselves are cumulative `var int` state that depends on the chart start bar and reset semantics (`buy_candidate` resets per-setup flags). Cumulative tallies cannot be reproduced deterministically from a fixed OHLCV window; see §2.2.

### 1.2 Prophet — `hud` (Prophet R38, line 1074, untitled top-right table)

4 metric rows, 2 columns. Owner decision (2026-11-05): agent display name is **Prophet**.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `MARKET` (row 0) | `hud_market_txt = cshi_txt + " · " + regime_detail` where `cshi_txt` from `cshi_score` (lines 162–171, 599) and `regime_detail` = ER + Vol (line 598) | None | `sensors` (KWW z-score, Hurst, efficiency ratio, volume ratio) in `core.mjs` (lines 564, 609); `cshi_score` composite not exposed | Computed (unverified, partial) | (b) unverified local reading |
| 2 | `HARMONIC` (row 1) | `hud_harmonic_txt = intensity_txt + " · " + int_dir_txt` from `inten` (lines 176, 237–239, 600) | None | `sensors.cycle_intensity` in `core.mjs` (line 608) | Computed (unverified) | (b) |
| 3 | `STRUCTURE` (row 2) | `hud_structure_txt = div_txt + " · " + vol_conf_txt` from `d_enc`, `t_enc`, `prophet_structure_subtype` (lines 241–262, 601) | `d_enc`, `structure_subtype` (`prophet_r38`) | `structure.d_enc`, `structure.subtype_code` in `core.mjs` (lines 595, 609) | TradingView output; local engine: parity-approved (`d_enc`, `structure_subtype`); volume-confirmation suffix is unverified | (a) for `d_enc`/`structure_subtype`, (b) for volume suffix |
| 4 | `MOMENTUM` (row 3) | `hud_momentum_txt = hud_momentum_strength_txt + " — " + legacy_tm_context_txt + momentum_trend_context_txt` (lines 603–615) | `t_enc` (`prophet_r38`); momentum delta `pro_fast - pro_fast[1]` is not in webhook | `oscillator.fast`/`slow` in `core.mjs` (line 609); `pro_fast - pro_fast[1]` not exposed | TradingView output; local engine: parity-approved (`t_enc`); momentum delta is Computed (unverified) | (a) for `t_enc`, (b) for oscillator momentum reading |

### 1.3 Trade Management — `trade_management_hud` (Prophet R38, line 1075)

9 columns × 1 row (1 header cell + 8 data cells).

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `TRADE MANAGEMENT` (col 0 header) | header / tooltip = `decision_tooltip` (lines 1072, 1087) | None | None | Not ported (rendering) | (b) informational label |
| 2 | Zone (col 1) | `zone_full_txt` / `zone_state_txt` (lines 619–652, 794, 1088) | `t_enc`, `d_enc` (`prophet_r38`) indirectly; OB zone proximity not in webhook | `structure.d_enc`, `confirmation.*` in `core.mjs` | Computed (unverified) | (b) |
| 3 | Cycle (col 2) | `cycle_full_txt` from `inten` (lines 784, 788, 1089) | None | `sensors.cycle_intensity` in `core.mjs` (line 608) | Computed (unverified) | (b) |
| 4 | Macro (col 3) | `macro_full_txt` from `is_macro_bull/bear` = `z_score >/< 0` (lines 158–159, 785, 789, 1090) | None | `sensors.kww_zscore` in `core.mjs` (line 609) | Computed (unverified) | (b) |
| 5 | Prophet–GMI (col 4) | `pg_full_txt` from `gmi_z_alignment_code` (lines 152–154, 786, 790, 1091) | `prophet_dir`, `gmi_dir`, `conflict`, `gate` (`gmi_v12_70`) | `htf_alignment` in `core.mjs` (line 601) | TradingView output; local engine: parity-approved (via `gmi_v12_70` alignment fields); local `htf_alignment` is Computed (unverified) | (a) via GMI webhook alignment + (b) local unverified |
| 6 | Action (col 5) | `action_full_txt` = `decision_conclusion` (lines 724–793, 1092) | None | None (OB lifecycle, ranking, trade readiness not ported) | Not ported | (c) or (d) |
| 7 | Entry candidate (col 6) | `entry_candidate_txt` (lines 1033–1035, 1093) — BUY/SELL LIMIT level, invalidation level, R:R, TTL, confidence | None | OB zones partially in `core.mjs` (`order_blocks`, line 602), but entry-level latching/TP-hit lifecycle not ported | Not ported | (c) or (d) |
| 8 | TP (col 7) | `tp_txt` (lines 1063–1064, 1094) — target key level | None | OB target scoring not ported | Not ported | (c) or (d) |
| 9 | Exit (col 8) | `exit_txt` (lines 1066–1069, 1095) — position-management state | None | Position-management states beyond `t_enc` not ported | Not ported | (c) or (d) |

### 1.4 The Interstellar Eyes — `hud_main` column 0 (GMI v12.70, line 221)

Price-band table: 1 header row (`row 0`) + **9 price-band rows (`rows 1..9`)** across 6 timeframes (`5m`, `15m`, `1H`, `4H`, `1D`, `1W`, populated via `f_fill_miraj_col` at lines 1775–1805 and 2098–2115).

| # | HUD row label (cell col 0) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `+MAX > H6` (row 1) | `c_h6_*` from `lib.camarilla_extended(high, low, close)` (lines 419–424, 1779, 2099) | None | `camarilla_extended` is listed under MizanLib in `LOCAL_COMPUTATION_OWNERSHIP.md`, not wired into `gmi-core.mjs` | Not ported (in GMI) | (c) new local computation |
| 2 | `H6 - H5` (row 2) | `c_h6_*`, `c_h5_*` (lines 419–424, 1782, 2100) | None | same | Not ported | (c) |
| 3 | `H5 - H4` (row 3) | `c_h5_*`, `c_h4_*` (lines 419–424, 1785, 2101) | None | same | Not ported | (c) |
| 4 | `H4 - H3` (row 4) | `c_h4_*`, `c_h3_*` (lines 419–424, 1788, 2102) | None | same | Not ported | (c) |
| 5 | `H3 - L3` (row 5) | `c_h3_*`, `c_l3_*`, `mid_p = (c_h3 + c_l3) / 2` (lines 1790–1792, 2103) | None | same | Not ported | (c) |
| 6 | `L3 - L4` (row 6) | `c_l3_*`, `c_l4_*` (lines 419–424, 1795, 2104) | None | same | Not ported | (c) |
| 7 | `L4 - L5` (row 7) | `c_l4_*`, `c_l5_*` (lines 419–424, 1798, 2105) | None | same | Not ported | (c) |
| 8 | `L5 - L6` (row 8) | `c_l5_*`, `c_l6_*` (lines 419–424, 1801, 2106) | None | same | Not ported | (c) |
| 9 | `-MAX < L6` (row 9) | `c_l6_*` lowest band (lines 419–424, 1804, 2107) | None | same | Not ported | (c) |

The Interstellar Eyes is a pure price-level reference grid with 9 bands across 6 timeframes. It is reproducible locally from the multi-TF OHLCV bundle via `camarilla_extended` (decision (c)), labelled UNVERIFIED because no webhook comparator exists today.

### 1.5 Kinetic Engine (TVA) — `hud_main` column 7 (GMI v12.70, line 221)

8 metric rows (rows 8–9 merged for `KINETIC PHASE`).

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `CHANNEL ANGLE (θ)` (row 1) | `s_theta = ta.ema(k_theta, 3)` (lines 465–471, 2121) | None | `diagnostics.s_theta` in `local-engines/gmi/src/gmi-core.mjs` (line 399) | Computed (unverified) | (b) |
| 2 | `VELOCITY (0)\|(1)\|(2)` (row 2) | `s_omega`, `omega_1`, `omega_2` (lines 472, 475–476, 2124) | None | `diagnostics.s_omega` (line 399); `omega_1`/`omega_2` not exposed | Computed (unverified) | (b) |
| 3 | `MOMENTUM FORCE (α)` (row 3) | `s_alpha = ta.ema(ta.change(s_omega), 3)` (lines 473, 2127) | None | `diagnostics.s_alpha` (line 399) | Computed (unverified) | (b) |
| 4 | `ANOMALY JERK (Δα)` (row 4) | `jerk_status` from `s_jerk` (lines 474, 493–494, 2130) | None | `s_jerk` computed internally, not exposed in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 5 | `EST. TIME TO REVERSAL` (row 5) | `rev_txt` from `est_rev_bars` (lines 496–516, 2133) | None | `est_rev_bars` computed in `gmi-core.mjs` (lines 316–317), not exposed in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 6 | `SPACETIME WARP` (row 6) | `swc_warp = lib.spacetime_warp(sigma_kww, ma_kww)` (lines 452, 2136) | None | `spacetimeWarp` in `mizan.mjs`, not exposed in `gmi-core.mjs` `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 7 | `MARKET ENTROPY` (row 7) | `e` (entropy), `is_chaos` (lines 441, 444, 2139) | None | `diagnostics.entropy`, `diagnostics.is_chaos` in `gmi-core.mjs` (line 398) | Computed (unverified) | (b) |
| 8 | `KINETIC PHASE` (rows 8–9 merged) | `kin_phase` from `s_theta`, `s_omega` (lines 478–492, 2142) | None | deterministic function of `diagnostics.s_theta` and `diagnostics.s_omega` (line 399) | Computed (unverified) | (b) derived reading |

### 1.6 Fabio AMT Sensors — `hud_main` column 9 (GMI v12.70, line 221)

10 metric rows.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `POC (GRAVITY)` (row 1) | `poc_price` from `lib.tdm_profile(...)` (lines 620, 2147) | None | `diagnostics.poc` in `gmi-core.mjs` (line 398) | Computed (unverified) | (b) |
| 2 | `VALUE AREA (65-80%)` (row 2) | `val_price`, `vah_price` (lines 620, 2150) | None | `diagnostics.val`, `diagnostics.vah` in `gmi-core.mjs` (line 398) | Computed (unverified) | (b) |
| 3 | `LVN 1 (PULLBACK) B\|S` (row 3) | `lvn_bull_1`, `lvn_bear_1` (lines 620, 2153) | None | `tdmProfileAt` returns `lvn_bull_1`/`lvn_bear_1` in `mizan.mjs` (line 160), destructured in `gmi-core.mjs` (line 295) but not placed in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 4 | `LVN 2 (VOID/SQZ) B\|S` (row 4) | `lvn_bull_2`, `lvn_bear_2` (lines 620, 2156) | None | returned by `tdmProfileAt` in `mizan.mjs` (line 160), not destructured in `gmi-core.mjs` | Computed (not exposed) | (c) expose in `diagnostics` |
| 5 | `HVN (STOP LOSS) B\|S` (row 5) | `hvn_price_bull`, `hvn_price_bear` (lines 620, 2159) | None | `tdmProfileAt` in `mizan.mjs` (line 160) omits HVN return fields | Not ported (in `mizan.mjs`) | (c) |
| 6 | `SQUEEZE STATE` (row 6) | `fp_status` (lines 673–709, 2161) | None | `diagnostics.fp_status` in `gmi-core.mjs` (line 398) | Computed (unverified) | (b) |
| 7 | `LIQUIDITY (MML)` (row 7) | `mml_liq` (lines 625–632, 2162) | None | `mml_liq` not exposed in `gmi-core.mjs` `diagnostics` | Computed (not exposed) | (c) |
| 8 | `ACTIVE SMR (D:S)` (row 8) | `bull_mass_pct`, `bear_mass_pct` from FVG reservoir (lines 559–616, 2167) | None | `zones` in `diagnostics` (line 400) has `in_mitig_*`, `in_ob_*`, `veto`, not FVG mass percentages | Not ported | (c) |
| 9 | `FABIO AMT MODEL STATUS` (row 9) | `fab_mod` from `fabio_m1_buy/sell`, `fabio_m2_buy/sell` (lines 1199, 2172) | None | `fabioDecision` in `mizan.mjs` (lines 177–187), computed in `gmi-core.mjs` but not placed in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 10 | `PROGRESSIVE SL` (row 10) | `sl_manager_txt` (lines 1408–1486, 2175) | None | depends on stateful OB lifecycle and position state | Not ported | (c) or (d) |

### 1.7 Chronos Matrix — `hud_aegis` top block (GMI v12.70, line 223)

5 metric rows.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `ACTIVE SESSIONS` (row 1) | `active_sessions` from `is_ses_tok`, `is_lon`, `is_ny` (lines 229–234, 1689–1697, 2217) | None | None | Not ported | (c) new local computation (UTC session window, deterministic) |
| 2 | `ASIAN RANGE (TOKYO)` (row 2) | `max_ses_tok`, `min_ses_tok` (lines 236–244, 1699, 2220) | None | None | Not ported | (c) (from Tokyo-window bars) |
| 3 | `WEEKLY CPR` (row 3) | `cpr_status` from `w_p`, `tc_val`, `bc_val` (lines 321–336, 2223) | None | Not ported in `gmi-core.mjs` | Not ported | (c) |
| 4 | `DAILY CPR + S/R` (row 4) | `d_cpr_status`, `d_r1..d_r3`, `d_s1..d_s3`, `d_p`, `d_tc`, `d_bc` (lines 337–371, 2226) | None | Not ported in `gmi-core.mjs` | Not ported | (c) |
| 5 | `CPR WIDTH × GMI` (row 5) | `cpr_width_gmi_text = d_cpr_width_status + " \| " + cpr_gmi_context` (lines 353–355, 1336–1338, 2229–2231) | `verdict` (`gmi_v12_70`) for the GMI side; daily CPR width is not in webhook | `comparable.verdict` in `gmi-core.mjs` (line 395); CPR width not ported | TradingView output; local engine: parity-approved (`verdict`); CPR width Not ported | (a) for `verdict` + (c) for CPR width |

### 1.8 Aegis Footprint Matrix — `hud_aegis` lower block (GMI v12.70, line 223)

6 metric rows.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `BUY / SELL VOL` (row 1+offset) | `buy_vol`, `sell_vol`, `cur_tot_vol` (lines 635–638, 2237–2240) | None | `footprintFromArrays` in `mizan.mjs` (lines 163–175); computed internally in `gmi-core.mjs`, not exposed in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 2 | `BAR DELTA` (row 2+offset) | `cur_bar_delta`, `cur_delta_pct` (lines 637, 639, 2242–2246) | None | computed internally in `gmi-core.mjs`, not in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 3 | `CVD (14B / LIFE)` (row 3+offset) | `osc_cvd`, `true_cvd` (lines 644–650, 2248–2251) | None | `osc_cvd` computed internally in `gmi-core.mjs`, not in `diagnostics`; lifetime `true_cvd` is chart-start dependent | Computed (not exposed, `osc_cvd`) / Not ported (`true_cvd`) | (c) expose 14-bar `osc_cvd` |
| 4 | `VOLUME SURGE` (row 4+offset) | `is_whale`, `vol_surge` (lines 654, 746–748, 2253–2256) | None | computed internally in `gmi-core.mjs`, not in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 5 | `PA STRUCTURE` (row 5+offset) | `aegis_pa_state` from `d_enc` (lines 2258–2262) | `d_enc` (`prophet_r37_ssot`) | `d_enc` in `src/prophet-r37-kernel.mjs` / `h1-producer.mjs` | TradingView output; local engine: parity-approved (`d_enc`) | (a) existing webhook field |
| 6 | `WHALE ACTIVITY` (row 6+offset) | `wai_str`, `active_lev_count` (lines 852–864, 2264–2267) | None | `in_mitig_*`, `in_ob_*` in `diagnostics.zones` (`gmi-core.mjs` line 400); `active_lev_count` not exposed | Computed (partial) | (b) `diagnostics.zones` + (c) expose `active_lev_count` |

### 1.9 Matrix & Omega Sensors — `hud_tdm` (GMI v12.70, line 224)

Owner decision (2026-11-05): **one agent per titled section** (6 agents total for `hud_tdm`, making **14 HUD agents** across the system). Each section agent receives only its own section's rows.

#### Agent 9 — Tactical Muscles (`hud_tdm` Section 1)

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `JMA PPO RANKING` | `pctRank`, `jma_proj_txt` (lines 289, 298–316, 2285–2292) | None | `diagnostics.pct_rank` in `local-engines/gmi/src/gmi-core.mjs` (line 399); `jma_est_bars` projection not exposed | Computed (unverified) | (b) `diagnostics.pct_rank` |
| 2 | `VPT VOLUME TREND` | `vpt_status` (lines 376–383, 2300–2303) | None | computed internally in `gmi-core.mjs`, not in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 3 | `TVA REGRESSION` | `tva_status` from `dyn_reg_period` (lines 453, 2306–2311) | None | `dyn_reg_period` computed internally in `gmi-core.mjs`, not in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 4 | `SMC BUY/SELL ZONE` (dynamic row rendered when `show_smc_zone` is active) | `bz_lbl_txt`, `lq_bot`/`lq_top` (lines 1132–1134, 1385–1510, 2314–2320) | None | depends on stateful OB lifecycle and position state | Not ported | (c) or (d) |

#### Agent 10 — Macro & Aether Sensors (`hud_tdm` Section 2)

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `MTF HURST (TREND)` | `global_h` (lines 436, 2328–2331) | None | `diagnostics.global_h` in `gmi-core.mjs` (line 398) | Computed (unverified) | (b) |
| 2 | `MTF Z-SCORE (KWW)` | `global_z` (lines 435, 2334–2338) | None | computed internally in `gmi-core.mjs`, not in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 3 | `CONSOL. GRAVITY` | `cg_bias_str`, `cg_net_pull` (lines 622–623, 2341–2344) | None | `cg_net_pull` computed from POC/VAL/VAH (`diagnostics.poc`/`val`/`vah` at line 398) | Computed (unverified, derivable) | (b) derived from `poc`/`val`/`vah` |
| 4 | `Z3 KINETIC SPREAD` | `kww_width`, `kww_width_pct` (lines 449–450, 2347–2350) | None | computed internally in `gmi-core.mjs`, not in `diagnostics` | Computed (not exposed) | (c) expose in `diagnostics` |
| 5 | `MACRO CYCLE` | `macro_state`, `macro_src_txt` (lines 391–406, 2353–2357) | None | `macro_kinematics` not ported (`LOCAL_COMPUTATION_OWNERSHIP.md`) | Not ported | (c) |
| 6 | `EST. MACRO SHIFT` | `macro_rev_txt`, `est_macro_bars` (lines 265–284, 2359–2362) | None | not ported in `gmi-core.mjs` | Not ported | (c) |
| 7 | `ASSET GRAVITY` | `grav_state`, `grav_vec` (lines 410–414, 2365–2368) | None | USOIL/DXY RSI gravity not ported in `gmi-core.mjs` | Not ported | (c) |
| 8 | `Q-GRAVITY PULL` | `g_scale` (lines 612, 2371–2374) | None | `q_gravity` not ported (`LOCAL_COMPUTATION_OWNERSHIP.md`) | Not ported | (c) |
| 9 | `MACRO SMR (SMRI)` | `smri` (lines 609–610, 2377–2380) | None | FVG mass not ported (`LOCAL_COMPUTATION_OWNERSHIP.md`) | Not ported | (c) |

#### Agent 11 — GABFX Price Action (`hud_tdm` Section 3)

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `QUASIMODO (QM) ZONE` | `qm_str` (lines 1140–1149, 2388–2394) | None | `diagnostics.zones` in `gmi-core.mjs` (line 400 spreads `...g` from `gabfxUpdate`) | Computed (unverified) | (b) `diagnostics.zones` |
| 2 | `RBS / SBR RETEST` | `rbs_sbr_str` (lines 1145, 2397–2403) | None | `diagnostics.zones` in `gmi-core.mjs` (line 400 spreads `...g` from `gabfxUpdate`) | Computed (unverified) | (b) `diagnostics.zones` |

#### Agent 12 — Playbook Execution (`hud_tdm` Section 4)

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `PHASE 1: HTF (MACRO)` | `str_ht` from `htf_state` (lines 1677–1678, 2414–2417) | None | `diagnostics.htf_state` in `gmi-core.mjs` (line 397) | Computed (unverified) | (b) |
| 2 | `PHASE 2: MTF (PROPHET)` | `str_mt` from `mtf_state` (lines 1680–1681, 2420–2423) | None | `diagnostics.mtf_state` in `gmi-core.mjs` (line 397) | Computed (unverified) | (b) |
| 3 | `PHASE 3: LTF (AEGIS/KIN)` | `str_lt` from `ltf_state` (lines 1683–1684, 2426–2429) | None | `diagnostics.ltf_state` in `gmi-core.mjs` (line 397) | Computed (unverified) | (b) |
| 4 | `PHASE 4: EXIT (KTS/TP)` | `str_ex` from `ext_state` (lines 1686–1687, 2432–2435) | None | `diagnostics.ext_state` in `gmi-core.mjs` (line 397) | Computed (unverified) | (b) |

#### Agent 13 — Decision Matrix (`hud_tdm` Section 5)

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `SCALP BURST INDEX` | `burst_txt`, `burst_score` (lines 1534–1562, 2442–2445) | None | `burst_score` not in `diagnostics` | Not ported | (c) |
| 2 | `ACTION VERDICT` | `verdict` (lines 1179–1305, 2448–2451) | `verdict` (`gmi_v12_70`) | `comparable.verdict` in `gmi-core.mjs` (line 395) | TradingView output; local engine: parity-approved (`verdict`) | (a) existing webhook field |
| 3 | `EXECUTE` | `ai_decision` (lines 1181, 1206–1304, 2454–2457) | `verdict`, `gate`, `conflict` (`gmi_v12_70`) | `comparable.verdict` + `diagnostics.branch` in `gmi-core.mjs` (lines 395, 397) | TradingView output; local engine: parity-approved (`verdict`/`gate`) + Computed (unverified, `branch`) | (a) + (b) derived reading |
| 4 | `SYSTEM GUARD` | `is_chaos` (lines 444, 2460–2463) | None | `diagnostics.is_chaos` in `gmi-core.mjs` (line 398) | Computed (unverified) | (b) |

#### Agent 14 — Grid Bot Protocol (`hud_tdm` Section 6)

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `CSHI VIABILITY` | `cshi_grid` (lines 713, 2470–2473) | None | `cshi_engine` not ported in `gmi-core.mjs` (`LOCAL_COMPUTATION_OWNERSHIP.md`) | Not ported | (c) |
| 2 | `DEPLOY STATUS` | `grid_status` (lines 715–729, 2476–2479) | None | not ported in `gmi-core.mjs` | Not ported | (c) |
| 3 | `GRID RANGE (BOT-TOP)` | `c_grid_bot`, `c_grid_top` (lines 1495–1510, 2482–2485) | None | not ported in `gmi-core.mjs` | Not ported | (c) or (d) |
| 4 | `TRIGGER PRICE` | `trigger_px` (lines 1511–1515, 2488–2491) | None | not ported in `gmi-core.mjs` | Not ported | (c) or (d) |
| 5 | `GRID QUANTITY (1.3%)` | `grid_count` (lines 1517–1519, 2494–2497) | None | not ported in `gmi-core.mjs` | Not ported | (c) or (d) |
| 6 | `TAKE PROFIT / STOP LOSS` | `c_grid_tp`, `c_grid_sl` (lines 1500–1509, 2500–2503) | None | not ported in `gmi-core.mjs` | Not ported | (c) or (d) |

---

## 2. Data-Source Decisions & Non-Reproducible HUD Rows

### 2.1 Breakdown across decisions

Counting every HUD row inventoried in §1 (14 HUD agents, 76 rows total including headers):

| Decision | Count (approx.) | Examples |
|---|---|---|
| (a) existing webhook field | ~8 rows | Funnel Confirmed/HQ (per-bar flags); Prophet Structure (`d_enc`, `structure_subtype`) & Momentum (`t_enc`); Trade Management Prophet–GMI (`prophet_dir`, `gmi_dir`, `conflict`, `gate`); Aegis PA Structure (`d_enc`); Decision Matrix Action Verdict (`verdict`) |
| (b) existing local engine output (unverified until parity-approved) | ~24 rows | Prophet Market/Harmonic/Momentum; Trade Management Zone/Cycle/Macro; Kinetic θ/ω/α/entropy/phase; Fabio POC/VA/squeeze; Tactical Muscles JMA PPO Ranking (`pct_rank`); Macro & Aether MTF Hurst & Consol. Gravity; GABFX QM & RBS/SBR (`diagnostics.zones`); Playbook Phases 1–4; Decision Matrix Execute (`branch`) & System Guard (`is_chaos`) |
| (c) new local computation (+ parity comparator where possible) | ~31 rows | Interstellar Eyes 9 camarilla bands; Chronos sessions/Asian range/weekly & daily CPR; Kinetic jerk/reversal bars/spacetime warp; Fabio LVN 1/2, HVN, MML, SMR, Fabio model status; Aegis buy/sell vol, delta, 14B CVD, surge, whale count; Tactical Muscles VPT & TVA regression; Macro & Aether Z-score, Z3 spread, macro cycle/shift, asset/Q-gravity, SMRI |
| (d) richer alert payload via `pinescript/candidates/` (codes & numeric levels) | ~13 rows | Trade Management Action/Entry/TP/Exit codes & levels; Fabio Progressive SL level & state code; Tactical Muscles SMC Buy/Sell Zone levels; Grid Bot range/trigger/quantity/TP-SL numeric fields; R37 Funnel cumulative counts |

Why (a) and (b) are preferred: (a) uses TradingView's own authoritative webhook outputs already stored per H1 candle; (b) reuses fields already computed by `local-engines/` without editing Pine or requiring the owner to reinstall TradingView alerts. Where a row is computed locally under (b) or (c) without a webhook comparator (or while the engine is still a parity candidate), it must be explicitly labelled **UNVERIFIED**.

### 2.2 HUD rows that cannot be reproduced locally from OHLCV alone (plainly)

1. **Trade Management Action / Entry candidate / TP / Exit (Prophet R38 cols 5–8).** These cells depend on the full stateful Order Block lifecycle (progressive mitigation, expiry, per-direction caps), target latching (`bias_tp_latched`), R:R gating, position-management state (`position_mode`, `position_entry`, `tp_reached`, `reversal_confirmed`) and chart-relative `bar_index`/`structure_state`. In `docs/LOCAL_COMPUTATION_OWNERSHIP.md`, position-management states beyond `t_enc` and TP-hit latching are explicitly "Not ported". If exact parity with TradingView's HUD is desired, use **(d)**: a candidate `prophet_r38` alert in `pinescript/candidates/` that emits **numeric levels, booleans and state codes** (never rendered strings, per brief §4) — specifically `action_code`, `entry_candidate_price`, `invalidation_price`, `candidate_rr`, `candidate_ttl`, `candidate_conf`, `tp_price`, `tp_reached` (boolean) and `exit_reason_code`. Until such a candidate is installed, the Trade Management agent relies on (a)/(b) (`t_enc`, `d_enc`, `cycle_intensity`, `kww_zscore`, `prophet_dir`/`gmi_dir`/`conflict`/`gate`). The candidate must carry those values as **codes and numeric levels** (e.g. `action_code`, `entry_candidate_price`, `invalidation_price`, `candidate_rr`, `candidate_ttl`, `candidate_conf`, `tp_price`, `tp_reached`, `exit_reason_code`) and must **not** carry the rendered strings `entry_candidate_txt`, `tp_txt` or `exit_txt` (brief §4: HUD data contracts carry numbers, booleans and codes, never rendered strings).

2. **R37 Funnel cumulative counters (Prophet R38 rows 1–6).** `funnel_candidates`, `funnel_price`, `funnel_structure`, `funnel_volume`, `funnel_confirmed` and `funnel_hq` are `var int` counters accumulated from the very first bar loaded on TradingView's chart, with stateful per-setup reset flags (`cand_counted_price`, etc.). Their absolute numbers depend on how many historical bars TradingView loaded and cannot be reproduced from a bounded local OHLCV window. Only the per-bar boolean events (`buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`) exist in the webhook (decision (a)) and local engine (decision (b)).

3. **Fabio AMT Progressive SL (`sl_manager_txt`) and Tactical Muscles SMC Buy/Sell Zone (`lq_bot`/`lq_top`).** Both depend on stateful Order Block mitigation/invalidation tracking and active position state across history. Reproducing them locally requires porting the full stateful OB manager (c) or emitting their numeric levels and state codes in a candidate alert (d).

4. **Aegis Footprint intrabar volume, delta, lifetime CVD (`true_cvd`) and surge.** In Pine, `request.security_lower_tf(syminfo.tickerid, "1", ...)` pulls TradingView's internal M1 intrabar arrays for every H1 bar, and `true_cvd` accumulates from chart bar 0. As documented in `docs/LOCAL_GMI_ENGINE.md`, the local GMI engine approximates M1 intrabars from the M1 OHLCV feed (`intrabars` in `diagnostics`), and lifetime `true_cvd` depends on chart start time. Therefore, exposing `buy_vol`, `sell_vol`, `cur_bar_delta`, `osc_cvd` (14-bar) and `vol_surge` from `gmi-core.mjs` (decision (c)) yields an **UNVERIFIED** local approximation, never an exact match to TradingView's intrabar footprint unless (d) sends those numeric values in the `gmi_v12_70` webhook.

5. **Grid Bot Protocol range, trigger price, quantity and TP/SL.** These depend on chart-relative structural high/low lookbacks (`struct_h`/`struct_l`), `g_poc_dir` and OB levels. They can be approximated locally as UNVERIFIED (c) or emitted as numeric fields in a candidate alert (d).

6. **Macro & Aether fundamental financial fallbacks (`request.financial`).** Pine attempts `request.financial` (which returns `na` on `OANDA:XAUUSD` and falls back to DXY/USOIL/technical proxies). The local engine can compute the DXY/USOIL/technical fallback path from the existing `TVC:DXY` and `TVC:USOIL` OHLCV pulls (c), labelled UNVERIFIED.

### 2.3 Trust status of fields today (2026-11-05)

- **Trusted `tradingview_webhook` lane (decision (a)):**
  - `prophet_r38`: `direction`, `buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`, `t_enc`, `d_enc`, `structure_subtype`.
  - `prophet_r37_ssot`: `direction`, `d_enc`, `b_enc`, `structure_subtype`, `bull_event`, `bear_event`.
  - `gmi_v12_70`: `verdict`, `gate`, `gmi_dir`, `prophet_dir`, `conflict`.
- **Local computation lane (`local_computation`):**
  - The same fields above are parity-checked on every closed H1 candle in `src/parity-registry.mjs`, and the `prophet` and `gmi` engines have been **parity-approved since 2026-11-05 01:00 UTC**. MizanLib is trusted through their declared dependency.
  - All other local engine outputs (`diagnostics.*`, `sensors.*`, `oscillator.*`) are not in `PARITY_FIELDS` and remain **UNVERIFIED** even after an engine reaches `24/24`.

---

## 3. Model Call & Cost Assessment (14 HUD Agents + Moderator)

### 3.1 Existing budgets (separate from HUD agents)

- **Multi-agent bus & news threads (`MULTI_AGENT_MAX_CALLS_PER_HOUR = 20`):** ~5 calls per H1 candle for the bus (`technical` + `news` × 2 rounds + `moderator`) and up to 5 calls per news analysis thread.
- **Live 15m room (`LIVE_ROOM_MAX_CALLS_PER_HOUR = 36`):** 12 calls/hour used at base (4 rooms/hour × 3 calls: `technical`, `risk`, `moderator`).
- **Runtime parameters:** 60 s per-call timeout; primary model `@cf/zai-org/glm-5.3-flash` (observed latency in `preview-e2e`: **3–12 s per call**) with fallback `@cf/zai-org/glm-4.7-flash` on first primary failure; 300 s wall budget per queue task; natural-language check (`src/natural-language.mjs`) with budgeted correction retries.

### 3.2 Call count per H1 candle and per hour (14 agents + moderator)

With the owner decision of **14 HUD agents** (3 Prophet R38 + 5 GMI main/aegis + 6 Matrix & Omega sections) and a **3-correction cap per run** (see §3.3):

- **Base calls per H1 candle:** 14 (HUD agents) + 1 (moderator summary) = **15 calls**.
- **Worst-case calls per H1 candle (with at most 3 natural-language correction calls per run):** 14 (HUD agents) + 3 (capped corrections) + 1 (moderator) = **18 calls**.
- **Hourly calls (1 H1 close per hour):** **15 base / 18 worst case** for a single H1 run.

### 3.3 Proposed budget, execution and wall-time design

1. **Dedicated hourly budget (`HUD_AGENTS_MAX_CALLS_PER_HOUR`):**
   - HUD agents use their **own** hourly budget variable `HUD_AGENTS_MAX_CALLS_PER_HOUR` so they never starve or compete with `MULTI_AGENT_MAX_CALLS_PER_HOUR` (bus + news threads) or `LIVE_ROOM_MAX_CALLS_PER_HOUR`.
   - **Proposed default: `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`.** This comfortably covers one worst-case H1 run (**18 calls**) plus up to **12 spare calls** for queue redelivery or parity-sweep backfill of a missed H1 candle within the same hour, and fails closed when exhausted.
2. **Parallel fan-out within the queue task (wall-time analysis):**
   - Dispatch all 14 HUD agents concurrently (`Promise.allSettled`) with a shared sub-deadline before running the moderator.
   - Using the observed `@cf/zai-org/glm-5.3-flash` latency from `preview-e2e` (**3–12 s per call**):
     - **Wave 1 (14 HUD agents in parallel):** ~**3–12 s** wall time (bounded by the slowest call; up to ~15–24 s if one call trips the primary and retries once on the fallback model).
     - **Wave 2 (up to 3 natural-language correction retries, run in parallel):** ~**3–12 s** wall time (or ~**9–36 s** if run sequentially).
     - **Wave 3 (1 moderator call):** ~**3–12 s** wall time.
     - **Total wall time per H1 run:** **~6–24 s base** and **~9–36 s (parallel corrections) to ~15–60 s (sequential corrections) worst case**, well within the **300 s** queue task wall budget.
3. **Capped natural-language corrections (max 3 per run):**
   - An answer that fails only `src/natural-language.mjs` is eligible for one correction call, capped at **3 correction calls total per H1 HUD run** (counted against `HUD_AGENTS_MAX_CALLS_PER_HOUR` and never executed past the budget or wall deadline). Any additional or second failure stays `invalid_output`.
4. **Model & fallback rule:**
   - Reuse `MULTI_AGENT_MODEL` (`@cf/zai-org/glm-5.3-flash`) and `MULTI_AGENT_FALLBACK_MODEL` (`@cf/zai-org/glm-4.7-flash`). After the first primary failure in a run, remaining calls in that run go straight to the fallback model.
5. **Idempotency:**
   - Key stored messages by `(candle_key, agent_id)`; if a queue task is redelivered, already-stored valid agent messages for that `candle_key` are reused without re-spending `HUD_AGENTS_MAX_CALLS_PER_HOUR`.

---

## 4. Speaking Schedule: Threads 1H vs. Live 15m Room

### 4.1 Threads 1H (every closed H1 bar)

All **14 HUD agents** post in **Threads 1H** on every closed H1 candle, after the H1 synthesis is persisted:

1. **R37 Funnel**
2. **Prophet**
3. **Trade Management**
4. **The Interstellar Eyes**
5. **Kinetic Engine (TVA)**
6. **Fabio AMT Sensors**
7. **Chronos Matrix**
8. **Aegis Footprint Matrix**
9. **Tactical Muscles**
10. **Macro & Aether Sensors**
11. **GABFX Price Action**
12. **Playbook Execution**
13. **Decision Matrix**
14. **Grid Bot Protocol**
15. **Moderator** (summarises the 14 HUD readings alongside the authoritative H1 decision).

Each HUD agent's evidence is strictly limited to **its own HUD's deterministic reading** plus the **authoritative H1 decision**. No HUD agent sees another HUD's fields.

### 4.2 Live 15m Room: honest data-timeframe constraints and proposal

**What data actually exists at 15m today:**
- The local Prophet, GMI and Mizan engines (`local-engines/producer/src/h1-producer.mjs`) run **only on closed H1 bars**.
- At 5m/15m, the only local computation produced today is `informational_5m_context` (`local-engines/producer/src/m5-producer.mjs`, which runs `buildM5ProphetContext` — 5m Prophet R38 + Mizan sensors, not GMI and not 15m HUD tables).
- Therefore, **15m HUD values do not exist today** for GMI HUDs (*Kinetic Engine (TVA)*, *Fabio AMT Sensors*, *Aegis Footprint Matrix*) or for the full *Trade Management* HUD.

**Two architectural options for the Live 15m Room:**

- **Option A (Proposed for Phase B/C): Keep the 14 HUD agents in Threads 1H only; do not add HUD agents to the Live 15m Room unless 15m HUD computation is built.**
  - *Why:* If *Trade Management*, *Kinetic Engine (TVA)* or *Fabio AMT Sensors* spoke in the 15m room today while strictly limited to their own HUD data, they would only be repeating their **latest H1 HUD snapshot** four times an hour (:00, :15, :30, :45 UTC) with no new 15m HUD evidence. Meanwhile, the existing Live 15m Room (`technical`, `risk`, `moderator`) already consumes the 15m candles (`m15`), the 5m Prophet context (`m5`), the H1 decision/TradingView reading (`h1`) and `news` for 12 calls/hour.
- **Option B (Alternative, requires new 15m producer computation under decision (c)):**
  - Build a new 15m local HUD producer that runs on closed M15 bars (using the M15 and M1 OHLCV already fetched by `market-data-ingestion`) to compute fresh 15m UNVERIFIED HUD snapshots for a 3-agent execution-timing subset (**Trade Management**, **Kinetic Engine (TVA)**, **Fabio AMT Sensors**, optionally **Aegis Footprint Matrix**).
  - *Cost of Option B:* Adds 15m engine computation in the pull adapter + KV storage + 3–4 extra model calls per 15m close (`12–16` calls/hour on primary model only, plus up to 1 correction call per room = `16–20` calls/hour, requiring `LIVE_ROOM_MAX_CALLS_PER_HOUR` to be raised from `36` to `48` to stay safe above the existing `12` calls/hour).

**Recommendation:** Adopt **Option A** (HUD agents speak per H1 candle in Threads 1H; Live 15m Room stays `technical` + `risk` + `moderator`), unless the owner explicitly wants **Option B** (building a 15m UNVERIFIED HUD producer for the 3–4 execution-timing HUD agents).

---

## 5. Risks, Guardrails & Open Questions for the Owner

### 5.1 Architectural risks and guardrails

1. **Advisory-only compliance (SSOT §5, brief §0.5).** Several HUD sections display price levels or terms that resemble trade instructions: *Trade Management* (entry candidate, TP, exit), *Fabio AMT Sensors* (HVN "STOP LOSS", progressive SL, model status), *Tactical Muscles* (SMC buy/sell zone), *Decision Matrix* (action verdict, execute) and *Grid Bot Protocol* (deploy status, grid range, trigger price, grid quantity, take profit / stop loss).
   - **Guardrail:** Every HUD agent prompt and deterministic reading must frame levels strictly as HUD observations attributed to the indicator (e.g., *"the Grid Bot Protocol section displays a trigger level near …"*), never as an order, position size or trade instruction. HUD agents never output entry/SL/TP/size fields in their JSON schema.
2. **Honest labelling of parity-candidate and unverified data.**
   - The `prophet` and `gmi` engines are parity-approved (since 2026-11-05 01:00 UTC), but approval covers only the `PARITY_FIELDS`. All other local values used by HUD agents (`diagnostics`, internals) remain UNVERIFIED and must be labelled so.
   - All local-engine HUD fields (decisions (b) and (c)) must carry an explicit `unverified` marker in the HUD data contract and deterministic reading until backed by a parity-approved comparator.
3. **Natural-language validator compliance (`src/natural-language.mjs`).**
   - Following `src/webhook-interpretation.mjs`, each of the 14 HUDs gets a deterministic decoder function turning numeric values, booleans and codes into plain English sentences before the model sees them, preventing the model from echoing `snake_case` identifiers, dotted paths or `key=value` tokens.
4. **Wall-clock and budget isolation.**
   - Parallel fan-out (`Promise.allSettled`), the 3-correction cap per run, and the dedicated `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30` budget prevent HUD agents from exceeding the 300 s queue consumer limit or affecting the existing H1 chain, multi-agent bus, news threads or live 15m room.
5. **Feature flag & deployment safety.**
   - All runtime code ships in the existing AI Worker (`src/`) behind `HUD_AGENTS_ENABLED` (`"false"` in `wrangler.jsonc`, `"true"` in `wrangler.preview.jsonc`), verified by unit tests and `preview-e2e` before any production enablement PR.

### 5.2 Open questions for the owner

> **Answered by the owner on 2026-11-05.** See "Owner decisions on the Phase A open questions" in `docs/BRIEF_HUD_AGENTS.md`: Option B with verified data; non-reproducible rows become decision-reasoning output; the funnel is read per current candle; the budget is 30 calls an hour. The questions below are kept for the record.

1. **Live 15m Room participation (§4.2 Option A vs. Option B):** Since HUD values are H1-only today, do you approve **Option A** (all 14 HUD agents speak in **Threads 1H** only; Live 15m Room remains unchanged), or do you want **Option B** (build a new 15m UNVERIFIED local HUD producer so *Trade Management*, *Kinetic Engine (TVA)* and *Fabio AMT Sensors* — and optionally *Aegis Footprint Matrix* — also speak every 15m)?
2. **Stateful / non-reproducible HUD rows — (c) local unverified vs. (d) Pine candidate alerts (§2.2):** For rows that depend on chart-stateful OB lifecycles or history (*Trade Management* Action/Entry/TP/Exit, *Fabio AMT* Progressive SL, *Tactical Muscles* SMC Zone, *Grid Bot Protocol* levels), should Phase C start with **(a)+(b)+(c) only** (reporting what is reproducible from webhooks and local engines, labelled UNVERIFIED where not parity-checked) and defer **(d)** (`pinescript/candidates/` alert extensions with numeric levels and codes) to a later optional phase?
3. **R37 Funnel agent scope (§1.1 & §2.2 item 2):** Because `funnel_table` counters are cumulative `var int` tallies from chart start, should the **R37 Funnel** agent interpret the per-bar funnel stage flags for the current H1 candle (candidate / price / structure / volume / confirmed / high-quality pass/fail on that bar, computed via (a)+(c)), or do you want cumulative counters added to a candidate alert (d)?
4. **Dedicated hourly budget (`HUD_AGENTS_MAX_CALLS_PER_HOUR`):** Confirm the proposed default of **`30` calls/hour** (covering 15 base / 18 worst-case calls per H1 candle plus redelivery/backfill headroom).

---

## Appendix A — Quick reference: parity-tracked fields per source

| Source | Fields in `tradingview_webhook` & `PARITY_FIELDS` (`src/parity-registry.mjs`) | Status at `2026-11-05T08:00Z` |
|---|---|---|
| `prophet_r38` | `direction`, `buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`, `t_enc`, `d_enc`, `structure_subtype` | TradingView webhook: authoritative (`tradingview_webhook` lane). Local `prophet` engine: **parity-approved (31/31)**. |
| `prophet_r37_ssot` | `direction`, `d_enc`, `b_enc`, `structure_subtype`, `bull_event`, `bear_event` | TradingView webhook: authoritative (`tradingview_webhook` lane). Compared by the local `prophet` engine (`PARITY_FIELDS.prophet`): **parity-approved (31/31)**. MizanLib is trusted through the approved engines' declared dependency. |
| `gmi_v12_70` | `verdict`, `gate`, `gmi_dir`, `prophet_dir`, `conflict` | TradingView webhook: authoritative (`tradingview_webhook` lane). Local `gmi` engine: **parity-approved (31/31)**. |

All other HUD-derived values are not in `PARITY_FIELDS` and must be labelled **UNVERIFIED**.

## Appendix B — Canonical 14 HUD Agents Inventory Summary

| # | HUD (agent display name) | Proposed `agent_id` | Source indicator | Pine table & location | Data rows (excl. header) |
|---|---|---|---|---|---|
| 1 | **R37 Funnel** | `r37_funnel` | Prophet R38 | `funnel_table` (line 505) | 6 counter rows (+ 1 header = 7 table rows) |
| 2 | **Prophet** | `prophet` | Prophet R38 | `hud` (line 1074) | 4 rows |
| 3 | **Trade Management** | `trade_management` | Prophet R38 | `trade_management_hud` (line 1075) | 8 data cells (+ 1 header cell = 9 columns) |
| 4 | **The Interstellar Eyes** | `interstellar_eyes` | GMI v12.70 | `hud_main` col 0 (line 221) | 9 price-band rows (+ 1 header = 10 table rows) |
| 5 | **Kinetic Engine (TVA)** | `kinetic_engine` | GMI v12.70 | `hud_main` col 7 (line 221) | 8 metric rows (rows 8–9 merged) |
| 6 | **Fabio AMT Sensors** | `fabio_amt` | GMI v12.70 | `hud_main` col 9 (line 221) | 10 rows |
| 7 | **Chronos Matrix** | `chronos_matrix` | GMI v12.70 | `hud_aegis` top (line 223) | 5 rows |
| 8 | **Aegis Footprint Matrix** | `aegis_footprint` | GMI v12.70 | `hud_aegis` lower (line 223) | 6 rows |
| 9 | **Tactical Muscles** | `tactical_muscles` | GMI v12.70 | `hud_tdm` Section 1 (line 224) | 4 rows (3 fixed + 1 dynamic SMC zone) |
| 10 | **Macro & Aether Sensors** | `macro_aether` | GMI v12.70 | `hud_tdm` Section 2 (line 224) | 9 rows |
| 11 | **GABFX Price Action** | `gabfx_price_action` | GMI v12.70 | `hud_tdm` Section 3 (line 224) | 2 rows |
| 12 | **Playbook Execution** | `playbook_execution` | GMI v12.70 | `hud_tdm` Section 4 (line 224) | 4 rows |
| 13 | **Decision Matrix** | `decision_matrix` | GMI v12.70 | `hud_tdm` Section 5 (line 224) | 4 rows |
| 14 | **Grid Bot Protocol** | `grid_bot_protocol` | GMI v12.70 | `hud_tdm` Section 6 (line 224) | 6 rows |

Total: **14 HUD agents + 1 moderator summary call = 15 base calls per H1 candle (18 worst case with up to 3 natural-language corrections).**
