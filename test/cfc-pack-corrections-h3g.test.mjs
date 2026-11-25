// HAIC H3g (owner "2. yes" to H3f, 2026-11-25: "harus dibuat jalurnya untuk feedback loop"): the owner's corrections
// in the Call for Councils seat pack and learned-item pack (src/cfc-pack.mjs). Only the masked record_json is read,
// never original_json; off in FS1, owner_corrections is not touched; the newest per target, at most 5, within 60 days.
import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidencePack, priceKeysIn, REF_RE, PACK_LIMITS } from "../src/cfc-pack.mjs";
import { recordOwnerCorrection, resetOwnerCorrectionsSchemaForTests } from "../src/owner-corrections.mjs";
import { FEATURE_SWITCH_OVERRIDE_KEY } from "../src/feature-switches.mjs";
import { resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import { NOW, seedEnv } from "./support/cfc-fixtures.mjs";

const HOUR = 3_600_000, DAY = 86_400_000;
const ACTOR = "owner:owner@example.com";
const ORIGINAL_ONLY = "ORIGINAL-ONLY-MARKER";

async function envOn(extra = {}) {
  resetOwnerCorrectionsSchemaForTests();
  resetFeatureSwitchMemoForTests();
  return { ...(await seedEnv()), OWNER_CORRECTIONS: "on", ...extra };
}

/** One correction through the real store (the record is masked, the original keeps the price). Returns its id. */
async function correct(env, { subject = "agent:risk", ref = "ev:xauusd/agent_thread_messages/12", text, at, category = "reading_wrong", rating }) {
  const input = { source: "nexus_room", target: { ref, subject }, ...(text ? { text } : {}), ...(category ? { category } : {}), ...(rating ? { rating } : {}) };
  const r = await recordOwnerCorrection(env, input, { actor: ACTOR, owner: true, now: at });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.correction_id;
}

/** A D1 that records every statement it is asked to prepare and refuses any that names owner_corrections. */
function spyDb(inner) {
  const sql = [];
  return {
    sql,
    db: inner.db,
    prepare(s) { sql.push(s); if (/owner_corrections/.test(s)) throw new Error("owner_corrections must not be read"); return inner.prepare(s); },
    batch: (list) => inner.batch(list)
  };
}

const ids = (block) => block.items.map((x) => x.correction_id);
const correctionRefs = (pack) => pack.refs.filter((r) => r.startsWith("ev:xauusd/owner_corrections/"));

test("H3g: the seat pack carries the masked text; original_json is never selected and its price never appears", async () => {
  const env = await envOn();
  const id = await correct(env, { text: "The risk seat read the support at 4095.5 as broken; it held", at: NOW - 2 * HOUR });
  // Text only the original holds: if original_json were read anywhere, the marker would show.
  env.DB.db.prepare("UPDATE owner_corrections SET original_json = json_set(original_json, '$.note', ?) WHERE correction_id = ?").run(ORIGINAL_ONLY, id);
  const seen = [];
  const inner = env.DB;
  env.DB = { ...inner, prepare: (s) => { seen.push(s); return inner.prepare(s); } };
  const pack = await buildEvidencePack(env, "seat:risk@15", { now: NOW });
  const block = pack.sections.owner_corrections;
  assert.equal(block.n, 1);
  assert.deepEqual(Object.keys(block).sort(), ["items", "n", "note"]);
  assert.equal(block.note, "the owner's corrections of this seat's outputs (masked record; prices already [level])");
  const [item] = block.items;
  assert.deepEqual(Object.keys(item).sort(), ["category", "correction_id", "created_at", "label", "rating", "redactions", "subject", "target_ref", "text"]);
  assert.equal(item.correction_id, id);
  assert.equal(item.text, "The risk seat read the support at [level] as broken; it held");
  assert.deepEqual([item.label, item.category, item.subject, item.target_ref], ["owner_correction", "reading_wrong", "agent:risk", "ev:xauusd/agent_thread_messages/12"]);
  assert.deepEqual(item.redactions, ["price"]);
  const json = JSON.stringify(pack);
  for (const leak of ["4095", ORIGINAL_ONLY, "owner@example.com"]) assert.ok(!json.includes(leak), `${leak} leaked into the pack`);
  assert.deepEqual(priceKeysIn(pack), []);
  const reads = seen.filter((s) => /owner_corrections/.test(s));
  assert.equal(reads.length, 1, "one read of the table");
  assert.ok(!/original_json/.test(reads[0]) && /SELECT correction_id, record_json, created_ms FROM owner_corrections/.test(reads[0]), reads[0]);
  assert.ok(pack.refs.includes(`ev:xauusd/owner_corrections/${id}`));
  for (const r of pack.refs) assert.match(r, REF_RE, r);
});

test("H3g: FS1 OWNER_CORRECTIONS off: unavailable and owner_corrections is not read (env off, or the FS1 override off)", async () => {
  for (const make of [
    async () => { resetFeatureSwitchMemoForTests(); return seedEnv(); },
    async () => {
      const env = await envOn();
      await env.SIGNAL_CACHE.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ OWNER_CORRECTIONS: { value: "off", actor: "owner", at: new Date(NOW).toISOString() } }));
      return env;
    }
  ]) {
    const env = await make();
    const spy = spyDb(env.DB);
    env.DB = spy;
    for (const key of ["seat:risk", "knowledge:note-1"]) {
      const pack = await buildEvidencePack(env, key, { now: NOW });
      assert.deepEqual(pack.sections.owner_corrections, { unavailable: "owner corrections are off (FS1 OWNER_CORRECTIONS)" }, key);
      assert.deepEqual(correctionRefs(pack), []);
    }
    assert.ok(spy.sql.length > 0 && !spy.sql.some((s) => /owner_corrections/.test(s)), "no statement names owner_corrections");
  }
  // The FS1 override turns it on over an env without the variable (resolved as OmegaGateway resolves it).
  resetOwnerCorrectionsSchemaForTests();
  resetFeatureSwitchMemoForTests();
  const env = await seedEnv();
  await env.SIGNAL_CACHE.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ OWNER_CORRECTIONS: { value: "on", actor: "owner", at: new Date(NOW).toISOString() } }));
  await correct({ ...env, OWNER_CORRECTIONS: "on" }, { text: "too early", at: NOW - HOUR });
  const pack = await buildEvidencePack(env, "seat:risk", { now: NOW });
  assert.equal(pack.sections.owner_corrections.n, 1);
  resetFeatureSwitchMemoForTests();
});

test("H3g: on but the table is missing: unavailable, the rest of the pack unchanged", async () => {
  const env = await envOn();
  const pack = await buildEvidencePack(env, "seat:risk", { now: NOW });
  assert.deepEqual(pack.sections.owner_corrections, { unavailable: "no owner correction is stored yet (owner_corrections)" });
  assert.ok(pack.sections.room_runs.unavailable && pack.sections.prior.unavailable && pack.sections.statements);
  const item = await buildEvidencePack(env, "knowledge:note-1", { now: NOW });
  assert.ok(item.sections.owner_corrections.unavailable);
});

test("H3g: the newest per target, at most 5, newest first; another subject and anything older than 60 days not read", async () => {
  const env = await envOn();
  const made = [];
  for (let i = 0; i < 7; i++) made.push(await correct(env, { ref: `ev:xauusd/agent_thread_messages/${20 + i}`, text: `reading ${["one", "two", "three", "four", "five", "six", "seven"][i]}`, at: NOW - (10 - i) * 2 * HOUR }));
  // Target 26 corrected again later: only the newest of the two is kept.
  const again = await correct(env, { ref: "ev:xauusd/agent_thread_messages/26", text: "on second look it was fine", at: NOW - HOUR, category: "good_call" });
  const seatSubject = await correct(env, { subject: "seat:risk", ref: "ev:xauusd/council_messages/9", text: "the seat form", at: NOW - 30 * 60_000 });
  const other = await correct(env, { subject: "agent:moderator", ref: "ev:xauusd/agent_thread_messages/99", text: "not the risk seat", at: NOW - 10 * 60_000 });
  const old = await correct(env, { ref: "ev:xauusd/agent_thread_messages/5", text: "long ago", at: NOW - (PACK_LIMITS.window_days + 1) * DAY });
  const pack = await buildEvidencePack(env, "seat:risk", { now: NOW });
  const block = pack.sections.owner_corrections;
  assert.equal(PACK_LIMITS.corrections, 5);
  assert.equal(block.n, 5);
  assert.deepEqual(ids(block), [seatSubject, again, made[5], made[4], made[3]], "newest first, one per target");
  assert.ok(!ids(block).includes(made[6]), "the older correction of the same target is dropped");
  assert.equal(block.items[1].category, "good_call");
  for (const missing of [other, old]) assert.ok(!JSON.stringify(pack).includes(missing), missing);
  assert.deepEqual(correctionRefs(pack).sort(), ids(block).map((id) => `ev:xauusd/owner_corrections/${id}`).sort());
  for (const r of pack.refs) assert.match(r, REF_RE, r);
  // The moderator's pack reads its own.
  const mod = await buildEvidencePack(env, "seat:moderator", { now: NOW });
  assert.deepEqual(ids(mod.sections.owner_corrections), [other]);
});

test("H3g: a record text that still holds a 3+ digit run is dropped (belt and braces)", async () => {
  const env = await envOn();
  const clean = await correct(env, { text: "the read was wrong", at: NOW - 2 * HOUR });
  const dirty = "cor_00000000000000aa";
  const record = { schema: "correction.v1", correction_id: dirty, label: "owner_correction", rating: null, category: "other", text: "level 4095 held", target: { ref: "ev:xauusd/agent_thread_messages/77", subject: "agent:risk", as_of: null }, redactions: [], created_at: new Date(NOW - HOUR).toISOString() };
  env.DB.db.prepare("INSERT INTO owner_corrections (correction_id, original_json, record_json, dedup_sha256, status, attempts, created_ms) VALUES (?, '{}', ?, 'x', 'pending', 0, ?)").run(dirty, JSON.stringify(record), NOW - HOUR);
  const pack = await buildEvidencePack(env, "seat:risk", { now: NOW });
  assert.deepEqual(ids(pack.sections.owner_corrections), [clean]);
  assert.ok(!JSON.stringify(pack).includes("4095") && !pack.refs.includes(`ev:xauusd/owner_corrections/${dirty}`));
});

test("H3g: the learned-item pack reads the item's own refs and subject, never a longer item id's", async () => {
  const env = await envOn();
  const byRef = await correct(env, { subject: "agent:risk", ref: "ev:xauusd/learned_live/note-1/v2#status", text: "the note misled the seat", at: NOW - 3 * HOUR });
  const bySubject = await correct(env, { subject: "model:note-1", ref: "ev:xauusd/shadow_agent_outputs/41", text: "the shadow arm was right", at: NOW - 2 * HOUR, category: "good_call" });
  const longer = await correct(env, { subject: "agent:risk", ref: "ev:xauusd/learned_live/note-10/v1", text: "a different note", at: NOW - HOUR });
  const pack = await buildEvidencePack(env, "knowledge:note-1", { now: NOW });
  const block = pack.sections.owner_corrections;
  assert.deepEqual(ids(block), [bySubject, byRef]);
  assert.equal(block.note, "the owner's corrections of this learned item's outputs (masked record; prices already [level])");
  assert.ok(!JSON.stringify(pack).includes(longer));
  assert.deepEqual(correctionRefs(pack).sort(), [byRef, bySubject].map((id) => `ev:xauusd/owner_corrections/${id}`).sort());
  for (const r of pack.refs) assert.match(r, REF_RE, r);
  assert.deepEqual(priceKeysIn(pack), []);
});
