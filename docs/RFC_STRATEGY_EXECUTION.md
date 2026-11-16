# RFC: execution only per the strategy agents, under the Decision Engine

Status: accepted by the owner, 2026-11-16. Implemented in one PR: the Decision Engine and the signal (part A) and Omega (part B), because Omega reads what the Decision Engine writes.

## The owner's rules (2026-11-16)

1. "EA dan Signal Engine wajib eksekusi hanya sesuai Strategy Agents untuk entry dan close positions, pastikan Strategy Agents juga comply dengan Decision Engine, termasuk protocol auto closed all apabila lean berbalik."
2. "strategy agents wajib evaluasi per 15 menit jika confidence turun untuk close profitable position."
3. "hold position atau extended hanya jika minimal confidence stabil atau bertambah."

The owner's answers to the open questions:
- **Lean flip** is the quorum lean turning: the Decision Engine's weighted lean (the quorum score, Omega's `power`) crosses to the side opposite the position beyond the ±0.15 band (`LEAN`), on a closed 15m bar. A neutral lean (inside the band) does not trigger.
- **Close-all scope:** only the system's positions (Omega-owned: magic 920200, source `omega`, or an `open:` intent). Manual and external positions are never touched.
- **Confidence:** each strategy agent's own confidence. It is made of whether the agent's setup still holds, the agent's measured quality, and the Decision Engine's direction.

## What runs today (the map, 2026-11-16)

- **Entry:**
  - The Decision Engine decides at every 15m close.
  - Its trade takes the plan of the strategy agent the council chose, if that agent is live and its plan passes the reward guardrail.
  - Otherwise it takes the default agent's plan (`zone_pullback`, the strategy engine's key-level plan), even when that agent does not see its setup. The default agent speaks in the consensus only at its level.
  - `eaSignal` turns the trade into the flat signal that Omega (and the EA) read.
- **Close (Omega, `src/omega-engine.mjs`):**
  - `close_all` on kill. This is account-wide in the OmegaExecutor.
  - `opposite`: the signal's side against a position.
  - `mean_reversal`: the signal's EXIT/REVERSAL fields, which are dormant.
  - `opposite_5m`.
  - `power_reversal`: power ≤ −0.5, fresh, and the position in profit.
  - The management that holds or extends: SL+ and trailing TP by key level and power, break-even, the 5m trail, the extended TP, the scale-out.
- **Strategy agents:** they plan only. They have no confidence and no exits, and they never read the Decision Engine (by design: they are one of its witnesses).

## Design

### 1. Entry: only a strategy agent's plan, on the Decision Engine's side (part A)

- A BUY or SELL takes a trade only from a strategy agent that **speaks** on that side. Speaking means the same thing as in the consensus:
  - the agent is live;
  - it sees its setup there (it has a plan);
  - its plan passes the reward guardrail;
  - for the default agent, price is at its level.
- If the council chose a speaking agent, that agent's plan is used. Otherwise the speaking agent with the strongest voice is used (its measured record), with the default agent first on a tie.
- If no agent speaks on the side, there is no trade. The stance is held at WAIT, overruled by `strategy_agents` ("no live strategy agent sees its setup on the <side> side").
- Compliance with the Decision Engine:
  - an agent's plan is only ever used on the Decision Engine's stance;
  - if the agents' consensus leans against that stance beyond the band (`lean` ≤ −0.15 for a BUY, ≥ +0.15 for a SELL), there is no trade, overruled by `strategy_agents` ("the strategy agents lean against the decision").
- The trade records its agent (`trade.strategy`, now always set). The signal carries it as `strategy`, and Omega stores it in the open intent, so the position knows its agent.

### 2. The agent's confidence, every 15m (part A)

At every decision, each agent that is not off gets a confidence per side, from 0 to 1, rounded to 2 places:

```
confidence = 0.40 × direction + 0.35 × setup + 0.25 × quality
direction  = (1 + side × quorum score) / 2           0 against the Decision Engine, 0.5 neutral, 1 with it
setup      = 1 when the agent speaks on the side, 0.5 when it speaks on neither, 0 when it speaks on the other
quality    = (voice − 0.5) / (1.5 − 0.5)             the agent's measured voice; 0.5 until it has 15 setups
```

- The decision stores `agent_confidence` (`{ id: { long, short } }`) and `agent_confidence_prev`. The previous one is the stored decision of the bar before, when that decision is exactly one 15m bar earlier; otherwise null.
- The signal carries both as flat strings, `agent_conf` and `agent_conf_prev` (`id:long:short` joined by `,`). The EA's flat parser ignores them.
- The 15m evaluation is the change from `agent_conf_prev` to `agent_conf`, for the position's agent and side:
  - a **drop** is more than 0.02 down;
  - **stable** is within ±0.02;
  - **rising** is more than 0.02 up.
  - The ±0.02 band (`CONFIDENCE_STABLE_BAND`) keeps rounding noise from closing a winner. With no previous value, the change is unknown, and the position is held but not extended.

### 3. Omega's exits (part B)

Omega applies these rules to the system's positions only, in this order. Each produces one close intent per ticket, because the executor's `close_all` is account-wide.

1. **Lean flip, close-all** (`lean_flip`):
   - Trigger: the power is fresh (the decision at most 35 minutes old, as for `power_reversal`) and lies beyond the band against the position (`side × power ≤ −0.15`).
   - Effect: every system position on that side is closed, in profit or not. A neutral power does not trigger.
   - The intent id carries the decision's bar, so each bar closes once.
2. **Confidence drop on a winner** (`confidence_drop`):
   - Trigger: the position is in profit and its agent's confidence on its side dropped at this 15m evaluation.
   - Effect: the position is closed.
   - The agent comes from the position's open intent. A position opened before this change, or with no agent recorded, is judged by the default agent's confidence.
3. **Hold or extend only when the confidence is stable or rising:**
   - The trailing TP (moving the target to the next key level) and the extended TP run only when the agent's confidence is stable or rising.
   - With a drop, or an unknown change, the target stays where it is and is taken.
   - The protective moves still run whatever the confidence: SL+ behind passed levels, break-even, the 5m trail, the scale-out. They only ever reduce risk.

- The existing exits stay: kill, `opposite`, `opposite_5m`, `power_reversal` (−0.5 in profit, now inside the lean flip's reach), `mean_reversal`.
- Nothing here sizes a position, arms live trading, or touches an account outside the system's own positions.

### 4. The rollback

- `STRATEGY_EXECUTION` (`"on"` / `"off"`, default on) switches all of this.
- With `off`, the Decision Engine trades the default plan as before, and Omega skips the lean flip, the confidence drop and the confidence gate on extending.
- Omega reads the switch from the signal (`strategy_execution`), so one flag on the AI Worker governs both.

## Tests

- **Part A:**
  - a BUY with no speaking agent is held at WAIT (`strategy_agents`);
  - the council's speaking agent is used, else the strongest voice;
  - a consensus against the stance holds the trade;
  - the confidence formula's corners;
  - `agent_confidence_prev` is used only from the bar exactly before;
  - the flat signal strings;
  - with the flag off, the decisions are as before.
- **Part B:**
  - the lean flip closes every system position on the flipped side, and never a manual one or one in a neutral lean, once per bar;
  - the confidence drop closes a winner and never a loser;
  - with a falling or unknown confidence the trailing and extended TP do not move, while SL+ and break-even still do;
  - with the flag off, the plans are as before.
