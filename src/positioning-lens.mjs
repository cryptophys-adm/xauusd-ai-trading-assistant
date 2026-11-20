// Lens A of the Positioning & Liquidity analyst (docs/RFC_POSITIONING_LIQUIDITY.md §3): how the large speculators
// stand in gold futures, from the CFTC Commitments of Traders report (COMEX gold, market code 088691), weekly and free,
// with no model call. Owner 2026-11-20: "Sekarang breakglass urgent jadi langsung live": live in every role at once,
// its weight per mode moved by Aether within hard bounds (src/lens-policy.mjs), the owner's switch
// `positioning_enabled` (default on) turns it off at once.
//
//   fetch      publicreporting.cftc.gov (Socrata, public, no key): the disaggregated futures-only report (72hh-3qpy)
//              and the legacy one (6dca-aqww) as the fallback; one request each, the calendar's budget pattern.
//   storage    D1 cot_reports (series, report_date), created lazily; a revision keeps its released_ms.
//   time       cotAt(t): the newest row with released_ms <= t, never the newest report_date <= t (§3.2).
//   facts      managed-money net, its week's change, its 156-week percentile, the change's z, open interest, crowding,
//              divergence, provenance; never a price (the feed's D1 closes are read inside, never emitted).
//   witness    POSITIONING (src/decision-engine.mjs), a capped lean, no hourly decay, stale after 14 days.

import { scoreStance } from "./outcome-scoring.mjs";

export const COT_HOST = "publicreporting.cftc.gov";
export const COT_MARKET_CODE = "088691";
export const COT_SERIES = Object.freeze({
  disaggregated: Object.freeze({ dataset: "72hh-3qpy", long: "m_money_positions_long_all", short: "m_money_positions_short_all", dlong: "change_in_m_money_long_all", dshort: "change_in_m_money_short_all" }),
  legacy: Object.freeze({ dataset: "6dca-aqww", long: "noncomm_positions_long_all", short: "noncomm_positions_short_all", dlong: "change_in_noncomm_long_all", dshort: "change_in_noncomm_short_all" })
});
/** The first run: three years plus one (RFC §3.1 Refinement: full three-year windows behind the day-one score). */
export const COT_BACKFILL_LIMIT = 260;
export const COT_LIVE_LIMIT = 6;
export const COT_PCTL_WEEKS = 156;
export const COT_STALE_DAYS = 14;
export const COT_KEEP_DAYS = 5 * 366;
export const POSITIONING_LEAN_CAP = 0.6;
export const POSITIONING_SCORE_HORIZON = 6;
export const COT_BACKFILL_KEY = "cot:backfill:v1";
export const COT_FETCH_LAST_KEY = "cot:fetch:last";
export const COT_FETCH_FAILS_KEY = "cot:fetch:fails";
export const COT_WEEK_CAP = 30;
/**
 * Weeks whose report came out late for a known publication outage, by report date with the real release day (New York
 * 15:30), from CFTC's own release schedule. Empty: the per-week catch-up days of the 2025 shutdown are not read from
 * cftc.gov yet; COT_PUBLICATION_OUTAGES holds those weeks back conservatively until then.
 */
export const COT_DELAYED_RELEASES = Object.freeze({});
/**
 * Publication outages whose per-week days are not listed (orchestrator review of #505): every report dated inside the
 * window counts as released no earlier than the end of the catch-up, New York 15:30 (the conservative choice: a replay
 * may read such a report late, never before it was public). 2025: the shutdown from 1 October stopped the report from
 * the one of 30 September; CFTC resumed on 19 November and published the backlog in chronological order, cleared by the
 * release of 29 December 2025 (CFTC press release 9138-25 and its accelerated revision), the one of the report of 23
 * December (Christmas week: Monday 29 December).
 */
export const COT_PUBLICATION_OUTAGES = Object.freeze([
  Object.freeze({ first_report: "2025-09-30", last_report: "2025-12-23", released_by: "2025-12-29" })
]);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r3 = (v) => (finite(v) ? Math.round(v * 1000) / 1000 : null);
const num = (v) => { const x = Number(v); return v != null && v !== "" && Number.isFinite(x) ? x : null; };

// ---------------------------------------------------------------- New York time and the release schedule

const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const nyParts = (ms) => Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
/** Pure: the UTC instant of a New York wall-clock time (handles US daylight time). */
export function nyToUtc(y, m, d, hh = 0, mm = 0) {
  let t = Date.UTC(y, m - 1, d, hh + 5, mm);
  for (let i = 0; i < 2; i++) {
    const p = nyParts(t);
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    t += Date.UTC(y, m - 1, d, hh, mm) - shown;
  }
  return t;
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);
const nthWeekday = (y, month, weekday, n) => { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return Date.UTC(y, month - 1, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7); };
const lastWeekday = (y, month, weekday) => { const last = new Date(Date.UTC(y, month, 0)); return Date.UTC(y, month - 1, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7)); };
const observed = (ms) => { const w = new Date(ms).getUTCDay(); return w === 6 ? ms - DAY : w === 0 ? ms + DAY : ms; };
/** Pure: the US federal holidays (observed) of a year, as YYYY-MM-DD. */
export function usFederalHolidays(y) {
  const f = (m, d) => observed(Date.UTC(y, m - 1, d));
  return new Set([f(1, 1), nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), lastWeekday(y, 5, 1), f(6, 19), f(7, 4), nthWeekday(y, 9, 1, 1), nthWeekday(y, 10, 1, 2), f(11, 11), nthWeekday(y, 11, 4, 4), f(12, 25), observed(Date.UTC(y + 1, 0, 1))].map(ymd));
}
/**
 * Pure: the scheduled release of the report of a Tuesday `reportDate` (YYYY-MM-DD): Friday 15:30 New York time, moved
 * to the following Monday 15:30 when a US federal holiday falls in that Monday-to-Friday week; a week listed in
 * COT_DELAYED_RELEASES reads its listed day; a week inside a COT_PUBLICATION_OUTAGES window is held to the end of the
 * catch-up. Returns { ms, estimated }.
 */
export function scheduledReleaseMs(reportDate, { delayed = COT_DELAYED_RELEASES, outages = COT_PUBLICATION_OUTAGES } = {}) {
  const d = String(reportDate).slice(0, 10);
  const at1530 = (day) => { const [y, m, dd] = String(day).slice(0, 10).split("-").map(Number); return nyToUtc(y, m, dd, 15, 30); };
  const listed = delayed[d];
  if (listed) return { ms: at1530(listed), estimated: false, listed: true };
  const normal = normalReleaseMs(d);
  const outage = (outages || []).find((o) => d >= o.first_report && d <= o.last_report);
  if (outage) return { ms: Math.max(normal, at1530(outage.released_by)), estimated: true, listed: false, outage: true };
  return { ms: normal, estimated: true, listed: false };
}
function normalReleaseMs(d) {
  const tue = dayMs(d);
  const mon = tue - DAY, fri = tue + 3 * DAY;
  const hol = new Set([...usFederalHolidays(new Date(mon).getUTCFullYear()), ...usFederalHolidays(new Date(fri).getUTCFullYear())]);
  let holiday = false;
  for (let t = mon; t <= fri; t += DAY) if (hol.has(ymd(t))) holiday = true;
  const day = new Date(holiday ? tue + 6 * DAY : fri);
  return nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 15, 30);
}

// ---------------------------------------------------------------- rows and storage

/** Pure: Socrata rows of one series as stored rows (net = long - short; the week's change from the change fields). */
export function parseCotRows(series, rows) {
  const s = COT_SERIES[series];
  if (!s) return [];
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (String(r?.cftc_contract_market_code ?? COT_MARKET_CODE).trim() !== COT_MARKET_CODE) continue;
    const date = String(r?.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const L = num(r[s.long]), S = num(r[s.short]);
    if (L == null || S == null) continue;
    const dL = num(r[s.dlong]), dS = num(r[s.dshort]);
    out.push({ series, report_date: date, market_code: COT_MARKET_CODE, oi: num(r.open_interest_all), oi_change: num(r.change_in_open_interest_all), net_long: L, net_short: S, net: L - S, net_change: dL != null && dS != null ? dL - dS : null });
  }
  return out.sort((a, b) => a.report_date.localeCompare(b.report_date));
}

export const COT_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cot_reports (
    series TEXT NOT NULL,
    report_date TEXT NOT NULL,
    market_code TEXT NOT NULL,
    oi INTEGER, oi_change INTEGER,
    net_long INTEGER NOT NULL, net_short INTEGER NOT NULL, net INTEGER NOT NULL, net_change INTEGER,
    released_ms INTEGER NOT NULL,
    released_estimated INTEGER NOT NULL DEFAULT 0,
    first_seen_ms INTEGER NOT NULL,
    revised_ms INTEGER,
    PRIMARY KEY (series, report_date)
  )`,
  "CREATE INDEX IF NOT EXISTS cot_reports_released ON cot_reports (series, released_ms)"
]);
let schemaReady = null;
export function resetCotSchemaForTests() { schemaReady = null; }
export async function ensureCotSchema(db) {
  if (schemaReady === db) return;
  for (const q of COT_SCHEMA_SQL) await db.prepare(q).run();
  schemaReady = db;
}

/**
 * Stores parsed rows. A new row seen live (`backfill` false) is released at max(scheduled release, first seen); a
 * backfilled one at its scheduled release, marked estimated unless listed. An existing row keeps released_ms and
 * first_seen_ms; changed values are replaced and revised_ms set. Returns { added, revised }.
 */
export async function storeCotRows(db, rows, { now = Date.now(), backfill = false } = {}) {
  await ensureCotSchema(db);
  let added = 0, revised = 0;
  for (const r of rows) {
    const prev = await db.prepare("SELECT oi, oi_change, net_long, net_short, net_change FROM cot_reports WHERE series = ? AND report_date = ?").bind(r.series, r.report_date).first();
    if (prev) {
      const same = Number(prev.net_long) === r.net_long && Number(prev.net_short) === r.net_short && (prev.oi == null ? null : Number(prev.oi)) === r.oi && (prev.net_change == null ? null : Number(prev.net_change)) === r.net_change && (prev.oi_change == null ? null : Number(prev.oi_change)) === r.oi_change;
      if (!same) {
        await db.prepare("UPDATE cot_reports SET oi = ?, oi_change = ?, net_long = ?, net_short = ?, net = ?, net_change = ?, revised_ms = ? WHERE series = ? AND report_date = ?")
          .bind(r.oi, r.oi_change, r.net_long, r.net_short, r.net, r.net_change, now, r.series, r.report_date).run();
        revised += 1;
      }
      continue;
    }
    const sched = scheduledReleaseMs(r.report_date);
    const live = !backfill;
    const released = live ? Math.max(sched.ms, now) : sched.ms;
    await db.prepare("INSERT OR IGNORE INTO cot_reports (series, report_date, market_code, oi, oi_change, net_long, net_short, net, net_change, released_ms, released_estimated, first_seen_ms, revised_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .bind(r.series, r.report_date, r.market_code, r.oi, r.oi_change, r.net_long, r.net_short, r.net, r.net_change, released, live ? 0 : sched.estimated ? 1 : 0, now).run();
    added += 1;
  }
  return { added, revised };
}

/** Every stored row (both series, oldest first). */
export async function readCotRows(db) {
  await ensureCotSchema(db);
  const rows = (await db.prepare("SELECT series, report_date, oi, oi_change, net_long, net_short, net, net_change, released_ms, released_estimated FROM cot_reports ORDER BY report_date").all()).results ?? [];
  return rows.map((r) => ({ series: r.series, report_date: r.report_date, oi: r.oi == null ? null : Number(r.oi), oi_change: r.oi_change == null ? null : Number(r.oi_change), net_long: Number(r.net_long), net_short: Number(r.net_short), net: Number(r.net), net_change: r.net_change == null ? null : Number(r.net_change), released_ms: Number(r.released_ms), released_estimated: Number(r.released_estimated) === 1 }));
}

// ---------------------------------------------------------------- point in time

/** Pure: the newest row of `series` known at t (released_ms <= t), or null. Never the newest report_date <= t. */
export function cotAt(rows, t, series = "disaggregated") {
  let best = null;
  for (const r of rows || []) if (r.series === series && finite(r.released_ms) && r.released_ms <= t && (!best || r.report_date > best.report_date)) best = r;
  return best;
}
/** Pure: the rows of `series` known at t, oldest first. */
export function knownAt(rows, t, series) {
  return (rows || []).filter((r) => r.series === series && finite(r.released_ms) && r.released_ms <= t).sort((a, b) => a.report_date.localeCompare(b.report_date));
}
/** Pure: the series the facts come from at t: the disaggregated one, else the legacy one when it is missing or older. */
export function seriesAt(rows, t) {
  const d = cotAt(rows, t, "disaggregated"), l = cotAt(rows, t, "legacy");
  if (d && (!l || d.report_date >= l.report_date)) return "disaggregated";
  return l ? "legacy" : null;
}

const pctlOf = (x, list) => {
  if (!list.length) return null;
  let below = 0, equal = 0;
  for (const v of list) { if (v < x) below += 1; else if (v === x) equal += 1; }
  return (below + 0.5 * equal) / list.length;
};

/**
 * Pure: lens A's facts at t (RFC §3.3), inside one series: never mixed. `knobs` are { crowd_pctl, flow_z };
 * `priceChange` the sign of the feed's D1 close Tuesday to Tuesday (read inside, never emitted). Null without a row.
 */
export function positioningFactsAt(rows, t, { knobs = {}, priceChange = null } = {}) {
  const series = seriesAt(rows, t);
  if (!series) return null;
  const known = knownAt(rows, t, series);
  const cur = known.at(-1);
  const before = known.slice(0, -1).slice(-COT_PCTL_WEEKS);
  const prev = before.at(-1) ?? null;
  const change = finite(cur.net_change) ? cur.net_change : prev ? cur.net - prev.net : null;
  const changes = [];
  for (let i = 0; i < before.length; i++) {
    const r = before[i], p = i > 0 ? before[i - 1] : null;
    const c = finite(r.net_change) ? r.net_change : p ? r.net - p.net : null;
    if (finite(c)) changes.push(c);
  }
  const mean = changes.length ? changes.reduce((s, x) => s + x, 0) / changes.length : null;
  const sd = changes.length > 1 ? Math.sqrt(changes.reduce((s, x) => s + (x - mean) ** 2, 0) / (changes.length - 1)) : null;
  const z = finite(change) && finite(sd) && sd > 0 ? (change - mean) / sd : null;
  const pctl = before.length >= 20 ? pctlOf(cur.net, before.map((r) => r.net)) : null;
  const crowd = finite(knobs.crowd_pctl) ? knobs.crowd_pctl : 0.9;
  const crowding = !finite(pctl) ? "unknown" : pctl >= crowd ? "crowded_long" : pctl <= 1 - crowd ? "crowded_short" : "neutral";
  const oiCh = finite(cur.oi_change) ? cur.oi_change : prev && finite(prev.oi) && finite(cur.oi) ? cur.oi - prev.oi : null;
  const oiPrev = finite(cur.oi) && finite(oiCh) ? cur.oi - oiCh : null;
  const oiPct = finite(oiCh) && finite(oiPrev) && oiPrev > 0 ? (oiCh / oiPrev) * 100 : null;
  let divergence = "none";
  if (finite(change) && change !== 0) {
    if (finite(priceChange) && priceChange > 0 && change < 0) divergence = "price_up_net_down";
    else if (finite(priceChange) && priceChange < 0 && change > 0) divergence = "price_down_net_up";
    else if (finite(oiCh) && oiCh > 0 && change < 0) divergence = "oi_up_net_down";
    else if (finite(oiCh) && oiCh < 0 && change > 0) divergence = "oi_down_net_up";
  }
  const ageDays = (t - dayMs(cur.report_date)) / DAY;
  return {
    net: cur.net, net_change_1w: change, net_pctl_3y: r3(pctl), net_change_z: r3(z),
    oi_change_1w: { contracts: oiCh, pct: r3(oiPct) }, crowding, divergence,
    as_of: cur.report_date, released_at: new Date(cur.released_ms).toISOString(), released_estimated: cur.released_estimated === true,
    series, proxy: series === "legacy" ? "non-commercial positions stand in for managed money" : null,
    age_days: Math.round(ageDays * 10) / 10, stale: ageDays > COT_STALE_DAYS, weeks: before.length
  };
}

/** Pure: the witness's lean (RFC §3.4): half contrarian crowding, half flow with the trend, within ±0.6. */
export function positioningLean(f, { crowd_pctl = 0.9, flow_z = 1 } = {}) {
  if (!f || f.stale) return null;
  const p = f.net_pctl_3y;
  let c = 0;
  if (finite(p) && p >= crowd_pctl) c = -(p - crowd_pctl) / (1 - crowd_pctl);
  else if (finite(p) && p <= 1 - crowd_pctl) c = ((1 - crowd_pctl) - p) / (1 - crowd_pctl);
  const z = f.net_change_z;
  const fl = finite(z) && Math.abs(z) >= flow_z ? clamp(z / (2 * flow_z), -1, 1) : 0;
  return r3(clamp(0.5 * fl + 0.5 * c, -POSITIONING_LEAN_CAP, POSITIONING_LEAN_CAP));
}

const pctText = (p) => (finite(p) ? `${Math.round(p * 100)}th percentile` : "an unmeasured percentile");
const signed = (x) => (finite(x) ? `${x >= 0 ? "up" : "down"} ${Math.abs(Math.round(x)).toLocaleString("en-US")} contracts` : "change unknown");
const DIVERGENCE_TEXT = Object.freeze({ none: "no divergence", price_up_net_down: "price up while the net fell", price_down_net_up: "price down while the net rose", oi_up_net_down: "open interest up while the net fell (fresh shorting)", oi_down_net_up: "open interest down while the net rose (short covering)" });
/** Pure: the one-line summary (the witness card and the 4H and 1D rooms' context line). No price. */
export function positioningLine(f) {
  if (!f) return "Positioning (CFTC): no report stored yet.";
  const who = f.series === "legacy" ? "non-commercial traders (proxy for managed money)" : "managed money";
  const side = f.net >= 0 ? "net long" : "net short";
  const crowd = f.crowding === "crowded_long" ? "crowded long" : f.crowding === "crowded_short" ? "crowded short" : f.crowding === "neutral" ? "not crowded" : "crowding unmeasured";
  const z = finite(f.net_change_z) ? ` (${f.net_change_z >= 0 ? "+" : ""}${f.net_change_z} SD)` : "";
  const oi = finite(f.oi_change_1w?.pct) ? `; open interest ${f.oi_change_1w.pct >= 0 ? "up" : "down"} ${Math.abs(f.oi_change_1w.pct).toFixed(1)}%` : "";
  const stale = f.stale ? ` The report is ${Math.round(f.age_days)} days old: stale, out of the quorum.` : "";
  return `Positioning (CFTC as of ${f.as_of}, released ${f.released_at.slice(0, 10)}): ${who} ${side} at the ${pctText(f.net_pctl_3y)} of 3 years, ${crowd}; ${signed(f.net_change_1w)} on the week${z}${oi}; ${DIVERGENCE_TEXT[f.divergence] ?? f.divergence}.${stale}`;
}

/** The witness's prompt sentence for the Decision Council (RFC §3.4). */
export const POSITIONING_PROMPT = "POSITIONING is the CFTC Commitments of Traders report for COMEX gold: managed money's net position as of Tuesday, published on Friday (later in a holiday week), so it is days old by design; crowding leans contrarian, the week's flow leans with the trend, divergence is in its summary for you to weigh; it is one small witness and never outweighs the guardrails.";

/**
 * Pure: the POSITIONING witness card at `weight` (the per-mode knob already in force). No hourly decay: `at` is null,
 * and the card is stale instead when the newest report known at t is more than 14 days old.
 */
export function positioningCard(f, { weight, knobs = {} } = {}) {
  const lean = positioningLean(f, knobs);
  const side = !finite(lean) || Math.abs(lean) < 0.15 ? "NEUTRAL" : lean > 0 ? "BULLISH" : "BEARISH";
  return {
    key: "POSITIONING", label: "Positioning", role: "CFTC managed-money positioning", weight,
    available: Boolean(f) && finite(lean), stale: Boolean(f?.stale), lean: finite(lean) ? lean : null, side, decision: null, confidence: null,
    summary: f ? positioningLine(f) : null, at: null, crowding: f?.crowding ?? null, divergence: f?.divergence ?? null
  };
}

/** Pure: the facts the mode council and the profile review read (RFC §3.5): crowding and divergence, never a trigger. */
export function positioningPackFact(f) {
  if (!f) return null;
  return { crowding: f.crowding, divergence: f.divergence, as_of: f.as_of, stale: f.stale, series: f.series, note: "a fact for the seats, never a trigger" };
}

// ---------------------------------------------------------------- the feed's D1 closes (divergence, read inside)

/** Pure: the sign of the feed's D1 close Tuesday to Tuesday for a report date, or null. `bars` are D1 candles. */
export function priceChangeFor(bars, reportDate) {
  const tue = dayMs(reportDate);
  if (!Number.isFinite(tue)) return null;
  const d = new Date(tue);
  const endNow = nyToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 17, 1);
  const closeAt = (end) => {
    let best = null;
    for (const b of bars || []) { const c = Date.parse(b?.close_time ?? ""); if (Number.isFinite(c) && c <= end && finite(b.close) && (!best || c > best.c)) best = { c, close: b.close }; }
    return best && end - best.c < 4 * DAY ? best.close : null;
  };
  const a = closeAt(endNow), p = closeAt(endNow - 7 * DAY);
  return finite(a) && finite(p) ? Math.sign(a - p) : null;
}

const SERIES = (tf) => `market-data:v2:series:OANDA:XAUUSD|${tf}`;
async function seriesBars(env, tf) {
  try { const rec = JSON.parse((await env?.SIGNAL_CACHE?.get?.(SERIES(tf))) || "null"); return (Array.isArray(rec?.candles) ? rec.candles : []).filter((c) => finite(c?.close) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)); } catch { return []; }
}

let factsMemo = { at: 0, db: null, rows: null, d1: null };
export function resetPositioningMemoForTests() { factsMemo = { at: 0, db: null, rows: null, d1: null }; }
/** The stored rows and the feed's D1 bars, kept 10 minutes per isolate (a weekly report). Never throws. */
async function loadInputs(env, now) {
  if (factsMemo.rows && now - factsMemo.at < 10 * 60_000 && factsMemo.db === env?.DB) return factsMemo;
  let rows = [], d1 = [];
  try { rows = await readCotRows(env.DB); } catch { rows = []; }
  d1 = await seriesBars(env, "1D");
  factsMemo = { at: now, db: env?.DB, rows, d1 };
  return factsMemo;
}

/** Lens A's facts now (null without a stored report). `knobs` the mode's crowd_pctl and flow_z. Never throws. */
export async function positioningNow(env, { now = Date.now(), knobs = {} } = {}) {
  try {
    const { rows, d1 } = await loadInputs(env, now);
    const series = seriesAt(rows, now);
    if (!series) return null;
    const cur = cotAt(rows, now, series);
    return positioningFactsAt(rows, now, { knobs, priceChange: priceChangeFor(d1, cur.report_date) });
  } catch { return null; }
}

// ---------------------------------------------------------------- the fetch (the calendar's budget pattern)

/** Pure: the Socrata request of a series. */
export function cotUrl(series, limit) {
  const s = COT_SERIES[series];
  const q = new URLSearchParams({ $where: `cftc_contract_market_code='${COT_MARKET_CODE}'`, $order: "report_date_as_yyyy_mm_dd DESC", $limit: String(limit) });
  return `https://${COT_HOST}/resource/${s.dataset}.json?${q.toString()}`;
}
async function fetchSeries(fetchImpl, series, limit) {
  const res = await fetchImpl(cotUrl(series, limit), { headers: { accept: "application/json", "user-agent": "cryptophys-nexus/1.0" }, signal: AbortSignal.timeout(10_000) });
  if (!res?.ok) throw new Error(`cot_http_${res?.status ?? "error"}`);
  return parseCotRows(series, await res.json());
}
const weekKey = (now) => `cot:fetch:week:${ymd(now - ((new Date(now).getUTCDay() + 6) % 7) * DAY)}`;

/** Pure: whether a new report is due: the scheduled release of the week after the newest stored one has passed. */
export function cotDue(rows, now) {
  const last = (rows || []).filter((r) => r.series === "disaggregated").map((r) => r.report_date).sort().at(-1);
  if (!last) return true;
  const next = ymd(dayMs(last) + 7 * DAY);
  return now >= scheduledReleaseMs(next).ms;
}

/**
 * The hourly step (the sweep and the closed-market heartbeat): the backfill once (3 + 1 years, KV marker
 * cot:backfill:v1, retried the next hour on a failure), then the live fetch only while a report is due, at most one
 * request per series an hour (KV cot:fetch:last) and COT_WEEK_CAP a week. No model call. Never throws.
 */
export async function runCotStep(env, { now = Date.now(), fetchImpl = globalThis.fetch, allowBackfill = true } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv?.put || typeof fetchImpl !== "function") return { status: "unavailable" };
  try {
    await ensureCotSchema(db);
    const last = Date.parse((await kv.get(COT_FETCH_LAST_KEY)) || "");
    if (Number.isFinite(last) && now - last < HOUR - 60_000) return { status: "fresh" };
    const backfilled = Boolean(await kv.get(COT_BACKFILL_KEY));
    // The closed-market idle heartbeat stays light (test/market-idle.test.mjs): it reads a new weekly report once the
    // history is in, and leaves the one-time 3 + 1 year backfill to the next trading sweep.
    if (!backfilled && !allowBackfill) return { status: "backfill_pending" };
    const rows = backfilled ? await readCotRows(db) : [];
    if (backfilled && !cotDue(rows, now)) return { status: "not_due" };
    const wk = weekKey(now);
    const used = Number(await kv.get(wk)) || 0;
    if (backfilled && used >= COT_WEEK_CAP) return { status: "week_cap" };
    await kv.put(COT_FETCH_LAST_KEY, new Date(now).toISOString(), { expirationTtl: 2 * 3600 });
    const limit = backfilled ? COT_LIVE_LIMIT : COT_BACKFILL_LIMIT;
    const out = { status: "ok", backfill: !backfilled, series: {} };
    let failed = 0, requests = 0;
    for (const series of Object.keys(COT_SERIES)) {
      try { requests += 1; const parsed = await fetchSeries(fetchImpl, series, limit); out.series[series] = await storeCotRows(db, parsed, { now, backfill: !backfilled }); }
      catch (e) { failed += 1; out.series[series] = { error: String(e?.message ?? e).slice(0, 80) }; }
    }
    await kv.put(wk, String(used + requests), { expirationTtl: 9 * 86_400 });
    if (!backfilled && !out.series.disaggregated?.error) await kv.put(COT_BACKFILL_KEY, new Date(now).toISOString());
    const fails = failed === Object.keys(COT_SERIES).length ? (Number(await kv.get(COT_FETCH_FAILS_KEY)) || 0) + 1 : 0;
    await kv.put(COT_FETCH_FAILS_KEY, String(fails), { expirationTtl: 30 * 86_400 });
    if (failed) out.status = failed === Object.keys(COT_SERIES).length ? "failed" : "partial";
    resetPositioningMemoForTests();
    if (out.status === "ok" && new Date(now).getUTCDay() === 6) await db.prepare("DELETE FROM cot_reports WHERE report_date < ?").bind(ymd(now - COT_KEEP_DAYS * DAY)).run();
    return out;
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The freshness the health alert and the page read: the newest report known, its age, the fetch failure streak. */
export async function cotFreshness(env, { now = Date.now() } = {}) {
  try {
    const { rows } = await loadInputs(env, now);
    const series = seriesAt(rows, now);
    const cur = series ? cotAt(rows, now, series) : null;
    const fails = Number(await env?.SIGNAL_CACHE?.get?.(COT_FETCH_FAILS_KEY)) || 0;
    const age = cur ? (now - dayMs(cur.report_date)) / DAY : null;
    return { as_of: cur?.report_date ?? null, series, age_days: age == null ? null : Math.round(age * 10) / 10, stale: cur ? age > COT_STALE_DAYS : true, fetch_fail_streak: fails, rows: rows.length };
  } catch { return { as_of: null, series: null, age_days: null, stale: true, fetch_fail_streak: 0, rows: 0 }; }
}

// ---------------------------------------------------------------- the outcome score (RFC §7.2, lens A)

/**
 * Pure: lens A's readings at the feed's 4H closes: where the witness would count with |lean| >= 0.15 (point in time:
 * cotAt at the close), each scored with scoreStance on the 4H bars, a horizon of 6 bars and the 0.5 x ATR threshold.
 * Returns [{ id, at_ms, side, outcome (hit | miss | neutral | null pending), lean }].
 */
export function positioningReadings(rows, bars4h, { knobs = {}, d1 = [], fromMs = 0 } = {}) {
  const out = [];
  for (const b of bars4h || []) {
    const close = Date.parse(b.close_time ?? "");
    if (!Number.isFinite(close) || close < fromMs) continue;
    const series = seriesAt(rows, close);
    if (!series) continue;
    const cur = cotAt(rows, close, series);
    const f = positioningFactsAt(rows, close, { knobs, priceChange: priceChangeFor(d1, cur.report_date) });
    const lean = positioningLean(f, knobs);
    if (!finite(lean) || Math.abs(lean) < 0.15) continue;
    const s = scoreStance({ stance: lean > 0 ? "BUY" : "SELL", bars: bars4h, closeMs: close, horizon: POSITIONING_SCORE_HORIZON });
    const outcome = s.result === "hit" || s.result === "miss" || s.result === "neutral" ? s.result : s.result === "pending" ? null : "neutral";
    out.push({ id: `pos:${close}`, at_ms: close, side: lean > 0 ? 1 : -1, outcome, lean, series });
  }
  return out;
}

/**
 * The ledger step's lens A scoring: the readings at each 4H close the feed's series holds (the first run replays them
 * all, point in time, from the backfill), stored in D1 lens_readings, pending ones scored again. Never throws.
 */
export async function scorePositioning(env, { now = Date.now(), knobs = {}, mode = null, record } = {}) {
  try {
    const { rows, d1 } = await loadInputs(env, now);
    if (!rows.length) return { status: "no_reports" };
    const bars = await seriesBars(env, "4h");
    if (bars.length < 30) return { status: "no_bars" };
    const readings = positioningReadings(rows, bars, { knobs, d1 });
    let stored = 0, scored = 0;
    for (const r of readings) {
      const res = await record(r, mode);
      if (res === "added") stored += 1; else if (res === "scored") scored += 1;
    }
    return { status: "ok", readings: readings.length, stored, scored };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}
