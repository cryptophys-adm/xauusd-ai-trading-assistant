// B9 (Track B): GET /api/chart-patterns, the Nexus chart patterns view (src/chart-patterns-view.mjs,
// cryptophys.chart-patterns-view.v1). test/fixtures/nexus-intel/chart-patterns.json is the Nexus Chart patterns page's
// (C3) contract: the view's answer on the seeded environment (test/support/chart-patterns-view-seed.mjs) with
// ?history=24 has its keys and types. Read-only: SELECTs and KV reads only, no DDL on a cold D1, no account, login,
// server or identity anywhere; every price the feed's; a measured target only ever the far target. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readChartPatternsView, historyParam, farTargets, viewCalibration, seatRoom, patternPlan, CHART_PATTERNS_VIEW_SCHEMA, VIEW_CHART_BARS, HISTORY_MAX } from "../src/chart-patterns-view.mjs";
import { seedChartPatternsEnv, STRATEGY, TRADED, INSIDE, NOW, d1, kv } from "./support/chart-patterns-view-seed.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = () => JSON.parse(readFileSync(join(root, "test/fixtures/nexus-intel/chart-patterns.json"), "utf8"));
const view = async (seed = {}, opts = {}) => { const env = await seedChartPatternsEnv(seed); return { env, v: { status: "ok", ...(await readChartPatternsView(env, { now: NOW, strategy: STRATEGY, history: 24, ...opts })) } }; };

/** Asserts `got` has the keys and types of `want` at every depth: null on either side is a nullable value. */
function sameShape(got, want, path = "$") {
  if (got === null || want === null) return;
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got), `${path}: an array`);
    if (want.length) for (const [i, x] of got.entries()) sameShape(x, want[Math.min(i, want.length - 1)], `${path}[${i}]`);
    return;
  }
  if (typeof want === "object") {
    assert.equal(typeof got, "object", `${path}: an object`);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${path}: its keys`);
    for (const k of Object.keys(want)) sameShape(got[k], want[k], `${path}.${k}`);
    return;
  }
  assert.equal(typeof got, typeof want, `${path}: ${typeof want}`);
}
/** Every key at any depth. */
const keysIn = (o, out = []) => { if (Array.isArray(o)) o.forEach((x) => keysIn(x, out)); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.push(k); keysIn(v, out); } return out; };
/** A D1 that refuses every statement but a SELECT (and records them). */
const selectOnly = (db = d1()) => { const prepare = db.prepare; db.prepare = (sql) => { if (/^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|REPLACE)\b/i.test(sql)) throw new Error(`DDL/DML refused: ${sql.slice(0, 40)}`); return prepare(sql); }; return db; };

test("CPV1. the fixture is the view's answer: keys and types, every chart, the patterns, the plan and the A10/A12 fields null", async () => {
  const main = fixture();
  const { v } = await view();
  sameShape(v, main);
  assert.equal(main.schema, CHART_PATTERNS_VIEW_SCHEMA);
  assert.equal(main.schema, "cryptophys.chart-patterns-view.v1");
  assert.deepEqual(Object.keys(main), ["status", "schema", "mode", "calibration_mode", "scale", "price", "atr_h1", "decision", "charts", "patterns", "far_targets", "calibration", "seat", "history"]);
  assert.deepEqual([main.mode, main.calibration_mode, main.scale], ["on", "auto", { prices: "feed", symbol: "OANDA:XAUUSD" }]);
  assert.deepEqual(Object.keys(main.decision).sort(), ["bar_close", "council_strategy", "decision_key", "trade_agent"]);
  assert.deepEqual([main.decision.trade_agent, main.decision.council_strategy], ["pattern_lines", "pattern_lines"]);
  // Charts: the four, each the detector's 60 bars, /api/ohlcv's candle shape.
  assert.deepEqual(Object.keys(main.charts).sort(), ["15", "240", "60", "D"]);
  for (const [tf, c] of Object.entries(main.charts)) {
    assert.deepEqual(Object.keys(c).sort(), ["interval_s", "label", "ohlcv"], tf);
    assert.equal(c.ohlcv.length, VIEW_CHART_BARS, tf);
    for (const b of c.ohlcv) assert.deepEqual(Object.keys(b), ["time", "open", "high", "low", "close", "volume"]);
    assert.ok(c.ohlcv.every((b, i) => i === 0 || b.time - c.ohlcv[i - 1].time === c.interval_s), `${tf}: consecutive bars`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(main.charts).map(([tf, c]) => [tf, [c.label, c.interval_s]])), { "15": ["15m", 900], "60": ["1H", 3600], "240": ["4H", 14400], D: ["daily", 86400] });
  // Patterns: every chart, every status; the drawing fields; a record, a zone, a plan.
  assert.deepEqual([...new Set(main.patterns.map((p) => p.tf))].sort(), ["15", "240", "60", "D"]);
  assert.deepEqual([...new Set(main.patterns.map((p) => p.status))].sort(), ["busted", "confirmed", "forming"]);
  for (const p of main.patterns) {
    for (const k of ["line_from", "line_to", "upper_from", "lower_from", "target_up", "target_down", "far_target", "start_bar", "end_bar", "bars_ago"]) assert.ok(k in p, k);
    assert.equal(typeof p.line_from, "string");
    assert.ok(p.end_bar < VIEW_CHART_BARS && p.start_bar >= 0, "indices into charts[tf].ohlcv");
    assert.deepEqual([p.held, p.breakout_bars_ago, p.bars_since_breakout, p.horizon_bars, p.bars_left], [null, null, null, null, null], "A10/A12 fill these");
    assert.deepEqual(Object.keys(p.record).sort(), ["chart", "pooled"]);
    if (p.status === "forming") assert.equal(p.far_target, null); else assert.equal(p.far_target, p.direction > 0 ? p.target_up : p.target_down);
  }
  assert.ok(main.patterns.some((p) => p.record.chart && p.record.pooled) && main.patterns.some((p) => p.record.chart === null));
  assert.ok(main.patterns.some((p) => p.zone) && main.patterns.every((p) => p.zone === null || p.zone.levels.length > 0));
  const planned = main.patterns.filter((p) => p.plan);
  assert.deepEqual(planned.map((p) => [p.tf, p.id, p.plan.agent, p.plan.side]).sort(), [["15", TRADED.id, "pattern_lines", "BUY"], ["60", INSIDE.id, "pattern_inside", "SELL"]].sort());
  for (const p of planned) assert.equal(p.plan.reach, null, "a later PR fills plan.reach");
  // The seat: four rooms; today's basis is the bar; horizon_bars waits for A12.
  assert.deepEqual(Object.keys(main.seat.rooms), ["M15", "H1", "H4", "D1"]);
  assert.deepEqual([main.seat.judged_on, main.seat.horizon_bars], ["bar", null]);
  // Calibration: by_tf and open, open breakouts with their far target.
  assert.ok(main.calibration.by_tf && main.calibration.open);
  for (const rows of Object.values(main.calibration.open)) for (const r of rows) assert.ok("far_target" in r && !("target" in r));
  assert.ok(main.history.length === 3 && main.history.every((h) => Array.isArray(h.patterns)));
});

test("CPV2. TP1-KZ2: a measured target is only the far target (far_target, target_up/down, far_targets); a plan's tp1/tp2 are its own", async () => {
  const { v } = await view();
  // No price is called `target`: the only `target` keys are the calibration's counts of breakouts that reached it.
  const targets = (o, out = []) => { if (Array.isArray(o)) o.forEach((x) => targets(x, out)); else if (o && typeof o === "object") { if ("target" in o) out.push(o); Object.values(o).forEach((x) => targets(x, out)); } return out; };
  for (const body of [v, fixture()]) {
    const counts = targets(body);
    assert.ok(counts.length);
    for (const o of counts) assert.ok(Number.isInteger(o.target) && Number.isInteger(o.n) && o.target <= o.n && "failed" in o, JSON.stringify(o));
  }
  // The pattern agent's plan keeps its TP1 (the key zone) and TP2 (the measured target); the measured target is far_target.
  const traded = v.patterns.find((p) => p.tf === "15" && p.id === TRADED.id);
  const plan = (await seedChartPatternsEnv()).SIGNAL_CACHE.m.get("decision-engine:latest");
  const own = JSON.parse(plan).strategy_plans.long.pattern_lines;
  assert.deepEqual([traded.plan.tp1, traded.plan.tp2], [own.tp1, own.tp2]);
  assert.equal(traded.plan.far_target, traded.far_target);
  assert.notEqual(traded.plan.tp1, traded.far_target, "the measured target is never TP1");
  // A forming pattern's plan (pattern_inside) names the measured target on its side as the far target.
  const inside = v.patterns.find((p) => p.tf === "60" && p.id === INSIDE.id);
  assert.equal(inside.plan.far_target, inside.target_down);
  // far_targets: every measured target (a forming pattern's both), the nearest first, with its distance in ATR(1H).
  const expected = v.patterns.flatMap((p) => (p.direction ? [p.direction > 0 ? p.target_up : p.target_down] : [p.target_up, p.target_down])).filter(Number.isFinite);
  assert.equal(v.far_targets.length, expected.length);
  assert.ok(v.far_targets.every((t, i) => i === 0 || t.distance_atr >= v.far_targets[i - 1].distance_atr));
  for (const t of v.far_targets) assert.equal(t.distance_atr, Math.round(Math.abs(t.price - v.price) / v.atr_h1 * 100) / 100);
  assert.deepEqual(farTargets([{ tf: "15", chart: "15m", id: "x", name: "x", status: "forming", direction: 0, target_up: 10, target_down: 4 }], { price: 6, atrH1: 2 }).map((t) => [t.direction, t.distance_atr]), [[-1, 1], [1, 2]]);
});

test("CPV3. CHART_PATTERNS_MODE off: no patterns and no far targets; the charts, calibration, seat and history stay", async () => {
  const { v } = await view({ env: { CHART_PATTERNS_MODE: "off" } });
  assert.equal(v.mode, "off");
  assert.deepEqual([v.patterns, v.far_targets], [[], []]);
  assert.equal(v.charts["15"].ohlcv.length, VIEW_CHART_BARS);
  assert.ok(v.calibration.by_tf && v.seat.rooms.M15.n > 0 && v.history.length === 3);
  // Off even with a memo built before the switch, and without a memo.
  assert.deepEqual((await view({ env: { CHART_PATTERNS_MODE: " OFF " } }, { strategy: null })).v.patterns, []);
  // PATTERN_CALIBRATION_MODE off: the default weights, so no record and every calibration key null.
  const cal = (await view({ env: { PATTERN_CALIBRATION_MODE: "off" } })).v;
  assert.equal(cal.calibration_mode, "off");
  assert.ok(Object.values(cal.calibration).every((x) => x === null));
  assert.ok(cal.patterns.length && cal.patterns.every((p) => p.record.chart === null && p.record.pooled === null));
  // PATTERN_HORIZON_MODE off: by_tf and open stripped (readPatternCalibration), the pooled block stays.
  const hz = (await view({ env: { PATTERN_HORIZON_MODE: "off" } })).v.calibration;
  assert.deepEqual([hz.by_tf, hz.open, typeof hz.patterns], [null, null, "object"]);
});

test("CPV4. no DDL on a cold KV and D1 (a D1 that refuses CREATE/ALTER/INSERT/UPDATE); SELECTs only; no KV write", async () => {
  // Cold: no table, no KV record, no memo.
  const cold = { DB: selectOnly(), SIGNAL_CACHE: kv() };
  const c = await readChartPatternsView(cold, { now: NOW, strategy: null, history: 24 });
  for (const sql of cold.DB.seen) assert.match(sql, /^\s*SELECT\b/i, sql);
  assert.deepEqual(cold.SIGNAL_CACHE.puts, []);
  assert.equal(cold.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0, "no table created");
  assert.deepEqual([c.patterns, c.far_targets, c.history, c.price, c.atr_h1], [[], [], [], null, null]);
  assert.deepEqual(Object.values(c.decision), [null, null, null, null]);
  assert.ok(Object.values(c.charts).every((x) => x.ohlcv.length === 0));
  assert.ok(Object.values(c.seat.rooms).every((r) => r.n === 0));
  assert.ok(Object.values(c.calibration).every((x) => x === null));
  // Seeded, the memo stubbed (the readStrategyMemo the route would pass): SELECTs only.
  const env = await seedChartPatternsEnv({ decisionInKv: false });
  selectOnly(env.DB);
  const v = await readChartPatternsView(env, { now: NOW, strategy: STRATEGY, history: 24 });
  assert.ok(env.DB.seen.length >= 3);
  for (const sql of env.DB.seen) assert.match(sql, /^\s*SELECT\b/i, sql);
  assert.deepEqual(env.SIGNAL_CACHE.puts, []);
  // Without decision-engine:latest the decision is the newest engine_decisions row.
  assert.equal(v.decision.trade_agent, "pattern_lines");
  assert.ok(env.DB.seen.some((s) => /SELECT decision_json FROM engine_decisions/.test(s)));
  // No memo: the patterns are detected on the same bars (no event patterns), the price and ATR from the bars.
  const bare = await readChartPatternsView(await seedChartPatternsEnv(), { now: NOW, strategy: null });
  assert.ok(bare.patterns.length && bare.patterns.every((p) => p.zone === null));
  assert.deepEqual(bare.patterns.map((p) => [p.tf, p.id]), STRATEGY.key_levels.patterns.map((p) => [p.tf, p.id]));
  assert.equal(bare.price, STRATEGY.price);
  // A decision read that fails is no decision (try/catch); another D1 failure reaches the route (500).
  const failing = await seedChartPatternsEnv({ decisionInKv: false });
  const prepare = failing.DB.prepare;
  failing.DB.prepare = (sql) => { if (/FROM engine_decisions/.test(sql) && /decision_json FROM/.test(sql)) throw new Error("D1_ERROR: boom"); return prepare(sql); };
  assert.equal((await readChartPatternsView(failing, { now: NOW, strategy: STRATEGY })).decision.decision_key, null);
  const broken = await seedChartPatternsEnv();
  const p2 = broken.DB.prepare;
  broken.DB.prepare = (sql) => { if (/FROM outcome_scores/.test(sql)) throw new Error("D1_ERROR: network connection lost"); return p2(sql); };
  await assert.rejects(readChartPatternsView(broken, { now: NOW, strategy: STRATEGY }), /network connection lost/);
  // The source never calls the reads that run DDL.
  const src = readFileSync(join(root, "src/chart-patterns-view.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["readLatestDecision", "readDecisions", "readAllocationEvents", "scorecards(", "ensure"]) assert.ok(!src.includes(f), f);
});

test("CPV5. no account, login, server or identity key in the answer or the fixture; every price the feed's", async () => {
  const { v } = await view();
  for (const body of [v, fixture()]) {
    for (const k of keysIn(body)) assert.doesNotMatch(k, /account|login|server|identity|ticket|broker/i, k);
    assert.ok(!JSON.stringify(body).includes("acct_"));
    assert.equal(body.scale.prices, "feed");
  }
});

test("CPV6. the seat: the Projection Agent's scored stances per room, 30 days, this scoring version only", async () => {
  const { v } = await view();
  const r = v.seat.rooms;
  assert.deepEqual([r.M15.timeframe, r.H1.timeframe, r.H4.timeframe, r.D1.timeframe], ["15", "60", "240", "1D"]);
  assert.deepEqual(r.M15.directional, { n: 5, hit: 3, miss: 1, neutral: 1, hit_rate: 0.75 }, "another agent, an older version and an old score do not count");
  assert.deepEqual(r.M15.wait, { n: 2, hit: 1, missed_opportunity: 1, accuracy: 0.5 });
  assert.equal(r.M15.n, 7);
  assert.deepEqual(r.H1.directional, { n: 3, hit: 1, miss: 2, neutral: 0, hit_rate: 0.333 });
  assert.equal(r.D1.n, 0);
  assert.deepEqual(r.D1.reputation, { decisive: 0, accuracy: null, shrunk: 0.5, weight: 1 });
  assert.deepEqual(v.seat.scoring, { version: "cryptophys.outcome-scoring.v3", candles: 4, threshold_atr: 0.5, window_days: 30 });
  assert.deepEqual(seatRoom("15", []).directional, { n: 0, hit: 0, miss: 0, neutral: 0, hit_rate: null });
});

test("CPV7. ?history: 0 by default, at most 24, newest first, each decision's stored patterns with their far target", async () => {
  assert.deepEqual([historyParam(undefined), historyParam(null), historyParam(""), historyParam("3"), historyParam("99"), historyParam("-1"), historyParam("2.5"), historyParam("x")], [0, 0, 0, 3, HISTORY_MAX, 0, 0, 0]);
  const { env, v } = await view({}, { history: undefined });
  assert.deepEqual(v.history, []);
  assert.ok(!env.DB.seen.some((s) => /chart_patterns/.test(s)), "no history read by default");
  const h = (await view({}, { history: "2" })).v.history;
  assert.equal(h.length, 2);
  assert.ok(h[0].bar_close > h[1].bar_close);
  assert.equal(h[0].trade_agent, "pattern_lines");
  const all = (await view()).v.history;
  assert.equal(all.length, 3);
  assert.deepEqual(all[1].patterns[0], { tf: "15", chart: "15m", id: "rectangle_top", name: "rectangle top", status: "confirmed", direction: 1, upper: 4098.4, lower: 4094.4, far_target: 4102.4 });
  assert.deepEqual([all[2].stance, all[2].trade_agent, all[2].patterns[0].far_target], ["WAIT", null, null]);
});

test("CPV8. pure parts: a plan matched by pattern and chart, the calibration's keys always present", () => {
  const plans = { long: { pattern_lines: { status: "live", pattern: "rectangle_top", setup: "the Projection Agent's 1H rectangle top, broken upward", entry: 1, stop: 0.5, tp1: 2, tp2: 3, rrr: { tp1: 2, tp2: 4 }, at_level: true } }, short: {} };
  const p = { tf: "15", id: "rectangle_top", direction: 1, target_up: 3 };
  assert.equal(patternPlan(p, plans), null, "another chart's pattern");
  assert.equal(patternPlan({ ...p, tf: "60", direction: -1 }, plans), null, "the other side");
  assert.deepEqual(patternPlan({ ...p, tf: "60" }, plans), { agent: "pattern_lines", side: "BUY", status: "live", at_level: true, entry: 1, stop: 0.5, tp1: 2, tp2: 3, rrr: { tp1: 2, tp2: 4 }, far_target: 3, reach: null });
  assert.equal(patternPlan(p, null), null);
  assert.deepEqual(viewCalibration(null), { version: null, computed_at: null, base_rate: null, resolved: null, pending: null, patterns: null, by_tf: null, open: null });
});

async function bundle(entry) {
  const out = await build({ entryPoints: [join(root, entry)], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") } });
  const dir = await mkdtemp(join(tmpdir(), "cpv-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}

test("CPV9. the route: 200 no-store through the AI Worker and Nexus's proxy (GET only, POST 405); ?history; INTEL_VIEWS off 404; a D1 failure 500 chart_patterns_unavailable", async () => {
  const worker = await bundle("src/index.ts");
  const nexus = await bundle("workers/xauusd-nexus-dashboard/src/index.ts");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const env = await seedChartPatternsEnv();
  const r = await worker.fetch(new Request("https://worker.test/api/chart-patterns?history=2"), env, ctx);
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(body.status, "ok");
  assert.equal(body.schema, "cryptophys.chart-patterns-view.v1");
  assert.equal(body.history.length, 2);
  // The route reads the clock: the seeded bars that closed after it are left out.
  assert.ok(body.charts["60"].ohlcv.length > 0 && body.charts["60"].ohlcv.length <= VIEW_CHART_BARS);
  sameShape({ ...body, patterns: [], far_targets: [] }, { ...fixture(), patterns: [], far_targets: [] });
  // Nexus forwards the GET over its AI_WORKER binding and the AI Worker's no-store stands; a POST never leaves Nexus.
  const seen = [];
  const AI_WORKER = { async fetch(req) { seen.push([req.method, new URL(req.url).pathname + new URL(req.url).search]); return worker.fetch(req, env, ctx); } };
  const p = await nexus.fetch(new Request("https://nexus.test/api/chart-patterns?history=24"), { AI_WORKER });
  assert.equal(p.status, 200);
  assert.equal(p.headers.get("cache-control"), "no-store");
  assert.equal((await p.json()).schema, "cryptophys.chart-patterns-view.v1");
  assert.equal((await nexus.fetch(new Request("https://nexus.test/api/chart-patterns", { method: "POST", body: "{}" }), { AI_WORKER })).status, 405);
  assert.deepEqual(seen, [["GET", "/api/chart-patterns?history=24"]]);
  // The off switch.
  const off = await worker.fetch(new Request("https://worker.test/api/chart-patterns"), { ...env, INTEL_VIEWS: "off" }, ctx);
  assert.equal(off.status, 404);
  assert.deepEqual(await off.json(), { status: "not_found", reason: "intel_views_off" });
  // A failing D1 read.
  const broken = await seedChartPatternsEnv();
  const prepare = broken.DB.prepare;
  broken.DB.prepare = (sql) => { if (/FROM outcome_scores/.test(sql)) throw new Error("D1_ERROR: boom"); return prepare(sql); };
  const e = await worker.fetch(new Request("https://worker.test/api/chart-patterns"), broken, ctx);
  assert.equal(e.status, 500);
  assert.deepEqual(await e.json(), { status: "error", error: "chart_patterns_unavailable" });
});
