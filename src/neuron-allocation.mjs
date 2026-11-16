// Neuron allocation, read-only (owner 2026-11-14: "setuju poin 4, tapi perlu visualisasi yang jelas di
// dashboard", then "Ya" to the order: this first, then structured metrics, then the model arena). What each
// agent costs in Workers AI neurons and what it delivers: its 30-day hit rate (the scorecards snapshot,
// src/outcome-scoring.mjs) against its neurons per day, per room. GET /api/neuron-allocation and the Nexus page
// "Neuron allocation". The allocation itself (an agent to shadow and back) is src/agent-allocation.mjs; its state
// and its logged changes are shown here.
//
// Tokens per agent come from the room messages (agent_thread_messages.usage_tokens, input and output together);
// they are turned into neurons with the model's own input/output mix of that day (ai_usage_daily), so an
// agent's neurons add up to what the meter shows for its model.
import { neuronsOf, readAiUsage } from "./ai-usage.mjs";
import { scorecards } from "./outcome-scoring.mjs";
import { ensureThreadSchema } from "./agent-threads.mjs";
import { readAllocationState, readAllocationEvents, ALLOCATION_RULES } from "./agent-allocation.mjs";
import { readMetricShadow } from "./metric-shadow.mjs";
import { readModelArena } from "./model-arena.mjs";
import { roomRunsReaderEnabled, docsReady, DOC_ROOMS_SQL } from "./room-runs.mjs";

export const NEURON_ALLOCATION_VERSION = "cryptophys.neuron-allocation.v1";
const ROOM_SQL = `CASE
  WHEN thread_id >= 'warroom:' AND thread_id < 'warroom;' THEN 'M15'
  WHEN thread_id = 'tf:H1' THEN 'H1' WHEN thread_id = 'tf:H4' THEN 'H4' WHEN thread_id = 'tf:D1' THEN 'D1'
  WHEN thread_id >= 'newsdaily:' AND thread_id < 'newsdaily;' THEN 'News Daily'
  WHEN thread_id >= 'macro:' AND thread_id < 'macro;' THEN 'Macro'
  ELSE 'Other' END`;
/** The scorecards' timeframe of each room's agents. */
const ROOM_TIMEFRAME = Object.freeze({ M15: "15", H1: "60", H4: "240", D1: "1D" });

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Pure: neurons per token of each (day, model), from the meter's input/output mix. */
export function blendedRates(usageRows) {
  const out = new Map();
  for (const r of usageRows || []) {
    const key = `${r.day}|${r.model}`;
    const a = out.get(key) || { prompt: 0, completion: 0 };
    a.prompt += Number(r.prompt_tokens) || 0;
    a.completion += Number(r.completion_tokens) || 0;
    out.set(key, a);
  }
  const rates = new Map();
  for (const [key, a] of out) {
    const model = key.split("|").slice(1).join("|");
    const n = neuronsOf(model, a.prompt, a.completion);
    const tokens = a.prompt + a.completion;
    if (n != null && tokens > 0) rates.set(key, n / tokens);
  }
  return rates;
}

/** Pure: the fallback rate of a model with no meter row that day (its input rate: a floor, never a guess above). */
function floorRate(model) {
  const n = neuronsOf(model, 1_000_000, 0);
  return n == null ? null : n / 1_000_000;
}

/**
 * Pure: the allocation view from the room rows { day, room, agent, model, calls, tokens }, the meter's
 * blended rates and the 30-day scorecards.
 */
export function buildAllocation({ rows = [], rates = new Map(), cards = [], days = 7, state = { rooms: {} }, changes = [], grounding = {} } = {}) {
  const agents = new Map();
  const byDayRoom = new Map();
  let total = 0;
  for (const r of rows) {
    const rate = rates.get(`${r.day}|${r.model}`) ?? floorRate(r.model);
    const neurons = rate == null ? null : (Number(r.tokens) || 0) * rate;
    const a = agents.get(r.agent) || { agent: r.agent, rooms: new Set(), models: new Set(), calls: 0, tokens: 0, neurons: 0, unpriced_tokens: 0, by_day: new Map() };
    a.rooms.add(r.room); a.models.add(r.model);
    a.calls += Number(r.calls) || 0;
    a.tokens += Number(r.tokens) || 0;
    if (neurons == null) a.unpriced_tokens += Number(r.tokens) || 0;
    else {
      a.neurons += neurons;
      a.by_day.set(r.day, (a.by_day.get(r.day) || 0) + neurons);
      total += neurons;
      const k = `${r.day}|${r.room}`;
      const d = byDayRoom.get(k) || { day: r.day, room: r.room, neurons: 0, by_agent: {} };
      d.neurons += neurons;
      d.by_agent[r.agent] = (d.by_agent[r.agent] || 0) + neurons;
      byDayRoom.set(k, d);
    }
    agents.set(r.agent, a);
  }
  // 30-day record per agent, over the timeframes of the rooms it sits in.
  const record = new Map();
  for (const c of cards || []) {
    if (!String(c.subject).startsWith("agent:")) continue;
    const id = String(c.subject).slice(6);
    const r = record.get(id) || { hit: 0, miss: 0, directional: 0, by_timeframe: {} };
    const hit = Number(c.directional?.hit) || 0, miss = Number(c.directional?.miss) || 0;
    r.hit += hit; r.miss += miss; r.directional += Number(c.directional?.n) || 0;
    r.by_timeframe[c.timeframe] = { hit, miss, hit_rate: c.directional?.hit_rate ?? null };
    record.set(id, r);
  }
  const dayList = [...new Set(rows.map((r) => r.day))].sort();
  const span = Math.max(1, dayList.length || days);
  const list = [...agents.values()].map((a) => {
    const rec = record.get(a.agent);
    const decided = rec ? rec.hit + rec.miss : 0;
    const timeframes = [...a.rooms].map((room) => ROOM_TIMEFRAME[room]).filter(Boolean);
    // Shadow in a room where it is benched; "shadow" overall only when benched in every room it sat in.
    const benchedIn = [...a.rooms].filter((room) => state.rooms?.[room]?.[a.agent]?.status === "shadow");
    return {
      agent: a.agent,
      status: benchedIn.length && benchedIn.length === a.rooms.size ? "shadow" : "live",
      shadow_rooms: benchedIn.sort(),
      rooms: [...a.rooms].sort(),
      models: [...a.models].sort(),
      calls: a.calls,
      tokens: a.tokens,
      neurons: Math.round(a.neurons),
      neurons_per_day: Math.round(a.neurons / span),
      share: total > 0 ? round(a.neurons / total) : null,
      unpriced_tokens: a.unpriced_tokens,
      hit_rate: decided > 0 ? round(rec.hit / decided) : null,
      hits: rec?.hit ?? 0,
      misses: rec?.miss ?? 0,
      scored: decided,
      by_timeframe: rec ? Object.fromEntries(Object.entries(rec.by_timeframe).filter(([tf]) => timeframes.includes(tf))) : {},
      // Neurons per correct directional call: the window's daily neurons over 30 days against the 30-day hits.
      neurons_per_hit: rec?.hit ? Math.round(a.neurons / span * 30 / rec.hit) : null,
      // The share of the metrics an agent cites that are on its own data's menu (the metric shadow arm, 15m room).
      grounding_rate: grounding[a.agent] ?? null,
      trend: dayList.map((d) => Math.round(a.by_day.get(d) || 0))
    };
  }).sort((x, y) => y.neurons - x.neurons);
  return {
    version: NEURON_ALLOCATION_VERSION,
    days: dayList,
    total_neurons: Math.round(total),
    neurons_per_day: Math.round(total / span),
    agents: list,
    rooms_by_day: [...byDayRoom.values()].map((d) => ({ day: d.day, room: d.room, neurons: Math.round(d.neurons), by_agent: Object.fromEntries(Object.entries(d.by_agent).map(([k, v]) => [k, Math.round(v)])) })).sort((a, b) => a.day.localeCompare(b.day) || a.room.localeCompare(b.room)),
    rules: ALLOCATION_RULES,
    changes
  };
}

/**
 * Pure (A4): the room memo by prompt (live) beside the memo by evidence (shadow), per opening schema, from the
 * meter rows of the window. `extra_neurons_per_day`: what the evidence key would save on top of the prompt key,
 * counting only its hits where the model then gave the same stance and bias.
 */
export function memoComparison(usageRows = [], { days = 7 } = {}) {
  const sum = (rows, k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const rate = (x, n) => (n > 0 ? round(x / n) : null);
  return ["war_room_opening", "tf_room_opening"].map((schema) => {
    const live = usageRows.filter((r) => r.source === schema);
    const ev = usageRows.filter((r) => r.source === `evidence_memo:${schema}`);
    const calls = sum(live, "calls"), reused = sum(live, "reused"), neurons = sum(live, "neurons");
    const hits = sum(ev, "memo_hits"), same = sum(ev, "memo_same");
    return {
      schema, calls, prompt_reused: reused, prompt_reuse_rate: rate(reused, calls + reused),
      evidence_hits: hits, evidence_hit_rate: rate(hits, calls), evidence_same_rate: rate(same, hits),
      extra_neurons_per_day: calls > 0 ? Math.round((same * neurons) / calls / Math.max(1, days)) : null
    };
  });
}

/** Pure (A5): the share of input tokens Workers AI served from its prefix cache over the window, from the meter's day totals. */
export function promptCache(totals = []) {
  const prompt = totals.reduce((n, d) => n + (Number(d.prompt_tokens) || 0), 0);
  const cached = totals.reduce((n, d) => n + (Number(d.cached_tokens) || 0), 0);
  return { prompt_tokens: prompt, cached_tokens: cached, share: prompt > 0 ? round(cached / prompt) : null };
}

/** The run documents' room of each document room (the same names as ROOM_SQL). */
const DOC_ROOM_NAME_SQL = "CASE r.room WHEN 'warroom' THEN 'M15' WHEN 'tf:H1' THEN 'H1' WHEN 'tf:H4' THEN 'H4' WHEN 'tf:D1' THEN 'D1' ELSE 'Other' END";
const IN_CHUNK = 90;

/**
 * ADR-0015 P2b reader 4 (owner 2026-11-16): the model calls and tokens per day, room, agent and model, in the shape of
 * the query on agent_thread_messages. The War Room and the 1H/4H/D1 rooms come from their run documents (steps
 * expanded and grouped in D1); the other rooms (Macro, News Daily, news threads) have no documents, so their messages
 * are read, only for the threads active in the window (agent_threads, then the thread_id index) instead of a scan of
 * the whole table. Null when the documents are not ready (the caller keeps the old query). A run still in progress is
 * counted once it concludes.
 */
export async function callRowsFromDocs(env, since, { now }) {
  if (!roomRunsReaderEnabled(env, "allocation") || !(await docsReady(env, { now }))) return null;
  const db = env.DB;
  try {
    const docs = (await db.prepare(`SELECT substr(json_extract(s.value, '$.ts'), 1, 10) AS day, ${DOC_ROOM_NAME_SQL} AS room, json_extract(s.value, '$.agent') AS agent, json_extract(s.value, '$.model') AS model, COUNT(*) AS calls, SUM(json_extract(s.value, '$.usage_tokens')) AS tokens FROM room_runs r, json_each(r.body_json, '$.steps') s WHERE r.room IN ${DOC_ROOMS_SQL} AND r.bar_close >= ? AND json_extract(s.value, '$.ts') >= ? AND json_extract(s.value, '$.usage_tokens') > 0 GROUP BY 1, 2, 3, 4`).bind(new Date(Date.parse(since) - 86_400_000).toISOString(), since).all()).results || [];
    const threadSince = new Date(Date.parse(since) - 86_400_000).toISOString();
    const threads = ((await db.prepare("SELECT id FROM agent_threads WHERE updated_at >= ? AND NOT ((id >= 'warroom:' AND id < 'warroom;') OR id IN ('tf:H1', 'tf:H4', 'tf:D1'))").bind(threadSince).all()).results || []).map((t) => t.id);
    const others = [];
    for (let i = 0; i < threads.length; i += IN_CHUNK) {
      const chunk = threads.slice(i, i + IN_CHUNK);
      const part = (await db.prepare(`SELECT substr(ts, 1, 10) AS day, ${ROOM_SQL} AS room, agent, model, COUNT(*) AS calls, SUM(usage_tokens) AS tokens FROM agent_thread_messages WHERE thread_id IN (${chunk.map(() => "?").join(", ")}) AND ts >= ? AND usage_tokens > 0 GROUP BY day, room, agent, model`).bind(...chunk, since).all()).results || [];
      others.push(...part);
    }
    // Re-group: rooms are distinct between the two sources, but a chunk boundary can split one (day, room, agent, model).
    const merged = new Map();
    for (const r of [...docs, ...others]) {
      const k = [r.day, r.room, r.agent, r.model].join("\u0000");
      const m = merged.get(k) || { day: r.day, room: r.room, agent: r.agent, model: r.model, calls: 0, tokens: 0 };
      m.calls += Number(r.calls) || 0;
      m.tokens += Number(r.tokens) || 0;
      merged.set(k, m);
    }
    return [...merged.values()];
  } catch {
    return null;
  }
}

/** GET /api/neuron-allocation: the last `days` days (1 to 14). */
export async function readNeuronAllocation(env, { days = 7, now = Date.now() } = {}) {
  const db = env.DB;
  await ensureThreadSchema(db);
  const n = Math.min(14, Math.max(1, Math.round(Number(days) || 7)));
  const since = new Date(now - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = (await callRowsFromDocs(env, since, { now })) ?? (((await db.prepare(`SELECT substr(ts, 1, 10) AS day, ${ROOM_SQL} AS room, agent, model, COUNT(*) AS calls, SUM(usage_tokens) AS tokens FROM agent_thread_messages WHERE ts >= ? AND usage_tokens > 0 GROUP BY day, room, agent, model`).bind(since).all()).results) || []);
  const usage = await readAiUsage(db, { days: n, now });
  const cards = await scorecards(db, { days: 30, now, snapshot: true });
  const [state, changes, metric, arena] = await Promise.all([readAllocationState(env), readAllocationEvents(db, { limit: 50 }), readMetricShadow(env, { days: n, now }).catch(() => null), readModelArena(env, { days: 30, now }).catch(() => null)]);
  const grounding = Object.fromEntries((metric?.agents ?? []).filter((a) => a.grounding_rate != null).map((a) => [a.agent, a.grounding_rate]));
  return { status: "ok", generated_at: new Date(now).toISOString(), window_days: n, record_days: 30, ...buildAllocation({ rows, rates: blendedRates(usage.rows), cards, days: n, state, changes, grounding }), metric_shadow: metric, memo: memoComparison(usage.rows, { days: n }), prompt_cache: promptCache(usage.totals), model_arena: arena };
}
