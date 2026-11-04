// Scheduled parity reconciliation for the local_computation lane.
//
// The per-event reconcile tasks (webhook_reconcile / local_calculation_reconcile)
// run within seconds of the evidence arriving. Because the evidence lives in KV
// (eventually consistent, and a colo that recently read a missing key can serve
// the cached miss for ~60s), those tasks can all observe a half-written lane and
// skip — and no later task ever revisits that candle, so the parity comparison is
// lost permanently (observed 2026-11-04 for the 23:00 and 00:00 UTC candles).
//
// This module provides an idempotent sweep: a cron re-runs the same
// reconcileLocalComputation for the most recently closed H1 candles, after KV
// has settled. recordComparison dedupes per (identity, candle), so re-running a
// reconciled candle is a no-op.

import { LOCAL_ENGINES } from "./evidence-fusion.mjs";
import {
  identityOf, compareWithWebhooks, requiredSourcesFor, ensureSchema,
  recordComparison, isTrusted, policyFromEnv
} from "./parity-registry.mjs";

export const OBSERVED_PREFIX = "localcalc-observed:";
const TRUSTED_PREFIX = "localcalc:";
export const LOCAL_TTL = { expirationTtl: 60 * 60 * 24 * 14 };

/** Cron expression that triggers the sweep in the scheduled handler. */
export const PARITY_SWEEP_CRON = "10-59/15 * * * *";
export const PARITY_SWEEP_LOOKBACK_CANDLES = 3;
const H1_SECONDS = 3600;

async function readJsonKV(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Autonomous provenance reconciliation for one candle. Compares every observed
 * local engine output with TradingView's webhook outputs for the same candle,
 * records the result in the parity registry (promotion/revocation is a fixed
 * rule), then places into the trusted local_computation lane exactly those
 * observed records whose identity is currently approved.
 */
export async function reconcileLocalComputation(env, candleKey) {
  await ensureSchema(env.DB);
  const policy = policyFromEnv(env);
  const observed = {};
  await Promise.all(LOCAL_ENGINES.map(async engine => {
    observed[engine] = await readJsonKV(env.WEBHOOK_BUFFER, OBSERVED_PREFIX + candleKey + ":" + engine);
  }));
  const comparisons = {};
  for (const engine of ["prophet", "gmi"]) {
    const record = observed[engine];
    const id = record ? identityOf(record) : null;
    if (!record || !id) continue;
    const webhooks = {};
    for (const source of requiredSourcesFor(engine)) {
      const payload = await readJsonKV(env.WEBHOOK_BUFFER, "candle:" + candleKey + ":" + source);
      if (payload) webhooks[source] = payload;
    }
    const comparison = compareWithWebhooks(record, webhooks, policy);
    const outcome = await recordComparison(env.DB, id, candleKey, comparison, policy);
    comparisons[engine] = { result: comparison.status, counted: outcome.counted, mismatches: comparison.mismatches ?? [], missing: comparison.missing ?? [] };
  }
  const trust = {};
  for (const engine of LOCAL_ENGINES) {
    const record = observed[engine];
    const id = record ? identityOf(record) : null;
    trust[engine] = id ? await isTrusted(env.DB, id) : false;
    const trustedKey = TRUSTED_PREFIX + candleKey + ":" + engine;
    if (record && trust[engine]) await env.WEBHOOK_BUFFER.put(trustedKey, JSON.stringify({ ...record, trust_status: "approved_by_parity" }), LOCAL_TTL);
    else await env.WEBHOOK_BUFFER.delete(trustedKey);
  }
  return { comparisons, trust };
}

/**
 * Candle keys of the `lookback` most recently closed H1 candles, newest first.
 * Candle keys are "<symbol>:<timeframe>:<bar open time in ms>" as carried by the
 * TradingView webhook payloads. A candle whose evidence never arrived is simply
 * skipped by reconcileLocalComputation, so guessing keys is safe.
 */
export function closedH1CandleKeys(now = Date.now(), { symbol = "OANDA:XAUUSD", timeframe = "60", lookback = PARITY_SWEEP_LOOKBACK_CANDLES } = {}) {
  const currentOpenMs = Math.floor(now / (H1_SECONDS * 1000)) * H1_SECONDS * 1000;
  const keys = [];
  for (let i = 1; i <= lookback; i += 1) {
    keys.push(`${symbol}:${timeframe}:${currentOpenMs - i * H1_SECONDS * 1000}`);
  }
  return keys;
}

/**
 * Reconciles the most recently closed H1 candles. Returns a per-candle summary;
 * individual candle failures are captured instead of aborting the sweep.
 */
export async function reconcileRecentCandles(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES } = {}) {
  const candleKeys = closedH1CandleKeys(now, { lookback });
  const results = {};
  for (const candleKey of candleKeys) {
    try {
      results[candleKey] = await reconcileLocalComputation(env, candleKey);
    } catch (error) {
      results[candleKey] = { error: error instanceof Error ? error.name : "UnknownError" };
    }
  }
  return { swept_at: new Date(now).toISOString(), candle_keys: candleKeys, results };
}

export async function backfillRecentAnalyses(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES, loadPayloads = null, runAnalysis = null } = {}) {
  const candleKeys = closedH1CandleKeys(now, { lookback });
  let triggered = 0;
  for (const candleKey of candleKeys) {
    const openMs = Number(String(candleKey).split(":").pop());
    if (!Number.isFinite(openMs)) continue;
    if (now - openMs > 2 * 60 * 60 * 1000) continue;
    try {
      const existing = await env.DB.prepare("SELECT status FROM analysis_runs WHERE candle_key = ?").bind(candleKey).first();
      if (existing) continue;
      const required = ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70"];
      const payloads = loadPayloads ? await loadPayloads(env, candleKey, required) : null;
      if (!payloads || !required.every(source => payloads[source])) continue;
      const lastColon = candleKey.lastIndexOf(":");
      const rest = candleKey.slice(0, lastColon);
      const secondLast = rest.lastIndexOf(":");
      const timeframe = rest.slice(secondLast + 1);
      const ticker = rest.slice(0, secondLast);
      if (typeof runAnalysis === "function") {
        await runAnalysis(env, candleKey, ticker, timeframe, payloads);
        triggered += 1;
      }
    } catch (error) {
      // swallow per-candle
    }
  }
  return { triggered, candle_keys: candleKeys };
}
