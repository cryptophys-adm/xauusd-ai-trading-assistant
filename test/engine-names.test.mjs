import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENGINE_NAMES, engineLabel, engineName, engineTimeframe } from "../src/engine-names.mjs";
import { BASE_ENGINES } from "../src/parity-registry.mjs";

test("every registry engine id has a canonical label with its timeframe", () => {
  assert.deepEqual(Object.keys(ENGINE_NAMES).sort(), [...BASE_ENGINES].sort(), "one name per base engine");
  assert.equal(engineLabel("gmi_m15"), "GMI v12.70 15m (gmi_m15)");
  assert.equal(engineLabel("prophet"), "Prophet R38 + R37 1H (prophet)");
  assert.equal(engineLabel("prophet_hud_h4"), "Prophet HUD 4H (prophet_hud_h4)");
  assert.equal(engineLabel("mizan_d1"), "MizanLib D1 (mizan_d1)");
  assert.equal(engineName("gmi_hud_m5"), "GMI HUD");
  assert.equal(engineTimeframe("gmi_hud_m5"), "5m");
  assert.equal(engineName("unknown_m5"), "unknown", "an unknown id falls back to its base id");
});

test("the Nexus name map holds the same engine names", () => {
  const ts = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/names.ts", import.meta.url), "utf8");
  const block = ts.slice(ts.indexOf("export const ENGINES"));
  for (const [id, name] of Object.entries(ENGINE_NAMES)) assert.match(block, new RegExp(`\\b${id}: "${name.replace(/[.+]/g, "\\$&")}"`), `${id} -> ${name} in names.ts`);
});
