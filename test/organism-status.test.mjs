// Owner 2026-11-12 ("ya bersihkan sekalian"): /api/organism/status is measured only. It used to return a fixed
// $500 treasury, a burn, a runway and a 150% AI quota that nothing measured.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { organismStatus, ORGANISM_STATUS_SCHEMA } from "../src/organism-status.mjs";
import { EA_HEARTBEAT_KEY } from "../src/ea-signal.mjs";

const kv = (entries = {}) => { const m = new Map(Object.entries(entries)); return { get: async (k) => m.get(k) ?? null, put: async () => {} }; };
const MON = Date.UTC(2026, 10, 9, 10, 0, 0); // Monday 10:00 UTC: open
const SAT = Date.UTC(2026, 10, 14, 10, 0, 0); // Saturday: closed

test("O1. no treasury, quota, burn or runway: those are not this Worker's to measure", async () => {
  const o = await organismStatus({ SIGNAL_CACHE: kv() }, { now: MON });
  assert.equal(o.schema, ORGANISM_STATUS_SCHEMA);
  const text = JSON.stringify(o);
  for (const gone of ["treasury", "balance_usd", "daily_burn", "runway", "ai_quota", "power_mode", "canon_sync", "lifecycle", "500"]) assert.ok(!text.includes(gone), gone);
});

test("O2. the market state follows the XAUUSD session; unmeasured values are null", async () => {
  assert.equal((await organismStatus({ SIGNAL_CACHE: kv() }, { now: MON })).market_state, "open");
  const sat = await organismStatus({ SIGNAL_CACHE: kv() }, { now: SAT });
  assert.equal(sat.market_state, "closed");
  assert.equal(sat.deals.recent_count, null, "no D1: the deal count is unknown, not 0");
  assert.equal(sat.omega.ea_connected, false);
  assert.equal(sat.omega.ea_heartbeat_age_ms, null);
  assert.equal(sat.decision_engine.latest_decided_at, null);
});

test("O2b. the deal count is read from D1 ea_deals over the last 7 days", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ea_deals (deal_ticket INTEGER, closed_ms INTEGER)");
  db.prepare("INSERT INTO ea_deals VALUES (1, ?), (2, ?), (3, ?)").run(MON - 3_600_000, MON - 86_400_000, MON - 10 * 86_400_000);
  const DB = { prepare: (sql) => { let p = []; const st = { bind: (...a) => { p = a; return st; }, first: async () => db.prepare(sql).get(...p) ?? null }; return st; } };
  assert.equal((await organismStatus({ DB, SIGNAL_CACHE: kv() }, { now: MON })).deals.recent_count, 2);
  const empty = new DatabaseSync(":memory:");
  empty.exec("CREATE TABLE ea_deals (deal_ticket INTEGER, closed_ms INTEGER)");
  const DB0 = { prepare: (sql) => { let p = []; const st = { bind: (...a) => { p = a; return st; }, first: async () => empty.prepare(sql).get(...p) ?? null }; return st; } };
  assert.equal((await organismStatus({ DB: DB0, SIGNAL_CACHE: kv() }, { now: MON })).deals.recent_count, 0, "an empty table is a measured 0");
});

test("O3. Omega's EA heartbeat is read from where the EA writes it", async () => {
  const hb = { received_at: new Date(MON - 30_000).toISOString(), positions: 1 };
  const o = await organismStatus({ SIGNAL_CACHE: kv({ [EA_HEARTBEAT_KEY]: JSON.stringify(hb) }), OMEGA_ENGINE_ENABLED: "true" }, { now: MON });
  assert.equal(o.omega.engine_enabled, true);
  assert.equal(o.omega.ea_connected, true);
  assert.equal(o.omega.ea_heartbeat_age_ms, 30_000);
});

test("O4. the Nexus organism card shows what the route measured, with a dash, never a default number or mode", () => {
  const card = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/components/OrganismCard.tsx", import.meta.url), "utf8");
  for (const fake of [/\?\? 150/, /GROWTH \(Full Capacity\)/, /SHA-256 Verified/, /Homeostasis active/, /\?\? "OPEN"/, /ai_quota_percent/, /Awareness Active/]) assert.doesNotMatch(card, fake);
  assert.match(card, /"—"/);
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /HotStandby|primary_broker: "|failover_ready: true/, "no invented broker route");
  const perf = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Performance.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(perf, /HotStandby|"Monex[- ]Demo"|"Auto Failover"|ARMED & READY|"Demo Hedging"/, "no invented broker, route or failover on the page");
});
