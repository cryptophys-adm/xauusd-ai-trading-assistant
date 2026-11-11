// Corpus Oracle phase 2 (docs/RFC_CORPUS_ORACLE.md; owner 2026-11-11 "All", the deferred plans): the
// local engines on the broker's bars, as a shadow lane that feeds nothing.
//
// At each 15m close that the TradingView lane publishes, the same 15m producer (Prophet R38, the shared
// Prophet core, GMI) runs once more with the broker's M15 bars (aggregated from the Corpus Oracle's M1, the
// AI Worker's corpusBars) in place of TradingView's, every other series unchanged. The two records'
// comparable fields are compared field by field, and only the agreement goes to the AI Worker
// (recordBrokerShadow). Nothing enters the parity registry, a room, a decision or a signal: the broker's
// bars differ from OANDA's by the basis, so TradingView's parity can never vouch for them; the agreement
// measures how far the engines' reading of the broker's chart follows TradingView's.
//
// The broker's M15 series is cached in KV and extended with the new minutes only. Skipped while the MT5
// fallback runs (both lanes would read the broker's bars). Switch: BROKER_SHADOW_MODE = "on" | "off".
import { buildM15LocalCalculations } from "../../local-engines/producer/src/m15-local-producer.mjs";
import { aggregateCandles } from "./derived-series.mjs";
import { brokerCandles } from "./mt5-fallback.mjs";

export const BROKER_M15_KEY = "market-data:v2:broker-shadow:m15";
const M15_S = 900;
const KEEP_BARS = 1000;
const MIN_BARS = 400;
const FIRST_FETCH_DAYS = 9;
const MAX_PAGES = 10;

export function brokerShadowMode(env) {
  return String(env?.BROKER_SHADOW_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/** Pure: the comparable leaves of two records, side by side: { fields, matched, mismatched[] }. */
export function compareComparable(a, b, prefix = "") {
  let fields = 0, matched = 0;
  const mismatched = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of [...keys].sort()) {
    const x = a?.[k], y = b?.[k], path = prefix ? `${prefix}.${k}` : k;
    if ((x && typeof x === "object" && !Array.isArray(x)) || (y && typeof y === "object" && !Array.isArray(y))) {
      const inner = compareComparable(x, y, path);
      fields += inner.fields; matched += inner.matched; mismatched.push(...inner.mismatched);
      continue;
    }
    fields += 1;
    const same = typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) : JSON.stringify(x) === JSON.stringify(y);
    if (same) matched += 1; else mismatched.push(path);
  }
  return { fields, matched, mismatched };
}

/** The broker's M15 bars, cached and extended with the new minutes. Never throws; [] when none. */
export async function brokerM15(env, { now = Date.now() } = {}) {
  const kv = env?.MARKET_DATA_CACHE;
  let cached = [];
  try { cached = JSON.parse((await kv?.get?.(BROKER_M15_KEY)) || "null")?.candles || []; } catch { cached = []; }
  const nowSec = Math.floor(now / 1000);
  const lastSec = cached.at(-1)?.time ?? null;
  let since = lastSec != null ? (lastSec + M15_S) * 1000 - 60_000 : now - FIRST_FETCH_DAYS * 86_400_000;
  const minutes = [];
  let source = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await env.AI_WORKER.corpusBars({ since_ms: since, limit: 1500 });
    const bars = r?.bars || [];
    source = r?.source ?? source;
    minutes.push(...bars);
    if (bars.length < 1500) break;
    since = bars.at(-1).t;
  }
  const after = lastSec ?? -Infinity;
  const fresh = aggregateCandles(brokerCandles(minutes, nowSec), { seconds: M15_S, sourceSeconds: 60, nowSec, after });
  // A bucket the fetched minutes do not cover from its start is not built (the first fetch's oldest one).
  const firstMinute = minutes.length ? Math.floor(minutes[0].t / 1000) : Infinity;
  const added = lastSec != null ? fresh : fresh.filter((c) => c.time >= firstMinute);
  const candles = [...cached, ...added].slice(-KEEP_BARS);
  if (added.length) await kv?.put?.(BROKER_M15_KEY, JSON.stringify({ source, candles }));
  return { source, candles };
}

/** After the 15m TradingView records are published: the broker shadow of the same bar. Never throws. */
export async function runBrokerShadow(env, { bundle, tvRecords, candleKey, now = Date.now() } = {}) {
  if (brokerShadowMode(env) === "off") return { status: "off" };
  if (typeof env?.AI_WORKER?.corpusBars !== "function" || typeof env?.AI_WORKER?.recordBrokerShadow !== "function") return { status: "unavailable" };
  if (!bundle || !Array.isArray(tvRecords) || !tvRecords.length) return { status: "no_tradingview_records" };
  if (bundle.feed === "mt5_fallback") return { status: "fallback_running" };
  try {
    const broker = await brokerM15(env, { now });
    const tvLast = bundle.timeframes?.M15?.candles?.at(-1);
    const last = broker.candles.at(-1);
    if (!tvLast || !last || last.time !== tvLast.time) return { status: "not_aligned", broker_bars: broker.candles.length };
    if (broker.candles.length < MIN_BARS) return { status: "insufficient_history", broker_bars: broker.candles.length, needed: MIN_BARS };
    const built = buildM15LocalCalculations({ ...bundle, timeframes: { ...bundle.timeframes, M15: { ...bundle.timeframes.M15, candles: broker.candles } } }, { now, mintick: Number(env.CHART_MINTICK) || 0.001 });
    const engines = {};
    for (const b of built.records) {
      const tv = tvRecords.find((r) => r.engine === b.engine);
      if (!tv) continue;
      const c = compareComparable(b.values?.comparable, tv.values?.comparable);
      if (!c.fields) continue; // an engine with no comparable field (the shared core) says nothing here
      const dir = (r) => r?.values?.comparable?.prophet_r38?.direction ?? r?.values?.comparable?.gmi_v12_70?.gmi_dir ?? r?.values?.comparable?.prophet_r37_ssot?.direction ?? null;
      engines[b.engine] = { fields: c.fields, matched: c.matched, mismatched: c.mismatched.slice(0, 20), direction_match: dir(b) == null && dir(tv) == null ? null : dir(b) === dir(tv) };
    }
    const result = await env.AI_WORKER.recordBrokerShadow({ candle_key: candleKey ?? built.candle_key, source: broker.source, broker_bars: broker.candles.length, engines });
    return { status: "recorded", candle_key: candleKey ?? built.candle_key, engines: Object.keys(engines), stored: result?.stored ?? null };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}
