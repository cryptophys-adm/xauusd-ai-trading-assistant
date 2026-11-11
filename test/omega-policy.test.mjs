// B-12 (issue #227): Omega's risk policy from Aether, behind the owner's switch, with a rollback.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyOmegaPolicy, readSettings, resetOmegaBrokerSchemaForTests, OMEGA_POLICY_KEY, OMEGA_POLICY_APPLIED_KEY } from "../src/omega-broker.mjs";
import { storeDeal, resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { policyFromPack, pullOmegaPolicy } from "../src/omega-policy.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const NOW = Date.parse("2026-11-12T10:00:00Z");
const PACK = { version: "cryptophys.omega-policy.v1", doctrine_sha: "a".repeat(64), values: { risk_pct: 0.4, max_positions: 2, max_daily_loss_pct: 2, max_spread_points: 60, max_signal_age_min: 10 } };
const deal = (i, profit, { source = "omega", at = NOW + (i + 1) * 60_000 } = {}) => ({ deal_ticket: 1000 + i, position_ticket: 2000 + i, mode: "demo", side: "BUY", volume: 0.01, entry_price: 1, exit_price: 1, profit, commission: 0, swap: 0, reason: profit > 0 ? "tp" : "sl", opened_ms: at - 60_000, closed_ms: at, source });

test("the pack in Omega's names; pulled hourly from Aether into KV", async () => {
  assert.deepEqual(policyFromPack(PACK), { risk_pct: 0.4, max_positions: 2, max_daily_loss_pct: 2, max_spread_points: 60, max_signal_age_ms: 600_000, doctrine_sha: "a".repeat(64), version: "cryptophys.omega-policy.v1" });
  assert.equal(policyFromPack({ values: {} }), null);
  const env = { SIGNAL_CACHE: kv(), AETHER: { omegaPolicy: async () => PACK } };
  assert.equal((await pullOmegaPolicy(env, { now: NOW })).status, "pulled");
  assert.equal(JSON.parse(env.SIGNAL_CACHE.map.get(OMEGA_POLICY_KEY)).risk_pct, 0.4);
  assert.equal((await pullOmegaPolicy(env, { now: NOW + 60_000 })).status, "fresh", "once an hour");
  assert.equal((await pullOmegaPolicy({ SIGNAL_CACHE: kv() }, { now: NOW })).status, "unavailable");
});

test("applied only behind the switch, within bounds, audited and reported; unchanged packs do nothing", async () => {
  resetOmegaBrokerSchemaForTests(); resetEaExecutionSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  await env.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ ...policyFromPack(PACK), risk_pct: 9 }));
  assert.equal((await applyOmegaPolicy(env, { now: NOW })).status, "disabled", "off unless the owner turns it on");
  const sent = [];
  const on = { ...env, OMEGA_POLICY_AUTO: "true" };
  const r = await applyOmegaPolicy(on, { now: NOW, notify: async (t) => { sent.push(t); } });
  assert.equal(r.status, "applied");
  assert.equal((await readSettings(env)).settings.risk_pct, 2, "clamped to Omega's own bound");
  assert.equal((await readSettings(env)).settings.max_positions, 2);
  assert.equal((await readSettings(env)).updated_by, "aether");
  assert.match(sent[0], /^XAUUSD SYSTEM · Omega policy applied from Aether's doctrine: risk pct 0\.5 → 2, max positions 1 → 2\./);
  assert.equal((await applyOmegaPolicy(on, { now: NOW + 1 })).status, "unchanged");
  const events = env.DB.raw.prepare("SELECT actor, action FROM omega_events WHERE action = 'settings'").all();
  assert.deepEqual(events.map((e) => e.actor), ["aether"]);
});

test("after 50 Omega trades a losing policy is rolled back and its doctrine version is not applied again", async () => {
  resetOmegaBrokerSchemaForTests(); resetEaExecutionSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_POLICY_AUTO: "true" };
  // Before the change: 50 Omega trades with profit factor 2; manual trades never count.
  for (let i = 0; i < 50; i++) await storeDeal(env, deal(i, i % 3 === 0 ? -1 : 1, { at: NOW - (100 - i) * 60_000 }), { now: NOW });
  await storeDeal(env, deal(500, -50, { source: "manual", at: NOW - 30_000 }), { now: NOW });
  await env.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify(policyFromPack(PACK)));
  assert.equal((await applyOmegaPolicy(env, { now: NOW })).status, "applied");
  const applied = JSON.parse(env.SIGNAL_CACHE.map.get(OMEGA_POLICY_APPLIED_KEY));
  assert.deepEqual([applied.baseline.trades, applied.baseline.profit_factor], [50, 1.94], "33 wins, 17 losses; the manual loss never counts");
  // 49 losing trades under it: not yet judged.
  for (let i = 0; i < 49; i++) await storeDeal(env, deal(100 + i, i % 2 === 0 ? -1 : 0.5), { now: NOW });
  assert.equal((await applyOmegaPolicy(env, { now: NOW + 3_600_000 })).status, "unchanged");
  await storeDeal(env, deal(149, -1), { now: NOW });
  const sent = [];
  const r = await applyOmegaPolicy(env, { now: NOW + 7_200_000, notify: async (t) => { sent.push(t); } });
  assert.equal(r.status, "rolled_back");
  assert.equal((await readSettings(env)).settings.risk_pct, 0.5, "the previous risk is back");
  assert.equal((await readSettings(env)).updated_by, "aether-rollback");
  assert.match(sent[0], /Omega policy rolled back/);
  assert.equal((await applyOmegaPolicy(env, { now: NOW + 7_300_000 })).status, "rejected_sha", "the same doctrine version is never applied again");
});
