// The replay of each timeframe's room quorum under other weighting parameters (src/weighting.mjs; owner
// decisions 2026-11-09). Deterministic and read-only: no model call, nothing reaches a room or a decision.
//
// For every concluded room of one timeframe in the window (15m: threads warroom:*, keyed by bar time;
// 1H, 4H, D1: threads tf:H1, tf:H4, tf:D1, keyed by the brief's candle key; the latest session of a bar):
//   - each agent's final bias (its Consensus Discussion answer, else its opening);
//   - each agent's weight at the room's time, point in time, on that timeframe only: only the scored
//     statements whose horizon had closed before the room met, in the bar's regime when the point uses one
//     (src/market-regime.mjs, from that timeframe's own bars);
//   - the replayed decision: the room's direction is the moderator's bias (BULLISH BUY, BEARISH SELL;
//     its stance is itself shaped by the live quorum); BUY or SELL when more than the point's quorum share
//     in that regime holds that bias, else WAIT;
//   - the decision is scored like every stance (src/outcome-scoring.mjs).
// Arms: the active point (control) and every grid point one parameter away. Statistics as every shadow
// arm (§9.3): paired one-sided sign test, Holm across the family's live tests of the month, the
// discovery minimum and the newest HOLDOUT_BARS as a holdout; after an activation, the reverse shadow.

import { SCORING, SCORING_VERSION, scoreStance, ensureOutcomeSchema } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";
import { WEIGHTING_DEFAULT, WEIGHTING_GRID, WEIGHTING_VERSION, weightingId, weightingChange, neighbourPoints, weightFromSums, loadAgentRows, agentWeight, weightingState, quorumFor, TF_MS } from "./weighting.mjs";
import { familyOf } from "./reputation.mjs";
import { regimeMap, REGIME_SERIES } from "./market-regime.mjs";
import { collectNexusAnalytics } from "./nexus-analytics.mjs";

export const WEIGHTING_REPLAY_VERSION = "cryptophys.weighting-replay.v2";
const DAY_MS = 86_400_000;
const SIDE = { BULLISH: "BUY", BEARISH: "SELL" };
const SYMBOL = "OANDA:XAUUSD";
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
/** The replay window of each timeframe: about the same number of rooms where the timeframe allows. */
export const REPLAY_DAYS = Object.freeze({ "15": 10, "60": 30, "240": 90, "1D": 365 });

/**
 * Pure: the replayed decision of each room under one arm. `rows` are the scored agent statements
 * ({ agent, close_ms, result, brier, regime }) sorted by close_ms; `rooms` ({ candle_key, close_ms,
 * bias, regime, entries: [{ agent, bias }] }) sorted by close_ms. Returns Map candle_key -> { stance, share }.
 */
export function replayQuorum(params, rows, rooms, { horizonMs = SCORING.horizon * 3_600_000, analytics = null } = {}) {
  const p = { ...WEIGHTING_DEFAULT, ...params };
  const hl = p.half_life_days ? p.half_life_days * DAY_MS : null;
  const origin = rows.length ? rows[0].close_ms : 0;
  // Sums are kept at the reference time `origin`: a row adds its value x 2^((close - origin) / hl); the sum
  // at time t is that x 2^(-(t - origin) / hl). Without a half-life every row counts 1.
  const lift = (close) => (hl ? 2 ** ((close - origin) / hl) : 1);
  const sums = new Map();
  const bump = (r, sign) => {
    const s = sums.get(r.agent) || { H: 0, D: 0, B: 0, NB: 0, n: 0, reg: new Map() };
    const k = sign * lift(r.close_ms);
    s.n += sign;
    if (r.result === "hit" || r.result === "miss" || r.result === "missed_opportunity") {
      s.D += k; if (r.result === "hit") s.H += k;
      if (r.regime) { const g = s.reg.get(r.regime) || { H: 0, D: 0 }; g.D += k; if (r.result === "hit") g.H += k; s.reg.set(r.regime, g); }
    }
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
      const reg = s && room.regime ? s.reg.get(room.regime) : null;
      const w = weightFromSums(s ? { H: s.H * down, D: s.D * down, B: s.B * down, NB: s.NB * down, n: s.n } : {}, p, room.regime ? { H: (reg?.H ?? 0) * down, D: (reg?.D ?? 0) * down } : null).weight;
      weighted[e.bias in weighted ? e.bias : "NEUTRAL"] += w; total += w;
    }
    const side = SIDE[room.bias];
    const share = side && total ? weighted[room.bias] / total : null;
    out.set(room.candle_key, { stance: side && share > quorumFor(p, room.regime, { analytics }) ? side : "WAIT", share: r3(share) });
  }
  return out;
}

/** Pure: the comparison of the arms. `outcome(candle_key, stance)` scores a stance on that candle. */
export function compareWeighting({ rows, rooms, outcome, active = WEIGHTING_DEFAULT, previous = null, activatedAt = null, now = Date.now(), moderator = new Map(), horizonMs = SCORING.horizon * 3_600_000, timeframe = "60", analytics = null }) {
  const scoreArm = (params) => {
    const decisions = replayQuorum(params, rows, rooms, { horizonMs, analytics });
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
    k.verdict = k.criteria.higher_outcome_score !== true ? "not_better" : k.criteria.holdout_no_worse ? "better_than_active: activated automatically" : "holdout_failed";
  }
  let reverse = null;
  if (previous && activatedAt) {
    const since = Date.parse(activatedAt);
    const after = rooms.filter((r) => r.close_ms >= since);
    const prev = scoreArm(previous);
    const t = pairedTally(after.filter((r) => prev.has(r.candle_key) && ctrl.has(r.candle_key)).map((r) => [prev.get(r.candle_key), ctrl.get(r.candle_key)]));
    reverse = { previous_id: weightingId(previous), since: activatedAt, rooms: t.bars, previous_better: t.candidate_better, active_better: t.control_better, p_value: t.p_value, previous_accuracy: t.accuracy, active_accuracy: t.control_accuracy };
  }
  const agreeable = rooms.filter((r) => moderator.has(r.candle_key) && ctrl.has(r.candle_key));
  const agree = agreeable.filter((r) => moderator.get(r.candle_key) === ctrl.get(r.candle_key).stance).length;
  const ctrlTally = pairedTally([...ctrl.values()].map((s) => [s, s]));
  const regimes = {};
  for (const r of rooms) regimes[r.regime ?? "unknown"] = (regimes[r.regime ?? "unknown"] || 0) + 1;
  return {
    version: WEIGHTING_REPLAY_VERSION, equation: WEIGHTING_VERSION, family: "weighting", timeframe, name: `Room quorum weighting (${timeframe})`,
    rooms: rooms.length, regimes,
    control: { id: weightingId(active), params: active, change: "none: the active weighting", scored_rooms: ctrl.size, accuracy: ctrlTally.accuracy, entries_taken: [...ctrl.values()].filter((s) => s.stance !== "WAIT").length, moderator_agreement: agreeable.length ? r3(agree / agreeable.length) : null },
    holm: { month, alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.id) },
    candidates: entries,
    reverse
  };
}

const READ_CACHE_MS = 5 * 60_000;
const cache = new Map();
export function resetWeightingReplayCacheForTests() { cache.clear(); }

const normBias = (bias, stance) => (["BULLISH", "BEARISH", "NEUTRAL"].includes(String(bias).toUpperCase()) ? String(bias).toUpperCase() : stance === "BUY" ? "BULLISH" : stance === "SELL" ? "BEARISH" : "NEUTRAL");

/** Pure: rooms from thread rows ({ run_id, step, agent, stance, bias, key }) and each key's close time. */
export function roomsFromRows(rows, closeOf) {
  const byKey = new Map();
  for (const r of rows) {
    const key = r.key;
    const close_ms = key ? closeOf(key) : NaN;
    if (!key || !Number.isFinite(close_ms)) continue;
    let room = byKey.get(key);
    // A later session of the bar (#hud) replaces the earlier one.
    if (!room || String(r.run_id) > room.run_id) { room = { candle_key: key, run_id: String(r.run_id), close_ms, agents: new Map(), bias: null, stance: null }; byKey.set(key, room); }
    if (String(r.run_id) !== room.run_id) continue;
    const bias = normBias(r.bias, r.stance);
    if (r.step === "conclusion") { room.bias = bias; room.stance = r.stance; continue; }
    if (r.step.startsWith("open:") || room.agents.has(r.agent)) room.agents.set(r.agent, bias);
  }
  return [...byKey.values()].filter((r) => r.stance && r.agents.size).map((r) => ({ candle_key: r.candle_key, close_ms: r.close_ms, bias: r.bias, stance: r.stance, entries: [...r.agents].map(([agent, bias]) => ({ agent, bias })) })).sort((a, b) => a.close_ms - b.close_ms);
}

const ORDER = "ORDER BY m.run_id, CASE WHEN m.step LIKE 'open:%' THEN 0 WHEN m.step LIKE 'debate:%' THEN 1 ELSE 2 END";
const STEPS = "(m.step LIKE 'open:%' OR m.step LIKE 'debate:%' OR m.step = 'conclusion')";
const TF_THREAD = Object.freeze({ "60": "tf:H1", "240": "tf:H4", "1D": "tf:D1" });

/** The concluded rooms of a timeframe since `sinceIso`. */
export async function loadRooms(db, timeframe, sinceIso) {
  if (timeframe === "15") {
    const rows = (await db.prepare(`SELECT m.run_id, m.step, m.agent, m.stance, json_extract(m.body_json, '$.bias') AS bias, m.bar_time AS bar_time FROM agent_thread_messages m WHERE m.thread_id >= 'warroom:' AND m.thread_id < 'warroom;' AND m.status = 'ok' AND m.ts >= ? AND ${STEPS} ${ORDER}`).bind(sinceIso).all()).results || [];
    // The 15m room's bar time is its close; its outcome key is the bar's open (src/outcome-scoring.mjs).
    return roomsFromRows(rows.map((r) => ({ ...r, key: Number.isFinite(Date.parse(r.bar_time)) ? `${SYMBOL}:15:${Date.parse(r.bar_time) - TF_MS["15"]}` : null })), (key) => Number(key.split(":").pop()) + TF_MS["15"]);
  }
  const rows = (await db.prepare(`SELECT m.run_id, m.step, m.agent, m.stance, json_extract(m.body_json, '$.bias') AS bias, json_extract(b.body_json, '$.candle_key') AS key FROM agent_thread_messages m JOIN agent_thread_messages b ON b.thread_id = m.thread_id AND b.run_id = m.run_id AND b.step = 'brief' WHERE m.thread_id = ? AND m.status = 'ok' AND m.ts >= ? AND ${STEPS} ${ORDER}`).bind(TF_THREAD[timeframe], sinceIso).all()).results || [];
  return roomsFromRows(rows, (key) => Number(String(key).split(":").pop()) + TF_MS[timeframe]);
}

/** The H1 rooms (kept for callers of the first release). */
export async function loadH1Rooms(db, sinceIso) { return loadRooms(db, "60", sinceIso); }

/** Loads a timeframe's rooms, scores and state, and replays the weighting arms (cached 5 minutes). */
export async function readWeightingReplay(env, { timeframe = "60", days = REPLAY_DAYS[timeframe] ?? 30, now = Date.now(), useCache = true, analytics = null } = {}) {
  const ck = `${timeframe}:${days}`;
  const hit = cache.get(ck);
  if (useCache && hit && now - hit.at < READ_CACHE_MS) return hit.value;
  await ensureOutcomeSchema(env.DB);
  let activeAnalytics = analytics;
  if (!activeAnalytics && env?.DB) {
    try { activeAnalytics = await collectNexusAnalytics(env, { now, days }); } catch {}
  }
  const state = await weightingState(env, { timeframe, now });
  const tfMs = TF_MS[timeframe];
  const windowStart = now - days * DAY_MS;
  const maxDays = Math.max(...WEIGHTING_GRID.days);
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:${SYMBOL}|${REGIME_SERIES[timeframe]}`)) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const regimes = regimeMap(bars);
  const byAgent = await loadAgentRows(env.DB, { days: days + maxDays, now, timeframe, regimes });
  const rows = [...byAgent].flatMap(([agent, list]) => list.map((r) => ({ agent, ...r }))).sort((a, b) => a.close_ms - b.close_ms);
  let rooms = [];
  try { rooms = await loadRooms(env.DB, timeframe, new Date(windowStart - tfMs).toISOString()); } catch { rooms = []; }
  rooms = rooms.filter((r) => r.close_ms >= windowStart).map((r) => ({ ...r, regime: regimes.get(r.close_ms) ?? null }));
  const outcomes = new Map();
  const scored = (await env.DB.prepare("SELECT candle_key, stance, result FROM outcome_scores WHERE timeframe = ? AND scoring_version = ? AND statement_close >= ?").bind(timeframe, SCORING_VERSION, new Date(windowStart).toISOString()).all()).results || [];
  for (const s of scored) (outcomes.get(s.candle_key) || outcomes.set(s.candle_key, new Map()).get(s.candle_key)).set(s.stance, s.result);
  const byCandle = new Map(rooms.map((r) => [r.candle_key, r]));
  const outcome = (key, stance) => {
    const known = outcomes.get(key)?.get(stance);
    if (known) return ["hit", "miss", "neutral", "missed_opportunity"].includes(known) ? known : null;
    const room = byCandle.get(key);
    if (!room || !bars.length) return null;
    const s = scoreStance({ stance, bars, closeMs: room.close_ms });
    return ["hit", "miss", "neutral", "missed_opportunity"].includes(s.result) ? s.result : null;
  };
  const moderator = new Map(rooms.map((r) => [r.candle_key, r.stance]));
  const comparison = compareWeighting({ rows, rooms, outcome, active: state.params, previous: state.previous, activatedAt: state.activated_at, now, moderator, horizonMs: SCORING.horizon * tfMs, timeframe, analytics: activeAnalytics });
  // Each agent's own weight now, under the active weighting (for the report and Nexus).
  const agentDiscounts = activeAnalytics?.quorum_weighting_input?.agent_weight_discounts ?? {};
  const disqualified = new Set(activeAnalytics?.quorum_weighting_input?.disqualified_agents || []);
  const agents = [...byAgent].map(([agent, list]) => ({
    agent,
    family: familyOf(agent),
    ...agentWeight(list, state.params, now, {
      horizonMs: 0,
      discount: agentDiscounts[agent] ?? 1,
      isStuck: disqualified.has(agent)
    })
  })).sort((a, b) => b.weight - a.weight);
  const value = { window_days: days, active: { id: state.id, params: state.params, activated_at: state.activated_at, source: state.source, change: weightingChange(state.params) }, agents, ...comparison, history: (state.history || []).slice(-10), nexus_analytics: activeAnalytics };
  if (useCache) cache.set(ck, { at: now, value });
  return value;
}
