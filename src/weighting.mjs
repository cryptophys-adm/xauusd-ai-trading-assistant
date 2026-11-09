// The weighting equation of every room's quorum and its automatic tuning (owner decisions 2026-11-09:
// "nanti aether yang akan membuat tuning persamaan pembobotan berdasarkan hasil learning, masing-masing
// agent akan diberi score pembobotan sendiri"; then: auto-tuning without an operator, adapting to
// volatility and market dynamics, each timeframe independent).
//
// Each agent of a room has its own weight on that room's timeframe, from its own scored statements
// (outcome_scores, "agent:<id>", that timeframe) within `days`:
//   decay    d     = 0.5 ^ (age_days / half_life_days)            (1 without a half-life)
//   accuracy acc_g = (Σd·hit + prior/2) / (Σd·decisive + prior)  shrunk toward 50 %
//   regime   acc   = (Σd·hit_r + k·acc_g) / (Σd·decisive_r + k)   with k = regime_prior, over the calls
//                    made in the bar's regime (src/market-regime.mjs), shrunk toward acc_g; acc = acc_g
//                    without a regime_prior or a regime
//   calib.   cal   = Σd·(0.25 − brier) / (0.25 · (Σd + prior))    shrunk toward 0
//   weight   w     = clamp(2 · acc · (1 + calibration_beta · cal), weight_range)
// The quorum: BUY or SELL needs more than quorum_share (+ high_vol_quorum_bonus in a high-volatility
// regime) of the weight on the matching bias. With the default point the weight is exactly the P7
// reputation weight and the quorum 0.5.
//
// Tuning (src/weighting-replay.mjs): per timeframe, every grid point one parameter away from the active
// point is replayed over that timeframe's stored rooms. The best point the replay rates better on
// discovery AND holdout is activated automatically (no operator), at most once a week per timeframe, and
// a point that turns out worse than the one before it in reverse shadow is rolled back automatically.
// Each change is sent to the owner's Telegram. WEIGHTING_MODE = "default" is the kill switch.

import { SCORING, SCORING_VERSION, ensureOutcomeSchema } from "./outcome-scoring.mjs";
import { loadRegimeMap, regimeAtClose } from "./market-regime.mjs";

export const WEIGHTING_VERSION = "cryptophys.weighting.v3";
export const WEIGHTING_FAMILY = "weighting";
export const WEIGHTING_TIMEFRAMES = Object.freeze(["15", "60", "240", "1D"]);
const TF_MS = Object.freeze({ "15": 900_000, "60": 3_600_000, "240": 4 * 3_600_000, "1D": 86_400_000 });
export const TF_LABEL = Object.freeze({ "15": "15-minute", "60": "1-hour", "240": "4-hour", "1D": "daily" });

/** The active equation until the tuning activates another point: the P7 reputation weight, quorum 0.5. */
export const WEIGHTING_DEFAULT = Object.freeze({
  prior: 10, weight_range: Object.freeze([0.25, 2]), days: 30, half_life_days: null, calibration_beta: 0, quorum_share: 0.5,
  regime_prior: null, high_vol_quorum_bonus: 0
});
export const WEIGHTING_KEYS = Object.freeze(Object.keys(WEIGHTING_DEFAULT));

/** The reviewed grid (a change is a reviewed PR). */
export const WEIGHTING_GRID = Object.freeze({
  prior: Object.freeze([5, 10, 20]),
  weight_range: Object.freeze([Object.freeze([0.25, 2]), Object.freeze([0.5, 1.5]), Object.freeze([0.1, 3])]),
  days: Object.freeze([14, 30, 60]),
  half_life_days: Object.freeze([null, 7, 14]),
  calibration_beta: Object.freeze([0, 0.5, 1]),
  quorum_share: Object.freeze([0.5, 0.55, 0.6]),
  regime_prior: Object.freeze([null, 10, 30]),
  high_vol_quorum_bonus: Object.freeze([0, 0.05, 0.1])
});
const PARAM_TEXT = Object.freeze({
  prior: (v) => `a reputation needs ${v} decisive calls of sample before it moves (prior ${v})`,
  weight_range: (v) => `weights kept within ${v[0]} to ${v[1]}`,
  days: (v) => `the track record covers ${v} days`,
  half_life_days: (v) => (v == null ? "every call in the window counts the same" : `a call counts half after ${v} days (half-life)`),
  calibration_beta: (v) => (v ? `confidence calibration (Brier) moves the weight with strength ${v}` : "confidence calibration does not move the weight"),
  quorum_share: (v) => `BUY or SELL needs more than ${Math.round(v * 100)}% of the weight`,
  regime_prior: (v) => (v == null ? "the weight ignores the market regime" : `the weight follows the agent's record in the current volatility and trend regime (shrinkage ${v})`),
  high_vol_quorum_bonus: (v) => (v ? `in high volatility the quorum needs ${Math.round(v * 100)} points more` : "the quorum is the same in every volatility")
});

const DAY_MS = 86_400_000;
const DECISIVE = new Set(["hit", "miss", "missed_opportunity"]);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Pure: the parameters as a stable id. */
export function weightingId(params) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  return `${WEIGHTING_FAMILY}@p${p.prior}-r${p.weight_range[0]}_${p.weight_range[1]}-d${p.days}-h${p.half_life_days ?? 0}-b${p.calibration_beta}-q${p.quorum_share}-g${p.regime_prior ?? 0}-v${p.high_vol_quorum_bonus}`;
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

/** A point stored before a key existed is completed with its default (v2 points had no regime keys). */
export function completePoint(params) {
  return params && typeof params === "object" ? { ...WEIGHTING_DEFAULT, ...params } : params;
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

/** Pure: the quorum share of a point in a regime. */
export function quorumFor(params, regime = null) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  return r3(p.quorum_share + (String(regime ?? "").startsWith("high") ? p.high_vol_quorum_bonus : 0));
}

/**
 * Pure: one agent's weight from its scored statements at time `at` (ms) in `regime`. `rows` are
 * { close_ms, result, brier, regime }; only those whose outcome was known at `at` (close + horizon)
 * and within `days` count. Returns { weight, accuracy, calibration, decisive, n }.
 */
export function agentWeight(rows, params, at, { horizonMs = SCORING.horizon * 3_600_000, regime = null } = {}) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  const g = { H: 0, D: 0, B: 0, NB: 0, n: 0 }, r = { H: 0, D: 0 };
  for (const row of rows || []) {
    if (!(row.close_ms + horizonMs <= at) || row.close_ms < at - p.days * DAY_MS) continue;
    const d = p.half_life_days ? 0.5 ** ((at - row.close_ms) / (p.half_life_days * DAY_MS)) : 1;
    g.n += 1;
    if (DECISIVE.has(row.result)) {
      g.D += d; if (row.result === "hit") g.H += d;
      if (regime && row.regime === regime) { r.D += d; if (row.result === "hit") r.H += d; }
    }
    if (Number.isFinite(row.brier)) { g.B += d * (0.25 - row.brier); g.NB += d; }
  }
  return weightFromSums(g, p, regime ? r : null);
}

/** Pure: the weight from decay-weighted sums (shared by the live path and the replay). */
export function weightFromSums({ H = 0, D = 0, B = 0, NB = 0, n = 0 }, params, regimeSums = null) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  const accG = (H + p.prior / 2) / (D + p.prior);
  const acc = p.regime_prior != null && regimeSums ? (regimeSums.H + p.regime_prior * accG) / (regimeSums.D + p.regime_prior) : accG;
  const cal = NB ? B / (0.25 * (NB + p.prior)) : 0;
  const weight = clamp(2 * acc * (1 + p.calibration_beta * cal), p.weight_range[0], p.weight_range[1]);
  return { weight: r3(weight), accuracy: r3(acc), calibration: r3(cal), decisive: r3(D), n };
}

// ---------------------------------------------------------------- live state (D1 weighting_states)

export const WEIGHTING_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS weighting_states (
    timeframe TEXT PRIMARY KEY,
    active_json TEXT NOT NULL,
    previous_json TEXT,
    source_json TEXT,
    activated_at TEXT NOT NULL,
    history_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
];
let schemaReady = false;
let stateCache = new Map();
export function resetWeightingCacheForTests() { schemaReady = false; stateCache = new Map(); }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of WEIGHTING_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
const STATE_CACHE_MS = 60_000;
const HISTORY_MAX = 40;

/** The stored state of a timeframe, or the default one. Never throws. */
export async function weightingState(env, { timeframe = "60", now = Date.now(), useCache = true } = {}) {
  const fallback = { timeframe, params: WEIGHTING_DEFAULT, id: weightingId(WEIGHTING_DEFAULT), previous: null, source: null, activated_at: null, history: [], stored: false };
  if (!env?.DB) return fallback;
  const cached = stateCache.get(timeframe);
  if (useCache && cached && now - cached.at < STATE_CACHE_MS) return cached.value;
  let value = fallback;
  try {
    await ensureSchema(env.DB);
    let row = await env.DB.prepare("SELECT active_json, previous_json, source_json, activated_at, history_json FROM weighting_states WHERE timeframe = ?").bind(timeframe).first();
    // The 1H point of the first release (one row, table weighting_state) is read until it is rewritten.
    if (!row && timeframe === "60") {
      try { row = await env.DB.prepare("SELECT active_json, previous_json, source_json, activated_at, history_json FROM weighting_state WHERE id = 1").first(); } catch { row = null; }
    }
    if (row) {
      const params = completePoint(JSON.parse(row.active_json));
      if (!weightingProblems(params).length) {
        const previous = row.previous_json ? completePoint(JSON.parse(row.previous_json)) : null;
        value = { timeframe, params, id: weightingId(params), previous, source: row.source_json ? JSON.parse(row.source_json) : null, activated_at: row.activated_at, history: JSON.parse(row.history_json || "[]"), stored: true };
      }
    }
  } catch { value = fallback; }
  if (useCache) stateCache.set(timeframe, { at: now, value });
  return value;
}

/** The parameters a timeframe's room uses now: the activated point, or the default (WEIGHTING_MODE "default"). */
export async function activeWeighting(env, { timeframe = "60", ...opts } = {}) {
  if (String(env?.WEIGHTING_MODE ?? "").trim().toLowerCase() === "default") return { timeframe, params: WEIGHTING_DEFAULT, id: weightingId(WEIGHTING_DEFAULT), mode: "default" };
  const s = await weightingState(env, { timeframe, ...opts });
  return { timeframe, params: s.params, id: s.id, mode: s.stored && s.id !== weightingId(WEIGHTING_DEFAULT) ? "activated" : "default", activated_at: s.activated_at, source: s.source };
}

async function writeState(env, timeframe, { params, previous, source, event, now }) {
  await ensureSchema(env.DB);
  const at = new Date(now).toISOString();
  const prev = await weightingState(env, { timeframe, now, useCache: false });
  const history = [...(prev.history || []), { ...event, at, id: weightingId(params) }].slice(-HISTORY_MAX);
  await env.DB.prepare(
    "INSERT INTO weighting_states (timeframe, active_json, previous_json, source_json, activated_at, history_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(timeframe) DO UPDATE SET active_json = excluded.active_json, previous_json = excluded.previous_json, source_json = excluded.source_json, activated_at = excluded.activated_at, history_json = excluded.history_json, updated_at = excluded.updated_at"
  ).bind(timeframe, JSON.stringify(params), previous ? JSON.stringify(previous) : null, source ? JSON.stringify(source) : null, at, JSON.stringify(history), at).run();
  stateCache.delete(timeframe);
}

/** A timeframe's point changes at most once a week (the reverse shadow needs rooms to judge it). */
export const ACTIVATION_COOLDOWN_DAYS = 7;
/** Reverse shadow: once this many rooms ran on the active point, a significantly better previous point wins it back. */
export const ROLLBACK_MIN_ROOMS = 100;
export const ROLLBACK_SIGNIFICANCE = 0.05;

/** Pure: whether the reverse shadow says to roll back (the previous point significantly better). */
export function rollbackDecision(state, replay) {
  const r = replay?.reverse;
  if (!state?.previous || !r) return { rollback: false, reason: "nothing to compare with" };
  if (r.rooms < ROLLBACK_MIN_ROOMS) return { rollback: false, reason: `${r.rooms} of ${ROLLBACK_MIN_ROOMS} rooms on the active weighting` };
  if (r.previous_better > r.active_better && r.p_value !== null && r.p_value < ROLLBACK_SIGNIFICANCE) return { rollback: true, reason: `the previous weighting was right ${r.previous_better} times where the active one was wrong, against ${r.active_better} (p ${r.p_value})` };
  return { rollback: false, reason: "the active weighting holds" };
}

/**
 * Pure: the automatic choice (owner decisions 2026-11-09: no operator). The candidate the replay rates
 * better_than_active on discovery and holdout with the lowest Holm-adjusted p, then the larger gain;
 * never a point that was rolled back before; at most once per ACTIVATION_COOLDOWN_DAYS.
 */
export function autoDecision(state, replay, { now = Date.now() } = {}) {
  const last = (state?.history || []).filter((h) => h.kind === "activated" || h.kind === "rolled_back").at(-1);
  if (last && now - Date.parse(last.at) < ACTIVATION_COOLDOWN_DAYS * DAY_MS) return { action: "none", reason: `the last change was less than ${ACTIVATION_COOLDOWN_DAYS} days ago` };
  const rejected = new Set((state?.history || []).filter((h) => h.kind === "rolled_back").map((h) => h.from));
  const better = (replay?.candidates || [])
    .filter((c) => String(c.verdict).startsWith("better_than_active") && !weightingProblems(c.params).length && !rejected.has(c.id) && c.id !== state?.id)
    .sort((a, b) => (a.discovery?.p_holm ?? 1) - (b.discovery?.p_holm ?? 1) || ((b.discovery?.accuracy ?? 0) - (b.discovery?.control_accuracy ?? 0)) - ((a.discovery?.accuracy ?? 0) - (a.discovery?.control_accuracy ?? 0)));
  if (!better.length) return { action: "none", reason: "no candidate is better than the active weighting on discovery and holdout" };
  const c = better[0];
  return { action: "activate", params: c.params, id: c.id, reason: c.change, evidence: { p_holm: c.discovery?.p_holm ?? null, accuracy: c.discovery?.accuracy ?? null, control_accuracy: c.discovery?.control_accuracy ?? null, holdout_accuracy: c.holdout?.accuracy ?? null } };
}

/**
 * Sweep step: rolls back or activates a timeframe's point automatically. `replay` is
 * readWeightingReplay for that timeframe. Never throws.
 */
export async function applyWeighting(env, { timeframe = "60", replay, now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable", timeframe };
  if (String(env?.WEIGHTING_MODE ?? "").trim().toLowerCase() === "default") return { status: "frozen", timeframe, reason: "WEIGHTING_MODE default" };
  try {
    const state = await weightingState(env, { timeframe, now, useCache: false });
    const back = rollbackDecision(state, replay);
    if (back.rollback) {
      await writeState(env, timeframe, { params: state.previous, previous: null, source: { rolled_back_from: state.id }, event: { kind: "rolled_back", from: state.id, reason: back.reason }, now });
      return { status: "rolled_back", timeframe, from: state.id, to: weightingId(state.previous), reason: back.reason };
    }
    const d = autoDecision(state, replay, { now });
    if (d.action === "activate") {
      await writeState(env, timeframe, { params: d.params, previous: state.params, source: { auto: true, evidence: d.evidence }, event: { kind: "activated", from: state.id, reason: d.reason, evidence: d.evidence }, now });
      return { status: "activated", timeframe, id: d.id, from: state.id, reason: d.reason, evidence: d.evidence };
    }
    return { status: "unchanged", timeframe, reason: d.reason };
  } catch (e) {
    return { status: "failed", timeframe, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Pure: the owner's Telegram line for an automatic change, or null (plain words, no price). */
export function weightingMessage(result) {
  if (!result || !["activated", "rolled_back"].includes(result.status)) return null;
  const tf = TF_LABEL[result.timeframe] ?? result.timeframe;
  if (result.status === "activated") {
    const e = result.evidence || {};
    const pct = (x) => (Number.isFinite(x) ? Math.round(x * 100) + "%" : "?");
    return `Auto-tuning (${tf} room): new weighting active. Change: ${result.reason}. Replay: right in ${pct(e.accuracy)} of decided calls against ${pct(e.control_accuracy)} before (holdout ${pct(e.holdout_accuracy)}). It rolls back by itself if it does worse.`;
  }
  return `Auto-tuning (${tf} room): the weighting was rolled back to the previous point. Reason: ${result.reason}.`;
}

// ---------------------------------------------------------------- live weights of a room

/** Every scored agent statement of a timeframe in the last `days`, grouped by agent, each with its regime. */
export async function loadAgentRows(db, { days, now = Date.now(), timeframe = "60", regimes = null } = {}) {
  await ensureOutcomeSchema(db);
  const since = new Date(now - days * DAY_MS).toISOString();
  const raw = (await db.prepare("SELECT subject, statement_close, result, brier FROM outcome_scores WHERE timeframe = ? AND subject LIKE 'agent:%' AND scoring_version = ? AND statement_close >= ? ORDER BY statement_close").bind(timeframe, SCORING_VERSION, since).all()).results || [];
  const byAgent = new Map();
  for (const r of raw) {
    const agent = String(r.subject).slice("agent:".length);
    if (agent === "moderator") continue;
    const close_ms = Date.parse(r.statement_close);
    if (!Number.isFinite(close_ms)) continue;
    (byAgent.get(agent) || byAgent.set(agent, []).get(agent)).push({ close_ms, result: r.result, brier: Number.isFinite(r.brier) ? r.brier : null, regime: regimes ? regimes.get(close_ms) ?? null : null });
  }
  return byAgent;
}

/**
 * The reputation map of a room under its timeframe's active weighting, in the bar's regime (the shape of
 * reputationFromScorecards, the weight replaced). `base` is the P7 reputation (for display).
 * Every scored statement already has its outcome, so the horizon gate is not applied live.
 */
export async function weightedReputation(db, params, { now = Date.now(), base = {}, timeframe = "60", regimes = null, regime = null } = {}) {
  const byAgent = await loadAgentRows(db, { days: params.days, now, timeframe, regimes });
  const out = { ...base };
  for (const [agent, rows] of byAgent) {
    const w = agentWeight(rows, params, now, { horizonMs: 0, regime });
    out[agent] = { ...(base[agent] ?? { n: w.n, decisive: w.decisive, accuracy: null, hit_rate: null, wait_accuracy: null, brier: null }), weight: w.weight, shrunk: w.accuracy, calibration: w.calibration, weighting: weightingId(params), ...(regime ? { regime } : {}) };
  }
  return out;
}

/**
 * Everything a room needs for its crowd line (owner decisions 2026-11-09): the timeframe's active
 * weighting, the regime of the bar that closed at `closeMs`, the weights and the quorum share.
 */
export async function roomWeighting(env, db, timeframe, { closeMs = Date.now(), base = {} } = {}) {
  const w = await activeWeighting(env, { timeframe });
  let regimes = null, regime = null;
  if (w.params.regime_prior != null || w.params.high_vol_quorum_bonus) {
    regimes = await loadRegimeMap(env, timeframe);
    regime = regimeAtClose(regimes, closeMs);
  }
  let reputation = base;
  try { reputation = await weightedReputation(db, w.params, { now: closeMs, base, timeframe, regimes, regime }); } catch { reputation = base; }
  return { reputation, quorumShare: quorumFor(w.params, regime), weighting: w.id, regime };
}

export { TF_MS };
