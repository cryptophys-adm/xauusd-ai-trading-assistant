// Recovery backoff (orchestrator 2026-11-27): Cerebrum's watchdog stops restarting the terminal after 3 restarts on
// one connection version with no connected terminal in between, records one "held" event, answers "hold", and
// re-arms on a new connection version or a reconnect. Synthetic state; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, setConnection, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { recoveryHold, heldDetail, holdRecovery, RECOVERY_RESTART_CAP, HOLD_DIRECTIVE } from "../src/recovery-hold.mjs";
import { recoveryLine, relayReport } from "../src/ea-heartbeat-relay.mjs";
import { buildEnvelope } from "../workers/xauusd-omega/public/omega-crypto.js";

const M = 60_000;
const row = (ms, detail) => ({ ms, detail: JSON.stringify(detail) });
const disp = (ms, v, directive = "restart_terminal") => row(ms, { directive, reason: "terminal_disconnected", status: "dispatched", conn_version: v });

test("RH-1: the streak counts consecutive restarts on this connection version since the last reconnect", () => {
  assert.equal(RECOVERY_RESTART_CAP, 3);
  const T = 1_000 * M;
  assert.deepEqual(recoveryHold({ recent: [], connVersion: 7 }), { hold: false, recorded: false, streak: 0 });
  assert.deepEqual(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7)], connVersion: 7 }), { hold: false, recorded: false, streak: 2 });
  assert.deepEqual(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7), disp(T, 7)], connVersion: 7 }), { hold: true, recorded: false, streak: 3 });
  // A new connection version re-arms; so does a reconnect after the restarts; so does another directive in between.
  assert.equal(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7), disp(T, 7)], connVersion: 8 }).hold, false);
  assert.equal(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7), disp(T, 7)], connVersion: 7, connectedMs: T + M }).streak, 2, "only the restarts after the reconnect");
  assert.equal(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7, "remediate_algo_trading"), disp(T, 7)], connVersion: 7 }).streak, 1);
  // Events from before this change carry no conn_version: they never count.
  assert.equal(recoveryHold({ recent: [row(T, { directive: "restart_terminal", status: "dispatched" })], connVersion: 7 }).streak, 0);
  // The held event is found, so it is recorded once.
  const held = row(T + 9 * M, heldDetail({ connVersion: 7, streak: 3, reason: "terminal_disconnected" }));
  assert.deepEqual(recoveryHold({ recent: [held, disp(T + 6 * M, 7)], connVersion: 7 }), { hold: true, recorded: true, streak: 3 });
  assert.equal(recoveryHold({ recent: [held], connVersion: 7, connectedMs: T + 10 * M }).hold, false, "a reconnect after the hold re-arms");
  assert.deepEqual(holdRecovery(7), { directive: HOLD_DIRECTIVE, reason: "recovery_held", action_id: "hold:7" });
  const d = heldDetail({ connVersion: 7, streak: 3 });
  assert.equal(d.status, "held"); assert.equal(d.directive, "restart_terminal"); assert.match(d.message, /server name exactly/);
  assert.equal(JSON.stringify(d).includes("Monex"), false, "no server name in the event");
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
const T0 = Date.parse("2026-11-09T11:00:00Z"); // a Monday: gold is open
const STATE = (connected, now) => ({ connected, trade_allowed: true, server: "AnyBroker-Live 2", received_ms: now - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 1, equity: 1 }, symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, bid: 4101, ask: 4101.2 }, positions: [] });

test("RH-2: through the bridge sync: 3 restarts, then one held event and 'hold'; a reconnect or a new connection re-arms", async () => {
  resetOmegaBrokerSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv() };
  const sync = (connected, now) => bridgeSync(e, { state: STATE(connected, now), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now, signal: null });
  await sync(true, T0);
  const envelope = await buildEnvelope(SPKI, KID, { server: "AnyBroker-Live-2", login: "1", password: ["x", "y"].join("") });
  assert.equal((await setConnection(e, { envelope, server: "AnyBroker-Live-2", actor: "owner" }, { now: T0 + M })).ok, true);
  const recoveries = () => e.DB.raw.prepare("SELECT detail FROM omega_events WHERE actor = 'agent:cerebrum' AND action = 'autonomous_recovery' ORDER BY id").all().map((r) => JSON.parse(r.detail));
  const out = [];
  for (let i = 0; i < 6; i++) out.push((await sync(false, T0 + 2 * M + i * 3 * M)).recovery ?? null);
  assert.deepEqual(out.slice(0, 3).map((r) => r?.directive), ["restart_terminal", "restart_terminal", "restart_terminal"]);
  assert.deepEqual(out.slice(3).map((r) => r?.directive), ["hold", "hold", "hold"], "no fourth restart");
  const recs = recoveries();
  assert.equal(recs.filter((d) => d.status === "dispatched").length, 3);
  assert.equal(recs.filter((d) => d.status === "held").length, 1, "the hold is recorded once");
  assert.ok(recs.every((d) => Number.isFinite(d.conn_version)));
  // Between the 3-minute marks a sync also answers "hold" (the bridge's own restart stays off).
  assert.equal((await sync(false, T0 + 2 * M + 15 * M + 20_000)).recovery?.directive, "hold");
  // The terminal connects: one terminal_connected event; a later disconnect restarts again.
  await sync(true, T0 + 30 * M);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'terminal_connected'").get().n, 1);
  assert.equal((await sync(false, T0 + 34 * M)).recovery?.directive, "restart_terminal", "re-armed by the reconnect");
  // Held again after three more; a new connection version re-arms.
  await sync(false, T0 + 37 * M); await sync(false, T0 + 40 * M);
  assert.equal((await sync(false, T0 + 43 * M)).recovery?.directive, "hold");
  assert.equal((await setConnection(e, { envelope, server: "AnyBroker-Live 2", actor: "owner" }, { now: T0 + 44 * M })).ok, true);
  assert.equal((await sync(false, T0 + 46 * M)).recovery?.directive, "restart_terminal", "re-armed by the new connection");
});

test("RH-3: the Telegram relay says the hold once, with what to check", () => {
  const T = Date.parse("2026-11-27T12:00:00Z");
  const held = { id: 9, ms: T, detail: heldDetail({ connVersion: 7, streak: 3, reason: "terminal_disconnected" }) };
  assert.match(recoveryLine(held), /held/);
  assert.match(recoveryLine(held), /3 restarts did not reconnect/);
  assert.match(recoveryLine(held), /server name exactly/);
  const r = relayReport([{ id: 8, ms: T - 3 * M, detail: { directive: "restart_terminal", reason: "terminal_disconnected", status: "dispatched" } }, held]);
  assert.match(r.subject, /held/);
  assert.equal(r.body.actions.at(-1).status, "held");
});
