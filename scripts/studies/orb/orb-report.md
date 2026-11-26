# Track A PR 7: the orb_breakout replay (read-only, aggregates only)

`node scripts/studies/orb/orb-replay.mjs --data <dir>`, run 2026-11-26 on read-only data:

- D1 `engine_decisions`: 944 recorded 15m closes, 2026-11-12 10:45Z to 2026-11-26 08:30Z.
- KV `market-data:v2:series:OANDA:XAUUSD|15m`: 2000 bars.
- D1 `mt5_calendar`: 29 high-impact USD releases.

The owner put the agent live whatever this says (2026-11-26, relayed by the orchestrator: "nyalakan saja langsung aktif
dan kontribusi"). This is a report, not a gate.

## Method

- **Per close.** The agent gets:
  - the 15m bars up to that close;
  - the decision's own price, 1H ATR and recorded key levels;
  - the live TP1 and entry-zone switches;
  - the calendar's high-impact releases.
- **Both sides are planned at every close.** Production records a plan only on the side the engine decided, so this
  replay counts more setups than production would.
- **Setups and scoring.** Plans become setups as plan learning builds them (`setupsFrom`). Each is scored on the control
  arm (`setupOutcome`) on 15m bars, with the lapse at the window's end. A limit that never fills scores 0R.
- **Limits:**
  - The recorded key levels are the kept set. On 775 of the 944 closes (recorded before the zones were ranked), every
    kept level counts as a major zone.
  - 15m bars are coarser than the 1m bars plan learning uses in production. Which of the entry, the stop and the
    target came first inside a bar is not known.
  - Two weeks is a short sample. Both weeks were on standard time on both sides of the Atlantic, so no clock-mismatch
    day was seen.

## Results (control arm, all resolved)

| | Setups | Fill rate | Mean R (all) | Mean R (filled) | Exits |
|---|---:|---:|---:|---:|---|
| All | 59 | 0.39 | **−0.119** | −0.304 | 23 stopped (16 at 0R after the progressive stop, 7 at −1R), 34 target before entry, 2 unfilled |
| London | 41 | 0.49 | −0.146 | −0.300 | 20 stopped, 20 target before entry, 1 unfilled |
| New York | 18 | 0.17 | −0.056 | −0.333 | 3 stopped, 14 target before entry, 1 unfilled |
| London long | 23 | 0.57 | −0.130 | −0.231 | 13 stopped, 10 target before entry |
| London short | 18 | 0.39 | −0.167 | −0.429 | 7 stopped, 10 target before entry, 1 unfilled |
| New York short | 18 | 0.17 | −0.056 | −0.333 | 3 stopped, 14 target before entry, 1 unfilled |

- **No filled setup reached its target.** The median first-target reward is 1.34R. 14 of the 59 setups were at the
  level when planned.
- **Session-days.**
  - London: 13 days, 10 with a valid range.
  - New York: 13 days, 5 with a valid range. The other 5 had a release inside the range (`range_event`).
  - No range was too narrow or too wide, and no clock mismatch came up.
- **Overlap.** 55 of the 59 setups had another agent's plan on the same side at the same close, and 55 had one on the
  other side.

## Against the orchestrator's harm line

The line: a mean below 0R over 30 or more setups, or a session below −0.2R.

- **Crossed.** The mean is −0.119R over 59 setups.
- **Not crossed for either session.** London is −0.146R (41 setups) and New York is −0.056R (18).

The per-session breaker (15 resolved setups with a negative mean) would hold London back soon after it starts
recording, if production repeats this.

## Arm state at the time of the replay (read-only)

- `strategy_arm_state`: no agent armed (`armed_count` 0).
- `strategy_arms`: every row disarmed by the owner.
- Nothing is picked, so orb_breakout reaches a trade only through the council's choice among the live agents.
