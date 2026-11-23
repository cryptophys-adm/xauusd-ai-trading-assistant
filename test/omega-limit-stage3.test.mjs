// Omega limit entries, stage 3 (docs/RFC_OMEGA_LIMIT_ENTRY.md §2-§6, owner 2026-11-20): live limit placement behind
// entry_order "limit" and "council", the entry council, the pending council at each 15m close, the deterministic cancels
// of ADR-0020 Amendment 7, the fill's re-check, and the market path unchanged byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  planIntents, settingsFrom, OMEGA_DEFAULTS, LIMIT_ENTRY_AVAILABLE, ENTRY_COUNCIL_WAIT_MS, PLATFORM_MAX_OPEN, INTENT_ID_MAX,
  pendingDeleteReason, limitPlacement, limitActionIntents, fillGuard, fillGapR, openId
} from "../src/omega-engine.mjs";
import { limitKnobs as engineKnobs } from "../src/omega-limit-knobs.mjs";
import { limitKnobs as ledgerKnobs, LIMIT_KNOB_START } from "../src/ledger-omega-limit.mjs";
import {
  entryFacts, entryChoice, cleanEntryCouncil, entryCouncilSchema, pendingFacts, pendingAction, cleanPendingCouncil, runLimitCouncil,
  requestEntryCouncil, readEntryCouncil, pendingLimitActions, resetLimitCouncilSchemaForTests
} from "../src/limit-council.mjs";
import { managementFields } from "../src/ea-signal.mjs";
import { marketOutputs } from "./fixtures/omega-market-path.mjs";

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
// A BUY at the 4100 level (stop 4095, target 4110) on the feed's scale; the broker is 0.2 above the feed.
const SIGNAL = {
  side: "BUY", action: "ENTER_LIMIT", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, decided_ms: ISSUED + 60_000, expires_ms: ISSUED + 15 * 60_000, blackout: false, kill: false, paused: false,
  feed_basis: 0.2, feed_basis_known: true, key_levels: "4099.8:4100.1,4100.3:4100.6", power: 0.4, power_ms: ISSUED,
  quorum_long_share: 0.7, quorum_short_share: 0.2, veto_long: false, veto_short: false, trading_mode: "intraday", trade_agent: "zone_pullback"
};
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000, executor: { version: "1.21" },
  account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: [], orders: []
};
const ON = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
const LIMIT = { ...ON, entry_order: "limit" };
const COUNCIL = { ...ON, entry_order: "council" };
const ID = openId(ISSUED, "BUY");
const ex = (over = {}) => ({ ...EXECUTOR, ...over, account: { ...EXECUTOR.account, ...(over.account ?? {}) }, symbol: { ...EXECUTOR.symbol, ...(over.symbol ?? {}) } });
const sig = (over = {}) => ({ ...SIGNAL, ...over });
const answered = (choice, over = {}) => ({ id: ID, status: "answered", choice, rule: "test", reason: "the test's answer", ...over });
const plan = (over = {}) => planIntents({ signal: SIGNAL, control: { mode: "active" }, settings: LIMIT, executor: EXECUTOR, now: NOW, engineEnabled: true, ...over });
const codes = (r) => r.notes.map((n) => n.code);
const kinds = (r) => r.intents.map((it) => it.kind);
// Omega's resting BUY limit (its comment is its place_limit intent id) and that intent's payload.
const ORDER = { ticket: 777, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 4100.2, sl: 4095.2, tp: 4110.2, comment: ID, magic: 920200, source: "omega", placed_ms: NOW - 60_000 };
const META = { id: ID, side: "BUY", entry: 4100.2, sl: 4095.2, tp: 4110.2, lot: 0.1, signal_issued_ms: ISSUED, placed_ms: NOW - 60_000, expiry_ms: NOW + 59 * 60_000, share0: 0.7, decision_ms: ISSUED, profile: "aggressive", mode: "intraday", strategy: "zone_pullback", knobs: engineKnobs("intraday") };

test("S1 the switch: limit and council behind EA 1.21; market is today's; Aether's carried value is never re-checked", () => {
  assert.equal(LIMIT_ENTRY_AVAILABLE, true);
  assert.equal(OMEGA_DEFAULTS.entry_order, "market");
  for (const v of ["limit", "council"]) {
    assert.match(settingsFrom({ entry_order: v }, OMEGA_DEFAULTS, { ea_version: "1.20" }).error, /^ea_1_21_required/, `${v} below 1.21`);
    assert.match(settingsFrom({ entry_order: v }).error, /^ea_1_21_required.*no version/, `${v} with no version reported`);
    assert.equal(settingsFrom({ entry_order: v }, OMEGA_DEFAULTS, { ea_version: "1.21" }).settings.entry_order, v);
    assert.equal(settingsFrom({ entry_order: v }, OMEGA_DEFAULTS, { ea_version: "1.22.1" }).settings.entry_order, v);
    // A stored value passes through any other change (Aether's policy writes the whole settings back, with no EA check).
    assert.equal(settingsFrom({ entry_order: v, risk_pct: 1 }, { ...OMEGA_DEFAULTS, entry_order: v }).settings.entry_order, v);
  }
  assert.equal(settingsFrom({ entry_order: "market" }, { ...OMEGA_DEFAULTS, entry_order: "limit" }).settings.entry_order, "market", "back to market needs nothing");
  assert.match(settingsFrom({ entry_order: "stop" }, OMEGA_DEFAULTS, { ea_version: "1.21" }).error, /'market', 'limit' or 'council'/);
  // The planner refuses too when the terminal reports an older EA, whatever the setting says.
  const old = plan({ executor: ex({ executor: { version: "1.20" } }), entryCouncil: answered("place_limit") });
  assert.deepEqual([codes(old), kinds(old)], [["ea_1_21_required"], []]);
});

test("S2 every placement refusal, after every gate of today (no market fallback in limit mode)", () => {
  // Today's gates run first and in their order: a blackout is a blackout, not a council question.
  assert.deepEqual(codes(plan({ signal: sig({ blackout: true }) })), ["blackout"]);
  assert.deepEqual(codes(plan({ executor: ex({ symbol: { spread_points: 99 } }) })), ["spread"]);
  const refused = (over, code) => {
    const r = plan(over);
    assert.equal(codes(r).at(-1), code, code);
    assert.deepEqual(kinds(r).filter((k) => k === "open" || k === "place_limit"), [], `${code}: no order, no market entry`);
    assert.equal(r.entry_request, null, `${code}: no council asked`);
  };
  refused({ executor: ex({ account: { margin_mode: "netting" } }) }, "netting_account");
  refused({ signal: sig({ feed_basis_known: false }) }, "basis_unknown");
  refused({ signal: sig({ feed_basis: 1.2 }) }, "limit_through_price"); // 4101.2: at the ask
  refused({ signal: sig({ entry: 4098, stop: 4093, tp1: 4108 }) }, "limit_out_of_band"); // 3.0 from the ask, the band is 0.35 x 5 = 1.75
  refused({ executor: ex({ symbol: { stops_level_points: 150 } }), signal: sig({ stop: 4090, tp1: 4120 }) }, "limit_stops_level");
  // Only one pending Omega order at a time (a resting SELL limit holds a BUY signal back; a BUY one is same_side_unprotected first).
  refused({ executor: ex({ orders: [{ ...ORDER, type: "SELL_LIMIT", price_open: 4102, sl: 4107, tp: 4092 }] }), settings: { ...LIMIT, max_positions: 3 }, pendingMeta: { 777: { ...META, side: "SELL" } } }, "pending_order_exists");
  assert.equal(codes(plan({ executor: ex({ orders: [ORDER] }), settings: { ...LIMIT, max_positions: 3 }, pendingMeta: { 777: META } })).at(-1), "same_side_unprotected", "a pending order is unprotected until filled and locked");
  // The platform cap of 3 counts positions and pending orders together (ADR-0020 A7), below a custom max of 5.
  const three = [1, 2, 3].map((t) => ({ ticket: t, side: "BUY", volume: 0.01, open_price: 4090, sl: 4091, tp: 4120, intent_id: `open:${t}:B`, magic: 920200, source: "omega" }));
  refused({ executor: ex({ positions: three }), settings: { ...LIMIT, max_positions: 5 } }, "platform_cap");
  // The market path with the same book is unchanged (no platform cap there).
  assert.ok(kinds(plan({ executor: ex({ positions: three }), settings: { ...ON, max_positions: 5 }, signal: sig({ entry: 4101, stop: 4096, tp1: 4111 }) })).includes("open"));
  // A pending order counts toward max_positions (today's gate, before stage 3's own).
  assert.equal(codes(plan({ executor: ex({ orders: [ORDER] }), pendingMeta: { 777: META } })).at(-1), "max_positions");
  // The limit's helper on its own.
  assert.deepEqual(limitPlacement({ signal: SIGNAL, sym: EXECUTOR.symbol, account: EXECUTOR.account, planStopDist: 5 }), { ok: true, price: 4100.2, away: 1, away_r: 0.2, knobs: engineKnobs("intraday") });
});

test("S3 limit mode: the council is asked once the gates pass; skip and silence place nothing; place rests the limit, sized at its price", () => {
  const ask = plan();
  assert.deepEqual([codes(ask), kinds(ask)], [["entry_council_waiting"], []]);
  assert.equal(ask.entry_request.id, ID);
  assert.deepEqual(ask.entry_request.limit, { price: 4100.2, away_r: 0.2, band: 0.35, life_min: 60 });
  assert.equal(codes(plan({ entryCouncil: answered("skip") })).at(-1), "council_skip");
  assert.deepEqual(kinds(plan({ entryCouncil: answered("skip") })), []);
  const silent = plan({ entryCouncil: { id: ID, status: "silent", choice: null, rule: "daily_cap" } });
  assert.deepEqual([silent.notes.at(-1), kinds(silent)], [{ code: "council_unavailable", detail: "daily_cap" }, []]);
  // An answer for another signal is no answer.
  assert.equal(codes(plan({ entryCouncil: { ...answered("place_limit"), id: "open:1:B" } })).at(-1), "entry_council_waiting");

  const r = plan({ entryCouncil: answered("place_limit"), account: { spec_status: "validated", profile: "aggressive" } });
  const it = r.intents.find((x) => x.kind === "place_limit");
  // 0.5% of 10 000 at a 5.00 stop from the limit price: 0.10 lot; the stop and target keep the plan's distances from 4100.20.
  assert.deepEqual([it.id, it.side, it.volume, it.entry, it.sl, it.tp, it.ticket], [ID, "BUY", "0.1@4100.2", 4100.2, 4095.2, 4110.2, Math.floor((NOW + 60 * 60_000) / 1000)]);
  assert.ok(it.id.length <= INTENT_ID_MAX);
  assert.deepEqual([it.lot, it.share0, it.decision_ms, it.profile, it.expiry_ms, it.placed_ms, it.entry_order, it.mode, it.r_dist, it.strategy], [0.1, 0.7, ISSUED, "aggressive", NOW + 3_600_000, NOW, "limit", "intraday", 5, "zone_pullback"]);
  // Never GTC: the expiry is in the future, within the mode's bound.
  assert.ok(it.ticket * 1000 > NOW && it.ticket * 1000 <= NOW + engineKnobs("intraday").max_pending_life * 60_000);
  // One placement per signal: the next sync sees its id (already_opened).
  assert.equal(codes(plan({ entryCouncil: answered("place_limit"), recentIntentIds: [ID] })).at(-1), "already_opened");
});

test("S4 sizing at the limit price: today's formula and every hard guard (adaptive stop, profile caps, daily budget, minimum lot)", () => {
  const atPrice = (over) => plan({ entryCouncil: answered("place_limit"), ...over }).intents.find((x) => x.kind === "place_limit");
  // The adaptive stop (0.75 x ATR 8 = 6.00) widens the stop from the limit, the target keeps the reward-to-risk.
  const a = atPrice({ executor: ex({ symbol: { atr_value: 8, atr_points: 800 } }) });
  assert.deepEqual([a.sl, a.tp, a.volume], [4094.2, 4112.2, "0.08@4100.2"]);
  // The same signal at market: the same distances from the ask (the limit only changes the price it is sized at).
  const m = planIntents({ signal: sig({ action: "ENTER_MARKET" }), control: { mode: "active" }, settings: ON, executor: ex({ symbol: { atr_value: 8, atr_points: 800 } }), now: NOW, engineEnabled: true }).intents[0];
  assert.deepEqual([m.sl, m.tp], [4095.2, 4113.2]);
  // The daily budget caps the lot: 40 left above the floor buys 0.08 at a 5.00 stop.
  const b = plan({ entryCouncil: answered("place_limit"), executor: ex({ account: { equity: 9_840 } }) });
  assert.deepEqual([b.intents[0].volume, codes(b)], ["0.08@4100.2", ["lot_capped_daily_budget"]]);
  // Below the minimum lot over the cap: nothing (the hard guards are never bypassed).
  const tiny = plan({ entryCouncil: answered("place_limit"), executor: ex({ account: { equity: 50, day_start_balance: 50, balance: 50 } }) });
  assert.deepEqual([codes(tiny).at(-1), kinds(tiny)], ["volume_below_min", []]);
  assert.deepEqual(codes(plan({ entryCouncil: answered("place_limit"), executor: ex({ symbol: { tick_value_problem: "tick_value_mismatch" } }) })), ["tick_value_mismatch"]);
  // Probation halves the risk, as at market.
  assert.equal(atPrice({ signal: sig({ probation: true, risk_scale: 0.5 }) }).volume, "0.05@4100.2");
});

test("S5 council mode: waits for the council, a silent council is today's market path, each answer is followed", () => {
  const c = (over) => plan({ settings: COUNCIL, ...over });
  assert.deepEqual([codes(c()), kinds(c())], [["entry_council_waiting"], []]);
  // No answer past the wait: today's market path (price is within 0.35 x the stop of the level: a market open).
  const late = c({ now: ISSUED + 60_000 + ENTRY_COUNCIL_WAIT_MS, executor: ex({ received_ms: ISSUED + 60_000 + ENTRY_COUNCIL_WAIT_MS - 1000 }) });
  assert.deepEqual([late.notes[0], kinds(late)], [{ code: "council_unavailable", detail: "no_answer" }, ["open"]]);
  // Today's market path with its own gates: a plan level further away waits for its pullback, as today.
  const away = c({ signal: sig({ entry: 4099, stop: 4094, tp1: 4109 }), entryCouncil: { id: ID, status: "silent", rule: "council_failed" } });
  assert.deepEqual(codes(away), ["council_unavailable", "waiting_for_pullback"]);
  // A silent council (failure or cap) is the market path at once: with price inside 0.35 x the stop, a market open.
  const mkt = sig({ entry: 4101 });
  const silent = c({ signal: mkt, entryCouncil: { id: ID, status: "silent", rule: "council_failed" } });
  assert.deepEqual([codes(silent), kinds(silent)], [["council_unavailable"], ["open"]]);
  assert.equal(silent.intents[0].entry_order, "council");
  assert.deepEqual(kinds(c({ signal: mkt, entryCouncil: answered("enter_market") })), ["open"]);
  assert.deepEqual(kinds(c({ signal: mkt, entryCouncil: answered("skip") })), []);
  const lim = c({ entryCouncil: answered("place_limit") });
  assert.deepEqual([kinds(lim), lim.intents[0].entry_order], [["place_limit"], "council"]);
  // The council chose the limit but it cannot rest any more: no entry (the maker was chosen), said with its reason.
  assert.deepEqual(codes(c({ signal: sig({ feed_basis: 1.2 }), entryCouncil: answered("place_limit") })), ["limit_through_price"]);
});

test("S6 the conversion: the delete first, the market leg only after its result, a fill in between ends it, fresh sizing", () => {
  const orders = [{ ...ORDER, volume_initial: 0.3, volume_current: 0.3 }];
  const convert = { id: `lc:777:${Math.floor(NOW / 900_000) * 15}`, ticket: 777, action: "convert", rule: "council_convert" };
  // 1. The council's convert: the order's delete, and no market leg in the same plan.
  const first = plan({ settings: COUNCIL, executor: ex({ orders }), pendingMeta: { 777: META }, limitActions: [convert] });
  const del = first.intents.find((x) => x.kind === "delete_order");
  assert.deepEqual([del.id, del.ticket, del.reason, del.side, del.signal_issued_ms], ["del:777:cv", 777, "convert_to_market", "BUY", ISSUED]);
  assert.ok(!kinds(first).includes("open"));
  assert.deepEqual(first.limit_used, [convert.id]);
  // Only under "council".
  assert.deepEqual(plan({ executor: ex({ orders }), pendingMeta: { 777: META }, limitActions: [convert] }).limit_dropped.map((d) => d.reason), ["a conversion to market needs entry_order council"]);
  const leg = (conversion, over = {}) => plan({ settings: COUNCIL, signal: sig({ entry: 4101 }), conversion: { ticket: 777, side: "BUY", signal_issued_ms: ISSUED, filled: false, ...conversion }, ...over });
  // 2. The delete not answered yet: nothing.
  assert.deepEqual([codes(leg({ deleted: null })).at(-1), kinds(leg({ deleted: null }))], ["conversion_waiting_cancel", []]);
  // 3. Answered, but the terminal still reports the order: still nothing.
  assert.equal(codes(leg({ deleted: true }, { executor: ex({ orders }) })).at(-1), "pending_order_exists");
  // 4. Gone: the market leg, under its own id, sized afresh at its price (0.5% at the plan's 6.00 stop: 0.08), never the
  //    limit's 0.3 lot.
  const go = leg({ deleted: true });
  const open = go.intents.find((x) => x.kind === "open");
  assert.deepEqual([open.id, open.volume, open.converted_from, open.entry, open.sl], [`${ID}:m`, 0.08, 777, 4101.2, 4095.2]);
  assert.ok(codes(go).includes("conversion_market_leg"));
  // Its gates are today's: a blackout holds it.
  assert.equal(codes(leg({ deleted: true }, { signal: sig({ entry: 4101, blackout: true }) })).at(-1), "blackout");
  // 5. A fill in the meantime ends it: no market leg (the fill is managed as any limit fill).
  const filled = leg({ deleted: false, filled: true });
  assert.ok(codes(filled).includes("conversion_ended_fill"));
  assert.ok(!filled.intents.some((x) => x.id === `${ID}:m`));
  // A failed delete ends it too; one leg per signal: once sent, never again.
  assert.ok(codes(leg({ deleted: false })).includes("conversion_cancel_failed"));
  assert.ok(!leg({ deleted: true }, { recentIntentIds: [`${ID}:m`] }).intents.some((x) => x.id === `${ID}:m`));
});

test("S7 a move only toward price, within move_max_atr x ATR, the stop and target shifted the same, the lot untouched", () => {
  const sym = EXECUTOR.symbol, o = { ...ORDER, price_open: 4099.8, sl: 4094.8, tp: 4109.8 };
  const move = (price, max_move = 0.5) => limitActionIntents({ orders: [o], sym, actions: [{ id: "lc:777:29411100", ticket: 777, action: "move", rule: "council_move", price, max_move }] });
  const ok = move(4100.2);
  assert.deepEqual(ok.intents, [{ id: "mo:777:29411100", kind: "modify_order", ticket: 777, volume: 4100.2, sl: 4095.2, tp: 4110.2, reason: "limit_move_council_move", from_price: 4099.8 }]);
  assert.ok(!("lot" in ok.intents[0]), "a modify_order never carries a lot: the EA keeps the order's volume");
  assert.match(move(4099.5).dropped[0].reason, /not toward price/);
  assert.match(move(4100.5, 0.5).dropped[0].reason, /more than 0.5/);
  assert.match(move(4101.3, 2).dropped[0].reason, /no room/, "through the ask");
  // The council's move is to a broker key level it was shown, toward price within move_max_atr x ATR.
  const f = pendingFacts({ order: o, meta: META, decision: { stance: "SELL", quorum: { long_share: 0.6 } }, sym, atr15: 1, levels: [{ low: 4100.0, high: 4100.1 }, { low: 4100.3, high: 4100.6 }, { low: 4105, high: 4106 }], now: NOW });
  assert.deepEqual([f.max_move, f.candidates], [0.5, [4100, 4100.3]]);
  assert.deepEqual(pendingAction(f, { answer: "move", move_to: 4100.3, reason: "x" }).price, 4100.3);
  assert.equal(pendingAction(f, { answer: "move", move_to: 4105, reason: "x" }).rule, "move_not_a_level");
});

test("S8 the pending council: a measured reason or the order is kept; a silent council cancels at that close", () => {
  const sym = EXECUTOR.symbol;
  const facts = (decision, over = {}) => pendingFacts({ order: ORDER, meta: META, decision, sym, atr15: 4, levels: [], now: NOW, ...over });
  const wait = facts({ stance: "WAIT", quorum: { long_share: 0.6 }, agent_confidence: { zone_pullback: { long: 0.7 } }, agent_confidence_prev: { zone_pullback: { long: 0.7 } } });
  assert.deepEqual(wait.reasons, [], "a WAIT stance alone is never a reason");
  for (const answer of ["cancel", "move", "convert"]) assert.equal(pendingAction(wait, { answer, move_to: null, reason: "x" }).rule, "keep_no_reason");
  assert.equal(pendingAction(wait, { answer: "keep", move_to: null, reason: "x" }).action, "keep");
  assert.deepEqual(pendingAction(wait, null), { action: "cancel", rule: "council_unavailable", why: "the council did not answer at this 15m close: the order is cancelled (no pending order is left unattended)" });
  const against = facts({ stance: "SELL", quorum: { long_share: 0.3 } });
  assert.equal(pendingAction(against, { answer: "cancel", move_to: null, reason: "x" }).rule, "council_cancel");
  const drop = facts({ stance: "WAIT", agent_confidence: { zone_pullback: { long: 0.5 } }, agent_confidence_prev: { zone_pullback: { long: 0.8 } } });
  assert.match(drop.reasons[0], /confidence dropped/);
  const far = facts({ stance: "BUY" }, { sym: { ...sym, ask: 4104.4, bid: 4104.2 } });
  assert.match(far.reasons[0], /x ATR\(14\) 15m from the order/, "1.05 x ATR away, more than 0.5");
  assert.equal(pendingAction(far, { answer: "convert", move_to: null, reason: "x" }).rule, "convert_needs_council_mode");
  assert.equal(pendingAction({ ...far, entry_order: "council" }, { answer: "convert", move_to: null, reason: "x" }).action, "convert");
  assert.equal(cleanPendingCouncil({ answer: "sell" }), null);
  // The cancel reaches the broker as a delete with its reason; an action for an order gone is dropped.
  const c = limitActionIntents({ orders: [ORDER], sym, actions: [{ id: "lc:777:5", ticket: 777, action: "cancel", rule: "council_unavailable" }, { id: "lc:9:5", ticket: 9, action: "cancel", rule: "council_cancel" }] });
  assert.deepEqual(c.intents.map((x) => [x.id, x.kind, x.ticket, x.reason]), [["del:777:c5", "delete_order", 777, "council_unavailable"]]);
  assert.deepEqual(c.dropped, [{ id: "lc:9:5", reason: "the order is no longer pending" }]);
});

test("S9 the deterministic cancels, in their order, with no council (ADR-0020 A7)", () => {
  const why = (over = {}) => pendingDeleteReason({ settings: LIMIT, signal: SIGNAL, control: { mode: "active" }, executor: EXECUTOR, account: { spec_status: "validated", profile: "aggressive" }, lossFloor: 9_800, budget: 100, order: ORDER, meta: META, now: NOW, ...over });
  assert.equal(why(), null, "nothing holds: kept");
  const newer = { power_ms: ISSUED + 900_000 };
  assert.equal(why({ signal: sig({ ...newer, quorum_long_share: 0.64 }) }), "quorum_share_drop", "0.70 to 0.64: more than 0.05");
  assert.equal(why({ signal: sig({ ...newer, quorum_long_share: 0.66 }) }), null, "0.04 is within cancel_share_drop");
  assert.equal(why({ signal: sig({ quorum_long_share: 0.5 }) }), null, "the placing decision itself is no drop");
  assert.equal(why({ signal: sig({ veto_long: true }) }), "de_veto");
  assert.equal(why({ signal: sig({ veto_short: true }) }), null, "a veto of the other side");
  assert.equal(why({ account: { spec_status: "validated", profile: "safe" } }), "profile_downgrade");
  assert.equal(why({ now: NOW + 59 * 60_000 }), "pending_expired", "60 minutes from the EA's placed_ms (intraday)");
  assert.equal(why({ meta: null }), "pending_unrecorded");
  assert.equal(why({ budget: 0 }), "daily_risk_budget");
  // The order of the reasons: the global ones first, then the order's own.
  const real = ex({ account: { trade_mode: "real" } });
  assert.equal(why({ executor: real, signal: sig({ veto_long: true }) }), "disarmed", "disarm before the veto");
  assert.equal(why({ signal: sig({ paused: true, veto_long: true }) }), "paused");
  assert.equal(why({ signal: sig({ blackout: true }), budget: 0 }), "blackout");
  assert.equal(why({ lossFloor: 10_000, budget: 0 }), "daily_loss_limit");
  assert.equal(why({ budget: 0, account: { spec_status: "validated", profile: "safe" } }), "daily_risk_budget");
  assert.equal(why({ account: { spec_status: "validated", profile: "safe" }, signal: sig({ veto_long: true }) }), "profile_downgrade");
  assert.equal(why({ signal: sig({ ...newer, veto_long: true, quorum_long_share: 0.1 }) }), "de_veto");
  assert.equal(why({ signal: sig({ ...newer, quorum_long_share: 0.1 }), now: NOW + 3_600_000 }), "quorum_share_drop");
  assert.equal(why({ settings: { ...LIMIT, entry_order: "market" } }), "entry_order_market");
  // In the plan: each reason is a delete_order with its reason; a kill closes all, Omega off deletes (stage 1).
  const r = plan({ executor: ex({ orders: [ORDER] }), pendingMeta: { 777: META }, signal: sig({ veto_long: true, side: "NONE" }) });
  assert.deepEqual(r.intents.map((x) => [x.kind, x.ticket, x.reason]), [["delete_order", 777, "de_veto"]]);
  assert.deepEqual(plan({ executor: ex({ orders: [{ ...ORDER, sl: 0 }] }) }).intents.map((x) => x.reason), ["pending_without_stop"]);
  assert.deepEqual(plan({ settings: { ...LIMIT, enabled: false }, executor: ex({ orders: [ORDER] }) }).intents.map((x) => x.reason), ["engine_off"]);
  assert.deepEqual(kinds(plan({ control: { mode: "killed", at: "2026-11-20T11:01:00.000Z" }, executor: ex({ orders: [ORDER] }) })), ["close_all"]);
  assert.deepEqual(plan({ settings: { ...ON }, executor: ex({ orders: [ORDER] }) }).intents.filter((x) => x.kind === "delete_order").map((x) => x.reason), ["entry_order_market"], "back to market: deleted at the next sync");
});

test("S10 the fill's re-check: each hard guard closes the new position at once; otherwise it is the Position Manager's", () => {
  const pos = { ticket: 777, symbol: "XAUUSD", side: "BUY", volume: 0.1, open_price: 4100.2, sl: 4095.2, tp: 4110.2, intent_id: ID, magic: 920200, source: "omega", opened_ms: NOW - 1000 };
  const sym = EXECUTOR.symbol, account = EXECUTOR.account;
  const aggr = { profile: "aggressive", hard_cap_pct: 10, open_risk_pct: 10 };
  const g = (over = {}) => fillGuard({ position: pos, others: [], pending: [], sym, account, limits: aggr, lossFloor: 9_800, ...over });
  assert.equal(g(), null);
  assert.equal(g({ sym: { ...sym, tick_value_problem: "tick_value_mismatch" } }), "tick_value_mismatch");
  assert.equal(g({ sym: { ...sym, volume_min: 0.2 } }), "volume_below_min");
  assert.equal(g({ sym: { ...sym, volume_max: 0.05 } }), "volume_above_max");
  assert.equal(g({ limits: { profile: "safe", hard_cap_pct: 0.4, open_risk_pct: 2 } }), "hard_cap", "50 is 0.5% of 10 000");
  assert.equal(g({ limits: { ...aggr, open_risk_pct: 0.6 }, others: [{ ...pos, ticket: 5, open_price: 4100, sl: 4099.2 }] }), "open_risk_cap");
  assert.equal(g({ lossFloor: 9_960 }), "daily_risk_budget", "40 left above the floor, 50 at the stop");
  assert.equal(g({ position: { ...pos, sl: 0 } }), "hard_cap", "no stop: unbounded");
  // In the plan: the close comes first, with the guard as its reason; a clean fill is only recorded.
  const bad = plan({ executor: ex({ positions: [pos], account: { equity: 9_840, day_start_balance: 10_000 } }), limitFills: [777], pendingMeta: { 777: META }, signal: sig({ side: "NONE" }) });
  assert.deepEqual(bad.intents[0], { id: "cl:777:fg", kind: "close", ticket: 777, reason: "fill_guard_daily_risk_budget" });
  assert.deepEqual(bad.fill_checks, [{ ticket: 777, guard: "daily_risk_budget" }]);
  const good = plan({ executor: ex({ positions: [pos] }), limitFills: [777], pendingMeta: { 777: META }, signal: sig({ side: "NONE" }) });
  assert.deepEqual([good.fill_checks, kinds(good)], [[{ ticket: 777, guard: null }], []]);
  // The planned against the filled price, in R (positive: worse).
  assert.equal(fillGapR({ side: "BUY", planned: 4100.2, filled: 4100.3, rDist: 5 }), 0.02);
  assert.equal(fillGapR({ side: "SELL", planned: 4100.2, filled: 4100.3, rDist: 5 }), -0.02);
});

test("S11 the entry council's answer: the measured reason rule under council, place or skip under limit", () => {
  const request = { id: ID, side: "BUY", entry_order: "council", agent: "zone_pullback", limit: { price: 4100.2, away_r: 0.2 } };
  const decision = { stance: "BUY", quorum: { long_share: 0.6 }, quorum_prev: { long_share: 0.7 }, agent_confidence: { zone_pullback: { long: 0.6 } }, agent_confidence_prev: { zone_pullback: { long: 0.7 } }, reasons: ["r"] };
  const f = entryFacts({ request, decision, rooms: [{ room: "4H", bias: "bearish" }, { room: "1H", bias: "BULLISH" }] });
  assert.deepEqual(f.holds, { htf_against: true, htf_with: false, confidence_drop: true, confidence_rising: false, quorum_share_drop: true, price_away_from_level: true, price_at_level: false });
  const choose = (answer, measured, ff = f) => entryChoice(ff, cleanEntryCouncil({ answer, measured, reason: "r" }, "council"));
  assert.deepEqual(choose("skip", ["htf_against"]), { status: "answered", choice: "skip", rule: "htf_against", reason: "r" });
  assert.equal(choose("place_limit", ["price_away_from_level"]).choice, "place_limit");
  const none = choose("skip", ["htf_with"]);
  assert.deepEqual([none.choice, none.rule], ["enter_market", "no_measured_reason"], "a reason that does not hold is today's market entry");
  assert.equal(choose("enter_market", ["price_at_level"]).rule, "no_measured_reason");
  assert.equal(entryChoice(f, null, { silentRule: "daily_cap" }).status, "silent");
  const lf = entryFacts({ request: { ...request, entry_order: "limit" }, decision, rooms: [] });
  assert.equal(entryChoice(lf, cleanEntryCouncil({ answer: "place", measured: [], reason: "r" }, "limit")).choice, "place_limit");
  assert.equal(entryChoice(lf, cleanEntryCouncil({ answer: "skip", measured: [], reason: "r" }, "limit")).choice, "skip");
  assert.equal(cleanEntryCouncil({ answer: "enter_market" }, "limit"), null, "limit mode answers place or skip only");
  assert.deepEqual(entryCouncilSchema("council").properties.answer.enum, ["enter_market", "place_limit", "skip"]);
});

test("S12 the market path is unchanged byte for byte (hand fixtures and v4's replay traces, hashed before stage 3)", () => {
  // SLG1 (2026-11-23): stage 2 had no profit-lock gate; profit_lock_gate "legacy" is that code byte for byte.
  const outs = marketOutputs({ profitLockGate: "legacy" });
  const h = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  // Taken from the code at 3b245ca (stage 2) with test/fixtures/omega-market-path.mjs.
  assert.equal(h(outs.map((o) => o.output)), "96fdbcd43621042554b4c4198130d3516557aecaff9985dfe7f372f7b8630f39");
  assert.equal(h(outs.filter((o) => o.records).map((o) => o.records)), "418e243073ceac216e5dab004fc9ae54fd6bbef8588cbb7d658f6edcfe413c0d");
  assert.equal(outs.find((o) => o.name === "limit_setting_is_market").calls, outs.find((o) => o.name === "aggressive").calls, "v4 stays a market replay whatever entry_order says");
  for (const o of outs.filter((x) => x.group === "hand")) assert.deepEqual(Object.keys(o.output), ["intents", "notes", "pm_dropped"], `${o.name}: three fields only`);
});

test("S13 one knob table: the live engine's and the ledger's are the same; the signal carries the quorum shares and vetoes", () => {
  assert.equal(ledgerKnobs, engineKnobs);
  assert.deepEqual(engineKnobs("swing"), { mode: "swing", ...LIMIT_KNOB_START.swing, source: "start_values" });
  assert.equal(engineKnobs("scalp", { max_pending_life: 600 }).max_pending_life, 60, "clamped to A7");
  const f = managementFields({ decision_key: "OANDA:XAUUSD:15:1794476700000", quorum: { score: 0.3, long_share: 0.7, short_share: 0.2 }, vetoes: { long: [], short: ["x"] } }, { basis: 0.2 });
  assert.deepEqual([f.quorum_long_share, f.quorum_short_share, f.veto_long, f.veto_short], [0.7, 0.2, false, true]);
  assert.equal(PLATFORM_MAX_OPEN, 3);
});

// ---------------------------------------------------------------------------------------------------- the runner

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

test("S14 the council's runner: answers the filed entry, checks each resting limit once per 15m close, cancels when silent", async () => {
  resetLimitCouncilSchemaForTests();
  const env = { DB: d1(), POSITION_COUNCIL_DAILY_USD: "5" };
  const now = ISSUED + 17 * 60_000; // after the 11:15 close
  const calls = [];
  const call = async (_env, req) => { calls.push(req); return !req.schema.properties.move_to ? { status: "answered", obj: { answer: "place", measured: [], reason: "a clean pullback" } } : { status: "answered", obj: { answer: "cancel", move_to: null, reason: "the decision turned" } }; };
  const decision = { bar_close: new Date(ISSUED + 900_000).toISOString(), stance: "SELL", quorum: { long_share: 0.3 } };
  assert.deepEqual(await runLimitCouncil(env, { now, call, settings: { entry_order: "market" } }), { status: "off" });
  await requestEntryCouncil(env.DB, { id: ID, side: "BUY", entry_order: "limit", limit: { price: 4100.2, away_r: 0.2 } }, { now: now - 60_000 });
  assert.equal(await readEntryCouncil(env.DB, ID), null, "asked, not answered");
  const executor = ex({ orders: [{ ...ORDER, placed_ms: ISSUED + 6 * 60_000 }] });
  const r = await runLimitCouncil(env, { now, call, settings: { entry_order: "limit" }, executor, decision, rooms: [], atr: 4, signal: SIGNAL });
  assert.deepEqual(r.entries, [{ id: ID, status: "answered", choice: "place_limit", rule: "council_place" }]);
  assert.deepEqual(r.pending, [{ ticket: 777, action: "cancel", rule: "council_cancel" }]);
  assert.deepEqual(calls.map((c) => [c.schemaName, c.meterSource]), [["entry_council", "entry_council"], ["entry_council", "entry_council"]]);
  assert.deepEqual(await readEntryCouncil(env.DB, ID), { id: ID, status: "answered", choice: "place_limit", rule: "council_place", reason: "a clean pullback" });
  assert.deepEqual((await pendingLimitActions(env.DB, { now })).map((a) => [a.ticket, a.action, a.rule]), [[777, "cancel", "council_cancel"]]);
  // Once per order and 15m close.
  assert.deepEqual((await runLimitCouncil(env, { now: now + 5 * 60_000, call, settings: { entry_order: "limit" }, executor, decision, rooms: [], atr: 4, signal: SIGNAL })).pending, []);
  // The daily cap reached: no call, the order is cancelled at the next close (council_unavailable).
  const capped = await runLimitCouncil(env, { now: now + 15 * 60_000, call, settings: { entry_order: "limit" }, executor, decision: { ...decision, bar_close: new Date(ISSUED + 1_800_000).toISOString() }, rooms: [], atr: 4, signal: SIGNAL, capUsd: 0 });
  assert.deepEqual(capped.pending, [{ ticket: 777, action: "cancel", rule: "council_unavailable" }]);
  assert.equal(calls.length, 2);
});
