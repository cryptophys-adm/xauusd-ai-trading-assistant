// Room run documents, ADR-0015 phase 2a, in shadow (owner 2026-11-15: "setuju semuanya", item c;
// docs/RFC_ROOM_CELLS.md §4-§5). Once an hour the concluded runs of the 15m War Room and the 1H/4H/D1 rooms are
// derived from their stored messages into one D1 row each (room_runs: queryable columns plus a JSON body with
// every agent's final position and the conclusion). An hourly comparison checks that the statements outcome scoring
// builds from them equal the ones it reads from agent_thread_messages (room_runs_compare, GET /api/room-runs/status).
// P2b reader 1 (owner 2026-11-16): outcome scoring reads its room statements from these documents (docStatements,
// ROOM_RUNS_READ); the other readers still read the messages, and no room changes.
// The full transcript (R2, transcript_key) is added once the bucket is bound; until then transcript_key is null.
import { agentStatements } from "./outcome-scoring.mjs";
import { warRoomThreadIds } from "./thread-windows.mjs";

export const RUN_DOC_VERSION = "cryptophys.room-run.v1";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The rooms derived in this phase: the thread(s), its timeframe, and the bar length. */
export const RUN_ROOMS = Object.freeze({
  warroom: { timeframe: "15", ms: 900_000 },
  "tf:H1": { timeframe: "60", ms: HOUR_MS },
  "tf:H4": { timeframe: "240", ms: 4 * HOUR_MS },
  "tf:D1": { timeframe: "1D", ms: DAY_MS }
});
/** Runs derived per hourly pass, at most (a backlog drains over several hours). */
export const MAX_RUNS_PER_PASS = 200;
/** How far back a pass looks for concluded runs. */
export const DERIVE_WINDOW_MS = 2 * DAY_MS;

export function roomRunsEnabled(env) {
  return String(env?.ROOM_RUNS_SHADOW ?? "off").trim().toLowerCase() === "on";
}

/**
 * ADR-0015 P2b, reader 1 (owner 2026-11-16: "tidak perlu menunggu, langsung pindah ke room_runs"): outcome scoring
 * reads its room statements from the run documents. Needs the documents to be derived (ROOM_RUNS_SHADOW on);
 * ROOM_RUNS_READ "off" returns scoring to agent_thread_messages (the rollback flag).
 */
export function roomRunsReadEnabled(env) {
  return roomRunsEnabled(env) && String(env?.ROOM_RUNS_READ ?? "off").trim().toLowerCase() === "on";
}
/** The room whose run documents hold a scored timeframe's statements. */
export const ROOM_OF_TIMEFRAME = Object.freeze({ "15": "warroom", "60": "tf:H1", "240": "tf:H4", "1D": "tf:D1" });

export const ROOM_RUNS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS room_runs (
  room TEXT NOT NULL,
  run_id TEXT NOT NULL,
  timeframe TEXT,
  candle_key TEXT,
  bar_close TEXT,
  status TEXT NOT NULL,
  stance TEXT,
  bias TEXT,
  confidence REAL,
  agents_heard INTEGER NOT NULL DEFAULT 0,
  agents_failed INTEGER NOT NULL DEFAULT 0,
  shadow_seats INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  fallbacks INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER,
  opened_at TEXT,
  concluded_at TEXT,
  transcript_key TEXT,
  doc_version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  derived_at TEXT NOT NULL,
  PRIMARY KEY (room, run_id)
)`,
  "CREATE INDEX IF NOT EXISTS idx_room_runs_bar ON room_runs(room, bar_close)",
  "CREATE INDEX IF NOT EXISTS idx_room_runs_candle ON room_runs(candle_key)",
  `CREATE TABLE IF NOT EXISTS room_runs_compare (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  keys INTEGER NOT NULL,
  equal INTEGER NOT NULL,
  missing INTEGER NOT NULL,
  mismatched INTEGER NOT NULL,
  sample_json TEXT
)`,
  "CREATE INDEX IF NOT EXISTS idx_room_runs_compare_at ON room_runs_compare(timeframe, checked_at)"
];
let schemaReady = false;
export async function ensureRoomRunsSchema(db) {
  if (schemaReady) return;
  for (const sql of ROOM_RUNS_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetRoomRunsSchemaCacheForTests() { schemaReady = false; }

const parse = (t, f = null) => { try { return t ? JSON.parse(t) : f; } catch { return f; } };
const roomOf = (threadId) => (String(threadId).startsWith("warroom:") ? "warroom" : String(threadId));
const isSeat = (step) => step.startsWith("open:") || step.startsWith("debate:") || step.startsWith("shadow:");

/**
 * Pure: one run's document from its stored messages (rows of one thread and run_id). Each agent's final position
 * follows outcome scoring's rule: its debate answer, else its opening (or its shadow answer); the moderator's is
 * the conclusion. Returns null for a run without a conclusion row.
 */
export function buildRunDoc(rows, { threadId, runId }) {
  const room = roomOf(threadId);
  const spec = RUN_ROOMS[room];
  const conclusion = rows.find((r) => r.step === "conclusion");
  if (!spec || !conclusion) return null;
  const brief = rows.find((r) => r.step === "brief");
  const briefBody = parse(brief?.body_json, {}) || {};
  const barClose = conclusion.bar_time ?? brief?.bar_time ?? null;
  const candleKey = room === "warroom"
    ? (Number.isFinite(Date.parse(barClose)) ? `OANDA:XAUUSD:15:${Date.parse(barClose) - spec.ms}` : null)
    : (briefBody.candle_key ?? null);
  const agents = new Map();
  for (const r of rows.filter((x) => isSeat(x.step))) {
    const agent = String(r.agent);
    const prior = agents.get(agent);
    if (r.status !== "ok") { if (!prior) agents.set(agent, { agent, seat: r.step.startsWith("shadow:") ? "shadow" : "live", status: r.status, step: r.step }); continue; }
    if (prior?.status === "ok" && !r.step.startsWith("debate:")) continue;
    const body = parse(r.body_json, {}) || {};
    agents.set(agent, { agent, seat: r.step.startsWith("shadow:") ? "shadow" : "live", status: "ok", step: r.step, stance: r.stance ?? null, bias: body.bias ?? null, confidence: r.confidence ?? null, metrics: body.metrics ?? null, model: r.model ?? null, fallback_used: Number(r.fallback_used) === 1 });
  }
  const list = [...agents.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  const cbody = parse(conclusion.body_json, {}) || {};
  const calls = rows.filter((r) => r.model);
  const ts = rows.map((r) => r.ts).filter(Boolean).sort();
  return {
    room, run_id: runId, timeframe: spec.timeframe, candle_key: candleKey, bar_close: barClose,
    status: conclusion.status === "ok" ? "concluded" : "failed",
    stance: conclusion.status === "ok" ? conclusion.stance ?? null : null, bias: conclusion.status === "ok" ? cbody.bias ?? null : null,
    confidence: conclusion.status === "ok" ? conclusion.confidence ?? null : null,
    agents_heard: list.filter((a) => a.status === "ok" && a.seat === "live").length,
    agents_failed: list.filter((a) => a.status !== "ok").length,
    shadow_seats: list.filter((a) => a.seat === "shadow").length,
    model_calls: calls.length, fallbacks: calls.filter((r) => Number(r.fallback_used) === 1).length,
    tokens: calls.reduce((s, r) => s + (Number(r.usage_tokens) || 0), 0) || null,
    opened_at: ts[0] ?? null, concluded_at: conclusion.ts ?? null, transcript_key: null, doc_version: RUN_DOC_VERSION,
    body: {
      conclusion: conclusion.status === "ok" ? { stance: conclusion.stance ?? null, confidence: conclusion.confidence ?? null, summary: cbody.summary ?? null, reasons: cbody.reasons ?? [], dissent: cbody.dissent ?? [], metrics: cbody.metrics ?? null } : null,
      agents: list,
      brief: { candle_key: briefBody.candle_key ?? candleKey, roster: Array.isArray(briefBody.roster) ? briefBody.roster : null }
    }
  };
}

/**
 * Pure: the statements outcome scoring reads (agentStatements' shape), from run documents. Per key (the 15m bar
 * close, or the candle key), each agent's final position of the latest run that has it; the moderator's is the
 * conclusion.
 */
export function statementsFromDocs(docs) {
  const byKey = new Map();
  for (const d of [...docs].sort((a, b) => String(a.run_id).localeCompare(String(b.run_id)))) {
    if (d.status !== "concluded" && !(d.body?.agents || []).some((a) => a.status === "ok")) continue;
    const key = d.timeframe === "15" ? d.bar_close : d.candle_key;
    if (!key) continue;
    const list = byKey.get(key) || new Map();
    for (const a of d.body?.agents || []) {
      if (a.status !== "ok" || !a.stance) continue;
      list.set(a.agent, { subject: "agent:" + a.agent, source: a.seat === "shadow" ? "room_shadow" : "room", stance: a.stance, confidence: a.confidence ?? null });
    }
    if (d.body?.conclusion?.stance) list.set("moderator", { subject: "agent:moderator", source: "room", stance: d.body.conclusion.stance, confidence: d.body.conclusion.confidence ?? null });
    byKey.set(key, list);
  }
  return new Map([...byKey].map(([k, m]) => [k, [...m.values()]]));
}

/**
 * P2b reader: the statements of a timeframe's room from its run documents, in agentStatements' shape. First derives
 * the runs concluded since the last hourly pass, so scoring never waits for it. Bars that closed before the derive
 * window (the documents start there) come from `older` (the messages path), only when the window asks for them.
 * Returns null when the documents cannot be read (table absent): the caller keeps the messages path.
 */
export async function docStatements(env, timeframe, sinceIso, { now = Date.now(), older = null } = {}) {
  const room = ROOM_OF_TIMEFRAME[timeframe];
  const db = env?.DB;
  if (!room || !db) return null;
  try {
    await deriveRoomRuns(env, { now });
    const spec = RUN_ROOMS[room];
    const floor = new Date(Date.parse(sinceIso) - (room === "warroom" ? 0 : spec.ms + DAY_MS)).toISOString();
    const rows = (await db.prepare("SELECT run_id, timeframe, candle_key, bar_close, status, body_json FROM room_runs WHERE room = ? AND bar_close >= ?").bind(room, floor).all()).results || [];
    const map = statementsFromDocs(rows.map((r) => ({ ...r, body: parse(r.body_json, {}) })));
    const coverage = now - DERIVE_WINDOW_MS;
    if (typeof older === "function" && Date.parse(sinceIso) < coverage) {
      for (const [key, list] of await older()) {
        if (!map.has(key) && closeOfKey(key, room === "warroom" ? 0 : spec.ms) < coverage) map.set(key, list);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** The concluded runs of the window not yet derived, per thread, at most MAX_RUNS_PER_PASS. */
async function pendingRuns(db, { now }) {
  const since = new Date(now - DERIVE_WINDOW_MS).toISOString();
  const threads = [...(warRoomThreadIds(since, now) ?? []), "tf:H1", "tf:H4", "tf:D1"];
  const out = [];
  for (const threadId of threads) {
    if (out.length >= MAX_RUNS_PER_PASS) break;
    const room = roomOf(threadId);
    const rows = (await db.prepare("SELECT m.run_id FROM agent_thread_messages m LEFT JOIN room_runs r ON r.room = ? AND r.run_id = m.run_id WHERE m.thread_id = ? AND m.bar_time >= ? AND m.step = 'conclusion' AND r.run_id IS NULL ORDER BY m.run_id LIMIT ?")
      .bind(room, threadId, since, MAX_RUNS_PER_PASS - out.length).all()).results || [];
    for (const r of rows) out.push({ threadId, runId: r.run_id });
  }
  return out;
}

/** The hourly pass: derive the window's new run documents. Never throws; returns counts. */
export async function deriveRoomRuns(env, { now = Date.now() } = {}) {
  if (!roomRunsEnabled(env)) return { status: "disabled" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureRoomRunsSchema(db);
  let derived = 0, skipped = 0;
  for (const { threadId, runId } of await pendingRuns(db, { now })) {
    const rows = (await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? ORDER BY id").bind(threadId, runId).all()).results || [];
    const doc = buildRunDoc(rows, { threadId, runId });
    if (!doc) { skipped += 1; continue; }
    await db.prepare("INSERT INTO room_runs (room, run_id, timeframe, candle_key, bar_close, status, stance, bias, confidence, agents_heard, agents_failed, shadow_seats, model_calls, fallbacks, tokens, opened_at, concluded_at, transcript_key, doc_version, body_json, derived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room, run_id) DO NOTHING")
      .bind(doc.room, doc.run_id, doc.timeframe, doc.candle_key, doc.bar_close, doc.status, doc.stance, doc.bias, doc.confidence, doc.agents_heard, doc.agents_failed, doc.shadow_seats, doc.model_calls, doc.fallbacks, doc.tokens, doc.opened_at, doc.concluded_at, doc.transcript_key, doc.doc_version, JSON.stringify(doc.body), new Date(now).toISOString()).run();
    derived += 1;
  }
  return { status: "ok", derived, skipped };
}

const canon = (list) => JSON.stringify([...list].sort((a, b) => a.subject.localeCompare(b.subject)).map((s) => [s.subject, s.source, s.stance, s.confidence]));
const closeOfKey = (key, ms) => { const open = Number(String(key).split(":").pop()); return Number.isFinite(open) ? open + ms : Date.parse(key); };

/**
 * The shadow comparison (RFC_ROOM_CELLS §5, P2a): for the 15m and 1H rooms, the statements outcome scoring reads
 * from the messages against those built from the run documents, over the bars that closed between 42 h and 1 h ago
 * (both sides see whole bars there). Stored in room_runs_compare; returns the counts.
 */
export async function compareRoomRuns(env, { now = Date.now() } = {}) {
  if (!roomRunsEnabled(env)) return { status: "disabled" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureRoomRunsSchema(db);
  const since = new Date(now - DERIVE_WINDOW_MS).toISOString();
  const lo = now - 42 * HOUR_MS, hi = now - HOUR_MS;
  const out = {};
  for (const [room, tf] of [["warroom", "15"], ["tf:H1", "60"]]) {
    const ms = RUN_ROOMS[room].ms;
    const fromMessages = await agentStatements(env, tf, tf === "15" ? since : new Date(Date.parse(since) - ms).toISOString(), { now, source: "messages" });
    const rows = (await db.prepare("SELECT run_id, timeframe, candle_key, bar_close, status, body_json FROM room_runs WHERE room = ? AND bar_close >= ?").bind(room, since).all()).results || [];
    const fromDocs = statementsFromDocs(rows.map((r) => ({ ...r, body: parse(r.body_json, {}) })));
    const inWindow = (k) => { const c = closeOfKey(k, tf === "15" ? 0 : ms); return c >= lo && c <= hi; };
    const keys = [...new Set([...fromMessages.keys(), ...fromDocs.keys()])].filter(inWindow);
    let equal = 0, missing = 0, mismatched = 0;
    const sample = [];
    for (const k of keys) {
      const a = fromMessages.get(k), b = fromDocs.get(k);
      if (!b) { missing += 1; if (sample.length < 5) sample.push({ key: k, issue: "missing_in_docs" }); continue; }
      if (!a || canon(a) !== canon(b)) { mismatched += 1; if (sample.length < 5) sample.push({ key: k, issue: "mismatch", messages: a ? canon(a) : null, docs: canon(b) }); continue; }
      equal += 1;
    }
    await db.prepare("INSERT INTO room_runs_compare (checked_at, timeframe, keys, equal, missing, mismatched, sample_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(new Date(now).toISOString(), tf, keys.length, equal, missing, mismatched, sample.length ? JSON.stringify(sample) : null).run();
    out[tf] = { keys: keys.length, equal, missing, mismatched };
  }
  return { status: "ok", ...out };
}

/** GET /api/room-runs/status: the documents per room and the last comparisons. */
export async function roomRunsStatus(env, { limit = 24 } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureRoomRunsSchema(db);
  const rooms = (await db.prepare("SELECT room, COUNT(*) AS runs, MAX(bar_close) AS last_bar, SUM(status = 'concluded') AS concluded FROM room_runs GROUP BY room").all()).results || [];
  const compares = (await db.prepare("SELECT checked_at, timeframe, keys, equal, missing, mismatched, sample_json FROM room_runs_compare ORDER BY id DESC LIMIT ?").bind(Math.min(Math.max(Number(limit) || 24, 1), 200)).all()).results || [];
  return { status: "ok", enabled: roomRunsEnabled(env), doc_version: RUN_DOC_VERSION, rooms, compares: compares.map((c) => ({ ...c, sample: parse(c.sample_json, null), sample_json: undefined })) };
}
