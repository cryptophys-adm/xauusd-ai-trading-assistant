import test from "node:test";
import assert from "node:assert/strict";
import { buildM15LocalCalculations, m15WebhookCandleKey } from "../src/m15-local-producer.mjs";
import { ENGINE_PROVENANCE } from "../src/provenance.generated.mjs";
import { validateLocalCalculation, containsCredentialFields } from "../../../src/evidence-fusion.mjs";
import { compareWithWebhooks, identityOf, PARITY_FIELDS } from "../../../src/parity-registry.mjs";

function series(count, minutes, endOpenMs) {
  const step = minutes * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const openMs = endOpenMs - (count - 1 - i) * step;
    const open = 3900 + Math.sin(i / 9) * 15 + i * 0.02;
    const close = open + Math.sin(i / 3) * 3;
    return {
      time: openMs / 1000, open_time: new Date(openMs).toISOString(), close_time: new Date(openMs + step).toISOString(),
      open, high: Math.max(open, close) + 1.5, low: Math.min(open, close) - 1.2, close, volume: 1000 + (i % 17) * 40
    };
  });
}
const lastM15Open = Date.parse("2026-11-03T09:00:00Z");
const now = lastM15Open + 15 * 60_000 + 30_000;
function bundle(m15Count = 2000) {
  return {
    timeframes: {
      M5: { candles: series(1000, 5, lastM15Open + 10 * 60_000) },
      M1: { candles: series(3000, 1, lastM15Open + 14 * 60_000) },
      M15: { candles: series(m15Count, 15, lastM15Open) },
      H1: { candles: series(1000, 60, Date.parse("2026-11-03T08:00:00Z")) },
      H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) },
      D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) },
      W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
    }
  };
}

test("15m records are keyed like the 15m webhook and the 15m HUD snapshot, with timeframe 15", () => {
  const built = buildM15LocalCalculations(bundle(), { now });
  assert.equal(built.candle_key, `OANDA:XAUUSD:15:${lastM15Open}`);
  assert.equal(built.candle_key, m15WebhookCandleKey(lastM15Open));
  assert.deepEqual(built.records.map((r) => r.engine), ["mizan", "prophet", "gmi"]);
  assert.equal(built.gmi_error, null);
  assert.ok(built.records.every((r) => r.timeframe === "15" && r.candle_key === built.candle_key));
});

test("15m records get their own registry ids and hashes, never the H1 or 5m ones", () => {
  const built = buildM15LocalCalculations(bundle(), { now });
  for (const record of built.records) {
    const v = validateLocalCalculation(record, { symbol: "OANDA:XAUUSD", timeframe: "15", candle_key: built.candle_key, candle_time: built.candle_time }, now);
    assert.equal(v.valid, true, record.engine + " " + JSON.stringify(v.errors));
    assert.equal(containsCredentialFields(record), false);
  }
  const ids = Object.fromEntries(built.records.map((r) => [r.engine, identityOf(r)]));
  assert.deepEqual([ids.mizan.engine, ids.prophet.engine, ids.gmi.engine], ["mizan_m15", "prophet_m15", "gmi_m15"]);
  assert.equal(ids.prophet.implementationHash, ENGINE_PROVENANCE.prophet_m15.implementation_hash);
  assert.equal(ids.gmi.implementationHash, ENGINE_PROVENANCE.gmi_m15.implementation_hash);
  for (const other of ["prophet", "prophet_m5"]) assert.notEqual(ids.prophet.implementationHash, ENGINE_PROVENANCE[other].implementation_hash);
  for (const other of ["gmi", "gmi_m5"]) assert.notEqual(ids.gmi.implementationHash, ENGINE_PROVENANCE[other].implementation_hash);
});

test("15m records carry every webhook parity field, so a matching webhook compares as match", () => {
  const built = buildM15LocalCalculations(bundle(), { now });
  for (const record of built.records.filter((r) => PARITY_FIELDS[r.engine])) {
    const webhooks = Object.fromEntries(Object.entries(record.values.comparable).map(([source, fields]) => [source, { ...record.values.candle, ...fields }]));
    assert.equal(compareWithWebhooks(record, webhooks).status, "match", record.engine);
  }
});

test("15m producer refuses short history and a bar that has not closed", () => {
  assert.throws(() => buildM15LocalCalculations(bundle(100), { now }), /insufficient 15m history/);
  assert.throws(() => buildM15LocalCalculations(bundle(), { now: lastM15Open + 60_000 }), /not closed/);
});
