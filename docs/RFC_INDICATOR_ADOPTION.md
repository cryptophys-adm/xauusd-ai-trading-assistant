# RFC: Adopting the unported GMI, Prophet and Mizan modules

Status: **proposed, waiting for the owner's confirmation of the plan and the order** (owner 2026-11-19, relayed by the
orchestrator: "adopsi semuanya"). Nothing here is built until the owner confirms. The four agents dismantled on
2026-11-11 (R37 Funnel, GABFX Price Action, Playbook Execution, Grid Bot Protocol) stay dismantled.

"Adopt" means: computed locally from closed bars and read by an agent, by the Decision Engine as a witness, or by the
Position Manager as evidence. It never means a second decision or a second trade plan.

## What the canon requires of every stage

- **Parity (parity_trust_only).** A value is trusted only when TradingView confirms it.
  - A pure formula of closed bars, such as a pivot, a range or a session, is marked *derived* once the bar itself is
    verified against TradingView. This is how Camarilla, CPR and the sessions are read today.
  - An engine-state value (an oscillator, a latch, a score) is *verified* only after 24 consecutive candles match the
    same field in a TradingView alert (`DEFAULT_POLICY.promoteAfter`).
  - Until then the line is shown as unverified. Nothing is marked verified by hand.
- **Promotion (promotion_by_owner).** A new line in an agent's prompt is a new prompt input. It runs first in the
  existing shadow arm (`shadow:war_room_opening`, `shadow:tf_room_opening`), is scored by outcome scoring with the
  sign test, and goes live only on the owner's approval.
- **One decision, one plan (fail_closed_wait).**
  - Mizan s17 (safe_mode, gravity_veto, sniper_override), s20 (the Bayesian verdict and action_label) and the SL, TP
    and position boxes of GMI and Prophet are evidence an agent argues from, never an authority.
  - Prices still come only from the Key Level Agent's plan.
  - Nothing bypasses `tick_value_mismatch`, `volume_below_min` or the profile caps.
- **Public filter.** No new field reaches a public page with a decision, confidence, price or order wording.

## Stages

The order is my recommendation: cheapest first, then what serves the mode in force (scalp, 92% of decisions on 10-19
Nov), with new agents last.

| Stage | What | Read by | New agent | Parity route |
|---|---|---|---|---|
| 1 | **Computed but unread** (list B). GMI: Aegis buy/sell volume, bar delta, CVD 14, volume surge, validated OB bounds and nearest OB stop, Spacetime Warp, TVA adaptive period, previous-session profile and whale zones, the reversal-bar and JMA projection values. Prophet: early confirmation, divergence events with origin, OB rank/retests/high-volume, risk-gate numbers, pro_core. Mizan: ob_high_volume, vol_anomaly. | Existing HUD agents: Aegis, Kinetic, Fabio, Order Blocks, Prophet, Trade Management | No | Pure bar formulas are derived. Engine fields are added to the GMI and Prophet alert JSON in `pinescript/ssot`; the owner reinstalls the alerts, then the 24-candle parity applies. |
| 2 | **Scalp signals.** Decision Matrix Scalp Burst Index (5 points). Prophet: momentum strengthening/weakening suffix, ±0.35 threshold crossings and bands, CSHI score and the MARKET row, counter-trend reversal watch, momentum projection. | Decision Matrix and Prophet (rooms); Position Manager as evidence | No | Engine fields in the alert JSON (as stage 1). |
| 3 | **Level families.** Chronos: Asian range, daily R1-R3/S1-S3, CPR width class against the 20-day mean, wick reject, CPR × GMI confluence. Interstellar Eyes 5m Camarilla column, the 10 unused Fibonacci ratios, the TDM histogram blocks. Prophet R37 rolling 20/50/100-bar extremes. | Chronos and Interstellar (rooms); the Key Level Agent as candidate zones | No | Derived (pure bar formulas). |
| 4 | **Order flow and structure.** Aegis WAI, ACC/DIST diamonds and life CVD; Kinetic Anomaly Jerk and phase label; Tactical VPT; Fabio Active SMR and MML liquidity. Mizan s15 bos_detect and sweep_detect, s21 trap_detect, s16/s25 52-week extremes and macro trendline, s14 zone metrics. | Aegis, Kinetic, Tactical, Fabio, Order Blocks; Position Manager as evidence | No | GMI fields in the alert JSON. The Mizan structure functions are derived where they are pure bar formulas; the rest go through the stage 5 probe. |
| 5 | **The Mizan statistical stack.** s1-2 weights; s3 phi_wave and regime_score; s4 oracle_signals; s5 mtf_hurst, mtf_zscore, phi_confluence; s8 risk_score; s11 psi_field, gamma_dilation, psi_adaptive, rho_phase; s12 asset_gravity; s13 entropy_tensor, vol_anomaly_tensor, noise_level; s14 confidence_matrix; s17 safe_mode, gravity_veto, sniper_override; s18 div_bonus; s19 state_energy; s20 bayesian_net_tick and action_label; s22 markov_win_rate. | **A new agent, "Mizan Oracle"** (rooms; a witness of the Decision Engine only after promotion) | **Yes** | No installed indicator calls these functions, so TradingView has no reference. Proposal: a small **Cryptophys Mizan Probe** indicator in `pinescript/ssot` that calls the library and sends the values in one alert JSON on 15m. The owner installs it on TradingView; the usual 24-candle parity then applies. |
| 6 | **Second trade plans, as evidence only.** GMI Fabio progressive SL, SMC zones, position box and % CAP sizing; Prophet latched entry reference, manual position management and its exit reasons, TARGET KEY latch and HIT; Mizan s19 project_tp/project_sl. | Position Manager, as "what the indicator's own plan says" beside Omega's plan | No | Engine fields in the alert JSON. They are never used as a price for an order. |

## Settled before building (orchestrator review of this RFC)

1. **The Position Manager gets no new line until it has its own shadow.**
   - The Position Manager closes live positions by itself; both Omega trades of 19 Nov were closed by it (`pm_take_profit_weakening` and `pm_cut_loss`). A new line in its prompt therefore changes exits on real money.
   - Stages 2, 4 and 6 add nothing to its prompt until a Position Manager shadow arm exists. That arm runs the same snapshot with and without the new lines; the live action stays the control's.
   - **Paired outcome.** For each position-management decision where the arms differ (close versus hold, or a different stop), the score is the R the position would have made. For a close, that is the R at the close. For a hold, it is the R at the position's actual later exit, or at the stop or target, whichever the bars reach first.
   - It uses the same sign test with Holm, discovery and holdout. The owner promotes.
   - Building that arm is a stage of its own (stage 0b), before any Position Manager line.
2. **The unit of promotion is one agent in one stage.**
   - Each agent that gets new lines in a stage has one shadow arm carrying all of that agent's new lines for the stage.
   - Holm runs across the arms of the stage. If an arm fails, the agent and the stage it belongs to are known; the lines inside it are tested again only if the owner asks.
   - **Duration, stated honestly.** The 15m room runs about 92 decisions a weekday. Each arm needs 200 discovery and 100 holdout paired decisions where it differs from the control, and only a share of decisions differ. That puts one stage at **2 to 4 weeks**.
   - Run one after the other, the six stages take **3 to 5 months**. Arms on different agents can run at the same time, so overlapping stages 1-4, which touch mostly different agents, brings this to about **6 to 10 weeks**. Stage 5 starts only once the Mizan Probe has 24 matching candles.
3. **One Pine update and one reinstall for every stage.**
   - Emitting a field costs nothing until an agent reads it, and the 24-candle parity count can start for every field at once. So one update of the GMI and Prophet alert JSON in `pinescript/ssot` carries every field of every stage. The owner reinstalls the two alerts once, and installs the Mizan Probe in the same sitting.
   - **Size.** TradingView allows 40,960 characters in a message built by Pine's `alert()` or `alert_message` (4,000 in the alert dialog's Message field). Both alerts are "Any alert() function call", so the larger limit applies.
   - Before the update is designed, each payload is measured against that limit. A payload close to it is split into a second `alert()` call on the same bar.
   - Inbound webhooks do not count against the 500-a-day budget, which is the pull adapter's outbound calls.
4. **Path-dependent values.** Life CVD, the SMR reservoir, whale-zone HP and age, the Markov win rate and other cumulative values depend on where the history starts. The chart's start depends on how much history TradingView loads, which the local replay cannot match.
   - These values are compared by their **per-bar change**, the increment of the closed bar, which does not depend on the start. Their level is shown only as unverified context.
   - A value that is not cumulative but has a long warm-up (for example a 52-week extreme) is compared only after the local series covers its whole window.
5. **What the Mizan agent may say.**
   - Mizan s17 (`safe_mode`, `gravity_veto`, `sniper_override`) and s20 (`action_label`, the Bayesian verdict) would be verdicts in everything but name. The agent states the measured inputs and the score, for example "the Bayesian posterior for a long is 0.62". It never states the label as an instruction.
   - The words `sniper`, `override`, `veto`, `safe mode` and the action labels are added to the public filter as decision words. They never reach a public page.
   - The council reads the agent like any other witness: as evidence, not an authority.

## Cost

**Baseline** (D1 `ai_usage_daily`, weekdays 16-18 Nov): about 4,200 model calls and 6.1 million prompt tokens a day.
The largest sources are:
- the decision council (105 calls, about 10,000 tokens each);
- the War Room openings (641 calls, about 830 tokens each) and rebuttals (618 calls, about 1,700 tokens each);
- the timeframe rooms;
- the shadow arms, which roughly double the openings.

**Per stage.** A new HUD line costs about 25-40 tokens. It is paid in the agent's own opening, again in the rebuttals
that quote openings, and again in the shadow arm while it is being tested. The estimates are for the time in shadow;
after promotion the shadow copy goes away.

| Stage | Extra prompt tokens a day | Share of today | KV / D1 |
|---|---|---|---|
| 1 | +150k to +200k | about +3% | No new KV writes: the fields ride on the existing HUD snapshot write (a slightly larger value). |
| 2 | +100k to +150k | about +2% | None new |
| 3 | +50k (room lines); the Key Level Agent is deterministic | about +1% | None new |
| 4 | +100k to +150k | about +2% | None new |
| 5 | +300k to +450k: a new opening in every room, plus its rebuttals and its shadow arm | about +5 to +7% | About +10% room message rows in D1. One more TradingView alert: about 96 inbound webhooks a weekday. These are not counted in the 500-a-day budget (`tv-budget`), which counts only the pull adapter's outbound calls. |
| 6 | +50k (Position Manager prompt) | about +1% | None new |

All stages together come to about +15 to +20% prompt tokens while in shadow. The existing guards stay in place: the
shadow kill switch, the daily neuron breaker and the room memo.

## Knock-on effects

- **Stages 1-4 and 6** add lines to existing agents only. The roster does not change: the platform registry and DNA,
  the kernel's 32 registered agents, and the CTA War Room's 49 figures.
- **Stage 5** adds one agent:
  - a manifest;
  - a platform agent id with its registration and DNA;
  - the kernel count goes to 33;
  - a CTA War Room figure with a one-word name and an icon;
  - the public filter for its lines;
  - a reputation and scorecard entry.

  As a Decision Engine witness it would also need a weight, starting at a prior inside the doctrine's 0.02-0.28.
  The witness-weight auto-tuning then moves it.
- **Docs.** `docs/HUD_AGENTS_ASSESSMENT.md` is stale. It says Camarilla is not ported and that s_jerk is computed
  locally; both are wrong on main. Stage 1 corrects it.

## Questions for the owner

1. **The order.** Is stage 1 → 2 → 3 → 4 → 5 → 6 the right sequence, or should something come first?
2. **Parity for the engine fields.** Agree to extend the GMI and Prophet alert JSON in `pinescript/ssot`, and to
   reinstall the two alerts on TradingView when a stage is ready?
3. **Parity for Mizan.** Agree to install a **Cryptophys Mizan Probe** indicator with one 15m alert? Without a
   reference, the Mizan values can only be shown as unverified.
4. **Stage 5 agent.** One new "Mizan Oracle" agent in the rooms, read as evidence and becoming a witness only after
   promotion? Or spread the values over the existing agents, with no new agent?
