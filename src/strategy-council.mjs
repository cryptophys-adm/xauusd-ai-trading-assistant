// The strategy council's verdicts and its auto-arm (owner 2026-11-17, relayed: "council boleh langsung arm/disarm
// otomatis jika owner mengaktifkan mode auto"; confirmed in the session: "Setuju, kunci manual permanen").
//
// Once a UTC day, per strategy agent:
//   - walk-forward (deterministic, plan_setups' control arm, oldest 70% / latest 30% by time): `pass` with >= 30
//     setups, mean R >= +0.10, a bootstrap 2.5% bound > 0 and the latest 30% (>= 10 setups) >= 0; `fail` with >= 15
//     setups and a mean R < 0 or the latest 30% (>= 10) < 0; `collecting` otherwise;
//   - a council proposal: arm, keep or disarm, with its reason. One model call per strategy whose deterministic
//     options allow a change (arm only on a walk-forward pass, disarm on a fail or a live revert); the model's answer is
//     clamped to those options, so it can never arm a failing strategy. Metered as "strategy_council", capped per day.
// Both show on the recommendation cards (`verdicts`).
//
// Auto-arm acts only while BOTH hold: the code ceiling STRATEGY_COUNCIL_ARM is "allowed" (a PR sets it once platform
// ADR-0020 Amendment 2 merges; "off" until then) and the owner's toggle (D1 strategy_council_state.auto, flipped in
// Nexus by the owner only) is on. Then: at most 3 armed (setStrategyArm), at most one change per strategy per UTC day,
// no arm on a day the system auto-disarmed (kill switch, daily loss) or while an arm is blocked, never a pinned
// strategy (the owner's manual arm or disarm pins it until the owner unpins it), nothing when the council fails or data
// is short. Every council change is an arm event with actor "council" (and its evidence in strategy_council_runs), one
// Nexus Telegram line, and a strategy_arm.v1 item. Never throws.
import { callBusModel } from "./model-call.mjs";
import { ensureAiUsageSchema, neuronsOf, USD_PER_1K_NEURONS } from "./ai-usage.mjs";
import { CONTROL_ARM, ensurePlanLearningSchema } from "./plan-learning.mjs";
import { ensureStrategyArmSchema, readArmsFromDb, setStrategyArm, ARM_MAX } from "./strategy-arm.mjs";
import { bootstrapLow } from "./grid-adapt.mjs";
import { evRef } from "./cfc-pack.mjs";

export const COUNCIL_METER = "strategy_council";
export const COUNCIL_DAILY_USD = 1;
export const COUNCIL_KEY = "strategy-council:v1";
export const WF = Object.freeze({ pass_setups: 30, pass_mean_r: 0.1, fail_setups: 15, holdout_share: 0.3, holdout_min: 10, learn_days: 90 });
export const LIVE_REVERT_TRADES = 10;
const DAY = 86_400_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const parse = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS strategy_council_state (id INTEGER PRIMARY KEY CHECK (id = 1), auto INTEGER NOT NULL, updated_by TEXT, updated_ms INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO strategy_council_state (id, auto, updated_by, updated_ms) VALUES (1, 0, NULL, 0)",
  "CREATE TABLE IF NOT EXISTS strategy_arm_pins (strategy_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL, pinned_by TEXT, pinned_ms INTEGER NOT NULL, action TEXT)",
  `CREATE TABLE IF NOT EXISTS strategy_council_runs (day TEXT NOT NULL, strategy_id TEXT NOT NULL, proposal TEXT NOT NULL, reason TEXT,
    walk_forward TEXT, applied TEXT, at_ms INTEGER NOT NULL, PRIMARY KEY (day, strategy_id))`,
  // Every click of the owner's toggle (platform ADR-0020 Amendment 2: the same audit as an arm or disarm).
  "CREATE TABLE IF NOT EXISTS strategy_council_toggle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, auto INTEGER NOT NULL, actor TEXT, actor_sub TEXT, ms INTEGER NOT NULL)"
];
let schemaReady = null;
export async function ensureCouncilSchema(db) {
  if (schemaReady === db) return;
  await ensureStrategyArmSchema(db);
  for (const q of SCHEMA_SQL) await db.prepare(q).run();
  schemaReady = db;
}
export function resetCouncilSchemaForTests() { schemaReady = null; }

/** The code ceiling: "allowed" lets the owner's toggle act; anything else keeps the council to proposals. */
export function councilArmCeiling(env) {
  return String(env?.STRATEGY_COUNCIL_ARM ?? "off").trim().toLowerCase() === "allowed" ? "allowed" : "off";
}
export function councilDailyCapUsd(env) {
  const v = Number(env?.STRATEGY_COUNCIL_DAILY_USD ?? COUNCIL_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : COUNCIL_DAILY_USD;
}

/** Pure: the walk-forward of one strategy's setups (oldest first, each { r } of the control arm). */
export function walkForward(rs) {
  const n = rs.length;
  const h = n - Math.max(Math.ceil(n * WF.holdout_share), 0), train = rs.slice(0, h), hold = rs.slice(h);
  const m = mean(rs), mh = mean(hold), low = n ? bootstrapLow(rs) : null;
  const out = { n, mean_r: r3(m), low: r3(low), train_mean_r: r3(mean(train)), holdout_mean_r: r3(mh), holdout_n: hold.length };
  if (n >= WF.pass_setups && m >= WF.pass_mean_r && low > 0 && hold.length >= WF.holdout_min && mh >= 0) return { ...out, status: "pass" };
  if ((n >= WF.fail_setups && m < 0) || (hold.length >= WF.holdout_min && mh < 0)) return { ...out, status: "fail" };
  return { ...out, status: "collecting" };
}

/** Pure: the proposals the facts allow for one strategy. */
export function allowedProposals({ armed, walk, liveBad }) {
  if (armed) return walk.status === "fail" || liveBad ? ["keep", "disarm"] : ["keep"];
  return walk.status === "pass" && !liveBad ? ["keep", "arm"] : ["keep"];
}

export const COUNCIL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["proposal", "reason"],
  properties: { proposal: { type: "string", enum: ["arm", "keep", "disarm"] }, reason: { type: "string", maxLength: 240 } }
});

/** The council's messages for one strategy: facts only, no price. */
export function councilMessages(id, { walk, card, armed, allowed, liveMean }) {
  return [
    { role: "system", content: "You are the strategy council of an XAUUSD trading system. For one strategy agent, decide whether it should be armed (allowed to open positions), kept as it is, or disarmed. Only the proposals listed as allowed are possible. Judge from its measured record only: the walk-forward on its replayed setups (R per setup), its recommendation card, and its live Omega trades. Prefer keep when the evidence is thin. Answer in JSON: proposal and a one-sentence reason." },
    { role: "user", content: JSON.stringify({ strategy: id, currently_armed: armed, allowed_proposals: allowed, walk_forward: walk, live_last_trades_mean_r: liveMean, recommendation: card?.recommendation ? { verdict: card.recommendation.verdict, reason: card.recommendation.reason } : null, record: card?.record ?? null, omega_exits: card?.exits ?? null, executed: card?.executed ?? null }) }
  ];
}

async function councilSpendUsd(db, now) {
  await ensureAiUsageSchema(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source = ? GROUP BY model").bind(day, COUNCIL_METER).all()).results || [];
  let neurons = 0;
  for (const r of rows) neurons += neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0) ?? 0;
  return (neurons / 1000) * USD_PER_1K_NEURONS;
}

/** The council's state for the page and the strategy_arm.v1 digest. */
export async function readCouncilState(env) {
  try {
    await ensureCouncilSchema(env.DB);
    const st = await env.DB.prepare("SELECT auto, updated_by, updated_ms FROM strategy_council_state WHERE id = 1").first();
    const pins = (await env.DB.prepare("SELECT strategy_id, pinned_by, pinned_ms, action FROM strategy_arm_pins WHERE pinned = 1").all()).results ?? [];
    return { ceiling: councilArmCeiling(env), auto: Number(st?.auto) === 1, acting: councilArmCeiling(env) === "allowed" && Number(st?.auto) === 1,
      updated_by: st?.updated_by ?? null, updated_at: st?.updated_ms ? new Date(Number(st.updated_ms)).toISOString() : null,
      pins: pins.map((p) => ({ id: p.strategy_id, by: p.pinned_by, at: new Date(Number(p.pinned_ms)).toISOString(), action: p.action })) };
  } catch (e) { return { ceiling: councilArmCeiling(env), auto: false, acting: false, pins: [], error: String(e?.message ?? e).slice(0, 120) }; }
}

/** The owner's toggle (owner checked by the caller). Turning it on while the ceiling is off is refused. */
export async function setCouncilAuto(env, { on, actor, actor_sub = null, now = Date.now() }) {
  await ensureCouncilSchema(env.DB);
  if (on && councilArmCeiling(env) !== "allowed") return { ok: false, error: "council auto-arm is not allowed (STRATEGY_COUNCIL_ARM is off)" };
  await env.DB.prepare("UPDATE strategy_council_state SET auto = ?, updated_by = ?, updated_ms = ? WHERE id = 1").bind(on ? 1 : 0, String(actor ?? "owner"), now).run();
  await env.DB.prepare("INSERT INTO strategy_council_toggle_events (auto, actor, actor_sub, ms) VALUES (?, ?, ?, ?)").bind(on ? 1 : 0, String(actor ?? "owner"), actor_sub ? String(actor_sub) : null, now).run();
  return { ok: true, state: await readCouncilState(env) };
}

/** A manual arm or disarm pins the strategy against the council until the owner unpins it. */
export async function pinStrategy(env, { strategy_id, actor, action, now = Date.now() }) {
  await ensureCouncilSchema(env.DB);
  await env.DB.prepare("INSERT INTO strategy_arm_pins (strategy_id, pinned, pinned_by, pinned_ms, action) VALUES (?, 1, ?, ?, ?) ON CONFLICT(strategy_id) DO UPDATE SET pinned = 1, pinned_by = excluded.pinned_by, pinned_ms = excluded.pinned_ms, action = excluded.action")
    .bind(strategy_id, String(actor ?? "owner"), now, action ?? null).run();
}
export async function unpinStrategy(env, { strategy_id }) {
  await ensureCouncilSchema(env.DB);
  await env.DB.prepare("UPDATE strategy_arm_pins SET pinned = 0 WHERE strategy_id = ?").bind(strategy_id).run();
  return { ok: true, state: await readCouncilState(env) };
}

/**
 * Once a UTC day: walk-forward and proposals for every strategy with a record; acts when the council is acting.
 * `cards` are the recommendation cards (src/strategy-recommendation.mjs), `allowed` the live agent ids, `blocked` why an
 * arm is refused now (kill switch, daily loss) or null.
 */
export async function runStrategyCouncil(env, { now = Date.now(), call = callBusModel, send = null, cards = [], allowed = [], blocked = null, force = false } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    await ensureCouncilSchema(db);
    const day = new Date(now).toISOString().slice(0, 10);
    const prev = parse(await kv.get(COUNCIL_KEY));
    if (!force && prev?.day === day) return { status: "fresh" };
    // MS2: the live setups only (a shadow mode's setups are the mode selector's evidence, never a strategy's record).
    await ensurePlanLearningSchema(db);
    const rows = (await db.prepare("SELECT agent, results_json FROM plan_setups WHERE status = 'resolved' AND source = 'live' AND opened_at >= ? ORDER BY opened_at").bind(new Date(now - WF.learn_days * DAY).toISOString()).all()).results ?? [];
    const byAgent = {};
    for (const r of rows) { const x = parse(r.results_json)?.[CONTROL_ARM]; if (finite(x?.r)) (byAgent[r.agent ?? "zone_pullback"] ??= []).push(x.r); }
    // Live: each strategy's last closed Omega trades (Omega R), newest first.
    const live = {};
    try {
      const t = (await db.prepare("SELECT COALESCE(json_extract(d.decision_json, '$.trade.agent'), json_extract(d.decision_json, '$.trade.strategy')) AS agent, l.r_omega AS r FROM signal_ledger l JOIN engine_decisions d ON d.decision_key = l.candle_key WHERE l.omega_status = 'closed' AND l.r_omega IS NOT NULL ORDER BY l.closed_at DESC LIMIT 400").all()).results ?? [];
      for (const x of t) { const a = (live[x.agent || "zone_pullback"] ??= []); if (a.length < LIVE_REVERT_TRADES) a.push(Number(x.r)); }
    } catch { /* no live record */ }
    const arms = await readArmsFromDb(db);
    const state = await readCouncilState(env);
    const pinned = new Set(state.pins.map((p) => p.id));
    const capUsd = councilDailyCapUsd(env);
    // An auto-disarm by the system today: no council arm until the next UTC day.
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    const systemDisarm = Boolean(await db.prepare("SELECT id FROM strategy_arm_events WHERE action = 'disarm' AND actor = 'system' AND at >= ? LIMIT 1").bind(dayStart).first());
    const changedToday = new Set(((await db.prepare("SELECT DISTINCT strategy_id FROM strategy_arm_events WHERE at >= ?").bind(dayStart).all()).results ?? []).map((r) => r.strategy_id));
    const verdicts = {}, applied = [];
    for (const id of Object.keys(byAgent).sort()) {
      const walk = walkForward(byAgent[id]);
      const l = live[id] ?? [], liveMean = l.length >= LIVE_REVERT_TRADES ? r3(mean(l)) : null;
      const liveBad = liveMean != null && liveMean < 0;
      const isArmed = arms.ids.includes(id);
      const opts = allowedProposals({ armed: isArmed, walk, liveBad });
      let proposal = "keep", reason = opts.length === 1 ? `nothing to decide (walk-forward ${walk.status})` : null, source = "rules";
      if (opts.length > 1) {
        if ((await councilSpendUsd(db, now)) >= capUsd) { reason = "daily cap reached: keep"; }
        else {
          try {
            const card = cards.find((c) => c.id === id) ?? null;
            const r = await call(env, { messages: councilMessages(id, { walk, card, armed: isArmed, allowed: opts, liveMean }), schemaName: "strategy_council", schema: COUNCIL_SCHEMA, maxTokens: 300, effort: "low", deadline: Date.now() + 45_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: COUNCIL_METER });
            const o = r?.status === "answered" ? r.obj : null;
            if (o && opts.includes(o.proposal)) { proposal = o.proposal; reason = String(o.reason ?? "").slice(0, 240); source = "council"; }
            else reason = "the council gave no valid answer: keep";
          } catch { reason = "the council failed: keep"; }
        }
      }
      verdicts[id] = { walk_forward: walk, live_mean_r: liveMean, proposal, reason, source, allowed: opts, pinned: pinned.has(id) };
      // Acting: the owner's toggle under the ceiling, and every guard.
      let act = null;
      if (state.acting && proposal !== "keep" && source === "council") {
        if (pinned.has(id)) act = "skipped: pinned by the owner";
        else if (changedToday.has(id)) act = "skipped: changed today already";
        else if (proposal === "arm" && (systemDisarm || blocked)) act = `skipped: ${systemDisarm ? "the system disarmed today" : blocked}`;
        else if (proposal === "arm" && !allowed.includes(id)) act = "skipped: not a live strategy";
        else {
          const res = await setStrategyArm(env, { strategy_id: id, action: proposal, actor: "council", reason: "council", allowed, blocked: proposal === "arm" ? blocked : null, now, send: send ? (t) => send(`${t}\nCouncil: ${reason}`) : null });
          act = res.ok && res.changed ? proposal : `refused: ${res.error ?? "no change"}`;
          if (res.ok && res.changed) applied.push({ id, action: proposal });
        }
        verdicts[id].applied = act;
      }
      await db.prepare("INSERT OR REPLACE INTO strategy_council_runs (day, strategy_id, proposal, reason, walk_forward, applied, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(day, id, proposal, reason, JSON.stringify(walk), act, now).run();
    }
    const doc = { version: "cryptophys.strategy-council.v1", day, computed_at: new Date(now).toISOString(), acting: state.acting, ceiling: state.ceiling, auto: state.auto, max_armed: ARM_MAX, rules: WF, verdicts };
    await kv.put(COUNCIL_KEY, JSON.stringify(doc), { expirationTtl: 3 * DAY / 1000 });
    return { status: "computed", strategies: Object.keys(verdicts).length, proposals: Object.entries(verdicts).filter(([, v]) => v.proposal !== "keep").map(([k, v]) => `${k}:${v.proposal}`), applied };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * The latest council document. H3f-refs: each verdict carries `ev_ref`, the ref the owner's correction cites
 * (POST /omega/api/correction target.ref): its strategy_council_runs row (day, strategy_id), built on read (the KV
 * document is not rewritten); null without the document's day.
 */
export async function readCouncilVerdicts(env) {
  let doc;
  try { doc = parse(await env?.SIGNAL_CACHE?.get?.(COUNCIL_KEY)); } catch { return null; }
  if (!doc || typeof doc !== "object" || !doc.verdicts || typeof doc.verdicts !== "object") return doc;
  const day = typeof doc.day === "string" && doc.day ? doc.day : null;
  const verdicts = Object.fromEntries(Object.entries(doc.verdicts).map(([id, v]) => [id, v && typeof v === "object" && !Array.isArray(v)
    ? { ...v, ev_ref: day ? evRef("strategy_council_runs", `${day}/${id}`, { field: "proposal" }) : null }
    : v]));
  return { ...doc, verdicts };
}
