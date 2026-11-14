// Metric interpretations, not prose: the shadow arm (owner 2026-11-14 in the platform session: "perbaikan Ai
// seharusnya tidak berprosa tapi justru membawa interpretasi metrics yang dia propose bukan narasi", and "Ya" here
// to doing it in shadow first). On each 15m War Room bar, every agent that opened live answers once more, from the
// same data, as a table of metric readings instead of a claim:
//   { stance, confidence, metrics: [{ id, value, reading, implication, weight }], invalidation: { metric_id, level } }
// Each agent gets a menu of the metrics its own data holds (its HUD statements L1..Ln, the fields of its data,
// and plain summaries of its candles), and every cited id must be on that menu: the share that is, is the
// agent's grounding rate. The answer is stored in D1 metric_shadow_outputs beside the agent's live stance on
// the same bar and scored on the same 15m outcome; nothing reads it but the comparison and Nexus. Promotion of
// the format, room by room, needs the hit rate and the validity to be no worse (a later step, the owner's).
// `METRIC_SHADOW` "off" or the shadow kill switch (src/shadow-switch.mjs) stops it; at most METRIC_SHADOW_MAX_CALLS_PER_HOUR calls an hour (default 48).
import { callBusModel } from "./multi-agent-bus.mjs";
import { ROOM_STANCES } from "./agent-threads.mjs";
import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";
import { chatMessages } from "./model-text.mjs";
import { shadowAllowed } from "./shadow-switch.mjs";

export const METRIC_SHADOW_VERSION = "cryptophys.metric-shadow.v1";
export const IMPLICATIONS = Object.freeze(["bullish", "bearish", "neutral"]);
export const DEFAULT_MAX_CALLS_PER_HOUR = 48;
const MAX_MENU = 40;
const MAX_METRICS = 6;

export const METRIC_OPENING_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: {
    stance: { type: "string", enum: [...ROOM_STANCES] },
    confidence: { type: "number" },
    metrics: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, value: { type: ["number", "string", "boolean", "null"] }, reading: { type: "string" }, implication: { type: "string", enum: [...IMPLICATIONS] }, weight: { type: "number" } }, required: ["id", "reading", "implication", "weight"] } },
    invalidation: { type: ["object", "null"], additionalProperties: false, properties: { metric_id: { type: "string" }, level: { type: ["number", "string", "null"] } } }
  },
  required: ["stance", "confidence", "metrics"]
});

export function metricShadowEnabled(env) { return String(env?.METRIC_SHADOW ?? "").trim().toLowerCase() !== "off"; }
export function maxCallsPerHour(env) {
  const n = Number(env?.METRIC_SHADOW_MAX_CALLS_PER_HOUR ?? DEFAULT_MAX_CALLS_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 120) : DEFAULT_MAX_CALLS_PER_HOUR;
}

export const METRIC_SHADOW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS metric_shadow_outputs (
    room TEXT NOT NULL, bar_time TEXT NOT NULL, agent TEXT NOT NULL,
    stance TEXT, confidence REAL, control_stance TEXT, metrics_json TEXT,
    cited INTEGER, grounded INTEGER, status TEXT NOT NULL, model TEXT, usage_tokens INTEGER, latency_ms INTEGER,
    created_at TEXT NOT NULL, result TEXT, control_result TEXT, scoring_version TEXT, scored_at TEXT,
    PRIMARY KEY (room, bar_time, agent)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_metric_shadow_created ON metric_shadow_outputs(created_at)"
];
let schemaReady = false;
export function resetMetricShadowSchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of METRIC_SHADOW_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const isCandle = (c) => c && typeof c === "object" && ["o", "h", "l", "c"].every((k) => typeof c[k] === "number");

/** Pure: plain summaries of a candle series, as distances and ratios only: never a price level (rooms state none). */
export function candleSummary(prefix, candles) {
  const c = (candles || []).filter(isCandle);
  if (!c.length) return [];
  const last = c.at(-1), prev = c.at(-2), back4 = c.at(-5);
  const ranges = c.map((x) => x.h - x.l);
  const avg20 = ranges.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, ranges.length);
  const last20 = c.slice(-20), last8 = c.slice(-8);
  return [
    [`${prefix}.change_1`, prev ? num(last.c - prev.c) : null],
    [`${prefix}.change_4`, back4 ? num(last.c - back4.c) : null],
    [`${prefix}.range_last`, num(last.h - last.l)],
    [`${prefix}.range_avg_20`, num(avg20)],
    [`${prefix}.range_ratio`, avg20 > 0 ? num((last.h - last.l) / avg20) : null],
    [`${prefix}.below_high_20`, num(Math.max(...last20.map((x) => x.h)) - last.c)],
    [`${prefix}.above_low_20`, num(last.c - Math.min(...last20.map((x) => x.l)))],
    [`${prefix}.up_bars_of_8`, last8.filter((x) => x.c > x.o).length],
    [`${prefix}.body_ratio_last`, last.h > last.l ? num(Math.abs(last.c - last.o) / (last.h - last.l)) : null]
  ].filter(([, v]) => v !== null).map(([id, value]) => ({ id, value }));
}

/** Price-like numbers (3 to 5 digits) in text become "[level]"; a number of 1,000 or more is not kept as a value. */
export function noLevels(v) {
  if (typeof v === "number") return Math.abs(v) >= 1000 ? null : v;
  if (typeof v === "string") return v.replace(/\$?\b(?:\d{1,2},\d{3}|\d{3,5})(?:\.\d+)?\b/g, "[level]");
  return v;
}

/**
 * Pure: the menu of metrics an agent's own data holds: text statements as L1..Ln, primitive fields by their path,
 * candle series by their summaries. At most 40 entries; the same data always gives the same menu.
 */
export function metricMenu(data) {
  const menu = [];
  const walk = (v, path) => {
    if (menu.length >= MAX_MENU) return;
    if (Array.isArray(v)) {
      if (v.length && v.every(isCandle)) { menu.push(...candleSummary(path || "bars", v)); return; }
      if (v.every((x) => typeof x === "string")) { v.forEach((text, i) => menu.push({ id: path === "reading" || !path ? `L${i + 1}` : `${path}.L${i + 1}`, value: text.slice(0, 160) })); return; }
      if (v.every((x) => typeof x === "number")) { menu.push({ id: `${path}.last`, value: num(v.at(-1)) }); return; }
      return;
    }
    if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); return; }
    if (["number", "boolean"].includes(typeof v) || (typeof v === "string" && v.length <= 80)) menu.push({ id: path, value: typeof v === "number" ? num(v) : v });
  };
  walk(data, "");
  return menu.slice(0, MAX_MENU).map((m) => ({ id: m.id, value: noLevels(m.value) }));
}

/** Pure: the answer checked against the agent's menu: valid, how many metrics it cited, how many are on the menu. */
export function checkMetricAnswer(o, menu) {
  const ids = new Set((menu || []).map((m) => m.id));
  const metrics = (Array.isArray(o?.metrics) ? o.metrics.slice(0, MAX_METRICS) : []).map((m) => (m && typeof m === "object" ? { ...m, value: noLevels(m.value), reading: typeof m.reading === "string" ? noLevels(m.reading) : m.reading } : m));
  const valid = ROOM_STANCES.includes(o?.stance) && typeof o?.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 && metrics.length > 0
    && metrics.every((m) => typeof m?.id === "string" && typeof m?.reading === "string" && m.reading.length <= 60 && IMPLICATIONS.includes(m?.implication) && typeof m?.weight === "number");
  const grounded = metrics.filter((m) => ids.has(m?.id)).length;
  return { valid, cited: metrics.length, grounded, metrics };
}

/** The shadow prompt: the agent's role line and data, its metric menu, and the answer form (no prose). */
export function metricMessages(roleLine, data, menu) {
  return chatMessages([
    [
      roleLine,
      "Answer with metric readings only, never sentences. Cite only metric ids from the METRIC MENU; a metric not on the menu is not in your data. Never give a price level.",
      "Each metric: its id, its value, a short reading label (for example above_upper_band, divergence_bear, z_gt_2, rising_3_bars; at most 60 characters), its implication (bullish, bearish or neutral) and its weight (0 to 1, the weights of your metrics summing to about 1).",
      `Give 1 to ${MAX_METRICS} metrics, your stance (${ROOM_STANCES.join(", ")}) and confidence (0 to 1), and optionally the metric whose change would invalidate your view.`,
      'Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"metrics":[{"id":"<menu id>","value":<value>,"reading":"<label>","implication":"bullish|bearish|neutral","weight":0..1}],"invalidation":{"metric_id":"<menu id>","level":<value>}}'
    ].join("\n"),
    // Static instructions first, the bar's evidence last (prefix caching, the proposal's point 5).
    `METRIC MENU:\n${JSON.stringify(menu)}`,
    `YOUR DATA:\n${JSON.stringify(data)}`
  ]);
}

/**
 * Runs the room's shadow answers. `agents` are { agent, stance } of the live openings that answered; `dataFor(agent)`
 * the agent's data; `roleFor(agent)` its role line. Idempotent per (room, bar, agent); bounded per hour. Never throws.
 */
export async function runMetricShadow(env, { room = "M15", barTime, agents = [], dataFor, roleFor, clock = () => Date.now(), deadlineMs = 90_000 } = {}) {
  if (!metricShadowEnabled(env) || !env?.DB || !agents.length) return { status: metricShadowEnabled(env) ? "nothing_to_do" : "disabled" };
  try {
    // The shadow kill switch (src/shadow-switch.mjs): off, no model is called.
    if (!(await shadowAllowed(env))) return { status: "shadow_off" };
    await ensureSchema(env.DB);
    const used = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_shadow_outputs WHERE created_at >= ?").bind(new Date(clock() - 3_600_000).toISOString()).first())?.n ?? 0);
    let budget = maxCallsPerHour(env) - used;
    const deadline = clock() + deadlineMs;
    const out = { status: "ok", called: 0, stored: 0, skipped: 0 };
    await Promise.all(agents.map(async ({ agent, stance: control }) => {
      if (await env.DB.prepare("SELECT 1 AS x FROM metric_shadow_outputs WHERE room = ? AND bar_time = ? AND agent = ?").bind(room, barTime, agent).first()) { out.skipped += 1; return; }
      if (budget <= 0) { out.status = "budget_exhausted"; return; }
      budget -= 1; out.called += 1;
      const data = dataFor(agent);
      const menu = metricMenu(data);
      let row = { stance: null, confidence: null, metrics: null, cited: 0, grounded: 0, status: "agent_failed", model: null, usage: null, latency: null };
      try {
        const call = await callBusModel(env, { messages: metricMessages(roleFor(agent), data, menu), schemaName: "metric_opening", schema: METRIC_OPENING_SCHEMA, maxTokens: 500, effort: "low", deadline, clock, runState: { primaryError: null }, role: "agent", meterSource: "shadow:metric_opening" });
        row = { ...row, model: call.model ?? null, usage: call.usage_tokens ?? null, latency: call.latency_ms ?? null, status: call.status === "answered" ? "invalid_output" : call.status };
        if (call.status === "answered" && !call.truncated) {
          const check = checkMetricAnswer(call.obj, menu);
          row = { ...row, stance: call.obj.stance ?? null, confidence: typeof call.obj.confidence === "number" ? call.obj.confidence : null, metrics: { metrics: check.metrics, invalidation: call.obj.invalidation ? { metric_id: call.obj.invalidation.metric_id ?? null, level: noLevels(call.obj.invalidation.level ?? null) } : null }, cited: check.cited, grounded: check.grounded, status: check.valid ? "ok" : "invalid_output" };
        }
      } catch { /* stored as agent_failed */ }
      await env.DB.prepare("INSERT INTO metric_shadow_outputs (room, bar_time, agent, stance, confidence, control_stance, metrics_json, cited, grounded, status, model, usage_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room, bar_time, agent) DO NOTHING")
        .bind(room, barTime, agent, row.stance, row.confidence, control ?? null, row.metrics ? JSON.stringify(row.metrics).slice(0, 4000) : null, row.cited, row.grounded, row.status, row.model, row.usage, row.latency, new Date(clock()).toISOString()).run();
      out.stored += 1;
    }));
    return out;
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Sweep step: scores the stored shadow stances and their live controls once the 15m horizon has closed. */
export async function scoreMetricShadow(env, { now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  const pending = (await env.DB.prepare("SELECT room, bar_time, agent, stance, control_stance FROM metric_shadow_outputs WHERE status = 'ok' AND scored_at IS NULL ORDER BY bar_time LIMIT 400").all()).results || [];
  if (!pending.length) return { status: "ok", scored: 0 };
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|15m")) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time && Date.parse(c.close_time) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const final = (r) => (["pending", "no_data", "not_scored"].includes(r) ? null : r);
  const at = new Date(now).toISOString();
  let scored = 0;
  for (const r of pending) {
    const closeMs = Date.parse(r.bar_time);
    const mine = final(scoreStance({ stance: r.stance, bars, closeMs }).result);
    const ctrl = r.control_stance ? final(scoreStance({ stance: r.control_stance, bars, closeMs }).result) : null;
    if (!mine || (r.control_stance && !ctrl)) continue;
    await env.DB.prepare("UPDATE metric_shadow_outputs SET result = ?, control_result = ?, scoring_version = ?, scored_at = ? WHERE room = ? AND bar_time = ? AND agent = ?").bind(mine, ctrl, SCORING_VERSION, at, r.room, r.bar_time, r.agent).run();
    scored += 1;
  }
  return { status: "ok", scored };
}

/** Pure: the comparison per agent (rows of metric_shadow_outputs). */
export function compareMetricShadow(rows = []) {
  const byAgent = new Map();
  for (const r of rows) {
    const a = byAgent.get(r.agent) || { agent: r.agent, calls: 0, valid: 0, cited: 0, grounded: 0, same_stance: 0, paired: 0, hit: 0, miss: 0, control_hit: 0, control_miss: 0, tokens: 0, token_calls: 0, latency: 0, latency_calls: 0 };
    a.calls += 1;
    if (r.status === "ok") {
      a.valid += 1; a.cited += Number(r.cited) || 0; a.grounded += Number(r.grounded) || 0;
      if (r.control_stance) { a.paired += 1; if (r.stance === r.control_stance) a.same_stance += 1; }
      if (r.result === "hit") a.hit += 1; else if (r.result === "miss") a.miss += 1;
      if (r.control_result === "hit") a.control_hit += 1; else if (r.control_result === "miss") a.control_miss += 1;
    }
    if (Number(r.usage_tokens) > 0) { a.tokens += Number(r.usage_tokens); a.token_calls += 1; }
    if (Number(r.latency_ms) > 0) { a.latency += Number(r.latency_ms); a.latency_calls += 1; }
    byAgent.set(r.agent, a);
  }
  const rate = (x, n) => (n > 0 ? Math.round((x / n) * 1000) / 1000 : null);
  return [...byAgent.values()].map((a) => ({
    agent: a.agent, calls: a.calls,
    validity: rate(a.valid, a.calls),
    grounding_rate: rate(a.grounded, a.cited),
    stance_agreement: rate(a.same_stance, a.paired),
    hit_rate: rate(a.hit, a.hit + a.miss), decided: a.hit + a.miss,
    control_hit_rate: rate(a.control_hit, a.control_hit + a.control_miss), control_decided: a.control_hit + a.control_miss,
    tokens_per_call: a.token_calls ? Math.round(a.tokens / a.token_calls) : null,
    latency_ms: a.latency_calls ? Math.round(a.latency / a.latency_calls) : null
  })).sort((x, y) => x.agent.localeCompare(y.agent));
}

/** The comparison of the last `days` days (GET /api/metric-shadow, the Neuron allocation page's grounding). */
export async function readMetricShadow(env, { days = 7, now = Date.now(), room = "M15" } = {}) {
  await ensureSchema(env.DB);
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = (await env.DB.prepare("SELECT agent, stance, control_stance, cited, grounded, status, usage_tokens, latency_ms, result, control_result FROM metric_shadow_outputs WHERE room = ? AND bar_time >= ?").bind(room, since).all()).results || [];
  return { version: METRIC_SHADOW_VERSION, enabled: metricShadowEnabled(env), room, days, max_calls_per_hour: maxCallsPerHour(env), agents: compareMetricShadow(rows) };
}
