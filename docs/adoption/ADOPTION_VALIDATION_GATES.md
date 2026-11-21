## Objective

Provide shared, reproducible acceptance and comparison gates for the ORB, Adaptive Entry Confirmation and Monte Carlo adoption PRs. This PR must not create a second source of truth or duplicate the canonical performance ledger.

## Read first

- `AGENTS.md`
- `docs/SSOT.md`
- `docs/BACKLOG.md`
- `docs/RFC_STRATEGY_AGENTS.md`
- Existing Signal Ledger, strategy-agent records, scorecards, replay and Omega v4 parity contracts.

## Required behavior

1. Identify existing canonical data and reporting endpoints for agent performance, trade outcomes and Omega parity. Reuse them; do not create a new ledger, API, Worker, database/table or independent SSOT.
2. Define a common evaluation protocol for new strategy/entry variants:
   - frozen baseline and candidate identity/version;
   - chronological train/validation/holdout windows;
   - setup/trade sample counts;
   - per-session, per-agent, per-trading-mode and per-regime breakdown where sample permits;
   - expectancy, mean R, profit factor, max drawdown, win/loss/even, fill rate, missed-winner and false-signal measures as applicable;
   - costs/spread/slippage treatment and missing-data disclosures.
3. Separate realized production outcomes, historical replay, shadow outcomes and Monte Carlo simulations in both schemas and report language.
4. Define minimum sample / confidence gates from existing SSOT and RFC rules. Do not introduce conflicting thresholds. Where docs disagree (for example Plan Learner thresholds), flag for owner/SSOT reconciliation rather than silently choosing one.
5. Add a baseline-vs-candidate report format and deterministic tests proving no leakage, correct R aggregation, correct segmentation and evidence labeling.
6. Document promotion criteria as an owner-controlled decision. This PR must not enable candidate strategies or change production flags.

## Acceptance criteria

- Uses existing source-of-truth records and interfaces.
- No duplicate performance database, endpoint, Worker or SSOT.
- No change to live execution, Strategy Council weights, Omega or risk limits.
- Results include sample sizes and limitations; insufficient sample is explicitly inconclusive.
- Cross-PR contract is documented so the three adoption implementations produce comparable evidence.
- Add/update docs and tests; run the checks required by `AGENTS.md`.

## Out of scope

- Building a new dashboard, API, database, Worker or generalized analytics platform.
- Activating ORB or adaptive confirmation in production.
- Changing existing thresholds without an owner-approved SSOT update.

## Deliverable

A shared protocol and tests/report template that the other adoption PRs can use. Keep this narrow; do not duplicate the existing performance analytics.