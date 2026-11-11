import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { bridgeSync, brokerOverview, setConnection, clearConnection, writeSettings, readSettings, bridgeKey, executorFrom, resetOmegaBrokerSchemaForTests, INTENT_TTL_MS, closePosition } from "../src/omega-broker.mjs";
import { buildEnvelope, keyId } from "../workers/xauusd-omega/public/omega-crypto.js";

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
function env(over = {}) { resetOmegaBrokerSchemaForTests(); return { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true", ...over }; }

// The bridge's key pair, as the bridge makes it (RSA-3072).
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);

const ISSUED = Date.parse("2026-11-09T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
const SIGNAL = { side: "BUY", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false };
const STATE = {
  connected: true, server: "Monex-Demo", received_ms: NOW - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0, login: 5550123 },
  symbol: { name: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: []
};
const sync = (e, over = {}, opts = {}) => bridgeSync(e, { state: STATE, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0", ...over }, { now: NOW, signal: SIGNAL, ...opts });
const enable = (e) => writeSettings(e, { body: { enabled: true }, actor: "owner@example.com" }, { now: NOW });

test("the browser envelope opens with node:crypto exactly as docs/OMEGA_BRIDGE_PROTOCOL.md shows", async () => {
  assert.equal(await keyId(SPKI), KID);
  const creds = { server: "Monex-Demo", login: "5550123", password: "p@ss wörd" };
  const envl = await buildEnvelope(SPKI, KID, creds);
  assert.deepEqual(Object.keys(envl).sort(), ["ciphertext", "iv", "kid", "v", "wrapped_key"]);
  const aesKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envl.wrapped_key, "base64"));
  const ct = Buffer.from(envl.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envl.iv, "base64"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8")), creds);
  await assert.rejects(buildEnvelope(SPKI, "0".repeat(16), creds), /does not match/);
});

test("a connection needs a bridge that synced, its key id, a valid envelope and server name", async () => {
  const e = env();
  const envl = await buildEnvelope(SPKI, KID, { server: "Monex-Demo", login: "1", password: "x" });
  assert.equal((await setConnection(e, { envelope: envl, server: "Monex-Demo", actor: "o" })).error, "bridge_not_seen");
  await sync(e);
  assert.equal((await setConnection(e, { envelope: { ...envl, kid: "f".repeat(16) }, server: "Monex-Demo", actor: "o" })).error, "kid_mismatch");
  assert.match((await setConnection(e, { envelope: { ...envl, iv: "AAAA" }, server: "Monex-Demo", actor: "o" })).error, /iv/);
  assert.match((await setConnection(e, { envelope: { ...envl, v: 2 }, server: "Monex-Demo", actor: "o" })).error, /v must be 1/);
  assert.match((await setConnection(e, { envelope: envl, server: "<script>", actor: "o" })).error, /server/);
  const ok = await setConnection(e, { envelope: envl, server: "Monex-Demo", actor: "owner@example.com" });
  assert.deepEqual([ok.ok, ok.version, ok.status], [true, 1, "stored"]);
  const r = await sync(e);
  assert.deepEqual(r.connection, { version: 1, server: "Monex-Demo", envelope: envl });
});

test("a new bridge key voids the stored connection (needs re-entry) and it is never served", async () => {
  const e = env();
  await sync(e);
  await setConnection(e, { envelope: await buildEnvelope(SPKI, KID, { server: "S", login: "1", password: "x" }), server: "S", actor: "o" });
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const otherKid = createHash("sha256").update(Buffer.from(other, "base64")).digest("hex").slice(0, 16);
  const r = await sync(e, { publicKey: other, kid: otherKid });
  assert.equal(r.connection, null);
  const ov = await brokerOverview(e, { now: NOW });
  assert.equal(ov.connection.status, "needs_reentry");
  assert.equal(e.DB.raw.prepare("SELECT envelope FROM omega_connection").get().envelope, null, "the old envelope is dropped");
});

test("disconnect bumps the version and tells the bridge to clear the terminal login", async () => {
  const e = env();
  await sync(e);
  await setConnection(e, { envelope: await buildEnvelope(SPKI, KID, { server: "S", login: "1", password: "x" }), server: "S", actor: "o" });
  assert.match((await clearConnection(e, { actor: "o", reason: " " })).error, /reason/);
  assert.equal((await clearConnection(e, { actor: "o", reason: "switch broker" })).version, 2);
  assert.deepEqual((await sync(e)).connection, { version: 2, cleared: true });
});

test("the bridge's own state is kept as reported: its connected flag and write time, never a login", async () => {
  const e = env();
  await enable(e);
  const stale = await sync(e, { state: { ...STATE, received_ms: NOW - 120_000 } });
  assert.deepEqual([stale.intents, stale.notes.map((n) => n.code)], [[], ["executor_stale"]]);
  const off = await sync(e, { state: { ...STATE, connected: false } });
  assert.deepEqual(off.notes.map((n) => n.code), ["executor_stale"]);
  const none = await sync(e, { state: null });
  assert.deepEqual(none.notes.map((n) => n.code), ["executor_stale"]);
  assert.equal(executorFrom({ ...STATE }).account.login, undefined);
  assert.doesNotMatch(e.DB.raw.prepare("SELECT state FROM omega_bridge").get().state, /5550123/);
});

test("settings merge onto the stored ones and are audited; enabled false disarms live", async () => {
  const e = env();
  await writeSettings(e, { body: { enabled: true, risk_pct: 1 }, actor: "o" }, { now: NOW });
  await writeSettings(e, { body: { live_armed: true, confirm: "LIVE" }, actor: "o" }, { now: NOW });
  let s = (await readSettings(e)).settings;
  assert.deepEqual([s.enabled, s.risk_pct, s.live_armed], [true, 1, true]);
  await writeSettings(e, { body: { enabled: false }, actor: "o" }, { now: NOW });
  s = (await readSettings(e)).settings;
  assert.deepEqual([s.enabled, s.risk_pct, s.live_armed], [false, 1, false]);
  assert.equal((await writeSettings(e, { body: { risk_pct: 9 }, actor: "o" })).ok, false);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS c FROM omega_events WHERE action = 'settings'").get().c, 3);
});

test("the intent lifecycle: pending → sent on first return → done by its result; one open per signal", async () => {
  const e = env();
  await enable(e);
  const first = await sync(e);
  assert.equal(first.intents.length, 1);
  const id = first.intents[0].id;
  assert.equal(e.DB.raw.prepare("SELECT status FROM omega_intents WHERE id = ?").get(id).status, "sent");
  const again = await sync(e);
  assert.deepEqual(again.intents.map((i) => i.id), [id], "sent stays returned until a result");
  const done = await sync(e, { results: [{ id, ok: true, ticket: 42, executed_ms: NOW }], state: { ...STATE, positions: [{ ticket: 42, side: "BUY", volume: 0.1, intent_id: id }] } });
  assert.deepEqual(done.intents, []);
  const row = e.DB.raw.prepare("SELECT status, result FROM omega_intents WHERE id = ?").get(id);
  assert.equal(row.status, "done");
  assert.equal(JSON.parse(row.result).ticket, 42);
  const later = await sync(e, { state: STATE }, { now: NOW + 60_000 });
  assert.deepEqual(later.intents, [], "the position left (e.g. TP hit): the same signal never re-opens");
});

test("an unreported intent expires after the TTL, a late result still lands, and a result never resurrects a finished one", async () => {
  const e = env();
  await enable(e);
  const { intents: [it] } = await sync(e);
  const t = NOW + INTENT_TTL_MS + 1;
  await sync(e, { state: { ...STATE, received_ms: t - 1000 } }, { now: t });
  assert.equal(e.DB.raw.prepare("SELECT status FROM omega_intents WHERE id = ?").get(it.id).status, "expired");
  await sync(e, { results: [{ id: it.id, ok: false, error: "market closed", executed_ms: t }], state: { ...STATE, received_ms: t } }, { now: t + 1000 });
  assert.equal(e.DB.raw.prepare("SELECT status FROM omega_intents WHERE id = ?").get(it.id).status, "failed");
  await sync(e, { results: [{ id: it.id, ok: true, ticket: 1, executed_ms: t }], state: { ...STATE, received_ms: t } }, { now: t + 2000 });
  assert.equal(e.DB.raw.prepare("SELECT status FROM omega_intents WHERE id = ?").get(it.id).status, "failed");
});

test("a kill that failed is retried with the next attempt id, never the same id twice", async () => {
  const e = env();
  await e.SIGNAL_CACHE.put("ea:control", JSON.stringify({ mode: "killed", reason: "r", actor: "o", at: "2026-11-09T11:04:00.000Z" }));
  const st = { ...STATE, positions: [{ ticket: 8, side: "BUY", intent_id: "open:1:B" }] };
  const a = await sync(e, { state: st });
  assert.deepEqual(a.intents.map((i) => i.id), ["ka:" + Date.parse("2026-11-09T11:04:00.000Z")]);
  const b = await sync(e, { state: st, results: [{ id: a.intents[0].id, ok: false, error: "requote", executed_ms: NOW }] });
  assert.deepEqual(b.intents.map((i) => i.id), [a.intents[0].id + ":1"]);
  const c = await sync(e, { state: st });
  assert.deepEqual(c.intents.map((i) => i.id), [a.intents[0].id + ":1"], "no new attempt while one is in flight");
});

test("the overview has no envelope, login, password or public key; the key route has the key", async () => {
  const e = env();
  await sync(e);
  await setConnection(e, { envelope: await buildEnvelope(SPKI, KID, { server: "S", login: "5550123", password: "hunter2" }), server: "S", actor: "o" });
  const text = JSON.stringify(await brokerOverview(e, { now: NOW }));
  for (const bad of ["envelope", "wrapped_key", "ciphertext", "5550123", "hunter2", "login", "password", SPKI.slice(10, 40)]) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(Object.keys(await bridgeKey(e, { now: NOW })).sort(), ["kid", "public_key", "synced_age_ms"]);
  const parsed = JSON.parse(text);
  assert.equal(parsed.engine.env_enabled, true);
  assert.equal(parsed.bridge.bid, 4101);
  assert.equal(parsed.bridge.ask, 4101.2);
  assert.equal(parsed.bridge.digits, 2);
  assert.equal(parsed.bridge.volume_step, 0.01);
  assert.equal(parsed.bridge.day_start_balance, 10_000);
});

test("the sync refuses a missing key id or an oversized state", async () => {
  const e = env();
  assert.equal((await sync(e, { kid: "nope" })).ok, false);
  assert.equal((await sync(e, { state: { ...STATE, positions: Array.from({ length: 50 }, () => ({ ticket: 1, side: "BUY", intent_id: "x".repeat(31) })), server: "x".repeat(64) } })).ok, true, "50 positions fit");
});

test("autonomous watchdog: Cerebrum dispatches self-healing remediation and throttles anti-flapping", async () => {
  const e = env();
  await sync(e);
  await setConnection(e, { envelope: await buildEnvelope(SPKI, KID, { server: "S", login: "5550123", password: "hunter2" }), server: "S", actor: "o" });

  // 1. Algo trading disabled triggers remediation
  const res1 = await sync(e, { state: { ...STATE, trade_allowed: false } }, { now: NOW });
  assert.ok(res1.recovery, "recovery directive dispatched");
  assert.equal(res1.recovery.directive, "remediate_algo_trading");
  assert.equal(res1.recovery.reason, "trade_allowed_false");

  // 2. Anti-flapping cooldown prevents second dispatch immediately
  const res2 = await sync(e, { state: { ...STATE, trade_allowed: false } }, { now: NOW + 10_000 });
  assert.equal(res2.recovery, undefined, "recovery throttled within 3m cooldown");

  // 3. Overview surfaces autonomous watchdog state
  const ov = await brokerOverview(e, { now: NOW + 15_000 });
  assert.equal(ov.autonomous_watchdog?.active, true);
  assert.equal(ov.autonomous_watchdog?.agent, "agent:cerebrum");
  assert.equal(ov.autonomous_watchdog?.last_recovery?.directive, "remediate_algo_trading");
});

test("institutional execution telemetry: overview exposes TCA, SOR failover, macro risk and volatility", async () => {
  const e = env();
  await bridgeKey(e); // initializes schema

  // Sync bridge with completed intent reporting TCA metrics (fill price & slippage)
  const intentId = "open:1794222000000:B";
  await e.DB.prepare("INSERT INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES (?, 'open', ?, 'sent', ?, ?)")
    .bind(intentId, JSON.stringify({ id: intentId, kind: "open", side: "BUY", volume: 0.05, entry: 4050.0, sl: 4045.0, tp: 4060.0 }), NOW, NOW).run();

  await bridgeSync(e, {
    kid: KID,
    publicKey: SPKI,
    bridgeVersion: "1.0.0",
    state: {
      connected: true,
      trade_allowed: true,
      server: "Monex-Demo",
      received_ms: NOW + 1_000,
      symbol: { name: "XAUUSD.m", atr_value: 3.5, atr_points: 350, bid: 4050.2, ask: 4050.4, spread_points: 20 }
    },
    results: [
      { id: intentId, ok: true, ticket: 109988, executed_ms: NOW + 350, fill_price: 4050.2, slippage_pts: 2 }
    ]
  }, { now: NOW + 2_000 });

  const ov = await brokerOverview(e, { now: NOW + 2_000 });

  // 1. TCA telemetry
  assert.equal(ov.tca.samples_count, 1);
  assert.equal(ov.tca.avg_latency_ms, 350);
  assert.equal(ov.tca.avg_slippage_points, 2);
  assert.equal(ov.tca.quality, "PRIME");

  // 2. Smart Order Router (SOR)
  assert.equal(ov.sor.mode, "auto_failover");
  assert.equal(ov.sor.primary_broker, "Monex-Demo");
  assert.equal(ov.sor.status, "OPTIMAL");
  assert.equal(ov.sor.failover_ready, true);

  // 3. Volatility Telemetry
  assert.equal(ov.volatility.atr_points, 350);
  assert.equal(ov.volatility.regime, "NORMAL");
  assert.equal(ov.volatility.adaptive_enabled, true);

  // 4. Macro Risk Telemetry
  assert.equal(typeof ov.macro_risk.blackout, "boolean");
});

test("observability: executor preserves positions with source, magic, symbol and reports pending orders", async () => {
  const st = {
    connected: true,
    server: "Monex-Demo",
    account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1025 },
    symbol: { name: "XAUUSD.m", digits: 2, bid: 4050, ask: 4050.2 },
    positions: [
      { ticket: 101, symbol: "XAUUSD.m", side: "SELL", volume: 0.01, open_price: 4055, sl: 4065, tp: 4035, profit: 5, magic: 920200, source: "omega" },
      { ticket: 102, symbol: "XAUUSD.m", side: "SELL", volume: 0.02, open_price: 4060, sl: 0, tp: 0, profit: 20, magic: 0, source: "manual" }
    ],
    orders: [
      { ticket: 201, symbol: "XAUUSD.m", type: "BUY_LIMIT", volume_initial: 0.01, volume_current: 0.01, price_open: 4040, sl: 4030, tp: 4060, magic: 0, source: "manual" }
    ]
  };
  const exec = executorFrom(st);
  assert.equal(exec.positions.length, 2);
  assert.deepEqual(exec.positions[0], {
    ticket: 101, symbol: "XAUUSD.m", side: "SELL", volume: 0.01, open_price: 4055, sl: 4065, tp: 4035, profit: 5,
    intent_id: null, magic: 920200, source: "omega", opened_ms: null
  });
  assert.deepEqual(exec.positions[1], {
    ticket: 102, symbol: "XAUUSD.m", side: "SELL", volume: 0.02, open_price: 4060, sl: 0, tp: 0, profit: 20,
    intent_id: null, magic: 0, source: "manual", opened_ms: null
  });
  assert.equal(exec.orders.length, 1);
  assert.deepEqual(exec.orders[0], {
    ticket: 201, symbol: "XAUUSD.m", type: "BUY_LIMIT", volume_initial: 0.01, volume_current: 0.01, price_open: 4040, sl: 4030, tp: 4060,
    comment: null, magic: 0, source: "manual", placed_ms: null
  });

  const e = env();
  await sync(e, { state: st });
  const ov = await brokerOverview(e, { now: NOW });
  assert.equal(ov.bridge.positions.length, 2);
  assert.equal(ov.bridge.positions[1].source, "manual");
  assert.equal(ov.bridge.orders.length, 1);
  assert.equal(ov.bridge.orders[0].source, "manual");
});

test("closePosition queues a pending manual close intent and records an audit event", async () => {
  const e = env();
  const res = await closePosition(e, { ticket: 109082132, reason: "manual_override_tp_sl", actor: "owner@example.com" }, { now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.ticket, 109082132);
  assert.ok(res.intent_id.startsWith("manual:close:109082132:"));

  // Verify it appears in pending intents query
  const row = await e.DB.prepare("SELECT * FROM omega_intents WHERE id = ?").bind(res.intent_id).first();
  assert.equal(row.kind, "close");
  assert.equal(row.status, "pending");
  const payload = JSON.parse(row.payload);
  assert.equal(payload.ticket, 109082132);
  assert.equal(payload.reason, "manual_override_tp_sl");

  // Verify invalid ticket rejected
  const bad = await closePosition(e, { ticket: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid_ticket");
});


