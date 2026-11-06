import test from "node:test";
import assert from "node:assert/strict";
import { buildKeyLevels, rawLevels, clusterLevels, swings, TF_WEIGHT } from "../src/key-level-agent.mjs";

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

test("stacked levels form a zone; two or more sources make it a candidate, the score its strength", () => {
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
