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
  }),
  // Separate HUD identities (RFC §3). Approved prophet/gmi identities above are untouched.
  prophet_hud: Object.freeze({
    prophet_r38_hud: Object.freeze(["cshi_score", "cycle_intensity", "d_enc", "structure_subtype", "t_enc"])
  }),
  gmi_hud: Object.freeze({
    // The Grid Bot Protocol fields (2026-11-07): CSHI viability, deploy status code (1 muddy waters,
    // 2 toxic chop, 3 optimal, 4 trending or dead), muddy waters and grid viable.
    gmi_v12_70_hud: Object.freeze(["verdict", "gate", "gmi_dir", "prophet_dir", "conflict", "cshi_viability", "deploy_status", "muddy_waters", "grid_viable"])
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

export const BASE_ENGINES = Object.freeze(["mizan", "prophet", "gmi", "prophet_hud", "gmi_hud"]);

// Registry engine ids are scoped by chart timeframe. H1 keeps the bare id, so the
// approved H1 prophet/gmi rows (and their streaks) are untouched; every other
// timeframe earns its own approval under a suffixed id (prophet_m5, gmi_m5, ...).
// The same source and implementation hash approved on H1 says nothing about 5m.
const TIMEFRAME_SCOPE = Object.freeze({
  "60": "", "60M": "", "1H": "", "H1": "",
  "5": "_m5", "5M": "_m5", "M5": "_m5",
  "15": "_m15", "15M": "_m15", "M15": "_m15",
  // H4 and D1 charts (owner decision 2026-11-05). Pine v6 timeframe.period is "240" and "1D".
  "240": "_h4", "4H": "_h4", "H4": "_h4",
  "1D": "_d1", "D": "_d1", "D1": "_d1"
});

/** Registry engine id for an engine on a chart timeframe, or null when the timeframe is not supported. */
export function scopedEngine(engine, timeframe) {
  if (!BASE_ENGINES.includes(engine)) return null;
  const raw = timeframe == null || String(timeframe).trim() === "" ? "60" : String(timeframe).trim().toUpperCase();
  const suffix = TIMEFRAME_SCOPE[raw];
  return suffix === undefined ? null : engine + suffix;
}

/** Extracts the registry identity of a local calculation record, or null. */
export function identityOf(record) {
  const base = record?.engine;
  const engine = scopedEngine(base, record?.timeframe);
  const sourceHash = normalizeHash(record?.provenance?.source_hash);
  const implementationHash = normalizeHash(record?.provenance?.implementation_hash);
  if (!engine || !sourceHash || !implementationHash) return null;
  const dep = record?.provenance?.dependencies?.mizan;
  return {
    engine, sourceHash, implementationHash,
    mizanSourceHash: base === "mizan" ? null : normalizeHash(dep?.source_hash),
    mizanImplementationHash: base === "mizan" ? null : normalizeHash(dep?.implementation_hash)
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
/**
 * The engine internals behind a mismatch, kept in the comparison detail (2026-11-09: the GMI
 * gmi_dir mismatches on 5m conflict bars, where Pine and the local engine reset the verdict to 0
 * after gmi_dir was taken, so only gmi_dir shows that the verdict branch BEFORE the reset
 * differed). Unverified internals, for diagnosis only; never compared. Never a price: the value
 * area enters only as the close's position against it, the zones only as their flags.
 * 2026-11-09 (5m bar 08:35 UTC): the local branch was jma_long (+3) where Pine's verdict before the
 * reset was -3, so the JMA inputs (pct_rank, the kinetics) and the zone flags are kept too.
 */
const DIAGNOSTIC_KEYS = ["branch", "htf_state", "mtf_state", "ltf_state", "ext_state", "fp_status", "is_chaos", "entropy", "intrabars", "pct_rank", "s_theta", "s_omega", "s_alpha", "global_h"];
const isFiniteNum = (x) => typeof x === "number" && Number.isFinite(x);
function valueAreaPosition(close, vah, val) {
  if (![close, vah, val].every(isFiniteNum)) return null;
  return close > vah ? "above_vah" : close < val ? "below_val" : "inside";
}
function localDiagnostics(record) {
  const d = isRecord(record?.values?.diagnostics) ? record.values.diagnostics : null;
  if (!d) return {};
  const out = Object.fromEntries(DIAGNOSTIC_KEYS.filter((k) => k in d).map((k) => [k, d[k]]));
  const position = valueAreaPosition(record?.values?.candle?.c, d.vah, d.val);
  if (position) out.value_area = position;
  if (isRecord(d.zones)) {
    const flags = Object.entries(d.zones).filter(([, v]) => typeof v === "boolean");
    if (flags.length) out.zones = Object.fromEntries(flags);
  }
  return Object.keys(out).length ? { local_diagnostics: out } : {};
}

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
  // Only the input bar differs (open, high, low, close or volume) while every indicator field
  // agrees: the engine computed correctly on a bar that TradingView later finalised differently
  // (production 2026-11-06). That says nothing against the implementation, so it is recorded
  // apart and does not revoke; repeated input mismatches still do (see recordComparison).
  if (mismatches.length && mismatches.every((m) => String(m.field).startsWith("input:"))) return { status: "input_mismatch", compared, mismatches, missing: uniqueMissing };
  if (mismatches.length) return { status: "mismatch", compared, mismatches, missing: uniqueMissing, ...localDiagnostics(record) };
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

/** Consecutive input mismatches (on different candles) after which the identity is revoked. */
export const INPUT_MISMATCH_REVOKE_AFTER = 3;

/**
 * Records one comparison and applies the promotion/revocation rule. Returns
 * { counted: false } when this identity already has a result for the candle.
 *
 * An input mismatch (only the bar differs) is recorded but neither counts nor revokes, and it
 * stays open: when the pull adapter republishes the candle on the final bar, the new
 * comparison replaces it and counts. INPUT_MISMATCH_REVOKE_AFTER input mismatches in a row
 * (on different candles) mean the data pipeline itself is wrong, so they revoke like a mismatch.
 */
export async function recordComparison(db, id, candleKey, comparison, policy = DEFAULT_POLICY, now = new Date().toISOString()) {
  if (!["match", "mismatch", "incomplete", "input_mismatch"].includes(comparison.status)) return { counted: false, reason: comparison.status };
  let status = comparison.status;
  let escalated = false;
  if (status === "input_mismatch") {
    const previous = (await db.prepare(
      "SELECT result FROM engine_parity_comparisons WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND candle_key <> ? ORDER BY compared_at DESC LIMIT ?"
    ).bind(id.engine, id.sourceHash, id.implementationHash, candleKey, INPUT_MISMATCH_REVOKE_AFTER - 1).all())?.results || [];
    if (previous.length === INPUT_MISMATCH_REVOKE_AFTER - 1 && previous.every((r) => r.result === "input_mismatch")) { status = "mismatch"; escalated = true; }
  }
  const detail = JSON.stringify({ compared: comparison.compared, mismatches: comparison.mismatches.slice(0, 20), missing: comparison.missing.slice(0, 40), ...(escalated ? { reason: "repeated_input_mismatch" } : {}), ...(comparison.local_diagnostics ? { local_diagnostics: comparison.local_diagnostics } : {}) });
  const inserted = await db.prepare(
    `INSERT INTO engine_parity_comparisons (engine, source_hash, implementation_hash, candle_key, result, detail, compared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(engine, source_hash, implementation_hash, candle_key) DO UPDATE SET
       result = excluded.result, detail = excluded.detail, compared_at = excluded.compared_at
     WHERE engine_parity_comparisons.result = 'input_mismatch'`
  ).bind(id.engine, id.sourceHash, id.implementationHash, candleKey, status, detail, now).run();
  if (!inserted?.meta?.changes) return { counted: false, reason: "already_compared" };

  const key = [id.engine, id.sourceHash, id.implementationHash];
  if (status === "input_mismatch") {
    await db.prepare(
      `UPDATE engine_parity_registry SET last_candle_key = ?, last_result = 'input_mismatch', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(candleKey, detail, now, ...key).run();
    return { counted: false, result: "input_mismatch" };
  }
  comparison = { ...comparison, status };

  if (comparison.status === "match") {
    await db.prepare(
      `UPDATE engine_parity_registry SET
         consecutive_matches = consecutive_matches + 1,
         total_matches = total_matches + 1,
         status = CASE WHEN status <> 'approved' AND consecutive_matches + 1 >= ? THEN 'approved' ELSE status END,
         approved_at = CASE WHEN status <> 'approved' AND consecutive_matches + 1 >= ? THEN ? ELSE approved_at END,
         revoked_at = CASE WHEN status = 'approved' OR consecutive_matches + 1 >= ? THEN NULL ELSE revoked_at END,
         last_candle_key = ?, last_result = 'match', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(policy.promoteAfter, policy.promoteAfter, policy.promoteAfter, now, candleKey, detail, now, ...key).run();
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
  return { counted: true, result: comparison.status, ...(escalated ? { escalated: "repeated_input_mismatch" } : {}) };
}

/**
 * One-time reconciliation (owner approval 2026-11-06): comparisons stored as `mismatch` before the
 * input-mismatch rule, whose mismatches are all input-bar fields, are reclassified as
 * `input_mismatch`; an identity revoked only by such comparisons (no indicator mismatch since its
 * approval) is restored to approved. A revocation by an indicator mismatch, or by repeated input
 * mismatches (detail.reason "repeated_input_mismatch"), is never touched.
 * Returns { reclassified, restored: [engine] }.
 */
export async function reclassifyInputOnlyMismatches(db, now = new Date().toISOString()) {
  const inputOnly = `result = 'mismatch'
    AND COALESCE(json_extract(detail, '$.reason'), '') <> 'repeated_input_mismatch'
    AND json_array_length(json_extract(detail, '$.mismatches')) > 0
    AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(detail, '$.mismatches')) WHERE json_extract(value, '$.field') NOT LIKE 'input:%')`;
  const counts = (await db.prepare(`SELECT engine, source_hash, implementation_hash, COUNT(*) AS n FROM engine_parity_comparisons WHERE ${inputOnly} GROUP BY engine, source_hash, implementation_hash`).all())?.results || [];
  const updated = await db.prepare(`UPDATE engine_parity_comparisons SET result = 'input_mismatch' WHERE ${inputOnly}`).run();
  for (const c of counts) {
    await db.prepare("UPDATE engine_parity_registry SET total_mismatches = MAX(total_mismatches - ?, 0), updated_at = ? WHERE engine = ? AND source_hash = ? AND implementation_hash = ?")
      .bind(Number(c.n) || 0, now, c.engine, c.source_hash, c.implementation_hash).run();
  }
  const revoked = (await db.prepare(
    `SELECT r.engine, r.source_hash, r.implementation_hash FROM engine_parity_registry r
     WHERE r.status = 'revoked' AND r.approved_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM engine_parity_comparisons c WHERE c.engine = r.engine AND c.source_hash = r.source_hash
                       AND c.implementation_hash = r.implementation_hash AND c.result = 'mismatch' AND c.compared_at >= r.approved_at)`
  ).all())?.results || [];
  for (const r of revoked) {
    await db.prepare("UPDATE engine_parity_registry SET status = 'approved', revoked_at = NULL, updated_at = ? WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND status = 'revoked'")
      .bind(now, r.engine, r.source_hash, r.implementation_hash).run();
  }
  return { reclassified: Number(updated?.meta?.changes) || 0, restored: revoked.map((r) => r.engine) };
}

/** True when the identity is currently trusted for the local_computation lane. */
export async function isTrusted(db, id) {
  if (id.engine === "mizan" || id.engine.startsWith("mizan_")) {
    // Mizan is trusted per timeframe: only approved Prophet AND GMI identities on
    // the same timeframe scope (for example prophet_m5 and gmi_m5) vouch for it.
    const suffix = id.engine.slice("mizan".length);
    const row = await db.prepare(
      `SELECT
         SUM(CASE WHEN engine = ? THEN 1 ELSE 0 END) AS prophet,
         SUM(CASE WHEN engine = ? THEN 1 ELSE 0 END) AS gmi
       FROM engine_parity_registry
       WHERE status = 'approved' AND mizan_source_hash = ? AND mizan_implementation_hash = ?`
    ).bind("prophet" + suffix, "gmi" + suffix, id.sourceHash, id.implementationHash).first();
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
