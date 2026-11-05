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
/** 5m candles revisited per sweep: the sweep runs every 15 minutes, so 6 covers each 5m candle twice. */
export const PARITY_SWEEP_LOOKBACK_M5_CANDLES = 6;
const H1_SECONDS = 3600;
const M5_SECONDS = 300;

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
  // Nothing observed for this candle (for example a 5m candle with no local 5m
  // producer yet): nothing to compare and no trusted record can exist.
  if (!LOCAL_ENGINES.some(engine => observed[engine])) return { comparisons: {}, trust: {} };
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
    // A record that is not visible yet (KV is eventually consistent across locations) is
    // left alone: deleting its trusted copy here would undo a reconcile that saw it. Only a
    // visible record whose identity is not (or no longer) approved loses its trusted copy.
    if (record && trust[engine]) await env.WEBHOOK_BUFFER.put(trustedKey, JSON.stringify({ ...record, trust_status: "approved_by_parity" }), LOCAL_TTL);
    else if (record) await env.WEBHOOK_BUFFER.delete(trustedKey);
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
  return closedCandleKeys(now, H1_SECONDS, { symbol, timeframe, lookback });
}

/** Candle keys of the `lookback` most recently closed 5m candles, newest first. */
export function closedM5CandleKeys(now = Date.now(), { symbol = "OANDA:XAUUSD", lookback = PARITY_SWEEP_LOOKBACK_M5_CANDLES } = {}) {
  return closedCandleKeys(now, M5_SECONDS, { symbol, timeframe: "5", lookback });
}

function closedCandleKeys(now, seconds, { symbol, timeframe, lookback }) {
  const periodMs = seconds * 1000;
  const currentOpenMs = Math.floor(now / periodMs) * periodMs;
  const keys = [];
  for (let i = 1; i <= lookback; i += 1) keys.push(`${symbol}:${timeframe}:${currentOpenMs - i * periodMs}`);
  return keys;
}

/**
 * Reconciles the most recently closed H1 candles. Returns a per-candle summary;
 * individual candle failures are captured instead of aborting the sweep.
 */
export async function reconcileRecentCandles(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES, m5Lookback = PARITY_SWEEP_LOOKBACK_M5_CANDLES } = {}) {
  const candleKeys = closedH1CandleKeys(now, { lookback });
  // 5m parity (C0): 5m comparator webhooks are stored only and never queue a
  // reconcile task, so the sweep is what pairs them with the local 5m records
  // when those arrive first. Registry ids are timeframe-scoped (prophet_m5,
  // gmi_m5), so this can never touch the approved H1 identities.
  const m5CandleKeys = closedM5CandleKeys(now, { lookback: m5Lookback });
  const results = {};
  for (const candleKey of [...candleKeys, ...m5CandleKeys]) {
    try {
      results[candleKey] = await reconcileLocalComputation(env, candleKey);
    } catch (error) {
      results[candleKey] = { error: error instanceof Error ? error.name : "UnknownError" };
    }
  }
  return { swept_at: new Date(now).toISOString(), candle_keys: candleKeys, m5_candle_keys: m5CandleKeys, results };
}

/** Minutes after an H1 close after which a candle without approved local records is recorded as a fail-closed WAIT. */
export const LOCAL_MISSING_AFTER_MS = 30 * 60 * 1000;
/** Attempts after which a failed analysis is no longer retried by the backfill. */
export const BACKFILL_MAX_ATTEMPTS = 4;

export async function backfillRecentAnalyses(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES, loadPayloads = null, runAnalysis = null, setStatus = null } = {}) {
  const required = String(env?.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70").split(",").map(v=>v.trim()).filter(Boolean);
  const localPrimary = String(env?.INDICATOR_SOURCE || "local").toLowerCase() !== "webhook";
  const candleKeys = closedH1CandleKeys(now, { lookback });
  let triggered = 0;
  for (const candleKey of candleKeys) {
    const openMs = Number(String(candleKey).split(":").pop());
    if (!Number.isFinite(openMs)) continue;
    if (now - openMs > 2 * 60 * 60 * 1000) continue;
    try {
      const existing = await env.DB.prepare("SELECT status, attempt_count FROM analysis_runs WHERE candle_key = ?").bind(candleKey).first();
      // A run that failed (for example a Workers AI timeout) is retried here, like the queue
      // retries it, up to BACKFILL_MAX_ATTEMPTS; every other recorded status is final.
      if (existing && !(existing.status === "failed" && Number(existing.attempt_count || 0) < BACKFILL_MAX_ATTEMPTS)) continue;
      const payloads = (loadPayloads ? await loadPayloads(env, candleKey, required) : null) || {};
      if (localPrimary) {
        // Local-primary: approved local records drive the chain; webhooks are calibration only.
        // A candle whose approved local records never arrived is still recorded, as a
        // fail-closed WAIT, once the local publish window has passed.
        const trusted = await Promise.all(LOCAL_ENGINES.map(engine => env.WEBHOOK_BUFFER.get(TRUSTED_PREFIX + candleKey + ":" + engine)));
        const closedMs = openMs + H1_SECONDS * 1000;
        if (!trusted.every(Boolean) && now - closedMs < LOCAL_MISSING_AFTER_MS) continue;
      } else if (!required.every(source => payloads[source])) continue;
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
      if (typeof setStatus === "function") {
        try { await setStatus(env, candleKey, "failed", { message: error instanceof Error ? error.message : String(error) }, "analysis_failed"); } catch { /* ignore */ }
      }
      console.error("backfill_candle_failed", candleKey, error instanceof Error ? error.message : String(error));
    }
  }
  return { triggered, candle_keys: candleKeys };
}
