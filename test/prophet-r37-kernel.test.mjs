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

function flat(osc){
  return osc.map((o,i)=>({bar_index:i,open:100,high:101,low:99,close:100,oscillator:o,volume_ratio:1.2,has_volume:true,atr:1}));
}

test("zero-cross follows Pine ta.crossover/crossunder (x>0 and x[1]<=0)",()=>{
  // i=1: lands exactly on 0 -> NOT a cross (b stays 0)
  // i=2: 0 -> positive -> crossover (b resets to 1)
  const up=replayProphetR37Structure(flat([-1,0,1]));
  assert.deepEqual(up.map(r=>r.b_enc),[0,0,1]);
  const down=replayProphetR37Structure(flat([1,0,-1]));
  assert.deepEqual(down.map(r=>r.b_enc),[0,0,1]);
  // na prior value is never a cross
  const na=replayProphetR37Structure(flat([null,1]));
  assert.deepEqual(na.map(r=>r.b_enc),[0,0]);
});

test("rejects gapped bar_index (Pine bar_index is consecutive)",()=>{
  const input=candles(3);
  input[2].bar_index=5;
  assert.throws(()=>replayProphetR37Structure(input),/consecutive/);
});

test("bearish divergence: origin = previous pivot at bar_index - pivot_right, event on confirm bar",()=>{
  // Oscillator pivot highs at i=5 (0.9) and i=13 (0.6); price pivot highs rising.
  const osc=[0.1,0.2,0.3,0.4,0.5,0.9,0.5,0.4,0.3,0.2,0.3,0.4,0.5,0.6,0.5,0.4,0.3];
  const rows=osc.map((o,i)=>{
    const hi = i===5?105 : i===13?110 : 101;
    return {bar_index:1000+i,open:100,high:hi,low:99,close:100,oscillator:o,volume_ratio:1.2,has_volume:true,atr:1};
  });
  const out=replayProphetR37Structure(rows);
  assert.equal(out[7].oscillator_ph,0.9);       // confirmed 2 bars later
  assert.equal(out[7].last_price_ph,105);
  assert.equal(out[7].bear_div_event,false);    // no prior pivot
  assert.equal(out[15].oscillator_ph,0.6);
  assert.equal(out[15].bear_div_event,true);
  assert.equal(out[15].bear_div_origin_bar,1005);
  assert.equal(out[15].bear_div_origin_value,0.9);
  assert.equal(out[15].d_enc,-1);
  assert.equal(out[15].b_enc,2);
  assert.equal(out[15].bear_event_bar,1015);
  assert.equal(out[15].last_price_ph,110);
});
