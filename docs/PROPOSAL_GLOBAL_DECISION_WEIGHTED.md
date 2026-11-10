# Proposal: Global Decision as a Continuously Tuned Linear Weighted Model

Status: DRAFT (owner approval required before implementation)
Date: 2026-11-10
Owner: AGY
Related: docs/SSOT.md §Decision Engine, src/weighting.mjs, src/aether-push.mjs

## 1. Problem
The current Decision Engine (src/decision-engine.mjs) weighs 7 witnesses (D1, H4, H1, M15, NEWS, MACRO, STRATEGY)
with fixed weights summing to 1.0. Right-panel context (Key levels, structure/regime, trend by timeframe,
macro drivers, session clock) is displayed but not part of the decision. The owner wants the Global Decision
to be a linear weighted equation whose weights are tuned continuously by Aether, similar to the room quorum
weighting already in src/weighting.mjs.

## 2. Proposed Witness Set (expanded)
Keep the 7 core witnesses and add context witnesses derived from right-panel data:

Core (unchanged):
- D1, H4, H1, M15, NEWS, MACRO, STRATEGY

New context witnesses (each must be deterministic, from closed bars / approved local records only):
- KEY_LEVELS: strength of the nearest candidate zone and at-level flag (from Key Level Agent)
- REGIME: 1H regime sensor vector (trend, efficiency, stretch, volume, cycle, order, chaos flag)
- TREND_TF: weighted trend alignment across D1/H4/H1/M15 (already in strategy, exposed separately)
- MACRO_DRIVERS: gold vs DXY/yield/silver/oil correlation and change (from correlations)
- SESSION: session clock phase (Asia/London/NY) as a contextual bias

Each new witness produces a lean in [-1, 1] and a confidence, or null (drops out, rest renormalise).

## 3. Linear Model
score = sum(w_i * lean_i * conf_i) / sum(w_i * conf_i)  (renormalised over available witnesses)
bias = sideOf(score)
stance = BUY/SELL/WAIT based on score vs quorum threshold and guardrails.

Weights w_i are per-witness and per-regime, stored in D1 weighting_states (extended with a
"global_decision" timeframe scope) or a new table global_decision_weights.

## 4. Continuous Tuning by Aether
Reuse the machinery in src/weighting.mjs and src/weighting-replay.mjs:
- Score each witness's contribution against 4-candle outcomes (outcome_scores).
- Replay candidate weight sets over the last N decisions (discovery + holdout).
- Auto-activate a better weight set (Holm-adjusted, p < 0.05) at most once per 7 days.
- Rollback via reverse shadow if the previous set performs better.
- Telegram notify on activation/rollback.
- Aether audits via KnowledgeIngress weighting report (mode: "global_decision").

## 5. Guardrails (unchanged)
The 7 guardrails (fresh, quorum, confirmation, no_veto, levels, reward, confidence) remain deterministic.
Weights only affect the council's evidence and the fallback score; they never bypass guardrails.

## 6. Safety & Rollout
- Feature flag: GLOBAL_DECISION_WEIGHTED = "false" initially.
- Shadow mode: compute the weighted score in parallel, log to D1, compare with current 7-witness score.
- No change to production decision until shadow shows consistent improvement (>= 200 decisions).
- Kill switch restores the current 7-witness model.

## 7. Implementation Steps (when approved)
1. Extend witnessCards() in src/decision-engine.mjs to accept context inputs (key levels, regime, correlations, session).
2. Add weight loading from D1 (global_decision scope) with default equal-ish weights.
3. Integrate weighting replay for the new scope.
4. Add shadow logging and Aether report.
5. UI: show weights and tuning status on the Decision card.
6. Tests: unit tests for witness expansion, replay, auto-activation.

## 8. Risks
- Overfitting to recent regime; mitigated by shrinkage and holdout.
- New witnesses may be noisy/unverified; they drop out when null.
- Complexity in council evidence; keep context separate from weighted score.

## 9. Decision Needed
Owner approval to proceed with implementation and shadow rollout.