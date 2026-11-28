// CL1 PR2 (owner 2026-11-28, relayed verbatim: "Langsung aja 100%" and "Beam → Haiku → WAI (Recommended)"): the live
// provider chain for the gpt-oss-120b sources and the text roles. Behind two owner FS1 switches, ROUTER_DECISION and
// ROUTER_TEXT (both "off" by default); off, nothing here runs and every call is today's Workers AI call.
//
// The chain per call: Reflection's Beam (the free model the shadow news comparison already uses) → Claude Haiku 5.5
// (Anthropic API, USD) → the call's Workers AI model as before. Each step falls through on a timeout, a 429, a 5xx, a
// refusal or cut-off answer, invalid JSON or schema, a paid sign, a cap, a breaker or a rolled-back provider; the last
// step is today's Workers AI path, so the decision is never empty. Every attempt is metered (ai_usage_daily, under the
// role's source and the provider's model) and recorded (D1 router_calls, never a prompt or an answer).
import Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage, ensureAiUsageSchema } from "./ai-usage.mjs";
import { modelRouterConfig, routerKernelStatus, paidSignOf, rateLimitUntil, MODEL_ROUTER_RATE_KEY, readModelRouterPaid, reportRouterPaidSign } from "./model-router.mjs";
import { CLAUDE_MODEL, CLAUDE_METER_MODEL, CLAUDE_METER_PREFIX, toClaudeRequest, claudeSchema, classifyClaudeError, claudeUsdMicros, readClaudeBreaker, tripClaudeBreaker } from "./claude-shadow.mjs";

export const ROUTER_VERSION = "provider-router-v1";
/** The routed sources by switch group; nothing else is routed (seats, rebuttals, shadow arms stay on Workers AI). */
export const ROUTER_GROUPS = Object.freeze({
  decision: Object.freeze(["decision_council", "war_room_conclusion", "tf_room_conclusion", "macro_room_conclusion"]),
  text: Object.freeze(["news_analyst", "news_counselor", "news_reasoner", "news_daily_tldr", "plain_decision", "thread_moderator"])
});
export const ROUTER_SWITCHES = Object.freeze({ decision: "ROUTER_DECISION", text: "ROUTER_TEXT" });
export const ROUTER_PROVIDERS = Object.freeze(["beam", "claude"]);
/**
 * The output cap of each routed role (max_tokens / max_completion_tokens; never above the caller's own budget for Beam).
 * Claude's decision roles think, so their cap holds the thinking too.
 */
export const ROUTER_OUTPUT_CAP = Object.freeze({
  decision_council: 8000, war_room_conclusion: 6000, tf_room_conclusion: 6000, macro_room_conclusion: 6000,
  news_analyst: 2048, news_counselor: 2048, news_reasoner: 3000, news_daily_tldr: 2048, plain_decision: 2048, thread_moderator: 3000
});
/**
 * What never leaves the account (orchestrator, CL1 PR2): a prompt that carries any of these JSON keys, or the value of any
 * of the Worker's secrets, is not sent to Beam or Anthropic; the call goes to Workers AI as before. Prices and market
 * evidence go out.
 */
export const OUTBOUND_FORBIDDEN_KEYS = Object.freeze(["account_ref", "account_id", "account_number", "login", "broker_login", "password", "balance", "equity", "free_margin", "margin_level", "lots", "lot_size", "position_size", "owner_email", "email", "api_key", "token", "secret"]);
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/i;
/** Per-call timeouts; a step runs only while the Workers AI step keeps its reserve before the call's deadline. */
export const ROUTER_TIMEOUT_MS = Object.freeze({ beam: 20_000, claude: 20_000 });
export const WORKERS_AI_RESERVE_MS = 35_000;
/** The text roles have no deadline of their own (the hourly news chain); they get one this long. */
export const ROUTER_TEXT_DEADLINE_MS = 120_000;
/** Beam: xauusd's share of the org's free beta (10M in / 1M out a day, 60 rpm, shared with CTA). */
export const BEAM_LIVE_LIMITS = Object.freeze({ tokens_in_day: 6_000_000, tokens_out_day: 600_000, rpm: 30 });
export const BEAM_METER_PREFIX = "reflection:";
/** Claude: a hard daily cap for live use (the owner may set ROUTER_CLAUDE_USD_PER_DAY), and calls a minute per role. */
export const CLAUDE_LIVE_CAP_USD = 1.0;
export const CLAUDE_LIVE_RPM = 4;
/** Auto-rollback per role and provider over a rolling day; back only by the owner's flip of the group switch. */
export const ROUTER_ROLLBACK = Object.freeze({ window_ms: 86_400_000, min_calls: 20, min_validity: 0.95, max_timeout_share: 0.02 });
export const ROUTER_ROLLBACK_KEY = "provider-router:rollback:v1";

const ROUTER_SQL = [
  `CREATE TABLE IF NOT EXISTS router_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, day TEXT NOT NULL,
  role TEXT NOT NULL, grp TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, asked INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
  reason TEXT, latency_ms INTEGER, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, usd_micros INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS idx_router_calls_at ON router_calls (at_ms)",
  "CREATE INDEX IF NOT EXISTS idx_router_calls_role ON router_calls (role, provider, at_ms)"
];
/** router_calls keeps 30 days: enough for p50/p95 and the 7-day baseline (pruned by the hourly rollback check). */
export const ROUTER_KEEP_MS = 30 * 86_400_000;
const int = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const word = (v, n = 40) => String(v ?? "").replace(/[^a-z0-9_.:-]/gi, "_").slice(0, n);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / 86_400_000) * 86_400_000;
const nextDay = (ms) => dayStart(ms) + 86_400_000;

let schemaReady = new WeakSet();
let rateHeadersLogged = 0;
export function resetProviderRouterForTests() { schemaReady = new WeakSet(); rateHeadersLogged = 0; }
async function ensureSchema(db) {
  if (!db?.prepare || schemaReady.has(db)) return;
  for (const sql of ROUTER_SQL) await db.prepare(sql).run();
  schemaReady.add(db);
}

/** Pure: the switch group of a meter source ("decision", "text"), or null when it is not routed. */
export function routerGroupOf(source) {
  for (const [g, roles] of Object.entries(ROUTER_GROUPS)) if (roles.includes(String(source ?? ""))) return g;
  return null;
}
/** Pure: a group switch's mode, "on" or "off" (the default; anything but "on" is off). */
export function routerMode(env, group) {
  return group === "decision" ? routerDecisionMode(env) : group === "text" ? routerTextMode(env) : "off";
}
/** FS1's accessors (one reader per key). */
export function routerDecisionMode(env) { return String(env?.ROUTER_DECISION ?? "").trim().toLowerCase() === "on" ? "on" : "off"; }
export function routerTextMode(env) { return String(env?.ROUTER_TEXT ?? "").trim().toLowerCase() === "on" ? "on" : "off"; }

/** Pure: the day's Claude cap in USD: the owner's ROUTER_CLAUDE_USD_PER_DAY when set (0 < x <= 20), else 1.00. */
export function claudeLiveCap(env) {
  const v = Number(env?.ROUTER_CLAUDE_USD_PER_DAY);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 20) : CLAUDE_LIVE_CAP_USD;
}
export function claudeLiveRpm(env) {
  const v = Number(env?.ROUTER_CLAUDE_RPM);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 60) : CLAUDE_LIVE_RPM;
}

/** Pure: the first JSON object in a model's text, or null. */
export function jsonOf(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  try { const o = JSON.parse(t); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { /* look inside */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(t.slice(a, b + 1)); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
}

/**
 * Pure: the role's JSON schema checked on an answer: required keys present, types and enums right, nested objects too.
 * Numeric ranges and lengths are left to the caller's own validator, which still runs after the router.
 */
export function schemaErrors(obj, schema, path = "") {
  const out = [];
  if (!schema || typeof schema !== "object") return out;
  const t = schema.type;
  const at = path || "answer";
  const typeOk = (v, ty) => ty === "string" ? typeof v === "string" : ty === "number" ? typeof v === "number" && Number.isFinite(v) : ty === "integer" ? Number.isInteger(v)
    : ty === "boolean" ? typeof v === "boolean" : ty === "array" ? Array.isArray(v) : ty === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : ty === "null" ? v === null : true;
  const types = Array.isArray(t) ? t : t ? [t] : [];
  if (types.length && !types.some((ty) => typeOk(obj, ty))) { out.push(`${at}:type`); return out; }
  if (Array.isArray(schema.enum) && !schema.enum.includes(obj)) out.push(`${at}:enum`);
  if (obj && typeof obj === "object" && !Array.isArray(obj) && schema.properties) {
    for (const k of schema.required || []) if (!(k in obj)) out.push(`${path ? `${path}.` : ""}${k}:missing`);
    for (const [k, s] of Object.entries(schema.properties)) if (k in obj) out.push(...schemaErrors(obj[k], s, path ? `${path}.${k}` : k));
  }
  if (Array.isArray(obj) && schema.items) obj.slice(0, 50).forEach((v, i) => out.push(...schemaErrors(v, schema.items, `${at}[${i}]`)));
  return out.slice(0, 12);
}

/** Pure: an answer as the router accepts it ({ ok, obj, text, reason }). */
export function acceptAnswer({ text, schema, check = null, cutOff = false, refused = false }) {
  if (refused) return { ok: false, reason: "refusal" };
  if (cutOff) return { ok: false, reason: "cut_off" };
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (!schema && typeof check !== "function") return { ok: true, obj: null, text: t };
  const obj = jsonOf(t);
  if (!obj) return { ok: false, reason: "invalid_json" };
  const errors = schema ? schemaErrors(obj, schema) : [];
  if (errors.length) return { ok: false, reason: `schema:${errors[0]}` };
  const bad = typeof check === "function" ? check(obj) : null;
  return bad ? { ok: false, reason: `check:${word(bad, 40)}` } : { ok: true, obj, text: t };
}

/**
 * Pure: why these messages must not leave the account, or null. A forbidden JSON key ("key": ...) anywhere in the text,
 * or the value of any secret binding (a name with KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL, 8 characters or more).
 */
export function outboundBlock(env, messages) {
  const text = (Array.isArray(messages) ? messages : []).map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))).join("\n");
  for (const k of OUTBOUND_FORBIDDEN_KEYS) if (new RegExp(`"${k}"\\s*:`, "i").test(text)) return `forbidden_key:${k}`;
  for (const [name, v] of Object.entries(env || {})) {
    if (!SECRET_NAME.test(name) || typeof v !== "string" || v.trim().length < 8) continue;
    if (text.includes(v.trim())) return "secret_value";
  }
  return null;
}
/** Pure: a role's output cap for a call that asked for `asked` tokens (Beam never more than the caller asked). */
export function outputCap(role, asked, provider) {
  const cap = ROUTER_OUTPUT_CAP[role] ?? 2048;
  const a = Math.max(256, Math.round(Number(asked) || cap));
  return provider === "beam" ? Math.min(a, cap) : cap;
}

async function record(db, row) {
  if (!db?.prepare) return;
  try {
    await ensureSchema(db);
    await db.prepare("INSERT INTO router_calls (at_ms, day, role, grp, provider, model, asked, outcome, reason, latency_ms, tokens_in, tokens_out, usd_micros) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.at, dayOf(row.at), word(row.role), row.grp, row.provider, row.model ? word(row.model, 80) : null, row.asked ? 1 : 0, row.outcome, row.reason ? word(row.reason, 60) : null,
        Number.isFinite(row.latency_ms) ? Math.round(row.latency_ms) : null, int(row.tokens_in), int(row.tokens_out), int(row.usd_micros)).run();
  } catch { /* the record is best effort; the call goes on */ }
}
async function one(db, sql, ...binds) {
  try { await ensureSchema(db); return (await db.prepare(sql).bind(...binds).first()) || {}; } catch { return null; }
}

/** The rollback state ({ "<role>|<provider>": { at, validity, timeout_share, calls, telegram_sent_at } }). Never throws. */
export async function readRollbacks(env) {
  try { const v = JSON.parse((await env?.SIGNAL_CACHE?.get?.(ROUTER_ROLLBACK_KEY)) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
/** The owner's last flip of a group switch to "on" (ms), from FS1's audit rows; null when none or unreadable. */
export async function lastSwitchOn(db, group) {
  const key = ROUTER_SWITCHES[group];
  if (!db?.prepare || !key) return null;
  try {
    const r = await db.prepare("SELECT MAX(ms) AS ms FROM omega_events WHERE action = 'feature_switch' AND actor = 'owner' AND json_extract(detail, '$.key') = ? AND json_extract(detail, '$.to') = 'on'").bind(key).first();
    return Number.isFinite(Number(r?.ms)) && Number(r.ms) > 0 ? Number(r.ms) : null;
  } catch { return null; }
}
/** Whether a role's provider is rolled back now: a rollback stands until the owner flips the group switch on after it. */
async function rolledBack(env, role, provider, group, rollbacks) {
  const rb = rollbacks[`${role}|${provider}`];
  if (!rb) return false;
  return rollbackStands(rb, await lastSwitchOn(env?.DB, group));
}

async function beamAttempt(env, ctx) {
  const { role, grp, messages, schema, check, deadline, clock, fetcher, rollbacks } = ctx;
  const maxTokens = outputCap(role, ctx.maxTokens, "beam");
  const cfg = modelRouterConfig(env);
  const model = `${BEAM_METER_PREFIX}${cfg.model}`;
  const db = env?.DB;
  const now = clock();
  const skip = async (reason) => { await record(db, { at: clock(), role, grp, provider: "beam", model, asked: false, outcome: "skipped", reason }); return { ok: false, asked: false, reason }; };
  if (!cfg.has_key) return skip("no_key");
  if (await rolledBack(env, role, "beam", grp, rollbacks)) return skip("rolled_back");
  if (await readModelRouterPaid(env)) return skip("paid_hold");
  try { const rl = JSON.parse((await env?.SIGNAL_CACHE?.get?.(MODEL_ROUTER_RATE_KEY)) || "null"); if (rl && Number(rl.until) > now) return skip("rate_limit_hold"); } catch { /* no hold */ }
  const k = await routerKernelStatus(env, { now });
  if (k.status !== "on") return skip(k.status === "paid_capped" ? "kernel_paid_capped" : k.status === "off" ? "kernel_off" : "kernel_unknown");
  const today = await one(db, "SELECT COALESCE(SUM(tokens_in), 0) AS i, COALESCE(SUM(tokens_out), 0) AS o FROM router_calls WHERE provider = 'beam' AND asked = 1 AND at_ms >= ?", dayStart(now));
  if (!today) return skip("meter_unreadable");
  if (int(today.i) >= BEAM_LIVE_LIMITS.tokens_in_day) return skip("limit_tokens_in");
  if (int(today.o) + maxTokens > BEAM_LIVE_LIMITS.tokens_out_day) return skip("limit_tokens_out");
  const minute = await one(db, "SELECT COUNT(*) AS n FROM router_calls WHERE provider = 'beam' AND asked = 1 AND at_ms > ?", now - 60_000);
  if (Number(minute?.n) >= BEAM_LIVE_LIMITS.rpm) return skip("limit_rpm");
  const timeout = Math.min(ROUTER_TIMEOUT_MS.beam, deadline - now - WORKERS_AI_RESERVE_MS);
  if (timeout < 5_000) return skip("no_time");

  const t0 = clock();
  const meter = (outcome, usage = { prompt: 0, completion: 0 }) => recordAiUsage(db, { source: role, model, outcome, prompt: usage.prompt, completion: usage.completion, now: clock() });
  const done = async (outcome, reason, extra = {}) => {
    await record(db, { at: clock(), role, grp, provider: "beam", model, asked: true, outcome, reason, latency_ms: clock() - t0, ...extra });
    return { ok: false, asked: true, reason, outcome };
  };
  let res, body = null;
  try {
    res = await fetcher(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.REFLECTION_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages, max_completion_tokens: maxTokens, reasoning_effort: "low" }),
      signal: AbortSignal.timeout(timeout)
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    await meter(timedOut ? "timeout" : "failed");
    return done(timedOut ? "timeout" : "failed", timedOut ? "timeout" : "unreachable");
  }
  const usage = { prompt: int(body?.usage?.prompt_tokens), completion: int(body?.usage?.completion_tokens) };
  const tokens = { tokens_in: usage.prompt, tokens_out: usage.completion };
  await meter(res.ok ? "ok" : "failed", usage);
  const said = `${body?.error?.code ?? ""} ${body?.error?.type ?? ""} ${body?.error?.message ?? ""}`;
  if (res.status === 429) {
    const until = rateLimitUntil(clock(), said, res?.headers?.get?.("retry-after"));
    try { await env?.SIGNAL_CACHE?.put?.(MODEL_ROUTER_RATE_KEY, JSON.stringify({ until }), { expirationTtl: Math.max(60, Math.ceil((until - clock()) / 1000) + 60) }); } catch { /* the next 429 sets it again */ }
    return done("failed", "rate_limited", tokens);
  }
  const paid = paidSignOf(res.status, said, Number(body?.usage?.cost ?? body?.usage?.total_cost ?? body?.cost ?? 0));
  if (paid) { await reportRouterPaidSign(env, paid, clock); return done("failed", paid, tokens); }
  if (!res.ok) return done("failed", res.status >= 500 ? "http_5xx" : "http_4xx", tokens);
  const retention = String(res?.headers?.get?.("reflection-data-retention") ?? "").trim().toLowerCase();
  if (!retention) return done("failed", "retention_missing", tokens);
  if (retention === "contributor") return done("failed", "retention_contributor", tokens);
  const choice = body?.choices?.[0];
  const a = acceptAnswer({ text: choice?.message?.content, schema, check, cutOff: choice?.finish_reason === "length" });
  if (!a.ok) return done("invalid", a.reason, tokens);
  await record(db, { at: clock(), role, grp, provider: "beam", model, asked: true, outcome: "ok", latency_ms: clock() - t0, ...tokens });
  return { ok: true, provider: "beam", model, text: a.text, obj: a.obj, usage, latency_ms: clock() - t0 };
}

async function claudeAttempt(env, ctx) {
  const { role, grp, messages, schema, check, deadline, clock, client, rollbacks } = ctx;
  const maxTokens = outputCap(role, ctx.maxTokens, "claude");
  const model = CLAUDE_METER_MODEL;
  const db = env?.DB;
  const now = clock();
  const skip = async (reason) => { await record(db, { at: clock(), role, grp, provider: "claude", model, asked: false, outcome: "skipped", reason }); return { ok: false, asked: false, reason }; };
  if (!client && !String(env?.ANTHROPIC_API_KEY ?? "").trim()) return skip("no_key");
  if (await rolledBack(env, role, "claude", grp, rollbacks)) return skip("rolled_back");
  const breaker = await readClaudeBreaker(env);
  if (breaker && Number(breaker.until_ms) > now) return skip(`breaker_${word(breaker.reason || "open", 20)}`);
  // Live spend only: the shadow's rows (claude:<role>) count against its own cap.
  let spent = Infinity;
  try {
    await ensureAiUsageSchema(db);
    const r = await db.prepare("SELECT COALESCE(SUM(usd_micros), 0) AS u FROM ai_usage_daily WHERE day = ? AND model = ? AND source NOT LIKE ?").bind(dayOf(now), CLAUDE_METER_MODEL, `${CLAUDE_METER_PREFIX}%`).first();
    spent = (Number(r?.u) || 0) / 1e6;
  } catch { spent = Infinity; }
  if (!(spent < claudeLiveCap(env))) return skip("cap_reached");
  const minute = await one(db, "SELECT COUNT(*) AS n FROM router_calls WHERE provider = 'claude' AND role = ? AND asked = 1 AND at_ms > ?", role, now - 60_000);
  if (!minute || Number(minute.n) >= claudeLiveRpm(env)) return skip("limit_rpm");
  const timeout = Math.min(ROUTER_TIMEOUT_MS.claude, deadline - now - WORKERS_AI_RESERVE_MS);
  if (timeout < 5_000) return skip("no_time");

  const req = toClaudeRequest(messages);
  if (!req.messages.length) return skip("no_input");
  const decision = grp === "decision";
  const params = {
    model: CLAUDE_MODEL, max_tokens: maxTokens, messages: req.messages, ...(req.system ? { system: req.system } : {}),
    // The decision and conclusion roles think at effort low (as the 120b did); the text roles do not think.
    thinking: decision ? { type: "adaptive" } : { type: "disabled" },
    ...(decision || schema ? { output_config: { ...(decision ? { effort: "low" } : {}), ...(schema ? { format: { type: "json_schema", schema: claudeSchema(schema) } } : {}) } } : {})
  };
  const api = client ?? new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), maxRetries: 0, timeout });
  const t0 = clock();
  let res = null, headers = null;
  try {
    const call = api.messages.create(params, { timeout });
    if (typeof call?.withResponse === "function") { const w = await call.withResponse(); res = w.data; headers = w.response?.headers ?? null; } else res = await call;
  } catch (error) {
    const c = classifyClaudeError(error);
    if (c.trip) await tripClaudeBreaker(env, c.trip, clock());
    await recordAiUsage(db, { source: role, model, outcome: c.outcome === "timeout" ? "timeout" : "failed", now: clock() });
    await record(db, { at: clock(), role, grp, provider: "claude", model, asked: true, outcome: c.outcome === "timeout" ? "timeout" : "failed", reason: c.trip || (c.outcome === "timeout" ? "timeout" : clip(error?.status ?? "error", 20)), latency_ms: clock() - t0 });
    return { ok: false, asked: true, reason: c.trip || c.outcome };
  }
  // The key's rate tier, logged on the first calls of each isolate (owner check of the burst fit).
  if (headers && rateHeadersLogged < 3) {
    rateHeadersLogged += 1;
    const h = (n) => headers.get?.(n) ?? null;
    console.log("router_claude_rate_limits", JSON.stringify({ requests_limit: h("anthropic-ratelimit-requests-limit"), input_tokens_limit: h("anthropic-ratelimit-input-tokens-limit"), output_tokens_limit: h("anthropic-ratelimit-output-tokens-limit"), requests_remaining: h("anthropic-ratelimit-requests-remaining") }));
  }
  const u = res?.usage ?? {};
  const use = { input: int(u.input_tokens), output: int(u.output_tokens), cacheRead: int(u.cache_read_input_tokens), cacheWrite: int(u.cache_creation_input_tokens) };
  const usd = claudeUsdMicros(use);
  await recordAiUsage(db, { source: role, model, outcome: "ok", prompt: use.input + use.cacheRead + use.cacheWrite, completion: use.output, cached: use.cacheRead, cacheWrite: use.cacheWrite, usdMicros: usd, now: clock() });
  const text = (res?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  const a = acceptAnswer({ text, schema, check, cutOff: res?.stop_reason === "max_tokens", refused: res?.stop_reason === "refusal" });
  const row = { at: clock(), role, grp, provider: "claude", model, asked: true, latency_ms: clock() - t0, tokens_in: use.input + use.cacheRead + use.cacheWrite, tokens_out: use.output, usd_micros: usd };
  if (!a.ok) { await record(db, { ...row, outcome: "invalid", reason: a.reason }); return { ok: false, asked: true, reason: a.reason }; }
  await record(db, { ...row, outcome: "ok" });
  return { ok: true, provider: "claude", model, text: a.text, obj: a.obj, usage: { prompt: row.tokens_in, completion: use.output }, latency_ms: clock() - t0 };
}

/**
 * One routed live call: Beam, then Claude Haiku; null when the source is not routed, its group is off, or neither gave an
 * accepted answer (the caller then runs its Workers AI path as before). Never throws.
 * Returns { provider, model, text, obj, usage: { prompt, completion }, latency_ms, tried }.
 */
export async function routeLiveCall(env, { source, messages, schema = null, check = null, maxTokens = 4096, deadline = null, clock = () => Date.now(), fetcher = (...a) => fetch(...a), claudeClient = null } = {}) {
  const grp = routerGroupOf(source);
  if (!grp || routerMode(env, grp) !== "on") return null;
  try {
    const start = clock();
    const blocked = outboundBlock(env, messages);
    if (blocked) {
      await record(env?.DB, { at: start, role: source, grp, provider: "router", asked: false, outcome: "skipped", reason: blocked });
      console.warn("router_outbound_blocked", JSON.stringify({ role: word(source), reason: blocked }));
      return null;
    }
    const ctx = { role: source, grp, messages, schema, check, maxTokens, deadline: Number.isFinite(deadline) ? deadline : start + ROUTER_TEXT_DEADLINE_MS, clock, fetcher, client: claudeClient, rollbacks: await readRollbacks(env) };
    const tried = [];
    for (const step of [beamAttempt, claudeAttempt]) {
      const r = await step(env, ctx);
      if (r.ok) return { ...r, tried };
      tried.push(r.reason);
    }
    console.log("router_fell_through", JSON.stringify({ role: word(source), tried }));
    return null;
  } catch (error) {
    console.error("router_failed", clip(error?.message ?? error, 200));
    return null;
  }
}

/**
 * Pure: per role and provider, the rollback rule's numbers over the rows and whether it trips. `since` maps
 * "<role>|<provider>" to the time its count starts (the owner's re-arm), so calls from before a re-arm never trip it again.
 * Trips when validity (ok over ok + invalid, at least 20 answers) is under 95%, or more than 2% of at least 20 calls timed
 * out (and at least 2 did: one timeout alone never rolls a provider back).
 */
export function rollbackVerdicts(rows, { since = {} } = {}) {
  const by = new Map();
  for (const r of rows || []) {
    if (Number(r.asked) !== 1) continue;
    const k = `${r.role}|${r.provider}`;
    if (Number.isFinite(Number(since[k])) && Number(r.at_ms) <= Number(since[k])) continue;
    const a = by.get(k) || { role: r.role, provider: r.provider, calls: 0, answered: 0, ok: 0, timeouts: 0 };
    a.calls += 1;
    if (r.outcome === "ok") { a.ok += 1; a.answered += 1; } else if (r.outcome === "invalid") a.answered += 1; else if (r.outcome === "timeout") a.timeouts += 1;
    by.set(k, a);
  }
  return [...by.values()].map((a) => {
    // Validity is over the answers (ok and invalid): an HTTP error or a 429 is no answer and falls through at once.
    const validity = a.answered ? a.ok / a.answered : null, timeout_share = a.calls ? a.timeouts / a.calls : null;
    const trips = a.calls >= ROUTER_ROLLBACK.min_calls && ((a.answered >= ROUTER_ROLLBACK.min_calls && validity < ROUTER_ROLLBACK.min_validity) || (a.timeouts >= 2 && timeout_share > ROUTER_ROLLBACK.max_timeout_share));
    return { ...a, validity: validity == null ? null : Math.round(validity * 1000) / 1000, timeout_share: timeout_share == null ? null : Math.round(timeout_share * 1000) / 1000, trips };
  }).sort((x, y) => `${x.role}|${x.provider}`.localeCompare(`${y.role}|${y.provider}`));
}

/** Pure: whether a rollback stands, given the owner's last flip of its group switch to "on" (ms or null). */
export function rollbackStands(rb, lastOnMs) {
  if (!rb) return false;
  return !(Number.isFinite(Number(lastOnMs)) && Number(lastOnMs) > Number(rb.at));
}

/**
 * The hourly rollback check. A role's provider whose day (since its last re-arm) has validity under 95% or timeouts over
 * 2% is rolled back: KV state, an omega_events router_rollback row and one Telegram notice per rollback event (a notice
 * that failed is sent at the next check, never twice). It stands until the owner's FS1 flip of the group switch to "on"
 * written after rolled_back_at (an earlier flip never counts). Also prunes router_calls past 30 days. Never throws.
 */
export async function evaluateRouterRollback(env, { now = Date.now(), send = null } = {}) {
  try {
    if (!env?.DB) return { status: "unavailable" };
    await ensureSchema(env.DB);
    try { await env.DB.prepare("DELETE FROM router_calls WHERE at_ms < ?").bind(now - ROUTER_KEEP_MS).run(); } catch { /* the next hour prunes */ }
    if (routerDecisionMode(env) !== "on" && routerTextMode(env) !== "on") return { status: "off" };
    const state = await readRollbacks(env);
    const lastOn = { decision: await lastSwitchOn(env.DB, "decision"), text: await lastSwitchOn(env.DB, "text") };
    // Calls count from the later of the window start and a re-arm after the key's last rollback.
    const since = {};
    for (const [key, rb] of Object.entries(state)) {
      const on = lastOn[routerGroupOf(key.split("|")[0])];
      if (!rollbackStands(rb, on)) since[key] = on;
    }
    const rows = (await env.DB.prepare("SELECT at_ms, role, provider, asked, outcome FROM router_calls WHERE at_ms >= ? AND asked = 1").bind(now - ROUTER_ROLLBACK.window_ms).all()).results || [];
    const verdicts = rollbackVerdicts(rows, { since });
    let dirty = false;
    const added = [];
    for (const v of verdicts.filter((x) => x.trips && routerGroupOf(x.role))) {
      const key = `${v.role}|${v.provider}`;
      if (rollbackStands(state[key], lastOn[routerGroupOf(v.role)])) continue; // already rolled back
      state[key] = { at: now, validity: v.validity, timeout_share: v.timeout_share, calls: v.calls, telegram_sent_at: null };
      added.push(key);
      dirty = true;
      try { await env.DB.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:provider-router", "router_rollback", JSON.stringify({ role: v.role, provider: v.provider, validity: v.validity, timeout_share: v.timeout_share, calls: v.calls })).run(); } catch { /* the KV state still holds it */ }
    }
    // One notice per standing rollback event: the ones not yet told (this hour's, or a failed send before).
    const notified = [];
    for (const [key, rb] of Object.entries(state)) {
      const [role, provider] = key.split("|");
      if (rb.telegram_sent_at || !rollbackStands(rb, lastOn[routerGroupOf(role)]) || typeof send !== "function") continue;
      try {
        await send(`Model router: ${provider} is rolled back for ${role} (validity ${Math.round((rb.validity ?? 0) * 100)}%, timeouts ${Math.round((rb.timeout_share ?? 0) * 1000) / 10}% over ${rb.calls} calls). Its calls go to the next provider. It comes back only when the owner switches ${ROUTER_SWITCHES[routerGroupOf(role)]} off and on again.`);
        rb.telegram_sent_at = new Date(now).toISOString();
        notified.push(key);
        dirty = true;
      } catch { /* told at the next check */ }
    }
    if (dirty) await env.SIGNAL_CACHE?.put?.(ROUTER_ROLLBACK_KEY, JSON.stringify(state));
    return { status: added.length ? "rolled_back" : "ok", added, notified, verdicts };
  } catch (error) {
    return { status: "error", message: clip(error?.message ?? error, 200) };
  }
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] : null);

/**
 * GET /api/model-router: the switches, per role and provider over `days` (calls, share, validity, fallbacks, timeouts,
 * p50/p95 latency, USD, Beam output per call), Claude's spend against its cap, Beam's tokens against xauusd's share, the
 * breaker, the rollbacks, and the council's BUY/SELL/WAIT today and in the 7 days before ROUTER_DECISION went on.
 */
export async function readModelRouter(env, { days = 7, now = Date.now() } = {}) {
  const n = Math.min(Math.max(Math.round(Number(days) || 7), 1), 90);
  const out = {
    version: ROUTER_VERSION, switches: { ROUTER_DECISION: routerDecisionMode(env), ROUTER_TEXT: routerTextMode(env) }, groups: ROUTER_GROUPS, chain: ["beam", "claude", "workers_ai"],
    limits: { beam: BEAM_LIVE_LIMITS, claude_usd_per_day: claudeLiveCap(env), claude_rpm_per_role: claudeLiveRpm(env), timeouts_ms: ROUTER_TIMEOUT_MS, workers_ai_reserve_ms: WORKERS_AI_RESERVE_MS }, rollback_rule: ROUTER_ROLLBACK, days: n
  };
  if (!env?.DB) return { ...out, error: "unavailable" };
  try {
    await ensureSchema(env.DB);
    const since = now - n * 86_400_000;
    const rows = (await env.DB.prepare("SELECT role, provider, asked, outcome, reason, latency_ms, tokens_in, tokens_out, usd_micros FROM router_calls WHERE at_ms >= ?").bind(since).all()).results || [];
    const by = new Map();
    for (const r of rows) {
      const k = `${r.role}|${r.provider}`;
      const a = by.get(k) || { role: r.role, provider: r.provider, attempts: 0, calls: 0, ok: 0, invalid: 0, timeouts: 0, failed: 0, skipped: 0, tokens_in: 0, tokens_out: 0, usd_micros: 0, lat: [], reasons: {} };
      a.attempts += 1;
      if (Number(r.asked) === 1) a.calls += 1;
      if (r.outcome === "ok") { a.ok += 1; if (Number.isFinite(Number(r.latency_ms))) a.lat.push(Number(r.latency_ms)); }
      else if (r.outcome === "invalid") a.invalid += 1; else if (r.outcome === "timeout") a.timeouts += 1; else if (r.outcome === "failed") a.failed += 1; else a.skipped += 1;
      if (r.outcome !== "ok" && r.reason) a.reasons[r.reason] = (a.reasons[r.reason] || 0) + 1;
      a.tokens_in += int(r.tokens_in); a.tokens_out += int(r.tokens_out); a.usd_micros += int(r.usd_micros);
      by.set(k, a);
    }
    const okByRole = new Map();
    for (const a of by.values()) okByRole.set(a.role, (okByRole.get(a.role) || 0) + a.ok);
    const by_role = [...by.values()].map(({ lat, ...a }) => {
      const s = lat.sort((x, y) => x - y);
      return { ...a, share_of_routed: okByRole.get(a.role) ? Math.round((a.ok / okByRole.get(a.role)) * 1000) / 1000 : null, validity_rate: a.ok + a.invalid ? Math.round((a.ok / (a.ok + a.invalid)) * 1000) / 1000 : null,
        fallbacks: a.calls - a.ok, p50_latency_ms: pct(s, 0.5), p95_latency_ms: pct(s, 0.95), usd: a.usd_micros / 1e6, output_per_call: a.ok ? Math.round(a.tokens_out / Math.max(1, a.calls)) : null };
    }).sort((x, y) => (x.role + x.provider).localeCompare(y.role + y.provider));
    const day0 = dayStart(now);
    const beam = await one(env.DB, "SELECT COALESCE(SUM(tokens_in), 0) AS i, COALESCE(SUM(tokens_out), 0) AS o, MIN(CASE WHEN reason IN ('limit_tokens_in', 'limit_tokens_out') THEN at_ms END) AS out_at FROM router_calls WHERE provider = 'beam' AND at_ms >= ?", day0);
    let claudeUsd = null;
    try {
      await ensureAiUsageSchema(env.DB);
      const r = await env.DB.prepare("SELECT COALESCE(SUM(usd_micros), 0) AS u FROM ai_usage_daily WHERE day = ? AND model = ? AND source NOT LIKE ?").bind(dayOf(now), CLAUDE_METER_MODEL, `${CLAUDE_METER_PREFIX}%`).first();
      claudeUsd = (Number(r?.u) || 0) / 1e6;
    } catch { claudeUsd = null; }
    const breaker = await readClaudeBreaker(env);
    const rollbacks = await readRollbacks(env);
    const switchAt = await lastSwitchOn(env.DB, "decision");
    const lastOnOf = { decision: switchAt, text: await lastSwitchOn(env.DB, "text") };
    const councilCounts = async (fromMs, toMs) => {
      try {
        const r = (await env.DB.prepare("SELECT stance, COUNT(*) AS n FROM engine_decisions WHERE bar_close >= ? AND bar_close < ? GROUP BY stance").bind(new Date(fromMs).toISOString(), new Date(toMs).toISOString()).all()).results || [];
        return Object.fromEntries(["BUY", "SELL", "WAIT"].map((s) => [s, Number(r.find((x) => x.stance === s)?.n) || 0]));
      } catch { return null; }
    };
    const ref = switchAt ?? now;
    return {
      ...out, by_role,
      today: {
        day: dayOf(now), resets_at: new Date(nextDay(now)).toISOString(),
        claude: { usd: claudeUsd, cap_usd: claudeLiveCap(env) },
        beam: beam ? { tokens_in: int(beam.i), tokens_out: int(beam.o), limit_in: BEAM_LIVE_LIMITS.tokens_in_day, limit_out: BEAM_LIVE_LIMITS.tokens_out_day, exhausted_at: beam.out_at ? new Date(Number(beam.out_at)).toISOString() : null } : null
      },
      breaker: breaker && Number(breaker.until_ms) > now ? { reason: breaker.reason, until: new Date(Number(breaker.until_ms)).toISOString(), since: breaker.at ?? null } : null,
      rollbacks: Object.entries(rollbacks).map(([k, v]) => ({ role: k.split("|")[0], provider: k.split("|")[1], rolled_back_at: new Date(Number(v.at)).toISOString(), validity: v.validity, timeout_share: v.timeout_share, calls: v.calls, telegram_sent_at: v.telegram_sent_at ?? null, cleared: !rollbackStands(v, lastOnOf[routerGroupOf(k.split("|")[0])] ?? null) })),
      council: { switch_on_at: switchAt ? new Date(switchAt).toISOString() : null, today: await councilCounts(day0, now + 1), before_switch_7d: await councilCounts(ref - 7 * 86_400_000, ref) }
    };
  } catch (error) {
    return { ...out, error: clip(error?.message ?? error, 200) };
  }
}

/** The news Reasoner's answer as the router accepts it: one JSON object with a known recommendation (else a reason). */
export const NEWS_RECOMMENDATIONS = Object.freeze(["BULLISH_BIAS", "BEARISH_BIAS", "NEUTRAL", "WAIT_FOR_TECHNICAL_CONFIRMATION"]);
export function newsReasonerCheck(obj) {
  return NEWS_RECOMMENDATIONS.includes(String(obj?.recommendation ?? "").toUpperCase()) ? null : "recommendation";
}
