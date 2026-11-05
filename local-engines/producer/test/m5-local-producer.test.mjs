import test from "node:test";
import assert from "node:assert/strict";
import { buildM5LocalCalculations, m5WebhookCandleKey } from "../src/m5-local-producer.mjs";
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
const lastM5Open = Date.parse("2026-11-03T09:20:00Z");
const now = lastM5Open + 5 * 60_000 + 20_000;
function bundle(m5Count = 1000) {
  return {
    timeframes: {
      M5: { candles: series(m5Count, 5, lastM5Open) },
      M1: { candles: series(3000, 1, lastM5Open + 4 * 60_000) },
      M15: { candles: series(2000, 15, Date.parse("2026-11-03T09:00:00Z")) },
      H1: { candles: series(1000, 60, Date.parse("2026-11-03T08:00:00Z")) },
      H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) },
      D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) },
      W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
    }
  };
}

test("5m records are keyed like the 5m webhook and carry timeframe 5", () => {
  const built = buildM5LocalCalculations(bundle(), { now });
  assert.equal(built.candle_key, `OANDA:XAUUSD:5:${lastM5Open}`);
  assert.equal(built.candle_key, m5WebhookCandleKey(lastM5Open));
  assert.deepEqual(built.records.map((r) => r.engine), ["mizan", "prophet", "gmi"]);
  assert.equal(built.gmi_error, null);
  for (const record of built.records) {
    assert.equal(record.timeframe, "5");
    assert.equal(record.candle_key, built.candle_key);
  }
});

test("5m records satisfy the contract and get timeframe-scoped registry ids, never the H1 ones", () => {
  const built = buildM5LocalCalculations(bundle(), { now });
  for (const record of built.records) {
    const v = validateLocalCalculation(record, { symbol: "OANDA:XAUUSD", timeframe: "5", candle_key: built.candle_key, candle_time: built.candle_time }, now);
    assert.equal(v.valid, true, record.engine + " " + JSON.stringify(v.errors));
    assert.equal(containsCredentialFields(record), false);
  }
  const ids = Object.fromEntries(built.records.map((r) => [r.engine, identityOf(r)]));
  assert.equal(ids.mizan.engine, "mizan_m5");
  assert.equal(ids.prophet.engine, "prophet_m5");
  assert.equal(ids.gmi.engine, "gmi_m5");
  assert.equal(ids.prophet.implementationHash, ENGINE_PROVENANCE.prophet_m5.implementation_hash);
  assert.equal(ids.gmi.implementationHash, ENGINE_PROVENANCE.gmi_m5.implementation_hash);
  assert.notEqual(ids.prophet.implementationHash, ENGINE_PROVENANCE.prophet.implementation_hash);
  assert.notEqual(ids.gmi.implementationHash, ENGINE_PROVENANCE.gmi.implementation_hash);
  assert.equal(ids.prophet.mizanImplementationHash, ENGINE_PROVENANCE.mizan.implementation_hash);
});

test("5m records carry every webhook parity field, so a matching webhook compares as match", () => {
  const built = buildM5LocalCalculations(bundle(), { now });
  for (const record of built.records.filter((r) => PARITY_FIELDS[r.engine])) {
    const webhooks = Object.fromEntries(Object.entries(record.values.comparable).map(([source, fields]) => [source, { ...record.values.candle, ...fields }]));
    assert.equal(compareWithWebhooks(record, webhooks).status, "match", record.engine);
    for (const [source, fields] of Object.entries(PARITY_FIELDS[record.engine])) {
      for (const field of fields) assert.ok(field in record.values.comparable[source], `${record.engine}.${source}.${field}`);
    }
  }
});

test("5m producer refuses short history and a bar that has not closed", () => {
  assert.throws(() => buildM5LocalCalculations(bundle(100), { now }), /insufficient 5m history/);
  assert.throws(() => buildM5LocalCalculations(bundle(), { now: lastM5Open + 60_000 }), /not closed/);
});
