// Owner 2026-11-16: the EA health message ("Cerebrum Self-Healing Action") goes to the Cryptophys-Cerebrum chat
// through the kernel's ea_heartbeat topic, never to the Nexus chat; only that message moves.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { relayEaHeartbeat, relayReport, recoveryLine, EA_HEARTBEAT_AGENT, RELAY_CURSOR_KEY, RELAY_MIN_GAP_MS, RELAY_RETRY_MS, RELAY_MAX_AGE_MS, RELAY_TEXT_MAX } from "../src/ea-heartbeat-relay.mjs";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const M = 60_000;

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    run: async () => db.prepare(sql).run(...params),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };
function recovery(db, ms, directive = "restart_terminal", reason = "terminal_disconnected", actor = "agent:cerebrum") {
  db.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, 'autonomous_recovery', ?)").run(ms, actor, JSON.stringify({ directive, reason, action_id: `rec:${ms}`, status: "dispatched" }));
}
function env() {
  const calls = [];
  return { calls, DB: d1(), SIGNAL_CACHE: kv(), AGENTS: { syscall: async (agentId, cap, report) => { calls.push({ agentId, cap, report }); return { outcome: "succeeded", result: { report: { report_id: "r" + calls.length } } }; } } };
}

test("the self-healing step no longer sends to the Nexus chat; the event stays in omega_events for the relay", () => {
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Cerebrum Self-Healing Action/);
  assert.match(src, /"agent:cerebrum", "autonomous_recovery"/);
  // The trading messages stay in Nexus (owner: "pindahkan yang nomor 1 saja").
  for (const m of ["Omega Order Executed", "Omega Intent Rejected"]) assert.match(src, new RegExp(m));
});

test("a recovery is relayed once as an ea_heartbeat report: plain text, warning, the risk manager's agent", async () => {
  const e = env();
  recovery(e.DB, NOW - 5 * M);
  const r = await relayEaHeartbeat(e, { now: NOW });
  assert.equal(r.status, "sent");
  assert.equal(e.calls.length, 1);
  const { agentId, cap, report } = e.calls[0];
  assert.deepEqual([agentId, cap, report.kind, report.severity, report.body.telegram_topic], [EA_HEARTBEAT_AGENT, "reports.publish", "xauusd_digest", "warning", "ea_heartbeat"]);
  assert.match(report.body.text, /Cerebrum self-healing · 2026-11-16 11:55 UTC/);
  assert.match(report.body.text, /Restart the MT5 terminal \(restart_terminal\)/);
  assert.match(report.body.text, /the terminal lost its broker connection/);
  assert.doesNotMatch(report.body.text, /<[a-z]/i, "plain text, no HTML");
  assert.notEqual(report.severity, "critical");
  // The same recovery is never sent again.
  assert.equal((await relayEaHeartbeat(e, { now: NOW + RELAY_MIN_GAP_MS + M })).status, "idle");
  assert.equal(e.calls.length, 1);
});

test("at most one report per 30 minutes, carrying every recovery since the last one; stale ones are skipped", async () => {
  const e = env();
  recovery(e.DB, NOW - 3 * M);
  await relayEaHeartbeat(e, { now: NOW });
  recovery(e.DB, NOW + 4 * M, "remediate_algo_trading", "trade_allowed_false");
  recovery(e.DB, NOW + 8 * M);
  assert.equal((await relayEaHeartbeat(e, { now: NOW + 10 * M })).status, "waiting");
  const r = await relayEaHeartbeat(e, { now: NOW + RELAY_MIN_GAP_MS });
  assert.deepEqual([r.status, r.count], ["sent", 2]);
  const text = e.calls[1].report.body.text;
  assert.ok(text.indexOf("Turn Algo Trading back on") < text.indexOf("Restart the MT5 terminal"), "oldest first");
  assert.equal(text.split("\n\n").length, 2, "blank line between recoveries");
  // A recovery older than the kernel's stale window is not sent, but the cursor moves past it.
  const s = env();
  recovery(s.DB, NOW - RELAY_MAX_AGE_MS - M);
  assert.equal((await relayEaHeartbeat(s, { now: NOW })).status, "idle");
  assert.equal(s.calls.length, 0);
  assert.equal(JSON.parse(s.SIGNAL_CACHE.m.get(RELAY_CURSOR_KEY)).last_id, 1);
});

test("a refused report waits 15 minutes; a transport failure retries at the next run; other actors are ignored", async () => {
  const e = env();
  e.AGENTS.syscall = async (agentId, cap, report) => { e.calls.push({ report }); return { outcome: "denied", reason: "rate_limited" }; };
  recovery(e.DB, NOW - M);
  recovery(e.DB, NOW - M, "restart_terminal", "terminal_disconnected", "owner");
  assert.equal((await relayEaHeartbeat(e, { now: NOW })).status, "denied");
  assert.equal((await relayEaHeartbeat(e, { now: NOW + 5 * M })).status, "waiting");
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].report.body.actions.length, 1, "only the self-healing agent's recoveries");
  const f = env();
  f.AGENTS.syscall = async () => { throw new Error("boom"); };
  recovery(f.DB, NOW - M);
  assert.equal((await relayEaHeartbeat(f, { now: NOW })).status, "failed");
  f.AGENTS.syscall = async () => ({ outcome: "succeeded", result: { report: { report_id: "x" } } });
  assert.equal((await relayEaHeartbeat(f, { now: NOW + 5 * M })).status, "sent");
  const off = await relayEaHeartbeat({ DB: d1(), SIGNAL_CACHE: kv() }, { now: NOW });
  assert.equal(off.status, "disabled");
  void RELAY_RETRY_MS;
});

test("the text stays within the bound and keeps the newest recoveries", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, ms: NOW + i * M, detail: JSON.stringify({ directive: "restart_terminal", reason: "chart_frozen_stale_quote" }) }));
  const rep = relayReport(rows);
  assert.ok(rep.body.text.length <= RELAY_TEXT_MAX);
  assert.match(rep.body.text, /earlier actions? not shown/);
  assert.match(rep.body.text, new RegExp(new Date(NOW + 11 * M).toISOString().slice(11, 16)), "the newest is kept");
  assert.equal(rep.body.actions.length, 12);
  assert.match(recoveryLine({ ms: NOW, detail: { directive: "x", reason: "y" } }), /Action: x \(x\)\nReason: y/);
});
