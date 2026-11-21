## Objective

Implement a deterministic Session Opening Range Breakout (ORB) strategy as a new Strategy Agent, reusing the existing strategy-agent contract and lifecycle. This is an adoption into the existing XAUUSD system, not a parallel strategy engine.

## Read first

- `AGENTS.md`
- `docs/SSOT.md`
- `docs/RFC_STRATEGY_AGENTS.md`
- `docs/BACKLOG.md`
- Existing implementation in `src/strategy-agents.mjs`, strategy council and Strategy Agents tests.

## Required behavior

1. Define ORB as a registry agent using the existing `{ id, version, label, fits, plan(dir, ctx) }` contract.
2. Keep the strategy pure and deterministic. It may return a plan or `null`; it must not read room messages, quorum/witness state, make the directional decision, call an LLM, or create orders.
3. Derive the opening range from explicit, documented XAUUSD session windows. Treat London and New York as distinct configurations; handle daylight-saving transitions, weekends, missing bars and daily market breaks explicitly. Do not hardcode an unverified UTC offset as the session definition.
4. Use closed bars only. Define range start/end, breakout confirmation, retest eligibility, invalidation, expiry and duplicate-setup prevention.
5. ATR may normalize breakout distance and risk, but respect existing global stop/risk/reward guardrails. Do not duplicate or bypass them.
6. Produce explainable plan metadata using existing conventions; every rejection must have a deterministic reason available to tests/records where supported.
7. Keep ORB shadow-only by default. Do not add it to production live allow-lists or modify Wrangler production variables. Promotion remains owner-controlled.
8. Add tests for both sides, London/New York sessions, DST boundaries, forming-bar exclusion, breakout/retest, false breakout, range-too-wide/too-narrow, stale/missing bars, expiry, duplicate setup and global guardrails.

## Acceptance criteria

- Existing 13 agents and their behavior remain unchanged.
- ORB integrates through the current registry and strategy measurement path.
- No new Worker, service binding, database/table, external market-data provider or broker integration.
- Historical XAUUSD evaluation reports setup count, fill rate, mean R, expectancy, profit factor, stop/target rates, and results by session, trading mode and 1H regime where data permits.
- Evaluation uses chronological/walk-forward separation; no in-sample result is presented as out-of-sample evidence.
- If historical session data or runtime records are unavailable, document the exact limitation; do not fabricate performance.
- Add/update docs and tests. Run the checks required by `AGENTS.md`.

## Out of scope

- Enabling ORB for live trading.
- Changing Decision Engine, Strategy Council weights, Omega, Position Manager or five-Worker topology.
- Editing `pinescript/ssot/*`.

## Deliverable

A complete implementation and tests, plus a concise evidence-based evaluation. Do not stop at an architecture proposal. If prerequisites block implementation, report the precise blocker and leave the strategy shadow/off.