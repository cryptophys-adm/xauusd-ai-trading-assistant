// Range shadow (src/range-shadow.mjs; owner via the orchestrator 2026-11-27: "setuju c1 + c2 sekalian b"): c1 the range
// key, c2 the both-side setups (source range_both) with their cap, their fill rule and their isolation from everything
// that arms or gates live trading, b the intraday range episodes, and GET /api/range-shadow. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as rs from "../src/range-shadow.mjs";
import * as pl from "../src/plan-learning.mjs";
import * as ms from "../src/mode-selector.mjs";
import { ruleVersionOf } from "../src/mode-shadow.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const M1 = 60_000, M15 = 15 * M1, HOUR = 60 * M1, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-26T10:00:00.000Z"); // a 15m close (and an hourly one)
const keyOf = (closeMs) => `OANDA:XAUUSD:15:${closeMs - M15}`;

const plansBoth = () => ({
  long: { range_fade: { entry: 4000, stop: 3990, tp1: 4015, at_level: false }, zone_pullback: { entry: 3999, stop: 3989, tp1: 4014, at_level: false } },
  short: { range_fade: { entry: 4020, stop: 4030, tp1: 4005, at_level: false } }
});
function engineTable(db) {
  db.raw.exec("CREATE TABLE IF NOT EXISTS engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, stance TEXT NOT NULL, decision_json TEXT NOT NULL)");
}
function insertDecision(db, closeMs, { stance = "WAIT", regime = "normal-ranging", plans = plansBoth(), mode = "intraday" } = {}) {
  engineTable(db);
  db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, decision_json) VALUES (?, ?, ?, ?, ?)")
    .run(keyOf(closeMs), iso(closeMs), iso(closeMs + M1), stance, JSON.stringify({ trading_mode: mode, context: { regime_1h: regime }, strategy: { atr_h1: 10 }, strategy_plans: plans, trade: {} }));
}
/** 1m bars from `from`, rising 0.25 a minute from 4000: a long limit at 4000 fills and reaches 4015; a short at 4020 is reached only after 80 minutes. */
const rising = (from, n = 240) => Array.from({ length: n }, (_, i) => ({ open_time: iso(from + i * M1), close_time: iso(from + (i + 1) * M1), open: 4000 + i * 0.25, high: 4000.5 + i * 0.25, low: 3999.5 + i * 0.25, close: 4000.25 + i * 0.25 }));
const envOf = (extra = {}) => ({ DB: d1(), SIGNAL_CACHE: kv(), RANGE_SHADOW_MODE: "on", ...extra });
const reset = () => { pl.resetPlanLearningSchemaCacheForTests(); rs.resetRangeEpisodesSchemaForTests(); rs.resetRangeShadowLogForTests(); };

test("RS-1 c1: the range key keeps the range tokens only; null for none; the rule in force maps to itself", () => {
  assert.equal(rs.rangeKeyOf("tp1_kz:on+zone_ahead@1+zone_aim@1:qualified"), "tp1_kz:on+zone_ahead@1+zone_aim@1:qualified");
  assert.equal(rs.rangeKeyOf("tp1_kz:on+zone_ahead@1+future_token@2"), "tp1_kz:on+zone_ahead@1", "a token that does not touch range plans is dropped");
  assert.equal(rs.rangeKeyOf("tp1_kz:off"), "tp1_kz:off");
  assert.equal(rs.rangeKeyOf(null), null);
  assert.equal(rs.rangeKeyOf(""), null);
  assert.equal(rs.rangeKeyOf("v"), "v", "a version with no range token is its own key");
  assert.equal(rs.rangeRuleVersionOf({}), rs.rangeKeyOf(ruleVersionOf({})));
  assert.equal(rs.rangeShadowMode({}), "off", "default off");
  assert.equal(rs.rangeShadowMode({ RANGE_SHADOW_MODE: " ON " }), "on");
  assert.equal(rs.rangeShadowMode({ RANGE_SHADOW_MODE: "shadow" }), "off");
});

test("RS-2 c2: both sides' range strategy plans while ranging, any stance; never another agent or a trending decision", () => {
  const row = (closeMs, regime, plans = plansBoth()) => ({ decision_key: keyOf(closeMs), decided_at: iso(closeMs + M1), atr_h1: 10, mode: "intraday", regime, plans: JSON.stringify(plans) });
  const out = pl.rangeBothSetupsFrom([row(T0, "normal-ranging"), row(T0 + M15, "high-ranging"), row(T0 + 2 * M15, "normal-trending")], { rangeKey: "k" });
  assert.deepEqual(out.map((s) => [s.setup_key, s.side, s.agent, s.source, s.rule_version, s.decisions]), [
    [`rangeboth:${keyOf(T0)}:BUY:range_fade`, "BUY", "range_fade", "range_both", "k", 2],
    [`rangeboth:${keyOf(T0)}:SELL:range_fade`, "SELL", "range_fade", "range_both", "k", 2]
  ]);
  assert.equal(out[0].last_seen_ms, T0 + M15, "the repeated plan extends the setup; the trending decision does not");
  assert.deepEqual(pl.rangeBothSetupsFrom([row(T0, "normal-trending")], { rangeKey: "k" }), []);
});

test("RS-3 c2 cap: at most 150 a UTC day; one range_both_capped line per day with the count; the result carries it", () => {
  const setups = Array.from({ length: 5 }, (_, i) => ({ opened_ms: T0 + i * M15 }));
  const day = iso(T0).slice(0, 10);
  assert.deepEqual(rs.capRangeBoth(setups, { [day]: 147 }), { kept: setups.slice(0, 3), capped: [{ day, count: 150, dropped: 2 }] });
  assert.deepEqual(rs.capRangeBoth(setups, {}).capped, []);
  assert.equal(rs.RANGE_BOTH_DAILY_CAP, 150);
  reset();
  const lines = [];
  assert.deepEqual(rs.logRangeBothCapped([{ day, count: 150 }], { log: (l) => lines.push(l) }), [day]);
  assert.deepEqual(rs.logRangeBothCapped([{ day, count: 150 }], { log: (l) => lines.push(l) }), [], "once per day");
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ event: "range_both_capped", day, count: 150, cap: 150 }]);
});

test("RS-4 c2 in the hourly run: range_both rows of both sides, replayed on the control arm with the live fill rule; the cap logs and reports", async (t) => {
  reset();
  const env = envOf();
  insertDecision(env.DB, T0);
  insertDecision(env.DB, T0 + M15);
  insertDecision(env.DB, T0 + 2 * M15, { regime: "normal-trending" });
  const now = T0 + 3 * HOUR;
  const out = await pl.runPlanLearning(env, { now, bars: rising(T0) });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.range_both, { added: 2, extended: 0, resolved: 2, unavailable: 0, capped: [] });
  const rows = env.DB.raw.prepare("SELECT setup_key, side, agent, source, rule_version, status, results_json FROM plan_setups ORDER BY setup_key").all();
  assert.deepEqual(rows.map((r) => [r.setup_key.startsWith("rangeboth:"), r.side, r.agent, r.source, r.rule_version, r.status]), [
    [true, "BUY", "range_fade", "range_both", rs.rangeRuleVersionOf(env), "resolved"],
    [true, "SELL", "range_fade", "range_both", rs.rangeRuleVersionOf(env), "resolved"]
  ]);
  const res = rows.map((r) => JSON.parse(r.results_json));
  assert.deepEqual(res.map((x) => Object.keys(x)), [[pl.CONTROL_ARM], [pl.CONTROL_ARM]], "the control arm only");
  // Fill realism: the long limit at 4000 traded within its fill window (filled, its target); the short limit at 4020
  // never traded before price was already beyond its target (the live rule's target_before_entry): no fill, 0R.
  assert.equal(res[0][pl.CONTROL_ARM].f, 1);
  assert.equal(res[0][pl.CONTROL_ARM].s, "target");
  assert.deepEqual(res[1][pl.CONTROL_ARM], { s: "target_before_entry", r: 0, f: 0 });
  // The learned state (KV) is the live setups' only.
  const state = JSON.parse(await env.SIGNAL_CACHE.get(pl.PLAN_LEARNING_KEY));
  assert.equal(state.setups.resolved, 0);
  assert.deepEqual(state.cells ?? [], []);

  // The cap: 150 stored today (the 2 above and 148 more), a new ranging plan the next hour is dropped, logged once, reported each run.
  const day = iso(T0 + 4 * HOUR).slice(0, 10);
  const fill = env.DB.raw.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, context, status, version, updated_at, source) VALUES (?, 'k', 'range_fade', ?, ?, ?, 1, 'BUY', 4000, 3990, 4015, 10, 'none|unknown', 'resolved', 'x', ?, 'range_both')");
  for (let i = 0; i < 148; i += 1) fill.run(`cap:${i}`, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`);
  insertDecision(env.DB, T0 + 4 * HOUR, { plans: { long: { sweep_reversal: { entry: 3995, stop: 3985, tp1: 4010, at_level: false } } } });
  const lines = [];
  t.mock.method(console, "log", (l) => lines.push(l));
  const capped = await pl.runPlanLearning(env, { now: T0 + 4 * HOUR + 2 * M15, bars: rising(T0) });
  const again = await pl.runPlanLearning(env, { now: T0 + 4 * HOUR + 3 * M15, bars: rising(T0) });
  assert.deepEqual(capped.range_both.capped, [{ day, count: 150, dropped: 1 }]);
  assert.deepEqual(again.range_both.capped, [{ day, count: 150, dropped: 1 }], "never silent: every run's result carries it");
  assert.deepEqual(lines.filter((l) => String(l).includes("range_both_capped")).map((l) => JSON.parse(l)), [{ event: "range_both_capped", day, count: 150, cap: 150 }]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups WHERE agent = 'sweep_reversal' AND decision_key <> 'k'").get().n, 0);
});

test("RS-5 c2 off (the default, and previews): no range_both row, no episode, the run's result as before", async () => {
  reset();
  const env = envOf({ RANGE_SHADOW_MODE: "off" });
  insertDecision(env.DB, T0);
  const out = await pl.runPlanLearning(env, { now: T0 + 3 * HOUR, bars: rising(T0) });
  assert.equal("range_both" in out, false);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'range_episodes'").get().n, 0);
});

test("RS-6 c2 fill realism in the replay: a limit fills only when a bar trades through it within the plan's fill window", () => {
  const base = { setup_key: "rangeboth:x", side: "BUY", entry: 3990, stop: 3980, tp1: 4005, atr_h1: 10, at_level: false, opened_ms: T0, decided_ms: T0 + M1, last_seen_ms: T0 + M15 };
  const flat = (low) => Array.from({ length: 120 }, (_, i) => ({ open_time: iso(T0 + i * M1), close_time: iso(T0 + (i + 1) * M1), open: 4000, high: 4001, low: i === 60 ? low : 3999, close: 4000 }));
  assert.equal(pl.fillWindowOf(base), 30 * M1);
  const late = pl.replaySetup(base, flat(3989), { now: T0 + 3 * HOUR, arms: pl.CONTROL_ONLY });
  assert.deepEqual(late.results[pl.CONTROL_ARM], { s: "unfilled", r: 0, f: 0 }, "traded through at minute 60, after the 30-minute window");
  const never = pl.replaySetup(base, flat(3995), { now: T0 + 3 * HOUR, arms: pl.CONTROL_ONLY });
  assert.deepEqual(never.results[pl.CONTROL_ARM], { s: "unfilled", r: 0, f: 0 }, "never traded");
  const inWindow = pl.replaySetup({ ...base, last_seen_ms: T0 + HOUR }, flat(3989), { now: T0 + 3 * HOUR, arms: pl.CONTROL_ONLY });
  assert.equal(inWindow.results[pl.CONTROL_ARM].f, 1, "within a longer plan's window it fills");
});

test("RS-7 b: an episode opens at the 4th consecutive ranging 1H close and ends at the first non-ranging close or a missing hour", () => {
  const c = (h, regime) => ({ close_ms: T0 + h * HOUR, regime });
  const R = "normal-ranging", X = "normal-trending";
  assert.deepEqual(rs.rangeEpisodesFrom([c(0, X), c(1, R), c(2, R), c(3, R), c(4, X)]), [], "three ranging closes are no episode");
  assert.deepEqual(rs.rangeEpisodesFrom([c(0, X), c(1, R), c(2, R), c(3, R), c(4, R), c(5, R), c(6, X), c(7, R)]),
    [{ start_ms: T0 + HOUR, opened_ms: T0 + 4 * HOUR, end_ms: T0 + 6 * HOUR, hours: 5, status: "ended" }]);
  assert.deepEqual(rs.rangeEpisodesFrom([c(0, R), c(1, R), c(2, R), c(3, R)]), [{ start_ms: T0, opened_ms: T0 + 3 * HOUR, end_ms: null, hours: 4, status: "open" }]);
  assert.deepEqual(rs.rangeEpisodesFrom([c(0, R), c(1, R), c(2, R), c(3, R), c(5, R)]), [{ start_ms: T0, opened_ms: T0 + 3 * HOUR, end_ms: T0 + 3 * HOUR, hours: 4, status: "gap" }], "a missing hour ends it");
  assert.deepEqual(rs.rangeEpisodesFrom([c(0, R), c(1, R), c(2, R), { close_ms: T0 + 2 * HOUR + M15, regime: X }, c(3, R)]).map((e) => e.hours), [4], "only closes at minute :00 count");
  assert.deepEqual(rs.writableEpisodes([{ start_ms: 1 }, { start_ms: 2 }], { firstMs: 1 }), [{ start_ms: 2 }], "an episode at the first loaded close may have started earlier");
  assert.equal(rs.RANGE_EPISODE_MIN_HOURS, 4);
});

test("RS-8 b in the hourly run: episodes upserted (an open one ends later in place); the migration records the schema", async () => {
  reset();
  const env = envOf();
  const R = "normal-ranging", X = "normal-trending";
  [X, R, R, R, R, R].forEach((g, h) => insertDecision(env.DB, T0 + h * HOUR, { regime: g, plans: {} }));
  const first = await pl.runPlanLearning(env, { now: T0 + 5 * HOUR + 5 * M1, bars: [] });
  assert.deepEqual(first.range_episodes, { written: 1, open: 1 });
  insertDecision(env.DB, T0 + 6 * HOUR, { regime: X, plans: {} });
  const second = await pl.runPlanLearning(env, { now: T0 + 6 * HOUR + 5 * M1, bars: [] });
  assert.deepEqual(second.range_episodes, { written: 1, open: 0 });
  assert.deepEqual(env.DB.raw.prepare("SELECT start_ms, opened_ms, end_ms, hours, status FROM range_episodes").all().map((r) => ({ ...r })),
    [{ start_ms: T0 + HOUR, opened_ms: T0 + 4 * HOUR, end_ms: T0 + 6 * HOUR, hours: 5, status: "ended" }]);
  const fresh = d1();
  fresh.raw.exec(readFileSync(new URL("../migrations/0027_range_episodes.sql", import.meta.url), "utf8"));
  const cols = (x) => x.raw.prepare("PRAGMA table_info(range_episodes)").all().map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(cols(fresh), cols(env.DB));
});

const ev = (source, decision_key, r, extra = {}) => ({ source, mode: "intraday", decision_key, agent: "range_fade", side: "SELL", htf: "with", entry: 4010, stop: 4015, r, f: 1, rule_version: "tp1_kz:on", opened_ms: T0, ...extra });

test("RS-9 range_both counts in the selector's range evidence (n_both), each cell shown with and without it; live first on a duplicate", () => {
  const list = [
    ...Array.from({ length: 20 }, (_, i) => ev("live", `L${i}`, 0.3)),
    ...Array.from({ length: 12 }, (_, i) => ev("range_both", `B${i}`, 0.3)),
    ev("range_both", "L0", -5), // the live setup of that bar, agent and side wins
    ev("range_both", "L1", 0.3, { side: "BUY", htf: "against" }), // the other side of a live bar is its own setup
    ev("range_both", "Z", 9, { rule_version: "tp1_kz:off" }) // another range key
  ];
  const e = ms.rangeShadowEvidence(list, { ruleVersion: "tp1_kz:on+future_token@1" });
  assert.deepEqual([e.status, e.n, e.mean_r, e.best_cell, e.n_live, e.n_shadow, e.n_both], ["pass", 32, 0.3, "range_fade|SELL|with", 20, 0, 13]);
  assert.deepEqual(e.without_both, { status: "collecting", n: 20, mean_r: null, best_cell: null });
  const cell = e.cells.find((c) => c.context === "with");
  assert.deepEqual([cell.status, cell.setups, cell.n_live, cell.n_both, cell.without_both.status, cell.without_both.setups, cell.fill_rate], ["pass", 32, 20, 12, "collecting", 20, 1]);
  assert.deepEqual(e.cells.find((c) => c.context === "against").without_both, { setups: 0, mean_r: null, status: "collecting" });
  const out = ms.outcomeEvidence({ range: e });
  assert.equal(out.range.n_both, 13);
  assert.deepEqual(out.range.cells.find((c) => c.cell === "range_fade|SELL|with"), { cell: "range_fade|SELL|with", status: "pass", setups: 32, status_without_both: "collecting", setups_without_both: 20 });
});

test("RS-10 range_both never reaches what arms or gates live: unionSetups (modes' walk-forward, probation), the live cell gate, LIVE_SETUPS readers", async () => {
  const list = [ev("live", "L0", 0.3, { mode: "range" }), ev("range_both", "B0", 0.3, { mode: "range" }), ev("range_both", "B1", 0.3, { mode: "range" })];
  const u = ms.unionSetups(list, { ruleVersion: "tp1_kz:on" });
  assert.deepEqual(u.map((s) => s.decision_key), ["L0"]);
  assert.equal(ms.liveRecordOf(u, "range").n, 1, "the probation's live count");
  assert.equal(pl.LIVE_SETUPS, "source = 'live'");
  // The plan learner's state (the live cell gate reads its cells) after range_both rows only: no cell.
  reset();
  const env = envOf();
  insertDecision(env.DB, T0);
  await pl.runPlanLearning(env, { now: T0 + 3 * HOUR, bars: rising(T0) });
  const state = JSON.parse(await env.SIGNAL_CACHE.get(pl.PLAN_LEARNING_KEY));
  assert.equal(state.agents.length, 0);
  assert.deepEqual(state.cells, []);
  assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM plan_setups WHERE ${pl.LIVE_SETUPS}`).get().n, 0);
  assert.ok(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plan_setups WHERE source = 'range_both'").get().n > 0);
  // Every source file that reads plan_setups but the mode selector, the plan learner's own queues and the htf tagger
  // filters source = 'live' (orb-view reads orb_breakout only, never a range strategy).
  for (const f of ["strategy-council", "cfc-pack", "cfc-triggers", "council-knob-tuning", "grid-adapt", "strategy-recommendation"]) {
    const src = readFileSync(new URL(`../src/${f}.mjs`, import.meta.url), "utf8");
    for (const m of src.matchAll(/FROM plan_setups[^`"]*/g)) assert.match(m[0], /source = 'live'|LIVE_SETUPS/, `${f}: ${m[0].slice(0, 80)}`);
  }
});

test("RS-11 GET /api/range-shadow: the evidence both ways, the cap, the episodes with their setups per agent and side; no price", async () => {
  reset();
  const env = envOf({ MODE_SHADOW_EVIDENCE: "on" });
  const R = "normal-ranging";
  insertDecision(env.DB, T0 - HOUR, { regime: "normal-trending", plans: {} });
  [0, 1, 2, 3].forEach((h) => insertDecision(env.DB, T0 + h * HOUR, { regime: R, plans: h === 0 ? plansBoth() : {} }));
  await pl.runPlanLearning(env, { now: T0 + 3 * HOUR + 5 * M1, bars: rising(T0) });
  const v = await ms.rangeShadowStatus(env, { now: T0 + 3 * HOUR + 10 * M1 });
  assert.equal(v.status, "ok");
  assert.equal(v.mode, "on");
  assert.equal(v.range_key, rs.rangeRuleVersionOf(env));
  assert.deepEqual(v.range_both, { cap_per_day: 150, today: 2 });
  assert.equal(v.evidence.n_both, 2);
  assert.equal(v.evidence.without_both.status, "collecting");
  assert.deepEqual(v.episodes.map((e) => [e.start, e.status, e.hours]), [[iso(T0), "open", 4]]);
  assert.deepEqual(v.episodes[0].setups.map((s) => [s.agent, s.side, s.n, s.resolved, s.n_both]), [["range_fade", "BUY", 1, 1, 1], ["range_fade", "SELL", 1, 1, 1]]);
  const text = JSON.stringify(v);
  for (const k of ["\"entry\"", "\"stop\"", "\"tp1\"", "\"lot\"", "4000", "4020"]) assert.equal(text.includes(k), false, k);
  assert.equal((await ms.rangeShadowStatus({})).status, "unavailable");
});

test("RS-12 the switch: production on, previews off", () => {
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const at = w.indexOf("\"previews\"");
  assert.ok(at > 0);
  assert.match(w.slice(0, at), /"RANGE_SHADOW_MODE": "on"/);
  assert.match(w.slice(at), /"RANGE_SHADOW_MODE": "off"/);
});
