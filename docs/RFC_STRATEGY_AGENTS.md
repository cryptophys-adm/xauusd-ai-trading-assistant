# RFC: strategy agents (pluggable strategies, chosen by the council)

Status: steps 1 to 4 built on 2026-11-13; every agent is live in production since the owner's decision of that day. Canonical state: `docs/SSOT.md` ("Strategy agents"); open steps:
`docs/BACKLOG.md` item 24.

## 0. Goal

Owner 2026-11-13: "bukan hanya logicnya, itu static, kita perlu agent yang bisa dibongkar pasang
menyesuaikan strategy yang tepat yang dipilih oleh council." Until now one fixed logic placed every plan
(`tradeLevels`: a pullback to the nearest key zone, the stop behind the next zone). The council chose
the side and never the way of trading it, so a stop hunt, a breakout and a range all got the same
plan. The plan learner (`docs/RFC_PLAN_LEARNING.md`) tunes that one logic's numbers; it cannot make it
a different strategy.

## 1. A strategy agent

One way of trading price action behind one interface (`src/strategy-agents.mjs`):

```
{ id, version, label, fits, plan(dir, ctx) }
```

- `fits`: one sentence for the council, the price action the strategy is made for and what it is not for.
- `plan(dir, ctx)`: pure and deterministic. From the price, the 1H ATR, the Key Level Agent's zones,
  the closed 15m bars and the 1H regime it returns its own entry, stop and targets, in the shape of the
  engine's plan, or null when its setup is not on the chart.
- An agent never reads a room, a witness or the quorum, and never decides the side. The council decides
  the side inside the guardrails; an agent only says where its strategy would enter, stop and target.
- A language model never writes a price: every level still comes from deterministic code.

Adding or removing a strategy is one entry in the registry (`STRATEGY_AGENTS`).

## 2. The agents

| Agent | Made for | Entry | Stop | Targets |
| --- | --- | --- | --- | --- |
| `zone_pullback` | any market; the plan of before | the nearest key zone behind price, or price when it holds there | behind the next zone plus 0.2 ATR | the next key levels |
| `sweep_reversal` | a stop hunt: a new 3-hour extreme through a key zone within three 15m bars, closed back inside | the close | 0.1 ATR beyond the sweep's extreme | the next key levels |
| `breakout_retest` | a trend continuing: a 15m close beyond a zone that had held price for three bars, not closed back through | the broken edge (price when it retests now) | behind the zone or the breakout bar, the tighter | the next key levels |
| `range_fade` | a ranging 1H regime, price in the outer 35 % of its 8-hour range | the range's edge | 0.25 ATR beyond the edge | the middle, then the far side of the range |

A stop is never closer than 0.25 ATR; a plan with more than 2.5 ATR of risk is no plan.

**The pattern families** (owner 2026-11-13: "libatkan Projection Agent karena dia yang punya knowledge
terkait price action"; asked how many patterns that means: 53 chart patterns and 10 event patterns, "benar").
The Projection Agent holds the platform's price-action knowledge: the catalogue of chart and event
patterns and each pattern's measured record on gold. Of the 63, 58 apply to gold (the five event patterns
tied to company events have no gold event). They are traded by eight agents, one per family, each by
that family's own way of being confirmed and of failing:

| Family | Patterns | Entry | Stop behind the broken line |
| --- | --- | --- | --- |
| `pattern_peaks` | 16: double and triple tops and bottoms, head-and-shoulders, three falling peaks, three rising valleys | the return to the confirmation line | half the pattern's height (at most 1.25 ATR) |
| `pattern_lines` | 15: triangles, wedges, rectangles, broadening formations, diamonds | the return to the broken line | the pattern's other line, where it is busted (at most 1 ATR) |
| `pattern_curve` | 10: cup with handle, rounding turns, scallops, bump-and-run | the return to the rim | a third of the height (at most 1.25 ATR); first target half the measured move |
| `pattern_bars` | 4: horns, pipes | the return to the level they broke | the spikes' own extreme (at most 1.25 ATR) |
| `pattern_pole` | 3: flags, pennants, the high and tight flag | at price near the breakout: these seldom return | the flag's other side (at most 1 ATR) |
| `pattern_gaps` | 3: gaps, island reversals, long islands | the gap's edge | the gap's other edge (at most 1 ATR) |
| `pattern_legs` | 2: measured moves | as the pause between the legs breaks | the pause (at most 1.25 ATR) |
| `pattern_event` | 5: the dead-cat bounce and its inverse, the release surprises, the release flag | near the break after the release | the pattern's other side (at most 1.25 ATR) |

The first target is the pattern's measured target. These rules are a first reading of each family's
method, written from scratch and unproven on gold: each pattern's own trades are recorded, and a pattern
whose record is negative over 15 resolved setups is held back while the rest of its family trades on. The
Projection Agent's own record still decides which pattern is traded: one measured below the rate of all
patterns is left out, the best measured comes first.

A break is upward or downward alike: every agent plans both sides. A pattern that has not broken yet is
traded by `pattern_inside` when it has two boundary lines at least 0.8 ATR apart (a rectangle, a broadening
formation, a wide triangle, wedge or diamond): from one line toward the other, a long from the lower line
or a short from the upper one, the stop 0.25 ATR beyond the line, the targets the middle and the far line.
Its record is kept apart from the same pattern's breaks.

When the council has strategies to choose from, the evidence also carries the Projection Agent's reading
(`price_action`: each pattern on the 15m, 1H and 4H charts, whether it broke upward or downward, its record on
gold; no price), so the choice of strategy leans on the price action it sees.

## 3. Status: plug in, test, trade

- `off`: not computed.
- `shadow`: its plan is recorded with every decision (`strategy_plans`) and measured by the plan learner
  on the bars that follow. Never traded, never shown to the council.
- `live`: when it sees its setup on a side and its plan passes that side's reward guardrail, the council
  finds it in the evidence beside the default plan and may name it (`strategy` in its answer). The trade
  then takes that agent's entry, stop and targets. Naming none, or one that is not live, keeps the
  default agent's plan.

`zone_pullback` is always live. The others are shadow by default in code and live in production since
2026-11-13 (owner: "live sekarang langsung implementasi karena strategi lebih related dengan key level
bukan decision"). A breaker suspends a live agent whose measured record is negative over at least 30
resolved setups (back to shadow, still measured) and lets it back when the record is no longer negative;
the owner hears of each change on Telegram. Switches: `STRATEGY_AGENTS_LIVE` and
`STRATEGY_AGENTS_OFF` (comma-separated ids), `STRATEGY_AGENTS_MODE` (`on`, or `off` for the default agent
only). With every other agent in shadow the council's evidence, its prompt and every trade are exactly
as before.

## 4. Measured like everything else

The plan learner follows each agent's own setups (one per agent and side while the plan is repeated) on
the Signal Ledger's bars: setups, mean R per setup, fill rate, target and stop rates, per context
(trading mode and 1H regime). `GET /api/strategy-agents` shows the registry with each agent's record.

## 5. Steps

1. Built: the registry, four agents, the record in shadow, the measurement, the council's choice among
   live agents (inactive while only the default is live).
2. Built: every agent live (owner 2026-11-13), with the breaker.
3. Built: each agent's record in the council's evidence, overall and in the present market condition.
4. Built: Nexus Strategy agents page (the registry, the records, the agent each decision took).
5. Built: the Projection Agent in the layer (eight pattern families over its 58 patterns, a record and a breaker per pattern, `price_action`).
   Built: `pattern_inside` for line patterns before they break.
   Open: a rule per pattern where a pattern's record shows the family's rule does not fit it; entering before a
   break on a partial rise or decline; the 4H chart.
6. More agents (each a registry entry): a momentum continuation on the 5m structure, a session-open
   range break, a news-release fade.
