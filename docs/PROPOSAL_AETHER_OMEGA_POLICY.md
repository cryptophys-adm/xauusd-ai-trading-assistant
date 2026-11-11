# Proposal: Aether-Governed Omega Policy (Risk / Max Positions)

Status: IMPLEMENTED 2026-11-11 (owner: "All", the deferred plans). Off until the owner sets OMEGA_POLICY_AUTO or the page's policy_auto.
Date: 2026-11-10

## 1. Principle
All policy decisions for the Omega broker engine (risk_pct, max_positions, max_daily_loss_pct,
max_spread_points, max_signal_age_ms) are determined by Aether (cryptophys-aether), the Knowledge Guardian.
The AI Worker never invents policy; it only applies Aether-approved policy within hard safety bounds.

## 2. Flow
1. Aether publishes a "policy pack" (approved parameter set) via KnowledgeIngress.
2. The AI Worker pulls it hourly (like the learned pack in src/aether-pack.mjs).
3. On change, the AI Worker validates bounds and writes settings via OmegaGateway.writeSettings with actor "aether".
4. Every change is audited in omega_events and Telegram-notified.

## 3. Safety Bounds (hard-coded, never exceeded)
- risk_pct: 0.1% – 2.0%
- max_positions: 1 – 3
- max_daily_loss_pct: 1% – 5%
- max_spread_points: 30 – 120
- max_signal_age_ms: 300000 – 600000

## 4. Rollback
- Reverse shadow: if outcomes worsen (win rate / expectancy) over 50 trades, revert to previous policy.
- Kill switch: OMEGA_POLICY_AUTO = "false" disables auto-adjust; manual UI remains.

## 5. Implementation Steps
1. Define policy pack schema in Aether.
2. Add pull in src/aether-pack.mjs (or new src/aether-omega-policy.mjs).
3. Add validation + writeSettings call.
4. Add feature flag OMEGA_POLICY_AUTO (default false).
5. Tests + shadow run.

## 6. Decision Needed
Owner approval.
## 7. Implementation (2026-11-11)

- **Aether.** `KnowledgeIngress.omegaPolicy()` (cryptophys-aether #18) returns the doctrine-in-force values of
  the omega.* facts, each within its fact's bound. A value changes only through a Knowledge Council amendment
  that Cerebrum executed.
- **Pull.** `src/omega-policy.mjs` `pullOmegaPolicy` runs hourly and writes the pack to KV `omega:policy`,
  with the signal age in ms.
- **Apply.** `applyOmegaPolicy` (`src/omega-broker.mjs`) runs only behind the switch, clamps each value to
  Omega's own bounds and does nothing when unchanged. It audits the change (`omega_events` "settings",
  actor `aether`) and reports it to Telegram.
- **Rollback.** After 50 Omega trades under the policy (`ea_deals.source = 'omega'`; manual trades never
  count), the policy is reverted (actor `aether-rollback`) when its profit factor is below 1 and below the
  50 trades before it. Its doctrine sha is then refused.
