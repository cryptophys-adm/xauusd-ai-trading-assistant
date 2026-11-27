// PT1 (2026-11-27; the owner to CTA: confirmed chart patterns on every chart within about 5 minutes, their invalidation,
// and an hourly recap): the public analysis's patterns gain M15 and busted ones, and a cheap path serves the patterns of
// M15, H1, H4 and D1 to CTA's fast pass from one KV key, written by the 5-minute step (src/public-patterns.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicAnalysis, publicPatterns, analysisLeaks, ANALYSIS_CHARTS, KEY_MAP_CHARTS, PROJECTION_MAX_HEIGHTS, PUBLIC_PATTERN_STATUSES } from "../src/public-analysis.mjs";
import { buildStrategy, keyLevelChartsOf } from "../src/strategy-engine.mjs";
import { PRICE_LIKE } from "../src/public-projection.mjs";
import { PATTERNS_KEY, PATTERNS_VERSION, PATTERN_BARS, PATTERN_SERIES, seriesKey, barCloseMs, patternsOf, readPatterns, runPatternsStep } from "../src/public-patterns.mjs";
import { zoneInputs, NOW } from "./support/zone-types-fixture.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const barsOf = (i) => ({ M15: i.m15Bars, H1: i.h1Bars, H4: i.h4Bars, D1: i.d1Bars });
const isNew = (p) => p.chart === "M15" || p.status === "busted";

/** A fake SIGNAL_CACHE that records every key it is asked for and every write. */
function fakeKv(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const gets = [], puts = [];
  return {
    gets, puts, map,
    async get(k) { gets.push(k); return map.has(k) ? map.get(k) : null; },
    async put(k, v, o) { puts.push({ k, o }); map.set(k, v); },
  };
}
const seriesKv = (i, extra = {}) => fakeKv({ ...Object.fromEntries(Object.entries(PATTERN_SERIES).map(([c, iv]) => [seriesKey(iv), { candles: barsOf(i)[c] }])), ...extra });

test("PT1-1 patterns only gain M15 and busted ones: zones_by_chart, closed and every other key are byte for byte as before", () => {
  assert.equal(ANALYSIS_CHARTS["15"], "M15");
  assert.deepEqual([...PUBLIC_PATTERN_STATUSES], ["forming", "confirmed", "busted"]);
  assert.deepEqual([...KEY_MAP_CHARTS], ["H1", "H4", "D1"], "zones_by_chart and closed keep their charts");
  const inputs = zoneInputs();
  const kl = buildStrategy(inputs).key_levels;
  assert.ok(kl.patterns.some((p) => String(p.tf) === "15"), "the fixture has M15 patterns");
  // A busted H4 pattern beside the strategy's own: the analysis shows it, without a projection.
  const busted = { tf: "240", id: "head_and_shoulders_top", status: "busted", direction: 1, upper: 4050, lower: 4010, target: 4100 };
  const klB = { ...kl, patterns: [...kl.patterns, busted] };
  const structure = { h1: { trend: "up", label: "HH" }, m15: { trend: "down", label: "LL" } };
  const charts = keyLevelChartsOf(inputs);
  const now = publicAnalysis(klB, { structure, now: NOW, charts });
  const before = publicAnalysis({ ...klB, patterns: klB.patterns.filter((p) => String(p.tf) !== "15" && p.status !== "busted") }, { structure, now: NOW, charts });
  assert.ok(now.patterns.some((p) => p.chart === "M15"), "M15 patterns are public now");
  const b = now.patterns.find((p) => p.status === "busted");
  assert.deepEqual([b.chart, b.pattern, b.direction, b.projection], ["H4", "head_and_shoulders_top", "up", null], "a busted pattern, never a projection");
  assert.equal(JSON.stringify({ ...now, patterns: now.patterns.filter((p) => !isNew(p)) }), JSON.stringify(before), "everything else byte for byte");
  assert.deepEqual(Object.keys(now.zones_by_chart), ["H1", "H4", "D1"]);
  assert.deepEqual(Object.keys(now.closed), ["H1", "H4", "D1"]);
  assert.deepEqual(analysisLeaks(now), []);
  for (const p of now.patterns) assert.deepEqual(Object.keys(p).filter((k) => !["chart", "pattern", "name", "chapter", "status", "direction", "upper", "lower", "projection", "lines"].includes(k)), [], "the H1 pattern shape, nothing more");
});

test("PT1-2 the BP1 guards apply to M15 exactly as to H1; a busted pattern never has a projection; other statuses stay out", () => {
  const base = { id: "triangle_symmetrical", status: "confirmed", direction: 1, upper: 4010, lower: 3990 };
  for (const tf of ["15", "60"]) {
    const out = publicPatterns([
      { ...base, tf, target: 4030 },
      { ...base, tf, target: null },
      { ...base, tf, target: 0 },
      { ...base, tf, target: 4000 },
      { ...base, tf, target: 4010 + 20 * PROJECTION_MAX_HEIGHTS + 1 },
      { ...base, tf, status: "busted", target: 4030 },
      { ...base, tf, upper: null, target: 4030 },
      { ...base, tf, status: "failed", target: 4030 },
      { ...base, tf, status: "retired", target: 4030 },
    ]);
    assert.deepEqual(out.map((p) => [p.status, p.projection]), [["confirmed", 4030], ["confirmed", null], ["confirmed", null], ["confirmed", null], ["confirmed", null], ["busted", null]], tf);
  }
  const [m] = publicPatterns([{ ...base, tf: "15", target: 4030 }]);
  const [h] = publicPatterns([{ ...base, tf: "60", target: 4030 }]);
  assert.deepEqual({ ...m, chart: "H1" }, h, "the same projection of the same pattern, by chart name only");
});

test("PT1-3 the cheap path gives the patterns the strategy gives, on every chart, from the four series and the released figures alone", () => {
  for (const prophet of [false, true]) {
    const inputs = zoneInputs(undefined, { prophet });
    const fromStrategy = publicAnalysis(buildStrategy(inputs).key_levels, { now: NOW }).patterns;
    const cheap = patternsOf(barsOf(inputs), { events: inputs.releases ?? [] });
    assert.equal(JSON.stringify(cheap.patterns), JSON.stringify(fromStrategy), `prophet ${prophet}`);
    assert.deepEqual(new Set(cheap.patterns.map((p) => p.chart)), new Set(["M15", "H1", "H4", "D1"]), "every chart");
    assert.deepEqual(cheap.closed, { M15: barCloseMs(inputs.m15Bars.at(-1)), H1: barCloseMs(inputs.h1Bars.at(-1)), H4: barCloseMs(inputs.h4Bars.at(-1)), D1: barCloseMs(inputs.d1Bars.at(-1)) });
    assert.equal(cheap.at_close_ms, Math.max(...Object.values(cheap.closed)));
  }
  const inputs = zoneInputs();
  assert.deepEqual(patternsOf(barsOf(inputs), { mode: "off" }).patterns, [], "CHART_PATTERNS_MODE off: none, as the strategy");
  const longer = { ...barsOf(inputs), H1: [{ high: 1 }, ...inputs.h1Bars] };
  assert.equal(JSON.stringify(patternsOf(longer).patterns), JSON.stringify(patternsOf(barsOf(inputs)).patterns), `only the last ${PATTERN_BARS} bars count`);
  for (const p of patternsOf(barsOf(inputs)).patterns) assert.ok(!PRICE_LIKE.test(`${p.name} ${p.status} ${p.direction}`), p.name);
});

test("PT1-4 the writer: five KV reads per 5m run; a new close of any chart computes once and writes once; the same closes stop before computing", async () => {
  const inputs = zoneInputs();
  const kv = seriesKv(inputs);
  const env = { SIGNAL_CACHE: kv };
  const first = await runPatternsStep(env, { now: NOW });
  assert.equal(first.status, "written", JSON.stringify(first));
  assert.deepEqual(kv.puts.map((p) => [p.k, p.o.expirationTtl > 0]), [[PATTERNS_KEY, true]]);
  assert.deepEqual([...kv.gets].sort(), [...Object.values(PATTERN_SERIES).map(seriesKey), PATTERNS_KEY].sort(), "the four series and the stored value, nothing else (no DB: no released figures read)");
  const stored = JSON.parse(kv.map.get(PATTERNS_KEY));
  assert.deepEqual(Object.keys(stored), ["version", "at_close_ms", "closed", "mode", "patterns"]);
  assert.equal(JSON.stringify(stored.patterns), JSON.stringify(patternsOf(barsOf(inputs)).patterns));
  for (let i = 0; i < 3; i++) assert.equal((await runPatternsStep(env, { now: NOW })).status, "same_close");
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.gets.length, 5 + 3 * 5);
  // A late H1 series (its close arrives after the 15m one): recomputed although the 15m close is the same.
  const h1 = { ...inputs.h1Bars.at(-1), close_time: new Date(barCloseMs(inputs.h1Bars.at(-1)) + 3_600_000).toISOString() };
  kv.map.set(seriesKey("1h"), JSON.stringify({ candles: [...inputs.h1Bars, h1] }));
  assert.equal((await runPatternsStep(env, { now: NOW })).status, "written", "a chart's new close is a new value (its closed time)");
  assert.equal(JSON.parse(kv.map.get(PATTERNS_KEY)).closed.H1, barCloseMs(h1));
  assert.equal((await runPatternsStep(env, { now: NOW })).status, "same_close");
  // The owner's CHART_PATTERNS_MODE off rewrites to no patterns once, then stops.
  const off = { SIGNAL_CACHE: kv, CHART_PATTERNS_MODE: "off" };
  assert.equal((await runPatternsStep(off, { now: NOW })).status, "written");
  assert.deepEqual(JSON.parse(kv.map.get(PATTERNS_KEY)).patterns, []);
  assert.equal((await runPatternsStep(off, { now: NOW })).status, "same_close");
  // No series, no binding, KV down: never throws.
  assert.equal((await runPatternsStep({ SIGNAL_CACHE: fakeKv() })).status, "no_bars");
  assert.equal((await runPatternsStep({})).status, "disabled");
  assert.equal((await runPatternsStep({ SIGNAL_CACHE: { get: async () => { throw new Error("kv down"); }, put: async () => {} } })).status, "no_bars");
});

test("PT1-5 the reader: its one KV key and nothing else; sinceCloseMs equal to the stored close answers unchanged without the patterns", async () => {
  const value = patternsOf(barsOf(zoneInputs()));
  const kv = fakeKv({ [PATTERNS_KEY]: value });
  const env = { SIGNAL_CACHE: kv, DB: { prepare() { throw new Error("no D1 read"); } } };
  const full = await readPatterns(env);
  assert.deepEqual(full, { version: PATTERNS_VERSION, at_close_ms: value.at_close_ms, closed: value.closed, patterns: value.patterns });
  assert.deepEqual(await readPatterns(env, { sinceCloseMs: value.at_close_ms }), { version: PATTERNS_VERSION, at_close_ms: value.at_close_ms, unchanged: true });
  assert.deepEqual((await readPatterns(env, { sinceCloseMs: value.at_close_ms - 900_000 })).patterns, value.patterns);
  assert.deepEqual(kv.gets, [PATTERNS_KEY, PATTERNS_KEY, PATTERNS_KEY], "one read per call, of that key only");
  assert.deepEqual(await readPatterns({ SIGNAL_CACHE: fakeKv() }), { version: PATTERNS_VERSION, at_close_ms: null, closed: null, patterns: [] });
  assert.deepEqual(await readPatterns({ SIGNAL_CACHE: fakeKv({ [PATTERNS_KEY]: "{not json" }) }), { version: PATTERNS_VERSION, at_close_ms: null, closed: null, patterns: [] });
  assert.deepEqual(analysisLeaks(full), []);
});

test("PT1-6 wiring: patterns() reads only through readPatterns (no fs(), strategy or decision read); the writer runs in the 5-minute ledger step; analysis() is unchanged", () => {
  const src = read("src/index.ts");
  const m = src.match(/async patterns\(input\?: \{ sinceCloseMs\?: number \}\): Promise<JsonObject> \{\n([\s\S]*?)\n  \}/);
  assert.ok(m, "the RPC method exists on PublicProjection");
  assert.equal(m[1].trim(), "return readPatterns(this.env, { sinceCloseMs: input?.sinceCloseMs ?? null }) as Promise<JsonObject>;");
  const start = src.indexOf("export class PublicProjection extends WorkerEntrypoint<Env> {");
  assert.ok(src.indexOf("async patterns(input?: { sinceCloseMs?: number })") > start, "on PublicProjection");
  const ledger = src.slice(src.indexOf("async function runLedgerStep(env: Env)"), src.indexOf("async function runLedgerStep(env: Env)") + 4000);
  assert.match(ledger, /await runPatternsStep\(env\)/);
  assert.match(src, /async analysis\(\): Promise<JsonObject> \{\n    await this\.fs\(\);\n    const \[read, latest\] = await Promise\.all\(\[readStrategyWithCharts\(this\.env\)/);
  const imports = read("src/public-patterns.mjs").split("\n").filter((l) => l.startsWith("import ")).join("\n");
  assert.doesNotMatch(imports, /strategy-engine|decision-engine|feature-switch/, "no strategy, decision or feature-switch code");
  assert.match(read("docs/SSOT.md"), /\*\*PT1\*\*/);
  assert.match(read("docs/CHANGELOG.md"), /PT1/);
  // The strategy's series and bar counts, which the cheap path mirrors.
  assert.equal(PATTERN_BARS, 60);
  assert.match(read("src/strategy-engine.mjs"), /h1Bars: h1Bars\.slice\(-60\), m15Bars: m15Bars\.slice\(-60\), h4Bars: h4Bars\.slice\(-60\), d1Bars: d1Bars\.slice\(-60\)/);
  assert.match(read("src/strategy-engine.mjs"), /seriesCandles\(env, "1h"\), seriesCandles\(env, "15m"\), seriesCandles\(env, "4h"\), seriesCandles\(env, "1D"\)/);
  assert.match(read("src/strategy-engine.mjs"), /market-data:v2:series:OANDA:XAUUSD\|\$\{interval\}/);
});
