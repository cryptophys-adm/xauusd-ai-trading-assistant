// Parity removal S1 (owner 2026-11-26: "Kita akan remove parity karena efeknya kecil dan sudah terbukti";
// "langkah pertama hapus parity dulu saja tapi tetap pertahankan arsitektur sekarang"): trust comes from the
// frozen table in src/trusted-identities.mjs. TI-1 is the guard for any hashed engine change; TI-2 shows the
// freeze answers exactly as the registry did for every identity the producers emit today.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TRUSTED_IDENTITIES, UNTRUSTED_IDENTITIES, frozenTrusted } from "../src/trusted-identities.mjs";
import { isTrusted, registryApproved, ensureSchema, scopedEngine, resetSchemaCacheForTests } from "../src/parity-registry.mjs";
import { m5ParityApproved } from "../src/m5-verification.mjs";
import { ENGINE_PROVENANCE } from "../local-engines/producer/src/provenance.generated.mjs";

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

const MIZAN = ENGINE_PROVENANCE.mizan;
const idOf = (engine, p) => ({
  engine, sourceHash: p.source_hash, implementationHash: p.implementation_hash,
  mizanSourceHash: engine.startsWith("mizan") ? null : MIZAN.source_hash, mizanImplementationHash: engine.startsWith("mizan") ? null : MIZAN.implementation_hash
});

test("TI-1 the guard: every identity the producers emit is in the frozen table or listed untrusted, with its current hashes", () => {
  const listed = new Map([...TRUSTED_IDENTITIES, ...UNTRUSTED_IDENTITIES].map((t) => [t.engine, t]));
  assert.equal(listed.size, TRUSTED_IDENTITIES.length + UNTRUSTED_IDENTITIES.length, "no engine is both trusted and untrusted, none twice");
  for (const [engine, p] of Object.entries(ENGINE_PROVENANCE)) {
    const t = listed.get(engine);
    assert.ok(t, `${engine}: a new engine needs a row in src/trusted-identities.mjs (trusted only with the owner's OK)`);
    assert.deepEqual([t.source_hash, t.implementation_hash], [p.source_hash, p.implementation_hash],
      `${engine}: its hashed files changed. Update src/trusted-identities.mjs in the same PR: a behaviour-identical refactor by review; a behaviour change with a shadow-agreement report and the owner's OK`);
  }
  for (const t of [...TRUSTED_IDENTITIES, ...UNTRUSTED_IDENTITIES]) assert.ok(ENGINE_PROVENANCE[t.engine], `${t.engine}: listed but no producer emits it`);
  assert.deepEqual(TRUSTED_IDENTITIES.map((t) => t.engine), ["prophet", "gmi", "prophet_m5", "gmi_m5", "prophet_m15", "gmi_m15", "prophet_h4", "gmi_h4"], "the eight identities the orchestrator's PR1 ruling froze");
  for (const t of TRUSTED_IDENTITIES) assert.deepEqual({ ...t.mizan }, { source_hash: MIZAN.source_hash, implementation_hash: MIZAN.implementation_hash }, `${t.engine} vouches for today's Mizan`);
  assert.ok(Object.isFrozen(TRUSTED_IDENTITIES) && TRUSTED_IDENTITIES.every(Object.isFrozen));
});

test("TI-2 byte-identity: for every identity the producers emit, the frozen table answers as the registry snapshot of 2026-11-26 did", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  await ensureSchema(db);
  const now = "2026-11-26T00:00:00.000Z";
  const insert = (engine, p, status, mizan = MIZAN) => db.raw.prepare(
    "INSERT INTO engine_parity_registry (engine, source_hash, implementation_hash, status, mizan_source_hash, mizan_implementation_hash, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(engine, p.source_hash, p.implementation_hash, status, engine.startsWith("mizan") ? null : mizan.source_hash, engine.startsWith("mizan") ? null : mizan.implementation_hash, now, now);
  // The snapshot's shape (statuses per identity, no data rows): the eight approved, the D1 identities and
  // Mizan per chart candidates, gmi_hud revoked, plus older approved hashes no producer emits any more.
  for (const t of TRUSTED_IDENTITIES) insert(t.engine, t, "approved");
  insert("prophet_d1", ENGINE_PROVENANCE.prophet_d1, "candidate");
  insert("gmi_d1", ENGINE_PROVENANCE.gmi_d1, "candidate");
  insert("gmi_hud", ENGINE_PROVENANCE.gmi_hud, "revoked");
  for (const s of ["", "_m5", "_m15", "_h4", "_d1"]) insert("mizan" + s, MIZAN, "candidate");
  const stale = { source_hash: ENGINE_PROVENANCE.gmi.source_hash, implementation_hash: "d".repeat(64) };
  insert("gmi", stale, "approved");

  const emitted = [];
  for (const [engine, p] of Object.entries(ENGINE_PROVENANCE)) if (engine !== "mizan" && engine !== "prophet_adopt") emitted.push(idOf(engine, p));
  for (const tf of ["60", "5", "15", "240", "1D"]) emitted.push(idOf(scopedEngine("mizan", tf), MIZAN));
  assert.equal(emitted.length, 16, "11 engines and Mizan on five charts");
  for (const id of emitted) assert.equal(await isTrusted(db, id), await registryApproved(db, id), id.engine);
  assert.deepEqual((await Promise.all(emitted.map((id) => isTrusted(db, id)))).filter(Boolean).length, 12, "8 engines and Mizan on 1H, 5m, 15m and 4H");
  assert.equal(await isTrusted(db, idOf("mizan_d1", MIZAN)), false, "no D1 pair vouches for Mizan on D1");

  // The one intended difference: the registry's word no longer counts, either way.
  assert.equal(await registryApproved(db, idOf("gmi", stale)), true);
  assert.equal(await isTrusted(db, idOf("gmi", stale)), false, "an older approved hash no producer emits is not trusted");
  db.raw.prepare("UPDATE engine_parity_registry SET status = 'revoked' WHERE engine = 'prophet_m5'").run();
  assert.equal(await isTrusted(db, idOf("prophet_m5", ENGINE_PROVENANCE.prophet_m5)), true, "a revocation in the registry does not untrust a frozen identity");
});

test("TI-3 the 5m approval and the Mizan rule read the table; an injected table shows both rules", async () => {
  assert.equal(await m5ParityApproved({}), true);
  assert.equal(await m5ParityApproved(null), false, "no database: unavailable, as before");
  const noM5 = TRUSTED_IDENTITIES.filter((t) => t.engine !== "gmi_m5");
  assert.equal(await m5ParityApproved({}, noM5), false);
  assert.equal(frozenTrusted(idOf("mizan_m5", MIZAN), noM5), false, "Mizan on 5m needs both 5m engines");
  assert.equal(frozenTrusted(idOf("mizan_m5", MIZAN)), true);
  assert.equal(frozenTrusted(idOf("mizan", { source_hash: MIZAN.source_hash, implementation_hash: "e".repeat(64) })), false, "another Mizan library is not vouched for");
  assert.equal(frozenTrusted(idOf("prophet_m5", { ...ENGINE_PROVENANCE.prophet_m5, implementation_hash: ENGINE_PROVENANCE.prophet_m5.implementation_hash.toUpperCase() })), true, "hashes compare case-insensitively, as normalizeHash does");
  assert.equal(frozenTrusted(null), false);
  assert.equal(frozenTrusted({ engine: "prophet_adopt_m15", sourceHash: ENGINE_PROVENANCE.prophet_adopt.source_hash, implementationHash: ENGINE_PROVENANCE.prophet_adopt.implementation_hash }), false, "a group identity is never trusted");
});
