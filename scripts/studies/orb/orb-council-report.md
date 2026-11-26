# Track A PR 9: session_range for the council and the Technical Analyst (read-only, aggregates only)

`node scripts/studies/orb/orb-council-size.mjs --data <dir>` was run on 2026-11-26. It used the same read-only data as
the A7 replay:
- the 944 recorded 15m decisions from 2026-11-12 to 2026-11-26;
- the KV 15m series;
- the 29 high-impact USD releases in the MT5 calendar.

This is a report, not a gate.

## How often the reading is present

| | Count |
|---|---:|
| Decisions | 944 |
| With `session_range` | 532 (56.4%) |
| — London window | 192 |
| — New York window (wins in the overlap) | 340 |
| Range status `ok` (formed) | 332 |
| Range status `range_event` (a release inside the range) | 160 |
| Range status `not_formed` (the first three bars still coming) | 40 |
| With a breakout | 230 |

## Prompt size

| | Before | With the reading |
|---|---:|---:|
| Council: reference prompt (zone scenario fixture) | 12,933 chars | +650 chars on average when present (**+5.0%**); +2.8% averaged over every bar |
| Technical Analyst's opening prompt (its 4 closed 15m candles) | 2,774 chars on average | 3,062 chars on average over every bar: **+10.3%**; **+18.4% on the bars that carry the reading** |

**Plainly:** while a window is open, the Technical Analyst's average prompt grows by more than 5%, at +18.4% on those
bars.
- Its prompt is small, so even a short addition is a large share of it.
- The reading's JSON and the one rule line (shortened to fit) are what adds the length.
- The council grows by 5.0% on the bars that carry the reading.
- Model calls per bar are unchanged.

## Limits

- The council's reference size is one fixture prompt, not the live prompts' average. Live council prompts carry more
  evidence, so the relative growth there is likely lower.
- The bars are the KV 15m series, and the ATR is each decision's recorded 1H ATR. The War Room uses `h1AtrOf15` on the
  same 15m bars instead.
