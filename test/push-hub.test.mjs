// The push hub (ADR-0015 phase 1, workers/xauusd-nexus-dashboard/src/push-hub.mjs): a page that connects
// gets each subscribed topic's latest snapshot at once, then every new one; a page on another topic gets
// nothing; an unknown topic is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { PushHubCore, topicsOf, PUSH_TOPICS, nexusStreamRequest } from "../workers/xauusd-nexus-dashboard/src/push-hub.mjs";

class FakeSocket { constructor() { this.sent = []; this.tags = []; } send(m) { this.sent.push(JSON.parse(m)); } }
class FakePair { constructor() { this.client = new FakeSocket(); this.server = new FakeSocket(); return { 0: this.client, 1: this.server }; } }
function fakeCtx() {
  const storage = new Map(), sockets = [];
  return {
    sockets,
    storage: { get: async (k) => storage.get(k), put: async (k, v) => { storage.set(k, v); } },
    acceptWebSocket(ws, tags = []) { ws.tags = tags; sockets.push(ws); },
    getWebSockets(tag) { return tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets; }
  };
}
const upgrade = (topics) => new Request(`https://nexus.example/api/stream?topics=${topics}`, { headers: { upgrade: "websocket" } });
const hub = (ctx) => new PushHubCore(ctx, { WebSocketPair: FakePair, upgraded: (client) => ({ status: 101, client }) });

test("topics: only known ones, once", () => {
  assert.deepEqual(Object.keys(PUSH_TOPICS), ["war-room", "threads", "decision", "omega-overview"]);
  // Account data is never a topic of Nexus' own stream (behind the edge Access only): Nexus strips it.
  const limited = nexusStreamRequest(new Request("https://x/api/stream?topics=threads,omega-overview,decision", { headers: { upgrade: "websocket" } }));
  assert.equal(new URL(limited.url).searchParams.get("topics"), "threads,decision");
  assert.equal(limited.headers.get("upgrade"), "websocket");
  assert.equal(nexusStreamRequest(new Request("https://x/api/stream?topics=omega-overview")), null);
  assert.deepEqual(topicsOf("https://x/api/stream?topics=war-room,nope,war-room"), ["war-room"]);
  assert.deepEqual(topicsOf("https://x/api/stream"), []);
});

test("a page gets the latest snapshot when it connects, then each new one", async () => {
  const ctx = fakeCtx();
  const h = hub(ctx);
  assert.deepEqual(await h.publish("war-room", { status: "ok", room: { bar_time: "2026-11-13T19:45:00.000Z" } }, { now: 1 }), { status: "ok", sent: 0 });
  const r = await h.connect(upgrade("war-room"));
  assert.equal(r.status, 101);
  const server = ctx.sockets[0];
  assert.deepEqual(server.tags, ["war-room"]);
  assert.equal(server.sent.length, 1);
  assert.equal(server.sent[0].data.room.bar_time, "2026-11-13T19:45:00.000Z");
  assert.deepEqual(await h.publish("war-room", { status: "ok", room: { bar_time: "2026-11-13T20:00:00.000Z", phase: "debate" } }), { status: "ok", sent: 1 });
  assert.equal(server.sent.at(-1).data.room.phase, "debate");
  assert.equal(server.sent.at(-1).type, "snapshot");
  assert.deepEqual(h.connections(), { "war-room": 1, threads: 0, decision: 0, "omega-overview": 0 });
});

test("ADR-0015 rest: one socket carries the rooms and the decision, each to its own subscribers", async () => {
  const ctx = fakeCtx();
  const h = hub(ctx);
  await h.publish("decision", { status: "ok", engine: { stance: "WAIT" } });
  await h.connect(upgrade("threads,decision"));
  await h.connect(upgrade("war-room"));
  const [market, room] = ctx.sockets;
  assert.deepEqual(market.sent.map((m) => m.topic), ["decision"], "the stored decision on connect; no threads stored yet");
  assert.deepEqual(await h.publish("threads", { D1: { status: "ok", thread: { chart: "D1" } }, H4: { status: "not_found" }, H1: { status: "ok", thread: { chart: "H1" } } }), { status: "ok", sent: 1 });
  assert.equal(market.sent.at(-1).data.H1.thread.chart, "H1");
  assert.equal(room.sent.length, 0, "a War Room page gets no market topic");
  assert.deepEqual(h.connections(), { "war-room": 1, threads: 1, decision: 1, "omega-overview": 0 });
});

test("no upgrade, no known topic and an unknown topic's publish are refused", async () => {
  const ctx = fakeCtx();
  const h = hub(ctx);
  assert.equal((await h.connect(new Request("https://nexus.example/api/stream?topics=war-room"))).status, 426);
  assert.equal((await h.connect(upgrade("nope"))).status, 400);
  assert.deepEqual(await h.publish("nope", {}), { status: "unknown_topic", sent: 0 });
  assert.equal(ctx.sockets.length, 0);
});

test("the War Room publishes the room exactly as Nexus reads it; without the binding nothing is published", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { publishWarRoom, readWarRoom } = await import("../src/war-room.mjs");
  const { THREAD_SCHEMA_SQL } = await import("../src/agent-threads.mjs");
  const raw = new DatabaseSync(":memory:");
  for (const sql of THREAD_SCHEMA_SQL) raw.exec(sql);
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() { raw.prepare(sql).run(...params); return { success: true }; },
    async first() { return raw.prepare(sql).get(...params) ?? null; },
    async all() { return { results: raw.prepare(sql).all(...params) }; }
  });
  const DB = { prepare: (sql) => stmt(sql) };
  const run = "2026-11-13T20:00:00.000Z";
  raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, body_json, status) VALUES (?, ?, 'brief', 'system', ?, ?, 'info')").run("warroom:2026-11-13", run, run, JSON.stringify({ roster: ["m15"] }));
  const published = [];
  const env = { DB, WAR_ROOM_ENABLED: "true", PUSH_HUB: { getByName: (name) => ({ publish: async (topic, data) => { published.push({ name, topic, data }); return { status: "ok", sent: 1 }; } }) } };
  assert.deepEqual(await publishWarRoom(env), { status: "ok", sent: 1 });
  assert.equal(published[0].name, "nexus");
  assert.equal(published[0].topic, "war-room");
  // Nexus reads /api/war-room/latest with the metric chips (A3), so the snapshot carries them too.
  assert.deepEqual(published[0].data, { status: "ok", enabled: true, room: await readWarRoom(DB, { metrics: true }) });
  assert.ok("metric_shadow" in published[0].data.room);
  assert.deepEqual(await publishWarRoom({ DB }), { status: "disabled" });
});

test("the Omega overview: replayed on connect only while fresh, and counted so it is computed only for listeners", async () => {
  const ctx = fakeCtx();
  let now = Date.parse("2026-11-16T10:00:00Z");
  const h = new PushHubCore(ctx, { WebSocketPair: FakePair, upgraded: (client) => ({ status: 101, client }), now: () => now });
  assert.equal(h.subscribers("omega-overview"), 0);
  await h.publish("omega-overview", { broker: { bridge: { equity: 1 } } }, { now });
  now += 30_000;
  await h.connect(upgrade("omega-overview"));
  assert.equal(ctx.sockets[0].sent.length, 1, "30 s old: sent");
  assert.equal(h.subscribers("omega-overview"), 1);
  now += 60_000;
  await h.connect(upgrade("omega-overview"));
  assert.equal(ctx.sockets[1].sent.length, 0, "90 s old: not replayed, the page reads it");
  assert.equal(h.subscribers("nope"), 0);
});
