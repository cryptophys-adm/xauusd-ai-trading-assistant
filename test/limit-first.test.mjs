// E1 limit-first (src/limit-first.mjs; owner 2026-11-27 via the orchestrator: "harus mengikuti strateginya, jika memang
// strategi fallback harusnya tunggu di limit dan berada di zone, supply and demmand juga harus menjadi concern"): a
// pullback strategy never yields a market intent with the switch on; the market-by-design agents are byte-identical;
// the placement rule, the record-only own-type gate, the entry line and the named auto-revert. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { planIntents, settingsFrom, OMEGA_DEFAULTS, ENTRY_COUNCIL_WAIT_MS, openId, limitActionIntents } from "../src/omega-engine.mjs";
import { limitKnobs } from "../src/omega-limit-knobs.mjs";
import * as lf from "../src/limit-first.mjs";
import { ERA_SWITCHES, eraSwitches } from "../src/ledger-omega4.mjs";
import { FEATURE_SWITCHES } from "../src/feature-switches.mjs";
import { limitLine } from "../src/omega-broker.mjs";

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
// A BUY at price (entry 4101 on the feed, 4101.2 on the broker = the ask), its stop 6 below, the 1H ATR 4: an
// at-level pullback plan that today's council would enter at market. The demand zone 4098.5-4100.5 (feed) holds it.
const SIGNAL = {
  side: "BUY", action: "ENTER_LIMIT", entry: 4101, stop: 4095, tp1: 4111, issued_ms: ISSUED, decided_ms: ISSUED + 60_000, expires_ms: ISSUED + 15 * 60_000, blackout: false, kill: false, paused: false,
  feed_basis: 0.2, feed_basis_known: true, key_levels: "4098.5:4100.5,4110:4112", power: 0.4, power_ms: ISSUED,
  quorum_long_share: 0.7, quorum_short_share: 0.2, veto_long: false, veto_short: false, trading_mode: "intraday", trade_agent: "zone_pullback",
  signal_id: "OANDA:XAUUSD:15:1795600000000"
};
const LF = { lf_atr: 4, lf_type: "demand", lf_gate: "pass", lf_zone_low: 4098.5, lf_zone_high: 4100.5 };
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000, executor: { version: "1.21" },
  account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: [], orders: []
};
const ON = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
const COUNCIL = { ...ON, entry_order: "council" };
const ID = openId(ISSUED, "BUY");
const sig = (over = {}) => ({ ...SIGNAL, ...LF, ...over });
const answered = (choice) => ({ id: ID, status: "answered", choice, rule: "test", reason: "the test's answer" });
const plan = (over = {}) => planIntents({ signal: sig(), control: { mode: "active" }, settings: COUNCIL, executor: EXECUTOR, now: NOW, engineEnabled: true, ...over });
const kinds = (r) => r.intents.map((it) => it.kind);
const codes = (r) => r.notes.map((n) => n.code);
const LATE = ISSUED + 60_000 + ENTRY_COUNCIL_WAIT_MS;

test("LF-1 the switch: on by default; settingsFrom checks it; an FS1 switch and an era switch", () => {
  assert.equal(OMEGA_DEFAULTS.limit_first, "on");
  assert.equal(settingsFrom({ limit_first: "off" }).settings.limit_first, "off");
  assert.match(settingsFrom({ limit_first: "yes" }).error, /limit_first must be 'on' or 'off'/);
  assert.ok(ERA_SWITCHES.includes("limit_first"));
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, limit_first: "off" }), ["limit_first=off"]);
  const fs = FEATURE_SWITCHES.find((s) => s.key === "limit_first");
  assert.deepEqual([fs.group, fs.resolve, fs.era_switch, fs.default_value], ["omega", "omega-settings", true, "on"]);
  assert.deepEqual(lf.LIMIT_FIRST_AGENTS, ["zone_pullback", "breakout_retest"]);
  assert.equal(lf.limitFirstAgent(""), true, "an empty agent is the default agent's plan");
  for (const a of ["sweep_reversal", "range_fade", "pattern_inside", "orb_breakout", "pattern_peaks"]) assert.equal(lf.limitFirstAgent(a), false, a);
});

test("LF-2 a pullback strategy never yields a market intent: the council's enter_market, place_limit and silence all rest the limit; skip stays a skip", () => {
  for (const council of [answered("enter_market"), answered("place_limit"), { id: ID, status: "silent", rule: "council_failed" }, null]) {
    const r = council ? plan({ entryCouncil: council }) : plan({ now: LATE, executor: { ...EXECUTOR, received_ms: LATE - 1000 } });
    assert.deepEqual(kinds(r), ["place_limit"], JSON.stringify(council));
    assert.ok(!kinds(r).includes("open"));
    const it = r.intents[0];
    assert.deepEqual([it.limit_first, it.entry_basis, it.entry_zone_type, it.zone_type_gate, it.entry, it.sl, it.tp], [true, "zone_edge", "demand", "pass", 4100.7, 4095.2, 4111.2]);
    assert.equal(it.decision_key, SIGNAL.signal_id);
    assert.ok(codes(r).includes("limit_first"));
  }
  assert.deepEqual(kinds(plan({ entryCouncil: answered("skip") })), []);
  // A breakout_retest plan follows the same rule.
  assert.deepEqual(kinds(plan({ signal: sig({ trade_agent: "breakout_retest" }), entryCouncil: answered("enter_market") })), ["place_limit"]);
  // Under entry_order "limit" too, the council's place rests the limit-first limit.
  const lim = plan({ settings: { ...ON, entry_order: "limit" }, entryCouncil: answered("place_limit") });
  assert.deepEqual([kinds(lim), lim.intents[0].limit_first], [["place_limit"], true]);
});

test("LF-3 a limit that cannot rest is no entry, never a market fallback", () => {
  // The zone passed: price already below the demand zone's far edge.
  const passed = plan({ executor: { ...EXECUTOR, symbol: { ...EXECUTOR.symbol, bid: 4097.8, ask: 4098 } }, entryCouncil: answered("enter_market") });
  assert.deepEqual([kinds(passed), codes(passed)], [[], ["zone_passed"]]);
  // A netting account: no limit, no market.
  const net = plan({ executor: { ...EXECUTOR, account: { ...EXECUTOR.account, margin_mode: "netting" } }, entryCouncil: answered("enter_market") });
  assert.deepEqual([kinds(net), codes(net).at(-1)], [[], "netting_account"]);
});

test("LF-4 market-by-design agents and limit_first off are byte-identical to the engine before E1", () => {
  const strip = (o) => { const { lf_atr, lf_type, lf_gate, lf_zone_low, lf_zone_high, ...rest } = o; return rest; };
  for (const agent of ["sweep_reversal", "range_fade", "pattern_inside", "orb_breakout"]) {
    for (const council of [answered("enter_market"), answered("place_limit"), answered("skip")]) {
      const withFields = plan({ signal: sig({ trade_agent: agent }), entryCouncil: council });
      const before = plan({ signal: strip(sig({ trade_agent: agent })), entryCouncil: council });
      assert.equal(JSON.stringify(withFields), JSON.stringify(before), `${agent} ${council.choice}`);
    }
  }
  // limit_first "off": a pullback strategy's signal with the fields plans exactly as one without them.
  for (const council of [answered("enter_market"), answered("place_limit"), answered("skip")]) {
    const off = plan({ settings: { ...COUNCIL, limit_first: "off" }, entryCouncil: council });
    const before = plan({ settings: { ...COUNCIL, limit_first: "off" }, signal: strip(sig()), entryCouncil: council });
    assert.equal(JSON.stringify(off), JSON.stringify(before), council.choice);
  }
  // And today's market entry for the pullback strategy with it off (the council's enter_market at price).
  assert.deepEqual(kinds(plan({ settings: { ...COUNCIL, limit_first: "off" }, entryCouncil: answered("enter_market") })), ["open"]);
  // entry_order "market": nothing changes either.
  assert.deepEqual(kinds(plan({ settings: ON })), ["open"]);
});

test("LF-5 placement: 0.1 ATR behind the entry, the own zone's near edge when far enough, clipped to the zone, the guards", () => {
  const knobs = limitKnobs("intraday", null, {});
  const symbol = EXECUTOR.symbol;
  const base = { sym: symbol, digits: 2, planStopDist: 6, knobs, minRiskShare: 0.5, minRr: 1 };
  // No own zone: entry - 0.1 x ATR (4101.2 - 0.4), recorded untyped / block.
  const plain = lf.limitFirstPlacement({ ...base, signal: { ...SIGNAL, lf_atr: 4, lf_type: "untyped", lf_gate: "block" } });
  assert.deepEqual([plain.ok, plain.price, plain.entry_basis, plain.zone_type, plain.gate], [true, 4100.8, "limit_first", "untyped", "block"]);
  // The own zone's near edge (4100.7) stands 0.5 >= 0.4 from the ask: the limit rests there.
  const edge = lf.limitFirstPlacement({ ...base, signal: sig() });
  assert.deepEqual([edge.ok, edge.price, edge.entry_basis, edge.own_zone], [true, 4100.7, "zone_edge", { low: 4098.7, high: 4100.7 }]);
  // A near edge closer than the depth: 0.1 ATR behind the entry, kept inside the zone.
  const near = lf.limitFirstPlacement({ ...base, signal: sig({ lf_zone_low: 4099.5, lf_zone_high: 4101 }) });
  assert.deepEqual([near.ok, near.price, near.entry_basis], [true, 4100.8, "limit_first"]);
  // A narrow zone whose far edge is above the target: never past the far edge.
  const clip = lf.limitFirstPlacement({ ...base, signal: sig({ lf_atr: 20, lf_zone_low: 4100.6, lf_zone_high: 4101 }) });
  assert.deepEqual([clip.ok, clip.price], [true, 4100.8]);
  // Price under the zone: passed. Too little risk left: zone_tight. Inputs missing: refused.
  assert.equal(lf.limitFirstPlacement({ ...base, sym: { ...symbol, bid: 4097.8, ask: 4098 }, signal: sig() }).code, "zone_passed");
  assert.equal(lf.limitFirstPlacement({ ...base, signal: sig({ stop: 4098, lf_zone_low: null, lf_zone_high: null }) }).code, "zone_tight");
  assert.equal(lf.limitFirstPlacement({ ...base, signal: sig({ lf_atr: 0 }) }).code, "limit_first_inputs");
  // The stop and the target are the plan's (broker scale).
  assert.deepEqual([edge.sl, edge.tp], [4095.2, 4111.2]);
});

test("LF-6 a limit-first order is never converted to market; any other order still is (under council)", () => {
  const order = { ticket: 777, type: "BUY_LIMIT", price_open: 4100.7, volume_current: 0.1, sl: 4095.2, tp: 4111.2, comment: ID };
  const act = { id: "lc:777:1", ticket: 777, action: "convert", rule: "council_convert" };
  const refused = limitActionIntents({ orders: [order], sym: EXECUTOR.symbol, actions: [act], entryOrder: "council", meta: { 777: { limit_first: true, signal_issued_ms: ISSUED } } });
  assert.deepEqual(refused.intents ?? refused.out ?? [], []);
  const other = limitActionIntents({ orders: [order], sym: EXECUTOR.symbol, actions: [act], entryOrder: "council", meta: { 777: { signal_issued_ms: ISSUED } } });
  assert.equal(JSON.stringify(other).includes("convert_to_market"), true);
  assert.equal(JSON.stringify(refused).includes("limit-first"), true);
});

test("LF-7 the signal's fields: only on pullback trades; the own-type medium+ zone, the entry's zone type, the record-only gate", () => {
  const decision = {
    strategy: { atr_h1: 4 },
    key_levels: [{ low: 4098.5, high: 4100.5, zone_type: "demand", zone_strength: "medium" }, { low: 4110, high: 4112, zone_type: "supply", zone_strength: "strong" }],
    sd_levels: [{ low: 4099, high: 4101.5, zone_type: "demand", zone_strength: "weak" }]
  };
  const t = { agent: "zone_pullback", entry: 4100 };
  assert.deepEqual(lf.limitFirstSignalFields(decision, t, "BUY"), { lf_atr: 4, lf_type: "demand", lf_gate: "pass", lf_zone_low: 4098.5, lf_zone_high: 4100.5 });
  // A SELL at the same entry sits in a demand zone: opposite type, the gate blocks (record only).
  assert.deepEqual(lf.limitFirstSignalFields(decision, t, "SELL"), { lf_atr: 4, lf_type: "demand", lf_gate: "block" });
  // A weak own zone only: not own-type for the rule.
  assert.deepEqual(lf.limitFirstSignalFields({ ...decision, key_levels: [] }, { ...t, entry: 4101 }, "BUY"), { lf_atr: 4, lf_type: "demand", lf_gate: "block" });
  // No zone at all: untyped.
  assert.deepEqual(lf.limitFirstSignalFields({ strategy: { atr_h1: 4 } }, t, "BUY"), { lf_atr: 4, lf_type: "untyped", lf_gate: "block" });
  // Market-by-design agents and a missing ATR: no field.
  assert.deepEqual(lf.limitFirstSignalFields(decision, { ...t, agent: "sweep_reversal" }, "BUY"), {});
  assert.deepEqual(lf.limitFirstSignalFields({ ...decision, strategy: {} }, t, "BUY"), {});
});

test("LF-8 the entry line says why it waits", () => {
  assert.equal(lf.limitFirstWords({ entry_basis: "zone_edge", entry_zone_type: "demand" }), "limit (limit-first, demand zone edge)");
  assert.equal(lf.limitFirstWords({ entry_basis: "limit_first", entry_zone_type: "supply" }), "limit (limit-first, supply zone)");
  assert.equal(lf.limitFirstWords({ entry_basis: "limit_first", entry_zone_type: "untyped" }), "limit (limit-first, untyped zone)");
  const line = limitLine("placed", { label: "Demo", side: "BUY", ticket: 1, lot: 0.1, price: 4100.7, sl: 4095.2, tp: 4111.2, expiry_ms: NOW, how: "limit (limit-first, demand zone edge)" });
  assert.match(line, /Entry: limit \(limit-first, demand zone edge\)/);
  assert.doesNotMatch(limitLine("placed", { label: "Demo", side: "BUY", ticket: 1, lot: 0.1, price: 4100.7, sl: 4095.2, tp: 4111.2, expiry_ms: NOW }), /Entry:/);
});

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    run: async () => { db.prepare(sql).run(...params); return { meta: {} }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  db.exec(`CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, key_meta TEXT);
    CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created_ms INTEGER, updated_ms INTEGER);
    CREATE TABLE ea_deals (position_ticket INTEGER, volume REAL, exit_price REAL, closed_ms INTEGER);
    CREATE TABLE plan_setups (decision_key TEXT, side TEXT, agent TEXT, source TEXT, status TEXT, results_json TEXT);
    CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT);`);
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

function seedTrades(db, n, { r, e0 }) {
  db.raw.prepare("INSERT INTO omega_settings (id, settings, key_meta) VALUES (1, ?, ?)").run(JSON.stringify({ limit_first: "on" }), "{}");
  for (let i = 0; i < n; i += 1) {
    const key = `OANDA:XAUUSD:15:${1795600000000 + i * 900_000}`;
    // A BUY limit at 4100 (risk 5), filled there; closed at 4100 + 5r.
    db.raw.prepare("INSERT INTO omega_intents VALUES (?, 'place_limit', ?, 'done', ?, ?, ?)").run(`lf${i}`, JSON.stringify({ side: "BUY", limit_first: true, lot: 0.1, entry: 4100, sl: 4095, sl_plan: 4095, r_dist: 5, filled_ms: 1 + i, fill_price: 4100, decision_key: key, strategy: "zone_pullback" }), JSON.stringify({ ticket: 1000 + i }), 10 + i, 10 + i);
    db.raw.prepare("INSERT INTO ea_deals VALUES (?, 0.1, ?, ?)").run(1000 + i, 4100 + 5 * r, 100 + i);
    db.raw.prepare("INSERT INTO plan_setups VALUES (?, 'BUY', 'zone_pullback', 'live', 'resolved', ?)").run(key, JSON.stringify({ "e0@s1": { r: e0, s: "target", f: 1 } }));
  }
}

test("LF-9 the named auto-revert: waits for 30 closed trades; below the e0 replay it turns limit_first off once (setting, event, Telegram); else kept", async () => {
  assert.deepEqual(lf.limitFirstVerdict(Array.from({ length: 29 }, () => ({ r: -1, e0: 1 }))), { ready: false, n: 29, mean_r: -1, mean_e0: 1, revert: false });
  // Worse: 30 trades at +0.1R against the replay's +0.3R.
  const db = d1(), store = kv(), writes = [], lines = [];
  seedTrades(db, 30, { r: 0.1, e0: 0.3 });
  const env = { DB: db, SIGNAL_CACHE: store };
  const write = async (body, actor) => { writes.push({ body, actor }); return { ok: true }; };
  const out = await lf.limitFirstRevert(env, { now: 1_000_000, write, send: async (t) => lines.push(t) });
  assert.deepEqual([out.status, out.n, out.mean_r, out.mean_e0], ["reverted", 30, 0.1, 0.3]);
  assert.deepEqual(writes, [{ body: { limit_first: "off" }, actor: "agent:limit-first" }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /limit_first\) off: its first 30 closed trades averaged \+0\.1R, below the \+0\.3R/);
  assert.doesNotMatch(lines[0], /4100|4095/, "no price");
  assert.deepEqual(db.raw.prepare("SELECT actor, action FROM omega_events").all().map((r) => ({ ...r })), [{ actor: "agent:limit-first", action: "limit_first_reverted" }]);
  assert.equal((await lf.limitFirstRevert(env, { now: 1_000_001, write, send: async (t) => lines.push(t) })).status, "done", "once per window");
  assert.equal(writes.length, 1);
  // Better or equal: kept, nothing written.
  const db2 = d1(), w2 = [];
  seedTrades(db2, 30, { r: 0.4, e0: 0.3 });
  const kept = await lf.limitFirstRevert({ DB: db2, SIGNAL_CACHE: kv() }, { now: 1, write: async (b) => { w2.push(b); return { ok: true }; } });
  assert.deepEqual([kept.status, w2.length], ["kept", 0]);
  // Fewer than 30: waiting. Off: inactive.
  const db3 = d1(); seedTrades(db3, 10, { r: -1, e0: 1 });
  assert.equal((await lf.limitFirstRevert({ DB: db3, SIGNAL_CACHE: kv() }, { now: 1, write })).status, "waiting");
  const db4 = d1(); db4.raw.prepare("INSERT INTO omega_settings VALUES (1, ?, '{}')").run(JSON.stringify({ limit_first: "off" }));
  assert.equal((await lf.limitFirstRevert({ DB: db4, SIGNAL_CACHE: kv() }, { now: 1, write })).status, "inactive");
});
