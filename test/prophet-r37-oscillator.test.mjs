import test from "node:test";
import assert from "node:assert/strict";
import {
  prophetVolumeRatio, prophetVolumeAnomaly, prophetVolumeCycle,
  prophetEfficiencyRatio, calculateProphetTensor, replayProphetR37ClosedBars,
  pineAtr, gmiAtrValues
} from "../src/prophet-r37-oscillator.mjs";

test("volume ratio uses prior SMA and caps at two",()=>{
  assert.deepEqual(prophetVolumeRatio([10,10,30],2),[1,1,2]);
});

test("efficiency ratio is zero for a flat series and bounded for monotonic prices",()=>{
  assert.deepEqual(prophetEfficiencyRatio([5,5,5],2),[null,0,0]);
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

test("efficiency ratio follows Pine math.sum warm-up (na until len samples)",()=>{
  const er=prophetEfficiencyRatio([1,2,3,2,3],3);
  assert.deepEqual(er.slice(0,2),[null,null]);
  // i=2: |3-nz(src[3],3)|=0, path=0+1+1 => 0
  assert.equal(er[2],0);
  // i=3: |2-1|=1, path=|2-1|+|3-2|+|2-3|=3
  assert.equal(er[3],1/3);
});

test("pineAtr: tr(true) seed + SMA seed + RMA recursion; gmiAtrValues floors at mintick",()=>{
  const c=[
    {high:10,low:8,close:9},   // tr=2 (no prior close)
    {high:12,low:9,close:11},  // tr=max(3,|12-9|,|9-9|)=3
    {high:11,low:10,close:10}, // tr=max(1,0,1)=1
    {high:10.01,low:10,close:10}// tr=max(.01,0,0)=.01
  ];
  const atr=pineAtr(c,2);
  assert.equal(atr[0],null);
  assert.equal(atr[1],2.5);          // sma(2,3)
  assert.equal(atr[2],(1+2.5)/2);    // rma
  assert.ok(Math.abs(atr[3]-(0.01+1.75)/2)<1e-12);
  const floored=gmiAtrValues([{high:1,low:1,close:1},{high:1,low:1,close:1}],0.01,2);
  assert.deepEqual(floored,[null,0.01]);
  assert.throws(()=>gmiAtrValues(c,0));
});

test("closed bars feed prophet_volume_ratio (not vol_anomaly) into f_vol_cycle and structure",()=>{
  const candles=Array.from({length:90},(_,i)=>({
    bar_index:i, open:100+Math.sin(i/3), close:100+Math.sin((i+1)/3),
    high:101.5+Math.sin(i/3), low:98.5+Math.sin(i/3),
    volume:i%7===0?500:100+i
  }));
  const out=replayProphetR37ClosedBars(candles,{mintick:0.01});
  assert.deepEqual(out.proAnom,out.volumeRatio);
  // Branches genuinely differ on this series, so the choice is observable.
  assert.ok(out.volumeRatio.some((v,i)=>v!==out.volumeAnomalyRealtime[i]));
  const closes=candles.map(c=>c.close),highs=candles.map(c=>c.high),lows=candles.map(c=>c.low);
  const r13=prophetVolumeCycle(closes,highs,lows,out.volumeRatio,13);
  const r34=prophetVolumeCycle(closes,highs,lows,out.volumeRatio,34);
  const r55=prophetVolumeCycle(closes,highs,lows,out.volumeRatio,55);
  out.rawComp.forEach((v,i)=>{
    if(v===null) return;
    assert.ok(Math.abs(v-(r13[i]*.5+r34[i]*.35+r55[i]*.15))<1e-12,`raw_comp[${i}]`);
  });
  assert.equal(out.rawComp[53],null);
  assert.equal(typeof out.rawComp[54],"number");
  assert.equal(out.atrValues[12],null);
  assert.equal(typeof out.atrValues[13],"number");
});

test("has_volume follows cumulative nz(volume) > 0",()=>{
  const candles=Array.from({length:3},(_,i)=>({bar_index:i,open:1,high:2,low:0,close:1,volume:[null,0,5][i]}));
  const out=replayProphetR37ClosedBars(candles,{atrValues:[1,1,1]});
  assert.deepEqual(out.hasVolume,[false,false,true]);
});
