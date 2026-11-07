import test from "node:test";
import assert from "node:assert/strict";
import { buildKeyLevels, rawLevels, clusterLevels, swings, TF_WEIGHT, CANDIDATE_MIN_SOURCES, CANDIDATE_MIN_SCORE } from "../src/key-level-agent.mjs";

const camarilla = (base) => ({ h3: base + 8, h4: base + 20, h5: base + 35, l3: base - 2, l4: base - 14, l5: base - 30 });
const snap = (timeframe, cam, extra = {}) => ({
  timeframe,
  huds: {
    interstellar_eyes: { fields: { camarilla: cam } },
    chronos_matrix: { fields: { daily_cpr: { pivot: 4020, tc: 4024, bc: 4016 }, weekly_cpr: { pivot: 3960, tc: 3965, bc: 3955 } } },
    fabio_amt: { fields: { poc: 4052, vah: 4068, val: 4030 } },
    ...extra
  }
});

test("swings are 2-bar fractals of closed bars, newest first", () => {
  const bars = [10, 11, 15, 11, 10, 9, 5, 9, 10, 12].map((m) => ({ high: m + 1, low: m - 1 }));
  const { highs, lows } = swings(bars);
  assert.deepEqual(highs, [16]);
  assert.deepEqual(lows, [4]);
  assert.deepEqual(swings([]), { highs: [], lows: [] });
});

test("every chart's levels are gathered once, weighted by kind and timeframe", () => {
  // The daily Camarilla set and both pivot ranges appear in every snapshot: they count once.
  const snapshots = { "60": snap("60", { "60": camarilla(4040), D: camarilla(4080) }), "15": snap("15", { "15": camarilla(4041), D: camarilla(4080) }) };
  const d1 = [{ high: 4090, low: 4010, close: 4050 }];
  const w1 = [{ high: 4120, low: 3950, close: 4050 }];
  const raw = rawLevels({ snapshots, bars: { D1: d1, W1: w1 }, price: 4045, atrH1: 10 });
  assert.equal(raw.filter((l) => l.label === "daily Camarilla H4").length, 1);
  assert.equal(raw.filter((l) => l.label === "daily pivot").length, 1);
  assert.equal(raw.find((l) => l.label === "daily Camarilla H4").weight, 2.5, "H4 1.0 x daily 2.5");
  assert.equal(raw.find((l) => l.label === "15m Camarilla L3").weight, 0.6);
  assert.ok(raw.some((l) => l.label === "previous day high" && l.price === 4090));
  assert.ok(raw.some((l) => l.label === "previous week low" && l.price === 3950 && l.weight === 3));
  assert.ok(raw.some((l) => l.label === "round 4050" && l.weight === 0.8) && raw.some((l) => l.label === "round 4025" && l.weight === 0.4));
  assert.ok(!raw.some((l) => l.label === "round 4100"), "round numbers only within four 1H ranges");
  assert.ok(raw.some((l) => l.label === "1H point of control") && raw.some((l) => l.label === "15m point of control"), "each chart's value area");
  assert.ok(raw.every((l, i) => i === 0 || l.price >= raw[i - 1].price));
  assert.equal(TF_WEIGHT.W, 3);
});

test("one value per Camarilla level and pivot: the freshest snapshot wins, a stale daily set never doubles", () => {
  // Production 2026-11-06 23:56: "daily Camarilla L3 / daily Camarilla L3": the D1 snapshot still
  // held the 5 November set ("1D") beside the current one ("D") and both counted as sources.
  const h1 = { ...snap("60", { "60": camarilla(4040), D: camarilla(4080) }), computed_at: "2026-11-06T23:00:40Z" };
  const d1 = { ...snap("1D", { "1D": camarilla(3990), "240": camarilla(4000) }), computed_at: "2026-11-05T22:01:00Z" };
  d1.huds.chronos_matrix = { fields: { daily_cpr: { pivot: 3980, tc: 3985, bc: 3975 } } };
  const raw = rawLevels({ snapshots: { "1D": d1, "60": h1 } });
  const daily = raw.filter((l) => l.label === "daily Camarilla L3");
  assert.equal(daily.length, 1);
  assert.equal(daily[0].price, 4078, "the current daily set (base 4080 - 2), not the stale one");
  assert.deepEqual(raw.filter((l) => l.label === "daily pivot").map((l) => l.price), [4020], "the fresh pivot");
  assert.equal(raw.filter((l) => l.label === "4H Camarilla L3").length, 1, "the stale D1 snapshot's 4H set is the only one here");
});

test("a candidate needs three sources and at least medium strength (owner decision 2026-11-06)", () => {
  const lv = (price, kind, tf, label, weight) => ({ price, kind, tf, label, weight });
  assert.deepEqual([CANDIDATE_MIN_SOURCES, CANDIDATE_MIN_SCORE], [3, 3]);
  const [twoStrong, threeWeak, threeMedium] = clusterLevels([
    lv(100, "previous", "W", "previous week high", 3), lv(100.5, "camarilla", "D", "daily Camarilla H4", 2.5),
    lv(110, "camarilla", "60", "1H Camarilla H3", 0.9), lv(110.5, "camarilla", "15", "15m Camarilla H3", 0.6), lv(111, "round", "15", "round 110", 0.8),
    lv(120, "camarilla", "60", "1H Camarilla H4", 1.5), lv(120.5, "pivot", "D", "daily pivot", 2.5), lv(121, "round", "15", "round 120", 0.8)
  ], 2, 105);
  assert.equal(twoStrong.strength, "medium");
  assert.equal(twoStrong.candidate, false, "two sources are not enough, however heavy");
  assert.equal(threeWeak.candidate, false, "three sources, score 2.3: weak");
  assert.equal(threeMedium.candidate, true, "three sources, score 4.8");
});

test("stacked levels form a zone; enough independent sources make it a candidate, the score its strength", () => {
  const lv = (price, kind, tf, label, weight) => ({ price, kind, tf, label, weight });
  const zones = clusterLevels([
    lv(4030, "value", "60", "1H value area low", 1.2), lv(4031, "swing", "15", "15m swing low", 0.9), lv(4031.5, "camarilla", "D", "daily Camarilla L4", 2.5), lv(4032, "previous", "D", "previous day low", 2.5),
    lv(4045, "camarilla", "60", "1H Camarilla H3", 0.9), lv(4046, "camarilla", "60", "1H Camarilla H4", 1.5),
    lv(4060, "round", "15", "round 4060", 0.4)
  ], 3, 4040);
  assert.equal(zones.length, 3);
  const [support, mid, top] = zones;
  assert.deepEqual([support.low, support.high], [4030, 4032]);
  assert.equal(support.sources, 4);
  assert.equal(support.candidate, true);
  assert.equal(support.strength, "strong", "score 7.1");
  assert.equal(support.role, "support");
  assert.match(support.label, /^daily Camarilla L4 \/ previous day low \/ 1H value area low \+1$/);
  assert.equal(mid.sources, 1, "two Camarilla levels of one chart are one source");
  assert.equal(mid.candidate, false);
  assert.equal(mid.role, "resistance");
  assert.equal(top.strength, "weak");
});

test("the agent's reading: zones near price, candidates, and a plain summary", () => {
  const snapshots = { "60": snap("60", { "60": camarilla(4040), D: camarilla(4080) }), "15": snap("15", { "15": camarilla(4041) }) };
  const r = buildKeyLevels({ snapshots, bars: { D1: [{ high: 4090, low: 4031, close: 4050 }] }, price: 4045, atrH1: 10 });
  assert.equal(r.tolerance, 3);
  assert.ok(r.raw_count > 20);
  assert.ok(r.candidates.length >= 2);
  assert.ok(r.candidates.every((z) => z.sources >= 2));
  assert.ok(r.zones.every((z) => Math.abs(z.price - 4045) <= 40), "within four 1H ranges");
  assert.match(r.summary, /Nearest candidate support .*sources/);
  assert.match(r.summary, /Nearest candidate resistance/);
  const empty = buildKeyLevels({});
  assert.deepEqual(empty.zones, []);
  assert.equal(empty.summary, "No price yet.");
});

test("P6: each chart's order blocks and Supertrend line are key levels", () => {
  const s = snap("60", { "60": camarilla(4040) }, {
    order_blocks: { fields: { bull_top: 4012, bull_bottom: 4006, bear_top: 4090, bear_bottom: 4084 } },
    supertrend: { fields: { direction: 1, line: 4018.5 } }
  });
  const raw = rawLevels({ snapshots: { "60": s } });
  const ob = raw.filter((l) => l.kind === "order block");
  assert.deepEqual(ob.map((l) => l.label), ["1H bullish order block bottom", "1H bullish order block top", "1H bearish order block bottom", "1H bearish order block top"]);
  assert.equal(ob[0].weight, 1.05, "0.7 x 1H 1.5");
  assert.deepEqual(raw.filter((l) => l.kind === "supertrend").map((l) => [l.label, l.price, l.weight]), [["1H Supertrend line", 4018.5, 0.9]]);
});
