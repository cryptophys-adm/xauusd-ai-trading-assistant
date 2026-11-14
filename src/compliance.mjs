// Agent compliance (RFC_AETHER_KNOWLEDGE_GUARDIAN phase A1, §5.5): deterministic checks of what each
// room agent said against its role and the owner's rules. Read-only over the stored room messages:
// a check never changes a message, a stance, a conclusion or a decision. Aether's guardian reads the
// rates (GET /api/compliance) and the cards (src/decision-cards.mjs).
//
// Checks (v1):
//   order_wording        order, size or lot wording (advisory only: no orders, no position size)
//   stance_bias_conflict BUY with a BEARISH bias or SELL with a BULLISH bias
//   calibration_talk     the text speaks of parity, calibration or verification (agents never do)
//   natural_language     field names, evidence paths or key=value in the text
//   data_scope           a HUD or indicator agent names another agent's indicator (manifest names)
// Not yet (later phases): the confidence cap of uncalibrated agents, own-data contradiction,
// moderator crowd mentions and the Reasoner's guard override rate.

import { naturalLanguageErrors, CALIBRATION_TALK } from "./natural-language.mjs";
import { MANIFESTS } from "./indicator-manifests.mjs";

export const COMPLIANCE_VERSION = "cryptophys.compliance.v1";
export const CHECKS = Object.freeze(["order_wording", "stance_bias_conflict", "calibration_talk", "natural_language", "data_scope"]);

const ORDER = /\b(?:buy|sell)\s+(?:limit|stop)\b|\b(?:place|placing|open|opening|enter|entering)\s+(?:an?\s+|the\s+)?(?:order|position)\b|\blot(?:s| size)?\b|\bposition siz(?:e|ing)\b|\b(?:stop[- ]loss|take[- ]profit)\s+(?:at|of|to)\b|\b(?:go|going)\s+(?:long|short)\s+at\b/i;
const CALIBRATION = CALIBRATION_TALK;

/** Distinctive indicator names of the HUD and indicator agents (generic names are left out). */
const GENERIC = new Set(["prophet", "order_blocks", "trade_management"]);
const SCOPE_NAMES = Object.freeze(MANIFESTS
  .filter((m) => (m.kind === "hud" || m.kind === "indicator") && !GENERIC.has(m.id))
  .map((m) => ({ id: m.id, name: m.name.replace(/^The /, "").replace(/ \(.*\)$/, "").replace(/ Sensors$/, "") })));
const SCOPED_KINDS = new Set(["hud", "indicator"]);
const kindOf = new Map(MANIFESTS.map((m) => [m.id, m.kind]));

/** The text of one stored message body (opening claim, debate argument, conclusion summary and reasons). */
export function messageText(body) {
  if (!body || typeof body !== "object") return "";
  return [body.claim, body.argument, body.summary, ...(Array.isArray(body.reasons) ? body.reasons : [])].filter((x) => typeof x === "string").join(" ");
}

/** Pure: the violations of one message ({ agent, stance, body }); each { check, detail }. */
export function checkMessage({ agent, stance, body }) {
  const text = messageText(body);
  const out = [];
  const order = text.match(ORDER);
  if (order) out.push({ check: "order_wording", detail: order[0].toLowerCase() });
  const s = String(stance ?? "").toUpperCase(), b = String(body?.bias ?? "").toUpperCase();
  if ((s === "BUY" && b === "BEARISH") || (s === "SELL" && b === "BULLISH")) out.push({ check: "stance_bias_conflict", detail: `${s} with a ${b.toLowerCase()} bias` });
  const cal = text.match(CALIBRATION);
  if (cal) out.push({ check: "calibration_talk", detail: cal[0].toLowerCase() });
  const nl = naturalLanguageErrors(text);
  if (text && nl.length) out.push({ check: "natural_language", detail: nl.join(", ") });
  if (SCOPED_KINDS.has(kindOf.get(agent))) {
    const lower = text.toLowerCase();
    const named = SCOPE_NAMES.filter((x) => x.id !== agent && lower.includes(x.name.toLowerCase())).map((x) => x.name);
    if (named.length) out.push({ check: "data_scope", detail: `named ${named.join(", ")}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// D1: one row per (message, check). The sweep checks each message once.

export const COMPLIANCE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS compliance_checks (
    message_id INTEGER NOT NULL,
    check_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    chart TEXT NOT NULL,
    bar_time TEXT,
    agent TEXT NOT NULL,
    step TEXT NOT NULL,
    detail TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (message_id, check_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_compliance_checks_bar ON compliance_checks(bar_time)",
  `CREATE TABLE IF NOT EXISTS compliance_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_message_id INTEGER NOT NULL
  )`
];
let schemaReady = false;
export function resetComplianceSchemaCacheForTests() { schemaReady = false; }
export async function ensureComplianceSchema(db) {
  if (schemaReady) return;
  for (const sql of COMPLIANCE_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/** The chart of a room thread: warroom:* is 15m; tf:H1, tf:H4, tf:D1. Other threads are not rooms. */
export function chartOfThread(threadId) {
  const t = String(threadId);
  if (t.startsWith("warroom:")) return "15";
  return { "tf:H1": "60", "tf:H4": "240", "tf:D1": "1D" }[t] ?? null;
}

/**
 * Sweep step: checks the room messages stored since the last checked message id (openings,
 * Consensus Discussion answers, conclusions), at most `limit` per run. Idempotent.
 */
export async function runComplianceChecks(env, { now = Date.now(), limit = 400 } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureComplianceSchema(db);
  const cursor = Number((await db.prepare("SELECT last_message_id AS id FROM compliance_cursor WHERE id = 1").first())?.id) || 0;
  let rows = [];
  try {
    rows = (await db.prepare("SELECT id, thread_id, step, agent, bar_time, stance, body_json FROM agent_thread_messages WHERE id > ? AND status = 'ok' AND ((thread_id >= 'warroom:' AND thread_id < 'warroom;') OR (thread_id >= 'tf:' AND thread_id < 'tf;')) ORDER BY id LIMIT ?").bind(cursor, limit).all()).results || [];
  } catch { return { status: "no_rooms" }; }
  let checked = 0, violations = 0, last = cursor;
  const at = new Date(now).toISOString();
  for (const r of rows) {
    last = Math.max(last, Number(r.id));
    const chart = chartOfThread(r.thread_id);
    if (!chart || !(r.step.startsWith("open:") || r.step.startsWith("debate:") || r.step === "conclusion")) continue;
    let body = null;
    try { body = JSON.parse(r.body_json || "null"); } catch { body = null; }
    checked += 1;
    for (const v of checkMessage({ agent: r.agent, stance: r.stance, body })) {
      const res = await db.prepare("INSERT OR IGNORE INTO compliance_checks (message_id, check_id, thread_id, chart, bar_time, agent, step, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(r.id, v.check, r.thread_id, chart, r.bar_time ?? null, r.agent, r.step, String(v.detail).slice(0, 200), at).run();
      violations += Number(res?.meta?.changes) || 0;
    }
  }
  if (last > cursor) await db.prepare("INSERT INTO compliance_cursor (id, last_message_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_message_id = excluded.last_message_id").bind(last).run();
  return { status: "ok", checked, violations, cursor: last };
}

/** GET /api/compliance: violations per 100 messages, per agent and chart, over `days`. */
export async function readCompliance(env, { days = 7, now = Date.now() } = {}) {
  const db = env.DB;
  await ensureComplianceSchema(db);
  const since = new Date(now - days * 86_400_000).toISOString();
  const msgs = (await db.prepare("SELECT thread_id, agent, COUNT(*) AS n FROM agent_thread_messages WHERE status = 'ok' AND bar_time >= ? AND ((thread_id >= 'warroom:' AND thread_id < 'warroom;') OR (thread_id >= 'tf:' AND thread_id < 'tf;')) AND (step LIKE 'open:%' OR step LIKE 'debate:%' OR step = 'conclusion') GROUP BY thread_id, agent").bind(since).all()).results || [];
  const hits = (await db.prepare("SELECT chart, agent, check_id, COUNT(*) AS n, MAX(detail) AS example FROM compliance_checks WHERE bar_time >= ? GROUP BY chart, agent, check_id").bind(since).all()).results || [];
  const key = (chart, agent) => `${chart}|${agent}`;
  const rows = new Map();
  for (const m of msgs) {
    const chart = chartOfThread(m.thread_id);
    if (!chart) continue;
    const k = key(chart, m.agent);
    const r = rows.get(k) || { chart, agent: m.agent, messages: 0, violations: 0, by_check: {} };
    r.messages += Number(m.n) || 0;
    rows.set(k, r);
  }
  for (const h of hits) {
    const k = key(h.chart, h.agent);
    const r = rows.get(k) || { chart: h.chart, agent: h.agent, messages: 0, violations: 0, by_check: {} };
    r.violations += Number(h.n) || 0;
    r.by_check[h.check_id] = { count: Number(h.n) || 0, example: h.example ?? null };
    rows.set(k, r);
  }
  const agents = [...rows.values()].map((r) => ({ ...r, rate_per_100: r.messages ? Math.round((r.violations / r.messages) * 1000) / 10 : null }))
    .sort((a, b) => (b.rate_per_100 ?? 0) - (a.rate_per_100 ?? 0));
  const total = agents.reduce((a, r) => ({ messages: a.messages + r.messages, violations: a.violations + r.violations }), { messages: 0, violations: 0 });
  return { version: COMPLIANCE_VERSION, window_days: days, checks: CHECKS, total: { ...total, rate_per_100: total.messages ? Math.round((total.violations / total.messages) * 1000) / 10 : null }, agents };
}
