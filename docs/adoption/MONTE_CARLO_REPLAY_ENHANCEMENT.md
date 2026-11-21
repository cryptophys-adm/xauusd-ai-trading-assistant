## Objective

Adopt and improve the external Time Machine's statistical validation ideas for XAUUSD strategy evaluation. This is a research/backtest capability, never a trade signal or production control.

## Read first

- `AGENTS.md`
- `docs/SSOT.md`
- `docs/RFC_STRATEGY_AGENTS.md`
- `docs/RFC_PLAN_LEARNING.md`
- Existing replay, Omega v4 parity, Signal Ledger, performance scorecard and test implementations.

## Required behavior

1. Audit current replay/simulation facilities first. Reuse existing engines and data contracts; do not create duplicate simulation or ledger systems.
2. Add reproducible Monte Carlo analysis for resolved XAUUSD setup/trade outcomes. Use explicit seed, simulation count, input window, assumptions and versioned methodology.
3. Distinguish at least:
   - resampling independent trade outcomes (sequence risk);
   - block/bootstrap resampling where serial dependence matters;
   - session/regime-stratified resampling where justified.
   Do not independently shuffle candles and then claim realistic market-path simulation.
4. Report distributions/quantiles for expectancy, cumulative R, max drawdown, losing streaks, ruin/guardrail breach probability where definable, and sample-size sensitivity.
5. Preserve chronological and walk-forward boundaries. Do not leak future records, use in-sample parameter choices in holdout, or mix simulated and realized trades.
6. Label synthetic/simulated evidence distinctly from realized ledger results. No Monte Carlo output may arm a strategy, change parameters, modify an EA/Omega order or override a guardrail.
7. Document assumptions and known limitations: non-stationarity, clustering, regime shifts, spread/slippage, broker fills and small samples. Model costs only where supported by verified data; otherwise disclose omissions.
8. Add deterministic tests for seed reproducibility, empty/small samples, missing outcomes, drawdown calculation, block boundaries, leakage prevention and output labeling.

## Acceptance criteria

- No new Worker, database/table, external data provider or execution dependency.
- Reuses the canonical ledger/replay source and respects its provenance.
- Includes comparison against simple baseline statistics and sensitivity to simulation method / sample size.
- Output is repeatable and traceable to input window, data source, code version and assumptions.
- Historical evaluation is split chronologically; report out-of-sample separately.
- If existing records cannot support the requested analysis, expose the limitation rather than fabricate estimates.
- Add/update docs and tests; run the checks required by `AGENTS.md`.

## Out of scope

- New trading strategy or signal.
- Replacing Omega v4 parity validation.
- Automatic strategy promotion, parameter tuning or live execution changes.

## Deliverable

A working research utility/report integrated with existing reporting conventions, with tests and a methodology note.