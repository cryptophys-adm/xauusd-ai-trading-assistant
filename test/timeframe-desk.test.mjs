import test from "node:test";
import assert from "node:assert/strict";
import { chartDeskReading, chartDeskLabel } from "../src/timeframe-desk.mjs";

const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async (k) => (m.has(k) ? m.get(k) : null) }; };
const KEY = "OANDA:XAUUSD:240:1793937600000";
const prophet = { values: { comparable: { prophet_r38: { direction: 1, buy_confirmed: true, sell_confirmed: false, t_enc: 0, d_enc: 1 }, prophet_r37_ssot: { d_enc: 0, b_enc: 1 } } } };
const gmi = { values: { comparable: { gmi_v12_70: { verdict: 2, gate: 1, gmi_dir: 1, prophet_dir: 1, conflict: false } } } };

test("a chart desk reads the approved local records of its bar in plain language", async () => {
  const env = { WEBHOOK_BUFFER: kv({ [`localcalc:${KEY}:prophet`]: JSON.stringify(prophet), [`localcalc:${KEY}:gmi`]: JSON.stringify(gmi) }) };
  const r = await chartDeskReading(env, KEY);
  assert.equal(r.available, true);
  assert.equal(r.approved_by_parity, true);
  assert.ok(r.reading.length >= 2, "one sentence per engine plus the overall read");
  assert.ok(r.reading.every((s) => typeof s === "string" && !/_/.test(s)), "plain language, no field names");
  assert.equal(r.buy_confirmed, true);
  assert.equal(chartDeskLabel("4H", r), "parity-approved 4H chain");
});

test("observed records that parity has not approved are read, but labelled so", async () => {
  const env = { WEBHOOK_BUFFER: kv({ [`localcalc-observed:${KEY}:prophet`]: JSON.stringify(prophet) }) };
  const r = await chartDeskReading(env, KEY);
  assert.equal(r.available, true);
  assert.equal(r.approved_by_parity, false);
  assert.equal(chartDeskLabel("D1", r), "D1 local records, not parity approved");
});

test("no record at all means no desk, never an invented reading", async () => {
  const r = await chartDeskReading({ WEBHOOK_BUFFER: kv() }, KEY);
  assert.equal(r.available, false);
  assert.deepEqual(r.reading, []);
  assert.equal((await chartDeskReading({}, KEY)).available, false);
});
