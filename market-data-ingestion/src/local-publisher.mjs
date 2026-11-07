// Publishes local_computation records for each newly closed H1 bar to the AI
// Worker through its LocalComputationIngress RPC entrypoint. The AI Worker stores them as
// observed and lets its autonomous parity registry decide trust by comparing
// them with the TradingView webhook outputs for the same candle_key.
import { buildBundle } from "./tradingview-source.mjs";
import { buildH1LocalCalculations, CHART_TICKERID } from "../../local-engines/producer/src/h1-producer.mjs";
import { buildM5LocalCalculations } from "../../local-engines/producer/src/m5-local-producer.mjs";
import { buildM15LocalCalculations } from "../../local-engines/producer/src/m15-local-producer.mjs";
import { buildHtfLocalCalculations, HTF_CHARTS } from "../../local-engines/producer/src/htf-local-producer.mjs";
import { m5ContextFromRecords } from "../../local-engines/producer/src/m5-context.mjs";
import { buildHudSnapshot } from "../../local-engines/producer/src/hud-snapshot.mjs";
import { buildGmiHudRecord } from "../../local-engines/producer/src/gmi-hud-producer.mjs";

const PUBLISHED_PREFIX = "market-data:v2:local-published:";
export const LAST_PUBLISH_KEY = "market-data:v2:local-last-publish";
export const LAST_M5_PUBLISH_KEY = "market-data:v2:local-last-publish-m5";
// 5m records are published only for the bar that just closed (the cron runs every 5 minutes).
const MAX_M5_PUBLISH_DELAY_MS = 9 * 60 * 1000;
// The AI Worker rejects local outputs older than 30 minutes; publish only fresh closes.
const MAX_PUBLISH_DELAY_MS = 25 * 60 * 1000;

const asString = (v) => (typeof v === "string" ? v : "");

/**
 * The gmi_hud parity record of a built H1 candle (Grid Bot Protocol comparator, RFC_HUD_AGENTS §3).
 * Posted apart from the engine records: its result never decides the publish marker, so a HUD
 * parity failure can neither block nor repeat the H1 engine publish.
 */
async function publishGmiHud(env, built, bundle) {
  let record = null;
  try { record = buildGmiHudRecord(built, bundle, { mintick: Number(env.CHART_MINTICK) || 0.001 }); }
  catch (error) { return { engine: "gmi_hud", http_status: null, error: asString(error?.code) || "gmi_hud_failed" }; }
  if (!record) return { engine: "gmi_hud", http_status: null, error: "not_produced" };
  try { return await postRecord(env, record); }
  catch (error) { return { engine: "gmi_hud", http_status: null, error: asString(error?.name) || "post_failed" }; }
}

async function postRecord(env, record) {
  // RPC Service Binding (entrypoint "LocalComputationIngress" on the AI Worker).
  const { status, body } = await env.AI_WORKER.submit(record);
  return {
    engine: record.engine,
    http_status: status,
    trust_status: asString(body?.trust_status) || null,
    analysis_status: asString(body?.analysis_status) || null,
    error: status < 300 ? null : (asString(body?.error) || "ai_worker_rejected"),
    validation_errors: Array.isArray(body?.validation_errors) ? body.validation_errors.slice(0, 10) : undefined
  };
}

export async function publishLocalComputation(env, { now = Date.now(), force = false, bundle = null } = {}) {
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: "cache_not_configured" };
  if (typeof env.AI_WORKER?.submit !== "function") return { status: "publisher_not_configured" };
  const resolvedBundle = bundle || await buildBundle(env, now);
  const lastH1 = resolvedBundle.timeframes?.H1?.candles?.at(-1);
  if (!lastH1) return { status: "no_h1_data" };
  const closedAgo = now - Date.parse(lastH1.close_time);
  if (!force && closedAgo > MAX_PUBLISH_DELAY_MS) return { status: "no_fresh_h1_close", last_h1_close_time: lastH1.close_time };

  let built;
  try {
    built = buildH1LocalCalculations(resolvedBundle, { now, mintick: Number(env.CHART_MINTICK) || 0.001 });
  } catch (error) {
    return { status: asString(error?.code) || "local_computation_failed", message: asString(error?.message).slice(0, 200) };
  }
  const markerKey = PUBLISHED_PREFIX + built.candle_key;
  if (!force && (await kv.get(markerKey))) return { status: "already_published", candle_key: built.candle_key };

  const results = [];
  for (const record of built.records) {
    try {
      results.push(await postRecord(env, record));
    } catch (error) {
      results.push({ engine: record.engine, http_status: null, error: asString(error?.name) || "post_failed" });
    }
  }
  const ok = results.every((r) => r.http_status && r.http_status < 300);
  const hudParity = await publishGmiHud(env, built, resolvedBundle);
  const summary = {
    status: ok ? "published" : "partial_failure",
    candle_key: built.candle_key,
    candle_time: built.candle_time,
    published_at: new Date(now).toISOString(),
    engines: results,
    hud_parity: hudParity,
    not_produced: built.records.some((r) => r.engine === "gmi") ? [] : ["gmi"],
    gmi_error: built.gmi_error || null,
    // The bar the records were built on, so a later revision of it can be detected.
    bar: barSnapshot(lastH1)
  };
  if (ok) await kv.put(markerKey, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  await kv.put(LAST_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  return summary;
}

const barSnapshot = (b) => (b ? { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null } : null);
const sameBar = (a, b) => !!a && !!b && ["open", "high", "low", "close", "volume"].every((k) => a[k] === b[k]);

/** The bundle as it was at `closeMs`: every series cut to the bars closed by then. */
export function bundleUntil(bundle, closeMs) {
  const cut = (f) => (f ? { ...f, candles: (f.candles || []).filter((c) => Date.parse(c.close_time) <= closeMs) } : f);
  const timeframes = Object.fromEntries(Object.entries(bundle?.timeframes || {}).map(([k, f]) => [k, cut(f)]));
  const external = Object.fromEntries(Object.entries(bundle?.external_series || {}).map(([sym, frames]) => [sym, Object.fromEntries(Object.entries(frames || {}).map(([k, f]) => [k, cut(f)]))]));
  return { ...bundle, timeframes, context_timeframes: { D1: timeframes.D1, W1: timeframes.W1 }, external_series: external };
}

/** H1 bars checked for a revision after their records were published (newest first). */
export const H1_REVISION_LOOKBACK = 3;

/**
 * Self-healing input (gap 1, owner decision 2026-11-06): when TradingView revises an H1 bar after
 * its local records were published (the overlap re-pull of the next close merges the final bar),
 * the records are rebuilt on the bar as it was then, cut at its close, and published once more.
 * The AI Worker compares them again: a former input mismatch is replaced and counts.
 */
export async function republishRevisedH1(env, { now = Date.now(), bundle = null } = {}) {
  const kv = env.MARKET_DATA_CACHE;
  if (!kv || typeof env.AI_WORKER?.submit !== "function") return { status: "not_configured" };
  const resolvedBundle = bundle || await buildBundle(env, now);
  const h1 = resolvedBundle.timeframes?.H1?.candles || [];
  const out = [];
  for (const bar of h1.slice(-H1_REVISION_LOOKBACK).reverse()) {
    const candleKey = "OANDA:XAUUSD:60:" + Date.parse(bar.open_time);
    let marker = null;
    try { marker = JSON.parse((await kv.get(PUBLISHED_PREFIX + candleKey)) || "null"); } catch { marker = null; }
    if (!marker?.bar || marker.republished_at || sameBar(marker.bar, barSnapshot(bar))) continue;
    let built;
    try {
      built = buildH1LocalCalculations(bundleUntil(resolvedBundle, Date.parse(bar.close_time)), { now, mintick: Number(env.CHART_MINTICK) || 0.001 });
    } catch (error) {
      out.push({ candle_key: candleKey, status: asString(error?.code) || "local_computation_failed" });
      continue;
    }
    if (built.candle_key !== candleKey) { out.push({ candle_key: candleKey, status: "candle_key_mismatch" }); continue; }
    const results = [];
    for (const record of built.records) {
      try { results.push(await postRecord(env, record)); }
      catch (error) { results.push({ engine: record.engine, http_status: null, error: asString(error?.name) || "post_failed" }); }
    }
    const ok = results.every((r) => r.http_status && r.http_status < 300);
    // The revised bar changes the Grid Bot fields too: republish the HUD parity record with it.
    const hudParity = await publishGmiHud(env, built, bundleUntil(resolvedBundle, Date.parse(bar.close_time)));
    if (ok) {
      await kv.put(PUBLISHED_PREFIX + candleKey, JSON.stringify({ ...marker, bar: barSnapshot(bar), previous_bar: marker.bar, republished_at: new Date(now).toISOString() }), { expirationTtl: 60 * 60 * 24 * 7 });
    }
    out.push({ candle_key: candleKey, status: ok ? "republished" : "partial_failure", previous_bar: marker.bar, bar: barSnapshot(bar), engines: results, hud_parity: hudParity });
  }
  return { status: out.length ? "revised" : "unchanged", candles: out };
}

/**
 * C0 verified 5m lane: publishes the mizan/prophet/gmi records of the latest
 * closed 5m bar. The AI Worker stores them as observed, compares them with the
 * 5m webhooks under timeframe-scoped registry ids (prophet_m5, gmi_m5) and never
 * starts the H1 chain for them. Enabled only when M5_PARITY_PUBLISH is "true".
 */
export async function publishM5LocalComputation(env, { now = Date.now(), force = false, bundle = null } = {}) {
  if (String(env.M5_PARITY_PUBLISH || "").toLowerCase() !== "true") return { status: "m5_publish_disabled" };
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: "cache_not_configured" };
  if (typeof env.AI_WORKER?.submit !== "function") return { status: "publisher_not_configured" };
  const resolvedBundle = bundle || await buildBundle(env, now);
  const lastM5 = resolvedBundle.timeframes?.M5?.candles?.at(-1);
  if (!lastM5) return { status: "no_m5_data" };
  const closedAgo = now - Date.parse(lastM5.close_time);
  if (!force && closedAgo > MAX_M5_PUBLISH_DELAY_MS) return { status: "no_fresh_m5_close", last_m5_close_time: lastM5.close_time };

  let built;
  try {
    built = buildM5LocalCalculations(resolvedBundle, { now, mintick: Number(env.CHART_MINTICK) || 0.001 });
  } catch (error) {
    return { status: asString(error?.code) || "local_computation_failed", message: asString(error?.message).slice(0, 200) };
  }
  const markerKey = PUBLISHED_PREFIX + built.candle_key;
  if (!force && (await kv.get(markerKey))) return { status: "already_published", candle_key: built.candle_key };

  const results = [];
  for (const record of built.records) {
    try {
      results.push(await postRecord(env, record));
    } catch (error) {
      results.push({ engine: record.engine, http_status: null, error: asString(error?.name) || "post_failed" });
    }
  }
  const ok = results.every((r) => r.http_status && r.http_status < 300);
  const summary = {
    status: ok ? "published" : "partial_failure",
    timeframe: "5",
    candle_key: built.candle_key,
    candle_time: built.candle_time,
    published_at: new Date(now).toISOString(),
    engines: results,
    not_produced: built.records.some((r) => r.engine === "gmi") ? [] : ["gmi"],
    gmi_error: built.gmi_error || null
  };
  if (ok) await kv.put(markerKey, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 });
  await kv.put(LAST_M5_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  // B2: the 5m execution context of the same bar, reshaped from its parity record (never
  // stored here; the cron forwards it to the AI Worker's submitContext).
  return { ...summary, context: m5ContextFromRecords(built, resolvedBundle.timeframes?.M5?.candles) };
}

export const LAST_M15_PUBLISH_KEY = "market-data:v2:local-last-publish-m15";
// The cron runs every 5 minutes: a 15m close is published by the first run after it.
const MAX_M15_PUBLISH_DELAY_MS = 9 * 60 * 1000;

/**
 * Verified 15m lane (owner decision 2026-11-05): publishes the 15m local records for parity,
 * like the 5m lane, once per closed 15m bar. Enabled only when M15_PARITY_PUBLISH is "true".
 */
export async function publishM15LocalComputation(env, { now = Date.now(), force = false, bundle = null } = {}) {
  if (String(env.M15_PARITY_PUBLISH || "").toLowerCase() !== "true") return { status: "m15_publish_disabled" };
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: "cache_not_configured" };
  if (typeof env.AI_WORKER?.submit !== "function") return { status: "publisher_not_configured" };
  const resolvedBundle = bundle || await buildBundle(env, now);
  const lastM15 = resolvedBundle.timeframes?.M15?.candles?.at(-1);
  if (!lastM15) return { status: "no_m15_data" };
  if (!force && now - Date.parse(lastM15.close_time) > MAX_M15_PUBLISH_DELAY_MS) return { status: "no_fresh_m15_close", last_m15_close_time: lastM15.close_time };
  let built;
  try {
    built = buildM15LocalCalculations(resolvedBundle, { now, mintick: Number(env.CHART_MINTICK) || 0.001 });
  } catch (error) {
    return { status: asString(error?.code) || "local_computation_failed", message: asString(error?.message).slice(0, 200) };
  }
  const markerKey = PUBLISHED_PREFIX + built.candle_key;
  if (!force && (await kv.get(markerKey))) return { status: "already_published", candle_key: built.candle_key };
  const results = [];
  for (const record of built.records) {
    try {
      results.push(await postRecord(env, record));
    } catch (error) {
      results.push({ engine: record.engine, http_status: null, error: asString(error?.name) || "post_failed" });
    }
  }
  const ok = results.every((r) => r.http_status && r.http_status < 300);
  const summary = {
    status: ok ? "published" : "partial_failure",
    timeframe: "15",
    candle_key: built.candle_key,
    candle_time: built.candle_time,
    published_at: new Date(now).toISOString(),
    engines: results,
    not_produced: built.records.some((r) => r.engine === "gmi") ? [] : ["gmi"],
    gmi_error: built.gmi_error || null
  };
  if (ok) await kv.put(markerKey, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 });
  await kv.put(LAST_M15_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  return summary;
}

/** H4/D1 lane (owner decision 2026-11-05): last publish summary per chart. */
export const LAST_HTF_PUBLISH_KEY = "market-data:v2:local-last-publish-htf";
const MAX_HTF_PUBLISH_DELAY_MS = Object.freeze({ H4: 30 * 60 * 1000, D1: 60 * 60 * 1000 });

/**
 * Publishes the local records of the latest closed H4 and D1 bars (timeframes "240" and
 * "1D") for parity against the TradingView alerts on those charts. Flag-gated by
 * HTF_PARITY_PUBLISH; each candle is published once.
 */
export async function publishHtfLocalComputation(env, { now = Date.now(), force = false, bundle = null } = {}) {
  if (String(env.HTF_PARITY_PUBLISH || "").toLowerCase() !== "true") return { status: "htf_publish_disabled" };
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: "cache_not_configured" };
  if (typeof env.AI_WORKER?.submit !== "function") return { status: "publisher_not_configured" };
  const resolvedBundle = bundle || await buildBundle(env, now);
  const charts = {};
  for (const chart of Object.keys(HTF_CHARTS)) {
    const last = resolvedBundle.timeframes?.[chart]?.candles?.at(-1);
    if (!last) { charts[chart] = { status: "no_data" }; continue; }
    if (!force && now - Date.parse(last.close_time) > MAX_HTF_PUBLISH_DELAY_MS[chart]) { charts[chart] = { status: "no_fresh_close", last_close_time: last.close_time }; continue; }
    let built;
    try {
      built = buildHtfLocalCalculations(resolvedBundle, { chart, now, mintick: Number(env.CHART_MINTICK) || 0.001 });
    } catch (error) {
      charts[chart] = { status: asString(error?.code) || "local_computation_failed", message: asString(error?.message).slice(0, 200) };
      continue;
    }
    const markerKey = PUBLISHED_PREFIX + built.candle_key;
    if (!force && (await kv.get(markerKey))) { charts[chart] = { status: "already_published", candle_key: built.candle_key }; continue; }
    const results = [];
    for (const record of built.records) {
      try { results.push(await postRecord(env, record)); }
      catch (error) { results.push({ engine: record.engine, http_status: null, error: asString(error?.name) || "post_failed" }); }
    }
    const ok = results.every((r) => r.http_status && r.http_status < 300);
    charts[chart] = {
      status: ok ? "published" : "partial_failure", timeframe: HTF_CHARTS[chart].period,
      candle_key: built.candle_key, candle_time: built.candle_time, published_at: new Date(now).toISOString(),
      engines: results, not_produced: built.records.some((r) => r.engine === "gmi") ? [] : ["gmi"], gmi_error: built.gmi_error || null
    };
    if (ok) await kv.put(markerKey, JSON.stringify(charts[chart]), { expirationTtl: 60 * 60 * 24 * 3 });
  }
  const summary = { status: "ok", checked_at: new Date(now).toISOString(), charts };
  if (Object.values(charts).some((c) => ["published", "partial_failure"].includes(c.status))) await kv.put(LAST_HTF_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  return summary;
}

// H4 and D1 feed the timeframe War Rooms (owner decision 2026-11-06).
// catchUpMs (D1 catch-up, owner decision 2026-11-06): an H4 or D1 bar whose snapshot was never
// published inside maxDelayMs is still published once while it is the chart's latest closed bar,
// cut at its own close so the snapshot is the one it would have been at the close. The room of
// that bar then re-convenes once with the HUD agents (src/timeframe-threads.mjs). D1 covers the
// weekend (Friday's close stays the latest until Monday's). H1 and M15 rooms move on every bar.
const HUD_CHARTS = Object.freeze({
  H1: { maxDelayMs: 25 * 60 * 1000 }, M15: { maxDelayMs: 9 * 60 * 1000 },
  H4: { maxDelayMs: 30 * 60 * 1000, catchUpMs: 4 * 60 * 60 * 1000 }, D1: { maxDelayMs: 60 * 60 * 1000, catchUpMs: 72 * 60 * 60 * 1000 }
});
const HUD_PERIOD = Object.freeze({ H1: "60", M15: "15", H4: "240", D1: "1D" });
// Longer than the longest catch-up window, so a caught-up bar is never sent twice.
const HUD_MARKER_TTL_S = 60 * 60 * 24 * 4;
export const LAST_HUD_PUBLISH_KEY = "market-data:v2:hud-last-publish";

/**
 * Phase C2: publishes the HUD snapshot of the latest closed H1 and M15 bar to the AI
 * Worker (LocalComputationIngress.submitHud). HUD agents only; never decision evidence.
 * Enabled only when HUD_SNAPSHOT_PUBLISH is "true". One snapshot per chart bar.
 */
export async function publishHudSnapshots(env, { now = Date.now(), bundle = null } = {}) {
  if (String(env.HUD_SNAPSHOT_PUBLISH || "").toLowerCase() !== "true") return { status: "hud_publish_disabled" };
  const kv = env.MARKET_DATA_CACHE;
  if (!kv) return { status: "cache_not_configured" };
  if (typeof env.AI_WORKER?.submitHud !== "function") return { status: "publisher_not_configured" };
  const resolvedBundle = bundle || await buildBundle(env, now);
  const results = {};
  for (const [chart, { maxDelayMs, catchUpMs = 0 }] of Object.entries(HUD_CHARTS)) {
    const last = resolvedBundle.timeframes?.[chart]?.candles?.at(-1);
    if (!last) { results[chart] = { status: "no_data" }; continue; }
    const closeMs = Date.parse(last.close_time);
    const late = now - closeMs > maxDelayMs;
    if (late && !(now - closeMs <= catchUpMs)) { results[chart] = { status: "no_fresh_close" }; continue; }
    // A late bar is only sent when it was never sent: check the marker before building.
    const lateKey = late ? [CHART_TICKERID, HUD_PERIOD[chart], String(Date.parse(last.open_time))].join(":") : null;
    if (lateKey && await kv.get("market-data:v2:hud-published:" + lateKey)) { results[chart] = { status: "already_published", candle_key: lateKey }; continue; }
    let snapshot;
    try {
      snapshot = buildHudSnapshot(late ? bundleUntil(resolvedBundle, closeMs) : resolvedBundle, { chart, now, mintick: Number(env.CHART_MINTICK) || 0.001 });
    } catch (error) {
      results[chart] = { status: asString(error?.code) || "hud_snapshot_failed" };
      continue;
    }
    const markerKey = "market-data:v2:hud-published:" + snapshot.candle_key;
    if (await kv.get(markerKey)) { results[chart] = { status: "already_published", candle_key: snapshot.candle_key }; continue; }
    try {
      const { status, body } = await env.AI_WORKER.submitHud(snapshot);
      const ok = status < 300;
      if (ok) await kv.put(markerKey, "1", { expirationTtl: HUD_MARKER_TTL_S });
      results[chart] = { status: ok ? "published" : "rejected", ...(late ? { catch_up: true } : {}), candle_key: snapshot.candle_key, http_status: status, error: ok ? null : asString(body?.error) || "ai_worker_rejected" };
    } catch (error) {
      results[chart] = { status: "post_failed", candle_key: snapshot.candle_key, error: asString(error?.name) || "post_failed" };
    }
  }
  const summary = { status: "done", published_at: new Date(now).toISOString(), charts: results };
  await kv.put(LAST_HUD_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  return summary;
}
