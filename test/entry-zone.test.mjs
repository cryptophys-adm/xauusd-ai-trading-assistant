// EZ1, the entry zone (owner 2026-11-23: "decision & signal harusnya memberi nilai zone bukan exact, sehingga omega tidak
// akan info limit through price"): the plans carry a zone beside the entry, the decision and the EA signal carry it, and
// Omega rests its limit inside it when the plan's own level is already through price. ENTRY_ZONE_MODE "off" and a signal
// without a zone are today's behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entryZoneOf, entryZoneMode, tradeLevels, ENTRY_ZONE, STRATEGY_PARAMS } from "../src/strategy-engine.mjs";
import { finishPlan, agentContext, slimPlan } from "../src/strategy-agents.mjs";
import { tradeFor } from "../src/decision-engine.mjs";
import { eaSignalFromDecision, entryZoneFields } from "../src/ea-signal.mjs";
import { planIntents, OMEGA_DEFAULTS, limitPlacement, limitActionIntents, signalEntryZone, zoneLimit, ZONE_MIN_RR, ZONE_MIN_RISK_SHARE, openId } from "../src/omega-engine.mjs";
import { limitKnobs } from "../src/omega-limit-knobs.mjs";
import { entryFacts, pendingFacts } from "../src/limit-council.mjs";
import { replayOmegaLimit } from "../src/ledger-omega-limit.mjs";
import { decisionFromRow } from "../src/ledger-omega4.mjs";
import { publicRecap, recapLeaks } from "../src/public-projection.mjs";
import { replayOmega4 } from "../src/ledger-omega4.mjs";
import { createHash } from "node:crypto";
import { tp1OffSample } from "./support/tp1-off-sample.mjs";

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
// A BUY at the 4100 level (stop 4095, target 4110) on the feed's scale, its zone 4099-4101; the broker is 0.2 above the feed.
const SIGNAL = {
  side: "BUY", action: "ENTER_LIMIT", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, decided_ms: ISSUED + 60_000, expires_ms: ISSUED + 15 * 60_000, blackout: false, kill: false, paused: false,
  feed_basis: 0.2, feed_basis_known: true, key_levels: "4099.8:4100.1,4100.3:4100.6", power: 0.4, power_ms: ISSUED,
  quorum_long_share: 0.7, quorum_short_share: 0.2, veto_long: false, veto_short: false, trading_mode: "intraday", trade_agent: "zone_pullback",
  entry_zone_low: 4099, entry_zone_high: 4101
};
const NO_ZONE = (() => { const { entry_zone_low, entry_zone_high, ...rest } = SIGNAL; return rest; })();
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000, executor: { version: "1.21" },
  account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: [], orders: []
};
const ON = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
const LIMIT = { ...ON, entry_order: "limit" };
const ID = openId(ISSUED, "BUY");
const ex = (sym = {}) => ({ ...EXECUTOR, symbol: { ...EXECUTOR.symbol, ...sym } });
const answered = { id: ID, status: "answered", choice: "place_limit", rule: "test", reason: "the test's answer" };
const plan = (over = {}) => planIntents({ signal: SIGNAL, control: { mode: "active" }, settings: LIMIT, executor: EXECUTOR, now: NOW, engineEnabled: true, entryCouncil: answered, ...over });
const codes = (r) => r.notes.map((n) => n.code);
const ACCOUNT = { margin_mode: "hedging" };
const place = (signal, sym, minDist = 0) => limitPlacement({ signal, sym: { ...EXECUTOR.symbol, ...sym }, account: ACCOUNT, planStopDist: Math.abs(signal.entry - signal.stop), minDist });

test("EZ1 entryZoneOf: a key zone's band clipped to 0.5 x ATR(1H) around the entry; a structural plan's entry +/- 0.15 x ATR(1H); never past half the risk", () => {
  assert.deepEqual(ENTRY_ZONE, { band_max_atr: 0.5, structural_atr: 0.15, stop_share: 0.5 });
  // A 10-wide zone around a long entry at 4100 with ATR 4: clipped to 4099-4101 (2 = 0.5 x 4).
  assert.deepEqual(entryZoneOf({ dir: 1, entry: 4100, stop: 4090, atrH1: 4, band: [4095, 4105] }), { entry_low: 4099, entry_high: 4101 });
  // A narrow zone stays as it is; an entry at its near edge keeps the zone's side of it.
  assert.deepEqual(entryZoneOf({ dir: 1, entry: 4098, stop: 4090, atrH1: 4, band: [4097.5, 4098] }), { entry_low: 4097.5, entry_high: 4098 });
  // Entry just outside the band (at the level, within near): the band is widened to hold it, then clipped around it.
  assert.deepEqual(entryZoneOf({ dir: -1, entry: 4099, stop: 4110, atrH1: 4, band: [4100, 4100.5] }), { entry_low: 4099, entry_high: 4100 });
  assert.deepEqual(entryZoneOf({ dir: -1, entry: 4099.5, stop: 4110, atrH1: 4, band: [4100, 4100.5] }), { entry_low: 4099.5, entry_high: 4100.5 });
  // Structural: +/- 0.15 x ATR.
  assert.deepEqual(entryZoneOf({ dir: -1, entry: 3579.82, stop: 3590, atrH1: 10 }), { entry_low: 3578.32, entry_high: 3581.32 });
  // The stop's side never reaches past half the risk: a long with a 1.0 risk keeps its low at entry - 0.5.
  assert.deepEqual(entryZoneOf({ dir: 1, entry: 4100, stop: 4099, atrH1: 10 }), { entry_low: 4099.5, entry_high: 4101.5 });
  assert.deepEqual(entryZoneOf({ dir: -1, entry: 4100, stop: 4101, atrH1: 10 }), { entry_low: 4098.5, entry_high: 4100.5 });
  // No zone: a stop on the wrong side, no ATR, no direction.
  assert.equal(entryZoneOf({ dir: 1, entry: 4100, stop: 4101, atrH1: 4 }), null);
  assert.equal(entryZoneOf({ dir: 1, entry: 4100, stop: 4090, atrH1: 0 }), null);
  assert.equal(entryZoneOf({ dir: 0, entry: 4100, stop: 4090, atrH1: 4 }), null);
  assert.equal(entryZoneMode({}), "on");
  assert.equal(entryZoneMode({ ENTRY_ZONE_MODE: " OFF " }), "off");
});

test("EZ2 the plans: a pullback or at-level plan takes its key zone's band; a structural agent its own; switched off, none", () => {
  const near = STRATEGY_PARAMS.near_atr * 4;
  const levels = [{ low: 4095, high: 4098, label: "the 4095.00–4098.00 key zone", major: true }];
  // A pullback to the zone below price: the zone's band around the entry at its top edge.
  const pull = tradeLevels({ dir: 1, price: 4098 + near + 1, levels, atrH1: 4, entryZone: true });
  assert.equal(pull.at_level, false);
  assert.equal(pull.entry, 4098);
  assert.deepEqual([pull.entry_low, pull.entry_high], [4097, 4098]);
  // At the zone: price inside it is the entry, the zone's band around it.
  const at = tradeLevels({ dir: 1, price: 4096.5, levels, atrH1: 4, entryZone: true });
  assert.equal(at.at_level, true);
  assert.deepEqual([at.entry_low, at.entry_high], [4095.5, 4097.5]);
  // Inside a chart-plane demand zone with no key zone at price: no zone (absent, today's).
  const plane = tradeLevels({ dir: 1, price: 4120, levels, atrH1: 4, inZone: true, entryZone: true });
  assert.equal(plane.at_level, true);
  assert.equal("entry_low" in plane, false);
  // Off: byte-identical to today's plan.
  const off = tradeLevels({ dir: 1, price: 4098 + near + 1, levels, atrH1: 4 });
  const { entry_low, entry_high, ...rest } = pull;
  assert.deepEqual(off, rest);
  assert.equal(JSON.stringify(off), JSON.stringify(rest), "the same keys in the same order");
  // A structural plan (finishPlan): entry +/- 0.15 x ATR when the context asks for it.
  const ctx = agentContext({ strategy: { price: 4100, atr_h1: 4, key_levels: { zones: [] } }, entryZone: true });
  const p = finishPlan("sweep_reversal", 1, { entry: 4100, stop: 4094, atLevel: true, entryNote: "x", stopNote: "y", setup: "z", targets: { tp1: 4112, tp1_note: "a", tp2: 4120, tp2_note: "b" } }, ctx);
  assert.deepEqual([p.entry_low, p.entry_high], [4099.4, 4100.6]);
  const p0 = finishPlan("sweep_reversal", 1, { entry: 4100, stop: 4094, atLevel: true, entryNote: "x", stopNote: "y", setup: "z", targets: { tp1: 4112, tp1_note: "a", tp2: 4120, tp2_note: "b" } }, agentContext({ strategy: { price: 4100, atr_h1: 4, key_levels: { zones: [] } } }));
  assert.equal("entry_low" in p0, false);
  // The stored plan (strategy_plans) and the trade carry the zone; without one, nothing new.
  assert.deepEqual([slimPlan(p).entry_low, slimPlan(p).entry_high], [4099.4, 4100.6]);
  assert.equal("entry_low" in slimPlan(p0), false);
  const t = tradeFor("BUY", p, { minRrr: 1 });
  assert.deepEqual([t.entry, t.entry_low, t.entry_high], [4100, 4099.4, 4100.6]);
  assert.equal("entry_low" in tradeFor("BUY", p0, { minRrr: 1 }), false);
});

const DECISION = (trade) => ({
  decision_key: `OANDA:XAUUSD:15:${ISSUED - 15 * 60_000}`, bar_close: new Date(ISSUED).toISOString(), decided_at: new Date(ISSUED + 60_000).toISOString(), stance: "BUY", confidence: 0.7,
  trade: { side: "BUY", action: "ENTER_LIMIT", entry: 4100, stop: 4095, tp: 4110, tp1: 4110, target: "tp1", trigger_required: false, ...trade },
  guardrails: { long: { entry_trigger: { fired: false } }, short: { entry_trigger: { fired: false } } }
});
/** The EA's own lookup (ea/mt5/CryptophysXAUUSD.mq5 JsonValueStart): the first `"<key>":` in the text, then its value. */
function eaValue(json, key) {
  const needle = `"${key}":`;
  let p = json.indexOf(needle);
  if (p < 0) return undefined;
  p += needle.length;
  const rest = json.slice(p);
  const m = rest.match(/^\s*("([^"]*)"|[^,}\s]+)/);
  return m ? (m[2] ?? m[1]) : undefined;
}

test("EZ3 the signal: flat entry_zone_low/high only for a zone that holds the entry short of the stop; the EA's keys read the same values", () => {
  const withZone = eaSignalFromDecision({ decision: DECISION({ entry_low: 4099, entry_high: 4101 }), now: NOW });
  const without = eaSignalFromDecision({ decision: DECISION({}), now: NOW });
  assert.deepEqual([withZone.entry_zone_low, withZone.entry_zone_high], [4099, 4101]);
  assert.equal("entry_zone_low" in without, false);
  // A zone that does not hold the entry, or reaches the stop, is not sent.
  assert.deepEqual(entryZoneFields({ entry: 4100, stop: 4095, entry_low: 4100.5, entry_high: 4101 }, "BUY"), {});
  assert.deepEqual(entryZoneFields({ entry: 4100, stop: 4095, entry_low: 4094, entry_high: 4101 }, "BUY"), {});
  assert.deepEqual(entryZoneFields({ entry: 4100, stop: 4105, entry_low: 4099, entry_high: 4105 }, "SELL"), {});
  assert.deepEqual(entryZoneFields({ entry: 4100, stop: 4105, entry_low: 4099, entry_high: 4101 }, "SELL"), { entry_zone_low: 4099, entry_zone_high: 4101 });
  // The needles: every key the MQL5 EA reads finds the same value with the zone in the signal as without it.
  const src = readFileSync(new URL("../ea/mt5/CryptophysXAUUSD.mq5", import.meta.url), "utf8");
  const keys = [...new Set([...src.matchAll(/Json(?:String|Number|Bool)\(json, "([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
  assert.ok(keys.length >= 14, `the EA reads ${keys.length} keys`);
  const a = JSON.stringify({ ...withZone, server_ms: 0 }), b = JSON.stringify({ ...without, server_ms: 0 });
  assert.deepEqual(Object.fromEntries(keys.map((k) => [k, eaValue(a, k)])), Object.fromEntries(keys.map((k) => [k, eaValue(b, k)])));
  assert.equal(eaValue(a, "entry"), "4100", "the needle `\"entry\":` never meets entry_zone_*");
  assert.ok(!keys.some((k) => k.startsWith("entry_zone")), "the EA reads no zone key");
  assert.ok(!Object.keys(withZone).some((k) => /tp2|extended_tp/.test(k)), "no tp2 or extended_tp key");
});

test("EZ4 limitPlacement: a level through price rests inside the zone, above the bid for a SELL (the 23:45-like case), below the ask for a BUY", () => {
  // The 23:45 SELL at its 15m close 3579.82: by placement the bid is 0.3 over it, still inside the zone.
  const sell = { side: "SELL", action: "ENTER_LIMIT", entry: 3579.82, stop: 3590, tp1: 3560, feed_basis: 0, feed_basis_known: true, trading_mode: "scalp", entry_zone_low: 3578.32, entry_zone_high: 3581.32 };
  const s = place(sell, { bid: 3580.12, ask: 3580.32, spread_points: 20 });
  assert.equal(s.ok, true, s.code);
  assert.equal(s.moved, true);
  assert.equal(s.price, 3580.32, "at least one spread above the bid, inside the zone");
  assert.ok(s.price > 3580.12 && s.price <= 3581.32);
  assert.deepEqual([s.sl, s.tp, s.from], [3590, 3560, 3579.82], "the plan's stop and target stay where the plan put them");
  assert.equal(s.rr, 2.099);
  // Without the zone the same moment is today's limit_through_price.
  const { entry_zone_low, entry_zone_high, ...bare } = sell;
  assert.equal(place(bare, { bid: 3580.12, ask: 3580.32 }).code, "limit_through_price");
  // A BUY through the ask (broker scale: the zone is 4099.2-4101.2): one spread below the ask.
  const b = place(SIGNAL, { bid: 4099.8, ask: 4100.0 });
  assert.deepEqual([b.ok, b.moved, b.price, b.sl, b.tp], [true, true, 4099.8, 4095.2, 4110.2]);
  // The broker's stop level is kept too: 30 points from the ask.
  const lvl = place(SIGNAL, { bid: 4099.8, ask: 4100.0, stops_level_points: 30 }, 0.3);
  assert.deepEqual([lvl.ok, lvl.price], [true, 4099.7]);
  // A level within the stop level of price (today's limit_stops_level) moves inside the zone as well.
  const near = place(SIGNAL, { bid: 4100.2, ask: 4100.4 }, 0.3);
  assert.deepEqual([near.ok, near.moved, near.price], [true, true, 4100.1]);
});

test("EZ5 the whole zone passed is zone_passed; a moved limit paying under 1R is zone_rr; neither is limit_through_price", () => {
  const passed = place(SIGNAL, { bid: 4099.1, ask: 4099.3 });
  assert.equal(passed.ok, false);
  assert.equal(passed.code, "zone_passed");
  assert.match(passed.detail, /4099\.2-4101\.2 is passed/);
  const sellPassed = place({ ...SIGNAL, side: "SELL", entry: 4100, stop: 4110, tp1: 4080, entry_zone_low: 4099, entry_zone_high: 4101 }, { bid: 4101.1, ask: 4101.3 });
  assert.equal(sellPassed.code, "zone_passed");
  assert.equal(ZONE_MIN_RR, 1);
  // The target 4103 (broker 4103.2): from 4099.8 it pays 3.4 against a 4.6 risk.
  const rr = place({ ...SIGNAL, tp1: 4103 }, { bid: 4099.8, ask: 4100.0 });
  assert.deepEqual([rr.ok, rr.code], [false, "zone_rr"]);
  // At exactly 1R it rests.
  const one = zoneLimit({ signal: { ...SIGNAL, tp1: 4104.2 }, sym: { ...EXECUTOR.symbol, bid: 4099.8, ask: 4100.0 }, zone: { low: 4099.2, high: 4101.2 }, digits: 2, planStopDist: 5, knobs: limitKnobs("intraday"), from: 4100.2 });
  assert.deepEqual([one.ok, one.rr], [true, 1]);
});

test("EZ5b zone_tight: a move inside the zone never cuts the plan's risk below half (the boundary at exactly half rests)", () => {
  assert.equal(ZONE_MIN_RISK_SHARE, 0.5);
  // A BUY at 4100 (stop 4095: the plan's risk 5), its zone reaching 4096 (broker 4096.2); the stop at the broker 4095.2.
  const wide = { ...SIGNAL, entry_zone_low: 4096, entry_zone_high: 4101 };
  // The ask at 4097.9: the limit one spread below, 4097.7, keeps 2.5 = half the risk: it rests.
  const half = place(wide, { bid: 4097.7, ask: 4097.9 });
  assert.deepEqual([half.ok, half.moved, half.price], [true, true, 4097.7]);
  // One tick lower, 4097.69, keeps 2.49: zone_tight, not zone_rr.
  const tight = place(wide, { bid: 4097.69, ask: 4097.89 });
  assert.deepEqual([tight.ok, tight.code, tight.price], [false, "zone_tight", 4097.69]);
  assert.match(tight.detail, /2\.49 of risk to the plan's stop, under 2\.5 \(0\.5 x the plan's 5\)/);
  // A SELL moved up toward its stop the same way.
  const sell = { ...SIGNAL, side: "SELL", entry: 4100, stop: 4110, tp1: 4080, entry_zone_low: 4099, entry_zone_high: 4108 };
  // Its risk is 10 (broker stop 4110.2): a limit at 4105.2 keeps exactly half, one at 4105.21 does not.
  const sHalf = place(sell, { bid: 4105.0, ask: 4105.2 });
  assert.deepEqual([sHalf.ok, sHalf.price], [true, 4105.2]);
  const sTight = place(sell, { bid: 4105.01, ask: 4105.21 });
  assert.deepEqual([sTight.code, sTight.price], ["zone_tight", 4105.21]);
  // The broker's stop level counts too: the floor is max(stop level, half the risk).
  // A 3.0 stop level puts the limit at 4097.9, 2.7 of risk: above half (2.5) but under the stop level, so zone_tight.
  const lvl = zoneLimit({ signal: wide, sym: { ...EXECUTOR.symbol, bid: 4100.7, ask: 4100.9 }, zone: { low: 4096.2, high: 4101.2 }, digits: 2, planStopDist: 5, minDist: 3, knobs: limitKnobs("intraday"), from: 4100.2 });
  assert.deepEqual([lvl.code, lvl.price], ["zone_tight", 4097.9]);
});

test("EZ6 no zone, or a zone that no longer holds the signal: today's placement, result for result", () => {
  for (const sym of [{ bid: 4101, ask: 4101.2 }, { bid: 4099.8, ask: 4100.0 }, { bid: 4100.2, ask: 4100.4 }, { bid: 4140, ask: 4140.2 }]) {
    for (const minDist of [0, 0.3]) {
      const today = place(NO_ZONE, sym, minDist);
      assert.equal("zone" in today, false);
      // Away from the level (no refusal), the zone changes nothing at all.
      if (today.ok || today.code === "limit_out_of_band") assert.deepEqual(place(SIGNAL, sym, minDist), today);
    }
  }
  // A grid adaptation that moved the entry out of the zone, or a zone reaching the stop: ignored.
  assert.equal(signalEntryZone({ ...SIGNAL, entry: 4102 }), null);
  assert.equal(signalEntryZone({ ...SIGNAL, stop: 4099.5 }), null);
  assert.equal(signalEntryZone({ ...SIGNAL, entry_zone_low: 4101, entry_zone_high: 4099 }), null);
  assert.deepEqual(signalEntryZone(SIGNAL), { low: 4099.2, high: 4101.2 });
  assert.equal(place({ ...SIGNAL, entry: 4102, stop: 4097, entry_zone_low: 4099, entry_zone_high: 4101 }, { bid: 4101.8, ask: 4102 }).code, "limit_through_price");
});

test("EZ7 planIntents: the moved limit's order keeps the plan's stop and target, records the zone and its move; without a zone today's refusal", () => {
  const r = plan({ executor: ex({ bid: 4099.8, ask: 4100.0 }) });
  const it = r.intents.find((x) => x.kind === "place_limit");
  assert.ok(it, codes(r).join(","));
  assert.deepEqual([it.entry, it.sl, it.tp], [4099.8, 4095.2, 4110.2]);
  assert.deepEqual(it.entry_zone, { low: 4099.2, high: 4101.2 });
  assert.equal(it.zone_from, 4100.2);
  assert.equal(it.volume, `${it.lot}@4099.8`);
  assert.ok(codes(r).includes("limit_in_zone"));
  // The lot: risk_pct at the moved stop distance, never above tight_stop_max_lot_factor x the plan's lot.
  assert.ok(it.lot <= 0.15 + 1e-9);
  // No zone: today's limit_through_price, no order.
  const bare = plan({ signal: NO_ZONE, executor: ex({ bid: 4099.8, ask: 4100.0 }) });
  assert.deepEqual(bare.intents.filter((x) => x.kind === "place_limit"), []);
  assert.ok(codes(bare).includes("limit_through_price"));
  // A placement away from price is today's order with the zone recorded beside it.
  const away = plan();
  const away0 = plan({ signal: NO_ZONE });
  const a = away.intents.find((x) => x.kind === "place_limit"), a0 = away0.intents.find((x) => x.kind === "place_limit");
  const { entry_zone, ...rest } = a;
  assert.deepEqual(rest, a0);
  assert.deepEqual(entry_zone, { low: 4099.2, high: 4101.2 });
  // The whole zone passed: zone_passed, no order.
  const passed = plan({ executor: ex({ bid: 4099.1, ask: 4099.3 }) });
  assert.deepEqual(passed.intents.filter((x) => x.kind === "place_limit"), []);
  assert.ok(codes(passed).includes("zone_passed"));
});

test("EZ8 a move never leaves the zone (Omega's check and the pending council's levels); zone_passed counts as price_at_level", () => {
  const ORDER = { ticket: 777, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 4099.4, sl: 4095.2, tp: 4110.2, comment: ID, magic: 920200, source: "omega", placed_ms: NOW - 60_000 };
  const meta = { 777: { entry_zone: { low: 4099.2, high: 4101.2 } } };
  const sym = { ...EXECUTOR.symbol, bid: 4103, ask: 4103.2 };
  const inside = limitActionIntents({ orders: [ORDER], sym, actions: [{ id: "a:1", ticket: 777, action: "move", price: 4101, max_move: 5, rule: "council" }], meta });
  assert.equal(inside.intents[0]?.kind, "modify_order");
  const out = limitActionIntents({ orders: [ORDER], sym, actions: [{ id: "a:2", ticket: 777, action: "move", price: 4101.6, max_move: 5, rule: "council" }], meta });
  assert.deepEqual(out.intents, []);
  assert.match(out.dropped[0].reason, /leaves the entry zone 4099.2-4101.2/);
  // Without a zone on the order: today's move.
  assert.equal(limitActionIntents({ orders: [ORDER], sym, actions: [{ id: "a:3", ticket: 777, action: "move", price: 4101.6, max_move: 5, rule: "council" }], meta: {} }).intents[0]?.kind, "modify_order");
  // The pending council is offered only levels inside the zone.
  const levels = [{ low: 4100.5, high: 4100.8 }, { low: 4101.6, high: 4101.9 }];
  const f = pendingFacts({ order: ORDER, meta: { ...meta[777], knobs: limitKnobs("intraday") }, sym, atr15: 20, levels, now: NOW });
  assert.deepEqual(f.candidates, [4100.5]);
  assert.deepEqual(pendingFacts({ order: ORDER, meta: { knobs: limitKnobs("intraday") }, sym, atr15: 20, levels, now: NOW }).candidates, [4100.5, 4101.6]);
  const facts = entryFacts({ request: { side: "BUY", limit: { refused: "zone_passed", away_r: -0.2 } }, decision: null, rooms: [] });
  assert.equal(facts.holds.price_at_level, true);
});

test("EZ9 the limit counterfactual places inside the zone where the level is through price, and misses with zone_passed past it", () => {
  const M1 = 60_000, M15 = 15 * M1, C = Date.parse("2026-11-19T12:00:00Z");
  const key = `OANDA:XAUUSD:15:${C - M15}`;
  // Price over the SELL level from before the decision (as L3), then down through it.
  const at = (p) => (t) => (t < C + 20 * M1 ? p : 1990);
  const price = at(2001);
  const pathOf = (fn) => { const out = []; for (let t = C - 5 * 3600_000; t < C + 60 * M1; t += M1) { const o = fn(t), c = fn(t + M1); out.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c }); } return out; };
  const decision = (trade) => decisionFromRow({ decision_json: JSON.stringify({
    decision_key: key, bar_close: new Date(C).toISOString(), decided_at: new Date(C + 2 * M1).toISOString(), stance: "SELL", confidence: 0.7, trade,
    guardrails: { long: { entry_trigger: { fired: false, note: "waiting" } }, short: { entry_trigger: { fired: false, note: "waiting" } } },
    quorum: { score: -0.3, long_share: 0.2, short_share: 0.8 }, key_levels: [{ low: 1940, high: 1942 }], agent_confidence: { zone_pullback: { long: 0.6, short: 0.85 } },
    agent_confidence_prev: { zone_pullback: { long: 0.6, short: 0.85 } }, trading_mode: "scalp", strategy_execution: false, context: { regime_1h: "normal-ranging" }, strategy: { atr_h1: 5 }
  }) });
  const trade = { side: "SELL", action: "ENTER_LIMIT", entry: 2000, stop: 2020, tp: 1970, tp1: 1970, target: "tp1", agent: "zone_pullback" };
  const base = { settings: { ...OMEGA_DEFAULTS, enabled: true }, profileAt: () => "aggressive", from: C, to: C + 60 * M1 };
  // Bid 2001 over the SELL level 2000, inside the zone 1997-2003: a limit rests inside it (today: limit_through_price).
  const today = replayOmegaLimit({ ...base, bars: pathOf(price), decisions: [decision(trade)] }).records[key];
  assert.deepEqual([today.limit_status, today.limit_gate], ["missed", "limit_through_price"]);
  const zoned = replayOmegaLimit({ ...base, bars: pathOf(price), decisions: [decision({ ...trade, entry_low: 1997, entry_high: 2003 })] }).records[key];
  assert.notEqual(zoned.limit_gate, "limit_through_price");
  assert.ok(["closed", "open", "resting", "missed"].includes(zoned.limit_status));
  assert.notEqual(zoned.limit_gate, "zone_passed");
  // Bid 2005, past the zone's top 2003: zone_passed.
  const passed = replayOmegaLimit({ ...base, bars: pathOf(at(2005)), decisions: [decision({ ...trade, entry_low: 1997, entry_high: 2003 })] }).records[key];
  assert.deepEqual([passed.limit_status, passed.limit_gate], ["missed", "zone_passed"]);
});

test("EZ10 the public recap carries no zone, and the zone keys are forbidden at any depth", () => {
  const row = { bar_close: "2026-11-20T11:00:00.000Z", stance: "BUY", confidence: 0.7, decision_json: JSON.stringify({ ...DECISION({ entry_low: 4099, entry_high: 4101 }), strategy_plans: { long: { zone_pullback: { entry_low: 4099, entry_high: 4101 } } } }) };
  const r = publicRecap(row);
  assert.deepEqual(recapLeaks(r), []);
  assert.doesNotMatch(JSON.stringify(r), /entry_low|entry_high|entry_zone/);
  assert.equal(recapLeaks({ a: { entry_zone_low: 1 } }).length, 1);
  assert.equal(recapLeaks({ a: [{ entry_high: 1 }] }).length, 1);
});

test("EZ11 off is byte-identical to main: the seeded plan sample hashes as on main; on, it only adds the zone keys", () => {
  const off = tp1OffSample();
  // The hash of this sample on main before TP1-KZ and EZ1 (test/tp1-key-zone.test.mjs TK5).
  assert.equal(createHash("sha256").update(off).digest("hex"), "e71b8114bfb67ea5301f75d0377d4956a4f705b67689cca24bf6ff6d69d77c2c");
  const on = tp1OffSample({ entryZone: true });
  assert.notEqual(on, off);
  let zoned = 0;
  const strip = (k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && "entry_low" in v) { zoned++; const { entry_low, entry_high, ...rest } = v; return rest; }
    return v;
  };
  assert.equal(JSON.stringify(JSON.parse(on, strip)), off, "on, every plan is today's plus entry_low/entry_high");
  assert.ok(zoned > 100, `${zoned} plans carry a zone`);
  // Every zone holds its entry and stays short of its stop.
  for (const row of JSON.parse(on)) for (const p of [row.base, ...Object.values(row.plans).map((a) => a.plan)]) {
    if (!p || !("entry_low" in p)) continue;
    assert.ok(p.entry_low <= p.entry && p.entry <= p.entry_high, `${p.entry_low} ${p.entry} ${p.entry_high}`);
    assert.ok(row.dir > 0 ? p.stop < p.entry_low : p.entry_high < p.stop);
  }
});

test("EZ12 v4 (the market replay) is unchanged by the zone: the same records with and without it", () => {
  const M1 = 60_000, M15 = 15 * M1, C = Date.parse("2026-11-19T12:00:00Z");
  const key = `OANDA:XAUUSD:15:${C - M15}`;
  const fn = (t) => (t < C + 20 * M1 ? 2001 : 1990);
  const bars = []; for (let t = C - 5 * 3600_000; t < C + 60 * M1; t += M1) { const o = fn(t), c = fn(t + M1); bars.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c }); }
  const decision = (trade) => decisionFromRow({ decision_json: JSON.stringify({
    decision_key: key, bar_close: new Date(C).toISOString(), decided_at: new Date(C + 2 * M1).toISOString(), stance: "SELL", confidence: 0.7, trade,
    guardrails: { long: { entry_trigger: { fired: false, note: "waiting" } }, short: { entry_trigger: { fired: false, note: "waiting" } } },
    quorum: { score: -0.3, long_share: 0.2, short_share: 0.8 }, key_levels: [{ low: 1940, high: 1942 }], agent_confidence: { zone_pullback: { long: 0.6, short: 0.85 } },
    agent_confidence_prev: { zone_pullback: { long: 0.6, short: 0.85 } }, trading_mode: "scalp", strategy_execution: false, context: { regime_1h: "normal-ranging" }, strategy: { atr_h1: 5 }
  }) });
  const trade = { side: "SELL", action: "ENTER_LIMIT", entry: 2000, stop: 2020, tp: 1970, tp1: 1970, target: "tp1", agent: "zone_pullback" };
  const base = { settings: { ...OMEGA_DEFAULTS, enabled: true }, profileAt: () => "aggressive", from: C, to: C + 60 * M1, bars };
  const a = replayOmega4({ ...base, decisions: [decision(trade)] });
  const b = replayOmega4({ ...base, decisions: [decision({ ...trade, entry_low: 1997, entry_high: 2003 })] });
  assert.ok(a.records[key], "v4 has the record");
  assert.deepEqual(b.records, a.records);
});
