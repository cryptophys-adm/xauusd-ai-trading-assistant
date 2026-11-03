# Local computation: who computes what

This page is the single answer to "who computes the Pine parameters locally". The answer is one Worker, deployed only from `main`.

## Owner
`xauusd-tradingview-pull-adapter` (source `market-data-ingestion/`, deployed by `deploy-market-data-ingestion.yml`).

1. **Every 5 minutes:** it pulls closed TradingView OHLCV for XAUUSD M1/M5/M15/H1/H4/D1/W1, plus USOIL, DXY and USDT. The pull goes through the news Worker's `TvGateway` RPC, which uses the single TradingView MCP OAuth grant.
2. **On every closed H1 bar:** it runs the three local engines in `local-engines/producer/src/h1-producer.mjs`:
   - **MizanLib** (record id `mizan`): `src/prophet-r37-kernel.mjs` and `src/prophet-r37-oscillator.mjs`, plus `local-engines/gmi/src/mizan.mjs`.
   - **Prophet**: `local-engines/prophet-r38/src/core.mjs`, plus the shared core above.
   - **GMI**: `local-engines/gmi/src/gmi-core.mjs`.
3. **Publishing:** it sends the three records to the AI Worker over the `LocalComputationIngress` RPC entrypoint. The AI Worker compares each record field by field with the TradingView webhooks for the same candle. An engine identity is trusted (`approved_by_parity`) only after 24 consecutive matching candles. Any mismatch revokes it.

The following Workers are **not** part of this:
- `xauusd-mizan-engine`, `xauusd-prophet-engine` and `xauusd-gmi-engine`, which were stubs;
- `xauusd-market-data-normalizer` and `xauusd-pull-orchestrator`;
- `xauusd-confluence-controller`.

They were removed by `.github/workflows/decommission-legacy-workers.yml`. Do not deploy Workers by hand. A manual deploy on 2026-11-03 replaced the pull adapter with a stub and stopped this lane for about six hours.

## Coverage (honest scope)
Status meanings:
- **Verified:** compared with TradingView on every H1 candle.
- **Computed:** ported from the Pine source and run, but not compared. These values appear only as `diagnostics` or engine internals.
- **Not ported:** not computed locally.

| Pine | Verified (parity-checked fields) | Computed, not verified | Not ported |
|---|---|---|---|
| **MizanLib** (`CryptophysMizanLib/4`) | Indirectly, through Prophet and GMI: `prophet_structure_core` (`d_enc`, `b_enc`, subtype, events) and `calculate_prophet_tensor` (`pro_fast` sign) | `kww_calc`, `kww_zscore`, `hurst_rs`, `entropy_calc`, `efficiency_ratio`, `vol_anomaly`, `prophet_volume_ratio`, `f_vol_cycle`, `spacetime_warp`, `return_distribution`, `get_jurik`, `tdm_profile`, `footprint_from_arrays`, `fabio_decision`, `ob_progressive_update`, `ob_high_volume` | Functions used only by GMI panels that do not affect the compared fields: `calculate_cone`, `camarilla_extended`, `daily_cpr_stats`, `cshi_engine`, `macro_kinematics`, `macro_penalty`, `q_gravity`, `fvg_*`, `ext_profile_*`/`ext_update_intra` (external session VP). Exports neither indicator imports are not needed. |
| **Prophet R38** | `direction`, `buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`, `t_enc`, `d_enc`, `structure_subtype` | Oscillator (fast/slow/core), sensors (KWW z-score, Hurst, efficiency ratio, volume ratio/anomaly, ATR, cycle intensity), HTF alignment, OB zone lifecycle/ranking, buy/sell stop levels and R:R | Position-management states beyond `t_enc`, TP-hit/target latching lifecycle, chart rendering and HUD |
| **Prophet R37 shared core** (inside GMI) | `direction` (consensus), `d_enc`, `b_enc`, `structure_subtype`, `bull_event`, `bear_event` | `pro_slow`, `pro_core` | `structure_state` (chart-relative `bar_index`, not comparable) |
| **GMI v12.70** | `verdict`, `gate`, `gmi_dir`, `prophet_dir`, `conflict` | TVA kinetics (θ/ω/α, estimated reversal bars), entropy/chaos, htf/mtf/ltf/ext states, TDM profile (VAH/VAL/POC/LVN), M1 footprint status, volume veto, whale zones, Aegis OBs, GABFX QM/RBS/SBR, Fabio M1/M2, JMA, override branch | CPR context (non-vetoing), Camarilla, singularity cone, macro/USOIL/DXY panels, external session volume profile, CSHI grid, Q-gravity, FVG mass, HUD/rendering |

Known approximations in GMI are listed in `docs/LOCAL_GMI_ENGINE.md`.

## How to extend coverage
To verify a "computed" or "not ported" value, it needs a TradingView comparator. The steps are:
1. Add the field to the Pine webhook payload.
2. Add it to `PARITY_FIELDS` in `src/parity-registry.mjs`.
3. Emit it in `values.comparable` from the producer.
4. Add its meaning to `knowledge/kb-v4.mjs`, with a Pine line citation.

Until then, agents must treat it as unverified. Knowledge base v4 already says so.
