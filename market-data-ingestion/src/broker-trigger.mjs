// 5m execution for Omega (docs/RFC_OMEGA_5M_EXECUTION.md; owner 2026-11-11 "ya rancang A+C, timing dari
// broker langsung", 2026-11-12: everything on). At each broker 5m close (the cron runs every minute), the
// 5m Prophet producer runs on the broker's M5 bars (aggregated from the Corpus Oracle's M1, cached and
// extended), the other series TradingView's, and the bar's confirmations go to the AI Worker with the
// swing high and low of the last 3 broker 5m bars and the 5m ATR(14), on the broker's own scale
// (submitBrokerTrigger). Below 400 broker M5 bars only the structure is sent (ready: false) and the
// TradingView 5m confirmation stays the trigger. Switch: BROKER_TRIGGER_MODE = "on" (default) | "off".
import { buildM5LocalCalculations } from "../../local-engines/producer/src/m5-local-producer.mjs";
import { brokerSeries } from "./broker-shadow.mjs";

export const BROKER_M5_KEY = "market-data:v2:broker-trigger:m5";
const LAST_KEY = "market-data:v2:broker-trigger:last";
const M5_S = 300;
const MIN_BARS = 400;
const finite = (x) => typeof x === "number" && Number.isFinite(x);

export function brokerTriggerMode(env) {
  return String(env?.BROKER_TRIGGER_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/** Pure: the swing high and low of the last `n` bars and the ATR(14), or null. */
export function structureOf(bars, n = 3) {
  if (!Array.isArray(bars) || bars.length < 15) return null;
  const last = bars.slice(-n);
  const tr = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }
  const atr = tr.reduce((s, x) => s + x, 0) / tr.length;
  const r = (x) => Math.round(x * 1000) / 1000;
  return { swing_high: r(Math.max(...last.map((b) => b.high))), swing_low: r(Math.min(...last.map((b) => b.low))), atr: r(atr) };
}

/** Cron step: the broker 5m bar's trigger, once per broker 5m close. Never throws. */
export async function runBrokerTrigger(env, { bundle, now = Date.now() } = {}) {
  if (brokerTriggerMode(env) === "off") return { status: "off" };
  if (typeof env?.AI_WORKER?.corpusBars !== "function" || typeof env?.AI_WORKER?.submitBrokerTrigger !== "function") return { status: "unavailable" };
  const kv = env.MARKET_DATA_CACHE;
  try {
    const broker = await brokerSeries(env, { now, seconds: M5_S, key: BROKER_M5_KEY });
    const last = broker.candles.at(-1);
    if (!last) return { status: "no_broker_bars" };
    const closeMs = (last.time + M5_S) * 1000;
    if (now - closeMs > 6 * 60_000) return { status: "stale", last_close: new Date(closeMs).toISOString() };
    if (Number((await kv.get(LAST_KEY)) || 0) === closeMs) return { status: "already_sent" };
    const structure = structureOf(broker.candles);
    if (!structure) return { status: "insufficient_history", broker_bars: broker.candles.length };
    let ready = false, buy = false, sell = false, error = null;
    if (broker.candles.length >= MIN_BARS && bundle?.timeframes) {
      try {
        const built = buildM5LocalCalculations({ ...bundle, timeframes: { ...bundle.timeframes, M5: { ...(bundle.timeframes.M5 || {}), candles: broker.candles } } }, { now, mintick: Number(env.CHART_MINTICK) || 0.001 });
        const r38 = built.records.find((r) => r.engine === "prophet")?.values?.comparable?.prophet_r38;
        if (r38) { ready = true; buy = r38.buy_confirmed === true; sell = r38.sell_confirmed === true; }
      } catch (e) { error = String(e?.code || e?.message || e).slice(0, 80); }
    }
    const result = await env.AI_WORKER.submitBrokerTrigger({ close_ms: closeMs, ready, buy_confirmed: buy, sell_confirmed: sell, ...structure, bars: broker.candles.length, source: broker.source });
    if (result?.ok) await kv.put(LAST_KEY, String(closeMs), { expirationTtl: 3600 });
    return { status: result?.ok ? "sent" : "refused", close: new Date(closeMs).toISOString(), ready, buy, sell, broker_bars: broker.candles.length, ...(error ? { engine_error: error } : {}) };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}
