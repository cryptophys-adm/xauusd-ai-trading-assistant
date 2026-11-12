// Economic releases (owner 2026-11-10: "apakah economic calendar sudah punya agent yang bisa memprediksi
// horizon dan update analytic setelah news release beserta data releasenya?"). The ForexFactory export
// (src/econ-calendar.mjs) has the forecast and the previous value but never the actual. This module
// adds the released value and what it did to gold:
//   1. Releases: TradingView's economic calendar (through the news-ingestion Worker's TvGateway, the
//      same OAuth grant and quota cooldown) gives actual, forecast and previous for the high-importance
//      USD events. The sweep pulls the day of an event released in the last 3 hours that has no actual
//      yet, and back-fills about 400 days of history, one 14-day window an hour.
//   2. Surprise: actual - forecast, in units of the event's own past surprises (its standard deviation
//      once 6 are known; until then a tenth of the forecast or the forecast-previous gap), within +-3.
//      Its effect on gold follows the Calendar Agent's fixed rule of the event kind (src/calendar-agent.mjs).
//   3. Reaction and horizon: gold's move 1, 2, 4, 8 and 24 hours after each release, in 1H ATR, signed by
//      the rule's direction (positive = gold moved the way the rule says), from gold's 1-hour history
//      (one TradingView pull a day). Per event kind: the mean signed move and the hit rate at each
//      horizon; the learned horizon is the longest one whose hit rate is at least 55 % with a positive
//      mean (null below 5 releases: the fixed 4 hours stand).
// Advisory context only: no price level, no order. The Decision Engine, the Calendar Agent and the
// Macro War Room read it.

import { ruleOf } from "./calendar-agent.mjs";

export const ECON_RELEASES_VERSION = "cryptophys.econ-releases.v1";
export const REACTION_HOURS = Object.freeze([1, 2, 4, 8, 24]);
/** The hours before a release over which gold's drift toward the consensus is measured (owner 2026-11-12). */
export const PRE_HOURS = Object.freeze([1, 2, 4, 8]);
export const MIN_HORIZON_SAMPLES = 5;
export const HORIZON_HIT_RATE = 0.55;
/** A contrarian pre-release drift counts only below this one-sided binomial p (owner 2026-11-12). */
export const CONTRARIAN_P_MAX = 0.05;
export const BACKFILL_DAYS = 400;
const BACKFILL_WINDOW_DAYS = 14;
const HOUR = 3_600_000, DAY = 86_400_000;
const LIVE_LOOKBACK_MS = 3 * HOUR;
const HISTORY_KEY = "econ:gold-1h-history:v1";
const HISTORY_MARKER = "econ:gold-1h-history:fetched";
const CURSOR_KEY = "econ:backfill:cursor";
const LIVE_MARKER = (day) => `econ:live-pull:${day}`;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);
const clip3 = (v) => Math.max(-3, Math.min(3, v));
const goldOf = (usd) => (usd === "usd_up" ? -1 : usd === "usd_down" ? 1 : 0);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
/** A stable key per event: its currency, minute and title. */
export const releaseKey = (e) => `${e.currency || "USD"}:${new Date(Date.parse(e.time)).toISOString().slice(0, 16)}:${slug(e.title)}`;
/** The series an event belongs to (the same indicator across months): its title without the period words. */
export const seriesOf = (title) => slug(String(title || "").replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b|\b(q[1-4]|20\d\d)\b|\(.*?\)/gi, ""));

export const ECON_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS econ_releases (
    release_key TEXT PRIMARY KEY,
    series TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    currency TEXT NOT NULL,
    time TEXT NOT NULL,
    importance INTEGER,
    actual REAL, forecast REAL, previous REAL, unit TEXT,
    surprise REAL, surprise_z REAL, gold_direction INTEGER,
    reaction_json TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_econ_releases_time ON econ_releases(time)",
  "CREATE INDEX IF NOT EXISTS idx_econ_releases_series ON econ_releases(series, time)"
];
let schemaReady = false;
export function resetEconSchemaCacheForTests() { schemaReady = false; }
export async function ensureEconSchema(db) {
  if (schemaReady) return;
  for (const sql of ECON_SCHEMA_SQL) await db.prepare(sql).run();
  // The pre-release drift (owner 2026-11-12), added after the table. A failed ALTER is accepted only when
  // the column is there, so a transient error is retried at the next call instead of cached.
  try { await db.prepare("ALTER TABLE econ_releases ADD COLUMN pre_json TEXT").run(); }
  catch (error) {
    const cols = ((await db.prepare("PRAGMA table_info(econ_releases)").all()).results || []).map((c) => c.name);
    if (!cols.includes("pre_json")) throw error;
  }
  schemaReady = true;
}

/**
 * Pure: the surprise of a release against its forecast. `past` are the earlier surprises (actual -
 * forecast) of the same series. Null without an actual or a forecast.
 */
export function surpriseOf({ title, actual, forecast, previous }, past = []) {
  if (!isNum(actual) || !isNum(forecast)) return null;
  const s = actual - forecast;
  const p = (past || []).filter(isNum);
  let scale = null, basis;
  if (p.length >= 6) {
    const mean = p.reduce((a, b) => a + b, 0) / p.length;
    const sd = Math.sqrt(p.reduce((a, b) => a + (b - mean) ** 2, 0) / (p.length - 1));
    if (sd > 0) { scale = sd; basis = `${p.length} past surprises`; }
  }
  if (!scale) {
    scale = Math.max(Math.abs(forecast) * 0.1, isNum(previous) ? Math.abs(forecast - previous) : 0, 1e-9);
    basis = "a tenth of the forecast or the forecast-previous gap (fewer than 6 past surprises)";
  }
  const rule = ruleOf(title);
  const direction = s === 0 ? 0 : goldOf(rule.higher) * Math.sign(s);
  return { surprise: r3(s), surprise_z: r3(clip3(s / scale)), gold_direction: direction, kind: rule.kind, basis, why: rule.why };
}

/** Average true range of the 14 bars before index i (columns of 1H bars), or null. */
function atrBefore(bars, i, n = 14) {
  if (i < n + 1) return null;
  let sum = 0;
  for (let k = i - n; k < i; k++) sum += Math.max(bars.h[k] - bars.l[k], Math.abs(bars.h[k] - bars.c[k - 1]), Math.abs(bars.l[k] - bars.c[k - 1]));
  return sum / n;
}

/**
 * Pure: gold's reaction to a release from 1H columns { t (open, seconds), o, h, l, c }: the move from the
 * open of the hour holding the release to the close h hours later, in the ATR of the 14 hours before,
 * signed by the rule's direction. Null when the bars do not cover the release and its first hour.
 */
/** Pure: the index of the 1H bar holding the release (the last opening at or before it), or -1. */
function releaseBarIndex(time, bars) {
  const t = Math.floor(Date.parse(time) / 1000);
  if (!bars?.t?.length || !Number.isFinite(t)) return -1;
  let lo = 0, hi = bars.t.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars.t[mid] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  return i >= 0 && t < bars.t[i] + 3600 ? i : -1;
}

export function reactionOf({ time, gold_direction }, bars) {
  const i = releaseBarIndex(time, bars);
  if (i < 0) return null;
  const atr = atrBefore(bars, i);
  if (!isNum(atr) || atr <= 0) return null;
  const base = bars.o[i];
  const out = { atr: r3(atr), moves: {}, signed: {} };
  for (const h of REACTION_HOURS) {
    const j = i + h - 1;
    if (j >= bars.t.length) break;
    // A market gap (the weekend) inside the window: the hour count no longer measures time.
    if (bars.t[j] - bars.t[i] > (h + 6) * 3600) break;
    const move = (bars.c[j] - base) / atr;
    out.moves[`${h}h`] = r3(move);
    out.signed[`${h}h`] = gold_direction ? r3(move * gold_direction) : null;
  }
  return Object.keys(out.moves).length ? out : null;
}

/**
 * Pure: the consensus of a release for gold before it comes out (the Calendar Agent's rule): a forecast
 * above the previous reading is "firmer expected", so the consensus leans the way a beat would move
 * gold; +1 gold up, -1 gold down, 0 without a forecast, a previous reading, a rule or a change.
 */
export function consensusOf({ title, forecast, previous }) {
  const beat = goldOf(ruleOf(title).higher);
  return beat && isNum(forecast) && isNum(previous) && forecast !== previous ? Math.sign(forecast - previous) * beat : 0;
}

/**
 * Pure: gold's drift before a release (owner 2026-11-12: "ada tendensi market bergerak sesuai proyeksi
 * horizon menjelang release economic calendar"): the move from the open of the bar h hours before the
 * release hour to the open of the release hour, in the ATR of the 14 hours before it, signed by the
 * consensus (positive = gold drifted the consensus way). Null when the bars do not hold the release.
 */
export function preDriftOf(release, bars) {
  const i = releaseBarIndex(release?.time, bars);
  if (i < 0) return null;
  const atr = atrBefore(bars, i);
  if (!isNum(atr) || atr <= 0) return null;
  const consensus = consensusOf(release);
  const base = bars.o[i];
  const out = { atr: r3(atr), consensus, moves: {}, signed: {} };
  for (const h of PRE_HOURS) {
    const j = i - h;
    if (j < 0) break;
    // A market gap (the weekend) inside the window: the hour count no longer measures time.
    if (bars.t[i] - bars.t[j] > (h + 6) * 3600) break;
    const move = (base - bars.o[j]) / atr;
    out.moves[`${h}h`] = r3(move);
    out.signed[`${h}h`] = consensus ? r3(move * consensus) : null;
  }
  return Object.keys(out.moves).length ? out : null;
}

/**
 * Pure: per event kind, the pre-release drift: at each of PRE_HOURS the mean signed move and how often
 * gold drifted the consensus way, over the releases that had a consensus; the learned pre-release
 * horizon is the longest one with a hit rate of at least HORIZON_HIT_RATE and a positive mean (0 when
 * none; null under MIN_HORIZON_SAMPLES releases).
 */
export function preDriftStats(rows) {
  const byKind = new Map();
  for (const r of rows || []) {
    const pre = typeof r.pre_json === "string" ? safeParse(r.pre_json) : r.pre ?? null;
    if (!pre?.signed || !pre.consensus) continue;
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(pre.signed);
  }
  const out = {};
  for (const [kind, list] of byKind) {
    const st = kindStats(list, PRE_HOURS);
    // The contrarian drift (owner 2026-11-12: "ya buatkan opsi kontrarian untuk survei"): a kind without a
    // learned horizon whose gold drifted against the consensus at least HORIZON_HIT_RATE of the time, with
    // a negative mean, and significantly (one-sided binomial p < CONTRARIAN_P_MAX): the longest such hour.
    const against = st.horizon_hours === 0 ? PRE_HOURS.map((h) => {
      const x = st.horizons[`${h}h`];
      if (!x || x.n < MIN_HORIZON_SAMPLES || !(x.mean_atr < 0)) return null;
      const k = x.n - Math.round(x.hit_rate * x.n);
      const p = binomialTail(k, x.n);
      return k / x.n >= HORIZON_HIT_RATE && p < CONTRARIAN_P_MAX ? { h, rate: r3(k / x.n), p: r3(p), mean_atr: x.mean_atr } : null;
    }).filter(Boolean) : [];
    const best = against.at(-1) ?? null;
    out[kind] = { ...st, contrarian_hours: st.horizon_hours === 0 ? best?.h ?? 0 : null, against_rate: best?.rate ?? null, against_p: best?.p ?? null, against_mean_atr: best?.mean_atr ?? null };
  }
  return out;
}

/** Pure: the one-sided binomial tail P(X >= k) for n fair trials. */
export function binomialTail(k, n) {
  let c = 1, p = 0;
  for (let i = 0; i <= n; i++) { if (i >= k) p += c; c = (c * (n - i)) / (i + 1); }
  return p / 2 ** n;
}

/**
 * Pure: per event kind, the mean signed move and the hit rate at each horizon, and the learned horizon
 * (the longest one with a hit rate of at least HORIZON_HIT_RATE and a positive mean; null under
 * MIN_HORIZON_SAMPLES releases).
 */
export function horizonStats(rows) {
  const byKind = new Map();
  for (const r of rows || []) {
    const rx = typeof r.reaction_json === "string" ? safeParse(r.reaction_json) : r.reaction ?? null;
    if (!rx?.signed || !r.gold_direction) continue;
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(rx.signed);
  }
  const out = {};
  for (const [kind, list] of byKind) {
    const st = kindStats(list, REACTION_HOURS, { pick: "peak" });
    const peak = Object.entries(st.horizons).filter(([, x]) => x.n >= MIN_HORIZON_SAMPLES).sort((a, b) => b[1].mean_atr - a[1].mean_atr)[0];
    out[kind] = { ...st, peak: st.horizon_hours != null && peak ? { at: peak[0], mean_atr: peak[1].mean_atr, hit_rate: peak[1].hit_rate } : null };
  }
  return out;
}

/**
 * Pure: one kind's signed moves (one object per release, keyed "<h>h") at each of `hours`: the count, the
 * mean and the hit rate; the learned horizon is, among the hours with a hit rate of at least
 * HORIZON_HIT_RATE and a positive mean, the longest (`pick` "longest") or the one with the largest mean
 * ("peak") (0 when none; null under MIN_HORIZON_SAMPLES releases), with its hit rate and mean. Shared by the reaction after a release and the drift before it.
 */
function kindStats(list, hours, { pick = "longest" } = {}) {
  const horizons = {};
  for (const h of hours) {
    const v = list.map((x) => x[`${h}h`]).filter(isNum);
    if (!v.length) continue;
    horizons[`${h}h`] = { n: v.length, mean_atr: r3(v.reduce((a, b) => a + b, 0) / v.length), hit_rate: r3(v.filter((x) => x > 0).length / v.length) };
  }
  const enough = list.length >= MIN_HORIZON_SAMPLES;
  const good = hours.filter((h) => { const x = horizons[`${h}h`]; return x && x.n >= MIN_HORIZON_SAMPLES && x.hit_rate >= HORIZON_HIT_RATE && x.mean_atr > 0; });
  // "longest" (the drift before a release): the longest qualifying hour. "peak" (the reaction after it; owner
  // 2026-11-12: "ya perbaiki horizon reaksi pakai peak 2 jam"): the qualifying hour with the largest mean
  // move, so a strong first hours' reaction is not diluted by a weak day (inflation: 2 h at 91 %, not 24 h at 56 %).
  const learned = !enough || !good.length ? null
    : pick === "peak" ? good.reduce((a, b) => (horizons[`${b}h`].mean_atr > horizons[`${a}h`].mean_atr ? b : a))
    : Math.max(...good);
  return {
    samples: list.length, horizons,
    horizon_hours: enough ? learned ?? 0 : null,
    hit_rate: learned ? horizons[`${learned}h`].hit_rate : null,
    mean_atr: learned ? horizons[`${learned}h`].mean_atr : null
  };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/** Upserts the events of a calendar answer (USD, with a title and a time). Returns the number written. */
export async function upsertReleases(db, events, { now = Date.now() } = {}) {
  await ensureEconSchema(db);
  let n = 0;
  for (const e of events || []) {
    if (!e?.title || !Number.isFinite(Date.parse(e.time)) || (e.currency && e.currency !== "USD")) continue;
    const key = releaseKey({ ...e, currency: "USD" }), series = seriesOf(e.title);
    const past = ((await db.prepare("SELECT surprise FROM econ_releases WHERE series = ? AND time < ? AND surprise IS NOT NULL ORDER BY time DESC LIMIT 24").bind(series, new Date(Date.parse(e.time)).toISOString()).all()).results || []).map((r) => r.surprise);
    const sp = surpriseOf(e, past);
    const kind = ruleOf(e.title).kind;
    const iso = new Date(now).toISOString();
    await db.prepare(`INSERT INTO econ_releases (release_key, series, kind, title, currency, time, importance, actual, forecast, previous, unit, surprise, surprise_z, gold_direction, fetched_at, updated_at)
      VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(release_key) DO UPDATE SET kind = excluded.kind, actual = COALESCE(excluded.actual, actual), forecast = COALESCE(excluded.forecast, forecast), previous = COALESCE(excluded.previous, previous),
        surprise = COALESCE(excluded.surprise, surprise), surprise_z = COALESCE(excluded.surprise_z, surprise_z), gold_direction = COALESCE(excluded.gold_direction, gold_direction), updated_at = excluded.updated_at`)
      .bind(key, series, kind, e.title, new Date(Date.parse(e.time)).toISOString(), isNum(e.importance) ? e.importance : null, isNum(e.actual) ? e.actual : null, isNum(e.forecast) ? e.forecast : null, isNum(e.previous) ? e.previous : null, e.unit ?? null,
        sp?.surprise ?? null, sp?.surprise_z ?? null, sp ? sp.gold_direction : null, iso, iso).run();
    n += 1;
  }
  return n;
}

/**
 * The MT5 fallback, stage 2 (2026-11-11): released values from the MQL5 calendar (src/corpus-oracle.mjs
 * readMt5Calendar) while TradingView's calendar is down. MQL5 names the events its own way ("Nonfarm
 * Payrolls" for "Non Farm Payrolls"), so a value goes to the row of the same minute and kind when one
 * waits for its actual (the series' history stays one), else it is stored under its own title.
 */
export async function applyMt5Actuals(db, events, { now = Date.now() } = {}) {
  await ensureEconSchema(db);
  let n = 0;
  for (const e of events || []) {
    if (!isNum(e?.actual) || !e?.title || !Number.isFinite(Date.parse(e.time))) continue;
    const t = Date.parse(e.time);
    const rows = ((await db.prepare("SELECT title FROM econ_releases WHERE time >= ? AND time <= ? AND actual IS NULL").bind(new Date(t - 60_000).toISOString(), new Date(t + 60_000).toISOString()).all()).results || []);
    const kind = ruleOf(e.title).kind;
    const match = rows.find((r) => kind !== "other" && ruleOf(r.title).kind === kind) || (rows.length === 1 ? rows[0] : null);
    n += await upsertReleases(db, [{ ...e, title: match ? match.title : e.title, time: new Date(t).toISOString() }], { now });
  }
  return n;
}

const dayRange = (ms) => { const d = new Date(ms).toISOString().slice(0, 10); return { date_from: `${d}T00:00:00Z`, date_to: `${d}T23:59:59Z` }; };

async function callCalendar(env, request) {
  const svc = env?.NEWS_INGESTION;
  if (typeof svc?.economicCalendar !== "function") return { ok: false, error: "no_gateway" };
  try {
    const r = await svc.economicCalendar({ ...request, currencies: "USD", min_importance: 1 });
    return r?.status === 200 ? { ok: true, events: r.body?.events || [] } : { ok: false, error: r?.body?.error || `status_${r?.status}` };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 120) }; }
}

/** Gold's 1H history (KV, refreshed once a day from TradingView), as columns, or null. */
async function goldHistory(env, now) {
  const kv = env?.SIGNAL_CACHE;
  let cached = safeParse((await kv?.get?.(HISTORY_KEY)) || "null");
  const fetched = Date.parse((await kv?.get?.(HISTORY_MARKER)) || "");
  if ((!cached || !Number.isFinite(fetched) || now - fetched > DAY) && typeof env?.NEWS_INGESTION?.goldHistory === "function") {
    try {
      await kv?.put?.(HISTORY_MARKER, new Date(now).toISOString(), { expirationTtl: 3 * DAY });
      const r = await env.NEWS_INGESTION.goldHistory(6000);
      const bars = r?.status === 200 ? r.body?.results?.[0]?.bars : null;
      if (bars?.t?.length) { cached = { t: bars.t, o: bars.o, h: bars.h, l: bars.l, c: bars.c }; await kv?.put?.(HISTORY_KEY, JSON.stringify(cached), { expirationTtl: 8 * DAY }); }
    } catch { /* keep the cache */ }
  }
  // The newest hours from the pull adapter's 1H series (no TradingView call).
  try {
    const rec = safeParse((await kv?.get?.("market-data:v2:series:OANDA:XAUUSD|1h")) || "null");
    const recent = (rec?.candles || []).filter((b) => [b.open, b.high, b.low, b.close].every(isNum) && b.open_time);
    if (recent.length) {
      const map = new Map();
      if (cached?.t) cached.t.forEach((t, k) => map.set(t, [cached.o[k], cached.h[k], cached.l[k], cached.c[k]]));
      for (const b of recent) map.set(Math.floor(Date.parse(b.open_time) / 1000), [b.open, b.high, b.low, b.close]);
      const ts = [...map.keys()].sort((a, b) => a - b);
      cached = { t: ts, o: ts.map((t) => map.get(t)[0]), h: ts.map((t) => map.get(t)[1]), l: ts.map((t) => map.get(t)[2]), c: ts.map((t) => map.get(t)[3]) };
    }
  } catch { /* history only */ }
  return cached?.t?.length ? cached : null;
}

/**
 * Sweep step. Never throws. (1) The day of a High-impact USD event released 2 minutes to 3 hours ago
 * whose actual is not stored, at most once per sweep and once every 10 minutes per day; (2) at the first
 * sweep of each hour, one 14-day window of history back to BACKFILL_DAYS; (3) the reactions of releases
 * whose 24 hours have passed, from gold's 1H history; (4) the pre-release drift of every release whose
 * hour has begun, history included.
 */
export async function refreshEconReleases(env, { now = Date.now(), gatedEvents = [], readMt5 = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db) return { status: "unavailable" };
  const out = { status: "ok", live: null, backfill: null, reactions: 0 };
  try {
    await ensureEconSchema(db);
    // (1) Live: the released value of an event that has just come out.
    const due = (gatedEvents || []).filter((e) => e.currency === "USD" && e.impact === "High").map((e) => Date.parse(e.time)).filter((t) => Number.isFinite(t) && now - t >= 2 * 60_000 && now - t <= LIVE_LOOKBACK_MS);
    if (due.length) {
      const t = Math.max(...due);
      const day = new Date(t).toISOString().slice(0, 10);
      const have = await db.prepare("SELECT COUNT(*) AS n FROM econ_releases WHERE time >= ? AND time <= ? AND actual IS NOT NULL").bind(new Date(t - 60_000).toISOString(), new Date(t + 60_000).toISOString()).first();
      const last = Date.parse((await kv?.get?.(LIVE_MARKER(day))) || "");
      if (!Number(have?.n) && !(Number.isFinite(last) && now - last < 10 * 60_000)) {
        await kv?.put?.(LIVE_MARKER(day), new Date(now).toISOString(), { expirationTtl: 2 * DAY });
        const r = await callCalendar(env, dayRange(t));
        if (r.ok) out.live = { day, events: await upsertReleases(db, r.events, { now }) };
        else {
          // TradingView's calendar is down: the broker terminal's (MQL5) released values, when the bridge sent them.
          const range = dayRange(t);
          const mt5 = typeof readMt5 === "function" ? await readMt5(env, { fromMs: Date.parse(range.date_from), toMs: Date.parse(range.date_to) }) : [];
          out.live = mt5.length ? { day, source: "mt5", tradingview_error: r.error, events: await applyMt5Actuals(db, mt5, { now }) } : { day, error: r.error };
        }
      }
    }
    // Rows stored before a rule learned their title (production 2026-11-10: "Non Farm Payrolls" read as
    // "other"): re-classified, with the rule's effect on gold.
    for (const r of ((await db.prepare("SELECT release_key, title, surprise FROM econ_releases WHERE kind = 'other' LIMIT 50").all()).results || [])) {
      const rule = ruleOf(r.title);
      if (rule.kind === "other") continue;
      const dir = isNum(r.surprise) && r.surprise !== 0 ? goldOf(rule.higher) * Math.sign(r.surprise) : null;
      // pre_json cleared: its consensus was measured without the rule, so it is measured again (step 4).
      await db.prepare("UPDATE econ_releases SET kind = ?, gold_direction = COALESCE(?, gold_direction), pre_json = NULL, updated_at = ? WHERE release_key = ?").bind(rule.kind, dir, new Date(now).toISOString(), r.release_key).run();
    }
    // (2) Back-fill, one window an hour.
    if (new Date(now).getUTCMinutes() < 25) {
      const cursor = Date.parse((await kv?.get?.(CURSOR_KEY)) || "") || now;
      if (cursor > now - BACKFILL_DAYS * DAY) {
        const from = cursor - BACKFILL_WINDOW_DAYS * DAY;
        const r = await callCalendar(env, { date_from: new Date(from).toISOString().slice(0, 19) + "Z", date_to: new Date(cursor).toISOString().slice(0, 19) + "Z" });
        if (r.ok) { await kv?.put?.(CURSOR_KEY, new Date(from).toISOString()); out.backfill = { from: new Date(from).toISOString(), events: await upsertReleases(db, r.events, { now }) }; }
        else out.backfill = { error: r.error };
      }
    }
    // (3) Reactions: releases with an actual whose 24 hours have passed and no reaction yet.
    const pending = ((await db.prepare("SELECT * FROM econ_releases WHERE actual IS NOT NULL AND reaction_json IS NULL AND time <= ? ORDER BY time DESC LIMIT 400").bind(new Date(now - 25 * HOUR).toISOString()).all()).results || []);
    let history;
    const historyOnce = async () => (history === undefined ? (history = await goldHistory(env, now)) : history);
    if (pending.length) {
      const bars = await historyOnce();
      if (bars) {
        const first = bars.t[0] * 1000;
        for (const r of pending) {
          const rx = reactionOf(r, bars);
          // Before the history's first bar it can never be measured: mark it, so it is not retried.
          const value = rx ? JSON.stringify(rx) : Date.parse(r.time) < first + 15 * HOUR ? JSON.stringify({ unavailable: "before the 1H history" }) : null;
          if (value) { await db.prepare("UPDATE econ_releases SET reaction_json = ?, updated_at = ? WHERE release_key = ?").bind(value, new Date(now).toISOString(), r.release_key).run(); out.reactions += 1; }
        }
      }
    }
    // (4) The pre-release drift (owner 2026-11-12) of every release whose hour has begun, history included,
    // at the first sweep of each hour (it feeds the statistics, not a live decision).
    const prePending = new Date(now).getUTCMinutes() < 25 ? ((await db.prepare("SELECT release_key, title, time, forecast, previous FROM econ_releases WHERE pre_json IS NULL AND time <= ? ORDER BY time DESC LIMIT 400").bind(new Date(now - 5 * 60_000).toISOString()).all()).results || []) : [];
    if (prePending.length) {
      const bars = await historyOnce();
      if (bars) {
        const first = bars.t[0] * 1000, last = bars.t.at(-1) * 1000;
        out.pre = 0;
        for (const r of prePending) {
          const pre = preDriftOf(r, bars);
          const t = Date.parse(r.time);
          // Before the history, or an hour the history has passed without a bar (market closed): never
          // measurable, so it is not retried.
          const value = pre ? JSON.stringify(pre) : t < first + 9 * HOUR || t + HOUR <= last ? JSON.stringify({ unavailable: "not in the 1H history" }) : null;
          if (value) { await db.prepare("UPDATE econ_releases SET pre_json = ?, updated_at = ? WHERE release_key = ?").bind(value, new Date(now).toISOString(), r.release_key).run(); out.pre += 1; }
        }
      }
    }
  } catch (e) {
    out.status = "failed"; out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}

/** CALENDAR_CONTRARIAN (owner 2026-11-12): "on" lets a significant contrarian pre-release drift lean the other way. */
/**
 * The released figures of the last `days` with a direction for gold, newest first: the events of the
 * Projection Agent's event patterns (src/chart-patterns.mjs). Never throws; [] without a database.
 */
export async function recentReleases(env, { now = Date.now(), days = 5, limit = 12 } = {}) {
  const db = env?.DB;
  if (!db) return [];
  try {
    await ensureEconSchema(db);
    const rows = ((await db.prepare("SELECT title, time, gold_direction FROM econ_releases WHERE time >= ? AND time <= ? AND actual IS NOT NULL AND gold_direction IS NOT NULL AND gold_direction <> 0 ORDER BY time DESC LIMIT ?")
      .bind(new Date(now - days * 86_400_000).toISOString(), new Date(now).toISOString(), limit).all()).results || []);
    return rows.map((r) => ({ title: String(r.title ?? "").slice(0, 80), time: r.time, gold_direction: Number(r.gold_direction) > 0 ? 1 : -1 }));
  } catch { return []; }
}

export function calendarContrarianMode(env) {
  return String(env?.CALENDAR_CONTRARIAN ?? "off").trim().toLowerCase() === "on" ? "on" : "off";
}

/**
 * The Calendar Agent's release intelligence at `now`: the releases of the last 24 hours and the next 48
 * with their surprise, and the horizon statistics per event kind. Never throws.
 */
export async function calendarIntel(env, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return { version: ECON_RELEASES_VERSION, releases: [], stats: {}, pre_stats: {} };
  try {
    await ensureEconSchema(db);
    const releases = ((await db.prepare("SELECT release_key, series, kind, title, time, actual, forecast, previous, unit, surprise, surprise_z, gold_direction FROM econ_releases WHERE time >= ? AND time <= ? ORDER BY time").bind(new Date(now - 24 * HOUR).toISOString(), new Date(now + 48 * HOUR).toISOString()).all()).results || []);
    const rows = ((await db.prepare("SELECT kind, gold_direction, reaction_json FROM econ_releases WHERE reaction_json IS NOT NULL AND gold_direction IS NOT NULL AND gold_direction <> 0").all()).results || []);
    // Its own try: the pre-release statistics never take the releases and the reaction statistics down.
    let preRows = [];
    try { preRows = ((await db.prepare("SELECT kind, pre_json FROM econ_releases WHERE pre_json IS NOT NULL").all()).results || []); } catch { preRows = []; }
    const counts = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN actual IS NOT NULL THEN 1 ELSE 0 END) AS released, MIN(time) AS since FROM econ_releases").first();
    return { version: ECON_RELEASES_VERSION, releases, stats: horizonStats(rows), pre_stats: preDriftStats(preRows), contrarian: calendarContrarianMode(env) === "on", history: { releases: Number(counts?.n) || 0, with_actual: Number(counts?.released) || 0, since: counts?.since ?? null } };
  } catch {
    return { version: ECON_RELEASES_VERSION, releases: [], stats: {}, pre_stats: {} };
  }
}
