// CL1 PR1 (2026-11-28, owner via the orchestrator: cut Workers AI neurons with a Claude API credit; shadow first): the
// same input as three live callers (decision_council, war_room_conclusion, h1_reasoner) goes to Claude Haiku 5.5 once,
// after the live answer is stored, and its answer is recorded beside the live one: valid or not, the stance it implies,
// whether it agrees, its tokens and its USD. Nothing reads the shadow answer but the comparison; the live result never
// changes. Guards before every call: the owner's FS1 switch CLAUDE_SHADOW ("shadow"; default off), the shadow kill
// switch, the Worker secret ANTHROPIC_API_KEY (none: no call), a hard daily cap in USD read from ai_usage_daily, and a
// breaker (402 / 401 / 403 / billing: until the next UTC day; 429: an hour; three timeouts in a row: an hour).
import Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage, ensureAiUsageSchema } from "./ai-usage.mjs";
import { shadowAllowed } from "./shadow-switch.mjs";

export const CLAUDE_SHADOW_VERSION = "claude-shadow-v1";
export const CLAUDE_MODEL = "claude-haiku-5-5";
/** The model as the meter (ai_usage_daily.model) and the comparison table name it. */
export const CLAUDE_METER_MODEL = `anthropic:${CLAUDE_MODEL}`;
/** The meter's source prefix: not "shadow:", so the Workers AI neuron budget of the shadow arms is untouched. */
export const CLAUDE_METER_PREFIX = "claude:";
/**
 * USD per million tokens for Claude Haiku 5.5 (Anthropic first-party rates): prompts of 100K tokens or fewer, and the
 * longer card. Cache reads are 0.1x the input rate, 5-minute cache writes 1.25x.
 */
export const CLAUDE_USD_PER_M = Object.freeze({
  short: Object.freeze({ input: 0.10, output: 0.50, cache_read: 0.01, cache_write: 0.125 }),
  long: Object.freeze({ input: 0.50, output: 2.50, cache_read: 0.05, cache_write: 0.625 })
});
export const CLAUDE_LONG_PROMPT_TOKENS = 100_000;
/** The hard daily cap (owner budget, the orchestrator's CL1 brief): CLAUDE_SHADOW_USD_PER_DAY may lower it, never raise it. */
export const CLAUDE_DAILY_CAP_USD = 0.55;
export const CLAUDE_TIMEOUT_MS = 45_000;
export const CLAUDE_TIMEOUTS_TO_TRIP = 3;
export const CLAUDE_BREAKER_KEY = "claude-shadow:breaker:v1";
const HOUR = 3_600_000;

/**
 * The roles in shadow and how each is asked. The 120b roles (moderator, conclusion, reasoner) think adaptively at low
 * effort; the seat roles (gemma's, not in PR1) run with thinking off at low effort.
 */
export const CLAUDE_ROLES = Object.freeze({
  decision_council: Object.freeze({ thinking: "adaptive", effort: "low", maxTokens: 8000, json: true }),
  war_room_conclusion: Object.freeze({ thinking: "adaptive", effort: "low", maxTokens: 6000, json: true }),
  h1_reasoner: Object.freeze({ thinking: "adaptive", effort: "low", maxTokens: 8000, json: false })
});

export const CLAUDE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS claude_shadow_outputs (
  role TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  statement_close TEXT,
  model TEXT NOT NULL,
  thinking TEXT,
  effort TEXT,
  status TEXT NOT NULL,
  errors TEXT,
  stop_reason TEXT,
  stance TEXT,
  live_stance TEXT,
  agree INTEGER,
  confidence REAL,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  usd_micros INTEGER,
  live_model TEXT,
  live_status TEXT,
  live_latency_ms INTEGER,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (role, candle_key)
)`;

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const int = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextUtcDay = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

let ready = false;
export function resetClaudeShadowSchemaForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  await db.prepare(CLAUDE_SCHEMA_SQL).run();
  ready = true;
}

/** Pure: "shadow" when the owner's switch says so (FS1 CLAUDE_SHADOW), else "off". */
export function claudeShadowMode(env) {
  const v = String(env?.CLAUDE_SHADOW ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}
export const claudeShadowEnabled = (env) => claudeShadowMode(env) === "shadow";

/** Pure: the day's cap in USD, never above CLAUDE_DAILY_CAP_USD. */
export function claudeDailyCap(env) {
  const v = Number(env?.CLAUDE_SHADOW_USD_PER_DAY);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, CLAUDE_DAILY_CAP_USD) : CLAUDE_DAILY_CAP_USD;
}

/** Pure: USD of one response's usage, in micro-dollars (the card by the prompt's full size). */
export function claudeUsdMicros({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const prompt = int(input) + int(cacheRead) + int(cacheWrite);
  const r = prompt > CLAUDE_LONG_PROMPT_TOKENS ? CLAUDE_USD_PER_M.long : CLAUDE_USD_PER_M.short;
  return Math.round(int(input) * r.input + int(output) * r.output + int(cacheRead) * r.cache_read + int(cacheWrite) * r.cache_write);
}

/**
 * Pure: a Workers AI chat request as a Messages API request. The system messages join into one system block, marked for
 * the prompt cache (the stable part); the rest keep their order, user first.
 */
export function toClaudeRequest(messages) {
  const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : String(c ?? ""));
  const list = Array.isArray(messages) ? messages : [];
  const system = list.filter((m) => m?.role === "system").map((m) => text(m.content)).filter(Boolean).join("\n\n");
  const turns = list.filter((m) => m?.role === "user" || m?.role === "assistant").map((m) => ({ role: m.role, content: text(m.content) })).filter((m) => m.content);
  while (turns.length && turns[0].role !== "user") turns.shift();
  return { system: system ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : undefined, messages: turns };
}

/**
 * Pure: a JSON schema in the structured-outputs subset: every object closed (additionalProperties false), and the
 * numeric, string-length and array-size constraints the API does not take removed (the live validator still checks).
 */
export function claudeSchema(schema) {
  const DROP = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern"]);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) if (!DROP.has(k)) out[k] = k === "properties" ? Object.fromEntries(Object.entries(v || {}).map(([p, s]) => [p, walk(s)])) : walk(v);
    if (out.type === "object") out.additionalProperties = false;
    return out;
  };
  return walk(schema);
}

/** The breaker's state (KV), or null. Never throws. */
export async function readClaudeBreaker(env) {
  try { const raw = await env?.SIGNAL_CACHE?.get?.(CLAUDE_BREAKER_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function writeBreaker(env, state) {
  try { await env?.SIGNAL_CACHE?.put?.(CLAUDE_BREAKER_KEY, JSON.stringify(state), { expirationTtl: 3 * 86_400 }); } catch { /* best effort */ }
}

/** Pure: what an error from the Messages API means for the breaker. */
export function classifyClaudeError(error) {
  const status = Number(error?.status);
  const type = String(error?.error?.error?.type ?? error?.type ?? "");
  if (error instanceof Anthropic.APIConnectionTimeoutError || error?.name === "TimeoutError") return { outcome: "timeout", trip: null };
  if (status === 402 || type === "billing_error") return { outcome: "failed", trip: "billing" };
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return { outcome: "failed", trip: "auth" };
  if (status === 429 || type === "rate_limit_error") return { outcome: "failed", trip: "rate_limited" };
  return { outcome: "failed", trip: null };
}

/** Today's (UTC) Claude spend in USD from the meter. Never throws: an unreadable meter counts as the cap reached. */
export async function claudeSpendToday(db, { now = Date.now() } = {}) {
  try {
    await ensureAiUsageSchema(db);
    const r = await db.prepare("SELECT COALESCE(SUM(usd_micros), 0) AS u, COALESCE(SUM(calls), 0) AS calls FROM ai_usage_daily WHERE day = ? AND model = ?").bind(dayOf(now), CLAUDE_METER_MODEL).first();
    return { usd: (Number(r?.u) || 0) / 1e6, calls: Number(r?.calls) || 0, error: null };
  } catch (e) {
    return { usd: Infinity, calls: 0, error: clip(e?.message ?? e, 120) };
  }
}

/**
 * Pure: why a call must not run, or null. Order: switch, kill switch, key, breaker, cap.
 */
export function claudeGate({ enabled, allowed, hasKey, breaker, spentUsd, cap, now }) {
  if (!enabled) return "claude_shadow_off";
  if (!allowed) return "shadow_off";
  if (!hasKey) return "no_key";
  if (breaker && Number(breaker.until_ms) > now) return `breaker_${breaker.reason || "open"}`;
  if (!(spentUsd < cap)) return "cap_reached";
  return null;
}

/**
 * One shadow call for a role, after the live answer is stored. `validate(objOrText)` -> { valid, errors } is the live
 * call's own check; `toStance(objOrText)` the stance it implies (the council: after the guardrails). Never throws; never
 * touches the live result. `client` is injectable (tests: an Anthropic client with a stub fetch).
 */
export async function runClaudeShadow(env, { role, candleKey, statementClose = null, messages, schema = null, validate = () => ({ valid: true }), toStance = (o) => o?.stance, live = {}, clock = () => Date.now(), client = null, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  try {
    const cfg = CLAUDE_ROLES[role];
    if (!cfg) return { status: "unknown_role" };
    if (!env?.DB) return { status: "unavailable" };
    const now = clock();
    const enabled = claudeShadowEnabled(env);
    const allowed = enabled ? await shadowAllowed(env) : false;
    const hasKey = Boolean(String(env?.ANTHROPIC_API_KEY ?? "").trim()) || Boolean(client);
    const breaker = enabled && allowed && hasKey ? await readClaudeBreaker(env) : null;
    const spend = enabled && allowed && hasKey ? await claudeSpendToday(env.DB, { now }) : { usd: 0 };
    const cap = claudeDailyCap(env);
    const gate = claudeGate({ enabled, allowed, hasKey, breaker, spentUsd: spend.usd, cap, now });
    if (gate) return { status: gate, ...(gate === "cap_reached" ? { spent_usd: spend.usd, cap_usd: cap } : {}) };
    await ensureSchema(env.DB);
    if (await env.DB.prepare("SELECT 1 AS x FROM claude_shadow_outputs WHERE role = ? AND candle_key = ?").bind(role, candleKey).first()) return { status: "already_done" };

    const req = toClaudeRequest(messages);
    if (!req.messages.length) return { status: "no_input" };
    const api = client ?? new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), maxRetries: 0, timeout: timeoutMs });
    const params = {
      model: CLAUDE_MODEL, max_tokens: cfg.maxTokens, messages: req.messages, ...(req.system ? { system: req.system } : {}),
      thinking: cfg.thinking === "disabled" ? { type: "disabled" } : { type: "adaptive" },
      output_config: { effort: cfg.effort, ...(cfg.json && schema ? { format: { type: "json_schema", schema: claudeSchema(schema) } } : {}) }
    };
    const row = { status: "agent_failed", errors: null, stop_reason: null, stance: null, confidence: null, latency_ms: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    const t0 = clock();
    let outcome = "ok", trip = null;
    try {
      const res = await api.messages.create(params, { timeout: timeoutMs });
      row.latency_ms = clock() - t0;
      const u = res?.usage ?? {};
      Object.assign(row, { input: int(u.input_tokens), output: int(u.output_tokens), cacheRead: int(u.cache_read_input_tokens), cacheWrite: int(u.cache_creation_input_tokens), stop_reason: res?.stop_reason ?? null });
      row.usd = claudeUsdMicros({ input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite });
      // Read by block type: thinking blocks may come first.
      const text = (res?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
      if (res?.stop_reason === "refusal") Object.assign(row, { status: "refusal", errors: clip(res?.stop_details?.category ?? "refusal", 120) });
      else if (res?.stop_reason === "max_tokens") Object.assign(row, { status: "invalid_output", errors: "answer_cut_off" });
      else {
        let answer = text;
        if (cfg.json) { try { answer = JSON.parse(text); } catch { answer = null; } }
        const v = answer == null || answer === "" ? { valid: false, errors: [cfg.json ? "unparseable" : "empty"] } : validate(answer);
        if (v?.valid) {
          const stance = toStance(answer);
          Object.assign(row, { status: "ok", stance: stance == null ? null : clip(stance, 24), confidence: answer && typeof answer === "object" && Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null });
        } else Object.assign(row, { status: "invalid_output", errors: clip((v?.errors || []).slice(0, 6).join(", "), 300) });
      }
    } catch (error) {
      row.latency_ms = clock() - t0;
      const c = classifyClaudeError(error);
      outcome = c.outcome; trip = c.trip;
      Object.assign(row, { status: c.outcome === "timeout" ? "timeout" : "agent_failed", errors: clip(`${error?.status ?? ""} ${error?.message ?? error}`, 300) });
    }
    // The breaker: billing and auth until the next UTC day, a rate limit an hour, three timeouts in a row an hour.
    const prev = breaker ?? {};
    if (trip) await writeBreaker(env, { reason: trip, until_ms: trip === "rate_limited" ? now + HOUR : nextUtcDay(now), at: new Date(now).toISOString(), timeouts: 0 });
    else if (outcome === "timeout") {
      const timeouts = (Number(prev.timeouts) || 0) + 1;
      await writeBreaker(env, timeouts >= CLAUDE_TIMEOUTS_TO_TRIP ? { reason: "timeouts", until_ms: now + HOUR, at: new Date(now).toISOString(), timeouts: 0 } : { ...prev, until_ms: Number(prev.until_ms) || 0, timeouts });
    } else if (Number(prev.timeouts)) await writeBreaker(env, { ...prev, timeouts: 0 });

    await recordAiUsage(env.DB, { source: `${CLAUDE_METER_PREFIX}${role}`, model: CLAUDE_METER_MODEL, outcome: outcome === "ok" ? "ok" : outcome, prompt: row.input + row.cacheRead + row.cacheWrite, completion: row.output, cached: row.cacheRead, cacheWrite: row.cacheWrite, usdMicros: row.usd, now });
    const liveStance = live.stance == null ? null : clip(live.stance, 24);
    const agree = row.status === "ok" && liveStance != null && row.stance != null ? (row.stance === liveStance ? 1 : 0) : null;
    await env.DB.prepare(
      "INSERT INTO claude_shadow_outputs (role, candle_key, statement_close, model, thinking, effort, status, errors, stop_reason, stance, live_stance, agree, confidence, latency_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_micros, live_model, live_status, live_latency_ms, version, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(role, candle_key) DO NOTHING"
    ).bind(role, candleKey, statementClose, CLAUDE_MODEL, cfg.thinking, cfg.effort, row.status, row.errors, row.stop_reason, row.stance, liveStance, agree, row.confidence, row.latency_ms,
      row.input, row.output, row.cacheRead, row.cacheWrite, row.usd, live.model ?? null, live.status ?? null, Number.isFinite(Number(live.latency_ms)) ? Math.round(Number(live.latency_ms)) : null,
      CLAUDE_SHADOW_VERSION, new Date(now).toISOString()).run();
    return { status: row.status, role, stance: row.stance, live_stance: liveStance, agree, usd: row.usd / 1e6, latency_ms: row.latency_ms };
  } catch (error) {
    return { status: "error", message: clip(error?.message ?? error, 200) };
  }
}

/**
 * GET /api/claude-shadow: the switch, the key's presence (never its value), the breaker, today's spend against the cap,
 * and per role over `days`: calls, validity, agreement with the live answer, tokens, USD and latency.
 */
export async function readClaudeShadow(env, { days = 14, now = Date.now() } = {}) {
  const n = Math.min(Math.max(Math.round(Number(days) || 14), 1), 90);
  const out = {
    version: CLAUDE_SHADOW_VERSION, mode: claudeShadowMode(env), model: CLAUDE_MODEL, key_configured: Boolean(String(env?.ANTHROPIC_API_KEY ?? "").trim()),
    cap_usd_per_day: claudeDailyCap(env), rates_usd_per_million: CLAUDE_USD_PER_M, roles: Object.keys(CLAUDE_ROLES), days: n,
    note: "Shadow only: the same input as the live call, after it; nothing reads the answer but this comparison."
  };
  if (!env?.DB) return { ...out, error: "unavailable" };
  try {
    await ensureSchema(env.DB);
    const spend = await claudeSpendToday(env.DB, { now });
    const breaker = await readClaudeBreaker(env);
    const since = new Date(now - (n - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = (await env.DB.prepare(
      "SELECT role, COUNT(*) AS calls, SUM(status = 'ok') AS ok, SUM(status = 'invalid_output') AS invalid, SUM(status = 'refusal') AS refusals, SUM(status = 'timeout') AS timeouts, SUM(status = 'agent_failed') AS failed, " +
      "SUM(agree IS NOT NULL) AS compared, SUM(agree = 1) AS agreed, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens, " +
      "SUM(usd_micros) AS usd_micros, AVG(latency_ms) AS avg_latency_ms, AVG(live_latency_ms) AS avg_live_latency_ms FROM claude_shadow_outputs WHERE substr(created_at, 1, 10) >= ? GROUP BY role ORDER BY role"
    ).bind(since).all()).results ?? [];
    const byRole = rows.map((r) => {
      const calls = Number(r.calls) || 0, ok = Number(r.ok) || 0, compared = Number(r.compared) || 0;
      return {
        role: r.role, calls, ok, invalid: Number(r.invalid) || 0, refusals: Number(r.refusals) || 0, timeouts: Number(r.timeouts) || 0, failed: Number(r.failed) || 0,
        validity_rate: calls ? Math.round((ok / calls) * 1000) / 1000 : null, compared, agreement_rate: compared ? Math.round(((Number(r.agreed) || 0) / compared) * 1000) / 1000 : null,
        input_tokens: Number(r.input_tokens) || 0, output_tokens: Number(r.output_tokens) || 0, cache_read_tokens: Number(r.cache_read_tokens) || 0, cache_write_tokens: Number(r.cache_write_tokens) || 0,
        usd: Math.round(Number(r.usd_micros) || 0) / 1e6, avg_latency_ms: r.avg_latency_ms == null ? null : Math.round(Number(r.avg_latency_ms)), avg_live_latency_ms: r.avg_live_latency_ms == null ? null : Math.round(Number(r.avg_live_latency_ms))
      };
    });
    return {
      ...out,
      today: { day: dayOf(now), usd: Number.isFinite(spend.usd) ? Math.round(spend.usd * 1e6) / 1e6 : null, calls: spend.calls, cap_usd: out.cap_usd_per_day, meter_error: spend.error },
      breaker: breaker && Number(breaker.until_ms) > now ? { reason: breaker.reason, until: new Date(Number(breaker.until_ms)).toISOString() } : null,
      by_role: byRole
    };
  } catch (error) {
    return { ...out, error: clip(error?.message ?? error, 200) };
  }
}
