# Backlog

Open work that waits on something: the market, a date, the owner, or its turn. `docs/SSOT.md`
stays the canonical description of the system; `docs/CHANGELOG.md` records what changed. An item
leaves this file when it is done (and enters the CHANGELOG) or when the owner drops it. This is the
only backlog: the older lists (`docs/BRIEF_HUD_AGENTS.md` §6, `docs/RFC_INDICATOR_AGENT_PLATFORM.md`
§9 and §10) were merged here on 2026-11-07 (owner request). Item numbers are stable: a number that
is gone was done or dropped (CHANGELOG 2026-11-09 for items 0 to 4, 8, 9, 11, 13, 16, 17 and 18).

## Verified after the reopen (2026-11-09, items 0 to 4 closed)

The market reopened on Sunday 2026-11-08 at 22:00 UTC. The checks of items 0 to 4 passed on
production D1 by 04:00 UTC (CHANGELOG 2026-11-09): strategy capture per H1 bar, H1 by Consensus
Discussion with the decision about 7 minutes after the close, the model migration (conclusions on
gpt-oss-120b, about 1 % invalid openings on gemma, no 3021 rate limits), and the P7 scorecards
filling for the 15m and 1H rooms. What the reopen also showed was fixed the same morning: the
three post-reopen fail-closed bars (#184, #189), the GMI duplicate alerts (#191) and the Prophet
setup READY state that never reached the decision (#192).

5. **The features of 2026-11-08 on live data: the parts that wait for an event.** Verified on 2026-11-09 from D1 (the KV caches themselves are not readable from the session): the Macro War Room of 02:00 UTC read this week's calendar ("No high-impact USD event in the next 24 hours; 2 within 48 hours", its Calendar Agent naming the coming Core CPI) and live correlations (DXY -0.14 % over 4 hours, silver +2.48 %, the weekly correlation with gold), so the calendar fetch and the 4h context series (DXY, US10Y, silver, oil) work. Still open:
   - **Event gate (#157):** the first High-impact USD event of the week (Core CPI) must add the caution to the strategy engine from 2 hours before to 30 minutes after it, and appear as `event_risk` for the Risk Desk of the timeframe rooms.
   - **Telegram alerts (#158):** the bot secrets are set (the `ledger_alerts` seed row of 2026-11-08 10:55 UTC proves it). No ledger event has happened yet, so no message has been sent; the first BUY or SELL of the week will show whether each event arrives once.

## After the first days of the new chain

6. **Scorecard: is the decision still "always WAIT"?** The owner's starting problem (2026-11-06). Every H1 decision since the reopen was WAIT with a bullish bias; #192 (the setup READY state as an entry trigger) and the quorum decision (2026-11-09, indicators as arguments, not gates) are the changes aimed at it, so check early, about Wednesday 2026-11-12, and again after a week (about 2026-11-16).
   - The split of BUY, SELL and WAIT from the H1 Reasoner and from the strategy engine.
   - How often the room reached its quorum (`consensus.quorum.met`) and how often the Reasoner's own decision differed from it (`guard_overridden`); how often a quorum stayed WAIT for lack of a valid plan (`plan_available` false).
   - How often the room or the Reasoner cited `setup_state` (READY) and what came of those bars.
   - The outcome scoring of those decisions (Nexus Scorecards page).
   - How often the weighted crowd line differs from the room's conclusion.
   - Then decide with the owner whether the quorum share (0.5) or the rules need loosening or tightening, and whether the 15m Live War Room and the strategy engine should follow the quorum too (they still require the Prophet confirmation).

## After 2026-11-20 (Workers AI retires glm-5.3-flash and nemotron-3-120b-a12b)

7. **Clean-up (low priority).**
   - Remove the glm-5 and nemotron branches of `modelRequests`.
   - Remove the retired H1 multi-agent bus path: the module stays for its stored history.
   - Remove the legacy `/analyze` bundle chain, which still calls the Analyst and the Counselor.

## Owner actions

10. **P5 shadow candidates (reviewed 2026-11-07, owner decision).**
    - **Stopped:** `prophet_r37@latch12` and `prophet_r38@latch8` (`RETIRED_CANDIDATES` in `src/shadow-versions.mjs`).
      - `prophet_r37@latch12`: 14 stances differed out of 492, the candidate was right 4 times against the active version's 3 (p 0.5).
      - `prophet_r38@latch8`: 0 stances differed. R38 takes a side only on a confirmed signal, so the latch never changed its stance.
    - **Kept, with a deadline:** `prophet_r37@latch8`. At the review it was right 4 times against the active version's 5 (p 0.75), and it had 13 % fewer stuck candles. Review it once it has 30 decisive pairs, or on 2026-12-07 at the latest. Stop it then unless it is significantly better.
    - **Kept until the sample is complete:** `gmi_v12_70@latch8` and `@latch12` (36 of 200 bars at the review). Review around 2026-11-14 (scheduled). Since #150 a verdict needs 300 shared bars: 200 for discovery (Holm-adjusted per family per month) and the newest 100 as a holdout.
    - **If every latch candidate stays `not_better`:** the latch expiry is not the improvement, and the cause of the stuck states has to be found elsewhere.
12. **Aether, the Knowledge Guardian** (from the Nexus analytic layers, owner request 2026-11-07). Phases A1 to A8 and the A9 groundwork are built (CHANGELOG 2026-11-07 and 2026-11-08; status in `docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md` §0.7). What remains waits on data or on the owner:
    - **Owner:** approve or reject the curator's and calibrator's proposals on the Console Knowledge page.
    - **Owner:** set `SHADOW_KNOWLEDGE_ENABLED` once a text item is approved (a small PR).
    - **Data:** the replays (crowd, strategy thresholds, shadow knowledge) need about 300 scored rooms or hours (18 scored H1 rooms on 2026-11-08; the 15m room scored 351 statements in the first six hours of 2026-11-09).
    - **K9, the first promotion PR:** only once a candidate reads `better_than_active: ready for owner review`; the owner approves it.
    - **The room quorum weighting** (2026-11-09, SSOT "Room quorum weighting"): tuned automatically per timeframe, no approval. A point needs 300 concluded and scored rooms of its timeframe before it can be activated: about 4 days on 15m, two weeks on 1H, about 2 months on 4H and more than a year on D1. Watch the Telegram messages and `GET /api/weighting?timeframe=60` from about 2026-11-23.
14. **Rotate the TradingView webhook secret before publishing** (owner decision 2026-11-09: deferred to the final step before publish). The current secret was visible in a status-line screenshot during the 401 diagnosis. Steps: PowerShell `New-Guid` one-liner, GitHub secret `TV_WEBHOOK_SECRET`, run `set-webhook-secret.yml` as a new run (never "Re-run"), the indicators' "CTA Webhook Secret" input, then delete and recreate every alert (an alert keeps the inputs it was created with). Keep "Indicator arguments" off in the chart's status line.

## Calibration in progress

15. **4H and D1 parity** (alerts installed by the owner on 2026-11-09, about 03:30 UTC; H1 and 15m earlier the same morning). The `prophet_h4` / `gmi_h4` identities need 24 matches (about 4 trading days), `prophet_d1` / `gmi_d1` about 5 weeks. Until then the 4H and D1 Desks speak at confidence 0.4 or lower. First receipts to confirm: H4 at 06:00 UTC, D1 at 22:00 UTC on 2026-11-09 (scheduled checks).
19. **GMI re-approval after B4** (2026-11-09). Every GMI identity re-earns 24 consecutive parity matches against the TradingView alerts: `gmi_m5` about 2 hours, `gmi_m15` about 6 hours, `gmi` and `gmi_hud` (1H) about 24 trading hours, `gmi_h4` about 4 trading days and `gmi_d1` about 5 weeks (both already calibrating). Since the quorum change of 2026-11-09 the H1 decision no longer waits for it: the chain reads the GMI record as `not_parity_approved` meanwhile. Until the 5m and 15m identities are approved again, the 5m confirmation reads UNVERIFIED 5m and the 15m desk not calibrated. Check the registry the next day. Status at 07:10 UTC on 2026-11-09: `gmi` 2 of 24 and `gmi_hud` 2 of 24 (all matched, so `gmi` after 22 more H1 bars, around 06:00 UTC on 2026-11-10 counting the daily break), `gmi_m5` 10 in a row after one mismatch at 06:15 UTC (pre-existing, below), `gmi_m15` 0 because no 15m alert has arrived since 05:30 UTC.
    - **Owner:** the 15m TradingView alerts (Prophet and GMI) have sent nothing since 05:30 UTC on 2026-11-09, with no rejection in `webhook_rejections`; check that they are still active (the GMI alert may have been removed when the script was reinstalled for #191).
    - **The 5m `gmi_dir` mismatch** (about 1 bar in 18, before and after B4): only on conflict bars (gate -1), where the verdict branch before the conflict reset differs from Pine's. The comparison detail keeps the local branch (`local_diagnostics`). First reading, bar 08:35 UTC on 2026-11-09: local `jma_long` (+3, close inside the value area, `htf_state` -1, footprint BUY CONTROL) where Pine was -3 before the reset. The detail now also keeps `pct_rank`, the kinetics, the value-area position and the zone flags; read the next mismatch to tell a JMA threshold difference from a zone or Fabio branch that fires only in Pine.
