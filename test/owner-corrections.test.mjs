// HAIC H3f, minimal (platform docs/design/HAIC-H3.md §4, §7.2, §7.4): the correction.v1 contract against the shared
// fixtures (copied verbatim from cryptophys-cloud-platform docs/contracts/correction-v1 at 62e5167), and the recorder
// behind its off switch: the original stays here, the masked record goes to the kernel as nexus-teacher.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  buildCorrection, validateCorrection, correctionContentHash, correctionDedupHash, recordPayload, recordOwnerCorrection, sendOwnerCorrections,
  resetOwnerCorrectionsSchemaForTests, correctionsEnabled, NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY, CORRECTIONS_MAX_ATTEMPTS
} from "../src/owner-corrections.mjs";

const fixture = (p) => JSON.parse(readFileSync(new URL(`./fixtures/correction-v1/${p}`, import.meta.url), "utf8"));
const index = fixture("index.json");
const vectors = fixture("vectors.json");

test("OC1 every shared fixture: valid files pass, each invalid file fails with its expected error", () => {
  assert.ok(index.files.length >= 17);
  for (const f of index.files) {
    const errors = validateCorrection(fixture(f.file));
    if (f.expect_errors.length === 0) assert.deepEqual(errors, [], f.file);
    else for (const e of f.expect_errors) assert.ok(errors.includes(e), `${f.file}: ${errors.join(", ")}`);
  }
});

test("OC2 the hashes: each valid fixture's content and dedup hash recompute exactly; the build vectors give the expected record", async () => {
  for (const f of index.files.filter((x) => x.expect_errors.length === 0)) {
    const c = fixture(f.file);
    assert.equal(await correctionContentHash(c), c.content_sha256, `${f.file} content`);
    assert.equal(await correctionDedupHash(c), c.dedup_sha256, `${f.file} dedup`);
  }
  for (const v of vectors.build) {
    const r = await buildCorrection(v.input, v.context);
    assert.equal(r.ok, true, v.name);
    for (const [k, want] of Object.entries(v.expect)) assert.deepEqual(r.correction[k], want, `${v.name}: ${k}`);
    assert.deepEqual(validateCorrection(r.correction), [], v.name);
  }
  for (const v of vectors.refused) assert.deepEqual(await buildCorrection(v.input, { actor: "owner:owner@example.com", owner: true, attested_by: "xauusd_nexus_access", now: "2026-11-19T10:00:00Z", correction_id: "cor_0000000000000000" }), { ok: false, error: v.error }, v.name);
});

test("OC3 masking: a price in the text, a priced ref and a secret leave as [level], a dropped field and [redacted]; never a parameter", async () => {
  const ctx = { actor: "owner:owner@example.com", owner: true, attested_by: "xauusd_nexus_access", now: "2026-11-22T09:00:00Z", correction_id: "cor_00000000000000aa" };
  const r = await buildCorrection({
    side: "nexus", source: "nexus_room", category: "invalidation_too_tight",
    text: "The stop at 4,095.50 was inside the noise; token Bearer abcdefghijklmnopqrstuvwxyz0123",
    target: { ref: "ev:xauusd/room_run/r_15m_0900#entry_price", subject: "seat:m15_room", as_of: "2026-11-22T09:00:00Z" },
    evidence_refs: ["ev:xauusd/card/d_x#tp2", "ev:xauusd/card/d_y", "not a ref"]
  }, ctx);
  assert.equal(r.ok, true);
  const c = r.correction;
  assert.match(c.text, /\[level\]/);
  assert.doesNotMatch(c.text, /4,?095/);
  assert.match(c.text, /\[redacted\]/);
  assert.equal(c.target.ref, "ev:xauusd/room_run/r_15m_0900", "the price field is dropped from the ref");
  assert.deepEqual(c.evidence_refs, ["ev:xauusd/card/d_x", "ev:xauusd/card/d_y"]);
  assert.equal(c.invalid_refs, 1);
  assert.deepEqual(c.redactions, ["secret", "price"]);
  assert.deepEqual(validateCorrection(c), []);
  assert.deepEqual((await buildCorrection({ side: "nexus", source: "nexus_card", rating: "down", stop_loss: 1, target: { ref: "ev:xauusd/card/d_x", subject: "seat:a", as_of: null } }, ctx)), { ok: false, error: "forbidden_key: input.stop_loss" });
  const payload = recordPayload(c);
  assert.deepEqual(["correction_id", "content_sha256", "dedup_sha256"].filter((k) => k in payload), [], "corrections.record takes the record without its id and hashes");
});

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const NOW = Date.parse("2026-11-22T09:00:00Z");
const INPUT = { source: "nexus_card", rating: "down", category: "reading_wrong", text: "Read the 4H as bullish below 4100; it was a range.", target: { ref: "ev:xauusd/card/d_20261122_0900", subject: "seat:h4_room", as_of: "2026-11-22T09:00:00Z" } };

test("OC4 the switch is off by default: nothing is recorded and nothing is sent", async () => {
  resetOwnerCorrectionsSchemaForTests();
  assert.equal(correctionsEnabled({}), false);
  const env = { DB: d1(), AGENTS: { syscall: async () => { throw new Error("must not be called"); } } };
  assert.deepEqual(await recordOwnerCorrection(env, INPUT, { actor: "owner:owner@example.com", owner: true, now: NOW }), { ok: false, error: "disabled" });
  assert.deepEqual(await sendOwnerCorrections(env, { now: NOW }), { status: "disabled" });
});

test("OC5 on: the original stays local, the masked record goes as nexus-teacher; a failure is retried, a denial is final", async () => {
  resetOwnerCorrectionsSchemaForTests();
  const calls = [];
  let answer = { outcome: "failed", reason: "timeout" };
  const env = { OWNER_CORRECTIONS: "on", DB: d1(), AGENTS: { syscall: async (agent, capability, input) => { calls.push({ agent, capability, input }); return answer; } } };
  const rec = await recordOwnerCorrection(env, INPUT, { actor: "owner:owner@example.com", owner: true, now: NOW });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.redactions, ["price"]);
  const row = env.DB.raw.prepare("SELECT original_json, record_json, status FROM owner_corrections").get();
  assert.match(row.original_json, /4100/, "the original, prices included, stays in xauusd");
  assert.doesNotMatch(row.record_json, /4100/);
  assert.equal(row.status, "pending");
  // A transport failure: retried by the next sweep.
  assert.deepEqual(await sendOwnerCorrections(env, { now: NOW }), { status: "ok", sent: 0, denied: 0, failed: 1, pending: 1 });
  assert.deepEqual([calls[0].agent, calls[0].capability], [NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY]);
  assert.equal(calls[0].input.side, "nexus");
  assert.equal(calls[0].input.attested_by, "xauusd_nexus_access");
  assert.equal(calls[0].input.weight, 3);
  assert.doesNotMatch(JSON.stringify(calls[0].input), /4100|correction_id|sha256/);
  answer = { outcome: "succeeded", result: { correction_id: "cor_1234567890abcdef", deduplicated: false, redactions: ["price"] } };
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 60_000 })).sent, 1);
  assert.deepEqual({ ...env.DB.raw.prepare("SELECT status, platform_id FROM owner_corrections").get() }, { status: "sent", platform_id: "cor_1234567890abcdef" });
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 120_000 })).pending, 0, "a sent record is not sent again");
  // A denial is final.
  await recordOwnerCorrection(env, { ...INPUT, rating: "up", category: "good_call", text: null }, { actor: "owner:owner@example.com", owner: true, now: NOW + 1 });
  answer = { outcome: "denied", reason: "capability_not_granted" };
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 180_000 })).denied, 1);
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 240_000 })).pending, 0);
  // A record that keeps failing stops after CORRECTIONS_MAX_ATTEMPTS.
  await recordOwnerCorrection(env, { ...INPUT, text: "again" }, { actor: "owner:owner@example.com", owner: true, now: NOW + 2 });
  answer = { outcome: "failed", reason: "timeout" };
  for (let i = 0; i < CORRECTIONS_MAX_ATTEMPTS; i++) await sendOwnerCorrections(env, { now: NOW + 300_000 + i });
  assert.equal(env.DB.raw.prepare("SELECT status FROM owner_corrections WHERE original_json LIKE '%again%'").get().status, "failed");
  // A non-owner actor's record weighs 1; a structurally empty one is refused.
  assert.equal((await recordOwnerCorrection(env, { source: "nexus_card", target: INPUT.target }, { actor: "nexus:viewer@example.com", now: NOW })).error, "empty");
});
