import test from "node:test";
import assert from "node:assert/strict";
import { m5ContextFromRecords } from "../src/m5-context.mjs";

const T0 = Date.parse("2026-11-05T13:00:00.000Z");
const bars = Array.from({ length: 20 }, (_, i) => ({
  open_time: new Date(T0 + i * 300_000).toISOString(), close_time: new Date(T0 + (i + 1) * 300_000).toISOString(),
  open: 4000 + i, high: 4002 + i, low: 3999 + i, close: 4001 + i, volume: 10 + i
}));
const last = bars.at(-1);
const built = {
  candle_key: "OANDA:XAUUSD:5:" + Date.parse(last.open_time),
  candle_time: last.open_time,
  records: [
    { engine: "mizan", values: { comparable: {} } },
    { engine: "prophet", symbol: "OANDA:XAUUSD", values: { bias: "BEARISH", comparable: { prophet_r38: { buy_confirmed: false, sell_confirmed: true, d_enc: -1, t_enc: 3 } } } }
  ]
};

test("the 5m context reshapes the bar's prophet parity record", () => {
  const c = m5ContextFromRecords(built, bars);
  assert.equal(c.schema_version, "cryptophys.local-context.v1");
  assert.equal(c.trust_status, "informational_unverified", "verification is decided by the AI Worker, never by the producer");
  assert.equal(c.candle_key, built.candle_key);
  assert.equal(c.candle_time, last.close_time);
  assert.deepEqual([c.bias, c.buy_confirmed, c.sell_confirmed, c.d_enc, c.t_enc], ["BEARISH", false, true, -1, 3]);
  assert.equal(c.recent_bars.length, 12);
  assert.deepEqual(c.recent_bars.at(-1), { t: last.close_time, o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume });
});

test("no context without the prophet record or for another bar", () => {
  assert.equal(m5ContextFromRecords({ ...built, records: built.records.slice(0, 1) }, bars), null);
  assert.equal(m5ContextFromRecords(built, bars.slice(0, -1)), null);
  assert.equal(m5ContextFromRecords(null, bars), null);
});
