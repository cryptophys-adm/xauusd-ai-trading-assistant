// Bridge 1.7.1 review (2026-11-26): the "EA answered" fault-clear counts only a result for an intent still pending, sent
// or expired at receipt. A result line sent again (a bridge restart, a .done re-read) for an intent already done or
// failed is not a new answer: it clears nothing, and the result itself stays idempotent.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, resetOmegaBrokerSchemaForTests, LIMIT_FAULT_NO_ANSWER, RESULT_OPEN_STATUSES } from "../src/omega-broker.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";

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

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const NOW = Date.parse("2026-11-26T10:00:00Z");
const STATE = {
  connected: true, server: "AnyBroker-Demo", received_ms: NOW - 500,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: []
};
const SIGNAL = { side: "WAIT", issued_ms: NOW - 60_000, expires_ms: NOW + 600_000, blackout: false, kill: false, paused: false };

async function setup() {
  resetOmegaBrokerSchemaForTests();
  resetEaExecutionSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "false" };
  await bridgeSync(e, { state: STATE, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.1" }, { now: NOW - 5000, signal: SIGNAL });
  return e;
}
// A "never answered" fault raised by a later limit (not ea_silent, so the heartbeat path does not lift it).
function raiseFault(e, at) {
  e.DB.raw.prepare("UPDATE omega_settings SET limit_fault = ? WHERE id = 1")
    .run(JSON.stringify({ why: LIMIT_FAULT_NO_ANSWER, kind: "place_limit", intent_id: "lim:new:1", created_ms: at - 130_000, at_ms: at }));
}
const fault = (e) => e.DB.raw.prepare("SELECT limit_fault FROM omega_settings WHERE id = 1").get().limit_fault;
function addIntent(e, id, status, result = null) {
  e.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, 'open', ?, ?, ?, ?, ?)")
    .run(id, JSON.stringify({ id, kind: "open", side: "BUY", volume: 0.01 }), status, result == null ? null : JSON.stringify(result), NOW - 300_000, NOW - 299_000);
}
const row = (e, id) => e.DB.raw.prepare("SELECT status, result, updated_ms FROM omega_intents WHERE id = ?").get(id);
const send = (e, results, now = NOW) => bridgeSync(e, { state: { ...STATE, received_ms: now - 500 }, results, publicKey: SPKI, kid: KID, bridgeVersion: "1.7.1" }, { now, signal: SIGNAL });
const cleared = (e) => e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'limit_fault_cleared'").get().n;

test("FC1: an old result re-sent for a done or failed intent leaves a later no-answer fault in place", async () => {
  const e = await setup();
  addIntent(e, "open:old:B", "done", { ok: true, ticket: 111 });
  addIntent(e, "open:bad:B", "failed", { ok: false, error: "requote" });
  const doneBefore = row(e, "open:old:B");
  raiseFault(e, NOW - 1000);
  await send(e, [
    { id: "open:old:B", ok: true, ticket: 111, executed_ms: NOW - 299_500 },
    { id: "open:bad:B", ok: false, error: "requote", executed_ms: NOW - 299_400 },
    { id: "open:unknown:B", ok: true, ticket: 112, executed_ms: NOW - 299_300 }
  ]);
  assert.ok(fault(e), "the fault stays");
  assert.equal(JSON.parse(fault(e)).intent_id, "lim:new:1");
  assert.equal(cleared(e), 0);
  assert.deepEqual(row(e, "open:old:B"), doneBefore, "the result itself stays idempotent");
});

for (const status of RESULT_OPEN_STATUSES) {
  test(`FC2: a result for ${status === "expired" ? "an" : "a"} ${status} intent is a new answer and clears the fault`, async () => {
    const e = await setup();
    addIntent(e, "open:old:B", "done", { ok: true, ticket: 111 });
    addIntent(e, `open:${status}:B`, status);
    raiseFault(e, NOW - 1000);
    // The old line first: it does not use up the one clear of this sync.
    await send(e, [{ id: "open:old:B", ok: true, ticket: 111, executed_ms: NOW - 299_500 }, { id: `open:${status}:B`, ok: true, ticket: 222, executed_ms: NOW - 900 }]);
    assert.equal(fault(e), null, "the EA answered: the fault is lifted");
    assert.equal(cleared(e), 1);
    assert.equal(row(e, `open:${status}:B`).status, "done");
  });
}

test("FC3: the open statuses are those the result UPDATE lands on", () => {
  assert.deepEqual([...RESULT_OPEN_STATUSES], ["pending", "sent", "expired"]);
});
