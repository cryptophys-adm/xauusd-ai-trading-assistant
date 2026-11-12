import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { omegaHealth, OMEGA_HEALTH_SCHEMA, EA_STALE_AFTER_MS, EXECUTOR_STALE_AFTER_MS } from "../src/omega-health.mjs";
import { EA_HEARTBEAT_KEY, EA_CONTROL_KEY } from "../src/ea-signal.mjs";

const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);

function d1({ schema = true } = {}) {
  const db = new DatabaseSync(":memory:");
  if (schema) {
    db.exec("CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, server TEXT, kid TEXT, envelope TEXT, updated_by TEXT, updated_ms INTEGER)");
    db.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, kid TEXT, public_key TEXT, bridge_version TEXT, state TEXT, synced_ms INTEGER)");
  }
  const writes = [];
  return {
    raw: db, writes,
    prepare(sql) {
      if (!/^\s*SELECT/i.test(sql)) writes.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; },
        async run() { db.prepare(sql).run(...params); return {}; }
      };
      return stmt;
    }
  };
}
const kv = (entries = {}) => { const m = new Map(Object.entries(entries)); return { get: async (k) => m.get(k) ?? null, put: async () => { throw new Error("health must not write KV"); } }; };

test("H1. nothing measured yet: every value is null or false, nothing is invented", async () => {
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  const h = await omegaHealth(env, { now: NOW });
  assert.equal(h.schema, OMEGA_HEALTH_SCHEMA);
  assert.equal(h.ea.seen, false);
  assert.equal(h.ea.connected, false);
  assert.equal(h.ea.heartbeat_age_ms, null);
  assert.equal(h.ea.open_positions, null);
  assert.equal(h.ea.source, null);
  assert.equal(h.bridge.seen, false);
  assert.equal(h.bridge.synced_age_ms, null);
  assert.equal(h.bridge.terminal_connected, null);
  assert.equal(h.bridge.credentials_stored, null, "no connection row: unknown, not false");
  assert.deepEqual(h.control, { mode: "active", set_ms: null });
  assert.equal(h.engine_enabled, false);
});

test("H2. a fresh heartbeat and bridge sync are reported with their ages; no account figure leaks", async () => {
  const db = d1();
  db.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Broker-Live')").run();
  const state = { connected: true, trade_allowed: true, server: "Broker-Live", received_ms: NOW - 5_000, account: { balance: 1234.5, equity: 1200 } };
  db.raw.prepare("INSERT INTO omega_bridge (id, kid, bridge_version, state, synced_ms) VALUES (1, 'k', '1.4.0', ?, ?)").run(JSON.stringify(state), NOW - 20_000);
  const hb = { received_at: new Date(NOW - 2_000).toISOString(), version: "2.1", mode: "auto", trading_allowed: true, positions: 2, control: "active", floating_pnl: 12.3, today_pnl: 40 };
  const env = { DB: db, SIGNAL_CACHE: kv({ [EA_HEARTBEAT_KEY]: JSON.stringify(hb), [EA_CONTROL_KEY]: JSON.stringify({ mode: "paused", at: new Date(NOW - 3_600_000).toISOString() }) }), OMEGA_ENGINE_ENABLED: "true" };
  const h = await omegaHealth(env, { now: NOW });
  assert.deepEqual(h.ea, { seen: true, heartbeat_age_ms: 2_000, stale_after_ms: EA_STALE_AFTER_MS, connected: true, version: "2.1", mode: "auto", trading_allowed: true, open_positions: 2, reported_control: "active", source: "heartbeat" });
  assert.deepEqual(h.control, { mode: "paused", set_ms: NOW - 3_600_000 });
  assert.equal(h.bridge.connected, true);
  assert.equal(h.bridge.synced_age_ms, 20_000);
  assert.equal(h.bridge.bridge_version, "1.4.0");
  assert.equal(h.bridge.terminal_connected, true);
  assert.equal(h.bridge.trade_allowed, true);
  assert.equal(h.bridge.credentials_stored, true);
  const text = JSON.stringify(h);
  for (const secretish of ["Broker-Live", "1234.5", "equity", "balance", "floating_pnl", "today_pnl"]) assert.ok(!text.includes(secretish), secretish);
  assert.equal(db.writes.length, 0, "health writes nothing to D1");
});

test("H3. stale heartbeat and stale terminal state: not connected, and the terminal state is unknown", async () => {
  const db = d1();
  db.raw.prepare("INSERT INTO omega_connection (id, version, status) VALUES (1, 1, 'stored')").run();
  db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.4.0', ?, ?)").run(JSON.stringify({ connected: true, trade_allowed: true, received_ms: NOW - 3_600_000 }), NOW - 600_000);
  const hb = { received_at: new Date(NOW - EA_STALE_AFTER_MS - 1).toISOString(), positions: 0 };
  const h = await omegaHealth({ DB: db, SIGNAL_CACHE: kv({ [EA_HEARTBEAT_KEY]: JSON.stringify(hb) }) }, { now: NOW });
  assert.equal(h.ea.seen, true);
  assert.equal(h.ea.connected, false);
  assert.equal(h.ea.open_positions, 0);
  assert.equal(h.ea.source, "heartbeat", "the heartbeat is stale but still fresher than the hour-old state");
  assert.equal(h.bridge.connected, false);
  assert.equal(h.bridge.terminal_connected, null);
  assert.equal(h.bridge.trade_allowed, null);
});

test("H4. a missing table or a broken KV value never throws", async () => {
  const h = await omegaHealth({ DB: d1({ schema: false }), SIGNAL_CACHE: kv({ [EA_HEARTBEAT_KEY]: "{not json" }) }, { now: NOW });
  assert.equal(h.ea.seen, false);
  assert.equal(h.bridge.seen, false);
  const h2 = await omegaHealth({}, { now: NOW });
  assert.equal(h2.bridge.seen, false);
});

test("H5. the OmegaHealth entrypoint exposes health() only", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const m = src.match(/export class OmegaHealth extends WorkerEntrypoint<Env> \{([\s\S]*?)\n\}\n/);
  assert.ok(m, "OmegaHealth entrypoint");
  assert.deepEqual([...m[1].matchAll(/^\s+async (\w+)\(/gm)].map((x) => x[1]), ["health"]);
});

test("H6. executor state relayed by bridge is used when no heartbeat", async () => {
  const db = d1();
  const state = { connected: true, trade_allowed: true, received_ms: NOW - 3_000, positions: [{}, {}], server: "Broker-Live", account: { balance: 1234.5 } };
  db.raw.prepare("INSERT INTO omega_bridge (id, kid, bridge_version, state, synced_ms) VALUES (1, 'k', '1.4.0', ?, ?)").run(JSON.stringify(state), NOW - 1_000);
  const env = { DB: db, SIGNAL_CACHE: kv() };
  const h = await omegaHealth(env, { now: NOW });
  assert.deepEqual(h.ea, { seen: true, heartbeat_age_ms: 3_000, stale_after_ms: EXECUTOR_STALE_AFTER_MS, connected: true, version: null, mode: null, trading_allowed: true, open_positions: 2, reported_control: null, source: "omega_executor" });
  const text = JSON.stringify(h);
  assert.ok(!text.includes("Broker-Live"));
  assert.ok(!text.includes("1234.5"));
  assert.equal(db.writes.length, 0, "health writes nothing to D1");
});

test("H7. stale executor state is seen but not connected", async () => {
  const db = d1();
  const state = { connected: true, trade_allowed: true, received_ms: NOW - EXECUTOR_STALE_AFTER_MS - 1 };
  db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.4.0', ?, ?)").run(JSON.stringify(state), NOW - 1_000);
  const h = await omegaHealth({ DB: db, SIGNAL_CACHE: kv() }, { now: NOW });
  assert.equal(h.ea.seen, true);
  assert.equal(h.ea.connected, false);
  assert.equal(h.ea.source, "omega_executor");
});

test("H8. fresher of heartbeat and executor state wins", async () => {
  // heartbeat 10 min old, state 4 s old -> executor
  {
    const db = d1();
    const state = { connected: true, trade_allowed: true, received_ms: NOW - 4_000 };
    db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.4.0', ?, ?)").run(JSON.stringify(state), NOW - 1_000);
    const hb = { received_at: new Date(NOW - 600_000).toISOString(), positions: 0 };
    const env = { DB: db, SIGNAL_CACHE: kv({ [EA_HEARTBEAT_KEY]: JSON.stringify(hb) }) };
    const h = await omegaHealth(env, { now: NOW });
    assert.equal(h.ea.source, "omega_executor");
    assert.equal(h.ea.connected, true);
  }
  // heartbeat 4 s old, state 10 min old -> heartbeat
  {
    const db = d1();
    const state = { connected: true, trade_allowed: true, received_ms: NOW - 600_000 };
    db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.4.0', ?, ?)").run(JSON.stringify(state), NOW - 1_000);
    const hb = { received_at: new Date(NOW - 4_000).toISOString(), positions: 0 };
    const env = { DB: db, SIGNAL_CACHE: kv({ [EA_HEARTBEAT_KEY]: JSON.stringify(hb) }) };
    const h = await omegaHealth(env, { now: NOW });
    assert.equal(h.ea.source, "heartbeat");
    assert.equal(h.ea.connected, true);
  }
});

test("H9. state without numeric received_ms or non-JSON yields no executor candidate", async () => {
  // no numeric received_ms
  {
    const db = d1();
    db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.4.0', ?, ?)").run(JSON.stringify({ connected: true }), NOW - 1_000);
    const h = await omegaHealth({ DB: db, SIGNAL_CACHE: kv() }, { now: NOW });
    assert.equal(h.ea.seen, false);
    assert.equal(h.ea.source, null);
  }
  // non-JSON state
  {
    const db = d1();
    db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.4.0', ?, ?)").run("{not json", NOW - 1_000);
    const h = await omegaHealth({ DB: db, SIGNAL_CACHE: kv() }, { now: NOW });
    assert.equal(h.ea.seen, false);
    assert.equal(h.ea.source, null);
  }
});

test("H10. OmegaExecutor 1.12 reports its version and who moves the stops", async () => {
  const run = async (executor) => {
    const db = d1();
    db.raw.prepare("INSERT INTO omega_bridge (id, bridge_version, state, synced_ms) VALUES (1, '1.1.0', ?, ?)").run(JSON.stringify({ connected: true, received_ms: NOW - 2_000, positions: [], executor }), NOW - 1_000);
    return (await omegaHealth({ DB: db, SIGNAL_CACHE: kv() }, { now: NOW })).ea;
  };
  let ea = await run({ name: "OmegaExecutor", version: "1.12", auto_break_even: false, trailing_stop: false, dynamic_atr_stop: true });
  assert.equal(ea.version, "1.12");
  assert.equal(ea.mode, "omega_only");
  ea = await run({ version: "1.12", auto_break_even: true, trailing_stop: false });
  assert.equal(ea.mode, "local_stops");
  ea = await run(undefined);
  assert.equal(ea.version, null, "1.11 and older report no version");
  assert.equal(ea.mode, null);
});
