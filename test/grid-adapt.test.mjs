// The grid's automatic entry/stop (owner 2026-11-17: "council strategy agent yang harus otomatis menyesuaikan";
// confirmed: "Setuju, bangun begitu"): a strict evidence gate per strategy x regime, the plan otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cellLevels, planR, sliceEvidence, chooseCell, applyGridChoice, runGridAdapt, readGridChoices, GATE, gridAdaptMode } from "../src/grid-adapt.mjs";
import { PLAN_ARMS, CONTROL_ARM } from "../src/plan-learning.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

// A setup: BUY at 4000, stop 3990 (risk 10), 1H ATR 10. `win(id)` gives that arm's own-R result.
const setup = (results, over = {}) => ({ side: "BUY", entry: 4000, stop: 3990, atr_h1: 10, results, ...over });
const allArms = (fn) => Object.fromEntries(PLAN_ARMS.map((a) => [a.id, fn(a)]));

test("GA1. a cell is judged in R of the PLAN's stop on the same setups: a tight stop's big own-R is not a gain", () => {
  assert.deepEqual(cellLevels({ side: "BUY", entry: 4000, stop: 3990, atr_h1: 10 }, 0.3, 0.5), { entry: 3997, stop: 3995, risk: 2, risk0: 10 });
  // Own R +5 on a 2-point risk is +1 plan R; the plan's own +1 is +1 plan R: no gain.
  const s = setup({ "e0.3@s0.5": { r: 5, f: 1 }, [CONTROL_ARM]: { r: 1, f: 1 } });
  assert.deepEqual(planR(s, 0.3, 0.5), { r: 1, f: 1 });
  assert.deepEqual(planR(s, 0, 1), { r: 1, f: 1 });
  assert.equal(planR(s, 0.1, 0.8), null, "a cell without a replay does not count");
});

test("GA2. the gate: 40 fills, gain over the margin with a bootstrap low above 0, a positive holdout, agreeing neighbours", () => {
  // Every setup: the plan +0.2 plan R; e0@s1.25 +0.5 own R (= +0.625 plan R) and its neighbours mildly better.
  const good = [...Array(60)].map((_, i) => setup(allArms((a) => ({ r: a.id === CONTROL_ARM ? 0.2 : a.id === "e0@s1.25" ? 0.5 + (i % 3) * 0.05 : a.entry_shift === 0 && a.stop_scale === 0.8 ? 0.3 : a.entry_shift === 0.1 && a.stop_scale === 1.25 ? 0.2 : -0.2, f: 1 }))));
  const cells = sliceEvidence(good);
  assert.equal(cells["e0@s1.25"].passes, true);
  assert.ok(cells["e0@s1.25"].low > 0 && cells["e0@s1.25"].holdout > 0 && cells["e0@s1.25"].neighbours > 0);
  assert.equal(chooseCell(cells), "e0@s1.25");
  // Too few fills (39) → the plan.
  assert.equal(chooseCell(sliceEvidence(good.slice(0, 39))), null);
  // An isolated peak (neighbours clearly worse) → the plan.
  const isolated = [...Array(60)].map(() => setup(allArms((a) => ({ r: a.id === CONTROL_ARM ? 0.2 : a.id === "e0.2@s0.65" ? 3 : -1, f: 1 }))));
  assert.equal(sliceEvidence(isolated)["e0.2@s0.65"].passes, false);
  // Good early, bad on the latest quarter → the plan.
  const decays = good.map((s, i) => (i >= 45 ? setup(allArms((a) => ({ r: a.id === CONTROL_ARM ? 0.2 : -0.5, f: 1 }))) : s));
  assert.equal(sliceEvidence(decays)["e0@s1.25"].passes, false);
  // Hysteresis: the current cell stays unless another beats it by the switch margin.
  assert.equal(chooseCell({ a: { passes: true, gain: 0.2 }, b: { passes: true, gain: 0.22 } }, "a"), "a");
  assert.equal(chooseCell({ a: { passes: true, gain: 0.2 }, b: { passes: true, gain: 0.3 } }, "a"), "b");
  assert.equal(chooseCell({ a: { passes: false, gain: 0.2 } }, "a"), null, "a cell that no longer passes goes back to the plan");
});

test("GA3. the signal: the slice's cell moves entry and stop (a deeper entry is a limit); the plan otherwise; Omega records grid:<cell>", () => {
  const decision = { context: { regime_1h: "high-trending" }, strategy: { atr_h1: 10 } };
  const sig = { side: "BUY", action: "ENTER_MARKET", entry: 4000, stop: 3990, tp1: 4020, trade_agent: "sweep_reversal" };
  const choices = { slices: { "sweep_reversal|high-trending": { cell: "e0.2@s0.8" } } };
  const a = applyGridChoice(sig, { decision, choices });
  assert.deepEqual([a.entry, a.stop, a.action, a.grid_cell, a.grid_slice, a.plan_entry], [3998, 3992, "ENTER_LIMIT", "e0.2@s0.8", "sweep_reversal|high-trending", 4000]);
  assert.equal(applyGridChoice(sig, { decision: { ...decision, context: { regime_1h: "low-ranging" } }, choices }), sig, "another regime: the plan");
  assert.equal(applyGridChoice({ ...sig, side: "NONE" }, { decision, choices }).entry, 4000);
  assert.equal(gridAdaptMode({}), "off");
  // Omega: the intent carries the cell and the stop source.
  const ISSUED = Date.parse("2026-11-09T11:00:00Z"), NOW = ISSUED + 60_000;
  const EX = { connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 10000, equity: 10000, day_start_balance: 10000, day_realized_pl: 0 },
    symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 }, positions: [] };
  const S = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false, grid_cell: "e0@s1.25", grid_slice: "zone_pullback|high-trending" };
  const open = planIntents({ signal: S, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true, adaptive_volatility: false }, executor: EX, now: NOW, engineEnabled: true }).intents.at(-1);
  assert.deepEqual([open.kind, open.stop_source, open.grid_cell, open.grid_slice], ["open", "grid:e0@s1.25", "e0@s1.25", "zone_pullback|high-trending"]);
});

test("GA4. once a UTC day into KV; an adopted slice whose live grid trades lose reverts to the plan and is held 7 days; one line each", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE plan_setups (agent TEXT, regime TEXT, side TEXT, entry REAL, stop REAL, atr_h1 REAL, results_json TEXT, opened_at TEXT, status TEXT);
    CREATE TABLE omega_intents (id TEXT, kind TEXT, payload TEXT, status TEXT, result TEXT, created_ms INTEGER, updated_ms INTEGER);
    CREATE TABLE signal_ledger (candle_key TEXT, omega_status TEXT, r_omega REAL);`);
  const t0 = Date.parse("2026-11-17T12:00:00Z");
  for (let i = 0; i < 60; i += 1) db.prepare("INSERT INTO plan_setups VALUES ('sweep_reversal', 'high-trending', 'BUY', 4000, 3990, 10, ?, ?, 'resolved')")
    .run(JSON.stringify(allArms((a) => ({ r: a.id === CONTROL_ARM ? 0.2 : a.id === "e0@s1.25" ? 0.5 + (i % 3) * 0.05 : a.entry_shift === 0 && a.stop_scale === 0.8 ? 0.3 : a.entry_shift === 0.1 && a.stop_scale === 1.25 ? 0.2 : -0.2, f: 1 }))), new Date(t0 - (60 - i) * 3_600_000).toISOString());
  const wrap = (sql) => { let a = []; const s = { bind: (...x) => { a = x; return s; }, run: async () => db.prepare(sql).run(...a), first: async () => db.prepare(sql).get(...a) ?? null, all: async () => ({ results: db.prepare(sql).all(...a) }) }; return s; };
  const kv = new Map();
  const env = { GRID_ADAPT_MODE: "live", DB: { prepare: wrap }, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
  const sent = [];
  const r1 = await runGridAdapt(env, { now: t0, send: async (t) => sent.push(t) });
  assert.deepEqual(r1.adopted, ["sweep_reversal|high-trending:e0@s1.25"]);
  assert.match(sent[0], /Grid adopted for sweep_reversal in high-trending: e0@s1.25 \(was the plan\)/);
  assert.equal((await runGridAdapt(env, { now: t0 + 3_600_000 })).status, "fresh", "once a UTC day");
  // Ten live grid trades of the slice lose → revert and hold.
  for (let i = 0; i < 10; i += 1) {
    const issued = t0 + i * 900_000;
    db.prepare("INSERT INTO omega_intents VALUES (?, 'open', ?, 'done', '{}', ?, ?)").run(`open:${issued}:B`, JSON.stringify({ signal_issued_ms: issued, grid_cell: "e0@s1.25", grid_slice: "sweep_reversal|high-trending" }), issued, issued);
    db.prepare("INSERT INTO signal_ledger VALUES (?, 'closed', -0.4)").run(`OANDA:XAUUSD:15:${issued}`);
  }
  const r2 = await runGridAdapt(env, { now: t0 + 86_400_000, send: async (t) => sent.push(t) });
  assert.deepEqual([r2.adopted, r2.reverted], [[], ["sweep_reversal|high-trending:e0@s1.25"]]);
  assert.match(sent.at(-1), /Grid reverted .*back to the plan \(live: 10 trades/);
  const doc = await readGridChoices(env);
  assert.deepEqual([Object.keys(doc.slices), Object.keys(doc.held)], [[], ["sweep_reversal|high-trending"]]);
  assert.equal((await runGridAdapt({ ...env, GRID_ADAPT_MODE: "off" }, { now: t0 })).status, "disabled");
  assert.equal(GATE.min_fills, 40);
});

test("GA5. pre-entry only (platform ADR-0020 Amendment 1, 2026-11-17): the grid never changes an open position's stop or target", () => {
  const ISSUED = Date.parse("2026-11-09T11:00:00Z"), NOW = ISSUED + 60_000;
  const open = { ticket: 77, side: "BUY", volume: 0.1, open_price: 4095, sl: 4090, tp: 4120, intent_id: "open:1:B", source: "omega", profit: 5 };
  const EX = { connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 10000, equity: 10005, day_start_balance: 10000, day_realized_pl: 0 },
    symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 }, positions: [open] };
  const plain = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false };
  // The widest grid stop (x1.25) on the same signal while a position is open.
  const decision = { context: { regime_1h: "high-trending" }, strategy: { atr_h1: 10 } };
  const grid = applyGridChoice({ ...plain, trade_agent: "zone_pullback" }, { decision, choices: { slices: { "zone_pullback|high-trending": { cell: "e0@s1.25" } } } });
  assert.equal(grid.stop, 4093.75, "the signal's stop is wider (x1.25 of 5)");
  const S = { ...OMEGA_DEFAULTS, enabled: true, max_positions: 3 };
  const run = (signal) => planIntents({ signal, control: { mode: "active" }, settings: S, executor: EX, now: NOW, engineEnabled: true }).intents;
  const mgmt = (xs) => xs.filter((x) => x.ticket === open.ticket).map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(mgmt(run(grid)), mgmt(run({ ...plain, trade_agent: "zone_pullback" })), "the open ticket's intents are the same with or without the grid");
  for (const x of run(grid).filter((i) => i.ticket === open.ticket && (i.kind === "modify_sl" || i.kind === "modify_tp"))) {
    assert.ok(x.kind !== "modify_sl" || x.sl >= open.sl, "an open stop is never widened");
  }
});
