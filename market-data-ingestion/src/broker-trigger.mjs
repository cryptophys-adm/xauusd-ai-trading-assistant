// 5m execution for Omega (docs/RFC_OMEGA_5M_EXECUTION.md; owner 2026-11-11 "ya rancang A+C, timing dari
// broker langsung", 2026-11-12: everything on). At each broker 5m close (the cron runs every minute), the
// 5m Prophet producer runs on the broker's M5 bars (aggregated from the Corpus Oracle's M1, cached and
// extended), the other series TradingView's, and the bar's confirmations go to the AI Worker with the
// swing high and low of the last 3 broker 5m bars and the 5m ATR(14), on the broker's own scale
// (submitBrokerTrigger). Below 400 broker M5 bars only the structure is sent (ready: false) and the
// TradingView 5m confirmation stays the trigger. Switch: BROKER_TRIGGER_MODE = "on" (default) | "off".
import { buildM5LocalCalculations } from "../../local-engines/producer/src/m5-local-producer.mjs";
import { calculateProphetR38Core } from "../../local-engines/prophet-r38/src/core.mjs";
import { brokerSeries } from "./broker-shadow.mjs";

export const BROKER_M5_KEY = "market-data:v2:broker-trigger:m5";
const LAST_KEY = "market-data:v2:broker-trigger:last";
const M5_S = 300;
const MIN_BARS = 400;
const finite = (x) => typeof x === "number" && Number.isFinite(x);

export function brokerTriggerMode(env) {
  return String(env?.BROKER_TRIGGER_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

// C1 (cost brief 2026-11-27, orchestrator OK): the trigger reads only Prophet R38's buy/sell confirmation of the last
// broker 5m bar, yet built every 5m engine (R38, R37, GMI, Mizan) with the full HTF series; R38's HTF alignment
// (buildHtfAlignment in the protected prophet-r38/src/core.mjs, not edited) scans every HTF bar for every chart bar,
// about 2.5-3 s per run. BROKER_TRIGGER_R38_ONLY "on" (default) calls calculateProphetR38Core directly with exactly the
// producer's arguments (m5-local-producer.mjs: the last 1000 bars, confirmed, 5 minutes, closed-only HTF, the
// mintick), each HTF series trimmed to start HTF_KEEP_BEFORE bars before the HTF bar the first chart bar reads. The
// HTF z-score at bar j reads only bars j-49..j (kwwAt, length 50) and the bar a chart bar reads only moves forward in
// time, so every selected z, and so every output, is unchanged (trimHigherTimeframes; tests BT-C1). "shadow" keeps the
// full producer live, computes the R38-only result beside it and counts matches (recordShadow); "off" is the full
// producer alone.
export const M5_WINDOW = 1000;
export const HTF_KEEP_BEFORE = 60;
const HTF_MINUTES = Object.freeze({ M15: 15, H1: 60, H4: 240, D1: 1440, W1: 10080 });
const frameBars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

export function brokerTriggerR38Mode(env) {
  const v = String(env?.BROKER_TRIGGER_R38_ONLY ?? "on").trim().toLowerCase();
  return v === "off" || v === "shadow" ? v : "on";
}

const htfCloseMs = (bar, tf) => (bar?.close_time && finite(Date.parse(bar.close_time)) ? Date.parse(bar.close_time) : Date.parse(bar?.open_time) + HTF_MINUTES[tf] * 60_000);

/**
 * Pure: each HTF series from HTF_KEEP_BEFORE bars before the bar the first chart bar reads (the core's own rule: the
 * bar containing it, else the last closed before it). A series whose bars are not in order without overlap (each opens
 * after the previous one and no earlier than its close) is kept whole.
 */
export function trimHigherTimeframes(chartBars, higher, keepBefore = HTF_KEEP_BEFORE) {
  const first = Date.parse(chartBars?.[0]?.open_time);
  const out = {};
  for (const [tf, list] of Object.entries(higher || {})) {
    const arr = Array.isArray(list) ? list : [];
    let rising = finite(first);
    for (let j = 1; rising && j < arr.length; j++) if (!(Date.parse(arr[j].open_time) > Date.parse(arr[j - 1].open_time)) || !(htfCloseMs(arr[j - 1], tf) <= Date.parse(arr[j].open_time))) rising = false;
    if (!rising || !(tf in HTF_MINUTES)) { out[tf] = arr; continue; }
    let sel = arr.findIndex((b) => { const s = Date.parse(b.open_time), e = htfCloseMs(b, tf); return finite(s) && finite(e) && s <= first && first < e; });
    if (sel >= 0) sel -= 1;
    else for (let j = 0; j < arr.length; j++) if (htfCloseMs(arr[j], tf) <= first) sel = j;
    out[tf] = sel - keepBefore > 0 ? arr.slice(sel - keepBefore) : arr;
  }
  return out;
}

/** The last broker 5m bar's R38 confirmation, as buildM5LocalCalculations computes it, with the HTF trimmed. Throws like it. */
export function brokerR38(bundle, candles, { now = Date.now(), mintick = 0.001, trim = true } = {}) {
  const m5 = (Array.isArray(candles) ? candles : []).slice(-M5_WINDOW);
  if (m5.length < MIN_BARS) throw Object.assign(new Error(`insufficient 5m history: ${m5.length} < ${MIN_BARS}`), { code: "insufficient_m5_history" });
  const last = m5.at(-1);
  const openMs = Date.parse(last.open_time);
  if (!finite(openMs) || Date.parse(last.close_time) > now) throw Object.assign(new Error("latest 5m bar is not closed"), { code: "m5_bar_not_closed" });
  if (Date.parse(last.close_time) - openMs !== M5_S * 1000) throw Object.assign(new Error("latest bar is not a 5m bar"), { code: "m5_bar_invalid" });
  const tf = bundle?.timeframes || {};
  const higher = { M15: frameBars(tf.M15), H1: frameBars(tf.H1), H4: frameBars(tf.H4), D1: frameBars(tf.D1), W1: frameBars(tf.W1) };
  const r38 = calculateProphetR38Core(m5.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: 5, gmi_closed_only: true, mintick, higher_timeframes: trim ? trimHigherTimeframes(m5, higher) : higher
  });
  const o = r38.outputs.at(-1);
  return { buy: o.confirmation?.buy_confirmed === true, sell: o.confirmation?.sell_confirmed === true };
}

/**
 * The "shadow" tally per UTC day (KV R38_SHADOW_KEY, 14 days): bars compared, mismatches, failed full runs and the
 * last mismatch's close; the evidence for switching to "on". One small write per broker 5m close while in shadow.
 */
export const R38_SHADOW_KEY = "market-data:v2:broker-trigger:r38-shadow";
export async function recordShadow(kv, { now = Date.now(), closeMs, outcome }) {
  if (!kv?.get || !kv?.put) return null;
  let doc = null;
  try { doc = JSON.parse((await kv.get(R38_SHADOW_KEY)) || "null"); } catch { doc = null; }
  const days = doc && typeof doc.days === "object" && doc.days ? { ...doc.days } : {};
  const day = new Date(now).toISOString().slice(0, 10);
  const d = { compared: 0, mismatched: 0, failed: 0, last_mismatch_close: null, ...(days[day] || {}) };
  if (outcome === "failed") d.failed += 1;
  else { d.compared += 1; if (outcome === "mismatch") { d.mismatched += 1; d.last_mismatch_close = new Date(closeMs).toISOString(); } }
  days[day] = d;
  const kept = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).slice(-14));
  await kv.put(R38_SHADOW_KEY, JSON.stringify({ v: 1, days: kept }), { expirationTtl: 60 * 60 * 24 * 30 });
  return d;
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
    let ready = false, buy = false, sell = false, error = null, shadow = null;
    if (broker.candles.length >= MIN_BARS && bundle?.timeframes) {
      const mintick = Number(env.CHART_MINTICK) || 0.001;
      const full = () => {
        const built = buildM5LocalCalculations({ ...bundle, timeframes: { ...bundle.timeframes, M5: { ...(bundle.timeframes.M5 || {}), candles: broker.candles } } }, { now, mintick });
        const r38 = built.records.find((r) => r.engine === "prophet")?.values?.comparable?.prophet_r38;
        return r38 ? { buy: r38.buy_confirmed === true, sell: r38.sell_confirmed === true } : null;
      };
      const mode = brokerTriggerR38Mode(env);
      try {
        // "shadow": the full producer stays the live path; the R38-only result is computed beside it and compared.
        const got = mode === "on" ? brokerR38(bundle, broker.candles, { now, mintick }) : full();
        if (got) { ready = true; buy = got.buy; sell = got.sell; }
        if (mode === "shadow" && got) {
          let outcome = "match";
          try { const cut = brokerR38(bundle, broker.candles, { now, mintick }); if (cut.buy !== got.buy || cut.sell !== got.sell) { outcome = "mismatch"; console.log("broker_trigger_r38_mismatch", JSON.stringify({ close: new Date(closeMs).toISOString(), full: got, r38_only: cut })); } }
          catch (e) { outcome = "failed"; console.log("broker_trigger_r38_shadow_failed", String(e?.code || e?.message || e).slice(0, 80)); }
          shadow = outcome;
          await recordShadow(kv, { now, closeMs, outcome });
        }
      } catch (e) { error = String(e?.code || e?.message || e).slice(0, 80); }
    }
    const result = await env.AI_WORKER.submitBrokerTrigger({ close_ms: closeMs, ready, buy_confirmed: buy, sell_confirmed: sell, ...structure, bars: broker.candles.length, source: broker.source });
    if (result?.ok) await kv.put(LAST_KEY, String(closeMs), { expirationTtl: 3600 });
    return { status: result?.ok ? "sent" : "refused", close: new Date(closeMs).toISOString(), ready, buy, sell, broker_bars: broker.candles.length, ...(shadow ? { r38_shadow: shadow } : {}), ...(error ? { engine_error: error } : {}) };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}
