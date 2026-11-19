// The "room" guardrail, tuned per trading mode by the learning protocol (owner 2026-11-19, relayed and confirmed:
// "guardrail room biarkan protocol learning dan knowledge yang melakukan adjustment secara dinamis", then "sesuai
// rekomendasimu": hard bounds 0.5 to 1.5 times the 1H average range for every mode; the value in force is an
// operational fact the doctrine protocol carries, no new promotion_by_owner entry).
//
// The guardrail (owner 2026-11-13, src/strategy-engine.mjs squeezeOf): no entry while the nearest key zones below and
// above price are less than `corridor_atr` times the 1H average range apart. It was 1 for every mode; on 19 Nov the
// scalp mode, whose target is the nearest zone, failed on it alone in 38 of 48 decisions. The value is now learned
// per mode, with the protocol of the Decision Engine's witness weights (src/witness-tuning.mjs):
//
//   - Replay. Every stored decision keeps the corridor in 1H ranges (squeeze.corridor_atr), its trading mode, each
//     witness and every guardrail check of both sides. Under a value v the room check passes when the corridor is at
//     least v ranges (or there is no zone on one side); a decision whose room could not be measured stays failed
//     (fail-closed). Every other check keeps its recorded result and the quorum is replayed with the active witness
//     weights, the same for every arm (replayDecision). Each replayed stance is scored like every stance
//     (src/outcome-scoring.mjs, the closed 15m bars).
//   - Arms. Per mode, the active value plus and minus ROOM_STEP, inside ROOM_MIN..ROOM_MAX (the owner's bounds): the
//     protocol can never switch the guard off.
//   - Statistics. Paired one-sided sign test, Holm across every arm of every mode, the discovery minimum (200 paired
//     decisions of the mode) and the newest 100 as a holdout.
//   - Activation. Automatic, per mode at most once per ACTIVATION_COOLDOWN_DAYS; never a value rolled back before.
//     Reverse shadow: once ROLLBACK_MIN_ROOMS decisions of the mode ran on the active value, a significantly better
//     previous value wins it back. Each change goes to the owner's Telegram, every report to Aether, and the doctrine
//     facts carry the value in force (src/doctrine-facts.mjs).
// ROOM_TUNING_MODE "default" holds every mode at 1 and stops every change. Read-only for prices: the report holds
// values, counts, accuracies and p-values only.

import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";
import { ACTIVATION_COOLDOWN_DAYS, ROLLBACK_MIN_ROOMS, ROLLBACK_SIGNIFICANCE } from "./weighting.mjs";
import { replayDecision, decisionFromRow, activeWitnessTuning } from "./witness-tuning.mjs";
import { ensureDecisionSchema } from "./decision-engine.mjs";
import { SQUEEZE_RULE } from "./strategy-engine.mjs";

export const ROOM_TUNING_VERSION = "cryptophys.room-tuning.v1";
export const ROOM_REPORT_VERSION = "cryptophys.room-tuning-report.v1";
export const ROOM_TIMEFRAME = "room";
/** The rule before the protocol (owner 2026-11-13): one 1H average range. */
export const ROOM_DEFAULT = SQUEEZE_RULE.corridor_atr;
/** The owner's hard bounds (2026-11-19, "sesuai rekomendasimu"), in 1H average ranges, every mode. */
export const ROOM_MIN = SQUEEZE_RULE.min_atr;
export const ROOM_MAX = SQUEEZE_RULE.max_atr;
export const ROOM_STEP = 0.25;
export const ROOM_MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);
export const ROOM_REPLAY_DAYS = 21;
const DAY_MS = 86_400_000;
const SERIES_KEY = "market-data:v2:series:OANDA:XAUUSD|15m";
const SCORED = new Set(["hit", "miss", "neutral", "missed_opportunity"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (x) => Math.round(x * 100) / 100;
const pct = (x) => (isNum(x) ? `${Math.round(x * 100)}%` : "?");
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Pure: the mode a value belongs to (range, intraday, swing, scalp; anything else is intraday, as modeThresholds). */
export function roomMode(mode) {
  const m = String(mode ?? "").trim().toLowerCase();
  return ROOM_MODES.includes(m) ? m : "intraday";
}

/** Pure: a value held inside the owner's bounds (null for anything that is not a number). */
export function clampRoom(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return r2(Math.min(ROOM_MAX, Math.max(ROOM_MIN, n)));
}

/** Pure: the arms next to `active`: plus and minus ROOM_STEP, inside the bounds. */
export function neighbourRooms(active) {
  const out = [];
  for (const [direction, v] of [["up", active + ROOM_STEP], ["down", active - ROOM_STEP]]) {
    const x = r2(v);
    if (x < ROOM_MIN - 1e-9 || x > ROOM_MAX + 1e-9 || x === r2(active)) continue;
    out.push({ value: x, direction });
  }
  return out;
}

// ---------------------------------------------------------------- replay

/**
 * Pure: whether the room check passes under `v` for a decision's stored corridor (`room`: { measured, ratio } with
 * ratio null when there is no zone on one side). Not measured: fails (the guard's fail-closed rule).
 */
export function roomPasses(room, v) {
  if (!room || room.measured !== true) return false;
  if (room.ratio === null) return true;
  return isNum(room.ratio) && room.ratio >= v - 1e-9;
}

/** Pure: the decision with its room check recomputed under `v` (null when it holds no room check to replay). */
export function withRoom(d, v) {
  const has = (list) => Array.isArray(list) && list.some((c) => c.id === "room");
  if (!has(d?.checks?.long) || !has(d?.checks?.short) || !d.room) return null;
  const pass = roomPasses(d.room, v);
  const set = (list) => list.map((c) => (c.id === "room" ? { ...c, pass } : c));
  return { ...d, checks: { long: set(d.checks.long), short: set(d.checks.short) } };
}

/**
 * Pure: the comparison of the arms of every mode. `decisions` sorted by close_ms (decisionFromRow plus `room` and
 * `room_atr`, the value it was decided with); `weights` the active witness weights; `active` { [mode]: value };
 * `previous`/`activatedAt` per mode for the reverse shadow; `outcome(key, closeMs, stance)` scores a stance or null.
 */
export function compareRooms({ decisions, outcome, weights, active = {}, previous = {}, activatedAt = {}, now = Date.now() }) {
  const scoreArm = (list, v) => {
    const scored = new Map();
    for (const d of list) {
      const dd = withRoom(d, v);
      const r = dd ? replayDecision(dd, weights) : null;
      const result = r ? outcome(d.key, d.close_ms, r.stance) : null;
      if (result) scored.set(d.key, { stance: r.stance, result });
    }
    return scored;
  };
  const modes = {};
  const candidates = [];
  for (const mode of ROOM_MODES) {
    const list = decisions.filter((d) => roomMode(d.mode) === mode && withRoom(d, ROOM_DEFAULT));
    const v = clampRoom(active[mode]) ?? ROOM_DEFAULT;
    const ctrl = scoreArm(list, v);
    // Fidelity: under the value each decision was made with, how often the replayed room check matches the recorded one.
    let checked = 0, matched = 0;
    for (const d of list) {
      if (!isNum(d.room_atr) || typeof d.recorded_room !== "boolean") continue;
      checked += 1; if (roomPasses(d.room, d.room_atr) === d.recorded_room) matched += 1;
    }
    const ctrlTally = pairedTally([...ctrl.values()].map((s) => [s, s]));
    modes[mode] = { active: v, decisions: list.length, scored: ctrl.size, accuracy: ctrlTally.accuracy, entries_taken: [...ctrl.values()].filter((s) => s.stance !== "WAIT").length,
      fidelity: { checks: checked, matched, share: checked ? r2(matched / checked) : null }, reverse: null };
    for (const arm of neighbourRooms(v)) {
      const mine = scoreArm(list, arm.value);
      const pairs = list.filter((d) => mine.has(d.key) && ctrl.has(d.key)).map((d) => [mine.get(d.key), ctrl.get(d.key)]);
      const cut = Math.max(0, pairs.length - HOLDOUT_BARS);
      const all = pairedTally(pairs), discovery = pairedTally(pairs.slice(0, cut)), holdout = pairedTally(pairs.slice(cut));
      candidates.push({
        id: `room:${mode}:${arm.value}`, mode, value: arm.value, direction: arm.direction, change: `${mode} room ${arm.direction} from ${v} to ${arm.value} times the 1H average range`,
        same_decisions: pairs.length, differing_decisions: pairs.filter(([a, b]) => a.stance !== b.stance).length,
        entries_taken: [...mine.values()].filter((s) => s.stance !== "WAIT").length,
        paired: { candidate_better: all.candidate_better, control_better: all.control_better, p_value: all.p_value, significance: SHADOW_SIGNIFICANCE },
        accuracy: all.accuracy, control_accuracy: all.control_accuracy,
        discovery: { ...discovery, p_holm: null }, holdout: { ...holdout, required_bars: HOLDOUT_BARS, complete: holdout.bars >= HOLDOUT_BARS },
        criteria: { minimum_sample: discovery.bars >= SHADOW_MIN_SAMPLE, higher_outcome_score: null, holdout_no_worse: null },
        verdict: "collecting"
      });
    }
    const prev = clampRoom(previous[mode]);
    if (prev !== null && activatedAt[mode]) {
      const since = Date.parse(activatedAt[mode]);
      const after = list.filter((d) => d.close_ms >= since);
      const p = scoreArm(after, prev);
      const t = pairedTally(after.filter((d) => p.has(d.key) && ctrl.has(d.key)).map((d) => [p.get(d.key), ctrl.get(d.key)]));
      modes[mode].reverse = { previous: prev, since: activatedAt[mode], rooms: t.bars, previous_better: t.candidate_better, active_better: t.control_better, p_value: t.p_value, previous_accuracy: t.accuracy, active_accuracy: t.control_accuracy };
    }
  }
  const live = candidates.filter((k) => k.criteria.minimum_sample);
  const adjusted = holmAdjust(live.map((k) => k.discovery.p_value));
  live.forEach((k, i) => { k.discovery.p_holm = adjusted[i]; });
  for (const k of live) {
    const d = k.discovery, h = k.holdout;
    k.criteria.higher_outcome_score = d.accuracy !== null && d.control_accuracy !== null ? d.accuracy > d.control_accuracy && d.p_holm !== null && d.p_holm < SHADOW_SIGNIFICANCE : null;
    k.criteria.holdout_no_worse = h.complete && (h.accuracy !== null && h.control_accuracy !== null ? h.accuracy >= h.control_accuracy : h.candidate_better >= h.control_better);
    k.verdict = k.criteria.higher_outcome_score !== true ? "not_better" : k.criteria.holdout_no_worse ? "better_than_active: activated automatically" : "holdout_failed";
  }
  return {
    version: ROOM_TUNING_VERSION, family: "room_guardrail", timeframe: ROOM_TIMEFRAME, name: "Decision Engine room guardrail per trading mode",
    bounds: { min: ROOM_MIN, max: ROOM_MAX, step: ROOM_STEP, default: ROOM_DEFAULT },
    rooms: decisions.length, modes,
    holm: { month: holmMonth(now), alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.id) },
    candidates
  };
}

// ---------------------------------------------------------------- live state (D1 room_tuning_state)

export const ROOM_STATE_SQL = [
  `CREATE TABLE IF NOT EXISTS room_tuning_state (
    mode TEXT PRIMARY KEY,
    active REAL NOT NULL,
    previous REAL,
    source_json TEXT,
    activated_at TEXT NOT NULL,
    history_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
];
let schemaReady = false;
let stateCache = null;
let replayCache = null;
const STATE_CACHE_MS = 60_000;
const READ_CACHE_MS = 5 * 60_000;
const HISTORY_MAX = 40;
export function resetRoomTuningCacheForTests() { schemaReady = false; stateCache = null; replayCache = null; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of ROOM_STATE_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export const roomTuningFrozen = (env) => String(env?.ROOM_TUNING_MODE ?? "").trim().toLowerCase() === "default";

const defaultState = (mode) => ({ mode, active: ROOM_DEFAULT, previous: null, source: null, activated_at: null, history: [], stored: false });

/** The stored state of every mode ({ [mode]: { active, previous, activated_at, history, stored } }), or the defaults. Never throws. */
export async function roomTuningState(env, { now = Date.now(), useCache = true } = {}) {
  const fallback = Object.fromEntries(ROOM_MODES.map((m) => [m, defaultState(m)]));
  if (!env?.DB) return fallback;
  if (useCache && stateCache && now - stateCache.at < STATE_CACHE_MS) return stateCache.value;
  let value = fallback;
  try {
    await ensureSchema(env.DB);
    const rows = (await env.DB.prepare("SELECT mode, active, previous, source_json, activated_at, history_json FROM room_tuning_state").all()).results ?? [];
    value = { ...fallback };
    for (const r of rows) {
      if (!ROOM_MODES.includes(r.mode)) continue;
      const active = clampRoom(r.active);
      if (active === null) continue;
      value[r.mode] = { mode: r.mode, active, previous: clampRoom(r.previous), source: parse(r.source_json), activated_at: r.activated_at, history: parse(r.history_json) || [], stored: true };
    }
  } catch { value = fallback; }
  if (useCache) stateCache = { at: now, value };
  return value;
}

/**
 * The room the guardrail asks for in `mode` now, in 1H average ranges, always inside the owner's bounds:
 * { value, source: "default" | "auto_tuned" | "frozen", activated_at }. Never throws (the default on any failure).
 */
export async function activeRoom(env, mode, { now = Date.now() } = {}) {
  const m = roomMode(mode);
  if (roomTuningFrozen(env)) return { mode: m, value: ROOM_DEFAULT, source: "frozen", activated_at: null };
  try {
    const s = (await roomTuningState(env, { now }))[m];
    const tuned = s.stored && s.active !== ROOM_DEFAULT;
    return { mode: m, value: s.active, source: tuned ? "auto_tuned" : "default", activated_at: tuned ? s.activated_at : null };
  } catch { return { mode: m, value: ROOM_DEFAULT, source: "default", activated_at: null }; }
}

async function writeState(env, mode, { active, previous, source, event, now }) {
  await ensureSchema(env.DB);
  const at = new Date(now).toISOString();
  const prev = (await roomTuningState(env, { now, useCache: false }))[mode];
  const history = [...(prev.history || []), { ...event, at, value: active }].slice(-HISTORY_MAX);
  await env.DB.prepare(
    "INSERT INTO room_tuning_state (mode, active, previous, source_json, activated_at, history_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(mode) DO UPDATE SET active = excluded.active, previous = excluded.previous, source_json = excluded.source_json, activated_at = excluded.activated_at, history_json = excluded.history_json, updated_at = excluded.updated_at"
  ).bind(mode, active, previous ?? null, source ? JSON.stringify(source) : null, at, JSON.stringify(history), at).run();
  stateCache = null;
}

/** Pure: per mode, whether the reverse shadow says to roll back. */
export function roomRollbackDecision(state, modeReplay) {
  const r = modeReplay?.reverse;
  if (state?.previous == null || !r) return { rollback: false, reason: "nothing to compare with" };
  if (r.rooms < ROLLBACK_MIN_ROOMS) return { rollback: false, reason: `${r.rooms} of ${ROLLBACK_MIN_ROOMS} decisions on the active value` };
  if (r.previous_better > r.active_better && r.p_value !== null && r.p_value < ROLLBACK_SIGNIFICANCE) return { rollback: true, reason: `the previous value was right ${r.previous_better} times where the active one was wrong, against ${r.active_better} (p ${r.p_value})` };
  return { rollback: false, reason: "the active value holds" };
}

/** Pure: per mode, the automatic choice: the arm better on discovery and holdout with the lowest Holm p, then the larger gain. */
export function roomAutoDecision(state, replay, mode, { now = Date.now() } = {}) {
  const last = (state?.history || []).filter((h) => h.kind === "activated" || h.kind === "rolled_back").at(-1);
  if (last && now - Date.parse(last.at) < ACTIVATION_COOLDOWN_DAYS * DAY_MS) return { action: "none", reason: `the last change was less than ${ACTIVATION_COOLDOWN_DAYS} days ago` };
  const rejected = new Set((state?.history || []).filter((h) => h.kind === "rolled_back").map((h) => h.from));
  const gain = (c) => (c.discovery?.accuracy ?? 0) - (c.discovery?.control_accuracy ?? 0);
  const better = (replay?.candidates || [])
    .filter((c) => c.mode === mode && String(c.verdict).startsWith("better_than_active") && clampRoom(c.value) === c.value && !rejected.has(c.value) && c.value !== state?.active)
    .sort((a, b) => (a.discovery?.p_holm ?? 1) - (b.discovery?.p_holm ?? 1) || gain(b) - gain(a));
  if (!better.length) return { action: "none", reason: "no value is better than the active one on discovery and holdout" };
  const c = better[0];
  return { action: "activate", value: c.value, reason: c.change, evidence: { p_holm: c.discovery?.p_holm ?? null, accuracy: c.discovery?.accuracy ?? null, control_accuracy: c.discovery?.control_accuracy ?? null, holdout_accuracy: c.holdout?.accuracy ?? null } };
}

/** Sweep step: per mode, rolls back or activates a value automatically. Never throws. Returns one result per changed mode. */
export async function applyRoomTuning(env, { replay, now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable", changes: [] };
  if (roomTuningFrozen(env)) return { status: "frozen", reason: "ROOM_TUNING_MODE default", changes: [] };
  try {
    const states = await roomTuningState(env, { now, useCache: false });
    const changes = [];
    for (const mode of ROOM_MODES) {
      const state = states[mode];
      const back = roomRollbackDecision(state, replay?.modes?.[mode]);
      if (back.rollback) {
        await writeState(env, mode, { active: state.previous, previous: null, source: { rolled_back_from: state.active }, event: { kind: "rolled_back", from: state.active, reason: back.reason }, now });
        changes.push({ status: "rolled_back", mode, from: state.active, to: state.previous, reason: back.reason });
        continue;
      }
      const d = roomAutoDecision(state, replay, mode, { now });
      if (d.action === "activate") {
        await writeState(env, mode, { active: d.value, previous: state.active, source: { auto: true, evidence: d.evidence }, event: { kind: "activated", from: state.active, reason: d.reason, evidence: d.evidence }, now });
        changes.push({ status: "activated", mode, from: state.active, to: d.value, reason: d.reason, evidence: d.evidence });
      }
    }
    return { status: changes.length ? "changed" : "unchanged", changes };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200), changes: [] };
  }
}

/** Pure: the owner's Telegram line for one automatic change, or null (plain words, no price). */
export function roomTuningMessage(change) {
  if (!change || !["activated", "rolled_back"].includes(change.status)) return null;
  if (change.status === "activated") {
    const e = change.evidence || {};
    return `Auto-tuning (room guardrail, ${change.mode}): the key zones around price must now be at least ${change.to} times the 1H average range apart (was ${change.from}; bounds ${ROOM_MIN} to ${ROOM_MAX}). Replay: right in ${pct(e.accuracy)} of decided calls against ${pct(e.control_accuracy)} before (holdout ${pct(e.holdout_accuracy)}). It rolls back by itself if it does worse.`;
  }
  return `Auto-tuning (room guardrail, ${change.mode}): rolled back from ${change.from} to ${change.to} times the 1H average range. Reason: ${change.reason}.`;
}

// ---------------------------------------------------------------- loading and the report

/** Pure: a decision from its projected row (loadRoomDecisions): decisionFromRow plus the stored corridor. */
export function roomDecisionFromRow(row) {
  const d = decisionFromRow(row);
  if (!d) return null;
  const measured = row.sq_type === "object";
  const ratio = measured ? (row.sq_corridor === null || row.sq_corridor === undefined ? null : Number(row.sq_ratio)) : null;
  const roomCheck = d.checks.long.find((c) => c.id === "room");
  return { ...d, room: { measured, ratio: ratio === null || Number.isFinite(ratio) ? ratio : null }, room_atr: isNum(Number(row.room_atr)) && row.room_atr !== null ? Number(row.room_atr) : ROOM_DEFAULT, recorded_room: roomCheck ? roomCheck.pass : null };
}

/** The stored decisions since `sinceIso` with the room check and corridor, projected in D1 (no summaries). */
export async function loadRoomDecisions(db, sinceIso) {
  await ensureDecisionSchema(db);
  const checks = (side) => `(SELECT json_group_array(json_array(json_extract(c.value, '$.id'), json_extract(c.value, '$.pass'))) FROM json_each(d.decision_json, '$.guardrails.${side}.checks') c)`;
  const sql = "SELECT d.decision_key, d.bar_close, json_extract(d.decision_json, '$.trading_mode') AS mode, json_extract(d.decision_json, '$.decided_at') AS decided_at, json_extract(d.decision_json, '$.weights') AS weights, " +
    "json_type(d.decision_json, '$.squeeze') AS sq_type, json_extract(d.decision_json, '$.squeeze.corridor') AS sq_corridor, json_extract(d.decision_json, '$.squeeze.corridor_atr') AS sq_ratio, json_extract(d.decision_json, '$.room_atr') AS room_atr, " +
    "(SELECT json_group_array(json_array(json_extract(w.value, '$.key'), json_extract(w.value, '$.available'), json_extract(w.value, '$.stale'), json_extract(w.value, '$.lean'), json_extract(w.value, '$.at'))) FROM json_each(d.decision_json, '$.witnesses') w) AS w, " +
    `${checks("long")} AS gl, ${checks("short")} AS gs FROM engine_decisions d WHERE d.bar_close >= ? AND instr(d.decision_json, '"room"') > 0 ORDER BY d.bar_close`;
  const rows = (await db.prepare(sql).bind(sinceIso).all()).results || [];
  return rows.map(roomDecisionFromRow).filter(Boolean).sort((a, b) => a.close_ms - b.close_ms);
}

/** Loads the decisions, the 15m bars and the state, and replays the arms of every mode (cached 5 minutes). */
export async function readRoomTuning(env, { days = ROOM_REPLAY_DAYS, now = Date.now(), useCache = true } = {}) {
  if (useCache && replayCache && now - replayCache.at < READ_CACHE_MS) return replayCache.value;
  const states = await roomTuningState(env, { now });
  let weights = null;
  try { weights = (await activeWitnessTuning(env, { now })).weights; } catch { weights = null; }
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.(SERIES_KEY)) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  let decisions = [];
  try { decisions = env?.DB ? await loadRoomDecisions(env.DB, new Date(now - days * DAY_MS).toISOString()) : []; } catch { decisions = []; }
  const memo = new Map();
  const outcome = (key, closeMs, stance) => {
    const k = `${key}|${stance}`;
    if (memo.has(k)) return memo.get(k);
    const s = bars.length ? scoreStance({ stance, bars, closeMs }) : { result: "no_data" };
    const v = SCORED.has(s.result) ? s.result : null;
    memo.set(k, v);
    return v;
  };
  const frozen = roomTuningFrozen(env);
  const active = Object.fromEntries(ROOM_MODES.map((m) => [m, frozen ? ROOM_DEFAULT : states[m].active]));
  const previous = Object.fromEntries(ROOM_MODES.map((m) => [m, frozen ? null : states[m].previous]));
  const activatedAt = Object.fromEntries(ROOM_MODES.map((m) => [m, frozen || !states[m].stored ? null : states[m].activated_at]));
  const comparison = compareRooms({ decisions, outcome, weights, active, previous, activatedAt, now });
  const value = {
    window_days: days, scoring: SCORING_VERSION, mode: frozen ? "default" : "auto", ...comparison,
    history: Object.fromEntries(ROOM_MODES.map((m) => [m, (states[m].history || []).slice(-10)]))
  };
  if (useCache) replayCache = { at: now, value };
  return value;
}

/** Pure: the report for Aether's audit (values, counts, accuracies, p-values; no price, level or size). */
export function roomTuningReport(replay, { now = Date.now() } = {}) {
  const stat = (t) => (t ? { bars: t.bars, candidate_better: t.candidate_better, control_better: t.control_better, p_value: t.p_value, ...(t.p_holm !== undefined ? { p_holm: t.p_holm } : {}), accuracy: t.accuracy, control_accuracy: t.control_accuracy, ...(t.complete !== undefined ? { complete: t.complete, required_bars: t.required_bars } : {}) } : null);
  return {
    version: ROOM_REPORT_VERSION, equation: replay?.version ?? ROOM_TUNING_VERSION, generated_at: new Date(now).toISOString(),
    mode: replay?.mode ?? "auto", timeframe: ROOM_TIMEFRAME, window_days: replay?.window_days ?? null, rooms: replay?.rooms ?? 0,
    bounds: replay?.bounds ?? { min: ROOM_MIN, max: ROOM_MAX, step: ROOM_STEP, default: ROOM_DEFAULT },
    active: { params: Object.fromEntries(ROOM_MODES.map((m) => [m, replay?.modes?.[m]?.active ?? ROOM_DEFAULT])) },
    modes: Object.fromEntries(ROOM_MODES.map((m) => { const x = replay?.modes?.[m]; return [m, x ? { active: x.active, decisions: x.decisions, scored: x.scored, accuracy: x.accuracy, entries_taken: x.entries_taken, fidelity: x.fidelity, reverse: x.reverse } : null]; })),
    agents: [],
    holm: replay?.holm ?? null,
    candidates: (replay?.candidates || []).map((c) => ({ id: c.id, mode: c.mode, change: c.change, params: { [c.mode]: c.value }, verdict: c.verdict, same_rooms: c.same_decisions, differing_decisions: c.differing_decisions, discovery: stat(c.discovery), holdout: stat(c.holdout) })),
    history: replay?.history ?? {}
  };
}
