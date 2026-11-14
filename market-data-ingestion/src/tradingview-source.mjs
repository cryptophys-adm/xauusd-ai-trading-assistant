// TradingView-native OHLCV source for the local Mizan/Prophet/GMI engines.
//
// Bars come from the TradingView MCP `mcp-tv-get-ohlcv` tool through the
// news-ingestion Worker's gateway (the single owner of the TradingView OAuth
// grant and quota cooldown). M1, H1, H4, D1, W1 and the 4h macro series are native
// TradingView series. Since 2026-11-05 (owner decision, budget 800 calls a day) M5 and
// M15 are aggregated locally from M1, and USOIL M15 and H1 from USOIL M5
// (derived-series.mjs). verifyDerivedSeries compares them with native bars once a day.

import { aggregateCandles, sourceCovers, compareWithNative } from "./derived-series.mjs";
export const MARKET_DATA_SCHEMA = "cryptophys.market-data.v2";
export const PROVIDER = "TradingView MCP (mcp-tv-get-ohlcv via xauusd-fundamental-news-ingestion gateway)";
export const CANONICAL_SYMBOL = "OANDA:XAUUSD";
const SERIES_KEY_PREFIX = "market-data:v2:series:";
const BUDGET_KEY_PREFIX = "market-data:v2:mcp-calls:";
// The gateway's quota cooldown as last reported to this adapter. 2026-11-11: after the provider quota ran
// out at 13:05 UTC, every minute's run still reserved its calls from the daily budget although the gateway
// refused them without calling TradingView; by evening the budget read exhausted, which would have blocked
// the pulls had the cooldown ended before midnight. While it holds, no call is planned against the budget.
const GATEWAY_COOLDOWN_KEY = "market-data:v2:gateway-cooldown";
/** Gateway answers that never reached TradingView: their reservation goes back to the budget. */
const NO_PROVIDER_CALL = new Set(["mcp_quota_cooldown_active", "gateway_not_configured"]);
/** KV key of the last refresh summary, written by every pull cycle. */
export const LAST_REFRESH_KEY = "market-data:v2:last-refresh";
const MAX_GATEWAY_COUNT = 8000;
const HEAL_EVERY_MIN = 5;

// Order is priority: the chart source (M1) is refreshed first when the per-run call
// budget is tight. `derived_from` series are built locally from their source (see
// derived-series.mjs) and are pulled natively only to bootstrap or to fill a gap the source
// no longer covers (owner decision 2026-11-05, TradingView MCP budget 800 a day).
export const SERIES = Object.freeze([
  // Owner decision 2026-11-08: the gold chart stays live (1m pulled every 5 minutes); only the macro
  // series USOIL 5m is pulled once per 15 minutes (cadence below). Since the cron runs every minute
  // (owner 2026-11-09: the H1 decision within 1 to 2 minutes of the close), the 1m chart keeps its
  // 5-minute cadence explicitly, so the quota does not change.
  { key: "OANDA:XAUUSD|1m", symbol: CANONICAL_SYMBOL, interval: "1m", timeframe: "M1", seconds: 60, retain: 3000, role: "chart_source", cadence: 300 },
  { key: "OANDA:XAUUSD|5m", symbol: CANONICAL_SYMBOL, interval: "5m", timeframe: "M5", seconds: 300, retain: 5000, role: "chart", derived_from: "OANDA:XAUUSD|1m" },
  { key: "OANDA:XAUUSD|15m", symbol: CANONICAL_SYMBOL, interval: "15m", timeframe: "M15", seconds: 900, retain: 2000, role: "htf", derived_from: "OANDA:XAUUSD|1m" },
  // The 1H bars are built from the 1m pull like the 5m and 15m ones (owner 2026-11-14, the TradingView
  // quota: 24 calls a weekday; the account's quota ran out at about 20:00 UTC on 2026-11-12 and 11-13).
  // Hourly buckets sit on the UTC hour, as TradingView's do; the 4H, daily and weekly bars, which open at
  // the session's start, stay native.
  { key: "OANDA:XAUUSD|1h", symbol: CANONICAL_SYMBOL, interval: "1h", timeframe: "H1", seconds: 3600, retain: 1000, role: "htf", derived_from: "OANDA:XAUUSD|1m" },
  { key: "OANDA:XAUUSD|4h", symbol: CANONICAL_SYMBOL, interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "htf" },
  { key: "OANDA:XAUUSD|1D", symbol: CANONICAL_SYMBOL, interval: "1D", timeframe: "D1", seconds: 86400, retain: 500, role: "htf" },
  { key: "OANDA:XAUUSD|1W", symbol: CANONICAL_SYMBOL, interval: "1W", timeframe: "W1", seconds: 604800, retain: 260, role: "htf" },
  // USOIL feeds Macro & Aether's ASSET GRAVITY (WTI RSI at the chart timeframe).
  // Owner decision 2026-11-08 (quota): USOIL 5m is pulled once per 15 minutes, at the 15m close, with
  // every 5m bar, so GMI's oil input and its parity are unchanged; it was about 276 calls a weekday.
  { key: "TVC:USOIL|5m", symbol: "TVC:USOIL", interval: "5m", timeframe: "M5", seconds: 300, retain: 3000, role: "external", cadence: 900 },
  { key: "TVC:USOIL|15m", symbol: "TVC:USOIL", interval: "15m", timeframe: "M15", seconds: 900, retain: 1000, role: "external", derived_from: "TVC:USOIL|5m" },
  { key: "TVC:USOIL|1h", symbol: "TVC:USOIL", interval: "1h", timeframe: "H1", seconds: 3600, retain: 500, role: "external", derived_from: "TVC:USOIL|5m" },
  // GMI reads DXY and USDT only at 240 (macro_kinematics, dxy_close), whatever the chart.
  { key: "TVC:DXY|4h", symbol: "TVC:DXY", interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "external" },
  { key: "CRYPTOCAP:USDT|4h", symbol: "CRYPTOCAP:USDT", interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "external" },
  // Nexus correlations panel (backlog 11.3, 2026-11-08): context only, never in the engine bundle
  // (buildBundle skips role "context"), last in priority. 2 series x 6 closed 4h bars = about 12 calls a day.
  { key: "TVC:US10Y|4h", symbol: "TVC:US10Y", interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "context" },
  { key: "OANDA:XAGUSD|4h", symbol: "OANDA:XAGUSD", interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "context" }
]);

const asString = (value) => (typeof value === "string" ? value : "");
const finite = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * Converts gateway columns into closed candles. A bar is closed only when
 * t + interval <= now (TradingView marks the last bar as still forming).
 * Bars with inconsistent OHLC are rejected rather than repaired.
 */
/**
 * Native bars of 1 hour and longer count as closed only SETTLE_SECONDS after their close.
 * TradingView returns the just-closed bar before its last ticks are final: production
 * 2026-11-06, the H1 bar closing 04:00 UTC was pulled at about 04:00:20 with close 4045.145
 * and volume 48491; the final bar (and the TradingView alert) read 4044.815 and 48987. The
 * local H1 record built on the provisional bar failed parity on its input and revoked the
 * approved H1 identities. Shorter native bars (M1, USOIL 5m) keep no delay, so the 15m War
 * Room is not held back; derived bars inherit their source's timing.
 */
// 90 seconds until 2026-11-09; 60 since (owner: the H1 decision within 1 to 2 minutes of the close).
// A bar TradingView still revises after that is rebuilt and published again (republishRevisedH1), so
// its parity comparison still runs on the final bar.
export const SETTLE_SECONDS = 60;
export function settleSeconds(spec) {
  return spec && !spec.derived_from && spec.seconds >= 3600 ? SETTLE_SECONDS : 0;
}

export function closedCandlesFromColumns(bars, spec, nowSec) {
  const out = [];
  const n = Array.isArray(bars?.t) ? bars.t.length : 0;
  for (let i = 0; i < n; i++) {
    const t = bars.t[i], open = bars.o[i], high = bars.h[i], low = bars.l[i], close = bars.c[i];
    if (![t, open, high, low, close].every(finite)) throw Object.assign(new Error("non-finite OHLC"), { code: "invalid_ohlcv_payload" });
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw Object.assign(new Error("inconsistent OHLC bounds"), { code: "invalid_ohlcv_payload" });
    }
    if (t + spec.seconds + settleSeconds(spec) > nowSec) continue; // still forming or not yet final — never fed to the engines
    const volume = finite(bars.v?.[i]) ? bars.v[i] : null;
    out.push({
      time: t,
      open_time: new Date(t * 1000).toISOString(),
      close_time: new Date((t + spec.seconds) * 1000).toISOString(),
      open, high, low, close, volume
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Merges by bar open time (newer data wins) and keeps the last `retain` bars. */
export function mergeCandles(existing, incoming, retain) {
  const byTime = new Map();
  for (const candle of [...(existing || []), ...(incoming || [])]) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-retain);
}

/**
 * Plans the count to request for a series, or null when no new bar can have
 * closed since the cached one. Empty caches bootstrap to the retention depth.
 */
/**
 * Gold, FX, oil, the dollar index and yields do not trade from Friday evening to Sunday evening.
 * Owner decision 2026-11-08: no pull for those series in that window, so a weekend no longer
 * spends the TradingView quota on requests that cannot return a new bar (it exhausted the daily
 * budget of 800 calls, and the context series last in line never got a turn). The window follows
 * New York time, so it is right in both daylight-saving seasons: closed from Friday 17:30 to Sunday
 * 18:00 New York (Friday 22:30 to Sunday 23:00 UTC in winter, Friday 21:30 to Sunday 22:00 UTC in
 * summer). On 2026-11-08 a fixed Sunday 22:00 UTC reopen spent an hour of pulls before gold opened.
 * Crypto trades every day and is never skipped. An empty series still bootstraps once.
 */
const NY_WEEK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function marketClosed(symbol, nowSec) {
  if (/^CRYPTOCAP:|^BINANCE:|^COINBASE:/.test(String(symbol))) return false;
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(nowSec * 1000)).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return (p.weekday === "Fri" && minutes >= 17 * 60 + 30) || p.weekday === "Sat" || (p.weekday === "Sun" && minutes < 18 * 60);
}

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const DAYS_SINCE_FRIDAY = Object.freeze({ Fri: 0, Sat: 1, Sun: 2 });
/**
 * The weekend closure gold is in at `nowSec`, named by its Friday's New York date ("2026-11-13"), or
 * null while gold trades. The cron's closed-market idle mark (index.mjs) holds for one closure only.
 */
export function closureId(nowSec) {
  if (marketClosed(CANONICAL_SYMBOL, nowSec)) {
    const weekday = NY_WEEK.formatToParts(new Date(nowSec * 1000)).find((x) => x.type === "weekday")?.value;
    const back = DAYS_SINCE_FRIDAY[weekday];
    if (Number.isFinite(back)) return NY_DATE.format(new Date((nowSec - back * 86400) * 1000));
  }
  return null;
}

/**
 * Pure: the work a closed market still leaves for the cron in these records: a series without bars
 * (bootstrap) and a series holding the MT5 fallback's broker bars (heal, src/mt5-fallback.mjs).
 */
export function pendingWork(records) {
  const bootstrap = [], heal = [];
  SERIES.forEach((spec, i) => {
    if (!records?.[i]?.candles?.length) bootstrap.push(spec.key);
    if (Number.isFinite(Number(records?.[i]?.fallback?.since_sec))) heal.push(spec.key);
  });
  return { bootstrap, heal };
}

/** The wait between pulls of a series whose last pull after a gap brought no new bar: a quarter of its bar, 1 hour at most. */
export function gapBackoffSeconds(spec) {
  return Math.min(Math.max(spec.seconds / 4, 300), 3600);
}

/**
 * Healing after the MT5 fallback (src/mt5-fallback.mjs): a native series whose cache holds broker bars
 * since `fallback.since_sec` is pulled back over that range, so TradingView's bars overwrite them.
 * Null when the series holds no fallback bars.
 */
export function healPlan(spec, cached, nowSec) {
  const since = Number(cached?.fallback?.since_sec);
  if (spec.derived_from || !Number.isFinite(since)) return null;
  // Once per 5 minutes: while the gateway is still in cooldown every attempt reserves the daily budget.
  if (Math.floor(nowSec / 60) % HEAL_EVERY_MIN !== 0) return null;
  const count = Math.min(spec.retain, MAX_GATEWAY_COUNT, Math.ceil((nowSec - since) / spec.seconds) + 3);
  return { symbol: spec.symbol, interval: spec.interval, count, bootstrap: false, heal: true };
}

export function planRequest(spec, cached, nowSec) {
  const last = cached?.candles?.at(-1);
  if (!last) return { symbol: spec.symbol, interval: spec.interval, count: Math.min(spec.retain, MAX_GATEWAY_COUNT), bootstrap: true };
  const nextCloseSec = last.time + 2 * spec.seconds + settleSeconds(spec);
  if (nextCloseSec > nowSec) return null;
  const missing = Math.ceil((nowSec - last.time) / spec.seconds) + 2;
  if (missing >= spec.retain) return { symbol: spec.symbol, interval: spec.interval, count: Math.min(spec.retain, MAX_GATEWAY_COUNT), bootstrap: true };
  if (marketClosed(spec.symbol, nowSec)) return null;
  // After a gap (a weekend or a holiday), the bar after the cached one is not the one the clock
  // expects: the first bar of the week closes hours after the reopen, D1 a whole trading day later.
  // Production 2026-11-09: gold 1h/4h/1D, DXY, US10Y and XAGUSD were pulled again at every 5-minute
  // run after the reopen, each pull returning no new bar (the D1 alone about 250 pulls of the 800).
  // So once a pull after a gap brought nothing new, wait gapBackoffSeconds before the next one.
  const fetchedSec = Math.floor(Date.parse(cached?.fetched_at || "") / 1000);
  if (nowSec - last.time > 3 * spec.seconds && Number.isFinite(fetchedSec) && fetchedSec >= nextCloseSec && nowSec - fetchedSec < gapBackoffSeconds(spec)) return null;
  // A cadence series is pulled only once a new cadence boundary (the 15m close) has passed since
  // its last cached bar; the pull then brings every bar up to that boundary.
  if (spec.cadence && last.time + spec.seconds >= Math.floor(nowSec / spec.cadence) * spec.cadence) return null;
  return { symbol: spec.symbol, interval: spec.interval, count: Math.max(3, missing), bootstrap: false };
}

async function readJson(kv, key) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function readSeries(kv, spec) {
  return readJson(kv, SERIES_KEY_PREFIX + spec.key);
}

export async function writeSeries(kv, spec, record) {
  await kv.put(SERIES_KEY_PREFIX + spec.key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
}

/**
 * The daily call budget for the UTC date of `now`: TV_DAILY_CALL_BUDGET, unless
 * TV_DAILY_CALL_BUDGET_OVERRIDE ("YYYY-MM-DD:<calls>") names that date. The override is an owner
 * decision for one day and lapses at the next UTC midnight by itself (2026-11-08: the weekend
 * pulls before #165 spent the day's 800 calls, and the market reopens at 22:00 UTC).
 */
export function dailyBudget(env, now = Date.now()) {
  const parsed = Number.parseInt(asString(env?.TV_DAILY_CALL_BUDGET) || "800", 10);
  const base = Number.isFinite(parsed) ? parsed : 800;
  const m = asString(env?.TV_DAILY_CALL_BUDGET_OVERRIDE).match(/^(\d{4}-\d{2}-\d{2}):(\d+)$/);
  return m && m[1] === new Date(now).toISOString().slice(0, 10) ? Number(m[2]) : base;
}

async function reserveBudget(kv, env, wanted, now) {
  const daily = dailyBudget(env, now);
  const key = BUDGET_KEY_PREFIX + new Date(now).toISOString().slice(0, 10);
  const used = Number.parseInt((await kv.get(key)) || "0", 10) || 0;
  const allowed = Math.max(0, Math.min(wanted, daily - used));
  if (allowed > 0) await kv.put(key, String(used + allowed), { expirationTtl: 60 * 60 * 48 });
  return { allowed, used: used + allowed, daily };
}

/** Gives back calls reserved for a run the gateway refused before calling TradingView. */
async function releaseBudget(kv, count, now) {
  if (!(count > 0)) return;
  const key = BUDGET_KEY_PREFIX + new Date(now).toISOString().slice(0, 10);
  const used = Number.parseInt((await kv.get(key)) || "0", 10) || 0;
  await kv.put(key, String(Math.max(0, used - count)), { expirationTtl: 60 * 60 * 48 });
}

/** The gateway's quota cooldown end (ms) while it holds, else null. */
async function knownCooldownUntil(kv, now) {
  let rec = null;
  try { rec = JSON.parse((await kv.get(GATEWAY_COOLDOWN_KEY)) || "null"); } catch { rec = null; }
  const until = Date.parse(rec?.until || "");
  return Number.isFinite(until) && until > now ? until : null;
}

async function callGateway(env, requests) {
  // RPC Service Binding (entrypoint "TvGateway" on the news Worker): not
  // reachable over public HTTP, so no shared secret is involved.
  if (typeof env.TV_GATEWAY?.ohlcv !== "function") {
    throw Object.assign(new Error("TV_GATEWAY RPC binding is not configured"), { code: "gateway_not_configured" });
  }
  const { status, body } = await env.TV_GATEWAY.ohlcv(requests.map(({ symbol, interval, count }) => ({ symbol, interval, count })));
  if (status === 429 || status === 503) {
    throw Object.assign(new Error("TradingView MCP gateway unavailable"), {
      code: asString(body?.error) || "gateway_unavailable", http_status: status,
      quota_cooldown_until: asString(body?.quota_cooldown_until) || null, partial: body?.results || []
    });
  }
  if (status !== 200 || !Array.isArray(body?.results)) {
    throw Object.assign(new Error("TradingView MCP gateway request failed"), { code: asString(body?.error) || "gateway_request_failed", http_status: status });
  }
  return body.results;
}

/**
 * One quota-aware refresh cycle. Only series with a newly closed bar are
 * requested, chart first, bounded per run and per UTC day.
 *
 * `keep` (an array) receives the series records as this run left them, in SERIES order, so the cron
 * builds its bundle from them instead of reading every series from KV a second time (2026-11-14,
 * resource audit: 15 KV reads a minute). The summary itself never carries them: it is stored in KV.
 */
export async function refreshSeries(env, { now = Date.now(), force = false, keep = null } = {}) {
  const { summary, records } = await refreshCycle(env, { now, force });
  if (Array.isArray(keep)) keep.splice(0, keep.length, ...records);
  return { ...summary, due: pendingWork(records) };
}

async function refreshCycle(env, { now, force }) {
  const out = (summary, records) => ({ summary, records });
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) throw Object.assign(new Error("MARKET_DATA_CACHE binding is missing"), { code: "cache_not_configured" });
  const nowSec = Math.floor(now / 1000);
  const perRun = Math.min(12, Number.parseInt(asString(env.TV_MAX_CALLS_PER_RUN) || "8", 10) || 8);

  const cached = await Promise.all(SERIES.map((spec) => readSeries(kv, spec)));
  const sourceIndex = (spec) => SERIES.findIndex((s) => s.key === spec.derived_from);
  const planned = [];
  SERIES.forEach((spec, index) => {
    let plan;
    if (spec.derived_from) {
      // Derived locally unless its cache is empty or the cached source no longer reaches
      // back to its first missing bar: then one native pull bootstraps or fills the gap.
      const own = cached[index]?.candles || [];
      const source = cached[sourceIndex(spec)]?.candles || [];
      if (own.length && sourceCovers(own.at(-1), source, spec.seconds)) plan = null;
      else plan = planRequest(spec, cached[index], nowSec);
    } else {
      plan = healPlan(spec, cached[index], nowSec) ?? (force && cached[index]?.candles?.length
        ? { symbol: spec.symbol, interval: spec.interval, count: 5, bootstrap: false }
        : planRequest(spec, cached[index], nowSec));
    }
    if (plan) planned.push({ spec, index, plan });
  });
  if (planned.length === 0) {
    const derived = await deriveSeries(kv, cached, now, new Set());
    return out({ status: "up_to_date", requested: 0, updated: [], derived }, cached);
  }

  // The gateway's quota cooldown holds: nothing is reserved or asked; the derived series still extend.
  const cooldownUntil = await knownCooldownUntil(kv, now);
  if (cooldownUntil) {
    const derived = await deriveSeries(kv, cached, now, new Set());
    return out({ status: "mcp_quota_cooldown_active", quota_cooldown_until: new Date(cooldownUntil).toISOString(), requested: 0, deferred: planned.length, updated: [], failed: [], derived }, cached);
  }

  const budget = await reserveBudget(kv, env, Math.min(perRun, planned.length), now);
  const batch = planned.slice(0, budget.allowed);
  if (batch.length === 0) return out({ status: "daily_budget_exhausted", requested: 0, updated: [], budget }, cached);

  let results, gatewayError = null;
  try {
    results = await callGateway(env, batch.map((item) => item.plan));
  } catch (error) {
    gatewayError = error;
    results = Array.isArray(error.partial) ? error.partial : [];
  }
  if (gatewayError) {
    const code = asString(gatewayError.code);
    const until = Date.parse(asString(gatewayError.quota_cooldown_until));
    // Remember the cooldown until it ends, so the next runs neither reserve nor call.
    if (Number.isFinite(until) && until > now) {
      await kv.put(GATEWAY_COOLDOWN_KEY, JSON.stringify({ until: new Date(until).toISOString(), code, seen_at: new Date(now).toISOString() }), { expirationTtl: Math.max(60, Math.ceil((until - now) / 1000)) });
    }
    if (NO_PROVIDER_CALL.has(code) && results.length === 0) {
      await releaseBudget(kv, batch.length, now);
      budget.used = Math.max(0, budget.used - batch.length);
      budget.released = batch.length;
    }
  }

  const updated = [], failed = [];
  for (const [i, item] of batch.entries()) {
    const result = results[i];
    const previous = cached[item.index];
    if (!result?.ok) {
      failed.push({ series: item.spec.key, error: asString(result?.error) || asString(gatewayError?.code) || "not_attempted" });
      continue;
    }
    try {
      const incoming = closedCandlesFromColumns(result.bars, item.spec, nowSec);
      const candles = item.plan.bootstrap ? mergeCandles([], incoming, item.spec.retain) : mergeCandles(previous?.candles, incoming, item.spec.retain);
      await writeSeries(kv, item.spec, {
        series: item.spec.key, symbol: item.spec.symbol, interval: item.spec.interval, timeframe: item.spec.timeframe,
        fetched_at: new Date(now).toISOString(), candle_count: candles.length,
        volume_available: candles.length > 0 && candles.every((c) => c.volume !== null),
        candles
      });
      updated.push({ series: item.spec.key, received: incoming.length, stored: candles.length, bootstrap: item.plan.bootstrap });
    } catch (error) {
      failed.push({ series: item.spec.key, error: asString(error?.code) || "invalid_ohlcv_payload" });
    }
  }
  // Derived series are built after the native writes, from the refreshed sources. A
  // series pulled natively in this run is not derived again in the same run.
  const fresh = await Promise.all(SERIES.map((spec) => readSeries(kv, spec)));
  const derived = await deriveSeries(kv, fresh, now, new Set(updated.map((u) => u.series)));
  return out({
    status: gatewayError ? asString(gatewayError.code) || "gateway_error" : failed.length ? "partial" : "ok",
    quota_cooldown_until: gatewayError?.quota_cooldown_until || null,
    requested: batch.length, deferred: planned.length - batch.length, updated, failed, derived, budget
  }, fresh);
}

/** Extends every derived series from its cached source; `records` takes the new records. Never calls the gateway. */
async function deriveSeries(kv, records, now, skip) {
  const nowSec = Math.floor(now / 1000);
  const out = [];
  for (const [index, spec] of SERIES.entries()) {
    if (!spec.derived_from || skip.has(spec.key)) continue;
    const own = records[index]?.candles || [];
    const sourceSpec = SERIES.find((s) => s.key === spec.derived_from);
    const sourceRecord = records[SERIES.indexOf(sourceSpec)];
    const source = sourceRecord?.candles || [];
    if (!own.length || !sourceCovers(own.at(-1), source, spec.seconds)) continue;
    const fetchedAtSec = Math.floor(Date.parse(sourceRecord?.fetched_at || "") / 1000);
    // Healing after the MT5 fallback: once the source holds TradingView's bars again, the buckets built
    // from broker minutes are aggregated again from the fallback's start.
    const ownSince = Number(records[index]?.fallback?.since_sec);
    const healing = Number.isFinite(ownSince) && !sourceRecord?.fallback;
    const after = healing ? Math.floor(ownSince / spec.seconds) * spec.seconds - 1 : own.at(-1).time;
    const incoming = aggregateCandles(source, { seconds: spec.seconds, sourceSeconds: sourceSpec.seconds, nowSec, fetchedAtSec, after });
    if (!incoming.length) continue;
    const candles = mergeCandles(own, incoming, spec.retain);
    const record = {
      series: spec.key, symbol: spec.symbol, interval: spec.interval, timeframe: spec.timeframe,
      fetched_at: new Date(now).toISOString(), derived_from: spec.derived_from, candle_count: candles.length,
      volume_available: candles.length > 0 && candles.every((c) => c.volume !== null),
      // A series still fed by broker minutes keeps its fallback mark until the source heals.
      ...(records[index]?.fallback && !healing ? { fallback: records[index].fallback } : {}),
      candles
    };
    await writeSeries(kv, spec, record);
    records[index] = record;
    out.push({ series: spec.key, derived: incoming.length, stored: candles.length, ...(healing ? { healed: true } : {}) });
  }
  return out;
}

function frame(record, spec) {
  const candles = Array.isArray(record?.candles) ? record.candles : [];
  return {
    interval_minutes: spec.seconds / 60,
    tradingview_interval: spec.interval,
    candle_count: candles.length,
    fetched_at: record?.fetched_at || null,
    volume_available: record?.volume_available === true,
    candles
  };
}

/**
 * Assembles the engine input bundle from the per-series caches, or from `known` (the records a
 * refresh just left, in SERIES order) without reading KV again.
 */
export async function buildBundle(env, now = Date.now(), known = null) {
  const kv = env.MARKET_DATA_CACHE;
  const records = Array.isArray(known) && known.length === SERIES.length ? known : await Promise.all(SERIES.map((spec) => readSeries(kv, spec)));
  const timeframes = {}, external = {};
  SERIES.forEach((spec, i) => {
    // Context series (the Nexus correlations panel) never enter the engine input bundle.
    if (spec.role === "context") return;
    if (spec.symbol === CANONICAL_SYMBOL) timeframes[spec.timeframe] = frame(records[i], spec);
    else (external[spec.symbol] ||= {})[spec.timeframe] = frame(records[i], spec);
  });
  const m5 = timeframes.M5.candles;
  const fetchedTimes = records.map((r) => Date.parse(r?.fetched_at || "")).filter(Number.isFinite);
  return {
    schema_version: MARKET_DATA_SCHEMA,
    source: {
      provider: PROVIDER,
      canonical_symbol: CANONICAL_SYMBOL,
      provider_symbol: CANONICAL_SYMBOL,
      tool: "mcp-tv-get-ohlcv",
      candle_basis: "TradingView native bars for M1, H1, H4, D1, W1 and the 4h macro series; M5 and M15 aggregated locally from M1, USOIL M15 and H1 from USOIL M5 (epoch-aligned buckets, complete buckets only); closed bars only",
      notice: "Bars are served under the TradingView account's plan/exchange entitlements (realtime or delayed)."
    },
    fetched_at: fetchedTimes.length ? new Date(Math.max(...fetchedTimes)).toISOString() : null,
    assembled_at: new Date(now).toISOString(),
    // The MT5 fallback (src/mt5-fallback.mjs): the chart source holds the broker's bars while TradingView is down.
    feed: records[SERIES.findIndex((s) => s.key === `${CANONICAL_SYMBOL}|1m`)]?.fallback ? "mt5_fallback" : "tradingview",
    latest_closed_m5_close_time: m5.at(-1)?.close_time || null,
    volume_available: m5.length > 0 && m5.every((c) => c.volume !== null),
    timeframes,
    // Kept for the v1 engine-input contract (D1/W1 context); same native series.
    context_timeframes: { D1: timeframes.D1, W1: timeframes.W1 },
    external_series: external
  };
}

/** KV key of the last daily derived-vs-native comparison. */
export const DERIVED_CHECK_KEY = "market-data:v2:derived-check";
const VERIFY_COUNT = { 300: 48, 900: 32, 3600: 24 };

/**
 * Once per UTC day (from 01:00), pulls a few native bars of every derived series and
 * compares them with the derived bars on the same open times. Never writes a series.
 */
// The day whose check is known done, per KV binding (resource audit 2026-11-14: the record was read every
// minute to learn it was done hours ago).
const CHECKED_DAY = new WeakMap();
export async function verifyDerivedSeries(env, { now = Date.now() } = {}) {
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: "cache_not_configured" };
  const today = new Date(now).toISOString().slice(0, 10);
  if (new Date(now).getUTCHours() < 1 || (typeof kv === "object" && CHECKED_DAY.get(kv) === today)) return { status: "not_due" };
  const previous = await readJson(kv, DERIVED_CHECK_KEY);
  if (previous?.date === today) { if (typeof kv === "object") CHECKED_DAY.set(kv, today); return { status: "not_due" }; }
  const specs = SERIES.filter((s) => s.derived_from);
  const budget = await reserveBudget(kv, env, specs.length, now);
  if (budget.allowed < specs.length) return { status: "daily_budget_exhausted", budget };
  const nowSec = Math.floor(now / 1000);
  let results;
  try {
    results = await callGateway(env, specs.map((spec) => ({ symbol: spec.symbol, interval: spec.interval, count: VERIFY_COUNT[spec.seconds] || 24 })));
  } catch (error) {
    return { status: asString(error?.code) || "gateway_error" };
  }
  const series = [];
  for (const [i, spec] of specs.entries()) {
    const result = results[i];
    if (!result?.ok) { series.push({ series: spec.key, error: asString(result?.error) || "not_attempted" }); continue; }
    const native = closedCandlesFromColumns(result.bars, spec, nowSec);
    const derived = (await readSeries(kv, spec))?.candles || [];
    series.push({ series: spec.key, ...compareWithNative(derived, native) });
  }
  const summary = { date: today, checked_at: new Date(now).toISOString(), status: series.every((x) => !x.error && x.mismatched === 0) ? "match" : "mismatch_or_error", series };
  await kv.put(DERIVED_CHECK_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 14 });
  if (typeof kv === "object") CHECKED_DAY.set(kv, today);
  return summary;
}

export const SERIES_INTERNALS = { SERIES_KEY_PREFIX, BUDGET_KEY_PREFIX, DERIVED_CHECK_KEY, GATEWAY_COOLDOWN_KEY, dailyBudget };
