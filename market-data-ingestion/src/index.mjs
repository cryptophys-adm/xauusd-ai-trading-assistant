const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const WORKER_NAME = "xauusd-tradingview-pull-adapter";
const PROVIDER = "Twelve Data";
const CACHE_KEY = "market-data:v1:OANDA:XAUUSD";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_OUTPUTSIZE = 300;
const INTERVALS = [
  { name: "M5", minutes: 5, expectedBars: 1 },
  { name: "M15", minutes: 15, expectedBars: 3 },
  { name: "H1", minutes: 60, expectedBars: 12 },
  { name: "H4", minutes: 240, expectedBars: 48 },
  { name: "D1", minutes: 1440, expectedBars: 288 }
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getBearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  return diff === 0;
}

function parseNumber(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric field: ${field}`);
  return parsed;
}

function parseProviderCandle(value) {
  const openTime = Date.parse(`${value.datetime.replace(" ", "T")}Z`);
  if (!Number.isFinite(openTime)) throw new Error("Provider returned an invalid candle timestamp");
  const open = parseNumber(value.open, "open");
  const high = parseNumber(value.high, "high");
  const low = parseNumber(value.low, "low");
  const close = parseNumber(value.close, "close");
  const volume = parseNumber(value.volume, "volume");
  if ([open, high, low, close].some((item) => item === null)) {
    throw new Error("Provider candle is missing a required OHLC value");
  }
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new Error("Provider candle has inconsistent OHLC bounds");
  }
  return {
    open_time: new Date(openTime).toISOString(),
    open_time_ms: openTime,
    close_time: new Date(openTime + FIVE_MINUTES_MS).toISOString(),
    open, high, low, close, volume
  };
}

function normalizeProviderPayload(payload, nowMs) {
  if (!payload || payload.status !== "ok" || !Array.isArray(payload.values)) {
    const providerMessage = asString(payload?.message) || asString(payload?.code) || "invalid_provider_payload";
    throw Object.assign(new Error("Market data provider returned an unavailable response"), {
      code: "provider_unavailable",
      provider_message: providerMessage
    });
  }

  const all = payload.values.map(parseProviderCandle).sort((a, b) => a.open_time_ms - b.open_time_ms);
  const deduplicated = [];
  for (const candle of all) {
    if (deduplicated.length && deduplicated[deduplicated.length - 1].open_time_ms === candle.open_time_ms) {
      deduplicated[deduplicated.length - 1] = candle;
    } else {
      deduplicated.push(candle);
    }
  }

  // Never pass the still-forming M5 bar into deterministic calculations.
  const closed = deduplicated.filter((candle) => candle.open_time_ms + FIVE_MINUTES_MS <= nowMs);
  if (closed.length < 48) {
    throw Object.assign(new Error("Insufficient closed M5 history for a safe bootstrap"), {
      code: "insufficient_closed_history",
      closed_count: closed.length
    });
  }

  return closed.slice(-MAX_OUTPUTSIZE).map(({ open_time_ms, ...candle }) => candle);
}

function aggregateCandles(m5, interval) {
  if (interval.name === "M5") return m5;
  const widthMs = interval.minutes * 60 * 1000;
  const groups = new Map();

  for (const candle of m5) {
    const openMs = Date.parse(candle.open_time);
    const bucketMs = Math.floor(openMs / widthMs) * widthMs;
    if (!groups.has(bucketMs)) groups.set(bucketMs, []);
    groups.get(bucketMs).push(candle);
  }

  const result = [];
  for (const [bucketMs, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length !== interval.expectedBars) continue;
    const ordered = group.slice().sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
    const contiguous = ordered.every((bar, index) =>
      Date.parse(bar.open_time) === bucketMs + index * FIVE_MINUTES_MS
    );
    if (!contiguous) continue;

    result.push({
      open_time: new Date(bucketMs).toISOString(),
      close_time: new Date(bucketMs + widthMs).toISOString(),
      open: ordered[0].open,
      high: Math.max(...ordered.map((bar) => bar.high)),
      low: Math.min(...ordered.map((bar) => bar.low)),
      close: ordered[ordered.length - 1].close,
      // Do not fabricate tick/real volume when the upstream provider omits it.
      volume: ordered.every((bar) => Number.isFinite(bar.volume))
        ? ordered.reduce((sum, bar) => sum + bar.volume, 0)
        : null
    });
  }
  return result;
}

function buildBundle(m5, fetchedAt, providerMeta = {}) {
  const timeframes = {};
  for (const interval of INTERVALS) {
    const candles = aggregateCandles(m5, interval);
    timeframes[interval.name] = {
      interval_minutes: interval.minutes,
      candle_count: candles.length,
      candles
    };
  }

  return {
    schema_version: "cryptophys.market-data.v1",
    worker: WORKER_NAME,
    source: {
      provider: PROVIDER,
      provider_symbol: asString(providerMeta.symbol) || "XAU/USD",
      provider_interval: "5min",
      canonical_symbol: "OANDA:XAUUSD",
      source_kind: "licensed_external_market_data",
      parity_note: "Twelve Data candles are not asserted to be byte-identical to OANDA:XAUUSD TradingView candles."
    },
    fetched_at: fetchedAt,
    latest_closed_m5_close_time: m5.at(-1)?.close_time || null,
    volume_available: m5.length > 0 && m5.every((bar) => Number.isFinite(bar.volume)),
    timeframes,
    limitations: [
      "Only OHLCV is ingested. Footprint/order-flow arrays, TradingView indicator values, and external-symbol inputs are not inferred.",
      "Higher timeframes are aggregated from complete UTC-aligned M5 groups; they may differ from TradingView exchange/session boundaries.",
      "MizanLib, Prophet, and GMI parity is not established by this data-ingestion worker."
    ]
  };
}

async function fetchTwelveData(env) {
  const apiKey = asString(env.TWELVE_DATA_API_KEY).trim();
  if (!apiKey) throw Object.assign(new Error("TWELVE_DATA_API_KEY is not configured"), { code: "provider_not_configured" });

  const endpoint = new URL(asString(env.TWELVE_DATA_BASE_URL) || "https://api.twelvedata.com/time_series");
  endpoint.searchParams.set("symbol", asString(env.TWELVE_DATA_SYMBOL) || "XAU/USD");
  endpoint.searchParams.set("interval", "5min");
  endpoint.searchParams.set("outputsize", String(parsePositiveInt(env.M5_BOOTSTRAP_CANDLES, MAX_OUTPUTSIZE)));
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("timezone", "UTC");
  endpoint.searchParams.set("apikey", apiKey);

  const response = await fetch(endpoint, {
    headers: { accept: "application/json", "user-agent": "Cryptophys-Market-Data-Ingestion/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  const bodyText = await response.text();
  let payload;
  try { payload = JSON.parse(bodyText); } catch { payload = null; }

  if (!response.ok || !payload || payload.status !== "ok") {
    const status = response.status;
    const code = asString(payload?.code) || `http_${status}`;
    throw Object.assign(new Error("Twelve Data time-series request failed"), {
      code: status === 429 || code === "429" ? "provider_quota_exceeded" : "provider_request_failed",
      http_status: status,
      provider_code: code,
      provider_message: asString(payload?.message).slice(0, 240)
    });
  }
  return payload;
}

async function pull(env) {
  const payload = await fetchTwelveData(env);
  const fetchedAt = new Date().toISOString();
  const m5 = normalizeProviderPayload(payload, Date.now());
  const bundle = buildBundle(m5, fetchedAt, payload.meta || {});
  if (env.MARKET_DATA_CACHE) {
    await env.MARKET_DATA_CACHE.put(CACHE_KEY, JSON.stringify(bundle), { expirationTtl: 60 * 60 * 2 });
  }
  return bundle;
}

async function readLatest(env) {
  if (!env.MARKET_DATA_CACHE) {
    return { available: false, reason: "market_data_cache_not_configured" };
  }
  const raw = await env.MARKET_DATA_CACHE.get(CACHE_KEY);
  if (!raw) return { available: false, reason: "no_successful_pull_yet" };
  try {
    const bundle = JSON.parse(raw);
    const fetchedAt = Date.parse(bundle.fetched_at);
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 15 * 60 * 1000) {
      return { available: false, reason: "cached_market_data_stale", fetched_at: bundle.fetched_at || null };
    }
    return { available: true, ...bundle };
  } catch {
    return { available: false, reason: "cached_market_data_invalid" };
  }
}

function publicError(error) {
  const code = asString(error?.code) || "market_data_pull_failed";
  const status = code === "provider_not_configured" ? 503
    : code === "provider_quota_exceeded" ? 429
      : code === "insufficient_closed_history" ? 503 : 502;
  return {
    status,
    body: {
      worker: WORKER_NAME,
      available: false,
      error: code,
      message: error?.message || "Market data pull failed",
      ...(Number.isInteger(error?.closed_count) ? { closed_m5_count: error.closed_count } : {}),
      ...(Number.isInteger(error?.http_status) ? { provider_http_status: error.http_status } : {}),
      checked_at: new Date().toISOString()
    }
  };
}

async function handlePull(request, env) {
  if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    return json({ available: true, ...(await pull(env)) });
  } catch (error) {
    const result = publicError(error);
    return json(result.body, result.status);
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        status: "ok",
        worker: WORKER_NAME,
        provider: PROVIDER,
        source_configured: Boolean(asString(env.TWELVE_DATA_API_KEY)),
        pull_auth_configured: Boolean(asString(env.MARKET_DATA_INGEST_SECRET)),
        cache_configured: Boolean(env.MARKET_DATA_CACHE),
        cron: "*/5 * * * *",
        supported_timeframes: INTERVALS.map((item) => item.name)
      });
    }
    if (request.method === "POST" && url.pathname === "/pull") return handlePull(request, env);
    if (request.method === "GET" && url.pathname === "/latest") {
      if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) {
        return json({ error: "unauthorized" }, 401);
      }
      const latest = await readLatest(env);
      return json(latest, latest.available ? 200 : 503);
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await pull(env);
      } catch (error) {
        // Keep logs sanitized: never log URLs, API keys, request headers or raw provider payloads.
        console.error(JSON.stringify({
          worker: WORKER_NAME,
          event: "scheduled_pull_failed",
          code: asString(error?.code) || "market_data_pull_failed",
          checked_at: new Date().toISOString()
        }));
      }
    })());
  }
};

export const internals = {
  normalizeProviderPayload,
  aggregateCandles,
  buildBundle,
  constantTimeEqual,
  parseProviderCandle,
  resetForTests() {}
};

export default worker;
