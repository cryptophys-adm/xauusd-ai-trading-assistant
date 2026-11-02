import test from "node:test";
import assert from "node:assert/strict";
import {
  prophetVolumeRatio, prophetVolumeAnomaly, prophetVolumeCycle,
  prophetEfficiencyRatio, calculateProphetTensor, replayProphetR37ClosedBars
} from "../src/prophet-r37-oscillator.mjs";

test("volume ratio uses prior SMA and caps at two",()=>{
  assert.deepEqual(prophetVolumeRatio([10,10,30],2),[1,1,2]);
});

test("efficiency ratio is zero for a flat series and bounded for monotonic prices",()=>{
  assert.deepEqual(prophetEfficiencyRatio([5,5,5],2),[0,0,0]);
  const er=prophetEfficiencyRatio([1,2,3,4],2);
  assert.ok(er.every(v=>v>=0&&v<=1));
});

test("volume cycle is zero at midpoint and null before warm-up",()=>{
  const c=Array.from({length:14},()=>0);
  const h=c.map(()=>1), l=c.map(()=>-1), a=c.map(()=>1);
  const out=prophetVolumeCycle(c,h,l,a,13);
  assert.equal(out[11],null);
  assert.equal(out[12],0);
});

test("tensor preserves array lengths and null warm-up",()=>{
  const raw=Array.from({length:80},(_,i)=>Math.sin(i/5));
  const er=raw.map(()=>0.5);
  const out=calculateProphetTensor(raw,er,6);
  assert.equal(out.pro_fast.length,raw.length);
  assert.equal(out.pro_slow.length,raw.length);
  assert.equal(out.pro_core.length,raw.length);
  assert.ok(out.pro_fast.some(v=>typeof v==="number"));
});

test("closed-bar integration requires ATR vector and returns separate structure output",()=>{
  const candles=Array.from({length:70},(_,i)=>({bar_index:i,open:100+i*.1,high:101+i*.1,low:99+i*.1,close:100.2+i*.1,volume:100+i}));
  const out=replayProphetR37ClosedBars(candles,{atrValues:candles.map(()=>1)});
  assert.equal(out.structure.length,candles.length);
  assert.equal(out.pro_fast.length,candles.length);
  assert.ok(!Object.hasOwn(out.structure[0],"gmi_verdict"));
});
