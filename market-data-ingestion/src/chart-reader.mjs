// Read-only chart data for the Nexus dashboard. Serves the same closed
// TradingView bars the local engines use (no resampling, no forming bar).
import { SERIES, CANONICAL_SYMBOL, PROVIDER, readSeries } from "./tradingview-source.mjs";

export const CHART_TIMEFRAMES = Object.freeze(["M5", "M15", "H1", "H4", "D1", "W1"]);
const MAX_LIMIT = 1000;

const finite = (x) => typeof x === "number" && Number.isFinite(x);

export async function readChartCandles(env, { timeframe = "H1", limit = 300 } = {}) {
  const tf = String(timeframe || "").toUpperCase();
  if (!CHART_TIMEFRAMES.includes(tf)) return { status: 400, body: { error: "unsupported_timeframe", allowed: CHART_TIMEFRAMES } };
  const n = Math.min(MAX_LIMIT, Math.max(10, Math.floor(Number(limit)) || 300));
  const spec = SERIES.find((s) => s.symbol === CANONICAL_SYMBOL && s.timeframe === tf);
  if (!env.MARKET_DATA_CACHE) return { status: 503, body: { error: "cache_not_configured" } };
  const record = await readSeries(env.MARKET_DATA_CACHE, spec);
  const candles = (Array.isArray(record?.candles) ? record.candles : [])
    .slice(-n)
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(finite))
    .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: finite(c.volume) ? c.volume : null }));
  if (candles.length === 0) return { status: 503, body: { error: "no_data_yet", symbol: CANONICAL_SYMBOL, timeframe: tf } };
  const last = candles.at(-1);
  return {
    status: 200,
    body: {
      symbol: CANONICAL_SYMBOL,
      timeframe: tf,
      interval_seconds: spec.seconds,
      provider: PROVIDER,
      basis: "TradingView native closed bars (forming bar excluded)",
      fetched_at: typeof record?.fetched_at === "string" ? record.fetched_at : null,
      latest_close_time: new Date((last.time + spec.seconds) * 1000).toISOString(),
      count: candles.length,
      candles
    }
  };
}
