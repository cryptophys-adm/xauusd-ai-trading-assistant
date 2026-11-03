# Local GMI v12.70 Engine

Status: implemented (`local-engines/gmi`). It is published every closed 1H bar as the `gmi` record of the `local_computation` lane. It is trusted only after the autonomous parity registry has seen 24 consecutive candles that match the TradingView `gmi_v12_70` webhook.

## Scope

The engine reproduces the series that determine the five `gmi_v12_70` webhook fields on a confirmed `OANDA:XAUUSD` 1H bar, using the default indicator inputs:

| Field | Pine source |
|---|---|
| `verdict` | `verdict_state` after the full override chain and the R10 gate |
| `gate` | `r10_gate_status` (0 inactive, -2 invalid profile, -1 conflict, 2 aligned, 1 otherwise) |
| `gmi_dir` | `r10_gmi_dir`, taken from `verdict_state` before the gate reset |
| `prophet_dir` | `r10_prophet_consensus_dir` (shared Prophet core) |
| `conflict` | `r10_integration_conflict` |

The verdict path is ported in source order:
1. **Adaptive TVA regression kinetics** (θ/ω/α, `est_rev_bars`) with the KWW spacetime warp.
2. **State inputs:** entropy, efficiency and chaos; KWW; return distribution; and MTF Hurst (15/60/240/D/W).
3. **TDM volume profile** (VAH/VAL/POC/LVN) with the 3-bar fakeout memory.
4. **Aegis footprint** from TradingView M1 intrabars: squeeze, absorption, limit wall and CVD divergence.
5. **Shared Prophet core:** `pro_fast`, `d_enc` and subtype, reused from the R37 kernel.
6. **Zone and setup detectors:**
   - whale zones with mitigation (5-slot ring);
   - Aegis validated order blocks with progressive mitigation, expiry and per-direction caps;
   - GABFX QM/RBS/SBR from 14/14 pivots;
   - Fabio M1/M2 with the New York and London sessions (America/New_York);
   - JMA percent-rank kinetics.
7. **Overrides, in order:** entropy trap → volume veto → GABFX → Fabio M1/M2 → JMA → kinetic reversal.
8. **R10 shared Prophet × GMI × VP confluence gate.**

Rendering, HUD tables, CPR context (non-vetoing), macro/USOIL/DXY context and grid/position logic do not affect these fields and are not ported.

## Known approximations (resolved only by the parity registry)

1. **MTF Hurst:** uses realtime-at-close semantics. The developing 240/D/W bar is aggregated from chart bars since the last native bar's nominal close.
2. **History depth:** the cached window (1000 H1 bars) rather than the chart's full history. `var` levels (QM/RBS/SBR) older than the window are not reconstructed.
3. **`ta.pivothigh`/`ta.pivotlow` ties:** handled as strict inequality on both sides.
4. **`request.financial`:** treated as unavailable for `OANDA:XAUUSD`, so `has_funda = false`.

The record also includes non-compared `diagnostics`: which override branch fired, and the htf/mtf/ltf/ext states, footprint status, profile levels, kinetics and zone flags. When the registry reports a mismatch, these show which stage diverged.
