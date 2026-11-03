// Autonomous provenance registry for local-computation engines.
//
// Replaces the operator-approved hash allowlist. A local engine implementation
// (engine + source_hash + implementation_hash) becomes trusted only through
// measured parity: for each closed candle where TradingView's own outputs
// arrive by webhook, the local outputs and the raw candle inputs are compared
// field by field. The AI Worker holds the promotion/revocation privilege, but
// the decision is a deterministic rule, never a model judgement:
//   - N consecutive fully matching candles  -> approved
//   - any mismatch on an approved hash      -> revoked (fail closed)
//   - a revoked hash must re-earn N consecutive matches
// Mizan is a shared library with no webhook of its own: a Mizan hash is
// trusted only while approved Prophet AND GMI implementations declare it as
// their Mizan dependency.

export const PARITY_REGISTRY_VERSION = "cryptophys.engine-parity-registry.v1";

/** Webhook fields each local engine must reproduce (source -> fields). */
export const PARITY_FIELDS = Object.freeze({
  prophet: Object.freeze({
    prophet_r38: Object.freeze(["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype"]),
    // structure_state is a chart-relative bar_index and is not comparable across systems.
    prophet_r37_ssot: Object.freeze(["direction", "d_enc", "b_enc", "structure_subtype", "bull_event", "bear_event"])
  }),
  gmi: Object.freeze({
    gmi_v12_70: Object.freeze(["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"])
  })
});

/** Raw candle inputs carried by every webhook payload; the local engine must have used the same bar. */
export const INPUT_FIELDS = Object.freeze(["o", "h", "l", "c", "volume"]);

export const DEFAULT_POLICY = Object.freeze({ promoteAfter: 24, absTolerance: 1e-6, relTolerance: 1e-9 });

const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const HASH = /^[a-f0-9]{64}$/;

export function policyFromEnv(env = {}) {
  const int = Number.parseInt(String(env.PARITY_PROMOTE_AFTER ?? ""), 10);
  const abs = Number(env.PARITY_ABS_TOLERANCE);
  const rel = Number(env.PARITY_REL_TOLERANCE);
  return {
    promoteAfter: Number.isInteger(int) && int >= 1 ? int : DEFAULT_POLICY.promoteAfter,
    absTolerance: Number.isFinite(abs) && abs >= 0 ? abs : DEFAULT_POLICY.absTolerance,
    relTolerance: Number.isFinite(rel) && rel >= 0 ? rel : DEFAULT_POLICY.relTolerance
  };
}

export function normalizeHash(value) {
  const hash = typeof value === "string" ? value.trim().toLowerCase() : "";
  return HASH.test(hash) ? hash : null;
}

/** Extracts the registry identity of a local calculation record, or null. */
export function identityOf(record) {
  const engine = record?.engine;
  const sourceHash = normalizeHash(record?.provenance?.source_hash);
  const implementationHash = normalizeHash(record?.provenance?.implementation_hash);
  if (!["mizan", "prophet", "gmi"].includes(engine) || !sourceHash || !implementationHash) return null;
  const dep = record?.provenance?.dependencies?.mizan;
  return {
    engine, sourceHash, implementationHash,
    mizanSourceHash: engine === "mizan" ? null : normalizeHash(dep?.source_hash),
    mizanImplementationHash: engine === "mizan" ? null : normalizeHash(dep?.implementation_hash)
  };
}

function sameValue(a, b, policy) {
  if (typeof a === "number" && typeof b === "number") {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= policy.absTolerance + policy.relTolerance * Math.max(Math.abs(a), Math.abs(b));
  }
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return false;
}

/** Sources whose webhooks must all be present before an engine can be compared. */
export function requiredSourcesFor(engine) {
  return Object.keys(PARITY_FIELDS[engine] || {});
}

/**
 * Compares one local record against TradingView webhook payloads for the same
 * candle. Returns status "match", "mismatch", "incomplete" (local side did not
 * supply a required value), or "not_comparable" (engine has no webhook map or
 * webhooks are not all present yet).
 */
export function compareWithWebhooks(record, webhookPayloads, policy = DEFAULT_POLICY) {
  const engine = record?.engine;
  const fieldMap = PARITY_FIELDS[engine];
  if (!fieldMap) return { status: "not_comparable", reason: "engine_has_no_webhook_counterpart" };
  const sources = Object.keys(fieldMap);
  const absentSources = sources.filter((source) => !isRecord(webhookPayloads?.[source]));
  if (absentSources.length) return { status: "not_comparable", reason: "webhooks_not_all_present", absent_sources: absentSources };

  const comparable = isRecord(record?.values?.comparable) ? record.values.comparable : {};
  const candle = isRecord(record?.values?.candle) ? record.values.candle : {};
  const mismatches = [];
  const missing = [];
  let compared = 0;

  for (const source of sources) {
    const webhook = webhookPayloads[source];
    for (const field of INPUT_FIELDS) {
      if (!(field in candle)) { missing.push(`input:${field}`); continue; }
      if (!(field in webhook)) continue; // producer omitted it; nothing to verify against
      compared++;
      if (!sameValue(candle[field], webhook[field], policy)) mismatches.push({ source, field: `input:${field}`, local: candle[field], webhook: webhook[field] });
    }
    const local = isRecord(comparable[source]) ? comparable[source] : null;
    for (const field of fieldMap[source]) {
      if (!local || !(field in local)) { missing.push(`${source}:${field}`); continue; }
      if (!(field in webhook)) { missing.push(`webhook:${source}:${field}`); continue; }
      compared++;
      if (!sameValue(local[field], webhook[field], policy)) mismatches.push({ source, field, local: local[field], webhook: webhook[field] });
    }
  }
  const uniqueMissing = [...new Set(missing)];
  if (mismatches.length) return { status: "mismatch", compared, mismatches, missing: uniqueMissing };
  if (uniqueMissing.length) return { status: "incomplete", compared, mismatches: [], missing: uniqueMissing };
  return { status: "match", compared, mismatches: [], missing: [] };
}

// ---------------------------------------------------------------------------
// D1 persistence. All updates are single statements so concurrent webhook and
// local-calculation arrivals cannot lose increments; each (identity, candle) is
// counted at most once.

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS engine_parity_registry (
    engine TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    implementation_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'revoked')),
    consecutive_matches INTEGER NOT NULL DEFAULT 0,
    total_matches INTEGER NOT NULL DEFAULT 0,
    total_mismatches INTEGER NOT NULL DEFAULT 0,
    total_incomplete INTEGER NOT NULL DEFAULT 0,
    mizan_source_hash TEXT,
    mizan_implementation_hash TEXT,
    last_candle_key TEXT,
    last_result TEXT,
    last_detail TEXT,
    first_seen_at TEXT NOT NULL,
    approved_at TEXT,
    revoked_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (engine, source_hash, implementation_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS engine_parity_comparisons (
    engine TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    implementation_hash TEXT NOT NULL,
    candle_key TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT,
    compared_at TEXT NOT NULL,
    PRIMARY KEY (engine, source_hash, implementation_hash, candle_key)
  )`
];

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetSchemaCacheForTests() { schemaReady = false; }

export async function registerIdentity(db, id, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO engine_parity_registry (engine, source_hash, implementation_hash, mizan_source_hash, mizan_implementation_hash, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(engine, source_hash, implementation_hash) DO UPDATE SET
       mizan_source_hash = COALESCE(excluded.mizan_source_hash, engine_parity_registry.mizan_source_hash),
       mizan_implementation_hash = COALESCE(excluded.mizan_implementation_hash, engine_parity_registry.mizan_implementation_hash)`
  ).bind(id.engine, id.sourceHash, id.implementationHash, id.mizanSourceHash, id.mizanImplementationHash, now, now).run();
}

/**
 * Records one comparison and applies the promotion/revocation rule. Returns
 * { counted: false } when this identity already has a result for the candle.
 */
export async function recordComparison(db, id, candleKey, comparison, policy = DEFAULT_POLICY, now = new Date().toISOString()) {
  if (!["match", "mismatch", "incomplete"].includes(comparison.status)) return { counted: false, reason: comparison.status };
  const detail = JSON.stringify({ compared: comparison.compared, mismatches: comparison.mismatches.slice(0, 20), missing: comparison.missing.slice(0, 40) });
  const inserted = await db.prepare(
    `INSERT INTO engine_parity_comparisons (engine, source_hash, implementation_hash, candle_key, result, detail, compared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
  ).bind(id.engine, id.sourceHash, id.implementationHash, candleKey, comparison.status, detail, now).run();
  if (!inserted?.meta?.changes) return { counted: false, reason: "already_compared" };

  const key = [id.engine, id.sourceHash, id.implementationHash];
  if (comparison.status === "match") {
    await db.prepare(
      `UPDATE engine_parity_registry SET
         consecutive_matches = consecutive_matches + 1,
         total_matches = total_matches + 1,
         status = CASE WHEN status <> 'approved' AND consecutive_matches + 1 >= ? THEN 'approved' ELSE status END,
         approved_at = CASE WHEN status <> 'approved' AND consecutive_matches + 1 >= ? THEN ? ELSE approved_at END,
         last_candle_key = ?, last_result = 'match', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(policy.promoteAfter, policy.promoteAfter, now, candleKey, detail, now, ...key).run();
  } else if (comparison.status === "mismatch") {
    await db.prepare(
      `UPDATE engine_parity_registry SET
         consecutive_matches = 0,
         total_mismatches = total_mismatches + 1,
         status = CASE WHEN status = 'approved' THEN 'revoked' ELSE status END,
         revoked_at = CASE WHEN status = 'approved' THEN ? ELSE revoked_at END,
         last_candle_key = ?, last_result = 'mismatch', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(now, candleKey, detail, now, ...key).run();
  } else {
    // Incomplete local output neither advances nor resets the streak.
    await db.prepare(
      `UPDATE engine_parity_registry SET total_incomplete = total_incomplete + 1,
         last_candle_key = ?, last_result = 'incomplete', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(candleKey, detail, now, ...key).run();
  }
  return { counted: true, result: comparison.status };
}

/** True when the identity is currently trusted for the local_computation lane. */
export async function isTrusted(db, id) {
  if (id.engine === "mizan") {
    const row = await db.prepare(
      `SELECT
         SUM(CASE WHEN engine = 'prophet' THEN 1 ELSE 0 END) AS prophet,
         SUM(CASE WHEN engine = 'gmi' THEN 1 ELSE 0 END) AS gmi
       FROM engine_parity_registry
       WHERE status = 'approved' AND mizan_source_hash = ? AND mizan_implementation_hash = ?`
    ).bind(id.sourceHash, id.implementationHash).first();
    return Number(row?.prophet) > 0 && Number(row?.gmi) > 0;
  }
  const row = await db.prepare(
    "SELECT status FROM engine_parity_registry WHERE engine = ? AND source_hash = ? AND implementation_hash = ?"
  ).bind(id.engine, id.sourceHash, id.implementationHash).first();
  return row?.status === "approved";
}

export async function listRegistry(db, limit = 50) {
  const result = await db.prepare(
    `SELECT engine, source_hash, implementation_hash, status, consecutive_matches, total_matches, total_mismatches,
            total_incomplete, mizan_source_hash, mizan_implementation_hash, last_candle_key, last_result, last_detail,
            first_seen_at, approved_at, revoked_at, updated_at
     FROM engine_parity_registry ORDER BY updated_at DESC LIMIT ?`
  ).bind(Math.max(1, Math.min(200, limit))).all();
  return (result?.results || []).map((row) => ({ ...row, last_detail: (() => { try { return JSON.parse(row.last_detail); } catch { return null; } })() }));
}
