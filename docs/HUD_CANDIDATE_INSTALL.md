# HUD candidate install instructions (owner)

Phase C1. Documents only; no runtime change.

## What you install

1. Open TradingView, load the chart for `OANDA:XAUUSD`.
2. Replace the indicator with the candidate file from this repository:
   - `pinescript/candidates/The-Prophet-v7.02-R38.hud.v1.txt`
   - `pinescript/candidates/Global-Multiverse-Interceptor-v12.70.hud.v1.txt`
3. Save and add to chart.

## Alerts

Create two "Any alert() function call" alerts pointing at `https://ai.cryptophys.work/webhook` with the webhook secret:

- **H1 alert** on the H1 chart (existing alert, updated to the candidate).
- **15m alert** on the 15m chart (new).

Both alerts carry the original `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70` payloads byte-for-byte, plus the separate `prophet_r38_hud` and `gmi_v12_70_hud` payloads.

The `gmi_v12_70_hud` payload also carries the Grid Bot Protocol fields (2026-11-07): `cshi_viability`, `deploy_status` (1 muddy waters, 2 toxic chop, 3 optimal, 4 trending or dead), `muddy_waters` and `grid_viable`. The AI Worker compares them with its own `gmi_hud` record for the H1 candle.

## After install

- The 24-candle parity clock for the HUD identities starts only after the first `*_hud` webhook arrives.
- Until 24/24, HUD values stay UNVERIFIED.
- Do not remove the original indicator until the candidate is confirmed working.
