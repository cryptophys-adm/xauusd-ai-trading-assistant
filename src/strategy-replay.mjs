// Aether phase A8, part 4 (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.1, §9.4, K7): the strategy-threshold replay.
//
// Every hour stored in D1 strategy_inputs (src/strategy-inputs.mjs) is recomputed by the pure
// buildStrategy once per arm: the control is the live thresholds (STRATEGY_PARAMS) and each candidate
// changes one threshold. The decision of each arm (BUY, SELL or WAIT) is computed once, in the sweep,
// and stored in D1 strategy_replays (migration 0015), so a read is a cheap query. Each decision is
// scored with that stance's stored 4-hour outcome of the hour, the same yardstick for every arm.
// Statistics as for the other arms (§9.3): paired one-sided sign test, Holm across this family's
// candidates of the month, discovery minimum and the newest hours as a holdout.
// The control is also compared with the live decision stored at capture time: a mismatch means the
// stored inputs no longer reproduce the engine (code drift) and is reported.
// Nothing here reaches a room, a prompt or a decision. A better threshold is a proposal for an owner
// PR to src/strategy-engine.mjs.

import { buildStrategy, STRATEGY_PARAMS } from "./strategy-engine.mjs";
import { gunzipJson, ensureStrategyInputsSchema } from "./strategy-inputs.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";

export const STRATEGY_REPLAY_VERSION = "cryptophys.strategy-replay.v1";

/** The control: the live thresholds. An arm id names its parameters, so a changed grid is a new id. */
export const STRATEGY_CONTROL = Object.freeze({ id: "strategy@active", params: STRATEGY_PARAMS, change: "none: the live strategy-engine thresholds" });
/** The reviewed grid of the strategy family (at most 3 at once, RFC O6). Changing it is a reviewed PR. */
export const STRATEGY_CANDIDATES = Object.freeze([
  Object.freeze({ id: "strategy@rrr1.2", params: Object.freeze({ ...STRATEGY_PARAMS, min_rrr: 1.2 }), change: "a trade needs 1.2R to the final target instead of 1.5R" }),
  Object.freeze({ id: "strategy@conf0.3", params: Object.freeze({ ...STRATEGY_PARAMS, min_confidence: 0.3 }), change: "a minimum confidence of 0.3 instead of 0.4" }),
  Object.freeze({ id: "strategy@near0.5", params: Object.freeze({ ...STRATEGY_PARAMS, near_atr: 0.5 }), change: "price counts as at a key zone within 0.5 ATR instead of 0.35" })
]);
export const STRATEGY_ARMS = Object.freeze([STRATEGY_CONTROL, ...STRATEGY_CANDIDATES]);

export const STRATEGY_REPLAY_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS strategy_replays (
    candle_key TEXT NOT NULL,
    arm_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    state TEXT,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (candle_key, arm_id)
  )`
];
let schemaReady = false;
export function resetStrategyReplaySchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  await ensureStrategyInputsSchema(db);
  for (const sql of STRATEGY_REPLAY_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/** Pure: each arm's decision and state on one stored hour. */
export function replayHour(inputs, arms = STRATEGY_ARMS) {
  const out = {};
  for (const arm of arms) {
    const s = buildStrategy(inputs, arm.params);
    out[arm.id] = { decision: s.decision, state: s.state };
  }
  return out;
}

/**
 * Sweep step: computes the missing arm decisions of the stored hours, a few hours per run (each hour
 * decodes one record and runs buildStrategy once per missing arm). Hours marked no_data are skipped.
 */
export async function replayStrategyCaptures(env, { now = Date.now(), limit = 12, arms = STRATEGY_ARMS } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  const ids = arms.map((a) => a.id);
  const rows = (await env.DB.prepare(
    `SELECT si.candle_key, si.inputs_gz FROM strategy_inputs si WHERE (si.outcomes_json IS NULL OR si.outcomes_json NOT LIKE '%no_data%')
       AND (SELECT COUNT(*) FROM strategy_replays sr WHERE sr.candle_key = si.candle_key AND sr.arm_id IN (${ids.map(() => "?").join(", ")})) < ?
     ORDER BY si.captured_at LIMIT ?`
  ).bind(...ids, ids.length, limit).all()).results || [];
  const at = new Date(now).toISOString();
  let computed = 0, failed = 0;
  for (const r of rows) {
    let inputs;
    try { inputs = await gunzipJson(r.inputs_gz); } catch { failed += 1; continue; }
    const have = new Set(((await env.DB.prepare("SELECT arm_id FROM strategy_replays WHERE candle_key = ?").bind(r.candle_key).all()).results || []).map((x) => x.arm_id));
    const missing = arms.filter((a) => !have.has(a.id));
    let decisions;
    try { decisions = replayHour(inputs, missing); } catch { failed += 1; continue; }
    for (const a of missing) {
      await env.DB.prepare("INSERT INTO strategy_replays (candle_key, arm_id, decision, state, computed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(candle_key, arm_id) DO NOTHING")
        .bind(r.candle_key, a.id, decisions[a.id].decision, decisions[a.id].state, at).run();
    }
    computed += 1;
  }
  // Hours pruned from strategy_inputs (60 days) take their replays with them.
  await env.DB.prepare("DELETE FROM strategy_replays WHERE candle_key NOT IN (SELECT candle_key FROM strategy_inputs)").run();
  return { status: "ok", hours: computed, failed };
}

const VALID = new Set(["hit", "miss", "neutral", "missed_opportunity"]);

/** Pure: the comparison from scored hours ({ candle_key, outcomes, live_decision, decisions: { arm_id: decision } }), oldest first. */
export function compareStrategy(hours, { candidates = STRATEGY_CANDIDATES, control = STRATEGY_CONTROL, now = Date.now() } = {}) {
  const scored = (h, armId) => {
    const d = h.decisions?.[armId];
    const r = d ? h.outcomes?.[d] : null;
    return d && VALID.has(r) ? { stance: d, result: r } : null;
  };
  const ctrlHours = hours.filter((h) => scored(h, control.id));
  const drift = ctrlHours.filter((h) => h.live_decision && h.live_decision !== h.decisions[control.id]).map((h) => h.candle_key);
  const entries = candidates.map((arm) => {
    const pairs = ctrlHours.map((h) => [scored(h, arm.id), scored(h, control.id)]).filter(([a]) => a);
    const cut = Math.max(0, pairs.length - HOLDOUT_BARS);
    const all = pairedTally(pairs), discovery = pairedTally(pairs.slice(0, cut)), holdout = pairedTally(pairs.slice(cut));
    return {
      id: arm.id, change: arm.change, params: arm.params,
      same_hours: pairs.length, differing_decisions: pairs.filter(([a, b]) => a.stance !== b.stance).length,
      trades: pairs.filter(([a]) => a.stance !== "WAIT").length,
      paired: { candidate_better: all.candidate_better, control_better: all.control_better, p_value: all.p_value, significance: SHADOW_SIGNIFICANCE },
      accuracy: all.accuracy, control_accuracy: all.control_accuracy,
      discovery: { ...discovery, p_holm: null }, holdout: { ...holdout, required_bars: HOLDOUT_BARS, complete: holdout.bars >= HOLDOUT_BARS },
      criteria: { minimum_sample: discovery.bars >= SHADOW_MIN_SAMPLE, higher_outcome_score: null, holdout_no_worse: null },
      verdict: "collecting"
    };
  });
  const live = entries.filter((k) => k.criteria.minimum_sample);
  const adjusted = holmAdjust(live.map((k) => k.discovery.p_value));
  live.forEach((k, i) => { k.discovery.p_holm = adjusted[i]; });
  for (const k of live) {
    const d = k.discovery, h = k.holdout;
    k.criteria.higher_outcome_score = d.accuracy !== null && d.control_accuracy !== null ? d.accuracy > d.control_accuracy && d.p_holm !== null && d.p_holm < SHADOW_SIGNIFICANCE : null;
    k.criteria.holdout_no_worse = h.complete && (h.accuracy !== null && h.control_accuracy !== null ? h.accuracy >= h.control_accuracy : h.candidate_better >= h.control_better);
    k.verdict = k.criteria.higher_outcome_score !== true ? "not_better" : k.criteria.holdout_no_worse ? "better_than_active: ready for owner review" : "holdout_failed";
  }
  return {
    version: STRATEGY_REPLAY_VERSION, family: "strategy", name: "Strategy-engine thresholds",
    hours: hours.length,
    control: { id: control.id, change: control.change, params: control.params, scored_hours: ctrlHours.length, trades: ctrlHours.filter((h) => h.decisions[control.id] !== "WAIT").length, matches_live: ctrlHours.length - drift.length, drift: drift.slice(-5) },
    holm: { month: holmMonth(now), alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.id) },
    candidates: entries
  };
}

const READ_CACHE_MS = 5 * 60_000;
let cache = null;
export function resetStrategyReplayCacheForTests() { cache = null; }

/** Read model for /api/tuning (replays.strategy), cached 5 minutes. */
export async function readStrategyReplay(env, { now = Date.now(), useCache = true } = {}) {
  if (useCache && cache && now - cache.at < READ_CACHE_MS) return cache.value;
  await ensureSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT candle_key, captured_at, live_decision, outcomes_json FROM strategy_inputs WHERE outcomes_json IS NOT NULL AND outcomes_json NOT LIKE '%no_data%' ORDER BY captured_at").all()).results || [];
  const decisions = new Map();
  for (const r of (await env.DB.prepare("SELECT candle_key, arm_id, decision FROM strategy_replays").all()).results || []) {
    (decisions.get(r.candle_key) || decisions.set(r.candle_key, {}).get(r.candle_key))[r.arm_id] = r.decision;
  }
  const hours = rows.map((r) => {
    let outcomes = null;
    try { outcomes = JSON.parse(r.outcomes_json); } catch { outcomes = null; }
    return { candle_key: r.candle_key, live_decision: r.live_decision, outcomes, decisions: decisions.get(r.candle_key) || {} };
  });
  const value = compareStrategy(hours, { now });
  if (useCache) cache = { at: now, value };
  return value;
}
