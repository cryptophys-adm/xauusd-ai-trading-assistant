// HAIC H3f, minimal (platform docs/design/HAIC-H3.md §4, §7.2, §7.4): the correction.v1 contract against the shared
// fixtures (copied verbatim from cryptophys-cloud-platform docs/contracts/correction-v1 at 62e5167), and the recorder
// behind its off switch: the original stays here, the masked record goes to the kernel as nexus-teacher.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  CATEGORY_RAW_MAX, buildCorrection, validateCorrection, correctionContentHash, correctionDedupHash, recordPayload, recordOwnerCorrection, sendOwnerCorrections,
  resetOwnerCorrectionsSchemaForTests, correctionsEnabled, payloadLeaks, NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY, CORRECTIONS_MAX_ATTEMPTS, CORRECTIONS_BACKOFF_MS
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

test("OC5 on: the original stays local, the masked record goes as nexus-teacher; a thrown error or timeout is retried, the kernel's failed is final", async () => {
  resetOwnerCorrectionsSchemaForTests();
  const calls = [];
  let answer = () => { throw new Error("rpc_failed"); };
  const env = { OWNER_CORRECTIONS: "on", DB: d1(), AGENTS: { syscall: async (agent, capability, input) => { calls.push({ agent, capability, input }); return answer(); } } };
  const rec = await recordOwnerCorrection(env, INPUT, { actor: "owner:owner@example.com", owner: true, now: NOW });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.redactions, ["price"]);
  const row = env.DB.raw.prepare("SELECT original_json, record_json, status FROM owner_corrections").get();
  assert.match(row.original_json, /4100/, "the original, prices included, stays in xauusd");
  assert.doesNotMatch(row.record_json, /4100/);
  // A transport failure (a thrown error): kept for the next sweep, and the sweep stops there.
  assert.deepEqual(await sendOwnerCorrections(env, { now: NOW }), { status: "ok", sent: 0, rejected: 0, invalid: 0, failed: 1, stopped: "transport", pending: 1 });
  assert.deepEqual([calls[0].agent, calls[0].capability], [NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY]);
  assert.deepEqual([calls[0].input.side, calls[0].input.attested_by, calls[0].input.weight, calls[0].input.supersedes], ["nexus", "xauusd_nexus_access", 3, null]);
  assert.doesNotMatch(JSON.stringify(calls[0].input), /4100|correction_id|sha256/);
  // A timeout is a transport failure too.
  answer = () => new Promise(() => {});
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 1, timeoutMs: 5 })).stopped, "transport");
  answer = () => ({ outcome: "succeeded", result: { correction_id: "cor_1234567890abcdef", deduplicated: false, redactions: ["price"] } });
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 60_000 })).sent, 1);
  assert.deepEqual({ ...env.DB.raw.prepare("SELECT status, platform_id FROM owner_corrections").get() }, { status: "sent", platform_id: "cor_1234567890abcdef" });
  // The kernel's own failed is final (never retried, it would count toward a suspension).
  await recordOwnerCorrection(env, { ...INPUT, text: "second" }, { actor: "owner:owner@example.com", owner: true, now: NOW + 2 });
  answer = () => ({ outcome: "failed", reason: "invalid_correction" });
  const r = await sendOwnerCorrections(env, { now: NOW + 120_000 });
  assert.deepEqual([r.rejected, r.pending], [1, 0]);
  const before = calls.length;
  await sendOwnerCorrections(env, { now: NOW + 180_000 });
  assert.equal(calls.length, before, "a rejected record is never sent again");
  // A record that keeps failing in transport stops after CORRECTIONS_MAX_ATTEMPTS.
  await recordOwnerCorrection(env, { ...INPUT, text: "again" }, { actor: "owner:owner@example.com", owner: true, now: NOW + 3 });
  answer = () => { throw new Error("rpc_failed"); };
  for (let i = 0; i < CORRECTIONS_MAX_ATTEMPTS; i++) await sendOwnerCorrections(env, { now: NOW + 300_000 + i });
  assert.equal(env.DB.raw.prepare("SELECT status FROM owner_corrections WHERE original_json LIKE '%again%'").get().status, "failed");
  assert.equal((await recordOwnerCorrection(env, { source: "nexus_card", target: INPUT.target }, { actor: "nexus:viewer@example.com", now: NOW })).error, "empty");
});

test("OC6 a denial stops the sweep and backs off with every record still pending; one whoami decides after the wait", async () => {
  resetOwnerCorrectionsSchemaForTests();
  let calls = 0, status = "suspended";
  const env = { OWNER_CORRECTIONS: "on", DB: d1(), AGENTS: { syscall: async () => { calls += 1; return { outcome: "denied", reason: "failed: agent_enabled" }; }, whoami: async () => ({ status }) } };
  for (let i = 0; i < 5; i++) await recordOwnerCorrection(env, { ...INPUT, text: `note ${"abcde"[i]}` }, { actor: "owner:owner@example.com", owner: true, now: NOW + i });
  const r = await sendOwnerCorrections(env, { now: NOW });
  assert.deepEqual([r.stopped, r.pending, calls], ["denied", 5, 1], "one denial, nothing lost");
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 60_000 })).status, "backoff");
  assert.equal(calls, 1);
  assert.equal((await sendOwnerCorrections(env, { now: NOW + CORRECTIONS_BACKOFF_MS })).status, "backoff", "whoami says not enabled: wait again");
  status = "enabled";
  env.AGENTS.syscall = async () => { calls += 1; return { outcome: "succeeded", result: { correction_id: "cor_00000000000000ff" } }; };
  const ok = await sendOwnerCorrections(env, { now: NOW + 3 * CORRECTIONS_BACKOFF_MS });
  assert.deepEqual([ok.sent, ok.pending], [5, 0]);
});

test("OC7 nothing that leaves carries a price or a secret: the raw category is masked, the original is redacted locally, a leak is never sent", async () => {
  const ctx = { actor: "owner:owner@example.com", owner: true, attested_by: "xauusd_nexus_access", now: "2026-11-22T09:00:00Z", correction_id: "cor_00000000000000bb" };
  const r = await buildCorrection({ side: "nexus", source: "nexus_card", category: "SL at 4095.5 too tight", target: INPUT.target }, ctx);
  assert.equal(r.correction.category, "other");
  assert.equal(r.correction.category_raw, "SL at [level] too tight");
  assert.deepEqual(r.correction.redactions, ["price"]);
  assert.deepEqual(payloadLeaks(recordPayload(r.correction)), []);
  assert.deepEqual(validateCorrection(r.correction), []);
  // The platform's order: mask first, then cut, so a cut never splits a price the mask no longer sees.
  const long = await buildCorrection({ side: "nexus", source: "nexus_card", category: `${"x".repeat(56)} 4095.5 too tight`, target: INPUT.target }, ctx);
  assert.equal(long.correction.category_raw, `${"x".repeat(56)} [le`);
  assert.equal(long.correction.category_raw.length, CATEGORY_RAW_MAX);
  assert.deepEqual(long.correction.redactions, ["price"]);
  assert.deepEqual(validateCorrection(long.correction), []);
  const spaced = await buildCorrection({ side: "nexus", source: "nexus_card", category: "  too   tight  ", target: INPUT.target }, ctx);
  assert.equal(spaced.correction.category_raw, "too tight", "normalised like the text");
  assert.deepEqual(validateCorrection({ ...r.correction, category_raw: "SL at 4095.5" }), ["category_raw_carries_price"]);
  assert.deepEqual(validateCorrection({ ...r.correction, category_raw: "Bearer abcdefghijklmnopqrstuvwxyz" }), ["category_raw_carries_secret"]);
  assert.deepEqual(validateCorrection({ ...r.correction, category_raw: "x".repeat(CATEGORY_RAW_MAX + 1) }), ["category_raw"]);
  assert.deepEqual(validateCorrection({ ...r.correction, category_raw: "  " }), [], "no blank rule: one contract with the platform");
  assert.deepEqual(payloadLeaks({ text: "the 4,095 level", evidence_refs: ["ev:xauusd/card/d:15:1795211100000:0"], target: { ref: "ev:xauusd/card/d:15:1795211100000:0" } }), ["text"]);
  resetOwnerCorrectionsSchemaForTests();
  const env = { OWNER_CORRECTIONS: "on", DB: d1(), AGENTS: { syscall: async () => ({ outcome: "succeeded", result: {} }) } };
  await recordOwnerCorrection(env, { ...INPUT, text: "Bearer abcdefghijklmnopqrstuvwxyz0123 leaked" }, { actor: "owner:owner@example.com", owner: true, now: NOW });
  assert.doesNotMatch(env.DB.raw.prepare("SELECT original_json FROM owner_corrections").get().original_json, /abcdefghijklmnopqrstuvwxyz0123/, "a secret is redacted in the local copy too");
});

test("OC8 a systemic kernel failure never drains the queue: the first failed stops the sweep, and at most 3 strikes an hour reach the kernel", async () => {
  resetOwnerCorrectionsSchemaForTests();
  let calls = 0;
  const env = { OWNER_CORRECTIONS: "on", DB: d1(), AGENTS: { syscall: async () => { calls += 1; return { outcome: "failed", reason: "kernel_error" }; } } };
  for (let i = 0; i < 6; i++) await recordOwnerCorrection(env, { ...INPUT, text: `row ${"abcdef"[i]}` }, { actor: "owner:owner@example.com", owner: true, now: NOW + i });
  const first = await sendOwnerCorrections(env, { now: NOW });
  assert.deepEqual([first.stopped, first.rejected, first.pending, calls], ["rejected", 1, 5, 1], "6 pending rows: 1 failed call, 5 still pending");
  await sendOwnerCorrections(env, { now: NOW + 60_000 });
  await sendOwnerCorrections(env, { now: NOW + 120_000 });
  assert.equal(calls, 3);
  const held = await sendOwnerCorrections(env, { now: NOW + 180_000 });
  assert.deepEqual([held.stopped, calls], ["local_budget", 3], "the fourth strike in the hour is never sent");
  env.AGENTS.syscall = async () => { calls += 1; return { outcome: "succeeded", result: {} }; };
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 3_600_001 + 180_000 })).sent, 3, "the hour passes: the rest goes");
});

test("OC9 the backoff clears only for an enabled agent that holds corrections.record; secrets are caught in refs too; the local copy stays JSON", async () => {
  resetOwnerCorrectionsSchemaForTests();
  let whoami = { status: "enabled", capabilities: ["reports.publish"] }, calls = 0;
  const env = { OWNER_CORRECTIONS: "on", DB: d1(), AGENTS: { syscall: async () => { calls += 1; return { outcome: "denied", reason: "capability_not_granted" }; }, whoami: async () => whoami } };
  await recordOwnerCorrection(env, { ...INPUT, text: "Bearer abcdefghijklmnopqrstuvwxyz0123 leaked" }, { actor: "owner:owner@example.com", owner: true, now: NOW });
  await sendOwnerCorrections(env, { now: NOW });
  assert.equal((await sendOwnerCorrections(env, { now: NOW + CORRECTIONS_BACKOFF_MS })).status, "backoff", "enabled but not granted: still waiting");
  assert.equal(calls, 1);
  whoami = { status: "enabled", capabilities: ["corrections.record"] };
  env.AGENTS.syscall = async () => { calls += 1; return { outcome: "succeeded", result: {} }; };
  assert.equal((await sendOwnerCorrections(env, { now: NOW + 2 * CORRECTIONS_BACKOFF_MS })).sent, 1);
  const original = JSON.parse(env.DB.raw.prepare("SELECT original_json FROM owner_corrections").get().original_json);
  assert.match(original.text, /\[redacted\] leaked/);
  assert.match(original.text, /^Bearer|\[redacted\]/);
  assert.deepEqual(payloadLeaks({ target: { ref: "ev:xauusd/card/sk-abcdefghijklmnopqrstuvwxyz" }, evidence_refs: ["ev:xauusd/card/ghp_abcdefghijklmnopqrstuvwxyz0123"] }), ["target.ref", "evidence_refs[0]"]);
});
