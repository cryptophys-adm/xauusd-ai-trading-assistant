import test from "node:test";
import assert from "node:assert/strict";
import { rmaAtr, supertrendSeries, supertrendFields, SUPERTREND_DEFAULTS } from "../src/supertrend.mjs";

const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

test("P6: ta.supertrend defaults are factor 3 and ATR 10 (TradingView)", () => {
  assert.deepEqual({ ...SUPERTREND_DEFAULTS }, { factor: 3, atrPeriod: 10 });
});

test("Wilder ATR: seeded with the mean of the first period true ranges, then RMA", () => {
  const bars = [bar(10, 12, 9, 11), bar(11, 13, 10, 12), bar(12, 15, 11, 14), bar(14, 14.5, 12, 13)];
  const atr = rmaAtr(bars, 3);
  assert.deepEqual(atr.slice(0, 2), [null, null]);
  // TR: 3, 3 (13-10 vs |13-11|, |10-11|), 4 (15-11 vs |15-12|, |11-12|) -> seed 10/3; next TR 2.5 (|12-14|... 14.5-12=2.5, |14.5-14|, |12-14|=2) -> (10/3*2+2.5)/3
  assert.equal(atr[2], 10 / 3);
  assert.equal(atr[3], ((10 / 3) * 2 + 2.5) / 3);
});

test("the direction starts bearish (TradingView 1), turns bullish when close crosses the upper band, and the bands ratchet", () => {
  // A flat base, then a strong rally: the trend must flip bullish and the line must sit below price.
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(bar(100, 101, 99, 100));
  for (let i = 0; i < 10; i++) { const p = 100 + (i + 1) * 3; bars.push(bar(p - 3, p + 0.5, p - 3.5, p)); }
  const s = supertrendSeries(bars, { factor: 3, atrPeriod: 10 });
  assert.equal(s[9].direction, -1, "the first bar with an ATR is bearish (TradingView direction 1)");
  assert.equal(s.at(-1).direction, 1);
  assert.ok(s.at(-1).line < bars.at(-1).close);
  // In an uptrend the lower band never falls.
  for (let i = s.length - 5; i < s.length; i++) if (s[i - 1].direction === 1 && s[i].direction === 1) assert.ok(s[i].line >= s[i - 1].line);
  const f = supertrendFields(bars);
  assert.equal(f.direction, 1);
  assert.ok(f.distance_atr > 0);
  assert.equal(typeof f.flipped, "boolean");
  assert.ok(f.bars_since_flip >= 0);
  assert.equal(supertrendFields(bars.slice(0, 5)), null, "no ATR yet: no reading");
});
