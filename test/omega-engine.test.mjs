import test from "node:test";
import assert from "node:assert/strict";
import { planIntents, manageIntents, settingsFrom, floorToStep, OMEGA_DEFAULTS, INTENT_ID_MAX, openId, closeId, closeAllId, isOmegaOwned } from "../src/omega-engine.mjs";

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
  assert.deepEqual(r.intents[0], { id: "open:" + ISSUED + ":B", kind: "open", side: "BUY", volume: 0.1, entry: 4101.2, sl: 4096.2, tp: 4111.2, signal_issued_ms: ISSUED, reason: "signal", stop_source: "plan", trigger_source: null });
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
  // Since 2026-11-12 a loss just under the limit trades only what the daily risk budget still allows.
  assert.deepEqual(codes(plan({ executor: ex({ account: { ...EXECUTOR.account, equity: 9_801 } }) })), ["daily_risk_budget"], "1.00 of budget left: not even the minimum lot at a 5.00 stop");
  assert.equal(plan({ executor: ex({ account: { ...EXECUTOR.account, equity: 9_900 } }) }).intents[0].volume, 0.09, "100 of budget left: the full 0.5 % lot");
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

test("rollover quarantine gate blocks open intents between 21:55 and 22:15 UTC", () => {
  const quarantineNow = Date.UTC(2026, 10, 10, 22, 5, 0); // 22:05 UTC (in quarantine)
  const signal = {
    side: "BUY",
    action: "ENTER_BUY",
    issued_ms: quarantineNow,
    expires_ms: quarantineNow + 10 * 60_000,
    entry: 4100, stop: 4095, tp1: 4110
  };
  const { intents, notes } = planIntents({
    signal,
    settings: { enabled: true, live_armed: true },
    executor: { ...EXECUTOR, received_ms: quarantineNow - 1_000 },
    now: quarantineNow,
    engineEnabled: true
  });
  assert.equal(intents.length, 0);
  assert.ok(notes.some((n) => n.code === "rollover_quarantine"));
});

test("partial scale out closes 50% volume at TP1 when volume >= 0.02", () => {
  const signal = {
    side: "BUY",
    action: "ENTER_BUY",
    issued_ms: NOW,
    expires_ms: NOW + 10 * 60_000,
    entry: 4100, stop: 4095, tp1: 4110
  };
  const executor = {
    ...EXECUTOR,
    // open_price 4090 with current bid 4101 is +11 pts (> 2R vs 5 pt stop 4085)
    positions: [{ ticket: 771122, side: "BUY", volume: 0.04, open_price: 4090, sl: 4085, tp: 4110, profit: 80 }]
  };
  const { intents } = planIntents({
    signal,
    settings: { enabled: true, live_armed: true, max_positions: 2 },
    executor,
    now: NOW,
    engineEnabled: true
  });
  const partial = intents.find((it) => it.kind === "partial_close");
  assert.ok(partial, "partial_close intent emitted");
  assert.equal(partial.ticket, 771122);
  assert.equal(partial.volume, 0.02);
  assert.equal(partial.reason, "tp1_scale_out");
});

test("dynamic volatility & ATR stop: widens stop floor and normalizes risk sizing in high-volatility regime", () => {
  // Baseline stop distance in SIGNAL is 5.0 (4100 entry, 4095 stop)
  // If ATR is 8.0, 0.75 * ATR = 6.0 > 5.0
  const highVolExecutor = ex({
    symbol: { ...EXECUTOR.symbol, atr_value: 8.0, atr_points: 800 }
  });
  const r = plan({ executor: highVolExecutor });
  assert.equal(r.intents.length, 1);
  const openIntent = r.intents[0];
  // Entry = 4101.2, stop distance widened to 6.0 -> SL = 4095.2
  assert.equal(openIntent.entry, 4101.2);
  assert.equal(openIntent.sl, 4095.2);
  // Volume scaled down: 50 USD risk / (600 ticks * 1) = 0.08 lot (instead of 0.10 lot)
  assert.equal(openIntent.volume, 0.08);
  assert.ok(codes(r).includes("vol_regime_high"));
  // Audit 2026-11-11: the target moves with the widened stop, so the plan's 2R holds (10 / 5 = 12 / 6).
  assert.equal(openIntent.tp, 4113.2);
  assert.ok(codes(r).includes("adaptive_stop"));
  assert.equal(Math.round(((openIntent.tp - openIntent.entry) / (openIntent.entry - openIntent.sl)) * 1000) / 1000, 2);
});





test("audit 2026-11-11: open positions are managed whatever the entry gates say (blackout, pause, spread, rollover, full book, no side)", () => {
  const positions = [{ ticket: 9001, side: "BUY", volume: 0.04, open_price: 4090, sl: 4085, tp: 4110, profit: 80 }];
  const gated = [
    ["blackout", { signal: { ...SIGNAL, blackout: true } }],
    ["paused", { control: { mode: "paused" } }],
    ["spread", { executor: ex({ positions, symbol: { ...EXECUTOR.symbol, spread_points: 500 } }) }],
    ["rollover_quarantine", { now: Date.parse("2026-11-09T22:00:00Z"), signal: { ...SIGNAL, issued_ms: Date.parse("2026-11-09T21:55:00Z"), expires_ms: Date.parse("2026-11-09T23:00:00Z") }, executor: ex({ positions, received_ms: Date.parse("2026-11-09T22:00:00Z") - 1000 }) }],
    ["max_positions", {}],
    ["no_side", { signal: { ...SIGNAL, side: "NONE" } }]
  ];
  for (const [code, over] of gated) {
    const r = plan({ settings: { ...ON, trailing_stop_r: 1, max_positions: code === "max_positions" ? 1 : 3 }, executor: ex({ positions }), ...over });
    assert.ok(codes(r).includes(code), `${code}: ${JSON.stringify(codes(r))}`);
    assert.ok(!r.intents.some((it) => it.kind === "open"), `${code}: no new entry`);
    assert.ok(r.intents.some((it) => it.kind === "modify_sl" && it.sl === 4090 && it.reason === "break_even"), `${code}: break-even still applied`);
    assert.ok(r.intents.some((it) => it.kind === "partial_close" && it.ticket === 9001), `${code}: scale-out still applied`);
  }
  // Engine off and a stale executor still plan nothing; a kill still closes everything.
  assert.deepEqual(plan({ engineEnabled: false, executor: ex({ positions }) }).intents, []);
  assert.deepEqual(plan({ executor: ex({ positions, received_ms: NOW - 120_000 }) }).intents, []);
  assert.equal(plan({ signal: { ...SIGNAL, kill: true }, executor: ex({ positions }) }).intents[0].kind, "close_all");
});

test("audit 2026-11-11: break-even reads the executor's open_price and waits for trailing_stop_r R; scale-out banks half once per position", () => {
  const sym = EXECUTOR.symbol; // bid 4101, ask 4101.2
  const S = { ...ON, trailing_stop_r: 1 };
  // +11 on a 5 stop = 2.2R: break-even at the open price; a position already at break-even is left alone.
  assert.deepEqual(manageIntents({ positions: [{ ticket: 1, side: "BUY", volume: 0.01, open_price: 4090, sl: 4085, tp: 4110 }], sym, settings: S }).map((i) => [i.kind, i.sl]), [["modify_sl", 4090]]);
  assert.deepEqual(manageIntents({ positions: [{ ticket: 1, side: "BUY", volume: 0.01, open_price: 4090, sl: 4090, tp: 4110 }], sym, settings: S }), []);
  // +1 on a 5 stop = 0.2R: below trailing_stop_r, no break-even (it used to fire on any profit, and never on open_price).
  assert.deepEqual(manageIntents({ positions: [{ ticket: 2, side: "BUY", volume: 0.01, open_price: 4100, sl: 4095, tp: 4110 }], sym, settings: S }), []);
  // SELL: open 4112, ask 4101.2 = +10.8 on a 5 stop.
  assert.deepEqual(manageIntents({ positions: [{ ticket: 3, side: "SELL", volume: 0.01, open_price: 4112, sl: 4117, tp: 4090 }], sym, settings: S }).map((i) => [i.kind, i.sl]), [["modify_sl", 4112]]);
  assert.deepEqual(manageIntents({ positions: [{ ticket: 1, side: "BUY", volume: 0.01, open_price: 4090, sl: 4085, tp: 4110 }], sym, settings: { ...ON, trailing_stop_r: 0 } }), [], "trailing_stop_r 0: no break-even");
  // Scale-out: once per position (the remaining half is never halved again).
  const pos = [{ ticket: 7, side: "BUY", volume: 0.04, open_price: 4090, sl: 4085, tp: 4110 }];
  const first = manageIntents({ positions: pos, sym, settings: ON });
  assert.deepEqual(first.map((i) => [i.kind, i.volume, i.id]), [["partial_close", 0.02, "ps:7:4"]]);
  assert.deepEqual(manageIntents({ positions: [{ ...pos[0], volume: 0.02 }], sym, settings: ON, recentIntentIds: ["ps:7:4"] }), []);
  // A position being closed in the same plan is not managed.
  assert.deepEqual(manageIntents({ positions: pos, sym, settings: S, skipTickets: [7] }), []);
});

test("isOmegaOwned accurately separates bot trades from manual mobile orders", () => {
  assert.equal(isOmegaOwned({ ticket: 1, source: "omega" }), true);
  assert.equal(isOmegaOwned({ ticket: 2, magic: 920200 }), true);
  assert.equal(isOmegaOwned({ ticket: 3, intent_id: "open:1794389400000:S" }), true);
  assert.equal(isOmegaOwned({ ticket: 4, source: "manual" }), false);
  assert.equal(isOmegaOwned({ ticket: 5, magic: 0 }), false);
  assert.equal(isOmegaOwned({ ticket: 6, source: "external", magic: 12345 }), false);
  // Legacy fixture fallback
  assert.equal(isOmegaOwned({ ticket: 7, side: "BUY", open_price: 4000 }), true);
});

test("manual/mobile positions are protected: not auto-closed on opposite signal or mean reversal, not trailed, but counted in max_positions", () => {
  const manualPos = { ticket: 109082132, symbol: "XAUUSD.m", side: "SELL", volume: 0.02, open_price: 4063.4, sl: 0, tp: 0, profit: 28.34, magic: 0, source: "manual" };
  const omegaPos = { ticket: 109121707, symbol: "XAUUSD.m", side: "SELL", volume: 0.01, open_price: 4048.67, sl: 4058.76, tp: 4012.73, profit: -0.56, magic: 920200, source: "omega" };

  // 1. BUY signal arrives: only omega SELL position gets opposite close intent, manual position is untouched!
  const rOpp = plan({ signal: { ...SIGNAL, side: "BUY" }, executor: ex({ positions: [manualPos, omegaPos] }) });
  const closeIntents = rOpp.intents.filter((i) => i.kind === "close");
  assert.equal(closeIntents.length, 1);
  assert.equal(closeIntents[0].ticket, 109121707, "only omega position closed on opposite signal");
  assert.ok(!rOpp.intents.some((i) => i.ticket === 109082132), "manual mobile position must NEVER be auto-closed");

  // 2. Mean Reversal signal arrives: only omega position closed
  const rRev = plan({ signal: { ...SIGNAL, action: "REVERSAL", mean_reversal: true }, executor: ex({ positions: [manualPos, omegaPos] }) });
  const revCloses = rRev.intents.filter((i) => i.kind === "close");
  assert.equal(revCloses.length, 1);
  assert.equal(revCloses[0].ticket, 109121707);

  // 3. manageIntents (break-even / trailing): manual position is skipped
  const sym = EXECUTOR.symbol; // bid 4101, ask 4101.2
  const mng = manageIntents({ positions: [manualPos, omegaPos], sym, settings: { ...ON, trailing_stop_r: 1 } });
  assert.ok(!mng.some((i) => i.ticket === 109082132), "trailing/break-even must never modify manual positions");

  // 4. Max positions account exposure: manual positions count towards max_positions
  const rMax = plan({ signal: { ...SIGNAL, side: "SELL", stop: 4105, tp1: 4090 }, settings: { ...ON, max_positions: 1 }, executor: ex({ positions: [manualPos] }) });
  assert.ok(codes(rMax).includes("max_positions"), "account max_positions gate counts manual positions to prevent over-leverage");

  // 5. Emergency kill switch still closes all positions for account safety
  const rKill = plan({ signal: { ...SIGNAL, kill: true }, executor: ex({ positions: [manualPos, omegaPos] }) });
  assert.equal(rKill.intents[0].kind, "close_all");
});

test("a limit plan is not entered once price is past its entry toward the stop by more than 0.35 x the plan's stop (owner 2026-11-13)", () => {
  // SELL limit at 4100, stop 4120 (20): the band toward the stop ends at 4107. The 2026-11-13 trade sold at
  // 3903.98 against a 3888.48 entry and moved its stop 14 past the plan's.
  const sell = { ...SIGNAL, side: "SELL", action: "ENTER_LIMIT", entry: 4100, stop: 4120, tp1: 4090 };
  const at = (bid) => plan({ signal: sell, executor: ex({ symbol: { ...EXECUTOR.symbol, bid, ask: bid + 0.2 } }) });
  assert.ok(codes(at(4108)).includes("price_past_entry"));
  assert.equal(at(4108).intents.length, 0);
  const inside = at(4106);
  assert.equal(inside.intents.length, 1, "inside the band it enters");
  assert.equal(inside.intents[0].sl, 4126, "keeping the plan's distance from the fill");
  assert.ok(codes(at(4092)).includes("waiting_for_pullback"), "past the band toward the target it still waits for a pullback");
  // A BUY limit mirrors it; a market plan is not affected.
  const buy = { ...SIGNAL, action: "ENTER_LIMIT", entry: 4100, stop: 4080, tp1: 4110 };
  assert.ok(codes(plan({ signal: buy, executor: ex({ symbol: { ...EXECUTOR.symbol, bid: 4092.3, ask: 4092.5 } }) })).includes("price_past_entry"));
  assert.ok(!codes(plan({ signal: { ...sell, action: "ENTER_MARKET" }, executor: ex({ symbol: { ...EXECUTOR.symbol, bid: 4108, ask: 4108.2 } }) })).includes("price_past_entry"));
});
