// Recovery backoff (orchestrator 2026-11-27): Cerebrum's watchdog stops restarting the terminal after 3 restarts on
// one connection version with no connected terminal in between, records one "held" event, answers "hold", and
// re-arms on a new connection version or a reconnect. Synthetic state; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, setConnection, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { recoveryHold, heldDetail, holdRecovery, shouldRearm, RECOVERY_RESTART_CAP, RECOVERY_STREAK_GAP_MS, HOLD_DIRECTIVE } from "../src/recovery-hold.mjs";
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
  assert.equal(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7, "remediate_algo_trading"), disp(T, 7)], connVersion: 7 }).streak, 2, "another directive is skipped, not a break");
  // Events from before this change carry no conn_version: they never count.
  assert.equal(recoveryHold({ recent: [row(T, { directive: "restart_terminal", status: "dispatched" })], connVersion: 7 }).streak, 0);
  // The held event is found, so it is recorded once.
  const held = row(T + 9 * M, heldDetail({ connVersion: 7, streak: 3, reason: "terminal_disconnected" }));
  assert.deepEqual(recoveryHold({ recent: [held, disp(T + 6 * M, 7)], connVersion: 7 }), { hold: true, recorded: true, streak: 3 });
  assert.equal(recoveryHold({ recent: [held], connVersion: 7, connectedMs: T + 10 * M }).hold, false, "a reconnect after the hold re-arms");
  assert.equal(recoveryHold({ recent: [disp(T + 12 * M, 7, "remediate_algo_trading"), held], connVersion: 7 }).hold, true, "a remediate dispatch after the hold does not lift it");
  assert.deepEqual(holdRecovery(7), { directive: HOLD_DIRECTIVE, reason: "recovery_held", action_id: "hold:7" });
  // Only a tight run counts (review of #647): two dispatches more than 15 minutes apart, or a last one that old.
  assert.equal(RECOVERY_STREAK_GAP_MS, 15 * M);
  assert.equal(recoveryHold({ recent: [disp(T + 40 * M, 7), disp(T + 20 * M, 7), disp(T, 7)], connVersion: 7 }).streak, 1, "20 minutes apart: not one run");
  assert.equal(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7), disp(T, 7)], connVersion: 7, now: T + 9 * M }).hold, true);
  assert.equal(recoveryHold({ recent: [disp(T + 6 * M, 7), disp(T + 3 * M, 7), disp(T, 7)], connVersion: 7, now: T + 30 * M }).streak, 0, "a last dispatch 24 minutes old starts a new streak");
  assert.equal(recoveryHold({ recent: [held], connVersion: 7, now: T + 600 * M }).hold, true, "a recorded hold stays, however old, until a re-arm");
  // A healthy state re-arms: connected, a fresh quote, newer than the last recovery and no newer re-arm.
  const ex = (connected, rcv) => ({ connected, received_ms: rcv });
  assert.equal(shouldRearm({ executor: ex(true, T + 10 * M), now: T + 10 * M + 5000, lastRecoveryMs: T + 6 * M, lastRearmMs: 0 }), true);
  assert.equal(shouldRearm({ executor: ex(true, T + 10 * M), now: T + 10 * M + 5000, lastRecoveryMs: T + 6 * M, lastRearmMs: T + 8 * M }), false, "once per episode");
  assert.equal(shouldRearm({ executor: ex(false, T + 10 * M), now: T + 10 * M, lastRecoveryMs: T + 6 * M, lastRearmMs: 0 }), false);
  assert.equal(shouldRearm({ executor: ex(true, T + 5 * M), now: T + 10 * M, lastRecoveryMs: T + 4 * M, lastRearmMs: 0 }), false, "a stale quote is not healthy");
  assert.equal(shouldRearm({ executor: ex(true, T + 5 * M), now: T + 5 * M, lastRecoveryMs: T + 6 * M, lastRearmMs: 0 }), false, "a state from before the recovery");
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
  // The terminal connects with a fresh quote: one recovery_rearmed event (once per episode); a later disconnect restarts again.
  await sync(true, T0 + 30 * M); await sync(true, T0 + 31 * M);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'recovery_rearmed'").get().n, 1);
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

const STALE = (now, quoteAgeMs) => ({ ...STATE(true, now), received_ms: now - quoteAgeMs });

test("RH-4: stale-quote restarts that work never hold: each healthy fresh state re-arms (review of #647)", async () => {
  resetOmegaBrokerSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv() };
  const raw = (state, now) => bridgeSync(e, { state, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now, signal: null });
  await raw(STATE(true, T0), T0);
  const envelope = await buildEnvelope(SPKI, KID, { server: "AnyBroker-Live 2", login: "1", password: ["x", "y"].join("") });
  assert.equal((await setConnection(e, { envelope, server: "AnyBroker-Live 2", actor: "owner" }, { now: T0 + M })).ok, true);
  // Four frozen-chart episodes, an hour apart; each restart works (a fresh quote, connected all along).
  for (let k = 0; k < 4; k++) {
    const t = T0 + 2 * M + k * 60 * M;
    const r = await raw(STALE(t, 3 * M), t);
    assert.equal(r.recovery?.directive, "restart_terminal", `episode ${k + 1}: dispatched, not held`);
    await raw(STATE(true, t + 2 * M), t + 2 * M);
  }
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'recovery_rearmed'").get().n, 4, "one re-arm per episode");
  // Even four stale restarts in a tight run with healthy states between them never hold.
  for (let k = 0; k < 4; k++) {
    const t = T0 + 300 * M + k * 4 * M;
    assert.equal((await raw(STALE(t, 3 * M), t)).recovery?.directive, "restart_terminal");
    await raw(STATE(true, t + M), t + M);
  }
});

test("RH-5: held, then a healthy fresh state with connected never false: re-armed, the next problem is dispatched", async () => {
  resetOmegaBrokerSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv() };
  const raw = (state, now) => bridgeSync(e, { state, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now, signal: null });
  await raw(STATE(true, T0), T0);
  const envelope = await buildEnvelope(SPKI, KID, { server: "AnyBroker-Live 2", login: "1", password: ["x", "y"].join("") });
  await setConnection(e, { envelope, server: "AnyBroker-Live 2", actor: "owner" }, { now: T0 + M });
  // A frozen chart the restarts do not fix: three restarts, then held (connected true throughout).
  const out = [];
  for (let i = 0; i < 5; i++) { const t = T0 + 2 * M + i * 3 * M; out.push((await raw(STALE(t, 3 * M), t)).recovery?.directive ?? null); }
  assert.deepEqual(out, ["restart_terminal", "restart_terminal", "restart_terminal", "hold", "hold"]);
  // The chart comes back by itself (a fresh quote): re-armed with no false→true change.
  await raw(STATE(true, T0 + 20 * M), T0 + 20 * M);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'recovery_rearmed'").get().n, 1);
  assert.equal((await raw(STALE(T0 + 40 * M, 3 * M), T0 + 40 * M)).recovery?.directive, "restart_terminal", "the next problem is dispatched");
});
