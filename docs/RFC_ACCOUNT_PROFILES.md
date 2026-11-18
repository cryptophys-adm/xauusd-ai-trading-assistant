# RFC: Account Profiles & Dynamic Mode (Omega)

- **Status:** decided by the owner (2026-11-18); building in four phases. Phases 1 and 2 built (EA 1.15, `src/account-spec.mjs`, sizing in `planIntents`). ADR-0020 Amendment 3 merged on the platform (main 1ade63d, 2026-11-18 03:53 UTC).
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
| Custom | the account's own settings (live account: 2% / — / — / 10% / 5) | as set | as set | as set | as set | as set |

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

## 8. Position manager in R

The fixed ±30-pip thresholds in `src/position-manager.mjs` (`THRESHOLD_PIPS`) become R-based per mode, e.g. break-even at +0.5R and a cut at −0.5R when signals weaken.

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
- **EA version gate.** `OMEGA_EA_VERSION_GATE` "on" blocks new entries for an EA before 1.15 (`ea_outdated`). It
  shipped "off" and is on since 1.15 runs on the VPS: seen 2026-11-18 04:17:31 UTC (the 1.14 row adopted, the spec
  changed with the new fields), validated 04:18:32 UTC.

## Phase 2 as built (2026-11-18)

- **Limits.** `effectiveLimits(profile, settings)`: each limit (risk per trade, positions, daily loss) is the smaller of
  the profile's cap and the engine setting, so the Aether policy only tightens inside the profile. Custom is the
  settings unchanged: the live account sizes exactly as before (test AS14).
- **Minimum lot.** Below `volume_min` the minimum lot is used only when its real risk is within the profile's hard cap
  per trade (`min_lot_within_cap`); otherwise the setup is skipped (`volume_below_min`) with the numbers, e.g. "stop
  500 pts: the minimum lot 0.01 risks 5% of 100, over the Safe cap of 2%". Custom has no hard cap and skips as before.
  The day's risk budget still applies after it.
- **Total open risk.** What the open positions lose at their stops plus the new entry stays within the profile's total
  open risk: the lot is capped (`lot_capped_open_risk`) or the entry skipped (`open_risk_cap`). It never raises a lot.
- **Leverage is never an input.** Sizing uses the stop distance and the loss tick value only; the margin is the
  broker's `OrderCalcMargin` and `OrderCheck` answer in the EA. A reported leverage of 1:100,000 or more (the FxPro
  demo reports 1:2,000,000,000, margin USD 0.38 a lot) is shown as "unlimited" on the Omega page.
- **Where the reasons show.** The Omega page's entry status, with the numbers (`planner.details`, stored with the plan
  event when the codes change). The Signal Ledger replays in R, without lots, so the minimum-lot rule has no row there.

## Phases

| Phase | What | Gate to go live |
|---|---|---|
| 1 | EA spec reporting and checks (`OrderCheck`, `OrderCalcMargin`, freeze level), EA 1.15; the Worker stores the spec with its hash and gates entries on the EA version and spec validity; account profiles stored (live account = Custom) | EA 1.15 running on the VPS and spec validated |
| 2 | Sizing within the profile caps, min-lot rule, skip reasons in Nexus and the ledger | unit tests; the live account's sizing unchanged under Custom |
| 3 | Profile agent: approval and autonomous modes, guardrails, audit, Telegram | guardrail tests; ceiling = Custom on the live account |
| 4 | Dynamic mode selector (evidence-gated) and the R-based position manager | grid-adapt-style gate per regime; auto-revert |
