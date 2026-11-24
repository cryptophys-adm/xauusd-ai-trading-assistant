// Strategy recommendation cards (docs/RFC_STRATEGY_RECOMMENDATION.md §3; owner 2026-11-17 "Ya, semua, live").
// One read-only card per strategy agent, in agentCatalog order, computed deterministically, never by a model: its
// measured record (overall and in the present market condition), the R distribution of its setups, Omega's exits of
// its trades, its real Omega entries and closes, the breaker, the arm, and a recommendation (`recommendationOf`) with
// every rule checked, its value and an evidence ref (`ev:xauusd/<source>/<id>[@as_of][#field]`). No price field ever:
// only R, shares, counts and times. Computed on the 5-minute ledger step at most every RECO_MIN_GAP_MS into KV
// strategy-recommendations:v1 and read by GET /api/strategy-agents (no D1 query on the page's poll). Advice only: no
// decision, no gate and no order reads it.
import { AGENT_IDS, DEFAULT_AGENT, AGENT_BREAKER, CONSENSUS_RULES, suspendedAgents, suspendedPatterns } from "./strategy-agents.mjs";
import { readPlanLearning, CONTROL_ARM, ensurePlanLearningSchema } from "./plan-learning.mjs";
import { readArmsFromDb } from "./strategy-arm.mjs";

export const RECO_KEY = "strategy-recommendations:v1";
export const RECO_MIN_GAP_MS = 15 * 60_000;
export const RECO_RULES = Object.freeze({
  context_min_setups: CONSENSUS_RULES.record_min_setups, // 15
  record_min_setups: CONSENSUS_RULES.record_min_setups, // 15: a negative mean R from here is "not recommended"
  recommend_min_setups: AGENT_BREAKER.min_setups, // 30
  recommend_min_mean_r: 0.1,
  stop_share_min_trades: 20,
  stop_share_bad: 0.65,
  stop_share_ok: 0.5,
  ledger_last: 20
});
const R_BUCKETS = Object.freeze(["le_-1", "-1_0", "0_1", "1_2", "ge_2"]);

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Pure: the bucket of one R result. */
export function rBucket(r) {
  if (!finite(r)) return null;
  return r <= -1 ? "le_-1" : r < 0 ? "-1_0" : r < 1 ? "0_1" : r < 2 ? "1_2" : "ge_2";
}

/**
 * Pure: the recommendation of one card: { verdict: "recommended" | "neutral" | "not_recommended", reason, rules }.
 * Each rule is { rule, value, threshold, holds, ref }.
 */
export function recommendationOf(card) {
  const R = RECO_RULES, id = card.id, asOf = card.as_of ? `@${card.as_of}` : "";
  const rec = card.record ?? {}, ctx = card.context_record ?? null, ex = card.exits ?? {};
  const setups = finite(rec.setups) ? rec.setups : 0, meanR = finite(rec.mean_r) ? rec.mean_r : null;
  const ctxN = finite(ctx?.setups) ? ctx.setups : 0, ctxR = finite(ctx?.mean_r) ? ctx.mean_r : null;
  const trades = finite(ex.n) ? ex.n : 0, stopShare = finite(ex.stop_or_locked_share) ? ex.stop_or_locked_share : null;
  const ref = (src, key, field) => `ev:xauusd/${src}/${key}${asOf}#${field}`;
  const rules = [
    { rule: "breaker_suspended", value: Boolean(card.breaker?.suspended), threshold: false, ref: ref("strategy_breaker", id, "suspended") },
    { rule: "record_negative", value: meanR, threshold: `< 0 with setups >= ${R.record_min_setups}`, setups, ref: ref("plan_learning", `agent:${id}`, "mean_r") },
    { rule: "context_negative", value: ctxR, threshold: `< 0 with setups >= ${R.context_min_setups}`, setups: ctxN, context: card.context ?? null, ref: ref("plan_learning", `agent:${id}:${card.context ?? "unknown"}`, "mean_r") },
    { rule: "omega_stop_share", value: stopShare, threshold: `>= ${R.stop_share_bad} bad, < ${R.stop_share_ok} ok, over >= ${R.stop_share_min_trades} trades`, trades, ref: ref("signal_ledger", `agent:${id}:last${R.ledger_last}`, "omega_stop_or_sl_plus_share") }
  ];
  const bad = {
    breaker_suspended: Boolean(card.breaker?.suspended),
    record_negative: setups >= R.record_min_setups && meanR != null && meanR < 0,
    context_negative: ctxN >= R.context_min_setups && ctxR != null && ctxR < 0,
    omega_stop_share: trades >= R.stop_share_min_trades && stopShare != null && stopShare >= R.stop_share_bad
  };
  for (const r of rules) r.holds = !bad[r.rule];
  if (Object.values(bad).some(Boolean)) {
    const first = rules.find((r) => !r.holds);
    return { verdict: "not_recommended", reason: first.rule, rules };
  }
  const good = setups >= R.recommend_min_setups && meanR != null && meanR >= R.recommend_min_mean_r
    && (ctxN < R.context_min_setups || (ctxR != null && ctxR >= 0))
    && (trades < R.stop_share_min_trades || (stopShare != null && stopShare < R.stop_share_ok));
  rules.push({ rule: "recommend_bar", value: meanR, threshold: `setups >= ${R.recommend_min_setups} and mean R >= +${R.recommend_min_mean_r}`, setups, holds: good, ref: ref("plan_learning", `agent:${id}`, "mean_r") });
  if (good) return { verdict: "recommended", reason: "recommend_bar", rules };
  return { verdict: "neutral", reason: setups < R.record_min_setups ? "collecting" : "below_recommend_bar", rules };
}

/** Pure: the cards from the loaded facts. */
export function buildCards({ records = [], context = null, rDist = {}, exits = {}, executed = {}, arms = null, asOf = null } = {}) {
  const held = new Set(suspendedAgents(records).map((x) => x.id));
  const heldPatterns = suspendedPatterns(records);
  return AGENT_IDS.map((id) => {
    const rec = records.find((r) => r?.agent === id) ?? null;
    const ctxRec = rec && context ? (rec.contexts ?? []).find((c) => c.context === context) ?? null : null;
    const armRow = (arms?.armed ?? []).find((a) => a.id === id) ?? null;
    const card = {
      id, as_of: asOf, context,
      record: rec ? { setups: rec.setups, mean_r: rec.mean_r, fill_rate: rec.fill_rate, target_rate: rec.target_rate, stop_rate: rec.stop_rate } : null,
      context_record: ctxRec ? { setups: ctxRec.setups, mean_r: ctxRec.mean_r } : null,
      r_dist: rDist[id] ?? Object.fromEntries(R_BUCKETS.map((b) => [b, 0])),
      exits: exits[id] ?? { n: 0, stop_share: null, sl_plus_share: null, stop_or_locked_share: null, breakeven_share: null, ledger_n: 0 },
      executed: executed[id] ?? { opened: 0, closed: 0, win_share: null },
      breaker: { suspended: held.has(id) && id !== DEFAULT_AGENT, patterns_held: heldPatterns.filter((p) => p.agent === id).map((p) => p.id) },
      arm: { armed: Boolean(armRow), armed_by: armRow?.armed_by ?? null, armed_at: armRow?.armed_at ? new Date(Number(armRow.armed_at)).toISOString() : null, version: arms?.version ?? null }
    };
    return { ...card, recommendation: recommendationOf(card) };
  });
}

/** Pure: Omega's exits per agent from ledger rows { agent, omega_exit, sl_plus_triggered }, newest first, last N each. */
export function exitsOf(rows, n = RECO_RULES.ledger_last) {
  const by = {};
  for (const r of rows || []) {
    const id = typeof r.agent === "string" && r.agent ? r.agent : DEFAULT_AGENT;
    const a = (by[id] ??= { ledger: [], omega: [] });
    if (a.ledger.length < n) a.ledger.push(r);
    if (typeof r.omega_exit === "string" && r.omega_exit && a.omega.length < n) a.omega.push(r);
  }
  return Object.fromEntries(Object.entries(by).map(([id, a]) => {
    const on = a.omega.length, ln = a.ledger.length;
    const share = (k) => (on ? r3(a.omega.filter((x) => x.omega_exit === k).length / on) : null);
    const stop = share("stop"), locked = share("sl_plus");
    return [id, { n: on, stop_share: stop, sl_plus_share: locked, stop_or_locked_share: on ? r3((stop ?? 0) + (locked ?? 0)) : null, breakeven_share: ln ? r3(a.ledger.filter((x) => Number(x.sl_plus_triggered) === 1).length / ln) : null, ledger_n: ln }];
  }));
}

/** Reads the facts and writes the cards to KV, at most every RECO_MIN_GAP_MS. Never throws. */
export async function computeRecommendations(env, { now = Date.now(), force = false } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    if (!force) {
      const prev = parse(await kv.get(RECO_KEY));
      if (prev && now - Date.parse(prev.computed_at ?? "") < RECO_MIN_GAP_MS) return { status: "waiting" };
    }
    const safe = async (fn, fb) => { try { return await fn(); } catch { return fb; } };
    const state = await safe(() => readPlanLearning(env), null);
    const records = Array.isArray(state?.agents) ? state.agents : [];
    // MS2: the live setups only (a shadow mode's setups are the mode selector's evidence).
    await safe(() => ensurePlanLearningSchema(db), null);
    const context = await safe(async () => (await db.prepare("SELECT context FROM plan_setups WHERE source = 'live' ORDER BY opened_at DESC LIMIT 1").first())?.context ?? null, null);
    const rDist = await safe(async () => {
      const rows = (await db.prepare("SELECT agent, results_json FROM plan_setups WHERE status = 'resolved' AND source = 'live' ORDER BY opened_at DESC LIMIT 2000").all()).results ?? [];
      const out = {};
      for (const r of rows) {
        const b = rBucket(parse(r.results_json)?.[CONTROL_ARM]?.r);
        if (!b) continue;
        const d = (out[r.agent ?? DEFAULT_AGENT] ??= Object.fromEntries(R_BUCKETS.map((k) => [k, 0])));
        d[b] += 1;
      }
      return out;
    }, {});
    const exits = await safe(async () => exitsOf((await db.prepare(
      "SELECT COALESCE(json_extract(d.decision_json, '$.trade.agent'), json_extract(d.decision_json, '$.trade.strategy')) AS agent, l.omega_exit, l.sl_plus_triggered FROM signal_ledger l JOIN engine_decisions d ON d.decision_key = l.candle_key WHERE l.source = 'decision' AND l.status = 'closed' ORDER BY l.closed_at DESC LIMIT 400"
    ).all()).results ?? []), {});
    const executed = await safe(async () => {
      const opened = (await db.prepare("SELECT json_extract(payload, '$.strategy') AS agent, COUNT(*) AS n FROM omega_intents WHERE kind = 'open' AND status = 'done' GROUP BY 1").all()).results ?? [];
      const closed = (await db.prepare(`SELECT strategy AS agent, COUNT(DISTINCT deal_ticket) AS n, COUNT(DISTINCT CASE WHEN profit + COALESCE(commission, 0) + COALESCE(swap, 0) > 0 THEN deal_ticket END) AS wins FROM ea_deals WHERE source = 'omega' AND strategy IS NOT NULL GROUP BY 1`).all()).results ?? [];
      const out = {};
      for (const r of opened) { const id = r.agent || DEFAULT_AGENT; (out[id] ??= { opened: 0, closed: 0, win_share: null }).opened += Number(r.n) || 0; }
      for (const r of closed) { const x = (out[r.agent] ??= { opened: 0, closed: 0, win_share: null }); x.closed = Number(r.n) || 0; x.win_share = x.closed ? r3((Number(r.wins) || 0) / x.closed) : null; }
      return out;
    }, {});
    const arms = await safe(() => readArmsFromDb(db), null);
    const asOf = new Date(now).toISOString().slice(0, 16) + "Z";
    const cards = buildCards({ records, context, rDist, exits, executed, arms, asOf });
    const doc = { version: "cryptophys.strategy-recommendations.v1", computed_at: new Date(now).toISOString(), context, rules: RECO_RULES, cards };
    await kv.put(RECO_KEY, JSON.stringify(doc), { expirationTtl: 2 * 86_400 });
    return { status: "computed", cards: cards.length, recommended: cards.filter((c) => c.recommendation.verdict === "recommended").map((c) => c.id) };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The stored cards, or null. */
export async function readRecommendations(env) {
  try { return parse(await env?.SIGNAL_CACHE?.get?.(RECO_KEY)); } catch { return null; }
}
