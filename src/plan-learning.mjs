// Plan learner (owner 2026-11-13: "Kita butuh strategy modul learning yang adaptif terhadap price action
// supaya entry dan resiko lebih presisi"; docs/RFC_PLAN_LEARNING.md). The strategy engine places every
// plan by fixed rules (src/strategy-engine.mjs tradeLevels: the entry at the zone's near edge or at price,
// the stop behind the next zone plus 0.2 ATR). This module measures, on gold's own price action after each
// Decision Engine trade, where the entry and the stop should have been, and learns it per market condition.
//
//   setup      one plan the engine held: the first BUY or SELL decision of a run of decisions with the same
//              side, stop and target (the engine repeats a plan every 15 minutes while it stands). It lives
//              until the engine stops repeating it; an entry may fill only while it lives (at most 8 hours).
//   grid       each setup is replayed once per arm on the Signal Ledger's bars (1m where the 1m series
//              reaches, 15m before) with the ledger's own simulation (simulateSignal, SL+ at halfway); a
//              plan at its level is entered at market on the first bar, as Omega enters it:
//                entry shift   0, 0.1, 0.2 or 0.3 x the 1H ATR deeper than the plan's entry (toward the
//                              stop: a better price, fewer fills);
//                stop scale    0.5, 0.65, 0.8, 1 or 1.25 x the plan's stop distance, from the plan's entry.
//              The target stays the plan's key level. The control is the plan as it is (e0@s1). A result is
//              in R of the arm's own risk (the lot follows the stop distance); an entry that never fills is 0R.
//   context    the trading mode and the 1H regime of the decision (volatility and character, for example
//              "scalp|low-ranging"): the price action the plan stood in.
//   learner    per arm, the mean difference against the control on the same setups, shrunk toward the mean
//              over every context and that toward zero (a prior worth PRIOR setups). A context picks the arm
//              with the largest shrunk gain when it exceeds MARGIN R (and the arm was replayed on at least
//              MIN_PICK setups: one large outlier never moves a plan), else the plan as it is.
//   referee    walk-forward: for each setup the learner sees only setups resolved before it opened, picks,
//              and its pick is compared with the plan on that setup. A one-sided sign test on the older
//              part of the independent setups (none open while another runs), the newest part held out;
//              "better_than_plan" needs both.
// Shadow only: nothing here reaches a room, a decision, the EA signal or Omega. Applying a learned plan is
// a later, owner-approved step. Switch: PLAN_LEARNING_MODE = "shadow" (default) | "off".

import { simulateSignal, ledgerSeries, toMs, decisionCloseMs, validSignal, FILL_WINDOW_MS, TRADING_MODES } from "./signal-ledger.mjs";
import { signTestP, SHADOW_SIGNIFICANCE } from "./shadow-versions.mjs";

export const PLAN_LEARNING_VERSION = "cryptophys.plan-learning.v2";
export const PLAN_LEARNING_KEY = "plan-learning:state:v1";
export const ENTRY_SHIFTS = Object.freeze([0, 0.1, 0.2, 0.3]);
export const STOP_SCALES = Object.freeze([0.5, 0.65, 0.8, 1, 1.25]);
const M15 = 15 * 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
export const PLAN_RULES = Object.freeze({
  min_risk_atr: 0.25,        // an arm's stop distance is at least this many 1H ATR
  same_setup_atr: 0.05,      // stop and target within this many ATR: the same plan repeated
  setup_gap_ms: 2 * M15,     // a plan not repeated for this long has ended
  hold_max_ms: DAY,          // a filled arm is marked to market after this long
  prior: 20,                 // the shrinkage, in setups
  margin_r: 0.05,            // a pick must promise at least this much R per setup over the plan
  min_pick_setups: 20,       // an arm is picked only once it was replayed on this many setups
  market_band: 0.35,         // a plan at its level fills at market within this share of its stop distance (as Omega)
  min_setups: 60,            // the referee's minimum of independent setups (none open while another runs)
  min_decisive: 20,          // and of those where the pick and the plan ended differently
  holdout_share: 0.25, holdout_min: 15,
  window_days: 2,            // decisions read at each run
  backfill_days: 30,         // and at the first run, when no setup is stored yet
  learn_days: 90             // resolved setups the learner reads
});
/** The strategy agent whose plan a setup is: today the strategy engine's own key-level plan. */
export const DEFAULT_PLAN_AGENT = "zone_pullback";
export const armId = (e, k) => `e${e}@s${k}`;
export const CONTROL_ARM = armId(0, 1);
export const PLAN_ARMS = Object.freeze(ENTRY_SHIFTS.flatMap((e) => STOP_SCALES.map((k) => Object.freeze({ id: armId(e, k), entry_shift: e, stop_scale: k }))));

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();

export function planLearningMode(env) {
  return String(env?.PLAN_LEARNING_MODE ?? "shadow").trim().toLowerCase() === "off" ? "off" : "shadow";
}

/** The price action a plan stood in: the trading mode and the 1H regime label. */
export const contextOf = (s) => `${TRADING_MODES.includes(s?.mode) ? s.mode : "none"}|${typeof s?.regime === "string" && s.regime ? s.regime : "unknown"}`;

/** Pure: an arm's entry and stop for a plan ({ side, entry, stop, tp1, atr_h1 }), or null when the arm does not fit it. */
export function variantOf(plan, arm) {
  const dir = plan?.side === "BUY" ? 1 : plan?.side === "SELL" ? -1 : 0;
  if (!dir || ![plan.entry, plan.stop, plan.tp1, plan.atr_h1].every(finite) || plan.atr_h1 <= 0) return null;
  const risk0 = dir * (plan.entry - plan.stop);
  if (!(risk0 > 0)) return null;
  const entry = r2(plan.entry - dir * arm.entry_shift * plan.atr_h1);
  const stop = r2(plan.entry - dir * arm.stop_scale * risk0);
  const risk = dir * (entry - stop);
  if (!(risk >= PLAN_RULES.min_risk_atr * plan.atr_h1) || !(dir * (plan.tp1 - entry) > 0)) return null;
  return { side: plan.side, entry, stop, tp1: plan.tp1, risk: r2(risk), rrr: r2((dir * (plan.tp1 - entry)) / risk) };
}

/**
 * Pure: the setups of `decisions` (BUY or SELL, oldest first: { key, close_ms, decided_at, side, entry,
 * stop, tp1, atr_h1, mode, action, at_level, regime }). A decision repeating the stop and the target of
 * the latest setup of its side and strategy agent (`agent`, the default agent without one) within the gap
 * extends that setup; any other opens a new one.
 */
export function setupsFrom(decisions) {
  const out = [], cur = {};
  for (const d of decisions || []) {
    if (!finite(d?.close_ms) || !finite(d.atr_h1) || d.atr_h1 <= 0 || !validSignal({ side: d.side, entry: d.entry, stop: d.stop, tp1: d.tp1 })) continue;
    const agent = typeof d.agent === "string" && d.agent ? d.agent : DEFAULT_PLAN_AGENT, slot = `${d.side}:${agent}`;
    const c = cur[slot], tol = PLAN_RULES.same_setup_atr * d.atr_h1;
    if (c && d.close_ms - c.last_seen_ms <= PLAN_RULES.setup_gap_ms && Math.abs(d.stop - c.stop) <= tol && Math.abs(d.tp1 - c.tp1) <= tol) { c.last_seen_ms = d.close_ms; c.decisions += 1; continue; }
    const s = {
      setup_key: agent === DEFAULT_PLAN_AGENT ? `${d.key}:${d.side}` : `${d.key}:${d.side}:${agent}`, decision_key: d.key, agent, opened_ms: d.close_ms, decided_ms: finite(toMs(d.decided_at)) ? Math.max(toMs(d.decided_at), d.close_ms) : d.close_ms, last_seen_ms: d.close_ms, decisions: 1,
      side: d.side, entry: d.entry, stop: d.stop, tp1: d.tp1, atr_h1: d.atr_h1,
      mode: TRADING_MODES.includes(d.mode) ? d.mode : null, action: d.action === "ENTER_MARKET" ? "ENTER_MARKET" : "ENTER_LIMIT", at_level: d.at_level === true || d.at_level === 1,
      regime: typeof d.regime === "string" && d.regime ? d.regime : null
    };
    s.context = contextOf(s);
    out.push(s); cur[slot] = s;
  }
  return out;
}

/** How long an entry of the setup may fill: while the engine repeated the plan, at least one bar, at most the ledger's window. */
export const fillWindowOf = (s) => Math.min(FILL_WINDOW_MS, Math.max(M15, s.last_seen_ms + M15 - s.opened_ms));

/**
 * Pure: every arm's outcome of one ended setup on `bars` (closed, oldest first). { status: "resolved",
 * results: { arm: { s, r, f } } } once every fitting arm is final ("s" the exit, "r" in R of the arm's own
 * risk with 0 for no fill, "f" 1 when filled); "open" while one still runs; "unavailable" without bars
 * right after the decision. `resolved_ms` is the last arm's exit.
 */
export function replaySetup(setup, bars, { now = Date.now() } = {}) {
  // A 1m bar counts from the minute the decision was made; a coarser bar from the decided bar's close.
  const after = (bars || []).filter((b) => { const o = toMs(b.open_time); return o >= (toMs(b.close_time) - o <= 5 * 60_000 ? setup.decided_ms : setup.opened_ms); });
  if (!after.length || toMs(after[0].open_time) - setup.opened_ms > 3 * M15) return { status: now - setup.opened_ms > 2 * DAY ? "unavailable" : "open", results: {} };
  const results = {};
  let open = false, last = setup.opened_ms;
  // A plan at its level is entered at market, as Omega enters it (production 2026-11-13: one plan in
  // four counted as never filled because price had left the exact entry in the minute the council took):
  // on the first bar after the decision, when its open is within MARKET_BAND of the plan's stop distance
  // from the entry. The arm keeps its stop and target distances from that fill. A deeper entry stays a limit.
  const dir = setup.side === "BUY" ? 1 : -1, first = after[0].open;
  const market = setup.at_level === true && finite(first) && Math.abs(first - setup.entry) <= PLAN_RULES.market_band * dir * (setup.entry - setup.stop);
  const filled = market ? { ...setup, entry: first, stop: r2(setup.stop + first - setup.entry), tp1: r2(setup.tp1 + first - setup.entry) } : null;
  for (const arm of PLAN_ARMS) {
    const v = variantOf(arm.entry_shift === 0 && filled ? filled : setup, arm);
    if (!v) { results[arm.id] = { s: "invalid", r: null, f: 0 }; continue; }
    const sim = simulateSignal({ side: v.side, entry: v.entry, stop: v.stop, tp1: v.tp1, progressive_stop: v.entry, opened_at: iso(setup.opened_ms) }, after, { now, fillWindowMs: fillWindowOf(setup), holdMaxMs: PLAN_RULES.hold_max_ms });
    if (sim.status === "closed") results[arm.id] = { s: sim.exit_reason, r: r3(sim.r_tp1), f: 1 };
    else if (sim.status === "cancelled") results[arm.id] = { s: sim.exit_reason, r: 0, f: 0 };
    else { open = true; continue; }
    if (finite(toMs(sim.closed_at))) last = Math.max(last, toMs(sim.closed_at));
  }
  // Resolved at the last arm's exit on the bars, not at the time of this run: the referee may only learn
  // from what had ended before a later setup opened.
  return open ? { status: "open", results: {} } : { status: "resolved", results, resolved_ms: last };
}

const diffOf = (s, arm) => { const a = s.results?.[arm], c = s.results?.[CONTROL_ARM]; return finite(a?.r) && finite(c?.r) ? a.r - c.r : null; };

/**
 * Pure: what the resolved setups teach. Per arm, the mean R, the fill and target rates and the mean
 * difference against the plan; per context, each arm's shrunk gain and the pick.
 */
export function learn(setups, { prior = PLAN_RULES.prior, margin = PLAN_RULES.margin_r, minPick = PLAN_RULES.min_pick_setups } = {}) {
  const list = (setups || []).filter((s) => finite(s.results?.[CONTROL_ARM]?.r));
  const sum = {}, byCtx = {};
  const arms = PLAN_ARMS.map((arm) => {
    let n = 0, r = 0, d = 0, f = 0, t = 0;
    for (const s of list) {
      const x = s.results[arm.id];
      if (!finite(x?.r)) continue;
      const diff = x.r - s.results[CONTROL_ARM].r;
      n += 1; r += x.r; d += diff; f += x.f ? 1 : 0; t += x.s === "target" ? 1 : 0;
      const c = (byCtx[s.context] ??= {}), a = (c[arm.id] ??= { n: 0, d: 0 });
      a.n += 1; a.d += diff;
    }
    sum[arm.id] = { n, est: n ? d / (n + prior) : 0 };
    return { ...arm, n, mean_r: n ? r3(r / n) : null, mean_diff: n ? r3(d / n) : null, gain: r3(sum[arm.id].est), fill_rate: n ? r3(f / n) : null, target_rate: f ? r3(t / f) : null };
  });
  const best = (est) => {
    let pick = CONTROL_ARM, top = margin;
    for (const arm of PLAN_ARMS) if (arm.id !== CONTROL_ARM && sum[arm.id].n >= minPick && est(arm.id) > top) { pick = arm.id; top = est(arm.id); }
    return { pick, gain: pick === CONTROL_ARM ? 0 : r3(top) };
  };
  const global = best((id) => sum[id].est);
  const counts = {};
  for (const s of list) counts[s.context] = (counts[s.context] || 0) + 1;
  const contexts = Object.keys(byCtx).sort().map((context) => {
    const est = (id) => { const a = byCtx[context][id]; return a ? (a.d + prior * sum[id].est) / (a.n + prior) : sum[id].est; };
    return { context, n: counts[context] || 0, ...best(est), gains: Object.fromEntries(PLAN_ARMS.filter((a) => a.id !== CONTROL_ARM).map((a) => [a.id, r3(est(a.id))])) };
  });
  return { setups: list.length, arms, global, contexts };
}

/** Pure: the arm a learned state picks for a context (the pick over every context for one not seen yet). */
export function pickFor(state, context) {
  const c = (state?.contexts || []).find((x) => x.context === context);
  return (c ?? state?.global)?.pick ?? CONTROL_ARM;
}

/**
 * Pure: the referee. Each setup's pick comes from the setups resolved before it opened; its result is
 * compared with the plan's on that setup. The newest part is held out of the sign test.
 */
export function walkForward(setups, rules = PLAN_RULES) {
  const list = (setups || []).filter((s) => finite(s.results?.[CONTROL_ARM]?.r) && finite(s.opened_ms)).sort((a, b) => a.opened_ms - b.opened_ms);
  const byResolved = list.slice().sort((a, b) => (a.resolved_ms ?? Infinity) - (b.resolved_ms ?? Infinity));
  const steps = [];
  let known = 0, state = null, at = -1;
  for (const s of list) {
    while (known < byResolved.length && (byResolved[known].resolved_ms ?? Infinity) <= s.opened_ms) known += 1;
    if (known !== at) { state = learn(byResolved.slice(0, known), { prior: rules.prior, margin: rules.margin_r, minPick: rules.min_pick_setups }); at = known; }
    const pick = pickFor(state, s.context);
    const d = pick === CONTROL_ARM ? 0 : diffOf(s, pick) ?? 0;
    steps.push({ pick, d, opened_ms: s.opened_ms, resolved_ms: s.resolved_ms ?? s.opened_ms });
  }
  // The engine writes a new plan at almost every 15m close, so setups overlap and share one price move
  // (production 2026-11-13: 189 setups in four days, 1.2 decisions each). The sign test counts only setups
  // that opened after the one counted before them had ended, as independent trades.
  const independent = [];
  let free = -Infinity;
  for (const x of steps) if (x.opened_ms >= free) { independent.push(x); free = x.resolved_ms; }
  const part = (xs) => {
    const wins = xs.filter((x) => x.d > 0).length, losses = xs.filter((x) => x.d < 0).length;
    return { setups: xs.length, picked: xs.filter((x) => x.pick !== CONTROL_ARM).length, pick_better: wins, plan_better: losses, mean_diff: xs.length ? r3(xs.reduce((a, x) => a + x.d, 0) / xs.length) : null, p_value: signTestP(wins, losses) };
  };
  const n = independent.length;
  const hold = n >= rules.min_setups ? Math.max(rules.holdout_min, Math.round(n * rules.holdout_share)) : 0;
  const discovery = part(independent.slice(0, n - hold)), holdout = hold ? part(independent.slice(-hold)) : null;
  const decisive = discovery.pick_better + discovery.plan_better;
  const verdict = n < rules.min_setups || decisive < rules.min_decisive ? "collecting"
    : finite(discovery.p_value) && discovery.p_value < SHADOW_SIGNIFICANCE && discovery.mean_diff > 0 && holdout && holdout.mean_diff > 0 ? "better_than_plan" : "not_better";
  return { setups: list.length, independent: n, all: part(steps), discovery, holdout, verdict, needs: { independent: rules.min_setups, decisive: rules.min_decisive } };
}

/**
 * Pure: the learned placement for a decision's trade, or null when the learner keeps the plan (or the
 * decision has no trade). Advice only: it is shown beside the plan and changes nothing.
 */
export function planAdviceFor(decision, state) {
  const t = decision?.trade;
  if (!t || !state?.learned) return null;
  const plan = { side: t.side, entry: t.entry, stop: t.stop, tp1: t.tp, atr_h1: decision?.strategy?.atr_h1, mode: decision?.trading_mode, regime: decision?.context?.regime_1h };
  const context = contextOf(plan), pick = pickFor(state.learned, context);
  const arm = PLAN_ARMS.find((a) => a.id === pick);
  if (!arm || pick === CONTROL_ARM) return { context, arm: CONTROL_ARM, keeps_plan: true };
  const v = variantOf(plan, arm);
  if (!v) return { context, arm: CONTROL_ARM, keeps_plan: true };
  const seen = (state.learned.contexts || []).find((c) => c.context === context);
  return { context, arm: pick, keeps_plan: false, entry_shift: arm.entry_shift, stop_scale: arm.stop_scale, entry: v.entry, stop: v.stop, tp: v.tp1, rrr: v.rrr, plan_rrr: finite(t.rrr) ? t.rrr : null, gain: (seen ?? state.learned.global).gain, context_setups: seen?.n ?? 0, verdict: state.walk_forward?.verdict ?? "collecting" };
}

// ---------------------------------------------------------------------------
// Storage and the run.

export const PLAN_LEARNING_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS plan_setups (
    setup_key TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'zone_pullback',
    opened_at TEXT NOT NULL, decided_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, decisions INTEGER NOT NULL DEFAULT 1,
    side TEXT NOT NULL, entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, atr_h1 REAL NOT NULL,
    mode TEXT, action TEXT, at_level INTEGER NOT NULL DEFAULT 0, regime TEXT, context TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT, results_json TEXT,
    version TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_plan_setups_status ON plan_setups(status, opened_at)"
];
let schemaReady = false;
export function resetPlanLearningSchemaCacheForTests() { schemaReady = false; }
export async function ensurePlanLearningSchema(db) {
  if (schemaReady) return;
  for (const sql of PLAN_LEARNING_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

async function loadDecisions(db, sinceIso) {
  const rows = (await db.prepare(`SELECT decision_key, decided_at, stance,
      json_extract(decision_json, '$.trade.side') AS side, json_extract(decision_json, '$.trade.entry') AS entry, json_extract(decision_json, '$.trade.stop') AS stop,
      json_extract(decision_json, '$.trade.tp') AS tp, json_extract(decision_json, '$.trade.action') AS action, json_extract(decision_json, '$.trade.at_level') AS at_level,
      json_extract(decision_json, '$.strategy.atr_h1') AS atr_h1, json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.context.regime_1h') AS regime,
      json_extract(decision_json, '$.strategy_plans') AS plans
    FROM engine_decisions WHERE stance IN ('BUY', 'SELL') AND bar_close >= ? ORDER BY bar_close`).bind(sinceIso).all()).results || [];
  return rows.filter((r) => r.side === r.stance).flatMap(decisionPlans).filter((d) => finite(d.close_ms)).sort((a, b) => a.close_ms - b.close_ms);
}

/**
 * Pure: the plans one directional decision row holds, one per strategy agent that saw its setup on the
 * decided side (`plans`: the record's strategy_plans, src/strategy-agents.mjs). A decision of before the
 * agents holds one: its trade, the default agent's.
 */
export function decisionPlans(r) {
  const base = { key: r.decision_key, close_ms: decisionCloseMs(r.decision_key), decided_at: r.decided_at, side: r.side, atr_h1: Number(r.atr_h1), mode: r.mode, regime: r.regime };
  let plans = r.plans;
  if (typeof plans === "string") { try { plans = JSON.parse(plans); } catch { plans = null; } }
  const mine = plans && typeof plans === "object" ? plans[r.side === "BUY" ? "long" : "short"] : null;
  const list = Object.entries(mine && typeof mine === "object" ? mine : {}).filter(([, p]) => p && typeof p === "object")
    .map(([agent, p]) => ({ ...base, agent, entry: Number(p.entry), stop: Number(p.stop), tp1: Number(p.tp1), action: p.at_level ? "ENTER_MARKET" : "ENTER_LIMIT", at_level: p.at_level === true }));
  if (list.length) return list;
  return [{ ...base, agent: DEFAULT_PLAN_AGENT, entry: Number(r.entry), stop: Number(r.stop), tp1: Number(r.tp), action: r.action, at_level: r.at_level === 1 || r.at_level === true }];
}

/**
 * Pure: each strategy agent's own record on its resolved setups (its plan as it is, the control arm): the
 * setups, the mean R per setup, how often it filled and reached its target, and the same per context.
 */
export function agentRecords(setups) {
  const by = {};
  for (const s of setups || []) {
    const x = s.results?.[CONTROL_ARM];
    if (!finite(x?.r)) continue;
    const a = (by[s.agent ?? DEFAULT_PLAN_AGENT] ??= { n: 0, r: 0, f: 0, t: 0, st: 0, ctx: {} });
    const c = (a.ctx[s.context] ??= { n: 0, r: 0 });
    a.n += 1; a.r += x.r; a.f += x.f ? 1 : 0; a.t += x.s === "target" ? 1 : 0; a.st += x.s === "stop" ? 1 : 0; c.n += 1; c.r += x.r;
  }
  return Object.keys(by).sort().map((agent) => {
    const a = by[agent];
    return { agent, setups: a.n, mean_r: r3(a.r / a.n), fill_rate: r3(a.f / a.n), target_rate: a.f ? r3(a.t / a.f) : null, stop_rate: a.f ? r3(a.st / a.f) : null, contexts: Object.keys(a.ctx).sort().map((context) => ({ context, setups: a.ctx[context].n, mean_r: r3(a.ctx[context].r / a.ctx[context].n) })) };
  });
}

/** One D1 batch (one subrequest: the first run stores the whole stored history), else one statement at a time. */
async function runAll(db, statements) {
  if (!statements.length) return;
  if (typeof db.batch === "function") { for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50)); return; }
  for (const st of statements) await st.run();
}

const fromRow = (r) => {
  let results = null;
  try { results = r.results_json ? JSON.parse(r.results_json) : null; } catch { results = null; }
  const s = { setup_key: r.setup_key, decision_key: r.decision_key, agent: r.agent ?? DEFAULT_PLAN_AGENT, opened_ms: toMs(r.opened_at), decided_ms: toMs(r.decided_at), last_seen_ms: toMs(r.last_seen_at), decisions: Number(r.decisions) || 1, side: r.side, entry: r.entry, stop: r.stop, tp1: r.tp1, atr_h1: r.atr_h1, mode: r.mode ?? null, action: r.action ?? null, at_level: r.at_level === 1, regime: r.regime ?? null, context: r.context, status: r.status, resolved_ms: r.resolved_at ? toMs(r.resolved_at) : null, results };
  return s;
};

/**
 * One run: new setups from the engine's decisions, the replay of the setups that ended, and the learned
 * state (KV). Never throws; never touches a decision.
 */
export async function runPlanLearning(env, { now = Date.now(), bars = null } = {}) {
  if (planLearningMode(env) === "off") return { status: "disabled" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensurePlanLearningSchema(db);
    const empty = !(await db.prepare("SELECT setup_key FROM plan_setups LIMIT 1").first());
    const since = now - (empty ? PLAN_RULES.backfill_days : PLAN_RULES.window_days) * DAY;
    const decisions = await loadDecisions(db, iso(since));
    const known = new Map(((await db.prepare("SELECT setup_key, last_seen_at, status FROM plan_setups WHERE opened_at >= ?").bind(iso(since)).all()).results || []).map((r) => [r.setup_key, r]));
    let added = 0, extended = 0;
    const writes = [];
    for (const s of setupsFrom(decisions)) {
      const k = known.get(s.setup_key), stamp = iso(now);
      if (!k) {
        // A plan already running when the window starts is the tail of an older setup, not a new one.
        if (!empty && s.opened_ms - since < HOUR) continue;
        writes.push(db.prepare("INSERT OR IGNORE INTO plan_setups (setup_key, decision_key, agent, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
          .bind(s.setup_key, s.decision_key, s.agent, iso(s.opened_ms), iso(s.decided_ms), iso(s.last_seen_ms), s.decisions, s.side, s.entry, s.stop, s.tp1, s.atr_h1, s.mode, s.action, s.at_level ? 1 : 0, s.regime, s.context, PLAN_LEARNING_VERSION, stamp));
        added += 1;
      } else if (k.status === "open" && toMs(k.last_seen_at) < s.last_seen_ms) {
        writes.push(db.prepare("UPDATE plan_setups SET last_seen_at = ?, decisions = ?, updated_at = ? WHERE setup_key = ? AND status = 'open'").bind(iso(s.last_seen_ms), s.decisions, stamp, s.setup_key));
        extended += 1;
      }
    }
    await runAll(db, writes);
    // A setup replayed by an older version of the rules is replayed again.
    await db.prepare("UPDATE plan_setups SET status = 'open', results_json = NULL, resolved_at = NULL, version = ? WHERE version <> ? AND status IN ('resolved', 'unavailable')").bind(PLAN_LEARNING_VERSION, PLAN_LEARNING_VERSION).run();
    // The setups the engine no longer repeats are replayed until every arm is final.
    const open = ((await db.prepare("SELECT * FROM plan_setups WHERE status = 'open' AND last_seen_at <= ? ORDER BY opened_at LIMIT 200").bind(iso(now - PLAN_RULES.setup_gap_ms)).all()).results || []).map(fromRow);
    let resolved = 0, unavailable = 0;
    if (open.length) {
      const series = bars ?? (await ledgerSeries(env)).bars;
      const updates = [];
      for (const s of open) {
        const out = replaySetup(s, series, { now });
        if (out.status === "open") continue;
        updates.push(db.prepare("UPDATE plan_setups SET status = ?, resolved_at = ?, results_json = ?, updated_at = ? WHERE setup_key = ?").bind(out.status, iso(out.resolved_ms ?? now), out.status === "resolved" ? JSON.stringify(out.results) : null, iso(now), s.setup_key));
        if (out.status === "resolved") resolved += 1; else unavailable += 1;
      }
      await runAll(db, updates);
    }
    const previous = await readPlanLearning(env);
    if (!added && !extended && !resolved && !unavailable && previous?.version === PLAN_LEARNING_VERSION) return { status: "unchanged", setups: previous.setups?.resolved ?? 0 };
    const state = await buildState(db, { now });
    await env.SIGNAL_CACHE?.put?.(PLAN_LEARNING_KEY, JSON.stringify(state));
    return { status: "ok", added, extended, resolved, unavailable, setups: state.setups.resolved, verdict: state.walk_forward.verdict, global_pick: state.learned.global.pick };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function buildState(db, { now }) {
  const rows = ((await db.prepare("SELECT * FROM plan_setups WHERE status = 'resolved' AND opened_at >= ? ORDER BY opened_at").bind(iso(now - PLAN_RULES.learn_days * DAY)).all()).results || []).map(fromRow);
  const counts = (await db.prepare("SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable, MIN(opened_at) AS since FROM plan_setups").first()) || {};
  return {
    version: PLAN_LEARNING_VERSION, generated_at: iso(now), mode: "shadow",
    grid: { entry_shifts: ENTRY_SHIFTS, stop_scales: STOP_SCALES, control: CONTROL_ARM },
    rules: { market_band: PLAN_RULES.market_band, prior: PLAN_RULES.prior, margin_r: PLAN_RULES.margin_r, min_pick_setups: PLAN_RULES.min_pick_setups, min_risk_atr: PLAN_RULES.min_risk_atr, hold_max_hours: PLAN_RULES.hold_max_ms / HOUR, fill_window_max_hours: FILL_WINDOW_MS / HOUR, learn_days: PLAN_RULES.learn_days, significance: SHADOW_SIGNIFICANCE },
    setups: { resolved: rows.length, open: Number(counts.open) || 0, unavailable: Number(counts.unavailable) || 0, since: counts.since ?? null },
    // The grid is learned on the default agent's plans; every agent's own record stands beside it.
    learned: learn(rows.filter((s) => s.agent === DEFAULT_PLAN_AGENT)),
    walk_forward: walkForward(rows.filter((s) => s.agent === DEFAULT_PLAN_AGENT)),
    agents: agentRecords(rows)
  };
}

/** The learned state (KV), or null. */
export async function readPlanLearning(env) {
  try { return JSON.parse((await env?.SIGNAL_CACHE?.get?.(PLAN_LEARNING_KEY)) || "null"); } catch { return null; }
}
