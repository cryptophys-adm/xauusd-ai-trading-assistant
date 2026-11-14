// The push hub (ADR-0015 "Organs as cells", phase 1; owner 2026-11-14: "C. mulai kerjakan"). One Durable
// Object (class PushHub in this Worker's src/index.ts, binding PUSH_HUB, the single instance "nexus"; the AI
// Worker binds the same class across scripts to publish) holds the WebSockets
// of the open Nexus pages, hibernating between messages. When a cell's output changes (here: the 15m War
// Room, at each of its steps), the cell publishes a snapshot; the hub keeps the latest one per topic in its
// storage and sends it to the pages subscribed to that topic, and to a page as soon as it connects. Nexus
// then polls only as a fallback (every 5 minutes while the socket is open, instead of every 10 seconds).
//
// The snapshot is exactly what the page's read returns (`GET /api/war-room/latest`), so the page renders it
// the same way. A hub that is down changes nothing but the cost: the page polls again at its old rate.

export const PUSH_HUB_NAME = "nexus";
/** The topics a page may subscribe to, and the read whose body each topic carries. */
export const PUSH_TOPICS = Object.freeze({ "war-room": "/api/war-room/latest" });
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const storageKey = (topic) => `topic:${topic}`;

/** Pure: the subscribed topics of a stream request (`?topics=war-room`), the known ones only. */
export function topicsOf(url) {
  const raw = String(new URL(url).searchParams.get("topics") || "");
  return [...new Set(raw.split(",").map((t) => t.trim()).filter((t) => Object.hasOwn(PUSH_TOPICS, t)))];
}

/** Pure: the message a page receives for a topic. */
export function pushMessage(topic, entry) {
  return JSON.stringify({ type: "snapshot", topic, at: entry?.at ?? null, data: entry?.data ?? null });
}

/**
 * The hub's behaviour, kept apart from the Durable Object class so it runs under node:test with a fake
 * `ctx` (acceptWebSocket, getWebSockets, storage) and a fake WebSocketPair.
 */
export class PushHubCore {
  constructor(ctx, { WebSocketPair: Pair = globalThis.WebSocketPair, upgraded = (client) => new Response(null, { status: 101, webSocket: client }) } = {}) {
    this.ctx = ctx;
    this.Pair = Pair;
    this.upgraded = upgraded;
  }

  /** A page's WebSocket: accepted as hibernatable, tagged with its topics, sent each topic's latest snapshot. */
  async connect(request) {
    if (String(request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const topics = topicsOf(request.url);
    if (!topics.length) return new Response("No known topic", { status: 400 });
    const pair = new this.Pair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, topics);
    for (const topic of topics) {
      const entry = await this.ctx.storage.get(storageKey(topic));
      if (entry) { try { server.send(pushMessage(topic, entry)); } catch { /* the page polls */ } }
    }
    return this.upgraded(client);
  }

  /** A cell's new snapshot: stored as the topic's latest, sent to its subscribers. Returns how many got it. */
  async publish(topic, data, { now = Date.now() } = {}) {
    if (!Object.hasOwn(PUSH_TOPICS, topic)) return { status: "unknown_topic", sent: 0 };
    const entry = { at: new Date(now).toISOString(), data };
    const text = pushMessage(topic, entry);
    if (text.length > MAX_SNAPSHOT_BYTES) return { status: "too_large", sent: 0 };
    await this.ctx.storage.put(storageKey(topic), entry);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets(topic)) {
      try { ws.send(text); sent += 1; } catch { /* a closing socket */ }
    }
    return { status: "ok", sent };
  }

  /** How many pages are connected, per topic. */
  connections() {
    return Object.fromEntries(Object.keys(PUSH_TOPICS).map((t) => [t, this.ctx.getWebSockets(t).length]));
  }
}
