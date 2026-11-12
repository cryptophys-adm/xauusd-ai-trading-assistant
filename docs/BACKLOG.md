# Backlog

Open work that waits on something: the market, a date, the owner, or its turn. `docs/SSOT.md`
stays the canonical description of the system; `docs/CHANGELOG.md` records what changed. An item
leaves this file when it is done (and enters the CHANGELOG) or when the owner drops it. This is the
only backlog: the older lists (`docs/BRIEF_HUD_AGENTS.md` §6, `docs/RFC_INDICATOR_AGENT_PLATFORM.md`
§9 and §10) were merged here on 2026-11-07 (owner request). Item numbers are stable: a number that
is gone was done or dropped (CHANGELOG 2026-11-09 for items 0 to 4, 8, 9, 11, 13, 16, 17 and 18;
2026-11-12 for item 19 and the closed parts of items 5, 6, 12 and 15). Reviewed against production D1
on 2026-11-12 (owner: "check backlog").

## Verified after the reopen (2026-11-09, items 0 to 4 closed)

The market reopened on Sunday 2026-11-08 at 22:00 UTC. The checks of items 0 to 4 passed on
production D1 by 04:00 UTC (CHANGELOG 2026-11-09): strategy capture per H1 bar, H1 by Consensus
Discussion with the decision about 7 minutes after the close, the model migration (conclusions on
gpt-oss-120b, about 1 % invalid openings on gemma, no 3021 rate limits), and the P7 scorecards
filling for the 15m and 1H rooms. What the reopen also showed was fixed the same morning: the
three post-reopen fail-closed bars (#184, #189), the GMI duplicate alerts (#191) and the Prophet
setup READY state that never reached the decision (#192).

5. **The features of 2026-11-08 on live data: the part that waits for an event.** The calendar fetch, the 4h context series and the Telegram ledger alerts (#158) are verified: by 2026-11-12 the ledger had sent 16 entry, 16 exit, 5 closed and 1 cancelled event, each once. Still open:
   - **Event gate (#157) and the CALENDAR witness:** the next High-impact USD release (Core PPI and PPI, 2026-11-13 13:30 UTC) must add the caution from 2 hours before to 30 minutes after it, appear as `event_risk` for the rooms' Risk Desk, and move the CALENDAR witness ("before" from 05:30 UTC, "after" with the surprise). Checks scheduled at 06:05 and 14:20 UTC.

## After the first days of the new chain

6. **Review the Decision Engine and Omega per trading mode after a week (about 2026-11-19).** The question of 2026-11-06 ("is the decision always WAIT?") is answered: the Decision Engine replaced the H1 chain as the single decision, and it decided 41 SELL, 4 BUY and 51 WAIT on 2026-11-10, 42, 2 and 52 on 2026-11-11, and 56 SELL and 16 WAIT on 2026-11-12 (to 17:15 UTC). What to review instead, from the Signal Ledger on 1m bars (Nexus Performance, `by_mode`) and Aether's execution report:
   - per mode (scalp, intraday, swing): the plan's TP1 and TP2 against the Omega policy on the same signals (expectancy, profit factor, drawdown in R) and the gates that skipped signals;
   - Omega's real trades on the demo account since the settings of 2026-11-12 (risk 1.5 % per trade, daily loss limit 4 %, at most 2 positions): how many signals `volume_below_min` skipped at 0.01 lot, and whether the daily limit still stops good days;
   - the outcome scoring of the rooms (Nexus Scorecards) and the witness weights the auto-tune activated;
   - then decide with the owner on the mode, the risk per trade and any guardrail change.

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
    - **Done 2026-11-12:** three role reminders are approved (the htf, risk and chronos matrix agents speak of calibration, parity or verification in 26 %, 12 % and 11 % of their rooms) and `SHADOW_KNOWLEDGE_ENABLED` and `LEARNED_KNOWLEDGE_ENABLED` are on (owner: "mode production harus active semua"). The shadow arm now tests the approved items; the bundled pack stays empty until an item proves better and an owner PR adds it.
    - **Data:** the replays (crowd, strategy thresholds, shadow knowledge) need about 300 scored rooms or hours (18 scored H1 rooms on 2026-11-08; the 15m room scored 351 statements in the first six hours of 2026-11-09).
    - **K9, the first promotion PR:** only once a candidate reads `better_than_active: ready for owner review`; the owner approves it.
    - **The room quorum weighting** (2026-11-09, SSOT "Room quorum weighting"): tuned automatically per timeframe, no approval. A point needs 300 concluded and scored rooms of its timeframe before it can be activated: about 4 days on 15m, two weeks on 1H, about 2 months on 4H and more than a year on D1. Watch the Telegram messages, the Nexus Aether page (`nexus.cryptophys.work/aether`, weighting per timeframe) and `GET /api/weighting?timeframe=60`: the 15m room reaches 300 rooms first (137 at 11:11 UTC on 2026-11-09), the 1H room from about 2026-11-23.
14. **Rotate the TradingView webhook secret before publishing** (owner decision 2026-11-09: deferred to the final step before publish). The current secret was visible in a status-line screenshot during the 401 diagnosis. Steps: PowerShell `New-Guid` one-liner, GitHub secret `TV_WEBHOOK_SECRET`, run `set-webhook-secret.yml` as a new run (never "Re-run"), the indicators' "CTA Webhook Secret" input, then delete and recreate every alert (an alert keeps the inputs it was created with). Keep "Indicator arguments" off in the chart's status line.

## Waits for the Financial Management module

20. **Money figures on the Omega page** (owner 2026-11-12: "ya tunda sampai modul Financial Management, masukan backlog"). The Nexus Performance page shows no money since #267 (owner: "hapus broker capital, sesuai aturan never money; catatan kita akan membuat modul sendiri terkait Financial Management").
    - **What remains:** the Omega page in Nexus (`workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx`) still shows account and position money in the account currency:
      - P&L, swap and balance figures (`money()` and `cur`);
      - the P&L in the exit confirmation (`ExitConfirmModal`).
    - **These stay until the module exists.** The never-money test covers only the Performance page.
    - **When the module is designed:** move every account figure there, then drop it from the Omega page:
      - balance, equity, floating and realised P&L, swap, day start balance and day P&L;
      - any treasury.
    - **Then extend the never-money test** to the Omega page.
    - **Owner:** decide the module's scope and where it lives (Nexus or the platform Console) before it starts.

## Calibration in progress

15. **4H and D1 parity** (alerts installed by the owner on 2026-11-09). The 1H, 15m and 5m identities are approved (`prophet` 41, `prophet_m15` 360, `prophet_m5` 866 consecutive matches on 2026-11-12). Still calibrating: `prophet_h4` and `gmi_h4` at 17 of 24 (about two more trading days), `prophet_d1` 3 and `gmi_d1` 2 of 24 (weeks). Until then the 4H and D1 Desks speak at confidence 0.4 or lower.
