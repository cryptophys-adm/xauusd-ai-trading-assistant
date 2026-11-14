// Neuron allocation by reputation (owner 2026-11-14: "Setuju" to 45% over 60 decided calls -> shadow, 50% -> live).
import test from "node:test";
import assert from "node:assert/strict";
import { decideAllocation, rosterSplit, syncAgentAllocation, readAllocationState, readAllocationEvents, ALLOCATION_RULES, ALLOCATION_STATE_KEY } from "../src/agent-allocation.mjs";

const card = (agent, timeframe, hit, miss) => ({ subject: `agent:${agent}`, timeframe, directional: { n: hit + miss, hit, miss } });
const live = (agents, timeframe = "15") => agents.map((a) => card(a, timeframe, 40, 30)); // 57%: stays live
const NOW = Date.parse("2026-11-16T10:10:00Z");

test("the rules: below 45% over at least 60 decided calls goes to shadow; 50% brings it back", () => {
  assert.deepEqual([ALLOCATION_RULES.demote_below, ALLOCATION_RULES.min_scored, ALLOCATION_RULES.promote_at, ALLOCATION_RULES.shadow_every], [0.45, 60, 0.5, 4]);
  const cards = [...live(["technical", "news", "m15", "projection"]), card("risk", "15", 25, 40), card("supertrend", "15", 20, 30), card("moderator", "15", 10, 60)];
  const { next, changes } = decideAllocation({ cards, now: NOW });
  // risk: 25/65 = 38% over 65 -> shadow. supertrend: 40% but only 50 decided -> stays. moderator: exempt.
  assert.deepEqual(changes.map((c) => [c.room, c.agent, c.to]), [["M15", "risk", "shadow"]]);
  assert.equal(next.rooms.M15.risk.status, "shadow");
  assert.match(changes[0].reason, /38% of 65/);
  // Back at 50% or more: live again.
  const back = decideAllocation({ state: next, cards: [...live(["technical", "news", "m15", "projection"]), card("risk", "15", 33, 32)], now: NOW + 86_400_000 });
  assert.deepEqual(back.changes.map((c) => [c.agent, c.from, c.to]), [["risk", "shadow", "live"]]);
  // Between 45% and 50% nothing moves (no flapping).
  assert.deepEqual(decideAllocation({ state: next, cards: [...live(["technical", "news", "m15", "projection"]), card("risk", "15", 31, 34)], now: NOW }).changes, []);
});

test("never fewer than 4 live agents with a record in a room, weakest benched first; rooms are apart", () => {
  const cards = [card("a", "60", 20, 50), card("b", "60", 25, 45), card("c", "60", 40, 30), card("d", "60", 40, 30), card("e", "60", 40, 30), card("a", "15", 40, 30)];
  const { next, changes } = decideAllocation({ cards, now: NOW });
  assert.deepEqual(changes.map((c) => [c.room, c.agent]), [["H1", "a"]]);
  assert.equal(next.rooms.M15, undefined, "a is live in the 15m room, where its record is good");
});

test("a room's roster: the benched agent leaves the bus and answers in shadow on every fourth bar", () => {
  const state = { risk: { status: "shadow" } };
  const roster = ["m15", "news", "technical", "risk", "projection"];
  const onBar = rosterSplit(roster, state, { room: "M15", barTime: new Date(4 * 900_000 * 1000).toISOString() });
  assert.deepEqual(onBar.live, ["m15", "news", "technical", "projection"]);
  assert.deepEqual(onBar.shadow, ["risk"]);
  const offBar = rosterSplit(roster, state, { room: "M15", barTime: new Date((4 * 1000 + 1) * 900_000).toISOString() });
  assert.deepEqual(offBar.shadow, []);
  assert.deepEqual(offBar.benched, ["risk"]);
  // A room that would keep fewer than two live agents keeps everyone.
  assert.deepEqual(rosterSplit(["news", "risk"], { news: { status: "shadow" }, risk: { status: "shadow" } }, { room: "H1", barTime: "2026-11-16T10:00:00Z" }).live, ["news", "risk"]);
  assert.deepEqual(rosterSplit(roster, undefined, { room: "M15", barTime: "2026-11-16T10:00:00Z" }).live, roster);
});

test("the hourly sync stores the state, logs each move and tells the owner; AGENT_ALLOCATION off keeps everyone live", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return {}; }, async all() { return { results: raw.prepare(sql).all(...params) }; }, async first() { return raw.prepare(sql).get(...params) ?? null; } });
  const kv = new Map();
  const env = { DB: { prepare: (sql) => stmt(sql) }, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  const sent = [];
  const cards = [...live(["technical", "news", "m15", "projection"]), card("risk", "15", 25, 40)];
  const r = await syncAgentAllocation(env, { now: NOW, cards, send: async (t) => sent.push(t) });
  assert.equal(r.status, "changed");
  assert.equal((await readAllocationState(env)).rooms.M15.risk.status, "shadow");
  assert.deepEqual((await readAllocationEvents(env.DB)).map((e) => [e.room, e.agent, e.from, e.to]), [["M15", "risk", "live", "shadow"]]);
  assert.match(sent[0], /risk \(M15\) → SHADOW/);
  assert.equal((await syncAgentAllocation(env, { now: NOW + 3_600_000, cards })).status, "unchanged");
  const off = { ...env, AGENT_ALLOCATION: "off" };
  assert.deepEqual(await readAllocationState(off), { rooms: {} });
  assert.equal((await syncAgentAllocation(off, { cards })).status, "disabled");
  assert.ok(kv.has(ALLOCATION_STATE_KEY));
});

test("an agent's shadow answer is scored as its own call", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { agentStatements } = await import("../src/outcome-scoring.mjs");
  const { THREAD_SCHEMA_SQL } = await import("../src/agent-threads.mjs");
  const raw = new DatabaseSync(":memory:");
  for (const sql of THREAD_SCHEMA_SQL) raw.exec(sql);
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async all() { return { results: raw.prepare(sql).all(...params) }; } });
  const bar = "2026-11-16T10:15:00.000Z";
  const put = raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, status) VALUES ('warroom:2026-11-16', ?, ?, ?, ?, ?, ?, 0.6, '{}', 'ok')");
  put.run(bar, "open:news", "news", bar, bar, "BUY");
  put.run(bar, "shadow:risk", "risk", bar, bar, "SELL");
  const byBar = await agentStatements({ DB: { prepare: (sql) => stmt(sql) } }, "15", "2026-11-16T00:00:00Z");
  const list = byBar.get(bar);
  assert.deepEqual(list.map((s) => [s.subject, s.source, s.stance]).sort(), [["agent:news", "room", "BUY"], ["agent:risk", "room_shadow", "SELL"]]);
});
