// CG2 (2026-11-28): the corpus ingest's shifted-copy guard, the closed-minute filter and the one-time repair of the
// 10:25:58Z feed batch (src/corpus-oracle.mjs). No network: an in-memory SQLite D1. Synthetic prices only.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SHIFT_HOURS, SHIFTED_BATCH_2026_11_28, detectShiftedCopy, ingestFeedCorpus, repairShiftedBatch, repairShiftedBatchOnce, resetCorpusSchemaCacheForTests, resetShiftRepairForTests } from "../src/corpus-oracle.mjs";

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
const M = 60_000, H = 3_600_000;
const at = (iso) => Date.parse(iso);
// Irregular synthetic bars: no two minutes share an OHLC, so an honest batch never equals a stored one at any shift.
const bar = (t, i, seed = 0) => { const o = 3000 + ((i * 37 + seed * 101) % 997) / 10, c = o + (((i * 13) % 7) - 3) / 10; return [t, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.2, c, 10 + i, 20]; };
const series = (fromMs, n, seed = 0) => Array.from({ length: n }, (_, i) => bar(fromMs + i * M, i, seed));
const CONN = { version: 1, status: "stored", server: "FeedBroker-Demo" };
const STATE = { server: "FeedBroker-Demo", symbol: { name: "XAUUSD" } };
const SOURCE = "mt5:feedbroker-demo:XAUUSD";
const corpus = (rows) => ({ timeframe: "M1", server: "FeedBroker-Demo", symbol: "XAUUSD", bars: rows });
function env() { resetCorpusSchemaCacheForTests(); resetShiftRepairForTests(); return { DB: d1(), CORPUS_ORACLE_MODE: "shadow" }; }
const sync = (e, rows, now) => ingestFeedCorpus(e, corpus(rows), { bridgeId: "oanda", connection: CONN, state: STATE, now });
const count = (e, lo, hi, source = SOURCE) => Number(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM corpus_bars WHERE source = ? AND minute_ms BETWEEN ? AND ?").get(source, lo, hi).n);
const src = (e, source = SOURCE) => e.DB.raw.prepare("SELECT last_minute_ms, refused, last_error FROM corpus_sources WHERE source = ?").get(source);
function quiet(fn) {
  const warn = console.warn, log = console.log, seen = [];
  console.warn = (...a) => seen.push(["warn", ...a]); console.log = (...a) => seen.push(["log", ...a]);
  return Promise.resolve().then(fn).finally(() => { console.warn = warn; console.log = log; }).then((r) => ({ r, seen }));
}

// The incident: Friday 27 Nov 2026. Stored 17:43-19:42Z; at Saturday 10:25:58Z one sync carried 19:43-21:42Z with the
// OHLC of two hours earlier (the terminal had taken its server time for UTC).
const FROM = at("2026-11-27T17:43:00Z"), NEW_FROM = at("2026-11-27T19:43:00Z"), NEW_TO = at("2026-11-27T21:42:00Z");
const NOW = at("2026-11-28T10:25:58Z");
const shifted = (rows, ms) => rows.map(([t, ...rest]) => [t + ms, ...rest]);

test("CG2-1 the shift list covers whole hours from -14 to +14, never 0", () => {
  assert.equal(SHIFT_HOURS.length, 28);
  assert.ok(!SHIFT_HOURS.includes(0));
  assert.equal(Math.min(...SHIFT_HOURS), -14); assert.equal(Math.max(...SHIFT_HOURS), 14);
  assert.ok(1 + 3 * SHIFT_HOURS.length <= 100, "one lookup stays under D1's 100 bound parameters");
});

test("CG2-2 the 10:25:58Z signature (120 bars, +2h, identical OHLC) is refused whole and logged once", async () => {
  const e = env();
  const stored = series(FROM, 120);
  const first = await sync(e, stored, at("2026-11-27T19:43:30Z"));
  assert.equal(first.stored, 120);
  const { r, seen } = await quiet(() => sync(e, shifted(stored, 2 * H), NOW));
  assert.equal(r.error, "shifted_copy");
  assert.equal(r.shift_hours, 2);
  assert.equal(r.cursor_ms, at("2026-11-27T19:42:00Z"), "the cursor stays on the last honest minute");
  assert.equal(count(e, NEW_FROM, NEW_TO), 0, "nothing of the batch is stored");
  const s = src(e);
  assert.equal(s.last_error, "shifted_copy");
  assert.equal(Number(s.refused), 120);
  assert.equal(Number(s.last_minute_ms), at("2026-11-27T19:42:00Z"));
  const warns = seen.filter((x) => x[0] === "warn" && x[1] === "corpus_shifted_copy_refused");
  assert.equal(warns.length, 1);
  const logged = JSON.parse(warns[0][2]);
  assert.deepEqual({ source: logged.source, shift_hours: logged.shift_hours, matched: logged.matched, of: logged.of }, { source: SOURCE, shift_hours: 2, matched: 120, of: 120 });
  assert.doesNotMatch(warns[0][2], /30\d\d\./, "no price in the log");
  // The same batch again: refused again, counted, not logged a second time.
  const again = await quiet(() => sync(e, shifted(stored, 2 * H), NOW + 15_000));
  assert.equal(again.r.error, "shifted_copy");
  assert.equal(again.seen.filter((x) => x[1] === "corpus_shifted_copy_refused").length, 0);
  assert.equal(Number(src(e).refused), 240);
});

test("CG2-3 honest batches are stored: contiguous bars, overlaps with the cursor and a reconnect after a gap", async () => {
  const e = env();
  assert.equal((await sync(e, series(FROM, 120), at("2026-11-27T19:43:30Z"))).stored, 120);
  const next = await sync(e, [...series(FROM + 100 * M, 20), ...series(NEW_FROM, 120, 7)], at("2026-11-27T21:43:30Z"));
  assert.equal(next.error, undefined);
  assert.equal(next.stored, 120, "the overlap is ignored, the new minutes stored");
  assert.equal(count(e, NEW_FROM, NEW_TO), 120);
  assert.equal(src(e).last_error, null);
  // A batch that repeats one stored bar two hours later (a coincidence) is not a copy: two of the newest three must match.
  const one = series(at("2026-11-27T21:43:00Z"), 3, 11);
  one[0] = [one[0][0], ...series(FROM, 120)[0].slice(1)];
  assert.equal(await detectShiftedCopy(e.DB, SOURCE, one.map(([t, o, h, l, c]) => ({ t, o, h, l, c })), { prevLast: NEW_TO }), null);
});

test("CG2-4 a copy at another whole-hour shift (-3h) is caught too; flat bars do not count as evidence", async () => {
  const e = env();
  await sync(e, series(FROM, 120), at("2026-11-27T19:43:30Z"));
  const copy = shifted(series(FROM, 120).slice(60), -3 * H); // 15:43-16:42Z with the bars of 18:43-19:42Z, before the cursor
  const hit = await detectShiftedCopy(e.DB, SOURCE, copy.map(([t, o, h, l, c]) => ({ t, o, h, l, c })), { prevLast: null });
  assert.deepEqual(hit, { shift_hours: -3, matched: 60, of: 60 });
  const flat = Array.from({ length: 5 }, (_, i) => ({ t: NEW_FROM + i * M, o: 3000, h: 3000, l: 3000, c: 3000 }));
  assert.equal(await detectShiftedCopy(e.DB, SOURCE, flat, { prevLast: null }), null);
});

test("CG2-5 bars on minutes gold does not trade are refused, not stored (the weekend and the daily break)", async () => {
  const e = env();
  const sat = series(at("2026-11-28T10:00:00Z"), 5); // Saturday
  const brk = series(at("2026-11-26T22:10:00Z"), 5); // Thursday 17:10 New York, the daily break
  const ok = series(at("2026-11-27T19:00:00Z"), 5, 3);
  const r = await sync(e, [...brk, ...ok, ...sat], NOW);
  assert.equal(r.stored, 5);
  assert.equal(r.refused, 10);
  assert.equal(count(e, at("2026-11-26T22:00:00Z"), at("2026-11-26T22:59:00Z")), 0);
  assert.equal(count(e, at("2026-11-28T00:00:00Z"), at("2026-11-28T23:59:00Z")), 0);
});

test("CG2-6 the one-time repair deletes the 120 shifted rows of that batch, resets the cursor, and deletes 0 the second time", async () => {
  const e = env();
  assert.equal((await repairShiftedBatchOnce(e)).deleted, 0, "an empty corpus: nothing to repair, schema made");
  const S = SHIFTED_BATCH_2026_11_28;
  assert.deepEqual([S.from_ms, S.to_ms, S.shift_ms, new Date(S.received_ms).toISOString()], [at("2026-11-27T19:43:00Z"), at("2026-11-27T21:42:00Z"), 2 * H, "2026-11-28T10:25:58.378Z"]);
  const raw = e.DB.raw;
  const ins = raw.prepare("INSERT INTO corpus_bars (source, minute_ms, o, h, l, c, tick_volume, spread_points, connection_version, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, ?)");
  const honest = series(at("2026-11-27T04:55:00Z"), 888 - 120).concat(series(FROM, 120, 1));
  for (const [t, o, h, l, c, v, s] of honest) ins.run(S.source, t, o, h, l, c, v, s, t + 30_000);
  for (const [t, o, h, l, c, v, s] of shifted(series(FROM, 120, 1), 2 * H)) ins.run(S.source, t, o, h, l, c, v, s, S.received_ms);
  // Kept: another source's rows in the window from the same second.
  for (const [t, o, h, l, c, v, s] of shifted(series(FROM, 120, 1), 2 * H)) ins.run("mt5:other:XAUUSD", t, o, h, l, c, v, s, S.received_ms);
  raw.prepare("INSERT INTO corpus_sources (source, server, symbol, connection_version, last_minute_ms, stored, refused, updated_ms) VALUES (?, 'x', 'XAUUSD.SML', 5, ?, 1008, 0, 0)").run(S.source, S.to_ms);
  resetShiftRepairForTests();
  const { r, seen } = await quiet(() => repairShiftedBatchOnce(e));
  assert.deepEqual(r, { source: S.source, deleted: 120, cursor_reset: true, last_minute_ms: at("2026-11-27T19:42:00Z") });
  assert.equal(count(e, S.from_ms, S.to_ms, S.source), 0);
  assert.equal(count(e, 0, S.from_ms - 1, S.source), 888, "the 888 honest rows are untouched");
  assert.equal(count(e, S.from_ms, S.to_ms, "mt5:other:XAUUSD"), 120, "another source is never touched");
  const line = seen.find((x) => x[1] === "corpus_shifted_batch_repaired");
  assert.ok(line);
  assert.match(line[2], /"deleted":120/);
  assert.match(line[2], /"last_minute":"2026-11-27T19:42:00.000Z"/);
  assert.equal(await repairShiftedBatchOnce(e), null, "once per isolate");
  const second = await quiet(() => repairShiftedBatch(e.DB));
  assert.deepEqual(second.r, { source: S.source, deleted: 0, cursor_reset: false, last_minute_ms: at("2026-11-27T19:42:00Z") });
  assert.equal(second.seen.length, 0, "a no-op repair logs nothing");
});
