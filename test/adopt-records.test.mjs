// B11a (Track B; RFC_INDICATOR_ADOPTION stages 1, 2 and 6; owner 2026-11-19 "adopsi semuanya", 2026-11-22 (a)-(c)): the
// Prophet adoption record. The pull adapter builds it (adopt/prophet-adopt.mjs) and the AI Worker ingests it for group
// parity only (prophet_adopt_hud/core/ob/scalp/plan against the v2 alert). Nothing reads it. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { calculateProphetR38Core } from "../local-engines/prophet-r38/src/core.mjs";
import { obZoneSeries, prophetAdoptValues, momentumCode, buildProphetAdopt, buildProphetAdoptRecord, PROPHET_ADOPT_FIELDS, PROPHET_ADOPT_SOURCE } from "../local-engines/producer/src/adopt/prophet-adopt.mjs";
import { ENGINE_PROVENANCE } from "../local-engines/producer/src/provenance.generated.mjs";
import { chartProphetCore, chartProphetSetup, attachProphetSetup, prophetSetupState, SETUP_CHARTS } from "../local-engines/producer/src/prophet-setup.mjs";
import { PARITY_GROUPS, groupsFor, groupIdentityOf, identityOf, resetSchemaCacheForTests } from "../src/parity-registry.mjs";
import { ADOPT_ENGINES, INGEST_ENGINES, validateLocalCalculation, adoptIngest } from "../src/evidence-fusion.mjs";
import { reconcileLocalComputation, pruneAdoptComparisons, ADOPT_PRUNE_MAX_ROWS } from "../src/parity-sweep.mjs";
import { approvedComparable, barsVerified } from "../src/hud-store.mjs";
import { publishAdoptRecords, ADOPT_PUBLISHED_PREFIX } from "../market-data-ingestion/src/local-publisher.mjs";
import { ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { d1, kv } from "./support/webhook-harness.mjs";

const ROOT = new URL("../", import.meta.url);
const M15 = 15 * 60_000, H = 3_600_000;

/** A seeded OHLCV walk of `n` bars of `minutes`, ending with a bar that closed at `endMs`. */
function walk(seed, n, minutes, endMs) {
  let s = seed >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const out = [], step = minutes * 60_000;
  let c = 3900, t = endMs - n * step;
  for (let i = 0; i < n; i++) {
    const o = c; c = o + (r() - 0.5) * 6 * Math.sqrt(minutes / 60) + Math.sin(i / 40) * 1.2;
    const h = Math.max(o, c) + r() * 3, l = Math.min(o, c) - r() * 3;
    out.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + step).toISOString(), open: o, high: h, low: l, close: c, volume: 50 + Math.floor(r() * 400) });
    t += step;
  }
  return out;
}
/** A bundle whose every chart's last bar closed at or before `now`. */
function bundleAt(now, seed = 7) {
  const at = (ms) => Math.floor(now / ms) * ms;
  return {
    timeframes: {
      M15: { candles: walk(seed, 1000, 15, at(M15)) }, H1: { candles: walk(seed + 1, 1000, 60, at(H)) },
      H4: { candles: walk(seed + 2, 600, 240, at(4 * H)) }, D1: { candles: walk(seed + 3, 300, 1440, at(24 * H)) }, W1: { candles: walk(seed + 4, 120, 10080, at(7 * 24 * H)) }
    }
  };
}
const coreOf = (series, minutes = 60) => calculateProphetR38Core(series.map((b) => ({ ...b, confirmed: true })), { timeframe_minutes: minutes, gmi_closed_only: true, mintick: 0.001 });

test("AD-1 the OB zone lifecycle duplicate equals the core's: at the last bar its zones are active_order_block_zones, on 12 seeds and 3 charts", () => {
  for (const [minutes, seeds] of [[15, [1, 2, 3, 4]], [60, [5, 6, 7, 8]], [240, [9, 10, 11, 12]]]) {
    for (const seed of seeds) {
      const series = walk(seed, 1000, minutes, Date.parse("2026-11-20T00:00:00Z")).map((b) => ({ ...b, confirmed: true }));
      const r = coreOf(series, minutes);
      const core = r.outputs.at(-1).order_blocks.active_order_block_zones.map((z) => ({ dir: z.dir, top: z.top, bottom: z.bottom, born: z.born, highVolume: z.highVolume }));
      const mine = obZoneSeries(series, { atr: r.outputs.map((o) => o.sensors.atr14), er: r.outputs.map((o) => o.sensors.efficiency_ratio_14), mintick: 0.001 }).at(-1);
      assert.deepEqual(mine, core, `${minutes}m seed ${seed}`);
    }
  }
});

test("AD-2 the values: every alert field, the core's own numbers where it has them, the alert's codes, the no-position constants", () => {
  const series = walk(3, 1000, 60, Date.parse("2026-11-20T00:00:00Z")).map((b) => ({ ...b, confirmed: true }));
  const r = coreOf(series), o = r.outputs.at(-1);
  const v = prophetAdoptValues(series, r.outputs).comparable;
  assert.deepEqual(Object.keys(v), [...PROPHET_ADOPT_FIELDS]);
  // Every group's fields are in the record (the groups compare exactly these).
  for (const id of groupsFor("prophet_adopt")) for (const f of Object.keys(PARITY_GROUPS[id].fields)) assert.ok(f in v, `${id}.${f}`);
  const r8 = (x) => Math.round(x * 1e8) / 1e8;
  assert.equal(v.pro_fast, r8(o.oscillator.fast));
  assert.equal(v.er, r8(o.sensors.efficiency_ratio_14));
  assert.equal(v.ob_bull_n, o.order_blocks.active_bull_ob_count);
  assert.equal(v.buy_ready, o.order_blocks.buy_trade_ready ? 1 : 0);
  assert.ok([0, 1, 2, 3].includes(v.cshi_tier));
  assert.ok([-3, -2, -1, 0, 1, 2, 3].includes(v.ob_filter));
  assert.ok([0, 11, 12, 13, 14, 15, 16, 17, 18].includes(v.exit_code), "the no-position branch of the exit reason");
  assert.deepEqual([v.pos, v.entry_ok, v.tp_struct, v.tp_reached, v.reversal, v.mom_weak], [0, 0, null, 0, 0, 0], "the manual position inputs at their defaults");
  assert.ok([-1, 0, 1].includes(v.tk_dir));
  if (v.tk_dir === 0) assert.equal(v.tk_latched, null, "no TARGET KEY without a bias");
  for (const [k, x] of Object.entries(v)) assert.ok(x === null || Number.isFinite(x), `${k} is a number or null`);
  // The momentum codes (Pine 604).
  assert.deepEqual([momentumCode(1, 0, 0.1), momentumCode(1, 0, -0.1), momentumCode(-1, 0, -0.1), momentumCode(-1, 0, 0.1), momentumCode(0, 0, 0.1), momentumCode(1, 0, null)], [2, 1, -2, -1, 0, null]);
});

test("AD-3 the record: a valid local calculation, engine prophet_adopt, its own identity, every prophet_adopt group with an identity per chart", () => {
  const now = Date.now();
  const bundle = bundleAt(now);
  for (const [chart, tf, suffix] of [["M15", "15", "_m15"], ["H1", "60", ""], ["H4", "240", "_h4"], ["D1", "1D", "_d1"]]) {
    const rec = buildProphetAdoptRecord(bundle, chart, { now });
    assert.equal(rec.engine, "prophet_adopt");
    assert.equal(rec.timeframe, tf);
    assert.equal(rec.candle_key, `OANDA:XAUUSD:${tf}:${Date.parse(bundle.timeframes[chart].candles.at(-1).open_time)}`);
    assert.deepEqual(Object.keys(rec.values.comparable), [PROPHET_ADOPT_SOURCE]);
    assert.equal(rec.provenance.implementation_hash, ENGINE_PROVENANCE.prophet_adopt.implementation_hash);
    assert.deepEqual(validateLocalCalculation(rec, { symbol: rec.symbol, timeframe: rec.timeframe, candle_key: rec.candle_key, candle_time: rec.candle_time, now }).errors, [], chart);
    assert.equal(identityOf(rec).engine, "prophet_adopt" + suffix);
    for (const id of groupsFor("prophet_adopt")) assert.equal(groupIdentityOf(rec, id).engine, id + suffix);
  }
  assert.equal(buildProphetAdopt({ timeframes: {} }, "H1"), null);
  assert.throws(() => buildProphetAdopt(bundle, "M5"), { code: "unsupported_chart" });
});

/** The AI Worker bundled as wrangler does, with its named exports (the RPC entrypoints). */
async function loadWorkerModule() {
  const out = await build({ entryPoints: [new URL("src/index.ts", ROOT).pathname], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", alias: { "cloudflare:workers": new URL("test/support/cloudflare-workers-stub.mjs", ROOT).pathname } });
  const dir = mkdtempSync(join(tmpdir(), "adopt-worker-")), file = join(dir, "worker.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}
const mod = await loadWorkerModule();
async function workerEnv(extra = {}) {
  const sent = [];
  return { sent, env: { DB: await d1(), WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv(), XAUUSD_EVENTS: { async send(b) { sent.push(b); }, async sendBatch(l) { sent.push(...l.map((m) => m.body)); } }, INDICATOR_SOURCE: "local", ANALYSIS_TIMEFRAMES: "60", ...extra } };
}
function freshRecord(chart = "M15") {
  const now = Date.now();
  return buildProphetAdoptRecord(bundleAt(now), chart, { now });
}

test("AD-4 ingest: accepted for group parity, stored as observed, no engine-level identity; ADOPT_INGEST off refuses it with a 200 and writes nothing", async () => {
  resetSchemaCacheForTests();
  const rec = freshRecord("M15");
  const { env, sent } = await workerEnv();
  const res = await new mod.LocalComputationIngress({}, env).submit(rec);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.ok(env.WEBHOOK_BUFFER.map.has(`localcalc-observed:${rec.candle_key}:prophet_adopt`));
  assert.deepEqual(env.DB.db.prepare("SELECT engine FROM engine_parity_registry").all(), [], "group identities register at their first comparison, the engine never");
  assert.equal(sent.length, 1);
  const off = await workerEnv({ ADOPT_INGEST: "off" });
  const r2 = await new mod.LocalComputationIngress({}, off.env).submit(rec);
  assert.deepEqual([r2.status, r2.body.status], [200, "adopt_ingest_off"]);
  assert.equal(off.env.WEBHOOK_BUFFER.map.size, 0);
  assert.equal(off.sent.length, 0);
  assert.deepEqual([adoptIngest({}), adoptIngest({ ADOPT_INGEST: " OFF " }), adoptIngest({ ADOPT_INGEST: "x" })], ["on", "off", "on"]);
  assert.ok(INGEST_ENGINES.includes("prophet_adopt") && ADOPT_ENGINES.includes("gmi_adopt"));
});

test("AD-5 reconcile (S2): an adoption record is compared with nothing and gets no trusted copy, alert or not", async () => {
  resetSchemaCacheForTests();
  const rec = freshRecord("M15");
  const env = { DB: await d1(), WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv() };
  await env.WEBHOOK_BUFFER.put(`localcalc-observed:${rec.candle_key}:prophet_adopt`, JSON.stringify(rec));
  const c = rec.values.candle;
  const alert = { source: PROPHET_ADOPT_SOURCE, o: c.o, h: c.h, l: c.l, c: c.c, volume: c.volume, ...rec.values.comparable[PROPHET_ADOPT_SOURCE] };
  await env.WEBHOOK_BUFFER.put(`candle:${rec.candle_key}:${PROPHET_ADOPT_SOURCE}`, JSON.stringify(alert));
  const r = await reconcileLocalComputation(env, rec.candle_key);
  assert.deepEqual(r, { comparisons: {}, trust: {} }, "no engine or group comparison (parity removal S2)");
  assert.equal(r.groups, undefined);
  assert.equal([...env.WEBHOOK_BUFFER.map.keys()].filter((k) => k.startsWith("localcalc:")).length, 0);
  assert.ok(groupsFor("prophet_adopt").length > 0, "the groups are still declared (retired in S4)");
});

test("AD-6 knock-ons: the HUD store never reads an adoption group and its rows never vouch for a candle's bars; an adoption reconcile never starts the analysis path", async () => {
  // (i) approvedComparable: the same KV reads as main (prophet, gmi, gmi_hud), whatever is trusted for the adopt groups.
  const store = kv();
  let gets = 0; const counting = { ...store, async get(k) { gets += 1; return store.get(k); } };
  await store.put("localcalc:K:prophet_adopt_hud", JSON.stringify({ values: { comparable: { [PROPHET_ADOPT_SOURCE]: { cshi: 0.5 } } } }));
  assert.equal(await approvedComparable({ WEBHOOK_BUFFER: counting }, "K"), null);
  assert.equal(gets, 3);
  // barsVerified (S2): an adoption group's copy never verifies the bars; only a decision engine's trusted copy does.
  const bars = kv();
  await bars.put("localcalc:K:prophet_adopt_hud", JSON.stringify({ trust_status: "approved_by_parity" }));
  assert.equal(await barsVerified({ WEBHOOK_BUFFER: bars }, "K"), false);
  await bars.put("localcalc:K:gmi", JSON.stringify({ trust_status: "approved_by_parity" }));
  assert.equal(await barsVerified({ WEBHOOK_BUFFER: bars }, "K"), true);
  // (ii) the queue: an adoption record's reconcile task returns before the analysis path (source check).
  const idx = readFileSync(new URL("src/index.ts", ROOT), "utf8");
  const body = idx.slice(idx.indexOf("async function processLocalCalculationReconcileTask"), idx.indexOf("async function processLocalCalculationReconcileTask") + 600);
  assert.match(body, /await reconcileLocalComputation\(env, task\.candle_key\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(ADOPT_ENGINES\.includes\(asText\(\(task as \{ engine\?: unknown \}\)\.engine\)\)\) return;/);
});

test("AD-7 the prune: adoption rows older than 30 days only, at most 2,000 a sweep, other engines untouched", async () => {
  const db = await d1();
  db.db.exec("CREATE TABLE IF NOT EXISTS engine_parity_comparisons (engine TEXT, source_hash TEXT, implementation_hash TEXT, candle_key TEXT, result TEXT, detail TEXT, compared_at TEXT)");
  const now = Date.parse("2026-12-30T00:00:00Z"), old = new Date(now - 31 * 86_400_000).toISOString(), recent = new Date(now - 29 * 86_400_000).toISOString();
  const ins = db.db.prepare("INSERT INTO engine_parity_comparisons VALUES (?, 'a', 'b', ?, 'match', NULL, ?)");
  for (let i = 0; i < 2100; i++) ins.run("prophet_adopt_hud_m15", "old" + i, old);
  for (let i = 0; i < 10; i++) { ins.run("prophet_adopt_ob", "new" + i, recent); ins.run("gmi_m15", "g" + i, old); ins.run("gmi_adoptx", "x" + i, old); }
  assert.equal(await pruneAdoptComparisons({ DB: db }, { now }), ADOPT_PRUNE_MAX_ROWS);
  assert.equal(await pruneAdoptComparisons({ DB: db }, { now }), 100);
  assert.equal(await pruneAdoptComparisons({ DB: db }, { now }), 0);
  const left = Object.fromEntries(db.db.prepare("SELECT engine, COUNT(*) AS n FROM engine_parity_comparisons GROUP BY engine").all().map((r) => [r.engine, r.n]));
  assert.deepEqual(left, { gmi_adoptx: 10, gmi_m15: 10, prophet_adopt_ob: 10 });
  assert.equal(await pruneAdoptComparisons({}, { now }), 0);
});

test("AD-8 the publisher: the switch, reuse only (no core of its own), one build per bar (the marker first), the marker only on success", async () => {
  const now = Date.parse("2026-11-26T10:07:00Z");
  const bundle = bundleAt(now);
  const posted = [];
  const env = { MARKET_DATA_CACHE: kv(), PROPHET_ADOPT_PUBLISH: "true", AI_WORKER: { async submit(r) { posted.push(r); return { status: 202, body: { trust_status: "candidate_pending_parity" } }; } } };
  assert.deepEqual(await publishAdoptRecords({ ...env, PROPHET_ADOPT_PUBLISH: "false" }, { now, bundle }), { status: "adopt_publish_disabled" });
  // No publisher ran the chart's core this tick: nothing is built (an adoption build never runs a core of its own).
  const t0 = await publishAdoptRecords(env, { now, bundle });
  assert.equal(t0.builds, 0);
  assert.deepEqual(Object.values(t0.charts).map((r) => r.status), ["waiting_for_core", "waiting_for_core", "waiting_for_core", "waiting_for_core"]);
  // The setup states ran (as the local publishers do for each chart they publish): every chart is built from that run.
  chartProphetCore(bundle, "M15"); chartProphetCore(bundle, "H1");
  const t1 = await publishAdoptRecords(env, { now, bundle });
  assert.deepEqual(Object.values(t1.charts).map((r) => r.status), ["published", "published", "waiting_for_core", "waiting_for_core"]);
  chartProphetCore(bundle, "H4"); chartProphetCore(bundle, "D1");
  const t2 = await publishAdoptRecords(env, { now: now + 60_000, bundle });
  assert.deepEqual(Object.values(t2.charts).map((r) => r.status), ["already_published", "already_published", "published", "published"]);
  const t3 = await publishAdoptRecords(env, { now: now + 120_000, bundle });
  assert.equal(t3.builds, 0);
  assert.deepEqual(posted.map((r) => r.timeframe), ["15", "60", "240", "1D"]);
  assert.ok([...env.MARKET_DATA_CACHE.map.keys()].every((k) => k.startsWith(ADOPT_PUBLISHED_PREFIX + "prophet_adopt:")));
  // A rejected post leaves no marker, so the bar is tried again.
  const rej = { ...env, MARKET_DATA_CACHE: kv(), AI_WORKER: { async submit() { return { status: 400, body: { error: "x" } }; } } };
  const r1 = await publishAdoptRecords(rej, { now, bundle });
  assert.equal(r1.charts["prophet_adopt:M15"].status, "rejected");
  assert.equal(rej.MARKET_DATA_CACHE.map.size, 0);
  // A stale bar is not published.
  const late = await publishAdoptRecords({ ...env, MARKET_DATA_CACHE: kv() }, { now: now + 31 * 60_000, bundle });
  assert.equal(late.charts["prophet_adopt:M15"].status, "no_fresh_close");
  // The setup state reads the same run: one core per bundle and chart, and the state is unchanged.
  assert.deepEqual(chartProphetSetup(bundle, "H1"), chartProphetSetup(bundleAt(now), "H1"));
});

test("AD-12 the memo changes nothing the publishers post: each chart's attached setup state equals the one from an unshared core run, byte for byte", () => {
  const now = Date.parse("2026-11-26T10:07:00Z");
  const bundle = bundleAt(now), fresh = bundleAt(now);
  for (const chart of ["H1", "M15", "H4", "D1"]) {
    const spec = SETUP_CHARTS[chart], series = fresh.timeframes[spec.series].candles.slice(-spec.window);
    const key = `OANDA:XAUUSD:${spec.period}:${Date.parse(series.at(-1).open_time)}`;
    const r = calculateProphetR38Core(series.map((b) => ({ ...b, confirmed: true })), { timeframe_minutes: spec.minutes, gmi_closed_only: true, mintick: 0.001, higher_timeframes: { M15: fresh.timeframes.M15.candles, H1: spec.h1_from_slice ? series : fresh.timeframes.H1.candles, H4: fresh.timeframes.H4.candles, D1: fresh.timeframes.D1.candles, W1: fresh.timeframes.W1.candles } });
    const unshared = prophetSetupState(r.outputs);
    // The publisher's record, built twice on the same bundle (the second reads the memo) and once on a new bundle.
    const post = (b) => { const built = { candle_key: key, records: [{ engine: "prophet", values: { comparable: {} } }] }; attachProphetSetup(built, b, { chart }); return JSON.stringify(built); };
    const first = post(bundle), second = post(bundle), other = post(fresh);
    assert.equal(first, second, `${chart}: the memoised run posts the same record`);
    assert.equal(first, other, `${chart}: as a new bundle's`);
    assert.deepEqual(JSON.parse(first).records[0].values.setup, JSON.parse(JSON.stringify(unshared)), `${chart}: as an unshared core run's`);
  }
});

test("AD-9 no reader: no AI Worker module, Omega or Nexus reads an adoption record (only ingest, parity, the HUD store's exclusion and the names)", () => {
  const allowed = new Set(["evidence-fusion.mjs", "evidence-fusion.d.mts", "parity-registry.mjs", "parity-sweep.mjs", "hud-store.mjs", "engine-names.mjs", "index.ts", "knowledge-base.generated.mjs", "feature-switches.mjs", "trusted-identities.mjs"]);
  for (const f of readdirSync(new URL("src/", ROOT))) {
    if (!/\.(mjs|ts|mts)$/.test(f) || allowed.has(f)) continue;
    const text = readFileSync(new URL("src/" + f, ROOT), "utf8");
    assert.doesNotMatch(text, /prophet_adopt|gmi_adopt|ADOPT_ENGINES/, f);
  }
  const idx = readFileSync(new URL("src/index.ts", ROOT), "utf8");
  assert.deepEqual([...idx.matchAll(/ADOPT_ENGINES|adoptIngest/g)].length, 5, "the import, the ingest gate and switch, and the reconcile task's early return");
  for (const f of ["workers/xauusd-omega/src/omega.mjs", "workers/xauusd-omega/src/index.mjs"]) assert.doesNotMatch(readFileSync(new URL(f, ROOT), "utf8"), /prophet_adopt|gmi_adopt/, f);
});

test("AD-10 CPU: an adoption build reuses the tick's core run (no core of its own) and costs a fraction of a bare core run (median of 3)", () => {
  const now = Date.parse("2026-11-26T10:07:00Z");
  const bundle = bundleAt(now);
  const series = bundle.timeframes.H1.candles.slice(-1000);
  assert.equal(buildProphetAdopt(bundle, "H1", { reuseOnly: true }), null, "reuse only: without this tick's core run nothing is built");
  chartProphetCore(bundle, "H1");
  const time = (f) => { const ts = []; for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); ts.push(performance.now() - t0); } return ts.sort((a, b) => a - b)[1]; };
  const core = time(() => coreOf(series));
  const adopt = time(() => buildProphetAdopt(bundle, "H1", { reuseOnly: true }));
  assert.ok(adopt <= Math.max(40, core * 0.5), `adopt ${adopt.toFixed(1)} ms vs a bare core ${core.toFixed(1)} ms`);
});

test("AD-11 the hashes: V14 and ENGINE_CODE_HASH unchanged (no Omega or Position Manager module changed); no hashed local-engine file edited", async () => {
  assert.equal(createHash("sha256").update(engineBehaviourSource()).digest("hex"), ENGINE_BEHAVIOUR_HASH);
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(ENGINE_CODE_HASH, "4dcd1ac934afa5703fb5f0a9b58becf2f812ecbca44640d447b89f44047e47df");
  for (const id of ["prophet", "gmi", "gmi_hud", "prophet_m15", "prophet_h4", "prophet_d1"]) {
    for (const f of ENGINE_PROVENANCE[id].files.implementation) assert.equal(createHash("sha256").update(readFileSync(new URL(f.path, ROOT))).digest("hex"), f.sha256, `${id}: ${f.path}`);
  }
});
