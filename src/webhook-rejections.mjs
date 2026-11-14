// Webhook rejections (owner report 2026-11-09: every TradingView alert since the week open answered
// "401 Unauthorized" while the owner holds that the secret did not change).
//
// A rejected POST /webhook used to leave no trace: TradingView's alert log showed "401" and the
// Worker kept nothing. Now each rejection is one D1 row that says WHY, without ever storing or
// returning the secret or any part of it:
//   secret_missing         neither the body `secret` nor the x-webhook-secret header carries one
//                          (the indicator's "CTA Webhook Secret" input is empty in the alert);
//   secret_whitespace      the secret matches once leading/trailing spaces or line breaks are cut
//                          (a paste with a space or a newline);
//   secret_case            it matches ignoring letter case;
//   secret_length_differs  a different secret: its length differs from WEBHOOK_SECRET's;
//   secret_mismatch        a different secret of the same length.
// Only lengths, never characters, are kept; the rows hold source, timeframe, candle time and the
// request's content type and user agent, and are pruned after 14 days.
// Fingerprints (owner report 2026-11-09, after the secret was rotated and set in both places and
// the 5m alerts still answered 401 with two different 32-character secrets): each row also keeps the
// first 8 hex characters of the SHA-256 of the received secret and of WEBHOOK_SECRET. The owner
// hashes the candidate values on their own machine (printf '%s' "<value>" | sha256sum) and sees
// which one the alerts send and which one the Worker holds. 32 bits of the hash of a random
// 32-character secret do not help guess it; the fingerprints never leave D1. The health detector opens
// a "webhook_rejected" alert (Priority Queue) while rejections keep arriving.

export const WEBHOOK_REJECTIONS_SQL =
  "CREATE TABLE IF NOT EXISTS webhook_rejections (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, reason TEXT NOT NULL, secret_field TEXT NOT NULL, received_len INTEGER NOT NULL, expected_len INTEGER NOT NULL, source TEXT, timeframe TEXT, candle_time TEXT, content_type TEXT, user_agent TEXT, received_fp TEXT, expected_fp TEXT)";
const RETENTION_MS = 14 * 24 * 3600_000;
export const MAX_PER_HOUR = 300;

export const REJECTION_TEXT = Object.freeze({
  secret_missing: "the alert carries no secret (the indicator's CTA Webhook Secret input is empty in this alert)",
  secret_whitespace: "the secret has extra spaces or a line break around it",
  secret_case: "the secret differs only in letter case",
  secret_length_differs: "a different secret (its length differs from the Worker's)",
  secret_mismatch: "a different secret of the same length"
});

/**
 * Pure: why a request's secrets do not match `expected`. Returns null when one matches. Never
 * returns any character of either secret.
 */
export function classifyRejection({ headerSecret = "", bodySecret = "", expected = "" } = {}) {
  if (!expected) return null;
  if (headerSecret === expected || bodySecret === expected) return null;
  const field = bodySecret ? "body" : headerSecret ? "header" : "none";
  const got = bodySecret || headerSecret;
  const out = (reason) => ({ reason, secret_field: field, received_len: got.length, expected_len: expected.length });
  if (!got) return out("secret_missing");
  const candidates = [bodySecret, headerSecret].filter(Boolean);
  if (candidates.some((s) => s.trim() === expected)) return out("secret_whitespace");
  if (candidates.some((s) => s.toLowerCase() === expected.toLowerCase())) return out("secret_case");
  return out(got.length !== expected.length ? "secret_length_differs" : "secret_mismatch");
}

const clip = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);

/** The first 8 hex characters of the SHA-256 of a value (null for an empty one). */
export async function fingerprint(value) {
  if (typeof value !== "string" || !value) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The table of the first release had no fingerprint columns: add them once per isolate.
let columnsReady = false;
async function ensureColumns(db) {
  if (columnsReady) return;
  for (const col of ["received_fp", "expected_fp"]) {
    try { await db.prepare(`ALTER TABLE webhook_rejections ADD COLUMN ${col} TEXT`).run(); } catch { /* already there */ }
  }
  columnsReady = true;
}
export function resetRejectionSchemaCacheForTests() { columnsReady = false; }

/** Stores one rejection row and prunes rows past the retention. Never throws. */
export async function recordRejection(db, rejection, { source = null, timeframe = null, candleTime = null, contentType = null, userAgent = null, receivedSecret = "", expectedSecret = "" } = {}, now = Date.now()) {
  if (!db || !rejection) return false;
  try {
    await db.prepare(WEBHOOK_REJECTIONS_SQL).run();
    await ensureColumns(db);
    // A flood of unauthenticated requests must not fill D1: at most MAX_PER_HOUR rows an hour.
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM webhook_rejections WHERE received_at >= ?").bind(new Date(now - 3600_000).toISOString()).first();
    if (Number(recent?.n) >= MAX_PER_HOUR) return false;
    await db.prepare(
      "INSERT INTO webhook_rejections (received_at, reason, secret_field, received_len, expected_len, source, timeframe, candle_time, content_type, user_agent, received_fp, expected_fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(new Date(now).toISOString(), rejection.reason, rejection.secret_field, rejection.received_len, rejection.expected_len, clip(source, 40), clip(timeframe, 8), clip(candleTime, 24), clip(contentType, 60), clip(userAgent, 80), await fingerprint(receivedSecret), await fingerprint(expectedSecret)).run();
    await db.prepare("DELETE FROM webhook_rejections WHERE received_at < ?").bind(new Date(now - RETENTION_MS).toISOString()).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Rejections since `sinceMs`: { count, first_at, last_at, reasons: { reason: n }, sources: [..],
 * received_lengths: [..], expected_len }. Never throws; an absent table reads as none.
 */
export async function rejectionSummary(db, sinceMs) {
  const empty = { count: 0, first_at: null, last_at: null, reasons: {}, sources: [], received_lengths: [], expected_len: null };
  if (!db) return empty;
  let rows = [];
  try {
    rows = (await db.prepare("SELECT received_at, reason, received_len, expected_len, source FROM webhook_rejections WHERE received_at >= ? ORDER BY received_at").bind(new Date(sinceMs).toISOString()).all()).results || [];
  } catch {
    return empty;
  }
  if (!rows.length) return empty;
  const reasons = {}, lengths = {};
  for (const r of rows) {
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    (lengths[r.reason] ||= new Set()).add(Number(r.received_len));
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0][0];
  return {
    count: rows.length,
    first_at: rows[0].received_at,
    last_at: rows.at(-1).received_at,
    reasons,
    top_reason: top,
    sources: [...new Set(rows.map((r) => r.source).filter(Boolean))].sort(),
    // The lengths of the most frequent reason's secrets (a stray probe does not blur them).
    received_lengths: [...lengths[top]].sort((a, b) => a - b),
    expected_len: Number(rows.at(-1).expected_len)
  };
}

/**
 * The TradingView alert lane for Nexus System status: the last accepted alert (D1
 * webhook_sources) and the rejections of the last hour. Never throws.
 */
// Resource audit P0 (2026-11-14): the last webhook is read by time. webhook_sources comes from schema.sql
// (no run-time schema), so its index is made here once per isolate; a database without it skips it.
let receivedIndexReady = false;
async function ensureReceivedIndex(db) {
  if (receivedIndexReady) return;
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_webhook_sources_received ON webhook_sources(received_at)").run(); receivedIndexReady = true; } catch { /* no webhook_sources table */ }
}

export async function webhookLaneStatus(db, now = Date.now()) {
  await ensureReceivedIndex(db);
  let last = null;
  try {
    last = await db.prepare("SELECT source, candle_key, received_at FROM webhook_sources ORDER BY received_at DESC LIMIT 1").first();
  } catch { last = null; }
  // webhook_sources.received_at is SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS" in UTC.
  const lastAt = last?.received_at ? new Date(String(last.received_at).replace(" ", "T") + (String(last.received_at).endsWith("Z") ? "" : "Z")).toISOString() : null;
  const rejected = await rejectionSummary(db, now - 3600_000);
  return {
    last_accepted_at: lastAt,
    last_accepted_source: last?.source ?? null,
    rejected_last_hour: rejected.count,
    rejected_sources: rejected.sources,
    top_reason: rejected.top_reason ?? null,
    top_reason_text: rejected.top_reason ? REJECTION_TEXT[rejected.top_reason] ?? rejected.top_reason : null,
    last_rejected_at: rejected.last_at
  };
}
