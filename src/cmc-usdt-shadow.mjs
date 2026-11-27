// CMC USDT shadow sampler (TradingView cleanup, owner 2026-11-27: "gunakan coinmarketcap sudah disediakan API nya").
//
// What TradingView gives today: `CRYPTOCAP:USDT|4h` (500 bars, src/tradingview-source.mjs in the pull adapter). That
// symbol is Tether's MARKET CAPITALISATION in US dollars, not its dominance (dominance is `CRYPTOCAP:USDT.D`); the
// local GMI macro kinematics and the macro room read its rate of change.
//
// This module samples CoinMarketCap once an hour, in shadow only:
//   - `/v2/cryptocurrency/quotes/latest?id=825` (USDT): market cap and CMC's own market-cap dominance;
//   - `/v1/global-metrics/quotes/latest`: the total crypto market cap (for a dominance we compute ourselves).
// It keeps the hourly samples in one KV key, builds 4h bars from them and compares each 4h close with the stored
// TradingView bar of the same open time (absolute and signed relative error in basis points).
//
// Nothing live reads it: no room, decision, engine or page. The switch is `CMC_USDT_SHADOW` ("on" by default, "off"
// stops it); without `CMC_API_KEY` it is dormant. Logs carry status codes, counts and error statistics only: never the
// key, never a value.

export const CMC_HOST = "pro-api.coinmarketcap.com";
export const CMC_USDT_ID = 825;
export const CMC_SHADOW_KEY = "cmc:usdt:shadow:v1";
export const TV_USDT_SERIES_KEY = "market-data:v2:series:CRYPTOCAP:USDT|4h";
export const CMC_KEEP_HOURS = 24 * 35;
export const CMC_TIMEOUT_MS = 8_000;
const HOUR_MS = 3_600_000;
const H4_SEC = 4 * 3600;

export function cmcShadowMode(env) {
  return String(env?.CMC_USDT_SHADOW ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

export function cmcUrls() {
  return {
    quote: `https://${CMC_HOST}/v2/cryptocurrency/quotes/latest?id=${CMC_USDT_ID}&convert=USD`,
    global: `https://${CMC_HOST}/v1/global-metrics/quotes/latest?convert=USD`
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const credit = (j) => { const c = num(j?.status?.credit_count); return c != null && c >= 0 ? c : 0; };

/** The USDT quote: market cap (USD), CMC's dominance (%), and the quote time (ms). Null when the shape is wrong. */
export function parseQuote(j) {
  const d = j?.data?.[String(CMC_USDT_ID)] ?? j?.data?.[CMC_USDT_ID];
  const row = Array.isArray(d) ? d[0] : d;
  const usd = row?.quote?.USD;
  const mcap = num(usd?.market_cap);
  if (mcap == null || mcap <= 0) return null;
  const dom = num(usd?.market_cap_dominance);
  const at = Date.parse(usd?.last_updated ?? "");
  return { mcap, dom: dom != null && dom > 0 && dom < 100 ? dom : null, at: Number.isFinite(at) ? at : null, credit: credit(j) };
}

/** The global metrics: total crypto market cap (USD). Null when the shape is wrong. */
export function parseGlobal(j) {
  const total = num(j?.data?.quote?.USD?.total_market_cap);
  if (total == null || total <= 0) return null;
  return { total, credit: credit(j) };
}

function safeParse(text) { try { return text ? JSON.parse(text) : null; } catch { return null; } }

/**
 * 4h bars from hourly samples, aligned to the UTC 4h grid as TradingView's bars are. A bar opened at T has open =
 * the sample of hour T, high/low over the samples of hours T..T+4h, and close = the sample of hour T+4h (the first
 * sample after the bar closed). A bar without both its open and close sample is left out.
 */
export function bars4hFromSamples(samples) {
  const byHour = new Map();
  for (const s of samples || []) if (Number.isFinite(s?.h) && num(s?.mcap) != null) byHour.set(s.h, s);
  const opens = [...byHour.keys()].filter((h) => (h / 1000) % H4_SEC === 0).sort((a, b) => a - b);
  const bars = [];
  for (const t of opens) {
    const open = byHour.get(t), close = byHour.get(t + 4 * HOUR_MS);
    if (!open || !close) continue;
    const inBar = [0, 1, 2, 3, 4].map((k) => byHour.get(t + k * HOUR_MS)).filter(Boolean).map((s) => s.mcap);
    bars.push({ time: t / 1000, open: open.mcap, high: Math.max(...inBar), low: Math.min(...inBar), close: close.mcap, n: inBar.length });
  }
  return bars;
}

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : null;
const bp1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** The CMC 4h closes against the stored TradingView bars of the same open time: error in basis points. */
export function compareWithTv(bars, tvCandles) {
  const tv = new Map();
  for (const c of tvCandles || []) { const t = num(c?.time), close = num(c?.close); if (t != null && close != null && close > 0) tv.set(t, close); }
  const errs = [];
  for (const b of bars || []) { const ref = tv.get(b.time); if (ref != null) errs.push(((b.close - ref) / ref) * 10_000); }
  if (!errs.length) return { compared: 0, tv_bars: tv.size };
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  return {
    compared: errs.length, tv_bars: tv.size,
    median_abs_bp: bp1(quantile(abs, 0.5)), p90_abs_bp: bp1(quantile(abs, 0.9)), max_abs_bp: bp1(abs[abs.length - 1]),
    mean_signed_bp: bp1(errs.reduce((a, b) => a + b, 0) / errs.length)
  };
}

async function getJson(fetchImpl, url, key) {
  const res = await fetchImpl(url, { headers: { accept: "application/json", "X-CMC_PRO_API_KEY": key }, signal: AbortSignal.timeout(CMC_TIMEOUT_MS) });
  const body = res.ok ? safeParse(await res.text()) : null;
  return { status: res.status, body };
}

/**
 * One shadow step; called from every sweep, it samples at most once per UTC hour (a failed hour is not retried until
 * the next one). Returns a summary without values.
 */
export async function runCmcUsdtStep(env, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  if (cmcShadowMode(env) === "off") return { status: "off" };
  const key = typeof env?.CMC_API_KEY === "string" ? env.CMC_API_KEY.trim() : "";
  if (!key) return { status: "no_key" };
  const kv = env?.SIGNAL_CACHE;
  if (!kv?.get || !kv?.put || typeof fetchImpl !== "function") return { status: "unavailable" };
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const state = safeParse(await kv.get(CMC_SHADOW_KEY)) || {};
  const samples = Array.isArray(state.samples) ? state.samples : [];
  if (samples.some((s) => s?.h === hour) || state.fail_hour === hour) return { status: "not_due" };

  const day = new Date(hour).toISOString().slice(0, 10);
  const credits = state.credits?.day === day ? { ...state.credits } : { day, n: 0 };
  const urls = cmcUrls();
  let q, g;
  try {
    [q, g] = await Promise.all([getJson(fetchImpl, urls.quote, key), getJson(fetchImpl, urls.global, key)]);
  } catch (e) {
    const fails = (Number(state.fails) || 0) + 1;
    await kv.put(CMC_SHADOW_KEY, JSON.stringify({ ...state, samples, credits, fail_hour: hour, fails, last_error: e?.name === "TimeoutError" ? "timeout" : "fetch_failed" }));
    return { status: "fetch_failed", reason: e?.name === "TimeoutError" ? "timeout" : "fetch_failed", fails };
  }
  const quote = q.status === 200 ? parseQuote(q.body) : null;
  const global = g.status === 200 ? parseGlobal(g.body) : null;
  credits.n += (quote?.credit ?? 0) + (global?.credit ?? 0);
  if (!quote) {
    const fails = (Number(state.fails) || 0) + 1;
    await kv.put(CMC_SHADOW_KEY, JSON.stringify({ ...state, samples, credits, fail_hour: hour, fails, last_error: q.status === 200 ? "bad_shape" : `http_${q.status}` }));
    return { status: q.status === 200 ? "bad_shape" : "http_error", http: { quote: q.status, global: g.status }, fails };
  }
  const sample = {
    h: hour, at: now, q_at: quote.at, mcap: quote.mcap, cmc_dom: quote.dom,
    total: global?.total ?? null, dom: global?.total ? Math.round((quote.mcap / global.total) * 1e6) / 1e4 : null
  };
  const kept = [...samples.filter((s) => s?.h !== hour), sample].sort((a, b) => a.h - b.h).slice(-CMC_KEEP_HOURS);
  const tv = safeParse(await kv.get(TV_USDT_SERIES_KEY));
  const compare = compareWithTv(bars4hFromSamples(kept), tv?.candles);
  await kv.put(CMC_SHADOW_KEY, JSON.stringify({ v: 1, samples: kept, credits, fails: 0, fail_hour: null, last_ok: now, compare }));
  return { status: "sampled", samples: kept.length, http: { quote: q.status, global: g.status }, global: global ? "ok" : "missing", credits_today: credits.n, compare };
}

/** The shadow's state without values, for a report. */
export async function cmcUsdtShadowSummary(env) {
  const state = safeParse(await env?.SIGNAL_CACHE?.get?.(CMC_SHADOW_KEY));
  if (!state) return { status: "empty" };
  const samples = Array.isArray(state.samples) ? state.samples : [];
  return {
    status: "ok", samples: samples.length, first_hour: samples[0] ? new Date(samples[0].h).toISOString() : null,
    last_hour: samples.length ? new Date(samples[samples.length - 1].h).toISOString() : null, bars_4h: bars4hFromSamples(samples).length,
    credits: state.credits ?? null, fails: Number(state.fails) || 0, compare: state.compare ?? null
  };
}
