// Corpus Oracle phase 1 (owner 2026-11-11): the broker's closed M1 bars from Omega's active broker,
// pair and user, kept and measured against the TradingView feed; off by default; no decision reads it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { aggregateBars, corpusBasis, corpusMode, corpusSource, corpusStatus, ingestCorpus, readCorpusBars, resetCorpusSchemaCacheForTests, validateCorpus } from "../src/corpus-oracle.mjs";
import { feedAt, keyCloseOf } from "../src/feed.mjs";
import { bridgeSync, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
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
const NOW = Date.parse("2026-11-11T10:00:30Z");
const T0 = Date.parse("2026-11-11T09:00:00Z");
const bar = (i, base = 4100) => [T0 + i * M, base + i * 0.1, base + i * 0.1 + 0.5, base + i * 0.1 - 0.5, base + i * 0.1 + 0.2, 120, 18];
const bars = (n) => Array.from({ length: n }, (_, i) => bar(i));
const EXECUTOR = { connected: true, server: "Monex-Live", symbol: { name: "XAUUSD" } };
const CONN = { version: 3, status: "stored", server: "Monex-Live" };
const corpus = (over = {}) => ({ server: "Monex-Live", symbol: "XAUUSD", timeframe: "M1", bars: bars(60), ...over });

test("only Omega's active broker, pair and user: anything else is refused, never stored", () => {
  assert.equal(corpusMode({}), "off");
  assert.equal(corpusMode({ CORPUS_ORACLE_MODE: "shadow" }), "shadow");
  const ok = validateCorpus(corpus(), { executor: EXECUTOR, connection: CONN, now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.source, "mt5:monex-live:XAUUSD");
  assert.equal(ok.bars.length, 60);
  assert.equal(ok.connection_version, 3);
  assert.equal(validateCorpus(corpus({ server: "Other-Live" }), { executor: EXECUTOR, connection: CONN, now: NOW }).error, "broker_mismatch");
  assert.equal(validateCorpus(corpus({ symbol: "XAGUSD" }), { executor: EXECUTOR, connection: CONN, now: NOW }).error, "pair_mismatch");
  assert.equal(validateCorpus(corpus(), { executor: EXECUTOR, connection: { ...CONN, status: "cleared" }, now: NOW }).error, "no_active_user");
  assert.equal(validateCorpus(corpus(), { executor: { ...EXECUTOR, server: "Monex-Demo" }, connection: CONN, now: NOW }).error, "executor_broker_mismatch");
  assert.equal(validateCorpus(corpus({ timeframe: "M5" }), { executor: EXECUTOR, connection: CONN, now: NOW }).error, "timeframe_must_be_M1");
  // Open bar, unaligned time, broken OHLC, out of order: each refused bar is counted.
  const bad = validateCorpus(corpus({ bars: [bar(1), [T0 + 30_000, 1, 2, 0.5, 1.5, 1, 1], [T0 + 2 * M, 10, 9, 8, 9.5, 1, 1], bar(0), [NOW - (NOW % M), 1, 2, 0.5, 1, 1, 1]] }), { executor: EXECUTOR, connection: CONN, now: NOW });
  assert.equal(bad.ok, true);
  assert.equal(bad.bars.length, 1);
  assert.equal(bad.refused, 4);
});

test("aggregation keeps complete bars only; the basis is broker minus TradingView, with the return correlation", () => {
  const m1 = bars(60).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const m15 = aggregateBars(m1, 15);
  assert.equal(m15.length, 4);
  assert.equal(m15[0].open_ms, T0);
  assert.equal(m15[0].close, m1[14].c);
  assert.equal(m15[0].high, Math.max(...m1.slice(0, 15).map((b) => b.h)));
  assert.equal(aggregateBars(m1.filter((b, i) => i !== 3), 15).length, 3, "a missing minute leaves its 15m bar out");
  const broker = [4100, 4103, 4101.5, 4106].map((close, i) => ({ close_ms: T0 + (i + 1) * 15 * M, close }));
  const ref = broker.map((b, i) => ({ close_ms: b.close_ms, close: b.close - 0.3 + (i % 2 ? 0.02 : -0.02) }));
  const basis = corpusBasis(broker, ref);
  assert.equal(basis.matched, 4);
  assert.ok(Math.abs(basis.offset_mean - 0.3) < 0.001);
  assert.ok(basis.return_correlation > 0.9);
  assert.equal(corpusBasis([], ref).offset_mean, null);
});

test("ingest: off ignores; shadow stores once per minute, returns the cursor, counts refusals; the status measures it", async () => {
  resetCorpusSchemaCacheForTests();
  const db = d1();
  db.raw.exec("CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT)");
  db.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Monex-Live')").run();
  assert.deepEqual(await ingestCorpus({ DB: db }, corpus(), { executor: EXECUTOR, now: NOW }), { mode: "off", cursor_ms: null });
  const env = { DB: db, CORPUS_ORACLE_MODE: "shadow" };
  const first = await ingestCorpus(env, corpus(), { executor: EXECUTOR, now: NOW });
  assert.equal(first.stored, 60);
  assert.equal(first.cursor_ms, T0 + 59 * M);
  const again = await ingestCorpus(env, corpus(), { executor: EXECUTOR, now: NOW });
  assert.equal(again.stored, 0, "a minute is stored once");
  const wrong = await ingestCorpus(env, corpus({ server: "Other-Live" }), { executor: EXECUTOR, now: NOW });
  assert.equal(wrong.error, "broker_mismatch");
  const tv = { candles: [0, 1, 2, 3].map((i) => ({ close_time: new Date(T0 + (i + 1) * 15 * M).toISOString(), close: 4100 + (i * 15 + 14) * 0.1 + 0.2 - 0.25 })) };
  const status = await corpusStatus({ ...env, SIGNAL_CACHE: { get: async (k) => (k.endsWith("|15m") ? JSON.stringify(tv) : null) } }, { now: NOW });
  assert.equal(status.mode, "shadow");
  assert.equal(status.feeds_local_lane, false, "phase 1 feeds no decision");
  const s = status.sources.find((x) => x.source === "mt5:monex-live:XAUUSD");
  assert.equal(s.bars_24h, 60);
  assert.equal(s.missing_minutes_24h, 0);
  assert.equal(s.m15_complete_24h, 4);
  assert.ok(Math.abs(s.basis_m15.offset_mean - 0.25) < 0.001);
  assert.equal(status.sources.find((x) => x.source === "mt5:other-live:XAUUSD").last_error, "broker_mismatch");
  assert.doesNotMatch(JSON.stringify(status), /login|password|account/i);
});

test("the bridge sync takes the corpus and answers the cursor; without it, the sync is unchanged", async () => {
  resetOmegaBrokerSchemaForTests(); resetCorpusSchemaCacheForTests();
  const m = new Map();
  const env = { DB: d1(), SIGNAL_CACHE: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }, OMEGA_ENGINE_ENABLED: "false", CORPUS_ORACLE_MODE: "shadow" };
  const STATE = { connected: true, server: "Monex-Live", received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 1, equity: 1, day_start_balance: 1, day_realized_pl: 0 }, symbol: { name: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 }, positions: [] };
  const args = { state: STATE, results: [], publicKey: "A".repeat(64), kid: "0123456789abcdef", bridgeVersion: "1.0.0" };
  const plain = await bridgeSync(env, args, { now: NOW, signal: null });
  assert.equal(plain.ok, true);
  assert.equal(plain.corpus_cursor_ms, null);
  await env.DB.prepare("UPDATE omega_connection SET version = 3, status = 'stored', server = 'Monex-Live', kid = '0123456789abcdef' WHERE id = 1").run();
  const withCorpus = await bridgeSync(env, { ...args, corpus: corpus() }, { now: NOW, signal: null });
  assert.equal(withCorpus.ok, true);
  assert.equal(withCorpus.corpus_cursor_ms, T0 + 59 * M);
  assert.equal(corpusSource(" Monex-Live ", "xauusd"), "mt5:monex-live:XAUUSD");
});

test("the MT5 fallback reads the active source's bars after a time; the feed of a candle follows the 1m fallback mark", async () => {
  resetCorpusSchemaCacheForTests();
  const db = d1();
  db.raw.exec("CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT)");
  db.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Monex-Live')").run();
  assert.deepEqual(await readCorpusBars({ DB: db }, { sinceMs: 0 }), { source: null, bars: [] }, "off reads nothing");
  const env = { DB: db, CORPUS_ORACLE_MODE: "shadow" };
  assert.deepEqual(await readCorpusBars(env), { source: null, bars: [] }, "nothing collected yet");
  await ingestCorpus(env, corpus(), { executor: EXECUTOR, now: NOW });
  const r = await readCorpusBars(env, { sinceMs: T0 + 49 * M, limit: 5 });
  assert.equal(r.source, "mt5:monex-live:XAUUSD");
  assert.deepEqual(r.bars.map((b) => b.t), [50, 51, 52, 53, 54].map((i) => T0 + i * M), "after the time, oldest first, limited");
  assert.deepEqual(Object.keys(r.bars[0]).sort(), ["c", "h", "l", "o", "t", "v"]);

  assert.equal(keyCloseOf(`OANDA:XAUUSD:5:${T0}`), T0 + 5 * M);
  assert.equal(keyCloseOf(`OANDA:XAUUSD:60:${T0}`), T0 + 60 * M);
  assert.equal(keyCloseOf("nonsense"), null);
  const kv = (rec) => ({ SIGNAL_CACHE: { get: async (k) => (k === "market-data:v2:series:OANDA:XAUUSD|1m" ? JSON.stringify(rec) : null) } });
  assert.equal(await feedAt(kv({ candles: [] }), T0), "tradingview");
  const marked = kv({ fallback: { since_sec: T0 / 1000 }, candles: [] });
  assert.equal(await feedAt(marked, T0), "tradingview", "a candle that closed before the fallback");
  assert.equal(await feedAt(marked, T0 + 5 * M), "mt5_fallback");
  assert.equal(await feedAt({}, T0 + 5 * M), "tradingview");
});
