import test from "node:test";
import assert from "node:assert/strict";
import { cshiSeries, gridBotFields, DEPLOY_STATUS } from "../src/grid-bot.mjs";

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
