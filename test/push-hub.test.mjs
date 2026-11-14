// The push hub (ADR-0015 phase 1, workers/xauusd-nexus-dashboard/src/push-hub.mjs): a page that connects
// gets each subscribed topic's latest snapshot at once, then every new one; a page on another topic gets
// nothing; an unknown topic is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { PushHubCore, topicsOf, PUSH_TOPICS } from "../workers/xauusd-nexus-dashboard/src/push-hub.mjs";

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
  assert.deepEqual(Object.keys(PUSH_TOPICS), ["war-room"]);
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
  assert.deepEqual(h.connections(), { "war-room": 1 });
});

test("no upgrade, no known topic and an unknown topic's publish are refused", async () => {
  const ctx = fakeCtx();
  const h = hub(ctx);
  assert.equal((await h.connect(new Request("https://nexus.example/api/stream?topics=war-room"))).status, 426);
  assert.equal((await h.connect(upgrade("nope"))).status, 400);
  assert.deepEqual(await h.publish("nope", {}), { status: "unknown_topic", sent: 0 });
  assert.equal(ctx.sockets.length, 0);
});
