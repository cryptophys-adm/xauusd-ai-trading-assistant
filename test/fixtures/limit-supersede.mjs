// SS1's fixtures (src/limit-supersede.mjs): today's 14:00 and 14:15 BUYs through planIntents under entry_order "limit"
// and "council" (the old limit deleted, the new one placed once the delete is done), each refusal of the new signal,
// the open position, the other side, the same signal, a refused and an unanswered delete; and the limit counterfactual
// beside v4 replayed on 1m bars over the same two decisions. Generated here deterministically;
// test/limit-supersede.test.mjs asserts on them and test/fixtures/engine-behaviour.mjs hashes their outputs into
// ENGINE_BEHAVIOUR_HASH (with limit_supersede on only). Opaque tickets only; no account, no login, no real price.
import { planIntents, OMEGA_DEFAULTS, openId } from "../../src/omega-engine.mjs";
import { limitKnobs } from "../../src/omega-limit-knobs.mjs";
import { replayOmegaLimit } from "../../src/ledger-omega-limit.mjs";
import { replayOmega4 } from "../../src/ledger-omega4.mjs";
import { M1, M15, WARM, path, lerp, decision, dec, levels } from "./omega-v4-replay.mjs";

// Today, 2026-11-23 (a Monday): the 14:00 BUY (breakout_retest) and the 14:15 BUY (zone_pullback).
export const OLD_ISSUED = Date.parse("2026-11-23T14:00:00Z"); // 1795442400000, the intent open:1795442400000:B
export const NEW_ISSUED = Date.parse("2026-11-23T14:15:00Z");
export const OLD_PLACED = Date.parse("2026-11-23T14:10:54Z");
export const NEW_DECIDED = Date.parse("2026-11-23T14:17:23Z");
export const NOW = NEW_DECIDED + 7_000; // the first sync after the 14:15 decision
export const OLD_ID = openId(OLD_ISSUED, "BUY");
export const NEW_ID = openId(NEW_ISSUED, "BUY");
export const TICKET = 900001; // opaque (the live order is the 14:00 BUY's resting limit)

// The broker, 2 points above the feed (feed_basis 0.2); price inside the 14:15 plan's zone.
export const EXECUTOR = Object.freeze({
  connected: true, received_ms: NOW - 1_500, executor: { version: "1.21" },
  account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 2006.3, ask: 2006.5, spread_points: 20 },
  positions: [], orders: []
});
// The 14:00 BUY's limit, resting at its zone's edge since 14:10:54 (30 minutes, scalp), never filled.
export const OLD_ORDER = Object.freeze({ ticket: TICKET, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 2001.2, sl: 1996.2, tp: 2011.2, comment: OLD_ID, magic: 920200, source: "omega", placed_ms: OLD_PLACED });
export const OLD_META = Object.freeze({ id: OLD_ID, side: "BUY", entry: 2001.2, sl: 1996.2, tp: 2011.2, lot: 0.1, signal_issued_ms: OLD_ISSUED, placed_ms: OLD_PLACED, expiry_ms: OLD_PLACED + 30 * M1, share0: 0.62,
  decision_ms: OLD_ISSUED, profile: null, mode: "scalp", strategy: "breakout_retest", entry_basis: "zone_edge", knobs: limitKnobs("scalp") });
// The 14:15 BUY: its level 2006.5 (feed) is through price, so the limit rests inside its zone (2004.0-2007.0).
export const NEW_SIGNAL = Object.freeze({
  side: "BUY", action: "ENTER_LIMIT", entry: 2006.5, stop: 2000.5, tp1: 2018.5, issued_ms: NEW_ISSUED, decided_ms: NEW_DECIDED, expires_ms: NEW_ISSUED + M15, blackout: false, kill: false, paused: false,
  feed_basis: 0.2, feed_basis_known: true, entry_zone_low: 2004.0, entry_zone_high: 2007.0, entry_zone_edge: true, key_levels: "", power: 0.35, power_ms: NEW_ISSUED,
  quorum_long_share: 0.64, quorum_short_share: 0.3, quorum_long_share_prev: 0.62, quorum_short_share_prev: 0.3, decision_prev_ms: OLD_ISSUED, veto_long: false, veto_short: false, trading_mode: "scalp", trade_agent: "zone_pullback"
});
export const LIMIT = Object.freeze({ ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false, entry_order: "limit", max_positions: 2 });
export const COUNCIL = Object.freeze({ ...LIMIT, entry_order: "council" });
export const OFF = Object.freeze({ ...LIMIT, limit_supersede: "off" });

const ex = (over = {}) => ({ ...EXECUTOR, ...over, account: { ...EXECUTOR.account, ...(over.account ?? {}) }, symbol: { ...EXECUTOR.symbol, ...(over.symbol ?? {}) } });
export const answered = (choice, id = NEW_ID) => ({ id, status: "answered", choice, rule: "test", reason: "the fixture's answer" });
/** One sync's planIntents input: the old order resting (or gone), the 14:15 signal current. */
export function input({ settings = LIMIT, orders = [OLD_ORDER], meta = { [TICKET]: OLD_META }, signal = NEW_SIGNAL, now = NOW, council = answered("place_limit"), supersede = [], positions = [], recent = [] } = {}) {
  return { signal: { ...signal }, control: { mode: "active" }, settings: { ...settings }, executor: ex({ orders, positions, received_ms: now - 1_500 }), now, engineEnabled: true, recentIntentIds: recent,
    entryCouncil: council, pendingMeta: meta, supersede };
}
const delId = (now) => `del:${TICKET}:${Math.floor(now / M1)}`;
// A BUY position Omega opened from an earlier signal, unprotected (its stop below its open).
const OPEN_BUY = Object.freeze({ ticket: 365800001, side: "BUY", volume: 0.1, open_price: 2001.2, sl: 1996.2, tp: 2011.2, intent_id: OLD_ID, magic: 920200, source: "omega", opened_ms: OLD_PLACED + 3 * M1 });

/** Every planIntents case, [name, input]. */
export function planCases() {
  const next = NOW + M1 + 5_000;
  return [
    // Today with the switch off: the incident (same_side_unprotected) byte for byte.
    ["today_off", input({ settings: OFF })],
    // On, the first sync: the old limit's delete, the new signal through every gate, the place held until it is done.
    ["today_on_first", input()],
    // On, the council not yet asked: the delete and the council's request in the same plan.
    ["today_on_request", input({ council: null })],
    // On, the next sync: the old order gone, its delete done: the new limit inside its zone.
    ["today_on_after", input({ orders: [], meta: {}, now: next, supersede: [{ ticket: TICKET, deleted: true }], recent: [delId(NOW)] })],
    // The new signal refused: the old limit is cancelled all the same.
    ["refused_skip", input({ council: answered("skip") })],
    ["refused_band", input({ signal: { ...NEW_SIGNAL, entry: 2001.5, stop: 1995.5, tp1: 2013.5, entry_zone_low: 2000.0, entry_zone_high: 2002.0 } })],
    ["refused_expired", input({ now: NEW_ISSUED + M15 + 30_000 })],
    ["refused_silent", input({ council: { id: NEW_ID, status: "silent", choice: null, rule: "daily_cap" } })],
    // A filled limit is an open position: today's same_side_unprotected, on and off.
    ["position_on", input({ orders: [], meta: {}, positions: [OPEN_BUY] })],
    ["position_off", input({ settings: OFF, orders: [], meta: {}, positions: [OPEN_BUY] })],
    // The other side: an older SELL limit still holds a BUY back (pending_order_exists), on and off.
    ["opposite_on", input({ orders: [{ ...OLD_ORDER, type: "SELL_LIMIT", price_open: 2010.2, sl: 2015.2, tp: 2000.2, comment: openId(OLD_ISSUED, "SELL") }], meta: { [TICKET]: { ...OLD_META, id: openId(OLD_ISSUED, "SELL"), side: "SELL", share0: 0.3 } } })],
    ["opposite_off", input({ settings: OFF, orders: [{ ...OLD_ORDER, type: "SELL_LIMIT", price_open: 2010.2, sl: 2015.2, tp: 2000.2, comment: openId(OLD_ISSUED, "SELL") }], meta: { [TICKET]: { ...OLD_META, id: openId(OLD_ISSUED, "SELL"), side: "SELL", share0: 0.3 } } })],
    // The same signal's own limit is never superseded.
    ["same_signal", input({ orders: [{ ...OLD_ORDER, comment: NEW_ID }], meta: { [TICKET]: { ...OLD_META, id: NEW_ID, signal_issued_ms: NEW_ISSUED } }, recent: [NEW_ID] })],
    // The delete refused: the order still reported, sent again a minute later, no place in that sync.
    ["delete_rejected", input({ now: next, supersede: [{ ticket: TICKET, deleted: false }], recent: [delId(NOW)] })],
    // The order gone but its delete not yet answered: no place in that sync either.
    ["delete_unanswered", input({ orders: [], meta: {}, now: NOW + 3_000, supersede: [{ ticket: TICKET, deleted: null }], recent: [delId(NOW)] })],
    // "council": the council's market entry waits for the delete too, then enters.
    ["council_market_first", input({ settings: COUNCIL, council: answered("enter_market") })],
    ["council_market_after", input({ settings: COUNCIL, council: answered("enter_market"), orders: [], meta: {}, now: next, supersede: [{ ticket: TICKET, deleted: true }], recent: [delId(NOW)] })],
    // The order's placing signal read from its comment when its intent's payload has none.
    ["comment_only", input({ meta: { [TICKET]: { ...OLD_META, signal_issued_ms: undefined } } })]
  ];
}

// ---------------------------------------------------------------------------
// The limit counterfactual beside v4 (src/ledger-omega-limit.mjs) over the two decisions on 1m bars (feed scale).
// The 14:00 BUY rests at 2000 (price 2002 above it, never back); the 14:15 BUY's level 2005 is reached by 14:22, then
// price runs to its target.
export const R_C0 = OLD_ISSUED;
const buyTrade = (entry, stop, tp, agent) => ({ side: "BUY", action: "ENTER_LIMIT", entry, stop, tp, tp1: tp, target: "tp1", agent, rrr: Math.abs(tp - entry) / Math.abs(entry - stop) });
export function replayCase() {
  const lv = levels([[2058, 2060]]);
  const d0 = decision({ close: R_C0, stance: "BUY", score: 0.3, shares: [0.62, 0.3], trade: buyTrade(2000, 1985, 2030, "breakout_retest"), lv });
  const d1 = decision({ close: R_C0 + M15, stance: "BUY", score: 0.35, shares: [0.64, 0.3], decidedAfter: NEW_DECIDED - NEW_ISSUED, trade: buyTrade(2005, 1990, 2035, "zone_pullback"), lv });
  const pts = [[R_C0, 2002], [R_C0 + 16 * M1, 2003], [R_C0 + 17 * M1, 2006], [R_C0 + 22 * M1, 2004.7], [R_C0 + 50 * M1, 2036], [R_C0 + 90 * M1, 2036]];
  return { bars: path(R_C0 - WARM, R_C0 + 90 * M1, lerp(pts)), decisions: [dec(d0), dec(d1)], to: R_C0 + 90 * M1 };
}
export const replayBase = (settings = { ...OMEGA_DEFAULTS, enabled: true }) => ({ settings, profileAt: () => "aggressive", from: R_C0 - 30 * M1 });
export const replayLimit = (settings) => replayOmegaLimit({ ...replayBase(settings), ...replayCase() });
export const replayV4 = (settings) => replayOmega4({ ...replayBase(settings), ...replayCase() });

/** The fingerprint lines (test/fixtures/engine-behaviour.mjs, group ss/), written with limit_supersede on only. */
export function supersedeLines() {
  const lines = [];
  lines.push(`ss/plan=${JSON.stringify(planCases().filter(([n]) => !n.endsWith("_off")).map(([name, inp]) => [name, planIntents(inp)]))}`);
  const run = replayLimit();
  lines.push(`ss/limit/today/records=${JSON.stringify(run.records)}`);
  lines.push(`ss/limit/today/work=${JSON.stringify([run.steps, run.plans, run.limit])}`);
  return lines;
}
