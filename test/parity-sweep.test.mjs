import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  PARITY_SWEEP_CRON, PARITY_SWEEP_LOOKBACK_CANDLES,
  closedH1CandleKeys, closedM5CandleKeys, closedM15CandleKeys, reconcileLocalComputation, reconcileRecentCandles
} from "../src/parity-sweep.mjs";
import { resetSchemaCacheForTests, ensureSchema, registerIdentity, identityOf } from "../src/parity-registry.mjs";

/** Minimal D1 adapter over node:sqlite so the registry SQL runs for real. */
function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
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

/** Map-backed KV mock (strongly consistent, unlike the production race). */
function kv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };
}

const H = (c) => c.repeat(64);
const candle = { o: 3950.1, h: 3955.2, l: 3948.0, c: 3953.4, volume: 2103 };
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const R38_FIELDS = ["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype"];
const R37_FIELDS = ["direction", "d_enc", "b_enc", "structure_subtype", "bull_event", "bear_event"];
const GMI_FIELDS = ["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"];

function webhookPayloads() {
  return {
    prophet_r38: { ...candle, direction: 1, buy_confirmed: true, sell_confirmed: false, buy_high_quality: false, sell_high_quality: false, t_enc: 2, d_enc: -1, structure_subtype: 0 },
    prophet_r37_ssot: { ...candle, direction: 1, d_enc: -1, b_enc: 2, structure_subtype: 0, bull_event: true, bear_event: false },
    gmi_v12_70: { ...candle, verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false }
  };
}

function observedRecord(engine, webhooks, timeframe = "60") {
  const comparable = engine === "prophet"
    ? { prophet_r38: pick(webhooks.prophet_r38, R38_FIELDS), prophet_r37_ssot: pick(webhooks.prophet_r37_ssot, R37_FIELDS) }
    : { gmi_v12_70: pick(webhooks.gmi_v12_70, GMI_FIELDS) };
  return {
    engine, timeframe,
    provenance: { source_hash: H({ prophet: "a", gmi: "b" }[engine]), implementation_hash: H("1") },
    values: { candle, comparable }
  };
}

/** Seeds KV the way the webhook handler and LocalComputationIngress do. */
async function seedCandle(env, candleKey, timeframe = "60") {
  await ensureSchema(env.DB);
  const hooks = webhookPayloads();
  for (const [source, payload] of Object.entries(hooks)) {
    await env.WEBHOOK_BUFFER.put("candle:" + candleKey + ":" + source, JSON.stringify(payload));
  }
  for (const engine of ["prophet", "gmi"]) {
    const record = observedRecord(engine, hooks, timeframe);
    // ingestLocalCalculation registers the identity before any reconcile runs.
    await registerIdentity(env.DB, identityOf(record));
    await env.WEBHOOK_BUFFER.put("localcalc-observed:" + candleKey + ":" + engine, JSON.stringify(record));
  }
}

test.beforeEach(() => resetSchemaCacheForTests());

test("PARITY_SWEEP_CRON is a dedicated quarter-hour schedule", () => {
  assert.equal(PARITY_SWEEP_CRON, "10-59/15 * * * *");
  assert.ok(PARITY_SWEEP_LOOKBACK_CANDLES >= 2);
});

test("closedH1CandleKeys lists the most recently closed H1 candle opens, newest first", () => {
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  assert.deepEqual(closedH1CandleKeys(now), [
    "OANDA:XAUUSD:60:1793750400000", // 00:00 open, closed at 01:00
    "OANDA:XAUUSD:60:1793746800000", // 23:00 open
    "OANDA:XAUUSD:60:1793743200000"  // 22:00 open
  ]);
  assert.deepEqual(closedH1CandleKeys(now, { lookback: 1 }), ["OANDA:XAUUSD:60:1793750400000"]);
  assert.deepEqual(closedH1CandleKeys(Date.parse("2026-11-04T01:00:00.500Z"), { lookback: 1 }), ["OANDA:XAUUSD:60:1793750400000"]);
  assert.deepEqual(closedH1CandleKeys(now, { symbol: "OANDA:XAUUSD", timeframe: "60", lookback: 0 }), []);
});

test("sweep records the parity comparison for a candle whose per-event tasks missed it", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey);

  const result = await reconcileRecentCandles(env, { now });
  assert.equal(result.candle_keys.length, PARITY_SWEEP_LOOKBACK_CANDLES);
  assert.equal(result.results[candleKey].comparisons.prophet.result, "match");
  assert.equal(result.results[candleKey].comparisons.prophet.counted, true);
  assert.equal(result.results[candleKey].comparisons.gmi.result, "match");

  const rows = env.DB.db.prepare("SELECT engine, candle_key, result FROM engine_parity_comparisons ORDER BY engine").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.candle_key === candleKey && row.result === "match"));
  const registry = env.DB.db.prepare("SELECT engine, consecutive_matches, last_candle_key FROM engine_parity_registry ORDER BY engine").all().map((row) => ({ ...row }));
  assert.deepEqual(registry, [
    { engine: "gmi", consecutive_matches: 1, last_candle_key: candleKey },
    { engine: "prophet", consecutive_matches: 1, last_candle_key: candleKey }
  ]);
});

test("sweep is idempotent: re-running does not double count a candle", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey);

  await reconcileRecentCandles(env, { now });
  const second = await reconcileRecentCandles(env, { now: now + 10 * 60 * 1000 });
  assert.equal(second.results[candleKey].comparisons.prophet.result, "match");
  assert.equal(second.results[candleKey].comparisons.prophet.counted, false);

  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM engine_parity_comparisons").get().n, 2);
  assert.equal(env.DB.db.prepare("SELECT consecutive_matches FROM engine_parity_registry WHERE engine = 'prophet'").get().consecutive_matches, 1);
});

test("sweep skips candles whose evidence never arrived, without failing the others", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey);

  const result = await reconcileRecentCandles(env, { now });
  for (const older of ["OANDA:XAUUSD:60:1793746800000", "OANDA:XAUUSD:60:1793743200000"]) {
    assert.deepEqual(result.results[older].comparisons, {});
  }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM engine_parity_comparisons").get().n, 2);
});

test("reconcileLocalComputation promotes trusted records into the trusted lane only when approved", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey);

  const first = await reconcileLocalComputation(env, candleKey);
  assert.equal(first.trust.prophet, false);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":prophet"), null);

  // Force approval through 24 consecutive matching candles, then re-reconcile.
  const base = 1793750400000;
  for (let i = 1; i < 24; i += 1) {
    const key = `OANDA:XAUUSD:60:${base - i * 3600000}`;
    await seedCandle(env, key);
    await reconcileLocalComputation(env, key);
  }
  const after = await reconcileLocalComputation(env, candleKey);
  assert.equal(after.trust.prophet, true);
  const trusted = JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":prophet"));
  assert.equal(trusted.trust_status, "approved_by_parity");
});

test("closedM5CandleKeys lists the most recently closed 5m candle opens, newest first", () => {
  const now = Date.parse("2026-11-04T01:10:30.000Z");
  assert.deepEqual(closedM5CandleKeys(now, { lookback: 3 }), [
    "OANDA:XAUUSD:5:" + Date.parse("2026-11-04T01:05:00.000Z"),
    "OANDA:XAUUSD:5:" + Date.parse("2026-11-04T01:00:00.000Z"),
    "OANDA:XAUUSD:5:" + Date.parse("2026-11-04T00:55:00.000Z")
  ]);
});

test("closedM15CandleKeys lists the most recently closed 15m candle opens; the sweep includes them", async () => {
  const now = Date.parse("2026-11-04T01:10:30.000Z");
  assert.deepEqual(closedM15CandleKeys(now), [
    "OANDA:XAUUSD:15:" + Date.parse("2026-11-04T00:45:00.000Z"),
    "OANDA:XAUUSD:15:" + Date.parse("2026-11-04T00:30:00.000Z")
  ]);
  const result = await reconcileRecentCandles({ DB: d1(), WEBHOOK_BUFFER: kv() }, { now });
  assert.deepEqual(result.m15_candle_keys, closedM15CandleKeys(now));
});

test("sweep reconciles 5m candles under timeframe-scoped ids and never touches the H1 registry rows", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const h1Key = "OANDA:XAUUSD:60:1793750400000";
  const m5Key = "OANDA:XAUUSD:5:" + Date.parse("2026-11-04T01:00:00.000Z");
  await seedCandle(env, h1Key, "60");
  await seedCandle(env, m5Key, "5");

  const result = await reconcileRecentCandles(env, { now });
  assert.ok(result.m5_candle_keys.includes(m5Key));
  assert.equal(result.results[m5Key].comparisons.prophet.result, "match");
  const registry = env.DB.db.prepare("SELECT engine, consecutive_matches, last_candle_key FROM engine_parity_registry ORDER BY engine").all().map((row) => ({ ...row }));
  assert.deepEqual(registry, [
    { engine: "gmi", consecutive_matches: 1, last_candle_key: h1Key },
    { engine: "gmi_m5", consecutive_matches: 1, last_candle_key: m5Key },
    { engine: "prophet", consecutive_matches: 1, last_candle_key: h1Key },
    { engine: "prophet_m5", consecutive_matches: 1, last_candle_key: m5Key }
  ]);
  // A 5m candle with no local record is skipped without KV writes.
  const empty = result.m5_candle_keys.find((key) => key !== m5Key);
  assert.deepEqual(result.results[empty], { comparisons: {}, trust: {} });
});

test("reconcile never deletes a trusted copy just because its observed record is not visible yet", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await env.WEBHOOK_BUFFER.put("localcalc:" + candleKey + ":gmi", JSON.stringify({ engine: "gmi", trust_status: "approved_by_parity" }));
  // Only the prophet observed record is visible to this reconcile (gmi has not propagated).
  const hooks = webhookPayloads();
  const prophet = observedRecord("prophet", hooks);
  await ensureSchema(env.DB);
  await registerIdentity(env.DB, identityOf(prophet));
  await env.WEBHOOK_BUFFER.put("localcalc-observed:" + candleKey + ":prophet", JSON.stringify(prophet));
  await reconcileLocalComputation(env, candleKey);
  assert.ok(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":gmi"), "the trusted gmi copy written by another reconcile survives");
  // A visible record whose identity is not approved does lose its trusted copy.
  await env.WEBHOOK_BUFFER.put("localcalc:" + candleKey + ":prophet", JSON.stringify({ engine: "prophet" }));
  await reconcileLocalComputation(env, candleKey);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":prophet"), null);
});

test("H4/D1 sweep keys come from the cached native bars (22:00-anchored), newest first", async () => {
  const { closedHtfCandleKeys } = await import("../src/parity-sweep.mjs");
  const bar = (openIso, hours) => ({ open_time: openIso, close_time: new Date(Date.parse(openIso) + hours * 3600_000).toISOString() });
  const store = {
    "market-data:v2:series:OANDA:XAUUSD|4h": JSON.stringify({ candles: [bar("2026-11-05T14:00:00Z", 4), bar("2026-11-05T18:00:00Z", 4), bar("2026-11-05T22:00:00Z", 4)] }),
    "market-data:v2:series:OANDA:XAUUSD|1D": JSON.stringify({ candles: [bar("2026-11-03T22:00:00Z", 24), bar("2026-11-04T22:00:00Z", 24)] })
  };
  const env = { SIGNAL_CACHE: { async get(k) { return store[k] ?? null; } } };
  const now = Date.parse("2026-11-06T01:00:00Z"); // the 22:00 H4 bar is still forming
  assert.deepEqual(await closedHtfCandleKeys(env, now), [
    `OANDA:XAUUSD:240:${Date.parse("2026-11-05T18:00:00Z")}`,
    `OANDA:XAUUSD:240:${Date.parse("2026-11-05T14:00:00Z")}`,
    `OANDA:XAUUSD:1D:${Date.parse("2026-11-04T22:00:00Z")}`,
    `OANDA:XAUUSD:1D:${Date.parse("2026-11-03T22:00:00Z")}`
  ]);
  assert.deepEqual(await closedHtfCandleKeys({}, now), [], "no cache: no keys, never guessed");
});

test("a candle whose local input bar differs never enters the trusted lane; the republished final bar does", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv(), PARITY_PROMOTE_AFTER: "1" };
  const base = 1793750400000;
  const approvedKey = `OANDA:XAUUSD:60:${base - 3600000}`;
  await seedCandle(env, approvedKey);
  await reconcileLocalComputation(env, approvedKey);

  // The local record of the next candle was built on a provisional bar (close and volume differ).
  const key = `OANDA:XAUUSD:60:${base}`;
  await seedCandle(env, key);
  for (const engine of ["prophet", "gmi"]) {
    const rec = JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc-observed:" + key + ":" + engine));
    rec.values.candle = { ...rec.values.candle, c: rec.values.candle.c + 0.33, volume: rec.values.candle.volume - 496 };
    await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":" + engine, JSON.stringify(rec));
  }
  const first = await reconcileLocalComputation(env, key);
  assert.equal(first.comparisons.prophet.result, "input_mismatch");
  assert.deepEqual([first.trust.prophet, first.trust.gmi, first.trust.mizan], [false, false, false]);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + key + ":prophet"), null);
  const status = env.DB.db.prepare("SELECT status FROM engine_parity_registry WHERE engine = 'prophet'").get().status;
  assert.equal(status, "approved", "the identity is not revoked for a bar-only difference");

  // Republished on the final bar: it matches, counts, and enters the trusted lane.
  await seedCandle(env, key);
  const second = await reconcileLocalComputation(env, key);
  assert.equal(second.comparisons.prophet.result, "match");
  assert.equal(second.comparisons.prophet.counted, true);
  assert.equal(second.trust.prophet, true);
  assert.ok(await env.WEBHOOK_BUFFER.get("localcalc:" + key + ":prophet"));
});

test("gmi_hud (Grid Bot comparator) is compared and approved apart; it never enters or blocks the decision lane", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const HUD = { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false, cshi_viability: 64, deploy_status: 3, muddy_waters: false, grid_viable: true };
  const hudRecord = { engine: "gmi_hud", timeframe: "60", provenance: { source_hash: H("c"), implementation_hash: H("2") }, values: { candle, comparable: { gmi_v12_70_hud: HUD } } };
  const seedHud = async (key, webhook) => {
    await seedCandle(env, key);
    if (webhook) await env.WEBHOOK_BUFFER.put("candle:" + key + ":gmi_v12_70_hud", JSON.stringify(webhook));
    await registerIdentity(env.DB, identityOf(hudRecord));
    await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":gmi_hud", JSON.stringify(hudRecord));
  };
  const base = 1793750400000;
  // Without the candidate alert there is nothing to compare against.
  await seedHud(`OANDA:XAUUSD:60:${base}`, null);
  const none = await reconcileLocalComputation(env, `OANDA:XAUUSD:60:${base}`);
  assert.equal(none.comparisons.gmi_hud.result, "not_comparable");
  assert.equal(none.trust.gmi_hud, false);

  for (let i = 23; i >= 0; i -= 1) {
    const key = `OANDA:XAUUSD:60:${base - i * 3600000}`;
    await seedHud(key, { ...HUD });
    await reconcileLocalComputation(env, key);
  }
  const key = `OANDA:XAUUSD:60:${base}`;
  const after = await reconcileLocalComputation(env, key);
  assert.equal(after.trust.gmi_hud, true, "24 matching candles approve the HUD identity");
  assert.equal(JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + key + ":gmi_hud")).trust_status, "approved_by_parity");

  // A Grid Bot mismatch revokes gmi_hud only: the approved gmi identity and its trusted copy stay.
  const next = `OANDA:XAUUSD:60:${base + 3600000}`;
  await seedHud(next, { ...HUD, deploy_status: 2 });
  const out = await reconcileLocalComputation(env, next);
  assert.equal(out.comparisons.gmi_hud.result, "mismatch");
  assert.equal(out.trust.gmi_hud, false);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + next + ":gmi_hud"), null);
  assert.equal(out.trust.gmi, true);
  assert.equal(out.trust.prophet, true);
});
