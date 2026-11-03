import test from "node:test";
import assert from "node:assert/strict";
import { buildH1LocalCalculations, prophetR38TEnc, prophetConsensusDir, webhookCandleKey } from "../src/h1-producer.mjs";
import { validateLocalCalculation, containsCredentialFields } from "../../../src/evidence-fusion.mjs";
import { compareWithWebhooks, identityOf, PARITY_FIELDS } from "../../../src/parity-registry.mjs";

const HOUR = 3600_000;
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
const now = Date.parse("2026-11-03T10:03:00Z");
const lastH1Open = Date.parse("2026-11-03T09:00:00Z");
function bundle() {
  return {
    timeframes: {
      H1: { candles: series(1000, 60, lastH1Open) },
      M15: { candles: series(2000, 15, lastH1Open + 45 * 60_000) },
      H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) },
      D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) },
      W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
    }
  };
}

test("candle_key matches the AI Worker's webhook derivation (tickerid:timeframe.period:time ms)", () => {
  const built = buildH1LocalCalculations(bundle(), { now });
  assert.equal(built.candle_key, webhookCandleKey(lastH1Open));
  assert.equal(built.candle_key, `OANDA:XAUUSD:60:${lastH1Open}`);
  assert.equal(built.candle_time, "2026-11-03T09:00:00.000Z");
  assert.deepEqual(built.records.map((r) => r.engine), ["mizan", "prophet", "gmi"]);
  assert.equal(built.gmi_error, null);
});

test("records satisfy the local-calculation contract, carry no credential fields, and have registry identities", () => {
  const built = buildH1LocalCalculations(bundle(), { now });
  for (const record of built.records) {
    const v = validateLocalCalculation(record, { symbol: record.symbol, timeframe: record.timeframe, candle_key: record.candle_key, candle_time: record.candle_time }, now);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.equal(containsCredentialFields(record), false);
    assert.ok(identityOf(record), record.engine);
  }
  const prophet = identityOf(built.records[1]);
  const mizan = identityOf(built.records[0]);
  assert.equal(prophet.mizanSourceHash, mizan.sourceHash);
  assert.equal(prophet.mizanImplementationHash, mizan.implementationHash);
});

test("prophet supplies every parity field, so identical webhooks compare as a full match", () => {
  const built = buildH1LocalCalculations(bundle(), { now });
  const prophet = built.records[1];
  const webhooks = {};
  for (const source of Object.keys(PARITY_FIELDS.prophet)) {
    for (const field of PARITY_FIELDS.prophet[source]) assert.ok(field in prophet.values.comparable[source], `${source}.${field}`);
    webhooks[source] = { ...prophet.values.candle, ...prophet.values.comparable[source] };
  }
  const result = compareWithWebhooks(prophet, webhooks);
  assert.equal(result.status, "match", JSON.stringify(result));
  webhooks.prophet_r38 = { ...webhooks.prophet_r38, t_enc: webhooks.prophet_r38.t_enc + 1 };
  assert.equal(compareWithWebhooks(prophet, webhooks).status, "mismatch");
});

test("refuses short history and still-forming bars instead of guessing", () => {
  const short = bundle();
  short.timeframes.H1.candles = short.timeframes.H1.candles.slice(-100);
  assert.throws(() => buildH1LocalCalculations(short, { now }), /insufficient H1 history/);
  assert.throws(() => buildH1LocalCalculations(bundle(), { now: lastH1Open + HOUR - 1 }), /not closed/);
});

test("R38 t_enc follows the non-legacy Pine precedence", () => {
  const base = { dEnc: 0, bEnc: 0, proFast: 0, zScore: 0, hurst: 0.5, inten: 0, kaufmanEr: 0, volAnom: 1 };
  assert.equal(prophetR38TEnc({ ...base, dEnc: 3, hurst: 0.7, zScore: 1.2 }), 5);
  assert.equal(prophetR38TEnc({ ...base, dEnc: 3, hurst: 0.7, zScore: 0.5 }), 4);
  assert.equal(prophetR38TEnc({ ...base, dEnc: 3, proFast: 0.9 }), 4); // d_enc==3 wins over price discovery
  assert.equal(prophetR38TEnc({ ...base, proFast: 0.45 }), 6);
  assert.equal(prophetR38TEnc({ ...base, proFast: -0.45 }), -6);
  assert.equal(prophetR38TEnc({ ...base, dEnc: -3 }), 1);
  assert.equal(prophetR38TEnc({ ...base, inten: 3, kaufmanEr: 0.6, hurst: 0.7 }), 1);
  assert.equal(prophetR38TEnc({ ...base, inten: -3, kaufmanEr: 0.6, hurst: 0.7 }), -1);
  assert.equal(prophetR38TEnc({ ...base, inten: 3, kaufmanEr: 0.6 }), 0);
  assert.equal(prophetR38TEnc({ ...base, bEnc: -3 }), 3);
  assert.equal(prophetR38TEnc({ ...base, bEnc: 3, hurst: 0.7 }), 0);
  assert.equal(prophetR38TEnc({ ...base, hurst: null, bEnc: 3 }), 3); // na hurst -> not strong trend
});

test("GMI r10_prophet_consensus_dir: internal conflict forces neutral", () => {
  assert.equal(prophetConsensusDir({ proFast: 0.2, dEnc: 0, subtype: 0 }), 1);
  assert.equal(prophetConsensusDir({ proFast: 0, dEnc: -1, subtype: 0 }), -1);
  assert.equal(prophetConsensusDir({ proFast: 0.2, dEnc: 0, subtype: 1 }), 0);
  assert.equal(prophetConsensusDir({ proFast: -0.2, dEnc: 0, subtype: 4 }), -1);
  assert.equal(prophetConsensusDir({ proFast: null, dEnc: 0, subtype: 2 }), 1);
});

test("gmi record supplies every gmi_v12_70 parity field and declares the same Mizan dependency", () => {
  const built = buildH1LocalCalculations(bundle(), { now });
  const gmi = built.records.find((r) => r.engine === "gmi");
  const v = validateLocalCalculation(gmi, { symbol: gmi.symbol, timeframe: gmi.timeframe, candle_key: gmi.candle_key, candle_time: gmi.candle_time }, now);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  for (const field of PARITY_FIELDS.gmi.gmi_v12_70) assert.ok(field in gmi.values.comparable.gmi_v12_70, field);
  const webhooks = { gmi_v12_70: { ...gmi.values.candle, ...gmi.values.comparable.gmi_v12_70 } };
  assert.equal(compareWithWebhooks(gmi, webhooks).status, "match");
  assert.equal(identityOf(gmi).mizanSourceHash, identityOf(built.records[0]).sourceHash);
  // GMI and Prophet share the GMI-embedded prophet consensus direction.
  assert.equal(gmi.values.comparable.gmi_v12_70.prophet_dir, built.records[1].values.comparable.prophet_r37_ssot.direction);
});

test("gmi is omitted (not faked) when chart history is below the 300-bar profile lookback", () => {
  const short = bundle();
  short.timeframes.H1.candles = short.timeframes.H1.candles.slice(-200);
  const built = buildH1LocalCalculations(short, { now });
  assert.deepEqual(built.records.map((r) => r.engine), ["mizan", "prophet"]);
  assert.equal(built.gmi_error, "insufficient_chart_history");
});
