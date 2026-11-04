// TradingView-native OHLCV source for the local Mizan/Prophet/GMI engines.
//
// Bars come from the TradingView MCP `mcp-tv-get-ohlcv` tool through the
// news-ingestion Worker's gateway (the single owner of the TradingView OAuth
// grant and quota cooldown). Every series is a native TradingView series — the
// same bars Pine sees on the chart and through request.security /
// request.security_lower_tf — never re-aggregated or resampled here.

export const MARKET_DATA_SCHEMA = "cryptophys.market-data.v2";
export const PROVIDER = "TradingView MCP (mcp-tv-get-ohlcv via xauusd-fundamental-news-ingestion gateway)";
export const CANONICAL_SYMBOL = "OANDA:XAUUSD";
const SERIES_KEY_PREFIX = "market-data:v2:series:";
const BUDGET_KEY_PREFIX = "market-data:v2:mcp-calls:";
/** KV key of the last refresh summary, written by every pull cycle. */
export const LAST_REFRESH_KEY = "market-data:v2:last-refresh";
const MAX_GATEWAY_COUNT = 8000;

// Order is priority: the chart timeframe is refreshed first when the per-run
// call budget is tight.
export const SERIES = Object.freeze([
  { key: "OANDA:XAUUSD|5m", symbol: CANONICAL_SYMBOL, interval: "5m", timeframe: "M5", seconds: 300, retain: 5000, role: "chart" },
  { key: "OANDA:XAUUSD|1m", symbol: CANONICAL_SYMBOL, interval: "1m", timeframe: "M1", seconds: 60, retain: 3000, role: "lower_tf_intrabars" },
  { key: "OANDA:XAUUSD|15m", symbol: CANONICAL_SYMBOL, interval: "15m", timeframe: "M15", seconds: 900, retain: 2000, role: "htf" },
  { key: "OANDA:XAUUSD|1h", symbol: CANONICAL_SYMBOL, interval: "1h", timeframe: "H1", seconds: 3600, retain: 1000, role: "htf" },
  { key: "OANDA:XAUUSD|4h", symbol: CANONICAL_SYMBOL, interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "htf" },
  { key: "OANDA:XAUUSD|1D", symbol: CANONICAL_SYMBOL, interval: "1D", timeframe: "D1", seconds: 86400, retain: 500, role: "htf" },
  { key: "OANDA:XAUUSD|1W", symbol: CANONICAL_SYMBOL, interval: "1W", timeframe: "W1", seconds: 604800, retain: 260, role: "htf" },
  { key: "TVC:USOIL|5m", symbol: "TVC:USOIL", interval: "5m", timeframe: "M5", seconds: 300, retain: 1000, role: "external" },
  { key: "TVC:DXY|4h", symbol: "TVC:DXY", interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "external" },
  { key: "CRYPTOCAP:USDT|4h", symbol: "CRYPTOCAP:USDT", interval: "4h", timeframe: "H4", seconds: 14400, retain: 500, role: "external" }
]);

const asString = (value) => (typeof value === "string" ? value : "");
const finite = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * Converts gateway columns into closed candles. A bar is closed only when
 * t + interval <= now (TradingView marks the last bar as still forming).
 * Bars with inconsistent OHLC are rejected rather than repaired.
 */
export function closedCandlesFromColumns(bars, spec, nowSec) {
  const out = [];
  const n = Array.isArray(bars?.t) ? bars.t.length : 0;
  for (let i = 0; i < n; i++) {
    const t = bars.t[i], open = bars.o[i], high = bars.h[i], low = bars.l[i], close = bars.c[i];
    if (![t, open, high, low, close].every(finite)) throw Object.assign(new Error("non-finite OHLC"), { code: "invalid_ohlcv_payload" });
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw Object.assign(new Error("inconsistent OHLC bounds"), { code: "invalid_ohlcv_payload" });
    }
    if (t + spec.seconds > nowSec) continue; // still forming — never fed to the engines
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
export function planRequest(spec, cached, nowSec) {
  const last = cached?.candles?.at(-1);
  if (!last) return { symbol: spec.symbol, interval: spec.interval, count: Math.min(spec.retain, MAX_GATEWAY_COUNT), bootstrap: true };
  const nextCloseSec = last.time + 2 * spec.seconds;
  if (nextCloseSec > nowSec) return null;
  const missing = Math.ceil((nowSec - last.time) / spec.seconds) + 2;
  if (missing >= spec.retain) return { symbol: spec.symbol, interval: spec.interval, count: Math.min(spec.retain, MAX_GATEWAY_COUNT), bootstrap: true };
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

async function writeSeries(kv, spec, record) {
  await kv.put(SERIES_KEY_PREFIX + spec.key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
}

async function reserveBudget(kv, env, wanted, now) {
  const daily = Number.parseInt(asString(env.TV_DAILY_CALL_BUDGET) || "1200", 10);
  const key = BUDGET_KEY_PREFIX + new Date(now).toISOString().slice(0, 10);
  const used = Number.parseInt((await kv.get(key)) || "0", 10) || 0;
  const allowed = Math.max(0, Math.min(wanted, daily - used));
  if (allowed > 0) await kv.put(key, String(used + allowed), { expirationTtl: 60 * 60 * 48 });
  return { allowed, used: used + allowed, daily };
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
 */
export async function refreshSeries(env, { now = Date.now(), force = false } = {}) {
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) throw Object.assign(new Error("MARKET_DATA_CACHE binding is missing"), { code: "cache_not_configured" });
  const nowSec = Math.floor(now / 1000);
  const perRun = Math.min(12, Number.parseInt(asString(env.TV_MAX_CALLS_PER_RUN) || "8", 10) || 8);

  const cached = await Promise.all(SERIES.map((spec) => readSeries(kv, spec)));
  const planned = [];
  SERIES.forEach((spec, index) => {
    const plan = force && cached[index]?.candles?.length
      ? { symbol: spec.symbol, interval: spec.interval, count: 5, bootstrap: false }
      : planRequest(spec, cached[index], nowSec);
    if (plan) planned.push({ spec, index, plan });
  });
  if (planned.length === 0) return { status: "up_to_date", requested: 0, updated: [] };

  const budget = await reserveBudget(kv, env, Math.min(perRun, planned.length), now);
  const batch = planned.slice(0, budget.allowed);
  if (batch.length === 0) return { status: "daily_budget_exhausted", requested: 0, updated: [], budget };

  let results, gatewayError = null;
  try {
    results = await callGateway(env, batch.map((item) => item.plan));
  } catch (error) {
    gatewayError = error;
    results = Array.isArray(error.partial) ? error.partial : [];
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
  return {
    status: gatewayError ? asString(gatewayError.code) || "gateway_error" : failed.length ? "partial" : "ok",
    quota_cooldown_until: gatewayError?.quota_cooldown_until || null,
    requested: batch.length, deferred: planned.length - batch.length, updated, failed, budget
  };
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

/** Assembles the engine input bundle from the per-series caches. */
export async function buildBundle(env, now = Date.now()) {
  const kv = env.MARKET_DATA_CACHE;
  const records = await Promise.all(SERIES.map((spec) => readSeries(kv, spec)));
  const timeframes = {}, external = {};
  SERIES.forEach((spec, i) => {
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
      candle_basis: "TradingView native bars per interval (exchange session boundaries); closed bars only; no resampling",
      notice: "Bars are served under the TradingView account's plan/exchange entitlements (realtime or delayed)."
    },
    fetched_at: fetchedTimes.length ? new Date(Math.max(...fetchedTimes)).toISOString() : null,
    assembled_at: new Date(now).toISOString(),
    latest_closed_m5_close_time: m5.at(-1)?.close_time || null,
    volume_available: m5.length > 0 && m5.every((c) => c.volume !== null),
    timeframes,
    // Kept for the v1 engine-input contract (D1/W1 context); same native series.
    context_timeframes: { D1: timeframes.D1, W1: timeframes.W1 },
    external_series: external
  };
}

export const SERIES_INTERNALS = { SERIES_KEY_PREFIX, BUDGET_KEY_PREFIX };
