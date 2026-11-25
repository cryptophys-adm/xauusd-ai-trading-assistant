# HUD candidate install instructions (owner)

Documents only; no runtime change. Nobody but the owner touches TradingView.

## Current install: the adoption HUD (B10, install by 2026-12-08)

RFC_INDICATOR_ADOPTION stages 1 to 6. Three files from `pinescript/candidates`:

- `Global-Multiverse-Interceptor-v12.70.hud.v2.txt` (title "… · R12 ADOPTION HUD")
- `The-Prophet-v7.02-R38.hud.v2.txt` (title "… · R38 ADOPTION HUD")
- `Cryptophys-Mizan-Probe.v1.txt` (title "Cryptophys Mizan Probe v1")

Each `*.hud.v2` file is its `*.hud.v1` file plus one alert block at the end. Its inputs, their defaults and the five
existing payloads (`prophet_r38`, `prophet_r37_ssot`, `gmi_v12_70`, `prophet_r38_hud`, `gmi_v12_70_hud`) are
unchanged, so the v2 alerts deliver everything the v1 alerts delivered.

### Steps

1. Open TradingView with the chart `OANDA:XAUUSD`.
2. On each of the **5m, 15m, 1H, 4H and 1D** charts, replace the v1 indicators with the v2 files:
   1. Add `Global-Multiverse-Interceptor-v12.70.hud.v2.txt` and `The-Prophet-v7.02-R38.hud.v2.txt` as new indicators
      (Pine Editor, paste, save, add to chart).
   2. In each one's settings, keep every default. Turn on **Enable CTA Webhook** and enter the webhook secret in the
      input **CTA Webhook Secret** (the last input). Never put the secret anywhere else.
   3. Delete that chart's v1 alerts, then remove the v1 indicators.
   4. Create one alert per indicator: condition the indicator, **Any alert() function call**, expiration
      **open-ended**, webhook URL `https://ai.cryptophys.work/webhook`.
3. On the **15m** chart only, add `Cryptophys-Mizan-Probe.v1.txt`. Keep every default, turn on
   **Enable Probe Webhook** and enter the same webhook secret in **Probe Webhook Secret** (the last input). Create one
   alert: **Any alert() function call**, open-ended, the same webhook URL.

That is 11 alerts in all: GMI v2 and Prophet v2 on five charts (10), and the Probe on 15m (1).

### What each alert sends

- **GMI v2** (every chart): the three v1 payloads, and on 15m, 1H, 4H and 1D also `gmi_v12_70_adopt_hud`, once per
  closed bar.
- **Prophet v2** (every chart): the two v1 payloads, and on 15m, 1H, 4H and 1D also `prophet_r38_adopt_hud`, once per
  closed bar.
- **Probe** (15m): `probe_mizan_hud`, once per closed 15m bar. On any other chart it sends nothing.
- The 5m charts send only the v1 payloads (the adoption block skips 5m).

The new payloads carry numbers and codes only (no text, no `bar_index`); `na` arrives as `NaN` and is stored as null.
The AI Worker stores them for parity only: they never start the AI chain, and nothing reads them until B11 (GMI and
Prophet) and B26 (the Probe) publish the matching local records. Each field group then needs 24 matching candles
before its fields read as verified.

### Turning it off

Pause the alert in TradingView. The v1 files stay in the repository; reinstalling a v1 file restores the earlier
payloads exactly.

## Earlier install: the HUD v1 candidates (Phase C1)

1. Open TradingView, load the chart for `OANDA:XAUUSD`.
2. Replace the indicator with the candidate file from this repository:
   - `pinescript/candidates/The-Prophet-v7.02-R38.hud.v1.txt`
   - `pinescript/candidates/Global-Multiverse-Interceptor-v12.70.hud.v1.txt`
3. Save and add to chart.

Create two "Any alert() function call" alerts pointing at `https://ai.cryptophys.work/webhook` with the webhook
secret:

- **H1 alert** on the H1 chart (existing alert, updated to the candidate).
- **15m alert** on the 15m chart (new).

Both alerts carry the original `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70` payloads byte-for-byte, plus the
separate `prophet_r38_hud` and `gmi_v12_70_hud` payloads.

The `gmi_v12_70_hud` payload also carries the Grid Bot Protocol fields (2026-11-07): `cshi_viability`,
`deploy_status` (1 muddy waters, 2 toxic chop, 3 optimal, 4 trending or dead), `muddy_waters` and `grid_viable`. The
AI Worker compares them with its own `gmi_hud` record for the H1 candle.

After install:

- The 24-candle parity clock for the HUD identities starts only after the first `*_hud` webhook arrives.
- Until 24/24, HUD values stay UNVERIFIED.
- Do not remove the original indicator until the candidate is confirmed working.
