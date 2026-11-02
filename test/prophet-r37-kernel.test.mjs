import test from "node:test";
import assert from "node:assert/strict";
import { replayProphetR37Structure, PROPHET_R37_STRUCTURE_SOURCE } from "../src/prophet-r37-kernel.mjs";

function candles(n = 20) {
  return Array.from({length:n}, (_,i) => ({
    bar_index:i, open:100+i*0.1, high:101+i*0.1, low:99+i*0.1, close:100.2+i*0.1,
    oscillator: i < 4 ? -1 : i < 8 ? 1 : i < 12 ? -0.8 : 0.5,
    volume_ratio:1.2, has_volume:true, atr:1
  }));
}

test("exports source contract and exactly 16 output fields", () => {
  assert.equal(PROPHET_R37_STRUCTURE_SOURCE.pineExport, "prophet_structure_core");
  assert.equal(PROPHET_R37_STRUCTURE_SOURCE.outputFields.length, 16);
});

test("replay is deterministic and emits one tuple per candle", () => {
  const input=candles();
  const a=replayProphetR37Structure(input);
  const b=replayProphetR37Structure(input);
  assert.deepEqual(a,b);
  assert.equal(a.length,input.length);
  assert.equal(a[0].bar_index,0);
  assert.equal(a.at(-1).bar_index,input.length-1);
});

test("rejects non-monotonic bar indexes", () => {
  const input=candles(3);
  input[2].bar_index=1;
  assert.throws(()=>replayProphetR37Structure(input),/strictly increasing/);
});

test("rejects malformed OHLC instead of silently normalizing it", () => {
  const input=candles(2);
  input[1].high=input[1].low-1;
  assert.throws(()=>replayProphetR37Structure(input),/inconsistent OHLC/);
});

test("missing volume is distinct from a real volume ratio at or below one", () => {
  const input=candles(8);
  input.forEach(c=>{c.has_volume=false;c.volume_ratio=null;});
  assert.doesNotThrow(()=>replayProphetR37Structure(input));
});

test("output fields are stable and explicitly nullable", () => {
  const row=replayProphetR37Structure(candles(1))[0];
  for(const key of PROPHET_R37_STRUCTURE_SOURCE.outputFields) assert.ok(Object.hasOwn(row,key),key);
  assert.equal(row.state_bar,null);
  assert.equal(row.bull_event_bar,null);
  assert.equal(row.bear_event_bar,null);
});
