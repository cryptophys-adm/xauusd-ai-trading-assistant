import test from "node:test";
import assert from "node:assert/strict";
import {
  FRESH_PATTERN, FRESH_PATTERN_REVERT, FRESH_PATTERN_REVERT_KEY, FRESH_PATTERN_SOURCE, freshPatternModeOf, resolveFreshPattern, resolveFreshPatternMode,
  breakoutAgeBars, freshPlansRecord, freshPatternVerdict, freshPatternRevert, freshPatternRevertLine, readFreshPatternHold
} from "../src/fresh-pattern.mjs";
import { STRATEGY_AGENTS, freshPatternPlans, withFreshPlans, slimPlan } from "../src/strategy-agents.mjs";
import { assess, buildDecisionRecord, decisionKeyFor, councilEvidence } from "../src/decision-engine.mjs";
import { freshSetupsFrom } from "../src/plan-learning.mjs";
import { FEATURE_SWITCH_OVERRIDDEN, switchByKey, readSwitch } from "../src/feature-switches.mjs";

const agent = (id) => STRATEGY_AGENTS.find((a) => a.id === id);
/** Closed 15m bars from [low, high, close] rows (oldest first). */
const bars = (rows) => rows.map(([low, high, close], i) => ({ open_time: new Date(Date.UTC(2026, 10, 27, 2, 15 * i)).toISOString(), open: close, low, high, close }));
const flat = (n, low, high, close) => Array.from({ length: n }, () => [low, high, close]);
// The 27 Nov shape, at a made-up price: a 15m descending broadening wedge whose upper line (4000) a close broke; a key
// zone just ahead (4006) where TP1-KZ put TP1 0.2R away, so the agent had no plan; the measured target pays 1.2R.
const WEDGE = { tf: "15", chart: "15m", id: "broadening_wedge_descending", name: "descending broadening wedge", status: "confirmed", direction: 1, upper: 4000, lower: 3985, height: 15, target: 4020, bars_ago: 8 };
// 40 quiet bars below the line (range 6: the detector's margin is 0.6), then `beyond` closes above 4000.6.
const run = (beyond) => bars([...flat(40, 3990, 3996, 3993), ...flat(beyond, 3999, 4005, 4003)]);
const ctx = (extra = {}) => ({ price: 4003, atr: 10, levels: [], scalp: false, keyZone: true, patterns: [WEDGE], calibration: null, suspendedPatterns: [], bars: run(1), ...extra });

test("FP-1 breakoutAgeBars: the closed bars since the close that broke the line, bounded by the pattern's last turn", () => {
  assert.equal(breakoutAgeBars(run(1), WEDGE), 0, "the latest close broke");
  assert.equal(breakoutAgeBars(run(2), WEDGE), 1);
  assert.equal(breakoutAgeBars(run(3), WEDGE), 2, "the third bar since the break: not fresh");
  assert.equal(breakoutAgeBars(run(12), WEDGE), 7, "bounded by bars_ago (8)");
  assert.equal(breakoutAgeBars(run(12), { ...WEDGE, bars_ago: 3 }), 2);
  assert.equal(breakoutAgeBars(bars(flat(41, 3990, 3996, 3993)), WEDGE), null, "the latest bar is not beyond the line");
  assert.equal(breakoutAgeBars(bars([...flat(40, 3990, 3996, 3993), [3995, 4001, 4000.4]]), WEDGE), null, "within the detector's margin");
  assert.equal(breakoutAgeBars(run(1), { ...WEDGE, direction: 0, status: "forming" }), null);
  assert.equal(breakoutAgeBars([], WEDGE), null);
  assert.equal(breakoutAgeBars(bars([...flat(40, 4004, 4010, 4007), ...flat(1, 3990, 3998, 3996.6)]), { ...WEDGE, direction: -1, lower: 3998 }), 0, "downward: below the lower line");
  assert.deepEqual([FRESH_PATTERN.max_age_bars, FRESH_PATTERN.min_target_r, FRESH_PATTERN.chart], [1, 1, "15"]);
});

test("FP-2 the 27 Nov wedge: no plan under TP1-KZ, a fresh plan at market to the measured target", () => {
  const lines = agent("pattern_lines");
  const ahead = [{ low: 4005.5, high: 4006.5, price: 4006, major: true, label: "4005.50–4006.50 key zone", kind: "supply" }];
  assert.equal(lines.plan(1, ctx({ levels: ahead })), null, "TP1-KZ: TP1 on the key zone 0.2R ahead, below the 1R floor");
  const fresh = freshPatternPlans(1, ctx({ levels: ahead }), { pattern_lines: "live" });
  assert.deepEqual(Object.keys(fresh), ["pattern_lines"]);
  const p = fresh.pattern_lines.plan;
  assert.deepEqual([fresh.pattern_lines.status, p.entry, p.at_level, p.stop, p.tp1, p.tp2, p.rrr.tp1, p.pattern, p.chart], ["live", 4003, true, 3989, 4020, 4027.5, 1.21, "broadening_wedge_descending", "15m"]);
  assert.deepEqual(p.fresh_pattern, { pattern: "broadening_wedge_descending", chart: "15m", breakout_age_bars: 0, target_r: 1.21 });
  assert.match(p.entry_note, /fresh breakout, entered at market/);
  assert.equal(freshPatternPlans(1, ctx({ bars: run(2) }), { pattern_lines: "live" }).pattern_lines.plan.fresh_pattern.breakout_age_bars, 1, "one closed bar after the break: still fresh");
  // Shadow agents get their fresh plan as their plan (recorded, never traded); an agent off gets none.
  assert.equal(freshPatternPlans(1, ctx(), {}).pattern_lines.status, "shadow");
  assert.deepEqual(freshPatternPlans(1, ctx(), { pattern_lines: "off" }), {});
});

test("FP-3 not fresh, not paying or held back: no fresh plan", () => {
  const none = (c) => assert.deepEqual(freshPatternPlans(1, ctx(c), { pattern_lines: "live" }), {});
  none({ bars: run(3) });                                        // a 3-bar-old breakout
  none({ patterns: [{ ...WEDGE, target: 4015 }] });              // the measured target pays 0.86R (< 1R): no key-zone fallback
  none({ patterns: [{ ...WEDGE, tf: "60", chart: "1H" }] });     // 15m only
  none({ suspendedPatterns: ["pattern_lines:broadening_wedge_descending"] });  // the pattern breaker
  none({ calibration: { patterns: { broadening_wedge_descending: { n: 40, rate: 0.2, factor: 0.5, active: true } } } });  // measured below the rate
  none({ price: 3997 });                                         // price fell back into the pattern
  assert.deepEqual(freshPatternPlans(-1, ctx(), { pattern_lines: "live" }), {}, "the other side");
  assert.deepEqual(freshPatternPlans(1, ctx(), { pattern_inside: "live", pattern_lines: "off" }), {}, "pattern_inside has no fresh plan");
});

test("FP-4 withFreshPlans: an agent without a plan takes its fresh plan; a plan on the same pattern carries fresh_pattern", () => {
  const fresh = freshPatternPlans(1, ctx(), { pattern_lines: "live" });
  const out = withFreshPlans({ zone_pullback: { status: "live", plan: { agent: "zone_pullback", entry: 1 } } }, fresh);
  assert.deepEqual(Object.keys(out), ["zone_pullback", "pattern_lines"]);
  assert.equal(out.pattern_lines.plan.fresh_pattern.target_r, 1.21);
  const own = { pattern_lines: { status: "live", plan: { agent: "pattern_lines", entry: 4000, pattern: "broadening_wedge_descending", chart: "15m" } } };
  assert.deepEqual(withFreshPlans(own, fresh).pattern_lines.plan, { ...own.pattern_lines.plan, fresh_pattern: fresh.pattern_lines.plan.fresh_pattern }, "its own plan stays; it carries the record");
  const other = { pattern_lines: { status: "live", plan: { agent: "pattern_lines", entry: 4000, pattern: "triangle_symmetrical", chart: "15m" } } };
  assert.deepEqual(withFreshPlans(other, fresh), other, "a plan on another pattern stays as it was");
  assert.equal(slimPlan(fresh.pattern_lines.plan).fresh_pattern.pattern, "broadening_wedge_descending");
});

test("FP-5 freshPlansRecord: only a side whose guardrails all pass is recorded", () => {
  const fresh = { long: freshPatternPlans(1, ctx(), { pattern_lines: "live" }), short: {} };
  assert.equal(freshPlansRecord(fresh, { long: { allowed: false }, short: { allowed: true } }, slimPlan), null, "a failing guardrail: no plan");
  const rec = freshPlansRecord(fresh, { long: { allowed: true }, short: { allowed: true } }, slimPlan);
  assert.deepEqual(Object.keys(rec), ["long"]);
  assert.deepEqual([rec.long.pattern_lines.status, rec.long.pattern_lines.tp1, rec.long.pattern_lines.fresh_pattern.breakout_age_bars], ["live", 4020, 0]);
});

// End to end, as the 15m decision runs it.
const CLOSE = "2026-11-27T12:15:00.000Z", NOW = Date.parse(CLOSE) + 60_000;
const room = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
const zones = [{ low: 3985, high: 3988, price: 3986.5, candidate: true }, { low: 4005.5, high: 4006.5, price: 4006, candidate: true }, { low: 3970, high: 3972, price: 3971, candidate: true }];
const loaded = (beyond = 1) => ({
  inputs: { calendar: { events: [] }, m15Bars: run(beyond) },
  strategy: { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4003, atr_h1: 10, key_levels: { zones, patterns: [WEDGE] }, plan: { at_level: true } },
  global: { timeframes: [room("D1", 0.5), room("H4", 0.4), room("H1", 0.3), room("M15", 0.35, "BUY"), room("NEWS", 0.2), room("MACRO", 0.1)] }, correlations: null, regime: "normal-trending"
});
const LIVE = { STRATEGY_AGENTS_LIVE: "pattern_lines" };
const council = (strategy) => ({ answer: { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "market", target: "tp1", ...(strategy ? { strategy } : {}), summary: "Decision BUY, bias bullish: the wedge broke.", reasons: ["The rooms lean bullish."], risks: [], weighed: [] } });
const decision = (env, { beyond = 1, strategy = "pattern_lines" } = {}) => {
  const l = loaded(beyond), assessment = assess(l, { now: NOW, env });
  return { assessment, record: buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded: l, assessment, council: council(strategy), now: NOW, env }) };
};

test("FP-6 on: the fresh plan is offered to the council even alone, chosen, and the trade carries fresh_pattern", () => {
  const { assessment, record } = decision({ ...LIVE, FRESH_PATTERN_MODE: "on" });
  const g = assessment.guards.long;
  assert.equal(g.allowed, true, JSON.stringify(g.checks.filter((c) => !c.pass)));
  const ev = councilEvidence({ barClose: CLOSE, cards: [], quorum: assessment.quorum, guards: { long: { ...g, plans: { pattern_lines: g.plans.pattern_lines } }, short: assessment.guards.short } });
  assert.deepEqual(ev.long.strategies.map((s) => [s.id, s.fresh_breakout]), [["pattern_lines", { chart: "15m", closed_bars_ago: 0, measured_target_r: 1.21 }]], "the only live plan is offered");
  // The mode's reward rule still picks the target: TP1 pays 1.21R, below intraday's 1.5R, so the trade takes TP2 (1.75R).
  assert.deepEqual([record.stance, record.trade.strategy, record.trade.entry, record.trade.target, record.trade.tp, record.trade.action], ["BUY", "pattern_lines", 4003, "tp2", 4027.5, "ENTER_MARKET"]);
  assert.deepEqual(record.trade.fresh_pattern, { pattern: "broadening_wedge_descending", chart: "15m", breakout_age_bars: 0, target_r: 1.21 });
  assert.equal(record.fresh_pattern_mode, "on");
  assert.equal(record.fresh_plans.long.pattern_lines.fresh_pattern.target_r, 1.21);
  assert.equal(record.strategy_plans.long.pattern_lines.fresh_pattern.pattern, "broadening_wedge_descending");
});

test("FP-7 record: recorded, never offered nor traded; off: nothing; a 3-bar-old breakout: nothing", () => {
  const rec = decision({ ...LIVE, FRESH_PATTERN_MODE: "record" }).record;
  assert.equal(rec.fresh_pattern_mode, "record");
  assert.equal(rec.fresh_plans.long.pattern_lines.tp1, 4020);
  assert.equal(rec.strategy_plans.long.pattern_lines, undefined, "not among the agents' plans");
  assert.notEqual(rec.trade?.strategy, "pattern_lines");
  assert.equal(rec.trade?.fresh_pattern, undefined);
  const off = decision({ ...LIVE }).record;
  assert.deepEqual(["fresh_pattern_mode" in off, "fresh_plans" in off], [false, false], "off (the code default): the record is as before");
  const stale = decision({ ...LIVE, FRESH_PATTERN_MODE: "on" }, { beyond: 3 }).record;
  assert.equal(stale.fresh_plans, undefined);
  assert.equal(stale.trade?.fresh_pattern, undefined);
  // The plan learner's own rows (source pattern_fresh), whatever the council chose.
  const row = { decision_key: rec.decision_key, decided_at: rec.decided_at, atr_h1: 10, mode: rec.trading_mode, regime: "normal-trending", plans: JSON.stringify(rec.fresh_plans) };
  const setups = freshSetupsFrom([row]);
  assert.equal(setups.length, 1);
  assert.deepEqual([setups[0].source, setups[0].agent, setups[0].side, setups[0].entry, setups[0].tp1, setups[0].setup_key.startsWith("fresh:")], [FRESH_PATTERN_SOURCE, "pattern_lines", "BUY", 4003, 4020, true]);
});

const kvOf = (m = new Map()) => ({ m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } });

test("FP-8 the mode in force: the owner's override > the automatic revert > env; unreadable: record", async () => {
  assert.deepEqual([freshPatternModeOf({}), freshPatternModeOf({ FRESH_PATTERN_MODE: " ON " }), freshPatternModeOf({ FRESH_PATTERN_MODE: "x" })], ["off", "on", "off"]);
  const reverted = { status: "reverted" };
  assert.deepEqual(resolveFreshPattern({ env: { FRESH_PATTERN_MODE: "on" }, revert: reverted }), { value: "record", source: "auto_revert", env_value: "on" });
  assert.deepEqual(resolveFreshPattern({ env: { FRESH_PATTERN_MODE: "on", [FEATURE_SWITCH_OVERRIDDEN]: ["FRESH_PATTERN_MODE"] }, revert: reverted }).value, "on", "the owner wins");
  assert.deepEqual(resolveFreshPattern({ env: { FRESH_PATTERN_MODE: "on" }, revert: { status: "kept" } }).value, "on");
  const kv = kvOf();
  kv.m.set(FRESH_PATTERN_REVERT_KEY, JSON.stringify(reverted));
  assert.equal((await resolveFreshPatternMode({ FRESH_PATTERN_MODE: "on", SIGNAL_CACHE: kv })).value, "record");
  assert.equal((await resolveFreshPatternMode({ FRESH_PATTERN_MODE: "on", SIGNAL_CACHE: { get: async () => { throw new Error("kv"); } } })).value, "record");
  assert.equal((await resolveFreshPatternMode({ FRESH_PATTERN_MODE: "off", SIGNAL_CACHE: kv })).value, "off");
  // FS1: the panel row and its hold.
  const e = switchByKey("FRESH_PATTERN_MODE");
  assert.deepEqual([e.group, e.default_value, e.config_value, e.hold, e.hold_value, [...e.values]], ["plans", "off", "on", "fresh-pattern", "record", ["on", "record", "off"]]);
  assert.deepEqual(["on", "RECORD", "nope", undefined].map((v) => readSwitch(e, v)), ["on", "record", "off", "off"]);
  assert.equal(await readFreshPatternHold(kvOf()), null);
  kv.m.set(FRESH_PATTERN_REVERT_KEY, JSON.stringify({ ...reverted, at: "2026-12-05T00:00:00.000Z" }));
  assert.deepEqual(await readFreshPatternHold(kv), { since: "2026-12-05T00:00:00.000Z", until: null });
});

/** A D1 stand-in for the revert's reads (fresh decisions, their entry intents, the deals) and its one Omega event. */
function dbOf({ trades }) {
  const events = [];
  const db = {
    events,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        all: async () => {
          if (sql.includes("FROM engine_decisions")) return { results: trades.map((t) => ({ decision_key: `xauusd:15m:${t.ms}` })) };
          if (sql.includes("FROM ea_deals")) { const t = trades.find((x) => x.ticket === args[0]); return { results: t ? t.deals : [] }; }
          return { results: [] };
        },
        first: async () => {
          if (sql.includes("FROM omega_intents")) { const t = trades.find((x) => x.ms === args[0]); return t ? { payload: JSON.stringify({ side: "BUY", lot: 0.1, r_dist: 10, planned_entry: 4000 }), result: JSON.stringify({ ticket: t.ticket, fill_price: 4000 }) } : null; }
          return null;
        },
        run: async () => { if (sql.includes("INSERT INTO omega_events")) events.push(args); return {}; }
      };
      return stmt;
    }
  };
  return db;
}
const tradesAt = (rs) => rs.map((r, i) => ({ ms: 1_800_000_000_000 + i * 900_000, ticket: 1000 + i, deals: [{ volume: 0.1, exit_price: 4000 + r * 10 }] }));

test("FP-9 the automatic revert: after 30 closed fresh trades a mean below +0.10R sets record once (one event, one Telegram line)", async () => {
  assert.deepEqual(freshPatternVerdict([0.5, -1]), { n: 2, mean_r: -0.25, ready: false, revert: false });
  assert.equal(FRESH_PATTERN_REVERT.trades, 30);
  const sent = [], send = async (t) => { sent.push(t); };
  const env = (db, kv, extra = {}) => ({ FRESH_PATTERN_MODE: "on", DB: db, SIGNAL_CACHE: kv, ...extra });
  // 29 closed: waiting.
  const kv = kvOf();
  assert.deepEqual(await freshPatternRevert(env(dbOf({ trades: tradesAt(Array(29).fill(-0.2)) }), kv), { send }), { status: "waiting", n: 29, mean_r: -0.2 });
  // 30 closed below +0.10R: reverted.
  const db = dbOf({ trades: tradesAt([...Array(15).fill(1), ...Array(15).fill(-0.9)]) });
  const out = await freshPatternRevert(env(db, kv), { send, now: Date.parse("2026-12-05T00:00:00Z") });
  assert.deepEqual(out, { status: "reverted", n: 30, mean_r: 0.05 });
  assert.equal(JSON.parse(kv.m.get(FRESH_PATTERN_REVERT_KEY)).status, "reverted");
  assert.deepEqual([db.events.length, db.events[0][1]], [1, "fresh_pattern_reverted"]);
  assert.deepEqual(sent, [freshPatternRevertLine({ n: 30, mean_r: 0.05 })]);
  assert.match(sent[0], /set to record: its first 30 trades averaged \+0\.05R at the broker, below \+0\.1R/);
  assert.doesNotMatch(sent[0], /lot|account|ticket/i);
  assert.equal((await resolveFreshPatternMode(env(db, kv))).value, "record");
  // Once: the next step does nothing.
  assert.deepEqual(await freshPatternRevert(env(db, kv), { send }), { status: "done", verdict: "reverted" });
  assert.equal(sent.length, 1);
  // A good record is kept (no Telegram), the owner's override and a mode other than on run nothing.
  const kept = kvOf(), dbk = dbOf({ trades: tradesAt(Array(30).fill(0.4)) });
  assert.equal((await freshPatternRevert(env(dbk, kept), { send })).status, "kept");
  assert.deepEqual([dbk.events[0][1], sent.length], ["fresh_pattern_kept", 1]);
  assert.equal((await freshPatternRevert(env(dbk, kvOf(), { [FEATURE_SWITCH_OVERRIDDEN]: ["FRESH_PATTERN_MODE"] }), { send })).status, "owner");
  assert.equal((await freshPatternRevert(env(dbk, kvOf(), { FRESH_PATTERN_MODE: "record" }), { send })).status, "inactive");
  // A trade not closed in full ends the window there.
  const open = tradesAt(Array(30).fill(-1)); open[3].deals = [{ volume: 0.05, exit_price: 3990 }];
  assert.deepEqual(await freshPatternRevert(env(dbOf({ trades: open }), kvOf()), { send }), { status: "waiting", n: 3, mean_r: -1 });
});

test("FP-10 the plan learner's hourly run: pattern_fresh rows of a WAIT decision, replayed on the control arm only, apart from the live record", async () => {
  const { d1, kv } = await import("./fixtures/mode-shadow.mjs");
  const pl = await import("../src/plan-learning.mjs");
  pl.resetPlanLearningSchemaCacheForTests();
  const M1 = 60_000, M15 = 15 * M1, HOUR = 60 * M1, T0 = Date.parse("2026-11-26T10:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), FRESH_PATTERN_MODE: "record" };
  env.DB.raw.exec("CREATE TABLE IF NOT EXISTS engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, stance TEXT NOT NULL, decision_json TEXT NOT NULL)");
  const fresh = { long: { pattern_lines: { status: "live", entry: 4000, stop: 3990, tp1: 4015, tp2: 4020, at_level: true, pattern: "broadening_wedge_descending", chart: "15m", fresh_pattern: { pattern: "broadening_wedge_descending", chart: "15m", breakout_age_bars: 0, target_r: 1.5 } } } };
  env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, decision_json) VALUES (?, ?, ?, ?, ?)")
    .run(`OANDA:XAUUSD:15:${T0 - M15}`, iso(T0), iso(T0 + M1), "WAIT", JSON.stringify({ trading_mode: "intraday", context: { regime_1h: "normal-trending" }, strategy: { atr_h1: 10 }, strategy_plans: {}, trade: {}, fresh_pattern_mode: "record", fresh_plans: fresh }));
  // 1m bars rising 0.25 a minute from 4000: the market entry at 4000 reaches 4015 in an hour.
  const rising = Array.from({ length: 240 }, (_, i) => ({ open_time: iso(T0 + i * M1), close_time: iso(T0 + (i + 1) * M1), open: 4000 + i * 0.25, high: 4000.5 + i * 0.25, low: 3999.5 + i * 0.25, close: 4000.25 + i * 0.25 }));
  const out = await pl.runPlanLearning(env, { now: T0 + 3 * HOUR, bars: rising });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.pattern_fresh, { added: 1, extended: 0, resolved: 1, unavailable: 0 });
  const rows = env.DB.raw.prepare("SELECT setup_key, side, agent, source, rule_version, status, results_json FROM plan_setups").all();
  assert.deepEqual(rows.map((r) => [r.setup_key.startsWith("fresh:"), r.side, r.agent, r.source, r.rule_version, r.status]), [[true, "BUY", "pattern_lines", "pattern_fresh", "fresh_pattern@1", "resolved"]]);
  assert.deepEqual(Object.keys(JSON.parse(rows[0].results_json)), [pl.CONTROL_ARM], "the control arm only");
  assert.equal(JSON.parse(rows[0].results_json)[pl.CONTROL_ARM].s, "target");
  assert.equal(JSON.parse(await env.SIGNAL_CACHE.get(pl.PLAN_LEARNING_KEY)).setups.resolved, 0, "the live record does not count it");
  // Off: no rows, no queue.
  pl.resetPlanLearningSchemaCacheForTests();
  const offEnv = { ...env, DB: d1(), SIGNAL_CACHE: kv(), FRESH_PATTERN_MODE: "off" };
  assert.equal("pattern_fresh" in (await pl.runPlanLearning(offEnv, { now: T0 + 3 * HOUR, bars: rising })), false);
});
