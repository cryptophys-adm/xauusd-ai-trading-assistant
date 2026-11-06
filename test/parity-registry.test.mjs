import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  compareWithWebhooks, identityOf, ensureSchema, registerIdentity, recordComparison, isTrusted, listRegistry,
  resetSchemaCacheForTests, policyFromEnv, DEFAULT_POLICY, scopedEngine, INPUT_MISMATCH_REVOKE_AFTER
} from "../src/parity-registry.mjs";

/** Minimal D1 adapter over node:sqlite so the registry SQL runs for real. */
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

const H = (c) => c.repeat(64);
const candle = { o: 3950.1, h: 3955.2, l: 3948.0, c: 3953.4, volume: 2103 };
function webhooks(overrides = {}) {
  return {
    prophet_r38: { ...candle, direction: 1, buy_confirmed: true, sell_confirmed: false, buy_high_quality: false, sell_high_quality: false, t_enc: 2, d_enc: -1, structure_subtype: 0 },
    prophet_r37_ssot: { ...candle, direction: 1, d_enc: -1, b_enc: 2, structure_subtype: 0, bull_event: true, bear_event: false },
    gmi_v12_70: { ...candle, verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false },
    ...overrides
  };
}
function local(engine, comparable, extra = {}) {
  return {
    engine,
    provenance: { source_hash: H({ prophet: "a", gmi: "b", mizan: "c" }[engine]), implementation_hash: H("1"), ...(extra.dependencies ? { dependencies: extra.dependencies } : {}) },
    values: { candle: extra.candle ?? candle, comparable }
  };
}
const prophetComparable = () => {
  const w = webhooks();
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    prophet_r38: pick(w.prophet_r38, ["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype"]),
    prophet_r37_ssot: pick(w.prophet_r37_ssot, ["direction", "d_enc", "b_enc", "structure_subtype", "bull_event", "bear_event"])
  };
};
const gmiComparable = () => ({ gmi_v12_70: { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false } });
const mizanDep = { mizan: { source_hash: H("d"), implementation_hash: H("2") } };

test.beforeEach(() => resetSchemaCacheForTests());

test("comparison matches field-by-field including raw candle inputs, with numeric tolerance", () => {
  const result = compareWithWebhooks(local("prophet", prophetComparable()), webhooks());
  assert.equal(result.status, "match");
  assert.equal(result.compared, 2 * 5 + 8 + 6);
  const nearly = local("prophet", prophetComparable(), { candle: { ...candle, c: candle.c + 1e-9 } });
  assert.equal(compareWithWebhooks(nearly, webhooks()).status, "match");
});

test("a differing indicator value is a mismatch; a differing input bar alone is an input mismatch", () => {
  const value = prophetComparable();
  value.prophet_r38.d_enc = 1;
  const r1 = compareWithWebhooks(local("prophet", value), webhooks());
  assert.equal(r1.status, "mismatch");
  assert.deepEqual(r1.mismatches.map((m) => m.field), ["d_enc"]);
  const r2 = compareWithWebhooks(local("gmi", gmiComparable(), { candle: { ...candle, h: candle.h + 0.5 } }), webhooks());
  assert.equal(r2.status, "input_mismatch");
  assert.equal(r2.mismatches[0].field, "input:h");
});

test("missing local fields are incomplete; absent webhooks or Mizan are not comparable", () => {
  const partial = prophetComparable();
  delete partial.prophet_r37_ssot;
  assert.equal(compareWithWebhooks(local("prophet", partial), webhooks()).status, "incomplete");
  const noR37 = webhooks();
  delete noR37.prophet_r37_ssot;
  assert.equal(compareWithWebhooks(local("prophet", prophetComparable()), noR37).status, "not_comparable");
  assert.equal(compareWithWebhooks(local("mizan", {}), webhooks()).status, "not_comparable");
});

test("identity requires SHA-256 hashes and captures the declared Mizan dependency", () => {
  assert.equal(identityOf({ engine: "prophet", provenance: { source_hash: "x", implementation_hash: H("1") } }), null);
  const id = identityOf(local("gmi", {}, { dependencies: mizanDep }));
  assert.equal(id.mizanSourceHash, H("d"));
  assert.equal(identityOf(local("mizan", {})).mizanSourceHash, null);
});

test("N consecutive matches promote; a mismatch revokes; revoked must re-earn N; each candle counts once", async () => {
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 3 };
  const id = identityOf(local("prophet", {}));
  await registerIdentity(db, id);
  const match = { status: "match", compared: 24, mismatches: [], missing: [] };
  const mismatch = { status: "mismatch", compared: 24, mismatches: [{ field: "d_enc" }], missing: [] };

  await recordComparison(db, id, "k1", match, policy);
  assert.equal((await recordComparison(db, id, "k1", match, policy)).counted, false); // duplicate candle
  await recordComparison(db, id, "k2", match, policy);
  assert.equal(await isTrusted(db, id), false);
  await recordComparison(db, id, "k3", match, policy);
  assert.equal(await isTrusted(db, id), true);

  await recordComparison(db, id, "k4", { status: "incomplete", compared: 0, mismatches: [], missing: ["x"] }, policy);
  assert.equal(await isTrusted(db, id), true);

  await recordComparison(db, id, "k5", mismatch, policy);
  assert.equal(await isTrusted(db, id), false);
  const [row] = await listRegistry(db);
  assert.equal(row.status, "revoked");
  assert.equal(row.consecutive_matches, 0);
  assert.equal(row.total_matches, 3);
  assert.equal(row.total_mismatches, 1);
  assert.deepEqual(row.last_detail.mismatches, [{ field: "d_enc" }]);

  for (const k of ["k6", "k7"]) await recordComparison(db, id, k, match, policy);
  assert.equal(await isTrusted(db, id), false);
  await recordComparison(db, id, "k8", match, policy);
  assert.equal(await isTrusted(db, id), true);
});

test("Mizan is trusted only while approved Prophet AND GMI both declare the same Mizan dependency", async () => {
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 1 };
  const mizan = identityOf(local("mizan", {}, {}));
  mizan.sourceHash = H("d"); mizan.implementationHash = H("2");
  const prophet = identityOf(local("prophet", {}, { dependencies: mizanDep }));
  const gmi = identityOf(local("gmi", {}, { dependencies: mizanDep }));
  for (const id of [mizan, prophet, gmi]) await registerIdentity(db, id);
  const match = { status: "match", compared: 1, mismatches: [], missing: [] };

  await recordComparison(db, prophet, "k1", match, policy);
  assert.equal(await isTrusted(db, mizan), false);
  await recordComparison(db, gmi, "k1", match, policy);
  assert.equal(await isTrusted(db, mizan), true);
  await recordComparison(db, gmi, "k2", { status: "mismatch", compared: 1, mismatches: [{}], missing: [] }, policy);
  assert.equal(await isTrusted(db, mizan), false);
});

test("registry ids are timeframe-scoped: H1 keeps the bare id, 5m, 15m, H4 and D1 earn their own", () => {
  assert.equal(scopedEngine("prophet", "60"), "prophet");
  assert.equal(scopedEngine("prophet", "H1"), "prophet");
  assert.equal(scopedEngine("gmi", undefined), "gmi");
  assert.equal(scopedEngine("prophet", "5"), "prophet_m5");
  assert.equal(scopedEngine("mizan", "M5"), "mizan_m5");
  assert.equal(scopedEngine("prophet_hud", "15"), "prophet_hud_m15");
  assert.equal(scopedEngine("prophet", "240"), "prophet_h4");
  assert.equal(scopedEngine("gmi", "1D"), "gmi_d1");
  assert.equal(scopedEngine("mizan", "D"), "mizan_d1");
  assert.equal(scopedEngine("prophet", "1W"), null, "weekly is not a parity lane");
  assert.equal(scopedEngine("aegis", "60"), null);

  const h1 = identityOf({ ...local("prophet", {}, { dependencies: mizanDep }), timeframe: "60" });
  const m5 = identityOf({ ...local("prophet", {}, { dependencies: mizanDep }), timeframe: "5" });
  assert.equal(h1.engine, "prophet");
  assert.equal(m5.engine, "prophet_m5");
  assert.equal(m5.sourceHash, h1.sourceHash);
  assert.equal(m5.mizanSourceHash, h1.mizanSourceHash);
  assert.equal(identityOf({ ...local("mizan", {}), timeframe: "5" }).mizanSourceHash, null);
  assert.equal(identityOf({ ...local("prophet", {}), timeframe: "240" }).engine, "prophet_h4");
  assert.equal(identityOf({ ...local("prophet", {}), timeframe: "1W" }), null);
});

test("an approved H1 identity does not make the same hashes trusted on 5m, and 5m results never touch H1", async () => {
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 1 };
  const match = { status: "match", compared: 1, mismatches: [], missing: [] };
  const mismatch = { status: "mismatch", compared: 1, mismatches: [{}], missing: [] };
  const id = (engine, timeframe) => identityOf({ ...local(engine, {}, { dependencies: mizanDep }), timeframe });
  const [prophetH1, gmiH1, prophetM5, gmiM5] = [id("prophet", "60"), id("gmi", "60"), id("prophet", "5"), id("gmi", "5")];
  const mizanH1 = identityOf({ ...local("mizan", {}), timeframe: "60" });
  const mizanM5 = identityOf({ ...local("mizan", {}), timeframe: "5" });
  for (const m of [mizanH1, mizanM5]) { m.sourceHash = H("d"); m.implementationHash = H("2"); }
  for (const x of [prophetH1, gmiH1, prophetM5, gmiM5, mizanH1, mizanM5]) await registerIdentity(db, x);

  await recordComparison(db, prophetH1, "OANDA:XAUUSD:60:1", match, policy);
  await recordComparison(db, gmiH1, "OANDA:XAUUSD:60:1", match, policy);
  assert.equal(await isTrusted(db, prophetH1), true);
  assert.equal(await isTrusted(db, mizanH1), true);
  assert.equal(await isTrusted(db, prophetM5), false);
  assert.equal(await isTrusted(db, mizanM5), false);

  // A 5m mismatch resets only the 5m streak; the approved H1 identity stays approved.
  await recordComparison(db, prophetM5, "OANDA:XAUUSD:5:1", mismatch, policy);
  assert.equal(await isTrusted(db, prophetH1), true);

  await recordComparison(db, prophetM5, "OANDA:XAUUSD:5:2", match, policy);
  assert.equal(await isTrusted(db, mizanM5), false);
  await recordComparison(db, gmiM5, "OANDA:XAUUSD:5:2", match, policy);
  assert.equal(await isTrusted(db, prophetM5), true);
  assert.equal(await isTrusted(db, mizanM5), true);
});

test("policy is configurable from env with safe fallbacks", () => {
  assert.deepEqual(policyFromEnv({}), DEFAULT_POLICY);
  assert.equal(policyFromEnv({ PARITY_PROMOTE_AFTER: "48" }).promoteAfter, 48);
  assert.equal(policyFromEnv({ PARITY_PROMOTE_AFTER: "0" }).promoteAfter, 24);
});

test("a bar-only difference is an input mismatch; a differing indicator field stays a mismatch", () => {
  const bar = compareWithWebhooks(local("prophet", prophetComparable(), { candle: { ...candle, c: candle.c + 0.33, volume: candle.volume + 496 } }), webhooks());
  assert.equal(bar.status, "input_mismatch");
  assert.deepEqual(bar.mismatches.map((m) => m.field).sort(), ["input:c", "input:c", "input:volume", "input:volume"]);
  const value = prophetComparable();
  value.prophet_r38.d_enc = 1;
  assert.equal(compareWithWebhooks(local("prophet", value, { candle: { ...candle, c: candle.c + 0.33 } }), webhooks()).status, "mismatch");
});

test("an input mismatch neither counts nor revokes; the republished candle replaces it and counts", async () => {
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 2 };
  const id = identityOf(local("prophet", {}));
  await registerIdentity(db, id);
  const match = { status: "match", compared: 24, mismatches: [], missing: [] };
  const input = { status: "input_mismatch", compared: 24, mismatches: [{ field: "input:c" }], missing: [] };
  await recordComparison(db, id, "k1", match, policy, "2026-11-06T01:00:00Z");
  await recordComparison(db, id, "k2", match, policy, "2026-11-06T02:00:00Z");
  assert.equal(await isTrusted(db, id), true);

  const r = await recordComparison(db, id, "k3", input, policy, "2026-11-06T03:00:00Z");
  assert.deepEqual(r, { counted: false, result: "input_mismatch" });
  assert.equal(await isTrusted(db, id), true, "the approved identity stays approved");
  let [row] = await listRegistry(db);
  assert.equal(row.consecutive_matches, 2);
  assert.equal(row.last_result, "input_mismatch");

  // The pull adapter republishes k3 on the final bar: the new comparison replaces the open one.
  assert.equal((await recordComparison(db, id, "k3", match, policy, "2026-11-06T03:05:00Z")).counted, true);
  [row] = await listRegistry(db);
  assert.equal(row.consecutive_matches, 3);
  assert.equal((await recordComparison(db, id, "k3", match, policy)).counted, false, "a counted candle is final");
});

test(`${INPUT_MISMATCH_REVOKE_AFTER} input mismatches in a row mean the data pipeline is wrong: they revoke`, async () => {
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 1 };
  const id = identityOf(local("gmi", {}, { dependencies: mizanDep }));
  await registerIdentity(db, id);
  await recordComparison(db, id, "k0", { status: "match", compared: 1, mismatches: [], missing: [] }, policy, "2026-11-06T00:00:00Z");
  const input = { status: "input_mismatch", compared: 10, mismatches: [{ field: "input:volume" }], missing: [] };
  await recordComparison(db, id, "k1", input, policy, "2026-11-06T01:00:00Z");
  await recordComparison(db, id, "k2", input, policy, "2026-11-06T02:00:00Z");
  assert.equal(await isTrusted(db, id), true);
  const third = await recordComparison(db, id, "k3", input, policy, "2026-11-06T03:00:00Z");
  assert.equal(third.result, "mismatch");
  assert.equal(third.escalated, "repeated_input_mismatch");
  assert.equal(await isTrusted(db, id), false);
  const [row] = await listRegistry(db);
  assert.equal(row.status, "revoked");
  assert.equal(row.last_detail.reason, "repeated_input_mismatch");
});

test("one-time reconciliation: input-only revocations are restored; indicator and repeated-input revocations stay", async () => {
  const { reclassifyInputOnlyMismatches } = await import("../src/parity-registry.mjs");
  const db = d1();
  await ensureSchema(db);
  const policy = { ...DEFAULT_POLICY, promoteAfter: 1 };
  const match = { status: "match", compared: 1, mismatches: [], missing: [] };
  const old = (fields) => ({ status: "mismatch", compared: 10, mismatches: fields.map((field) => ({ field })), missing: [] });
  const ids = {
    inputOnly: identityOf(local("prophet", {})),
    indicator: identityOf(local("gmi", {}, { dependencies: mizanDep })),
    m5: identityOf({ ...local("prophet", {}), timeframe: "5" })
  };
  for (const id of Object.values(ids)) { await registerIdentity(db, id); await recordComparison(db, id, "k0", match, policy, "2026-11-06T00:00:00Z"); }
  // Under the old rule these bar-only differences were stored as mismatches and revoked.
  await recordComparison(db, ids.inputOnly, "k1", old(["input:c", "input:volume"]), policy, "2026-11-06T03:00:00Z");
  await recordComparison(db, ids.indicator, "k1", old(["input:c", "d_enc"]), policy, "2026-11-06T03:00:00Z");
  await recordComparison(db, ids.m5, "k1", { ...old(["input:volume"]), status: "mismatch" }, policy, "2026-11-06T03:00:00Z");
  await db.prepare("UPDATE engine_parity_comparisons SET detail = json_set(detail, '$.reason', 'repeated_input_mismatch') WHERE engine = 'prophet_m5'").run();
  for (const id of Object.values(ids)) assert.equal(await isTrusted(db, id), false);

  const r = await reclassifyInputOnlyMismatches(db, "2026-11-06T09:00:00Z");
  assert.deepEqual(r, { reclassified: 1, restored: ["prophet"] });
  assert.equal(await isTrusted(db, ids.inputOnly), true);
  assert.equal(await isTrusted(db, ids.indicator), false, "an indicator mismatch stays revoked");
  assert.equal(await isTrusted(db, ids.m5), false, "an escalated repeated-input revocation stays revoked");
  const row = (await listRegistry(db)).find((x) => x.engine === "prophet");
  assert.equal(row.total_mismatches, 0);
  assert.deepEqual(await reclassifyInputOnlyMismatches(db), { reclassified: 0, restored: [] }, "idempotent");
});
