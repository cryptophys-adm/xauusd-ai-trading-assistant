// Auto-tuning of the Decision Engine's witness weights (owner 2026-11-11: "harusnya bobot itu dinamis
// sesuai dengan auto tune yang ada di aether"). The same protocol as the rooms' quorum weighting
// (src/weighting.mjs, src/weighting-replay.mjs; owner decisions 2026-11-09: no operator, Aether audits):
//
//   - Replay. Every stored decision (D1 engine_decisions) holds each witness's lean, whether it counted
//     and every guardrail check of both sides. Under a set of weights W the replay recomputes the quorum
//     of those witnesses (quorumOf, as the live engine does) and the quorum check of each side with the
//     decision's own trading mode; every other check keeps its recorded result (no other check reads a
//     weight). The replayed stance is the side the guardrails allow (the larger share when both do),
//     else WAIT. The council's own choice and confidence cannot be replayed: the replay measures what
//     the weights let through, the same for every arm. Each stance is scored like every stance
//     (src/outcome-scoring.mjs, the closed 15m bars).
//   - Arms. The active weights (control) and, for each witness except SESSION (context only, it never
//     counts), that weight times 1.5 and divided by 1.5, the other counting witnesses rescaled so the
//     sum stays 1. A set with any weight outside 0.02 to 0.28 is not an arm (doctrine: at most 0.3 each).
//   - Statistics. As every shadow arm: paired one-sided sign test, Holm across the arms, the discovery
//     minimum (200 paired decisions) and the newest 100 as a holdout.
//   - Activation. Automatic, at most once per ACTIVATION_COOLDOWN_DAYS; never a set rolled back before.
//     Reverse shadow: once ROLLBACK_MIN_ROOMS decisions ran on the active set, a significantly better
//     previous set wins it back. Each change goes to the owner's Telegram, every report to Aether, and
//     the doctrine facts carry the weights in force (src/doctrine-facts.mjs), so the Knowledge Council
//     amends the doctrine through Cerebrum.
// WITNESS_TUNING_MODE "default" freezes the B-11 weights and stops every change. Read-only for prices:
// the report holds weights, counts, accuracies and p-values only.

import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";
import { ACTIVATION_COOLDOWN_DAYS, ROLLBACK_MIN_ROOMS, ROLLBACK_SIGNIFICANCE } from "./weighting.mjs";
// decision-engine.mjs imports this module too: its bindings are read only inside functions here.
import { EXTENDED_WITNESS_WEIGHTS, WITNESS_WEIGHTS, decisionWeightedEnabled, ensureDecisionSchema, keyCloseMs, modeThresholds, quorumOf } from "./decision-engine.mjs";
import { WITNESS_PRIORS } from "./witness-weighting.mjs";

export const WITNESS_TUNING_VERSION = "cryptophys.witness-tuning.v1";
export const WITNESS_REPORT_VERSION = "cryptophys.witness-weighting-report.v1";
/** The report's timeframe for Aether (one row beside the rooms' 15, 60, 240, 1D). */
export const WITNESS_TIMEFRAME = "engine";
/** The B-11 witnesses (WITNESS_PRIORS equals EXTENDED_WITNESS_WEIGHTS; a test pins it). */
export const WITNESS_KEYS = Object.freeze(Object.keys(WITNESS_PRIORS));
/** SESSION is context only (it never counts in the quorum), so its weight is not tuned. */
export const TUNED_WITNESSES = Object.freeze(WITNESS_KEYS.filter((k) => k !== "SESSION"));
export const WITNESS_STEP = 1.5;
export const WITNESS_MIN = 0.02;
export const WITNESS_MAX = 0.28;
/** The 15m series keeps 2000 bars (about four weeks of trading): the replay reaches as far. */
export const WITNESS_REPLAY_DAYS = 21;
const DAY_MS = 86_400_000;
const SERIES_KEY = "market-data:v2:series:OANDA:XAUUSD|15m";
const LABEL = Object.freeze({ D1: "daily room", H4: "4-hour room", H1: "1-hour room", M15: "15-minute room", NEWS: "News Daily", MACRO: "Macro room", STRATEGY: "strategy engine", KEY_LEVELS: "key levels", REGIME: "regime", TREND_TF: "trend timeframes", MACRO_DRIVERS: "macro drivers", SESSION: "session", CALENDAR: "economic calendar" });
const SCORED = new Set(["hit", "miss", "neutral", "missed_opportunity"]);
/** Recorded checks that no longer gate a decision. */
export const NON_GATING = Object.freeze(new Set(["confirmation"]));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r4 = (x) => Math.round(x * 10_000) / 10_000;
const r3 = (x) => (isNum(x) ? Math.round(x * 1000) / 1000 : null);
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

// ---------------------------------------------------------------- weight sets

/** Pure: why a weight set may not be used (empty when every witness is present, inside its bounds, and the sum is 1). */
export function witnessWeightsProblems(w) {
  if (!w || typeof w !== "object" || Array.isArray(w)) return ["not_an_object"];
  const out = [];
  for (const k of Object.keys(w)) if (!WITNESS_KEYS.includes(k)) out.push(`unknown_witness:${k}`);
  for (const k of WITNESS_KEYS) {
    if (!isNum(w[k])) out.push(`missing:${k}`);
    else if (w[k] < WITNESS_MIN - 1e-9 || w[k] > WITNESS_MAX + 1e-9) out.push(`out_of_bounds:${k}`);
  }
  if (!out.length) {
    const sum = WITNESS_KEYS.reduce((s, k) => s + w[k], 0);
    if (Math.abs(sum - 1) > 0.001) out.push("sum_not_1");
  }
  return out;
}

/** Pure: a short stable id of a weight set ("ww:" and 8 hex of its per-mille values). */
export function witnessWeightsId(w) {
  const text = WITNESS_KEYS.map((k) => Math.round((Number(w?.[k]) || 0) * 10_000)).join(",");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `ww:${h.toString(16).padStart(8, "0")}`;
}

/** Pure: `active` with witness `key` times `factor`, the other tuned witnesses rescaled (SESSION fixed); null when out of bounds. */
export function shiftWeights(active, key, factor) {
  if (!TUNED_WITNESSES.includes(key) || !isNum(active?.[key])) return null;
  const fixed = WITNESS_KEYS.filter((k) => !TUNED_WITNESSES.includes(k)).reduce((s, k) => s + active[k], 0);
  const next = active[key] * factor;
  const others = TUNED_WITNESSES.filter((k) => k !== key);
  const rest = others.reduce((s, k) => s + active[k], 0);
  const room = 1 - fixed - next;
  if (!(rest > 0) || !(room > 0)) return null;
  const out = {};
  for (const k of WITNESS_KEYS) out[k] = r4(k === key ? next : others.includes(k) ? active[k] * room / rest : active[k]);
  const residual = r4(1 - WITNESS_KEYS.reduce((s, k) => s + out[k], 0));
  if (residual) { const big = others.reduce((a, b) => (out[b] > out[a] ? b : a), others[0]); out[big] = r4(out[big] + residual); }
  return witnessWeightsProblems(out).length ? null : out;
}

/** Pure: the plain words of a change from `from` to `to` (the witness whose weight was moved). */
export function weightsChange(to, from = EXTENDED_WITNESS_WEIGHTS) {
  const moved = TUNED_WITNESSES.filter((k) => Math.abs((to?.[k] ?? 0) - (from?.[k] ?? 0)) >= 0.0005)
    .sort((a, b) => Math.abs(to[b] - from[b]) - Math.abs(to[a] - from[a]));
  if (!moved.length) return "none: the B-11 weights";
  return moved.slice(0, 3).map((k) => `${LABEL[k]} ${to[k] > from[k] ? "up" : "down"} from ${pct(from[k])} to ${pct(to[k])}`).join(", ") + (moved.length > 3 ? `, and ${moved.length - 3} more rescaled` : "");
}

/** Pure: the arms next to the active set: each tuned witness times WITNESS_STEP and divided by it. */
export function neighbourWeights(active) {
  const out = [];
  for (const key of TUNED_WITNESSES) {
    for (const [direction, factor] of [["up", WITNESS_STEP], ["down", 1 / WITNESS_STEP]]) {
      const weights = shiftWeights(active, key, factor);
      if (!weights) continue;
      const id = witnessWeightsId(weights);
      if (id === witnessWeightsId(active) || out.some((c) => c.id === id)) continue;
      out.push({ id, changed: key, direction, change: `${LABEL[key]} ${direction} from ${pct(active[key])} to ${pct(weights[key])}`, weights });
    }
  }
  return out;
}

// ---------------------------------------------------------------- replay

/**
 * Pure: the replayed stance of one decision under `weights`. `d` is { witnesses: [{key, available, stale,
 * lean, at}], checks: { long: [{id, pass}], short: [...] }, mode, decided_ms }. Returns { stance,
 * long, short, quorum } or null when the record holds no guardrail checks.
 */
export function replayDecision(d, weights) {
  if (!Array.isArray(d?.checks?.long) || !Array.isArray(d?.checks?.short) || !d.checks.long.length || !d.checks.short.length) return null;
  const cards = (d.witnesses || []).map((c) => ({ ...c, weight: isNum(weights?.[c.key]) ? weights[c.key] : 0 }));
  const q = quorumOf(cards, { now: d.decided_ms });
  const t = modeThresholds(d.mode);
  const quorumPass = (dir) => {
    const share = dir > 0 ? q.long_share : q.short_share;
    const opposing = dir > 0 ? q.short_share : q.long_share;
    return share > t.quorum_min || (dir * (q.score ?? 0) >= t.lean && share > opposing);
  };
  // "confirmation" no longer gates a decision (owner 2026-11-11: the candle is the entry trigger), so an
  // older record's confirmation check is not applied: every decision is replayed under today's rule.
  const allowed = (dir) => quorumPass(dir) && d.checks[dir > 0 ? "long" : "short"].every((c) => c.id === "quorum" || NON_GATING.has(c.id) || c.pass === true);
  const long = allowed(1), short = allowed(-1);
  const stance = long && short ? (q.long_share >= q.short_share ? "BUY" : "SELL") : long ? "BUY" : short ? "SELL" : "WAIT";
  return { stance, long, short, quorum: { long: quorumPass(1), short: quorumPass(-1), long_share: q.long_share, short_share: q.short_share } };
}

/**
 * Pure: the comparison of the arms. `decisions` sorted by close_ms ({ key, close_ms, witnesses, checks,
 * mode, decided_ms, recorded_weights }); `outcome(key, closeMs, stance)` scores a stance or returns null.
 */
export function compareWitnessWeights({ decisions, outcome, active = EXTENDED_WITNESS_WEIGHTS, previous = null, activatedAt = null, now = Date.now() }) {
  const scoreArm = (weights) => {
    const scored = new Map();
    for (const d of decisions) {
      const r = replayDecision(d, weights);
      const result = r ? outcome(d.key, d.close_ms, r.stance) : null;
      if (result) scored.set(d.key, { stance: r.stance, result });
    }
    return scored;
  };
  const ctrl = scoreArm(active);
  const pairsOf = (mine, list = decisions) => list.filter((d) => mine.has(d.key) && ctrl.has(d.key)).map((d) => [mine.get(d.key), ctrl.get(d.key)]);
  const entries = neighbourWeights(active).map((arm) => {
    const mine = scoreArm(arm.weights);
    const pairs = pairsOf(mine);
    const cut = Math.max(0, pairs.length - HOLDOUT_BARS);
    const all = pairedTally(pairs), discovery = pairedTally(pairs.slice(0, cut)), holdout = pairedTally(pairs.slice(cut));
    return {
      id: arm.id, changed: arm.changed, direction: arm.direction, change: arm.change, weights: arm.weights,
      same_decisions: pairs.length, differing_decisions: pairs.filter(([a, b]) => a.stance !== b.stance).length,
      entries_taken: [...mine.values()].filter((s) => s.stance !== "WAIT").length,
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
    k.verdict = k.criteria.higher_outcome_score !== true ? "not_better" : k.criteria.holdout_no_worse ? "better_than_active: activated automatically" : "holdout_failed";
  }
  let reverse = null;
  if (previous && activatedAt) {
    const since = Date.parse(activatedAt);
    const after = decisions.filter((d) => d.close_ms >= since);
    const prev = scoreArm(previous);
    const t = pairedTally(after.filter((d) => prev.has(d.key) && ctrl.has(d.key)).map((d) => [prev.get(d.key), ctrl.get(d.key)]));
    reverse = { previous_id: witnessWeightsId(previous), since: activatedAt, rooms: t.bars, previous_better: t.candidate_better, active_better: t.control_better, p_value: t.p_value, previous_accuracy: t.accuracy, active_accuracy: t.control_accuracy };
  }
  // Fidelity: with the weights each decision was made with, how often the replayed quorum check matches the recorded one.
  let checked = 0, matched = 0;
  for (const d of decisions) {
    if (!d.recorded_weights || !d.recorded_quorum) continue;
    const r = replayDecision(d, d.recorded_weights);
    if (!r) continue;
    for (const side of ["long", "short"]) {
      if (typeof d.recorded_quorum[side] !== "boolean") continue;
      checked += 1; if (r.quorum[side] === d.recorded_quorum[side]) matched += 1;
    }
  }
  const ctrlTally = pairedTally([...ctrl.values()].map((s) => [s, s]));
  return {
    version: WITNESS_TUNING_VERSION, family: "witness_weighting", timeframe: WITNESS_TIMEFRAME, name: "Decision Engine witness weights",
    rooms: decisions.length,
    control: { id: witnessWeightsId(active), weights: active, change: "none: the active weights", scored_rooms: ctrl.size, accuracy: ctrlTally.accuracy, entries_taken: [...ctrl.values()].filter((s) => s.stance !== "WAIT").length },
    replay_fidelity: { checks: checked, matched, share: checked ? r3(matched / checked) : null },
    holm: { month: holmMonth(now), alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.id) },
    candidates: entries,
    reverse
  };
}

// ---------------------------------------------------------------- live state (D1 witness_weighting_state)

export const WITNESS_STATE_SQL = [
  `CREATE TABLE IF NOT EXISTS witness_weighting_state (
    id TEXT PRIMARY KEY CHECK (id = 'engine'),
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
const STATE_CACHE_MS = 60_000;
const HISTORY_MAX = 40;
export function resetWitnessTuningCacheForTests() { schemaReady = false; stateCache = null; replayCache = null; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of WITNESS_STATE_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
export const tuningFrozen = (env) => String(env?.WITNESS_TUNING_MODE ?? "").trim().toLowerCase() === "default";

/**
 * Pure: a set stored before the CALENDAR witness (owner 2026-11-12) with it added at its prior: the tuned
 * witnesses give it its weight in proportion, the fixed ones (the session) keep theirs. Any other set is
 * returned as it is.
 */
/** The B-11 set before the CALENDAR witness: a stored copy of it is the new B-11 set, not a rescaled one. */
const B11_BEFORE_CALENDAR = Object.freeze({ D1: 0.16, H4: 0.16, H1: 0.16, M15: 0.12, NEWS: 0.08, MACRO: 0.04, STRATEGY: 0.08, KEY_LEVELS: 0.05, REGIME: 0.05, TREND_TF: 0.05, MACRO_DRIVERS: 0.03, SESSION: 0.02 });
export function withCalendarWeight(w) {
  if (!w || typeof w !== "object" || "CALENDAR" in w) return w;
  if (Object.keys(B11_BEFORE_CALENDAR).every((k) => Math.abs((Number(w[k]) || 0) - B11_BEFORE_CALENDAR[k]) < 1e-9) && Object.keys(w).length === Object.keys(B11_BEFORE_CALENDAR).length) return { ...WITNESS_PRIORS };
  const cal = WITNESS_PRIORS.CALENDAR;
  const tuned = TUNED_WITNESSES.filter((k) => k !== "CALENDAR");
  const fixed = WITNESS_KEYS.filter((k) => !TUNED_WITNESSES.includes(k)).reduce((s, k) => s + (Number(w[k]) || 0), 0);
  const rest = tuned.reduce((s, k) => s + (Number(w[k]) || 0), 0);
  if (!(rest > 0)) return w;
  const f = (1 - fixed - cal) / rest;
  const out = { ...w, CALENDAR: cal };
  for (const k of tuned) out[k] = Math.round((Number(w[k]) || 0) * f * 10_000) / 10_000;
  const drift = Math.round((1 - WITNESS_KEYS.reduce((s, k) => s + out[k], 0)) * 10_000) / 10_000;
  if (drift) { const top = tuned.reduce((a, b) => (out[a] >= out[b] ? a : b)); out[top] = Math.round((out[top] + drift) * 10_000) / 10_000; }
  return out;
}

/** The stored state, or the B-11 default. Never throws. */
export async function witnessTuningState(env, { now = Date.now(), useCache = true } = {}) {
  const fallback = { weights: { ...EXTENDED_WITNESS_WEIGHTS }, id: witnessWeightsId(EXTENDED_WITNESS_WEIGHTS), previous: null, source: null, activated_at: null, history: [], stored: false };
  if (!env?.DB) return fallback;
  if (useCache && stateCache && now - stateCache.at < STATE_CACHE_MS) return stateCache.value;
  let value = fallback;
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT active_json, previous_json, source_json, activated_at, history_json FROM witness_weighting_state WHERE id = 'engine'").first();
    const weights = row ? withCalendarWeight(parse(row.active_json)) : null;
    if (weights && !witnessWeightsProblems(weights).length) {
      const previous = row.previous_json ? withCalendarWeight(parse(row.previous_json)) : null;
      value = { weights, id: witnessWeightsId(weights), previous: previous && !witnessWeightsProblems(previous).length ? previous : null, source: parse(row.source_json), activated_at: row.activated_at, history: parse(row.history_json) || [], stored: true };
    }
  } catch { value = fallback; }
  if (useCache) stateCache = { at: now, value };
  return value;
}

/**
 * The witness weights the engine uses now. Without GLOBAL_DECISION_WEIGHTED the base set of seven; with
 * WITNESS_TUNING_MODE "default" the B-11 set; else the activated set (source "auto_tuned") or B-11 ("default").
 */
export async function activeWitnessTuning(env, { now = Date.now() } = {}) {
  if (!decisionWeightedEnabled(env)) return { weights: { ...WITNESS_WEIGHTS }, id: witnessWeightsId(WITNESS_WEIGHTS), source: "base", activated_at: null };
  if (tuningFrozen(env)) return { weights: { ...EXTENDED_WITNESS_WEIGHTS }, id: witnessWeightsId(EXTENDED_WITNESS_WEIGHTS), source: "default", frozen: true, activated_at: null };
  const s = await witnessTuningState(env, { now });
  const tuned = s.stored && s.id !== witnessWeightsId(EXTENDED_WITNESS_WEIGHTS);
  return { weights: { ...s.weights }, id: s.id, source: tuned ? "auto_tuned" : "default", activated_at: tuned ? s.activated_at : null };
}

async function writeState(env, { weights, previous, source, event, now }) {
  await ensureSchema(env.DB);
  const at = new Date(now).toISOString();
  const prev = await witnessTuningState(env, { now, useCache: false });
  const history = [...(prev.history || []), { ...event, at, id: witnessWeightsId(weights) }].slice(-HISTORY_MAX);
  await env.DB.prepare(
    "INSERT INTO witness_weighting_state (id, active_json, previous_json, source_json, activated_at, history_json, updated_at) VALUES ('engine', ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET active_json = excluded.active_json, previous_json = excluded.previous_json, source_json = excluded.source_json, activated_at = excluded.activated_at, history_json = excluded.history_json, updated_at = excluded.updated_at"
  ).bind(JSON.stringify(weights), previous ? JSON.stringify(previous) : null, source ? JSON.stringify(source) : null, at, JSON.stringify(history), at).run();
  stateCache = null;
}

/** Pure: whether the reverse shadow says to roll back (the previous set significantly better). */
export function witnessRollbackDecision(state, replay) {
  const r = replay?.reverse;
  if (!state?.previous || !r) return { rollback: false, reason: "nothing to compare with" };
  if (r.rooms < ROLLBACK_MIN_ROOMS) return { rollback: false, reason: `${r.rooms} of ${ROLLBACK_MIN_ROOMS} decisions on the active weights` };
  if (r.previous_better > r.active_better && r.p_value !== null && r.p_value < ROLLBACK_SIGNIFICANCE) return { rollback: true, reason: `the previous weights were right ${r.previous_better} times where the active ones were wrong, against ${r.active_better} (p ${r.p_value})` };
  return { rollback: false, reason: "the active weights hold" };
}

/** Pure: the automatic choice: the arm better on discovery and holdout with the lowest Holm p, then the larger gain. */
export function witnessAutoDecision(state, replay, { now = Date.now() } = {}) {
  const last = (state?.history || []).filter((h) => h.kind === "activated" || h.kind === "rolled_back").at(-1);
  if (last && now - Date.parse(last.at) < ACTIVATION_COOLDOWN_DAYS * DAY_MS) return { action: "none", reason: `the last change was less than ${ACTIVATION_COOLDOWN_DAYS} days ago` };
  // Ids from before the CALENDAR witness (12 witnesses) never match a 13-witness candidate; production had no
  // stored state or history when it came (D1 witness_weighting_state empty, 2026-11-12).
  const rejected = new Set((state?.history || []).filter((h) => h.kind === "rolled_back").map((h) => h.from));
  const gain = (c) => (c.discovery?.accuracy ?? 0) - (c.discovery?.control_accuracy ?? 0);
  const better = (replay?.candidates || [])
    .filter((c) => String(c.verdict).startsWith("better_than_active") && !witnessWeightsProblems(c.weights).length && !rejected.has(c.id) && c.id !== state?.id)
    .sort((a, b) => (a.discovery?.p_holm ?? 1) - (b.discovery?.p_holm ?? 1) || gain(b) - gain(a));
  if (!better.length) return { action: "none", reason: "no candidate is better than the active weights on discovery and holdout" };
  const c = better[0];
  return { action: "activate", weights: c.weights, id: c.id, reason: c.change, evidence: { p_holm: c.discovery?.p_holm ?? null, accuracy: c.discovery?.accuracy ?? null, control_accuracy: c.discovery?.control_accuracy ?? null, holdout_accuracy: c.holdout?.accuracy ?? null } };
}

/** Sweep step: rolls back or activates a weight set automatically. Never throws. */
export async function applyWitnessTuning(env, { replay, now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  if (!decisionWeightedEnabled(env)) return { status: "frozen", reason: "GLOBAL_DECISION_WEIGHTED is off" };
  if (tuningFrozen(env)) return { status: "frozen", reason: "WITNESS_TUNING_MODE default" };
  try {
    const state = await witnessTuningState(env, { now, useCache: false });
    const back = witnessRollbackDecision(state, replay);
    if (back.rollback) {
      await writeState(env, { weights: state.previous, previous: null, source: { rolled_back_from: state.id }, event: { kind: "rolled_back", from: state.id, reason: back.reason }, now });
      return { status: "rolled_back", from: state.id, to: witnessWeightsId(state.previous), reason: back.reason, weights: state.previous };
    }
    const d = witnessAutoDecision(state, replay, { now });
    if (d.action === "activate") {
      await writeState(env, { weights: d.weights, previous: state.weights, source: { auto: true, evidence: d.evidence }, event: { kind: "activated", from: state.id, reason: d.reason, evidence: d.evidence }, now });
      return { status: "activated", id: d.id, from: state.id, reason: d.reason, evidence: d.evidence, weights: d.weights };
    }
    return { status: "unchanged", reason: d.reason };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Pure: the owner's Telegram line for an automatic change, or null (plain words, no price). */
export function witnessTuningMessage(result) {
  if (!result || !["activated", "rolled_back"].includes(result.status)) return null;
  if (result.status === "activated") {
    const e = result.evidence || {};
    const p = (x) => (isNum(x) ? Math.round(x * 100) + "%" : "?");
    return `Auto-tuning (Decision Engine witnesses): new weights active. Change: ${result.reason}. Replay: right in ${p(e.accuracy)} of decided calls against ${p(e.control_accuracy)} before (holdout ${p(e.holdout_accuracy)}). They roll back by themselves if they do worse.`;
  }
  return `Auto-tuning (Decision Engine witnesses): the weights were rolled back to the previous set. Reason: ${result.reason}.`;
}

// ---------------------------------------------------------------- loading and the report

const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";

/** Pure: a decision from its projected row (see loadDecisions). */
export function decisionFromRow(row) {
  const close = keyCloseMs(row.decision_key);
  if (!Number.isFinite(close)) return null;
  const witnesses = (parse(row.w) || []).map(([key, available, stale, lean, at]) => ({ key, available: truthy(available), stale: truthy(stale), lean: isNum(lean) ? lean : null, at: at ?? null }));
  const checks = (s) => (parse(s) || []).map(([id, pass]) => ({ id, pass: truthy(pass) }));
  const long = checks(row.gl), short = checks(row.gs);
  const quorumOfSide = (list) => { const q = list.find((c) => c.id === "quorum"); return q ? q.pass : null; };
  const recorded = parse(row.weights);
  return {
    key: row.decision_key, close_ms: close, mode: row.mode ?? null,
    decided_ms: Number.isFinite(Date.parse(row.decided_at)) ? Date.parse(row.decided_at) : close,
    witnesses, checks: { long, short },
    recorded_weights: recorded && typeof recorded === "object" && !Array.isArray(recorded) ? recorded : null,
    recorded_quorum: { long: quorumOfSide(long), short: quorumOfSide(short) }
  };
}

/** The stored decisions since `sinceIso`, projected in D1 to what the replay reads (no summaries). */
export async function loadDecisions(db, sinceIso) {
  await ensureDecisionSchema(db);
  const checks = (side) => `(SELECT json_group_array(json_array(json_extract(c.value, '$.id'), json_extract(c.value, '$.pass'))) FROM json_each(d.decision_json, '$.guardrails.${side}.checks') c)`;
  const sql = "SELECT d.decision_key, d.bar_close, json_extract(d.decision_json, '$.trading_mode') AS mode, json_extract(d.decision_json, '$.decided_at') AS decided_at, json_extract(d.decision_json, '$.weights') AS weights, " +
    "(SELECT json_group_array(json_array(json_extract(w.value, '$.key'), json_extract(w.value, '$.available'), json_extract(w.value, '$.stale'), json_extract(w.value, '$.lean'), json_extract(w.value, '$.at'))) FROM json_each(d.decision_json, '$.witnesses') w) AS w, " +
    `${checks("long")} AS gl, ${checks("short")} AS gs FROM engine_decisions d WHERE d.bar_close >= ? ORDER BY d.bar_close`;
  const rows = (await db.prepare(sql).bind(sinceIso).all()).results || [];
  return rows.map(decisionFromRow).filter(Boolean).sort((a, b) => a.close_ms - b.close_ms);
}

let replayCache = null;
const READ_CACHE_MS = 5 * 60_000;

/** Loads the decisions, the 15m bars and the state, and replays the arms (cached 5 minutes). */
export async function readWitnessTuning(env, { days = WITNESS_REPLAY_DAYS, now = Date.now(), useCache = true } = {}) {
  if (useCache && replayCache && now - replayCache.at < READ_CACHE_MS) return replayCache.value;
  const active = await activeWitnessTuning(env, { now });
  const state = await witnessTuningState(env, { now });
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.(SERIES_KEY)) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const windowStart = now - days * DAY_MS;
  let decisions = [];
  try { decisions = env?.DB ? await loadDecisions(env.DB, new Date(windowStart).toISOString()) : []; } catch { decisions = []; }
  const memo = new Map();
  const outcome = (key, closeMs, stance) => {
    const k = `${key}|${stance}`;
    if (memo.has(k)) return memo.get(k);
    const s = bars.length ? scoreStance({ stance, bars, closeMs }) : { result: "no_data" };
    const v = SCORED.has(s.result) ? s.result : null;
    memo.set(k, v);
    return v;
  };
  const comparison = compareWitnessWeights({ decisions, outcome, active: active.weights, previous: active.source === "auto_tuned" ? state.previous : null, activatedAt: active.source === "auto_tuned" ? state.activated_at : null, now });
  const value = {
    window_days: days, scoring: SCORING_VERSION, mode: active.frozen ? "default" : active.source === "base" ? "off" : "auto",
    active: { id: active.id, weights: active.weights, source: active.source, activated_at: active.activated_at, change: weightsChange(active.weights) },
    // The B-11 starting set every tuned set is drawn against (owner 2026-11-13: the page no longer copies it).
    default_weights: { ...EXTENDED_WITNESS_WEIGHTS },
    ...comparison,
    history: (state.history || []).slice(-10)
  };
  if (useCache) replayCache = { at: now, value };
  return value;
}

/** Pure: the report for Aether's audit (weights, counts, accuracies, p-values; no price, level or size). */
export function witnessTuningReport(replay, { now = Date.now() } = {}) {
  const stat = (t) => (t ? { bars: t.bars, candidate_better: t.candidate_better, control_better: t.control_better, p_value: t.p_value, ...(t.p_holm !== undefined ? { p_holm: t.p_holm } : {}), accuracy: t.accuracy, control_accuracy: t.control_accuracy, ...(t.complete !== undefined ? { complete: t.complete, required_bars: t.required_bars } : {}) } : null);
  return {
    version: WITNESS_REPORT_VERSION, equation: replay?.version ?? WITNESS_TUNING_VERSION, generated_at: new Date(now).toISOString(),
    mode: replay?.mode ?? "auto", timeframe: WITNESS_TIMEFRAME, window_days: replay?.window_days ?? null, rooms: replay?.rooms ?? 0,
    active: replay?.active ? { id: replay.active.id, params: replay.active.weights, source: replay.active.source, activated_at: replay.active.activated_at ?? null, change: replay.active.change } : null,
    control: replay?.control ? { scored_rooms: replay.control.scored_rooms, accuracy: replay.control.accuracy, entries_taken: replay.control.entries_taken } : null,
    replay_fidelity: replay?.replay_fidelity ?? null,
    agents: [],
    holm: replay?.holm ?? null,
    candidates: (replay?.candidates || []).map((c) => ({ id: c.id, changed: c.changed, change: c.change, params: c.weights, verdict: c.verdict, same_rooms: c.same_decisions, differing_decisions: c.differing_decisions, discovery: stat(c.discovery), holdout: stat(c.holdout) })),
    reverse: replay?.reverse ?? null,
    history: (replay?.history || []).slice(-10)
  };
}
