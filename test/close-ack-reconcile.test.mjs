// CA1 (2026-11-25): a close the EA executed whose result line never arrived is recorded done from the ticket's closing
// deal in ea_deals, under every condition of src/close-reconcile.mjs. The ten real shapes are the expired close intents
// of 2026-11-18 to 2026-11-25 (ids, tickets, times, volumes and exit prices as production stored them; no account data).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  CLOSE_RECONCILE, CLOSE_RECONCILE_BACKFILL_KEY, RECONCILED_FROM, planCloseReconcile, reconcileLostCloses, reconciledResult,
  closeReconcileBackfill, openTicketsOf, openedVolume, reconcilableClose
} from "../src/close-reconcile.mjs";
import { bridgeSync, resetOmegaBrokerSchemaForTests, INTENT_TTL_MS, OMEGA_SCHEMA_SQL } from "../src/omega-broker.mjs";
import { EA_EXECUTION_SCHEMA_SQL, resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";

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
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

function withSchema(db) {
  for (const sql of OMEGA_SCHEMA_SQL) db.raw.exec(sql);
  for (const sql of EA_EXECUTION_SCHEMA_SQL) db.raw.exec(sql);
  for (const col of ["source TEXT", "strategy TEXT", "account_ref TEXT"]) { try { db.raw.exec(`ALTER TABLE ea_deals ADD COLUMN ${col}`); } catch { /* already there */ } }
  return db;
}
const freshDb = () => withSchema(d1());
function addIntent(db, { id, kind = "close", ticket, status = "expired", result = null, created_ms, reason = "x", extra = {} }) {
  const payload = JSON.stringify({ id, kind, ...(ticket != null ? { ticket } : {}), reason, ...extra });
  db.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, kind, payload, status, result == null ? null : JSON.stringify(result), created_ms, status === "expired" ? created_ms + INTENT_TTL_MS : created_ms + 700);
}
function addDeal(db, { deal_ticket, position_ticket, volume = 0.01, reason = "expert", closed_ms, exit_price = null, side = "SELL" }) {
  db.raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, mode, side, volume, entry_price, exit_price, profit, reason, closed_ms, received_at, source) VALUES (?, ?, 'demo', ?, ?, NULL, ?, 0, ?, ?, '2026-11-25T00:00:00Z', 'omega')")
    .run(deal_ticket, position_ticket, side, volume, exit_price, reason, closed_ms);
}
const rowOf = (db, id) => db.raw.prepare("SELECT status, result, updated_ms FROM omega_intents WHERE id = ?").get(id);
const snapshot = (db) => JSON.stringify(db.raw.prepare("SELECT id, status, result, updated_ms FROM omega_intents ORDER BY id").all());

// The ten real shapes (2026-11-18 .. 2026-11-25): intent, its ticket, created_ms, the open's volume (null: a manual
// position, no open intent), and the closing deal (ticket, time, volume, exit price; reason "expert").
const REAL = [
  { id: "manual:close:362284048:1795052126929", ticket: 362284048, created: 1795052126929, opened: null, deal: 356717834, closed: 1795052127220, vol: 0.01, exit: 3739.84, reason: "manual_user_exit" },
  { id: "pm:363516256:c:5983793", ticket: 363516256, created: 1795138063468, opened: 0.01, deal: 357953335, closed: 1795138063906, vol: 0.01, exit: 3577.88, reason: "pm_take_profit_weakening" },
  { id: "pm:363761040:c:5983856", ticket: 363761040, created: 1795156980573, opened: 0.01, deal: 358225469, closed: 1795156981166, vol: 0.01, exit: 3553.98, reason: "pm_cut_loss" },
  { id: "pm:366878075:c:5985084", ticket: 366878075, created: 1795525413637, opened: 0.01, limit: true, deal: 361385485, closed: 1795525414508, vol: 0.01, exit: 3636.45, reason: "pm_take_profit_weakening" },
  { id: "cl:367142356:cd:29925600", ticket: 367142356, created: 1795536250890, opened: 0.01, deal: 361660062, closed: 1795536251557, vol: 0.01, exit: 3566.29, reason: "confidence_drop" },
  { id: "cl:367254382:cd:29925705", ticket: 367254382, created: 1795542452130, opened: 0.01, deal: 361758903, closed: 1795542452726, vol: 0.01, exit: 3562.72, reason: "confidence_drop" },
  { id: "cl:367367458:cd:29925900", ticket: 367367458, created: 1795554240772, opened: 0.01, deal: 361881304, closed: 1795554241392, vol: 0.01, exit: 3551.57, reason: "confidence_drop" },
  { id: "cl:367878495:cd:29926710", ticket: 367878495, created: 1795602778446, opened: 0.01, deal: 362394671, closed: 1795602779070, vol: 0.01, exit: 3532.08, reason: "confidence_drop" },
  { id: "cl:368163530:cd:29926935", ticket: 368163530, created: 1795616253912, opened: 0.01, deal: 362695435, closed: 1795616255071, vol: 0.01, exit: 3478.74, reason: "confidence_drop" },
  { id: "manual:close:368280273:1795619955353", ticket: 368280273, created: 1795619955353, opened: null, deal: 362823472, closed: 1795619956197, vol: 0.01, exit: 3430.13, reason: "manual_user_exit" }
];
// The failed ":1" retry, real: the first attempt acked done, its retry created 0.2 s after the deal closed.
const RETRY = { first: "cl:366421556:cd:29924880", retry: "cl:366421556:cd:29924880:1", ticket: 366421556, created: 1795493560640, retryCreated: 1795493561790, deal: 360931111, closed: 1795493561571 };
const NOW = 1795622974230; // 2026-11-25, when the shapes were read

function seedReal(db) {
  for (const r of REAL) {
    addIntent(db, { id: r.id, ticket: r.ticket, created_ms: r.created, reason: r.reason });
    addDeal(db, { deal_ticket: r.deal, position_ticket: r.ticket, volume: r.vol, closed_ms: r.closed, exit_price: r.exit });
    if (r.opened != null) {
      const kind = r.limit ? "place_limit" : "open";
      addIntent(db, { id: `open:${r.ticket}`, kind, status: "done", created_ms: r.created - 600_000, result: { ok: true, ticket: r.ticket }, extra: r.limit ? { volume: `${r.opened}@3643.61`, lot: r.opened } : { volume: r.opened } });
    }
  }
  addIntent(db, { id: RETRY.first, ticket: RETRY.ticket, status: "done", created_ms: RETRY.created, result: { ok: true, ticket: RETRY.ticket, error: null, executed_ms: 1795493561005, fill_price: null, slippage_pts: null, latency_ms: 365 } });
  addIntent(db, { id: RETRY.retry, ticket: RETRY.ticket, status: "failed", created_ms: RETRY.retryCreated, result: { ok: false, ticket: RETRY.ticket, error: "position_not_found", executed_ms: 1795493562013, fill_price: null, slippage_pts: null, latency_ms: 223 } });
  addDeal(db, { deal_ticket: RETRY.deal, position_ticket: RETRY.ticket, closed_ms: RETRY.closed, exit_price: 3632.06 });
}

test("CA1-1: the ten real lost close acks are reconciled done from their expert deal, each with the marker", async () => {
  const db = freshDb();
  seedReal(db);
  const retryBefore = JSON.stringify(rowOf(db, RETRY.retry)), firstBefore = JSON.stringify(rowOf(db, RETRY.first));
  const r = await reconcileLostCloses(db, { now: NOW, openTickets: new Set(), sinceMs: NOW - 7 * 86_400_000 });
  assert.equal(r.status, "ran");
  assert.equal(r.candidates, 10);
  assert.equal(r.reconciled, 10);
  for (const s of REAL) {
    const row = rowOf(db, s.id);
    assert.equal(row.status, "done", s.id);
    const res = JSON.parse(row.result);
    assert.equal(res.reconciled_from, "ea_deals");
    assert.equal(res.deal_ticket, s.deal);
    assert.equal(res.executed_ms, s.closed);
    assert.equal(res.fill_price, s.exit);
    assert.equal(res.ticket, s.ticket);
    assert.equal(res.latency_ms, s.closed - s.created);
    assert.ok(res.latency_ms >= 0 && res.latency_ms <= CLOSE_RECONCILE.window_ms);
  }
  // The ":1" retry stays failed and the acked first attempt is untouched.
  assert.equal(JSON.stringify(rowOf(db, RETRY.retry)), retryBefore);
  assert.equal(JSON.stringify(rowOf(db, RETRY.first)), firstBefore);
  // One audit row per reconciled intent, its kind says reconciled, never an EA ack.
  const events = db.raw.prepare("SELECT actor, action, detail FROM omega_events").all();
  assert.equal(events.length, 10);
  for (const e of events) {
    assert.equal(e.action, "intent_reconciled");
    assert.equal(e.actor, "engine");
    assert.equal(JSON.parse(e.detail).from, "ea_deals");
  }
});

test("CA1-2: the marker shape", () => {
  const s = REAL[1];
  assert.deepEqual(reconciledResult({ id: s.id, ticket: s.ticket, created_ms: s.created }, { deal_ticket: s.deal, position_ticket: s.ticket, closed_ms: s.closed, exit_price: s.exit }), {
    ok: true, ticket: 363516256, error: null, executed_ms: 1795138063906, fill_price: 3577.88, slippage_pts: null, latency_ms: 438,
    reconciled: true, reconciled_from: "ea_deals", deal_ticket: 357953335
  });
  assert.equal(RECONCILED_FROM, "ea_deals");
  // No exit price: no fill price.
  assert.equal(reconciledResult({ ticket: 1, created_ms: 10 }, { deal_ticket: 2, closed_ms: 20, exit_price: null }).fill_price, null);
});

test("CA1-3: idempotent, running it twice changes nothing", async () => {
  const db = freshDb();
  seedReal(db);
  await reconcileLostCloses(db, { now: NOW, openTickets: new Set(), sinceMs: NOW - 7 * 86_400_000 });
  const before = snapshot(db), events = db.raw.prepare("SELECT COUNT(*) n FROM omega_events").get().n;
  const again = await reconcileLostCloses(db, { now: NOW + 60_000, openTickets: new Set(), sinceMs: NOW - 7 * 86_400_000 });
  assert.equal(again.reconciled, 0);
  assert.equal(again.status, "none");
  assert.equal(snapshot(db), before);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM omega_events").get().n, events);
});

// The negatives, on the pure rule and in D1.
const T = 400000001, C0 = 1795600000000;
const close = (over = {}) => ({ id: "cl:400000001:cd:1", kind: "close", status: "expired", result: null, created_ms: C0, ticket: T, ...over });
const deal = (over = {}) => ({ deal_ticket: 900000001, position_ticket: T, volume: 0.01, reason: "expert", closed_ms: C0 + 600, exit_price: 3500, ...over });
const plan = (intents, deals, extra = {}) => planCloseReconcile({ intents, deals, openTickets: new Set(), ...extra });

test("CA1-4: an SL, TP, stop-out or client close inside the window never reconciles", () => {
  for (const reason of ["sl", "tp", "stop_out", "stopout", "manual", "closed", "other"]) {
    const p = plan([close()], [deal({ reason })]);
    assert.equal(p.matches.length, 0, reason);
    assert.deepEqual(p.skipped, [{ ticket: T, why: "deal_reason" }]);
  }
  assert.equal(plan([close()], [deal()]).matches.length, 1);
});

test("CA1-5: a deal outside 5 s, or before created_ms, never reconciles", () => {
  assert.equal(plan([close()], [deal({ closed_ms: C0 + 5000 })]).matches.length, 1); // the bound is inclusive
  assert.deepEqual(plan([close()], [deal({ closed_ms: C0 + 5001 })]).skipped, [{ ticket: T, why: "outside_window" }]);
  assert.deepEqual(plan([close()], [deal({ closed_ms: C0 - 1 })]).skipped, [{ ticket: T, why: "outside_window" }]);
  assert.equal(plan([close()], [deal({ closed_ms: C0 })]).matches.length, 1);
});

test("CA1-6: a partial close never marks a full-close intent done", () => {
  // The position opened 0.02 lot; the expert deal closed 0.01 and the position is gone from the report (or not).
  assert.deepEqual(plan([close()], [deal()], { openVolumes: { [T]: 0.02 } }).skipped, [{ ticket: T, why: "partial_volume" }]);
  assert.deepEqual(plan([close()], [deal()], { openTickets: new Set([T]) }).skipped, [{ ticket: T, why: "position_open" }]);
  // An expert partial in the window, then the stop took the rest: the closing deal is the stop's.
  assert.deepEqual(plan([close()], [deal(), deal({ deal_ticket: 900000002, reason: "sl", closed_ms: C0 + 90_000 })], { openVolumes: { [T]: 0.02 } }).skipped, [{ ticket: T, why: "deal_reason" }]);
  // An earlier ladder partial and the close of the rest: the whole volume, reconciled with the closing deal.
  const whole = plan([close()], [deal({ deal_ticket: 900000000, volume: 0.01, closed_ms: C0 - 3_600_000 }), deal({ volume: 0.01 })], { openVolumes: { [T]: 0.02 } });
  assert.equal(whole.matches.length, 1);
  assert.equal(whole.matches[0].deal_ticket, 900000001);
  assert.equal(openedVolume("open", { volume: 0.03 }), 0.03);
  assert.equal(openedVolume("place_limit", { volume: "0.01@3643.61" }), 0.01);
  assert.equal(openedVolume("place_limit", { lot: 0.02, volume: "0.02@3643.61" }), 0.02);
  assert.equal(openedVolume("open", {}), null);
});

test("CA1-7: two intents competing for one deal: only the earliest takes it", () => {
  const a = close({ id: "pm:400000001:c:1", created_ms: C0 }), b = close({ id: "cl:400000001:cd:2", created_ms: C0 + 300 });
  const p = plan([b, a], [deal({ closed_ms: C0 + 900 })]);
  assert.deepEqual(p.matches.map((m) => m.id), ["pm:400000001:c:1"]);
  // The earliest acked done (it sent the deal): the later expired one stays expired.
  const acked = { ...a, status: "done", result: JSON.stringify({ ok: true, ticket: T }) };
  assert.deepEqual(plan([acked, b], [deal({ closed_ms: C0 + 900 })]).skipped, [{ ticket: T, why: "earlier_intent" }]);
  // A kill (close_all) or a partial_close earlier in the window: nobody takes the deal.
  assert.equal(plan([{ id: "ka:1", kind: "close_all", status: "done", result: "{}", created_ms: C0 - 200, ticket: null }, a], [deal()]).matches.length, 0);
  assert.equal(plan([{ id: "pl:400000001:1", kind: "partial_close", status: "expired", result: null, created_ms: C0 - 200, ticket: T }, a], [deal()]).matches.length, 0);
  // A deal another intent already took is never used again.
  const took = { ...a, status: "done", result: JSON.stringify({ ok: true, ticket: T, reconciled_from: "ea_deals", deal_ticket: 900000001 }) };
  assert.deepEqual(plan([took, close({ id: "cl:400000001:cd:9", created_ms: C0 + 100 })], [deal()]).skipped, [{ ticket: T, why: "deal_taken" }]);
});

test("CA1-8: a failed intent is never touched (the real :1 retry, and a failed close inside the window)", async () => {
  assert.equal(reconcilableClose({ kind: "close", status: "failed", result: null }), false);
  assert.equal(reconcilableClose({ kind: "close", status: "done", result: null }), false);
  assert.equal(reconcilableClose({ kind: "partial_close", status: "expired", result: null }), false);
  assert.equal(reconcilableClose({ kind: "close", status: "sent", result: null }), true);
  const db = freshDb();
  seedReal(db);
  addIntent(db, { id: "cl:400000001:cd:1", ticket: T, status: "failed", created_ms: C0, result: { ok: false, ticket: T, error: "requote" } });
  addDeal(db, { deal_ticket: 900000001, position_ticket: T, closed_ms: C0 + 500 });
  const before = JSON.stringify([rowOf(db, RETRY.retry), rowOf(db, "cl:400000001:cd:1")]);
  await reconcileLostCloses(db, { now: NOW, openTickets: new Set(), sinceMs: NOW - 30 * 86_400_000 });
  assert.equal(JSON.stringify([rowOf(db, RETRY.retry), rowOf(db, "cl:400000001:cd:1")]), before);
});

test("CA1-9: in D1, the negatives stay expired and the position still open is left alone", async () => {
  const db = freshDb();
  const cases = [
    { t: 400000011, reason: "sl", at: 600 }, { t: 400000012, reason: "tp", at: 600 },
    { t: 400000013, reason: "expert", at: 5001 }, { t: 400000014, reason: "expert", at: -1 }
  ];
  for (const c of cases) {
    addIntent(db, { id: `cl:${c.t}:cd:1`, ticket: c.t, created_ms: C0 });
    addDeal(db, { deal_ticket: c.t + 500000000, position_ticket: c.t, reason: c.reason, closed_ms: C0 + c.at });
  }
  addIntent(db, { id: "cl:400000015:cd:1", ticket: 400000015, created_ms: C0 });
  addIntent(db, { id: "open:400000015", kind: "open", status: "done", created_ms: C0 - 60_000, result: { ok: true, ticket: 400000015 }, extra: { volume: 0.02 } });
  addDeal(db, { deal_ticket: 900000015, position_ticket: 400000015, volume: 0.01, closed_ms: C0 + 400 });
  addIntent(db, { id: "cl:400000016:cd:1", ticket: 400000016, created_ms: C0 });
  addDeal(db, { deal_ticket: 900000016, position_ticket: 400000016, closed_ms: C0 + 400 });
  const before = snapshot(db);
  const r = await reconcileLostCloses(db, { now: C0 + 600_000, openTickets: new Set([400000016]), sinceMs: C0 - 1 });
  assert.equal(r.candidates, 6);
  assert.equal(r.reconciled, 0);
  assert.equal(snapshot(db), before);
  // No terminal state: nothing is done at all.
  assert.equal((await reconcileLostCloses(db, { now: C0 + 600_000, openTickets: null })).status, "no_state");
});

test("CA1-10: the backfill reads 30 days only, runs once behind its KV marker, and waits for a readable state", async () => {
  const db = freshDb();
  const now = NOW;
  const day = 86_400_000;
  const old = { id: "cl:400000021:cd:1", ticket: 400000021, created_ms: now - 31 * day };
  const inside = { id: "cl:400000022:cd:1", ticket: 400000022, created_ms: now - 29 * day };
  for (const x of [old, inside]) {
    addIntent(db, { id: x.id, ticket: x.ticket, created_ms: x.created_ms });
    addDeal(db, { deal_ticket: x.ticket + 500000000, position_ticket: x.ticket, closed_ms: x.created_ms + 700, exit_price: 3600 });
  }
  const env = { DB: db, SIGNAL_CACHE: kv() };
  // No stored terminal state: nothing, no marker.
  assert.deepEqual(await closeReconcileBackfill(env, { now }), { status: "no_state" });
  assert.equal(env.SIGNAL_CACHE.map.has(CLOSE_RECONCILE_BACKFILL_KEY), false);
  db.raw.prepare("INSERT INTO omega_bridge (id, kid, public_key, bridge_version, state, synced_ms) VALUES (1, 'k', 'p', '1.7.0', ?, ?)").run(JSON.stringify({ connected: true, positions: [] }), now);
  const first = await closeReconcileBackfill(env, { now });
  assert.deepEqual(first, { status: "ran", candidates: 1, reconciled: 1 });
  assert.equal(rowOf(db, inside.id).status, "done");
  assert.equal(rowOf(db, old.id).status, "expired");
  assert.equal(JSON.parse(rowOf(db, inside.id).result).reconciled_from, "ea_deals");
  const marker = JSON.parse(env.SIGNAL_CACHE.map.get(CLOSE_RECONCILE_BACKFILL_KEY));
  assert.deepEqual(marker, { at_ms: now, since_ms: now - 30 * day, candidates: 1, reconciled: 1 });
  assert.equal(JSON.parse(db.raw.prepare("SELECT detail FROM omega_events WHERE action = 'intent_reconciled'").get().detail).backfill, true);
  // Twice: the marker holds, nothing is read or written, even with a new candidate in the window.
  const late = { id: "cl:400000023:cd:1", ticket: 400000023, created_ms: now - 2 * day };
  addIntent(db, { id: late.id, ticket: late.ticket, created_ms: late.created_ms });
  addDeal(db, { deal_ticket: 900000023, position_ticket: late.ticket, closed_ms: late.created_ms + 700 });
  const before = snapshot(db);
  assert.deepEqual(await closeReconcileBackfill(env, { now: now + 300_000 }), { status: "done" });
  assert.equal(snapshot(db), before);
  assert.equal(openTicketsOf("not json"), null);
  assert.deepEqual([...openTicketsOf({ positions: [{ ticket: 5 }, { ticket: "x" }] })], [5]);
});

test("CA1-11: the backfill over the real shapes changes the ten, and a second pass with the marker removed changes nothing", async () => {
  const db = freshDb();
  seedReal(db);
  db.raw.prepare("INSERT INTO omega_bridge (id, kid, public_key, bridge_version, state, synced_ms) VALUES (1, 'k', 'p', '1.7.0', ?, ?)").run(JSON.stringify({ connected: true, positions: [] }), NOW);
  const env = { DB: db, SIGNAL_CACHE: kv() };
  assert.deepEqual(await closeReconcileBackfill(env, { now: NOW }), { status: "ran", candidates: 10, reconciled: 10 });
  const before = snapshot(db);
  env.SIGNAL_CACHE.map.delete(CLOSE_RECONCILE_BACKFILL_KEY);
  assert.deepEqual(await closeReconcileBackfill(env, { now: NOW + 300_000 }), { status: "ran", candidates: 0, reconciled: 0 });
  assert.equal(snapshot(db), before);
});

// The live path: the bridge sync reconciles when the deal lands, and before the TTL expiry.
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const SYNC_NOW = Date.parse("2026-11-25T10:00:00Z");
const STATE = {
  connected: true, server: "AnyBroker-Demo", received_ms: SYNC_NOW - 500,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: []
};
const SIGNAL = { side: "WAIT", issued_ms: SYNC_NOW - 60_000, expires_ms: SYNC_NOW + 600_000, blackout: false, kill: false, paused: false };
function brokerEnv() { resetOmegaBrokerSchemaForTests(); resetEaExecutionSchemaForTests(); return { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "false" }; }
const sync = (e, state, now) => bridgeSync(e, { state, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now, signal: SIGNAL });

test("CA1-12: live, the sync where the closing deal lands records the close done (reconciled), and a late EA result does not change it", async () => {
  const e = brokerEnv();
  await sync(e, STATE, SYNC_NOW - 5000);
  const id = "pm:400000031:c:5986000", created = SYNC_NOW - 1200;
  addIntent(e.DB, { id, ticket: 400000031, status: "sent", created_ms: created, reason: "pm_cut_loss" });
  addIntent(e.DB, { id: "open:400000031", kind: "open", status: "done", created_ms: SYNC_NOW - 900_000, result: { ok: true, ticket: 400000031 }, extra: { volume: 0.01 } });
  const d = { deal_ticket: 900000031, position_ticket: 400000031, side: "SELL", volume: 0.01, entry_price: 3600, exit_price: 3590.5, profit: 9.5, commission: 0, swap: 0, reason: "expert", source: "omega", opened_ms: SYNC_NOW - 900_000, closed_ms: created + 600 };
  await sync(e, { ...STATE, deals: [d] }, SYNC_NOW);
  const row = rowOf(e.DB, id);
  assert.equal(row.status, "done");
  assert.deepEqual(JSON.parse(row.result), { ok: true, ticket: 400000031, error: null, executed_ms: created + 600, fill_price: 3590.5, slippage_pts: null, latency_ms: 600, reconciled: true, reconciled_from: "ea_deals", deal_ticket: 900000031 });
  const ev = e.DB.raw.prepare("SELECT actor, detail FROM omega_events WHERE action = 'intent_reconciled'").all();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "engine");
  // A late result from the EA lands on pending, sent or expired only: the reconciled done stays.
  await bridgeSync(e, { state: { ...STATE, deals: [d], received_ms: SYNC_NOW + 4000 }, results: [{ id, ok: true, ticket: 400000031, executed_ms: created + 610 }], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now: SYNC_NOW + 5000, signal: SIGNAL });
  assert.equal(rowOf(e.DB, id).result, row.result);
});

test("CA1-13: live, a close about to expire is reconciled before the TTL expiry; one whose position is still open expires as before", async () => {
  const e = brokerEnv();
  await sync(e, STATE, SYNC_NOW - 300_000);
  withSchema(e.DB);
  const gone = "cl:400000041:cd:1", stays = "cl:400000042:cd:1", created = SYNC_NOW - INTENT_TTL_MS - 1000;
  addIntent(e.DB, { id: gone, ticket: 400000041, status: "sent", created_ms: created });
  addIntent(e.DB, { id: stays, ticket: 400000042, status: "sent", created_ms: created });
  addDeal(e.DB, { deal_ticket: 900000041, position_ticket: 400000041, closed_ms: created + 800, exit_price: 3555 });
  addDeal(e.DB, { deal_ticket: 900000042, position_ticket: 400000042, closed_ms: created + 800, volume: 0.01 });
  const open = { ticket: 400000042, side: "SELL", volume: 0.01, open_price: 3600, sl: 3610, tp: 3580, intent_id: "open:x", opened_ms: SYNC_NOW - 900_000, source: "omega" };
  await sync(e, { ...STATE, positions: [open] }, SYNC_NOW);
  assert.equal(rowOf(e.DB, gone).status, "done");
  assert.equal(JSON.parse(rowOf(e.DB, gone).result).reconciled_from, "ea_deals");
  assert.equal(rowOf(e.DB, stays).status, "expired");
  assert.equal(rowOf(e.DB, stays).result, null);
});
