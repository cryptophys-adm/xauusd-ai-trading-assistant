// F1: the data-only feed bridge (src/feed-bridge.mjs) and its corpus (src/corpus-oracle.mjs ingestFeedCorpus,
// readCorpusBars preferFeed). No network: an in-memory SQLite D1.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, createHash } from "node:crypto";
import { feedSync, setFeedConnection, clearFeedConnection, feedOverview, feedStateFrom, resetFeedSchemaForTests } from "../src/feed-bridge.mjs";
import { readCorpusBars, resetCorpusSchemaCacheForTests, FEED_FRESH_MS } from "../src/corpus-oracle.mjs";
import { bridgeSync, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { buildEnvelope } from "../workers/xauusd-omega/public/omega-crypto.js";

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
function env() { resetFeedSchemaForTests(); resetCorpusSchemaCacheForTests(); resetOmegaBrokerSchemaForTests(); return { DB: d1(), SIGNAL_CACHE: kv(), CORPUS_ORACLE_MODE: "shadow", OMEGA_ENGINE_ENABLED: "true" }; }

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const NOW = Date.parse("2026-11-27T04:00:00Z");
const MIN = 60_000;
const FEED_STATE = {
  connected: true, server: "FeedBroker-Demo", symbol: { name: "XAUUSD", bid: 3600.1, ask: 3600.3, digits: 2, contract_size: 0.1, currency_profit: "USD" },
  // A feed terminal may report an account and positions: none of it is kept or acted on.
  account: { balance: 1000, equity: 1000, login: 5550123 }, positions: [{ ticket: 1, side: "BUY", volume: 1 }], deals: [{ deal_ticket: 9 }]
};
const bars = (fromMs, n, base = 3600) => Array.from({ length: n }, (_, i) => [fromMs + i * MIN, base + i, base + i + 1, base + i - 1, base + i + 0.5, 10, 20]);
const corpusOf = (server, symbol, fromMs, n) => ({ timeframe: "M1", server, symbol, bars: bars(fromMs, n) });

test("FB-1. a feed sync stores the key and a stripped state, and its answer never carries intents", async () => {
  const e = env();
  const r = await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID, bridgeVersion: "1.8.0" }, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.role, "feed");
  assert.equal("intents" in r, false, "a feed cannot be told to trade");
  assert.equal(r.connection, null, "no login stored yet");
  const row = e.DB.raw.prepare("SELECT state FROM omega_feed_bridges WHERE bridge_id = 'oanda'").get();
  const st = JSON.parse(row.state);
  assert.deepEqual(Object.keys(st).sort(), ["connected", "received_ms", "server", "symbol", "terminal_error"]);
  assert.equal(JSON.stringify(st).includes("5550123"), false, "no login number");
  assert.equal(JSON.stringify(st).includes("balance"), false, "no account amounts");
  assert.deepEqual([st.symbol.contract_size, st.symbol.currency_profit], [0.1, "USD"], "the contract is recorded, never checked (a feed's lot size does not matter)");
  // The executor's own tables are not touched by a feed (they need not even exist).
  const tables = e.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('omega_bridge', 'omega_connection', 'omega_intents')").all();
  assert.deepEqual(tables, []);
  assert.equal((await feedSync(e, { bridgeId: "Bad Id!", state: FEED_STATE, publicKey: SPKI, kid: KID })).ok, false);
  assert.equal((await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: "nothex" })).ok, false);
  assert.deepEqual(feedStateFrom(null), null);
});

test("FB-2. the feed's login: sealed to its own key, checked per bridge, returned only to that key", async () => {
  const e = env();
  const envl = await buildEnvelope(SPKI, KID, { server: "FeedBroker-Demo", login: "1", password: "x" });
  assert.equal((await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "FeedBroker-Demo", actor: "o" })).error, "feed_bridge_not_seen");
  await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW });
  assert.equal((await setFeedConnection(e, { bridgeId: "oanda", envelope: { ...envl, kid: "f".repeat(16) }, server: "FeedBroker-Demo", actor: "o" })).error, "kid_mismatch");
  assert.match((await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "<script>", actor: "o" })).error, /server/);
  const ok = await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "FeedBroker-Demo", actor: "owner" }, { now: NOW });
  assert.deepEqual([ok.ok, ok.version, ok.status], [true, 1, "stored"]);
  const r = await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW + 1000 });
  assert.deepEqual(r.connection, { version: 1, server: "FeedBroker-Demo", envelope: envl });
  // A bridge reinstalled with another key gets no login until it is set again.
  const r2 = await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: "a".repeat(16) }, { now: NOW + 2000 });
  assert.equal(r2.connection, null);
  // Another feed id never sees this one's login.
  assert.equal((await feedSync(e, { bridgeId: "other", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW })).connection, null);
  assert.equal((await clearFeedConnection(e, { bridgeId: "oanda", actor: "owner", reason: "" })).ok, false, "a reason is required");
  const cleared = await clearFeedConnection(e, { bridgeId: "oanda", actor: "owner", reason: "rotate" }, { now: NOW + 3000 });
  assert.deepEqual([cleared.ok, cleared.version, cleared.status], [true, 2, "cleared"]);
  const view = await feedOverview(e, { now: NOW + 3000 });
  assert.equal(view.length, 2);
  const oanda = view.find((f) => f.bridge_id === "oanda");
  assert.deepEqual([oanda.role, oanda.fresh, oanda.server, oanda.connection.status], ["feed", true, "FeedBroker-Demo", "cleared"]);
  assert.equal(JSON.stringify(view).includes("envelope"), false, "the overview never carries the sealed login");
});

test("FB-3. the feed's bars: its own source, marked a feed; refused without its login, on another server or on the executor's", async () => {
  const e = env();
  const envl = await buildEnvelope(SPKI, KID, { server: "FeedBroker-Demo", login: "1", password: "x" });
  await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW });
  const from = NOW - 10 * MIN;
  const noLogin = await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID, corpus: corpusOf("FeedBroker-Demo", "XAUUSD", from, 5) }, { now: NOW });
  assert.equal(noLogin.corpus_error, "no_feed_connection");
  await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "FeedBroker-Demo", actor: "owner" }, { now: NOW });
  const wrong = await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID, corpus: corpusOf("Elsewhere-Live", "XAUUSD", from, 5) }, { now: NOW });
  assert.equal(wrong.corpus_error, "broker_mismatch");
  const ok = await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID, corpus: corpusOf("FeedBroker-Demo", "XAUUSD", from, 5) }, { now: NOW });
  assert.equal(ok.corpus_cursor_ms, from + 4 * MIN);
  assert.deepEqual(e.DB.raw.prepare("SELECT source, bridge_id FROM corpus_feeds").all().map((r) => ({ ...r })), [{ source: "mt5:feedbroker-demo:XAUUSD", bridge_id: "oanda" }]);
  // Another feed id may not write into this feed's source.
  await feedSync(e, { bridgeId: "other", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW });
  await setFeedConnection(e, { bridgeId: "other", envelope: envl, server: "FeedBroker-Demo", actor: "owner" }, { now: NOW });
  assert.equal((await feedSync(e, { bridgeId: "other", state: FEED_STATE, publicKey: SPKI, kid: KID, corpus: corpusOf("FeedBroker-Demo", "XAUUSD", from, 6) }, { now: NOW })).corpus_error, "source_of_another_feed");
  // A feed on the executor's own server is refused (it would be no independent source).
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS omega_connection (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, status TEXT NOT NULL, server TEXT, kid TEXT, envelope TEXT, updated_by TEXT, updated_ms INTEGER)");
  e.DB.raw.exec("INSERT OR REPLACE INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'FeedBroker-Demo')");
  assert.equal((await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID, corpus: corpusOf("FeedBroker-Demo", "XAUUSD", from, 6) }, { now: NOW })).corpus_error, "feed_on_executor_server");
});

test("FB-4. the MT5 fallback prefers a fresh feed; every other reader, and a stale feed, gets the executor's own bars", async () => {
  const e = env();
  const envl = await buildEnvelope(SPKI, KID, { server: "FeedBroker-Demo", login: "1", password: "x" });
  // The executor's own corpus source (as the executor's ingest stores it).
  await readCorpusBars(e, {}); // creates the corpus schema
  e.DB.raw.exec(`INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, last_error, updated_ms) VALUES ('mt5:execbroker-mt5:GOLD', 'ExecBroker-MT5', 'GOLD', 1, ${NOW - 2 * MIN}, 1, 0, NULL, ${NOW})`);
  e.DB.raw.exec(`INSERT INTO corpus_bars (source, minute_ms, o, h, l, c, tick_volume, spread_points, connection_version, received_ms) VALUES ('mt5:execbroker-mt5:GOLD', ${NOW - 2 * MIN}, 1, 2, 0.5, 1.5, 1, 1, 1, ${NOW})`);
  await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW });
  await setFeedConnection(e, { bridgeId: "oanda", envelope: envl, server: "FeedBroker-Demo", actor: "owner" }, { now: NOW });
  await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID, corpus: corpusOf("FeedBroker-Demo", "XAUUSD", NOW - 5 * MIN, 4) }, { now: NOW + 1000 });
  const fallback = await readCorpusBars(e, { preferFeed: true, now: NOW + 1000 });
  assert.equal(fallback.source, "mt5:feedbroker-demo:XAUUSD", "the fallback reads the fresh feed");
  const exec = await readCorpusBars(e, {});
  assert.equal(exec.source, "mt5:execbroker-mt5:GOLD", "the ladder, the gates and the basis read the executor's own source, never a feed");
  const stale = await readCorpusBars(e, { preferFeed: true, now: NOW + FEED_FRESH_MS + 5 * MIN });
  assert.equal(stale.source, "mt5:execbroker-mt5:GOLD", "a stale feed falls back to the executor's bars");
});

test("FB-5. the executor's bridge sync is unchanged by a feed's rows", async () => {
  const e = env();
  await feedSync(e, { bridgeId: "oanda", state: FEED_STATE, publicKey: SPKI, kid: KID }, { now: NOW });
  const r = await bridgeSync(e, { state: { connected: true, server: "ExecBroker-MT5", received_ms: NOW - 1000, account: { currency: "USD", balance: 1, equity: 1 }, symbol: { name: "GOLD" }, positions: [] }, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now: NOW, signal: null });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.intents), "the executor still gets its intents list");
  const b = e.DB.raw.prepare("SELECT kid FROM omega_bridge WHERE id = 1").get();
  assert.equal(b.kid, KID);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_feed_bridges").get().n, 1, "the feed row stays its own");
});
