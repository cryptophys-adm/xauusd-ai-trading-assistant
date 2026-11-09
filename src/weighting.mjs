// The weighting equation of the H1 quorum and its tuning by Aether (owner decision 2026-11-09: "nanti
// aether yang akan membuat tuning persamaan pembobotan berdasarkan hasil learning, masing-masing agent
// akan diberi score pembobotan sendiri"; activation by approval in the Console; the equation's
// parameters AND components are tunable).
//
// Each agent of the 1H War Room has its own weight, from its scored statements (outcome_scores,
// "agent:<id>", timeframe 60) within `days`:
//   decay    d   = 0.5 ^ (age_days / half_life_days)   (1 without a half-life)
//   accuracy acc = (Σd·hit + prior/2) / (Σd·decisive + prior)          shrunk toward 50 %
//   calib.   cal = Σd·(0.25 − brier) / (0.25 · (Σd + prior))           shrunk toward 0; 1 is perfect,
//                                                                       0 a coin flip, < 0 overconfident
//   weight   w   = clamp(2 · acc · (1 + calibration_beta · cal), weight_range)
// The quorum: BUY or SELL needs more than `quorum_share` of the weight on the matching bias.
// With the default parameters (no half-life, calibration_beta 0) the weight is exactly the P7
// reputation weight (src/reputation.mjs reputationOf), so nothing changed until a person approves.
//
// Tuning (src/weighting-replay.mjs): every grid point next to the active parameters is replayed over
// the stored 1H rooms; Aether's calibrator proposes a point that is better on discovery AND holdout;
// a person approves it in the Console; the pack pull (applyWeightingPack) activates it here. An active
// point that turns out worse than the one before it in reverse shadow is rolled back automatically.
// WEIGHTING_MODE = "default" ignores every activation (the owner's kill switch).

import { SCORING, SCORING_VERSION, ensureOutcomeSchema } from "./outcome-scoring.mjs";

export const WEIGHTING_VERSION = "cryptophys.weighting.v2";
export const WEIGHTING_FAMILY = "weighting";

/** The active equation until a person approves another point: the P7 reputation weight, quorum 0.5. */
export const WEIGHTING_DEFAULT = Object.freeze({
  prior: 10, weight_range: Object.freeze([0.25, 2]), days: 30, half_life_days: null, calibration_beta: 0, quorum_share: 0.5
});
export const WEIGHTING_KEYS = Object.freeze(Object.keys(WEIGHTING_DEFAULT));

/** The reviewed grid (a change is a reviewed PR here and in cryptophys-aether src/weighting.mjs). */
export const WEIGHTING_GRID = Object.freeze({
  prior: Object.freeze([5, 10, 20]),
  weight_range: Object.freeze([Object.freeze([0.25, 2]), Object.freeze([0.5, 1.5]), Object.freeze([0.1, 3])]),
  days: Object.freeze([14, 30, 60]),
  half_life_days: Object.freeze([null, 7, 14]),
  calibration_beta: Object.freeze([0, 0.5, 1]),
  quorum_share: Object.freeze([0.5, 0.55, 0.6])
});
const PARAM_TEXT = Object.freeze({
  prior: (v) => `a reputation needs ${v} decisive calls of sample before it moves (prior ${v})`,
  weight_range: (v) => `weights kept within ${v[0]} to ${v[1]}`,
  days: (v) => `the track record covers ${v} days`,
  half_life_days: (v) => (v == null ? "every call in the window counts the same" : `a call counts half after ${v} days (half-life)`),
  calibration_beta: (v) => (v ? `confidence calibration (Brier) moves the weight with strength ${v}` : "confidence calibration does not move the weight"),
  quorum_share: (v) => `BUY or SELL needs more than ${Math.round(v * 100)}% of the weight`
});

const DAY_MS = 86_400_000;
const H1_MS = 3_600_000;
const DECISIVE = new Set(["hit", "miss", "missed_opportunity"]);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Pure: the parameters as a stable id, e.g. "weighting@p10-r0.25_2-d30-h0-b0-q0.5". */
export function weightingId(params) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  return `${WEIGHTING_FAMILY}@p${p.prior}-r${p.weight_range[0]}_${p.weight_range[1]}-d${p.days}-h${p.half_life_days ?? 0}-b${p.calibration_beta}-q${p.quorum_share}`;
}

/** Pure: why `params` may not be used (empty when every key is present and on the reviewed grid). */
export function weightingProblems(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return ["not_an_object"];
  const out = [];
  for (const k of Object.keys(params)) if (!WEIGHTING_KEYS.includes(k)) out.push(`unknown_key:${k}`);
  for (const k of WEIGHTING_KEYS) {
    if (!(k in params)) { out.push(`missing:${k}`); continue; }
    if (!WEIGHTING_GRID[k].some((v) => same(v, params[k]))) out.push(`off_grid:${k}`);
  }
  return out;
}

/** Pure: the plain-language difference of `params` from `base`. */
export function weightingChange(params, base = WEIGHTING_DEFAULT) {
  const parts = WEIGHTING_KEYS.filter((k) => !same(params[k], base[k])).map((k) => PARAM_TEXT[k](params[k]));
  return parts.length ? parts.join("; ") : "none: the active weighting";
}

/** Pure: every grid point that differs from `active` in exactly one parameter (the replay's candidates). */
export function neighbourPoints(active = WEIGHTING_DEFAULT) {
  const out = [];
  for (const k of WEIGHTING_KEYS) {
    for (const v of WEIGHTING_GRID[k]) {
      if (same(v, active[k])) continue;
      const params = { ...active, [k]: v };
      out.push({ id: weightingId(params), params, changed: k, change: weightingChange(params, active) });
    }
  }
  return out;
}

/**
 * Pure: one agent's weight from its scored statements at time `at` (ms). `rows` are
 * { close_ms, result, brier }; only those whose outcome was known at `at` (close + horizon) and within
 * `days` count. Returns { weight, accuracy, calibration, decisive, n }.
 */
export function agentWeight(rows, params, at, { horizonMs = SCORING.horizon * H1_MS } = {}) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  let H = 0, D = 0, B = 0, NB = 0, n = 0;
  for (const r of rows || []) {
    if (!(r.close_ms + horizonMs <= at) || r.close_ms < at - p.days * DAY_MS) continue;
    const d = p.half_life_days ? 0.5 ** ((at - r.close_ms) / (p.half_life_days * DAY_MS)) : 1;
    n += 1;
    if (DECISIVE.has(r.result)) { D += d; if (r.result === "hit") H += d; }
    if (Number.isFinite(r.brier)) { B += d * (0.25 - r.brier); NB += d; }
  }
  return weightFromSums({ H, D, B, NB, n }, p);
}

/** Pure: the weight from decay-weighted sums (shared by the live path and the replay). */
export function weightFromSums({ H = 0, D = 0, B = 0, NB = 0, n = 0 }, params) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  const acc = (H + p.prior / 2) / (D + p.prior);
  const cal = NB ? B / (0.25 * (NB + p.prior)) : 0;
  const weight = clamp(2 * acc * (1 + p.calibration_beta * cal), p.weight_range[0], p.weight_range[1]);
  return { weight: r3(weight), accuracy: r3(acc), calibration: r3(cal), decisive: r3(D), n };
}

/** Pure: the weight of every agent from rows grouped by agent (Map or object agent -> rows). */
export function agentWeights(byAgent, params, at) {
  const out = {};
  for (const [agent, rows] of byAgent instanceof Map ? byAgent : Object.entries(byAgent || {})) out[agent] = agentWeight(rows, params, at);
  return out;
}

// ---------------------------------------------------------------- live state (D1 weighting_state)

export const WEIGHTING_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS weighting_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_json TEXT NOT NULL,
    previous_json TEXT,
    source_json TEXT,
    activated_at TEXT NOT NULL,
    history_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
];
let schemaReady = false;
let stateCache = null;
export function resetWeightingCacheForTests() { schemaReady = false; stateCache = null; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of WEIGHTING_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
const STATE_CACHE_MS = 60_000;
const HISTORY_MAX = 40;

/** The stored state, or the default one (nothing activated yet). Never throws. */
export async function weightingState(env, { now = Date.now(), useCache = true } = {}) {
  const fallback = { params: WEIGHTING_DEFAULT, id: weightingId(WEIGHTING_DEFAULT), previous: null, source: null, activated_at: null, history: [], stored: false };
  if (!env?.DB) return fallback;
  if (useCache && stateCache && now - stateCache.at < STATE_CACHE_MS) return stateCache.value;
  let value = fallback;
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT active_json, previous_json, source_json, activated_at, history_json FROM weighting_state WHERE id = 1").first();
    if (row) {
      const params = JSON.parse(row.active_json);
      if (!weightingProblems(params).length) {
        const previous = row.previous_json ? JSON.parse(row.previous_json) : null;
        value = { params, id: weightingId(params), previous, source: row.source_json ? JSON.parse(row.source_json) : null, activated_at: row.activated_at, history: JSON.parse(row.history_json || "[]"), stored: true };
      }
    }
  } catch { value = fallback; }
  if (useCache) stateCache = { at: now, value };
  return value;
}

/** The parameters the H1 room uses now: the activated point, or the default (WEIGHTING_MODE "default"). */
export async function activeWeighting(env, opts = {}) {
  if (String(env?.WEIGHTING_MODE ?? "").trim().toLowerCase() === "default") return { params: WEIGHTING_DEFAULT, id: weightingId(WEIGHTING_DEFAULT), mode: "default" };
  const s = await weightingState(env, opts);
  return { params: s.params, id: s.id, mode: s.stored && s.id !== weightingId(WEIGHTING_DEFAULT) ? "activated" : "default", activated_at: s.activated_at, source: s.source };
}

async function writeState(env, { params, previous, source, event, now }) {
  await ensureSchema(env.DB);
  const at = new Date(now).toISOString();
  const prev = await weightingState(env, { now, useCache: false });
  const history = [...(prev.history || []), { ...event, at, id: weightingId(params) }].slice(-HISTORY_MAX);
  await env.DB.prepare(
    "INSERT INTO weighting_state (id, active_json, previous_json, source_json, activated_at, history_json, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET active_json = excluded.active_json, previous_json = excluded.previous_json, source_json = excluded.source_json, activated_at = excluded.activated_at, history_json = excluded.history_json, updated_at = excluded.updated_at"
  ).bind(JSON.stringify(params), previous ? JSON.stringify(previous) : null, source ? JSON.stringify(source) : null, at, JSON.stringify(history), at).run();
  stateCache = null;
}

async function noteEvent(env, event, now) {
  const s = await weightingState(env, { now, useCache: false });
  if (!s.stored) {
    await writeState(env, { params: WEIGHTING_DEFAULT, previous: null, source: null, event: { kind: "initialised" }, now });
  }
  const cur = await weightingState(env, { now, useCache: false });
  const at = new Date(now).toISOString();
  const history = [...cur.history, { ...event, at }].slice(-HISTORY_MAX);
  await env.DB.prepare("UPDATE weighting_state SET history_json = ?, updated_at = ? WHERE id = 1").bind(JSON.stringify(history), at).run();
  stateCache = null;
}

/** A point activated at most once a week (the reverse shadow needs rooms to judge it). */
export const ACTIVATION_COOLDOWN_DAYS = 7;
/** Reverse shadow: once this many rooms ran on the active point, a significantly better previous point wins it back. */
export const ROLLBACK_MIN_ROOMS = 100;
export const ROLLBACK_SIGNIFICANCE = 0.05;

/**
 * Pure: what to do with the approved weighting items of the pack, given the state and the replay.
 * Returns { action: "none" | "activate" | "hold", item?, params?, reason }.
 *   - only param_candidate items of family "weighting" whose values are a full grid point;
 *   - never an item already activated, refused or rolled back (history), never the active point;
 *   - a week since the last activation;
 *   - the replay must still rate that point better_than_active (discovery and holdout): approval
 *     says a person agrees, the replay says the data still does.
 */
export function weightingDecision(pack, state, replay, { now = Date.now() } = {}) {
  const items = (Array.isArray(pack?.items) ? pack.items : []).filter((it) => it?.kind === "param_candidate" && it?.params?.family === WEIGHTING_FAMILY);
  if (!items.length) return { action: "none", reason: "no approved weighting item" };
  const handled = new Set((state?.history || []).filter((h) => h.item && ["activated", "refused", "rolled_back"].includes(h.kind)).map((h) => h.item));
  const open = items.map((it) => ({ it, key: `${it.item_id}@${it.version}` })).filter(({ key }) => !handled.has(key));
  if (!open.length) return { action: "none", reason: "every approved weighting item was handled" };
  const { it, key } = open[open.length - 1];
  const params = it.params.values;
  const problems = weightingProblems(params);
  if (problems.length) return { action: "refuse", item: key, reason: `not a reviewed grid point (${problems.join(", ")})` };
  if (weightingId(params) === state?.id) return { action: "refuse", item: key, reason: "already the active weighting" };
  const last = (state?.history || []).filter((h) => h.kind === "activated" || h.kind === "rolled_back").at(-1);
  if (last && now - Date.parse(last.at) < ACTIVATION_COOLDOWN_DAYS * DAY_MS) return { action: "hold", item: key, reason: `the last change was less than ${ACTIVATION_COOLDOWN_DAYS} days ago` };
  const cand = (replay?.candidates || []).find((c) => c.id === weightingId(params));
  if (!cand) return { action: "hold", item: key, reason: "the replay does not test this point against the active weighting" };
  if (!String(cand.verdict).startsWith("better_than_active")) return { action: "hold", item: key, reason: `the replay rates it ${cand.verdict}` };
  return { action: "activate", item: key, params, source: { item_id: it.item_id, version: it.version, proposal_id: it.proposal_id ?? null, content_sha256: it.content_sha256 ?? null }, reason: cand.change };
}

/** Pure: whether the reverse shadow says to roll back (the previous point significantly better). */
export function rollbackDecision(state, replay) {
  const r = replay?.reverse;
  if (!state?.previous || !r) return { rollback: false, reason: "nothing to compare with" };
  if (r.rooms < ROLLBACK_MIN_ROOMS) return { rollback: false, reason: `${r.rooms} of ${ROLLBACK_MIN_ROOMS} rooms on the active weighting` };
  if (r.previous_better > r.active_better && r.p_value !== null && r.p_value < ROLLBACK_SIGNIFICANCE) return { rollback: true, reason: `the previous weighting was right ${r.previous_better} times where the active one was wrong, against ${r.active_better} (p ${r.p_value})` };
  return { rollback: false, reason: "the active weighting holds" };
}

/**
 * Sweep step, hourly, after the pack pull: activates an approved weighting point or rolls back.
 * `pack` is the stored learned pack; `replay` readWeightingReplay. Never throws.
 */
export async function applyWeighting(env, { pack, replay, now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  if (String(env?.WEIGHTING_MODE ?? "").trim().toLowerCase() === "default") return { status: "frozen", reason: "WEIGHTING_MODE default" };
  try {
    const state = await weightingState(env, { now, useCache: false });
    const back = rollbackDecision(state, replay);
    if (back.rollback) {
      await writeState(env, { params: state.previous, previous: null, source: { rolled_back_from: state.id }, event: { kind: "rolled_back", item: state.source?.item_id ? `${state.source.item_id}@${state.source.version}` : null, from: state.id, reason: back.reason }, now });
      return { status: "rolled_back", from: state.id, to: weightingId(state.previous), reason: back.reason };
    }
    const d = weightingDecision(pack, state, replay, { now });
    if (d.action === "activate") {
      await writeState(env, { params: d.params, previous: state.params, source: d.source, event: { kind: "activated", item: d.item, from: state.id, reason: d.reason }, now });
      return { status: "activated", id: weightingId(d.params), from: state.id, item: d.item };
    }
    if (d.action === "refuse") {
      await noteEvent(env, { kind: "refused", item: d.item, reason: d.reason }, now);
      return { status: "refused", item: d.item, reason: d.reason };
    }
    return { status: d.action === "hold" ? "held" : "unchanged", item: d.item ?? null, reason: d.reason };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- live weights of the 1H room

/** Every scored H1 agent statement of the last `days` (+ horizon), grouped by agent. */
export async function loadAgentRows(db, { days, now = Date.now(), timeframe = "60" } = {}) {
  await ensureOutcomeSchema(db);
  const since = new Date(now - days * DAY_MS).toISOString();
  const raw = (await db.prepare("SELECT subject, statement_close, result, brier FROM outcome_scores WHERE timeframe = ? AND subject LIKE 'agent:%' AND scoring_version = ? AND statement_close >= ? ORDER BY statement_close").bind(timeframe, SCORING_VERSION, since).all()).results || [];
  const byAgent = new Map();
  for (const r of raw) {
    const agent = String(r.subject).slice("agent:".length);
    if (agent === "moderator") continue;
    const close_ms = Date.parse(r.statement_close);
    if (!Number.isFinite(close_ms)) continue;
    (byAgent.get(agent) || byAgent.set(agent, []).get(agent)).push({ close_ms, result: r.result, brier: Number.isFinite(r.brier) ? r.brier : null });
  }
  return byAgent;
}

/**
 * The reputation map of the 1H room under the active weighting (the shape of reputationFromScorecards,
 * the weight replaced). `base` is the P7 reputation (n, accuracy, hit rate, Brier for display).
 * Every scored statement already has its outcome, so the horizon gate is not applied live.
 */
export async function weightedReputation(db, params, { now = Date.now(), base = {} } = {}) {
  const byAgent = await loadAgentRows(db, { days: params.days, now });
  const out = { ...base };
  for (const [agent, rows] of byAgent) {
    const w = agentWeight(rows, params, now, { horizonMs: 0 });
    out[agent] = { ...(base[agent] ?? { n: w.n, decisive: w.decisive, accuracy: null, hit_rate: null, wait_accuracy: null, brier: null }), weight: w.weight, shrunk: w.accuracy, calibration: w.calibration, weighting: weightingId(params) };
  }
  return out;
}
