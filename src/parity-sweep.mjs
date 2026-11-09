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

import { LOCAL_ENGINES, HUD_ENGINES, INGEST_ENGINES } from "./evidence-fusion.mjs";
import {
  identityOf, compareWithWebhooks, requiredSourcesFor, ensureSchema,
  recordComparison, isTrusted, policyFromEnv, reclassifyInputOnlyMismatches
} from "./parity-registry.mjs";

export const OBSERVED_PREFIX = "localcalc-observed:";
const TRUSTED_PREFIX = "localcalc:";
export const LOCAL_TTL = { expirationTtl: 60 * 60 * 24 * 14 };

/** Cron expression that triggers the sweep in the scheduled handler. */
export const PARITY_SWEEP_CRON = "10-59/15 * * * *";
export const PARITY_SWEEP_LOOKBACK_CANDLES = 3;
/** 5m candles revisited per sweep: the sweep runs every 15 minutes, so 6 covers each 5m candle twice. */
export const PARITY_SWEEP_LOOKBACK_M5_CANDLES = 6;
// The sweep runs every 15 minutes: the last 2 closed 15m candles cover each one at least once.
export const PARITY_SWEEP_LOOKBACK_M15_CANDLES = 2;
const H1_SECONDS = 3600;
const M5_SECONDS = 300;
const M15_SECONDS = 900;

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
  await Promise.all(INGEST_ENGINES.map(async engine => {
    observed[engine] = await readJsonKV(env.WEBHOOK_BUFFER, OBSERVED_PREFIX + candleKey + ":" + engine);
  }));
  // Nothing observed for this candle (for example a 5m candle with no local 5m
  // producer yet): nothing to compare and no trusted record can exist.
  if (!INGEST_ENGINES.some(engine => observed[engine])) return { comparisons: {}, trust: {} };
  const comparisons = {};
  // HUD identities (gmi_hud) are compared like the engines but never vouch for the decision lane.
  for (const engine of ["prophet", "gmi", ...HUD_ENGINES]) {
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
    comparisons[engine] = { result: outcome.result ?? comparison.status, counted: outcome.counted, mismatches: comparison.mismatches ?? [], missing: comparison.missing ?? [], ...(outcome.escalated ? { escalated: outcome.escalated } : {}) };
  }
  // A candle whose local input bar differs from TradingView's final bar never enters the trusted
  // lane, whatever the identity's status: the H1 chain then reads the TradingView evidence for it,
  // until the pull adapter republishes the candle on the final bar and it matches.
  const inputDiffers = ["prophet", "gmi"].some((engine) => comparisons[engine]?.result === "input_mismatch");
  const trust = {};
  for (const engine of LOCAL_ENGINES) {
    const record = observed[engine];
    const id = record ? identityOf(record) : null;
    trust[engine] = id && !inputDiffers ? await isTrusted(env.DB, id) : false;
    const trustedKey = TRUSTED_PREFIX + candleKey + ":" + engine;
    // A record that is not visible yet (KV is eventually consistent across locations) is
    // left alone: deleting its trusted copy here would undo a reconcile that saw it. Only a
    // visible record whose identity is not (or no longer) approved loses its trusted copy.
    if (record && trust[engine]) await env.WEBHOOK_BUFFER.put(trustedKey, JSON.stringify({ ...record, trust_status: "approved_by_parity" }), LOCAL_TTL);
    else if (record) await env.WEBHOOK_BUFFER.delete(trustedKey);
  }
  // A HUD identity's trusted copy (localcalc:<candle>:gmi_hud) only marks HUD fields as verified
  // (hud-store.mjs); the decision lane reads LOCAL_ENGINES and never sees it.
  for (const engine of HUD_ENGINES) {
    const record = observed[engine];
    const id = record ? identityOf(record) : null;
    if (!record) continue;
    const ownInputDiffers = comparisons[engine]?.result === "input_mismatch";
    trust[engine] = id && !inputDiffers && !ownInputDiffers ? await isTrusted(env.DB, id) : false;
    const trustedKey = TRUSTED_PREFIX + candleKey + ":" + engine;
    if (trust[engine]) await env.WEBHOOK_BUFFER.put(trustedKey, JSON.stringify({ ...record, trust_status: "approved_by_parity" }), LOCAL_TTL);
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
  return closedCandleKeys(now, H1_SECONDS, { symbol, timeframe, lookback });
}

/** Candle keys of the `lookback` most recently closed 5m candles, newest first. */
export function closedM5CandleKeys(now = Date.now(), { symbol = "OANDA:XAUUSD", lookback = PARITY_SWEEP_LOOKBACK_M5_CANDLES } = {}) {
  return closedCandleKeys(now, M5_SECONDS, { symbol, timeframe: "5", lookback });
}

/** Verified 15m lane: the most recently closed 15m candle keys, newest first. */
export function closedM15CandleKeys(now = Date.now(), { symbol = "OANDA:XAUUSD", lookback = PARITY_SWEEP_LOOKBACK_M15_CANDLES } = {}) {
  return closedCandleKeys(now, M15_SECONDS, { symbol, timeframe: "15", lookback });
}

/**
 * H4/D1 lane: candle keys of the most recently closed H4 ("240") and D1 ("1D") bars, newest
 * first. OANDA H4 and D1 bars open at 17:00 New York, not on epoch multiples, so the keys
 * come from the pull adapter's cached native bars (same KV namespace), never from the clock.
 */
export async function closedHtfCandleKeys(env, now = Date.now(), { symbol = "OANDA:XAUUSD", lookback = 2 } = {}) {
  const keys = [];
  for (const [series, period] of [["4h", "240"], ["1D", "1D"]]) {
    let record = null;
    try { record = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:${symbol}|${series}`)) || "null"); } catch { record = null; }
    const closed = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => Date.parse(c.close_time) <= now && Number.isFinite(Date.parse(c.open_time)));
    for (const c of closed.slice(-lookback).reverse()) keys.push(`${symbol}:${period}:${Date.parse(c.open_time)}`);
  }
  return keys;
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
/** KV marker of the one-time input-mismatch reconciliation (owner approval 2026-11-06). */
export const RECLASSIFY_MARKER = "parity:reclassify-input-only:v1";

/** Runs reclassifyInputOnlyMismatches once per database (KV marker); never throws. */
export async function reclassifyOnce(env, now = Date.now()) {
  try {
    if (await env.SIGNAL_CACHE?.get?.(RECLASSIFY_MARKER)) return { status: "done_before" };
    await ensureSchema(env.DB);
    const result = await reclassifyInputOnlyMismatches(env.DB, new Date(now).toISOString());
    await env.SIGNAL_CACHE?.put?.(RECLASSIFY_MARKER, JSON.stringify({ ...result, at: new Date(now).toISOString() }));
    console.log("parity_reclassify_input_only", JSON.stringify(result));
    return { status: "ok", ...result };
  } catch (error) {
    console.error("parity_reclassify_failed", error instanceof Error ? error.message : String(error));
    return { status: "error" };
  }
}

export async function reconcileRecentCandles(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES, m5Lookback = PARITY_SWEEP_LOOKBACK_M5_CANDLES, m15Lookback = PARITY_SWEEP_LOOKBACK_M15_CANDLES } = {}) {
  // Before this sweep compares anything: restore identities revoked only by input-bar differences
  // under the old rule, so this same sweep places their records into the trusted lane again.
  await reclassifyOnce(env, now);
  const candleKeys = closedH1CandleKeys(now, { lookback });
  // 5m parity (C0): 5m comparator webhooks are stored only and never queue a
  // reconcile task, so the sweep is what pairs them with the local 5m records
  // when those arrive first. Registry ids are timeframe-scoped (prophet_m5,
  // gmi_m5), so this can never touch the approved H1 identities.
  const m5CandleKeys = closedM5CandleKeys(now, { lookback: m5Lookback });
  // Verified 15m lane: the same for the 15m comparators (prophet_m15, gmi_m15).
  const m15CandleKeys = closedM15CandleKeys(now, { lookback: m15Lookback });
  // H4/D1 lane (prophet_h4, gmi_h4, prophet_d1, gmi_d1): keys from the cached native bars.
  let htfCandleKeys = [];
  try { htfCandleKeys = await closedHtfCandleKeys(env, now); } catch { htfCandleKeys = []; }
  const results = {};
  for (const candleKey of [...candleKeys, ...m5CandleKeys, ...m15CandleKeys, ...htfCandleKeys]) {
    try {
      results[candleKey] = await reconcileLocalComputation(env, candleKey);
    } catch (error) {
      results[candleKey] = { error: error instanceof Error ? error.name : "UnknownError" };
    }
  }
  return { swept_at: new Date(now).toISOString(), candle_keys: candleKeys, m5_candle_keys: m5CandleKeys, m15_candle_keys: m15CandleKeys, htf_candle_keys: htfCandleKeys, results };
}

/** Minutes after an H1 close after which a candle without approved local records is recorded as a fail-closed WAIT. */
export const LOCAL_MISSING_AFTER_MS = 30 * 60 * 1000;
/** Attempts after which a failed analysis is no longer retried by the backfill. */
export const BACKFILL_MAX_ATTEMPTS = 4;
/** After an H1 close, a degraded run is retried this long when its evidence changed. */
export const DEGRADED_RETRY_MS = 45 * 60 * 1000;

const NY_WEEK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Gold does not trade from Friday 17:00 to Sunday 18:00 New York time: true for an hour opening in that window. */
export function goldClosedAt(ms) {
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return (p.weekday === "Fri" && minutes >= 17 * 60) || p.weekday === "Sat" || (p.weekday === "Sun" && minutes < 18 * 60);
}

export async function backfillRecentAnalyses(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES, loadPayloads = null, runAnalysis = null, setStatus = null } = {}) {
  const required = String(env?.REQUIRED_SOURCES || "prophet_r38,prophet_r37_ssot,gmi_v12_70").split(",").map(v=>v.trim()).filter(Boolean);
  const localPrimary = String(env?.INDICATOR_SOURCE || "local").toLowerCase() !== "webhook";
  const candleKeys = closedH1CandleKeys(now, { lookback });
  let triggered = 0;
  for (const candleKey of candleKeys) {
    const openMs = Number(String(candleKey).split(":").pop());
    if (!Number.isFinite(openMs)) continue;
    if (now - openMs > 2 * 60 * 60 * 1000) continue;
    // A closed-market hour has no bar and no local record: nothing to analyse (post-reopen audit
    // 2026-11-09: 48 fail-closed WAIT runs were recorded for the weekend hours).
    if (goldClosedAt(openMs)) continue;
    try {
      const existing = await env.DB.prepare("SELECT status, attempt_count FROM analysis_runs WHERE candle_key = ?").bind(candleKey).first();
      // A run that failed (for example a Workers AI timeout) is retried here, like the queue
      // retries it, up to BACKFILL_MAX_ATTEMPTS. A degraded run (required evidence missing) is
      // retried within DEGRADED_RETRY_MS of the close: the evidence often arrives minutes later
      // (production 2026-11-09: every H1 run fired at :05:35, the hourly news at :06:50, so each
      // bar stayed a degraded WAIT). The claim only succeeds when the evidence fingerprint
      // changed, so an unchanged degraded bar is not analysed twice. Every other status is final.
      const retryFailed = existing?.status === "failed" && Number(existing.attempt_count || 0) < BACKFILL_MAX_ATTEMPTS;
      const retryDegraded = existing?.status === "degraded" && Number(existing.attempt_count || 0) < BACKFILL_MAX_ATTEMPTS && now - (openMs + H1_SECONDS * 1000) <= DEGRADED_RETRY_MS;
      if (existing && !retryFailed && !retryDegraded) continue;
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
