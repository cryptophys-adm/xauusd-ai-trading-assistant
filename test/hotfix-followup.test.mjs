import test from "node:test";
import assert from "node:assert/strict";
import { loadWebhookPayloadsFromD1 } from "../src/webhook-payloads.mjs";
import { backfillRecentAnalyses, closedH1CandleKeys } from "../src/parity-sweep.mjs";

function kv(map = {}) {
  const m = new Map(Object.entries(map));
  return { async get(k){ return m.has(k)?m.get(k):null; }, async put(k,v){ m.set(k,String(v)); } };
}
function d1(rows) {
  return { prepare(){ return { bind(){ return { async all(){ return { results: rows }; }, async first(){ return rows[0]||null; } }; } }; } };
}

test("loadWebhookPayloadsFromD1 uses D1 when KV misses", async () => {
  const required = ["prophet_r38","prophet_r37_ssot","gmi_v12_70"];
  const payloads = { prophet_r38: {a:1}, prophet_r37_ssot:{b:2}, gmi_v12_70:{c:3} };
  const rows = required.map(s => ({ source: s, payload: JSON.stringify(payloads[s]) }));
  const env = { DB: d1(rows), WEBHOOK_BUFFER: kv({}) };
  const out = await loadWebhookPayloadsFromD1(env, "K", required);
  assert.deepEqual(out, payloads);
});

test("backfill runs once then no-op", async () => {
  const now = Date.parse("2026-11-04T03:00:00.000Z");
  const keys = closedH1CandleKeys(now, { lookback: 1 });
  const key = keys[0];
  const required = ["prophet_r38","prophet_r37_ssot","gmi_v12_70"];
  const payloads = Object.fromEntries(required.map(s=>[s,{x:1}]));
  const rows = required.map(s=>({source:s,payload:JSON.stringify(payloads[s])}));
  const env = { DB: { prepare(sql){ 
      if (sql.includes("analysis_runs")) return { bind(){ return { async first(){ return null; } }; } };
      if (sql.includes("webhook_sources")) return { bind(){ return { async all(){ return { results: rows }; } }; } };
      return { bind(){ return { async all(){ return {results:[]}; }, async first(){return null;} }; } };
    } }, WEBHOOK_BUFFER: kv({}) };
  const calls = [];
  const r1 = await backfillRecentAnalyses(env, { now, lookback:1, loadPayloads: async (_e,k,req)=> (k===key?payloads:null), runAnalysis: async (_e,k)=>{ calls.push(k); } });
  assert.equal(calls.length, 1);
  // second: mark analysis_runs exists
  env.DB = { prepare(sql){ 
      if (sql.includes("analysis_runs")) return { bind(){ return { async first(){ return {status:"complete"}; } }; } };
      if (sql.includes("webhook_sources")) return { bind(){ return { async all(){ return { results: rows }; } }; } };
      return { bind(){ return { async all(){ return {results:[]}; }, async first(){return null;} }; } };
    } };
  const r2 = await backfillRecentAnalyses(env, { now, lookback:1, loadPayloads: async (_e,k,req)=>payloads, runAnalysis: async (_e,k)=>{ calls.push(k); } });
  assert.equal(calls.length, 1);
});

test("backfill skips candles older than 2h", async () => {
  const now = Date.parse("2026-11-04T03:00:00.000Z");
  const required = ["prophet_r38","prophet_r37_ssot","gmi_v12_70"];
  const payloads = Object.fromEntries(required.map(s=>[s,{x:1}]));
  const keys = closedH1CandleKeys(now, { lookback: 3 });
  function makeDb() {
    return { prepare(sql) {
      if (sql.includes("analysis_runs")) return { bind() { return { async first() { return null; } }; } };
      return { bind() { return { async all() { return { results: [] }; } }; } };
    } };
  }
  const env = { DB: makeDb(), WEBHOOK_BUFFER: kv({}) };
  const calls = [];
  await backfillRecentAnalyses(env, { now, lookback: 3, loadPayloads: async (_e,k,req) => payloads, runAnalysis: async (_e,k) => { calls.push(k); }, setStatus: async () => {} });
  assert.equal(calls.length, 2);
  assert.ok(!calls.includes(keys[2]));
});
