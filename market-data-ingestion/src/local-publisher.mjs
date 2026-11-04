// Publishes local_computation records for each newly closed H1 bar to the AI
// Worker through its LocalComputationIngress RPC entrypoint. The AI Worker stores them as
// observed and lets its autonomous parity registry decide trust by comparing
// them with the TradingView webhook outputs for the same candle_key.
import { buildBundle } from "./tradingview-source.mjs";
import { buildH1LocalCalculations } from "../../local-engines/producer/src/h1-producer.mjs";

const PUBLISHED_PREFIX = "market-data:v2:local-published:";
export const LAST_PUBLISH_KEY = "market-data:v2:local-last-publish";
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
