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
| Prophet R37 bridge candidate | `The_Prophet_v7.00_R37_GMI_FIRST_KEY_LEVEL_BRIDGE_CANDIDATE.pine` | `e237331e99e13c578b4ae4fdfbb28a3b066b131a591ff51b357c0d8b1777e4f9` | 1284 | Located in Library and copied to `pinescript/candidates/`; imports `CryptophysMizanLib/1`. Explicitly a candidate; final TradingView-installed identity and parity are not yet proven. |
| GMI R10.1.7 candidate | `Global Multiverse Interceptor [v12.70 THE SINGULARITY](2).txt` | `c0665ee005c4035e38e691936a81294e665039ac8b425102df63ce68301f3b9e` | 3041 | R10.1.7 visual-toggle candidate; imports library version 1. |
| GMI CTA webhook candidate | `GMI_v12_70_CTA_Webhook.pine` | `c96949b358c610d404817372139e497edd1fe9e3174354d27620dfffaa4e7623` | 2823 | R11 CPR context candidate based on R10.1.7; not the same hash as the audited baseline. |

## Version-alignment findings

1. Prophet R38 imports Mizan library v4; Prophet v7.00 baseline and the available GMI R10.1.7 candidate import Mizan library v1. A single unversioned Mizan result is not sufficient evidence of parity for both dependency versions.
2. The audit ledger records the GMI baseline SHA-256 as `c090e42649db03b34b8fd3fd17fcae2d611a418508dedb83d503eb268d28c736`. A Library artifact named `Global Multiverse Interceptor [v12.70 THE SINGULARITY].txt` is now located, alongside several R10/R11 candidates, but the available raw-byte materialization path is denied; therefore the ledger hash has not yet been independently matched to that exact artifact.
3. A Prophet v7.00 R37 GMI-first key-level bridge candidate was found in the Library and copied into the repository candidate folder. This resolves the prior no-candidate search result, but does not prove it is the exact source installed in TradingView or the final producer for `prophet_r37_ssot`; its filename and indicator title explicitly mark it as a candidate.
4. The repository's existing inbound sources are `prophet_r38`, `prophet_r37_ssot`, and `gmi_v12_70`. Those source identifiers do not by themselves prove which Pine source revision or Mizan library version generated a given value.

## Required before implementing/promoting local engines

- Confirm the owner-approved final revision for `prophet_r37_ssot` against the located R37 candidate and confirm the GMI baseline file bytes against the audit-ledger hash.
- Approve the dependency matrix (including whether both Mizan v1 and v4 outputs are required per candle).
- Define per-engine output schemas and map fields to the source's actual exported series/alert payloads.
- Implement deterministic kernels against the approved hashes; record implementation SHA-256 separately from Pine source SHA-256.
- Build fixtures from known source outputs and compare every required value across bars, missing inputs, unconfirmed/forming candles, and timeframe boundaries.
- Run TradingView compile/replay/alert validation for the source revisions. Static source review alone is not parity evidence.

Until those items pass, `POST /evidence/local-calculation` is only a validated ingestion contract. It must not be treated as proof that local Mizan/Prophet/GMI engines exist or are correct, and the production Worker must not receive an approved provenance allowlist for placeholder implementations.
