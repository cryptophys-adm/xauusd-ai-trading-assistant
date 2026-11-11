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
// 1H, 4H and daily series aggregate from it during the fallback, on the grid of their last native bar
// (owner 2026-11-11: the AI Worker's input as with TradingView, no regression); only a bucket the 1m
// series covers from its start (it keeps about 50 hours, so the weekly bar waits for TradingView, as its
// close does). Every touched series records `fallback.since_sec`;
// the bundle then says feed "mt5_fallback", and every record and 5m context built on it carries it.
//
// Healing: once the gateway answers again, refreshSeries pulls each native series back over the
// fallback range (healPlan) and the native bars overwrite the broker bars (newer data wins); the derived
// series re-aggregate that range from the healed 1m series (deriveSeries).
//
// Switch: the owner's switch in the War Room (KV FEED_FALLBACK_KEY, written by the AI Worker through Omega;
// owner 2026-11-11), else FEED_FALLBACK_MODE = "auto" (replace while TradingView is down) | "off".

import { SERIES, readSeries, writeSeries, mergeCandles, marketClosed } from "./tradingview-source.mjs";
import { aggregateCandles } from "./derived-series.mjs";

export const FALLBACK_STALE_S = 10 * 60;
/** Pull statuses that mean the gateway is down. */
export const FALLBACK_TRIGGERS = Object.freeze(new Set(["mcp_quota_cooldown_active", "mcp_quota_exceeded", "gateway_unavailable", "daily_budget_exhausted"]));
const SYMBOL = "OANDA:XAUUSD";
const SOURCE_KEY = `${SYMBOL}|1m`;
/** The series rebuilt from the broker's M1 during a fallback: 5m and 15m (derived as always), 1H, 4H and D1. */
const REBUILT = Object.freeze([`${SYMBOL}|5m`, `${SYMBOL}|15m`, `${SYMBOL}|1h`, `${SYMBOL}|4h`, `${SYMBOL}|1D`]);
/** The owner's switch in the War Room, in the KV namespace shared with the AI Worker (src/feed.mjs there). */
export const FEED_FALLBACK_KEY = "market-data:v2:feed-fallback-mode";
const finite = (x) => typeof x === "number" && Number.isFinite(x);

export function fallbackMode(env) {
  return String(env?.FEED_FALLBACK_MODE ?? "off").trim().toLowerCase() === "auto" ? "auto" : "off";
}

/** The mode in force: the owner's switch when set, else FEED_FALLBACK_MODE. Never throws. */
export async function resolveFallbackMode(env) {
  try {
    const r = JSON.parse((await env?.MARKET_DATA_CACHE?.get?.(FEED_FALLBACK_KEY)) || "null");
    if (r?.mode === "auto" || r?.mode === "off") return { mode: r.mode, source: "owner" };
  } catch { /* the default below */ }
  return { mode: fallbackMode(env), source: "env" };
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
  const resolved = await resolveFallbackMode(env);
  if (resolved.mode === "off") return { status: "off", mode_source: resolved.source };
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
      // The grid of the last bar of the series (OANDA's 4H, daily and weekly bars open at the session start).
      const anchor = Number.isFinite(after) ? after : 0;
      const firstMinute = candles[0]?.time ?? Infinity;
      const bars = aggregateCandles(candles, { seconds: spec.seconds, sourceSeconds: 60, nowSec, after, anchor })
        .filter((c) => c.time >= firstMinute) // a bucket the 1m series does not cover from its start is not built
        .map((c) => ({ ...c, src: "mt5" }));
      if (!bars.length) continue;
      const merged = mergeCandles(own?.candles, bars, spec.retain);
      const ownSince = Math.min(own?.fallback?.since_sec ?? Infinity, bars[0].time);
      await writeSeries(kv, spec, { ...(own || {}), series: spec.key, symbol: spec.symbol, interval: spec.interval, timeframe: spec.timeframe, fetched_at: new Date(now).toISOString(), candle_count: merged.length, volume_available: merged.every((c) => c.volume !== null), fallback: { ...fallback, since_sec: ownSince }, candles: merged });
      rebuilt.push({ series: key, bars: bars.length });
    }
    // Stage 2 (2026-11-11): the macro series from the broker's macro symbols, while the gateway is down.
    const macro = await applyMacroFallback(env, { now });
    return { status: "active", source: fallback.source, since: new Date(since * 1000).toISOString(), m1_bars: incoming.length, rebuilt, macro, pull_status: pullStatus ?? null };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

// ---------------------------------------------------------------- stage 2: the macro series (2026-11-11)
// Owner 2026-11-11: the AI Worker's input as with TradingView, no regression. While the XAUUSD fallback
// runs (the gateway is down for every series), the macro series the broker can stand in for are rebuilt
// from its M1 bars (the AI Worker's corpusBars with a base), on the grid of their last native bar and
// only for buckets the broker's minutes cover from their start:
//   TVC:USOIL 5m, 15m, 1H   from the broker's oil CFD (its own price, as gold's);
//   OANDA:XAGUSD 4H         from the broker's silver;
//   TVC:DXY 4H              the ICE dollar index computed from the broker's six pairs:
//                           50.14348112 x EURUSD^-0.576 x USDJPY^0.136 x GBPUSD^-0.119 x USDCAD^0.091
//                           x USDSEK^0.042 x USDCHF^0.036, per minute where all six have a bar.
// US10Y and USDT dominance have no broker source and stay stale. Every rebuilt series carries the
// fallback mark, so the native pulls heal it as gold's.
const DXY_WEIGHTS = Object.freeze({ EURUSD: -0.576, USDJPY: 0.136, GBPUSD: -0.119, USDCAD: 0.091, USDSEK: 0.042, USDCHF: 0.036 });
const DXY_CONSTANT = 50.14348112;
export const MACRO_TARGETS = Object.freeze([
  { base: "USOIL", keys: ["TVC:USOIL|5m", "TVC:USOIL|15m", "TVC:USOIL|1h"] },
  { base: "XAGUSD", keys: ["OANDA:XAGUSD|4h"] },
  { base: "DXY", synthetic: true, keys: ["TVC:DXY|4h"] }
]);
const COVER_LOOKBACK_S = 6 * 3600;

/** Pure: the ICE dollar index from the six pairs' rows by minute; only minutes where all six have a bar. */
export function syntheticDxy(rowsByBase) {
  const maps = Object.keys(DXY_WEIGHTS).map((b) => new Map((rowsByBase[b] || []).map((r) => [r.t, r])));
  const times = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).sort((a, b) => a - b);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return times.map((t) => {
    const idx = (field) => DXY_CONSTANT * Object.keys(DXY_WEIGHTS).reduce((p, b, i) => p * Math.pow(maps[i].get(t)[field], DXY_WEIGHTS[b]), 1);
    const o = idx("o"), c = idx("c");
    return { t, o: r3(o), h: r3(Math.max(o, c)), l: r3(Math.min(o, c)), c: r3(c), v: null };
  }).filter((r) => [r.o, r.c].every(finite) && r.o > 0 && r.c > 0);
}

/** The macro series rebuilt from the broker's bars. Never throws; called while the XAUUSD fallback runs. */
export async function applyMacroFallback(env, { now = Date.now() } = {}) {
  const kv = env?.MARKET_DATA_CACHE;
  if (!kv || typeof env?.AI_WORKER?.corpusBars !== "function") return [];
  const nowSec = Math.floor(now / 1000);
  const out = [];
  for (const target of MACRO_TARGETS) {
    try {
      const specs = target.keys.map((k) => SERIES.find((s) => s.key === k)).filter(Boolean);
      const owns = await Promise.all(specs.map((spec) => readSeries(kv, spec)));
      // From six hours before the earliest bucket still to build, to know whether the minutes cover it.
      const nextStart = Math.min(...specs.map((spec, i) => (owns[i]?.candles?.at(-1)?.time ?? nowSec - 24 * 3600) + spec.seconds));
      const sinceMs = (nextStart - COVER_LOOKBACK_S) * 1000;
      let rows, source;
      if (target.synthetic) {
        const byBase = {};
        let sources = [];
        for (const b of Object.keys(DXY_WEIGHTS)) {
          const r = await env.AI_WORKER.corpusBars({ base: b, since_ms: sinceMs, limit: 1500 });
          byBase[b] = r?.bars || [];
          if (r?.source) sources.push(r.source);
        }
        rows = syntheticDxy(byBase);
        source = sources.length === 6 ? `${sources[0].split(":").slice(0, 2).join(":")}:DXY(6 pairs)` : null;
      } else {
        const r = await env.AI_WORKER.corpusBars({ base: target.base, since_ms: sinceMs, limit: 1500 });
        rows = r?.bars || [];
        source = r?.source ?? null;
      }
      const minutes = brokerCandles(rows, nowSec);
      if (!minutes.length || !source) { out.push({ base: target.base, status: "no_broker_bars" }); continue; }
      const firstMinute = minutes[0].time;
      for (const [i, spec] of specs.entries()) {
        const own = owns[i];
        const after = own?.candles?.at(-1)?.time ?? -Infinity;
        const anchor = Number.isFinite(after) ? after : 0;
        const bars = aggregateCandles(minutes, { seconds: spec.seconds, sourceSeconds: 60, nowSec, after, anchor })
          .filter((c) => c.time >= firstMinute) // the broker's minutes must cover the bucket from its start
          .map((c) => ({ ...c, src: "mt5" }));
        if (!bars.length) continue;
        const merged = mergeCandles(own?.candles, bars, spec.retain);
        const since = Math.min(own?.fallback?.since_sec ?? Infinity, bars[0].time);
        await writeSeries(kv, spec, { ...(own || {}), series: spec.key, symbol: spec.symbol, interval: spec.interval, timeframe: spec.timeframe, fetched_at: new Date(now).toISOString(), candle_count: merged.length, volume_available: merged.every((c) => c.volume !== null), fallback: { since_sec: since, source, started_at: own?.fallback?.started_at ?? new Date(now).toISOString() }, candles: merged });
        out.push({ series: spec.key, bars: bars.length });
      }
    } catch (error) {
      out.push({ base: target.base, status: "failed", error: String(error?.message ?? error).slice(0, 120) });
    }
  }
  return out;
}
