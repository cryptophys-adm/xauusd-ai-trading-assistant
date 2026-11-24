// The strategy agents' vetoes, softened for two-sided agents (SV1b, owner 2026-11-24, relayed: "Build A6+A7, switch on,
// auto-revert"; the study SV1a: the default agent zone_pullback speaks on both sides in 47 of 54 blocks, its two voices
// cancel in the lean's numerator but stay in its denominator, so one extra one-sided agent lifts the lean past 0.15).
//
// AGENT_VETO_RULE (wrangler.jsonc): "two_sided" | "classic". The code default (unset or unknown) is "classic": the vetoes
// of src/decision-engine.mjs decide() as before, byte for byte. Under "two_sided" (decide(), guards.veto_rule):
//   A6  the consensus lean veto (overruled.by "strategy_agents"): the lean itself is unchanged (the witness card, the
//       quorum and the threshold LEAN are as before), but the veto holds only when the classic veto holds (the lean
//       against the decided side is at least LEAN) AND at least A6_MIN_ONE_SIDED agents speak against the side without
//       also speaking for it (one-sided opposing agents). An opposing agent that also speaks for the decided side does
//       not count against it.
//   A7  the strategy arm veto ("an armed strategy sees its setup on the other side"): an armed agent that also speaks
//       for the decided side is ignored; the veto holds only for an armed agent that speaks against the side alone.
// A decision that trades ONLY because of A6 or A7 keeps veto_softened: { rule: "A6" | "A7", old_detail } (old_detail: the
// detail the classic rule would have written; words, never a price). Its Omega entry intent (omega-broker bridgeSync)
// and its Signal Ledger row (signal_ledger.veto_softened) carry the same object, so its Omega R is tracked per trade.
//
// The rule in force: the owner's force (KV AGENT_VETO_OWNER_KEY, set through the owner-only POST /api/strategy-council
// of the Omega Worker), else the automatic revert (KV AGENT_VETO_AUTO_KEY, while its hold lasts), else the env value.
// The automatic revert (runAgentVetoRevert, once a UTC day on the 5-minute ledger step, beside the grid's): once at
// least AGENT_VETO_REVERT.min_trades closed softened trades exist (Omega R as grid-adapt's live check reads it: the
// entry intents joined to signal_ledger.r_omega), the mean of the latest of them; below 0R the rule goes back to
// "classic" for AGENT_VETO_REVERT.hold_days, with one Telegram line and an Omega event. After the hold the env rule is
// back and only the trades opened after the hold count. Both KV keys are written only by this Worker at run time.

export const AGENT_VETO_RULES = Object.freeze(["two_sided", "classic"]);
export const AGENT_VETO_AUTO_KEY = "agent-veto:auto:v1";
export const AGENT_VETO_OWNER_KEY = "agent-veto:owner:v1";
/** A6: the one-sided opposing agents a lean veto needs under "two_sided". */
export const A6_MIN_ONE_SIDED = 2;
export const AGENT_VETO_REVERT = Object.freeze({ min_trades: 15, below_r: 0, hold_days: 7 });
const DAY = 86_400_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const parse = (s) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? null); } catch { return null; } };
const ruleOf = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return AGENT_VETO_RULES.includes(s) ? s : null;
};

/** Pure: the rule a value names ("two_sided" only when it says so; anything else, unset included, is "classic"). */
export function agentVetoRuleOf(env) {
  return ruleOf(env?.AGENT_VETO_RULE) === "two_sided" ? "two_sided" : "classic";
}

/** Pure: the owner's force (a stored { rule, actor, at }), or null. */
export function ownerForceOf(doc) {
  const rule = ruleOf(doc?.rule);
  return rule ? { rule, actor: typeof doc.actor === "string" ? doc.actor : null, at: typeof doc.at === "string" ? doc.at : null } : null;
}

/** Pure: the automatic revert in force at `now` (a stored { rule: "classic", until }), or null. */
export function autoRevertAt(doc, now = Date.now()) {
  return doc?.rule === "classic" && Date.parse(String(doc.until ?? "")) > now ? doc : null;
}

/** Pure: the rule in force: the owner's force, else the automatic revert while it holds, else the env value. */
export function resolveRule({ envRule = "classic", owner = null, auto = null, now = Date.now() } = {}) {
  const force = ownerForceOf(owner);
  if (force) return { rule: force.rule, source: "owner" };
  if (autoRevertAt(auto, now)) return { rule: "classic", source: "auto_revert" };
  return { rule: envRule === "two_sided" ? "two_sided" : "classic", source: "env" };
}

/**
 * The rule in force for a decision ({ rule, source, env_rule }). Reads the owner's key always (a force may turn the rule
 * on while env says "classic") and the revert's key only when it could matter. An unreadable KV gives "classic"
 * (source "unreadable"): the stricter rule, never the softened one by accident. Never throws.
 */
export async function resolveAgentVetoRule(env, { now = Date.now() } = {}) {
  const envRule = agentVetoRuleOf(env);
  try {
    const kv = env?.SIGNAL_CACHE;
    const owner = parse(await kv?.get?.(AGENT_VETO_OWNER_KEY));
    const auto = !ownerForceOf(owner) && envRule === "two_sided" ? parse(await kv?.get?.(AGENT_VETO_AUTO_KEY)) : null;
    return { ...resolveRule({ envRule, owner, auto, now }), env_rule: envRule };
  } catch {
    return { rule: "classic", source: "unreadable", env_rule: envRule };
  }
}

/** Pure: the revert's verdict over closed softened trades' R, newest first: { n, mean_r, ready, revert }. */
export function revertVerdict(rs, { minTrades = AGENT_VETO_REVERT.min_trades, belowR = AGENT_VETO_REVERT.below_r } = {}) {
  const last = (Array.isArray(rs) ? rs : []).filter(finite).slice(0, minTrades);
  const mean = last.length ? last.reduce((a, x) => a + x, 0) / last.length : null;
  const ready = last.length >= minTrades;
  return { n: last.length, mean_r: r3(mean), ready, revert: ready && mean < belowR };
}

/**
 * The closed softened trades in Omega's own R, newest first, as grid-adapt's live check reads them: the Omega entry
 * intents (a market open or a resting limit) that carry veto_softened, joined to the Signal Ledger row of their decision
 * (signal_ledger.candle_key) where Omega's policy has closed it (r_omega); one per decision. Only intents created at or
 * after `sinceMs` count. [] when unreadable.
 */
export async function softenedTrades(db, { sinceMs = 0, limit = 500 } = {}) {
  try {
    const rows = (await db.prepare("SELECT l.candle_key AS k, l.r_omega AS r, MAX(i.created_ms) AS at FROM omega_intents i JOIN signal_ledger l ON l.candle_key = 'OANDA:XAUUSD:15:' || CAST(json_extract(i.payload, '$.signal_issued_ms') AS INTEGER) WHERE i.kind IN ('open', 'place_limit') AND json_extract(i.payload, '$.veto_softened') IS NOT NULL AND l.omega_status = 'closed' AND i.created_ms >= ? GROUP BY l.candle_key ORDER BY at DESC LIMIT ?")
      .bind(finite(sinceMs) ? sinceMs : 0, limit).all()).results ?? [];
    return rows.map((x) => ({ key: x.k, r: Number(x.r), at: Number(x.at) })).filter((x) => finite(x.r));
  } catch { return []; }
}

async function omegaEvent(db, now, action, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:veto", action, JSON.stringify(detail)).run(); } catch { /* best effort */ }
}

/**
 * Once a UTC day (the 5-minute ledger step, beside runGridAdapt; no cron of its own): the hold's end, then the revert
 * check. Returns { status, ... }: inactive (the rule is "classic" by env and no force), fresh (already today), held,
 * owner_force (the owner's force wins: no revert), kept, reverted, unavailable or failed. Never throws.
 */
export async function runAgentVetoRevert(env, { now = Date.now(), send = null, force = false } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const envRule = agentVetoRuleOf(env);
    const owner = ownerForceOf(parse(await kv.get(AGENT_VETO_OWNER_KEY)));
    let auto = parse(await kv.get(AGENT_VETO_AUTO_KEY)) ?? {};
    const day = new Date(now).toISOString().slice(0, 10);
    // Neither the env nor a force turns the softened rule on: nothing was softened, nothing to check.
    if (envRule !== "two_sided" && owner?.rule !== "two_sided" && !auto.rule) return { status: "inactive" };
    if (!force && auto.day === day) return { status: "fresh" };
    const put = async (doc) => { await kv.put(AGENT_VETO_AUTO_KEY, JSON.stringify(doc)); return doc; };
    // The hold ends: the env rule is back, and only the trades opened from here on count.
    if (auto.rule === "classic" && !autoRevertAt(auto, now)) {
      await omegaEvent(db, now, "agent_veto_released", { rule: envRule, held_since: auto.since ?? null, held_until: auto.until ?? null });
      auto = { rule: null, window_since: auto.until ?? new Date(now).toISOString(), released_at: new Date(now).toISOString(), previous: { since: auto.since ?? null, until: auto.until ?? null, n: auto.n ?? null, mean_r: auto.mean_r ?? null } };
    }
    if (autoRevertAt(auto, now)) { await put({ ...auto, day }); return { status: "held", until: auto.until }; }
    const sinceMs = Date.parse(String(auto.window_since ?? "")) || 0;
    const v = revertVerdict((await softenedTrades(db, { sinceMs })).map((x) => x.r));
    if (owner) { await put({ ...auto, day, last: { n: v.n, mean_r: v.mean_r, at: new Date(now).toISOString() } }); return { status: "owner_force", rule: owner.rule, ...v }; }
    if (envRule !== "two_sided") { await put({ ...auto, day }); return { status: "inactive" }; }
    if (!v.revert) { await put({ ...auto, day, last: { n: v.n, mean_r: v.mean_r, at: new Date(now).toISOString() } }); return { status: "kept", ...v }; }
    const until = new Date(now + AGENT_VETO_REVERT.hold_days * DAY).toISOString();
    const doc = await put({ rule: "classic", since: new Date(now).toISOString(), until, n: v.n, mean_r: v.mean_r, window_since: auto.window_since ?? null, day, reason: `the last ${v.n} softened trades averaged ${v.mean_r}R` });
    await omegaEvent(db, now, "agent_veto_reverted", { rule: "classic", from: "two_sided", until, n: v.n, mean_r: v.mean_r });
    if (typeof send === "function") {
      try { await send(`XAUUSD SYSTEM · Strategy-agent veto back to classic for ${AGENT_VETO_REVERT.hold_days} days: the last ${v.n} trades the two-sided rule (A6/A7) let through averaged ${v.mean_r > 0 ? "+" : ""}${v.mean_r}R in Omega R, below ${AGENT_VETO_REVERT.below_r}R. Checked again daily after the hold.`); } catch { /* best effort */ }
    }
    return { status: "reverted", until: doc.until, ...v };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * The owner's force (the Omega Worker's owner-only POST /api/strategy-council with `veto_rule`; the AI Worker checks
 * OWNER_ACCESS_SUB again): "two_sided" or "classic" pins the rule, "auto" clears the force. Audited in omega_events.
 */
export async function setAgentVetoForce(env, { rule, actor = "owner", now = Date.now() } = {}) {
  const kv = env?.SIGNAL_CACHE;
  if (!kv) return { ok: false, error: "unavailable" };
  const want = String(rule ?? "").trim().toLowerCase();
  if (want !== "auto" && !ruleOf(want)) return { ok: false, error: "veto_rule must be two_sided, classic or auto" };
  const prev = ownerForceOf(parse(await kv.get(AGENT_VETO_OWNER_KEY)));
  const next = want === "auto" ? null : { rule: want, actor: String(actor).slice(0, 120), at: new Date(now).toISOString() };
  await kv.put(AGENT_VETO_OWNER_KEY, JSON.stringify(next ?? { rule: null, actor: String(actor).slice(0, 120), at: new Date(now).toISOString() }));
  if (env?.DB) await omegaEvent(env.DB, now, "agent_veto_owner", { rule: want, previous: prev?.rule ?? null, by: String(actor).slice(0, 120) });
  const resolved = await resolveAgentVetoRule(env, { now });
  return { ok: true, changed: (prev?.rule ?? "auto") !== want, force: want, rule: resolved.rule, source: resolved.source };
}

/**
 * Read only (GET /api/strategy-agents `veto_rule`): the rule in force and its source, the softened decisions the Signal
 * Ledger holds (all and per rule), and the closed softened trades counted since the last hold with their mean Omega R.
 */
export async function agentVetoStatus(env, { now = Date.now() } = {}) {
  const resolved = await resolveAgentVetoRule(env, { now });
  let auto = null, owner = null;
  try { auto = parse(await env?.SIGNAL_CACHE?.get?.(AGENT_VETO_AUTO_KEY)); owner = ownerForceOf(parse(await env?.SIGNAL_CACHE?.get?.(AGENT_VETO_OWNER_KEY))); } catch { /* none */ }
  let softened = null;
  try {
    const rows = (await env.DB.prepare("SELECT json_extract(veto_softened, '$.rule') AS rule, COUNT(*) AS n FROM signal_ledger WHERE veto_softened IS NOT NULL GROUP BY rule").all()).results ?? [];
    softened = { total: rows.reduce((a, x) => a + Number(x.n || 0), 0), A6: Number(rows.find((x) => x.rule === "A6")?.n || 0), A7: Number(rows.find((x) => x.rule === "A7")?.n || 0) };
  } catch { softened = null; }
  const sinceMs = Date.parse(String(auto?.window_since ?? "")) || 0;
  const v = env?.DB ? revertVerdict((await softenedTrades(env.DB, { sinceMs })).map((x) => x.r)) : { n: 0, mean_r: null, ready: false, revert: false };
  return {
    rule: resolved.rule, source: resolved.source, env_rule: resolved.env_rule,
    // The force without its actor (the audit row in omega_events keeps who).
    owner_force: owner ? { rule: owner.rule, at: owner.at } : null, auto_revert: autoRevertAt(auto, now) ? { since: auto.since ?? null, until: auto.until ?? null, n: auto.n ?? null, mean_r: auto.mean_r ?? null } : null,
    softened, closed: v.n, mean_r: v.mean_r, counted_since: auto?.window_since ?? null, last_check: auto?.day ?? null,
    revert_rule: { min_trades: AGENT_VETO_REVERT.min_trades, below_r: AGENT_VETO_REVERT.below_r, hold_days: AGENT_VETO_REVERT.hold_days }
  };
}

/**
 * The entry intent's tag: the decision's veto_softened (read once per decision key and isolate), or null. Only an entry
 * intent (a market open or a resting limit) is tagged; the decision is the one whose close the intent's signal carries.
 */
let tagMemo = { key: null, db: null, tag: null };
export function resetVetoTagMemoForTests() { tagMemo = { key: null, db: null, tag: null }; }
export async function vetoSoftenedTag(db, intent) {
  if (!db || !(intent?.kind === "open" || intent?.kind === "place_limit") || !finite(intent.signal_issued_ms)) return null;
  const key = `OANDA:XAUUSD:15:${intent.signal_issued_ms}`;
  if (tagMemo.key === key && tagMemo.db === db) return tagMemo.tag;
  let tag = null;
  try {
    const row = await db.prepare("SELECT json_extract(decision_json, '$.veto_softened') AS v FROM engine_decisions WHERE decision_key = ?").bind(key).first();
    const v = parse(row?.v);
    tag = v && (v.rule === "A6" || v.rule === "A7") ? { rule: v.rule, old_detail: String(v.old_detail ?? "").slice(0, 200) } : null;
  } catch { tag = null; }
  tagMemo = { key, db, tag };
  return tag;
}
