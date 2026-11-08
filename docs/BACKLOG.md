# Backlog

Open work that waits on something: the market, a date, the owner, or its turn. `docs/SSOT.md`
stays the canonical description of the system; `docs/CHANGELOG.md` records what changed. An item
leaves this file when it is done (and enters the CHANGELOG) or when the owner drops it. This is the
only backlog: the older lists (`docs/BRIEF_HUD_AGENTS.md` §6, `docs/RFC_INDICATOR_AGENT_PLATFORM.md`
§9 and §10) were merged here on 2026-11-07 (owner request).

## Waits for the market to reopen (first check: Monday 2026-11-09, 01:20 UTC, scheduled)

The gold market closes from Friday evening to Sunday evening (UTC), so the changes of 2026-11-07
have run in preview only. A scheduled check reads production after the reopen and reports to
the owner. Since 2026-11-08 `ai.cryptophys.work/api/*` is behind Cloudflare Access, so the checks read
D1 with read-only queries; the API paths below name what is checked, not how it is read.

0. **First strategy capture (scheduled: Monday 2026-11-09, 00:52 UTC).** `strategy_inputs` holds a row for the 23:00 H1 bar, captured about 40 minutes after its close, and one row per closed H1 bar after that.

1. **H1 decision by Consensus Discussion (#131).**
   - `GET /api/threads/timeframe?chart=H1`: `reasoner_decision.chain` is `consensus_reasoner`, and `consensus.status` is `concluded` (or `partial` / `empty` at the 45-minute fallback) for the bars after the reopen.
   - No bar stays parked (`analysis_runs` status `analyzing`, `error_code` `awaiting_consensus` or `finalizing`) beyond 45 minutes after its close.
   - The guard (`consensus.guard_overridden`) is rare. If it fires often, the Reasoner prompt needs work.
2. **Model migration (#132).**
   - The War Room and the 1H, 4H and D1 rooms: openings on `@cf/google/gemma-4-26b-a4b-it` (fallback `@cf/openai/gpt-oss-20b`), conclusions on `@cf/openai/gpt-oss-120b`.
   - Count `ok` against `agent_failed` and `invalid_output`, and how often `fallback_used` is set. Compare with the rates before the migration: about 96-98 % of openings ok, frequent 3021 rate limits on glm-5.3-flash.
   - A failed conclusion now carries `errors`, `model` and `raw` in the room API. Read them and fix what they show, before glm-5.3-flash and nemotron stop answering on 2026-11-20.
   - `/api/status`: `ai_worker.models` reads gpt-oss-120b for the news chain and the H1 Reasoner.
3. **The 1H room right after the close (#133).**
   - `consensus.decided_after_close_s` in the H1 synthesis.
   - Target: about 10 minutes after the close (before: 15-45 minutes).
   - The logs show `h1_room` and `h1_consensus_decision ... "via":"h1_room"` for most bars, and the sweep finishing only the rest.
4. **The crowd line, reputation and Nexus scorecards (P7).**
   - The room agents of the Live War Room 15m and the 1H room are scored from the reopen.
   - Check that `GET /api/scorecards` lists them under `reputation.rooms` once their first horizons close (4 candles).
   - Check that every room shows its crowd line.
5. **The features of 2026-11-08 on live data.**
   - **Economic calendar (#157):** the Nexus calendar page lists the week's events, and a High-impact USD event adds the caution to the strategy engine from 2 hours before to 30 minutes after it.
   - **Correlations (#156):** the 4h context series (DXY, US10Y, silver) fill and the Nexus correlations page shows values for 30 and 120 bars.
   - **Telegram alerts (#158):** once the owner has set the bot secrets (item 9), the first ledger events of the week arrive in Telegram, each once.

## After one week of the new chain (from about 2026-11-16)

6. **Scorecard: is the decision still "always WAIT"?** The owner's starting problem (2026-11-06).
   - The split of BUY, SELL and WAIT from the H1 Reasoner and from the strategy engine.
   - How often the consensus guard overrode the Reasoner.
   - The outcome scoring of those decisions (Nexus Scorecards page).
   - How often the weighted crowd line differs from the room's conclusion.
   - Then decide with the owner whether the rules need loosening or tightening.

## After 2026-11-20 (Workers AI retires glm-5.3-flash and nemotron-3-120b-a12b)

7. **Clean-up (low priority).**
   - Remove the glm-5 and nemotron branches of `modelRequests`.
   - Remove the retired H1 multi-agent bus path: the module stays for its stored history.
   - Remove the legacy `/analyze` bundle chain, which still calls the Analyst and the Counselor.

## Owner actions

8. **Calibrate the 4H and D1 desks.**
   - Install the Prophet R38 and GMI v12.70 alerts on the OANDA:XAUUSD 4-hour and daily charts: "Any alert() function call", same webhook.
   - Until 24 matches (about 4 trading days on H4, about 5 weeks on D1), the 4H and D1 Desks read as not calibrated and speak at confidence 0.4 or lower.
9. **Set the Telegram bot secrets on the AI Worker (found 2026-11-08).**
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are most likely not set in production: after the #158 deploy the sweep ran several times without creating `ledger_alerts`, which it does only when both exist. If so, no Telegram message has been sent so far, the H1 decision message included.
   - The owner sets both on the `xauusd-ai-trading-assistant` Worker (Cloudflare dashboard: Settings, Variables and Secrets). Never paste them into a chat.
   - The next sweep then records the existing ledger events without sending them; every later event is sent once.
10. **P5 shadow candidates (reviewed 2026-11-07, owner decision).**
    - **Stopped:** `prophet_r37@latch12` and `prophet_r38@latch8` (`RETIRED_CANDIDATES` in `src/shadow-versions.mjs`).
      - `prophet_r37@latch12`: 14 stances differed out of 492, the candidate was right 4 times against the active version's 3 (p 0.5).
      - `prophet_r38@latch8`: 0 stances differed. R38 takes a side only on a confirmed signal, so the latch never changed its stance.
    - **Kept, with a deadline:** `prophet_r37@latch8`. At the review it was right 4 times against the active version's 5 (p 0.75), and it had 13 % fewer stuck candles. Review it once it has 30 decisive pairs, or on 2026-12-07 at the latest. Stop it then unless it is significantly better.
    - **Kept until the sample is complete:** `gmi_v12_70@latch8` and `@latch12` (36 of 200 bars at the review). Review around 2026-11-14 (scheduled). Since #150 a verdict needs 300 shared bars: 200 for discovery (Holm-adjusted per family per month) and the newest 100 as a holdout.
    - **If every latch candidate stays `not_better`:** the latch expiry is not the improvement, and the cause of the stuck states has to be found elsewhere.

## Last week's backlog (2026-11-03 to 2026-11-06), merged here on 2026-11-07

11. **B4: remove the GMI core duplication** (owner, 2026-11-05).
   - `gmi-core-tf.mjs` repeats the approved H1 GMI core.
   - Merging them changes the GMI implementation hash, so the H1 `gmi` identity needs a new 24-candle approval.
   - Schedule it in a calibration window, with the H1 GMI alert active.
   - It cannot be done without the owner: it edits a hashed engine file (`gmi-core-tf.mjs`), which the project rules allow only in a calibration window the owner opens.
12. **Aether, the Knowledge Guardian** (from the Nexus analytic layers, owner request 2026-11-07). Phases A1 to A8 and the A9 groundwork are built (CHANGELOG 2026-11-07 and 2026-11-08; status in `docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md` §0.7). The other layers (economic calendar, Telegram alerts, correlations) were done on 2026-11-08 (CHANGELOG). What remains waits on data or on the owner:
    - **Owner:** approve or reject the curator's and calibrator's proposals on the Console Knowledge page.
    - **Owner:** set `SHADOW_KNOWLEDGE_ENABLED` once a text item is approved (a small PR).
    - **Data:** the replays (crowd, strategy thresholds, shadow knowledge) need about 300 scored rooms or hours (18 scored H1 rooms on 2026-11-08). The first strategy capture is due after the market reopens (item 0).
    - **K9, the first promotion PR:** only once a candidate reads `better_than_active: ready for owner review`; the owner approves it.
    - **Optional:** a Nexus Alerts page (the sidebar entry still reads "soon"); the alerts themselves go to Telegram.
13. **Comparator alerts for the new agents (owner).**
    - **Grid Bot Protocol:** the comparator is built (2026-11-07). The GMI HUD candidate alert carries its fields and the `gmi_hud` identity compares them. What remains is the owner step: install the GMI HUD candidate on the H1 chart (`docs/HUD_CANDIDATE_INSTALL.md`). The same install starts parity for the other GMI HUD fields.
    - **Supertrend and Order Blocks (optional):** they have no TradingView comparator yet, so their statements stay unverified (Supertrend counts as computed from verified bars).
