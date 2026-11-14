// AI Neuron B, the model arena (owner 2026-11-14: "lanjut B"). It runs in shadow and changes nothing live.
// On a sample of 15m bars, the two heavy steps that run on the moderator model are asked again, with the
// same messages, of a challenger model:
//   - the Decision Engine's council (decision_council). Its answer goes through the same guardrails
//     (decide) as the live answer, so both stances are compared like for like;
//   - the 15m War Room's conclusion (war_room_conclusion), checked by the room's own validation.
// Each answer is stored beside the live one, in model_arena_outputs. The live side is the stance that was
// decided on that bar, its model, status and latency. Both stances are then scored on the same 15m
// outcome. The comparison covers validity at the first try, agreement, hit rate, latency, tokens and
// neurons. Nothing here reaches a room, the council or a decision: the challenger is used live only if the
// owner decides so, after the record is in.
//
// Cost, so that the arena cannot crowd out the other shadow arms:
//   - only every ARENA_EVERY-th 15m bar (default 8, about one every two hours), offset from the metric
//     rebuttal bars;
//   - its own daily cap, ARENA_NEURONS_PER_DAY_MAX (default 6,000), counted from the meter
//     ("shadow:arena:<schema>");
//   - it stops for the day once all shadow spend reaches ARENA_SHADOW_SHARE (80%) of the kill switch's budget,
//     so it never trips the breaker by itself;
//   - one call per step, with no correction or retry, at reasoning effort "low";
//   - the shadow kill switch (src/shadow-switch.mjs) and MODEL_ARENA "off" turn it off.
import { runModel } from "./model-text.mjs";
import { parseModelObject, affinityId } from "./multi-agent-bus.mjs";
import { usageSplit, neuronsOf, NEURON_RATES } from "./ai-usage.mjs";
import { shadowAllowed, shadowSpendToday, shadowBudget, SHADOW_METER_PREFIX } from "./shadow-switch.mjs";
import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";

export const ARENA_VERSION = "model-arena-v1";
export const ARENA_DEFAULT_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const ARENA_DEFAULT_EVERY = 8;
// The arena's bars fall between the metric rebuttal bars (index % 4 === 0): index % 8 === 2.
export const ARENA_BAR_OFFSET = 2;
export const ARENA_DEFAULT_NEURONS_PER_DAY = 6_000;
export const ARENA_SHADOW_SHARE = 0.8;
export const ARENA_CALL_TIMEOUT_MS = 90_000;
export const ARENA_ROLES = Object.freeze(["decision_council", "war_room_conclusion"]);
export const ARENA_METER_PREFIX = `${SHADOW_METER_PREFIX}arena:`;
/** The live sources of each role in the usage meter, for the live side's neurons per call. */
const LIVE_SOURCES = Object.freeze({ decision_council: "decision_council", war_room_conclusion: "war_room_conclusion" });
/** Scored pairs per role before the record is read as more than noise. */
export const ARENA_MIN_PAIRS = 60;
const STANCES = new Set(["BUY", "SELL", "WAIT"]);

export const ARENA_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS model_arena_outputs (
  role TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  statement_close TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  status TEXT NOT NULL,
  errors TEXT,
  stance TEXT,
  confidence REAL,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  live_model TEXT,
  live_status TEXT,
  live_stance TEXT,
  live_latency_ms INTEGER,
  result TEXT,
  live_result TEXT,
  scoring_version TEXT,
  scored_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (role, candle_key)
)`;
let ready = false;
export function resetModelArenaSchemaForTests() { ready = false; }
async function ensureSchema(db) {
  if (ready) return;
  await db.prepare(ARENA_SCHEMA_SQL).run();
  ready = true;
}

const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const posInt = (x, d) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : d);

export function arenaEnabled(env) { return String(env?.MODEL_ARENA ?? "").trim().toLowerCase() !== "off"; }
export function arenaModel(env) { return clip(env?.ARENA_MODEL, 120) || ARENA_DEFAULT_MODEL; }
export function arenaEvery(env) { return Math.min(96, posInt(env?.ARENA_EVERY, ARENA_DEFAULT_EVERY)); }
export function arenaDailyCap(env) { return posInt(env?.ARENA_NEURONS_PER_DAY_MAX, ARENA_DEFAULT_NEURONS_PER_DAY); }
export function arenaEffort(env) {
  const e = String(env?.ARENA_REASONING_EFFORT ?? "").trim().toLowerCase();
  return ["none", "low", "high", "max"].includes(e) ? e : "low";
}

/** Whether the arena samples the 15m bar that closed at `barTime`. */
export function isArenaBar(barTime, every = ARENA_DEFAULT_EVERY) {
  const index = Math.floor(Date.parse(barTime) / 900_000);
  if (!Number.isFinite(index)) return false;
  return every <= 1 || index % every === ARENA_BAR_OFFSET % every;
}

/** Today's arena neurons and all shadow neurons, from the meter. */
export async function arenaSpendToday(db, { now = Date.now() } = {}) {
  const spend = await shadowSpendToday(db, { now });
  const arena = Object.entries(spend.by_source || {}).filter(([s]) => s.startsWith(ARENA_METER_PREFIX)).reduce((n, [, v]) => n + (Number(v.neurons) || 0), 0);
  return { arena, shadow: Number(spend.neurons) || 0, error: spend.error ?? null };
}

/** Why the arena would not call now, or null. Pure over its inputs. */
export function arenaGate({ enabled, allowed, sampled, arenaNeurons, shadowNeurons, cap, budget, meterError = null }) {
  if (!enabled) return "disabled";
  if (!allowed) return "shadow_off";
  if (!sampled) return "not_an_arena_bar";
  if (meterError) return "meter_unavailable";
  if (arenaNeurons >= cap) return "arena_cap_reached";
  if (shadowNeurons >= ARENA_SHADOW_SHARE * budget) return "shadow_budget_headroom";
  return null;
}

/**
 * One challenger call beside a live step. `live` is { model, status, stance, latency_ms } of the live step on
 * this bar (status "ok" at the first try, "ok_after_retry" after a correction, retry or fallback, else why not); `validate(obj)` is the live step's own check; `toStance(obj)` maps a valid answer to the stance
 * that is compared (the council's through the guardrails). Never throws.
 */
export async function runArenaCall(env, { role, candleKey, statementClose, messages, schemaName = role, schema = null, maxTokens = 4096, validate, toStance = (o) => o?.stance, live = {}, clock = () => Date.now(), timeoutMs = ARENA_CALL_TIMEOUT_MS } = {}) {
  try {
    if (!ARENA_ROLES.includes(role)) return { status: "unknown_role" };
    if (!env?.DB || !env?.AI) return { status: "unavailable" };
    const allowed = arenaEnabled(env) ? await shadowAllowed(env) : false;
    const spend = allowed ? await arenaSpendToday(env.DB, { now: clock() }) : { arena: 0, shadow: 0, error: null };
    const gate = arenaGate({ enabled: arenaEnabled(env), allowed, sampled: isArenaBar(statementClose, arenaEvery(env)), arenaNeurons: spend.arena, shadowNeurons: spend.shadow, cap: arenaDailyCap(env), budget: shadowBudget(env), meterError: spend.error });
    if (gate) return { status: gate, ...(gate === "arena_cap_reached" || gate === "shadow_budget_headroom" ? { arena_neurons: spend.arena, shadow_neurons: spend.shadow } : {}) };
    await ensureSchema(env.DB);
    if (await env.DB.prepare("SELECT 1 AS x FROM model_arena_outputs WHERE role = ? AND candle_key = ?").bind(role, candleKey).first()) return { status: "already_done" };
    const model = arenaModel(env), effort = arenaEffort(env);
    const row = { status: "agent_failed", errors: null, stance: null, confidence: null, latency_ms: null, prompt: null, completion: null, cached: null };
    const t0 = clock();
    let timer;
    try {
      const call = runModel(env.AI, model, { messages, schemaName, schema, effort, maxTokens, meter: { db: env.DB, source: `${ARENA_METER_PREFIX}${schemaName}` }, affinity: affinityId(env, `arena:${schemaName}`) });
      const { result } = await Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("arena_call_timeout"), { name: "TimeoutError" })), timeoutMs); })]);
      row.latency_ms = clock() - t0;
      const u = usageSplit(result);
      Object.assign(row, { prompt: u.prompt, completion: u.completion, cached: u.cached });
      const parsed = parseModelObject(result);
      if (parsed.truncated) Object.assign(row, { status: "invalid_output", errors: "answer_cut_off" });
      else {
        const obj = parsed.obj && typeof parsed.obj === "object" ? { ...parsed.obj } : null;
        const v = obj ? validate(obj) : { valid: false, errors: ["unparseable"] };
        if (v.valid) {
          const stance = toStance(obj);
          Object.assign(row, { status: "ok", stance: STANCES.has(stance) ? stance : null, confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : null });
        } else Object.assign(row, { status: "invalid_output", errors: clip((v.errors || []).slice(0, 6).join(", "), 300) });
      }
    } catch (error) {
      row.latency_ms = clock() - t0;
      Object.assign(row, { status: error?.name === "TimeoutError" ? "timeout" : "agent_failed", errors: clip(error?.message ?? error, 300) });
    } finally { clearTimeout(timer); }
    await env.DB.prepare(
      "INSERT INTO model_arena_outputs (role, candle_key, statement_close, model, effort, status, errors, stance, confidence, latency_ms, prompt_tokens, completion_tokens, cached_tokens, live_model, live_status, live_stance, live_latency_ms, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(role, candle_key) DO NOTHING"
    ).bind(role, candleKey, statementClose, model, effort, row.status, row.errors, row.stance, row.confidence, row.latency_ms, row.prompt, row.completion, row.cached,
      live.model ?? null, live.status ?? null, STANCES.has(live.stance) ? live.stance : null, Number.isFinite(Number(live.latency_ms)) ? Math.round(Number(live.latency_ms)) : null, new Date(clock()).toISOString()).run();
    return { status: row.status, model, role, stance: row.stance, live_stance: live.stance ?? null, latency_ms: row.latency_ms };
  } catch (error) {
    return { status: "error", message: clip(error?.message ?? error, 200) };
  }
}

/** Sweep step: scores both stances of each stored pair on the 15m bars once the horizon has closed. */
export async function scoreModelArena(env, { now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  const pending = (await env.DB.prepare("SELECT role, candle_key, statement_close, stance, live_stance FROM model_arena_outputs WHERE status = 'ok' AND stance IS NOT NULL AND live_stance IS NOT NULL AND scored_at IS NULL ORDER BY statement_close LIMIT 200").all()).results || [];
  if (!pending.length) return { status: "ok", scored: 0 };
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|15m")) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time && Date.parse(c.close_time) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const final = (r) => (["pending", "no_data", "not_scored"].includes(r) ? null : r);
  const at = new Date(now).toISOString();
  let scored = 0;
  for (const r of pending) {
    const closeMs = Date.parse(r.statement_close);
    const mine = final(scoreStance({ stance: r.stance, bars, closeMs }).result);
    const theirs = final(scoreStance({ stance: r.live_stance, bars, closeMs }).result);
    if (!mine || !theirs) continue;
    await env.DB.prepare("UPDATE model_arena_outputs SET result = ?, live_result = ?, scoring_version = ?, scored_at = ? WHERE role = ? AND candle_key = ?").bind(mine, theirs, SCORING_VERSION, at, r.role, r.candle_key).run();
    scored += 1;
  }
  return { status: "ok", scored };
}

/** Sweep step: drops arena rows older than 90 days. */
export async function pruneModelArena(env, { now = Date.now(), days = 90 } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  await env.DB.prepare("DELETE FROM model_arena_outputs WHERE statement_close < ?").bind(new Date(now - days * 86_400_000).toISOString()).run();
  return { status: "ok" };
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
// A WAIT that let a 2:1 trade go by (missed_opportunity) counts against it here: the council mostly waits.
const hitRate = (results) => {
  const decided = results.filter((r) => r === "hit" || r === "miss" || r === "missed_opportunity");
  return { rate: decided.length ? round(decided.filter((r) => r === "hit").length / decided.length) : null, decided: decided.length };
};

/**
 * Pure: the comparison per role from arena rows and the usage meter's rows (ai_usage_daily of the window).
 * Neurons per call: the challenger's from its own tokens; the live model's from its day rows of the same source.
 */
export function compareModelArena(rows = [], usageRows = [], { cap = ARENA_DEFAULT_NEURONS_PER_DAY, every = ARENA_DEFAULT_EVERY, model = ARENA_DEFAULT_MODEL, spentToday = null } = {}) {
  const roles = ARENA_ROLES.map((role) => {
    const mine = rows.filter((r) => r.role === role);
    const ok = mine.filter((r) => r.status === "ok");
    const withLive = ok.filter((r) => r.live_stance);
    const liveOk = mine.filter((r) => r.live_status != null);
    const scored = mine.filter((r) => r.result && r.live_result);
    const a = hitRate(scored.map((r) => r.result)), b = hitRate(scored.map((r) => r.live_result));
    const priced = mine.filter((r) => Number(r.prompt_tokens) > 0);
    const neurons = priced.map((r) => neuronsOf(r.model, Number(r.prompt_tokens) || 0, Number(r.completion_tokens) || 0, Number(r.cached_tokens) || 0)).filter((n) => n != null);
    const live = usageRows.filter((u) => u.source === LIVE_SOURCES[role] && NEURON_RATES[u.model]);
    const liveCalls = live.reduce((n, u) => n + (Number(u.calls) || 0), 0);
    const liveNeurons = live.reduce((n, u) => n + (neuronsOf(u.model, Number(u.prompt_tokens) || 0, Number(u.completion_tokens) || 0) || 0), 0);
    const liveTokens = live.reduce((n, u) => n + (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0), 0);
    return {
      role,
      calls: mine.length,
      validity: mine.length ? round(ok.length / mine.length) : null,
      // The live step may correct, retry or fall back; the challenger gets one call. Both at the first try, and
      // the live step's share answered at all.
      live_validity: liveOk.length ? round(liveOk.filter((r) => r.live_status === "ok").length / liveOk.length) : null,
      live_answered: liveOk.length ? round(liveOk.filter((r) => String(r.live_status).startsWith("ok")).length / liveOk.length) : null,
      failures: Object.fromEntries([...new Set(mine.filter((r) => r.status !== "ok").map((r) => r.status))].map((s) => [s, mine.filter((r) => r.status === s).length])),
      stance_agreement: withLive.length ? round(withLive.filter((r) => r.stance === r.live_stance).length / withLive.length) : null,
      compared: withLive.length,
      scored_pairs: scored.length,
      hit_rate: a.rate, decided: a.decided,
      live_hit_rate: b.rate, live_decided: b.decided,
      latency_ms: median(ok.map((r) => Number(r.latency_ms))),
      live_latency_ms: median(withLive.map((r) => Number(r.live_latency_ms))),
      tokens_per_call: priced.length ? Math.round(priced.reduce((n, r) => n + (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0), 0) / priced.length) : null,
      cached_share: priced.length ? round(priced.reduce((n, r) => n + (Number(r.cached_tokens) || 0), 0) / Math.max(1, priced.reduce((n, r) => n + (Number(r.prompt_tokens) || 0), 0))) : null,
      live_tokens_per_call: liveCalls ? Math.round(liveTokens / liveCalls) : null,
      neurons_per_call: neurons.length ? Math.round(neurons.reduce((n, x) => n + x, 0) / neurons.length) : null,
      live_neurons_per_call: liveCalls ? Math.round(liveNeurons / liveCalls) : null,
      verdict: scored.length < ARENA_MIN_PAIRS ? "collecting" : "ready for owner review"
    };
  });
  return {
    version: ARENA_VERSION, challenger: model, every_nth_bar: every, neurons_per_day_cap: cap, shadow_share: ARENA_SHADOW_SHARE, min_pairs: ARENA_MIN_PAIRS,
    spent_today: spentToday, roles
  };
}

/** Read model (GET /api/model-arena and the neuron allocation page). */
export async function readModelArena(env, { days = 14, now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const n = Math.min(90, Math.max(1, Math.round(Number(days) || 14)));
  const since = new Date(now - n * 86_400_000).toISOString();
  const rows = (await env.DB.prepare("SELECT role, candle_key, statement_close, model, status, stance, confidence, latency_ms, prompt_tokens, completion_tokens, cached_tokens, live_model, live_status, live_stance, live_latency_ms, result, live_result FROM model_arena_outputs WHERE statement_close >= ?").bind(since).all()).results || [];
  const day = since.slice(0, 10);
  let usageRows = [];
  try { usageRows = (await env.DB.prepare("SELECT source, model, SUM(calls) AS calls, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens FROM ai_usage_daily WHERE day >= ? AND source IN ('decision_council', 'war_room_conclusion') GROUP BY source, model").bind(day).all()).results || []; } catch { usageRows = []; }
  const spend = await arenaSpendToday(env.DB, { now });
  return { enabled: arenaEnabled(env), window_days: n, ...compareModelArena(rows, usageRows, { cap: arenaDailyCap(env), every: arenaEvery(env), model: arenaModel(env), spentToday: { arena_neurons: spend.arena, shadow_neurons: spend.shadow, shadow_budget: shadowBudget(env) } }) };
}
