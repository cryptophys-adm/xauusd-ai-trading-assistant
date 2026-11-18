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

import { structureShift, structureAt, probationFrom, probationVerdict, PROBATION } from "../src/htf-cells.mjs";

// A down move, a lower high at bar 6, then a close above it at the last bar (a change of structure up).
const hbars = (closes) => closes.map((c, i) => ({ close_time: new Date(T0 + (i + 1) * H).toISOString(), close: c, high: c + 1, low: c - 1 }));

test("HC6 the change of structure: the last closed bar beyond the latest swing point against the trade", () => {
  const up = hbars([100, 98, 96, 94, 93, 95, 97, 95, 93, 92, 94, 99]);
  const end = T0 + 12 * H;
  assert.deepEqual(structureShift(up, "BUY", end), { ok: true, level: 98 }, "close 99 above the swing high 98 (bar 7)");
  assert.equal(structureShift(up, "BUY", end - H).ok, false, "one bar earlier: 94 is not above 98");
  assert.equal(structureShift(up, "SELL", end).ok, false);
  assert.deepEqual(structureAt({ h1: up, h4: [] }, end), { BUY: { h1: true, h4: false }, SELL: { h1: false, h4: false } });
  assert.equal(structureShift([], "BUY", end).ok, false);
});

test("HC7 probation: sweep reversals only; graduated at full risk; off, reverted and unconfirmed hold; half risk otherwise", () => {
  const down = { h4: "down", d1: "down", trend: "down" };
  const confirmed = { BUY: { h1: true, h4: false }, SELL: { h1: false, h4: false } };
  const base = sig("sweep_reversal", "BUY");
  const p = applyCellGate(base, { htf: down, cells: [], structure: confirmed, probation: probationFrom(null) });
  assert.deepEqual([p.side, p.probation, p.risk_scale, p.probation_state, p.structure_tf], ["BUY", true, 0.5, "probation", "H1"]);
  const passed = applyCellGate(base, { htf: down, cells: [{ agent: "sweep_reversal", side: "BUY", context: "against", setups: 40, mean_r: 0.2, status: "pass" }], structure: confirmed, probation: probationFrom(null) });
  assert.deepEqual([passed.side, passed.probation, passed.probation_state], ["BUY", undefined, "graduated"]);
  assert.equal(applyCellGate(base, { htf: down, structure: confirmed, probation: { enabled: false, reverted: {} } }).awaiting_reason, "htf_against", "owner off");
  assert.equal(applyCellGate(base, { htf: down, structure: confirmed, probation: { enabled: true, reverted: { "sweep_reversal|BUY|against": { at_ms: 1 } } } }).awaiting_reason, "probation_reverted");
  const waiting = applyCellGate(base, { htf: down, structure: { BUY: { h1: false, h4: false } }, probation: probationFrom(null) });
  assert.equal(waiting.awaiting_reason, "probation_unconfirmed");
  assert.match(cellGateText(waiting), /waits for a change of structure on a closed H1 or H4 candle/);
  // A range fade against the trend never gets probation.
  assert.equal(applyCellGate(sig("range_fade", "BUY"), { htf: down, structure: confirmed, probation: probationFrom(null) }).awaiting_reason, "htf_against");
  assert.deepEqual(probationFrom('{"enabled":false}'), { enabled: false, reverted: {} });
  assert.deepEqual(PROBATION.agents, ["sweep_reversal"]);
});

test("HC8 the revert verdict: the last 5 probation trades' mean R under 0", () => {
  assert.deepEqual(probationVerdict([{ r: -1 }, { r: 0.5 }]), { revert: false, mean_r: null, trades: 2 });
  assert.deepEqual(probationVerdict([{ r: 2 }, { r: -1 }, { r: -1 }, { r: -1 }, { r: 0.5 }, { r: 0.4 }]), { revert: true, mean_r: -0.42, trades: 6 });
  assert.equal(probationVerdict([{ r: 1 }, { r: -1 }, { r: 1 }, { r: -1 }, { r: 0.2 }]).revert, false);
});

test("HC9 the engine: half the risk and half the hard cap; one probation at a time; never a hedge; tagged with its risk", () => {
  const NOW = Date.parse("2026-11-18T15:00:00Z");
  const s0 = { ...sig("sweep_reversal", "BUY"), action: "ENTER_MARKET", entry: 4000.2, stop: 3995.2, tp1: 4010.2, issued_ms: NOW - 5000, decided_ms: NOW - 5000, expires_ms: NOW + 600_000, probation: true, risk_scale: 0.5, htf_context: "against" };
  const ex = (positions = []) => ({ connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000 },
    symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4000, ask: 4000.2, spread_points: 20 }, positions });
  const settings = { ...OMEGA_DEFAULTS, enabled: true, adaptive_volatility: false };
  const run = (signal, positions = [], meta = {}) => planIntents({ signal, settings, executor: ex(positions), now: NOW, engineEnabled: true, account: { profile: "conservative", spec_status: "validated" }, positionMeta: meta });
  const full = run({ ...s0, probation: undefined, risk_scale: undefined }).intents.find((i) => i.kind === "open");
  const half = run(s0).intents.find((i) => i.kind === "open");
  assert.ok(full && half, "both open");
  // The default setting's 0.5% (under Conservative's 2%): $50 at a $5 stop is 0.1 lot; probation half: 0.05 lot, $25.
  assert.deepEqual([full.volume, half.volume], [0.1, 0.05]);
  assert.deepEqual([half.probation, half.cell, half.risk_usd], [true, "sweep_reversal|BUY|against", 25]);
  assert.equal(full.probation, undefined);
  // One at a time: a probation position open holds the next.
  const pos = { ticket: 9, side: "BUY", volume: 0.2, open_price: 3990, sl: 3985, tp: 4010, source: "omega", magic: 920200, intent_id: "open:1:B" };
  const busy = run(s0, [pos], { "open:1:B": { mode: "scalp", r_dist: 5, probation: true } });
  assert.ok(busy.notes.some((n) => n.code === "probation_busy"), JSON.stringify(busy.notes));
  // Never against a position on the other side (manual or Omega).
  const hedge = run(s0, [{ ...pos, side: "SELL", source: "manual", magic: 0, intent_id: null, sl: 4010, tp: 3980 }]);
  assert.ok(hedge.notes.some((n) => n.code === "probation_hedge"), JSON.stringify(hedge.notes));
});

import { DatabaseSync } from "node:sqlite";
import { probationTick, setProbation, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return { raw: db, prepare(sql) { let params = []; const st = { bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return st; }, async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }, async first() { return db.prepare(sql).get(...params) ?? null; }, async all() { return { results: db.prepare(sql).all(...params) }; } }; return st; } };
}
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

test("HC10 the revert check: closed probation trades' R from their deals; 5 averaging under 0R revert the cell; the owner's on clears it", async () => {
  resetOmegaBrokerSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  env.DB.raw.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER, position_ticket INTEGER, profit REAL, commission REAL, swap REAL, currency TEXT, closed_ms INTEGER, source TEXT)");
  await probationTick(env);
  const nets = [-25, -25, 30, -25, -10];
  nets.forEach((net, i) => {
    env.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, 'open', ?, 'done', ?, ?, ?)")
      .run(`open:${i}:B`, JSON.stringify({ kind: "open", side: "BUY", probation: true, cell: "sweep_reversal|BUY|against", risk_usd: 25 }), JSON.stringify({ ok: true, ticket: 100 + i }), i, i);
    env.DB.raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, profit, commission, swap, currency, closed_ms, source) VALUES (?, ?, ?, 0, 0, 'USD', ?, 'omega')").run(500 + i, 100 + i, net, i);
  });
  const lines = [];
  const real = globalThis.fetch;
  globalThis.fetch = async () => { lines.push("tg"); return new Response("{}"); };
  try {
    const r = await probationTick(env, { now: 1000 });
    assert.deepEqual([r.status, r.reverted], ["changed", ["sweep_reversal|BUY|against"]]);
    const stored = JSON.parse(env.SIGNAL_CACHE.map.get("omega:probation:v1"));
    assert.deepEqual([stored.enabled, stored.reverted["sweep_reversal|BUY|against"].mean_r], [true, -0.44]);
    assert.equal((await probationTick(env, { now: 2000 })).status, "unchanged", "reverted once");
    const on = await setProbation(env, { enabled: true, actor: "owner@example.com" });
    assert.deepEqual(on.probation, { enabled: true, reverted: {} });
    const off = await setProbation(env, { enabled: false, actor: "owner@example.com" });
    assert.equal(off.probation.enabled, false);
    assert.match((await setProbation(env, { enabled: "yes" })).error, /true or false/);
  } finally { globalThis.fetch = real; }
});

test("HC11 probation halves the hard cap too: on a small account the minimum lot that passed the full cap is held", () => {
  const NOW = Date.parse("2026-11-18T15:00:00Z");
  // $100 equity, 1 oz minimum lot, a $4 stop: the minimum lot risks 4%, within Conservative's 5% cap, not within 2.5%.
  const exec = { connected: true, received_ms: NOW - 1000, account: { trade_mode: "real", currency: "USD", balance: 100, equity: 100, day_start_balance: 100 },
    symbol: { name: "GoldOne", currency_profit: "USD", contract_size: 1, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 0.01, volume_min: 1, volume_max: 100, volume_step: 1, stops_level_points: 0, bid: 4000, ask: 4000.2, spread_points: 20 }, positions: [], owner_symbol: "GoldOne" };
  const s0 = { ...sig("sweep_reversal", "BUY"), action: "ENTER_MARKET", entry: 4000.2, stop: 3996.2, tp1: 4008.2, issued_ms: NOW - 5000, decided_ms: NOW - 5000, expires_ms: NOW + 600_000 };
  const run = (signal) => planIntents({ signal, settings: { ...OMEGA_DEFAULTS, enabled: true, live_armed: true, adaptive_volatility: false }, executor: exec, now: NOW, engineEnabled: true, account: { profile: "conservative", spec_status: "validated" } });
  assert.ok(run(s0).notes.some((n) => n.code === "min_lot_within_cap"), "full risk: the minimum lot within the 5% cap");
  const p = run({ ...s0, probation: true, risk_scale: 0.5 });
  assert.ok(!p.intents.some((i) => i.kind === "open"));
  const n = p.notes.find((x) => x.code === "volume_below_min");
  assert.ok(n, JSON.stringify(p.notes));
  assert.match(n.detail, /cap of 2\.5%/);
});
