import { buildLocalEngineInput } from "./engine-inputs.mjs";
import { calculateProphetR38Core } from "../../local-engines/prophet-r38/src/core.mjs";
import { publishLocalComputation, publishM5LocalComputation, publishHudSnapshots, LAST_PUBLISH_KEY } from "./local-publisher.mjs";
import { buildM5ProphetContext } from "../../local-engines/producer/src/m5-producer.mjs";
import { SERIES, PROVIDER, LAST_REFRESH_KEY, refreshSeries, buildBundle, closedCandlesFromColumns, mergeCandles, planRequest } from "./tradingview-source.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const WORKER_NAME = "xauusd-tradingview-pull-adapter";
const STATUS_KEY = LAST_REFRESH_KEY;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function asString(value) {
  return typeof value === "string" ? value : "";
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

async function pull(env, options = {}) {
  const result = await refreshSeries(env, options);
  const summary = { ...result, checked_at: new Date().toISOString() };
  if (env.MARKET_DATA_CACHE) {
    await env.MARKET_DATA_CACHE.put(STATUS_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  }
  return summary;
}

async function readLatest(env) {
  if (!env.MARKET_DATA_CACHE) return { available: false, reason: "market_data_cache_not_configured" };
  const bundle = await buildBundle(env);
  const now = Date.now();
  const latestCandleAt = Date.parse(bundle.latest_closed_m5_close_time || "");
  if (!Number.isFinite(latestCandleAt)) return { available: false, reason: "no_successful_pull_yet" };
  if (latestCandleAt > now + 5 * 60 * 1000) return { available: false, reason: "latest_closed_candle_time_in_future" };
  if (now - latestCandleAt > 15 * 60 * 1000) {
    return {
      available: false,
      reason: "latest_closed_market_candle_stale",
      latest_closed_m5_close_time: bundle.latest_closed_m5_close_time,
      candle_age_ms: now - latestCandleAt
    };
  }
  return { available: true, ...bundle };
}

function publicError(error) {
  const code = asString(error?.code) || "market_data_pull_failed";
  const status = code === "gateway_not_configured" || code === "cache_not_configured" ? 503 : 502;
  return { status, body: { worker: WORKER_NAME, available: false, error: code, checked_at: new Date().toISOString() } };
}

async function handlePull(request, env) {
  if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const result = await pull(env);
    const status = result.status === "mcp_quota_exceeded" ? 429
      : ["mcp_quota_cooldown_active", "gateway_unavailable", "daily_budget_exhausted"].includes(result.status) ? 503 : 200;
    return json({ worker: WORKER_NAME, ...result }, status);
  } catch (error) {
    const result = publicError(error);
    return json(result.body, result.status);
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      let lastRefresh = null;
      try { lastRefresh = JSON.parse((await env.MARKET_DATA_CACHE?.get(STATUS_KEY)) || "null"); } catch { lastRefresh = null; }
      return json({
        status: "ok",
        worker: WORKER_NAME,
        provider: PROVIDER,
        gateway_configured: typeof env.TV_GATEWAY?.ohlcv === "function",
        gateway_binding: Boolean(env.TV_GATEWAY),
        pull_auth_configured: Boolean(asString(env.MARKET_DATA_INGEST_SECRET)),
        local_publisher_configured: typeof env.AI_WORKER?.submit === "function",
        cache_configured: Boolean(env.MARKET_DATA_CACHE),
        cron: "*/5 * * * *",
        series: SERIES.map(({ symbol, interval, timeframe, retain, role }) => ({ symbol, interval, timeframe, retain, role })),
        last_refresh: lastRefresh ? { status: lastRefresh.status, checked_at: lastRefresh.checked_at, requested: lastRefresh.requested, failed: lastRefresh.failed, quota_cooldown_until: lastRefresh.quota_cooldown_until } : null
      });
    }
    if (request.method === "POST" && url.pathname === "/pull") return handlePull(request, env);
    if (request.method === "POST" && url.pathname === "/publish-local") {
      if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) return json({ error: "unauthorized" }, 401);
      const result = await publishLocalComputation(env, { force: url.searchParams.get("force") === "true" });
      const failed = ["publisher_not_configured", "cache_not_configured", "partial_failure"].includes(result.status);
      return json({ worker: WORKER_NAME, ...result }, failed ? 503 : 200);
    }
    if (request.method === "GET" && url.pathname === "/local-computation/latest") {
      if (!constantTimeEqual(getBearer(request), asString(env.MARKET_DATA_INGEST_SECRET))) return json({ error: "unauthorized" }, 401);
      let last = null;
      try { last = JSON.parse((await env.MARKET_DATA_CACHE?.get(LAST_PUBLISH_KEY)) || "null"); } catch { last = null; }
      return json({ worker: WORKER_NAME, last_publish: last }, last ? 200 : 404);
    }
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
        D1: latest.timeframes?.D1?.candles || [],
        W1: latest.timeframes?.W1?.candles || []
      };
      const bars = (latest.timeframes?.M5?.candles || []).slice(-500).map((bar) => ({ ...bar, confirmed: true }));
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
          M5_available_in_cache: latest.timeframes?.M5?.candle_count || 0,
          M5_engine_window_limit: 500,
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
        // Keep logs sanitized: never log URLs, secrets, request headers or raw provider payloads.
        console.error(JSON.stringify({
          worker: WORKER_NAME,
          event: "scheduled_pull_failed",
          code: asString(error?.code) || "market_data_pull_failed",
          checked_at: new Date().toISOString()
        }));
      }
      // Build the bundle once for both publish and informational 5m context.
      let latestBundle = null;
      try { latestBundle = await buildBundle(env); } catch { latestBundle = null; }
      // Publish the local_computation lane for a newly closed H1 bar (runs on cached data
      // even if this cycle's pull failed; the publisher enforces freshness and dedupe).
      try {
        const published = await publishLocalComputation(env, { bundle: latestBundle });
        if (!["no_fresh_h1_close", "already_published"].includes(published.status)) {
          console.log(JSON.stringify({ worker: WORKER_NAME, event: "local_computation_publish", status: published.status, candle_key: published.candle_key || null }));
        }
      } catch (error) {
        console.error(JSON.stringify({ worker: WORKER_NAME, event: "local_computation_publish_failed", code: asString(error?.code) || "publish_failed" }));
      }
      // C0 verified 5m lane: publish the 5m local records for parity (flag-gated).
      try {
        const publishedM5 = await publishM5LocalComputation(env, { bundle: latestBundle });
        if (!["m5_publish_disabled", "no_fresh_m5_close", "already_published"].includes(publishedM5.status)) {
          console.log(JSON.stringify({ worker: WORKER_NAME, event: "local_computation_publish_m5", status: publishedM5.status, candle_key: publishedM5.candle_key || null, gmi_error: publishedM5.gmi_error || null }));
        }
      } catch (error) {
        console.error(JSON.stringify({ worker: WORKER_NAME, event: "local_computation_publish_m5_failed", code: asString(error?.code) || "publish_failed" }));
      }
      // Phase C2: HUD snapshots for the HUD agents (flag-gated; never decision evidence).
      try {
        const hud = await publishHudSnapshots(env, { bundle: latestBundle });
        const failed = Object.entries(hud.charts || {}).filter(([, r]) => !["published", "already_published", "no_fresh_close"].includes(r.status));
        if (failed.length) console.error(JSON.stringify({ worker: WORKER_NAME, event: "hud_snapshot_publish_failed", charts: Object.fromEntries(failed.map(([c, r]) => [c, r.status])) }));
      } catch (error) {
        console.error(JSON.stringify({ worker: WORKER_NAME, event: "hud_snapshot_publish_failed", code: asString(error?.code) || "publish_failed" }));
      }
      // Informational (unverified) 5m context: build from closed M5 bars and forward
      // to the AI Worker. Never enters the trusted local_computation lane.
      try {
        if (typeof env.AI_WORKER?.submitContext === "function" && latestBundle) {
          const bars = latestBundle?.timeframes?.M5?.candles || [];
          if (Array.isArray(bars) && bars.length >= 50) {
            const context = buildM5ProphetContext(bars);
            const result = await env.AI_WORKER.submitContext(context);
            if (result?.status && result.status >= 400) {
              console.error(JSON.stringify({ worker: WORKER_NAME, event: "m5_context_submit_failed", status: result.status }));
            }
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ worker: WORKER_NAME, event: "m5_context_build_failed", code: asString(error?.code) || "build_failed" }));
      }
    })());
  }
};

export const internals = {
  closedCandlesFromColumns,
  mergeCandles,
  planRequest,
  buildBundle,
  constantTimeEqual,
  resetForTests() {}
};

export default worker;
