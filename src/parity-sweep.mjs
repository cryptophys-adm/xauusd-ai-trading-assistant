// The trusted local_computation lane, refreshed per candle.
//
// The per-event reconcile tasks (webhook_reconcile / local_calculation_reconcile) run within seconds of
// the evidence arriving; KV is eventually consistent, so a cron sweep re-runs the same reconcile for the
// recently closed candles after KV has settled. Re-running a candle is a no-op.
//
// Parity removal S2 (2026-11-26/27): the reconcile no longer compares anything with TradingView and
// writes nothing to the parity registry. Trust is the frozen table (src/trusted-identities.mjs, S1).
// The module keeps its name, the decision records' reader and the backfill until S6.

import { LOCAL_ENGINES, HUD_ENGINES, ADOPT_ENGINES } from "./evidence-fusion.mjs";
import {
  identityOf, ensureSchema, isTrusted, policyFromEnv, reclassifyInputOnlyMismatches, repairApprovedAt
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

/** trust_status of a local record that parity has not (or not yet) approved. */
export const NOT_PARITY_APPROVED = "not_parity_approved";

/**
 * The local engine records the H1 decision reads for a candle (owner decision 2026-11-09: no waiting
 * on parity, no dependence on the TradingView webhooks). For each decision engine: the
 * parity-approved copy when it exists (trust_status approved_by_parity), else the observed record as
 * published, labelled not_parity_approved, so the agents read it with less weight instead of the bar
 * failing closed. An engine that published nothing for the candle is simply absent.
 */
export async function decisionLocalRecords(env, candleKey) {
  const kv = env?.WEBHOOK_BUFFER;
  if (!kv?.get) return [];
  const out = [];
  for (const engine of LOCAL_ENGINES) {
    const trusted = await readJsonKV(kv, TRUSTED_PREFIX + candleKey + ":" + engine);
    if (trusted) { out.push(trusted); continue; }
    const observed = await readJsonKV(kv, OBSERVED_PREFIX + candleKey + ":" + engine);
    if (observed) out.push({ ...observed, trust_status: NOT_PARITY_APPROVED });
  }
  return out;
}

/**
 * The trusted local_computation lane for one candle (parity removal S2, owner 2026-11-26: "Kita akan remove
 * parity karena efeknya kecil dan sudah terbukti"; orchestrator PR1 plan). Nothing is compared with TradingView
 * and nothing is written to the parity registry any more: each observed record of a decision engine whose
 * identity is in the frozen table (src/trusted-identities.mjs) gets its trusted copy
 * (localcalc:<candle>:<engine>, trust_status approved_by_parity); a visible record of an identity outside it
 * loses its copy. HUD and group identities (gmi_hud, B7) are never trusted, so they never get one. The return
 * keeps its shape ({ comparisons, trust }) for the callers; `comparisons` is always empty.
 */
export async function reconcileLocalComputation(env, candleKey) {
  const observed = {};
  await Promise.all([...LOCAL_ENGINES, ...HUD_ENGINES].map(async engine => {
    observed[engine] = await readJsonKV(env.WEBHOOK_BUFFER, OBSERVED_PREFIX + candleKey + ":" + engine);
  }));
  if (![...LOCAL_ENGINES, ...HUD_ENGINES].some(engine => observed[engine])) return { comparisons: {}, trust: {} };
  const trust = {};
  for (const engine of LOCAL_ENGINES) {
    const record = observed[engine];
    const id = record ? identityOf(record) : null;
    trust[engine] = id ? await isTrusted(env.DB, id) : false;
    const trustedKey = TRUSTED_PREFIX + candleKey + ":" + engine;
    // A record that is not visible yet (KV is eventually consistent across locations) is left alone:
    // deleting its trusted copy here would undo a reconcile that saw it.
    if (record && trust[engine]) await env.WEBHOOK_BUFFER.put(trustedKey, JSON.stringify({ ...record, trust_status: "approved_by_parity" }), LOCAL_TTL);
    else if (record) await env.WEBHOOK_BUFFER.delete(trustedKey);
  }
  for (const engine of HUD_ENGINES) {
    if (!observed[engine]) continue;
    trust[engine] = false;
    await env.WEBHOOK_BUFFER.delete(TRUSTED_PREFIX + candleKey + ":" + engine);
  }
  return { comparisons: {}, trust };
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
/** KV marker of the one-time approved_at repair (2026-11-25), in the same namespace (SIGNAL_CACHE). */
export const APPROVED_AT_REPAIR_MARKER = "parity:repair:approved-at:v1";

/** The KV namespace that holds the one-time markers, or null when it cannot both read and write. */
const markerStore = (env) => (typeof env?.SIGNAL_CACHE?.get === "function" && typeof env?.SIGNAL_CACHE?.put === "function" ? env.SIGNAL_CACHE : null);

/**
 * Runs reclassifyInputOnlyMismatches once per database; never throws. Single-shot: a missing
 * RECLASSIFY_MARKER is the only way it runs, and the marker is written (without a TTL, so it never
 * expires) BEFORE the reclassification, so a run that fails part-way is not repeated either. Without
 * a marker store (no SIGNAL_CACHE binding) it refuses, instead of running on every sweep. To run it
 * again, delete the marker deliberately.
 */
export async function reclassifyOnce(env, now = Date.now()) {
  try {
    const store = markerStore(env);
    if (!store) return { status: "no_marker_store" };
    if (await store.get(RECLASSIFY_MARKER)) return { status: "done_before" };
    const at = new Date(now).toISOString();
    await store.put(RECLASSIFY_MARKER, JSON.stringify({ status: "claimed", at }));
    await ensureSchema(env.DB);
    const result = await reclassifyInputOnlyMismatches(env.DB, at);
    await store.put(RECLASSIFY_MARKER, JSON.stringify({ ...result, at }));
    console.log("parity_reclassify_input_only", JSON.stringify(result));
    return { status: "ok", ...result };
  } catch (error) {
    console.error("parity_reclassify_failed", error instanceof Error ? error.message : String(error));
    return { status: "error" };
  }
}

/**
 * Runs repairApprovedAt once per database (APPROVED_AT_REPAIR_MARKER, no TTL); never throws. The
 * marker is written after the repair, so a failed run is retried by the next sweep (the repair is
 * idempotent). One log line: parity_approved_at_repair with counts and identity ids only.
 */
export async function repairApprovedAtOnce(env, now = Date.now()) {
  try {
    const store = markerStore(env);
    if (!store) return { status: "no_marker_store" };
    if (await store.get(APPROVED_AT_REPAIR_MARKER)) return { status: "done_before" };
    await ensureSchema(env.DB);
    const result = await repairApprovedAt(env.DB, policyFromEnv(env));
    await store.put(APPROVED_AT_REPAIR_MARKER, JSON.stringify({ ...result, at: new Date(now).toISOString() }));
    console.log("parity_approved_at_repair", JSON.stringify({ event: "parity_approved_at_repair", repaired: result.repaired, skipped: result.skipped, revoked_cleared: result.revoked_cleared }));
    return { status: "ok", ...result };
  } catch (error) {
    console.error("parity_approved_at_repair_failed", error instanceof Error ? error.message : String(error));
    return { status: "error" };
  }
}

/** B11 (orchestrator 2026-11-26, Q5): retention of the adoption groups' comparison rows. */
export const ADOPT_COMPARISON_RETENTION_DAYS = 30;
export const ADOPT_PRUNE_MAX_ROWS = 2000;

/**
 * B11: deletes the adoption groups' comparison rows (engine ids gmi_adopt_* / prophet_adopt_*) older than 30 days,
 * at most 2,000 a sweep. No other engine's rows are touched (their retention is a separate decision). Returns the
 * number deleted (0 without the table or on an error; the sweep never fails on it).
 */
export async function pruneAdoptComparisons(env, { now = Date.now() } = {}) {
  if (!env?.DB?.prepare) return 0;
  const cutoff = new Date(now - ADOPT_COMPARISON_RETENTION_DAYS * 86_400_000).toISOString();
  const like = ADOPT_ENGINES.map(() => "engine LIKE ? ESCAPE '\\'").join(" OR ");
  const patterns = ADOPT_ENGINES.map((e) => e.replace(/_/g, "\\_") + "\\_%");
  try {
    const r = await env.DB.prepare(`DELETE FROM engine_parity_comparisons WHERE rowid IN (SELECT rowid FROM engine_parity_comparisons WHERE (${like}) AND compared_at < ? LIMIT ${ADOPT_PRUNE_MAX_ROWS})`)
      .bind(...patterns, cutoff).run();
    return Number(r?.meta?.changes) || 0;
  } catch {
    return 0;
  }
}

export async function reconcileRecentCandles(env, { now = Date.now(), lookback = PARITY_SWEEP_LOOKBACK_CANDLES, m5Lookback = PARITY_SWEEP_LOOKBACK_M5_CANDLES, m15Lookback = PARITY_SWEEP_LOOKBACK_M15_CANDLES } = {}) {
  // Parity removal S2: no comparison, no registry write; the sweep only refreshes the trusted lane of the
  // recently closed candles from the frozen table (and prunes the adoption rows, B11 Q5, until S6).
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
  const adoptPruned = await pruneAdoptComparisons(env, { now });
  return { swept_at: new Date(now).toISOString(), candle_keys: candleKeys, m5_candle_keys: m5CandleKeys, m15_candle_keys: m15CandleKeys, htf_candle_keys: htfCandleKeys, results, adopt_pruned: adoptPruned };
}

/** Minutes after an H1 close after which a candle without approved local records is recorded as a fail-closed WAIT. */
export const LOCAL_MISSING_AFTER_MS = 30 * 60 * 1000;
/** Attempts after which a failed analysis is no longer retried by the backfill. */
export const BACKFILL_MAX_ATTEMPTS = 4;
/** After an H1 close, a degraded run is retried this long when its evidence changed. */
export const DEGRADED_RETRY_MS = 45 * 60 * 1000;

// Gold's trading week lives in market-hours.mjs (re-exported here for the existing importers).
export { goldClosedAt } from "./market-hours.mjs";
import { goldClosedAt } from "./market-hours.mjs";

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
        // Owner decision 2026-11-09: approved or not, the published records start the chain.
        const records = await decisionLocalRecords(env, candleKey);
        const closedMs = openMs + H1_SECONDS * 1000;
        if (records.length < LOCAL_ENGINES.length && now - closedMs < LOCAL_MISSING_AFTER_MS) continue;
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
