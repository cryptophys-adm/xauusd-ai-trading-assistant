// Room memo (owner 2026-11-11: "kurangi neuron/hari tanpa mengurangi kapabilitas agent").
//
// A room step (an opening, a Consensus Discussion answer or a conclusion) whose whole request is the
// same as one answered before (same primary model, schema and messages, so the same data) has the
// same answer: with ROOM_MEMO_ENABLED = "true" the stored answer is used again, validated again
// against this room's rules, and no model call is made. Every agent still speaks at every bar.
//
// Without the flag the memo runs in shadow: it records how often the same request comes back
// (memo_hits) and how often the model then gives the same stance and bias (memo_same) in
// ai_usage_daily, so the saving and its safety are measured before anything is reused.
//
// Only answers of the primary model that passed validation without inferred metrics are stored.

export const ROOM_MEMO_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS room_memo (
  kind TEXT NOT NULL,
  step TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  message_id INTEGER,
  model TEXT,
  answer_json TEXT NOT NULL,
  stance TEXT,
  bias TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, step, input_hash)
)`,
  "CREATE INDEX IF NOT EXISTS idx_room_memo_created ON room_memo(created_at)"
];

/** A stored answer is used for this long; the same request after it calls the model again. */
export const ROOM_MEMO_TTL_MS = 24 * 60 * 60 * 1000;
/** Rooms whose steps are memoised: the 15m War Room, the 1H/4H/D1 rooms and the HUD threads. */
const MEMO_THREAD = /^(?:warroom:|tf:|hud)/;

export function roomMemoEnabled(env) {
  return String(env?.ROOM_MEMO_ENABLED ?? "false").trim().toLowerCase() === "true";
}

/** The step's thread family: the War Room's daily thread id without its date. */
export function memoKind(threadId) {
  return String(threadId ?? "").replace(/:\d{4}-\d{2}-\d{2}$/, "");
}

export function memoEligible(base) {
  return MEMO_THREAD.test(String(base?.thread_id ?? "")) && typeof base?.step === "string" && base.step !== "brief";
}

/** SHA-256 (first 32 hex characters) of the request: model, schema name and messages. */
export async function inputHash(parts) {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let schemaReady = false;
export async function ensureRoomMemoSchema(db) {
  if (schemaReady) return;
  for (const sql of ROOM_MEMO_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetRoomMemoSchemaCacheForTests() { schemaReady = false; }

/** The stored answer for this request, within the TTL, or null. Never throws. */
export async function memoLookup(db, { kind, step, hash, now = Date.now(), ttlMs = ROOM_MEMO_TTL_MS }) {
  try {
    await ensureRoomMemoSchema(db);
    const row = await db.prepare("SELECT * FROM room_memo WHERE kind = ? AND step = ? AND input_hash = ?").bind(kind, step, hash).first();
    if (!row || !(Date.parse(row.created_at) >= now - ttlMs)) return null;
    return row;
  } catch {
    return null;
  }
}

/** Stores (or refreshes) the answer of a request. Never throws. */
export async function memoStore(db, { kind, step, hash, messageId = null, model = null, answer, now = Date.now() }) {
  try {
    await ensureRoomMemoSchema(db);
    const at = new Date(now).toISOString();
    await db.prepare(
      "INSERT INTO room_memo (kind, step, input_hash, message_id, model, answer_json, stance, bias, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(kind, step, input_hash) DO UPDATE SET message_id = excluded.message_id, model = excluded.model, answer_json = excluded.answer_json, stance = excluded.stance, bias = excluded.bias, created_at = excluded.created_at"
    ).bind(kind, step, hash, messageId, model, JSON.stringify(answer), answer?.stance ?? null, answer?.bias ?? null, at).run();
    // Old rows are pruned now and then (one store in 64), through the created_at index.
    if (Number(messageId) % 64 === 0) await db.prepare("DELETE FROM room_memo WHERE created_at < ?").bind(new Date(now - 2 * ROOM_MEMO_TTL_MS).toISOString()).run();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the evidence key, in shadow (AI Neuron A4)
// Owner 2026-11-14 ("lanjut", A4): the memo above matches a request only when the whole prompt is the same, so a
// bar whose closes moved by a few cents misses although the agent's evidence reads the same. The evidence key is
// the agent's own metric menu (src/metric-shadow.mjs metricMenu: its HUD statements with price levels masked,
// its fields, its candles as distances and ratios) plus its learned notes, hashed with the model and schema.
// It runs in shadow: it never reuses an answer. On each fresh model call that the prompt key missed, it records
// whether the evidence key had an answer within the TTL (memo_hits) and whether the model then gave the same
// stance and bias (memo_same), in ai_usage_daily under the source "evidence_memo:<schema name>". A higher hit
// rate with the same answers is the case for keying the live memo on the evidence (a later step, the owner's).
export const EVIDENCE_MEMO_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS room_memo_evidence (
  kind TEXT NOT NULL,
  step TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  model TEXT,
  stance TEXT,
  bias TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, step, evidence_hash)
)`,
  "CREATE INDEX IF NOT EXISTS idx_room_memo_evidence_created ON room_memo_evidence(created_at)"
];
export const EVIDENCE_METER_PREFIX = "evidence_memo:";
let evidenceReady = false;
export function resetEvidenceMemoSchemaCacheForTests() { evidenceReady = false; }

export function evidenceMemoEnabled(env) {
  return String(env?.EVIDENCE_MEMO_SHADOW ?? "on").trim().toLowerCase() !== "off";
}

/**
 * Shadow step after a fresh model call: compares the answer with the evidence key's stored answer, then stores
 * this one. `promptHit`: the prompt key had an answer (those are counted by the memo itself). Never throws.
 */
export async function evidenceShadow(db, { kind, step, hash, schemaName, answer, model, promptHit = false, record, now = Date.now(), ttlMs = ROOM_MEMO_TTL_MS }) {
  if (!db?.prepare || !hash || !answer) return null;
  try {
    if (!evidenceReady) { for (const sql of EVIDENCE_MEMO_SCHEMA_SQL) await db.prepare(sql).run(); evidenceReady = true; }
    const row = await db.prepare("SELECT model, stance, bias, created_at FROM room_memo_evidence WHERE kind = ? AND step = ? AND evidence_hash = ?").bind(kind, step, hash).first();
    const fresh = row && Date.parse(row.created_at) >= now - ttlMs;
    let out = "miss";
    if (fresh && !promptHit) {
      const source = `${EVIDENCE_METER_PREFIX}${schemaName}`;
      await record?.({ source, model: row.model, outcome: "memo_hit", now });
      out = "hit";
      if (row.stance === (answer.stance ?? null) && (row.bias ?? null) === (answer.bias ?? null)) {
        await record?.({ source, model: row.model, outcome: "memo_same", now });
        out = "same";
      }
    } else if (fresh) out = "prompt_hit";
    const at = new Date(now).toISOString();
    await db.prepare("INSERT INTO room_memo_evidence (kind, step, evidence_hash, model, stance, bias, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, step, evidence_hash) DO UPDATE SET model = excluded.model, stance = excluded.stance, bias = excluded.bias, created_at = excluded.created_at")
      .bind(kind, step, hash, model ?? null, answer.stance ?? null, answer.bias ?? null, at).run();
    // Old rows go now and then, through the created_at index.
    if (hash.endsWith("00")) await db.prepare("DELETE FROM room_memo_evidence WHERE created_at < ?").bind(new Date(now - 2 * ROOM_MEMO_TTL_MS).toISOString()).run();
    return out;
  } catch {
    return null;
  }
}
