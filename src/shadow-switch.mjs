// The shadow kill switch (owner 2026-11-14: "berikan kill switch untuk mode shadow jika ternyata biaya
// membengkak"). One switch for every shadow path that calls a model:
//   - the metric-format arm (src/metric-shadow.mjs),
//   - the learned notes under test (src/shadow-knowledge.mjs: the 15m War Room, the 1H room, the council),
//   - a benched agent's answer beside its room on every fourth bar (src/agent-allocation.mjs),
//   - the model arena's challenger on the council and the 15m conclusion (src/model-arena.mjs), which also
//     stops for the day at its own cap and once all shadow spend reaches 80% of this budget.
// Off, none of them calls a model; the live rooms and the decision are untouched. A benched agent then stays
// benched and its record stops moving until the switch is on again.
//
// Two ways to turn it off:
//   - the owner, through Omega (Cloudflare Access, a person and a reason), audited in D1 shadow_switch_events
//     and sent to Telegram, like the MT5 fallback switch (src/feed.mjs);
//   - the cost breaker, hourly in the sweep: when today's shadow calls (UTC day, every row metered as
//     "shadow:<schema name>" in ai_usage_daily) pass SHADOW_NEURONS_PER_DAY_MAX neurons (default 25,000), it
//     turns the switch off itself and tells the owner. It stays off until the owner turns it on again.
// `SHADOW_MODE` "off" (a Worker variable) holds it off whatever the switch says.
import { neuronsOf, ensureAiUsageSchema, FREE_NEURONS_PER_DAY, USD_PER_1K_NEURONS } from "./ai-usage.mjs";

export const SHADOW_SWITCH_KEY = "shadow-mode:switch:v1";
export const SHADOW_MODES = Object.freeze(["on", "off"]);
export const SHADOW_METER_PREFIX = "shadow:";
/** Today's shadow neurons above which the breaker turns shadow off (about USD 0.28 a day at the paid rate). */
export const DEFAULT_SHADOW_NEURONS_PER_DAY = 25_000;
export const BREAKER_ACTOR = "cost-breaker";

const EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS shadow_switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, mode TEXT NOT NULL, previous_mode TEXT, reason TEXT NOT NULL, actor TEXT NOT NULL)`;
const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

export function shadowBudget(env) {
  const n = Number(env?.SHADOW_NEURONS_PER_DAY_MAX ?? DEFAULT_SHADOW_NEURONS_PER_DAY);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHADOW_NEURONS_PER_DAY;
}
const envOff = (env) => String(env?.SHADOW_MODE ?? "").trim().toLowerCase() === "off";

async function readSwitch(env) {
  try {
    const r = JSON.parse((await env?.SIGNAL_CACHE?.get?.(SHADOW_SWITCH_KEY)) || "null");
    return r && SHADOW_MODES.includes(r.mode) ? r : null;
  } catch { return null; }
}

/** Whether shadow paths may call a model now. Read fresh on each room run (one KV read); never throws. */
export async function shadowAllowed(env) {
  if (envOff(env)) return false;
  return (await readSwitch(env))?.mode !== "off";
}

/** A room's roster split (src/agent-allocation.mjs rosterSplit) with no shadow turn while shadow is off. */
export async function gateShadowTurns(env, allocation) {
  if (!allocation?.shadow?.length || (await shadowAllowed(env))) return allocation;
  return { ...allocation, shadow: [], shadow_off: true };
}

/** Today's (UTC) shadow spend from the meter: neurons, by source and in all. Never throws. */
export async function shadowSpendToday(db, { now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await ensureAiUsageSchema(db);
    const rows = (await db.prepare("SELECT source, model, SUM(calls) AS calls, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source >= 'shadow:' AND source < 'shadow;' GROUP BY source, model").bind(day).all()).results || [];
    const bySource = {};
    let neurons = 0, calls = 0, unpriced = 0;
    for (const r of rows) {
      const n = neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0);
      const s = bySource[r.source] || { calls: 0, neurons: 0 };
      s.calls += Number(r.calls) || 0;
      calls += Number(r.calls) || 0;
      if (n == null) unpriced += (Number(r.p) || 0) + (Number(r.c) || 0);
      else { s.neurons += n; neurons += n; }
      bySource[r.source] = s;
    }
    for (const s of Object.values(bySource)) s.neurons = Math.round(s.neurons);
    return { day, calls, neurons: Math.round(neurons), unpriced_tokens: unpriced, by_source: bySource };
  } catch {
    return { day, calls: 0, neurons: 0, unpriced_tokens: 0, by_source: {}, error: "meter_unavailable" };
  }
}

/** The switch, today's shadow spend against the budget, and the last changes (GET /omega/api/shadow-mode). */
export async function readShadowMode(env, { now = Date.now() } = {}) {
  const sw = await readSwitch(env);
  const spend = env?.DB ? await shadowSpendToday(env.DB, { now }) : null;
  let events = [];
  try {
    await env.DB.prepare(EVENTS_SCHEMA).run();
    events = (await env.DB.prepare("SELECT at, mode, previous_mode, reason, actor FROM shadow_switch_events ORDER BY id DESC LIMIT 10").all())?.results || [];
  } catch { events = []; }
  const budget = shadowBudget(env);
  return {
    mode: sw?.mode ?? "on", mode_source: sw ? (sw.actor === BREAKER_ACTOR ? "breaker" : "owner") : "default",
    held_off_by_variable: envOff(env), allowed: !envOff(env) && sw?.mode !== "off",
    set_at: sw?.at ?? null, set_by: sw?.actor ?? null, reason: sw?.reason ?? null,
    budget_neurons_per_day: budget,
    // A rough price of the shadow neurons alone, as if the day's free allowance were already spent.
    spend_today: spend ? { ...spend, share_of_budget: Math.round((spend.neurons / budget) * 1000) / 1000, usd_at_paid_rate: Math.round(spend.neurons * USD_PER_1K_NEURONS / 10) / 100 } : null,
    free_neurons_per_day: FREE_NEURONS_PER_DAY,
    events
  };
}

/** A change of the switch: a mode, a reason, who. Audited; returns the new state. */
export async function setShadowMode(env, { mode, reason = "", actor = "" } = {}, { now = Date.now() } = {}) {
  if (!SHADOW_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${SHADOW_MODES.join(", ")}` };
  const who = clip(actor, 200), why = clip(reason, 200);
  if (!who) return { ok: false, error: "actor is required" };
  if (!why) return { ok: false, error: "a reason is required" };
  if (!env?.SIGNAL_CACHE?.put) return { ok: false, error: "kv_unavailable" };
  const previous = (await readSwitch(env))?.mode ?? "on";
  const record = { mode, reason: why, actor: who, at: new Date(now).toISOString() };
  await env.SIGNAL_CACHE.put(SHADOW_SWITCH_KEY, JSON.stringify(record));
  try {
    await env.DB.prepare(EVENTS_SCHEMA).run();
    await env.DB.prepare("INSERT INTO shadow_switch_events (at, mode, previous_mode, reason, actor) VALUES (?, ?, ?, ?, ?)").bind(record.at, mode, previous, why, who).run();
  } catch (error) {
    console.error("shadow_switch_audit_failed", error instanceof Error ? error.message : String(error));
  }
  return { ok: true, mode, previous_mode: previous, changed: previous !== mode, at: record.at };
}

/** The Telegram line of a change. */
export function shadowModeMessage(result, { reason = "", spend = null, budget = null } = {}) {
  const on = result.mode === "on";
  if (!on && spend != null) return `XAUUSD SYSTEM · Shadow mode switched OFF by the cost breaker: today's shadow calls reached ${Math.round(spend).toLocaleString("en-US")} neurons (budget ${Math.round(budget).toLocaleString("en-US")}). Live rooms and decisions go on; no shadow call runs until you switch it on again (Nexus, Neuron allocation).`;
  return `XAUUSD SYSTEM · Shadow mode switched ${on ? "ON" : "OFF"} by the owner (${String(reason).slice(0, 160)}). ${on ? "The shadow arms (metric format, notes under test, benched agents) call their models again." : "No shadow call runs; live rooms and decisions go on, and benched agents stay benched with their record paused."}`;
}

/** Hourly in the sweep: turns shadow off once today's shadow neurons pass the budget. Never throws. */
export async function checkShadowBudget(env, { now = Date.now(), send = null } = {}) {
  try {
    if (!env?.DB || !(await shadowAllowed(env))) return { status: "off" };
    const spend = await shadowSpendToday(env.DB, { now });
    const budget = shadowBudget(env);
    if (spend.neurons <= budget) return { status: "within_budget", neurons: spend.neurons, budget };
    const result = await setShadowMode(env, { mode: "off", reason: `today's shadow calls reached ${spend.neurons} neurons, budget ${budget}`, actor: BREAKER_ACTOR }, { now });
    if (result.ok && result.changed && send) {
      try { await send(shadowModeMessage(result, { spend: spend.neurons, budget })); } catch (e) { console.error("shadow_breaker_telegram_failed", e instanceof Error ? e.message : String(e)); }
    }
    return { status: result.ok ? "tripped" : "trip_failed", neurons: spend.neurons, budget, by_source: spend.by_source, ...(result.ok ? {} : { error: result.error }) };
  } catch (e) {
    return { status: "error", error: String(e?.message ?? e).slice(0, 200) };
  }
}
