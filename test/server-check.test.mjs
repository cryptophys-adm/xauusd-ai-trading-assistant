// Wrong server name (orchestrator 2026-11-27, brief A): "not_seen" until the terminal is connected on the exact stored
// name; a near-match hint (case, spaces, hyphens, underscores folded) as a warning only. Synthetic state; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, brokerOverview, setConnection, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { foldServerName, nearMatch, serverCheck, SERVER_SEEN_WAIT_MS } from "../src/server-check.mjs";
import { heldDetail } from "../src/recovery-hold.mjs";
import { recoveryLine, relayReport } from "../src/ea-heartbeat-relay.mjs";
import { buildEnvelope } from "../workers/xauusd-omega/public/omega-crypto.js";

const M = 60_000;

test("SC-1: the fold and the near match: case, spaces, hyphens and underscores only", () => {
  assert.equal(foldServerName("AnyBroker-Live 2"), "anybrokerlive2");
  assert.equal(foldServerName("anybroker_LIVE-2"), "anybrokerlive2");
  assert.equal(nearMatch("AnyBroker-Live-2", ["Other-Demo", "AnyBroker-Live 2"]), "AnyBroker-Live 2");
  assert.equal(nearMatch("AnyBroker-Live 2", ["AnyBroker-Live 2"]), null, "the exact name is no hint");
  assert.equal(nearMatch("AnyBroker-Live2.", ["AnyBroker-Live 2"]), null, "a dot is not folded");
  assert.equal(nearMatch("", ["x"]), null);
  const conn = { status: "stored", server: "AnyBroker-Live-2", updated_ms: 0 };
  assert.equal(serverCheck({ conn: { ...conn, status: "cleared" }, executor: null, now: 0 }), null);
  assert.deepEqual(serverCheck({ conn, executor: { connected: false, server: "AnyBroker-Live-2" }, now: SERVER_SEEN_WAIT_MS - 1 }), { status: "pending" });
  // Today's case: the terminal echoes the configured name while it is not connected: not a login.
  const c = serverCheck({ conn, executor: { connected: false, server: "AnyBroker-Live-2" }, now: SERVER_SEEN_WAIT_MS });
  assert.equal(c.status, "not_seen");
  assert.match(c.message, /named exactly 'AnyBroker-Live-2'/);
  assert.equal(serverCheck({ conn, executor: { connected: true, server: "AnyBroker-Live 2" }, now: 10 * M }).status, "not_seen", "connected elsewhere is not the stored name");
  assert.deepEqual(serverCheck({ conn, executor: { connected: true, server: "AnyBroker-Live-2" }, now: 10 * M }), { status: "ok" });
  assert.deepEqual(serverCheck({ conn, executor: { connected: false, server: "AnyBroker-Live-2" }, now: 10 * M, seen: true }), { status: "disconnected" }, "seen before: a disconnect is not a wrong name");
});

function d1() {
  const db = new DatabaseSync(":memory:");
  return { raw: db, prepare(sql) { let params = []; const stmt = {
    bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
    async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; } }; return stmt; } };
}
const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const T0 = Date.parse("2026-11-09T11:00:00Z");
const STATE = (connected, server, now) => ({ connected, trade_allowed: true, server, received_ms: now - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 1, equity: 1 }, symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, bid: 4101, ask: 4101.2 }, positions: [] });

test("SC-2: today's case through the sync: the echoed name while disconnected raises server_not_seen once; the hold names it; the exact login clears it", async () => {
  resetOmegaBrokerSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv() };
  const sync = (connected, server, now) => bridgeSync(e, { state: STATE(connected, server, now), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now, signal: null });
  await sync(true, "AnyBroker-Demo", T0);
  // An account seen before on the broker's real name (the accounts table as account-spec creates it).
  e.DB.raw.prepare("CREATE TABLE IF NOT EXISTS omega_accounts (account_ref TEXT PRIMARY KEY, server TEXT, legacy INTEGER NOT NULL DEFAULT 0, spec_hash TEXT, spec TEXT, spec_status TEXT NOT NULL DEFAULT 'pending', spec_problem TEXT, spec_since_ms INTEGER, spec_validated_ms INTEGER, profile TEXT NOT NULL, ceiling TEXT NOT NULL, agent_mode TEXT NOT NULL, custom TEXT, profile_by TEXT, profile_ms INTEGER, created_ms INTEGER NOT NULL)").run();
  e.DB.raw.prepare("INSERT INTO omega_accounts (account_ref, server, profile, ceiling, agent_mode, created_ms) VALUES ('acct_x', 'AnyBroker-Live 2', 'balanced', 'balanced', 'downgrade_only', ?)").run(T0);
  const envelope = await buildEnvelope(SPKI, KID, { server: "AnyBroker-Live-2", login: "1", password: ["x", "y"].join("") });
  const saved = await setConnection(e, { envelope, server: "AnyBroker-Live-2", actor: "owner" }, { now: T0 + M });
  assert.equal(saved.ok, true, "a near match is saved as entered");
  assert.equal(saved.warning?.code, "server_name_near_match");
  assert.equal(saved.warning?.did_you_mean, "AnyBroker-Live 2");
  // The terminal echoes the typed name and never connects.
  for (let i = 0; i < 6; i++) await sync(false, "AnyBroker-Live-2", T0 + 2 * M + i * 3 * M);
  const notSeen = e.DB.raw.prepare("SELECT actor, detail FROM omega_events WHERE action = 'server_not_seen'").all();
  assert.equal(notSeen.length, 1, "once per connection version");
  assert.equal(notSeen[0].actor, "agent:cerebrum");
  assert.match(JSON.parse(notSeen[0].detail).message, /named exactly 'AnyBroker-Live-2'/);
  assert.equal(JSON.parse(notSeen[0].detail).message.includes("AnyBroker-Live 2"), false, "no other server name in the Telegram text");
  const held = e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'autonomous_recovery'").all().map((r) => JSON.parse(r.detail)).find((d) => d.status === "held");
  assert.equal(held?.cause, "server_not_seen", "the hold names the cause");
  assert.match(held.message, /not logged into a server named exactly 'AnyBroker-Live-2'/);
  let ov = await brokerOverview(e, { now: T0 + 20 * M });
  assert.equal(ov.server_check.status, "not_seen");
  assert.equal(ov.server_check.did_you_mean, "AnyBroker-Live 2", "the hint on the Omega page");
  // Connected on another name is still not seen; connected on the exact stored name clears it.
  await sync(true, "AnyBroker-Live 2", T0 + 22 * M);
  ov = await brokerOverview(e, { now: T0 + 22 * M + 1000 });
  assert.equal(ov.server_check.status, "not_seen");
  await sync(true, "AnyBroker-Live-2", T0 + 24 * M);
  ov = await brokerOverview(e, { now: T0 + 24 * M + 1000 });
  assert.deepEqual(ov.server_check, { status: "ok" });
});

test("SC-3: the Telegram relay says it once, with the typed name only", () => {
  const T = Date.parse("2026-11-27T12:00:00Z");
  const row = { id: 3, ms: T, action: "server_not_seen", detail: { conn_version: 9, server: "AnyBroker-Live-2", message: "The terminal has not logged into a server named exactly 'AnyBroker-Live-2'. Check spaces, hyphens and case, then enter the connection again." } };
  assert.match(recoveryLine(row), /Omega connection/);
  assert.match(recoveryLine(row), /named exactly 'AnyBroker-Live-2'/);
  const r = relayReport([row]);
  assert.match(r.subject, /has not logged into the server entered/);
  assert.equal(r.body.actions[0].action, "server_not_seen");
  const h = heldDetail({ connVersion: 9, streak: 3, cause: "server_not_seen", server: "AnyBroker-Live-2" });
  assert.match(recoveryLine({ id: 4, ms: T, detail: h }), /named exactly 'AnyBroker-Live-2'/);
});

test("SC-4: the latch (review of #648): seen logged in on this version, a later disconnect is 'disconnected', no server_not_seen, a generic hold; a new version resets it", async () => {
  resetOmegaBrokerSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv() };
  const sync = (connected, server, now) => bridgeSync(e, { state: STATE(connected, server, now), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now, signal: null });
  await sync(true, "AnyBroker-Demo", T0);
  const envelope = await buildEnvelope(SPKI, KID, { server: "AnyBroker-Live 2", login: "1", password: ["x", "y"].join("") });
  assert.equal((await setConnection(e, { envelope, server: "AnyBroker-Live 2", actor: "owner" }, { now: T0 + M })).ok, true);
  // Logged in on the exact name (like v102 since 11:57Z): one server_seen.
  await sync(true, "AnyBroker-Live 2", T0 + 2 * M); await sync(true, "AnyBroker-Live 2", T0 + 3 * M);
  const count = (a) => e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = ?").get(a).n;
  assert.equal(count("server_seen"), 1, "once per version");
  // A broker outage an hour later: the terminal stays disconnected for 10 minutes and more.
  for (let i = 0; i < 6; i++) await sync(false, "AnyBroker-Live 2", T0 + 60 * M + i * 3 * M);
  assert.equal(count("server_not_seen"), 0, "not a wrong name");
  const held = e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'autonomous_recovery'").all().map((r) => JSON.parse(r.detail)).find((d) => d.status === "held");
  assert.ok(held, "the restarts still hold after 3");
  assert.equal(held.cause, undefined, "the hold message stays generic");
  assert.doesNotMatch(held.message, /named exactly/);
  assert.equal((await brokerOverview(e, { now: T0 + 80 * M })).server_check.status, "disconnected");
  // A new connection version resets the latch: never seen on it, so not_seen after 5 minutes.
  const env2 = await buildEnvelope(SPKI, KID, { server: "AnyBroker-Live-2", login: "1", password: ["x", "y"].join("") });
  assert.equal((await setConnection(e, { envelope: env2, server: "AnyBroker-Live-2", actor: "owner" }, { now: T0 + 90 * M })).ok, true);
  for (let i = 0; i < 4; i++) await sync(false, "AnyBroker-Live-2", T0 + 91 * M + i * 2 * M);
  assert.equal(count("server_not_seen"), 1);
  assert.equal((await brokerOverview(e, { now: T0 + 99 * M })).server_check.status, "not_seen");
});
