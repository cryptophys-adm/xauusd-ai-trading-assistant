// Omega limit entries, stage 1 (docs/RFC_OMEGA_LIMIT_ENTRY.md, owner 2026-11-20): the switch (limit and council need EA
// 1.21 since stage 3), pending Omega orders counted as positions and as risk, deleted at once on a hard reason, and EA
// 1.21's contract. Stage 3's own tests: test/omega-limit-stage3.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planIntents, settingsFrom, OMEGA_DEFAULTS, omegaPendingOrders, pendingRiskAtStops, pendingDeleteReason, deleteOrderIntent, INTENT_ID_MAX, LIMIT_ENTRY_AVAILABLE } from "../src/omega-engine.mjs";

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
const SIGNAL = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false };
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: [], orders: []
};
const ON = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false };
const ORDER = { ticket: 777, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 4098, sl: 4093, tp: 4108, comment: "lim:1", magic: 920200, source: "omega", placed_ms: NOW - 60_000 };
const plan = (over = {}) => planIntents({ signal: SIGNAL, control: { mode: "active" }, settings: ON, executor: EXECUTOR, now: NOW, engineEnabled: true, ...over });
const codes = (r) => r.notes.map((n) => n.code);

test("LE1 the switch: entry_order defaults to market; limit and council need EA 1.21 since stage 3; anything else is refused", () => {
  assert.equal(OMEGA_DEFAULTS.entry_order, "market");
  assert.equal(LIMIT_ENTRY_AVAILABLE, true, "stage 3 flips it");
  assert.match(settingsFrom({ entry_order: "limit" }).error, /^ea_1_21_required/);
  assert.equal(settingsFrom({ entry_order: "limit" }, OMEGA_DEFAULTS, { ea_version: "1.21" }).settings.entry_order, "limit");
  assert.match(settingsFrom({ entry_order: "stop" }).error, /market', 'limit' or 'council'/);
  assert.equal(settingsFrom({ entry_order: "market" }).settings.entry_order, "market");
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, entry_order: "market" }).settings.entry_order, "market", "kept across other changes");
});

test("LE2 Omega's pending orders: own limits only; their risk at the stop is the fill price to the stop", () => {
  const orders = [ORDER, { ...ORDER, ticket: 778, magic: 0, source: "manual" }, { ...ORDER, ticket: 779, type: "BUY_STOP" }];
  assert.deepEqual(omegaPendingOrders({ orders }).map((o) => o.ticket), [777], "a manual order and a stop order are not Omega's limits");
  assert.equal(pendingRiskAtStops([ORDER], EXECUTOR.symbol), 50, "0.1 lot × 5.00 / 0.01 × 1");
  assert.equal(pendingRiskAtStops([{ ...ORDER, sl: 0 }], EXECUTOR.symbol), Infinity, "no stop: counted as unbounded");
});

test("LE3 stage 1: any pending Omega order is deleted at once (entry_order is market), and then counts for nothing", () => {
  const r = plan({ executor: { ...EXECUTOR, orders: [ORDER] } });
  const del = r.intents.filter((it) => it.kind === "delete_order");
  assert.deepEqual(del.map((d) => [d.ticket, d.reason]), [[777, "entry_order_market"]]);
  assert.ok(codes(r).includes("pending_deleted"));
  assert.ok(r.intents.some((it) => it.kind === "open"), "the market entry runs as today: the deleted order no longer counts");
  // The same minute never sends the same delete twice; the next minute may again (a refused delete is retried).
  assert.equal(plan({ executor: { ...EXECUTOR, orders: [ORDER] }, recentIntentIds: [del[0].id] }).intents.filter((it) => it.kind === "delete_order").length, 0);
  assert.notEqual(deleteOrderIntent(777, "x", NOW).id, deleteOrderIntent(777, "x", NOW + 60_000).id);
  assert.ok(deleteOrderIntent(9_999_999_999, "x", NOW).id.length <= INTENT_ID_MAX);
  // Without any order nothing changes: the market path is exactly today's.
  assert.deepEqual(plan().intents.map((it) => it.kind), ["open"]);
});

test("LE4 Omega off deletes its pending orders; kill closes all, orders included", () => {
  const off = plan({ settings: { ...ON, enabled: false }, executor: { ...EXECUTOR, orders: [ORDER] } });
  assert.deepEqual(off.intents.map((it) => [it.kind, it.ticket, it.reason]), [["delete_order", 777, "engine_off"]]);
  const kill = plan({ control: { mode: "killed", at: "2026-11-20T11:01:00.000Z" }, executor: { ...EXECUTOR, orders: [ORDER] } });
  assert.deepEqual(kill.intents.map((it) => it.kind), ["close_all"], "a pending order alone is enough for close_all");
});

test("LE5 the hard reasons, in order (stage 3 uses them with entry_order limit)", () => {
  const S = { ...ON, entry_order: "limit" };
  const why = (over = {}) => pendingDeleteReason({ settings: S, signal: SIGNAL, control: { mode: "active" }, executor: EXECUTOR, account: { spec_status: "validated" }, lossFloor: 9_800, ...over });
  // With the stage switch off every reason collapses to the switch.
  assert.equal(why({ available: false }), "entry_order_market");
  assert.equal(pendingDeleteReason({ settings: ON }), "entry_order_market");
  // Behind the stage switch, the reasons in their order (the demo fixture needs no arm).
  const at = (over = {}) => why({ available: true, ...over });
  assert.equal(at(), null, "nothing holds: the order is kept");
  assert.equal(at({ settings: ON, available: true }), "entry_order_market");
  const real = { ...EXECUTOR, account: { ...EXECUTOR.account, trade_mode: "real" } };
  assert.equal(at({ executor: real }), "disarmed", "a real account disarmed (owner or auto-disarm): deleted at once");
  assert.equal(at({ executor: real, settings: { ...S, live_armed: true } }), null, "armed: kept");
  assert.equal(at({ executor: real, signal: { ...SIGNAL, paused: true } }), "disarmed", "disarm comes before pause");
  assert.equal(at({ signal: { ...SIGNAL, paused: true } }), "paused");
  assert.equal(at({ signal: { ...SIGNAL, blackout: true } }), "blackout");
  assert.equal(at({ executor: { ...EXECUTOR, symbol: { ...EXECUTOR.symbol, tick_value_problem: "x" } } }), "tick_value_mismatch");
  assert.equal(at({ account: { spec_status: "pending" } }), "spec_unvalidated");
  assert.equal(at({ account: { spec_status: "validated", review_pending: true } }), "profile_review_pending");
  assert.equal(at({ lossFloor: 10_000 }), "daily_loss_limit");
});

test("LE7 an Omega pending order without a stop is said and deleted (Omega never places one)", () => {
  const r = plan({ executor: { ...EXECUTOR, orders: [{ ...ORDER, sl: 0 }, { ...ORDER, ticket: 780 }] } });
  assert.deepEqual(r.notes.find((n) => n.code === "pending_without_stop"), { code: "pending_without_stop", detail: "777" });
  assert.deepEqual(r.intents.filter((it) => it.kind === "delete_order").map((d) => [d.ticket, d.reason]), [[777, "pending_without_stop"], [780, "entry_order_market"]]);
});

test("LE6 OmegaExecutor 1.21: place_limit with lot@price and a required expiry, delete_order, no GTC, a dead-man switch", () => {
  const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");
  assert.match(ea, /#property version\s+"1\.22"/);
  assert.ok(ea.includes('kind == "place_limit"') && ea.includes('kind == "delete_order"'));
  assert.match(ea, /StringSplit\(volField, '@', parts\)/, "the volume field carries <lot>@<price>; the bridge is unchanged");
  assert.match(ea, /refused: expiry/, "no order without an expiry ahead");
  assert.match(ea, /refused: limit_through_price/);
  assert.match(ea, /refused: netting_account/);
  assert.match(ea, /input int\s+PendingDeadManSeconds = 120;/);
  assert.match(ea, /void EnforcePendingSafety\(\)[\s\S]*dead_man[\s\S]*expired[\s\S]*max_life/);
  assert.match(ea, /EnforcePendingSafety\(\);\s*\n\s*}/, "run every timer tick");
  assert.match(ea, /ORDER_TIME_SPECIFIED : ORDER_TIME_GTC/, "the broker's expiry where allowed; the EA's own timer deletes it in any case");
  // The bridge's line format is unchanged: id;kind;side;volume;sl;tp;ticket, volume up to 32 characters.
  const files = readFileSync(new URL("../bridge/omega-bridge/src/files.mjs", import.meta.url), "utf8");
  assert.match(files, /cleanAsciiField\(intent\.volume, 32\)/);
  assert.ok("0.01@4098.25".length <= 32);
});

test("LE7 OmegaExecutor 1.22: the EA's own deletions carry their reason when ok; every other ok result keeps an empty field", async () => {
  const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");
  assert.match(ea, /string errField = \(!ok \|\| StringFind\(id, "ea:del:"\) == 0\) \? CleanCsvField\(errorMsg\) : "";/);
  assert.match(ea, /AppendResult\(StringFormat\("ea:del:%I64u", t\), ok, t, ok \? why : trade\.ResultRetcodeDescription\(\), nowMs\);/);
  // The bridge keeps the field on an ok line as it is, so the Worker's eaDeletedLine reads the reason.
  const { parseResultsText } = await import("../bridge/omega-bridge/src/files.mjs");
  const [del, plain] = parseResultsText("ea:del:777;1;777;expired;1763600000000\nlim:1;1;778;;1763600000001\n");
  assert.deepEqual([del.id, del.ok, del.ticket, del.error], ["ea:del:777", true, 777, "expired"]);
  assert.equal(plain.error, undefined);
});
