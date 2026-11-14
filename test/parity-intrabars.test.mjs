// What a GMI parity mismatch was computed on (owner 2026-11-14: "kerjakan 1 dan 2", item 1).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { candleWindow, intrabarFingerprint, compareFingerprints, readIntrabars, recheckMismatchIntrabars, INTRABAR_RECHECK_AFTER_MS } from "../src/parity-intrabars.mjs";
import { compareWithWebhooks, ensureSchema, recordComparison, resetSchemaCacheForTests } from "../src/parity-registry.mjs";

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
const kvWith = (map) => ({ async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, v); } });
const OPEN = Date.UTC(2026, 10, 13, 18, 30);
const KEY = `OANDA:XAUUSD:15:${OPEN}`;
const minutes = (n, { from = 0, vol = (i) => 10 + i } = {}) => Array.from({ length: n }, (_, i) => {
  const t = OPEN / 1000 + (from + i) * 60;
  return { time: t, open: 3870 + i, high: 3871 + i, low: 3869 + i, close: i % 2 ? 3869.5 + i : 3870.5 + i, volume: vol(i) };
});

test("the window of a candle key and the intrabar series GMI reads there", () => {
  assert.deepEqual(candleWindow(KEY), { tf: "15", openMs: OPEN, closeMs: OPEN + 900_000, series: "1m" });
  assert.equal(candleWindow(`OANDA:XAUUSD:240:${OPEN}`).series, "5m");
  assert.equal(candleWindow(`OANDA:XAUUSD:1D:${OPEN}`).series, "15m");
  assert.equal(candleWindow("nonsense"), null);
});

test("the fingerprint keeps each intrabar's offset, volume and direction, and one hash: no price", () => {
  const all = [...minutes(15), ...minutes(3, { from: 15 })];
  const fp = intrabarFingerprint(all, candleWindow(KEY));
  assert.equal(fp.count, 15, "only the bar's own minutes");
  assert.deepEqual(fp.bars.slice(0, 3), [{ at: 0, v: 10, d: 1 }, { at: 1, v: 11, d: -1 }, { at: 2, v: 12, d: 1 }]);
  assert.match(fp.hash, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(JSON.stringify(fp), /387\d/, "no price in the fingerprint");
  // The same minutes give the same hash; a changed last minute is found.
  assert.equal(intrabarFingerprint(minutes(15), candleWindow(KEY)).hash, fp.hash);
  const later = intrabarFingerprint(minutes(15, { vol: (i) => (i === 14 ? 99 : 10 + i) }), candleWindow(KEY));
  assert.deepEqual(compareFingerprints(fp, later), { same: false, changed: [14], added: [], removed: [] });
  assert.deepEqual(compareFingerprints(intrabarFingerprint(minutes(14), candleWindow(KEY)), fp), { same: false, changed: [], added: [14], removed: [] }, "a minute that arrived late");
  assert.equal(compareFingerprints(null, fp), null);
});

test("a GMI mismatch keeps both sides' values, and the intrabars are read again once, later", async () => {
  resetSchemaCacheForTests();
  // Both sides' values on a mismatch (2026-11-13 18:45: TradingView sold, the local engine did not).
  const candle = { o: 1, h: 2, l: 0.5, c: 1.5, volume: 100 };
  const record = { engine: "gmi", provenance: { source_hash: "b".repeat(64), implementation_hash: "1".repeat(64) }, values: { candle, comparable: { gmi_v12_70: { verdict: 0, gate: 1, gmi_dir: 0, prophet_dir: 1, conflict: false } } } };
  const comparison = compareWithWebhooks(record, { gmi_v12_70: { ...candle, verdict: 0, gate: -1, gmi_dir: -1, prophet_dir: 1, conflict: true, shared_core_status: "ok" } });
  assert.equal(comparison.status, "mismatch");
  assert.deepEqual(comparison.values, { gmi_v12_70: { local: { verdict: 0, gate: 1, gmi_dir: 0, prophet_dir: 1, conflict: false }, webhook: { verdict: 0, gate: -1, gmi_dir: -1, prophet_dir: 1, conflict: true, shared_core_status: "ok" } } });
  assert.doesNotMatch(JSON.stringify(comparison.values), /"c":|"o":|volume/, "the input bar is not repeated");
  // The intrabars as cached at the comparison, kept in the detail.
  const kv = new Map([["market-data:v2:series:OANDA:XAUUSD|1m", JSON.stringify({ candles: minutes(15) })]]);
  const env = { DB: d1(), SIGNAL_CACHE: kvWith(kv) };
  await ensureSchema(env.DB);
  comparison.intrabars = await readIntrabars(env, KEY);
  assert.equal(comparison.intrabars.count, 15);
  const id = { engine: "gmi_m15", sourceHash: "b".repeat(64), implementationHash: "1".repeat(64), mizanSourceHash: null, mizanImplementationHash: null };
  const comparedAt = new Date(OPEN + 900_000 + 44_000).toISOString();
  await env.DB.prepare("INSERT INTO engine_parity_registry (engine, source_hash, implementation_hash, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id.engine, id.sourceHash, id.implementationHash, comparedAt, comparedAt).run();
  await recordComparison(env.DB, id, KEY, comparison, undefined, comparedAt);
  const stored = () => JSON.parse(env.DB.raw.prepare("SELECT detail FROM engine_parity_comparisons WHERE candle_key = ?").get(KEY).detail);
  assert.deepEqual([stored().values.gmi_v12_70.webhook.gmi_dir, stored().intrabars.count], [-1, 15]);
  // Too early: not read again. Later, the last minute's volume was revised by TradingView.
  const t0 = Date.parse(comparedAt);
  assert.deepEqual(await recheckMismatchIntrabars(env, { now: t0 + 60_000 }), { status: "ok", checked: 0, updated: 0 });
  kv.set("market-data:v2:series:OANDA:XAUUSD|1m", JSON.stringify({ candles: minutes(15, { vol: (i) => (i === 14 ? 99 : 10 + i) }) }));
  assert.deepEqual(await recheckMismatchIntrabars(env, { now: t0 + INTRABAR_RECHECK_AFTER_MS + 1 }), { status: "ok", checked: 1, updated: 1 });
  const later = stored().intrabars_later;
  assert.deepEqual([later.same, later.changed, later.count], [false, [14], 15]);
  // Once only; the result and the counts are untouched.
  assert.deepEqual(await recheckMismatchIntrabars(env, { now: t0 + INTRABAR_RECHECK_AFTER_MS + 120_000 }), { status: "ok", checked: 0, updated: 0 });
  assert.equal(env.DB.raw.prepare("SELECT result FROM engine_parity_comparisons WHERE candle_key = ?").get(KEY).result, "mismatch");
  assert.deepEqual(await recheckMismatchIntrabars({}, {}), { status: "unavailable" });
});
