// Feed content staleness (orchestrator 2026-11-27, after the OmegaFeed 1.01 install left the feed terminal without its
// EA): a syncing feed whose bars stopped for 5 minutes in trading hours is shown stale and told once per episode.
// In-memory SQLite D1; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, createHash } from "node:crypto";
import { feedSync, setFeedConnection, feedOverview, resetFeedSchemaForTests, resetFeedStaleForTests } from "../src/feed-bridge.mjs";
import { resetCorpusSchemaCacheForTests } from "../src/corpus-oracle.mjs";
import { resetOmegaBrokerSchemaForTests, bridgeSync } from "../src/omega-broker.mjs";
import { feedContentStale, newStaleEpisode, staleDetail, FEED_CONTENT_STALE_MS } from "../src/feed-stale.mjs";
import { recoveryLine, relayReport } from "../src/ea-heartbeat-relay.mjs";
import { buildEnvelope } from "../workers/xauusd-omega/public/omega-crypto.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-27T04:00:00Z"); // a Friday morning: gold is open
const SAT = Date.parse("2026-11-28T12:00:00Z");

test("FS-1: stale only while syncing, in trading hours, with bars that stopped; once per episode", () => {
  assert.equal(FEED_CONTENT_STALE_MS, 5 * MIN);
  assert.equal(feedContentStale({ syncedMs: NOW, lastBarMs: NOW - 4 * MIN, now: NOW }), false);
  assert.equal(feedContentStale({ syncedMs: NOW, lastBarMs: NOW - 6 * MIN, now: NOW }), true);
  assert.equal(feedContentStale({ syncedMs: NOW - 10 * MIN, lastBarMs: NOW - 20 * MIN, now: NOW }), false, "a feed that does not sync is the 'fresh' flag's matter");
  assert.equal(feedContentStale({ syncedMs: SAT, lastBarMs: SAT - 60 * MIN, now: SAT }), false, "the weekend is not stale");
  assert.equal(feedContentStale({ syncedMs: NOW, lastBarMs: null, now: NOW }), false, "a feed that never sent a bar is not 'stale'");
  assert.equal(newStaleEpisode({ lastEventMs: 0, lastBarMs: NOW - 6 * MIN }), true);
  assert.equal(newStaleEpisode({ lastEventMs: NOW - MIN, lastBarMs: NOW - 6 * MIN }), false, "the same episode");
  assert.equal(newStaleEpisode({ lastEventMs: NOW - 30 * MIN, lastBarMs: NOW - 6 * MIN }), true, "the feed came back in between");
  const d = staleDetail({ bridgeId: "oanda", lastBarMs: NOW - 19 * MIN, now: NOW });
  assert.equal(d.last_bar_age_min, 19);
  assert.deepEqual(Object.keys(d).sort(), ["bridge_id", "last_bar_age_min", "message"], "no server name, no login");
  // The daily break (17:00-18:00 New York; 22:00-23:00 UTC in November) and its first minutes do not page.
  const brk = Date.parse("2026-11-26T22:30:00Z"), after = Date.parse("2026-11-26T23:03:00Z");
  assert.equal(feedContentStale({ syncedMs: brk, lastBarMs: brk - 31 * MIN, now: brk }), false, "in the daily break");
  assert.equal(feedContentStale({ syncedMs: after, lastBarMs: after - 64 * MIN, now: after }), false, "3 minutes after the reopen");
  assert.equal(feedContentStale({ syncedMs: after + 4 * MIN, lastBarMs: after - 64 * MIN, now: after + 4 * MIN }), true, "7 minutes after the reopen with no new bar");
  assert.match(d.message, /Feed 'oanda' is syncing but its bars stopped 19 min ago/);
  assert.match(recoveryLine({ id: 1, ms: NOW, action: "feed_stale", detail: d }), /Omega data feed/);
  assert.match(relayReport([{ id: 1, ms: NOW, action: "feed_stale", detail: d }]).subject, /bars stopped/);
});

test("FS-3: a market-wide stop never pages: the feed is stale only once the executor's bars ran on past it", () => {
  // The post-Thanksgiving early close (27 Nov 2026): the feed's bars stopped at 19:42Z, the executor's at 19:43Z, and
  // feed_stale paged at 19:47Z although the calendar said open. Now it does not.
  const feedLast = Date.parse("2026-11-27T19:42:00Z"), execLast = Date.parse("2026-11-27T19:43:00Z");
  for (const t of [Date.parse("2026-11-27T19:47:19Z"), Date.parse("2026-11-27T21:00:00Z")]) {
    assert.equal(feedContentStale({ syncedMs: t, lastBarMs: feedLast, now: t }), true, "without an executor corpus: as before");
    assert.equal(feedContentStale({ syncedMs: t, lastBarMs: feedLast, now: t, executorBarMs: execLast }), false, "both stopped together: the market stopped");
    assert.equal(feedContentStale({ syncedMs: t, lastBarMs: feedLast, now: t, executorBarMs: null }), true, "no executor bar: as before");
  }
  // The feed's own fault: the executor runs on.
  const t = Date.parse("2026-11-27T04:00:00Z");
  assert.equal(feedContentStale({ syncedMs: t, lastBarMs: t - 7 * MIN, now: t, executorBarMs: t - MIN }), true, "the executor ran on 6 minutes past the feed");
  assert.equal(feedContentStale({ syncedMs: t, lastBarMs: t - 7 * MIN, now: t, executorBarMs: t - 3 * MIN }), false, "only 4 minutes past: not yet");
  assert.equal(feedContentStale({ syncedMs: t, lastBarMs: t - MIN, now: t, executorBarMs: t - MIN }), false, "a fresh feed is never stale");
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
const STATE = { connected: true, server: "FeedBroker-Live", symbol: { name: "XAUUSD", bid: 3600.1, ask: 3600.3, digits: 2, contract_size: 0.1, currency_profit: "USD" } };
const bars = (fromMs, n) => Array.from({ length: n }, (_, i) => [fromMs + i * MIN, 3600 + i, 3601 + i, 3599 + i, 3600.5 + i, 10, 20]);

test("FS-2: through the feed sync: bars stop, one feed_stale and the Data feeds card says so; bars resume, then stop again: one more", async () => {
  resetFeedSchemaForTests(); resetCorpusSchemaCacheForTests(); resetOmegaBrokerSchemaForTests(); resetFeedStaleForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv(), CORPUS_ORACLE_MODE: "shadow", OMEGA_ENGINE_ENABLED: "true" };
  // The executor's tables exist (the events table is the executor's), on another broker.
  await bridgeSync(e, { state: { connected: true, server: "ExecBroker-Live", received_ms: NOW, account: { trade_mode: "demo", currency: "USD" }, symbol: { name: "XAUUSD" }, positions: [] }, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now: NOW - 30 * MIN, signal: null });
  const sync = (now, corpus = null) => feedSync(e, { bridgeId: "oanda", state: STATE, publicKey: SPKI, kid: KID, bridgeVersion: "1.8.2", corpus }, { now });
  await sync(NOW - 30 * MIN);
  const envl = await buildEnvelope(SPKI, KID, { server: "FeedBroker-Live", login: "1", password: ["p", "w"].join("") });
  assert.equal((await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "FeedBroker-Live", actor: "owner" }, { now: NOW - 29 * MIN })).ok, true);
  // Bars until NOW-20, then nothing (the EA is gone); the bridge keeps syncing every 15 s.
  const r = await sync(NOW - 20 * MIN, { timeframe: "M1", server: "FeedBroker-Live", symbol: "XAUUSD", bars: bars(NOW - 25 * MIN, 5) });
  assert.ok(Number.isFinite(r.corpus_cursor_ms), `the feed's bars are stored (${JSON.stringify(r)})`);
  for (let t = NOW - 19 * MIN; t <= NOW; t += 15_000) await sync(t);
  const events = () => e.DB.raw.prepare("SELECT actor, detail FROM omega_events WHERE action = 'feed_stale'").all();
  assert.equal(events().length, 1, "one per episode");
  assert.equal(events()[0].actor, "agent:cerebrum");
  assert.equal(JSON.parse(events()[0].detail).bridge_id, "oanda");
  const card = (await feedOverview(e, { now: NOW })).find((f) => f.bridge_id === "oanda");
  assert.equal(card.content_stale, true);
  assert.ok(card.last_bar_age_ms > 5 * MIN);
  // Bars resume: not stale; they stop again later: a second event.
  await sync(NOW + MIN, { timeframe: "M1", server: "FeedBroker-Live", symbol: "XAUUSD", bars: bars(NOW - 20 * MIN, 21) });
  assert.equal((await feedOverview(e, { now: NOW + MIN })).find((f) => f.bridge_id === "oanda").content_stale, false);
  for (let t = NOW + 2 * MIN; t <= NOW + 12 * MIN; t += 30_000) await sync(t);
  assert.equal(events().length, 2);
});

test("FS-4: through the feed sync: when the executor's corpus stopped with the feed, no feed_stale; once it advances alone, one", async () => {
  resetFeedSchemaForTests(); resetCorpusSchemaCacheForTests(); resetOmegaBrokerSchemaForTests(); resetFeedStaleForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv(), CORPUS_ORACLE_MODE: "shadow", OMEGA_ENGINE_ENABLED: "true" };
  await bridgeSync(e, { state: { connected: true, server: "ExecBroker-Live", received_ms: NOW, account: { trade_mode: "demo", currency: "USD" }, symbol: { name: "XAUUSD" }, positions: [] }, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now: NOW - 30 * MIN, signal: null });
  const sync = (now, corpus = null) => feedSync(e, { bridgeId: "oanda", state: STATE, publicKey: SPKI, kid: KID, bridgeVersion: "1.8.2", corpus }, { now });
  await sync(NOW - 30 * MIN);
  const envl = await buildEnvelope(SPKI, KID, { server: "FeedBroker-Live", login: "1", password: ["p", "w"].join("") });
  assert.equal((await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "FeedBroker-Live", actor: "owner" }, { now: NOW - 29 * MIN })).ok, true);
  await sync(NOW - 20 * MIN, { timeframe: "M1", server: "FeedBroker-Live", symbol: "XAUUSD", bars: bars(NOW - 25 * MIN, 5) });
  // The executor's corpus stopped at the same minute (a market-wide stop).
  const execAt = (ms) => e.DB.raw.prepare("INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, updated_ms) VALUES ('mt5:execbroker-live:XAUUSD', 'ExecBroker-Live', 'XAUUSD', 1, ?, 1, 0, ?) ON CONFLICT(source) DO UPDATE SET last_minute_ms = excluded.last_minute_ms").run(ms, ms);
  execAt(NOW - 21 * MIN);
  for (let t = NOW - 19 * MIN; t <= NOW; t += 15_000) await sync(t);
  const events = () => e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'feed_stale'").all();
  assert.equal(events().length, 0, "a market-wide stop does not page");
  assert.equal((await feedOverview(e, { now: NOW })).find((f) => f.bridge_id === "oanda").content_stale, false);
  // The executor's bars advance again while the feed's do not: the feed's own fault.
  execAt(NOW + MIN);
  for (let t = NOW + MIN; t <= NOW + 3 * MIN; t += 30_000) await sync(t);
  assert.equal(events().length, 1);
  assert.equal((await feedOverview(e, { now: NOW + 3 * MIN })).find((f) => f.bridge_id === "oanda").content_stale, true);
});
