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

## 2. The first four agents

| Agent | Made for | Entry | Stop | Targets |
| --- | --- | --- | --- | --- |
| `zone_pullback` | any market; the plan of before | the nearest key zone behind price, or price when it holds there | behind the next zone plus 0.2 ATR | the next key levels |
| `sweep_reversal` | a stop hunt: a new 3-hour extreme through a key zone within three 15m bars, closed back inside | the close | 0.1 ATR beyond the sweep's extreme | the next key levels |
| `breakout_retest` | a trend continuing: a 15m close beyond a zone that had held price for three bars, not closed back through | the broken edge (price when it retests now) | behind the zone or the breakout bar, the tighter | the next key levels |
| `range_fade` | a ranging 1H regime, price in the outer 35 % of its 8-hour range | the range's edge | 0.25 ATR beyond the edge | the middle, then the far side of the range |

A stop is never closer than 0.25 ATR; a plan with more than 2.5 ATR of risk is no plan.

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
5. More agents (each a registry entry): a momentum continuation on the 5m structure, a session-open
   range break, a news-release fade.
