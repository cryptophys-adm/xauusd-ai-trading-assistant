import test from "node:test";
import assert from "node:assert/strict";
import { cshiSeries, gridBotFields, DEPLOY_STATUS, DEPLOY_STATUS_CODE } from "../src/grid-bot.mjs";

const bars = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("Grid Bot Protocol: the CSHI percent rank is 50 until 100 viability scores exist, as nz(ta.percentrank(., 100), 50)", () => {
  const b = bars(60, (i) => ({ open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
  const { grid, viability } = cshiSeries(b);
  assert.ok(grid.every((g) => g === 50));
  assert.ok(viability.slice(-10).every((v) => Number.isFinite(v)));
});

test("deploy status follows GMI: muddy waters with high entropy, toxic above 85, optimal 50 to 85, else trending", () => {
  // A long quiet base then a burst of large, full-bodied bars: the last viability ranks at the top (toxic).
  const base = bars(150, (i) => ({ open: 100, high: 100.6 + (i % 3) * 0.1, low: 99.4, close: 100 + ((i % 2) ? 0.2 : -0.2) }));
  const burst = bars(5, (i) => ({ open: 100 + i * 4, high: 104 + i * 4, low: 100 + i * 4, close: 104 + i * 4 }));
  const toxic = gridBotFields([...base, ...burst], { entropy: 0.5 });
  assert.equal(toxic.deploy_status, "toxic_chop_off");
  assert.ok(toxic.cshi_viability > 85);
  assert.equal(toxic.grid_viable, false);
  const quiet = gridBotFields(base, { entropy: 0.9 });
  assert.ok(DEPLOY_STATUS.includes(quiet.deploy_status));
  if (quiet.cshi_viability >= 45 && quiet.cshi_viability <= 85) assert.equal(quiet.deploy_status, "muddy_waters_on");
  assert.equal(gridBotFields(base, {}), null, "no GMI entropy: no reading");
});

// Moved from gmi-hud-producer.test.mjs when S4 (2026-11-28) retired the gmi_hud producer; grid-bot.mjs stays (hud-snapshot.mjs).
test("cshi_viability is a whole percent without float noise; the deploy status codes follow GMI's chain", () => {
  const start = Date.parse("2026-10-20T00:00:00Z");
  let p = 4000;
  const h1 = bars(300, (i) => {
    const o = p, c = p + Math.sin(i / 5) * 3 + (i % 7 === 0 ? -4 : 1.2);
    p = c;
    return { open_time: new Date(start + i * 3600000).toISOString(), close_time: new Date(start + (i + 1) * 3600000).toISOString(), open: o, high: Math.max(o, c) + 1.5, low: Math.min(o, c) - 1.1, close: c, volume: 1000 + i };
  });
  const g = gridBotFields(h1, { entropy: 0.5 });
  assert.equal(g.cshi_viability, Math.round(g.cshi_viability));
  assert.deepEqual(DEPLOY_STATUS_CODE, { muddy_waters_on: 1, toxic_chop_off: 2, optimal_on: 3, trending_off: 4 });
});
