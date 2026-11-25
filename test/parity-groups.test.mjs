// B7: parity field groups. Inert until B11 wires a group; today's identities are byte-identical.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  PARITY_GROUPS, BASE_ENGINES, DEFAULT_POLICY, compareWithWebhooks, groupIdentityOf, groupsFor,
  groupCompareOptions, parityGroupProblems, identityOf, registerIdentity, ensureSchema, isTrusted, resetSchemaCacheForTests
} from "../src/parity-registry.mjs";
import { reconcileLocalComputation } from "../src/parity-sweep.mjs";
import { INGEST_ENGINES } from "../src/evidence-fusion.mjs";
import { validateHudSnapshot, storeHudSnapshot, loadHudSnapshot, hudReadings, approvedComparable, HUD_SNAPSHOT_VERSION } from "../src/hud-store.mjs";
import { runParityScenario } from "./support/parity-scenario.mjs";
import { COMPARE_CASES } from "./support/parity-compare-cases.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8"));

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
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
function kv() {
  const map = new Map();
  let gets = 0;
  return {
    map, gets: () => gets,
    async get(key) { gets += 1; return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };
}

test.beforeEach(() => resetSchemaCacheForTests());

test("B7-1 parity is byte-identical to main for today's identities: sweep output, stored trust and the parity view", async () => {
  const now = await runParityScenario();
  const main = fixture("parity-b7-main.json");
  assert.equal(JSON.stringify(now), JSON.stringify(main));
  assert.ok(now.registry.length >= 8 && now.view.registry.length === now.registry.length, "the scenario covers prophet, gmi, gmi_hud and Mizan on 1H and 15m");
  assert.ok(now.reconciles.every(([, r]) => !("groups" in r)), "no group path ran");
});

test("B7-2 compareWithWebhooks without the new options deep-equals main's", () => {
  const main = fixture("parity-b7-compare-main.json");
  for (const [name, record, webhooks] of COMPARE_CASES) {
    const out = JSON.parse(JSON.stringify(compareWithWebhooks(record, webhooks, DEFAULT_POLICY)));
    assert.deepEqual(out, main[name], name);
    assert.deepEqual(JSON.parse(JSON.stringify(compareWithWebhooks(record, webhooks, DEFAULT_POLICY, {}))), main[name], name + " ({})");
    assert.deepEqual(JSON.parse(JSON.stringify(compareWithWebhooks(record, webhooks, DEFAULT_POLICY, { nullEqual: true, requireFinite: true }))), main[name], name + " (no fieldMap: the flags alone change nothing)");
  }
});

test("B7-3 no group id starts with mizan; the registry declares the witness group and B10's HUD groups, and it is sound", () => {
  assert.deepEqual(Object.keys(PARITY_GROUPS), [
    "probe_mizan_witness",
    "gmi_adopt_hud", "gmi_adopt_flow", "gmi_adopt_kin", "gmi_adopt_zone", "gmi_adopt_zone_levels", "gmi_adopt_burst", "gmi_adopt_order", "gmi_adopt_levels", "gmi_adopt_plan",
    "prophet_adopt_hud", "prophet_adopt_core", "prophet_adopt_ob", "prophet_adopt_scalp", "prophet_adopt_plan",
    "probe_mizan_core", "probe_mizan_mtf", "probe_mizan_decision", "probe_mizan_state"
  ]);
  assert.ok(Object.keys(PARITY_GROUPS).every((id) => !id.startsWith("mizan")));
  assert.deepEqual(parityGroupProblems(PARITY_GROUPS), []);
  const bad = { engine: "gmi", source: "gmi_v12_70", kind: "witness", fields: { verdict: "verdict" } };
  assert.ok(parityGroupProblems({ mizan_core: bad }).includes("mizan_core:id_starts_with_mizan"));
  assert.ok(parityGroupProblems({ gmi_hud: bad }).includes("gmi_hud:id_is_an_engine"));
  assert.ok(parityGroupProblems({ core_m15: bad }).includes("core_m15:id_has_timeframe_suffix"));
  assert.ok(parityGroupProblems({ w: { ...bad, nullEqual: true } }).includes("w:null_equal_outside_hud"));
  assert.ok(parityGroupProblems({ w: { ...bad, fields: {} } }).includes("w:fields_invalid"));
  // A group identity never reads as the Mizan library in isTrusted (an engine id starting "mizan").
  const id = groupIdentityOf(gmiHudRecord(), "grid_core", TEST_GROUPS);
  assert.equal(id.engine.startsWith("mizan"), false);
});

test("B7-4 the witness group: fields { net_witness, prior_edge }, nullEqual off, an explicit incomplete state", () => {
  const w = PARITY_GROUPS.probe_mizan_witness;
  assert.deepEqual({ ...w.fields }, { net_witness: "net_witness", prior_edge: "prior_edge" });
  assert.equal(w.kind, "witness");
  assert.equal(w.nullEqual, false);
  const options = groupCompareOptions("probe_mizan_witness");
  assert.equal(options.nullEqual, false);
  assert.equal(options.requireFinite, true);
  const candle = { o: 1, h: 2, l: 0.5, c: 1.5, volume: 10 };
  const run = (local, hook) => compareWithWebhooks(
    { engine: "probe_mizan", values: { candle, comparable: { probe_mizan_hud: local } } },
    { probe_mizan_hud: { ...candle, ...hook } }, DEFAULT_POLICY, options);

  // Both fields finite on both sides and equal: match.
  assert.equal(run({ net_witness: 0.42, prior_edge: -0.1 }, { net_witness: 0.42, prior_edge: -0.1 }).status, "match");
  // Null on both sides: incomplete, never a match.
  const nulls = run({ net_witness: null, prior_edge: null }, { net_witness: null, prior_edge: null });
  assert.equal(nulls.status, "incomplete");
  assert.equal(nulls.reason, "fields_not_finite");
  assert.deepEqual(nulls.null_fields, ["probe_mizan_hud:net_witness", "probe_mizan_hud:prior_edge"]);
  assert.deepEqual(nulls.missing, ["null:probe_mizan_hud:net_witness", "null:probe_mizan_hud:prior_edge"]);
  // One field null on both sides, the other equal: still incomplete.
  assert.equal(run({ net_witness: 0.42, prior_edge: null }, { net_witness: 0.42, prior_edge: null }).status, "incomplete");
  // Finite on one side only: no match (a mismatch, either way round).
  const oneSide = run({ net_witness: 0.42, prior_edge: -0.1 }, { net_witness: null, prior_edge: -0.1 });
  assert.equal(oneSide.status, "mismatch");
  assert.deepEqual(oneSide.mismatches.map((m) => m.field), ["net_witness"]);
  assert.equal(run({ net_witness: null, prior_edge: -0.1 }, { net_witness: 0.42, prior_edge: -0.1 }).status, "mismatch");
  assert.equal(run({ net_witness: "0.42", prior_edge: -0.1 }, { net_witness: 0.42, prior_edge: -0.1 }).status, "mismatch", "a string is not finite");
  // Finite and different: mismatch.
  assert.equal(run({ net_witness: 0.42, prior_edge: -0.1 }, { net_witness: 0.5, prior_edge: -0.1 }).status, "mismatch");
});

test("B7-5 nullEqual counts null === null as equal for a HUD group only; a fieldMap maps local to webhook names", () => {
  const candle = { o: 1, h: 2, l: 0.5, c: 1.5, volume: 10 };
  const groups = { hud_a: { engine: "gmi_hud", source: "s", kind: "hud", fields: { x: "x_hook" }, nullEqual: true }, wit_a: { engine: "gmi_hud", source: "s", kind: "witness", fields: { x: "x_hook" }, nullEqual: true } };
  const record = { engine: "gmi_hud", values: { candle, comparable: { s: { x: null } } } };
  const hooks = { s: { ...candle, x_hook: null } };
  assert.equal(compareWithWebhooks(record, hooks, DEFAULT_POLICY, groupCompareOptions("hud_a", groups)).status, "match");
  assert.equal(groupCompareOptions("wit_a", groups).nullEqual, false, "nullEqual is ignored outside a HUD group");
  assert.equal(compareWithWebhooks(record, hooks, DEFAULT_POLICY, groupCompareOptions("wit_a", groups)).status, "mismatch");
  const diff = compareWithWebhooks({ ...record, values: { candle, comparable: { s: { x: 2 } } } }, { s: { ...candle, x_hook: 3 } }, DEFAULT_POLICY, { fieldMap: { s: { x: "x_hook" } } });
  assert.equal(diff.status, "mismatch");
  assert.deepEqual(diff.mismatches, [{ source: "s", field: "x", webhook_field: "x_hook", local: 2, webhook: 3 }]);
  assert.deepEqual(diff.values, { s: { local: { x: 2 }, webhook: { x_hook: 3 } } });
});

test("B7-6 inert: no ingested engine declares a group, so the sweep's group path and the group KV reads never run", async () => {
  for (const engine of INGEST_ENGINES) assert.deepEqual(groupsFor(engine), [], engine);
  assert.equal(INGEST_ENGINES.includes(PARITY_GROUPS.probe_mizan_witness.engine), false);
  assert.equal(BASE_ENGINES.includes("probe_mizan"), false);
  const probeRecord = { engine: "probe_mizan", timeframe: "15", provenance: { source_hash: "a".repeat(64), implementation_hash: "b".repeat(64) } };
  assert.equal(groupIdentityOf(probeRecord, "probe_mizan_witness"), null, "no probe_mizan identity until B26 registers the engine");
  const env = { WEBHOOK_BUFFER: kv() };
  assert.equal(await approvedComparable(env, "OANDA:XAUUSD:60:1"), null);
  assert.equal(env.WEBHOOK_BUFFER.gets(), 3, "prophet, gmi and gmi_hud only, as on main");
});

// A test registry: two groups on the gmi_hud records (the Grid Bot comparator).
const TEST_GROUPS = Object.freeze({
  grid_core: { engine: "gmi_hud", source: "gmi_v12_70_hud", kind: "hud", fields: { cshi_viability: "cshi_viability", deploy_status: "deploy_status" } },
  grid_flags: { engine: "gmi_hud", source: "gmi_v12_70_hud", kind: "hud", fields: { muddy_waters: "muddy_waters", grid_viable: "grid_viable" } },
  grid_witness: { engine: "gmi_hud", source: "gmi_v12_70_hud", kind: "witness", fields: { score: "score" }, requireFinite: true }
});
const H = (c) => c.repeat(64);
const candle = { o: 3950.1, h: 3955.2, l: 3948.0, c: 3953.4, volume: 2103 };
const HUD = { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false, cshi_viability: 64, deploy_status: 3, muddy_waters: false, grid_viable: true };
function gmiHudRecord(timeframe = "60", extra = {}) {
  return { engine: "gmi_hud", timeframe, provenance: { source_hash: H("c"), implementation_hash: H("2") }, values: { candle, comparable: { gmi_v12_70_hud: { ...HUD, score: 0.5, ...extra } } } };
}

test("B7-7 groupIdentityOf: the engine identity's hashes under <group id><timeframe suffix>", () => {
  const h1 = groupIdentityOf(gmiHudRecord(), "grid_core", TEST_GROUPS);
  const base = identityOf(gmiHudRecord());
  assert.deepEqual(h1, { engine: "grid_core", sourceHash: base.sourceHash, implementationHash: base.implementationHash, mizanSourceHash: null, mizanImplementationHash: null, group: "grid_core", parentEngine: "gmi_hud" });
  assert.equal(groupIdentityOf(gmiHudRecord("15"), "grid_core", TEST_GROUPS).engine, "grid_core_m15");
  assert.equal(groupIdentityOf({ ...gmiHudRecord(), engine: "gmi" }, "grid_core", TEST_GROUPS), null, "another engine's record does not carry the group");
  assert.equal(groupIdentityOf(gmiHudRecord(), "nope", TEST_GROUPS), null);
  assert.deepEqual(groupsFor("gmi_hud", TEST_GROUPS), ["grid_core", "grid_flags", "grid_witness"]);
});

async function seed(env, key, hook, local = {}) {
  await ensureSchema(env.DB);
  const record = gmiHudRecord("60", local);
  await registerIdentity(env.DB, identityOf(record));
  await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":gmi_hud", JSON.stringify(record));
  await env.WEBHOOK_BUFFER.put("candle:" + key + ":gmi_v12_70_hud", JSON.stringify({ ...candle, ...HUD, score: 0.5, ...hook }));
}
const row = async (env, engine) => env.DB.prepare("SELECT status, consecutive_matches, total_matches, total_mismatches, total_incomplete FROM engine_parity_registry WHERE engine = ?").bind(engine).first();

test("B7-8 each group earns its own 24-candle trust; one bad field in one group revokes only that group", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const base = 1793750400000;
  const at = (i) => `OANDA:XAUUSD:60:${base + i * 3600000}`;
  for (let i = 0; i < 24; i += 1) {
    await seed(env, at(i), {});
    const r = await reconcileLocalComputation(env, at(i), { groups: TEST_GROUPS });
    assert.equal(r.groups.comparisons.grid_core.result, "match");
    assert.equal(r.groups.trust.grid_core, i === 23, "approved at the 24th match, not before");
  }
  for (const g of ["grid_core", "grid_flags", "grid_witness"]) assert.equal((await row(env, g)).status, "approved", g);
  assert.equal((await row(env, "gmi_hud")).status, "approved");

  // grid_viable differs: grid_flags (and the whole gmi_hud identity, as today) are revoked; grid_core stays.
  await seed(env, at(24), { grid_viable: false });
  const out = await reconcileLocalComputation(env, at(24), { groups: TEST_GROUPS });
  assert.equal(out.comparisons.gmi_hud.result, "mismatch");
  assert.equal(out.trust.gmi_hud, false);
  assert.deepEqual([out.groups.comparisons.grid_core.result, out.groups.comparisons.grid_flags.result, out.groups.comparisons.grid_witness.result], ["match", "mismatch", "match"]);
  assert.deepEqual(out.groups.trust, { grid_core: true, grid_flags: false, grid_witness: true });
  assert.equal((await row(env, "grid_flags")).status, "revoked");
  assert.equal((await row(env, "grid_core")).status, "approved");
  assert.equal((await row(env, "grid_core")).consecutive_matches, 25);

  // The trusted lane: grid_core's copy holds only its own fields; grid_flags' and gmi_hud's are gone.
  const core = JSON.parse(await env.WEBHOOK_BUFFER.get("localcalc:" + at(24) + ":grid_core"));
  assert.deepEqual(core.values.comparable, { gmi_v12_70_hud: { cshi_viability: 64, deploy_status: 3 } });
  assert.equal(core.trust_status, "approved_by_parity");
  assert.equal(core.group, "grid_core");
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + at(24) + ":grid_flags"), null);
  assert.equal(await env.WEBHOOK_BUFFER.get("localcalc:" + at(24) + ":gmi_hud"), null);

  // approvedComparable merges per source and per group: grid_core's fields stay comparable.
  const approved = await approvedComparable(env, at(24), { groups: TEST_GROUPS });
  assert.deepEqual(approved, { gmi_v12_70_hud: { cshi_viability: 64, deploy_status: 3, score: 0.5 } });
  assert.equal(await approvedComparable(env, at(24)), null, "the live registry reads no group key");
});

test("B7-9 a witness-like group with null on both sides records incomplete: neither advances nor resets its streak", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const key = (i) => `OANDA:XAUUSD:60:${1793750400000 + i * 3600000}`;
  for (let i = 0; i < 3; i += 1) { await seed(env, key(i), {}); await reconcileLocalComputation(env, key(i), { groups: TEST_GROUPS }); }
  await seed(env, key(3), { score: null }, { score: null });
  const r = await reconcileLocalComputation(env, key(3), { groups: TEST_GROUPS });
  assert.equal(r.groups.comparisons.grid_witness.result, "incomplete");
  assert.deepEqual(r.groups.comparisons.grid_witness.null_fields, ["gmi_v12_70_hud:score"]);
  assert.deepEqual({ ...(await row(env, "grid_witness")) }, { status: "candidate", consecutive_matches: 3, total_matches: 3, total_mismatches: 0, total_incomplete: 1 });
  assert.equal(r.comparisons.gmi_hud.result, "match", "the engine identity does not compare the group's extra field");
  assert.equal(await isTrusted(env.DB, groupIdentityOf(gmiHudRecord(), "grid_witness", TEST_GROUPS)), false);
});

test("B7-10 an MT5 fallback record skips the group comparisons too", async () => {
  const env = { DB: d1(), WEBHOOK_BUFFER: kv() };
  const key = "OANDA:XAUUSD:60:1793750400000";
  await seed(env, key, {});
  const k = "localcalc-observed:" + key + ":gmi_hud";
  await env.WEBHOOK_BUFFER.put(k, JSON.stringify({ ...JSON.parse(await env.WEBHOOK_BUFFER.get(k)), feed: "mt5_fallback" }));
  const r = await reconcileLocalComputation(env, key, { groups: TEST_GROUPS });
  assert.equal(r.groups.comparisons.grid_core.result, "fallback_skipped");
  assert.equal(await row(env, "grid_core"), null, "nothing registered or counted");
});

test("B7-11 validateHudSnapshot drops an unknown HUD id and keeps the rest of the snapshot", async () => {
  const now = Date.parse("2026-11-05T12:01:00Z");
  const key = "OANDA:XAUUSD:60:" + Date.parse("2026-11-05T11:00:00Z");
  const snap = {
    schema_version: HUD_SNAPSHOT_VERSION, symbol: "OANDA:XAUUSD", timeframe: "60", candle_key: key,
    candle_time: "2026-11-05T11:00:00.000Z", computed_at: "2026-11-05T12:00:30.000Z", not_computed: [],
    huds: {
      decision_matrix: { fields: { verdict: 3, gate: 2, conflict: false }, parity: { verdict: "gmi_v12_70.verdict" } },
      mizan_oracle_next: { fields: { anything: 1 } }
    }
  };
  const v = validateHudSnapshot(snap, now);
  assert.equal(v.valid, true);
  assert.deepEqual(v.dropped_huds, ["mizan_oracle_next"]);
  const env = { SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv() };
  const warn = console.warn; const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  let res;
  try { res = await storeHudSnapshot(env, snap, now); } finally { console.warn = warn; }
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.dropped_huds, ["mizan_oracle_next"]);
  assert.ok(lines.some((l) => l.startsWith("hud_snapshot_dropped_huds") && l.includes("mizan_oracle_next")));
  const stored = await loadHudSnapshot(env, { timeframe: "60" });
  assert.deepEqual(Object.keys(stored.huds), ["decision_matrix"]);
  assert.deepEqual(stored.huds.decision_matrix, snap.huds.decision_matrix);
  assert.deepEqual(stored.dropped_huds, ["mizan_oracle_next"]);
  const readings = await hudReadings(env, stored);
  assert.deepEqual(Object.keys(readings.readings), ["decision_matrix"]);
  assert.deepEqual(readings.dropped_huds, ["mizan_oracle_next"]);
  // A snapshot of known HUDs only is stored and read exactly as before (no dropped_huds key).
  const clean = { ...snap, huds: { decision_matrix: snap.huds.decision_matrix } };
  assert.deepEqual(validateHudSnapshot(clean, now), { valid: true, errors: [] });
  const res2 = await storeHudSnapshot(env, clean, now);
  assert.deepEqual(res2.body, { status: "accepted", candle_key: key, timeframe: "60" });
  const stored2 = await loadHudSnapshot(env, { timeframe: "60" });
  assert.equal("dropped_huds" in stored2, false);
  assert.equal("dropped_huds" in (await hudReadings(env, stored2)), false);
});
