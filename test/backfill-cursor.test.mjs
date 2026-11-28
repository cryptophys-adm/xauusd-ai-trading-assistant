// BF1 (a): the backfill cursor (src/corpus-oracle.mjs): each corpus sync answers corpus_backfill_from_ms, the source's
// first missing trading minute in the last 10 hours, or null. No network: an in-memory SQLite D1.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKFILL_WINDOW_MS, firstTradingMinute, ingestFeedCorpus, ingestCorpus, readCorpusBars, resetCorpusSchemaCacheForTests } from "../src/corpus-oracle.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  const seen = [];
  return {
    raw: db,
    seen,
    prepare(sql) {
      seen.push(sql);
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const M = 60_000;
const at = (iso) => Date.parse(iso);
const bars = (fromMs, n) => Array.from({ length: n }, (_, i) => [fromMs + i * M, 3600 + i, 3601 + i, 3599 + i, 3600.5 + i, 10, 20]);
const CONN = { version: 1, status: "stored", server: "FeedBroker-Demo" };
const STATE = { server: "FeedBroker-Demo", symbol: { name: "XAUUSD" } };
const feedCorpus = (fromMs, n) => ({ timeframe: "M1", server: "FeedBroker-Demo", symbol: "XAUUSD", bars: bars(fromMs, n) });
function env() { resetCorpusSchemaCacheForTests(); return { DB: d1(), CORPUS_ORACLE_MODE: "shadow" }; }
const sync = (e, fromMs, n, now) => ingestFeedCorpus(e, feedCorpus(fromMs, n), { bridgeId: "oanda", connection: CONN, state: STATE, now });
const lagReads = (e) => e.DB.seen.filter((s) => s.includes("LAG(")).length;
const cached = (e) => e.DB.raw.prepare("SELECT backfill_from_ms AS b FROM corpus_sources WHERE source = 'mt5:feedbroker-demo:XAUUSD'").get()?.b ?? null;

// Friday 27 Nov 2026 04:00 UTC (Thursday 23:00 New York): gold trades.
const NOW = at("2026-11-27T04:00:00Z");

test("BF-1 firstTradingMinute: gold's daily break and weekend are not missing minutes", () => {
  assert.equal(firstTradingMinute(at("2026-11-24T21:00:00Z"), at("2026-11-24T21:30:00Z")), at("2026-11-24T21:00:00Z"));
  assert.equal(firstTradingMinute(at("2026-11-24T22:00:00Z"), at("2026-11-24T23:30:00Z")), at("2026-11-24T23:00:00Z"), "the daily break 22:00-23:00 UTC in November");
  assert.equal(firstTradingMinute(at("2026-11-24T22:00:00Z"), at("2026-11-24T23:00:00Z")), null, "only the break");
  assert.equal(firstTradingMinute(at("2026-11-29T22:00:00Z"), at("2026-11-29T23:00:00Z")), null, "Sunday before the 23:00 reopen");
  assert.equal(BACKFILL_WINDOW_MS, 10 * 3_600_000);
});

test("BF-2 a steady feed: no backfill, and no hole query once the source has bars", async () => {
  const e = env();
  const first = await sync(e, NOW - 10 * M, 5, NOW);
  assert.equal(first.backfill_from_ms, null, "a first source with no other gold source: no floor, nothing to ask");
  const before = lagReads(e);
  const next = await sync(e, NOW - 5 * M, 5, NOW);
  assert.equal(next.backfill_from_ms, null);
  assert.equal(lagReads(e), before, "contiguous bars, no hole open: the hole query is not run");
  assert.equal(cached(e), null);
});

test("BF-3 a reconnect opens a hole; the oldest-first chunk closes it", async () => {
  const e = env();
  await sync(e, NOW - 120 * M, 10, NOW);                 // 02:00-02:09
  const after = await sync(e, NOW - 30 * M, 10, NOW);    // 03:30-03:39: 02:10-03:29 never sent
  assert.equal(after.backfill_from_ms, Math.floor((NOW - 110 * M) / M) * M, "the first minute after the last stored one");
  assert.equal(cached(e), after.backfill_from_ms, "cached on the source's row");
  const half = await sync(e, NOW - 110 * M, 40, NOW);     // 02:10-02:49
  assert.equal(half.backfill_from_ms, Math.floor((NOW - 70 * M) / M) * M, "the cursor walks forward with each chunk");
  const done = await sync(e, NOW - 70 * M, 40, NOW);      // 02:50-03:29
  assert.equal(done.backfill_from_ms, null, "closed");
  assert.equal(cached(e), null);
  const quiet = lagReads(e);
  await sync(e, NOW - 20 * M, 5, NOW);                    // contiguous again
  assert.equal(lagReads(e), quiet, "no query once the hole is closed");
});

test("BF-4 bounded to the last 10 hours", async () => {
  const e = env();
  await sync(e, NOW - 12 * 3_600_000, 5, NOW);
  const r = await sync(e, NOW - 5 * M, 5, NOW);
  assert.equal(r.backfill_from_ms, Math.floor((NOW - BACKFILL_WINDOW_MS) / M) * M, "the window's start, never older");
});

test("BF-5 the daily break and the weekend are not holes", async () => {
  const e = env();
  const now = at("2026-11-24T23:10:30Z");
  await sync(e, at("2026-11-24T21:50:00Z"), 10, now);     // to 21:59
  assert.equal((await sync(e, at("2026-11-24T23:00:00Z"), 10, now)).backfill_from_ms, null, "22:00-23:00 is the break");
  const w = env();
  const sun = at("2026-11-29T23:10:30Z");
  await sync(w, at("2026-11-27T21:50:00Z"), 10, sun);      // Friday to 21:59
  assert.equal((await sync(w, at("2026-11-29T23:00:00Z"), 10, sun)).backfill_from_ms, null, "the weekend");
  const late = env();
  await sync(late, at("2026-11-27T21:50:00Z"), 10, sun);
  assert.equal((await sync(late, at("2026-11-29T23:05:00Z"), 5, sun)).backfill_from_ms, at("2026-11-29T23:00:00Z"), "the reopen's first minutes are a hole");
});

test("BF-6 a new source asks from the newest minute any other gold source stored", async () => {
  const e = env();
  await readCorpusBars(e, {}); // creates the corpus schema
  e.DB.raw.exec(`INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, last_error, updated_ms) VALUES ('mt5:execbroker-mt5:GOLD', 'ExecBroker-MT5', 'GOLD', 1, ${NOW - 60 * M}, 1, 0, NULL, ${NOW})`);
  e.DB.raw.exec(`INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, last_error, updated_ms) VALUES ('mt5macro:execbroker-mt5:XAGUSD', 'ExecBroker-MT5', 'XAGUSD', 1, ${NOW}, 1, 0, NULL, ${NOW})`);
  const r = await sync(e, NOW - 10 * M, 10, NOW);
  assert.equal(r.backfill_from_ms, NOW - 59 * M, "the minute after the executor's last (a macro source does not count)");
});

test("BF-7 the executor's path answers the same; off answers nothing new", async () => {
  resetCorpusSchemaCacheForTests();
  const db = d1();
  db.raw.exec("CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT)");
  db.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'AnyBroker-Live')").run();
  const EXECUTOR = { connected: true, server: "AnyBroker-Live", symbol: { name: "XAUUSD" } };
  const corpus = (fromMs, n) => ({ server: "AnyBroker-Live", symbol: "XAUUSD", timeframe: "M1", bars: bars(fromMs, n) });
  assert.deepEqual(await ingestCorpus({ DB: db }, corpus(NOW - 10 * M, 5), { executor: EXECUTOR, now: NOW }), { mode: "off", cursor_ms: null });
  const e = { DB: db, CORPUS_ORACLE_MODE: "shadow" };
  await ingestCorpus(e, corpus(NOW - 120 * M, 10), { executor: EXECUTOR, now: NOW });
  const r = await ingestCorpus(e, corpus(NOW - 30 * M, 10), { executor: EXECUTOR, now: NOW });
  assert.equal(r.backfill_from_ms, Math.floor((NOW - 110 * M) / M) * M);
});
