import test from "node:test";
import assert from "node:assert/strict";
import { asOf, pearson, buildCorrelations, readCorrelations, ASSETS, WINDOWS, closes } from "../src/correlations.mjs";

const H4 = 14_400_000, T0 = Date.parse("2026-10-01T00:00:00Z");
// Gold closes every 4h; deterministic noisy walk.
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const goldMoves = Array.from({ length: 200 }, () => rnd() * 0.01);
const gold = []; let g = 4000;
for (let i = 0; i < 200; i++) { g *= Math.exp(goldMoves[i]); gold.push({ t: T0 + (i + 1) * H4, close: g }); }
// Silver follows gold (same moves, 1h earlier closes), the dollar moves against it.
const shifted = (sign, base, offset) => { let v = base; return goldMoves.map((m, i) => { v *= Math.exp(sign * m + rnd() * 0.001); return { t: T0 + (i + 1) * H4 - offset, close: v }; }); };
const silver = shifted(1, 48, 3_600_000), dxy = shifted(-1, 100, 0);
const yields = (() => { let y = 4.2; return goldMoves.map((m, i) => { y += -m * 10 + rnd() * 0.001; return { t: T0 + (i + 1) * H4, close: y }; }); })();

test("as-of alignment takes the last close at or before each grid time, never older than one bar", () => {
  const series = [{ t: 10, close: 1 }, { t: 20, close: 2 }, { t: 40, close: 4 }];
  assert.deepEqual(asOf(series, [5, 10, 25, 34, 39, 45, 100], 15), [null, 1, 2, 2, null, 4, null], "34 is 14 after 20 (kept), 39 is 19 after it (too old)");
});

test("pearson: perfect, inverse, too few pairs", () => {
  const x = Array.from({ length: 20 }, (_, i) => i), y = x.map((v) => 2 * v + 1);
  assert.equal(pearson(x, y).r, 1);
  assert.equal(pearson(x, y.map((v) => -v)).r, -1);
  assert.deepEqual(pearson(x.slice(0, 5), y.slice(0, 5)), { r: null, n: 5 });
});

test("the panel: silver with gold, the dollar and the yield against it; changes in percent and basis points", () => {
  const spec = (id) => ASSETS.find((a) => a.id === id);
  const view = buildCorrelations({ gold, assets: [{ spec: spec("dxy"), series: dxy }, { spec: spec("us10y"), series: yields }, { spec: spec("silver"), series: silver }] });
  const row = (id) => view.assets.find((a) => a.id === id);
  assert.ok(row("silver").correlation.short > 0.9, "silver tracks gold even with 4h bars closing an hour earlier");
  assert.ok(row("dxy").correlation.long < -0.9);
  assert.ok(row("us10y").correlation.long < -0.9);
  assert.equal(row("silver").correlation.short_n, WINDOWS.short - 0);
  assert.equal(row("us10y").unit, "bp");
  const y = yields.map((p) => p.close);
  assert.equal(row("us10y").change["4h"], Math.round((y.at(-1) - y.at(-2)) * 1000) / 10, "the yield's change in basis points");
  assert.equal(typeof view.gold.change["1d"], "number");
  assert.match(view.note, /Context only/);
});

test("missing series read as unavailable; the reader uses the cached 4h series", async () => {
  const cache = { "market-data:v2:series:OANDA:XAUUSD|4h": { candles: gold.map((p) => ({ close: p.close, close_time: new Date(p.t).toISOString() })) } };
  const env = { SIGNAL_CACHE: { async get(k) { return cache[k] ? JSON.stringify(cache[k]) : null; } } };
  const view = await readCorrelations(env, { now: T0 + 300 * H4 });
  assert.equal(view.gold.last, gold.at(-1).close);
  assert.ok(view.assets.every((a) => a.available === false && a.correlation.short === null));
  assert.equal(closes({ candles: [{ close: 1, close_time: new Date(T0 + H4).toISOString() }] }, T0).length, 0, "a bar not closed yet is ignored");
});
