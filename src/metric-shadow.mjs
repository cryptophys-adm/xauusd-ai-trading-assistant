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
// A2 (owner 2026-11-14: "lanjut kerjakan A2"): the rebuttals too. On every fourth 15m bar (the hour's bars), each
// agent that rebutted live answers the room's metric openings in metric form: which metric of which opening (#n)
// it disputes, with which metric of its own, and how (contradicts, outweighs, confirms). Stored in
// metric_shadow_rebuttals beside its live rebuttal stance and scored the same way.
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
  "CREATE INDEX IF NOT EXISTS idx_metric_shadow_created ON metric_shadow_outputs(created_at)",
  `CREATE TABLE IF NOT EXISTS metric_shadow_rebuttals (
    room TEXT NOT NULL, bar_time TEXT NOT NULL, agent TEXT NOT NULL,
    stance TEXT, confidence REAL, control_stance TEXT, rebuts_json TEXT,
    cited INTEGER, grounded INTEGER, status TEXT NOT NULL, model TEXT, usage_tokens INTEGER, latency_ms INTEGER,
    created_at TEXT NOT NULL, result TEXT, control_result TEXT, scoring_version TEXT, scored_at TEXT,
    PRIMARY KEY (room, bar_time, agent)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_metric_rebuttals_created ON metric_shadow_rebuttals(created_at)"
];
export const RELATIONS = Object.freeze(["contradicts", "outweighs", "confirms"]);
export const DEFAULT_REBUTTAL_EVERY = 4;
export const DEFAULT_REBUTTAL_MAX_CALLS_PER_HOUR = 12;
const MAX_REBUTS = 4;
export const METRIC_REBUTTAL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: {
    stance: { type: "string", enum: [...ROOM_STANCES] },
    confidence: { type: "number" },
    rebuts: { type: "array", items: { type: "object", additionalProperties: false, properties: { ref: { type: "string" }, their_metric: { type: "string" }, my_metric: { type: "string" }, relation: { type: "string", enum: [...RELATIONS] } }, required: ["ref", "their_metric", "my_metric", "relation"] } }
  },
  required: ["stance", "confidence", "rebuts"]
});
export function rebuttalEvery(env) {
  const n = Math.round(Number(env?.METRIC_REBUTTAL_EVERY ?? DEFAULT_REBUTTAL_EVERY));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 96) : DEFAULT_REBUTTAL_EVERY;
}
export function rebuttalCallsPerHour(env) {
  const n = Number(env?.METRIC_REBUTTAL_MAX_CALLS_PER_HOUR ?? DEFAULT_REBUTTAL_MAX_CALLS_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 48) : DEFAULT_REBUTTAL_MAX_CALLS_PER_HOUR;
}
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

/** Pure: whether a 15m bar is a rebuttal bar (every `every`-th bar, counted from the epoch: the hour's first bar at 4). */
export function isRebuttalBar(barTime, every = DEFAULT_REBUTTAL_EVERY) {
  const index = Math.floor(Date.parse(barTime) / 900_000);
  return Number.isFinite(index) && index % every === 0;
}

/**
 * Pure: the anonymous metric bus of a bar: every valid metric opening but the rebutter's own, as "#n" (in agent
 * order, so the same bar gives the same numbers), with its metric table. `refs` maps "#n" back to the agent.
 */
export function metricBus(openings, self) {
  const others = (openings || []).filter((o) => o.agent !== self && o.status === "ok").sort((a, b) => a.agent.localeCompare(b.agent));
  const bus = [], refs = new Map();
  others.forEach((o, i) => {
    const ref = `#${i + 1}`;
    refs.set(ref, o.agent);
    bus.push({ ref, stance: o.stance, confidence: o.confidence, metrics: (o.metrics || []).map((m) => ({ id: m.id, value: m.value ?? null, reading: m.reading, implication: m.implication, weight: m.weight })) });
  });
  return { bus, refs };
}

/** Pure: a metric rebuttal checked: valid in form; each rebut grounded when its #n is on the bus, their metric is in that opening and mine is on my menu. */
export function checkMetricRebuttal(o, { bus = [], menu = [] } = {}) {
  const own = new Set((menu || []).map((m) => m.id));
  const tables = new Map((bus || []).map((b) => [b.ref, new Set((b.metrics || []).map((m) => m.id))]));
  const rebuts = Array.isArray(o?.rebuts) ? o.rebuts.slice(0, MAX_REBUTS) : null;
  const valid = ROOM_STANCES.includes(o?.stance) && typeof o?.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 && Array.isArray(rebuts)
    && rebuts.every((r) => r && typeof r.ref === "string" && typeof r.their_metric === "string" && typeof r.my_metric === "string" && RELATIONS.includes(r.relation));
  const items = (rebuts || []).filter((r) => r && typeof r === "object").map((r) => ({ ref: String(r.ref ?? "").trim(), their_metric: String(r.their_metric ?? ""), my_metric: String(r.my_metric ?? ""), relation: r.relation }));
  const grounded = items.filter((r) => tables.get(r.ref)?.has(r.their_metric) && own.has(r.my_metric)).length;
  return { valid, cited: items.length, grounded, rebuts: items };
}

/** The shadow rebuttal prompt: the agent's role line, the rules and the form first; its menu, its metric opening and the bus last. */
export function metricRebuttalMessages(roleLine, { menu, opening, bus }) {
  return chatMessages([
    [
      roleLine,
      "This is the Consensus Discussion of this bar, in metric form. The METRIC BUS holds the other agents' metric openings, anonymously (#n).",
      "Rebut with metrics only, never sentences: for each opening you dispute, name its reference (#n), the metric of that opening you dispute (its id, as on the bus), the metric of your own that answers it (an id from YOUR METRIC MENU), and the relation: contradicts (your metric points the other way), outweighs (yours matters more here) or confirms (theirs convinced you).",
      `Give 0 to ${MAX_REBUTS} rebuts, then your stance after the discussion (you may change it if the bus convinced you) and your confidence (0 to 1). Never give a price level.`,
      'Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"rebuts":[{"ref":"#n","their_metric":"<id on the bus>","my_metric":"<id on your menu>","relation":"contradicts|outweighs|confirms"}]}'
    ].join("\n"),
    `YOUR METRIC MENU:\n${JSON.stringify(menu)}`,
    `YOUR METRIC OPENING:\n${JSON.stringify(opening)}`,
    `METRIC BUS:\n${JSON.stringify(bus)}`
  ]);
}

/**
 * The room's shadow rebuttals, after its metric openings (runMetricShadow) on the same bar. `rebutters` are
 * { agent, stance } of the live rebuttals; each needs its own valid metric opening of the bar. Only on a
 * rebuttal bar (METRIC_REBUTTAL_EVERY, default every fourth); idempotent; bounded per hour. Never throws.
 */
export async function runMetricRebuttals(env, { room = "M15", barTime, rebutters = [], dataFor, roleFor, clock = () => Date.now(), deadlineMs = 90_000 } = {}) {
  if (!metricShadowEnabled(env)) return { status: "disabled" };
  if (!env?.DB || !rebutters.length) return { status: "nothing_to_do" };
  if (!isRebuttalBar(barTime, rebuttalEvery(env))) return { status: "not_a_rebuttal_bar" };
  try {
    if (!(await shadowAllowed(env))) return { status: "shadow_off" };
    await ensureSchema(env.DB);
    const rows = (await env.DB.prepare("SELECT agent, stance, confidence, metrics_json, status FROM metric_shadow_outputs WHERE room = ? AND bar_time = ?").bind(room, barTime).all()).results || [];
    const openings = rows.map((r) => { let m = null; try { m = JSON.parse(r.metrics_json || "null"); } catch { m = null; } return { agent: r.agent, stance: r.stance, confidence: r.confidence, status: r.status, metrics: m?.metrics ?? [] }; });
    const used = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_shadow_rebuttals WHERE created_at >= ?").bind(new Date(clock() - 3_600_000).toISOString()).first())?.n ?? 0);
    let budget = rebuttalCallsPerHour(env) - used;
    const deadline = clock() + deadlineMs;
    const out = { status: "ok", called: 0, stored: 0, skipped: 0, no_opening: 0 };
    await Promise.all(rebutters.map(async ({ agent, stance: control }) => {
      const mine = openings.find((o) => o.agent === agent && o.status === "ok");
      if (!mine) { out.no_opening += 1; return; }
      if (await env.DB.prepare("SELECT 1 AS x FROM metric_shadow_rebuttals WHERE room = ? AND bar_time = ? AND agent = ?").bind(room, barTime, agent).first()) { out.skipped += 1; return; }
      if (budget <= 0) { out.status = "budget_exhausted"; return; }
      budget -= 1; out.called += 1;
      const menu = metricMenu(dataFor(agent));
      const { bus, refs } = metricBus(openings, agent);
      let row = { stance: null, confidence: null, rebuts: null, cited: 0, grounded: 0, status: "agent_failed", model: null, usage: null, latency: null };
      try {
        const opening = { stance: mine.stance, confidence: mine.confidence, metrics: mine.metrics };
        const call = await callBusModel(env, { messages: metricRebuttalMessages(roleFor(agent), { menu, opening, bus }), schemaName: "metric_rebuttal", schema: METRIC_REBUTTAL_SCHEMA, maxTokens: 400, effort: "low", deadline, clock, runState: { primaryError: null }, role: "agent", meterSource: "shadow:metric_rebuttal" });
        row = { ...row, model: call.model ?? null, usage: call.usage_tokens ?? null, latency: call.latency_ms ?? null, status: call.status === "answered" ? "invalid_output" : call.status };
        if (call.status === "answered" && !call.truncated) {
          const check = checkMetricRebuttal(call.obj, { bus, menu });
          // Stored with the rebutted agent beside each #n, so the comparison can say who was disputed.
          const rebuts = check.rebuts.map((r) => ({ ...r, agent: refs.get(r.ref) ?? null }));
          row = { ...row, stance: call.obj.stance ?? null, confidence: typeof call.obj.confidence === "number" ? call.obj.confidence : null, rebuts, cited: check.cited, grounded: check.grounded, status: check.valid ? "ok" : "invalid_output" };
        }
      } catch { /* stored as agent_failed */ }
      await env.DB.prepare("INSERT INTO metric_shadow_rebuttals (room, bar_time, agent, stance, confidence, control_stance, rebuts_json, cited, grounded, status, model, usage_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room, bar_time, agent) DO NOTHING")
        .bind(room, barTime, agent, row.stance, row.confidence, control ?? null, row.rebuts ? JSON.stringify(row.rebuts).slice(0, 4000) : null, row.cited, row.grounded, row.status, row.model, row.usage, row.latency, new Date(clock()).toISOString()).run();
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
  const tables = ["metric_shadow_outputs", "metric_shadow_rebuttals"];
  const pendingOf = {};
  for (const t of tables) pendingOf[t] = (await env.DB.prepare(`SELECT room, bar_time, agent, stance, control_stance FROM ${t} WHERE status = 'ok' AND scored_at IS NULL ORDER BY bar_time LIMIT 400`).all()).results || [];
  if (!tables.some((t) => pendingOf[t].length)) return { status: "ok", scored: 0 };
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|15m")) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time && Date.parse(c.close_time) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const final = (r) => (["pending", "no_data", "not_scored"].includes(r) ? null : r);
  const at = new Date(now).toISOString();
  let scored = 0, rebuttals = 0;
  for (const t of tables) {
    for (const r of pendingOf[t]) {
      const closeMs = Date.parse(r.bar_time);
      const mine = final(scoreStance({ stance: r.stance, bars, closeMs }).result);
      const ctrl = r.control_stance ? final(scoreStance({ stance: r.control_stance, bars, closeMs }).result) : null;
      if (!mine || (r.control_stance && !ctrl)) continue;
      await env.DB.prepare(`UPDATE ${t} SET result = ?, control_result = ?, scoring_version = ?, scored_at = ? WHERE room = ? AND bar_time = ? AND agent = ?`).bind(mine, ctrl, SCORING_VERSION, at, r.room, r.bar_time, r.agent).run();
      if (t === "metric_shadow_outputs") scored += 1; else rebuttals += 1;
    }
  }
  return { status: "ok", scored, rebuttals_scored: rebuttals };
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

/**
 * A3 (owner 2026-11-14: "lanjut"): one bar's shadow answers in metric form, per agent, for the War Room's metric
 * chips in Nexus. Valid answers only (an invalid one is counted, never shown). Null when the tables are not there
 * yet. Never throws. Two reads on the primary key's (room, bar_time) prefix.
 */
export async function readMetricShadowBar(db, { room = "M15", barTime } = {}) {
  if (!db?.prepare || !barTime) return null;
  const parse = (t) => { try { return JSON.parse(t || "null"); } catch { return null; } };
  try {
    const [o, r] = await Promise.all([
      db.prepare("SELECT agent, stance, confidence, metrics_json, cited, grounded, status FROM metric_shadow_outputs WHERE room = ? AND bar_time = ?").bind(room, barTime).all(),
      db.prepare("SELECT agent, stance, confidence, rebuts_json, cited, grounded, status FROM metric_shadow_rebuttals WHERE room = ? AND bar_time = ?").bind(room, barTime).all()
    ]);
    const openings = {}, rebuttals = {};
    let invalid = 0;
    for (const x of o.results || []) {
      if (x.status !== "ok") { invalid += 1; continue; }
      const body = parse(x.metrics_json) || {};
      openings[x.agent] = { stance: x.stance, confidence: x.confidence, cited: x.cited, grounded: x.grounded, metrics: (body.metrics || []).map((m) => ({ id: m.id, value: noLevels(m.value ?? null), reading: typeof m.reading === "string" ? noLevels(m.reading) : null, implication: m.implication, weight: m.weight })), invalidation: body.invalidation?.metric_id ?? null };
    }
    for (const x of r.results || []) {
      if (x.status !== "ok") { invalid += 1; continue; }
      rebuttals[x.agent] = { stance: x.stance, confidence: x.confidence, cited: x.cited, grounded: x.grounded, rebuts: (parse(x.rebuts_json) || []).map((b) => ({ agent: b.agent ?? null, their_metric: b.their_metric, my_metric: b.my_metric, relation: b.relation })) };
    }
    return { openings, rebuttals, invalid };
  } catch {
    return null;
  }
}

/** The comparison of the last `days` days (GET /api/metric-shadow, the Neuron allocation page's grounding). */
export async function readMetricShadow(env, { days = 7, now = Date.now(), room = "M15" } = {}) {
  await ensureSchema(env.DB);
  const since = new Date(now - days * 86_400_000).toISOString();
  const cols = "agent, stance, control_stance, cited, grounded, status, usage_tokens, latency_ms, result, control_result";
  const rows = (await env.DB.prepare(`SELECT ${cols} FROM metric_shadow_outputs WHERE room = ? AND bar_time >= ?`).bind(room, since).all()).results || [];
  const rebuttals = (await env.DB.prepare(`SELECT ${cols} FROM metric_shadow_rebuttals WHERE room = ? AND bar_time >= ?`).bind(room, since).all()).results || [];
  return {
    version: METRIC_SHADOW_VERSION, enabled: metricShadowEnabled(env), room, days, max_calls_per_hour: maxCallsPerHour(env),
    agents: compareMetricShadow(rows),
    // A2: the rebuttals in metric form against the agent's live rebuttal on the same bar.
    rebuttals: compareMetricShadow(rebuttals), rebuttal_every: rebuttalEvery(env), rebuttal_max_calls_per_hour: rebuttalCallsPerHour(env)
  };
}
