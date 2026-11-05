# HUD Agents Assessment (Phase A)

> Owner request 2026-11-04 (brief `docs/BRIEF_HUD_AGENTS.md`). Documents only — no runtime change.
> Canonical documents `docs/SSOT.md` and `AGENTS.md` win over anything here.

## 0. Scope, method and sources

This assessment walks every HUD table and row of the two installed Pine indicators and decides, for each row, where its data comes from today and where it should come from for a per-HUD agent.

Sources inspected (line numbers as in `main` on 2026-11-04):

- `pinescript/ssot/The-Prophet-v7.02-R38.txt` — `funnel_table` (line 505), `hud` (line 1074), `trade_management_hud` (line 1075).
- `pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt` — `hud_main` (line 221): column 0 "The Interstellar Eyes", column 7 "Kinetic Engine (TVA)", column 9 "Fabio AMT Sensors"; `hud_aegis` (line 223): top "Chronos Matrix", lower block "Aegis Footprint Matrix"; `hud_tdm` (line 224): "Matrix & Omega Sensors" with six titled sections.
- `src/parity-registry.mjs` (`PARITY_FIELDS`, `INPUT_FIELDS`) — the only trust gate.
- `docs/LOCAL_COMPUTATION_OWNERSHIP.md`, `docs/LOCAL_GMI_ENGINE.md` — honest coverage.
- `local-engines/producer/src/h1-producer.mjs`, `local-engines/gmi/src/gmi-core.mjs`, `local-engines/gmi/src/mizan.mjs`, `local-engines/prophet-r38/src/core.mjs`.
- `src/webhook-interpretation.mjs` — the deterministic reading pattern to follow.
- `src/multi-agent-bus.mjs`, `src/agent-threads.mjs` — budgets, validators, correction rule.

Parity status legend used throughout:

- **Verified** — field is in `PARITY_FIELDS` and compared field-by-field with a TradingView webhook on every closed H1 bar; trusted only after 24 consecutive matches.
- **Computed (unverified)** — ported from Pine and run locally, appears in `diagnostics` or engine internals, not compared.
- **Not ported** — not computed locally today.

Data-source decision legend (brief §3.2):

- **(a)** existing webhook field;
- **(b)** existing local engine output — trusted only when parity-approved, otherwise labelled UNVERIFIED;
- **(c)** new local computation + parity comparator;
- **(d)** richer alert payload from a Pine candidate in `pinescript/candidates/`, owner must install.

Preference order: (a) > (b) > (c) > (d).

---

## 1. HUD Row-by-Row Inventory & Coverage Matrix

### 1.1 R37 Funnel — `funnel_table` (Prophet R38, line 505)

Table is 2 columns × 7 rows, rendered only when `show_funnel` is on. Counters are cumulative diagnostic tallies, not per-bar signals.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `R37 FUNNEL` (header) | table title only | None | None | Not applicable (rendering) | (b) informational label |
| 2 | `Candidates` (row 1) | `funnel_candidates` incremented on `buy_candidate or sell_candidate` (lines 483–484) | None | None | Not ported | (c) new local computation |
| 3 | `Price` (row 2) | `funnel_price` incremented on `buy/sell_window_active and bullish/bearish_price_confirm` (lines 489–492) | None | None | Not ported | (c) |
| 4 | `Structure` (row 3) | `funnel_structure` on price+structure confirm (lines 493–496) | None | None | Not ported | (c) |
| 5 | `Volume` (row 4) | `funnel_volume` on price+structure+volume pass (lines 497–500) | None | None | Not ported | (c) |
| 6 | `Confirmed` (row 5) | `funnel_confirmed` on `buy_confirmed or sell_confirmed` (lines 501–502) | `buy_confirmed` / `sell_confirmed` (`prophet_r38`) | `confirmation.buy_confirmed` / `sell_confirmed` in `local-engines/prophet-r38/src/core.mjs` (line 522) | Verified | (a) existing webhook field |
| 7 | `High Quality` (row 6) | `funnel_hq` on `buy_high_quality or sell_high_quality` (lines 503–504) | `buy_high_quality` / `sell_high_quality` (`prophet_r38`) | `confirmation.buy_high_quality` / `sell_high_quality` (line 523) | Verified | (a) |

Note: the funnel counters are cumulative `var int` state that depends on full chart history and reset semantics (`buy_candidate` resets the per-setup flags). They cannot be reproduced deterministically from a single bar; see §2.

### 1.2 Prophet HUD — `hud` (Prophet R38, line 1074, untitled top-right table)

4 metric rows, 2 columns. The table has no title in Pine; owner must confirm the display name ("Prophet HUD" proposed).

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `MARKET` (row 0) | `hud_market_txt = cshi_txt + " · " + regime_detail` where `cshi_txt` from `cshi_score` (lines 162–171, 599) and `regime_detail` = ER + Vol (line 598) | None | `sensors` (KWW z-score, Hurst, efficiency ratio, volume ratio) in `core.mjs` (lines 609, 564); `cshi_score` itself not computed | Computed (partial) | (b) unverified local reading |
| 2 | `HARMONIC` (row 1) | `hud_harmonic_txt = intensity_txt + " · " + int_dir_txt` from `inten` (lines 176, 237–239, 600) | None | `sensors.cycle_intensity` in `core.mjs` (line 608) | Computed (unverified) | (b) |
| 3 | `STRUCTURE` (row 2) | `hud_structure_txt = div_txt + " · " + vol_conf_txt` from `d_enc`, `t_enc`, `prophet_structure_subtype` (lines 241–262, 601) | `d_enc`, `structure_subtype` (`prophet_r38`) | `structure.d_enc`, `structure.subtype_code` in `core.mjs` (line 595, 609) | Verified (d_enc, subtype); `div_txt` rendering not | (a) for d_enc/subtype, (b) for rendered label |
| 4 | `MOMENTUM` (row 3) | `hud_momentum_txt = hud_momentum_strength_txt + " — " + legacy_tm_context_txt + momentum_trend_context_txt` (lines 603–615) | None (`t_enc` is in webhook but momentum delta is not) | `oscillator.fast`/`slow` in `core.mjs` (line 609); `pro_fast - pro_fast[1]` not exposed | Computed (unverified) | (b) unverified local reading |

### 1.3 Trade Management HUD — `trade_management_hud` (Prophet R38, line 1075)

9 columns × 1 row. This is the richest per-bar decision surface.

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `TRADE MANAGEMENT` (col 0) | header / tooltip = `decision_tooltip` (line 1072) | None | None | Not ported | (c) |
| 2 | Zone (col 1) | `zone_full_txt` / `zone_state_txt` (lines 619–652, 794) | None (`t_enc`, `d_enc` indirectly) | `structure.d_enc`, `confirmation.*` in `core.mjs` | Computed (unverified) | (b) |
| 3 | Cycle (col 2) | `cycle_full_txt` from `inten` (lines 784, 788) | None | `sensors.cycle_intensity` in `core.mjs` (line 608) | Computed (unverified) | (b) |
| 4 | Macro (col 3) | `macro_full_txt` from `is_macro_bull/bear` = `z_score >/< 0` (lines 158–159, 785, 789) | None | KWW z-score in `core.mjs` (line 609) | Computed (unverified) | (b) |
| 5 | Prophet–GMI (col 4) | `pg_full_txt` from `gmi_z_alignment_code` (lines 152–154, 786, 790) | None (`gmi_v12_70` has `prophet_dir`, `gmi_dir`, `conflict`, `gate`) | `htf_alignment` in `core.mjs` (line 601); GMI alignment not computed locally in Prophet | Computed (unverified) | (b) local unverified; (a) partial via GMI webhook |
| 6 | Action (col 5) | `action_full_txt` = `decision_conclusion` (lines 724–793) | None | None (OB lifecycle, ranking, trade readiness not ported) | Not ported | (c) or (d) |
| 7 | Entry candidate (col 6) | `entry_candidate_txt` (lines 1033–1035) — contains BUY/SELL LIMIT level, INV level, R:R, TTL, CONF | None | OB zones partially in `core.mjs` (`order_blocks`, line 602) but entry-level latching/TP-hit lifecycle not ported | Not ported | (c) or (d) |
| 8 | TP (col 7) | `tp_txt` (lines 1063–1064) — target key level | None | OB target scoring not ported | Not ported | (c) or (d) |
| 9 | Exit (col 8) | `exit_txt` (lines 1066–1069) — position-management review text | None | Position-management states beyond `t_enc` not ported | Not ported | (c) or (d) |

### 1.4 The Interstellar Eyes — `hud_main` column 0 (GMI v12.70, line 221)

Price-band table: rows are Camarilla-derived zones across 6 timeframes (5m/15m/1H/4H/1D/1W).

| # | HUD row label (cell col 0) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `+MAX > H6` (row 1) | `c_h6_*` from `lib.camarilla_extended(high, low, close)` (lines 419–424) | None | `camarilla_extended` listed under MizanLib computed (not verified) in `LOCAL_COMPUTATION_OWNERSHIP.md` row MizanLib; not invoked in `gmi-core.mjs` | Not ported (in GMI) | (c) new local computation |
| 2 | `H6 - H5` (row 2) | `c_h5_*` same | None | same | Not ported | (c) |
| 3 | `H4 - H3` (row 4) | `c_h4_*` same | None | same | Not ported | (c) |
| 4 | `H3 - L3` (row 5) | mid zone, `mid_p = (c_h3 + c_l3)/2` (line 1790) | None | same | Not ported | (c) |
| 5 | `L3 - L4` (row 6) | `c_l3_*`, `c_l4_*` same | None | same | Not ported | (c) |
| 6 | `L4 - L5` (row 7) | `c_l5_*` same | None | same | Not ported | (c) |
| 7 | `L5 - L6` (row 8) | `c_l6_*` same | None | same | Not ported | (c) |
| 8 | `-MAX < L6` (row 9) | `c_l6_*` lowest band | None | same | Not ported | (c) |

The Interstellar Eyes is a pure price-level reference grid; no decision logic. Reproducible locally from OHLCV via `camarilla_extended` (already in MizanLib, just not wired into the GMI lane). Recommend (c): wire it into the producer as diagnostics, labelled UNVERIFIED until a comparator exists (no webhook field today → no parity possible without (d)).

### 1.5 Kinetic Engine (TVA) — `hud_main` column 7 (GMI v12.70, line 221)

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `CHANNEL ANGLE (θ)` (row 1) | `s_theta = ta.ema(k_theta, 3)` (lines 465–471) | None | `diagnostics.s_theta` in `gmi-core.mjs` (line 399) | Computed (unverified) | (b) |
| 2 | `VELOCITY (0)\|(1)\|(2)` (row 2) | `s_omega`, `omega_1`, `omega_2` (lines 472, 475–476) | None | `diagnostics.s_omega` (line 399); omega_1/2 not exposed | Computed (unverified) | (b) |
| 3 | `MOMENTUM FORCE (α)` (row 3) | `s_alpha = ta.ema(ta.change(s_omega), 3)` (line 473) | None | `diagnostics.s_alpha` (line 399) | Computed (unverified) | (b) |
| 4 | `ANOMALY JERK (Δα)` (row 4) | `jerk_status` from `s_jerk` (lines 474, 493–494) | None | `s_jerk` not exposed in diagnostics | Computed (not exposed) | (c) |
| 5 | `EST. TIME TO REVERSAL` (row 5) | `rev_txt` from `est_rev_bars` (lines 496–516) | None | `est_rev_bars` is used internally in `gmi-core.mjs` (lines 316–317) but not in `diagnostics` | Computed (not exposed) | (c) |
| 6 | `SPACETIME WARP` (row 6) | `swc_warp = lib.spacetime_warp(sigma_kww, ma_kww)` (line 452) | None | `spacetime_warp` not in diagnostics; `sigma_kww`/`ma_kww` not exposed | Computed (not exposed) | (c) |
| 7 | `MARKET ENTROPY` (row 7) | `e` (entropy), `is_chaos` (lines 441, 444) | None | `diagnostics.entropy`, `diagnostics.is_chaos` (line 398) | Computed (unverified) | (b) |
| 8 | `KINETIC PHASE` (row 8–9 merged) | `kin_phase` from `s_theta`, `s_omega` (lines 478–492) | None | derived from `s_theta`/`s_omega` (not exposed as a code) | Computed (not exposed) | (b) derived reading |

### 1.6 Fabio AMT Sensors — `hud_main` column 9 (GMI v12.70, line 221)

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `POC (GRAVITY)` (row 1) | `poc_price` from `lib.tdm_profile(...)` (line 620) | None | `diagnostics.poc` (line 398) | Computed (unverified) | (b) |
| 2 | `VALUE AREA (65-80%)` (row 2) | `val_price`, `vah_price` (line 620) | None | `diagnostics.val`, `diagnostics.vah` (line 398) | Computed (unverified) | (b) |
| 3 | `LVN 1 (PULLBACK) B\|S` (row 3) | `lvn_bull_1`, `lvn_bear_1` (line 620) | None | `tdmProfileAt` returns `lvn_bull_1`/`lvn_bear_1` in `mizan.mjs` (line 160) but `gmi-core` destructures only `lvn_bull_1`/`lvn_bear_1` (line 295) and does not put them in `diagnostics` | Computed (not exposed) | (c) expose in diagnostics |
| 4 | `LVN 2 (VOID/SQZ) B\|S` (row 4) | `lvn_bull_2`, `lvn_bear_2` (line 620) | None | computed by `tdmProfileAt` (line 160) but not destructured in `gmi-core` (line 295) | Computed (not exposed) | (c) |
| 5 | `HVN (STOP LOSS) B\|S` (row 5) | `hvn_price_bull`, `hvn_price_bear` (line 620) | None | computed inside `tdm_profile` (lib) but not returned by `tdmProfileAt` in `mizan.mjs` (line 160 returns only vah/val/poc/lvn) | Not ported (in mizan) | (c) |
| 6 | `SQUEEZE STATE` (row 6) | `fp_status` (lines 673–709) | None | `diagnostics.fp_status` (line 398) | Computed (unverified) | (b) |
| 7 | `LIQUIDITY (MML)` (row 7) | `mml_liq` (line 2162) | None | `mml_liq` not in `gmi-core` diagnostics | Computed (not exposed) | (c) |
| 8 | `ACTIVE SMR (D:S)` (row 8) | `bull_mass_pct`, `bear_mass_pct` from FVG reservoir (lines 559–616, 2167) | None | `zones` in diagnostics (line 398) includes `in_mitig_*`, `in_ob_*`, `veto` but not `bull_mass_pct`/`bear_mass_pct` | Computed (not exposed) | (c) |
| 9 | `FABIO AMT MODEL STATUS` (row 9) | `fab_mod` from `fabio_m1_buy/sell`, `fabio_m2_buy/sell` (lines 1199, 2172) | None | `fabioDecision` in `mizan.mjs` (lines 177–187); result not in diagnostics | Computed (not exposed) | (c) |
| 10 | `PROGRESSIVE SL` (row 10) | `sl_manager_txt` (lines 1408–1486) | None | `sl_manager_*` not in diagnostics; depends on OB lifecycle + position state | Not ported | (c) or (d) |

### 1.7 Chronos Matrix — `hud_aegis` top block (GMI v12.70, line 223)

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `ACTIVE SESSIONS` (row 1) | `active_sessions` from `is_ses_tok`, `is_lon`, `is_ny` (lines 229–234, 1689–1697) | None | None | Not ported | (c) new local computation (time-of-day, trivial) |
| 2 | `ASIAN RANGE (TOKYO)` (row 2) | `max_ses_tok`, `min_ses_tok` (lines 236–244, 1699) | None | None | Not ported | (c) (needs M1 bars during Tokyo session) |
| 3 | `WEEKLY CPR` (row 3) | `cpr_status` from `w_p`, `tc_val`, `bc_val` (lines 321–336) | None | `daily_cpr_stats` listed under MizanLib computed (not verified) but CPR itself not in `gmi-core` | Not ported | (c) |
| 4 | `DAILY CPR + S/R` (row 4) | `d_cpr_status`, `d_r1..d_r3`, `d_s1..d_s3`, `d_p`, `d_tc`, `d_bc` (lines 337–371) | None | `daily_cpr_stats` in MizanLib computed (not verified); not in `gmi-core` | Not ported | (c) |
| 5 | `CPR WIDTH × GMI` (row 5) | `cpr_width_gmi_text = d_cpr_width_status + " \| " + cpr_gmi_context` (lines 353–355, 2229–2231) | None | `cpr_gmi_context` derived from `verdict_state` and `cpr_context_dir` (lines 1336–1338); verdict is parity field | Computed (partial) | (b) unverified local reading |

### 1.8 Aegis Footprint Matrix — `hud_aegis` lower block (GMI v12.70, line 223)

| # | HUD row label (cell) | Pine variable(s) & producer expression | Webhook field today | Local engine coverage | Parity status | Decision |
|---|---|---|---|---|---|---|
| 1 | `BUY / SELL VOL` (row 1+offset) | `buy_vol`, `sell_vol`, `cur_tot_vol` (lines 635–638, 2237–2240) | None | `footprintFromArrays` in `mizan.mjs` (lines 163–175); GMI engine computes `buy_vol`/`sell_vol` internally (line 635) but not exposed in diagnostics | Computed (not exposed) | (c) expose in diagnostics |
| 2 | `BAR DELTA` (row 2+offset) | `cur_bar_delta`, `cur_delta_pct` (lines 637, 639, 2242–2246) | None | computed internally in GMI; not in diagnostics | Computed (not exposed) | (c) |
| 3 | `CVD (14B / LIFE)` (row 3+offset) | `osc_cvd`, `true_cvd` (lines 650, 644–648, 2248–2251) | None | computed internally; not in diagnostics | Computed (not exposed) | (c) |
| 4 | `VOLUME SURGE` (row 4+offset) | `is_whale`, `vol_surge` (lines 654, 746–748, 2253–2256) | None | `vol_surge` not in diagnostics; `is_whale` not exposed | Computed (not exposed) | (c) |
| 5 | `PA STRUCTURE` (row 5+offset) | `aegis_pa_state` from `d_enc` (lines 2258–2262) | `d_enc` (`prophet_r37_ssot` / `gmi` indirectly) | `d_enc` is a parity field for `prophet_r37_ssot` | Verified (d_enc) | (a) existing webhook field |
| 6 | `WHALE ACTIVITY` (row 6+offset) | `wai_str`, `active_lev_count` (lines 852–864, 2264–2267) | None | `in_mitig_*`, `in_ob_*` in diagnostics `zones` (line 398); `wai_str`/`active_lev_count` not exposed | Computed (not exposed) | (c) |

### 1.9 Matrix & Omega Sensors — `hud_tdm` (GMI v12.70, line 224)

Six titled sections. Default = one agent for the whole table (counts as 1 of the 9). Alternative = one agent per section (6 agents, 14 total).

**Section A — Tactical Muscles**

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity | Decision |
|---|---|---|---|---|---|---|
| 1 | `JMA PPO RANKING` | `pctRank`, `jma_proj_txt` (lines 289, 298–316, 2285–2292) | None | JMA percent-rank not in GMI diagnostics; `pctRank`/`jma_est_bars` not exposed | Computed (not exposed) | (c) |
| 2 | `VPT VOLUME TREND` | `vpt_status` (lines 376–383, 2300–2303) | None | not in diagnostics | Computed (not exposed) | (c) |
| 3 | `TVA REGRESSION` | `tva_status` from `dyn_reg_period` (lines 453, 2306–2311) | None | not in diagnostics | Computed (not exposed) | (c) |
| 4 | `SMC BUY/SELL ZONE` | `bz_lbl_txt`, `lq_bot`/`lq_top` (lines 1132–1134, 1385–1510, 2314–2320) | None | not in diagnostics | Not ported (OB lifecycle + position state) | (c) or (d) |

**Section B — Macro & Aether Sensors**

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity | Decision |
|---|---|---|---|---|---|---|
| 1 | `MTF HURST (TREND)` | `global_h` (lines 436, 2328–2331) | None | `diagnostics.global_h` (line 398) | Computed (unverified) | (b) |
| 2 | `MTF Z-SCORE (KWW)` | `global_z` (lines 435, 2334–2338) | None | `global_z` not in diagnostics (only `global_h`) | Computed (not exposed) | (c) |
| 3 | `CONSOL. GRAVITY` | `cg_bias_str`, `cg_net_pull` (lines 622–623, 2341–2344) | None | `cg_net_pull` not in diagnostics | Computed (not exposed) | (c) |
| 4 | `Z3 KINETIC SPREAD` | `kww_width`, `kww_width_pct` (lines 449–450, 2347–2350) | None | not in diagnostics | Computed (not exposed) | (c) |
| 5 | `MACRO CYCLE` | `macro_state`, `macro_src_txt` (lines 391–406, 2353–2357) | None | `macro_state` not in diagnostics; `is_funda_*` not computed (request.financial unavailable for OANDA:XAUUSD) | Computed (not exposed) | (c) |
| 6 | `EST. MACRO SHIFT` | `macro_rev_txt`, `est_macro_bars` (lines 265–284, 2359–2362) | None | not in diagnostics | Computed (not exposed) | (c) |
| 7 | `ASSET GRAVITY` | `grav_state`, `grav_vec` (lines 410–414, 2365–2368) | None | not in diagnostics (USOIL RSI) | Computed (not exposed) | (c) |
| 8 | `Q-GRAVITY PULL` | `g_scale` (lines 612, 2371–2374) | None | not in diagnostics | Computed (not exposed) | (c) |
| 9 | `MACRO SMR (SMRI)` | `smri` (lines 609–610, 2377–2380) | None | not in diagnostics | Computed (not exposed) | (c) |

**Section C — GABFX Price Action**

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity | Decision |
|---|---|---|---|---|---|---|
| 1 | `QUASIMODO (QM) ZONE` | `qm_str` (lines 1140–1149, 2388–2394) | None | `gabfx_update` not in diagnostics | Computed (not exposed) | (c) |
| 2 | `RBS / SBR RETEST` | `rbs_sbr_str` (lines 1145, 2397–2403) | None | not in diagnostics | Computed (not exposed) | (c) |

**Section D — Playbook Execution**

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity | Decision |
|---|---|---|---|---|---|---|
| 1 | `PHASE 1: HTF (MACRO)` | `str_ht` from `htf_state` (lines 1677–1678, 2414–2417) | None | `diagnostics.htf_state` (line 398) | Computed (unverified) | (b) |
| 2 | `PHASE 2: MTF (PROPHET)` | `str_mt` from `mtf_state` (lines 1680–1681, 2420–2423) | None | `diagnostics.mtf_state` (line 398) | Computed (unverified) | (b) |
| 3 | `PHASE 3: LTF (AEGIS/KIN)` | `str_lt` from `ltf_state` (lines 1683–1684, 2426–2429) | None | `diagnostics.ltf_state` (line 398) | Computed (unverified) | (b) |
| 4 | `PHASE 4: EXIT (KTS/TP)` | `str_ex` from `ext_state` (lines 1686–1687, 2432–2435) | None | `diagnostics.ext_state` (line 398) | Computed (unverified) | (b) |

**Section E — Decision Matrix**

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity | Decision |
|---|---|---|---|---|---|---|
| 1 | `SCALP BURST INDEX` | `burst_txt`, `burst_score` (lines 1534–1562, 2442–2445) | None | `burst_score` not in diagnostics | Computed (not exposed) | (c) |
| 2 | `ACTION VERDICT` | `verdict` text (lines 1179–1305, 2448–2451) | `verdict` (`gmi_v12_70`) | `comparable.verdict` in `gmi-core.mjs` (line 395) | Verified | (a) |
| 3 | `EXECUTE` | `ai_decision` (lines 1181, 1206–1304, 2454–2457) | None | derived from `verdict` + override branch; `branch` is in diagnostics (line 397) | Computed (partial) | (b) derived reading |
| 4 | `SYSTEM GUARD` | `is_chaos` (lines 444, 2460–2463) | None | `diagnostics.is_chaos` (line 398) | Computed (unverified) | (b) |

**Section F — Grid Bot Protocol**

| # | HUD row label | Pine variable(s) | Webhook | Local coverage | Parity | Decision |
|---|---|---|---|---|---|---|
| 1 | `CSHI VIABILITY` | `cshi_grid` (lines 713, 2470–2473) | None | `cshi_engine` listed under MizanLib computed (not verified); not in GMI diagnostics | Computed (not exposed) | (c) |
| 2 | `DEPLOY STATUS` | `grid_status` (lines 715–729, 2476–2479) | None | not in diagnostics | Computed (not exposed) | (c) |
| 3 | `GRID RANGE (BOT-TOP)` | `c_grid_bot`/`c_grid_top` (lines 1495–1510, 2482–2485) | None | not in diagnostics | Not ported | (c) or (d) |
| 4 | `TRIGGER PRICE` | `trigger_px` (lines 1511–1515, 2488–2491) | None | not in diagnostics | Not ported | (c) or (d) |
| 5 | `GRID QUANTITY (1.3%)` | `grid_count` (lines 1517–1519, 2494–2497) | None | not in diagnostics | Not ported | (c) or (d) |
| 6 | `TAKE PROFIT / STOP LOSS` | `str_g_tpsl` = `c_grid_tp`/`c_grid_sl` (lines 1500–1509, 2500–2503) | None | not in diagnostics | Not ported | (c) or (d) |

---

## 2. Data-Source Decisions & Non-Reproducible HUD Rows

### 2.1 Breakdown across decisions

Counting every HUD row inventoried in §1 (9 HUDs, ~75 rows total):

| Decision | Count (approx.) | Examples |
|---|---|---|
| (a) existing webhook field | ~8 rows | Funnel Confirmed/HQ; Prophet HUD Structure; GMI Decision Matrix Action Verdict; Aegis PA Structure |
| (b) existing local engine output (unverified unless parity-approved) | ~22 rows | Prophet HUD Market/Harmonic/Momentum; Kinetic θ/ω/α/entropy/phase; Fabio POC/VA/squeeze; MTF Hurst; Playbook phases; System Guard |
| (c) new local computation + parity comparator | ~30 rows | Interstellar Eyes camarilla bands; Chronos sessions/asian range/CPR; Fabio LVN 1/2, HVN, MML, SMR, Fabio model status, progressive SL; Aegis buy/sell vol, delta, CVD, surge, whale; Tactical Muscles, Macro & Aether most rows; Grid Bot most rows; funnel counters |
| (d) richer alert payload via `pinescript/candidates/` | ~15 rows | Trade Management Action/Entry/TP/Exit; Interstellar Eyes (if we want TV's own band labels); Grid Bot grid range/trigger/qty/TP-SL; SMC buy/sell zone; progressive SL; entry candidate |

Preference (a)/(b) over (c)/(d): (a) and (b) reuse data already flowing (webhook or local engine), so no Pine change, no owner install step, and no new parity surface beyond what exists. (c) needs implementation plus a comparator and, for HUD-only rows, often no webhook counterpart exists so parity can never be earned → must be labelled UNVERIFIED forever (acceptable for informational HUD readings, but must be labelled). (d) requires the owner to install a candidate alert and changes the canonical Pine contract; reserve for rows that are chart-stateful or TradingView-feed-dependent and cannot be recomputed from OHLCV.

### 2.2 HUD rows that cannot be reproduced locally (plainly)

1. **Trade Management Action / Entry candidate / TP / Exit (Prophet R38 cols 5–8).** These depend on the full OB lifecycle (progressive mitigation, expiry, per-direction caps), target latching (`bias_tp_latched`), R:R gating, position-management state (`position_mode`, `position_entry`, `tp_reached`, `reversal_confirmed`) and chart-relative `bar_index`/`structure_state`. Only `t_enc` and `d_enc` are parity fields; OB ranking and entry-level latching are explicitly "Not ported" in `LOCAL_COMPUTATION_OWNERSHIP.md`. Cannot be reproduced from OHLCV alone without re-implementing the whole OB engine (a large (c)) or richer alert payloads (d). Recommended: (d) a richer `prophet_r38` alert carrying `entry_candidate_txt`, `tp_txt`, `exit_txt`, `best_buy_ob_*`, `best_sell_ob_*`, `buy_rr`/`sell_rr`, gated behind a candidate alert the owner installs.

2. **Interstellar Eyes camarilla bands.** `camarilla_extended` exists in MizanLib (computed, not verified) but is not wired into the GMI lane, and there is no webhook counterpart (TradingView's `request.security` multi-TF camarilla is feed-derived). Reproducible in principle via (c) but parity can never be earned → always UNVERIFIED unless (d) adds a `camarilla` webhook field.

3. **Chronos Matrix sessions / Asian range / weekly & daily CPR / S/R.** Multi-timeframe HTF values; reproducible from the OHLCV bundle (D1/W1/M1) via (c), but no webhook counterpart exists today, so parity can never be earned. Daily CPR uses previous completed daily candle (available in bundle). Asian range needs M1 bars during the Tokyo session window. Recommend (c) for computation, labelled UNVERIFIED, with an optional (d) to earn parity.

4. **Fabio AMT progressive SL, MML liquidity, SMR, Fabio model status, LVN 2, HVN.** `tdmProfileAt` (mizan.mjs) already computes LVN 1/2 and POC/VAH/VAL, but HVN and the Fabio M1/M2 decision require intrabar footprint and session flags; progressive SL depends on OB lifecycle and position state. Recommend (c) to expose the already-computed fields, (d) for progressive SL and Fabio model status (chart-stateful).

5. **Aegis Footprint buy/sell volume, delta, CVD, surge, whale activity.** Computed internally by GMI from M1 intrabars (`request.security_lower_tf`), which the local engine cannot reproduce exactly (TradingView's intrabar fetch). The local GMI engine approximates with chart bars but is not in diagnostics. Recommend (b) where the local engine exposes it, labelled UNVERIFIED; (d) if exact parity with TradingView's LTF footprint is required.

6. **Grid Bot Protocol (range, trigger, qty, TP/SL).** Depends on `g_poc_dir`, `struct_h`/`struct_l` (chart-relative), and OB levels. Recommend (d) or accept (c) as UNVERIFIED.

7. **R37 Funnel cumulative counters.** `var int` cumulative state with reset-on-candidate semantics; not a per-bar value. Cannot be reproduced from a single closed bar. Recommend (d) or drop from agent evidence (treat as informational only).

8. **Prophet HUD Market (CSHI score) and Momentum (pro_fast delta).** CSHI score and the one-bar momentum delta are computed in Pine but not exposed by the local engine's `core.mjs` output surface (the local engine emits `sensors` and `oscillator` but not `cshi_score` or `pro_fast[1]`). Reproducible via (c) with small additions. Recommended (c).

### 2.3 What is already trustworthy (verified) and can be cited directly

- `direction`, `buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`, `t_enc`, `d_enc`, `structure_subtype` (prophet_r38).
- `direction`, `d_enc`, `b_enc`, `structure_subtype`, `bull_event`, `bear_event` (prophet_r37_ssot).
- `verdict`, `gate`, `gmi_dir`, `prophet_dir`, `conflict` (gmi_v12_70).

Everything else is UNVERIFIED and must be labelled as such in agent evidence and UI.

---

## 3. Model Call & Cost Assessment

### 3.1 Baseline (existing)

- Multi-agent bus: 20 calls/hour cap, ~5 calls per H1 candle (technical + news × 2 rounds + moderator).
- Live 15m room: 36 calls/hour cap, 12 used (4 rooms × 3 calls).
- Per-call: 60 s timeout, primary `@cf/zai-org/glm-5.3-flash` → fallback `@cf/zai-org/glm-4.7-flash` on first primary failure; wall budget 300 s per queue task; one correction call (counted) on natural-language failure only.

### 3.2 Option 1 — 9 HUD agents (one per HUD table) + 1 moderator

Base calls per H1 candle: 9 (agents) + 1 (moderator) = **10**.

Worst case with one natural-language correction retry per agent (no moderator retry assumed, moderator is a single consensus call): 9 (agents) + 9 (corrections) + 1 (moderator) = **19**.

Per hour (one H1 close per hour, no live-room participation): **10 base / 19 worst case**.

### 3.3 Option 2 — 14 HUD agents (Matrix & Omega split into 6) + 1 moderator

Base calls per H1 candle: 14 + 1 = **15**.

Worst case with one correction per agent: 14 + 14 + 1 = **29**.

Per hour: **15 base / 29 worst case**.

### 3.4 Comparison against existing budgets

| Budget | Value | Option 1 base | Option 1 worst | Option 2 base | Option 2 worst |
|---|---|---|---|---|---|
| `MULTI_AGENT_MAX_CALLS_PER_HOUR` | 20 | 10 | 19 (fits, 1 spare) | 15 | 29 (exceeds by 9) |
| `LIVE_ROOM_MAX_CALLS_PER_HOUR` | 36 | 12 (room base) | — | 12 | — |
| Wall budget per queue task | 300 s | 10 × ~10–25 s = ~100–250 s (fits) | 19 × ~10–25 s = ~190–475 s (may exceed) | 15 × ~10–25 s = ~150–375 s (may exceed) | 29 × ~10–25 s = ~290–725 s (exceeds) |

Both options fit the hourly cap at base, but Option 2's worst case exceeds it, and the wall budget is tight for both once correction retries accumulate. Sequential execution is not safe for Option 2.

### 3.5 Proposed design

1. **New env var `HUD_AGENTS_MAX_CALLS_PER_HOUR`**, default **15** for Option 1, **25** if Option 2 is chosen. Fail closed when exceeded (same pattern as `MULTI_AGENT_MAX_CALLS_PER_HOUR`).
2. **Parallel fan-out within a single queue task**: dispatch all HUD agents concurrently (Promise.allSettled) with a shared 240 s sub-budget inside the 300 s task, then run the moderator after all settle. This keeps wall time ~max(agent latency) + moderator instead of sum.
3. **Correction retries are serialised and capped**: at most 3 correction calls total per run (not one per agent), prioritised by agents whose output failed the natural-language validator. A second failure stays `invalid_output`.
4. **Per-agent model**: reuse `MULTI_AGENT_MODEL` (`@cf/zai-org/glm-5.3-flash`) with `MULTI_AGENT_FALLBACK_MODEL` on first primary failure; after the first primary failure in a run, remaining steps go straight to fallback (same rule as the bus).
5. **No paid fallback in the live 15m room** (primary only), consistent with the existing live-room rule.
6. **Idempotency**: key each run by `(candle_key, run_id)`; a re-run for the same candle reuses stored messages and does not re-spend budget (same as `claimAnalysisRun`).

### 3.6 Recommended option

**Option 1 (9 agents)** as the default. It fits the existing hourly cap at base with margin, fits the wall budget with parallel fan-out, and keeps the correction-retry worst case inside the cap. Option 2 (14 agents) is viable only if the owner accepts a higher cap (25) and the extra cost of 5 more model calls per H1 candle; the marginal value of splitting "Matrix & Omega Sensors" into 6 agents is debatable because several sections (Tactical Muscles, Macro & Aether) share the same underlying GMI diagnostics.

---

## 4. Speaking Schedule: Threads 1H vs. Live 15m Room

### 4.1 Threads 1H (every closed H1 bar)

All 9 (or 14) HUD agents post as replies under the H1 thread, after the H1 synthesis is persisted and the bus has run. Order:

1. Bus agents (`technical`, `news`) and `moderator` consensus (existing).
2. HUD agents, each posting a reading derived only from its own HUD data plus the authoritative H1 decision.
3. A final `moderator` summary of the HUD agents (one extra call, already counted in §3.2).

Each HUD agent's evidence is limited to its own HUD plus the H1 decision; no agent sees another HUD's data or the raw model outputs.

### 4.2 Live 15m Room (subset only)

Data availability at 15m/5m vs H1:

| HUD agent | Data available at 15m? | Speak in live room? | Rationale |
|---|---|---|---|
| Trade Management (Prophet R38) | `t_enc`, `d_enc`, `direction` are per-bar H1 fields; at 15m only the 5m Prophet context (unverified) exists | Yes (every 15m close) | Trade-management state is the most time-sensitive HUD; but it must be labelled UNVERIFIED 15m and never override the H1 decision |
| Kinetic Engine (TVA) | θ/ω/α/entropy are computable on any timeframe; at 15m only from 5m context (unverified) | Yes (every 15m close) | Kinetics are the natural "execution timing" signal for the live room |
| Fabio AMT Sensors | POC/VA/LVN/HVN from a 15m/5m volume profile; squeeze state from 5m footprint | Yes (every 15m close) | Fabio AMT is explicitly an execution-timing model (M1/M2 sessions) |
| Aegis Footprint Matrix | Footprint from M1 intrabars; available at 15m via LTF fetch | Optional (every 15m close) | Useful for absorption/squeeze detection but adds a 4th agent; recommend opt-in via flag |
| R37 Funnel | Cumulative counters, H1-only semantics | No | Not meaningful at 15m |
| Prophet HUD (Market/Harmonic/Structure/Momentum) | All H1-derived | No | H1 backdrop only |
| The Interstellar Eyes | Camarilla bands exist per timeframe already (5m/15m columns in the table) | No | Price bands are static reference levels; no need to re-speak per 15m |
| Chronos Matrix | Sessions/CPR are H1/D1/W1-derived | No | No intraday change |
| Matrix & Omega Sensors | Mixed; some sections (Tactical Muscles, Decision Matrix) are H1-derived | No | Too broad for the live room; H1 backdrop only |

Live-room additions: 3 agents × 4 rooms = 12 extra calls/hour (or 4 agents = 16). Added to the existing 12 room calls = 24–28, still under the 36 cap. If Aegis is included, the cap holds with 4 spare.

### 4.3 Evidence rules in the live room (unchanged)

- `m15`: closed 15m candles (setup).
- `m5`: UNVERIFIED 5m Prophet read (execution timing).
- `h1`: H1 decision and H1 TradingView reading (backdrop).
- `news`: latest news-thread consensus.
- The moderator must state the H1 decision whenever its stance differs from it.
- Primary model only, never the paid fallback.

---

## 5. Risks, Guardrails & Open Questions for the Owner

### 5.1 Architectural risks

1. **Wall-clock overrun.** Sequential agent calls (9–14 agents + moderator + corrections) can exceed the 300 s queue-task budget. Mitigation: parallel fan-out (§3.5.2) and a 3-correction cap.
2. **Hourly cap exhaustion.** Option 2's worst case (29) exceeds the 20-call cap. Mitigation: Option 1 as default, or raise `HUD_AGENTS_MAX_CALLS_PER_HOUR` to 25 and accept the cost.
3. **Advisory-only compliance (SSOT §5, brief §0.5).** Several HUD rows display levels that look like instructions: Trade Management entry candidate (BUY/SELL LIMIT, INV, R:R), progressive SL, HVN "STOP LOSS", Grid Bot TP/SL, SMC buy/sell zone, Fabio model status. Agents must report these as "the HUD shows …" and never as instructions. The existing natural-language validator (`src/natural-language.mjs`) rejects field names and key paths but does not catch imperative phrasing; add a prompt-level guardrail and a reviewer check in preview-e2e.
4. **Unverified data labelling.** ~80% of HUD rows are UNVERIFIED (computed but not parity-approved, or not ported). Agents must prefix such readings with "unverified" / "the local engine shows (unverified)" and the UI must show the UNVERIFIED badge, consistent with the 5m context rule.
5. **Natural-language validator compliance.** HUD readings are code-to-sentence decoders (one per HUD, following `src/webhook-interpretation.mjs`). Every code path needs a test; the model never sees raw codes without their meaning. Correction calls count against the budget.
6. **No new Workers, no manual deploys.** All HUD-agent runtime lives in the existing AI Worker (`src/`) behind `HUD_AGENTS_ENABLED` (off in production, on in preview). No new Worker, no `wrangler deploy` by hand.
7. **Pine sources untouched.** HUD data for (a)/(b)/(c) comes from existing webhook fields or local engines. (d) requires a candidate in `pinescript/candidates/` and owner installation; do not edit `pinescript/ssot/*`.
8. **Idempotency per (candle, run).** Re-running a candle must not re-spend budget or duplicate messages; reuse `claimAnalysisRun`-style claiming.
9. **Feature flag.** `HUD_AGENTS_ENABLED` off in `wrangler.jsonc` (production), on in `wrangler.preview.jsonc`, with preview-e2e proof that every HUD agent answers on the primary model in natural language before production enablement (owner approval required).

### 5.2 Open questions for the owner

1. **9 vs. 14 agents for "Matrix & Omega Sensors".** Default = one agent for the whole `hud_tdm` table (9 agents total). Alternative = one agent per titled section (14 agents, 5 more model calls per H1 candle, and the hourly cap must rise from 15 to 25). Which do you prefer?
2. **Name of the untitled top-right Prophet table.** Pine line 1074 creates `hud` with no title. Proposed display name "Prophet HUD". Confirm or rename.
3. **Live 15m Room participation.** Proposed subset: Trade Management, Kinetic Engine (TVA), Fabio AMT Sensors, optionally Aegis Footprint Matrix (3–4 agents × 4 rooms = 12–16 calls, under the 36 cap). Approve the subset and whether Aegis is included.
4. **(d) Pine candidates vs. (b)/(c) local unverified readings.** For the ~15 rows that are chart-stateful or TradingView-feed-dependent (Trade Management entry/TP/exit, progressive SL, Grid Bot grid/trigger/qty/TP-SL, Interstellar Eyes camarilla bands, Chronos CPR/S-R, Fabio HVN/SMR/MML/model status), do you want (d) richer alert payloads (requires you to install candidate alerts on TradingView) for parity-eligible data, or accept (c) local unverified readings labelled UNVERIFIED? Recommend a hybrid: (c) for computation now, (d) later only where parity matters.
5. **Funnel agent.** The R37 Funnel counters are cumulative chart state with no webhook counterpart. Should the Funnel be an agent at all, or treated as informational only (no agent, no model call)?
6. **Budget.** Confirm `HUD_AGENTS_MAX_CALLS_PER_HOUR` default of 15 (Option 1) or set a different value.
7. **Moderator summary.** Should the HUD moderator produce a single consolidated summary (1 call) or per-HUD one-line verdicts aggregated client-side (0 calls)? Recommend the single summary.

---

## Appendix A — Quick reference: verified fields per source (for agent evidence)

| Source | Verified fields (parity-approved only after 24 matches) |
|---|---|
| `prophet_r38` | `direction`, `buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`, `t_enc`, `d_enc`, `structure_subtype` |
| `prophet_r37_ssot` | `direction`, `d_enc`, `b_enc`, `structure_subtype`, `bull_event`, `bear_event` |
| `gmi_v12_70` | `verdict`, `gate`, `gmi_dir`, `prophet_dir`, `conflict` |

All other HUD-derived values are UNVERIFIED and must be labelled accordingly.

## Appendix B — HUD inventory summary

| HUD (agent name) | Source file | Table | Rows | Default agent count |
|---|---|---|---|---|
| R37 Funnel | Prophet R38 | `funnel_table` (505) | 7 | 1 |
| Prophet HUD | Prophet R38 | `hud` (1074) | 4 | 1 |
| Trade Management | Prophet R38 | `trade_management_hud` (1075) | 9 | 1 |
| The Interstellar Eyes | GMI v12.70 | `hud_main` col 0 (221) | 9 | 1 |
| Kinetic Engine (TVA) | GMI v12.70 | `hud_main` col 7 (221) | 9 | 1 |
| Fabio AMT Sensors | GMI v12.70 | `hud_main` col 9 (221) | 10 | 1 |
| Chronos Matrix | GMI v12.70 | `hud_aegis` top (223) | 5 | 1 |
| Aegis Footprint Matrix | GMI v12.70 | `hud_aegis` lower (223) | 7 | 1 |
| Matrix & Omega Sensors | GMI v12.70 | `hud_tdm` (224) | 6 sections | 1 (or 6) |

Total: 9 agents (default) or 14 agents (Matrix & Omega split). Plus 1 moderator summary call.
