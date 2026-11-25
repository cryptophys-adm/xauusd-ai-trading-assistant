// ZN1 UI: the Nexus Zones page's fixtures (test/fixtures/nexus-zones/*.json) are this seed's answers, from the real
// GET /api/zones view (src/zone-readings.mjs zonesView) and the real breaker tick (runZoneBreaker) over a seeded sqlite
// D1 and KV, so the page's contract never drifts from the view:
//   zones.json                    held: FS1's Z5 evidence (30 resolved zone_blocked BUY setups at +0.15R; 30 resolved
//                                 tp_typed and stop_skip arms below their base), sample readings over 30 days, the forced
//                                 tick at 2026-11-24 07:22 UTC (zone_ahead by "block", tp and stop by "rule:…"), then
//                                 12 SELL setups, 7 days of stances and 16 Omega closes a zone touched;
//   zones-legacy.json             the held answer with held[] as { rule, by } (a backend before ZN1: the fallbacks);
//   zones-clear.json              the same readings only (no counterfactual rows), a tick: nothing held;
//   zones-empty.json              no table at all (ZR-16's shape: every list [], breaker null);
//   feature-switches-held.json    the held state's GET /api/feature-switches (read-only, viewer.can_control false):
//                                 the page reads a hold's since and until from its zone_hold when /api/zones has none;
//   zones-off.json, zones-error.json  src/index.ts' 404 (ZONE_READINGS off) and 500 (zonesView threw) bodies.
// test/nexus-zones-page.test.mjs checks each file against this seed, byte for byte. After a change to zonesView or the
// breaker, regenerate them: node test/support/nexus-zones-seed.mjs --write
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ZONE_READINGS_VERSION, ensureZoneReadingsSchema, resetZoneReadingsSchemaForTests, runZoneBreaker, zonesView
} from "../../src/zone-readings.mjs";
import { featureSwitchesPayload, resetFeatureSwitchMemoForTests } from "../../src/feature-switch-store.mjs";
import { readSettings, resetOmegaBrokerSchemaForTests } from "../../src/omega-broker.mjs";
import { ruleVersionOf } from "../../src/mode-shadow.mjs";
import { CONTROL_ARM } from "../../src/plan-learning.mjs";
import { d1, kv } from "../fixtures/mode-shadow.mjs";
import { HOLD_AT, NOW, configEnv } from "./nexus-fs1-seed.mjs";

export { HOLD_AT, NOW };
const HOUR = 3_600_000, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

/** src/index.ts GET /api/zones: ZONE_READINGS off answers 404 with this body, a zonesView failure 500 with this one. */
export const OFF_BODY = { status: "not_found", reason: "zone_readings_off" };
export const ERROR_BODY = { status: "error", error: "zones_unavailable" };

/** A small deterministic generator (reset on every seedZones call). */
function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

async function freshEnv() {
  resetZoneReadingsSchemaForTests();
  resetFeatureSwitchMemoForTests();
  resetOmegaBrokerSchemaForTests();
  const env = { ...configEnv(), SIGNAL_CACHE: kv(), DB: d1() };
  await readSettings(env);
  await ensureZoneReadingsSchema(env.DB);
  return env;
}

/** zone_readings over the last 29 days: [type, approach, strength, n, held share, broke share] per group. */
function seedReadings(env, rv, rnd) {
  const ins = env.DB.raw.prepare("INSERT INTO zone_readings (reading_key, decision_key, bar_close, zone_type, zone_strength, zone_freshness, zone_rank, ds_sources, approach, outcome, mfe_atr, mae_atr, bars, mode, regime, version, rule_version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'intraday', 'ranging', ?, ?)");
  const plan = [
    ["demand", "from_above", "strong", 22, 0.55, 0.2], ["demand", "from_above", "medium", 34, 0.47, 0.26], ["demand", "from_above", "weak", 18, 0.33, 0.39],
    ["demand", "inside", "medium", 12, 0.42, 0.33], ["demand", "from_below", "medium", 6, 0.17, 0.5],
    ["supply", "from_below", "strong", 16, 0.5, 0.25], ["supply", "from_below", "medium", 28, 0.43, 0.29], ["supply", "from_below", "weak", 14, 0.29, 0.43],
    ["supply", "inside", "medium", 9, 0.33, 0.44],
    [null, "from_above", null, 41, 0.39, 0.34], [null, "from_below", null, 37, 0.35, 0.38], ["mixed", "from_above", "medium", 8, 0.38, 0.38]
  ];
  let k = 0;
  for (const [type, approach, strength, n, ph, pb] of plan) {
    for (let i = 0; i < n; i++) {
      const held = i < Math.round(n * ph), broke = !held && i < Math.round(n * ph) + Math.round(n * pb);
      const outcome = held ? "held" : broke ? "broke" : "neither";
      const at = NOW - Math.floor(rnd() * 29 * DAY) - HOUR;
      const mfe = held ? 0.6 + rnd() * 0.9 : 0.1 + rnd() * 0.5, mae = broke ? 0.5 + rnd() * 0.8 : 0.1 + rnd() * 0.45;
      ins.run(`d${k}#0`, `d${k}`, iso(at), type, strength, type ? "fresh" : null, approach, outcome, Math.round(mfe * 100) / 100, Math.round(mae * 100) / 100, held || broke ? 3 + (k % 5) : 8, ZONE_READINGS_VERSION, rv);
      k++;
    }
  }
}

/** test/support/nexus-fs1-seed.mjs zoneBreakerTick's evidence, the same rows: zone_ahead by block, tp and stop by rule. */
function seedBreakerEvidence(env, rv) {
  const db = env.DB, at = (i) => new Date(HOLD_AT - (i + 1) * HOUR).toISOString();
  const blocked = db.raw.prepare("INSERT INTO zone_blocked_setups (setup_key, decision_key, opened_at, decided_at, last_seen_at, side, entry, stop, tp1, atr_h1, context, status, results_json, version, updated_at, rule_version) VALUES (?, 'k', ?, ?, ?, 'BUY', 4000, 3990, 4015, 10, 'c', 'resolved', ?, 'v', 'u', ?)");
  for (let i = 0; i < 30; i++) blocked.run(`blocked-${i}`, at(i), at(i), at(i), JSON.stringify({ [CONTROL_ARM]: { r: 0.15, s: "target", f: 1 } }), rv);
  const arm = db.raw.prepare("INSERT INTO zone_rule_arms (arm_key, setup_key, decision_key, agent, rule, side, opened_at, decided_at, last_seen_at, entry, stop, tp1, base_stop, base_tp1, atr_h1, status, acted_r, base_r, resolved_at, rule_version, version, updated_at) VALUES (?, ?, 'k', 'zone_pullback', ?, 'BUY', ?, ?, ?, 4000, 3990, 4015, 3992, 4012, 10, 'resolved', ?, ?, ?, ?, 'v', 'u')");
  for (const [rule, acted, base] of [["tp_typed", 0.1, 0.3], ["stop_skip", 0.05, 0.2]]) {
    for (let i = 0; i < 30; i++) arm.run(`${rule}-${i}`, `s-${rule}-${i}`, rule, at(i), at(i), at(i), acted, base, at(i), rv);
  }
}

/** A second side for the zone_blocked table, after the tick (the view only): 5 stops, 4 targets, 3 limits never filled. */
function seedSellBlocked(env, rv) {
  const st = env.DB.raw.prepare("INSERT INTO zone_blocked_setups (setup_key, decision_key, opened_at, decided_at, last_seen_at, side, entry, stop, tp1, atr_h1, context, status, results_json, version, updated_at, rule_version) VALUES (?, 'k', ?, ?, ?, 'SELL', 4000, 4010, 3985, 10, 'c', 'resolved', ?, 'v', 'u', ?)");
  for (let i = 0; i < 12; i++) {
    const a = iso(NOW - (i + 30) * 3 * HOUR);
    st.run(`sell-${i}`, a, a, a, JSON.stringify({ [CONTROL_ARM]: i < 5 ? { r: -1, s: "stop", f: 1 } : i < 9 ? { r: 0.8, s: "target", f: 1 } : { r: 0, s: "nofill", f: 0 } }), rv);
  }
}

/** Seven days of 15m decisions (the columns zonesView reads): BUY, SELL and WAIT, some WAITs zone_blocked. */
function seedStances(env) {
  env.DB.raw.exec("CREATE TABLE IF NOT EXISTS engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, stance TEXT, decided_at TEXT, decision_json TEXT)");
  const st = env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, stance, decided_at, decision_json) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 7 * 96; i++) {
    const at = iso(NOW - (i + 1) * 15 * 60_000);
    const stance = i % 9 === 0 ? "BUY" : i % 11 === 0 ? "SELL" : "WAIT";
    const zb = stance === "WAIT" && i % 23 === 0 ? { zone_blocked: { side: i % 2 ? "long" : "short" } } : {};
    st.run(`e${i}`, at, stance, at, JSON.stringify(zb));
  }
}

/** test/zone-readings.test.mjs ZR-15's Omega rows, dated inside the 30 days: 16 closes, half placed by a zone, half trailed. */
function seedOmega(env) {
  const db = env.DB.raw;
  db.exec("CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS position_actions (id TEXT PRIMARY KEY, ticket INTEGER NOT NULL, bar INTEGER NOT NULL, at_ms INTEGER NOT NULL, side TEXT NOT NULL, pips REAL, price REAL, action TEXT NOT NULL, rule TEXT NOT NULL, sl REAL, tp REAL, why TEXT, council TEXT, orig_sl REAL, orig_tp REAL, basis REAL, status TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER NOT NULL, position_ticket INTEGER, mode TEXT NOT NULL, side TEXT NOT NULL, volume REAL NOT NULL, entry_price REAL, exit_price REAL, stop_loss REAL, take_profit REAL, profit REAL NOT NULL, commission REAL NOT NULL DEFAULT 0, swap REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL, signal_id TEXT, opened_ms INTEGER, closed_ms INTEGER NOT NULL, currency TEXT, received_at TEXT NOT NULL, source TEXT)");
  for (let t = 1; t <= 16; t++) {
    db.prepare("INSERT INTO omega_intents VALUES (?, 'open', ?, 'done', ?, ?, ?)").run(`o${t}`, JSON.stringify({ entry: 4000, sl: 3990, volume: 0.1, r_dist: 10, signal_issued_ms: NOW - DAY + t * HOUR, side: "BUY", level_source: t % 2 ? "zone" : "key_level" }), JSON.stringify({ ticket: 900 + t }), NOW - DAY, NOW - DAY);
    if (t % 2 === 0) db.prepare("INSERT INTO position_actions VALUES (?, ?, 1, ?, 'BUY', 0, 0, 'modify_sl', 'zone_trail', 0, 0, '', '', 0, 0, 0, 'done')").run(`a${t}`, 900 + t, NOW - DAY);
    db.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, mode, side, volume, profit, reason, opened_ms, closed_ms, currency, received_at, source) VALUES (?, ?, 'real', 'BUY', 0.1, ?, 'sl', ?, ?, 'USD', 'x', 'omega')").run(5000 + t, 900 + t, t % 3 ? -5 : 8, NOW - DAY, NOW - 1000);
  }
}

/** The seeded answers (see the header). Deterministic: a fresh D1, KV, memo and generator on every call. */
export async function seedZones() {
  const rnd = rng();
  // held
  const env = await freshEnv();
  const rv = ruleVersionOf(env);
  seedReadings(env, rv, rnd);
  seedBreakerEvidence(env, rv);
  const heldTick = await runZoneBreaker(env, { now: HOLD_AT, force: true });
  if (heldTick.status !== "changed" || heldTick.held.join() !== "zone_ahead,tp,stop") throw new Error(`zones seed, held tick: ${JSON.stringify(heldTick)}`);
  seedSellBlocked(env, rv);
  seedStances(env);
  seedOmega(env);
  const held = await zonesView(env, { now: NOW });
  const switches = await featureSwitchesPayload(env, { now: NOW, canControl: false });
  // clear
  const env2 = await freshEnv();
  seedReadings(env2, ruleVersionOf(env2), rnd);
  const clearTick = await runZoneBreaker(env2, { now: HOLD_AT, force: true });
  if (clearTick.status !== "unchanged" || clearTick.held.length) throw new Error(`zones seed, clear tick: ${JSON.stringify(clearTick)}`);
  seedStances(env2);
  const clear = await zonesView(env2, { now: NOW });
  // empty: no table at all
  resetZoneReadingsSchemaForTests();
  const empty = await zonesView({ ...configEnv(), SIGNAL_CACHE: kv(), DB: d1() }, { now: NOW });
  // legacy: the held answer as a backend before ZN1 gave it (held[] entries { rule, by } only), so the page's fallbacks
  // (the switches' times, else none; effective unknown) stay tested against a real shape.
  const legacy = { ...held, breaker: { ...held.breaker, held: held.breaker.held.map(({ rule, by }) => ({ rule, by })) } };
  return JSON.parse(JSON.stringify({ held, legacy, clear, empty, switches, off: OFF_BODY, error: ERROR_BODY }));
}

/** The fixture files and the seed's answer each one holds. */
export const FILES = { "zones.json": "held", "zones-legacy.json": "legacy", "zones-clear.json": "clear", "zones-empty.json": "empty", "feature-switches-held.json": "switches", "zones-off.json": "off", "zones-error.json": "error" };

// CLI: `node test/support/nexus-zones-seed.mjs --write` rewrites the fixtures from the seed.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedZones();
  const dir = new URL("../fixtures/nexus-zones/", import.meta.url);
  for (const [name, key] of Object.entries(FILES)) writeFileSync(new URL(name, dir), JSON.stringify(out[key], null, 2) + "\n");
  console.log(`wrote ${Object.keys(FILES).length} fixtures to test/fixtures/nexus-zones/`);
}
