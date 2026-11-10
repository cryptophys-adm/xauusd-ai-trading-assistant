# Proposal: Progressive Stop Loss (SL+) for Strategy / Omega / EA

Status: DRAFT (owner approval required)
Date: 2026-11-10

## 1. Goal
Lock profit by moving the stop loss progressively (to breakeven, then trailing) once a trade reaches
predefined profit thresholds. Applies to:
- Strategy engine plans (tradeLevels)
- Omega broker engine (intents: modify_sl)
- MT5 EA (CryptophysXAUUSD.mq5)

## 2. Design
- Add `progressive_stop` levels to the plan (already in trade_plan for H1).
- Omega: new intent kind `modify_sl` with new SL price; bridge executes OrderModify.
- EA: trailing stop logic based on ATR or fixed R.

## 3. Safety
- Never move SL against the trade.
- Only tighten (move toward profit).
- Configurable thresholds.

## 4. Implementation Steps
1. Strategy: compute progressive_stop in tradeLevels.
2. Omega engine: emit modify_sl intents when profit threshold reached.
3. Bridge/EA: execute modify.
4. UI: show progressive stop.
5. Tests.

## 5. Decision Needed
Owner approval.EOF
gh issue create --title "Proposal: Progressive Stop Loss (SL+) for strategy/Omega/EA" --body "Proposal: docs/PROPOSAL_PROGRESSIVE_STOP.md

Adds progressive/trailing stop to lock profit across strategy engine, Omega broker engine, and MT5 EA. Needs owner approval." 2>&1 | tail -1
