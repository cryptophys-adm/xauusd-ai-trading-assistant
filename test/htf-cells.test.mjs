// Range mode step 1 (owner 2026-11-18, confirmed: "Setuju"): the H4/D1 trend filter and the evidence gate per cell.
import test from "node:test";
import assert from "node:assert/strict";
import { tfTrend, htfTrend, htfContext, htfAt, cellRecords, cellStatus, applyCellGate, cellGateText, CELL_GATE, RANGE_GATED_AGENTS } from "../src/htf-cells.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

const H = 3_600_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
// n bars of `stepMs`, closing from T0, the close moving by `drift` a bar.
const series = (n, stepMs, drift, start = 4000) => Array.from({ length: n }, (_, i) => ({ close_time: new Date(T0 + (i + 1) * stepMs).toISOString(), close: start + drift * i }));

test("HC1 the trend per timeframe: EMA(50) and its slope on closed bars only; too few bars is null", () => {
  const up = series(80, 4 * H, 2), down = series(80, 4 * H, -2), flat = series(80, 4 * H, 0);
  const end = T0 + 80 * 4 * H;
  assert.equal(tfTrend(up, end), "up");
  assert.equal(tfTrend(down, end), "down");
  assert.equal(tfTrend(flat, end), "flat");
  assert.equal(tfTrend(up.slice(0, 40), end), null, "under 56 bars");
  // A bar that has not closed by the time is not read.
  assert.equal(tfTrend(up, T0 + 30 * 4 * H), null);
});

test("HC2 H4 and D1 combined; a side's context; the H4/D1 snapshot at a time", () => {
  assert.equal(htfTrend("down", "down"), "down");
  assert.equal(htfTrend("flat", "down"), "down");
  assert.equal(htfTrend("up", "flat"), "up");
  assert.equal(htfTrend("up", "down"), "mixed");
  assert.equal(htfTrend(null, "up"), null);
  assert.deepEqual(["BUY", "SELL"].map((s) => htfContext(s, "down")), ["against", "with"]);
  assert.deepEqual(["BUY", "SELL"].map((s) => htfContext(s, "mixed")), ["neutral", "neutral"]);
  assert.equal(htfContext("BUY", null), "unknown");
  const end = T0 + 300 * 24 * H;
  assert.deepEqual(htfAt({ h4: series(80, 4 * H, -2), d1: series(300, 24 * H, -3) }, end), { h4: "down", d1: "down", trend: "down" });
});

test("HC3 the records per cell (gated agents only, the plan as it is) and the bar: 30 setups at +0.10R", () => {
  const s = (agent, side, htf, r) => ({ agent, side, htf, results: { c: { r } } });
  const rows = [
    ...Array.from({ length: 30 }, () => s("range_fade", "SELL", "with", 0.3)),
    ...Array.from({ length: 11 }, () => s("range_fade", "BUY", "against", -1)),
    ...Array.from({ length: 31 }, () => s("sweep_reversal", "SELL", "neutral", 0.05)),
    s("zone_pullback", "BUY", "with", 2),
    s("range_fade", "BUY", null, 1)
  ];
  const cells = cellRecords(rows, { arm: "c" });
  assert.deepEqual(cells.map((c) => [c.agent, c.side, c.context, c.setups, c.mean_r, c.status]), [
    ["range_fade", "BUY", "against", 11, -1, "collecting"],
    ["range_fade", "BUY", "unknown", 1, 1, "collecting"],
    ["range_fade", "SELL", "with", 30, 0.3, "pass"],
    ["sweep_reversal", "SELL", "neutral", 31, 0.05, "below_bar"]
  ]);
  assert.equal(cellStatus(29, 5), "collecting");
  assert.deepEqual(CELL_GATE, { min_setups: 30, min_mean_r: 0.1 });
  assert.deepEqual(RANGE_GATED_AGENTS, ["range_fade", "sweep_reversal"]);
});

const sig = (agent, side) => ({ signal_id: "s1", side, action: "ENTER_LIMIT", entry: 4000, stop: side === "BUY" ? 3990 : 4010, tp1: side === "BUY" ? 4020 : 3980, trade_agent: agent });
const cells = [{ agent: "range_fade", side: "SELL", context: "with", setups: 30, mean_r: 0.3, status: "pass" }, { agent: "range_fade", side: "BUY", context: "neutral", setups: 12, mean_r: 0.2, status: "collecting" }];

test("HC4 the gate on a signal: only the range strategies; against the trend, unknown, collecting and below the bar have no side", () => {
  const down = { h4: "down", d1: "down", trend: "down" };
  const ok = applyCellGate(sig("range_fade", "SELL"), { htf: down, cells });
  assert.deepEqual([ok.side, ok.htf_context, ok.cell_gate, ok.awaiting_reason], ["SELL", "with", "pass:30:0.3", undefined]);
  const against = applyCellGate(sig("range_fade", "BUY"), { htf: down, cells });
  assert.deepEqual([against.side, against.awaiting_reason, against.awaiting_side, against.entry], ["NONE", "htf_against", "BUY", 0]);
  assert.match(cellGateText(against), /range_fade BUY against the H4\/D1 trend \(down; H4 down, D1 down\)/);
  const collecting = applyCellGate(sig("range_fade", "BUY"), { htf: { h4: "flat", d1: "flat", trend: "flat" }, cells });
  assert.deepEqual([collecting.side, collecting.awaiting_reason], ["NONE", "cell_collecting"]);
  assert.match(cellGateText(collecting), /collecting evidence, 12\/30 setups/);
  assert.equal(applyCellGate(sig("sweep_reversal", "SELL"), { htf: down, cells: [] }).awaiting_reason, "cell_collecting", "no record: collecting");
  assert.equal(applyCellGate(sig("range_fade", "SELL"), { htf: null, cells }).awaiting_reason, "htf_unknown", "fail closed");
  assert.equal(applyCellGate(sig("range_fade", "SELL"), { htf: down, cells: [{ ...cells[0], status: "below_bar", mean_r: 0.02 }] }).awaiting_reason, "cell_below_bar");
  // Other agents and a WAIT are untouched.
  const zone = sig("zone_pullback", "BUY");
  assert.equal(applyCellGate(zone, { htf: down, cells: [] }), zone);
  const wait = { side: "NONE", trade_agent: "range_fade" };
  assert.equal(applyCellGate(wait, { htf: down, cells }), wait);
});

test("HC5 the engine says why on the page and opens nothing for a held range trade", () => {
  const NOW = Date.parse("2026-11-18T15:00:00Z");
  const held = { ...applyCellGate({ ...sig("range_fade", "BUY"), issued_ms: NOW - 5000, decided_ms: NOW - 5000, expires_ms: NOW + 600_000 }, { htf: { h4: "down", d1: "down", trend: "down" }, cells }) };
  const executor = { connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1000, day_start_balance: 1000 },
    symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4000, ask: 4000.2, spread_points: 20 }, positions: [] };
  const p = planIntents({ signal: held, settings: { ...OMEGA_DEFAULTS, enabled: true }, executor, now: NOW, engineEnabled: true });
  assert.ok(!p.intents.some((it) => it.kind === "open"));
  const n = p.notes.find((x) => x.code === "htf_against");
  assert.ok(n, JSON.stringify(p.notes));
  assert.match(n.detail, /against the H4\/D1 trend/);
});
