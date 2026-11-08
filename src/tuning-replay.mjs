// Aether phase A8, part 2 (RFC_AETHER_KNOWLEDGE_GUARDIAN §9.1 and §9.4, K7): deterministic replay of
// the reputation parameters behind the 1H room's weighted crowd line (src/reputation.mjs).
//
// Every 1H room's agents are scored as "agent:<id>" (outcome_scores, timeframe 60). For each scored
// room, the replay rebuilds the weighted crowd bias the way buildCrowdLine does, once with the active
// parameters (the control) and once per candidate parameter set:
//   - reputation of each agent at the room's time, point in time: only the scores whose horizon had
//     closed before the room met (statement close + SCORING.horizon bars) and within the window days;
//   - the agent's bias is its final scored stance (BUY bullish, SELL bearish, WAIT neutral), the same
//     for every arm, so the comparison is like for like;
//   - the crowd stance (BULLISH BUY, BEARISH SELL, NEUTRAL WAIT) is scored with the outcome of that
//     stance on that candle: the result an agent with the same stance received (same scoring), else
//     scoreStance on the cached H1 bars.
// The statistics are the shadow ones (§9.3): paired one-sided sign test, Holm across this family's
// candidates of the month, discovery minimum and the newest bars as a holdout.
// Read-only: nothing is stored, nothing reaches a room, a prompt or a decision. A better parameter set
// is a proposal for an owner PR to src/reputation.mjs.

import { REPUTATION_PRIOR, WEIGHT_RANGE, REPUTATION_DAYS, NEUTRAL_BAND } from "./reputation.mjs";
import { SCORING, SCORING_VERSION, scoreStance, ensureOutcomeSchema } from "./outcome-scoring.mjs";
import { pairedTally, holmAdjust, holmMonth, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS } from "./shadow-versions.mjs";

export const CROWD_REPLAY_VERSION = "cryptophys.crowd-replay.v1";
const H1_MS = 3_600_000;

/** The active reputation parameters (src/reputation.mjs): the control. */
export const CROWD_CONTROL = Object.freeze({
  id: "crowd@active", prior: REPUTATION_PRIOR, weight_range: WEIGHT_RANGE, days: REPUTATION_DAYS, neutral_band: NEUTRAL_BAND,
  change: "none: the active reputation parameters"
});
/** The reviewed grid of the crowd family (at most 3 at once, RFC O6). Changing it is a reviewed PR. */
export const CROWD_CANDIDATES = Object.freeze([
  Object.freeze({ id: "crowd@prior20", prior: 20, weight_range: WEIGHT_RANGE, days: REPUTATION_DAYS, neutral_band: NEUTRAL_BAND, change: "a reputation needs twice the sample (prior 20 instead of 10) before its weight moves" }),
  Object.freeze({ id: "crowd@weight0.5-1.5", prior: REPUTATION_PRIOR, weight_range: Object.freeze([0.5, 1.5]), days: REPUTATION_DAYS, neutral_band: NEUTRAL_BAND, change: "weights kept within 0.5 to 1.5 instead of 0.25 to 2" }),
  Object.freeze({ id: "crowd@band0.2", prior: REPUTATION_PRIOR, weight_range: WEIGHT_RANGE, days: REPUTATION_DAYS, neutral_band: 0.2, change: "the crowd is neutral within a weighted lean of 0.2 instead of 0.1" })
]);

const SIGN = { BUY: 1, SELL: -1, WAIT: 0 };
const DECISIVE = new Set(["hit", "miss", "missed_opportunity"]);
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Pure: a reputation weight from hits and decisive outcomes (reputationOf with explicit parameters). */
export function weightOf(hits, decisive, { prior, weight_range }) {
  const shrunk = (hits + prior / 2) / (decisive + prior);
  return r3(Math.min(weight_range[1], Math.max(weight_range[0], 2 * shrunk)));
}

/** Pure: the weighted crowd stance of one room (buildCrowdLine's weighted_bias as a stance). */
export function crowdStance(entries, weights, neutralBand) {
  let sum = 0, wsum = 0;
  for (const e of entries) {
    const w = Number.isFinite(weights[e.agent]) ? weights[e.agent] : 1;
    sum += (SIGN[e.stance] ?? 0) * w; wsum += w;
  }
  const lean = wsum ? sum / wsum : 0;
  return Math.abs(lean) < neutralBand ? "WAIT" : lean > 0 ? "BUY" : "SELL";
}

/**
 * Pure: the crowd stance per room for one arm. `rows` are the scored H1 agent statements
 * ({ agent, candle_key, close_ms, stance, result }), sorted by close_ms; `rooms` the rooms to replay
 * (close_ms ascending), each with its non-moderator entries. Returns Map candle_key -> stance.
 */
export function replayArm(arm, rows, rooms, { horizonMs = SCORING.horizon * H1_MS } = {}) {
  const days = arm.days * 86_400_000;
  const stats = new Map(); // agent -> { hits, decisive }
  const bump = (r, d) => {
    if (!DECISIVE.has(r.result)) return;
    const s = stats.get(r.agent) || { hits: 0, decisive: 0 };
    s.decisive += d; if (r.result === "hit") s.hits += d;
    stats.set(r.agent, s);
  };
  const out = new Map();
  let add = 0, drop = 0;
  for (const room of rooms) {
    const t = room.close_ms;
    while (add < rows.length && rows[add].close_ms + horizonMs <= t) bump(rows[add++], 1);
    while (drop < add && rows[drop].close_ms < t - days) bump(rows[drop++], -1);
    const weights = {};
    for (const e of room.entries) {
      const s = stats.get(e.agent);
      weights[e.agent] = weightOf(s?.hits ?? 0, s?.decisive ?? 0, arm);
    }
    out.set(room.candle_key, crowdStance(room.entries, weights, arm.neutral_band));
  }
  return out;
}

/** Pure: the comparison of the arms over the replayed rooms. `outcome(candle_key, stance)` scores a stance. */
export function compareCrowd({ rows, rooms, outcome, candidates = CROWD_CANDIDATES, control = CROWD_CONTROL, now = Date.now(), moderator = new Map() }) {
  const scoreArm = (arm) => {
    const stances = replayArm(arm, rows, rooms);
    const scored = new Map();
    for (const room of rooms) {
      const stance = stances.get(room.candle_key);
      const result = outcome(room.candle_key, stance);
      if (result) scored.set(room.candle_key, { stance, result });
    }
    return scored;
  };
  const ctrl = scoreArm(control);
  const month = holmMonth(now);
  const entries = candidates.map((arm) => {
    const mine = scoreArm(arm);
    const pairs = rooms.filter((r) => mine.has(r.candle_key) && ctrl.has(r.candle_key)).map((r) => [mine.get(r.candle_key), ctrl.get(r.candle_key)]);
    const cut = Math.max(0, pairs.length - HOLDOUT_BARS);
    const all = pairedTally(pairs), discovery = pairedTally(pairs.slice(0, cut)), holdout = pairedTally(pairs.slice(cut));
    return {
      id: arm.id, change: arm.change, params: { prior: arm.prior, weight_range: arm.weight_range, days: arm.days, neutral_band: arm.neutral_band },
      same_rooms: pairs.length, differing_stances: pairs.filter(([a, b]) => a.stance !== b.stance).length,
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
  // Context for the crowd pattern (§9.2): the moderator's conclusion on the same rooms.
  const modPairs = rooms.filter((r) => moderator.has(r.candle_key) && ctrl.has(r.candle_key)).map((r) => [ctrl.get(r.candle_key), moderator.get(r.candle_key)]);
  const vsModerator = pairedTally(modPairs);
  return {
    version: CROWD_REPLAY_VERSION, family: "crowd", name: "Weighted crowd line (1H room reputation)",
    rooms: rooms.length,
    control: { id: control.id, change: control.change, params: { prior: control.prior, weight_range: control.weight_range, days: control.days, neutral_band: control.neutral_band }, scored_rooms: ctrl.size },
    crowd_vs_moderator: { rooms: vsModerator.bars, crowd_better: vsModerator.candidate_better, moderator_better: vsModerator.control_better, p_value: vsModerator.p_value, crowd_accuracy: vsModerator.accuracy, moderator_accuracy: vsModerator.control_accuracy },
    holm: { month, alpha: SHADOW_SIGNIFICANCE, tests: adjusted.filter((p) => p !== null).length, live: live.map((k) => k.id) },
    candidates: entries
  };
}

const READ_CACHE_MS = 5 * 60_000;
let cache = null;
export function resetCrowdReplayCacheForTests() { cache = null; }

/** Loads the scored 1H room statements and replays the crowd arms (cached 5 minutes). */
export async function readCrowdReplay(env, { days = 30, now = Date.now(), useCache = true } = {}) {
  if (useCache && cache && cache.days === days && now - cache.at < READ_CACHE_MS) return cache.value;
  await ensureOutcomeSchema(env.DB);
  const windowStart = now - days * 86_400_000;
  const historyStart = windowStart - Math.max(CROWD_CONTROL.days, ...CROWD_CANDIDATES.map((c) => c.days)) * 86_400_000;
  const raw = (await env.DB.prepare("SELECT subject, candle_key, statement_close, stance, result FROM outcome_scores WHERE timeframe = '60' AND subject LIKE 'agent:%' AND scoring_version = ? AND statement_close >= ? ORDER BY statement_close").bind(SCORING_VERSION, new Date(historyStart).toISOString()).all()).results || [];
  const rows = [], byCandle = new Map(), moderator = new Map(), outcomes = new Map();
  for (const r of raw) {
    const agent = String(r.subject).slice("agent:".length), close_ms = Date.parse(r.statement_close);
    if (!Number.isFinite(close_ms) || !(r.stance in SIGN)) continue;
    (outcomes.get(r.candle_key) || outcomes.set(r.candle_key, new Map()).get(r.candle_key)).set(r.stance, r.result);
    if (agent === "moderator") { moderator.set(r.candle_key, { stance: r.stance, result: r.result }); continue; }
    rows.push({ agent, candle_key: r.candle_key, close_ms, stance: r.stance, result: r.result });
    if (close_ms >= windowStart) {
      const room = byCandle.get(r.candle_key) || { candle_key: r.candle_key, close_ms, entries: [] };
      room.entries.push({ agent, stance: r.stance });
      byCandle.set(r.candle_key, room);
    }
  }
  const rooms = [...byCandle.values()].sort((a, b) => a.close_ms - b.close_ms);
  let bars = null;
  const outcome = (key, stance) => {
    const known = outcomes.get(key)?.get(stance);
    if (known) return DECISIVE.has(known) || known === "neutral" ? known : null;
    bars ??= [];
    const room = byCandle.get(key);
    if (!room || !bars.length) return null;
    const s = scoreStance({ stance, bars, closeMs: room.close_ms });
    return ["hit", "miss", "neutral", "missed_opportunity"].includes(s.result) ? s.result : null;
  };
  // Bars are needed only for a crowd stance no agent of that room took: load them once, lazily.
  if (rooms.some((room) => ["BUY", "SELL", "WAIT"].some((st) => !outcomes.get(room.candle_key)?.has(st)))) {
    try {
      const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|1h")) || "null");
      bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    } catch { bars = []; }
  }
  const value = { window_days: days, ...compareCrowd({ rows, rooms, outcome, now, moderator }) };
  if (useCache) cache = { at: now, days, value };
  return value;
}
