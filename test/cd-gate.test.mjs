// CDG, the confidence-drop gate (owner 2026-11-25: "Learned gate, hold otherwise (Recommended)"; src/cd-gate.mjs).
// Pure where it can be; the job, the log and the revert on an in-memory SQLite D1 and a Map KV. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, writeSettings, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { resetLiquiditySchemaForTests } from "../src/liquidity-lens.mjs";
import {
  cdGateOn, cdDrop, dropBucket, cellKey, cdGateVerdict, gateAt, gateCells, passKeys, gateChanges, cfR, atLevelFlip, recordCdEvents, resetCdMemoForTests,
  readCdGateLive, computeCdGate, revertOutcomes, cdGateRevert, cdGateStatus, CD_GATE_RULE, CD_GATE_MODES, CD_GATE_KEY, CD_GATE_HISTORY_KEY, CD_GATE_REVERT_KEY, CD_GATE_REVERT
} from "../src/cd-gate.mjs";
import { OMEGA_DEFAULTS, settingsFrom, strategyExits, planIntents } from "../src/omega-engine.mjs";
import { replayOmega4, eraSwitches, ERA_SWITCHES, ENGINE_CODE, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { switchByKey } from "../src/feature-switches.mjs";
import { atrRangeRatio, buildDecisionRecord, ATR_RANGE_BARS } from "../src/decision-engine.mjs";
import { pineAtr } from "../src/prophet-r37-oscillator.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { replayScenarios } from "./fixtures/omega-market-path.mjs";
import { withoutAtrRangeRatio } from "./support/zone-aim-inert.mjs";
import { zoneScenario, zoneInputs } from "./support/zone-types-fixture.mjs";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as pp from "../src/public-projection.mjs";
import * as pa from "../src/public-analysis.mjs";
import * as pl from "../src/plan-learning.mjs";
import { d1 as zoneD1, kv as zoneKv } from "./fixtures/mode-shadow.mjs";

const M1 = 60_000, M15 = 15 * M1, H = 3_600_000, DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");
const PREV_CODE_HASH = "c4aa5772b5ee81fecdde470f5070ebecffc94b0ecfcfef0062edba41dbf8e620";
const V14_HASH = "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69";
const iso = (ms) => new Date(ms).toISOString();

function d1() {
  const db = new DatabaseSync(":memory:");
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map((v) => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => statement(sql) };
}
function kv() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, String(v)); } };
}

// ---------------------------------------------------------------- the gate's math

/**
 * Decisions 2 hours apart, each with its own two broker bars (the minute before the decided minute and 59 minutes
 * after it), so each decision's 1h move is the one given: [{ move: +1 | -1, ac, acp }].
 */
function series(list, { start = NOW - 20 * DAY } = {}) {
  const decisions = [], bars = [];
  list.forEach((x, i) => {
    const close = start + i * 2 * H, decided = close + 2 * M1 + 7_000;
    decisions.push({ bar_close_ms: close, decided_ms: decided, ac: x.ac ?? null, acp: x.acp ?? null });
    const m = Math.floor(decided / M1) * M1;
    bars.push({ t: m - M1, c: 2000 }, { t: m + 59 * M1, c: 2000 + x.move });
  });
  return { decisions, bars };
}
const longDrop = (d = 0.2) => ({ ac: { zone_pullback: { long: 0.5, short: 0.5 } }, acp: { zone_pullback: { long: r2(0.5 + d), short: 0.5 } } });
const shortDrop = (d = 0.35) => ({ ac: { zone_pullback: { long: 0.5, short: 0.4 } }, acp: { zone_pullback: { long: 0.5, short: r2(0.4 + d) } } });
const flat = () => ({ ac: { zone_pullback: { long: 0.5, short: 0.5 } }, acp: { zone_pullback: { long: 0.5, short: 0.5 } } });
function r2(x) { return Math.round(x * 100) / 100; }
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
/** A cell of `n` long drops with `adv` of them adverse (price down), plus flat decisions so the long base rate is base_down / total. */
function cellCase({ n, adv, extraDown, extraUp, drop = 0.2 }) {
  return series([...many(n, (i) => ({ move: i < adv ? -1 : 1, ...longDrop(drop) })), ...many(extraDown, () => ({ move: -1, ...flat() })), ...many(extraUp, () => ({ move: 1, ...flat() }))]);
}
const KEY = cellKey("zone_pullback", "long", "0.15-0.25");

test("CDG-1 the switch: cd_gate on by default, validated, carried, in ERA_SWITCHES and FS1; the buckets", () => {
  assert.equal(OMEGA_DEFAULTS.cd_gate, "on");
  assert.deepEqual(CD_GATE_MODES, ["on", "off"]);
  assert.equal(settingsFrom({ cd_gate: "off" }).settings.cd_gate, "off");
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, cd_gate: "off" }).settings.cd_gate, "off", "carried through another change");
  for (const bad of ["legacy", true, 1, ""]) assert.match(settingsFrom({ cd_gate: bad }).error, /cd_gate must be 'on' or 'off'/, String(bad));
  assert.equal(cdGateOn({}), true);
  assert.equal(cdGateOn({ cd_gate: "off" }), false);
  assert.ok(ERA_SWITCHES.includes("cd_gate"));
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), [], "on by default adds nothing to the era's signature");
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, cd_gate: "off" }), ["cd_gate=off"]);
  const row = switchByKey("cd_gate");
  assert.deepEqual([row.group, row.write, row.resolve, row.era_switch, row.default_value, [...row.values]], ["omega", "omega-settings", "omega-settings", true, "on", ["on", "off"]]);
  // Buckets: 0.15-0.25 and >=0.25; below 0.15 none (never gated).
  assert.deepEqual([0.1, 0.149, 0.15, 0.175, 0.2, 0.249, 0.25, 0.35, 0.5].map(dropBucket), [null, null, "0.15-0.25", "0.15-0.25", "0.15-0.25", "0.15-0.25", ">=0.25", ">=0.25", ">=0.25"]);
  assert.equal(dropBucket(cdDrop(0.5, 0.7)), "0.15-0.25", "0.7 - 0.5 in floating point is still 0.2");
  assert.equal(cdDrop(0.5, null), null);
});

test("CDG-2 the gate math: lift at 0.09/0.10, n at 29/30, base rate per side, a 0.10 drop never a cell", () => {
  // n 30, 18 adverse (0.6), base 20 of 40 down (0.5): lift 0.10 passes.
  let g = gateCells({ ...cellCase({ n: 30, adv: 18, extraDown: 2, extraUp: 8 }), now: NOW });
  assert.deepEqual([g.cells[KEY].n, g.cells[KEY].adverse_rate, g.cells[KEY].base_rate, g.cells[KEY].lift, g.cells[KEY].pass], [30, 0.6, 0.5, 0.1, true]);
  assert.deepEqual([g.base.long.n, g.base.long.rate, g.base.short.rate], [40, 0.5, 0.5]);
  // n 100, 59 adverse (0.59), base 100 of 200 (0.5): lift 0.09 fails; 60 adverse (0.60) passes.
  g = gateCells({ ...cellCase({ n: 100, adv: 59, extraDown: 41, extraUp: 59 }), now: NOW });
  assert.deepEqual([g.cells[KEY].lift, g.cells[KEY].pass], [0.09, false]);
  g = gateCells({ ...cellCase({ n: 100, adv: 60, extraDown: 40, extraUp: 60 }), now: NOW });
  assert.deepEqual([g.cells[KEY].lift, g.cells[KEY].pass], [0.1, true]);
  // n 29 fails whatever the lift; 30 passes.
  g = gateCells({ ...cellCase({ n: 29, adv: 29, extraDown: 0, extraUp: 29 }), now: NOW });
  assert.deepEqual([g.cells[KEY].n, g.cells[KEY].adverse_rate, g.cells[KEY].lift, g.cells[KEY].pass], [29, 1, 0.5, false]);
  g = gateCells({ ...cellCase({ n: 30, adv: 30, extraDown: 0, extraUp: 30 }), now: NOW });
  assert.deepEqual([g.cells[KEY].n, g.cells[KEY].pass], [30, true]);
  // The base rate is per side: a short is adverse when price rises.
  const s = series([...many(30, (i) => ({ move: i < 24 ? 1 : -1, ...shortDrop(0.35) })), ...many(10, () => ({ move: -1, ...flat() }))]);
  g = gateCells({ ...s, now: NOW });
  const sk = cellKey("zone_pullback", "short", ">=0.25");
  assert.deepEqual([g.base.short.rate, g.base.long.rate, g.cells[sk].adverse_rate, g.cells[sk].base_rate, g.cells[sk].lift, g.cells[sk].pass], [0.6, 0.4, 0.8, 0.6, 0.2, true]);
  // A 0.10 drop is no sample of any cell; the decision still counts in the base.
  g = gateCells({ ...series(many(40, (i) => ({ move: i % 2 ? 1 : -1, ...longDrop(0.1) }))), now: NOW });
  assert.deepEqual([Object.keys(g.cells), g.base.long.n], [[], 40]);
  // The window: decisions older than 30 days are out; a horizon not yet closed is not measured.
  const old = series(many(5, () => ({ move: -1, ...longDrop() })), { start: NOW - 40 * DAY });
  g = gateCells({ decisions: old.decisions, bars: old.bars, now: NOW });
  assert.deepEqual([g.window.decisions, g.window.measured], [0, 0]);
  const late = series([{ move: -1, ...longDrop() }], { start: NOW - 30 * M1 });
  assert.equal(gateCells({ ...late, now: NOW }).window.measured, 0);
  assert.deepEqual(passKeys({ a: { pass: true }, b: { pass: false }, c: { pass: true } }), ["a", "c"]);
});

test("CDG-3 the verdict and the history: pass needs the cell; gateAt is the entry in force, none before the first", () => {
  const gate = { cells: { [KEY]: { pass: true, n: 40, lift: 0.12 }, [cellKey("zone_pullback", "long", ">=0.25")]: { pass: false, n: 50, lift: 0.02 } } };
  assert.equal(cdGateVerdict(gate, { agent: "zone_pullback", side: "long", now: 0.5, prev: 0.7 }).pass, true);
  assert.equal(cdGateVerdict(gate, { agent: "zone_pullback", side: "long", now: 0.35, prev: 0.7 }).pass, false, "a failing cell");
  assert.equal(cdGateVerdict(gate, { agent: "sweep_reversal", side: "long", now: 0.5, prev: 0.7 }).pass, false, "a missing cell");
  assert.deepEqual(cdGateVerdict({ cells: { "zone_pullback|long|0.05-0.15": { pass: true } } }, { agent: "zone_pullback", side: "long", now: 0.6, prev: 0.7 }), { drop: 0.1, bucket: null, key: null, cell: null, pass: false });
  const h = [{ at_ms: 1000, pass: [KEY] }, { at_ms: 5000, pass: [] }];
  assert.equal(gateAt(h, 999), undefined);
  assert.deepEqual(gateAt(h, 1000), { cells: { [KEY]: { pass: true } } });
  assert.deepEqual(gateAt(h, 4999), { cells: { [KEY]: { pass: true } } });
  assert.deepEqual(gateAt(h, 5000), { cells: {} });
  assert.equal(gateAt([], 1), undefined);
  assert.deepEqual(gateChanges({ a: { pass: true }, b: { pass: false } }, { a: { pass: false, n: 31, lift: 0.05 }, b: { pass: false }, c: { pass: true, n: 30, lift: 0.2 } }).map((c) => [c.key, c.from, c.to]), [["a", true, false], ["c", false, true]]);
});

// ---------------------------------------------------------------- strategyExits and planIntents

const POWER_MS = NOW - 60_000;
const SIG = { strategy_execution: true, power: 0.3, power_ms: POWER_MS, agent_conf: "zone_pullback:0.5:0.5", agent_conf_prev: "zone_pullback:0.7:0.4" };
const POS = { ticket: 7, side: "BUY", volume: 0.1, open_price: 2000, sl: 1995, tp: 2010, intent_id: "open:1:B", magic: 920200, source: "omega" };
const SYM = { bid: 2002, ask: 2002.2 };
const exits = (over = {}) => strategyExits({ positions: [POS], signal: SIG, sym: SYM, agents: { [POS.intent_id]: "zone_pullback" }, now: NOW, ...over });
const BAR = Math.floor(POWER_MS / M1);

test("CDG-4 strategyExits: a pass closes as today, a failing or missing cell holds (no intent at all), a drop below 0.15 holds", () => {
  const today = exits();
  assert.deepEqual(today.intents, [{ id: `cl:7:cd:${BAR}`, kind: "close", ticket: 7, reason: "confidence_drop", agent: "zone_pullback" }]);
  assert.equal("cd" in today, false, "without a gate: today's result, nothing more");
  const pass = exits({ cdGate: { cells: { [KEY]: { pass: true, n: 40, lift: 0.12 } } } });
  assert.deepEqual(pass.intents, today.intents, "a passing cell: the close, as today");
  assert.deepEqual(pass.cd, [{ ticket: 7, bar_ms: BAR, agent: "zone_pullback", side: "long", drop: 0.2, bucket: "0.15-0.25", cell: { n: 40, lift: 0.12, pass: true }, action: "closed", price: 2002 }]);
  const fail = exits({ cdGate: { cells: { [KEY]: { pass: false, n: 40, lift: 0.05 } } } });
  assert.deepEqual([fail.intents, fail.cd[0].action, fail.cd[0].cell], [[], "held", { n: 40, lift: 0.05, pass: false }]);
  const missing = exits({ cdGate: { cells: {} } });
  assert.deepEqual([missing.intents, missing.cd[0].action, missing.cd[0].cell], [[], "held", null]);
  const small = exits({ signal: { ...SIG, agent_conf_prev: "zone_pullback:0.6:0.4" }, cdGate: { cells: { "zone_pullback|long|0.05-0.15": { pass: true }, [KEY]: { pass: true } } } });
  assert.deepEqual([small.intents, small.cd[0].drop, small.cd[0].bucket, small.cd[0].action], [[], 0.1, null, "held"]);
  // A SELL's side is short and its price the ask; a lean flip is never gated.
  const sell = exits({ positions: [{ ...POS, side: "SELL", open_price: 2004, intent_id: "open:1:S" }], agents: { "open:1:S": "zone_pullback" }, signal: { ...SIG, power: -0.1, agent_conf: "zone_pullback:0.5:0.4", agent_conf_prev: "zone_pullback:0.5:0.75" }, cdGate: { cells: {} } });
  assert.deepEqual([sell.cd[0].side, sell.cd[0].bucket, sell.cd[0].price, sell.intents], ["short", ">=0.25", 2002.2, []]);
  const lf = exits({ signal: { ...SIG, power: -0.5 }, cdGate: { cells: {} } });
  assert.deepEqual([lf.intents.map((i) => i.reason), lf.cd], [["lean_flip"], []]);
  // The extend gate reads as before.
  assert.equal(fail.extendOf(POS), today.extendOf(POS));
});

/** The aggressive replay's planIntents input at its confidence_drop minute (zone_pullback long, 0.7 to 0.5). */
function dropInput() {
  const s = replayScenarios().find((x) => x.name === "aggressive");
  const trace = [];
  replayOmega4({ ...s.opts, trace });
  const t = trace.find((x) => x.output.intents.some((it) => it.reason === "confidence_drop"));
  return { scenario: s, input: t.input, now: t.now };
}

test("CDG-5 planIntents: held is the plan of no drop at all (no close, no stop move); a pass is today's plan; cd_gate off is today's plan byte for byte", () => {
  const { input } = dropInput();
  const today = planIntents(input);
  assert.ok(today.intents.some((it) => it.reason === "confidence_drop"));
  assert.equal("cd_gate" in today, false);
  const held = planIntents({ ...input, cdGate: { cells: {} } });
  const noDrop = planIntents({ ...input, signal: { ...input.signal, agent_conf_prev: input.signal.agent_conf } });
  assert.deepEqual(held.intents, noDrop.intents, "held: exactly the plan with no drop (the position follows its plan, SLG1 and the PM)");
  assert.equal(held.intents.some((it) => it.reason === "confidence_drop"), false);
  assert.deepEqual(held.cd_gate.map((e) => [e.action, e.bucket, e.drop, e.agent, e.side]), [["held", "0.15-0.25", 0.2, "zone_pullback", "long"]]);
  const passed = planIntents({ ...input, cdGate: { cells: { [KEY]: { pass: true, n: 30, lift: 0.1 } } } });
  assert.deepEqual([passed.intents, passed.notes], [today.intents, today.notes]);
  assert.equal(passed.cd_gate[0].action, "closed");
  const off = { ...input, settings: { ...input.settings, cd_gate: "off" } };
  assert.equal(JSON.stringify(planIntents({ ...off, cdGate: { cells: {} } })), JSON.stringify(today), "off: byte-identical to today's intents");
  assert.equal(JSON.stringify(planIntents(off)), JSON.stringify(today));
});

// ---------------------------------------------------------------- the held-drop log

async function decisionsDb() {
  const db = d1();
  db.raw.exec("CREATE TABLE engine_decisions (decision_key TEXT, bar_close TEXT, decision_json TEXT)");
  const put = (ms, at) => db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?)").run(`OANDA:XAUUSD:15:${ms}`, iso(ms), JSON.stringify({ strategy_plans: { long: { zone_pullback: { status: "live", at_level: at } }, short: {} } }));
  put(BAR * M1, false);
  put(BAR * M1 - M15, true);
  return db;
}

test("CDG-6 the held-drop log: one row per (ticket, decision bar), at_level_flip from the two decisions' plans, a gated close replaces a hold, never back", async () => {
  resetCdMemoForTests();
  const db = await decisionsDb();
  const held = exits({ cdGate: { cells: {} } }).cd;
  const meta = { [POS.intent_id]: { r_dist: 5 } };
  assert.equal(await recordCdEvents(db, { events: held, positions: [POS], meta, now: NOW }), 1);
  assert.equal(await recordCdEvents(db, { events: held, positions: [POS], meta, now: NOW + 500 }), 0, "the same hold again: the memo skips it");
  resetCdMemoForTests();
  await recordCdEvents(db, { events: held, positions: [POS], meta, now: NOW + 1000 });
  let rows = db.raw.prepare("SELECT * FROM omega_cd_holds").all();
  assert.equal(rows.length, 1, "dedup by the key, also without the memo");
  assert.deepEqual([rows[0].ticket, rows[0].bar_ms, rows[0].agent, rows[0].side, rows[0].drop_conf, rows[0].bucket, rows[0].cell_n, rows[0].cell_pass, rows[0].at_level_flip, rows[0].price, rows[0].open_price, rows[0].r_dist, rows[0].cf_r, rows[0].action, rows[0].at_ms],
    [7, BAR, "zone_pullback", "long", 0.2, "0.15-0.25", null, 0, 1, 2002, 2000, 5, 0.4, "held", NOW]);
  const closed = exits({ cdGate: { cells: { [KEY]: { pass: true, n: 33, lift: 0.11 } } } }).cd;
  await recordCdEvents(db, { events: closed, positions: [POS], meta, now: NOW + 2000 });
  rows = db.raw.prepare("SELECT * FROM omega_cd_holds").all();
  assert.deepEqual([rows.length, rows[0].action, rows[0].cell_n, rows[0].cell_lift, rows[0].cell_pass], [1, "closed", 33, 0.11, 1]);
  resetCdMemoForTests();
  await recordCdEvents(db, { events: held, positions: [POS], meta, now: NOW + 3000 });
  assert.equal(db.raw.prepare("SELECT action FROM omega_cd_holds").get().action, "closed", "a hold never replaces a close");
  // No flip when both decisions agree; unknown (null) when a decision is missing.
  assert.equal(atLevelFlip({ long: { zone_pullback: { at_level: true } } }, { long: { zone_pullback: { at_level: true } } }, "zone_pullback", "long"), false);
  assert.equal(atLevelFlip(undefined, { long: {} }, "zone_pullback", "long"), null);
  assert.equal(atLevelFlip(null, { long: { zone_pullback: { at_level: true } } }, "zone_pullback", "long"), true, "no plans recorded reads as not at level");
  assert.equal(cfR({ side: "SELL", price: 2002.2, open_price: 2004, r_dist: 6 }), 0.3);
  assert.equal(cfR({ side: "BUY", price: 2002, open_price: 2000, r_dist: null }), null);
});

test("CDG-7 the live read: KV gate memoised per isolate; missing or unreadable holds everything", async () => {
  resetCdMemoForTests();
  const store = kv();
  assert.deepEqual(await readCdGateLive({ SIGNAL_CACHE: store }, { now: NOW }), { cells: {} });
  await store.put(CD_GATE_KEY, JSON.stringify({ computed_at: "x", cells: { [KEY]: { pass: true } } }));
  assert.deepEqual(await readCdGateLive({ SIGNAL_CACHE: store }, { now: NOW + 1000 }), { cells: {} }, "memoised for 5 minutes");
  assert.deepEqual((await readCdGateLive({ SIGNAL_CACHE: store }, { now: NOW + 6 * M1 })).cells, { [KEY]: { pass: true } });
  resetCdMemoForTests();
  assert.deepEqual(await readCdGateLive({ SIGNAL_CACHE: { get: async () => { throw new Error("down"); } } }, { now: NOW }), { cells: {} });
});

// ---------------------------------------------------------------- the auto-revert

const holdRow = (i, { action = "held", cf = 0.5 } = {}) => ({ ticket: 100 + i, side: "long", cf_r: cf, action, volume: 0.1, r_dist: 5, at_ms: NOW - 10 * DAY + i * H });
const dealsFor = (rows, r) => Object.fromEntries(rows.map((x) => [x.ticket, [{ side: "BUY", volume: 0.1, entry_price: 2000, exit_price: 2000 + r * 5, closed_ms: x.at_ms + H }]]));

test("CDG-8 revertOutcomes: 15 outcomes, held ones at their realised R on the volume held, gated closes at their counterfactual", () => {
  const rows = many(15, (i) => holdRow(i));
  let v = revertOutcomes(rows, dealsFor(rows, -0.4));
  assert.deepEqual([v.ready, v.n, v.mean_r, v.mean_cf_r, v.revert], [true, 15, -0.4, 0.5, true], "worse: revert");
  v = revertOutcomes(rows, dealsFor(rows, 1.2));
  assert.deepEqual([v.ready, v.mean_r, v.revert], [true, 1.2, false], "better: kept");
  v = revertOutcomes(rows.slice(0, 14), dealsFor(rows, -0.4));
  assert.deepEqual([v.ready, v.n, v.revert], [false, 14, false], "14: nothing yet");
  // A gated close's outcome is its counterfactual; a position still open stops the list there.
  const mixed = [holdRow(0, { action: "closed", cf: 0.3 }), holdRow(1)];
  v = revertOutcomes(mixed, { 101: [] }, { outcomes: 2 });
  assert.deepEqual([v.n, v.list[0].outcome_r, v.ready], [1, 0.3, false]);
  // Several rows of a ticket: its first event counts.
  v = revertOutcomes([holdRow(0), { ...holdRow(0), at_ms: holdRow(0).at_ms + M15, cf_r: 9 }], dealsFor([holdRow(0)], 1), { outcomes: 1 });
  assert.deepEqual([v.n, v.list[0].cf_r], [1, 0.5]);
});

async function revertEnv({ rows, r, settings = {}, keyMeta = null }) {
  const db = d1();
  db.raw.exec("CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, key_meta TEXT); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE ea_deals (position_ticket INTEGER, side TEXT, volume REAL, entry_price REAL, exit_price REAL, closed_ms INTEGER)");
  db.raw.prepare("INSERT INTO omega_settings VALUES (1, ?, ?)").run(JSON.stringify(settings), keyMeta ? JSON.stringify(keyMeta) : null);
  resetCdMemoForTests();
  const env = { DB: db, SIGNAL_CACHE: kv() };
  const insert = "INSERT INTO omega_cd_holds (ticket, bar_ms, agent, side, cf_r, action, volume, r_dist, at_ms) VALUES (?, ?, 'zone_pullback', ?, ?, ?, ?, ?, ?)";
  await (await import("../src/cd-gate.mjs")).ensureCdSchema(db);
  for (const x of rows) db.raw.prepare(insert).run(x.ticket, Math.floor(x.at_ms / M1), x.side, x.cf_r, x.action, x.volume, x.r_dist, x.at_ms);
  for (const [t, ds] of Object.entries(dealsFor(rows, r))) for (const d of ds) db.raw.prepare("INSERT INTO ea_deals VALUES (?, ?, ?, ?, ?, ?)").run(Number(t), d.side, d.volume, d.entry_price, d.exit_price, d.closed_ms);
  const writes = [], sent = [];
  const write = async (body, actor) => { writes.push([body, actor]); return { ok: true }; };
  const send = async (t) => { sent.push(t); };
  return { env, db, writes, sent, write, send };
}

test("CDG-9 the auto-revert: at 15 a worse mean sets cd_gate off and says it once; a better one is kept; fewer waits; off is inactive", async () => {
  const rows = many(15, (i) => holdRow(i));
  const w = await revertEnv({ rows, r: -0.4 });
  let out = await cdGateRevert(w.env, { now: NOW, send: w.send, write: w.write });
  assert.deepEqual([out.status, out.n, out.mean_r, out.mean_cf_r], ["reverted", 15, -0.4, 0.5]);
  assert.deepEqual(w.writes, [[{ cd_gate: "off" }, "agent:cd-gate"]]);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /^XAUUSD OMEGA · Confidence-drop gate \(cd_gate\) off: its first 15 outcomes averaged -0\.4R, below the \+0\.5R/);
  out = await cdGateRevert(w.env, { now: NOW + H, send: w.send, write: w.write });
  assert.deepEqual([out.status, w.writes.length, w.sent.length], ["done", 1, 1], "once per window");
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM omega_events WHERE action = 'cd_gate_reverted'").get().n, 1);
  const k = await revertEnv({ rows, r: 1.2 });
  out = await cdGateRevert(k.env, { now: NOW, send: k.send, write: k.write });
  assert.deepEqual([out.status, k.writes.length, k.sent.length], ["kept", 0, 0]);
  assert.equal(JSON.parse(k.env.SIGNAL_CACHE.map.get(CD_GATE_REVERT_KEY)).status, "kept");
  const few = await revertEnv({ rows: rows.slice(0, 14), r: -0.4 });
  out = await cdGateRevert(few.env, { now: NOW, send: few.send, write: few.write });
  assert.deepEqual([out.status, out.n, few.writes.length], ["waiting", 14, 0]);
  const off = await revertEnv({ rows, r: -0.4, settings: { cd_gate: "off" } });
  assert.equal((await cdGateRevert(off.env, { now: NOW, write: off.write })).status, "inactive");
  // The owner turning it on again opens a new window (key_meta's time): rows before it do not count.
  const again = await revertEnv({ rows, r: -0.4, keyMeta: { cd_gate: { by: "owner", at: iso(NOW - DAY) } } });
  assert.deepEqual([(await cdGateRevert(again.env, { now: NOW, write: again.write })).status, again.writes.length], ["waiting", 0]);
  assert.equal(CD_GATE_REVERT.outcomes, 15);
});

// ---------------------------------------------------------------- v4

test("CDG-10 v4 replays the gate in force at each bar from its history; off, no history or a bar before it is today's replay", () => {
  const { scenario, now } = dropInput();
  const run = (over = {}) => { const trace = []; const r = replayOmega4({ ...scenario.opts, ...over, trace }); return { records: JSON.stringify(r.records), outputs: JSON.stringify(trace.map((t) => [t.now, t.output])), trace }; };
  const today = run();
  assert.deepEqual(run({ cdGate: null }), { ...today, trace: run({ cdGate: null }).trace });
  const same = (x) => [x.records, x.outputs];
  assert.deepEqual(same(run({ cdGate: { history: [] } })), same(today), "no history: today's replay");
  assert.deepEqual(same(run({ cdGate: { history: [{ at_ms: now + M1, pass: [] }] } })), same(today), "a gate from after the drop: not in force at it");
  assert.deepEqual(same(run({ cdGate: { history: [{ at_ms: now - H, pass: [KEY] }] } })).at(0), same(today).at(0), "a passing cell in force: the records are today's");
  const held = run({ cdGate: { history: [{ at_ms: now - H, pass: [] }] } });
  assert.notEqual(held.records, today.records, "held: the trade runs on");
  const at = held.trace.find((t) => t.now === now);
  assert.equal(at.output.intents.some((it) => it.reason === "confidence_drop"), false);
  assert.equal(at.output.cd_gate[0].action, "held");
  assert.deepEqual(at.input.cdGate, { cells: {} });
  const off = run({ settings: { ...scenario.opts.settings, cd_gate: "off" }, cdGate: { history: [{ at_ms: now - H, pass: [] }] } });
  assert.deepEqual(same(off), same(today), "cd_gate off: today's replay byte for byte");
});

// ---------------------------------------------------------------- the daily job

async function jobEnv(list) {
  const db = d1();
  db.raw.exec("CREATE TABLE engine_decisions (decision_key TEXT, bar_close TEXT, decision_json TEXT); CREATE TABLE broker_bars_1m (account_ref TEXT, source TEXT, minute_ms INTEGER, o REAL, h REAL, l REAL, c REAL); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT)");
  const env = { DB: db, SIGNAL_CACHE: kv() };
  const add = (l, start) => {
    const s = series(l, { start });
    for (const d of s.decisions) db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?)").run(`k${d.bar_close_ms}`, iso(d.bar_close_ms), JSON.stringify({ decided_at: iso(d.decided_ms), agent_confidence: d.ac, agent_confidence_prev: d.acp }));
    for (const b of s.bars) db.raw.prepare("INSERT INTO broker_bars_1m VALUES ('acct_a', 'mt5:srv:SYM', ?, ?, ?, ?, ?)").run(b.t, b.c, b.c, b.c, b.c);
  };
  add(list, NOW - 20 * DAY);
  return { env, db, add };
}

test("CDG-11 the daily job: KV gate and history, one event and one line per flip; once a day; the same evidence changes nothing", async () => {
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const j = await jobEnv([...many(30, (i) => ({ move: i < 30 ? -1 : 1, ...longDrop() })), ...many(30, () => ({ move: 1, ...flat() }))]);
  let out = await computeCdGate(j.env, { now: NOW, send });
  assert.deepEqual([out.status, out.passing, out.changes.map((c) => [c.key, c.to])], ["changed", 1, [[KEY, true]]]);
  const doc = JSON.parse(j.env.SIGNAL_CACHE.map.get(CD_GATE_KEY));
  assert.deepEqual([doc.cells[KEY].n, doc.cells[KEY].adverse_rate, doc.cells[KEY].base_rate, doc.cells[KEY].lift, doc.cells[KEY].pass, doc.window.decisions, doc.base.long.rate], [30, 1, 0.5, 0.5, true, 60, 0.5]);
  assert.deepEqual(JSON.parse(j.env.SIGNAL_CACHE.map.get(CD_GATE_HISTORY_KEY)), [{ at_ms: NOW, pass: [KEY] }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^XAUUSD OMEGA · Confidence-drop gate \(CDG\): zone_pullback long 0\.15-0\.25 passes \(n 30, lift \+0\.5\)/);
  assert.doesNotMatch(sent[0], /\d{4}\.\d/, "no price");
  assert.equal((await computeCdGate(j.env, { now: NOW + H, send })).status, "fresh", "once a UTC day");
  out = await computeCdGate(j.env, { now: NOW + H, send, force: true });
  assert.equal(out.status, "unchanged");
  assert.deepEqual([sent.length, JSON.parse(j.env.SIGNAL_CACHE.map.get(CD_GATE_HISTORY_KEY)).length, j.db.raw.prepare("SELECT COUNT(*) AS n FROM omega_events").get().n], [1, 1, 1], "idempotent: no event, line or history entry");
  // More benign drops the next day: the cell fails; one event, one line, a second history entry.
  j.add(many(90, () => ({ move: 1, ...longDrop() })), NOW - 10 * DAY);
  out = await computeCdGate(j.env, { now: NOW + DAY, send });
  assert.deepEqual([out.status, out.changes.map((c) => [c.key, c.from, c.to])], ["changed", [[KEY, true, false]]]);
  assert.deepEqual(JSON.parse(j.env.SIGNAL_CACHE.map.get(CD_GATE_HISTORY_KEY)).map((h) => h.pass), [[KEY], []]);
  assert.deepEqual([sent.length, j.db.raw.prepare("SELECT COUNT(*) AS n FROM omega_events WHERE action = 'cd_gate_cell'").get().n], [2, 2]);
  // The read-only view.
  const view = await cdGateStatus(j.env);
  assert.deepEqual(Object.keys(view), ["computed_at", "window", "base", "cells", "passing", "history", "log", "revert", "rule"]);
  assert.deepEqual([view.passing, view.history.entries, view.cells[KEY].pass, view.rule.buckets, view.log], [[], 2, false, ["0.15-0.25", ">=0.25"], null], "SELECT only: no log table yet reads as null");
  await (await import("../src/cd-gate.mjs")).ensureCdSchema(j.db);
  assert.deepEqual((await cdGateStatus(j.env)).log, { held: 0, closed: 0 });
  assert.deepEqual(CD_GATE_RULE.buckets.map((b) => b.id), ["0.15-0.25", ">=0.25"]);
});

// ---------------------------------------------------------------- hashes

test("CDG-12 the hashes: V14 holds (the fixtures carry no gate), ENGINE_CODE_HASH moves with cd-gate in ENGINE_CODE", async () => {
  assert.equal(ENGINE_BEHAVIOUR_HASH, V14_HASH);
  assert.equal(await sha256Hex(engineBehaviourSource()), V14_HASH);
  assert.notEqual(ENGINE_CODE_HASH, PREV_CODE_HASH);
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.ok(ENGINE_CODE["cd-gate"][1].includes("cdGateVerdict") && ENGINE_CODE["cd-gate"][1].includes("gateAt"));
});

// ---------------------------------------------------------------- the atr_range_ratio measurement

const bar15 = (i, { o, h, l, c }) => ({ open_time: iso(NOW - (40 - i) * M15), close_time: iso(NOW - (39 - i) * M15), open: o, high: h, low: l, close: c, volume: 1 });

test("CDG-13 atr_range_ratio: ATR(14) over the 16-bar 15m range on closed bars, 3 places; recorded on the decision, which is otherwise unchanged", async () => {
  const bars = many(40, (i) => { const c = 2000 + Math.sin(i / 3) * 6 + i * 0.4; return bar15(i, { o: c - 0.5, h: c + 1 + (i % 4) * 0.3, l: c - 1.2 - (i % 3) * 0.2, c }); });
  const close = iso(NOW);
  const atr = pineAtr(bars, 14).at(-1);
  const last = bars.slice(-ATR_RANGE_BARS);
  const want = Math.round((atr / (Math.max(...last.map((b) => b.high)) - Math.min(...last.map((b) => b.low)))) * 1000) / 1000;
  assert.equal(atrRangeRatio(bars, close), want);
  assert.ok(want > 0 && want < 1);
  // A bar not closed at the decision's close is left out.
  const forming = [...bars, { ...bar15(40, { o: 2000, h: 2100, l: 1900, c: 2000 }), close_time: iso(NOW + M15) }];
  assert.equal(atrRangeRatio(forming, close), want);
  assert.equal(atrRangeRatio(bars.slice(-15), close), null, "fewer than 16 closed bars");
  assert.equal(atrRangeRatio([], close), null);
  // On the record: the number only; absent without enough bars; everything else is as before.
  const rec = (inputs) => buildDecisionRecord({ key: `OANDA:XAUUSD:15:${NOW - M15}`, barClose: close, loaded: { inputs, strategy: null }, now: NOW + 2 * M1 });
  const withBars = rec({ m15Bars: bars }), none = rec({});
  assert.equal(withBars.atr_range_ratio, want);
  assert.equal("atr_range_ratio" in none, false);
  const { structure: s1, ...a } = withoutAtrRangeRatio(withBars);
  const { structure: s2, ...b } = none;
  assert.equal(JSON.stringify(a), JSON.stringify(b), "otherwise byte-identical");
  // The zone fixture's decision carries it (its own 15m series), in the record and in the stored row; the signal and the
  // management fields Omega reads do not (Z0-9's pin holds with it stripped).
  const z = await zoneScenario({ se, de, ea, pp, pa, pl }, { db: zoneD1, kv: zoneKv, modes: { zoneTypes: "off" } });
  const ratio = atrRangeRatio(zoneInputs({ zoneTypes: "off" }).m15Bars, z.record.bar_close);
  assert.ok(typeof ratio === "number" && ratio > 0);
  assert.equal(z.record.atr_range_ratio, ratio);
  assert.equal(JSON.parse(z.stored).atr_range_ratio, ratio);
  assert.equal(JSON.stringify(z.signal).includes("atr_range_ratio") || JSON.stringify(z.management).includes("atr_range_ratio"), false);
});

// ---------------------------------------------------------------- the live sync

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const LIVE_POS = { ticket: 404, symbol: "XAUUSD", side: "BUY", volume: 0.1, open_price: 1995, sl: 1990, tp: 2010, intent_id: "open:5:B", magic: 920200, source: "omega", opened_ms: NOW - H };
const LIVE_STATE = (now, over = {}) => ({
  connected: true, server: "AnyBroker-Demo", received_ms: now - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 1999.0, ask: 1999.2, spread_points: 20 },
  positions: [LIVE_POS], deals: [], ...over
});
const LIVE_SIGNAL = (now) => ({ side: "NONE", action: "", entry: 0, stop: 0, tp1: 0, issued_ms: 0, expires_ms: 0, blackout: false, kill: false, paused: false, server_ms: now, strategy_execution: true, power: 0.3, power_ms: POWER_MS, agent_conf: "zone_pullback:0.5:0.5", agent_conf_prev: "zone_pullback:0.7:0.4" });
async function liveEnv(settings = {}) {
  resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests(); resetLiquiditySchemaForTests(); resetCdMemoForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  const sync = (now) => bridgeSync(e, { state: LIVE_STATE(now), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0" }, { now, signal: LIVE_SIGNAL(now) });
  await sync(NOW - 30_000);
  await writeSettings(e, { body: { enabled: true, ...settings }, actor: "owner" }, { now: NOW - 20_000 });
  e.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, 'open', ?, 'done', ?, ?, ?)")
    .run(LIVE_POS.intent_id, JSON.stringify({ id: LIVE_POS.intent_id, kind: "open", side: "BUY", volume: 0.1, entry: 1995, sl: 1990, tp: 2010, r_dist: 5, mode: "intraday", strategy: "zone_pullback", signal_issued_ms: 5 }), JSON.stringify({ ok: true, ticket: 404 }), NOW - H, NOW - H);
  return { e, sync };
}
const cdClose = (e) => e.DB.raw.prepare("SELECT id FROM omega_intents WHERE id = ?").get(`cl:404:cd:${BAR}`) ?? null;
const holds = (e) => { try { return e.DB.raw.prepare("SELECT ticket, action, r_dist, cf_r, bucket FROM omega_cd_holds").all().map((r) => ({ ...r })); } catch { return []; } };

test("CDG-14 the live sync: no gate yet holds the winner and logs it once; a passing cell closes it (logged closed); cd_gate off is today's close, nothing logged", async () => {
  const a = await liveEnv();
  await a.sync(NOW);
  await a.sync(NOW + 500);
  assert.equal(cdClose(a.e), null, "held: no close intent");
  assert.equal(a.e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE json_extract(payload, '$.ticket') = 404").get().n, 0, "and no stop move from the hold");
  assert.deepEqual(holds(a.e), [{ ticket: 404, action: "held", r_dist: 5, cf_r: 0.8, bucket: "0.15-0.25" }]);
  const b = await liveEnv();
  await b.e.SIGNAL_CACHE.put(CD_GATE_KEY, JSON.stringify({ computed_at: iso(NOW - H), cells: { [KEY]: { pass: true, n: 31, lift: 0.14 } } }));
  resetCdMemoForTests(); // the live read is memoised for 5 minutes per isolate (the first sync read no gate)
  await b.sync(NOW);
  assert.ok(cdClose(b.e), "a passing cell: today's close");
  assert.deepEqual(holds(b.e).map((r) => r.action), ["closed"]);
  const c = await liveEnv({ cd_gate: "off" });
  await c.sync(NOW);
  assert.ok(cdClose(c.e), "off: today's close");
  assert.deepEqual(holds(c.e), []);
});
