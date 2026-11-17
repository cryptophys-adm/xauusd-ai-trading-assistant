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

const knob = (id, label, current, min, max, step, unit, applies) => Object.freeze({ id, label, current, min, max, step, unit, applies });

export const KNOB_REGISTRY = Object.freeze([
  knob("decision.min_confidence", "Minimum council confidence to act", MIN_CONFIDENCE, 0.3, 0.6, 0.05, "share", "Decision Engine: the council's confidence floor"),
  knob("decision.min_rrr.intraday", "Minimum reward to risk, intraday mode", MODE_THRESHOLDS.intraday.min_rrr, 1, 2.5, 0.1, "R", "Decision Engine reward guardrail in intraday mode"),
  knob("decision.min_rrr.swing", "Minimum reward to risk, swing mode", MODE_THRESHOLDS.swing.min_rrr, 1.5, 3, 0.1, "R", "Decision Engine reward guardrail in swing mode"),
  knob("decision.quorum_min.scalp", "Witness quorum needed, scalp mode", MODE_THRESHOLDS.scalp.quorum_min, 0.4, 0.65, 0.05, "share", "Decision Engine quorum guardrail in scalp mode"),
  knob("decision.quorum_min.intraday", "Witness quorum needed, intraday mode", MODE_THRESHOLDS.intraday.quorum_min, 0.4, 0.7, 0.05, "share", "Decision Engine quorum guardrail in intraday mode"),
  knob("decision.quorum_min.swing", "Witness quorum needed, swing mode", MODE_THRESHOLDS.swing.quorum_min, 0.45, 0.75, 0.05, "share", "Decision Engine quorum guardrail in swing mode")
  // Phase 2 (2026-11-17): only knobs the shadow replay can test are listed; the strategy engine's and the agents' own
  // numbers (near_atr, max_risk_atr, ...) need code to make them tunable, so a council proposes them as a task.
]);

const BY_ID = new Map(KNOB_REGISTRY.map((k) => [k.id, k]));
export const knobById = (id) => BY_ID.get(String(id ?? "")) ?? null;
const roundTo = (x, step) => Math.round(Math.round(x / step) * step * 1e6) / 1e6;

// --- the live values (written by src/council-knob-tuning.mjs; read by the Decision Engine and the moderator) ---------
export const KNOBS_KEY = "council-knobs:v1";
const parseDoc = (s) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? null); } catch { return null; } };
/** Pure: the document's live values, clamped to the registry (a knob no longer listed is ignored). */
export function knobValues(doc) {
  const out = {};
  for (const [id, x] of Object.entries(doc?.live ?? {})) {
    const k = knobById(id);
    const v = Number(x?.value);
    if (k && Number.isFinite(v)) out[id] = Math.min(k.max, Math.max(k.min, v));
  }
  return out;
}
let cache = null;
/** The live knob values ({id: value}); {} when none or unreadable. Cached 60 s per isolate. */
export async function readKnobOverrides(env, { now = Date.now() } = {}) {
  if (cache && now - cache.at < 60_000 && cache.kv === env?.SIGNAL_CACHE) return cache.value;
  let doc = null;
  try { doc = parseDoc(await env?.SIGNAL_CACHE?.get?.(KNOBS_KEY)); } catch { doc = null; }
  const value = knobValues(doc);
  cache = { at: now, kv: env?.SIGNAL_CACHE, value };
  return value;
}
export function resetKnobCache() { cache = null; }
/** A knob's value in force: the live one when set, else the code's. */
const inForce = (k, live) => (Number.isFinite(Number(live?.[k.id])) ? Number(live[k.id]) : k.current);

/** Pure: a proposed value for a knob, rounded to its step; refused outside the bounds or equal to the value in force. */
export function checkKnobValue(id, value, live = null) {
  const k = knobById(id);
  if (!k) return { ok: false, error: `unknown knob ${String(id ?? "").slice(0, 60)}` };
  const v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, error: `${k.id} needs a number` };
  const r = roundTo(v, k.step);
  if (r < k.min - 1e-9 || r > k.max + 1e-9) return { ok: false, error: `${k.id} must stay within ${k.min} to ${k.max} ${k.unit}` };
  const now = inForce(k, live);
  if (Math.abs(r - now) < 1e-9) return { ok: false, error: `${k.id} is already ${now}` };
  return { ok: true, knob: k, value: r, from: now };
}

/** The registry as the moderator sees it. */
export const knobMenu = (live = null) => KNOB_REGISTRY.map((k) => ({ id: k.id, what: k.label, current: inForce(k, live), min: k.min, max: k.max, step: k.step, unit: k.unit }));
