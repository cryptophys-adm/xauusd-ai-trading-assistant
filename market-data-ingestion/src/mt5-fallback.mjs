// The MT5 fallback feed (docs/RFC_MT5_FALLBACK.md; owner 2026-11-11: "ya rancang jalur cadangan dari bar
// MT5", then "trade seperti biasa" on the broker's raw price).
//
// On 2026-11-11 the TradingView provider quota ran out at 13:05 UTC and every pull paused until 00:00
// UTC: the XAUUSD series stood still, so no room met and every decision held WAIT for hours, while the
// owner's MT5 terminal kept syncing the broker's live price through the Omega bridge.
//
// While the gateway is down (its cooldown or the daily budget stops the pull, or the 1m series is more
// than FALLBACK_STALE_S behind) and the market trades, the broker's closed M1 bars from the Corpus
// Oracle (the AI Worker's corpusBars RPC; only Omega's active broker, pair and user) are merged into the
// OANDA:XAUUSD 1m series, marked src "mt5". The 5m and 15m series aggregate from it as always, and the
// 1H series aggregates from it during the fallback. Every touched series records `fallback.since_sec`;
// the bundle then says feed "mt5_fallback", and every record and 5m context built on it carries it.
//
// Healing: once the gateway answers again, refreshSeries pulls each native series back over the
// fallback range (healPlan) and the native bars overwrite the broker bars (newer data wins); the derived
// series re-aggregate that range from the healed 1m series (deriveSeries).
//
// Switch: FEED_FALLBACK_MODE = "auto" (replace while TradingView is down) | "off".

import { SERIES, readSeries, writeSeries, mergeCandles, marketClosed } from "./tradingview-source.mjs";
import { aggregateCandles } from "./derived-series.mjs";

export const FALLBACK_STALE_S = 10 * 60;
/** Pull statuses that mean the gateway is down. */
export const FALLBACK_TRIGGERS = Object.freeze(new Set(["mcp_quota_cooldown_active", "mcp_quota_exceeded", "gateway_unavailable", "daily_budget_exhausted"]));
const SYMBOL = "OANDA:XAUUSD";
const SOURCE_KEY = `${SYMBOL}|1m`;
/** The series rebuilt from the broker's M1 during a fallback: 5m and 15m (derived as always) and 1H. */
const REBUILT = Object.freeze([`${SYMBOL}|5m`, `${SYMBOL}|15m`, `${SYMBOL}|1h`]);
const finite = (x) => typeof x === "number" && Number.isFinite(x);

export function fallbackMode(env) {
  return String(env?.FEED_FALLBACK_MODE ?? "off").trim().toLowerCase() === "auto" ? "auto" : "off";
}

/** Pure: the broker's closed M1 bars as series candles (src "mt5"), oldest first; malformed bars dropped. */
export function brokerCandles(rows, nowSec) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = Math.floor(Number(r?.t) / 1000);
    const o = Number(r?.o), h = Number(r?.h), l = Number(r?.l), c = Number(r?.c);
    if (![t, o, h, l, c].every(finite) || t % 60 !== 0 || t + 60 > nowSec) continue;
    if (!(o > 0 && h >= Math.max(o, c) && l <= Math.min(o, c) && l > 0)) continue;
    out.push({ time: t, open_time: new Date(t * 1000).toISOString(), close_time: new Date((t + 60) * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: finite(Number(r?.v)) && r.v !== null ? Number(r.v) : null, src: "mt5" });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Pure: whether the gateway is down for the 1m chart source. */
export function gatewayDown(pullStatus, m1Record, nowSec) {
  if (FALLBACK_TRIGGERS.has(String(pullStatus || ""))) return true;
  const last = m1Record?.candles?.at(-1);
  return !last || nowSec - (last.time + 60) > FALLBACK_STALE_S;
}

/**
 * Cron step after the pull: replaces the 1m chart source with the broker's bars while TradingView is
 * down. Never throws; returns what it did.
 */
export async function applyMt5Fallback(env, pullStatus, { now = Date.now() } = {}) {
  if (fallbackMode(env) === "off") return { status: "off" };
  const kv = env?.MARKET_DATA_CACHE;
  if (!kv || typeof env?.AI_WORKER?.corpusBars !== "function") return { status: "unavailable" };
  const nowSec = Math.floor(now / 1000);
  if (marketClosed(SYMBOL, nowSec)) return { status: "market_closed" };
  try {
    const sourceSpec = SERIES.find((s) => s.key === SOURCE_KEY);
    const m1 = await readSeries(kv, sourceSpec);
    if (!gatewayDown(pullStatus, m1, nowSec)) return { status: m1?.fallback ? "healing" : "inactive" };
    const lastSec = m1?.candles?.at(-1)?.time ?? nowSec - 24 * 3600;
    const corpus = await env.AI_WORKER.corpusBars({ since_ms: lastSec * 1000, limit: 1500 });
    const incoming = brokerCandles(corpus?.bars, nowSec).filter((c) => c.time > lastSec);
    if (!incoming.length) return { status: "no_broker_bars", source: corpus?.source ?? null, pull_status: pullStatus ?? null };
    const since = Math.min(m1?.fallback?.since_sec ?? Infinity, incoming[0].time);
    const fallback = { since_sec: since, source: corpus?.source ?? null, started_at: m1?.fallback?.started_at ?? new Date(now).toISOString() };
    const candles = mergeCandles(m1?.candles, incoming, sourceSpec.retain);
    await writeSeries(kv, sourceSpec, { ...(m1 || {}), series: sourceSpec.key, symbol: sourceSpec.symbol, interval: sourceSpec.interval, timeframe: sourceSpec.timeframe, fetched_at: new Date(now).toISOString(), candle_count: candles.length, volume_available: candles.every((c) => c.volume !== null), fallback, candles });
    // 5m, 15m and 1H from the broker's minutes (complete buckets only), each marked for healing.
    const rebuilt = [];
    for (const key of REBUILT) {
      const spec = SERIES.find((s) => s.key === key);
      const own = await readSeries(kv, spec);
      const after = own?.candles?.at(-1)?.time ?? -Infinity;
      const bars = aggregateCandles(candles, { seconds: spec.seconds, sourceSeconds: 60, nowSec, after }).map((c) => ({ ...c, src: "mt5" }));
      if (!bars.length) continue;
      const merged = mergeCandles(own?.candles, bars, spec.retain);
      const ownSince = Math.min(own?.fallback?.since_sec ?? Infinity, bars[0].time);
      await writeSeries(kv, spec, { ...(own || {}), series: spec.key, symbol: spec.symbol, interval: spec.interval, timeframe: spec.timeframe, fetched_at: new Date(now).toISOString(), candle_count: merged.length, volume_available: merged.every((c) => c.volume !== null), fallback: { ...fallback, since_sec: ownSince }, candles: merged });
      rebuilt.push({ series: key, bars: bars.length });
    }
    return { status: "active", source: fallback.source, since: new Date(since * 1000).toISOString(), m1_bars: incoming.length, rebuilt, pull_status: pullStatus ?? null };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}
