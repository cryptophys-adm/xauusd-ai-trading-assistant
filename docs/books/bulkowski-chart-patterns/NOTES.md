# Chart patterns for the Projection Agent

- **Source:** Thomas N. Bulkowski, *Encyclopedia of Chart Patterns*, 2nd edition, John Wiley & Sons, 2005.
  The book itself is not kept in this repository (it is copyrighted); only this note and the code are.
- **Owner decision (2026-11-12):** "adopsi semua yang ada di buku untuk main muscle knowledge Projection
  Agent": the agent reads Fibonacci, the cone and trendlines, and now the book's 53 chart patterns and
  10 event patterns.
- **Code:** `src/chart-patterns.mjs` (catalogue and detectors), used by the Key Level Agent under the
  Projection Agent's name. Tests: `test/chart-patterns.test.mjs`.

## What was taken, and what was not

Taken, and written from scratch in our own code and words:

- **The catalogue:** every pattern of the book by chapter number (`PATTERN_CATALOG`, 63 entries).
- **How a pattern is recognised** on closed bars: its turning points, boundary lines, peaks and valleys.
- **The breakout:** the close beyond a pattern's line that confirms it.
- **The measure rule:** the pattern's height projected from the breakout gives a target.
- **The return to the breakout price** (throwback after an upward breakout, pullback after a downward one):
  the broken line is kept as a level.
- **The busted pattern:** a one-sided pattern that closes beyond its other side reads the other way.

Not taken:

- **The statistics.** The book's failure rates and average moves come from daily charts of US stocks from
  1991 to 2004. They are not copied here and give no weight to anything. Each pattern's own hit rate on
  XAUUSD has to be measured from the decisions' `chart_patterns` records before a pattern earns more
  weight (doctrine: learned knowledge is never canon).
- **Sizes in percent.** A stock's "10 % decline" has no meaning on a 15-minute gold chart. Every size is a
  multiple of the chart's own average true range.

## The event patterns and gold

The book's events are company news. Gold has none of them; its events are the released high-impact USD
figures the calendar already stores, with their direction for gold.

| Chapter | Book pattern | For gold |
|---|---|---|
| 54, 55 | Dead-cat bounce and its inverse | Used: the event is a bar that moved price by 4 average ranges |
| 56, 57 | Bad and good earnings surprise | Used as the bearish and bullish release surprise: the release bar's low and high are the breakout lines |
| 59 | Earnings flag | Used as the release flag: a flag after the release bar's move |
| 58 | FDA drug approval | Not applicable |
| 60, 61 | Bad and good same-store sales | Not applicable |
| 62, 63 | Stock downgrade and upgrade | Not applicable |

## What the agent gives

For each chart (15m, 1H, 4H, daily), at most five patterns, the broken-out ones first. Each gives levels to
the Key Level Agent, in the projection family:

| Level | Weight |
|---|---|
| A breakout line of a forming pattern | 0.6 |
| The broken line after a breakout (throwback or pullback level) | 0.8 |
| The measured target | 0.7 (0.6 for a busted pattern) |
| The other line after a breakout | 0.5 |

A zone counts the projection family once per chart, so many patterns at one price do not add up.
Switch: `CHART_PATTERNS_MODE` = `on` (default) or `off`.

## Limits known today

- The bars given to the agent are the last 60 of each chart, so long patterns (rounding turns, cups, bump
  and run) are seen at that scale only.
- Gold trades almost around the clock: gaps and islands appear mostly at the weekly open.
- Horns and pipes are weekly-chart patterns in the book; here they are read on each chart's own bars.
- The curved patterns (rounding turns, scallops) and the measured moves fire most often and are ranked last.
