# RFC: the plan learner (entry and risk from gold's own price action)

Status: step 1 built on 2026-11-13, shadow only. Canonical state: `docs/SSOT.md` ("Plan learner");
open steps: `docs/BACKLOG.md` item 23.

## 0. Goal

Owner 2026-11-13: "Kita butuh strategy modul learning yang adaptif terhadap price action supaya entry
dan resiko lebih presisi." The strategy engine places every plan by fixed rules (`tradeLevels`): the
entry at the key zone's near edge or at price, the stop behind the next zone plus 0.2 ATR, the target at
the next key level. The rules do not look at what price did after earlier plans. On 2026-11-13 the
Signal Ledger held 34 Decision Engine signals: a scalp plan's stop was about 14 points (one 1H ATR)
for a target about as far (RRR about 1.1), while the trades that reached their target had gone only
0.31R against the entry first. The plan is safe and imprecise.

## 1. What is learned

Two numbers of a plan, per market condition:

- **entry shift**: how much deeper than the plan's entry (toward the stop) the entry should wait, in 1H
  ATR. A deeper entry is a better price and a smaller risk, and fills less often.
- **stop scale**: the stop distance as a share of the plan's, from the plan's entry. A tighter stop
  raises the reward per risk and is hit more often.

The target stays the plan's key level. The learner chooses on a fixed grid (entry shift 0, 0.1, 0.2,
0.3 ATR; stop scale 0.5, 0.65, 0.8, 1, 1.25), 20 arms; the control is the plan as it is. A grid, not a
free model: every arm is a plan a person can read, and the sample is small.

## 2. How it is measured

- **Setup**: one plan the engine held, the first decision of a run of BUY or SELL decisions with the
  same stop and target. The engine repeats a plan every 15 minutes; counting each repeat would count one
  price path many times.
- **Replay**: each arm of each ended setup on the Signal Ledger's bars (1m where the 1m series reaches,
  15m before) with the ledger's own simulation, so the learner and the Performance page read price the
  same way. A plan at its level is entered at market on the first bar (within 0.35 of its stop distance),
  as Omega enters it. An entry may fill only while the engine repeated the plan (at most 8 hours). A result is in
  R of the arm's own risk, because the lot follows the stop distance; an entry that never fills is 0R,
  so a deeper entry pays for the trades it misses.
- **Context**: the trading mode and the 1H regime of the decision (volatility and character, for
  example `scalp|low-ranging`).

## 3. How it learns

Per arm, the mean difference against the plan on the same setups. A context's estimate is shrunk
toward the estimate over every context, and that toward zero, with a prior worth 20 setups. A context
picks the arm with the largest shrunk gain when it exceeds 0.05R per setup and the arm was replayed on
at least 20 setups; else it keeps the plan. With little data the learner therefore changes nothing.

## 4. The referee

Walk-forward only: for each setup the learner sees the setups that had resolved before it opened,
picks, and its pick is compared with the plan on that setup. The engine writes a new plan at almost every 15m
close (production: 189 setups in four days), so setups overlap and share one price move; the test
therefore counts only independent setups, those that opened after the one counted before them had ended.
A one-sided sign test on their older part (p < 0.05, mean difference above zero), their newest quarter
(at least 15) held out and required to agree. The verdict is `collecting` below 60 independent setups or
20 decisive ones, then `better_than_plan` or `not_better`.

## 5. Risks and their guards

- **Small samples and outliers**: the shrinkage, the 20-setup minimum per arm, the margin; the referee
  judges the learner, not an arm.
- **Coarse bars**: a tight stop on a 15m bar that holds both the stop and the target counts as the stop
  (the ledger's rule), so older history is biased against tight stops, never for them.
- **Fills**: the replay fills a limit when price trades at it; a real fill needs price through it. The
  spread and the broker basis are not modelled (as in the ledger's plan policy).
- **Regime change**: 90 days of setups, re-learned at every run; the referee keeps running after a
  verdict, and a learner that stops being better loses it.

## 6. Steps

1. Shadow (built): setups, replay, learner, referee; `GET /api/plan-learning`; nothing reads it.
2. Nexus: the grid, the pick per context and the learned plan beside the latest decision's plan.
3. Applying it (owner approval, after a `better_than_plan` verdict): the Decision Engine's trade takes
   the learned entry and stop inside the guardrails (the reward threshold is checked again), and the
   Signal Ledger measures both. Until then no decision, EA signal or Omega order changes.
4. Later arms once the sample allows: the stop at the broker's 15m swing, the target by the reach of
   past moves, the speed of the approach as context.
