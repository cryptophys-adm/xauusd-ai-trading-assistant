# Pine SSOT verification (2026-11-03)

This page records how the files in `pinescript/ssot/` were checked against what is installed and running in TradingView.

## Naming
- **Local computation engines:** MizanLib (record engine id `mizan`), Prophet (`prophet`) and GMI (`gmi`).
- **TradingView webhook sources:** `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70`.
  - `prophet_r37_ssot` is the shared Prophet structure core that GMI computes from MizanLib.
  - These source names are also the keys of `values.comparable` in local records. They are not local engine names.

## Results
| Check | Prophet R38 | GMI v12.70 | MizanLib |
|---|---|---|---|
| Indicator title equals the installed indicator | ✅ `The Prophet v7.02 (MizanLib Shared Core) · R38` | ✅ `Global Multiverse Interceptor [v12.70 THE SINGULARITY] · R10.1.5 SEPARATE CHRONOS HUD` | n/a (library) |
| Every non-boolean input default equals the installed alert's settings, in order | ✅ 33/33 | ✅ 37/37 | n/a |
| Webhook payload keys equal the keys actually delivered | ✅ | ✅ (both `prophet_r37_ssot` and `gmi_v12_70`) | n/a |
| Import path | `cryptophys/CryptophysMizanLib/4` | `cryptophys/CryptophysMizanLib/4` | — |
| Functional parity with TradingView output | ✅ every candle matched so far (24 fields, including MizanLib structure fields) | ⏳ first comparison from 15:00 UTC | indirect (via Prophet and GMI) |
| Content equals the owner's export of the published library | n/a | n/a | ✅ identical code (2026-11-03) |

These checks are enforced by tests:
- `test/pine-installed-inputs.test.mjs` checks titles, input defaults and payload keys.
- `test/knowledge-base.test.mjs` checks that the 53 cited Pine lines still contain the quoted text.

Source SHA-256 of the current files:
- `The-Prophet-v7.02-R38.txt`: `71a9e933f7a123545125ed075a7bf1940c7cc1930396b6112a8e480f2d5aedc9`
- `Global-Multiverse-Interceptor-v12.70.txt`: `f9115eb0224a6f68f212a368a662be57dd2810d1a6adc0abbe1b2ce570ee2c94`
- `CryptophysMizanLib-uploaded.txt`: `755ab68cb0ed9bd536c4e83eb71b09f804424cc1027b811f486906a3625aba59`

## Open items
1. **MizanLib: resolved on 2026-11-03.**
   - The owner pasted the source of the published `CryptophysMizanLib/4` and it was compared line by line with the repo copy: all 1,190 lines, Sections 1–32, are identical.
   - The only differences are trailing whitespace on 8 lines and the final newline, which the chat paste does not preserve. No code, constant or comment differs.
   - The repo copy was therefore kept unchanged, so the MizanLib engine identity and the parity history stay intact.
   - The earlier byte-size mismatch with the recorded raw artifact (73,727 bytes versus 73,681) is a whitespace and line-ending difference only.
2. **Boolean inputs.** TradingView alert names do not show boolean inputs, for example `legacy_mode`, `shared_prophet_alignment` and `use_vol_veto`. The engines assume the Pine defaults; the parity registry will flag any deviation.
3. **GMI header comments.** The GMI file header says "R11 CPR CONTEXT ENGINE CANDIDATE — BASED ON USER-UPLOADED R10.1.7" and "static transformation only… NOT yet verified". The installed indicator title and settings match this file, so these comments are stale. They are left untouched to preserve the source bytes.
