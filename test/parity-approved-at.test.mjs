// The approved_at / revoked_at fix (2026-11-25): the recordComparison bind, the reclassification's
// guard against a non-ISO approved_at, the one-time approved_at repair, and the single-shot
// reclassification marker.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureSchema, registerIdentity, recordComparison, registryApproved, listRegistry, reclassifyInputOnlyMismatches,
  repairApprovedAt, isIsoTimestamp, resetSchemaCacheForTests, DEFAULT_POLICY, INPUT_MISMATCH_REVOKE_AFTER
} from "../src/parity-registry.mjs";
import {
  repairApprovedAtOnce, reclassifyOnce, reconcileRecentCandles, APPROVED_AT_REPAIR_MARKER, RECLASSIFY_MARKER
} from "../src/parity-sweep.mjs";
import { readParityView } from "../src/parity-view.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  let prepared = 0;
  return {
    db, prepared: () => prepared,
    prepare(sql) {
      prepared += 1;
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
function kv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const puts = [];
  return {
    map, puts,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value, options) { puts.push([key, options]); map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };
}

const H = (c) => c.repeat(64);
const MIZAN = { mizanSourceHash: H("9"), mizanImplementationHash: H("8") };
const ident = (engine, s, i, mizan = true) => ({ engine, sourceHash: H(s), implementationHash: H(i), ...(mizan ? MIZAN : { mizanSourceHash: null, mizanImplementationHash: null }) });
const at = (n) => new Date(Date.parse("2026-11-20T00:00:00.000Z") + n * 60_000).toISOString();
const MATCH = { status: "match", compared: 10, mismatches: [], missing: [] };
const MISMATCH = { status: "mismatch", compared: 10, mismatches: [{ source: "gmi_v12_70", field: "verdict", local: 3, webhook: -3 }], missing: [] };
const INCOMPLETE = { status: "incomplete", compared: 9, mismatches: [], missing: ["gmi_v12_70:verdict"] };
const INPUT = { status: "input_mismatch", compared: 10, mismatches: [{ source: "gmi_v12_70", field: "input:c", local: 1, webhook: 2 }], missing: [] };
const row = (db, id) => ({ ...db.db.prepare("SELECT * FROM engine_parity_registry WHERE engine = ? AND source_hash = ? AND implementation_hash = ?").get(id.engine, id.sourceHash, id.implementationHash) });

test.beforeEach(() => resetSchemaCacheForTests());

test("PF-1 the 24th consecutive match approves with approved_at = now and clears revoked_at; re-approval after a revocation too", async () => {
  const db = d1();
  await ensureSchema(db);
  const id = ident("gmi", "b", "1");
  await registerIdentity(db, id, at(0));
  for (let i = 0; i < 23; i += 1) await recordComparison(db, id, "k" + i, MATCH, DEFAULT_POLICY, at(i));
  assert.equal(row(db, id).status, "candidate");
  assert.equal(row(db, id).approved_at, null);
  await recordComparison(db, id, "k23", MATCH, DEFAULT_POLICY, at(23));
  let r = row(db, id);
  assert.equal(r.status, "approved");
  assert.equal(r.approved_at, at(23), "the approval time, an ISO timestamp");
  assert.ok(isIsoTimestamp(r.approved_at));
  assert.equal(r.revoked_at, null);
  // A further match on an approved identity keeps its approval time.
  await recordComparison(db, id, "k24", MATCH, DEFAULT_POLICY, at(24));
  assert.equal(row(db, id).approved_at, at(23));

  // Revoked by an indicator mismatch, then re-earned: revoked_at stays until the 24th match, then NULL.
  await recordComparison(db, id, "k25", MISMATCH, DEFAULT_POLICY, at(25));
  r = row(db, id);
  assert.equal(r.status, "revoked");
  assert.equal(r.revoked_at, at(25));
  assert.equal(r.approved_at, at(23));
  for (let i = 0; i < 23; i += 1) await recordComparison(db, id, "r" + i, MATCH, DEFAULT_POLICY, at(26 + i));
  r = row(db, id);
  assert.equal(r.status, "revoked");
  assert.equal(r.revoked_at, at(25), "kept while the streak is short");
  await recordComparison(db, id, "r23", MATCH, DEFAULT_POLICY, at(49));
  r = row(db, id);
  assert.equal(r.status, "approved");
  assert.equal(r.approved_at, at(49), "the re-approval time");
  assert.equal(r.revoked_at, null);
  assert.equal(await registryApproved(db, id), true);
});

test("PF-2 mismatch, incomplete and input_mismatch behave as before the bind fix", async () => {
  const db = d1();
  await ensureSchema(db);
  const id = ident("prophet", "a", "1");
  await registerIdentity(db, id, at(0));
  const pick = (r) => ({ status: r.status, consecutive_matches: r.consecutive_matches, total_matches: r.total_matches, total_mismatches: r.total_mismatches, total_incomplete: r.total_incomplete, last_result: r.last_result, approved_at: r.approved_at, revoked_at: r.revoked_at, updated_at: r.updated_at });
  await recordComparison(db, id, "c0", MATCH, DEFAULT_POLICY, at(0));
  await recordComparison(db, id, "c1", MISMATCH, DEFAULT_POLICY, at(1));
  assert.deepEqual(pick(row(db, id)), { status: "candidate", consecutive_matches: 0, total_matches: 1, total_mismatches: 1, total_incomplete: 0, last_result: "mismatch", approved_at: null, revoked_at: null, updated_at: at(1) }, "a candidate's mismatch resets the streak only");
  await recordComparison(db, id, "c2", MATCH, DEFAULT_POLICY, at(2));
  await recordComparison(db, id, "c3", INCOMPLETE, DEFAULT_POLICY, at(3));
  assert.deepEqual(pick(row(db, id)), { status: "candidate", consecutive_matches: 1, total_matches: 2, total_mismatches: 1, total_incomplete: 1, last_result: "incomplete", approved_at: null, revoked_at: null, updated_at: at(3) }, "incomplete neither advances nor resets");
  const input = await recordComparison(db, id, "c4", INPUT, DEFAULT_POLICY, at(4));
  assert.deepEqual(input, { counted: false, result: "input_mismatch" });
  assert.deepEqual(pick(row(db, id)), { status: "candidate", consecutive_matches: 1, total_matches: 2, total_mismatches: 1, total_incomplete: 1, last_result: "input_mismatch", approved_at: null, revoked_at: null, updated_at: at(4) }, "input_mismatch counts nothing");
  for (let i = 1; i < INPUT_MISMATCH_REVOKE_AFTER - 1; i += 1) await recordComparison(db, id, "c" + (4 + i), INPUT, DEFAULT_POLICY, at(4 + i));
  const third = await recordComparison(db, id, "c9", INPUT, DEFAULT_POLICY, at(9));
  assert.equal(third.escalated, "repeated_input_mismatch");
  assert.equal(row(db, id).consecutive_matches, 0);
  assert.equal(row(db, id).total_mismatches, 2);
  // On an approved identity a mismatch revokes and stamps revoked_at, as before.
  for (let i = 0; i < 24; i += 1) await recordComparison(db, id, "m" + i, MATCH, DEFAULT_POLICY, at(10 + i));
  assert.equal(row(db, id).approved_at, at(33));
  await recordComparison(db, id, "x", MISMATCH, DEFAULT_POLICY, at(40));
  assert.deepEqual(pick(row(db, id)), { status: "revoked", consecutive_matches: 0, total_matches: 26, total_mismatches: 3, total_incomplete: 1, last_result: "mismatch", approved_at: at(33), revoked_at: at(40), updated_at: at(40) });
});

test("PF-3 the reclassification never restores a row whose approved_at is not ISO", async () => {
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 1 };
  const real = ident("gmi_hud", "c", "2");
  const inputOnly = ident("gmi_m5", "b", "3");
  const control = ident("prophet_m5", "a", "3");
  for (const id of [real, inputOnly, control]) { await registerIdentity(db, id, at(0)); await recordComparison(db, id, "k0", MATCH, policy, at(1)); }
  // gmi_hud: revoked by a real indicator mismatch; inputOnly and control by an old input-only mismatch.
  await recordComparison(db, real, "k1", MISMATCH, policy, at(5));
  const oldInput = { status: "mismatch", compared: 10, mismatches: [{ field: "input:c" }], missing: [] };
  await recordComparison(db, inputOnly, "k1", oldInput, policy, at(5));
  await recordComparison(db, control, "k1", oldInput, policy, at(5));
  // The old bind's approval time.
  db.db.prepare("UPDATE engine_parity_registry SET approved_at = '24.0' WHERE engine IN ('gmi_hud', 'gmi_m5')").run();
  assert.equal(db.db.prepare("SELECT ? >= '24.0' AS later").get(at(5)).later, 0, "an ISO compared_at sorts before \"24.0\": the old query saw no mismatch after the approval");

  const r = await reclassifyInputOnlyMismatches(db, at(9));
  assert.deepEqual(r, { reclassified: 2, restored: ["prophet_m5"] }, "only the row with a real approval time is restored");
  assert.equal(row(db, real).status, "revoked", "a real mismatch after a \"24.0\" approval stays revoked");
  assert.equal(row(db, inputOnly).status, "revoked", "an unknown approval time is never restored");
  assert.equal(row(db, control).status, "approved");
});

/**
 * The production shape (2026-11-25 04:20Z): five approved and two revoked rows with approved_at
 * "24.0", plus rows the repair must not touch. Returns { ids, expected }.
 */
async function buildWorld(db) {
  await ensureSchema(db);
  const ids = {
    gmi: ident("gmi", "e", "1"),                 // approved, no mismatch ever; incomplete and input_mismatch interleaved
    gmi_h4: ident("gmi_h4", "e", "2"),           // approved, one mismatch, then 30 matches; a stale revoked_at
    gmi_m15: ident("gmi_m15", "6", "3"),         // approved, two mismatches, the streak after the last one
    prophet_h4: ident("prophet_h4", "a", "4"),   // approved, exactly 24 matches
    prophet_m5: ident("prophet_m5", "a", "5"),   // approved but only 10 matches after its last mismatch: skipped
    gmi_hud: ident("gmi_hud", "7", "6"),         // revoked
    gmi_m5: ident("gmi_m5", "7", "7"),           // revoked
    prophet: ident("prophet", "a", "1"),         // approved with an ISO approved_at: untouched
    prophet_m15: ident("prophet_m15", "a", "8"), // candidate: untouched
    mizan: ident("mizan", "9", "8", false)       // vouched for by prophet and gmi
  };
  const expected = {};
  let n = 0;
  const cmp = async (id, result, count = 1) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const when = at(n);
      db.db.prepare("INSERT INTO engine_parity_comparisons (engine, source_hash, implementation_hash, candle_key, result, detail, compared_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id.engine, id.sourceHash, id.implementationHash, "c" + n, result, "{}", when);
      out.push(when);
    }
    return out;
  };
  for (const id of Object.values(ids)) await registerIdentity(db, id, at(0));
  // gmi: 10 matches, an incomplete, an input mismatch, 20 matches: the 24th match is the 14th after the gap.
  const g1 = await cmp(ids.gmi, "match", 10); await cmp(ids.gmi, "incomplete"); await cmp(ids.gmi, "input_mismatch");
  const g2 = await cmp(ids.gmi, "match", 20);
  expected.gmi = [...g1, ...g2][23];
  await cmp(ids.gmi_h4, "match", 3); await cmp(ids.gmi_h4, "mismatch");
  expected.gmi_h4 = (await cmp(ids.gmi_h4, "match", 30))[23];
  await cmp(ids.gmi_m15, "match", 30); await cmp(ids.gmi_m15, "mismatch"); await cmp(ids.gmi_m15, "match", 5); await cmp(ids.gmi_m15, "mismatch");
  expected.gmi_m15 = (await cmp(ids.gmi_m15, "match", 26))[23];
  expected.prophet_h4 = (await cmp(ids.prophet_h4, "match", 24))[23];
  await cmp(ids.prophet_m5, "match", 24); await cmp(ids.prophet_m5, "mismatch"); await cmp(ids.prophet_m5, "match", 10);
  await cmp(ids.gmi_hud, "match", 24); await cmp(ids.gmi_hud, "mismatch"); await cmp(ids.gmi_hud, "match", 5);
  await cmp(ids.gmi_m5, "match", 30); await cmp(ids.gmi_m5, "mismatch");
  await cmp(ids.prophet, "match", 24);
  await cmp(ids.prophet_m15, "match", 3);
  const set = (id, fields) => db.db.prepare(`UPDATE engine_parity_registry SET ${Object.keys(fields).map((k) => k + " = ?").join(", ")} WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`)
    .run(...Object.values(fields), id.engine, id.sourceHash, id.implementationHash);
  const approved = (c, m) => ({ status: "approved", approved_at: "24.0", consecutive_matches: c, total_matches: c, total_mismatches: m, updated_at: at(500) });
  set(ids.gmi, { ...approved(30, 0), total_incomplete: 1 });
  set(ids.gmi_h4, { ...approved(30, 1), revoked_at: at(4) });
  set(ids.gmi_m15, approved(26, 2));
  set(ids.prophet_h4, approved(24, 0));
  set(ids.prophet_m5, approved(10, 1));
  set(ids.gmi_hud, { status: "revoked", approved_at: "24.0", revoked_at: at(300), consecutive_matches: 5, total_matches: 29, total_mismatches: 1, updated_at: at(501) });
  set(ids.gmi_m5, { status: "revoked", approved_at: "24.0", revoked_at: at(301), consecutive_matches: 0, total_matches: 30, total_mismatches: 1, updated_at: at(502) });
  set(ids.prophet, { status: "approved", approved_at: at(200), consecutive_matches: 24, total_matches: 24, updated_at: at(503) });
  set(ids.prophet_m15, { consecutive_matches: 3, total_matches: 3, updated_at: at(504) });
  return { ids, expected };
}

const strip = (rows) => rows.map(({ approved_at, revoked_at, ...rest }) => rest);
const label = (id) => `${id.engine}:${id.sourceHash.slice(0, 8)}:${id.implementationHash.slice(0, 8)}`;

test("PF-4 the approved_at repair: the streak-completing match, revoked_at on approved rows, skipped rows untouched", async () => {
  const db = d1();
  const { ids, expected } = await buildWorld(db);
  const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, row(db, id)]));
  const trustedBefore = {};
  for (const [k, id] of Object.entries(ids)) trustedBefore[k] = await registryApproved(db, id);
  const viewBefore = await readParityView(db, { now: Date.parse(at(600)) });
  const listedBefore = await listRegistry(db, 200);
  const comparisonsBefore = db.db.prepare("SELECT * FROM engine_parity_comparisons ORDER BY engine, candle_key").all();

  const result = await repairApprovedAt(db);
  assert.deepEqual(result, { repaired: 4, skipped: [label(ids.gmi_hud), label(ids.gmi_m5), label(ids.prophet_m5)], revoked_cleared: 1 });

  for (const k of ["gmi", "gmi_h4", "gmi_m15", "prophet_h4"]) {
    const r = row(db, ids[k]);
    assert.equal(r.approved_at, expected[k], k + ": the 24th match after the last mismatch");
    assert.equal(r.revoked_at, null, k);
  }
  for (const k of ["prophet_m5", "gmi_hud", "gmi_m5"]) assert.deepEqual(row(db, ids[k]), before[k], k + ": skipped, nothing written");
  for (const k of ["prophet", "prophet_m15", "mizan"]) assert.deepEqual(row(db, ids[k]), before[k], k + ": not a non-ISO row");
  // Nothing but the two columns changed: status, counters, updated_at, comparisons.
  for (const [k, id] of Object.entries(ids)) {
    const { approved_at: _a, revoked_at: _r, ...rest } = row(db, id);
    const { approved_at: _b, revoked_at: _s, ...restBefore } = before[k];
    assert.deepEqual(rest, restBefore, k);
    assert.equal(await registryApproved(db, id), trustedBefore[k], k + ": registryApproved unchanged");
  }
  assert.equal(trustedBefore.mizan, true, "the scenario covers a trusted Mizan");
  assert.deepEqual(db.db.prepare("SELECT * FROM engine_parity_comparisons ORDER BY engine, candle_key").all(), comparisonsBefore);
  // The parity view differs only in approved_at / revoked_at (and the health fields derived from revoked_at).
  const viewAfter = await readParityView(db, { now: Date.parse(at(600)) });
  assert.deepEqual(strip(viewAfter.registry), strip(viewBefore.registry));
  const health = (h) => h.map(({ revoked, ok, ...rest }) => rest);
  assert.deepEqual(health(viewAfter.health), health(viewBefore.health));
  assert.deepEqual({ ...viewAfter, registry: null, health: null }, { ...viewBefore, registry: null, health: null });
  assert.deepEqual(strip(await listRegistry(db, 200)), strip(listedBefore));
  // A second run writes nothing: only the skipped rows are still non-ISO.
  assert.deepEqual(await repairApprovedAt(db), { repaired: 0, skipped: result.skipped, revoked_cleared: 0 });
});

test("PF-5 repairApprovedAtOnce runs once behind its KV marker, with one log line of ids and counts", async () => {
  const db = d1();
  const { ids, expected } = await buildWorld(db);
  const env = { DB: db, SIGNAL_CACHE: kv() };
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args); };
  let first, second;
  try {
    first = await repairApprovedAtOnce(env, Date.parse(at(700)));
    // Put a bad value back: only the marker keeps the repair from running again.
    db.db.prepare("UPDATE engine_parity_registry SET approved_at = '24.0' WHERE engine = 'gmi'").run();
    second = await repairApprovedAtOnce(env, Date.parse(at(701)));
  } finally { console.log = original; }
  assert.equal(first.status, "ok");
  assert.equal(first.repaired, 4);
  assert.deepEqual(second, { status: "done_before" });
  assert.equal(row(db, ids.gmi).approved_at, "24.0", "the marker prevented a re-run");
  assert.equal(row(db, ids.gmi_h4).approved_at, expected.gmi_h4);
  assert.deepEqual(env.SIGNAL_CACHE.puts, [[APPROVED_AT_REPAIR_MARKER, undefined]], "one marker write, without a TTL");
  assert.deepEqual(JSON.parse(env.SIGNAL_CACHE.map.get(APPROVED_AT_REPAIR_MARKER)), { repaired: 4, skipped: [label(ids.gmi_hud), label(ids.gmi_m5), label(ids.prophet_m5)], revoked_cleared: 1, at: at(700) });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "parity_approved_at_repair");
  assert.deepEqual(JSON.parse(logs[0][1]), { event: "parity_approved_at_repair", repaired: 4, skipped: [label(ids.gmi_hud), label(ids.gmi_m5), label(ids.prophet_m5)], revoked_cleared: 1 });
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(logs[0][1]), "ids and counts only");
  // Without a marker store it refuses instead of running on every sweep.
  resetSchemaCacheForTests();
  const bare = d1();
  await buildWorld(bare);
  const prepared = bare.prepared();
  assert.deepEqual(await repairApprovedAtOnce({ DB: bare }), { status: "no_marker_store" });
  assert.equal(bare.prepared(), prepared);
});

test("PF-6 the sweep's output is the same with and without the repair", async () => {
  const run = async (marker) => {
    resetSchemaCacheForTests();
    const db = d1();
    await buildWorld(db);
    const env = { DB: db, WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv({ [RECLASSIFY_MARKER]: "{}", ...(marker ? { [APPROVED_AT_REPAIR_MARKER]: "{}" } : {}) }) };
    const original = console.log;
    console.log = () => {};
    try { return { sweep: await reconcileRecentCandles(env, { now: Date.parse("2026-11-20T12:10:00Z") }), rows: db.db.prepare("SELECT * FROM engine_parity_registry ORDER BY engine").all() }; }
    finally { console.log = original; }
  };
  const repaired = await run(false);
  const unrepaired = await run(true);
  assert.deepEqual(repaired.sweep, unrepaired.sweep);
  assert.deepEqual(strip(repaired.rows), strip(unrepaired.rows));
  assert.notDeepEqual(repaired.rows, unrepaired.rows, "the repair did run in the first sweep");
});

test("PF-7 the reclassification is single-shot: the marker present, it never runs; absent, it runs once and sets it", async () => {
  const seedInputOnly = async () => {
    resetSchemaCacheForTests();
    const db = d1();
    await ensureSchema(db);
    const id = ident("prophet", "a", "1");
    await registerIdentity(db, id, at(0));
    await recordComparison(db, id, "k0", MATCH, { ...DEFAULT_POLICY, promoteAfter: 1 }, at(1));
    await recordComparison(db, id, "k1", { status: "mismatch", compared: 10, mismatches: [{ field: "input:c" }], missing: [] }, DEFAULT_POLICY, at(2));
    return { db, id };
  };
  const quiet = async (fn) => { const original = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = original; } };

  // Marker present: never runs, the database is not touched.
  const present = await seedInputOnly();
  const store = kv({ [RECLASSIFY_MARKER]: JSON.stringify({ at: "2026-11-06T09:10:00.000Z" }) });
  const prepared = present.db.prepared();
  assert.deepEqual(await reclassifyOnce({ DB: present.db, SIGNAL_CACHE: store }), { status: "done_before" });
  assert.equal(present.db.prepared(), prepared);
  assert.equal(row(present.db, present.id).status, "revoked");
  assert.deepEqual(store.puts, []);

  // Marker absent: runs once, sets the marker (claimed first, then the result; never a TTL), never again.
  const absent = await seedInputOnly();
  const fresh = kv();
  const ran = await quiet(() => reclassifyOnce({ DB: absent.db, SIGNAL_CACHE: fresh }, Date.parse(at(10))));
  assert.deepEqual(ran, { status: "ok", reclassified: 1, restored: ["prophet"] });
  assert.equal(row(absent.db, absent.id).status, "approved");
  assert.deepEqual(fresh.puts, [[RECLASSIFY_MARKER, undefined], [RECLASSIFY_MARKER, undefined]]);
  assert.deepEqual(JSON.parse(fresh.map.get(RECLASSIFY_MARKER)), { reclassified: 1, restored: ["prophet"], at: at(10) });
  // Revoke it again by an input-only mismatch: a second call must not restore it.
  await recordComparison(absent.db, absent.id, "k2", { status: "mismatch", compared: 10, mismatches: [{ field: "input:c" }], missing: [] }, DEFAULT_POLICY, at(11));
  assert.equal(row(absent.db, absent.id).status, "revoked");
  assert.deepEqual(await reclassifyOnce({ DB: absent.db, SIGNAL_CACHE: fresh }), { status: "done_before" });
  assert.equal(row(absent.db, absent.id).status, "revoked");

  // A run that fails part-way is not repeated: the marker was claimed before the work.
  const failing = await seedInputOnly();
  const claimed = kv();
  const broken = { prepare(sql) { if (/json_each/.test(sql)) throw new Error("boom"); return failing.db.prepare(sql); } };
  const errorLog = console.error;
  console.error = () => {};
  try { assert.deepEqual(await reclassifyOnce({ DB: broken, SIGNAL_CACHE: claimed }), { status: "error" }); }
  finally { console.error = errorLog; }
  assert.equal(JSON.parse(claimed.map.get(RECLASSIFY_MARKER)).status, "claimed");
  assert.deepEqual(await reclassifyOnce({ DB: failing.db, SIGNAL_CACHE: claimed }), { status: "done_before" });
  assert.equal(row(failing.db, failing.id).status, "revoked");

  // No marker store (no SIGNAL_CACHE binding): it refuses instead of running on every sweep.
  const none = await seedInputOnly();
  const before = none.db.prepared();
  assert.deepEqual(await reclassifyOnce({ DB: none.db }), { status: "no_marker_store" });
  assert.deepEqual(await reclassifyOnce({ DB: none.db, SIGNAL_CACHE: { async get() { return null; } } }), { status: "no_marker_store" }, "a store that cannot write is no store");
  assert.equal(none.db.prepared(), before);
  assert.equal(row(none.db, none.id).status, "revoked");
});

test("PF-8 the B7 scenario after the fix: real ISO approval times, and the revoked gmi identities are not restored", async () => {
  const { runParityScenario } = await import("./support/parity-scenario.mjs");
  const original = console.log;
  console.log = () => {};
  let out;
  try { out = await runParityScenario(); } finally { console.log = original; }
  const byEngine = Object.fromEntries(out.registry.map((r) => [r.engine, r]));
  for (const engine of ["prophet", "prophet_m15", "gmi", "gmi_m15", "gmi_hud", "gmi_hud_m15"]) assert.ok(isIsoTimestamp(byEngine[engine].approved_at), engine);
  for (const engine of ["gmi", "gmi_m15", "gmi_hud", "gmi_hud_m15"]) {
    assert.equal(byEngine[engine].status, "revoked", engine + ": revoked by an indicator mismatch, never restored");
    assert.ok(byEngine[engine].revoked_at > byEngine[engine].approved_at, engine);
  }
  assert.deepEqual(JSON.parse(Object.fromEntries(out.signal_cache)[RECLASSIFY_MARKER]).restored, []);
  assert.deepEqual(JSON.parse(Object.fromEntries(out.signal_cache)[APPROVED_AT_REPAIR_MARKER]), { repaired: 0, skipped: [], revoked_cleared: 0, at: out.sweep.swept_at });
});
