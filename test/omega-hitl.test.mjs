// Human-AI interaction on the Trade tab (owner 2026-11-19): the owner's Modify of a position or pending order, and
// Delegate of manual positions to Omega (one by one, or every new one while the toggle is on).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checkPositionModify, checkOrderModify, ownerModify, setDelegation, setDelegateMode, readDelegations, delegationsForSync, withDelegated, delegatedStopIntents, markDelegatedIntents, plannerIds, hitlSupported, resetHitlSchemaForTests } from "../src/omega-hitl.mjs";
import { isOmegaOwned, planIntents } from "../src/omega-engine.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created_ms INTEGER, updated_ms INTEGER); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT)");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const NOW = Date.parse("2026-11-19T10:00:00Z");
const SYM = { name: "GOLD", bid: 3750, ask: 3750.2, digits: 2, point: 0.01, stops_level_points: 100, atr_value: 6, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_step: 0.01, volume_max: 50, contract_size: 100, currency_profit: "USD", spread_points: 20 };
const BUY = { ticket: 11, side: "BUY", volume: 0.1, open_price: 3740, sl: 3730, tp: 3770, magic: 920200, source: "omega", intent_id: "open:1:B", opened_ms: NOW - 60_000 };
const MAN = { ticket: 22, side: "SELL", volume: 0.05, open_price: 3760, sl: 0, tp: 0, magic: 0, source: "manual", intent_id: "", opened_ms: NOW - 30_000 };
const ORD = { ticket: 33, type: "BUY_LIMIT", price_open: 3740, sl: 3730, tp: 3770, magic: 0, source: "manual" };
const exec = (over = {}) => ({ connected: true, executor: { version: "1.18" }, received_ms: NOW, account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1000, day_start_balance: 1000 }, symbol: SYM, positions: [BUY, MAN], orders: [ORD], ...over });

test("HI1 a position's stop and target are checked against the live price and the broker's stop distance", () => {
  assert.deepEqual(checkPositionModify({ position: BUY, sym: SYM, sl: 3735.123, tp: 3780 }), { sl: 3735.12, tp: 3780 });
  assert.equal(checkPositionModify({ position: BUY, sym: SYM, sl: 3749.5 }).error, "stop_below_price", "inside the 1.00 stop distance below the bid");
  assert.equal(checkPositionModify({ position: BUY, sym: SYM, tp: 3745 }).error, "target_above_price");
  assert.deepEqual(checkPositionModify({ position: MAN, sym: SYM, sl: 3765, tp: "" }), { sl: 3765, tp: 0 }, "a SELL: stop above the ask; empty removes the target");
  assert.equal(checkPositionModify({ position: MAN, sym: SYM, sl: 3750.5 }).error, "stop_above_price");
  assert.equal(checkPositionModify({ position: null, sym: SYM, sl: 1 }).error, "position_not_found");
});

test("HI2 a pending order's price, stop and target by its type", () => {
  assert.deepEqual(checkOrderModify({ order: ORD, sym: SYM, price: 3742, sl: 3732, tp: 3772 }), { price: 3742, sl: 3732, tp: 3772 });
  assert.equal(checkOrderModify({ order: ORD, sym: SYM, price: 3755 }).error, "price_wrong_side", "a buy limit above the ask");
  assert.equal(checkOrderModify({ order: { ...ORD, type: "SELL_STOP" }, sym: SYM, price: 3745, sl: 3740 }).error, "stop_above_price");
  assert.equal(checkOrderModify({ order: { ...ORD, type: "BUY_STOP_LIMIT" }, sym: SYM, price: 3760 }).error, "order_type_not_supported");
});

test("HI3 the owner's edit is one manual: intent, audited; refused offline or on an EA before 1.18", async () => {
  resetHitlSchemaForTests();
  const db = d1();
  const env = { DB: db };
  const r = await ownerModify(env, { ticket: 11, sl: 3736, tp: 3790, actor: "owner@example.com" }, { now: NOW, executor: exec() });
  assert.equal(r.ok, true);
  const row = db.raw.prepare("SELECT id, kind, payload FROM omega_intents").get();
  assert.match(row.id, /^manual:mp:11:/);
  assert.ok(row.id.length <= 31);
  assert.deepEqual(JSON.parse(row.payload).kind === "modify_sltp" && [JSON.parse(row.payload).sl, JSON.parse(row.payload).tp], [3736, 3790]);
  assert.equal(db.raw.prepare("SELECT action FROM omega_events").get().action, "owner_modify_position");
  const o = await ownerModify(env, { target: "order", ticket: 33, price: 3741, sl: 3731, tp: "" }, { now: NOW + 1000, executor: exec() });
  assert.equal(o.ok, true);
  const op = JSON.parse(db.raw.prepare("SELECT payload FROM omega_intents WHERE kind = 'modify_order'").get().payload);
  assert.deepEqual([op.volume, op.sl, op.tp], [3741, 3731, 0], "the order's new price rides in the volume field");
  assert.equal((await ownerModify(env, { ticket: 11, sl: 3736 }, { now: NOW, executor: exec({ executor: { version: "1.17" } }) })).error, "ea_1_18_required");
  assert.equal((await ownerModify(env, { ticket: 11, sl: 3736 }, { now: NOW, executor: exec({ connected: false }) })).error, "executor_offline");
  assert.equal((await ownerModify(env, { ticket: 11, sl: 3760 }, { now: NOW, executor: exec() })).error, "stop_below_price");
  assert.equal(hitlSupported({ executor: { version: "1.18" } }), true);
});

test("HI4 Delegate: a manual position by hand, or every new one while the toggle is on; taken back by hand", async () => {
  resetHitlSchemaForTests();
  const db = d1();
  const env = { DB: db };
  assert.equal((await setDelegation(env, { ticket: 11, on: true }, { now: NOW, executor: exec() })).error, "already_omega");
  assert.equal((await setDelegation(env, { ticket: 22, on: true }, { now: NOW, executor: exec({ executor: { version: "1.17" } }) })).error, "ea_1_18_required");
  assert.equal((await setDelegation(env, { ticket: 22, on: true, actor: "owner" }, { now: NOW, executor: exec() })).ok, true);
  assert.deepEqual((await readDelegations(db)).tickets, [22]);
  assert.equal((await setDelegation(env, { ticket: 22, on: false }, { now: NOW + 1 })).ok, true);
  assert.deepEqual((await readDelegations(db)).tickets, []);
  // The toggle: a manual position opened after it is adopted at the next sync; one opened before is not, and one the
  // owner took back (22) is never adopted again.
  await setDelegateMode(env, { on: true }, { now: NOW - 45_000 });
  const log = [];
  const fresh = { ...MAN, ticket: 55, opened_ms: NOW - 20_000 }, old = { ...MAN, ticket: 66, opened_ms: NOW - 90_000 };
  const t = await delegationsForSync(db, exec({ positions: [BUY, MAN, fresh, old] }), { now: NOW, log: async (a, d) => log.push([a, d]) });
  assert.deepEqual(t, [55]);
  assert.deepEqual(log, [["position_delegated", { ticket: 55, auto: true }]]);
  await setDelegateMode(env, { on: false }, { now: NOW + 2 });
  assert.equal((await readDelegations(db)).mode.on, false);
  const late = { ...MAN, ticket: 44, opened_ms: NOW + 10 };
  assert.deepEqual(await delegationsForSync(db, exec({ positions: [fresh, late] }), { now: NOW + 20 }), [55], "toggle off: 44 stays manual; 55 stays delegated");
});

test("HI5 a delegated position is managed like Omega's own: a stop from the plan, its intents with d: ids", () => {
  assert.equal(isOmegaOwned(MAN), false);
  const { executor, meta } = withDelegated(exec(), [22], { mode: "scalp" });
  const d = executor.positions.find((p) => p.ticket === 22);
  assert.deepEqual([d.delegated, d.intent_id, isOmegaOwned(d)], [true, "deleg:22", true]);
  assert.deepEqual(meta["deleg:22"], { mode: "scalp", r_dist: null });
  // No stop: the plan's stop distance on its side (SELL, 8.00), from its open price.
  const s = delegatedStopIntents({ positions: executor.positions, sym: SYM, signal: { side: "SELL", entry: 3755, stop: 3763 } });
  assert.deepEqual(s, [{ id: "ds:22", kind: "modify_sl", ticket: 22, sl: 3768, tp: null, reason: "delegated_stop_plan" }]);
  // Without a same-side plan: 1.5 × ATR(M15) = 9.00.
  assert.equal(delegatedStopIntents({ positions: executor.positions, sym: SYM, signal: { side: "BUY", entry: 1, stop: 0 } })[0].sl, 3769);
  // An opposite signal closes it like Omega's own; the intent carries the d: id the EA accepts.
  const plan = planIntents({ signal: { side: "BUY", action: "ENTER_MARKET", entry: 3750, stop: 3740, tp1: 3770, issued_ms: NOW - 60_000, expires_ms: NOW + 600_000 }, control: { mode: "active" }, settings: { enabled: true, max_positions: 3 }, executor, now: NOW, engineEnabled: true });
  const close = plan.intents.find((i) => i.ticket === 22 && i.kind === "close");
  assert.ok(close, JSON.stringify(plan.intents));
  const marked = markDelegatedIntents(plan.intents, [22]);
  assert.ok(marked.find((i) => i.ticket === 22).id.startsWith("d:"));
  assert.ok(!marked.find((i) => i.ticket === 11)?.id?.startsWith("d:"), "Omega's own keep their ids");
  assert.deepEqual(plannerIds(["d:cl:22", "x"]), ["d:cl:22", "cl:22", "x"]);
});
