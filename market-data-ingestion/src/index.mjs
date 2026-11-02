import { buildLocalEngineInput, buildLocalEngineReadiness } from "./engine-inputs.mjs";
import { calculateProphetR38Core } from "../../local-engines/prophet-r38/src/core.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const WORKER_NAME = "xauusd-tradingview-pull-adapter";
const PROVIDER = "Twelve Data";
const CACHE_KEY = "market-data:v1:OANDA:XAUUSD";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_OUTPUTSIZE = 5000;
const INCREMENTAL_OUTPUTSIZE = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const BOOTSTRAP_STATE_KEY = "market-data:v1:bootstrap-state";
const BOOTSTRAP_RETRY_MS = DAY_MS;
const DAILY_CONTEXT_OUTPUTSIZE = 60;
const WEEKLY_CONTEXT_OUTPUTSIZE = 60;
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

function parseProviderCandle(value, durationMs = FIVE_MINUTES_MS) {
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
    close_time: new Date(openTime + durationMs).toISOString(),
    open, high, low, close, volume
  };
}

function normalizeProviderPayload(payload, nowMs, options = {}) {
  const durationMs = options.durationMs ?? FIVE_MINUTES_MS;
  const maxCandles = options.maxCandles ?? MAX_OUTPUTSIZE;
  const minClosed = options.minClosed ?? 48;
  if (!payload || payload.status !== "ok" || !Array.isArray(payload.values)) {
    const providerMessage = asString(payload?.message) || asString(payload?.code) || "invalid_provider_payload";
    throw Object.assign(new Error("Market data provider returned an unavailable response"), {
      code: "provider_unavailable",
      provider_message: providerMessage
    });
  }

  const all = payload.values.map((value) => parseProviderCandle(value, durationMs)).sort((a, b) => a.open_time_ms - b.open_time_ms);
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
  if (closed.length < minClosed) {
    throw Object.assign(new Error("Insufficient closed history for the requested interval"), {
      code: "insufficient_closed_history",
      closed_count: closed.length,
      required_count: minClosed
    });
  }

  return closed.slice(-maxCandles).map(({ open_time_ms, ...candle }) => candle);
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

function buildBundle(m5, fetchedAt, providerMeta = {}, contextTimeframes = {}) {
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
    context_timeframes: contextTimeframes,
    history_sufficiency: {
      m5_bootstrap_target: MAX_OUTPUTSIZE,
      m5_bootstrap_complete: m5.length >= MAX_OUTPUTSIZE,
      prophet_default_mtf_ready: ["M15", "H1", "H4"].every((tf) => timeframes[tf].candle_count >= 51) &&
        (contextTimeframes.D1?.candle_count || 0) >= 51 && (contextTimeframes.W1?.candle_count || 0) >= 51,
      gmi_profile_history_ready: (timeframes.M5?.candle_count || 0) >= 300,
      gmi_daily_cpr_history_ready: (contextTimeframes.D1?.candle_count || 0) >= 21,
      gmi_weekly_cpr_history_ready: (contextTimeframes.W1?.candle_count || 0) >= 51
    },
    engine_readiness: buildLocalEngineReadiness({
      schema_version: "cryptophys.market-data.v1",
      source: { ...timeframes.M5, canonical_symbol: "OANDA:XAUUSD", provider: PROVIDER, provider_symbol: asString(providerMeta.symbol) || "XAU/USD" },
      fetched_at: fetchedAt,
      latest_closed_m5_close_time: m5.at(-1)?.close_time || null,
      volume_available: m5.length > 0 && m5.every((bar) => Number.isFinite(bar.volume)),
      timeframes,
      context_timeframes: contextTimeframes
    }),
    limitations: [
      "Only OHLCV is ingested. Footprint/order-flow arrays, TradingView indicator values, and external-symbol inputs are not inferred.",
      "M15/H1/H4 are aggregated from complete UTC-aligned M5 groups; native D1/W1 context is separately fetched to meet source warm-up requirements. These can differ from TradingView exchange/session boundaries.",
      "MizanLib, Prophet, and GMI parity is not established by this data-ingestion worker.",
      "MizanLib source/import identity is not fully verified; Prophet output remains blocked pending full R38 parity; GMI requires M1 intrabars, footprint/order-flow and external-symbol data not present in this bundle."
    ]
  };
}

async function fetchTwelveData(env, interval = "5min", outputsize = MAX_OUTPUTSIZE) {
  const apiKey = asString(env.TWELVE_DATA_API_KEY).trim();
  if (!apiKey) throw Object.assign(new Error("TWELVE_DATA_API_KEY is not configured"), { code: "provider_not_configured" });

  const endpoint = new URL(asString(env.TWELVE_DATA_BASE_URL) || "https://api.twelvedata.com/time_series");
  endpoint.searchParams.set("symbol", asString(env.TWELVE_DATA_SYMBOL) || "XAU/USD");
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("outputsize", String(parsePositiveInt(outputsize, MAX_OUTPUTSIZE)));
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("timezone", "UTC");
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `apikey ${apiKey}`,
      "user-agent": "Cryptophys-Market-Data-Ingestion/1.0"
    },
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
  if (interval === "1day" || interval === "1week") {
    const exchangeTimezone = asString(payload.meta?.exchange_timezone).trim();
    if (!["UTC", "Etc/UTC", "GMT"].includes(exchangeTimezone)) {
      throw Object.assign(new Error("Native D1/W1 timestamps are not proven to be UTC"), {
        code: "provider_timezone_unverified",
        provider_timezone: exchangeTimezone || null
      });
    }
  }
  return payload;
}

function mergeClosedCandles(existing, incoming, maxCandles = MAX_OUTPUTSIZE) {
  const byOpenTime = new Map();
  for (const candle of [...(existing || []), ...(incoming || [])]) {
    byOpenTime.set(candle.open_time, candle);
  }
  return [...byOpenTime.values()]
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
    .slice(-maxCandles);
}

async function readCachedBundle(env) {
  if (!env.MARKET_DATA_CACHE) return null;
  const raw = await env.MARKET_DATA_CACHE.get(CACHE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function pull(env) {
  const nowMs = Date.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const cached = await readCachedBundle(env);
  const cachedM5 = Array.isArray(cached?.timeframes?.M5?.candles) ? cached.timeframes.M5.candles : [];
  let bootstrapState = null;
  if (env.MARKET_DATA_CACHE) {
    try { bootstrapState = JSON.parse(await env.MARKET_DATA_CACHE.get(BOOTSTRAP_STATE_KEY) || "null"); } catch {}
  }
  const lastBootstrapAt = Date.parse(bootstrapState?.attempted_at || "");
  const bootstrapRetryAllowed = !Number.isFinite(lastBootstrapAt) || nowMs - lastBootstrapAt >= BOOTSTRAP_RETRY_MS;
  const bootstrap = cachedM5.length < MAX_OUTPUTSIZE && bootstrapRetryAllowed;
  if (bootstrap && env.MARKET_DATA_CACHE) {
    await env.MARKET_DATA_CACHE.put(BOOTSTRAP_STATE_KEY, JSON.stringify({
      attempted_at: fetchedAt, status: "started"
    }), { expirationTtl: 60 * 60 * 24 * 8 });
  }
  const m5Payload = await fetchTwelveData(env, "5min", bootstrap ? MAX_OUTPUTSIZE : INCREMENTAL_OUTPUTSIZE);
  const incomingM5 = normalizeProviderPayload(m5Payload, nowMs, {
    durationMs: FIVE_MINUTES_MS,
    maxCandles: bootstrap ? MAX_OUTPUTSIZE : INCREMENTAL_OUTPUTSIZE,
    minClosed: bootstrap ? 48 : 1
  });
  const m5 = mergeClosedCandles(cachedM5, incomingM5);
  if (bootstrap && env.MARKET_DATA_CACHE) {
    await env.MARKET_DATA_CACHE.put(BOOTSTRAP_STATE_KEY, JSON.stringify({
      attempted_at: fetchedAt, status: m5.length >= MAX_OUTPUTSIZE ? "complete" : "insufficient_history",
      returned_closed_m5: m5.length
    }), { expirationTtl: 60 * 60 * 24 * 8 });
  }

  // The 20-day daily CPR average and Prophet's default D1/W1 alignment require
  // native higher-timeframe warm-up history; M5-derived D1/W1 cannot supply it.
  const oldContext = cached?.context_timeframes || {};
  const needsDaily = !Array.isArray(oldContext.D1?.candles) ||
    oldContext.D1.candles.length < 21 ||
    nowMs - Date.parse(oldContext.D1.candles.at(-1)?.close_time || 0) >= DAY_MS;
  const needsWeekly = !Array.isArray(oldContext.W1?.candles) ||
    oldContext.W1.candles.length < 51 ||
    nowMs - Date.parse(oldContext.W1.candles.at(-1)?.close_time || 0) >= WEEK_MS;

  let dailyContext = oldContext.D1?.candles || [];
  let weeklyContext = oldContext.W1?.candles || [];
  let dailyMeta = oldContext.D1?.source || null;
  let weeklyMeta = oldContext.W1?.source || null;

  if (needsDaily) {
    const dailyPayload = await fetchTwelveData(env, "1day", DAILY_CONTEXT_OUTPUTSIZE);
    dailyContext = normalizeProviderPayload(dailyPayload, nowMs, {
      durationMs: DAY_MS, maxCandles: DAILY_CONTEXT_OUTPUTSIZE, minClosed: 21
    });
    dailyMeta = { provider: PROVIDER, interval: "1day", alignment_basis: "provider_native_UTC" };
  }
  if (needsWeekly) {
    const weeklyPayload = await fetchTwelveData(env, "1week", WEEKLY_CONTEXT_OUTPUTSIZE);
    weeklyContext = normalizeProviderPayload(weeklyPayload, nowMs, {
      durationMs: WEEK_MS, maxCandles: WEEKLY_CONTEXT_OUTPUTSIZE, minClosed: 51
    });
    weeklyMeta = { provider: PROVIDER, interval: "1week", alignment_basis: "provider_native_UTC" };
  }

  const contextTimeframes = {
    D1: { interval_minutes: 1440, candle_count: dailyContext.length, candles: dailyContext, source: dailyMeta },
    W1: { interval_minutes: 10080, candle_count: weeklyContext.length, candles: weeklyContext, source: weeklyMeta }
  };
  const bundle = buildBundle(m5, fetchedAt, m5Payload.meta || {}, contextTimeframes);
  if (env.MARKET_DATA_CACHE) {
    await env.MARKET_DATA_CACHE.put(CACHE_KEY, JSON.stringify(bundle), { expirationTtl: 60 * 60 * 24 * 8 });
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
    const now = Date.now();
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > 15 * 60 * 1000) {
      return { available: false, reason: "cached_market_data_stale", fetched_at: bundle.fetched_at || null };
    }
    const latestCandleAt = Date.parse(bundle.latest_closed_m5_close_time || "");
    if (!Number.isFinite(latestCandleAt)) {
      return { available: false, reason: "latest_closed_candle_time_missing" };
    }
    if (latestCandleAt > now + 5 * 60 * 1000) {
      return { available: false, reason: "latest_closed_candle_time_in_future" };
    }
    if (now - latestCandleAt > 15 * 60 * 1000) {
      return {
        available: false,
        reason: "latest_closed_market_candle_stale",
        latest_closed_m5_close_time: bundle.latest_closed_m5_close_time,
        candle_age_ms: now - latestCandleAt
      };
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
      : code === "insufficient_closed_history" || code === "provider_timezone_unverified" ? 503 : 502;
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
        m5_bootstrap_target: MAX_OUTPUTSIZE,
        m5_incremental_outputsize: INCREMENTAL_OUTPUTSIZE,
        native_context_intervals: ["1day", "1week"],
        supported_timeframes: [...INTERVALS.map((item) => item.name), "W1-context"]
      });
    }
    if (request.method === "POST" && url.pathname === "/pull") return handlePull(request, env);
    if (request.method === "GET" && url.pathname === "/engine-inputs") {
      if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) {
        return json({ error: "unauthorized" }, 401);
      }
      const engine = (url.searchParams.get("engine") || "").toLowerCase();
      if (!["mizan", "prophet", "gmi"].includes(engine)) {
        return json({ error: "engine_required", allowed_engines: ["mizan", "prophet", "gmi"] }, 400);
      }
      const latest = await readLatest(env);
      if (!latest.available) return json(latest, 503);
      return json(buildLocalEngineInput(latest, engine), 200);
    }
    if (request.method === "GET" && url.pathname === "/engine-shadow") {
      if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) {
        return json({ error: "unauthorized" }, 401);
      }
      const engine = (url.searchParams.get("engine") || "").toLowerCase();
      if (!["mizan", "prophet", "gmi"].includes(engine)) {
        return json({ error: "engine_required", allowed_engines: ["mizan", "prophet", "gmi"] }, 400);
      }
      const latest = await readLatest(env);
      if (engine !== "prophet") {
        if (latest.available) {
          const contract = buildLocalEngineInput(latest, engine);
          return json({
            worker: WORKER_NAME,
            engine,
            engine_shadow_status: "blocked_no_local_calculator",
            calculation_status: contract.calculation_status,
            data_status: contract.data_status,
            history_gaps: contract.history_gaps,
            unavailable_inputs: contract.unavailable_inputs,
            missing_dependencies: contract.missing_dependencies,
            calculation_allowed_for_trusted_evidence: false,
            parity_status: "not_proven"
          }, 501);
        }
        return json({
          worker: WORKER_NAME,
          engine,
          engine_shadow_status: "blocked_no_local_calculator",
          calculation_status: engine === "mizan" ? "blocked_source_identity" : "blocked_missing_gmi_inputs",
          data_status: latest.reason || "market_data_unavailable",
          calculation_allowed_for_trusted_evidence: false,
          parity_status: "not_proven"
        }, 501);
      }
      if (!latest.available) return json(latest, 503);
      const contract = buildLocalEngineInput(latest, engine);
      if (contract.data_status !== "history_ready_for_shadow") {
        return json({
          worker: WORKER_NAME,
          engine,
          engine_shadow_status: "blocked_insufficient_history",
          data_status: contract.data_status,
          history_gaps: contract.history_gaps,
          calculation_allowed_for_trusted_evidence: false,
          parity_status: "not_proven"
        }, 503);
      }
      const htf = {
        M15: latest.timeframes?.M15?.candles || [],
        H1: latest.timeframes?.H1?.candles || [],
        H4: latest.timeframes?.H4?.candles || [],
        D1: latest.context_timeframes?.D1?.candles || [],
        W1: latest.context_timeframes?.W1?.candles || []
      };
      const bars = (latest.timeframes?.M5?.candles || []).map((bar) => ({ ...bar, confirmed: true }));
      const calculated = calculateProphetR38Core(bars, {
        timeframe_minutes: 5,
        gmi_closed_only: true,
        higher_timeframes: htf
      });
      return json({
        worker: WORKER_NAME,
        engine,
        engine_shadow_status: "partial_calculation_available",
        calculation_status: "partial_unverified_kernel",
        implementation_scope: calculated.implementation_scope,
        source: calculated.source,
        symbol: latest.source?.canonical_symbol || "OANDA:XAUUSD",
        provider: latest.source?.provider || null,
        fetched_at: latest.fetched_at,
        latest_closed_m5_close_time: latest.latest_closed_m5_close_time,
        history_requirements: calculated.history_requirements,
        input_history_counts: {
          M5: bars.length,
          M15: htf.M15.length,
          H1: htf.H1.length,
          H4: htf.H4.length,
          D1: htf.D1.length,
          W1: htf.W1.length
        },
        output_count: Math.min(20, calculated.outputs.length),
        outputs: calculated.outputs.slice(-20),
        parity_status: "not_proven",
        calculation_allowed_for_trusted_evidence: false,
        warnings: [
          "This is a partial local R38 kernel, not the full R38 engine.",
          "TradingView fixture parity has not been demonstrated.",
          "Never use these outputs as trusted evidence or live trade instructions."
        ]
      }, 200);
    }
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
  mergeClosedCandles,
  aggregateCandles,
  buildBundle,
  constantTimeEqual,
  parseProviderCandle,
  resetForTests() {}
};

export default worker;
