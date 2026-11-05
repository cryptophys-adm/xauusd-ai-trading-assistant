import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  compareWithWebhooks, identityOf, ensureSchema, registerIdentity, recordComparison, isTrusted, listRegistry,
  resetSchemaCacheForTests, policyFromEnv, DEFAULT_POLICY, scopedEngine
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

test("a differing indicator value or a differing input bar is a mismatch", () => {
  const value = prophetComparable();
  value.prophet_r38.d_enc = 1;
  const r1 = compareWithWebhooks(local("prophet", value), webhooks());
  assert.equal(r1.status, "mismatch");
  assert.deepEqual(r1.mismatches.map((m) => m.field), ["d_enc"]);
  const r2 = compareWithWebhooks(local("gmi", gmiComparable(), { candle: { ...candle, h: candle.h + 0.5 } }), webhooks());
  assert.equal(r2.status, "mismatch");
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

test("registry ids are timeframe-scoped: H1 keeps the bare id, 5m and 15m earn their own", () => {
  assert.equal(scopedEngine("prophet", "60"), "prophet");
  assert.equal(scopedEngine("prophet", "H1"), "prophet");
  assert.equal(scopedEngine("gmi", undefined), "gmi");
  assert.equal(scopedEngine("prophet", "5"), "prophet_m5");
  assert.equal(scopedEngine("mizan", "M5"), "mizan_m5");
  assert.equal(scopedEngine("prophet_hud", "15"), "prophet_hud_m15");
  assert.equal(scopedEngine("prophet", "240"), null);
  assert.equal(scopedEngine("aegis", "60"), null);

  const h1 = identityOf({ ...local("prophet", {}, { dependencies: mizanDep }), timeframe: "60" });
  const m5 = identityOf({ ...local("prophet", {}, { dependencies: mizanDep }), timeframe: "5" });
  assert.equal(h1.engine, "prophet");
  assert.equal(m5.engine, "prophet_m5");
  assert.equal(m5.sourceHash, h1.sourceHash);
  assert.equal(m5.mizanSourceHash, h1.mizanSourceHash);
  assert.equal(identityOf({ ...local("mizan", {}), timeframe: "5" }).mizanSourceHash, null);
  assert.equal(identityOf({ ...local("prophet", {}), timeframe: "240" }), null);
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
