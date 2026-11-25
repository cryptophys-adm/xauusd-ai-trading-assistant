// KM1 (owner 2026-11-25: "Agent harus punya kemampuan scheduling misal pull keymap dari xauusd per 1h dan 4h dan 1D …
// Jika waktunya sama berarti digabung"): the public analysis gains each chart's own key-level map (zones_by_chart) and
// the bar close it was read at (closed). The agent's clustering runs over only that chart's levels; nothing it already
// returned changes. Pure: no network, no D1.
import test from "node:test";
import assert from "node:assert/strict";
import { publicAnalysis, analysisLeaks, zoneMetrics, ANALYSIS_FORBIDDEN_KEYS, KEY_MAP_CHARTS } from "../src/public-analysis.mjs";
import { keyLevelsByChart, chartOfLevel, buildKeyLevels, rawLevels, chartPatterns, KEY_LEVEL_CHARTS } from "../src/key-level-agent.mjs";
import { keyLevelChartsOf, buildStrategy, readStrategy, readStrategyWithCharts } from "../src/strategy-engine.mjs";
import { PRICE_LIKE } from "../src/public-projection.mjs";
import { AGENT_IDS } from "../src/strategy-agents.mjs";
import { zoneInputs, NOW } from "./support/zone-types-fixture.mjs";

const ZONE_KEYS = ["role", "low", "high", "strength", "sources", "metrics"];
const INTERNAL = /\b(prophet|gmi|mizan|nexus|omega|aether|cerebrum)\b/i;

// Price 4040, 1H ATR 10 (tolerance 3). A 1H stack at 4060-4062 (Camarilla, value area, order block: 3 families), a
// 4H stack at 4020-4021 (Camarilla and value area: 2 families) and the shared daily/weekly levels at 4000-4002 (daily
// and weekly pivot, previous day low, round 4000: 3 families). A 15m Camarilla H4 at 4061 belongs to no chart.
const fixture = () => ({
  snapshots: {
    "60": { timeframe: "60", huds: {
      interstellar_eyes: { fields: { camarilla: { "60": { h4: 4060 } } } },
      fabio_amt: { fields: { poc: 4061 } },
      order_blocks: { fields: { bear_top: 4062 } },
      chronos_matrix: { fields: { daily_cpr: { pivot: 4000 }, weekly_cpr: { pivot: 4001 } } }
    } },
    "240": { timeframe: "240", huds: { interstellar_eyes: { fields: { camarilla: { "240": { l4: 4020 } } } }, fabio_amt: { fields: { poc: 4021 } } } },
    "15": { timeframe: "15", huds: { interstellar_eyes: { fields: { camarilla: { "15": { h4: 4061 } } } } } }
  },
  bars: { D1: [{ high: 4090, low: 4002, close: 4045 }], W1: [{ high: 4200, low: 3800, close: 4000 }] },
  price: 4040, atrH1: 10, patterns: "off"
});
/** rawLevels' arguments from the strategy's inputs, as keyLevelChartsOf builds them (the chart patterns included). */
const keyLevelArgsOf = (i) => {
  const bars = { M15: i.m15Bars, H1: i.h1Bars, H4: i.h4Bars, D1: i.d1Bars, W1: i.w1Bars };
  return { snapshots: { "15": i.m15Snapshot, "60": i.h1Snapshot, "240": i.h4Snapshot, "1D": i.d1Snapshot }, bars, price: 4000, atrH1: 10, patterns: chartPatterns(bars) };
};
const bandsOf = (list) => list.map((z) => [z.low, z.high]);

test("KM1-1 the level-to-chart mapping: 1H to H1, 4H to H4; daily, weekly, session and round numbers to D1; 15m to none", () => {
  assert.deepEqual(KEY_LEVEL_CHARTS, ["H1", "H4", "D1"]);
  assert.deepEqual(KEY_MAP_CHARTS, KEY_LEVEL_CHARTS);
  for (const [tf, chart] of [["60", "H1"], ["240", "H4"], ["D", "D1"], ["1D", "D1"], ["W", "D1"], ["15", null]]) assert.equal(chartOfLevel({ kind: "camarilla", tf }), chart, tf);
  assert.equal(chartOfLevel({ kind: "round", tf: "15" }), "D1", "round numbers are filed under 15m for their weight only");
  assert.equal(chartOfLevel({ kind: "open", tf: "D" }), "D1", "session levels carry the daily timeframe");
  const raw = rawLevels(fixture());
  const where = Object.fromEntries(raw.map((l) => [l.label, chartOfLevel(l)]));
  assert.deepEqual([where["daily pivot"], where["weekly pivot"], where["previous day low"], where["previous week high"], where["round 4000"]], ["D1", "D1", "D1", "D1", "D1"]);
  assert.deepEqual([where["1H Camarilla H4"], where["4H Camarilla L4"], where["15m Camarilla H4"]], ["H1", "H4", null]);
});

test("KM1-2 per-chart clustering: each chart's zone only in its chart, shared levels in D1, candidate by the 3-family rule on that chart", () => {
  const by = keyLevelsByChart(fixture());
  const multi = (list) => list.filter((z) => z.sources >= 2);
  assert.deepEqual(bandsOf(multi(by.H1)), [[4060, 4062]]);
  assert.deepEqual(bandsOf(multi(by.H4)), [[4020, 4021]]);
  assert.deepEqual(bandsOf(multi(by.D1)), [[4000, 4002]]);
  assert.ok(by.H1.every((z) => z.members.every((m) => !m.label.startsWith("15m"))), "a 15m level is on no chart");
  const a = publicAnalysis({ price: 4040, atr_h1: 10, candidates: [], patterns: [] }, { now: NOW, charts: { zones: by, closed: {} } });
  const [h1, h4, d1] = ["H1", "H4", "D1"].map((c) => a.zones_by_chart[c]);
  assert.deepEqual(h1, [{ role: "supply", low: 4060, high: 4062, strength: "medium", sources: 3, metrics: ["1H Camarilla H4", "1H point of control", "1H bearish order block top"], candidate: true }]);
  assert.deepEqual(h4, [{ role: "demand", low: 4020, high: 4021, strength: "medium", sources: 2, metrics: ["4H Camarilla L4", "4H point of control"], candidate: false }]);
  assert.deepEqual(d1, [{ role: "demand", low: 4000, high: 4002, strength: "strong", sources: 3, metrics: ["weekly pivot", "daily pivot", "previous day low"], candidate: true }]);
  // The cross-chart reading is unchanged by this: the agent's own candidates still stack every chart together.
  const kl = buildKeyLevels(fixture());
  assert.ok(kl.candidates.some((z) => z.low === 4060 && z.members.some((m) => m.label === "15m Camarilla H4")));
});

test("KM1-3 the shape: zones_by_chart H1/H4/D1 in the zones[] shape plus candidate, sorted as zones[]; closed holds ISO bar closes or null", () => {
  const by = keyLevelsByChart(fixture());
  const kl = buildKeyLevels(fixture());
  const a = publicAnalysis(kl, { now: NOW, charts: { zones: by, closed: { H1: "2026-11-25T10:00:00.000Z", H4: "2026-11-25T08:00:00Z", D1: "2026-11-24" } } });
  assert.deepEqual(Object.keys(a.zones_by_chart), ["H1", "H4", "D1"]);
  assert.ok(a.zones.length, "the fixture has cross-chart zones");
  for (const z of a.zones) assert.deepEqual(Object.keys(z), ZONE_KEYS);
  for (const list of Object.values(a.zones_by_chart)) {
    assert.ok(Array.isArray(list));
    for (const z of list) { assert.deepEqual(Object.keys(z), [...ZONE_KEYS, "candidate"]); assert.equal(typeof z.candidate, "boolean"); }
    assert.ok(list.every((z, i) => i === 0 || list[i - 1].high >= z.high), "highest first, as zones[]");
  }
  assert.deepEqual(a.closed, { H1: "2026-11-25T10:00:00.000Z", H4: "2026-11-25T08:00:00.000Z", D1: null });
  // Null or missing charts: the same shape, empty.
  const empty = publicAnalysis(kl, { now: NOW, charts: null });
  assert.deepEqual([empty.zones_by_chart, empty.closed], [{ H1: [], H4: [], D1: [] }, { H1: null, H4: null, D1: null }]);
});

test("KM1-4 a chart lists every zone of two or more families and every candidate; a lone level is no zone; the agent's cap applies per chart", () => {
  const by = keyLevelsByChart(fixture());
  assert.ok(by.D1.some((z) => z.sources === 1), "round 4050 alone is a one-level zone in the agent's reading");
  const a = publicAnalysis({}, { now: NOW, charts: { zones: by } });
  assert.ok(Object.values(a.zones_by_chart).flat().every((z) => z.candidate || z.sources >= 2));
  assert.ok(!a.zones_by_chart.D1.some((z) => z.low === 4050), "the lone round number is not listed");
  // Three 3-family 1H stacks under price (Camarilla, value area, order block): scores 3.45, 3.9 and 3.15, all medium
  // candidates by the rule; the cap keeps the strongest two (4010, 4000), and 4020 is listed with candidate false.
  const snapshots = { "60": { timeframe: "60", huds: {
    interstellar_eyes: { fields: { camarilla: { "60": { l5: 4000, l4: 4010, l3: 4020 } } } },
    fabio_amt: { fields: { val: 4000.5, poc: 4010.5, vah: 4020.5 } },
    order_blocks: { fields: { bear_bottom: 4001, bull_bottom: 4011, bull_top: 4021 } }
  } } };
  const by2 = keyLevelsByChart({ snapshots, bars: {}, price: 4040, atrH1: 10, patterns: "off" });
  const h1 = publicAnalysis({}, { now: NOW, charts: { zones: by2 } }).zones_by_chart.H1;
  assert.deepEqual(h1.map((z) => [z.low, z.role, z.sources, z.candidate]), [[4020, "demand", 3, false], [4010, "demand", 3, true], [4000, "demand", 3, true]]);
});

test("KM1-5 the existing output is byte-identical: zones, patterns, structure, price and atr_h1 with or without the maps", () => {
  const inputs = zoneInputs();
  const strategy = buildStrategy(inputs);
  const structure = { h1: { trend: "up", label: "HH" }, h4: { trend: "range", label: "LH" } };
  const before = publicAnalysis(strategy.key_levels, { structure, now: NOW });
  const charts = keyLevelChartsOf(inputs);
  const after = publicAnalysis(strategy.key_levels, { structure, now: NOW, charts });
  const { zones_by_chart: zbc, closed: _closed, ...rest } = after;
  assert.equal(JSON.stringify(rest), JSON.stringify(before));
  assert.deepEqual(Object.keys(after), [...Object.keys(before), "zones_by_chart", "closed"], "the new keys come after the old ones");
  assert.equal(after.version, before.version);
  assert.ok(zbc.H1.length && zbc.H4.length && zbc.D1.length, "the fixture fills every chart");
  // The strategy (and so the decision record built from it) is the same before and after the per-chart reading.
  assert.equal(JSON.stringify(buildStrategy(inputs)), JSON.stringify(strategy));
  assert.equal(JSON.stringify(inputs), JSON.stringify(zoneInputs()), "the inputs are not mutated");
});

test("KM1-6 closed: the bar-close time of the latest closed bar of each chart's own series, never a future one", () => {
  const inputs = zoneInputs();
  const { closed } = keyLevelChartsOf(inputs);
  assert.deepEqual(closed, { H1: inputs.h1Bars.at(-1).close_time, H4: inputs.h4Bars.at(-1).close_time, D1: inputs.d1Bars.at(-1).close_time });
  const future = { close_time: new Date(NOW + 3_600_000).toISOString(), open: 4000, high: 4001, low: 3999, close: 4000 };
  assert.equal(keyLevelChartsOf({ ...inputs, h1Bars: [...inputs.h1Bars, future] }).closed.H1, inputs.h1Bars.at(-1).close_time);
  assert.deepEqual(keyLevelChartsOf({ ...inputs, h4Bars: [], d1Bars: [{ high: 1 }] }).closed, { H1: inputs.h1Bars.at(-1).close_time, H4: null, D1: null });
});

test("KM1-7 public safety: no forbidden key, no internal name, agent id, price or trade word in the maps", () => {
  for (const prophet of [false, true]) {
    const inputs = zoneInputs(undefined, { prophet });
    const strategy = buildStrategy(inputs);
    const a = publicAnalysis(strategy.key_levels, { now: NOW, charts: keyLevelChartsOf(inputs) });
    assert.deepEqual(analysisLeaks(a), []);
    for (const k of ["zones_by_chart", "closed", "candidate", "H1", "H4", "D1"]) {
      assert.ok(!ANALYSIS_FORBIDDEN_KEYS.includes(k.toLowerCase()), k);
      assert.ok(!["plan", "decision", "trade", "lot", "lots", "account", "confidence"].includes(k.toLowerCase()), k);
    }
    const metrics = Object.values(a.zones_by_chart).flat().flatMap((z) => z.metrics);
    assert.ok(metrics.length > 5, "the scenario's maps carry metrics");
    for (const m of metrics) {
      assert.doesNotMatch(m, INTERNAL, m);
      assert.doesNotMatch(m, PRICE_LIKE, m);
      assert.doesNotMatch(m, /\b(entry|stop|take[- ]?profit|target|sl|tp\d?|lot|lots|buy|sell)\b/i, m);
      assert.ok(!AGENT_IDS.some((id) => m.toLowerCase().includes(id.replace(/_/g, " ")) || m.includes(id)), m);
    }
    // The maps hold nothing a zone of zones[] does not: no members, score, families, label, price, ds or qualified.
    for (const z of Object.values(a.zones_by_chart).flat()) for (const k of ["members", "score", "families", "label", "price", "ds", "qualified", "reader"]) assert.equal(k in z, false, k);
    // closed holds bar-close times only.
    for (const v of Object.values(a.closed)) assert.ok(v === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v));
    // Every metric name of the maps is a name zones[] can carry: a level label as zoneMetrics names it.
    const known = new Set(rawLevels({ ...keyLevelArgsOf(inputs) }).map((l) => zoneMetrics({ members: [l] })[0]).filter(Boolean));
    for (const m of metrics) assert.ok(known.has(m), m);
  }
});

test("KM1-8 cost: readStrategyWithCharts reads exactly what readStrategy reads, and its strategy is readStrategy's", async () => {
  const kvOf = (log) => ({ get: async (key) => { log.push(key); return null; }, put: async () => {}, list: async () => ({ keys: [] }) });
  const now = Date.parse("2026-11-25T10:05:00Z");
  const a = [], b = [];
  const plain = await readStrategy({ SIGNAL_CACHE: kvOf(a) }, { now });
  const both = await readStrategyWithCharts({ SIGNAL_CACHE: kvOf(b) }, { now });
  assert.deepEqual([...b].sort(), [...a].sort());
  assert.equal(JSON.stringify(both.strategy), JSON.stringify(plain));
  assert.deepEqual(both.charts, { zones: { H1: [], H4: [], D1: [] }, closed: { H1: null, H4: null, D1: null } });
});
