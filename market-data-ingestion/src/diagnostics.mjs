// Read-only operational diagnostics for the local_computation lane.
//
// The lane's state lives in KV (series caches, quota budget, last refresh and
// last publish summaries) and is not observable from D1. The Nexus dashboard
// reaches this through the MarketDataReader RPC entrypoint, so an operator can
// see whether the TradingView gateway is refreshed and whether H1 engine
// outputs are being published, without any secret.
import { SERIES, LAST_REFRESH_KEY, readSeries, SERIES_INTERNALS } from "./tradingview-source.mjs";
import { LAST_PUBLISH_KEY } from "./local-publisher.mjs";

async function readJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function readDiagnostics(env, { now = Date.now() } = {}) {
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: 503, body: { error: "cache_not_configured" } };
  const [lastRefresh, lastPublish, derivedCheck, records] = await Promise.all([
    readJson(kv, LAST_REFRESH_KEY),
    readJson(kv, LAST_PUBLISH_KEY),
    readJson(kv, SERIES_INTERNALS.DERIVED_CHECK_KEY),
    Promise.all(SERIES.map((spec) => readSeries(kv, spec)))
  ]);
  const today = new Date(now).toISOString().slice(0, 10);
  const budgetUsed = Number.parseInt((await kv.get(SERIES_INTERNALS.BUDGET_KEY_PREFIX + today)) || "0", 10) || 0;
  const budgetDaily = Number.parseInt(typeof env.TV_DAILY_CALL_BUDGET === "string" ? env.TV_DAILY_CALL_BUDGET : "", 10) || 800;
  return {
    status: 200,
    body: {
      worker: "xauusd-tradingview-pull-adapter",
      checked_at: new Date(now).toISOString(),
      gateway_configured: typeof env.TV_GATEWAY?.ohlcv === "function",
      publisher_configured: typeof env.AI_WORKER?.submit === "function",
      budget: { date: today, used: budgetUsed, daily: budgetDaily },
      last_refresh: lastRefresh,
      last_publish: lastPublish,
      derived_check: derivedCheck,
      series: SERIES.map((spec, index) => {
        const record = records[index];
        const last = Array.isArray(record?.candles) ? record.candles.at(-1) : null;
        return {
          series: spec.key,
          symbol: spec.symbol,
          interval: spec.interval,
          timeframe: spec.timeframe,
          role: spec.role,
          derived_from: spec.derived_from || null,
          cadence_seconds: spec.cadence || null,
          candle_count: typeof record?.candle_count === "number" ? record.candle_count : (Array.isArray(record?.candles) ? record.candles.length : 0),
          fetched_at: typeof record?.fetched_at === "string" ? record.fetched_at : null,
          latest_open_time: last?.open_time || null,
          latest_close_time: last?.close_time || null
        };
      })
    }
  };
}
