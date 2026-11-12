// Owner 2026-11-12: "ya tambahkan versi EA dan status input ke server". OmegaExecutor 1.12 reports its
// version and its local break-even and trailing inputs in state.json; Omega keeps them, says whether the EA
// leaves the stop and the target to Omega, and notes it in the plan while the EA still trails by itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executorFrom, executorInfoFrom, executorStatus, EXECUTOR_MIN_VERSION } from "../src/omega-broker.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");

test("E1. OmegaExecutor 1.12 writes its version and inputs into state.json; the version constant matches #property", () => {
  assert.match(ea, /#property version\s+"1\.12"/);
  assert.match(ea, /const string OMEGA_EXECUTOR_VERSION = "1\.12";/);
  assert.match(ea, /\\"executor\\":\{\\"name\\":\\"OmegaExecutor\\",\\"version\\":\\"%s\\",\\"auto_break_even\\":%s,\\"trailing_stop\\":%s,\\"dynamic_atr_stop\\":%s\}/);
  assert.match(ea, /AutoBreakEvenEnabled \? "true" : "false",\s*TrailingStopEnabled \? "true" : "false"/);
  assert.equal(EXECUTOR_MIN_VERSION, "1.12");
});

test("E2. the server keeps the report, checked; nothing else rides along", () => {
  const info = executorFrom({ connected: true, executor: { name: "OmegaExecutor", version: "1.12", auto_break_even: false, trailing_stop: false, dynamic_atr_stop: true, login: 123 } }).executor;
  assert.deepEqual(info, { name: "OmegaExecutor", version: "1.12", auto_break_even: false, trailing_stop: false, dynamic_atr_stop: true, local_management: false, up_to_date: true });
  assert.equal(executorFrom({ connected: true }).executor, null, "1.11 and older report nothing");
  assert.deepEqual([executorInfoFrom({ version: "1.12; drop" }).version, executorInfoFrom({ version: "1.12", trailing_stop: "yes" }).trailing_stop], [null, null], "malformed values are dropped");
  assert.equal(executorInfoFrom({ version: "1.11", auto_break_even: false, trailing_stop: false }).up_to_date, false);
  assert.equal(executorInfoFrom({ version: "1.20" }).up_to_date, true);
  assert.equal(executorInfoFrom({ version: "2.0" }).up_to_date, true);
});

test("E3. the status the pages show: ok, local management on, outdated, not reported", () => {
  assert.equal(executorStatus(executorInfoFrom({ version: "1.12", auto_break_even: false, trailing_stop: false })).status, "ok");
  const on = executorStatus(executorInfoFrom({ version: "1.12", auto_break_even: true, trailing_stop: true }));
  assert.equal(on.status, "local_management");
  assert.match(on.note, /AutoBreakEvenEnabled and TrailingStopEnabled still on/);
  assert.equal(executorStatus(executorInfoFrom({ version: "1.12", auto_break_even: false, trailing_stop: true })).note.startsWith("TrailingStopEnabled still on"), true);
  assert.equal(executorStatus(executorInfoFrom({ version: "1.11", auto_break_even: false, trailing_stop: false })).status, "outdated");
  assert.equal(executorStatus(null).status, "unknown");
});

test("E4. the plan notes an EA that still trails by itself, and still plans", () => {
  const NOW = Date.parse("2026-11-12T14:00:00Z");
  const executor = (report) => ({
    connected: true, received_ms: NOW - 1000, executor: report,
    account: { trade_mode: "demo", equity: 10_000, balance: 10_000, day_start_balance: 10_000 },
    symbol: { name: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 }, positions: []
  });
  const signal = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: NOW - 60_000, expires_ms: NOW + 600_000, blackout: false, kill: false, paused: false };
  const plan = (report) => planIntents({ signal, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true }, executor: executor(report), now: NOW, engineEnabled: true });
  const on = plan(executorInfoFrom({ version: "1.12", auto_break_even: true, trailing_stop: false }));
  assert.deepEqual([on.notes.map((n) => n.code), on.intents.map((i) => i.kind)], [["ea_local_management"], ["open"]]);
  assert.deepEqual(plan(executorInfoFrom({ version: "1.12", auto_break_even: false, trailing_stop: false })).notes, []);
  assert.deepEqual(plan(null).notes, [], "an EA that reports nothing is no note in the plan (the pages show it)");
});
