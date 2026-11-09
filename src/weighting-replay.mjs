// The replay of the H1 quorum under other weighting parameters (src/weighting.mjs; owner decision
// 2026-11-09). Deterministic and read-only: no model call, nothing reaches a room or a decision.
//
// For every concluded 1H War Room in the window (thread tf:H1, the latest session of each bar):
//   - each agent's final bias (its Consensus Discussion answer, else its opening);
//   - each agent's weight at the room's time, point in time: only the scored statements whose
//     horizon had closed before the room met (src/weighting.mjs agentWeight);
//   - the replayed decision: the room's direction is the moderator's bias (BULLISH BUY, BEARISH SELL;
//     its stance is itself shaped by the live quorum, so a lower share could not be replayed from it);
//     BUY or SELL when more than quorum_share of the weight holds that bias, else WAIT;
//   - the decision is scored like every stance (src/outcome-scoring.mjs): the result an agent with the
//     same stance received on that candle, else scoreStance on the cached H1 bars.
// Arms: the active weighting (control) and every grid point one parameter away from it. Statistics as
// every shadow arm (§9.3): paired one-sided sign test, Holm across the family's live tests of the month,
// the discovery minimum and the newest HOLDOUT_BARS as a holdout. After an activation, the reverse
// shadow compares the active point with the one before it on the rooms since (rollbackDecision).

import { SCORING, SCORING_VERSION, scoreStance, ensureOutcomeSchema } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";
import { WEIGHTING_DEFAULT, WEIGHTING_GRID, WEIGHTING_VERSION, weightingId, weightingChange, neighbourPoints, weightFromSums, loadAgentRows, agentWeight, weightingState } from "./weighting.mjs";
import { familyOf } from "./reputation.mjs";

export const WEIGHTING_REPLAY_VERSION = "cryptophys.weighting-replay.v1";
const H1_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SIDE = { BULLISH: "BUY", BEARISH: "SELL" };
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/**
 * Pure: the replayed decision of each room under one arm. `rows` are the scored agent statements
 * ({ agent, close_ms, result, brier }) sorted by close_ms; `rooms` ({ candle_key, close_ms, bias,
 * entries: [{ agent, bias }] }) sorted by close_ms. Returns Map candle_key -> { stance, share }.
 */
export function replayQuorum(params, rows, rooms, { horizonMs = SCORING.horizon * H1_MS } = {}) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  const hl = p.half_life_days ? p.half_life_days * DAY_MS : null;
  const origin = rows.length ? rows[0].close_ms : 0;
  // Sums are kept at the reference time `origin`: a row adds its value x 2^((close - origin) / hl);
  // the sum at time t is that x 2^(-(t - origin) / hl). Without a half-life every row counts 1.
  const lift = (close) => (hl ? 2 ** ((close - origin) / hl) : 1);
  const sums = new Map();
  const bump = (r, sign) => {
    const s = sums.get(r.agent) || { H: 0, D: 0, B: 0, NB: 0, n: 0 };
    const k = sign * lift(r.close_ms);
    s.n += sign;
    if (r.result === "hit" || r.result === "miss" || r.result === "missed_opportunity") { s.D += k; if (r.result === "hit") s.H += k; }
    if (Number.isFinite(r.brier)) { s.B += k * (0.25 - r.brier); s.NB += k; }
    sums.set(r.agent, s);
  };
  const out = new Map();
  let add = 0, drop = 0;
  for (const room of rooms) {
    const t = room.close_ms;
    while (add < rows.length && rows[add].close_ms + horizonMs <= t) bump(rows[add++], 1);
    while (drop < add && rows[drop].close_ms < t - p.days * DAY_MS) bump(rows[drop++], -1);
    const down = hl ? 2 ** (-(t - origin) / hl) : 1;
    const weighted = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
    let total = 0;
    for (const e of room.entries) {
      const s = sums.get(e.agent);
      const w = weightFromSums(s ? { H: s.H * down, D: s.D * down, B: s.B * down, NB: s.NB * down, n: s.n } : {}, p).weight;
      weighted[e.bias in weighted ? e.bias : "NEUTRAL"] += w; total += w;
    }
    const side = SIDE[room.bias];
    const share = side && total ? weighted[room.bias] / total : null;
    out.set(room.candle_key, { stance: side && share > p.quorum_share ? side : "WAIT", share: r3(share) });
  }
  return out;
}

/** Pure: the comparison of the arms. `outcome(candle_key, stance)` scores a stance on that candle. */
export function compareWeighting({ rows, rooms, outcome, active = WEIGHTING_DEFAULT, previous = null, activatedAt = null, now = Date.now(), moderator = new Map() }) {
  const scoreArm = (params) => {
    const decisions = replayQuorum(params, rows, rooms);
    const scored = new Map();
    for (const room of rooms) {
      const d = decisions.get(room.candle_key);
      const result = d ? outcome(room.candle_key, d.stance) : null;
      if (result) scored.set(room.candle_key, { stance: d.stance, result, share: d.share });
    }
    return scored;
  };
  const ctrl = scoreArm(active);
  const pairsOf = (mine, keys = rooms) => keys.filter((r) => mine.has(r.candle_key) && ctrl.has(r.candle_key)).map((r) => [mine.get(r.candle_key), ctrl.get(r.candle_key)]);
  const month = holmMonth(now);
  const entries = neighbourPoints(active).map((point) => {
    const mine = scoreArm(point.params);
    const pairs = pairsOf(mine);
    const cut = Math.max(0, pairs.length - HOLDOUT_BARS);
    const all = pairedTally(pairs), discovery = pairedTally(pairs.slice(0, cut)), holdout = pairedTally(pairs.slice(cut));
    return {
      id: point.id, changed: point.changed, change: point.change, params: point.params,
      same_rooms: pairs.length, differing_decisions: pairs.filter(([a, b]) => a.stance !== b.stance).length,
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
    k.verdict = k.criteria.higher_outcome_score !== true ? "not_better" : k.criteria.holdout_no_worse ? "better_than_active: ready for approval in the Console" : "holdout_failed";
  }
  // Reverse shadow: the point before the activation against the active one, on the rooms since.
  let reverse = null;
  if (previous && activatedAt) {
    const since = Date.parse(activatedAt);
    const after = rooms.filter((r) => r.close_ms >= since);
    const prev = scoreArm(previous);
    const t = pairedTally(after.filter((r) => prev.has(r.candle_key) && ctrl.has(r.candle_key)).map((r) => [prev.get(r.candle_key), ctrl.get(r.candle_key)]));
    reverse = { previous_id: weightingId(previous), since: activatedAt, rooms: t.bars, previous_better: t.candidate_better, active_better: t.control_better, p_value: t.p_value, previous_accuracy: t.accuracy, active_accuracy: t.control_accuracy };
  }
  // How often the replayed control matches the moderator's own conclusion (the replay's definition check).
  const agreeable = rooms.filter((r) => moderator.has(r.candle_key) && ctrl.has(r.candle_key));
  const agree = agreeable.filter((r) => moderator.get(r.candle_key) === ctrl.get(r.candle_key).stance).length;
  const ctrlTally = pairedTally([...ctrl.values()].map((s) => [s, s]));
  return {
    version: WEIGHTING_REPLAY_VERSION, equation: WEIGHTING_VERSION, family: "weighting", name: "H1 quorum weighting (1H War Room)",
    rooms: rooms.length,
    control: { id: weightingId(active), params: active, change: "none: the active weighting", scored_rooms: ctrl.size, accuracy: ctrlTally.accuracy, entries_taken: [...ctrl.values()].filter((s) => s.stance !== "WAIT").length, moderator_agreement: agreeable.length ? r3(agree / agreeable.length) : null },
    holm: { month, alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.id) },
    candidates: entries,
    reverse
  };
}

const READ_CACHE_MS = 5 * 60_000;
let cache = null;
export function resetWeightingReplayCacheForTests() { cache = null; }

/** The concluded 1H rooms since `sinceIso`: final bias per agent, the moderator's bias and stance. */
export async function loadH1Rooms(db, sinceIso) {
  const rows = (await db.prepare(
    "SELECT m.run_id, m.step, m.agent, m.stance, json_extract(m.body_json, '$.bias') AS bias, json_extract(b.body_json, '$.candle_key') AS candle_key " +
    "FROM agent_thread_messages m JOIN agent_thread_messages b ON b.thread_id = m.thread_id AND b.run_id = m.run_id AND b.step = 'brief' " +
    "WHERE m.thread_id = 'tf:H1' AND m.status = 'ok' AND m.ts >= ? AND (m.step LIKE 'open:%' OR m.step LIKE 'debate:%' OR m.step = 'conclusion') " +
    "ORDER BY m.run_id, CASE WHEN m.step LIKE 'open:%' THEN 0 WHEN m.step LIKE 'debate:%' THEN 1 ELSE 2 END"
  ).bind(sinceIso).all()).results || [];
  const byKey = new Map();
  for (const r of rows) {
    const key = r.candle_key;
    const open = Number(String(key || "").split(":").pop());
    if (!key || !Number.isFinite(open)) continue;
    let room = byKey.get(key);
    // A later session of the bar (#hud) replaces the earlier one.
    if (!room || String(r.run_id) > room.run_id) { room = { candle_key: key, run_id: String(r.run_id), close_ms: open + H1_MS, agents: new Map(), bias: null, stance: null }; byKey.set(key, room); }
    if (String(r.run_id) !== room.run_id) continue;
    const bias = ["BULLISH", "BEARISH", "NEUTRAL"].includes(String(r.bias).toUpperCase()) ? String(r.bias).toUpperCase() : r.stance === "BUY" ? "BULLISH" : r.stance === "SELL" ? "BEARISH" : "NEUTRAL";
    if (r.step === "conclusion") { room.bias = bias; room.stance = r.stance; continue; }
    if (r.step.startsWith("open:") || room.agents.has(r.agent)) room.agents.set(r.agent, bias);
  }
  return [...byKey.values()].filter((r) => r.stance && r.agents.size).map((r) => ({ candle_key: r.candle_key, close_ms: r.close_ms, bias: r.bias, stance: r.stance, entries: [...r.agents].map(([agent, bias]) => ({ agent, bias })) })).sort((a, b) => a.close_ms - b.close_ms);
}

/** Loads the rooms, the scores and the state, and replays the weighting arms (cached 5 minutes). */
export async function readWeightingReplay(env, { days = 30, now = Date.now(), useCache = true } = {}) {
  if (useCache && cache && cache.days === days && now - cache.at < READ_CACHE_MS) return cache.value;
  await ensureOutcomeSchema(env.DB);
  const state = await weightingState(env, { now });
  const windowStart = now - days * DAY_MS;
  const maxDays = Math.max(...WEIGHTING_GRID.days);
  const historyStart = windowStart - maxDays * DAY_MS;
  const byAgent = await loadAgentRows(env.DB, { days: days + maxDays, now });
  const rows = [...byAgent].flatMap(([agent, list]) => list.map((r) => ({ agent, ...r }))).filter((r) => r.close_ms >= historyStart).sort((a, b) => a.close_ms - b.close_ms);
  let rooms = [];
  try { rooms = await loadH1Rooms(env.DB, new Date(windowStart - H1_MS).toISOString()); } catch { rooms = []; }
  rooms = rooms.filter((r) => r.close_ms >= windowStart);
  const outcomes = new Map();
  const scored = (await env.DB.prepare("SELECT candle_key, stance, result FROM outcome_scores WHERE timeframe = '60' AND scoring_version = ? AND statement_close >= ?").bind(SCORING_VERSION, new Date(windowStart).toISOString()).all()).results || [];
  for (const s of scored) (outcomes.get(s.candle_key) || outcomes.set(s.candle_key, new Map()).get(s.candle_key)).set(s.stance, s.result);
  let bars = null;
  const loadBars = async () => {
    try {
      const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|1h")) || "null");
      return (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    } catch { return []; }
  };
  if (rooms.some((room) => ["BUY", "SELL", "WAIT"].some((st) => !outcomes.get(room.candle_key)?.has(st)))) bars = await loadBars();
  const byCandle = new Map(rooms.map((r) => [r.candle_key, r]));
  const outcome = (key, stance) => {
    const known = outcomes.get(key)?.get(stance);
    if (known) return ["hit", "miss", "neutral", "missed_opportunity"].includes(known) ? known : null;
    const room = byCandle.get(key);
    if (!room || !bars?.length) return null;
    const s = scoreStance({ stance, bars, closeMs: room.close_ms });
    return ["hit", "miss", "neutral", "missed_opportunity"].includes(s.result) ? s.result : null;
  };
  const moderator = new Map(rooms.map((r) => [r.candle_key, r.stance]));
  const comparison = compareWeighting({ rows, rooms, outcome, active: state.params, previous: state.previous, activatedAt: state.activated_at, now, moderator });
  // Each agent's own weight now, under the active weighting (for the report and the Console).
  const agents = [...byAgent].map(([agent, list]) => ({ agent, family: familyOf(agent), ...agentWeight(list, state.params, now, { horizonMs: 0 }) })).sort((a, b) => b.weight - a.weight);
  const value = { window_days: days, active: { id: state.id, params: state.params, activated_at: state.activated_at, source: state.source, change: weightingChange(state.params) }, agents, ...comparison, history: (state.history || []).slice(-10) };
  if (useCache) cache = { at: now, days, value };
  return value;
}
