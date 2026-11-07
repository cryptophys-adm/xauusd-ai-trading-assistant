import test from "node:test";
import assert from "node:assert/strict";
import { buildGmiHudRecord, GMI_HUD_FIELDS } from "../src/gmi-hud-producer.mjs";
import { gridBotFields, DEPLOY_STATUS_CODE } from "../src/grid-bot.mjs";
import { ENGINE_PROVENANCE } from "../src/provenance.generated.mjs";
import { PARITY_FIELDS, identityOf } from "../../../src/parity-registry.mjs";
import { validateLocalCalculation, LOCAL_ENGINES } from "../../../src/evidence-fusion.mjs";

function h1Bars(n = 300) {
  const out = [];
  let p = 4000;
  const start = Date.parse("2026-10-20T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const o = p, c = p + Math.sin(i / 5) * 3 + (i % 7 === 0 ? -4 : 1.2);
    out.push({ open_time: new Date(start + i * 3600000).toISOString(), close_time: new Date(start + (i + 1) * 3600000).toISOString(), open: o, high: Math.max(o, c) + 1.5, low: Math.min(o, c) - 1.1, close: c, volume: 1000 + i });
    p = c;
  }
  return out;
}

function builtFor(bars, entropy = 0.62) {
  const last = bars.at(-1), openMs = Date.parse(last.open_time);
  const gmi = {
    schema_version: "cryptophys.local-calculation.v1", symbol: "OANDA:XAUUSD", timeframe: "60",
    candle_key: "OANDA:XAUUSD:60:" + openMs, candle_time: last.open_time, computed_at: last.close_time, engine: "gmi",
    values: { candle: { o: last.open, h: last.high, l: last.low, c: last.close, volume: last.volume }, comparable: { gmi_v12_70: { verdict: 2, gate: 1, gmi_dir: 1, prophet_dir: 1, conflict: false } }, diagnostics: { entropy } },
    provenance: { dependencies: { mizan: { source_hash: "a".repeat(64), implementation_hash: "b".repeat(64) } } }
  };
  return { candle_key: gmi.candle_key, records: [gmi] };
}

test("buildGmiHudRecord repeats the GMI fields and adds the Grid Bot fields of the same closed H1 bars", () => {
  const bars = h1Bars();
  const built = builtFor(bars);
  const record = buildGmiHudRecord(built, { timeframes: { H1: { candles: bars } } });
  assert.equal(record.engine, "gmi_hud");
  assert.equal(record.candle_key, built.candle_key);
  const c = record.values.comparable.gmi_v12_70_hud;
  assert.deepEqual(Object.keys(c).sort(), [...GMI_HUD_FIELDS].sort());
  assert.deepEqual(Object.keys(c).sort(), [...PARITY_FIELDS.gmi_hud.gmi_v12_70_hud].sort(), "the record carries every parity field");
  const grid = gridBotFields(bars, { entropy: 0.62 });
  assert.equal(c.cshi_viability, grid.cshi_viability);
  assert.equal(c.deploy_status, DEPLOY_STATUS_CODE[grid.deploy_status]);
  assert.equal(c.verdict, 2);
  assert.equal(record.provenance.source_hash, ENGINE_PROVENANCE.gmi_hud.source_hash);
  assert.notEqual(ENGINE_PROVENANCE.gmi_hud.implementation_hash, ENGINE_PROVENANCE.gmi.implementation_hash, "its own identity, not the approved gmi one");
  assert.equal(identityOf(record).engine, "gmi_hud");
  assert.ok(!LOCAL_ENGINES.includes("gmi_hud"), "never part of the decision lane");
  assert.equal(validateLocalCalculation(record, {}, Date.parse(record.computed_at)).errors.includes("unsupported_engine"), false);
});

test("buildGmiHudRecord is null without the gmi record, its entropy, or bars ending at the candle", () => {
  const bars = h1Bars();
  assert.equal(buildGmiHudRecord({ records: [] }, { timeframes: { H1: { candles: bars } } }), null);
  assert.equal(buildGmiHudRecord(builtFor(bars, null), { timeframes: { H1: { candles: bars } } }), null);
  assert.equal(buildGmiHudRecord(builtFor(bars), { timeframes: { H1: { candles: bars.slice(0, -1) } } }), null);
});

test("cshi_viability is a whole percent without float noise; the deploy status codes follow GMI's chain", () => {
  const g = gridBotFields(h1Bars(), { entropy: 0.5 });
  assert.equal(g.cshi_viability, Math.round(g.cshi_viability));
  assert.deepEqual(DEPLOY_STATUS_CODE, { muddy_waters_on: 1, toxic_chop_off: 2, optimal_on: 3, trending_off: 4 });
});
