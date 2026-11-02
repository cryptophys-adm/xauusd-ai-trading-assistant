import test from "node:test";
import assert from "node:assert/strict";
import { calculateProphetR38Core } from "../src/core.mjs";

function makeBars(count = 500) {
  const bars = [];
  let close = 2400;
  for (let i = 0; i < count; i++) {
    const delta = Math.sin(i / 7) * 0.7 + Math.cos(i / 17) * 0.3 + 0.015;
    const open = close;
    close = close + delta;
    bars.push({
      open_time: new Date(Date.UTC(2026, 0, 1) + i * 300000).toISOString(),
      close_time: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 300000).toISOString(),
      open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.2,
      close, volume: 100 + (i % 23) * 3, confirmed: true
    });
  }
  return bars;
}

test("Prophet R38 partial core emits source-derived sensors and preserves input order", () => {
  const bars = makeBars();
  const result = calculateProphetR38Core(bars);
  assert.equal(result.schema_version, "cryptophys.prophet-r38-core.v1");
  assert.equal(result.source.declared_version, "The Prophet v7.02 R38");
  assert.equal(result.outputs.length, bars.length);
  assert.equal(result.outputs[0].index, 0);
  assert.equal(result.outputs.at(-1).index, bars.length - 1);
  assert.equal(result.outputs.at(-1).calculation_scope, "R38_SOURCE_DERIVED_OSCILLATOR_PARTIAL");
  assert.equal(result.outputs.at(-1).trusted_evidence_allowed, false);
  assert.equal(result.outputs.at(-1).parity_status, "not_proven");
});

test("Prophet R38 partial core has warm-up nulls then finite oscillator values", () => {
  const result = calculateProphetR38Core(makeBars(500));
  const oscillator = result.outputs.map(x => x.oscillator.fast);
  assert.ok(oscillator.slice(0, 100).some(x => x === null));
  assert.ok(oscillator.slice(200).some(x => Number.isFinite(x)));
  assert.ok(result.outputs.slice(200).every(x => Number.isFinite(x.sensors.kww_zscore_50)));
  assert.ok(result.outputs.slice(200).every(x => Number.isFinite(x.sensors.hurst_rs_100)));
});

test("Prophet R38 partial core does not invent volume and records volume absence", () => {
  const bars = makeBars(300).map(({ volume, ...bar }) => bar);
  const result = calculateProphetR38Core(bars);
  assert.equal(result.has_volume, false);
  assert.ok(result.outputs.every(x => x.sensors.volume_ratio_20 === 1));
  assert.ok(result.outputs.every(x => x.trusted_evidence_allowed === false));
});

test("Prophet R38 partial core rejects invalid OHLC and out-of-order candles", () => {
  const invalid = makeBars(10);
  invalid[4] = { ...invalid[4], high: invalid[4].low - 1 };
  assert.throws(() => calculateProphetR38Core(invalid), /invalid OHLC/);
  const outOfOrder = makeBars(10);
  outOfOrder[8] = { ...outOfOrder[8], open_time: outOfOrder[1].open_time };
  assert.throws(() => calculateProphetR38Core(outOfOrder), /chronological/);
});
