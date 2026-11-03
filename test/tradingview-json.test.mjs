import test from "node:test";
import assert from "node:assert/strict";
import { parseTradingViewJson, normalizeNonFiniteTokens } from "../src/tradingview-json.mjs";

// Shape of the real GMI v12.70 alert that TradingView delivered (secret redacted).
const gmiAlert = '{"v":1,"source":"gmi_v12_70","src":"gmi_v12_70","ticker":"OANDA:XAUUSD","symbol":"OANDA:XAUUSD","timeframe":"60","tf":"60","candle_time":"1793674800000","timestamp":"1793674800000","t":1793674800000,"o":3945.705,"h":3946.21,"l":3924.42,"c":3926.32,"volume":23530,"verdict":0,"gate":-1,"gmi_dir":0,"prophet_dir":1,"conflict":true,"shared_core_status":NaN,"secret":"REDACTED"}';

test("strict JSON passes through untouched", () => {
  assert.deepEqual(parseTradingViewJson('{"a":1,"b":"NaN"}'), { value: { a: 1, b: "NaN" }, normalized_tokens: 0 });
});

test("real GMI alert with shared_core_status:NaN parses, NaN -> null, other fields intact", () => {
  const { value, normalized_tokens } = parseTradingViewJson(gmiAlert);
  assert.equal(normalized_tokens, 1);
  assert.equal(value.shared_core_status, null);
  assert.equal(value.verdict, 0);
  assert.equal(value.conflict, true);
  assert.equal(value.candle_time, "1793674800000");
  assert.equal(value.c, 3926.32);
});

test("Prophet R37 structure_state:NaN, Infinity, -Infinity and arrays are normalized only at value positions", () => {
  const { value, normalized_tokens } = parseTradingViewJson('{"structure_state":NaN,"x":Infinity,"y":-Infinity,"arr":[1,NaN,2],"z" : NaN }');
  assert.equal(normalized_tokens, 5);
  assert.deepEqual(value, { structure_state: null, x: null, y: null, arr: [1, null, 2], z: null });
});

test("tokens inside strings (including escaped quotes) are never touched", () => {
  const { text, replaced } = normalizeNonFiniteTokens('{"msg":"NaN \\"Infinity\\" ok","v":NaN}');
  assert.equal(replaced, 1);
  assert.equal(JSON.parse(text).msg, 'NaN "Infinity" ok');
});

test("genuinely malformed JSON still fails", () => {
  assert.throws(() => parseTradingViewJson('{"a":NaNx}'));
  assert.throws(() => parseTradingViewJson('{"a":1'));
  assert.throws(() => parseTradingViewJson('{"NaN"NaN}'));
});
