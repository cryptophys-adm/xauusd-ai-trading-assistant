// HAIC H3f, minimal (platform docs/design/HAIC-H3.md §4, §7.2; owner "Setuju semua rekomendasi", 2026-11-19): the
// owner's corrections and ratings of Nexus outputs, sent to the platform as correction.v1 records by the dedicated
// kernel agent nexus-teacher (capability corrections.record, tier 1, no seat; platform XAUUSD_CEILING, H3e).
//
// What this module is today: the contract (a port of control-plane-shared/src/correction.ts at platform main
// 62e5167, checked against the shared fixtures in test/fixtures/correction-v1), the local store and the sender. The
// switch OWNER_CORRECTIONS is off by default; nothing records a correction until the Nexus control and
// POST /omega/api/correction land (the full H3f, later work).
//
// Rules (§4.4, §5.2, §7.2):
// - The original, prices included, stays in this Worker's D1 (owner_corrections.original_json). Only the masked record
//   leaves: secrets redacted, price-like numbers as [level], text at most 500 characters, refs without a price field.
// - A record never carries a parameter or a price-like key. A correction never writes STRATEGY_PARAMS, knob
//   overrides, risk profiles, witness weights, QUORUM_SHARE or REPUTATION_PRIOR, never arms a strategy and never
//   enters outcome_scores: this module only stores and sends.
// - A transport failure is retried by the next sweep (as aether-push.mjs does for cards); a kernel denial is final
//   (AGENTS.md rule 7).

export const NEXUS_TEACHER_ID = "nexus-teacher";
export const CORRECTIONS_CAPABILITY = "corrections.record";
export const CORRECTION_SCHEMA = "correction.v1";
export const CORRECTION_DEDUP_VERSION = "cryptophys.correction-dedup.v1";
export const CORRECTION_SIDES = Object.freeze(["cerebrum", "nexus"]);
export const CORRECTION_SOURCES = Object.freeze(["chat_rating", "council", "typed_proposal", "knowledge_review", "nexus_card", "nexus_room", "nexus_engine", "nexus_council"]);
export const CORRECTION_LABELS = Object.freeze(["owner_rating", "owner_correction", "owner_decision", "reviewer_correction"]);
export const CORRECTION_CATEGORIES = Object.freeze([
  "reading_wrong", "invalidation_too_tight", "invalidation_too_loose", "evidence_wrong", "evidence_missing",
  "overconfident", "underconfident", "rule_broken", "good_call", "other"
]);
export const CORRECTION_ATTESTATIONS = Object.freeze(["cerebrum_access", "xauusd_nexus_access"]);
export const CORRECTION_REDACTIONS = Object.freeze(["secret", "price", "truncated"]);
export const CORRECTION_TEXT_MAX = 500;
export const CORRECTION_REFS_MAX = 10;
export const LABEL_WEIGHT = Object.freeze({ owner_rating: 3, owner_correction: 3, owner_decision: 1, reviewer_correction: 2 });
export const NON_OWNER_WEIGHT = 1;
/** Pending records sent per sweep, and the attempts after which a record that keeps failing stops being retried. */
export const CORRECTIONS_SEND_PER_SWEEP = 20;
export const CORRECTIONS_MAX_ATTEMPTS = 48;

const ID = /^cor_[0-9a-f]{16}$/;
const SUBJECT = /^(agent|model|seat):[A-Za-z0-9_.:-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PRICE_G = /(?:\d{1,3}(?:[.,\s_'’]\d{3})+(?:[.,]\d+)?|\d{3,}(?:[.,]\d+)?)/g;
const PRICE = new RegExp(PRICE_G.source);
const FORBIDDEN_KEYS = new Set(["params", "parameters", "values", "value", "change", "changes", "patch", "set", "weight_delta"]);
const PRICE_KEY_PARTS = new Set(["price", "prices", "level", "levels", "size", "sizing", "entry", "entries", "stop", "order", "orders", "lot", "lots", "sl", "tp", "tp1", "tp2"]);
const ALLOWED_KEYS = new Set([
  "schema", "correction_id", "side", "source", "label", "rating", "category", "target", "text", "evidence_refs", "actor", "attested_by",
  "weight", "supersedes", "redactions", "created_at", "content_sha256", "dedup_sha256", "category_raw", "invalid_refs"
]);

// ------------------------------------------------------------ evidence refs (platform council.ts §4.6)
const REF = /^ev:(platform|xauusd|aether|adr|ssot)\/(?:([a-z][a-z0-9_.-]{0,63})\/)?([^@#\s]{1,200})(?:@([^#\s]{1,40}))?(?:#([A-Za-z0-9_.]{1,80}))?$/;
const PRICE_WORDS = /^(price|entry|stoploss|stop|takeprofit|sl|tp\d?|level|bid|ask|open|high|low|close|mid)$/i;
export function parseRef(ref) {
  if (typeof ref !== "string") return null;
  const m = REF.exec(ref);
  if (!m) return null;
  const [, side, source, id, asOf, field] = m;
  return { side, source: source ?? side, id, as_of: asOf ?? null, field: field ?? null };
}
export const refCarriesPrice = (ref) => ref.field !== null && PRICE_WORDS.test(ref.field.split(/[._]/).pop() ?? "");

// ------------------------------------------------------------ secrets (platform conversation.ts and http.ts)
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const SECRET_SHAPES = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:cf|CF)[A-Za-z0-9_-]*_(?:token|TOKEN)\s*[=:]\s*\S{20,}/
]);
const redactValue = (text) => text.replace(SECRET_VALUE, "[redacted]");
export const secretInText = (text) => redactValue(text) !== text || SECRET_SHAPES.some((re) => re.test(text));
export function redactText(text) {
  let out = redactValue(String(text));
  for (const re of SECRET_SHAPES) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]");
  return out;
}

// ------------------------------------------------------------ the contract (platform correction.ts)
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** Trim and collapse every whitespace run; case is kept. */
export const normalizeText = (s) => s.trim().replace(/\s+/g, " ");

/** Keys that name a parameter or a price, anywhere in a value. */
export function forbiddenCorrectionKeys(value, path = "correction") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenCorrectionKeys(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const parts = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]/);
    const bad = FORBIDDEN_KEYS.has(k.toLowerCase()) || parts.some((p) => PRICE_KEY_PARTS.has(p));
    return [...(bad ? [`${path}.${k}`] : []), ...forbiddenCorrectionKeys(v, `${path}.${k}`)];
  });
}

function safeRef(raw) {
  const ref = parseRef(raw);
  if (!ref || typeof raw !== "string") return null;
  return refCarriesPrice(ref) ? { ref: raw.slice(0, raw.indexOf("#")), priced: true } : { ref: raw, priced: false };
}

/** Text as stored: secrets redacted, prices masked, at most CORRECTION_TEXT_MAX characters; each step flagged. */
export function safeText(raw, redactions) {
  if (typeof raw !== "string") return null;
  let text = normalizeText(raw);
  if (!text) return null;
  if (secretInText(text)) { text = redactText(text); redactions.add("secret"); }
  if (PRICE.test(text)) { text = text.replace(PRICE_G, "[level]"); redactions.add("price"); }
  if (text.length > CORRECTION_TEXT_MAX) { text = text.slice(0, CORRECTION_TEXT_MAX); redactions.add("truncated"); }
  return text;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

/** §4.3: the same actor, target, label, rating, category, normalized text and sorted refs; ids, times, supersedes left out. */
export function correctionDedupHash(c) {
  return sha256Hex(JSON.stringify([CORRECTION_DEDUP_VERSION, c.actor, c.target.ref, c.label, c.rating, c.category, normalizeText(c.text ?? ""), [...c.evidence_refs].sort()]));
}
/** The record's content: everything but its id, its time, its weight and its two hashes. */
export function correctionContentHash(c) {
  const { correction_id: _i, created_at: _c, weight: _w, content_sha256: _h, dedup_sha256: _d, ...content } = c;
  return sha256Hex(JSON.stringify(canonical(content)));
}

/**
 * An input into a record (§4.4). Structural errors only: an unknown side, source or label, a target that is not an ev:
 * ref or names no subject, a parameter key, or nothing to learn (no rating, category or text). Everything else is made
 * safe. ctx = { actor, owner, attested_by, now, correction_id } comes from the caller's authentication, never the input.
 */
export async function buildCorrection(input, ctx) {
  if (!isObject(input)) return { ok: false, error: "invalid_request" };
  const bad = forbiddenCorrectionKeys(input, "input").filter((k) => !/^input\.target\.(ref|subject|as_of)$/.test(k));
  if (bad.length) return { ok: false, error: `forbidden_key: ${bad[0]}` };
  if (!CORRECTION_SIDES.includes(input.side)) return { ok: false, error: "invalid_side" };
  if (!CORRECTION_SOURCES.includes(input.source)) return { ok: false, error: "invalid_source" };
  const redactions = new Set();
  const target = isObject(input.target) ? input.target : null;
  const tref = target ? safeRef(target.ref) : null;
  if (!tref) return { ok: false, error: "invalid_target" };
  if (tref.priced) redactions.add("price");
  const subject = typeof target.subject === "string" ? target.subject : "";
  if (!SUBJECT.test(subject)) return { ok: false, error: "invalid_subject" };
  const asOf = typeof target.as_of === "string" && ISO.test(target.as_of) ? target.as_of : null;
  const rating = input.rating === "up" || input.rating === "down" ? input.rating : null;
  let category = null;
  let categoryRaw;
  if (typeof input.category === "string" && input.category.trim()) {
    if (CORRECTION_CATEGORIES.includes(input.category)) category = input.category;
    else { category = "other"; categoryRaw = input.category.slice(0, 60); }
  }
  const text = safeText(input.text, redactions);
  if (!rating && !category && !text) return { ok: false, error: "empty" };
  const label = CORRECTION_LABELS.includes(input.label) ? input.label
    : input.label === undefined ? (category || text ? "owner_correction" : "owner_rating") : "";
  if (!label) return { ok: false, error: "invalid_label" };
  if (label === "owner_rating" && !rating) return { ok: false, error: "rating_required" };
  const refs = [];
  let invalid = 0;
  for (const r of Array.isArray(input.evidence_refs) ? input.evidence_refs : []) {
    const s = safeRef(r);
    if (!s) { invalid += 1; continue; }
    if (s.priced) redactions.add("price");
    if (!refs.includes(s.ref) && refs.length < CORRECTION_REFS_MAX) refs.push(s.ref);
  }
  const supersedes = typeof input.supersedes === "string" && ID.test(input.supersedes) ? input.supersedes : null;
  const base = {
    schema: CORRECTION_SCHEMA, correction_id: ctx.correction_id, side: input.side, source: input.source,
    label, rating, category, target: { ref: tref.ref, subject, as_of: asOf }, text, evidence_refs: refs,
    actor: ctx.actor, attested_by: ctx.attested_by, weight: ctx.owner ? LABEL_WEIGHT[label] : NON_OWNER_WEIGHT,
    supersedes, redactions: CORRECTION_REDACTIONS.filter((r) => redactions.has(r)), created_at: ctx.now,
    ...(categoryRaw ? { category_raw: categoryRaw } : {}), ...(invalid ? { invalid_refs: invalid } : {})
  };
  return { ok: true, correction: { ...base, content_sha256: await correctionContentHash(base), dedup_sha256: await correctionDedupHash(base) } };
}

/** Every rule a stored or sent record must hold (the shared fixtures are checked with it). */
export function validateCorrection(c) {
  if (!isObject(c)) return ["not_an_object"];
  const errors = [];
  for (const k of Object.keys(c)) if (!ALLOWED_KEYS.has(k)) errors.push(`unknown_key: ${k}`);
  for (const k of forbiddenCorrectionKeys(c).filter((k) => !/^correction\.target\.(ref|subject|as_of)$/.test(k))) errors.push(`forbidden_key: ${k}`);
  if (c.schema !== CORRECTION_SCHEMA) errors.push("schema");
  if (typeof c.correction_id !== "string" || !ID.test(c.correction_id)) errors.push("correction_id");
  if (!CORRECTION_SIDES.includes(c.side)) errors.push("side");
  if (!CORRECTION_SOURCES.includes(c.source)) errors.push("source");
  const label = c.label;
  if (!CORRECTION_LABELS.includes(label)) errors.push("label");
  if (!(c.rating === null || c.rating === "up" || c.rating === "down")) errors.push("rating");
  if (!(c.category === null || CORRECTION_CATEGORIES.includes(c.category))) errors.push("category");
  const t = isObject(c.target) ? c.target : null;
  const ref = t ? parseRef(t.ref) : null;
  if (!t || !ref) errors.push("target.ref");
  else if (refCarriesPrice(ref)) errors.push("target.ref_carries_price");
  if (!t || typeof t.subject !== "string" || !SUBJECT.test(t.subject)) errors.push("target.subject");
  if (t && !(t.as_of === null || (typeof t.as_of === "string" && ISO.test(t.as_of)))) errors.push("target.as_of");
  if (c.text !== null) {
    if (typeof c.text !== "string" || !c.text.trim()) errors.push("text");
    else {
      if (c.text.length > CORRECTION_TEXT_MAX) errors.push("text_too_long");
      if (secretInText(c.text)) errors.push("text_carries_secret");
      if (PRICE.test(c.text)) errors.push("text_carries_price");
    }
  }
  if (!Array.isArray(c.evidence_refs) || c.evidence_refs.length > CORRECTION_REFS_MAX) errors.push("evidence_refs");
  else for (const r of c.evidence_refs) {
    const p = parseRef(r);
    if (!p) errors.push("evidence_refs.unparsed");
    else if (refCarriesPrice(p)) errors.push("evidence_refs.carries_price");
  }
  if (typeof c.actor !== "string" || c.actor.length < 3 || c.actor.length > 200) errors.push("actor");
  if (!CORRECTION_ATTESTATIONS.includes(c.attested_by)) errors.push("attested_by");
  if (!(c.weight === NON_OWNER_WEIGHT || (CORRECTION_LABELS.includes(label) && c.weight === LABEL_WEIGHT[label]))) errors.push("weight");
  if (!(c.supersedes === null || (typeof c.supersedes === "string" && ID.test(c.supersedes)))) errors.push("supersedes");
  if (!Array.isArray(c.redactions) || !c.redactions.every((r) => CORRECTION_REDACTIONS.includes(r))) errors.push("redactions");
  if (typeof c.created_at !== "string" || !ISO.test(c.created_at)) errors.push("created_at");
  if (typeof c.content_sha256 !== "string" || !HEX64.test(c.content_sha256)) errors.push("content_sha256");
  if (typeof c.dedup_sha256 !== "string" || !HEX64.test(c.dedup_sha256)) errors.push("dedup_sha256");
  if (label === "owner_rating" && c.rating === null) errors.push("owner_rating_without_rating");
  if (label === "owner_correction" && c.category === null && c.text === null) errors.push("owner_correction_without_content");
  if (label === "owner_decision" && c.text === null) errors.push("owner_decision_without_reason");
  if (c.category_raw !== undefined && (c.category !== "other" || typeof c.category_raw !== "string")) errors.push("category_raw");
  if (c.invalid_refs !== undefined && !(Number.isInteger(c.invalid_refs) && c.invalid_refs > 0)) errors.push("invalid_refs");
  return errors;
}

/** What corrections.record takes (§7.1): the masked record without its id and its two hashes. */
export function recordPayload(c) {
  const { correction_id: _i, content_sha256: _h, dedup_sha256: _d, ...payload } = c;
  return payload;
}

// ------------------------------------------------------------ the local store and the sender
/** The owner's switch: off unless OWNER_CORRECTIONS is "on". */
export const correctionsEnabled = (env) => String(env?.OWNER_CORRECTIONS ?? "off").trim().toLowerCase() === "on";

const SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS owner_corrections (
    correction_id TEXT PRIMARY KEY,
    original_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    dedup_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    platform_id TEXT,
    created_ms INTEGER NOT NULL,
    sent_ms INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS idx_owner_corrections_status ON owner_corrections(status, created_ms)"
]);
let ready = false;
export function resetOwnerCorrectionsSchemaForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
  ready = true;
}
const newCorrectionId = () => "cor_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Store one correction: the original as given (prices included, kept here) and the masked record to send. Refused only
 * as buildCorrection refuses (structure), or when the switch is off. actor is the caller's verified identity.
 */
export async function recordOwnerCorrection(env, input, { actor, owner = false, now = Date.now() } = {}) {
  if (!correctionsEnabled(env)) return { ok: false, error: "disabled" };
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  if (typeof actor !== "string" || actor.length < 3 || actor.length > 200) return { ok: false, error: "invalid_actor" };
  const built = await buildCorrection({ ...input, side: "nexus" }, { actor, owner: owner === true, attested_by: "xauusd_nexus_access", now: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"), correction_id: newCorrectionId() });
  if (!built.ok) return built;
  const errors = validateCorrection(built.correction);
  if (errors.length) return { ok: false, error: errors[0] };
  await ensureSchema(db);
  await db.prepare("INSERT INTO owner_corrections (correction_id, original_json, record_json, dedup_sha256, status, attempts, created_ms) VALUES (?, ?, ?, ?, 'pending', 0, ?)")
    .bind(built.correction.correction_id, JSON.stringify(input), JSON.stringify(built.correction), built.correction.dedup_sha256, now).run();
  return { ok: true, correction_id: built.correction.correction_id, redactions: built.correction.redactions };
}

/** The sweep: send pending records as nexus-teacher. Success and denial are final; a failure is retried next sweep. */
export async function sendOwnerCorrections(env, { now = Date.now(), limit = CORRECTIONS_SEND_PER_SWEEP } = {}) {
  if (!correctionsEnabled(env)) return { status: "disabled" };
  const db = env?.DB;
  if (!db || typeof env?.AGENTS?.syscall !== "function") return { status: "unavailable" };
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT correction_id, record_json, attempts FROM owner_corrections WHERE status = 'pending' ORDER BY created_ms LIMIT ?").bind(limit).all()).results || [];
  let sent = 0, denied = 0, failed = 0;
  for (const row of rows) {
    let record;
    try { record = JSON.parse(row.record_json); } catch { record = null; }
    if (!record || validateCorrection(record).length) {
      await db.prepare("UPDATE owner_corrections SET status = 'invalid', reason = ? WHERE correction_id = ?").bind("record_invalid", row.correction_id).run();
      continue;
    }
    let r;
    try { r = await env.AGENTS.syscall(NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY, recordPayload(record)); }
    catch (e) { r = { outcome: "failed", reason: String(e?.message ?? e).slice(0, 200) }; }
    if (r?.outcome === "succeeded" || r?.outcome === "success") {
      const id = r?.result?.correction_id ?? r?.result?.correction?.correction_id ?? null;
      await db.prepare("UPDATE owner_corrections SET status = 'sent', platform_id = ?, sent_ms = ?, reason = ? WHERE correction_id = ?")
        .bind(typeof id === "string" ? id.slice(0, 40) : null, now, r?.result?.deduplicated ? "deduplicated" : null, row.correction_id).run();
      sent += 1;
    } else if (r?.outcome === "denied") {
      await db.prepare("UPDATE owner_corrections SET status = 'denied', reason = ? WHERE correction_id = ?").bind(String(r?.reason ?? "denied").slice(0, 200), row.correction_id).run();
      denied += 1;
    } else {
      const attempts = Number(row.attempts || 0) + 1;
      await db.prepare("UPDATE owner_corrections SET attempts = ?, status = ?, reason = ? WHERE correction_id = ?")
        .bind(attempts, attempts >= CORRECTIONS_MAX_ATTEMPTS ? "failed" : "pending", String(r?.reason ?? r?.outcome ?? "failed").slice(0, 200), row.correction_id).run();
      failed += 1;
    }
  }
  return { status: "ok", sent, denied, failed, pending: rows.length - sent - denied };
}
