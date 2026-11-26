// Lens B of the Positioning & Liquidity analyst (docs/RFC_POSITIONING_LIQUIDITY.md §4-§6): liquidity read from the
// broker's own closed M1 bars (tick volume and spread, Omega's corpus). Owner 2026-11-20: "Sekarang breakglass urgent
// jadi langsung live"; live in every role at once, its weight per mode moved by Aether within hard bounds
// (src/lens-policy.mjs); the owner's switch `liquidity_enabled` (default on) turns it off at once.
//
//   archive    D1 broker_bars_1m, keyed by the opaque account_ref (never the account number) and the corpus source,
//              written in the corpus ingest, pruned at 120 days, backfilled from corpus_bars once per identity
//              (account_ref, source and the connection versions; B2).
//   baseline   per account and source and per New York hour of the week, the last 8 weeks; reset on a new account,
//              server, symbol or digits; "insufficient" below 4 weeks, with a rolling fallback (same NY hour of day).
//   facts      percentiles and ratios only (spike, thin, spread ratio, reclaimed sweep, equal-high/low pools,
//              high-volume nodes); the levels stay inside (brokerKeyLevels, source "liquidity").
//   never      liquidity never opens a position, sets a size or a price for an entry (test LQ-alone).

import { goldPausedAt, goldClosedAt, nyHour, SESSIONS } from "./market-hours.mjs";

export const BROKER_BARS_KEEP_DAYS = 120;
export const LIQUIDITY_BASELINE_WEEKS = 8;
export const LIQUIDITY_SUFFICIENT_WEEKS = 4;
export const BASELINE_MIN_BARS = 45;
export const SESSION_OPEN_EXCLUDE_MIN = 5;
/** New York hours of the Tokyo, London and New York opens (src/decision-engine.mjs SESSIONS: 19, 3 and 8). */
export const SESSION_OPEN_HOURS_NY = Object.freeze([19, 3, 8]);
export const LIQUIDITY_MODIFY_DEFER_MAX_MS = 10 * 60_000;
export const SWEEP_WITH_MAX_AGE_MIN = 15;
export const SWEEP_SCORE_BARS_15M = 8;
export const SWEEP_SCORE_ATR = 0.5;
export const LIQUIDITY_STATE_KEY = "liquidity:state:v1";
export const LIQUIDITY_SPIKE_KEY = "liquidity:spike:v1";
/** The v1 marker (one per Worker): kept only so a reader can tell the old backfill ran; B2 writes v2 per identity. */
export const LIQUIDITY_BACKFILL_KEY = "liquidity:backfill:v1";
/** Pure: FNV-1a 32-bit of a text, as 8 hex digits (a short, stable key part). */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
/**
 * B2: the backfill's identity, its account_ref, source and a short hash of the sorted connection versions it copied
 * (the list itself is in the marker's value: a key with every version would pass KV's 512 bytes after many reconnects).
 */
export const backfillIdentity = (accountRef, source, versions) => `${accountRef}|${source}|v${shortHash([...versions].sort((a, b) => a - b).join(","))}`;
export const backfillKey = (identity) => `liquidity:backfill:v2:${identity}`;
export const backfillFailedKey = (identity) => `liquidity:backfill:failed:v2:${identity}`;
/** The archived connection versions of an account_ref and source, kept so a step does not scan the archive for them. */
export const backfillVersionsKey = (accountRef, source) => `liquidity:backfill:versions:v2:${accountRef}|${source}`;
export const LIQUIDITY_STATE_FRESH_MS = 15 * 60_000;
export const baselineKey = (accountRef) => `liquidity:baseline:${accountRef}`;
/** The archive's columns, in the INSERT's order. */
export const BROKER_BAR_COLUMNS = Object.freeze(["account_ref", "source", "minute_ms", "o", "h", "l", "c", "tick_volume", "spread_points", "digits", "connection_version", "received_ms", "legacy_ref"]);
/** D1 binds at most 100 parameters a statement: 13 columns x 7 rows = 91 (archiveMinuteBars writes 20 rows of 5). */
export const BROKER_ROWS_PER_STATEMENT = 7;
const QUANTILES = 101;
const M1 = 60_000, M15 = 15 * M1, HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const r3 = (v) => (finite(v) ? Math.round(v * 1000) / 1000 : null);

// ---------------------------------------------------------------- New York clock

const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WD = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const nyClock = (ms) => { const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { wd: WD[p.weekday], hour: Number(p.hour), minute: Number(p.minute) }; };
/** Pure: the New York hour of the week (0 = Sunday 00:00 to 167), which moves with US daylight time. */
export function nyHourOfWeek(ms) { const c = nyClock(ms); return c.wd * 24 + c.hour; }

/** Pure: the daily rollover quarantine, 21:55-22:15 UTC (the same window as src/omega-engine.mjs isRolloverQuarantine). */
export function inRollover(ms) { const d = new Date(ms); const h = d.getUTCHours(), m = d.getUTCMinutes(); return (h === 21 && m >= 55) || (h === 22 && m < 15); }
/** Pure: within the first SESSION_OPEN_EXCLUDE_MIN minutes after the weekly or daily reopen or a session open (NY 19, 3, 8). */
export function inSessionOpen(ms) {
  if (goldPausedAt(ms)) return false;
  if (goldPausedAt(ms - SESSION_OPEN_EXCLUDE_MIN * M1)) return true; // the weekly or the daily reopen just happened
  const c = nyClock(ms);
  return SESSION_OPEN_HOURS_NY.includes(c.hour) && c.minute < SESSION_OPEN_EXCLUDE_MIN;
}
/** Pure: why a minute is left out of the baseline and the events, or null. */
export function excludedWhy(ms) {
  if (inRollover(ms)) return "rollover_quarantine";
  if (goldPausedAt(ms)) return "market_paused";
  if (inSessionOpen(ms)) return "session_open";
  return null;
}

// ---------------------------------------------------------------- the archive

export const BROKER_BARS_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS broker_bars_1m (
    account_ref TEXT NOT NULL,
    source TEXT NOT NULL,
    minute_ms INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    tick_volume INTEGER,
    spread_points INTEGER,
    digits INTEGER,
    connection_version INTEGER,
    received_ms INTEGER NOT NULL,
    legacy_ref INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_ref, source, minute_ms)
  )`,
  `CREATE TABLE IF NOT EXISTS liquidity_readings (
    at_ms INTEGER NOT NULL,
    account_ref TEXT NOT NULL,
    mode TEXT,
    baseline TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    levels_json TEXT,
    PRIMARY KEY (account_ref, at_ms)
  )`
]);
let ready = null;
export function resetLiquiditySchemaForTests() { ready = null; }
export async function ensureLiquiditySchema(db) {
  if (ready === db) return;
  for (const q of BROKER_BARS_SQL) await db.prepare(q).run();
  ready = db;
}

/** Runs statements in batches of 50 (db.batch when the binding has it); returns each statement's result in order. */
async function runAll(db, statements) {
  const out = [];
  for (let i = 0; i < statements.length; i += 50) {
    const part = statements.slice(i, i + 50);
    if (typeof db.batch === "function") out.push(...((await db.batch(part)) ?? part.map(() => null)));
    else for (const st of part) out.push(await st.run());
  }
  return out;
}

/**
 * The corpus ingest's archive step: the validated M1 bars ({ t, o, h, l, c, v, s }) of the active account under its
 * opaque account_ref (never the account number) and source, BROKER_ROWS_PER_STATEMENT rows a statement; pruned at 120
 * days once an hour. Returns the rows sent.
 */
export async function archiveBrokerBars(db, opts = {}) {
  return (await archiveBrokerRows(db, opts)).sent;
}
/**
 * archiveBrokerBars with the rows the archive took: { sent, added, from_ms, to_ms }, added from each INSERT's
 * meta.changes (never a COUNT delta, which the prune or a live ingest would skew), and the minutes spanned by the
 * statements that added rows.
 */
export async function archiveBrokerRows(db, { accountRef, legacy = false, source, digits = null, connectionVersion = null, bars = [], now = Date.now() } = {}) {
  const none = { sent: 0, added: 0, from_ms: null, to_ms: null, sent_from_ms: null, sent_to_ms: null };
  if (!db || typeof accountRef !== "string" || !/^acct_[0-9a-f]{16}$/.test(accountRef) || typeof source !== "string" || !source.startsWith("mt5:") || !bars.length) return none;
  await ensureLiquiditySchema(db);
  const rows = bars.filter((b) => finite(b?.t) && b.t % M1 === 0 && b.t + M1 <= now);
  const statements = [], parts = [];
  const tuple = `(${BROKER_BAR_COLUMNS.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += BROKER_ROWS_PER_STATEMENT) {
    const part = rows.slice(i, i + BROKER_ROWS_PER_STATEMENT);
    parts.push(part);
    statements.push(db.prepare(`INSERT OR IGNORE INTO broker_bars_1m (${BROKER_BAR_COLUMNS.join(", ")}) VALUES ${part.map(() => tuple).join(", ")}`)
      .bind(...part.flatMap((b) => [accountRef, source, b.t, b.o, b.h, b.l, b.c, finite(b.v) ? b.v : null, finite(b.s) ? b.s : null, Number.isInteger(digits) ? digits : null, finite(connectionVersion) ? connectionVersion : null, now, legacy ? 1 : 0])));
  }
  if (new Date(now).getUTCMinutes() === 0) statements.push(db.prepare("DELETE FROM broker_bars_1m WHERE minute_ms < ?").bind(now - BROKER_BARS_KEEP_DAYS * DAY));
  const results = await runAll(db, statements);
  let added = 0, from = null, to = null;
  parts.forEach((part, i) => {
    const n = Number(results[i]?.meta?.changes) || 0;
    if (n <= 0) return;
    added += n;
    from = from == null ? part[0].t : Math.min(from, part[0].t);
    to = to == null ? part.at(-1).t : Math.max(to, part.at(-1).t);
  });
  return { sent: rows.length, added, from_ms: from, to_ms: to, sent_from_ms: rows[0]?.t ?? null, sent_to_ms: rows.at(-1)?.t ?? null };
}

/**
 * The backfill (RFC §4.1; B2): the traded pair's corpus_bars rows (mt5:%, never mt5macro:%) of the active connection
 * version and of every version already archived for the account_ref and source, each group copied under its own
 * version (INSERT OR IGNORE: an archived minute is kept as it is), with the legacy flag of the account's live rows.
 * Once per identity (account_ref, source, versions; KV liquidity:backfill:v2:<identity>), so a new connection version
 * backfills again. The marker keeps the versions, the rows added and the minutes they span, and `rebuilt`; the ledger
 * step drives the baseline rebuild and the sweep replay from it, so a step that fails after the marker loses neither.
 * A failure writes no marker (the next step retries) and logs one liquidity_backfill_failed per identity. Never throws.
 */
export async function backfillBrokerBars(env, { accountRef, legacy = false, source, digits = null, connectionVersion = null, now = Date.now(), log = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv?.put || !accountRef || !source?.startsWith("mt5:")) return { status: "unavailable" };
  let identity = null;
  try {
    await ensureLiquiditySchema(db);
    // The archived versions: kept in KV, the archive scanned only when the active version is not among them.
    let known = null;
    try { known = JSON.parse((await kv.get(backfillVersionsKey(accountRef, source))) || "null")?.versions ?? null; } catch { known = null; }
    if (!Array.isArray(known) || (finite(connectionVersion) && !known.includes(connectionVersion))) {
      const archived = ((await db.prepare("SELECT DISTINCT connection_version AS v FROM broker_bars_1m WHERE account_ref = ? AND source = ? AND connection_version IS NOT NULL").bind(accountRef, source).all()).results ?? []).map((r) => Number(r.v));
      known = [...new Set([...(finite(connectionVersion) ? [connectionVersion] : []), ...archived].filter(finite))].sort((a, b) => a - b);
      if (known.length) await kv.put(backfillVersionsKey(accountRef, source), JSON.stringify({ at: new Date(now).toISOString(), versions: known }));
    }
    const versions = [...new Set(known.filter(finite))].sort((a, b) => a - b);
    if (!versions.length) return { status: "no_version" };
    identity = backfillIdentity(accountRef, source, versions);
    let marker = null;
    try { marker = JSON.parse((await kv.get(backfillKey(identity))) || "null"); } catch { marker = null; }
    if (marker && marker.status !== "copying") return { status: "done", identity, marker };
    // A copy that was cut off after its rows committed (the final marker was not written): copied again (adding
    // nothing), and its whole span is replayed and the baseline rebuilt, since what it added is no longer known.
    const resumed = marker?.status === "copying";
    await kv.put(backfillKey(identity), JSON.stringify({ status: "copying", at: new Date(now).toISOString(), versions }));
    // The legacy flag of the account's live rows (the bridge state can lag the executor's login hash).
    const live = await db.prepare("SELECT legacy_ref FROM broker_bars_1m WHERE account_ref = ? AND source = ? ORDER BY minute_ms DESC LIMIT 1").bind(accountRef, source).first();
    const flag = live ? Number(live.legacy_ref) === 1 : legacy;
    let sent = 0, added = 0, from = null, to = null, sentFrom = null, sentTo = null;
    for (const v of versions) {
      const rows = ((await db.prepare("SELECT minute_ms AS t, o, h, l, c, tick_volume AS v, spread_points AS s FROM corpus_bars WHERE source = ? AND connection_version = ? ORDER BY minute_ms").bind(source, v).all()).results) ?? [];
      const bars = rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: r.v == null ? null : Number(r.v), s: r.s == null ? null : Number(r.s) }));
      const r = await archiveBrokerRows(db, { accountRef, legacy: flag, source, digits, connectionVersion: v, bars, now });
      sent += r.sent; added += r.added;
      if (r.from_ms != null) { from = from == null ? r.from_ms : Math.min(from, r.from_ms); to = to == null ? r.to_ms : Math.max(to, r.to_ms); }
      if (r.sent_from_ms != null) { sentFrom = sentFrom == null ? r.sent_from_ms : Math.min(sentFrom, r.sent_from_ms); sentTo = sentTo == null ? r.sent_to_ms : Math.max(sentTo, r.sent_to_ms); }
    }
    marker = resumed && sent > 0
      ? { status: "copied", at: new Date(now).toISOString(), versions, sent, added, resumed: true, from_ms: sentFrom, to_ms: sentTo, rebuilt: false }
      : { status: "copied", at: new Date(now).toISOString(), versions, sent, added, from_ms: from, to_ms: to, rebuilt: added === 0 };
    await kv.put(backfillKey(identity), JSON.stringify(marker));
    return { status: "backfilled", identity, versions, sent, added, marker };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 160);
    try {
      if (identity && typeof log === "function" && !(await kv.get(backfillFailedKey(identity)))) {
        await log("liquidity_backfill_failed", { error });
        await kv.put(backfillFailedKey(identity), JSON.stringify({ at: new Date(now).toISOString() }), { expirationTtl: 30 * 86_400 });
      }
    } catch { /* the event is best effort */ }
    return { status: "failed", error, ...(identity ? { identity } : {}) };
  }
}

/** The ledger step marks a backfill's baseline rebuild done (the marker stays the backfill's record). */
export async function markBackfillRebuilt(env, identity, marker) {
  await env.SIGNAL_CACHE.put(backfillKey(identity), JSON.stringify({ ...marker, rebuilt: true }));
}

/** The archived bars of an account and source from `fromMs` (oldest first). */
export async function readBrokerBars(db, { accountRef, source, fromMs, toMs = Infinity, digits = undefined }) {
  await ensureLiquiditySchema(db);
  const to = finite(toMs) ? toMs : 8.64e15;
  const sql = `SELECT minute_ms AS t, o, h, l, c, tick_volume AS v, spread_points AS s, digits FROM broker_bars_1m WHERE account_ref = ? AND source = ? AND minute_ms >= ? AND minute_ms < ?${digits !== undefined ? " AND (digits = ? OR digits IS NULL)" : ""} ORDER BY minute_ms`;
  const st = db.prepare(sql);
  const rows = ((await (digits !== undefined ? st.bind(accountRef, source, fromMs, to, digits) : st.bind(accountRef, source, fromMs, to)).all()).results) ?? [];
  return rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: r.v == null ? null : Number(r.v), s: r.s == null ? null : Number(r.s) }));
}

// ---------------------------------------------------------------- the baseline

const quantiles = (list) => {
  const a = list.filter(finite).sort((x, y) => x - y);
  if (!a.length) return null;
  return Array.from({ length: QUANTILES }, (_, i) => { const p = (i / (QUANTILES - 1)) * (a.length - 1); const lo = Math.floor(p), hi = Math.ceil(p); return Math.round((a[lo] + (a[hi] - a[lo]) * (p - lo)) * 100) / 100; });
};
const median = (list) => { const a = list.filter(finite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
/** Pure: the share of a quantile function (101 values, 0..1) at or below x (a mid rank for ties). */
export function pctlFrom(q, x) {
  if (!Array.isArray(q) || !q.length || !finite(x)) return null;
  if (x < q[0]) return 0;
  if (x > q.at(-1)) return 1;
  let below = 0, equal = 0;
  for (const v of q) { if (v < x) below += 1; else if (v === x) equal += 1; }
  return r3((below + 0.5 * equal) / q.length);
}

/** Pure: the eligible minutes of each New York hour of the week, read on the week before `now` (not excluded). */
export function eligibleMinutes(now) {
  const out = {};
  const start = Math.floor((now - WEEK) / M1) * M1;
  for (let t = start; t < start + WEEK; t += M1) {
    if (excludedWhy(t)) continue;
    const h = nyHourOfWeek(t);
    out[h] = (out[h] ?? 0) + 1;
  }
  return out;
}

/**
 * Pure: the baseline of one New York hour of the week from its bars over the window: the quantiles of the M1 tick
 * volume and of the complete 15-minute sums, the median bar spread, and how many weeks held `minBars` bars or more.
 */
export function hourBaseline(bars, { minBars = BASELINE_MIN_BARS } = {}) {
  const v = [], s = [], weeks = new Map(), buckets = new Map();
  for (const b of bars) {
    if (excludedWhy(b.t)) continue;
    if (finite(b.v)) v.push(b.v);
    if (finite(b.s)) s.push(b.s);
    const w = Math.floor(b.t / WEEK);
    weeks.set(w, (weeks.get(w) ?? 0) + 1);
    const k = Math.floor(b.t / M15) * M15;
    const g = buckets.get(k) ?? { n: 0, sum: 0 };
    g.n += 1; g.sum += finite(b.v) ? b.v : 0;
    buckets.set(k, g);
  }
  const sums = [...buckets.values()].filter((g) => g.n >= 12).map((g) => g.sum);
  return { n: v.length, weeks: [...weeks.values()].filter((n) => n >= minBars).length, q1: quantiles(v), q15: quantiles(sums), spread_median: median(s) };
}

/** Pure: the identity a baseline belongs to; a change starts a new baseline (RFC §4.2). */
export const baselineIdentity = ({ accountRef, source, digits }) => `${accountRef}|${source}|${Number.isInteger(digits) ? digits : "?"}`;

/**
 * Pure: the whole baseline from the window's bars ({ t, v, s }, oldest first). `eligible` maps each hour of the week
 * to its eligible minutes (the 45-bar rule is held to 75 % of them where the exclusions leave fewer than 60).
 */
export function buildBaseline(bars, { identity, now, eligible = eligibleMinutes(now) } = {}) {
  const from = now - LIQUIDITY_BASELINE_WEEKS * WEEK;
  const byHour = new Map();
  for (const b of bars) {
    if (!(b.t >= from && b.t < now)) continue;
    const h = nyHourOfWeek(b.t);
    (byHour.get(h) ?? byHour.set(h, []).get(h)).push(b);
  }
  const hours = {};
  for (const [h, list] of byHour) hours[h] = hourBaseline(list, { minBars: Math.min(BASELINE_MIN_BARS, Math.floor(0.75 * (eligible[h] ?? 60))) });
  return finishBaseline({ identity, hours, eligible, now });
}
/** Pure: the baseline's sufficiency: every trading hour of the week holds LIQUIDITY_SUFFICIENT_WEEKS weeks. */
export function finishBaseline({ identity, hours, eligible, now, reset_at = null }) {
  const trading = Object.keys(eligible).map(Number);
  const weeks = trading.length ? Math.min(...trading.map((h) => hours[h]?.weeks ?? 0)) : 0;
  return { identity, updated_ms: now, hours, baseline: trading.length && weeks >= LIQUIDITY_SUFFICIENT_WEEKS ? "sufficient" : "insufficient", baseline_weeks: weeks, reset_at };
}

/**
 * Pure: the percentile of a value in its hour of the week (`which` "q1" or "q15"); while the baseline is insufficient
 * (or the hour has no data), the rolling fallback: the same New York hour of day across the available days (a
 * mixture of their quantile functions weighted by their bars), else every hour with data.
 */
export function baselinePctl(baseline, ms, x, which = "q1") {
  const hours = baseline?.hours ?? {};
  const h = nyHourOfWeek(ms);
  const own = hours[h];
  if (baseline?.baseline === "sufficient" && Array.isArray(own?.[which])) return { pctl: pctlFrom(own[which], x), basis: "hour_of_week" };
  const mix = (list) => {
    const used = list.filter((e) => Array.isArray(e?.[which]) && e.n > 0);
    const n = used.reduce((s, e) => s + e.n, 0);
    return n ? r3(used.reduce((s, e) => s + e.n * pctlFrom(e[which], x), 0) / n) : null;
  };
  const sameHour = Object.entries(hours).filter(([k]) => Number(k) % 24 === h % 24).map(([, e]) => e);
  const p = mix(sameHour);
  if (p != null) return { pctl: p, basis: "rolling_hour_of_day" };
  return { pctl: mix(Object.values(hours)), basis: "rolling_all" };
}
/** Pure: the median bar spread of the hour of the week (else the rolling fallback's median of medians). */
export function spreadMedian(baseline, ms) {
  const hours = baseline?.hours ?? {};
  const own = hours[nyHourOfWeek(ms)];
  if (finite(own?.spread_median) && own.spread_median > 0) return own.spread_median;
  const h = nyHourOfWeek(ms) % 24;
  const same = Object.entries(hours).filter(([k, e]) => Number(k) % 24 === h && finite(e?.spread_median) && e.spread_median > 0).map(([, e]) => e.spread_median);
  const m = median(same.length ? same : Object.values(hours).map((e) => e?.spread_median).filter((x) => finite(x) && x > 0));
  return finite(m) ? m : null;
}

// ---------------------------------------------------------------- bars to structure

/** Pure: M1 bars aggregated to `minutes`, complete buckets only, with the tick-volume sum: { t, o, h, l, c, v }. */
export function aggregate(bars, minutes) {
  const span = minutes * M1, groups = new Map();
  for (const b of bars) { const k = Math.floor(b.t / span) * span; (groups.get(k) ?? groups.set(k, []).get(k)).push(b); }
  const out = [];
  for (const [k, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (list.length < Math.max(1, Math.floor(minutes * 0.8))) continue;
    list.sort((a, b) => a.t - b.t);
    out.push({ t: k, o: list[0].o, h: Math.max(...list.map((x) => x.h)), l: Math.min(...list.map((x) => x.l)), c: list.at(-1).c, v: list.reduce((s, x) => s + (finite(x.v) ? x.v : 0), 0) });
  }
  return out;
}
/** Pure: ATR(14) of the closed 15m bars, or null. */
export function atr15(bars) {
  const b = aggregate(bars, 15);
  if (b.length < 15) return null;
  let sum = 0;
  for (let i = b.length - 14; i < b.length; i++) sum += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return sum / 14;
}
/** Pure: M5 fractals (two bars each side): { t (the center's open), confirmed_ms, kind: "high" | "low", price }. */
export function fractals(bars) {
  const m5 = aggregate(bars, 5), out = [];
  for (let i = 2; i < m5.length - 2; i++) {
    const x = m5[i], confirmed = m5[i + 2].t + 5 * M1;
    if (x.h > m5[i - 1].h && x.h > m5[i - 2].h && x.h >= m5[i + 1].h && x.h >= m5[i + 2].h) out.push({ t: x.t, confirmed_ms: confirmed, kind: "high", price: x.h });
    if (x.l < m5[i - 1].l && x.l < m5[i - 2].l && x.l <= m5[i + 1].l && x.l <= m5[i + 2].l) out.push({ t: x.t, confirmed_ms: confirmed, kind: "low", price: x.l });
  }
  return out;
}

/**
 * Pure: the reclaimed sweeps in `bars` (RFC §4.3): a wick beyond the prior swing high (buy side) or low (sell side)
 * confirmed within `lookbackMin` before the bar, on a bar whose tick volume is at or above `spikePctl` of its hour,
 * that closed back inside; excluded minutes do not count. Returns [{ t, side, extreme, swing, vol_pctl }] (internal:
 * the extreme is a broker price and stays in the Worker).
 */
export function detectSweeps(bars, { baseline, lookbackMin = 180, spikePctl = 0.95, fromMs = -Infinity } = {}) {
  const fr = fractals(bars), out = [];
  for (const b of bars) {
    if (b.t < fromMs || excludedWhy(b.t) || !finite(b.v)) continue;
    const vp = baselinePctl(baseline, b.t, b.v, "q1").pctl;
    if (!finite(vp) || vp < spikePctl) continue;
    const prior = fr.filter((f) => f.confirmed_ms <= b.t && f.t >= b.t - lookbackMin * M1);
    const highs = prior.filter((f) => f.kind === "high" && b.h > f.price && b.c < f.price).sort((x, y) => y.price - x.price);
    const lows = prior.filter((f) => f.kind === "low" && b.l < f.price && b.c > f.price).sort((x, y) => x.price - y.price);
    if (highs.length) out.push({ t: b.t, side: "buy_side", extreme: b.h, swing: highs[0].price, close: b.c, vol_pctl: vp });
    if (lows.length) out.push({ t: b.t, side: "sell_side", extreme: b.l, swing: lows[0].price, close: b.c, vol_pctl: vp });
  }
  return out;
}

/** Pure: equal highs and lows not yet taken (RFC §4.3): groups of two or more swings within tol of each other. */
export function poolsOf(bars, { tol, price }) {
  const fr = fractals(bars), out = [];
  if (!finite(tol) || tol <= 0) return out;
  for (const kind of ["high", "low"]) {
    const list = fr.filter((f) => f.kind === kind).sort((a, b) => a.price - b.price);
    let group = [];
    const flush = () => {
      if (group.length >= 2) {
        const lo = Math.min(...group.map((g) => g.price)), hi = Math.max(...group.map((g) => g.price));
        const after = Math.max(...group.map((g) => g.confirmed_ms));
        const taken = bars.some((b) => b.t >= after && (kind === "high" ? b.h > hi : b.l < lo));
        if (!taken) out.push({ kind, low: lo, high: hi, swings: group.length, side: finite(price) ? (lo > price ? "above" : hi < price ? "below" : "at") : null });
      }
      group = [];
    };
    for (const f of list) { if (group.length && f.price - group[0].price > tol) flush(); group.push(f); }
    flush();
  }
  return out;
}

/** Pure: the high-volume nodes of the tick-volume profile (bins of `bin` wide; a node at or above `pctl` of the bins). */
export function hvnOf(bars, { bin, pctl = 0.85, price }) {
  if (!finite(bin) || bin <= 0 || !bars.length) return [];
  const lo = Math.min(...bars.map((b) => b.l)), vol = new Map();
  for (const b of bars) {
    if (!finite(b.v) || b.v <= 0) continue;
    const a = Math.floor((b.l - lo) / bin), z = Math.floor((b.h - lo) / bin), k = z - a + 1;
    for (let i = a; i <= z; i++) vol.set(i, (vol.get(i) ?? 0) + b.v / k);
  }
  const vals = [...vol.values()].sort((x, y) => x - y);
  if (vals.length < 5) return [];
  const cut = vals[Math.min(vals.length - 1, Math.floor(pctl * (vals.length - 1)))];
  const nodes = [...vol.entries()].filter(([, v]) => v >= cut).map(([i]) => i).sort((x, y) => x - y);
  const zones = [];
  for (const i of nodes) {
    const last = zones.at(-1);
    if (last && i === last.to + 1) last.to = i; else zones.push({ from: i, to: i });
  }
  return zones.map((z) => { const low = lo + z.from * bin, high = lo + (z.to + 1) * bin; return { low, high, side: finite(price) ? (low > price ? "above" : high < price ? "below" : "at") : null }; });
}

// ---------------------------------------------------------------- the facts

const round2 = (x) => Math.round(x * 100) / 100;
/**
 * Pure: lens B's facts (RFC §4.3) for the last closed bar, from the account's bars (oldest first, M1 { t, o, h, l, c,
 * v, s }), its baseline and the mode's knobs. `liveSpread` is the executor's live spread in points (else the last bar's).
 * Returns { facts (no price), levels ([{ low, high, kind }], broker scale, internal), sweeps }.
 */
export function liquidityFacts({ bars = [], baseline = null, knobs = {}, now = Date.now(), liveSpread = null } = {}) {
  const k = { spike_pctl: 0.95, thin_pctl: 0.2, spread_widen: 2, sweep_lookback_min: 180, pool_tol_atr: 0.05, hvn_pctl: 0.85, profile_window_min: 1440, ...knobs };
  const closed = bars.filter((b) => b.t + M1 <= now);
  const last = closed.at(-1);
  const base = { baseline: baseline?.baseline ?? "insufficient", baseline_weeks: baseline?.baseline_weeks ?? 0, baseline_reset_at: baseline?.reset_at ?? null };
  if (!last || now - last.t > 30 * M1) return { facts: { available: false, reason: last ? "archive_stale" : "no_bars", ...base }, levels: [], sweeps: [] };
  const excluded = excludedWhy(last.t);
  const vp = baselinePctl(baseline, last.t, last.v, "q1");
  const lastBucket = Math.floor((last.t + M1) / M15) * M15 - M15;
  const bucket = closed.filter((b) => b.t >= lastBucket && b.t < lastBucket + M15);
  const sum15 = bucket.length >= 12 ? bucket.reduce((s, b) => s + (finite(b.v) ? b.v : 0), 0) : null;
  const vp15 = finite(sum15) ? baselinePctl(baseline, lastBucket, sum15, "q15") : { pctl: null, basis: vp.basis };
  const med = spreadMedian(baseline, now);
  const spread = finite(liveSpread) ? liveSpread : last.s;
  const ratio = finite(spread) && finite(med) && med > 0 ? r3(spread / med) : null;
  const atr = atr15(closed);
  const price = last.c;
  const sweepsAll = detectSweeps(closed, { baseline, lookbackMin: k.sweep_lookback_min, spikePctl: k.spike_pctl, fromMs: now - 60 * M1 });
  const sweep = sweepsAll.at(-1) ?? null;
  const window = closed.filter((b) => b.t >= now - k.profile_window_min * M1);
  const pools = finite(atr) ? poolsOf(window, { tol: k.pool_tol_atr * atr, price }) : [];
  const nodes = finite(atr) ? hvnOf(window, { bin: 0.1 * atr, pctl: k.hvn_pctl, price }) : [];
  const facts = {
    available: true, ...base, basis: vp.basis, minute_at: new Date(last.t).toISOString(),
    vol_pctl: vp.pctl, vol_pctl_15m: vp15.pctl,
    vol_spike: !excluded && finite(vp.pctl) && vp.pctl >= k.spike_pctl,
    thin: !excluded && finite(vp15.pctl) && vp15.pctl <= k.thin_pctl,
    spread_ratio: ratio, spread_spike: finite(ratio) && ratio >= k.spread_widen,
    sweep: sweep ? { side: sweep.side, age_min: Math.round((now - sweep.t - M1) / M1), vol_pctl: sweep.vol_pctl, reclaimed: true } : null,
    pools: { above: pools.filter((p) => p.side === "above").length, below: pools.filter((p) => p.side === "below").length, equal_highs: pools.filter((p) => p.kind === "high").length, equal_lows: pools.filter((p) => p.kind === "low").length },
    hvn: { inside: nodes.some((n) => n.side === "at"), above: nodes.filter((n) => n.side === "above").length, below: nodes.filter((n) => n.side === "below").length },
    ...(excluded ? { excluded } : {})
  };
  const levels = [
    ...sweepsAll.slice(-3).map((s) => ({ low: round2(s.extreme), high: round2(s.extreme), kind: "sweep" })),
    ...pools.map((p) => ({ low: round2(p.low), high: round2(p.high), kind: "pool" })),
    ...nodes.map((n) => ({ low: round2(n.low), high: round2(n.high), kind: "hvn" }))
  ].sort((a, b) => Math.abs((a.low + a.high) / 2 - price) - Math.abs((b.low + b.high) / 2 - price)).slice(0, 12).sort((a, b) => a.low - b.low);
  return { facts, levels, sweeps: sweepsAll };
}

/** Pure: a side's sweep evidence (RFC §5.2): "sweep_with" (a reclaimed sell-side sweep for a long, buy-side for a short) within 15 minutes, "sweep_against", or null. */
export function sweepFor(facts, side) {
  const s = facts?.sweep;
  if (!s || !finite(s.age_min) || s.age_min > SWEEP_WITH_MAX_AGE_MIN) return null;
  const buy = side === "BUY" || side === "long" || side === 1;
  if (s.side === (buy ? "sell_side" : "buy_side")) return "sweep_with";
  return "sweep_against";
}

/** Pure: the 15m and 1H rooms' line (RFC §4.3): words and counts, never a price. */
export function liquidityLine(facts) {
  if (!facts?.available) return `Liquidity (broker M1): ${facts?.reason === "archive_stale" ? "no recent broker bars" : "no broker bars yet"}.`;
  const pct = (p) => (finite(p) ? `${Math.round(p * 100)}th percentile` : "unmeasured");
  const parts = [
    `tick volume at the ${pct(facts.vol_pctl)} of its hour${facts.vol_spike ? " (a spike)" : ""}`,
    `the last 15 minutes at the ${pct(facts.vol_pctl_15m)}${facts.thin ? " (thin)" : ""}`,
    finite(facts.spread_ratio) ? `spread ${facts.spread_ratio}x the hour's norm${facts.spread_spike ? " (widened)" : ""}` : "spread norm unmeasured",
    facts.sweep ? `a reclaimed ${facts.sweep.side === "buy_side" ? "buy-side" : "sell-side"} sweep ${facts.sweep.age_min} minutes ago` : "no sweep",
    `equal highs/lows untaken: ${facts.pools.above} above, ${facts.pools.below} below`,
    `high-volume nodes: ${facts.hvn.above} above, ${facts.hvn.below} below${facts.hvn.inside ? ", price inside one" : ""}`
  ];
  return `Liquidity (broker M1, baseline: ${facts.baseline}${facts.baseline !== "sufficient" ? `, ${facts.baseline_weeks} of ${LIQUIDITY_SUFFICIENT_WEEKS} weeks` : ""}): ${parts.join("; ")}.${facts.excluded ? ` Excluded minute (${facts.excluded}).` : ""}`;
}

// ---------------------------------------------------------------- the conditions (B16: the 15m and 1H risk desks and moderators)

/**
 * A number shaped like a price: three to five digits, with or without decimals. Lens B's conditions never carry one
 * (words, percentiles, ratios and counts only), and liquidityConditions refuses a line that would.
 */
export const PRICE_SHAPED = /\b\d{3,5}(\.\d+)?\b/;
const ordinal = (n) => { const t = n % 100; return `${n}${t >= 11 && t <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] ?? "th"}`; };
const pctlWord = (p) => (finite(p) ? ordinal(Math.max(0, Math.min(100, Math.round(p * 100)))) : null);
const r1 = (v) => (finite(v) ? Math.round(v * 10) / 10 : null);
const r2c = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);
const timesWord = (x) => (!finite(x) ? null : x >= 10 ? "more than 10 times" : `${r1(x)} times`);
const countWord = (n) => (finite(n) && n >= 0 ? (n > 99 ? "many" : String(Math.round(n))) : "0");
const count = (n) => (finite(n) && n >= 0 ? Math.round(n) : 0);

/**
 * Pure: the session liquidity at an instant (src/market-hours.mjs SESSIONS, as the Decision Engine's sessionAt reads it):
 * "high" in an overlap, "normal" in one session, "thin" between sessions, "paused" in the daily pause, "closed".
 */
export function sessionLiquidity(ms) {
  if (!finite(ms)) return { names: [], overlap: false, liquidity: null };
  if (goldClosedAt(ms)) return { names: [], overlap: false, liquidity: "closed" };
  if (goldPausedAt(ms)) return { names: [], overlap: false, liquidity: "paused" };
  const h = nyHour(ms);
  const names = SESSIONS.filter((x) => (h >= x.from && h < x.to) || (h + 24 >= x.from && h + 24 < x.to)).map((x) => x.name);
  return { names, overlap: names.length > 1, liquidity: names.length > 1 ? "high" : names.length ? "normal" : "thin" };
}

/**
 * Pure: whether the rooms read lens B's conditions (the same gates as the Decision Engine's liquidityEvidence and the
 * LIQUIDITY card): lens B on and above its floor (`knobs.active`), its facts available and its state at most
 * LIQUIDITY_STATE_FRESH_MS old.
 */
export function liquidityConditionsOn(state, knobs, now = Date.now()) {
  return Boolean(knobs?.active && state?.facts?.available === true && now - Number(state.at_ms) <= LIQUIDITY_STATE_FRESH_MS);
}

/**
 * Pure: lens B's liquidity conditions in plain words (B16), for the 15m and 1H rooms' risk desk and moderator, their
 * stored brief and GET /api/liquidity: the spread against its norm for this New York hour of the week, the depth (the
 * last 15 minutes' tick volume, thin or not), the minute's tick volume, the session's liquidity and where price sits
 * against lens B's levels (inside a high-volume node or not; the untaken equal-high/low pools and nodes above and below,
 * as counts). The flags are the facts' own (measured at the ledger step); the thresholds are the mode's knobs in force.
 * No sweep (the LIQUIDITY council card's, B15) and no price: words, percentiles, ratios and counts, never a number shaped
 * like a price (PRICE_SHAPED; a line that would carry one is refused: null). Null without available facts.
 */
export function liquidityConditions(facts, { knobs = null, stateAtMs = null, now = Date.now() } = {}) {
  if (!facts || facts.available !== true) return null;
  const k = knobs && typeof knobs === "object" ? knobs : {};
  const ratio = r2c(facts.spread_ratio);
  const widen = finite(k.spread_widen) ? k.spread_widen : null;
  const spread = { ratio, widen, state: !finite(ratio) ? "unmeasured" : facts.spread_spike === true ? "widened" : "normal" };
  const thinAt = finite(k.thin_pctl) ? k.thin_pctl : null;
  const depth = { vol_pctl_15m: finite(facts.vol_pctl_15m) ? facts.vol_pctl_15m : null, thin_pctl: thinAt, state: !finite(facts.vol_pctl_15m) ? "unmeasured" : facts.thin === true ? "thin" : "normal" };
  const spikeAt = finite(k.spike_pctl) ? k.spike_pctl : null;
  const activity = { vol_pctl: finite(facts.vol_pctl) ? facts.vol_pctl : null, spike_pctl: spikeAt, state: !finite(facts.vol_pctl) ? "unmeasured" : facts.vol_spike === true ? "spike" : "normal" };
  const at = Date.parse(String(facts.minute_at ?? ""));
  const session = { ...sessionLiquidity(Number.isFinite(at) ? at : finite(stateAtMs) ? stateAtMs : now), excluded: typeof facts.excluded === "string" ? facts.excluded : null };
  const pools = facts.pools ?? {}, hvn = facts.hvn ?? {};
  const poolsAt = Math.max(0, count(pools.equal_highs) + count(pools.equal_lows) - count(pools.above) - count(pools.below));
  const levels = { inside_node: hvn.inside === true, nodes_above: count(hvn.above), nodes_below: count(hvn.below), pools_above: count(pools.above), pools_below: count(pools.below), pools_at: poolsAt };
  const baseline = facts.baseline === "sufficient" ? "sufficient" : "insufficient";
  const weeks = finite(facts.baseline_weeks) ? facts.baseline_weeks : 0;

  const spreadText = spread.state === "unmeasured" ? "spread against its norm unmeasured"
    : `spread ${timesWord(facts.spread_ratio)} its norm for this hour of the week, ${spread.state}${finite(widen) ? ` (widened at ${timesWord(widen)} or more)` : ""}`;
  const depthText = depth.state === "unmeasured" ? "depth unmeasured"
    : `depth ${depth.state}: the last 15 minutes' tick volume at the ${pctlWord(depth.vol_pctl_15m)} percentile of its hour${finite(thinAt) ? ` (thin at or below the ${pctlWord(thinAt)})` : ""}`;
  const activityText = activity.state === "unmeasured" ? "the minute's tick volume unmeasured"
    : `the minute's tick volume at the ${pctlWord(activity.vol_pctl)} percentile${activity.state === "spike" ? ", a spike" : ", no spike"}`;
  const sessionText = session.liquidity === "closed" ? "session: market closed" : session.liquidity === "paused" ? "session: the daily trading pause"
    : `session: ${session.names.length ? session.names.join(" and ") + (session.overlap ? " overlap" : "") : "between sessions"}, ${session.liquidity} liquidity`;
  const levelText = `levels: price ${levels.inside_node ? "inside" : "outside"} a high-volume node (${countWord(levels.nodes_above)} above, ${countWord(levels.nodes_below)} below); untaken equal highs/lows ${countWord(levels.pools_above)} above, ${countWord(levels.pools_below)} below${levels.pools_at ? `, ${countWord(levels.pools_at)} at price` : ""}`;
  const head = `Liquidity conditions (broker M1${k.mode ? `, ${k.mode} mode` : ""}, baseline: ${baseline}${baseline !== "sufficient" ? `, ${countWord(weeks)} of ${LIQUIDITY_SUFFICIENT_WEEKS} weeks` : ""})`;
  const line = `${head}: ${[spreadText, depthText, activityText, sessionText, levelText].join("; ")}.${session.excluded ? ` The minute is excluded from the baseline (${session.excluded.replace(/_/g, " ")}).` : ""}`;
  if (PRICE_SHAPED.test(line) || /sweep/i.test(line)) return null;
  return { mode: typeof k.mode === "string" ? k.mode : null, baseline, baseline_weeks: weeks, spread, depth, activity, session, levels, line };
}

// ---------------------------------------------------------------- the signal's flat fields and the live spread

/**
 * Pure: the signal's flat liquidity fields (RFC §4.4, §5): the levels ("low:high:kind" joined by ",", broker scale),
 * the median spread of this hour of the week and the mode's widen threshold (Omega compares its live spread), and
 * whether the lens is on (the switch, the weight above its floor, a fresh state). The EA ignores them.
 */
export function liquidityFields(state, { now = Date.now(), knobs = null } = {}) {
  const fresh = state && finite(state.at_ms) && now - state.at_ms <= LIQUIDITY_STATE_FRESH_MS && state.facts?.available === true;
  const on = Boolean(fresh && knobs?.active);
  const med = on ? (finite(state.medians?.[nyHourOfWeek(now)]) ? state.medians[nyHourOfWeek(now)] : finite(state.median_any) ? state.median_any : null) : null;
  return {
    liquidity_on: on,
    liquidity_weight: on ? knobs.weight : 0,
    liquidity_levels: on ? (state.levels || []).filter((z) => finite(z?.low) && finite(z?.high) && z.low <= z.high && ["sweep", "pool", "hvn"].includes(z.kind)).map((z) => `${z.low}:${z.high}:${z.kind}`).join(",") : "",
    liquidity_spread_median: finite(med) && med > 0 ? med : 0,
    liquidity_spread_widen: on && finite(knobs.spread_widen) ? knobs.spread_widen : 0,
    liquidity_sweep: on && state.facts?.sweep && state.facts.sweep.age_min <= SWEEP_WITH_MAX_AGE_MIN ? state.facts.sweep.side : "",
    liquidity_sweep_age_min: on && state.facts?.sweep ? state.facts.sweep.age_min + Math.round((now - state.at_ms) / M1) : -1,
    liquidity_thin: on && state.facts?.thin === true
  };
}

/** Pure (B18): lens B's levels on the feed's scale (broker − basis, cents), the same order; [] without a finite basis. */
export function levelsOnFeed(levels, basis) {
  if (!finite(basis) || !Array.isArray(levels)) return [];
  const r2 = (v) => Math.round(v * 100) / 100;
  return levels.filter((z) => finite(z?.low) && finite(z?.high) && z.low <= z.high).map((z) => ({ low: r2(z.low - basis), high: r2(z.high - basis), kind: z.kind }));
}

/** Pure: the liquidity levels of a signal ([{ low, high, kind, source: "liquidity" }], broker scale), or []. */
export function signalLiquidityLevels(signal) {
  if (signal?.liquidity_on !== true || typeof signal.liquidity_levels !== "string" || !signal.liquidity_levels) return [];
  const out = [];
  for (const part of signal.liquidity_levels.split(",")) {
    const [lo, hi, kind] = part.split(":");
    const low = Number(lo), high = Number(hi);
    if (finite(low) && finite(high) && low > 0 && low <= high && ["sweep", "pool", "hvn"].includes(kind)) out.push({ low, high, source: "liquidity", kind });
  }
  return out;
}

/** Pure: the live spread ratio against the hour's norm (the entry gate and the deferral), or null. */
export function liveSpreadRatio(signal, sym) {
  if (signal?.liquidity_on !== true) return null;
  const med = Number(signal.liquidity_spread_median);
  const sp = Number(sym?.spread_points);
  return finite(med) && med > 0 && finite(sp) && sp >= 0 ? sp / med : null;
}
/** Pure: whether the live spread spikes (RFC §5.1): the lens on and the ratio at or above the mode's spread_widen. */
export function liveSpreadSpike(signal, sym) {
  const r = liveSpreadRatio(signal, sym);
  const w = Number(signal?.liquidity_spread_widen);
  return finite(r) && finite(w) && w > 0 && r >= w;
}

/** The modify kinds a spike defers (RFC §6); closes, kill, pause, the fill guard and hard-guard stops never wait. */
export const DEFERRABLE_KINDS = Object.freeze(["modify_sl", "modify_tp", "modify_sltp"]);
/**
 * Pure: the planner's intents with the deferrable modifications held back while the live spread spikes, for at most
 * LIQUIDITY_MODIFY_DEFER_MAX_MS from the spike's start (`spikeSinceMs`). An intent marked `hard` (a stop a hard guard
 * requires) is never held. Returns { intents, deferred }.
 */
export function deferModifications(intents, { spike = false, spikeSinceMs = null, now = Date.now() } = {}) {
  const since = finite(spikeSinceMs) ? spikeSinceMs : now;
  if (!spike || now - since >= LIQUIDITY_MODIFY_DEFER_MAX_MS) return { intents, deferred: [] };
  const kept = [], deferred = [];
  for (const it of intents) (DEFERRABLE_KINDS.includes(it?.kind) && it.hard !== true ? deferred : kept).push(it);
  return { intents: kept, deferred };
}

// ---------------------------------------------------------------- the sweep's outcome (RFC §7.2, lens B)

/**
 * Pure: one sweep scored on the bars after it: hit when price moves SWEEP_SCORE_ATR x ATR(14, 15m) in the reversal's
 * direction (down after a buy-side sweep) before it trades beyond the sweep's extreme, within eight 15m bars; miss when
 * beyond the extreme first; neutral when neither; null while the horizon is open.
 */
export function scoreSweep(sweep, after, { atr, now = Date.now() } = {}) {
  if (!sweep || !finite(atr) || atr <= 0) return "neutral";
  const end = sweep.t + M1 + SWEEP_SCORE_BARS_15M * M15;
  const down = sweep.side === "buy_side";
  const ref = finite(sweep.close) ? sweep.close : sweep.swing;
  for (const b of after) {
    if (b.t <= sweep.t || b.t >= end) continue;
    const beyond = down ? b.h > sweep.extreme : b.l < sweep.extreme;
    const moved = down ? ref - b.l >= SWEEP_SCORE_ATR * atr : b.h - ref >= SWEEP_SCORE_ATR * atr;
    // A bar that does both is counted beyond the extreme first (conservative, as a stop and a target in one bar).
    if (beyond) return "miss";
    if (moved) return "hit";
  }
  return now >= end ? "neutral" : null;
}

/** B19: a hold reading's window (closed 15m bars after the stop move) and its tolerance beyond the level (x ATR15). */
export const LEVEL_HOLD_BARS_15M = 8;
export const LEVEL_HOLD_ATR = 0.1;
/**
 * Pure (B19): a stop moved to a lens B level, scored on the broker's M1 bars (the stop's own scale). `side` is the
 * position's (1 long: the stop below, -1 short). The window is the LEVEL_HOLD_BARS_15M closed 15m bars from the first
 * quarter-hour at or after the move; ATR15 over the bars before it. A close more than LEVEL_HOLD_ATR x ATR beyond the
 * level against the position is a miss; all the window's bars without one is a hit; no ATR, or a window with bars
 * missing once it is over, is neutral; null while the window is open.
 */
export function scoreLevelHold({ level, side, created_ms, bars = [], now = Date.now() } = {}) {
  if (!finite(level) || (side !== 1 && side !== -1) || !finite(created_ms)) return "neutral";
  const start = Math.ceil(created_ms / M15) * M15, end = start + LEVEL_HOLD_BARS_15M * M15;
  const list = Array.isArray(bars) ? bars : [];
  const atr = atr15(list.filter((b) => b.t < start));
  if (!finite(atr) || atr <= 0) return "neutral";
  // Closed 15m bars only: a bar still forming at `now` is not read (closed-candle rule).
  const closedTo = Math.min(end, Math.floor(now / M15) * M15);
  const after = aggregate(list.filter((b) => b.t >= start && b.t < closedTo), 15);
  const tol = LEVEL_HOLD_ATR * atr;
  for (const b of after) if (side > 0 ? b.c < level - tol - 1e-9 : b.c > level + tol + 1e-9) return "miss";
  if (now < end) return null;
  return after.length >= LEVEL_HOLD_BARS_15M ? "hit" : "neutral";
}

// ---------------------------------------------------------------- the state the readers share

/** The stored state (KV liquidity:state:v1), or null. */
export async function readLiquidityState(env) {
  try { return JSON.parse((await env?.SIGNAL_CACHE?.get?.(LIQUIDITY_STATE_KEY)) || "null"); } catch { return null; }
}
