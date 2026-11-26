# Track A PR 8: the opening-range edges as key levels, on vs off (read-only, aggregates only)

`node scripts/studies/orb/orb-levels-replay.mjs --data <dir>`, run 2026-11-26.

**Data.** The 301 stored strategy captures in D1 `strategy_inputs`, 2026-11-09 to 2026-11-26. These are the slim inputs
`buildStrategy` reads, one per 1H candle.

**Method.**
- Each capture is built twice:
  - with the edges on, the new default;
  - with `modes.orbLevels` set to "off", which gives today's levels.
- From each build, every strategy agent's plan on both sides is computed:
  - all agents are treated as live;
  - the live TP1 key-zone and entry-zone switches are applied;
  - no regime is given.
- This is a report, not a gate.

## Key levels

| | Count |
|---|---:|
| Captures with a live opening-range window | 160 of 301 |
| London ranges live | 104 |
| New York ranges live | 92 |
| Captures where the edges are in a zone | 157 |
| Edge levels | 374 |
| Zones an edge joined | 368 |
| Captures where the number of zones changed | 2 |
| Captures where the candidates differ | 40 |
| — one more candidate | 1 |
| — one fewer candidate | 2 |
| — same count, bounds or role moved (an edge widened a candidate) | 37 |
| Candidates whose third family was the edges' session family | **0** |
| Strategy direction or decision changed | 0 |

The edges never made a candidate: no candidate needed the session family that the edges brought. What they change is the
bounds of zones they join, and in 3 captures the cap per side kept a different pair of candidates.

## Agent plans (both sides, all agents)

| | Count |
|---|---:|
| Plans compared (present on or off) | 1084 |
| Unchanged | 1037 (95.7%) |
| Appeared with the edges | 9 |
| Vanished with the edges | 5 |
| TP1 moved | 29 |
| Stop moved | 11 |
| Entry moved | 3 |

Plans changed per agent:

| Agent | Changed / compared |
|---|---|
| zone_pullback | 21 / 371 |
| sweep_reversal | 7 / 104 |
| breakout_retest | 4 / 183 |
| pattern_lines | 4 / 130 |
| orb_breakout | 4 / 74 |
| pattern_curve | 3 / 57 |
| pattern_inside | 3 / 80 |
| pattern_peaks | 1 / 70 |

## Limits

- The captures are hourly, not every 15m close.
- No outcome is scored here. This measures what the levels change, not whether the changes pay.
- Agent plans are computed with every agent live and no regime. Production uses its own statuses and the 1H regime.
