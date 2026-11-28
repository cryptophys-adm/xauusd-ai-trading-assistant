// SB1, the shadow model router (owner 2026-11-25: "semua shadow pakai beam"; after the read-only survey found that only
// one source can route safely, the owner chose "news_compare saja"). A small copy of CTA's router (cryptophys-cta
// src/agent/router.mjs, main b2a30f3) with its defaults: one OpenAI-compatible Chat Completions endpoint, so the model is
// a setting, not code: MODEL_BASE_URL (default Reflection's https://api.reflection.ai/openai/v1) and MODEL_ID (default
// Beam-1.0-501B-A23B), with the key in the AI Worker secret REFLECTION_API_KEY that the owner sets through the platform.
// No key, no call.
//
// Scope (binding): only the news shadow comparison routes (src/news-shadow-compare.mjs runNewsShadowCompare, both of its
// readings). The call site passes its own allow-list (["news_compare"]) and its site name; a call is routed only when
// the site is in that list. Nothing selects by meter source. Every other caller (metric_opening, the note arm, the
// benched seats, decision_council, every other shadow source and every live caller) never reaches this module.
//
// The switch: FS1 row SHADOW_MODEL_ROUTER, "off" by default, owner-flipped. Off, the call site never calls in here.
//
// Every one of these falls back to the current Workers AI call, unchanged, and logs its reason code (never the prompt or
// the answer): a console line `model_router_fallback` and a row in D1 model_router_events.
//   - unreachable: a 25 s timeout or a network error; a breaker opens after 3 failures (timeout, network error, 5xx)
//     in a 15-minute window (aligned to the quarter hour) and stays open for the rest of that window;
//   - a 429 (never a paid sign, whatever its text; a back-off to the next 00:00 UTC for a daily quota, else Retry-After
//     or 60 s, held in KV model-router:rate-limited:v1), or Beam's own counters: 100k input tokens and 20k output tokens a UTC day (the Beam rows of ai_usage_daily,
//     read through the shadow breaker's shadowSpendToday; the output check reserves this call's own cap), 20 requests a
//     UTC day and 2 a minute (every request sent, D1 model_router_events);
//   - any paid sign: a 402, a billing or credit error, or an answer that reports a cost above 0. These also turn routing
//     off org-wide (the kernel's model_router.report_paid, once) and hold it off here until the kernel's status reads
//     "on" again (a report that did not land is retried on each call, and routing stays held until it lands);
//   - the kernel's model_router.status not "on" (read with a 60 s cache per isolate); a refused, failed or unknown
//     capability call reads as not "on";
//   - no `reflection-data-retention` header, or the value "contributor" (the request may train Reflection's models);
//   - an invalid answer: the same parse (parseModelObject) and the call site's own validation as the Workers AI path.
// The kernel (platform AIR1, 982971c: the ADR-0007 amendment; XAUUSD_CEILING grants xauusd-model-router these two
// capabilities; organism.json declares the agent so the census proposes register_agent). The two capabilities are
// called like every other kernel capability: kernelSyscall over the AGENTS binding as MODEL_ROUTER_AGENT, whose answer is
// { outcome: "succeeded", result } (workers/ai-kernel/src/syscall.ts). model_router.status's result is
// modelRouterStatus() (control-plane-shared/src/model-router.ts): { schema: "model_router.status.v1", available,
// state: { state, mode, paid_cap_usd, spent_usd, ... } | null, effective, health, limits, today, ... }. Routing needs
// state.state "on" AND state.mode "free_only" (the amendment: never under paid_capped, where only the kernel counts
// spend); `effective` is not read (it also reflects the kernel's own var and key). model_router.report_paid takes only
// { signal } (http_402, billing_error, cost_field, plan_change or reported); any other key is refused. Anything else
// (refused, failed, unknown, null state) reads as not "on" and every call falls back.
import { recordAiUsage } from "./ai-usage.mjs";
import { parseModelObject } from "./model-call.mjs";

/** The router's Worker secret, set by the owner through the platform. */
export const MODEL_ROUTER_SECRETS = Object.freeze(["REFLECTION_API_KEY"]);
export const MODEL_ROUTER_DEFAULTS = Object.freeze({ base: "https://api.reflection.ai/openai/v1", model: "Beam-1.0-501B-A23B" });
/** Beam's own counters for the routed shadow calls (Reflection's free Beta is shared by the organisation). */
export const MODEL_ROUTER_LIMITS = Object.freeze({ tokens_in_day: 100_000, tokens_out_day: 20_000, requests_day: 20, rpm: 2 });
/**
 * The hard output cap of one call. Beam always reasons and its reasoning counts as output, so the cap is the tight budget:
 * news_compare makes about 2 calls a day, 2 x 2,000 = 4,000 of the 20,000 a day; the 20k cap is hit only after 10 calls.
 */
export const MODEL_ROUTER_MAX_TOKENS = 2_000;
export const MODEL_ROUTER_EFFORT = "low";
export const MODEL_ROUTER_TIMEOUT_MS = 25_000;
export const MODEL_ROUTER_BREAKER = Object.freeze({ failures: 3, window_ms: 15 * 60_000 });
export const MODEL_ROUTER_STATUS_CACHE_MS = 60_000;
/** The kernel agent the router's two capabilities are called as (platform 982971c: XAUUSD_CEILING grants it model_router.status and model_router.report_paid). */
export const MODEL_ROUTER_AGENT = "xauusd-model-router";
export const MODEL_ROUTER_CAPABILITIES = Object.freeze({ status: "model_router.status", report_paid: "model_router.report_paid" });
/** KV (SIGNAL_CACHE): a paid sign seen here, { at, reason, reported }; routing stays off until the kernel reads "on" after it. */
export const MODEL_ROUTER_PAID_KEY = "model-router:paid:v1";
/** Every fallback reason code. */
export const MODEL_ROUTER_REASONS = Object.freeze([
  "not_allowed", "no_key", "breaker_open", "limit_tokens_in", "limit_tokens_out", "limit_requests_day", "limit_rpm",
  "kernel_off", "kernel_paid_capped", "kernel_unknown", "paid_hold", "timeout", "unreachable", "rate_limited", "rate_limit_hold", "paid_402", "paid_billing", "paid_cost",
  "http_5xx", "http_4xx", "retention_missing", "retention_contributor", "invalid_answer"
]);
const PAID = new Set(["paid_402", "paid_billing", "paid_cost"]);
/** The kernel's paid signal for each of this router's paid reasons (report_paid takes { signal } only). */
export const MODEL_ROUTER_PAID_SIGNAL = Object.freeze({ paid_402: "http_402", paid_billing: "billing_error", paid_cost: "cost_field", paid_plan: "plan_change" });
export const paidSignalOf = (reason) => MODEL_ROUTER_PAID_SIGNAL[reason] ?? "reported";
/** KV (SIGNAL_CACHE): a 429's back-off, { until } (ms). */
export const MODEL_ROUTER_RATE_KEY = "model-router:rate-limited:v1";
/**
 * Pure, the platform's order (AIR1 B1): a 402 is paid; a 429 never is (it is a rate limit, whatever the text); billing or
 * credit text counts only on another 4xx (never on a 429 or a 5xx); a cost above 0 counts only on a 2xx. Null otherwise.
 */
export function paidSignOf(status, said, billed) {
  if (status === 402) return "paid_402";
  if (status === 429 || status >= 500) return null;
  if (status >= 400 && status < 500) return BILLING.test(String(said ?? "")) ? "paid_billing" : null;
  if (status >= 200 && status < 300 && Number.isFinite(Number(billed)) && Number(billed) > 0) return "paid_cost";
  return null;
}
/** Pure: when a 429's back-off ends: the next 00:00 UTC for a daily quota (the text says day, daily or today), else Retry-After seconds, else 60 s. */
export function rateLimitUntil(now, said, retryAfter) {
  if (/\b(daily|day|today|per[ _-]?day|24 ?h)\b/i.test(String(said ?? ""))) return (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  const ra = Number(retryAfter);
  return now + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 86_400) * 1000 : 60_000);
}
const BILLING = /billing|credit|payment|insufficient[_ ]?(funds|balance)|prepaid|paid[_ ]?plan|upgrade|subscription/i;
const EVENTS_SQL = [
  `CREATE TABLE IF NOT EXISTS model_router_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, day TEXT NOT NULL,
  site TEXT NOT NULL, reading TEXT, model TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, asked INTEGER NOT NULL DEFAULT 0,
  failure INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, retention TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_model_router_events_at ON model_router_events (at_ms)"
];
const KEEP_MS = 90 * 86_400_000;
// src/shadow-switch.mjs reads this module's counters, and platform-reports.mjs reaches shadow-switch through the rooms:
// the kernel call is imported when it is first used, so no import cycle forms.
const kernelSyscall = async (...a) => (await import("./platform-reports.mjs")).kernelSyscall(...a);
const int = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);
const word = (v, n = 40) => String(v ?? "").replace(/[^a-z0-9_.:-]/gi, "_").slice(0, n);

/** The FS1 switch SHADOW_MODEL_ROUTER: "on" or "off" (the default; anything but "on" is off). */
export function shadowModelRouterMode(env) {
  return String(env?.SHADOW_MODEL_ROUTER ?? "").trim().toLowerCase() === "on" ? "on" : "off";
}

/** The router's settings from the Worker's vars and secret (the key itself never leaves the call below). */
export function modelRouterConfig(env = {}) {
  const base = String(env?.MODEL_BASE_URL || MODEL_ROUTER_DEFAULTS.base).replace(/\/+$/, "");
  return {
    base: /^https:\/\//.test(base) ? base : MODEL_ROUTER_DEFAULTS.base,
    model: String(env?.MODEL_ID || MODEL_ROUTER_DEFAULTS.model).slice(0, 80),
    has_key: Boolean(String(env?.REFLECTION_API_KEY ?? "").trim())
  };
}

/**
 * Pure: Beam's day counters from the shadow breaker's ai_usage_daily rows ({ model, calls, p, c }) of the router's model,
 * or null when there are none. `calls` counts the answers; the router adds the requests that got none (timeouts, errors)
 * from its own events.
 */
export function routerCounters(rows, model = MODEL_ROUTER_DEFAULTS.model) {
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r?.model === model);
  if (!mine.length) return null;
  const sum = (k) => mine.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const c = { model, calls: sum("calls"), requests: sum("calls"), tokens_in: sum("p"), tokens_out: sum("c") };
  return { ...c, limits: { ...MODEL_ROUTER_LIMITS }, at_limit: routerLimitReached(c) };
}

/** Pure: the first day limit a counter reaches ("limit_tokens_in", ...), or null. The output check reserves this call's cap. */
export function routerLimitReached(c, { maxTokens = MODEL_ROUTER_MAX_TOKENS } = {}) {
  if (!c) return null;
  if (int(c.tokens_in) >= MODEL_ROUTER_LIMITS.tokens_in_day) return "limit_tokens_in";
  if (int(c.tokens_out) + maxTokens > MODEL_ROUTER_LIMITS.tokens_out_day) return "limit_tokens_out";
  if (int(c.requests) >= MODEL_ROUTER_LIMITS.requests_day) return "limit_requests_day";
  return null;
}

let statusMemo = null; // { at, status, detail }: one kernel read per isolate per MODEL_ROUTER_STATUS_CACHE_MS
let schemaReady = new WeakSet();
export function resetModelRouterForTests() { statusMemo = null; schemaReady = new WeakSet(); }

async function ensureEvents(db) {
  if (schemaReady.has(db)) return;
  for (const sql of EVENTS_SQL) await db.prepare(sql).run();
  schemaReady.add(db);
}

/**
 * Pure: the router's reading of a model_router.status result. "on" only for state.state "on" with state.mode "free_only";
 * "paid_capped" for on under a paid cap (never routed here); "off" for any other known state (off, off_paid, off_owner,
 * off_retention); "unknown" when the result or its state is missing or unreadable.
 */
export function readKernelStatus(result) {
  const st = result && typeof result === "object" && result.schema === "model_router.status.v1" ? result.state : undefined;
  if (!st || typeof st !== "object") return { status: "unknown", detail: st === null ? "no_state" : "unreadable" };
  const state = String(st.state ?? ""), mode = String(st.mode ?? "");
  if (state === "on" && mode === "free_only") return { status: "on", detail: null };
  if (state === "on" && mode === "paid_capped") return { status: "paid_capped", detail: "paid_capped" };
  if (["off", "off_paid", "off_owner", "off_retention"].includes(state)) return { status: "off", detail: word(`${state}:${mode}`) };
  return { status: "unknown", detail: "unreadable" };
}

/** The kernel's router status: "on", "paid_capped", "off" or "unknown" (refused, failed, unreachable or unreadable). Never throws. */
export async function routerKernelStatus(env, { now = Date.now(), fresh = false } = {}) {
  if (!fresh && statusMemo && now >= statusMemo.at && now - statusMemo.at < MODEL_ROUTER_STATUS_CACHE_MS) return statusMemo;
  const r = await kernelSyscall(env, MODEL_ROUTER_AGENT, MODEL_ROUTER_CAPABILITIES.status, {});
  const ok = r?.outcome === "succeeded" || r?.outcome === "success";
  const read = ok ? readKernelStatus(r?.result) : { status: "unknown", detail: word(`${r?.outcome ?? "failed"}:${r?.reason ?? ""}`, 80) };
  statusMemo = { at: now, ...read };
  return statusMemo;
}

/** The paid sign held in KV ({ at, reason, reported }), or null. Never throws. Shared with the live router (CL1 PR2). */
export async function readModelRouterPaid(env) { return readPaid(env); }
async function readPaid(env) {
  try { const v = JSON.parse((await env?.SIGNAL_CACHE?.get?.(MODEL_ROUTER_PAID_KEY)) || "null"); return v && Number.isFinite(Number(v.at)) ? v : null; } catch { return null; }
}

/** One event row (never a prompt or an answer) and old rows dropped. Never throws. */
async function recordEvent(db, e) {
  if (!db?.prepare) return false;
  try {
    await ensureEvents(db);
    await db.prepare("INSERT INTO model_router_events (at_ms, day, site, reading, model, outcome, reason, asked, failure, tokens_in, tokens_out, retention) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(e.at, new Date(e.at).toISOString().slice(0, 10), word(e.site), e.reading ? word(e.reading) : null, word(e.model, 80), e.outcome, e.reason ?? null, e.asked ? 1 : 0, e.failure ? 1 : 0, int(e.tokens_in), int(e.tokens_out), e.retention ? word(e.retention) : null).run();
    await db.prepare("DELETE FROM model_router_events WHERE at_ms < ?").bind(e.at - KEEP_MS).run();
    return true;
  } catch { return false; }
}

async function countSince(db, sql, since) {
  try { await ensureEvents(db); return Number((await db.prepare(sql).bind(since).first())?.n) || 0; } catch { return 0; }
}

/**
 * One routed shadow call. `allow` is the call site's own allow-list and `site` its name; `messages` the call's messages;
 * `accept(obj)` the call site's validation (a value, or null when the answer does not fit); `fallback()` the current
 * Workers AI path, run unchanged on every fallback; `spendToday()` the shadow breaker's reading of today's spend (its
 * `beam` counters). Returns { via: "beam", value } or { via: "workers_ai", reason, value } and never throws (a throwing
 * fallback throws as it would without the router).
 */
export async function routeShadowCall(env, { site, allow, reading = null, messages, meterSource, accept, fallback, spendToday = null, fetcher = (...a) => fetch(...a), clock = () => Date.now(), timeoutMs = MODEL_ROUTER_TIMEOUT_MS } = {}) {
  const cfg = modelRouterConfig(env);
  const db = env?.DB;
  const back = async (reason, extra = {}) => {
    await recordEvent(db, { at: clock(), site, reading, model: cfg.model, outcome: "fallback", reason, ...extra });
    console.log("model_router_fallback", JSON.stringify({ site: word(site), reading: reading ? word(reading) : null, reason }));
    return { via: "workers_ai", reason, value: await fallback() };
  };
  if (!Array.isArray(allow) || !allow.includes(site)) return back("not_allowed");
  if (!cfg.has_key) return back("no_key");
  const now = clock();
  const windowStart = Math.floor(now / MODEL_ROUTER_BREAKER.window_ms) * MODEL_ROUTER_BREAKER.window_ms;
  if (db && await countSince(db, "SELECT COUNT(*) AS n FROM model_router_events WHERE failure = 1 AND at_ms >= ?", windowStart) >= MODEL_ROUTER_BREAKER.failures) return back("breaker_open");
  const spend = typeof spendToday === "function" ? await spendToday().catch(() => null) : null;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const asked = db ? await countSince(db, "SELECT COUNT(*) AS n FROM model_router_events WHERE asked = 1 AND at_ms >= ?", dayStart) : 0;
  const beam = spend?.beam ?? { tokens_in: 0, tokens_out: 0, calls: 0 };
  const limit = routerLimitReached({ ...beam, requests: Math.max(asked, Number(beam.calls) || 0) });
  if (limit) return back(limit);
  if (db && await countSince(db, "SELECT COUNT(*) AS n FROM model_router_events WHERE asked = 1 AND at_ms > ?", now - 60_000) >= MODEL_ROUTER_LIMITS.rpm) return back("limit_rpm");
  // A 429's back-off still running: no request.
  try { const rl = JSON.parse((await env?.SIGNAL_CACHE?.get?.(MODEL_ROUTER_RATE_KEY)) || "null"); if (rl && Number(rl.until) > now) return back("rate_limit_hold"); } catch { /* unreadable: no hold */ }
  // The kernel's status; after a paid sign here, only a status read made after it counts, and only "on" lifts it.
  const paid = await readPaid(env);
  // A paid sign whose report_paid did not land: the org-wide switch-off is not in force, so a kernel "on" proves nothing.
  // Hold, and report again on each call until the kernel takes it.
  if (paid && paid.reported !== true) {
    const r = await kernelSyscall(env, MODEL_ROUTER_AGENT, MODEL_ROUTER_CAPABILITIES.report_paid, { signal: paidSignalOf(paid.reason) });
    if (r?.outcome === "succeeded" || r?.outcome === "success") {
      try { await env?.SIGNAL_CACHE?.put?.(MODEL_ROUTER_PAID_KEY, JSON.stringify({ ...paid, at: clock(), reported: true })); } catch { /* reported; the next call reads the kernel again */ }
      statusMemo = { at: clock(), status: "off", detail: "paid" };
    }
    console.log("model_router_paid", JSON.stringify({ reason: word(paid.reason), reported: r?.outcome === "succeeded" || r?.outcome === "success", retry: true }));
    return back("paid_hold");
  }
  const k = await routerKernelStatus(env, { now, fresh: Boolean(paid && (!statusMemo || statusMemo.at < Number(paid.at))) });
  if (k.status !== "on") return back(paid ? "paid_hold" : k.status === "off" ? "kernel_off" : k.status === "paid_capped" ? "kernel_paid_capped" : "kernel_unknown");
  if (paid) { try { await env.SIGNAL_CACHE.delete(MODEL_ROUTER_PAID_KEY); } catch { /* the next status read decides again */ } }

  const meter = (outcome, usage = { prompt: 0, completion: 0 }) => recordAiUsage(db, { source: meterSource, model: cfg.model, outcome, prompt: usage.prompt, completion: usage.completion, now: clock() });
  let res;
  try {
    res = await fetcher(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.REFLECTION_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages, max_completion_tokens: MODEL_ROUTER_MAX_TOKENS, reasoning_effort: MODEL_ROUTER_EFFORT }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const reason = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "unreachable";
    await meter(reason === "timeout" ? "timeout" : "failed");
    return back(reason, { asked: true, failure: true });
  }
  const retention = String(res?.headers?.get?.("reflection-data-retention") ?? "").trim().toLowerCase() || null;
  let body = null;
  try { body = await res.json(); } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") { await meter("timeout"); return back("timeout", { asked: true, failure: true, retention }); }
    body = null;
  }
  const usage = { prompt: int(body?.usage?.prompt_tokens), completion: int(body?.usage?.completion_tokens) };
  const sent = { asked: true, retention, tokens_in: usage.prompt, tokens_out: usage.completion };
  const billed = Number(body?.usage?.cost ?? body?.usage?.total_cost ?? body?.cost ?? 0);
  const said = `${body?.error?.code ?? ""} ${body?.error?.type ?? ""} ${body?.error?.message ?? ""}`;
  await meter(res.ok ? "ok" : "failed", usage);
  // A 429 is a rate limit whatever its text says (a free-quota answer often reads "upgrade your plan" or "credits"):
  // never a paid sign. Back off until the next 00:00 UTC for a daily quota, else Retry-After or 60 s.
  if (res.status === 429) {
    const until = rateLimitUntil(clock(), said, res?.headers?.get?.("retry-after"));
    try { await env?.SIGNAL_CACHE?.put?.(MODEL_ROUTER_RATE_KEY, JSON.stringify({ until }), { expirationTtl: Math.max(60, Math.ceil((until - clock()) / 1000) + 60) }); } catch { /* the next 429 sets it again */ }
    return back("rate_limited", sent);
  }
  const paidSign = paidSignOf(res.status, said, billed);
  if (paidSign) {
    await reportRouterPaidSign(env, paidSign, clock);
    return back(paidSign, sent);
  }
  if (!res.ok) return back(res.status >= 500 ? "http_5xx" : "http_4xx", { ...sent, failure: res.status >= 500 });
  if (!retention) return back("retention_missing", sent);
  if (retention === "contributor") return back("retention_contributor", sent);
  let value = null;
  try { const parsed = parseModelObject(body); value = parsed.obj ? accept(parsed.obj) : null; } catch { value = null; }
  if (value == null) return back("invalid_answer", sent);
  await recordEvent(db, { at: clock(), site, reading, model: cfg.model, outcome: "routed", reason: null, ...sent });
  return { via: "beam", value };
}

/**
 * A paid sign seen on any Beam call (shadow or live): routing off org-wide through the kernel's report_paid, once, and held
 * off here (KV) until the kernel's status reads "on" again. Never throws.
 */
export async function reportRouterPaidSign(env, paidSign, clock = () => Date.now()) {
  const r = await kernelSyscall(env, MODEL_ROUTER_AGENT, MODEL_ROUTER_CAPABILITIES.report_paid, { signal: paidSignalOf(paidSign) });
  const reported = r?.outcome === "succeeded" || r?.outcome === "success";
  try { await env?.SIGNAL_CACHE?.put?.(MODEL_ROUTER_PAID_KEY, JSON.stringify({ at: clock(), reason: paidSign, reported })); } catch { /* the memo below still holds this isolate */ }
  statusMemo = { at: clock(), status: "off", detail: "paid" };
  console.log("model_router_paid", JSON.stringify({ reason: paidSign, reported }));
  return reported;
}

/** The router's recent events for a read model or a test (never a prompt or an answer). Never throws. */
export async function readRouterEvents(db, { limit = 50 } = {}) {
  try {
    await ensureEvents(db);
    return (await db.prepare("SELECT at_ms, day, site, reading, model, outcome, reason, asked, failure, tokens_in, tokens_out, retention FROM model_router_events ORDER BY id DESC LIMIT ?").bind(Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))).all()).results || [];
  } catch { return []; }
}
