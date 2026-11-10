import test from "node:test";
import assert from "node:assert/strict";
import { planIntents, settingsFrom, floorToStep, OMEGA_DEFAULTS, INTENT_ID_MAX, openId, closeId, closeAllId } from "../src/omega-engine.mjs";

const ISSUED = Date.parse("2026-11-09T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
const SIGNAL = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false };
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: []
};
const ON = { ...OMEGA_DEFAULTS, enabled: true };
const plan = (over = {}) => planIntents({ signal: SIGNAL, control: { mode: "active" }, settings: ON, executor: EXECUTOR, now: NOW, engineEnabled: true, ...over });
const codes = (r) => r.notes.map((n) => n.code);
const ex = (over) => ({ ...EXECUTOR, ...over });

test("sizing worked example: 0.5 % of 10 000 at a 5.00 stop with tick 0.01 worth 1 → 0.10 lot; SL/TP keep the plan's distances from the broker price", () => {
  const r = plan();
  assert.deepEqual(r.notes, []);
  assert.equal(r.intents.length, 1);
  assert.deepEqual(r.intents[0], { id: "open:" + ISSUED + ":B", kind: "open", side: "BUY", volume: 0.1, entry: 4101.2, sl: 4096.2, tp: 4111.2, signal_issued_ms: ISSUED, reason: "signal" });
  const sell = plan({ signal: { ...SIGNAL, side: "SELL", stop: 4105, tp1: 4090 } }).intents[0];
  assert.deepEqual([sell.side, sell.volume, sell.sl, sell.tp], ["SELL", 0.1, 4106, 4091], "SELL from the bid: 4101 + 5, 4101 - 10");
});

test("volume: floored to the step without float noise, clamped to max, refused below min", () => {
  assert.equal(floorToStep(0.1 / 0.01 * 0.01, 0.01), 0.1);
  assert.equal(floorToStep(0.29, 0.01), 0.29);
  assert.equal(floorToStep(1.2399999, 0.1), 1.2);
  assert.equal(plan({ settings: { ...ON, risk_pct: 2 }, executor: ex({ account: { ...EXECUTOR.account, equity: 1e9, day_start_balance: 1e9 } }) }).intents[0].volume, 50);
  const small = plan({ executor: ex({ account: { ...EXECUTOR.account, equity: 50, day_start_balance: 50 } }) });
  assert.deepEqual([small.intents, codes(small)], [[], ["volume_below_min"]]);
});

test("no NaN ever: a missing equity, a zero tick value or a missing level blocks the open (bad_input)", () => {
  for (const executor of [
    ex({ account: { ...EXECUTOR.account, equity: null } }),
    ex({ symbol: { ...EXECUTOR.symbol, tick_value: 0 } }),
    ex({ symbol: { ...EXECUTOR.symbol, ask: undefined } }),
    ex({ symbol: { ...EXECUTOR.symbol, digits: 2.5 } })
  ]) assert.deepEqual(codes(plan({ executor })), ["bad_input"]);
  assert.deepEqual(codes(plan({ signal: { ...SIGNAL, tp1: null } })), ["bad_input"]);
  for (const s of [{ risk_pct: Number.NaN }, { max_positions: Infinity }]) assert.ok(settingsFrom(s).error);
});

test("the switches: the env switch and the page toggle both must be on", () => {
  assert.deepEqual(codes(plan({ engineEnabled: false })), ["engine_off"]);
  assert.deepEqual(codes(plan({ settings: { ...ON, enabled: false } })), ["engine_off"]);
  assert.deepEqual(codes(planIntents({ signal: SIGNAL, executor: EXECUTOR, now: NOW, engineEnabled: true })), ["engine_off"], "defaults are off");
});

test("kill (env or control) closes everything with one stable id, even with the engine off or a stale executor", () => {
  const withPos = ex({ positions: [{ ticket: 9, side: "BUY", intent_id: "x" }], received_ms: NOW - 3_600_000 });
  const a = planIntents({ signal: { ...SIGNAL, kill: true }, executor: withPos, now: NOW, engineEnabled: false });
  assert.deepEqual(a.intents, [{ id: "ka:env", kind: "close_all", reason: "kill" }]);
  const at = "2026-11-09T11:02:00.000Z";
  const b1 = plan({ control: { mode: "killed", at }, executor: withPos });
  const b2 = plan({ control: { mode: "killed", at }, executor: withPos, now: NOW + 30_000 });
  assert.equal(b1.intents[0].id, "ka:" + Date.parse(at));
  assert.equal(b1.intents[0].id, b2.intents[0].id, "the same kill gives the same id on every sync");
  assert.deepEqual(plan({ control: { mode: "killed", at } }).intents, [], "nothing to close");
});

test("a stale, disconnected or missing executor plans nothing", () => {
  for (const executor of [null, ex({ connected: false }), ex({ received_ms: NOW - 61_000 }), ex({ received_ms: null })]) {
    assert.deepEqual(codes(plan({ executor })), ["executor_stale"]);
  }
});

test("entry gates: expired, too old, blackout, paused, spread, positions, daily loss, plan side, stops level", () => {
  const cases = [
    [{ now: ISSUED + 3_600_000, executor: ex({ received_ms: ISSUED + 3_599_000 }) }, "expired"],
    [{ now: ISSUED + 21 * 60_000, executor: ex({ received_ms: ISSUED + 21 * 60_000 - 1000 }) }, "signal_too_old"],
    [{ signal: { ...SIGNAL, blackout: true } }, "blackout"],
    [{ signal: { ...SIGNAL, paused: true } }, "paused"],
    [{ control: { mode: "paused" } }, "paused"],
    [{ executor: ex({ symbol: { ...EXECUTOR.symbol, spread_points: 61 } }) }, "spread"],
    [{ executor: ex({ positions: [{ ticket: 1, side: "BUY", intent_id: "open:1:B" }] }) }, "max_positions"],
    [{ executor: ex({ account: { ...EXECUTOR.account, equity: 9_800 } }) }, "daily_loss_limit"],
    [{ signal: { ...SIGNAL, stop: 4105 } }, "plan_wrong_side"],
    [{ executor: ex({ symbol: { ...EXECUTOR.symbol, stops_level_points: 600 } }) }, "stops_level"],
    [{ signal: { ...SIGNAL, side: "NONE" } }, "no_side"]
  ];
  for (const [over, code] of cases) {
    const r = plan(over);
    assert.equal(r.intents.filter((i) => i.kind === "open").length, 0, code);
    assert.ok(codes(r).includes(code), `${code}: got ${codes(r)}`);
  }
  assert.equal(plan({ executor: ex({ account: { ...EXECUTOR.account, equity: 9_801 } }) }).intents.length, 1, "a loss just under the limit still trades");
  // The Decision Engine's 15m signal (since #212): fresh for 10 minutes by default, like the EA 1.11.
  const m15 = { ...SIGNAL, expires_ms: ISSUED + 900_000 };
  assert.equal(plan({ signal: m15, now: ISSUED + 9 * 60_000, executor: ex({ received_ms: ISSUED + 9 * 60_000 - 1000 }) }).intents.length, 1);
  assert.deepEqual(codes(plan({ signal: m15, now: ISSUED + 11 * 60_000, executor: ex({ received_ms: ISSUED + 11 * 60_000 - 1000 }) })), ["signal_too_old"]);
});

test("a real account needs live armed for an open, but an opposite position is still closed", () => {
  const real = ex({ account: { ...EXECUTOR.account, trade_mode: "real" }, positions: [{ ticket: 77, side: "SELL", intent_id: "open:1:S" }] });
  const r = plan({ executor: real, settings: { ...ON, max_positions: 2 } });
  assert.deepEqual(r.intents, [{ id: "cl:77:opp", kind: "close", ticket: 77, reason: "opposite" }]);
  assert.deepEqual(codes(r), ["live_not_armed"]);
  assert.equal(plan({ executor: ex({ account: { ...EXECUTOR.account, trade_mode: "contest" } }) }).intents.length, 0, "contest counts as real");
  const armed = plan({ executor: real, settings: { ...ON, max_positions: 2, live_armed: true } });
  assert.deepEqual(armed.intents.map((i) => i.kind), ["close", "open"]);
});

test("an opposite position is closed and the new side opens once the close frees the slot", () => {
  const r = plan({ executor: ex({ positions: [{ ticket: 5, side: "SELL", intent_id: "open:1:S" }] }) });
  assert.deepEqual(r.intents.map((i) => i.id), ["cl:5:opp", "open:" + ISSUED + ":B"]);
});

test("one open per signal: a recent intent id or a position carrying it blocks a second", () => {
  const id = openId(ISSUED, "BUY");
  assert.deepEqual(codes(plan({ recentIntentIds: [id] })), ["already_opened"]);
  assert.deepEqual(codes(plan({ executor: ex({ positions: [{ ticket: 3, side: "BUY", intent_id: id }] }), settings: { ...ON, max_positions: 3 } })), ["already_opened"]);
});

test("every intent id fits an MT5 comment (31 characters), with a 19-digit ticket and a retry suffix", () => {
  const ids = [openId(ISSUED, "SELL"), closeId("9223372036854775807") + ":9", closeAllId(String(Date.now())) + ":9", closeAllId("env")];
  for (const id of ids) assert.ok(id.length <= INTENT_ID_MAX, `${id} is ${id.length} characters`);
});

test("settings: merged onto the stored ones; enabled false disarms live; LIVE needs enabled", () => {
  const stored = { ...OMEGA_DEFAULTS, enabled: true, risk_pct: 1.2, max_positions: 3 };
  assert.deepEqual(settingsFrom({ max_spread_points: 40 }, stored).settings, { ...stored, max_spread_points: 40 });
  assert.match(settingsFrom({ live_armed: true }, stored).error, /LIVE/);
  assert.equal(settingsFrom({ live_armed: true, confirm: "LIVE" }, stored).settings.live_armed, true);
  assert.match(settingsFrom({ live_armed: true, confirm: "LIVE" }, OMEGA_DEFAULTS).error, /enable/);
  assert.equal(settingsFrom({ enabled: false }, { ...stored, live_armed: true }).settings.live_armed, false);
  assert.match(settingsFrom({ risk_pct: 2.5 }).error, /risk_pct/);
  assert.match(settingsFrom({ max_positions: 1.5 }).error, /integer/);
  assert.equal(settingsFrom({ max_signal_age_min: 10 }).settings.max_signal_age_ms, 600_000);
  assert.match(settingsFrom({ enabled: "yes" }).error, /enabled/);
  assert.ok(settingsFrom([]).error);
});

test("mean reversal early exit closes active positions before SL hit", () => {
  const signal = {
    action: "EXIT",
    mean_reversal: true,
    issued_ms: NOW,
    expires_ms: NOW + 10 * 60_000,
    entry: 4100, stop: 4095, tp1: 4110
  };
  const executor = {
    ...EXECUTOR,
    positions: [{ ticket: 998877, side: "BUY", volume: 0.1, open_price: 4098, sl: 4095, tp: 4110, profit: 20 }]
  };
  const { intents, notes } = planIntents({
    signal,
    settings: { enabled: true, live_armed: true },
    executor,
    now: NOW,
    engineEnabled: true
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, "close");
  assert.equal(intents[0].ticket, 998877);
  assert.equal(intents[0].reason, "mean_reversal");
  assert.ok(notes.some((n) => n.code === "mean_reversal_exit"));
});

test("extended TP expands runner take profit on strong momentum", () => {
  const signal = {
    side: "BUY",
    action: "ENTER_BUY",
    issued_ms: NOW,
    expires_ms: NOW + 10 * 60_000,
    entry: 4100, stop: 4095, tp1: 4110,
    tp2: 4130, // Extended TP target
    confidence: 0.9
  };
  const executor = {
    ...EXECUTOR,
    positions: [{ ticket: 554433, side: "BUY", volume: 0.1, open_price: 4100, sl: 4095, tp: 4110, profit: 100 }]
  };
  const { intents } = planIntents({
    signal,
    settings: { enabled: true, live_armed: true, max_positions: 2 },
    executor,
    now: NOW,
    engineEnabled: true
  });
  const modifyTp = intents.find((it) => it.kind === "modify_tp");
  assert.ok(modifyTp, "modify_tp intent emitted");
  assert.equal(modifyTp.ticket, 554433);
  assert.equal(modifyTp.tp, 4130);
  assert.equal(modifyTp.reason, "extended_tp");
});

