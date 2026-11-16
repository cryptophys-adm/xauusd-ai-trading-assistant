// Omega's exits per the strategy agents (owner 2026-11-16, docs/RFC_STRATEGY_EXECUTION.md): the lean flip closes every
// system position against the Decision Engine's lean; a winner whose agent's confidence dropped is closed; the target is
// extended only while that confidence is stable or rising.
import test from "node:test";
import assert from "node:assert/strict";
import { planIntents, strategyExits, manageIntents, OMEGA_DEFAULTS, POWER_FRESH_MS, LEAN_BAND } from "../src/omega-engine.mjs";

const NOW = Date.parse("2026-11-16T10:20:00Z");
const POWER_MS = Date.parse("2026-11-16T10:15:00Z");
const BAR = Math.floor(POWER_MS / 60_000);
const SYM = { name: "XAUUSD.m", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 3920, ask: 3920.2, spread_points: 20 };
const SIGNAL = { side: "NONE", strategy_execution: true, power: 0.3, power_ms: POWER_MS, agent_conf: "sweep_reversal:0.7:0.3,zone_pullback:0.6:0.4", agent_conf_prev: "sweep_reversal:0.7:0.3,zone_pullback:0.6:0.4" };
const WIN_LONG = { ticket: 7, side: "BUY", volume: 0.01, open_price: 3900, sl: 3890, tp: 3925, source: "omega", magic: 920200, intent_id: "open:1:BUY" };
const LOSE_LONG = { ...WIN_LONG, ticket: 8, open_price: 3930, sl: 3910, tp: 3960, intent_id: "open:2:BUY" };
const MANUAL = { ...WIN_LONG, ticket: 9, source: "manual", magic: 0, intent_id: null };
const SHORT = { ...WIN_LONG, ticket: 10, side: "SELL", open_price: 3940, sl: 3950, tp: 3905, intent_id: "open:3:SELL" };
const exec = (positions) => ({ connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", equity: 10_000, balance: 10_000, day_start_balance: 10_000 }, symbol: SYM, positions });
const plan = (signal, positions, agents = {}) => planIntents({ signal, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true, max_positions: 5 }, executor: exec(positions), now: NOW, engineEnabled: true, agents });
const closes = (r) => r.intents.filter((i) => i.kind === "close").map((i) => [i.ticket, i.reason, i.id]);

test("the lean flip closes every system position on the flipped side, in profit or not; never a manual one, never on a neutral lean", () => {
  assert.equal(LEAN_BAND, 0.15);
  const flipped = plan({ ...SIGNAL, power: -0.2 }, [WIN_LONG, LOSE_LONG, MANUAL, SHORT]);
  assert.deepEqual(closes(flipped), [[7, "lean_flip", `cl:7:lf:${BAR}`], [8, "lean_flip", `cl:8:lf:${BAR}`]], "the shorts are with the lean; the manual position is untouched");
  assert.ok(flipped.notes.some((n) => n.code === "lean_flip"));
  assert.deepEqual(closes(plan({ ...SIGNAL, power: -0.14 }, [WIN_LONG, LOSE_LONG])), [], "inside the band: neutral");
  assert.deepEqual(closes(plan({ ...SIGNAL, power: -0.5, power_ms: NOW - POWER_FRESH_MS - 1 }, [LOSE_LONG])), [], "a stale decision never flips");
  assert.deepEqual(closes(plan({ ...SIGNAL, power: 0.2 }, [SHORT])), [[10, "lean_flip", `cl:10:lf:${BAR}`]], "a short against a bullish lean");
});

test("a winner whose agent's confidence dropped is closed; a loser is left to its stop; stable or rising holds", () => {
  const drop = { ...SIGNAL, agent_conf: "sweep_reversal:0.6:0.3,zone_pullback:0.6:0.4" };
  const agents = { "open:1:BUY": "sweep_reversal", "open:2:BUY": "sweep_reversal" };
  assert.deepEqual(closes(plan(drop, [WIN_LONG, LOSE_LONG], agents)), [[7, "confidence_drop", `cl:7:cd:${BAR}`]]);
  assert.deepEqual(closes(plan(drop, [WIN_LONG], {})), [], "without a recorded agent: the default agent's confidence, which held");
  assert.deepEqual(closes(plan({ ...SIGNAL, agent_conf: "sweep_reversal:0.68:0.3" }, [WIN_LONG], agents)), [], "0.02 down is stable");
  assert.deepEqual(closes(plan({ ...SIGNAL, agent_conf: "sweep_reversal:0.8:0.3" }, [WIN_LONG], agents)), [], "rising");
  assert.deepEqual(closes(plan({ ...SIGNAL, agent_conf_prev: "" }, [WIN_LONG], agents)), [], "no previous evaluation: held");
});

test("the target is extended only while the confidence is stable or rising; the protective moves always run", () => {
  // Key levels on a known basis, price near the 3925 target with a strong power: the trailing TP would move it.
  const levels = { key_levels: "3903:3905,3913:3915,3923:3925,3933:3935", feed_basis: 2, feed_basis_known: true, m5_atr: 3 };
  const sym = { ...SYM, bid: 3924, ask: 3924.2 };
  const agents = { "open:1:BUY": "sweep_reversal" };
  const run = (conf, prev) => {
    const signal = { ...SIGNAL, ...levels, power: 0.6, agent_conf: conf, agent_conf_prev: prev };
    const ex = strategyExits({ positions: [WIN_LONG], signal, sym, agents, now: NOW });
    return manageIntents({ positions: [WIN_LONG], sym, settings: { ...OMEGA_DEFAULTS, enabled: true }, signal, side: "NONE", now: NOW, extendOf: ex.extendOf }).map((i) => i.reason);
  };
  assert.ok(run("sweep_reversal:0.7:0.3", "sweep_reversal:0.7:0.3").includes("trail_tp_key_level"), "stable: extended");
  assert.ok(run("sweep_reversal:0.8:0.3", "sweep_reversal:0.7:0.3").includes("trail_tp_key_level"), "rising: extended");
  const unknown = run("sweep_reversal:0.7:0.3", "");
  assert.ok(!unknown.includes("trail_tp_key_level"), "unknown: the target stays");
  assert.ok(unknown.some((r) => r.startsWith("sl_key_level")), "SL+ still runs");
  // Without key levels: the extended TP of the signal follows the same gate.
  const ext = (prev) => {
    const signal = { ...SIGNAL, side: "BUY", tp2: 3990, agent_conf: "sweep_reversal:0.7:0.3", agent_conf_prev: prev };
    const ex = strategyExits({ positions: [WIN_LONG], signal, sym: SYM, agents, now: NOW });
    return manageIntents({ positions: [WIN_LONG], sym: SYM, settings: { ...OMEGA_DEFAULTS, enabled: true }, signal, side: "BUY", now: NOW, extendOf: ex.extendOf }).map((i) => i.reason);
  };
  assert.ok(ext("sweep_reversal:0.7:0.3").includes("extended_tp"));
  assert.ok(!ext("sweep_reversal:0.9:0.3").includes("extended_tp"), "a drop: no extension");
});

test("with the rules off (STRATEGY_EXECUTION off: the signal says so) Omega plans as before", () => {
  const off = { ...SIGNAL, strategy_execution: false, power: -0.3, agent_conf: "zone_pullback:0.1:0.9" };
  assert.deepEqual(closes(plan(off, [WIN_LONG, LOSE_LONG])), []);
  const ex = strategyExits({ positions: [WIN_LONG], signal: off, sym: SYM, now: NOW });
  assert.deepEqual([ex.intents, ex.extendOf(WIN_LONG)], [[], true]);
});

test("the open intent records the trade's agent", () => {
  const signal = { ...SIGNAL, side: "BUY", action: "ENTER_MARKET", signal_id: "k", trade_agent: "sweep_reversal", entry: 3920, stop: 3910, tp1: 3940, issued_ms: POWER_MS, expires_ms: POWER_MS + 900_000, decided_ms: POWER_MS + 60_000 };
  const r = planIntents({ signal, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true }, executor: exec([]), now: NOW, engineEnabled: true });
  const open = r.intents.find((i) => i.kind === "open");
  assert.ok(open, JSON.stringify(r.notes));
  assert.equal(open.strategy, "sweep_reversal");
});

test("positionAgents reads each open position's agent from its open intent", async () => {
  const { positionAgents } = await import("../src/omega-broker.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)");
  raw.prepare("INSERT INTO omega_intents VALUES ('open:1:BUY', 'open', ?, 'done', NULL, 1, 1)").run(JSON.stringify({ strategy: "sweep_reversal" }));
  raw.prepare("INSERT INTO omega_intents VALUES ('open:2:BUY', 'open', ?, 'done', NULL, 1, 1)").run(JSON.stringify({}));
  const wrap = (sql, params = []) => ({ bind: (...a) => wrap(sql, a), all: async () => ({ results: raw.prepare(sql).all(...params) }) });
  const db = { prepare: (sql) => wrap(sql) };
  assert.deepEqual(await positionAgents(db, { positions: [WIN_LONG, LOSE_LONG, MANUAL] }), { "open:1:BUY": "sweep_reversal" });
  assert.deepEqual(await positionAgents(db, { positions: [] }), {});
  assert.deepEqual(await positionAgents({ prepare() { throw new Error("no db"); } }, { positions: [WIN_LONG] }), {});
});
