// The council's knob registry (owner 2026-11-17, confirmed in the session: "Nexus dulu, Cerebrum nanti";
// "Live otomatis + rollback otomatis"; changes that need new code are built by Cryptophys itself, not externally).
//
// A council option may change trading only through a knob listed here: a number the system already uses, with hard
// bounds and a step. The moderator sees this list and writes a "policy_parameter" option only for one of these ids,
// with a value inside the bounds; anything else (a new filter, a new rule) is a "repository_task" for the platform's
// evolution loop. Phase 1 (this file) only validates. Phase 2 tests an accepted value in shadow against the control
// and applies it live with an automatic rollback (docs/RFC_COUNCIL_PROPOSALS.md).
//
// Every "current" value is read from the code that uses it, so the registry never drifts from the engine.
import { MODE_THRESHOLDS, MIN_CONFIDENCE } from "./decision-engine.mjs";
import { STRATEGY_PARAMS } from "./strategy-engine.mjs";
import { AGENT_RULES } from "./strategy-agents.mjs";

const knob = (id, label, current, min, max, step, unit, applies) => Object.freeze({ id, label, current, min, max, step, unit, applies });

export const KNOB_REGISTRY = Object.freeze([
  knob("decision.min_confidence", "Minimum council and strategy confidence to act", MIN_CONFIDENCE, 0.3, 0.6, 0.05, "share", "Decision Engine: the council's confidence floor and pickStrategy's per-agent floor"),
  knob("decision.min_rrr.intraday", "Minimum reward to risk, intraday mode", MODE_THRESHOLDS.intraday.min_rrr, 1, 2.5, 0.1, "R", "Decision Engine reward guardrail in intraday mode"),
  knob("decision.min_rrr.swing", "Minimum reward to risk, swing mode", MODE_THRESHOLDS.swing.min_rrr, 1.5, 3, 0.1, "R", "Decision Engine reward guardrail in swing mode"),
  knob("decision.quorum_min.scalp", "Witness quorum needed, scalp mode", MODE_THRESHOLDS.scalp.quorum_min, 0.4, 0.65, 0.05, "share", "Decision Engine quorum guardrail in scalp mode"),
  knob("decision.quorum_min.intraday", "Witness quorum needed, intraday mode", MODE_THRESHOLDS.intraday.quorum_min, 0.4, 0.7, 0.05, "share", "Decision Engine quorum guardrail in intraday mode"),
  knob("decision.quorum_min.swing", "Witness quorum needed, swing mode", MODE_THRESHOLDS.swing.quorum_min, 0.45, 0.75, 0.05, "share", "Decision Engine quorum guardrail in swing mode"),
  knob("strategy.near_atr", "How close to a key zone counts as at the zone", STRATEGY_PARAMS.near_atr, 0.2, 0.6, 0.05, "ATR", "Strategy engine at-zone band (zone_pullback entries)"),
  knob("agents.max_risk_atr", "Largest stop a strategy agent may plan", AGENT_RULES.max_risk_atr, 1.5, 3.5, 0.25, "ATR", "Strategy agents: no plan when the stop is wider than this")
]);

const BY_ID = new Map(KNOB_REGISTRY.map((k) => [k.id, k]));
export const knobById = (id) => BY_ID.get(String(id ?? "")) ?? null;
const roundTo = (x, step) => Math.round(Math.round(x / step) * step * 1e6) / 1e6;

/** Pure: a proposed value for a knob, rounded to its step; refused outside the bounds or equal to the current value. */
export function checkKnobValue(id, value) {
  const k = knobById(id);
  if (!k) return { ok: false, error: `unknown knob ${String(id ?? "").slice(0, 60)}` };
  const v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, error: `${k.id} needs a number` };
  const r = roundTo(v, k.step);
  if (r < k.min - 1e-9 || r > k.max + 1e-9) return { ok: false, error: `${k.id} must stay within ${k.min} to ${k.max} ${k.unit}` };
  if (Math.abs(r - k.current) < 1e-9) return { ok: false, error: `${k.id} is already ${k.current}` };
  return { ok: true, knob: k, value: r, from: k.current };
}

/** The registry as the moderator sees it. */
export const knobMenu = () => KNOB_REGISTRY.map((k) => ({ id: k.id, what: k.label, current: k.current, min: k.min, max: k.max, step: k.step, unit: k.unit }));
