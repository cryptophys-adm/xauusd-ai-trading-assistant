# Local Calculation Source Baseline and Parity Blockers

Status: source artifacts were located in the ChatGPT Library and hashed locally. This is a provenance inventory, **not** a claim of TradingView parity or production approval.

## Owner-designated final SSOT update (2026-11-02)

The owner corrected the earlier mislabeled MizanLib attachment and supplied `CryptophysMizanLib(9).txt`. The repository's canonical uploaded artifact is `pinescript/ssot/CryptophysMizanLib-uploaded.txt` (1190 lines, source begins with `//@version=6` and declares `library("CryptophysMizanLib", overlay=false)`). Raw uploaded attachment SHA-256: `252139fc8b5bb056af817deab152da6376923ae5647cba3b0413dc2abd024f89`. The prior `CryptophysMizanLib(8).txt` was not a library and is superseded; do not use it for implementation or parity claims.

This corrected source is now the owner-designated MizanLib SSOT. The older v1.6.1/v4 rows below remain historical audit artifacts, not substitutes for this uploaded source. The published TradingView library revision consumed by each indicator and exact output parity still require evidence from the final installed indicator/import configuration; do not infer a published version number from the source filename or internal comment alone.

## Exact artifacts inspected

| Role | Artifact | SHA-256 | Lines | Status / dependency |
|---|---|---|---:|---|
| Mizan library v1.6.1 | `CryptophysMizanLib_v1.6.1_Hardening_R1.pine` | `d3538dd4fdee185f4ccef5cd68aabb22dbc0281ff2a50c31b233b19d5060af70` | 635 | Matches the audited v1.6.1 hash; R1 is byte-identical to the recorded baseline. |
| Mizan library v4 | `CryptophysMizanLib_v4.pine` | `6c44d6bf2dbf7df525e2060cd166daf4b896c7d257ceb66fd787f4017880ceb3` | 1190 | Separate library revision with 96 exports, versus 70 in v1.6.1. Prophet R38 imports library version 4. |
| Prophet v7.00 baseline | `The Prophet v7.00 (The Omniscient SSOT).txt` | `ff481f4bed71baac2f11663b8fc8d6d1c10bf15fb0a5d336a5a69fd082f32e4a` | 331 | Baseline indicator; imports `CryptophysMizanLib/1`. |
| Prophet v7.00 R7 candidate | `The_Prophet_v7.00_STRUCTURE_LABEL_ALIGNMENT_R7.pine` | `7f8220b395fdbc61fe4d16142cabdc294dd7b1b12082b9d8de160d858913882f` | 344 | Diagnostic/display candidate, not interchangeable with the baseline without approval. |
| Prophet R38 webhook source | `Prophet_R38_CTA_Webhook.pine` | `073639144880528bbb00fa541a50d16631a8a3c22b619dae4fb207e6337ff1b4` | 1141 | Indicator identifies as Prophet v7.02 R38 and imports `CryptophysMizanLib/4`. |
| Prophet R37 bridge candidate | `The_Prophet_v7.00_R37_GMI_FIRST_KEY_LEVEL_BRIDGE_CANDIDATE.pine` | `e237331e99e13c578b4ae4fdfbb28a3b066b131a591ff51b357c0d8b1777e4f9` | 1284 | Located in Library; original artifact SHA-256 is recorded here. A text-normalized LF copy is preserved in `pinescript/candidates/`; its Git blob identity is separate. Imports `CryptophysMizanLib/1`. Explicitly a candidate; final TradingView-installed identity and parity are not yet proven. |
| GMI R10.1.7 candidate | `Global Multiverse Interceptor [v12.70 THE SINGULARITY](2).txt` | `c0665ee005c4035e38e691936a81294e665039ac8b425102df63ce68301f3b9e` | 3041 | R10.1.7 visual-toggle candidate; imports library version 1. |
| GMI CTA webhook candidate | `GMI_v12_70_CTA_Webhook.pine` | `c96949b358c610d404817372139e497edd1fe9e3174354d27620dfffaa4e7623` | 2823 | R11 CPR context candidate based on R10.1.7; not the same hash as the audited baseline. |

## Version-alignment findings

1. Prophet R38 imports Mizan library v4; Prophet v7.00 baseline and the available GMI R10.1.7 candidate import Mizan library v1. A single unversioned Mizan result is not sufficient evidence of parity for both dependency versions.
2. The audit ledger records the GMI baseline SHA-256 as `c090e42649db03b34b8fd3fd17fcae2d611a418508dedb83d503eb268d28c736`. A Library artifact named `Global Multiverse Interceptor [v12.70 THE SINGULARITY].txt` is now located, alongside several R10/R11 candidates, but the available raw-byte materialization path is denied; therefore the ledger hash has not yet been independently matched to that exact artifact.
3. A standalone Prophet v7.00 R37 GMI-first key-level bridge candidate was found in the Library and copied into the repository candidate folder. Separately, the current repository GMI source contains a `CTA WEBHOOK — CORE SNAPSHOT` section that emits a distinct `prophet_r37_ssot` payload from the embedded/shared Prophet R37 structure core. This is the strongest source-level evidence for the webhook producer. The standalone file is still only a candidate; the exact GMI revision installed in TradingView and its byte identity against the audit-ledger baseline remain unverified.
4. The repository's existing inbound sources are `prophet_r38`, `prophet_r37_ssot`, and `gmi_v12_70`. Those source identifiers do not by themselves prove which Pine source revision or Mizan library version generated a given value.

## Required before implementing/promoting local engines

- Confirm the final installed GMI revision in TradingView and verify its source hash against the audit ledger; confirm that the embedded `prophet_r37_ssot` payload is the intended producer and capture its expected outputs for parity fixtures.
- Approve the dependency matrix (including whether both Mizan v1 and v4 outputs are required per candle).
- Define per-engine output schemas and map fields to the source's actual exported series/alert payloads.
- Implement deterministic kernels against the approved hashes; record implementation SHA-256 separately from Pine source SHA-256.
- Build fixtures from known source outputs and compare every required value across bars, missing inputs, unconfirmed/forming candles, and timeframe boundaries.
- Run TradingView compile/replay/alert validation for the source revisions. Static source review alone is not parity evidence.

Until those items pass, `POST /evidence/local-calculation` is only a validated ingestion contract. It must not be treated as proof that local Mizan/Prophet/GMI engines exist or are correct, and the production Worker must not receive an approved provenance allowlist for placeholder implementations.

## Owner confirmation and GMI calculation map (2026-11-02)

The owner explicitly confirmed that `pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt` is the GMI source installed in TradingView. Treat this repository file as the implementation source of record for the current task; do not reopen the installed-source question or substitute the other Library candidates. The Git blob is `808b6ca42c1fdee41bd40454cd6bcca36839f3e5` (Git blob identity, not a raw-file SHA-256). The file is 2,821 lines as returned by GitHub's file API. The embedded header calls itself an R11 CPR Context Engine candidate based on R10.1.7; that header is retained as source metadata, not grounds to replace the owner's installed-source designation.

### Source-derived functional map

| Concern | Source location / symbol | Observable role | Local parity scope |
|---|---|---|---|
| Multi-timeframe inputs | `f_mtf_data()` around line 426; `request.security()` usages | Retrieves timeframe-specific values used by the indicator. | Requires matching symbol, timeframe, bar alignment, lookahead/gaps behavior, and historical warm-up. |
| Shared Prophet structure | `lib.prophet_structure_core(...)` around line 883 | Produces `d_enc`, `b_enc`, structure state/subtype, bull/bear events, divergence and pivot fields. | Depends on the exact published Mizan library version and all arguments; must not be approximated by direction-only rules. |
| GMI verdict | `verdict_state` initialized around line 1157 and assigned through the decision block ending around line 1296 | Encodes the GMI verdict; downstream code maps 3/-3 to directional GMI states. | Implement the full ordered decision tree and its prerequisites, not just the final mapping. |
| Prophet consensus | `r10_prophet_consensus_dir` around line 1316 | Combines the internal Prophet direction and structure/divergence direction; internal conflict forces neutral. | Must reproduce source's precedence and conflict rules exactly. |
| Integration gate | `r10_integration_conflict`, `r10_directionally_aligned`, `r10_gate_status` around lines 1317-1326 | Evaluates GMI/Prophet/volume-profile alignment and can neutralize `verdict_state` when conflict is active. | Requires volume-profile outputs, integration flags, validity conditions, and exact neutralization order. |
| CPR context | `cpr_gmi_dir` around line 1336 and the R11 CPR section | Adds CPR context diagnostics. Header/changelog says this context is diagnostic and does not alter verdict, alerts, or VP calculations. | Do not use CPR diagnostic fields to change the directional verdict unless the source itself is changed and re-approved. |
| Webhook contract | `CTA WEBHOOK — CORE SNAPSHOT v1.3` at lines 2814-2819 | Default-off input; only emits on confirmed bars. Emits separate `prophet_r37_ssot` and `gmi_v12_70` payloads with candle OHLCV, time/symbol/timeframe, source-specific state, and secret. | Preserve source identifiers, field meanings, confirmed-bar gating, and both distinct payloads. Validate secret escaping and receiver schema independently. |
| Rendering / HUD | `f_render_*` functions around lines 1807-2530 | Builds visuals and dashboard tables. | Not part of the first numeric parity kernel unless rendered outputs are explicitly part of the API contract. |

### Direct Mizan dependency inventory

The GMI file imports `cryptophys/CryptophysMizanLib/4 as lib`. Calls observed in this GMI source include:

`calculate_cone`, `calculate_prophet_tensor`, `camarilla_extended`, `cshi_engine`, `daily_cpr_stats`, `efficiency_ratio`, `entropy_calc`, `ext_profile_calc`, `ext_profile_poc`, `ext_profile_value_levels`, `ext_update_intra`, `f_vol_cycle`, `fabio_decision`, `footprint_from_arrays`, `fvg_detect`, `fvg_mass_bear`, `fvg_mass_bull`, `gabfx_update`, `get_jurik`, `hurst_rs`, `kww_calc`, `kww_zscore`, `macro_kinematics`, `macro_penalty`, `ob_direction_state`, `ob_high_volume`, `ob_progressive_update`, `ob_volume_pivot`, `ob_zone_bounds`, `prophet_structure_core`, `prophet_volume_ratio`, `q_gravity`, `return_distribution`, `spacetime_warp`, `tdm_profile`, and `vol_anomaly`.

This list is the direct-call inventory found in the GMI file, not a claim that all exports contribute to the webhook verdict. Before implementation, trace the transitive dependency slice for the webhook fields and the exact verdict path. The repository's uploaded Mizan source identifies itself internally as v1.6 and is not proof that it is byte-identical to the published `/4` dependency. Do not silently bind GMI to that uploaded file or assume version parity.

### Next implementation sequence

1. Extract the numeric dependency slice from the GMI decision block and the called Mizan exports, including every input, default, stateful series, and `request.security` behavior that affects `verdict_state`, `r10_gate_status`, and the webhook payload.
2. Define versioned schemas for both webhook payloads and map each output field to its source expression. Keep the embedded Prophet R37 producer distinct from the GMI verdict producer.
3. Implement only the deterministic numeric slice in a dedicated module with explicit state and warm-up semantics. Exclude chart objects/HUD rendering from the calculation module.
4. Add fixture tests using captured outputs from the installed TradingView indicator on closed candles. Include neutral/conflict cases, missing volume/profile inputs, MTF boundaries, and first-valid-bar warm-up. No TradingView output fixture means parity remains unverified.
5. Compute SHA-256 from the exact canonical source bytes and from the finalized implementation files in a reproducible build step. Do not use a Git blob SHA as a SHA-256 allowlist entry. Do not populate `LOCAL_CALC_PROVENANCE_ALLOWLIST` or enable production rollout until the source hash, implementation hash, and parity fixtures are independently verified.

