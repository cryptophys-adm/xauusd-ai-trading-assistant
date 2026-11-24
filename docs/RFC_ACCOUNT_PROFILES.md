# RFC: Account Profiles & Dynamic Mode (Omega)

- **Status:** decided by the owner (2026-11-18); four phases, all built (phase 4: the mode selector and the Position Manager in R). Phases 1 to 3 built (EA 1.15, `src/account-spec.mjs`, sizing in `planIntents`, the profile agent in `src/profile-agent.mjs`). ADR-0020 Amendment 3 merged on the platform (main 1ade63d, 2026-11-18 03:53 UTC).
- **Builds on:** ADR-0020 (no new trading authority, Decision Engine veto, never move funds), docs/RFC_STRATEGY_RECOMMENDATION.md, src/grid-adapt.mjs (evidence gate), src/omega-engine.mjs (sizing), ea/mt5/OmegaExecutor.mq5 (1.14).

## Goal (owner)

Omega must serve accounts from **USD 100**, with at most **10%** risk, and the Signal Engine should switch scalp, intraday and swing by itself. Standard accounts only (no cent or micro accounts for now). Nothing is tied to one broker: broker servers change, and the EA in MT5 executes.

## Owner decisions (2026-11-18, relayed by the orchestrator ~02:45 UTC, then confirmed in the session)

1. **Rollout:** "tidak ada shadow, langsung live". Each phase goes live behind its gates (spec validated, minimum EA version, risk caps), with automatic rollback when live results are worse.
2. **The current live account** starts as **Custom (current settings)**: `risk_pct` 2, `max_positions` 5, `max_daily_loss_pct` 10, as stored in D1 `omega_settings` (version 52). The orchestrator's relay said 4 positions and 5%; D1 is authoritative. Going live changes no lot size by itself.
3. **The profile agent** runs **autonomously with guardrails** on the live account.
4. **Guardrails:** as proposed (§6). For the live account the ceiling defaults to **Custom (current settings)**. The agent may step down to Conservative or Safe, and back up to at most the ceiling. It never raises risk above today's settings. The owner can change the ceiling in Nexus.

## 1. The EA supplies the spec (broker-agnostic)

- **What the EA reports.** The EA already writes the symbol spec in `state.json`, at `WriteStateJson`: digits, point, tick size and value, volume min/max/step, stops level, contract size, profit currency. The new version adds:
  - **symbol:** freeze level, trade mode, swap-free flag if available, margin per lot from `OrderCalcMargin`;
  - **account:** leverage, margin mode, free margin.
- **Spec hash.** The Worker stores the spec with a hash. A hash change (a new server, or a contract change) **blocks new entries** until the new spec validates. Open positions are still managed. A missing or odd spec means no entry, like `symbol_error`.
- **Money risk** uses the broker's loss tick value, as `omega-engine.mjs` already does, so non-USD accounts work.
- **What stays.** EA 1.14's exact gold allowlist stays. Nothing broker-specific is hard-coded.

## 2. The EA is the last gate

- **Checks before sending.** The new EA version runs `OrderCheck` and `OrderCalcMargin` and checks stops and freeze levels before each send.
- **On failure** it refuses and reports why (`refused: margin`, `refused: stops_level` and so on). It never resizes silently and never moves the SL.
- **Version gate.** Omega gates new entries on a **minimum EA version**. Today `EXECUTOR_MIN_VERSION` is only displayed; the new behaviour blocks new entries and reports `ea_outdated`. The owner compiles the new EA on the VPS.

## 3. Sizing from the SL

`lot = floor(risk_money / (SL distance / tick_size × tick_value) / step) × step`. This is the formula already in `omega-engine.mjs`.

- **Below `volume_min`:** the minimum lot is allowed **only if its real risk stays within the profile's hard cap**. Otherwise the setup is skipped with a visible reason, e.g. "SL 135 pips: min lot risks 13.5% of USD 100, over the Conservative cap 5%".
- **Today** the setup is simply skipped as `volume_below_min`.
- Skip reasons show in Nexus (Omega) and in the Signal Ledger.

## 4. Profiles

| Profile | Target risk / trade | Hard cap / trade | Total open risk | Daily loss (then auto-disarm) | Max concurrent | Modes |
|---|---|---|---|---|---|---|
| Safe | 1% | 2% | 2% | 3% | 1 | swing, intraday |
| Conservative | 2–3% | 5% | 5% | 6% | 2 | intraday, swing; scalp only if proven |
| Aggressive | 5% | 10% | 10% | 10% | 2–3 | all, scalp if proven |
| Custom | the account's own settings, at most Aggressive's (ADR-0020 Amendment 10, 2026-11-21: 10% / — / 10% / 10% / 3) | as set | as set | as set | as set | as set |

- **Safe** with nothing that fits: the account runs as **signals only plus an automatic paper-trade record**, so a USD 100 user still has Nexus and Telegram signals and the council.
- **Profiles change size, never signal quality.** The Decision Engine's gates (confidence, guardrails, veto) are the same for every profile.
- **Precedence.** The Aether Omega policy (`OMEGA_POLICY_BOUNDS`) and the profile cannot both set the same fields. The profile's caps are the outer bound; the policy may only tighten inside them.

## 5. The profile agent

The agent recommends the profile for an account from these inputs:
- capital;
- recent drawdown and the equity curve;
- the volatility regime;
- live results per profile.

Each account chooses a mode:
- **Approval:** the agent proposes a switch with its reasons, and the user accepts or declines in Nexus.
- **Autonomous:** the agent switches by itself within the guardrails. The live account starts here (owner, 2026-11-18).

## 6. Guardrails for autonomous switching (owner-approved as proposed)

- **Ceiling.** The user sets a ceiling profile and the agent never goes above it. The live account's ceiling is Custom (current settings).
- **Downgrades** happen at once when triggered: a drawdown of −20% from the equity peak, a loss streak, or an extreme volatility regime. They apply to new entries straight away.
- **Upgrades** need evidence: equity back above its prior peak **and** N trades with positive expectancy at the current profile. At most one step at a time, and at most one upgrade per 7 days.
- **Never mid-trade.** A switch applies to new entries only; open positions keep their size and SL.
- **Audit.** Every switch is logged (actor agent or user, reason, evidence) and sent as one Telegram line. Autonomous mode can be turned off at any time.

## 7. Dynamic mode (scalp, intraday, swing)

- **Inputs:**
  - volatility regime (ATR percentile);
  - trend strength;
  - session;
  - news proximity;
  - **account feasibility**: a mode whose SL cannot fit the capital and profile is excluded.
- **Adoption gate.** A mode is adopted per regime only past a grid-adapt gate (`GATE` in src/grid-adapt.mjs):
  - per-setup expectancy in plan-R on the `plan_setups` replay, which already stores `mode` and `context`;
  - a minimum sample;
  - a bootstrap lower bound;
  - a holdout.
- **Stability.** Hysteresis stops it flipping back and forth. It reverts automatically on live underperformance.
- **No shortcut for small accounts.** Grid data showed tight stops underperform (s0.5 −0.17R, n 240), so "small account → tight scalp" is not assumed. When nothing is proven, the account skips.
- **Today the mode is global:** env `TRADING_MODE`, KV `trading:mode`, default intraday. The selector chooses per regime and per account, and a manual pin stays possible.
- **Shadow per-mode evidence (MS2, 2026-11-23).** Each mode not in force runs the deterministic part of every 15m
  decision with the live witnesses and the live council's answer (`shadowModeDecisions`, `src/mode-shadow.mjs`):
  - its own geometry (scalp and `SCALP_TARGET` under TP1-KZ), thresholds (quorum_min, min_rrr, lean), room, vetoes
    and agent selection; range only while the 1H regime ranges and only from the range strategies;
  - the side: the council's BUY or SELL; on its WAIT a side the mode opens that the live gates had closed; without an
    answer the live fallback. The council's confidence applies.
  - A mode that would trade writes `mode_shadow_plans`; the plan learner derives shadow setups (`plan_setups.source =
    'shadow'`, control arm only). No model call, no room, no price in a room; the decision record is unchanged.
    `mode_shadow_plans` keeps 90 days (the cron's retention line, `pruneModeShadowPlans`).
  - The selector's evidence per mode is its live and shadow setups of the target rule in force (`rule_version`), one per
    bar and agent, the live one first. The gate, the margin, the streak and the council are unchanged. Every other
    reader of `plan_setups` reads live setups only.
- **Probation (MS2).** A selector switch to a mode (not the baseline) with fewer than 31 live resolved setups is a
  probation (ADR-0020 Amendment 3: new orders only, sizing within the profile cap):
  - Omega's new entries of that mode at 0.5 of the risk per trade; the profile's hard cap is not scaled and an open
    position is never touched; the EA is unchanged.
  - The baseline stays the owner's.
  - Its live setups since it started reach 15 with a mean under 0R, or its walk-forward fails: back to the baseline,
    reason `probation_failed` (a change row, an Omega event, one Telegram line, a `mode.v1` item).
  - It passes at 31 live setups and a walk-forward pass (cleared, full risk, one line).
  - The owner's pin, Auto and veto are unchanged and owner only; a pin or a veto clears it.
- **Switches.** `MODE_SHADOW_EVIDENCE` and `MODE_PROBATION` ("on" by default); both "off" is the behaviour before MS2.

## 8. Position manager in R

The fixed ±30-pip thresholds in `src/position-manager.mjs` (`THRESHOLD_PIPS`) become R-based per mode, e.g. break-even at +0.5R and a cut at −0.5R when signals weaken.

**Built 2026-11-18** (owner, confirmed: "Per mode"). Evidence: Omega's stops over the 7 days before averaged 139 pips (78–195), so 30 pips was ~0.2R (0.15–0.38R). The band is `PM_R_BAND` × the stop distance at entry (`pmBand`): scalp 0.3R, intraday and range 0.5R, swing 0.7R. It moves the take-profit-when-weakening, the break-even and the cut-loss rules; the TP1 lock (30 pips beyond TP1) stays in pips. A position without a known stop distance keeps 30 pips.

## 9. One code path, per-account profiles

- **Ready for multi-user.** Profiles live per account (keyed by the MT5 server and login hash, never the raw login in logs).
- **Permissions.** Changing a profile or the agent mode is owner-only (`OWNER_ACCESS_SUB`); today `POST /api/settings` takes any signed-in person.
- **ADR-0020 scope.** Everything stays inside ADR-0020: no new trading authority, the Decision Engine veto stands, funds never move. The orchestrator asks the platform to confirm no amendment is needed.

## 10. Platform gates for the profile agent (ADR-0020 Amendment 3, platform 2026-11-18)

The owner agreed to Amendment 3 ("setuju amandemen 3"). Until it is merged on the platform, the agent's upgrades are
owner clicks only; downgrades may run. The gates, for phase 3:
- **Ceiling.** Set by the owner only (`OWNER_ACCESS_SUB`, same origin, audited). The agent upgrades an account only
  while the owner's ceiling is above its current profile. Lowering the ceiling applies at once.
- **No upgrade with exposure.** Never while the account has an open position or a pending order.
- **One step, on evidence.** Upgrades go one profile at a time, on passing evidence. Missing evidence or a failing
  agent raises nothing.
- **Kill switch and daily loss.** Either returns the account to Safe, with no autonomous upgrade before the next UTC day.
- **Downgrades** are never blocked or delayed.
- **Audit.** Every switch is an Omega event, one Telegram line and an `xauusd_digest` with schema `risk_profile.v1`:
  the opaque account reference (never the broker account number), from, to, actor, reason, evidence reference,
  at. Severity info, warning for a forced downgrade, never critical.
- **Position manager** stays risk-only (Amendment 1): never widen a stop, never add, never move the target more
  than once.

## Phase 1 as built (2026-11-18)

- **EA 1.15** reports the spec of §1 and an opaque `login_hash`, and runs the checks of §2 (see docs/OMEGA_BRIDGE.md).
- **Spec hash.** An account's first usable spec validates at once (the live account keeps trading as today). A
  changed spec blocks new entries (`spec_unvalidated`) until it is usable and has held 60 s (`SPEC_SETTLE_MS`).
  Quotes, equity, free margin, margin per lot, tick value and the stops and freeze levels are not hashed: they move
  on their own and are checked at each entry by the server and the EA.
- **Account reference.** `acct_` + 16 hex of a hash of the EA's login hash; before 1.15 a hash of the server, kept
  for that server's first 1.15 sync. It is opaque in logs, events and Telegram, but not a secret: a login is a small
  number, so whoever knows the server could guess it.
- **Profiles stored.** D1 `omega_accounts`: the first account seen is Custom (`risk_pct` 2, `max_positions` 5,
  `max_daily_loss_pct` 10 at the time), ceiling Custom, autonomous; any later account Safe, ceiling Safe, approval.
  No lot size changes in phase 1.
- **EA 1.16.** 1.15 refused every open on the FxPro demo: under unlimited leverage the margin of 0.01 lot rounds to
  0.00, which 1.15 read as unknown. 1.16 refuses only when `OrderCalcMargin` fails, and the entry gate's minimum is 1.16.
- **EA version gate.** `OMEGA_EA_VERSION_GATE` "on" blocks new entries for an EA before the minimum (`ea_outdated`). It
  shipped "off" and is on since 1.15 runs on the VPS: seen 2026-11-18 04:17:31 UTC (the 1.14 row adopted, the spec
  changed with the new fields), validated 04:18:32 UTC.

## Phase 2 as built (2026-11-18)

- **Limits.** `effectiveLimits(profile, settings)`: each limit (risk per trade, positions, daily loss) is the smaller of
  the profile's cap and the engine setting, so the Aether policy only tightens inside the profile. Custom is the
  settings within Aggressive's limits (ADR-0020 Amendment 10, owner 2026-11-21: "Ya, Custom = Aggressive";
  `CUSTOM_CAPS`: 10% risk per trade, 10% daily loss, 3 positions); a Custom setting inside them sizes exactly as before
  (test AS14). Custom also takes Aggressive's 10% total open risk at the stops (owner 2026-11-21: "Ya, tambahkan"; it
  only ever refuses an entry) and still has no hard cap per trade. The settings themselves may not exceed
  those limits (`settingsFrom`: positions 1 to 3, daily loss 0.1 to 10%), since no profile allows more.
- **Minimum lot.** Below `volume_min` the minimum lot is used only when its real risk is within the profile's hard cap
  per trade (`min_lot_within_cap`); otherwise the setup is skipped (`volume_below_min`) with the numbers, e.g. "stop
  500 pts: the minimum lot 0.01 risks 5% of 100, over the Safe cap of 2%". Custom has no hard cap and skips as before.
  The day's risk budget still applies after it.
- **Total open risk.** What the open positions lose at their stops plus the new entry stays within the profile's total
  open risk: the lot is capped (`lot_capped_open_risk`) or the entry skipped (`open_risk_cap`). It never raises a lot.
- **Leverage is never an input.** Sizing uses the stop distance and the loss tick value only; the margin is the
  broker's `OrderCalcMargin` and `OrderCheck` answer in the EA. A reported leverage of 1:100,000 or more (the FxPro
  demo reports 1:2,000,000,000, margin USD 0.38 a lot) is shown as "unlimited" on the Omega page.
- **Risk setting up to 10% (owner 2026-11-18, "Naikkan ke 10%, dikunci profil").** `RISK_PCT_MAX` was 2, which held
  every profile at 2% per trade. It is 10 now. What applies is still the smaller of the setting and the profile's
  target (Safe 1%, Conservative 2%, Aggressive 5%), and Custom uses the setting itself. The Omega settings card shows
  what the profile applies now.
- **Where the reasons show.** The Omega page's entry status, with the numbers (`planner.details`, stored with the plan
  event when the codes change). The Signal Ledger replays in R, without lots, so the minimum-lot rule has no row there.

## Phase 3 as built (2026-11-18)

- **Ladder.** safe < conservative < aggressive < custom. A lower profile only tightens the account's own settings
  (phase 2), so Custom is the top for the live account.
- **Downgrades, never blocked or delayed, in every agent mode; new entries only.**
  - Forced (warning): the kill switch or the daily loss limit (the profile's own) sends the account to Safe. No
    autonomous upgrade is allowed before the next UTC day.
  - Agent, one step each, with hysteresis:
    - a 20% drawdown from the reference (the reference then resets to the equity);
    - 4 losing closed deals in a row since the last switch;
    - M15 ATR of 1000 points or more (latched until it is below 500).
- **Upgrades: one step, on evidence, autonomous mode only.** Approval mode stores a proposal for the owner's Accept or
  Decline. Every gate must hold:
  - below the owner's ceiling;
  - no open position and no pending order;
  - at most one upgrade per 7 days;
  - not before the post-kill block ends;
  - equity at or above the prior balance peak;
  - at least 20 closed deals since the switch with a positive mean net result.

  The check runs in the 5-minute ledger cron on a fresh terminal state. Missing evidence or a failure raises nothing.
- **Owner only** (`POST /omega/api/account-profile`, `OWNER_ACCESS_SUB`, same origin, checked again by the gateway):
  - the ceiling (a ceiling below the profile lowers it at once);
  - the profile, up to the ceiling (the owner's way back after a forced Safe);
  - the agent mode;
  - accept or decline a proposal.
- **Record.** Each switch is recorded in:
  - D1 `omega_profile_changes`;
  - the Omega event `profile_changed`;
  - one Telegram line;
  - a `risk_profile.v1` digest from xauusd-risk-manager, at most one report per 30 minutes. Its items are the opaque
    account reference, from, to, actor, reason, evidence ref (`omega_profile_changes:<id>`) and at. Severity is
    warning for a forced downgrade, info otherwise, never critical.
- **What this means for the live account (Custom, ceiling Custom).**
  - The agent can only step it down, and back up to Custom on evidence.
  - After a kill or the daily loss it is Safe. Climbing back to Custom takes three upgrades a week apart, each on
    evidence, unless the owner sets the profile directly.
- **Limitation.** `ea_deals` carries no account reference, so the streak and the evidence read the deals closed since
  the switch. That is correct for the one account Omega runs today.

## Profile council (2026-11-18)

Owner 2026-11-18, relayed: "libatkan council untuk naik profil". Confirmed in the session: upgrades need the
council's approval; for downgrades, "Council boleh menolak".

- **Module.** `src/profile-council.mjs`.
- **Seats.** Three seats review one change: risk, strategy and trade management.
  - Each seat answers approve or reject with one reason.
  - The evidence pack holds measured facts only, never a price:
    - equity, balance and its peak, and the drawdown;
    - the record since the last switch and per profile (90 days);
    - the volatility regime;
    - the last 20 position-management intents;
    - the strategy council's verdicts.
- **Moderator.** A fixed rule, not a model.
  - Upgrade: applies only when the risk seat approves and at least two of three approve. A seat that fails counts as
    reject.
  - Downgrade: vetoed only when all three seats answered, the risk seat rejects and at least two reject.
- **Upgrades (live).** An autonomous upgrade that passed every measured gate (§6, §10) is reviewed in the 5-minute
  ledger cron. It applies only on approve.
  - No pack, the daily cap, a failed council or a second review the same UTC day all mean no upgrade.
  - The bridge sync never raises a profile.
  - Approval mode is unchanged: the owner's Accept is the decision.
- **Downgrades (on since 2026-11-18, platform ADR-0020 Amendment 5).** `OMEGA_PROFILE_COUNCIL_DOWNGRADE` is `"on"`. The bridge sync convenes the council at once (`profile_review_started`, after the answer). The cap is 2 minutes: a review that has not finished by then applies the downgrade. An invalid verdict counts as no answer, so the downgrade applies. A veto's `risk_profile.v1` item carries its trigger, the profile it held back and `veto_until`. The ceiling the owner lowers never reaches the council. Before Amendment 5 the switch was `"off"`. Platform ADR-0020 Amendment 3 says a downgrade is
  never blocked, so the switch stays off until a platform amendment allows a veto. With `"on"`:
  - A soft trigger (drawdown, loss streak, extreme volatility) writes `pending_downgrade`. New entries wait
    (`profile_review_pending`), and the cron's council reviews it.
  - A veto keeps the profile for up to 24 h (`council_veto`). It lapses sooner if the drawdown reaches 25%, the run
    reaches 6 losses in a row, or a different trigger fires.
  - A failed council, three reviews in a day, or a review not done within 2 minutes applies the downgrade.
  - The kill switch and the daily loss limit never reach the council. They clear any pending downgrade or veto.
- **Record.**
  - One row per review in D1 `omega_profile_councils`; its `id` is the council session id.
  - The council's id, verdict and seats go in `omega_profile_changes.evidence`.
  - The `risk_profile.v1` items carry `council: { id, verdict }`.
  - A veto is an audit row with reason `council_veto` at severity warning.
  - One Telegram line names the verdict and each seat.
  - Omega → Setup → Risk profile shows the last three reviews.
- **Budget.** Metered as `profile_council` with its own daily cap (`PROFILE_COUNCIL_DAILY_USD`, default 0.25). Agent
  inventory entry `profile_council`.

## Account baseline and the owner's reset (2026-11-18)

Owner 2026-11-18, relayed: "beri tombol reset profile supaya jika ada akun yang berbeda hari ini bisa direset tapi
mendeteksi akun ini sebelumnya pernah login di omega atau tidak". Confirmed in the session: "setuju semua".

- **New account = new baseline.** An account is its login hash (OmegaExecutor 1.15+; opaque, never the number).
  - Its first sync seeds the balance peak and the drawdown reference. Losses before Omega never count.
  - The row an older EA left under the server's name is history; it is never adopted, since the server alone cannot
    tell which login it was. The one-time 1.14 → 1.15 adoption of the live account on 2026-11-18 is done.
- **Same account = same history.** A login Omega saw before keeps its row: peak, reference, profile, ceiling, changes.
- **Omega's deals only.** The loss streak, the upgrade evidence and the council's per-profile record read `ea_deals`
  rows with source `omega`, never manual deals.
- **Deposits and withdrawals.**
  - Each check compares the balance with the net of the `ea_deals` rows stored since the last check. A difference
    beyond USD 1 or 0.2% is a balance operation.
  - The drawdown reference and the peak move by it (event `balance_operation`).
  - The write is conditional on the state the check read, so the bridge sync and the cron never apply one operation
    twice.
  - Manual losses after onboarding are real equity and still count in the drawdown.
  - The daily loss (owner 2026-11-18, confirmed: "Setuju keduanya"): each operation is kept for its UTC day
    (`omega_accounts.day_ops`), and `dailyLossExecutor` moves the day's reference by the operations after it (the
    broker's day start: today's; the owner's reset: those after the reset; the onboarding balance already moves with
    them). It applies to the planner's floor and risk budget, the arm's auto-disarm, the profile agent and the overview.
  - A zero balance is never an operation: it is a terminal still loading an account (2026-11-18 16:41, an account
    switch read −98.03 then +52.64). The check skips it and compares the next real reading with the last one.
- **The owner's reset** (Setup → Risk profile → Reset baseline, owner only, a confirm that names the account).
  - It applies to the connected account only.
    - The drawdown reference becomes its equity and the peak its balance.
    - The loss streak and the evidence count from the reset (`baseline_ms`).
    - The volatility latch, a pending downgrade and a council veto are cleared.
    - The profile and the ceiling stay.
  - It is refused while the kill switch is on, and on a day the kill switch or the daily loss limit fired (until the
    next UTC day).
  - The reset is recorded as:
    - one audit row, reason `owner_reset`, with the previous values in its evidence;
    - the event `profile_baseline_reset`;
    - one Telegram line;
    - the `risk_profile.v1` item.
  - The panel shows whether Omega saw the account before: "First time on Omega" (first seen within 15 minutes) or
    "On Omega since <date> · last seen <ago>". It also shows the peak, the reference, the losses in a row and the number
    of profile changes. `last_seen_ms` is written at most every 10 minutes.

- **The onboarding day's daily loss** (owner 2026-11-18, confirmed: "Setuju").
  - On the UTC day Omega first sees an account, the daily-loss reference is its balance at onboarding (`onboard_balance`, or the first seeded peak for a row from before the column), not the broker's day start (`dailyLossExecutor`). It applies to the arm's auto-disarm, the profile agent and the planner.
  - Losses before Omega never trip the limit; losses after onboarding do. Deposits and withdrawals move the reference.
  - A block set on that day before this rule (no `upgrade_block_reason`) is lifted once (event `upgrade_block_cleared`). A block with its reason recorded stands to the next UTC day.
- **The owner's override** (owner 2026-11-18, confirmed: "Ya, boleh override"). On a day the kill switch or the daily loss limit fired, the owner may still raise the profile.
  - The page warns first: "Daily loss limit hit today (−X%). Raise profile anyway?".
  - The change is recorded as `owner_override_daily_lock` (audit, Telegram, `risk_profile.v1`).
  - The agent's own upgrades stay blocked to the next UTC day.
- **Approval-mode proposals** are in Omega → Setup → Risk profile ("Agent proposes … · council … · until …", Accept / Decline).
  - Each proposal carries the council's advice and expires after 24 h; an expired proposal cannot be accepted.
  - Its Telegram line links to https://nexus.cryptophys.work/omega#setup/profile.
  - A badge on Setup and on its Risk profile tab shows a pending proposal or a downgrade waiting for the council.

## Phase 4: the trading-mode selector (2026-11-18)

Owner 2026-11-18, relayed and confirmed in the session ("Setuju"): "libatkan council untuk ganti mode, dan owner punya
hak veto untuk mengubah mode kapan pun". Platform: no ADR-0020 amendment, since Amendment 3 lists the evidence-gated mode
selector. That holds as long as:
- a switch touches new orders only;
- sizing stays SL-based within the profile cap;
- the owner's actions are the owner's;
- the kill switch and the daily loss limit keep their effect.

- **Module.** `src/mode-selector.mjs`. It runs once a UTC day in the 5-minute ledger cron, with the mode on Auto
  (the default; the owner's last mode is the baseline). It writes the trading mode (KV `trading:mode`) that the Decision
  Engine reads at its next 15m close.
- **Evidence.** Each mode's resolved setups in `plan_setups` (control-arm R, the last 90 days), in the current 1H regime
  (30 or more setups), else across regimes. The walk-forward is the strategy council's: pass, fail or collecting.
  The setups load by `opened_at`, then `setup_key` (MS1, 2026-11-23), so the holdout is the same on every run.
- **Feasibility.** The mode's median stop at the broker's minimum lot must risk no more than the profile's hard cap
  (Custom: the risk setting).
- **Fail-safe moves, no council.**
  - Back to the baseline when the current mode's evidence fails.
  - To the feasible mode with the smallest stop when the current one no longer fits.
  - Back to the baseline on a day the kill switch or the daily loss limit fired.
- **A better mode.** A walk-forward pass, feasible, with a mean R at least 0.1R above the current mode's, and the same
  candidate two daily runs in a row. Then the mode council reviews it:
  - Seats: strategy, technical, risk, trade management. Meter `mode_council`, cap `MODE_COUNCIL_DAILY_USD` 0.25.
  - The switch applies only when the risk seat and at least three of four approve.
  - A failure, an invalid verdict or the cap keeps the mode.
- **The owner** (POST `/omega/api/trading-mode`, owner only, checked again in the AI Worker):
  - a mode pins it (it becomes the baseline; the selector stops);
  - "auto" hands it back to the selector and council;
  - "veto" reverts the last automatic switch (within 24 h) and pins it.
  - The Decision card's "Next mode" row shows Auto (council) or pinned, with Auto and Veto buttons. The Omega header
    reads e.g. "Aggressive · 5% · Intraday (auto)".
- **Record.** Each change or refused proposal produces:
  - a row in `omega_mode_changes`;
  - an Omega event (actor `agent:mode`);
  - one Telegram line naming each seat;
  - a `mode.v1` digest item (from, to, actor, reason, evidence ref, at; no price, no lot), at most one report per 30 min.
- **The daily outcome** (MS1, 2026-11-23). Every daily run, a change or not, is one Omega event `mode_selector_run`
  (actor `agent:mode`): status (`pinned_by_server`, `pinned`, `unchanged`, `changed`, `failed`), reason, the step's
  action, and each mode's evidence (n, mean R, status, scope), on a pinned day too. A run already made today records
  nothing.
- **The server pin.** Only the configured `TRADING_MODE` pins the mode. The Decision Engine reads the mode in force
  on a copy of env for its decision and never writes env (MS1), so the mode the selector wrote to KV never reads as the
  server's pin to the selector's next run in the same isolate.
- **Shadow evidence and probation** (MS2, 2026-11-23): see §7. The daily outcome's evidence adds `n_live` and
  `n_shadow` per mode; `GET /api/trading-mode` adds `selector` (per mode and 1H regime, live against shadow, and the
  probation).
- **Not yet.** The ladder's lock distance in R per mode (it is 30 pips for every mode) is the next step. It needs the
  initial stop from the open intent.

## Phases

| Phase | What | Gate to go live |
|---|---|---|
| 1 | EA spec reporting and checks (`OrderCheck`, `OrderCalcMargin`, freeze level), EA 1.15; the Worker stores the spec with its hash and gates entries on the EA version and spec validity; account profiles stored (live account = Custom) | EA 1.15 running on the VPS and spec validated |
| 2 | Sizing within the profile caps, min-lot rule, skip reasons in Nexus and the ledger | unit tests; the live account's sizing unchanged under Custom |
| 3 | Profile agent: approval and autonomous modes, guardrails, audit, Telegram | guardrail tests; ceiling = Custom on the live account |
| 4 | Dynamic mode selector (evidence-gated) and the R-based position manager | grid-adapt-style gate per regime; auto-revert |
