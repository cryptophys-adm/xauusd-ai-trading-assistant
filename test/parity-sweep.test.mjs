import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  PARITY_SWEEP_CRON, PARITY_SWEEP_LOOKBACK_CANDLES,
  closedH1CandleKeys, closedM5CandleKeys, closedM15CandleKeys, reconcileLocalComputation, reconcileRecentCandles
} from "../src/parity-sweep.mjs";
import { resetSchemaCacheForTests, ensureSchema, registerIdentity, identityOf, scopedEngine } from "../src/parity-registry.mjs";
import { TRUSTED_IDENTITIES } from "../src/trusted-identities.mjs";

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

// Since parity removal S1 (owner 2026-11-26) trust is the frozen table (src/trusted-identities.mjs): a record
// with the frozen identity of its chart is trusted at once, one with synthetic hashes never is, whatever
// the registry approves.
function frozenProvenance(engine, timeframe) {
  const t = TRUSTED_IDENTITIES.find((x) => x.engine === scopedEngine(engine, timeframe));
  return { source_hash: t.source_hash, implementation_hash: t.implementation_hash, dependencies: { mizan: t.mizan } };
}

function observedRecord(engine, webhooks, timeframe = "60", { trusted = false } = {}) {
  const comparable = engine === "prophet"
    ? { prophet_r38: pick(webhooks.prophet_r38, R38_FIELDS), prophet_r37_ssot: pick(webhooks.prophet_r37_ssot, R37_FIELDS) }
    : { gmi_v12_70: pick(webhooks.gmi_v12_70, GMI_FIELDS) };
  return {
    engine, timeframe,
    provenance: trusted ? frozenProvenance(engine, timeframe) : { source_hash: H({ prophet: "a", gmi: "b" }[engine]), implementation_hash: H("1") },
    values: { candle, comparable }
  };
}

/** Seeds KV the way the webhook handler and LocalComputationIngress do. */
async function seedCandle(env, candleKey, timeframe = "60", { trusted = false } = {}) {
  await ensureSchema(env.DB);
  const hooks = webhookPayloads();
  for (const [source, payload] of Object.entries(hooks)) {
    await env.WEBHOOK_BUFFER.put("candle:" + candleKey + ":" + source, JSON.stringify(payload));
  }
  for (const engine of ["prophet", "gmi"]) {
    const record = observedRecord(engine, hooks, timeframe, { trusted });
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

// Parity removal S2: the sweep refreshes the trusted lane from the frozen table and compares nothing.
const counts = (env) => ({
  comparisons: env.DB.db.prepare("SELECT COUNT(*) AS n FROM engine_parity_comparisons").get().n,
  registry: env.DB.db.prepare("SELECT COUNT(*) AS n FROM engine_parity_registry").get().n
});

test("S2: the sweep refreshes the trusted lane of a candle its per-event task missed, and writes no comparison", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey, "60", { trusted: true });
  const before = counts(env);
  const result = await reconcileRecentCandles(env, { now });
  assert.equal(result.candle_keys.length, PARITY_SWEEP_LOOKBACK_CANDLES);
  assert.deepEqual(result.results[candleKey].comparisons, {});
  assert.deepEqual([result.results[candleKey].trust.prophet, result.results[candleKey].trust.gmi, result.results[candleKey].trust.mizan], [true, true, false], "mizan published nothing for this candle");
  assert.equal(JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":prophet")).trust_status, "approved_by_parity");
  assert.deepEqual(counts(env), { ...before, comparisons: 0 }, "no comparison row, no registry change");
  assert.equal(result.intrabar_recheck, undefined, "the intrabar recheck is gone with the comparisons");
});

test("S2: the sweep is idempotent: a re-run writes the same trusted copies", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey, "60", { trusted: true });
  await reconcileRecentCandles(env, { now });
  const first = await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":gmi");
  const second = await reconcileRecentCandles(env, { now: now + 10 * 60 * 1000 });
  assert.equal(second.results[candleKey].trust.gmi, true);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":gmi"), first);
  assert.equal(counts(env).comparisons, 0);
});

test("sweep skips candles whose evidence never arrived, without failing the others", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey, "60", { trusted: true });
  const result = await reconcileRecentCandles(env, { now });
  for (const older of ["OANDA:XAUUSD:60:1793746800000", "OANDA:XAUUSD:60:1793743200000"]) {
    assert.deepEqual(result.results[older], { comparisons: {}, trust: {} });
  }
  assert.equal(result.results[candleKey].trust.prophet, true);
});

test("reconcileLocalComputation puts records into the trusted lane only for a frozen identity; a synthetic identity never, whatever the registry holds", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey);
  env.DB.db.prepare("UPDATE engine_parity_registry SET status = 'approved'").run();
  const synthetic = await reconcileLocalComputation(env, candleKey);
  assert.deepEqual([synthetic.trust.prophet, synthetic.trust.gmi], [false, false]);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":prophet"), null);
  const frozenKey = "OANDA:XAUUSD:60:" + (1793750400000 + 3600000);
  await seedCandle(env, frozenKey, "60", { trusted: true });
  const frozen = await reconcileLocalComputation(env, frozenKey);
  assert.deepEqual([frozen.trust.prophet, frozen.trust.gmi], [true, true]);
  assert.equal(JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + frozenKey + ":prophet")).trust_status, "approved_by_parity");
  assert.equal(counts(env).comparisons, 0);
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

test("the sweep refreshes 5m candles under timeframe-scoped identities: a frozen 5m identity is trusted, an H1 identity on a 5m record is not", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const now = Date.parse("2026-11-04T01:10:00.000Z");
  const h1Key = "OANDA:XAUUSD:60:1793750400000";
  const m5Key = "OANDA:XAUUSD:5:" + Date.parse("2026-11-04T01:00:00.000Z");
  await seedCandle(env, h1Key, "60", { trusted: true });
  await seedCandle(env, m5Key, "5", { trusted: true });
  const result = await reconcileRecentCandles(env, { now });
  assert.ok(result.m5_candle_keys.includes(m5Key));
  assert.deepEqual([result.results[m5Key].trust.prophet, result.results[m5Key].trust.gmi], [true, true]);
  // The H1 identities' hashes on a 5m record are not the 5m identities.
  for (const engine of ["prophet", "gmi"]) {
    const k = "localcalc-observed:" + m5Key + ":" + engine;
    const rec = JSON.parse(await env.WEBHOOK_BUFFER.get(k));
    rec.provenance = frozenProvenance(engine, "60");
    await env.WEBHOOK_BUFFER.put(k, JSON.stringify(rec));
  }
  const again = await reconcileLocalComputation(env, m5Key);
  assert.deepEqual([again.trust.prophet, again.trust.gmi], [false, false]);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + m5Key + ":prophet"), null);
  const empty = result.m5_candle_keys.find((key) => key !== m5Key);
  assert.deepEqual(result.results[empty], { comparisons: {}, trust: {} });
  assert.equal(counts(env).comparisons, 0);
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

test("S2: with no comparison, a record built on a provisional bar enters the trusted lane, and its republished final bar replaces it", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const key = `OANDA:XAUUSD:60:1793750400000`;
  await seedCandle(env, key, "60", { trusted: true });
  for (const engine of ["prophet", "gmi"]) {
    const rec = JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc-observed:" + key + ":" + engine));
    rec.values.candle = { ...rec.values.candle, c: rec.values.candle.c + 0.33, volume: rec.values.candle.volume - 496 };
    await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":" + engine, JSON.stringify(rec));
  }
  const first = await reconcileLocalComputation(env, key);
  assert.deepEqual(first.comparisons, {}, "no input-bar check: it needs TradingView's bar");
  assert.equal(first.trust.prophet, true);
  assert.equal(JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + key + ":prophet")).values.candle.volume, 2103 - 496);
  // The pull adapter republishes the final bar; the next reconcile copies it.
  await seedCandle(env, key, "60", { trusted: true });
  await reconcileLocalComputation(env, key);
  assert.equal(JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + key + ":prophet")).values.candle.volume, 2103);
});

test("S4: a leftover gmi_hud record (the retired Grid Bot comparator) is not read; the decision lane is untouched and its keys expire by TTL", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const HUD = { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false, cshi_viability: 64, deploy_status: 3, muddy_waters: false, grid_viable: true };
  const hudRecord = { engine: "gmi_hud", timeframe: "60", provenance: { source_hash: H("c"), implementation_hash: H("2") }, values: { candle, comparable: { gmi_v12_70_hud: HUD } } };
  const key = `OANDA:XAUUSD:60:1793750400000`;
  await seedCandle(env, key, "60", { trusted: true });
  await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":gmi_hud", JSON.stringify(hudRecord));
  const out = await reconcileLocalComputation(env, key);
  assert.equal("gmi_hud" in out.trust, false, "only the decision engines are read");
  assert.deepEqual([out.trust.prophet, out.trust.gmi], [true, true]);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + key + ":gmi_hud"), null, "no copy is ever written for it");
  assert.ok(await env.WEBHOOK_BUFFER.get("localcalc-observed:" + key + ":gmi_hud"), "the leftover observed key is left to its 14-day TTL, not deleted");
  assert.equal(counts(env).comparisons, 0);
  // Alone, a leftover record is not a candle the reconcile acts on.
  const lone = { DB: d1(), WEBHOOK_BUFFER: kv() };
  await lone.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":gmi_hud", JSON.stringify(hudRecord));
  assert.deepEqual(await reconcileLocalComputation(lone, key), { comparisons: {}, trust: {} });
});

test("decisionLocalRecords: the approved copy where it exists, else the observed record labelled not_parity_approved", async () => {
  const { decisionLocalRecords, NOT_PARITY_APPROVED } = await import("../src/parity-sweep.mjs");
  const env = { WEBHOOK_BUFFER: kv() };
  const key = "OANDA:XAUUSD:60:1762250400000";
  await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":prophet", JSON.stringify({ engine: "prophet", trust_status: "approved_by_parity" }));
  await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":prophet", JSON.stringify({ engine: "prophet" }));
  await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":gmi", JSON.stringify({ engine: "gmi" }));
  const records = await decisionLocalRecords(env, key);
  assert.deepEqual(records.map((r) => [r.engine, r.trust_status]), [["prophet", "approved_by_parity"], ["gmi", NOT_PARITY_APPROVED]], "mizan published nothing, so it is absent");
  assert.deepEqual(await decisionLocalRecords({}, key), []);
});

test("a record built on the MT5 fallback feed keeps its trust (frozen identity) and is compared with nothing", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const candleKey = "OANDA:XAUUSD:60:1793750400000";
  await seedCandle(env, candleKey, "60", { trusted: true });
  for (const engine of ["prophet", "gmi"]) {
    const k = "localcalc-observed:" + candleKey + ":" + engine;
    await env.WEBHOOK_BUFFER.put(k, JSON.stringify({ ...JSON.parse(await env.WEBHOOK_BUFFER.get(k)), feed: "mt5_fallback" }));
  }
  const r = await reconcileLocalComputation(env, candleKey);
  assert.equal(r.trust.prophet, true, "as before S2: a fallback record of a trusted identity enters the lane");
  assert.deepEqual(r.comparisons, {});
  assert.equal(counts(env).comparisons, 0, "no comparison recorded");
  assert.equal(JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":prophet")).feed, "mt5_fallback");
});

test("S2 ruling 1: an input-mismatch candle on a native bar enters the lane and its bars read verified; a fallback candle enters the lane but its bars do not (the 15m cap stays)", async () => {
  const { barsVerified } = await import("../src/hud-store.mjs");
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const native = "OANDA:XAUUSD:15:1793750400000";
  const fallback = "OANDA:XAUUSD:15:1793751300000";
  for (const [key, feed] of [[native, null], [fallback, "mt5_fallback"]]) {
    await seedCandle(env, key, "15", { trusted: true });
    for (const engine of ["prophet", "gmi"]) {
      const k = "localcalc-observed:" + key + ":" + engine;
      const rec = JSON.parse(await env.WEBHOOK_BUFFER.get(k));
      rec.values.candle = { ...rec.values.candle, c: rec.values.candle.c + 0.33 }; // differs from the webhook bar
      if (feed) rec.feed = feed;
      await env.WEBHOOK_BUFFER.put(k, JSON.stringify(rec));
    }
    const r = await reconcileLocalComputation(env, key);
    assert.deepEqual([r.trust.prophet, r.trust.gmi], [true, true], key);
  }
  assert.equal(await barsVerified(env, native), true, "native bar: verified, the 0.4 cap lifts for bar formulas");
  assert.equal(await barsVerified(env, fallback), false, "MT5 fallback bar: not verified, the 0.4 cap stays");
});
