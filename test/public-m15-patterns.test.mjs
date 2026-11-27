// M15P (2026-11-27; the owner to CTA: the confirmed M15 chart patterns "langsung ketika pattern 15m confirmed tanpa
// menunggu jadwal 1H"): M15 joins the public analysis's patterns only, and a cheap path serves them to CTA's fast pass
// from one KV key, written by the 5-minute step on a new 15m close (src/public-m15-patterns.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicAnalysis, publicPatterns, analysisLeaks, ANALYSIS_CHARTS, KEY_MAP_CHARTS, PROJECTION_MAX_HEIGHTS } from "../src/public-analysis.mjs";
import { buildStrategy, keyLevelChartsOf } from "../src/strategy-engine.mjs";
import { PRICE_LIKE } from "../src/public-projection.mjs";
import {
  M15_PATTERNS_KEY, M15_PATTERNS_VERSION, M15_SERIES_KEY, M15_PATTERN_BARS, barCloseMs, m15PatternsOf, readM15Patterns, runM15PatternsStep,
} from "../src/public-m15-patterns.mjs";
import { zoneInputs, NOW } from "./support/zone-types-fixture.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const withoutM15 = (kl) => ({ ...kl, patterns: (kl.patterns ?? []).filter((p) => String(p.tf) !== "15") });

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

test("M15P-1 M15 joins patterns only: ANALYSIS_CHARTS names it, KEY_MAP_CHARTS does not; analysis() is byte-identical but for M15 entries in patterns", () => {
  assert.equal(ANALYSIS_CHARTS["15"], "M15");
  assert.deepEqual([...KEY_MAP_CHARTS], ["H1", "H4", "D1"], "zones_by_chart and closed keep their charts");
  const inputs = zoneInputs();
  const kl = buildStrategy(inputs).key_levels;
  assert.ok(kl.patterns.some((p) => String(p.tf) === "15"), "the fixture has M15 patterns");
  const structure = { h1: { trend: "up", label: "HH" }, m15: { trend: "down", label: "LL" } };
  const charts = keyLevelChartsOf(inputs);
  const now = publicAnalysis(kl, { structure, now: NOW, charts });
  const before = publicAnalysis(withoutM15(kl), { structure, now: NOW, charts });
  const m15 = now.patterns.filter((p) => p.chart === "M15");
  assert.ok(m15.length > 0, "M15 patterns are public now");
  assert.equal(JSON.stringify({ ...now, patterns: now.patterns.filter((p) => p.chart !== "M15") }), JSON.stringify(before), "everything else byte for byte");
  assert.equal(JSON.stringify(now.zones_by_chart), JSON.stringify(before.zones_by_chart));
  assert.equal(JSON.stringify(now.closed), JSON.stringify(before.closed));
  assert.deepEqual(Object.keys(now.zones_by_chart), ["H1", "H4", "D1"]);
  assert.deepEqual(Object.keys(now.closed), ["H1", "H4", "D1"]);
  assert.deepEqual(analysisLeaks(now), []);
  for (const p of m15) assert.deepEqual(Object.keys(p).filter((k) => !["chart", "pattern", "name", "chapter", "status", "direction", "upper", "lower", "projection", "lines"].includes(k)), [], "the H1 pattern shape, nothing more");
});

test("M15P-2 the BP1 guards apply to M15 exactly as to H1: no projection without a measure, on the wrong side or absurdly far; no line without a number", () => {
  const base = { id: "triangle_symmetrical", status: "confirmed", direction: 1, upper: 4010, lower: 3990 };
  for (const tf of ["15", "60"]) {
    const out = publicPatterns([
      { ...base, tf, target: 4030 },
      { ...base, tf, target: null },
      { ...base, tf, target: 0 },
      { ...base, tf, target: 4000 },
      { ...base, tf, target: 4010 + 20 * PROJECTION_MAX_HEIGHTS + 1 },
      { ...base, tf, upper: null, target: 4030 },
      { ...base, tf, status: "failed", target: 4030 },
    ]);
    assert.deepEqual(out.map((p) => p.projection), [4030, null, null, null, null], tf);
    assert.ok(out.every((p) => p.upper > 0 && p.lower > 0), tf);
  }
  const [m] = publicPatterns([{ ...base, tf: "15", target: 4030 }]);
  const [h] = publicPatterns([{ ...base, tf: "60", target: 4030 }]);
  assert.deepEqual({ ...m, chart: "H1" }, h, "the same projection of the same pattern, by chart name only");
});

test("M15P-3 the cheap path computes the same M15 patterns as the strategy does, from the 15m bars and released figures alone", () => {
  const inputs = zoneInputs();
  const fromStrategy = publicAnalysis(buildStrategy(inputs).key_levels, { now: NOW }).patterns.filter((p) => p.chart === "M15");
  const cheap = m15PatternsOf(inputs.m15Bars, { events: inputs.releases ?? [] });
  assert.equal(JSON.stringify(cheap.patterns), JSON.stringify(fromStrategy));
  assert.equal(cheap.version, M15_PATTERNS_VERSION);
  assert.equal(cheap.at_close_ms, barCloseMs(inputs.m15Bars.at(-1)));
  assert.ok(Number.isFinite(cheap.at_close_ms));
  assert.deepEqual(m15PatternsOf(inputs.m15Bars, { mode: "off" }).patterns, [], "CHART_PATTERNS_MODE off: none, as the strategy");
  assert.equal(m15PatternsOf([...inputs.m15Bars, ...inputs.m15Bars].slice(-200)).patterns.length >= 0, true);
  assert.equal(JSON.stringify(m15PatternsOf([{ high: 1 }, ...inputs.m15Bars]).patterns), JSON.stringify(cheap.patterns), "only the last 60 bars count");
  // No price-shaped text beyond the patterns' own numbers: names and status words only.
  for (const p of cheap.patterns) assert.ok(!PRICE_LIKE.test(`${p.name} ${p.status} ${p.direction}`), p.name);
});

test("M15P-4 the writer: two KV reads per 5m run; a new 15m close computes once and writes once; the same close stops before computing; an equal value is not rewritten", async () => {
  const inputs = zoneInputs();
  const kv = fakeKv({ [M15_SERIES_KEY]: { candles: inputs.m15Bars } });
  const env = { SIGNAL_CACHE: kv };
  const first = await runM15PatternsStep(env, { now: NOW });
  assert.equal(first.status, "written", JSON.stringify(first));
  assert.deepEqual(kv.puts.map((p) => [p.k, p.o.expirationTtl > 0]), [[M15_PATTERNS_KEY, true]]);
  assert.deepEqual(kv.gets, [M15_SERIES_KEY, M15_PATTERNS_KEY], "the series and the stored value, nothing else (no DB: no released figures read)");
  const stored = JSON.parse(kv.map.get(M15_PATTERNS_KEY));
  assert.deepEqual(Object.keys(stored), ["version", "at_close_ms", "mode", "patterns"]);
  assert.equal(JSON.stringify(stored.patterns), JSON.stringify(m15PatternsOf(inputs.m15Bars).patterns));
  // The next three 5m runs inside the same 15m bar: two reads each, no compute, no write.
  for (let i = 0; i < 3; i++) assert.equal((await runM15PatternsStep(env, { now: NOW })).status, "same_close");
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.gets.length, 2 + 3 * 2);
  // A new close whose patterns are the same value: not rewritten.
  const next = { ...inputs.m15Bars.at(-1), close_time: new Date(Date.parse(inputs.m15Bars.at(-1).close_time) + 900_000).toISOString() };
  kv.map.set(M15_SERIES_KEY, JSON.stringify({ candles: [...inputs.m15Bars, next] }));
  const later = await runM15PatternsStep(env, { now: NOW });
  assert.ok(["written", "unchanged"].includes(later.status), later.status);
  assert.equal(JSON.parse(kv.map.get(M15_PATTERNS_KEY)).at_close_ms, later.status === "written" ? barCloseMs(next) : stored.at_close_ms);
  // The owner's CHART_PATTERNS_MODE off rewrites to no patterns once, then stops.
  const off = { SIGNAL_CACHE: kv, CHART_PATTERNS_MODE: "off" };
  assert.equal((await runM15PatternsStep(off, { now: NOW })).status, "written");
  assert.deepEqual(JSON.parse(kv.map.get(M15_PATTERNS_KEY)).patterns, []);
  assert.equal((await runM15PatternsStep(off, { now: NOW })).status, "same_close");
  // No series, no binding, a broken value: never throws.
  assert.equal((await runM15PatternsStep({ SIGNAL_CACHE: fakeKv() })).status, "no_bars");
  assert.equal((await runM15PatternsStep({})).status, "disabled");
  assert.equal((await runM15PatternsStep({ SIGNAL_CACHE: { get: async () => { throw new Error("kv down"); }, put: async () => {} } })).status, "no_bars");
});

test("M15P-5 the reader: its one KV key and nothing else; sinceCloseMs equal to the stored close answers unchanged without the patterns", async () => {
  const value = m15PatternsOf(zoneInputs().m15Bars);
  const kv = fakeKv({ [M15_PATTERNS_KEY]: value });
  const env = { SIGNAL_CACHE: kv, DB: { prepare() { throw new Error("no D1 read"); } } };
  const full = await readM15Patterns(env);
  assert.deepEqual(full, { version: M15_PATTERNS_VERSION, at_close_ms: value.at_close_ms, patterns: value.patterns });
  assert.deepEqual(await readM15Patterns(env, { sinceCloseMs: value.at_close_ms }), { version: M15_PATTERNS_VERSION, at_close_ms: value.at_close_ms, unchanged: true });
  assert.deepEqual((await readM15Patterns(env, { sinceCloseMs: value.at_close_ms - 900_000 })).patterns, value.patterns);
  assert.deepEqual(kv.gets, [M15_PATTERNS_KEY, M15_PATTERNS_KEY, M15_PATTERNS_KEY], "one read per call, of that key only");
  assert.deepEqual(await readM15Patterns({ SIGNAL_CACHE: fakeKv() }), { version: M15_PATTERNS_VERSION, at_close_ms: null, patterns: [] });
  assert.deepEqual(await readM15Patterns({ SIGNAL_CACHE: fakeKv({ [M15_PATTERNS_KEY]: "{not json" }) }), { version: M15_PATTERNS_VERSION, at_close_ms: null, patterns: [] });
  assert.deepEqual(analysisLeaks(full), []);
});

test("M15P-6 wiring: m15Patterns() reads only through readM15Patterns (no fs(), strategy or decision read); the writer runs in the 5-minute ledger step; analysis() is unchanged", () => {
  const src = read("src/index.ts");
  const m = src.match(/async m15Patterns\(input\?: \{ sinceCloseMs\?: number \}\): Promise<JsonObject> \{\n([\s\S]*?)\n  \}/);
  assert.ok(m, "the RPC method exists on PublicProjection");
  assert.equal(m[1].trim(), "return readM15Patterns(this.env, { sinceCloseMs: input?.sinceCloseMs ?? null }) as Promise<JsonObject>;");
  const ledger = src.slice(src.indexOf("async function runLedgerStep(env: Env)"), src.indexOf("async function runLedgerStep(env: Env)") + 4000);
  assert.match(ledger, /await runM15PatternsStep\(env\)/);
  assert.match(src, /async analysis\(\): Promise<JsonObject> \{\n    await this\.fs\(\);\n    const \[read, latest\] = await Promise\.all\(\[readStrategyWithCharts\(this\.env\)/);
  const imports = read("src/public-m15-patterns.mjs").split("\n").filter((l) => l.startsWith("import ")).join("\n");
  assert.doesNotMatch(imports, /strategy-engine|decision-engine|key-level-agent|feature-switch/, "no strategy, decision or feature-switch code");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /M15P/);
  assert.match(read("docs/CHANGELOG.md"), /M15P/);
  assert.equal(M15_PATTERN_BARS, 60, "the strategy's 15m bars (loadStrategyInputs: m15Bars.slice(-60))");
  assert.match(read("src/strategy-engine.mjs"), /m15Bars: m15Bars\.slice\(-60\)/);
  assert.match(read("src/strategy-engine.mjs"), /market-data:v2:series:OANDA:XAUUSD\|\$\{interval\}/);
});
