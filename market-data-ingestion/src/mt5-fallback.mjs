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
export const FALLBACK_TRIGGERS = Object.freeze(new Set(["mcp_quota_cooldown_active", "mcp_quota_exceeded", "gateway_unavailable", "daily_budget_exhausted", "account_budget_exhausted"]));
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
    // F1: a fresh feed bridge's bars first (another broker than the executor's), else the executor's own.
    const corpus = await env.AI_WORKER.corpusBars({ since_ms: lastSec * 1000, limit: 1500, prefer_feed: true });
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
// US10Y and the USDT market cap have no broker source and stay stale. Every rebuilt series carries the
// fallback mark, so the native pulls heal it as gold's.
const DXY_WEIGHTS = Object.freeze({ EURUSD: -0.576, USDJPY: 0.136, GBPUSD: -0.119, USDCAD: 0.091, USDSEK: 0.042, USDCHF: 0.036 });
const DXY_CONSTANT = 50.14348112;
export const MACRO_TARGETS = Object.freeze([
  { base: "USOIL", keys: ["TVC:USOIL|5m", "TVC:USOIL|15m", "TVC:USOIL|1h"] },
  { base: "XAGUSD", keys: ["OANDA:XAGUSD|4h"] },
  { base: "DXY", synthetic: true, keys: ["TVC:DXY|4h"] }
]);
/**
 * The series built from the broker's bars at all times, never pulled from TradingView (their SERIES entry carries
 * `broker`). QB1 O3 (2026-11-26) put silver 4H here; QB1-R (the same day) took it out again: the bridge sends no macro
 * symbol on the active broker (D1 corpus_sources holds only its gold), so the series froze. Empty until it does.
 */
export const BROKER_TARGETS = Object.freeze([]);
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

/**
 * One target's series from the broker's M1 bars (the AI Worker's corpusBars with a base), on the grid of each
 * series' last bar and only for buckets the broker's minutes cover from their start. `mark` (the fallback) records
 * fallback.since_sec so the native pulls heal the bars; without it (BROKER_TARGETS) the series holds no fallback mark.
 */
export async function rebuildFromBroker(env, kv, target, { now, mark }) {
  const nowSec = Math.floor(now / 1000);
  const out = [];
  const specs = target.keys.map((k) => SERIES.find((s) => s.key === k)).filter(Boolean);
  const owns = await Promise.all(specs.map((spec) => readSeries(kv, spec)));
  // From six hours before the earliest bucket still to build, to know whether the minutes cover it.
  const nextStart = Math.min(...specs.map((spec, i) => (owns[i]?.candles?.at(-1)?.time ?? nowSec - 24 * 3600) + spec.seconds));
  // Without the fallback (every run): ask the broker only once the next bucket can have closed.
  if (!mark && !specs.some((spec, i) => (owns[i]?.candles?.at(-1)?.time ?? -Infinity) + 2 * spec.seconds <= nowSec)) return [{ base: target.base, status: "not_due" }];
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
  if (!minutes.length || !source) return [{ base: target.base, status: "no_broker_bars" }];
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
    const { fallback: ownFallback, ...rest } = own || {};
    const record = { ...rest, series: spec.key, symbol: spec.symbol, interval: spec.interval, timeframe: spec.timeframe, fetched_at: new Date(now).toISOString(), candle_count: merged.length, volume_available: merged.every((c) => c.volume !== null), candles: merged };
    if (mark) record.fallback = { since_sec: Math.min(ownFallback?.since_sec ?? Infinity, bars[0].time), source, started_at: ownFallback?.started_at ?? new Date(now).toISOString() };
    else record.source = source;
    await writeSeries(kv, spec, record);
    out.push({ series: spec.key, bars: bars.length });
  }
  return out;
}

/** The macro series rebuilt from the broker's bars. Never throws; called while the XAUUSD fallback runs. */
export async function applyMacroFallback(env, { now = Date.now() } = {}) {
  const kv = env?.MARKET_DATA_CACHE;
  if (!kv || typeof env?.AI_WORKER?.corpusBars !== "function") return [];
  const out = [];
  for (const target of MACRO_TARGETS) {
    try { out.push(...(await rebuildFromBroker(env, kv, target, { now, mark: true }))); }
    catch (error) { out.push({ base: target.base, status: "failed", error: String(error?.message ?? error).slice(0, 120) }); }
  }
  return out;
}

/**
 * QB1 O3: the BROKER_TARGETS series from the broker's bars on every run, whatever the gateway's state; the broker
 * is asked only once a new bucket can have closed. Never throws.
 */
export async function applyBrokerSeries(env, { now = Date.now() } = {}) {
  const kv = env?.MARKET_DATA_CACHE;
  if (!kv || typeof env?.AI_WORKER?.corpusBars !== "function") return [];
  const out = [];
  for (const target of BROKER_TARGETS) {
    try { out.push(...(await rebuildFromBroker(env, kv, target, { now, mark: false }))); }
    catch (error) { out.push({ base: target.base, status: "failed", error: String(error?.message ?? error).slice(0, 120) }); }
  }
  return out;
}

// ---------------------------------------------------------------- BF1 (d): filling holes inside the 1m series
// After a bridge reconnect or a broker switch the 1m series can hold a hole: minutes the fallback never appended
// (applyMt5Fallback appends only bars newer than the series' last) and TradingView never healed. Every FILL_EVERY_MIN
// minutes, while the owner's fallback switch is "auto", the trading minutes missing between two bars of the last
// FILL_WINDOW_S are asked of the corpus (corpusBars, bounded to the hole): the feed bridge's source first (the OANDA feed,
// the TradingView series' own venue), the executor's for what the feed lacks. A filled minute is marked
// src "mt5-feed" or "mt5-exec" and `fill: true`; it never replaces a bar (only missing minutes are written). The 5m, 15m
// and 1H buckets the fill completes are built and inserted where their series has no bar, at their own open times, so a
// filled bar is history: freshness (FP1's breakout age, the public patterns' confirmed_at_ms) counts from the latest
// closed bar, and the Decision Engine decides only the latest close. With no hole, nothing is read but the 1m series.
export const FILL_WINDOW_S = 10 * 3600;
export const FILL_EVERY_MIN = 5;
const FILL_SERIES = Object.freeze([`${SYMBOL}|5m`, `${SYMBOL}|15m`, `${SYMBOL}|1h`]);
const NY_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" });

/** Pure: gold trades at the minute opening at `sec` (not the weekend, Friday 17:00 to Sunday 18:00 New York, nor the daily break, 17:00-18:00 Monday to Thursday). */
export function goldTradesAt(sec) {
  const p = Object.fromEntries(NY_CLOCK.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  const h = Number(p.hour);
  if (p.weekday === "Sat" || (p.weekday === "Fri" && h >= 17) || (p.weekday === "Sun" && h < 18)) return false;
  return !(["Mon", "Tue", "Wed", "Thu"].includes(p.weekday) && h === 17);
}

/** Pure: the holes of a 1m series in the window ending at `nowSec`: [{ from, to, minutes }] (seconds; the trading minutes from..to-60 are missing). */
export function seriesHoles(candles, nowSec, { windowS = FILL_WINDOW_S } = {}) {
  const start = nowSec - windowS;
  const c = (Array.isArray(candles) ? candles : []).filter((x) => finite(x?.time)).sort((a, b) => a.time - b.time);
  const out = [];
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1].time, b = c[i].time;
    if (b <= start || b - a <= 60) continue;
    let first = null, last = null, n = 0;
    for (let t = Math.max(a + 60, Math.ceil(start / 60) * 60); t < b; t += 60) if (goldTradesAt(t)) { if (first == null) first = t; last = t; n += 1; }
    if (n) out.push({ from: first, to: last + 60, minutes: n });
  }
  return out;
}

/**
 * Pure: the filled ranges a record carries after a fill (`fills`, [{ from, to }] in seconds): the new bars' runs added to
 * the record's own, merged, and only those ending inside the window (TradingView heals them while the day's budget allows,
 * src/tradingview-source.mjs healPlan). Null when none is left.
 */
export function fillsWith(existing, times, seconds, nowSec, { windowS = FILL_WINDOW_S } = {}) {
  const runs = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && t === last.to) last.to = t + seconds;
    else runs.push({ from: t, to: t + seconds });
  }
  const all = [...(Array.isArray(existing) ? existing : []), ...runs].filter((r) => finite(Number(r?.from)) && finite(Number(r?.to)) && Number(r.to) > nowSec - windowS)
    .map((r) => ({ from: Number(r.from), to: Number(r.to) })).sort((a, b) => a.from - b.from);
  const merged = [];
  for (const r of all) {
    const last = merged.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged.length ? merged.slice(-50) : null;
}

/** Pure: the complete buckets of `seconds` that the filled minutes make whole, absent from `existing`, from the 1m `candles`. */
export function filledBuckets(candles, filledTimes, existing, { seconds, nowSec }) {
  const have = new Set((existing || []).map((x) => x.time));
  const byTime = new Map((candles || []).map((x) => [x.time, x]));
  const starts = new Set([...filledTimes].map((t) => Math.floor(t / seconds) * seconds));
  const out = [];
  for (const s of [...starts].sort((a, b) => a - b)) {
    if (have.has(s) || s + seconds > nowSec) continue;
    const minutes = [];
    let whole = true;
    for (let t = s; t < s + seconds; t += 60) {
      if (!goldTradesAt(t)) continue;
      const m = byTime.get(t);
      if (!m) { whole = false; break; }
      minutes.push(m);
    }
    if (!whole || !minutes.length) continue;
    const src = minutes.some((m) => m.src === "mt5-exec") ? "mt5-exec" : minutes.some((m) => m.src === "mt5-feed") ? "mt5-feed" : minutes[0].src;
    const vol = minutes.every((m) => m.volume !== null && finite(m.volume)) ? minutes.reduce((a, m) => a + m.volume, 0) : null;
    out.push({ time: s, open_time: new Date(s * 1000).toISOString(), close_time: new Date((s + seconds) * 1000).toISOString(),
      open: minutes[0].open, high: Math.max(...minutes.map((m) => m.high)), low: Math.min(...minutes.map((m) => m.low)), close: minutes.at(-1).close, volume: vol, src, fill: true });
  }
  return out;
}

/**
 * Cron step (every FILL_EVERY_MIN minutes, the fallback switch "auto", the market open): fills the 1m series' holes from
 * the corpus and inserts the buckets they complete. Never throws; returns what it did.
 */
export async function fillHoles(env, { now = Date.now() } = {}) {
  const resolved = await resolveFallbackMode(env);
  if (resolved.mode === "off") return { status: "off" };
  const kv = env?.MARKET_DATA_CACHE;
  if (!kv || typeof env?.AI_WORKER?.corpusBars !== "function") return { status: "unavailable" };
  const nowSec = Math.floor(now / 1000);
  if (Math.floor(nowSec / 60) % FILL_EVERY_MIN !== 0) return { status: "not_due" };
  if (marketClosed(SYMBOL, nowSec)) return { status: "market_closed" };
  try {
    const sourceSpec = SERIES.find((s) => s.key === SOURCE_KEY);
    const m1 = await readSeries(kv, sourceSpec);
    const holes = seriesHoles(m1?.candles, nowSec);
    if (!holes.length) return { status: "no_hole" };
    const have = new Set((m1.candles || []).map((c) => c.time));
    const filled = new Map();
    for (const hole of holes) {
      const want = (rows, src) => brokerCandles(rows, nowSec).filter((c) => c.time >= hole.from && c.time < hole.to && !have.has(c.time) && !filled.has(c.time) && goldTradesAt(c.time)).map((c) => ({ ...c, src, fill: true }));
      const ask = { since_ms: (hole.from - 60) * 1000, limit: Math.min(1500, Math.ceil((hole.to - hole.from) / 60) + 1) };
      const first = await env.AI_WORKER.corpusBars({ ...ask, prefer_feed: true });
      for (const c of want(first?.bars, first?.feed ? "mt5-feed" : "mt5-exec")) filled.set(c.time, c);
      const still = hole.minutes - [...filled.keys()].filter((t) => t >= hole.from && t < hole.to).length;
      if (first?.feed && still > 0) {
        const exec = await env.AI_WORKER.corpusBars({ ...ask, prefer_feed: false });
        if (!exec?.feed) for (const c of want(exec?.bars, "mt5-exec")) filled.set(c.time, c);
      }
    }
    if (!filled.size) return { status: "nothing_in_corpus", holes: holes.length, missing: holes.reduce((a, h) => a + h.minutes, 0) };
    // Only missing minutes are written: the existing bars come last in the merge, so none is ever replaced.
    const candles = mergeCandles([...filled.values()], m1.candles, sourceSpec.retain);
    // The filled ranges are recorded, so TradingView replaces them once its budget allows (healPlan); then they clear.
    const m1Fills = fillsWith(m1.fills, filled.keys(), 60, nowSec);
    await writeSeries(kv, sourceSpec, { ...m1, fetched_at: m1.fetched_at, candle_count: candles.length, volume_available: candles.every((c) => c.volume !== null), ...(m1Fills ? { fills: m1Fills } : {}), candles });
    const rebuilt = [];
    for (const key of FILL_SERIES) {
      const spec = SERIES.find((s) => s.key === key);
      if (!spec) continue;
      const own = await readSeries(kv, spec);
      const bars = filledBuckets(candles, filled.keys(), own?.candles, { seconds: spec.seconds, nowSec });
      if (!bars.length) continue;
      const merged = mergeCandles(bars, own?.candles, spec.retain);
      const ownFills = fillsWith(own?.fills, bars.map((b) => b.time), spec.seconds, nowSec);
      await writeSeries(kv, spec, { ...(own || {}), series: spec.key, symbol: spec.symbol, interval: spec.interval, timeframe: spec.timeframe, candle_count: merged.length, volume_available: merged.every((c) => c.volume !== null), ...(ownFills ? { fills: ownFills } : {}), candles: merged });
      rebuilt.push({ series: key, bars: bars.length });
    }
    const bySrc = [...filled.values()].reduce((a, c) => ({ ...a, [c.src]: (a[c.src] ?? 0) + 1 }), {});
    return { status: "filled", holes: holes.length, missing: holes.reduce((a, h) => a + h.minutes, 0), filled: filled.size, by_source: bySrc, rebuilt };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}
