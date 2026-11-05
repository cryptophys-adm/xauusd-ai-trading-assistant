// Publishes local_computation records for each newly closed H1 bar to the AI
// Worker through its LocalComputationIngress RPC entrypoint. The AI Worker stores them as
// observed and lets its autonomous parity registry decide trust by comparing
// them with the TradingView webhook outputs for the same candle_key.
import { buildBundle } from "./tradingview-source.mjs";
import { buildH1LocalCalculations } from "../../local-engines/producer/src/h1-producer.mjs";
import { buildM5LocalCalculations } from "../../local-engines/producer/src/m5-local-producer.mjs";
import { buildM15LocalCalculations } from "../../local-engines/producer/src/m15-local-producer.mjs";
import { m5ContextFromRecords } from "../../local-engines/producer/src/m5-context.mjs";
import { buildHudSnapshot } from "../../local-engines/producer/src/hud-snapshot.mjs";

const PUBLISHED_PREFIX = "market-data:v2:local-published:";
export const LAST_PUBLISH_KEY = "market-data:v2:local-last-publish";
export const LAST_M5_PUBLISH_KEY = "market-data:v2:local-last-publish-m5";
// 5m records are published only for the bar that just closed (the cron runs every 5 minutes).
const MAX_M5_PUBLISH_DELAY_MS = 9 * 60 * 1000;
// The AI Worker rejects local outputs older than 30 minutes; publish only fresh closes.
const MAX_PUBLISH_DELAY_MS = 25 * 60 * 1000;

const asString = (v) => (typeof v === "string" ? v : "");

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
  const summary = {
    status: ok ? "published" : "partial_failure",
    candle_key: built.candle_key,
    candle_time: built.candle_time,
    published_at: new Date(now).toISOString(),
    engines: results,
    not_produced: built.records.some((r) => r.engine === "gmi") ? [] : ["gmi"],
    gmi_error: built.gmi_error || null
  };
  if (ok) await kv.put(markerKey, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  await kv.put(LAST_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  return summary;
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

const HUD_CHARTS = Object.freeze({ H1: { maxDelayMs: 25 * 60 * 1000 }, M15: { maxDelayMs: 9 * 60 * 1000 } });
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
  for (const [chart, { maxDelayMs }] of Object.entries(HUD_CHARTS)) {
    const last = resolvedBundle.timeframes?.[chart]?.candles?.at(-1);
    if (!last) { results[chart] = { status: "no_data" }; continue; }
    if (now - Date.parse(last.close_time) > maxDelayMs) { results[chart] = { status: "no_fresh_close" }; continue; }
    let snapshot;
    try {
      snapshot = buildHudSnapshot(resolvedBundle, { chart, now, mintick: Number(env.CHART_MINTICK) || 0.001 });
    } catch (error) {
      results[chart] = { status: asString(error?.code) || "hud_snapshot_failed" };
      continue;
    }
    const markerKey = "market-data:v2:hud-published:" + snapshot.candle_key;
    if (await kv.get(markerKey)) { results[chart] = { status: "already_published", candle_key: snapshot.candle_key }; continue; }
    try {
      const { status, body } = await env.AI_WORKER.submitHud(snapshot);
      const ok = status < 300;
      if (ok) await kv.put(markerKey, "1", { expirationTtl: 60 * 60 * 24 });
      results[chart] = { status: ok ? "published" : "rejected", candle_key: snapshot.candle_key, http_status: status, error: ok ? null : asString(body?.error) || "ai_worker_rejected" };
    } catch (error) {
      results[chart] = { status: "post_failed", candle_key: snapshot.candle_key, error: asString(error?.name) || "post_failed" };
    }
  }
  const summary = { status: "done", published_at: new Date(now).toISOString(), charts: results };
  await kv.put(LAST_HUD_PUBLISH_KEY, JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
  return summary;
}
