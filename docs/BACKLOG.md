# Backlog

Open work that waits on something: the market, a date, the owner, or its turn. `docs/SSOT.md`
stays the canonical description of the system; `docs/CHANGELOG.md` records what changed. An item
leaves this file when it is done (and enters the CHANGELOG) or when the owner drops it. This is the
only backlog: the older lists (`docs/BRIEF_HUD_AGENTS.md` §6, `docs/RFC_INDICATOR_AGENT_PLATFORM.md`
§9 and §10) were merged here on 2026-11-07 (owner request). Item numbers are stable: a number that
is gone was done or dropped (CHANGELOG 2026-11-09 for items 0 to 4, 8, 9, 11, 13, 16, 17 and 18;
2026-11-12 for item 19 and the closed parts of items 5, 6, 12 and 15; 2026-11-13 for items 5 and 22). Reviewed against production D1
on 2026-11-12 (owner: "check backlog").

## Verified after the reopen (2026-11-09, items 0 to 4 closed)

The market reopened on Sunday 2026-11-08 at 22:00 UTC. The checks of items 0 to 4 passed on
production D1 by 04:00 UTC (CHANGELOG 2026-11-09): strategy capture per H1 bar, H1 by Consensus
Discussion with the decision about 7 minutes after the close, the model migration (conclusions on
gpt-oss-120b, about 1 % invalid openings on gemma, no 3021 rate limits), and the P7 scorecards
filling for the 15m and 1H rooms. What the reopen also showed was fixed the same morning: the
three post-reopen fail-closed bars (#184, #189), the GMI duplicate alerts (#191) and the Prophet
setup READY state that never reached the decision (#192).

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
    - **Owner (optional since 2026-11-13, "buat agar autonomous"):** a text proposal is shadow-tested without waiting and goes live by itself on its shadow verdict (SSOT "Promotion, autonomous"); the owner may still reject one on the Console Knowledge page, which retires it. Parameter and weighting proposals still wait for the owner.
    - **Done 2026-11-12:** three role reminders are approved (the htf, risk and chronos matrix agents speak of calibration, parity or verification in 26 %, 12 % and 11 % of their rooms) and `SHADOW_KNOWLEDGE_ENABLED` and `LEARNED_KNOWLEDGE_ENABLED` are on (owner: "mode production harus active semua"). The shadow arm now tests the approved items; the bundled pack stays empty until an item proves better and an owner PR adds it.
    - **Data:** the replays (crowd, strategy thresholds, shadow knowledge) need about 300 scored rooms or hours (18 scored H1 rooms on 2026-11-08; the 15m room scored 351 statements in the first six hours of 2026-11-09).
    - **K9:** a text candidate that reads `better_than_active` now goes live by itself for the tested agent on the chart it was tested on (the 1H rooms, the 15m War Room or the council since 2026-11-13; `learned_live`, Nexus Model & Learning); an owner PR into the bundled pack is only needed to make it permanent or wider.
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

## The platform's own model

21. **A custom model from the platform's knowledge** (owner 2026-11-13: "end goalnya mampu membuat custom model sendiri dari knowledge ini khusus untuk EA dan XAUUSD Trading Assistant"; `docs/RFC_CUSTOM_MODEL.md`). Steps 1 and 2 are built (SSOT "Custom model dataset"): the dataset with a tight and a wide label set, and the self-trained baseline (hourly, walk-forward, shadow predictions, prospective record, report to Aether). Next:
    - **The baseline connects itself** to the council as advice once its prospective record passes the gate (SSOT "Connected by itself"); watch `/api/model/baseline` `promotion` and the Telegram line. On 2026-11-13 the first walk-forward check read: tight long skill +0.07 (AUC 0.70), tight short and both wide sets below the base rate (a one-way week), so it is far from connected. A quorum weight or a guardrail stays an owner decision.
    - **Aether's use of the model report**: the curator could turn a feature the models keep leaning on, or one that never carries information, into a proposal; council notes (consumer `council`) are shadow-tested since 2026-11-13 like the room notes (on the 15m bars).
    - **Decision model (built 2026-11-13, `train-model.yml`)**: trained daily, judged in shadow beside the baseline (`/api/model/gbm`). Next: put it behind the same council gate as the baseline once its prospective record holds 300 decisions per side, Shown since 2026-11-13: Nexus Model & Learning (`#/model`) and Cerebrum Training (the model report's `gbm` block, platform #318). Needs about 1000 to 2000 labeled rows to be worth much (a few weeks). If the run fails at "Store the model in KV", `CLOUDFLARE_API_TOKEN` lacks Workers KV edit: the owner adds it to the token.
    - **ONNX export and the EA reading it**, advice only until promoted.
    - **Language model**: a QLoRA fine-tune on Kaggle from the scored room statements, served as a Workers AI LoRA; after months of scored rooms.
    - **While the repository is public** (the owner makes it private after the reset): no row, feature table or weight in a commit, workflow log or artifact.

## The plan learner

23. **Entry and risk learned from price action** (owner 2026-11-13: "Kita butuh strategy modul learning yang adaptif terhadap price action supaya entry dan resiko lebih presisi"; `docs/RFC_PLAN_LEARNING.md`). Step 1 is built (SSOT "Plan learner"): shadow only, `GET /api/plan-learning`.
    - **Waits for data:** the referee needs 100 resolved setups and 30 decisive ones (about two weeks at 15 setups a trading day) before it reads `better_than_plan` or `not_better`.
    - **Owner:** applying the learned entry and stop to the Decision Engine's trade (inside the guardrails, the reward threshold checked again) changes what Omega trades; it starts only on the owner's word after a `better_than_plan` verdict. Also the owner's: whether that step then runs by itself like the weight tuning.
    - **Later arms:** the stop at the broker's 15m swing, the target by the reach of past moves, the speed of the approach as context.

## Strategy agents

24. **Pluggable strategy agents, chosen by the council** (owner 2026-11-13: "kita perlu agent yang bisa dibongkar pasang menyesuaikan strategy yang tepat yang dipilih oleh council"; `docs/RFC_STRATEGY_AGENTS.md`). Built (SSOT "Strategy agents"): the registry, four agents, the record and the measurement, the council's choice among live agents, the Nexus page. Built 2026-11-13: the agents' consensus is a witness of the quorum, weighted like a timeframe room (SSOT "Decision Engine").
    - **Live since 2026-11-13** (owner: "live sekarang langsung implementasi karena strategi lebih related dengan key level bukan decision"): all thirteen agents (the eight pattern families over the Projection Agent's 58 patterns and `pattern_inside` for line patterns before they break joined the same day), with the breaker (a negative record over 30 setups suspends an agent until it recovers) and each agent's record in the council's evidence.
    - **Watch:** which agent the council chooses and what it earns (Nexus Strategy agents, Telegram "Strategy:" line); part of the review of item 6 (about 2026-11-19). Omega's `adaptive_volatility` may widen an agent's tight stop to 0.75 × the broker's 15m ATR: the owner's Omega setting.
    - **Next:** a rule per pattern where a pattern's own record shows its family's rule does not fit it (the family rules are a first reading, unproven on gold); entering before a break on a partial rise or decline; the 4H chart's patterns; more agents (a momentum continuation on the 5m structure, a session-open range break, a news-release fade).
    - **Waits for data:** the agents' records start with the first decisions after the deploy; the stored history holds no agent plans.

## Calibration in progress

15. **4H and D1 parity** (alerts installed by the owner on 2026-11-09). The 1H, 15m and 5m identities are approved (`prophet` 41, `prophet_m15` 360, `prophet_m5` 866 consecutive matches on 2026-11-12). Still calibrating (2026-11-13): `prophet_h4` and `gmi_h4` at 20 of 24 (about one more trading day), `prophet_d1` 3 and `gmi_d1` 2 of 24 (weeks). `gmi_m5` was revoked again on 2026-11-13 (5 of 24 toward re-approval at 09:26 UTC); `prophet_m5` re-approved. `gmi_m5` matches about 98 to 99 % of 5m bars (2 to 3 mismatches a day, 22 on 2026-11-12 in one run of six bars from 10:05 UTC), and almost every mismatch is in the higher-timeframe gate (`gate`, `conflict`, sometimes `gmi_dir`) while the 15m and 1H GMI match every bar: likely the 5m alert reading a forming higher-timeframe bar. To study if it keeps revoking; it does not touch the decision (the 5m trigger is Prophet R38, approved). Until then the 4H and D1 Desks speak at confidence 0.4 or lower.
