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

test("the setup state of the record reaches the desk: READY after the one-bar event (backlog item 16)", async () => {
  const later = { values: { comparable: { prophet_r38: { direction: 0, buy_confirmed: false, sell_confirmed: false, t_enc: 0, d_enc: 1 }, prophet_r37_ssot: { d_enc: 1, b_enc: 1 } },
    setup: { buy_ready: true, sell_ready: false, buy_pass_age: 1, confirmation_window: 3, superseded_by_trend: null, instruction: "BUY_READY" } } };
  const env = { WEBHOOK_BUFFER: kv({ [`localcalc:${KEY}:prophet`]: JSON.stringify(later) }) };
  const r = await chartDeskReading(env, KEY);
  assert.deepEqual([r.buy_confirmed, r.buy_setup_ready, r.sell_setup_ready], [false, true, false]);
  assert.ok(r.reading.some((s) => /BUY setup is still READY: the confirmation passed 1 bar ago/.test(s)), r.reading.join(" | "));
  const plain = await chartDeskReading({ WEBHOOK_BUFFER: kv({ [`localcalc:${KEY}:prophet`]: JSON.stringify(prophet) }) }, KEY);
  assert.deepEqual([plain.buy_setup_ready, plain.sell_setup_ready], [false, false], "no setup in the record: no READY");
});

test("no record at all means no desk, never an invented reading", async () => {
  const r = await chartDeskReading({ WEBHOOK_BUFFER: kv() }, KEY);
  assert.equal(r.available, false);
  assert.deepEqual(r.reading, []);
  assert.equal((await chartDeskReading({}, KEY)).available, false);
});
