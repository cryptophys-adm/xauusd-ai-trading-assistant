## Objective

Adopt the useful Entry Timer / ATR confirmation ideas as a bounded, explainable confirmation layer for existing strategy plans. Do not create a second Decision Engine or replace Prophet, GMI, MizanLib, the strategy agents, Council, Plan Learner or Omega.

## Read first

- `AGENTS.md`
- `docs/SSOT.md`
- `docs/RFC_STRATEGY_AGENTS.md`
- `docs/RFC_PLAN_LEARNING.md`
- Existing entry, plan, reward-guard and signal-recording code/tests.

## Required behavior

1. Trace the current decision-to-plan-to-execution path and identify the narrowest existing integration point. Document it before coding.
2. Evaluate closed-candle confirmation, ATR-normalized breakout strength, retest/hold confirmation, volatility regime and entry expiry against the current plan.
3. Implement only confirmation dimensions that are not already implemented. Reuse existing ATR/regime calculations; do not duplicate market data or indicator engines.
4. Confirmation must be deterministic, pure where practical, and explainable. Return structured pass/reject/insufficient-data outcomes and stable reason codes.
5. Never use a forming candle as final confirmation. Define behavior for stale, missing, conflicting or insufficient bars as fail-closed / no confirmation.
6. Preserve the Council's authority over direction and the existing deterministic price-plan and reward/risk guardrails.
7. Keep the feature shadow/research-only by default. Do not change production flags, decision weights, agent live lists or execution behavior.
8. Compare each confirmation rule against an unfiltered baseline, and measure both rejected signals that would have lost and rejected signals that would have won. Avoid cherry-picking.
9. Add unit and integration tests for closed vs forming bars, long/short symmetry, ATR edge cases, gaps, retests, late entries, stale data, duplicate events and deterministic reason codes.

## Acceptance criteria

- No new Worker, database/table, external data provider or broker path.
- Existing signals and execution are unchanged unless an owner-approved, separately gated promotion is made later.
- Each rejection has an auditable reason.
- Historical results are reported by strategy agent, trading mode, session and 1H regime where sample size permits.
- Use chronological/walk-forward validation and disclose sample counts and confidence/uncertainty.
- Demonstrate that the filter does not improve headline win rate merely by discarding too many valid opportunities; include opportunity capture / missed-winner metrics.
- Add/update docs and tests; run the checks required by `AGENTS.md`.

## Out of scope

- New signal direction logic or a parallel entry engine.
- Modifying Prophet, GMI, MizanLib Pine source or their parity trust.
- Modifying Strategy Council, Omega, Position Manager, live config or topology.

## Deliverable

Implement the smallest valid integration in shadow/research mode, backed by before/after evidence. If the existing system already provides an equivalent control, document it and avoid redundant code.