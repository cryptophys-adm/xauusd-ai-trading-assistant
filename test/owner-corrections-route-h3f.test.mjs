// HAIC H3f, full (owner "2. yes", 2026-11-25; "harus dibuat jalurnya untuk feedback loop"): the owner's correction route,
// POST /omega/api/correction on the Omega Worker (the owner, same origin, JSON, the correction.v1 shape), the AI Worker's
// OmegaGateway.recordCorrection (the owner again, the FS1-resolved switch), and recordOwnerCorrection's dedup, race-safe
// insert and hourly cap; the masked record is what the nexus-teacher sweep sends. Off unless OWNER_CORRECTIONS is on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import {
  CORRECTION_SOURCES, CORRECTION_CATEGORIES, CORRECTIONS_PER_HOUR, NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY,
  payloadLeaks, recordPayload, validateCorrection, sendOwnerCorrections, recordOwnerCorrection, resetOwnerCorrectionsSchemaForTests
} from "../src/owner-corrections.mjs";
import { FEATURE_SWITCH_OVERRIDE_KEY, switchByKey, readSwitch } from "../src/feature-switches.mjs";
import { withFeatureSwitches, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import {
  handle as omegaHandle, resetKeyCacheForTests, correctionRequest,
  CORRECTION_ROUTE_SOURCES, CORRECTION_ROUTE_CATEGORIES, CORRECTION_ROUTE_LABELS, CORRECTION_ROUTE_RATINGS
} from "../workers/xauusd-omega/src/omega.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "owner-sub-h3f-0001";
const T0 = Date.parse("2026-11-25T09:00:00Z");
const SECRET = "Bearer abcdefghijklmnopqrstuvwxyz0123";
const TARGET = { ref: "ev:xauusd/card/d_20261125_0900", subject: "seat:m15_room", as_of: "2026-11-25T09:00:00Z" };
const BODY = { source: "nexus_card", label: "owner_correction", category: "invalidation_too_tight", text: "The stop was inside the noise.", target: TARGET, evidence_refs: ["ev:xauusd/card/d_20261125_0845"] };

// ------------------------------------------------------------------ the Access JWT (as test/feature-switches.test.mjs)
const TEAM = "cryptophys.cloudflareaccess.com", AUD = "b".repeat(64), NOW_S = 1_794_220_000;
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const opts = { fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: NOW_S };
async function jwt(claims) {
  const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW_S + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const ORIGIN = "https://nexus.cryptophys.work";
function req(token, { method = "POST", body = BODY, raw = null, headers = {} } = {}) {
  return new Request(`${ORIGIN}/omega/api/correction`, {
    method, body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
    headers: { "cf-access-jwt-assertion": token, origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }
  });
}
async function call(env, token, o) {
  const r = await omegaHandle(req(token, o), env, opts);
  return { status: r.status, body: await r.json() };
}
const owner = await jwt({ email: "owner@example.com", sub: OWNER });
const viewer = await jwt({ email: "viewer@example.com", sub: "viewer-sub-0002" });
const service = await jwt({ common_name: "ci.access" });
const accessEnv = (OMEGA, extra = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_ACCESS_SUB: OWNER, OMEGA, ...extra });

// ------------------------------------------------------------------ the bundled AI Worker (as FS-12)
async function loadWorkerModule() {
  const out = await build({
    entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-h3f-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod;
}
async function migratedD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(join(root, "schema.sql"), "utf8"));
  const dir = join(root, "migrations");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, name), "utf8"));
  const st = (sql, p = []) => ({ bind: (...a) => st(sql, a.map((v) => (v === undefined ? null : v))), run: async () => { const r = db.prepare(sql).run(...p); return { success: true, meta: { changes: Number(r.changes) } }; }, first: async (c) => { const row = db.prepare(sql).get(...p) ?? null; return c && row ? row[c] : row; }, all: async () => ({ success: true, results: db.prepare(sql).all(...p) }) });
  return { raw: db, prepare: (sql) => st(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (sql) => { db.exec(sql); return { count: 1 }; } };
}
/** A D1 that fails the test on any access (the switch off must never reach it). */
const untouchableDb = () => new Proxy({}, { get(_t, k) { throw new Error(`D1 touched: ${String(k)}`); } });
const ctx = { waitUntil: () => {}, passThroughOnException() {} };

// ------------------------------------------------------------------ tests

test("H3F-1 the route's lists are the contract's: nexus_* sources, the owner's two labels, up/down, every category", () => {
  assert.deepEqual([...CORRECTION_ROUTE_SOURCES], CORRECTION_SOURCES.filter((s) => s.startsWith("nexus_")));
  assert.deepEqual([...CORRECTION_ROUTE_CATEGORIES], [...CORRECTION_CATEGORIES]);
  assert.deepEqual([...CORRECTION_ROUTE_LABELS], ["owner_rating", "owner_correction"]);
  assert.deepEqual([...CORRECTION_ROUTE_RATINGS], ["up", "down"], "correction.v1's rating (buildCorrection takes up or down)");
  // The FS1 row: knowledge, a feature-switch row, off unless on (correctionsEnabled's rule), not set in wrangler.jsonc.
  const e = switchByKey("OWNER_CORRECTIONS");
  assert.deepEqual([e.group, e.write, e.worker, e.default_value, e.config_value, e.label], ["knowledge", "feature-switch", "ai", "off", null, "Owner corrections to the platform (H3f)"]);
  for (const [raw, want] of [[undefined, "off"], ["on", "on"], [" ON ", "on"], ["true", "off"], ["off", "off"], ["", "off"]]) assert.equal(readSwitch(e, raw), want, String(raw));
  assert.doesNotMatch(readFileSync(join(root, "wrangler.jsonc"), "utf8"), /OWNER_CORRECTIONS/, "off until the owner turns it on in FS1");
});

test("H3F-2 the shape: exactly the correction.v1 inputs Nexus sends; anything else is 400 with its code", () => {
  assert.deepEqual(correctionRequest(BODY).input, { ...BODY, rating: null });
  assert.deepEqual(correctionRequest({ source: "nexus_engine", label: "owner_rating", rating: "up", target: { ref: TARGET.ref, subject: "agent:zone_pullback" } }).input,
    { source: "nexus_engine", label: "owner_rating", rating: "up", category: null, target: { ref: TARGET.ref, subject: "agent:zone_pullback", as_of: null }, text: null, evidence_refs: [] });
  const bad = [
    [{ ...BODY, side: "cerebrum" }, "unknown_field"],
    [{ ...BODY, supersedes: "cor_0000000000000001" }, "unknown_field"],
    [{ ...BODY, stop_loss: 4000 }, "unknown_field"],
    [{ ...BODY, source: "chat_rating" }, "invalid_source"],
    [{ ...BODY, source: "council" }, "invalid_source"],
    [{ ...BODY, label: "owner_decision" }, "invalid_label"],
    [{ ...BODY, label: undefined }, "invalid_label"],
    [{ ...BODY, label: "owner_rating" }, "rating_required"],
    [{ ...BODY, label: "owner_rating", rating: 5 }, "invalid_rating"],
    [{ ...BODY, rating: "sideways" }, "invalid_rating"],
    [{ ...BODY, category: "too_tight" }, "invalid_category"],
    [{ ...BODY, target: "ev:xauusd/card/x" }, "invalid_target"],
    [{ ...BODY, target: { ...TARGET, ref: "card d_1" } }, "invalid_target"],
    [{ ...BODY, target: { ...TARGET, price: 4000 } }, "invalid_target"],
    [{ ...BODY, target: { ...TARGET, subject: "owner" } }, "invalid_subject"],
    [{ ...BODY, target: { ...TARGET, as_of: "yesterday" } }, "invalid_as_of"],
    [{ ...BODY, text: 42 }, "invalid_text"],
    [{ ...BODY, text: "x".repeat(501) }, "text_too_long"],
    [{ ...BODY, evidence_refs: "ev:xauusd/card/a" }, "invalid_evidence_refs"],
    [{ ...BODY, evidence_refs: ["not a ref"] }, "invalid_evidence_refs"],
    [{ ...BODY, evidence_refs: Array.from({ length: 11 }, (_, i) => `ev:xauusd/card/d_${"abcdefghijk"[i]}`) }, "too_many_refs"],
    [{ ...BODY, category: null, text: "  " }, "category_or_text_required"]
  ];
  for (const [body, error] of bad) assert.deepEqual(correctionRequest(body), { error }, error);
  assert.ok(correctionRequest({ ...BODY, text: "x".repeat(500), evidence_refs: Array.from({ length: 10 }, (_, i) => `ev:xauusd/card/d_${"abcdefghij"[i]}`) }).input, "500 characters and 10 refs pass");
});

test("H3F-3 route auth: the owner 200; a viewer, a service token, a cross-origin request 403; not JSON 415; too large 413; a bad shape 400", async () => {
  resetKeyCacheForTests();
  const calls = [];
  const O = { overview: async () => ({}), recordCorrection: async (i) => { calls.push(i); return { ok: true, correction_id: "cor_00000000000000a1", redactions: [], deduplicated: false }; } };
  const env = accessEnv(O);
  assert.deepEqual(await call(env, owner), { status: 200, body: { ok: true, correction_id: "cor_00000000000000a1", redactions: [], deduplicated: false } });
  assert.deepEqual(calls, [{ input: { ...BODY, rating: null }, actor: "owner@example.com", actor_sub: OWNER }], "the RPC gets the checked input, the Access email and the sub");
  assert.deepEqual(await call(env, viewer), { status: 403, body: { error: "owner_only" } });
  assert.equal((await call(env, service)).status, 403, "a service token never records a correction");
  assert.deepEqual(await call(env, owner, { headers: { origin: "https://evil.example" } }), { status: 403, body: { error: "cross_origin_refused" } });
  assert.deepEqual(await call(env, owner, { headers: { "sec-fetch-site": "cross-site" } }), { status: 403, body: { error: "same_origin_only" } });
  assert.deepEqual(await call(env, owner, { headers: { "content-type": "text/plain" } }), { status: 415, body: { error: "content_type_must_be_json" } });
  assert.deepEqual(await call(env, owner, { body: { ...BODY, text: "x".repeat(5000) } }), { status: 413, body: { error: "body_too_large" } });
  assert.deepEqual(await call(env, owner, { raw: "{not json" }), { status: 400, body: { error: "invalid_json" } });
  assert.deepEqual(await call(env, owner, { body: { ...BODY, source: "chat_rating" } }), { status: 400, body: { ok: false, error: "invalid_source" } });
  assert.deepEqual(await call(env, owner, { body: { ...BODY, text: "x".repeat(501) } }), { status: 400, body: { ok: false, error: "text_too_long" } });
  assert.equal((await call(accessEnv(O, { OWNER_ACCESS_SUB: "" }), owner)).status, 403, "no owner configured: nobody records");
  assert.equal(calls.length, 1, "nothing refused reached the AI Worker");
  assert.equal((await omegaHandle(req(owner, { method: "GET" }), env, opts)).status, 405);
  assert.equal((await call(accessEnv({ overview: async () => ({}) }), owner)).status, 503, "an AI Worker without the RPC");
  // The AI Worker's refusals as HTTP.
  for (const [error, status] of [["rate_limited", 429], ["owner_only", 403], ["disabled", 409], ["empty", 400]]) {
    const r = await call(accessEnv({ overview: async () => ({}), recordCorrection: async () => ({ ok: false, error }) }), owner);
    assert.deepEqual(r, { status, body: { ok: false, error } }, error);
  }
  const thrown = await call(accessEnv({ overview: async () => ({}), recordCorrection: async () => { throw new Error("rpc down"); } }), owner);
  assert.deepEqual(thrown, { status: 502, body: { error: "correction_failed" } });
});

test("H3F-4 on through FS1: masked in the reply and the record, one row per correction, 30 an hour, and the sweep sends the masked payload as nexus-teacher", async () => {
  resetKeyCacheForTests();
  const mod = await loadWorkerModule();
  const store = kv(), db = await migratedD1();
  const aiEnv = { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: db };
  const gw = new mod.OmegaGateway(ctx, aiEnv);
  const RealNow = Date.now, realFetch = globalThis.fetch;
  let clock = T0;
  Date.now = () => clock;
  globalThis.fetch = async () => { throw new Error("no network in tests"); };
  try {
    // Off by default: the owner's correction is refused, nothing stored.
    const env = accessEnv(gw);
    assert.deepEqual(await call(env, owner), { status: 409, body: { ok: false, error: "disabled" } });
    // The owner turns it on in FS1 (the panel's POST, owner checked again).
    const on = await gw.setFeatureSwitch({ key: "OWNER_CORRECTIONS", value: "on", actor: "owner@example.com", actor_sub: OWNER });
    assert.deepEqual([on.ok, on.switch.value, on.switch.source], [true, "on", "override"]);
    assert.equal(JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).OWNER_CORRECTIONS.value, "on");
    clock += 31_000; // past the FS1 memo
    assert.deepEqual(await gw.recordCorrection({ input: BODY, actor: "viewer@example.com", actor_sub: "viewer-sub-0002" }), { ok: false, error: "owner_only" }, "the AI Worker checks the owner again");

    // Masking: a price and a token-like secret in the text.
    const masked = { ...BODY, text: `The stop at 4095.5 was inside the noise; ${SECRET} pasted by mistake` };
    const r = await call(env, owner, { body: masked });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["correction_id", "deduplicated", "ok", "redactions"], "only the id, the redactions and the duplicate flag");
    assert.match(r.body.correction_id, /^cor_[0-9a-f]{16}$/);
    assert.deepEqual([r.body.ok, r.body.redactions, r.body.deduplicated], [true, ["secret", "price"], false]);
    const { correction_id: _id, ...reply } = r.body; // an id by its contract (as payloadLeaks exempts ids and refs)
    assert.deepEqual(payloadLeaks(reply), []);
    assert.doesNotMatch(JSON.stringify(r.body), /4095|abcdefghijklmnopqrstuvwxyz0123|noise/, "the reply never carries the text");
    const row = db.raw.prepare("SELECT correction_id, original_json, record_json, status FROM owner_corrections").get();
    assert.equal(row.correction_id, r.body.correction_id);
    const record = JSON.parse(row.record_json);
    assert.deepEqual(validateCorrection(record), []);
    assert.equal(record.text, "The stop at [level] was inside the noise; [redacted] pasted by mistake");
    assert.deepEqual([record.actor, record.side, record.weight, record.attested_by, record.label], ["owner:owner@example.com", "nexus", 3, "xauusd_nexus_access", "owner_correction"]);
    assert.deepEqual(payloadLeaks(recordPayload(record)), [], "the record the sweep sends");
    assert.match(row.original_json, /4095\.5/, "the original, prices included, stays here");
    assert.doesNotMatch(row.original_json, /abcdefghijklmnopqrstuvwxyz0123/, "a secret is redacted in the local copy too");

    // Dedup: the same correction again stores nothing and answers the stored id.
    const again = await call(env, owner, { body: masked });
    assert.deepEqual(again, { status: 200, body: { ok: true, correction_id: r.body.correction_id, redactions: ["secret", "price"], deduplicated: true } });
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_corrections").get().n, 1);
    // Two simultaneous POSTs of one new correction: one row (INSERT OR IGNORE on the unique dedup index).
    const twin = { ...BODY, label: "owner_rating", rating: "down", category: "overconfident", text: "Too sure for a range." };
    const [a, b] = await Promise.all([call(env, owner, { body: twin }), call(env, owner, { body: twin })]);
    assert.deepEqual([a.status, b.status, a.body.correction_id === b.body.correction_id], [200, 200, true]);
    assert.deepEqual([a.body.deduplicated, b.body.deduplicated].sort(), [false, true]);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_corrections").get().n, 2);
    assert.ok(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_owner_corrections_dedup'").get(), "the unique dedup index");

    // One sweep against a stub kernel: corrections.record as nexus-teacher, the masked payload, FS1's override in force.
    resetOwnerCorrectionsSchemaForTests();
    resetFeatureSwitchMemoForTests();
    const sent = [];
    const sweepEnv = await withFeatureSwitches({ ...aiEnv, AGENTS: { syscall: async (agent, capability, input) => { sent.push({ agent, capability, input }); return { outcome: "succeeded", result: { correction_id: "cor_00000000000000f1" } }; } } }, { now: clock });
    assert.equal(sweepEnv.OWNER_CORRECTIONS, "on", "the sweep's env carries the owner's override");
    const sweep = await sendOwnerCorrections(sweepEnv, { now: clock });
    assert.deepEqual([sweep.status, sweep.sent, sweep.pending], ["ok", 2, 0]);
    assert.deepEqual(sent.map((s) => [s.agent, s.capability]), [[NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY], [NEXUS_TEACHER_ID, CORRECTIONS_CAPABILITY]]);
    assert.equal(NEXUS_TEACHER_ID, "nexus-teacher");
    assert.equal(CORRECTIONS_CAPABILITY, "corrections.record");
    assert.deepEqual(sent[0].input, recordPayload(record));
    assert.equal(sent[0].input.text, "The stop at [level] was inside the noise; [redacted] pasted by mistake");
    for (const s of sent) assert.deepEqual(payloadLeaks(s.input), []);
    assert.doesNotMatch(JSON.stringify(sent), /4095|abcdefghijklmnopqrstuvwxyz0123|correction_id|sha256/);

    // The hourly cap: two hours on, 30 corrections pass, the 31st is 429 rate_limited; a duplicate still answers its id.
    clock += 2 * 3_600_000;
    const ids = [];
    for (let i = 0; i < CORRECTIONS_PER_HOUR; i++) {
      const x = await call(env, owner, { body: { ...BODY, text: `Note ${"abcdefghijklmnopqrstuvwxyzABCD"[i]} on this card.` } });
      assert.deepEqual([x.status, x.body.deduplicated], [200, false], `call ${i + 1}`);
      ids.push(x.body.correction_id);
      clock += 1_000;
    }
    assert.equal(CORRECTIONS_PER_HOUR, 30);
    assert.deepEqual(await call(env, owner, { body: { ...BODY, text: "One more note." } }), { status: 429, body: { ok: false, error: "rate_limited" } });
    assert.deepEqual((await call(env, owner, { body: { ...BODY, text: "Note a on this card." } })).body, { ok: true, correction_id: ids[0], redactions: [], deduplicated: true });
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_corrections").get().n, 32, "2 earlier + 30 this hour, none for the refused one");
    clock += 3_600_000;
    assert.equal((await call(env, owner, { body: { ...BODY, text: "One more note." } })).status, 200, "the hour rolls on");
  } finally { Date.now = RealNow; globalThis.fetch = realFetch; }
});

test("H3F-5 off: disabled, with a D1 that throws on any access; an FS1 override of off too", async () => {
  resetKeyCacheForTests();
  const mod = await loadWorkerModule();
  const RealNow = Date.now;
  Date.now = () => T0 + 10 * 86_400_000;
  try {
    for (const store of [kv(), (() => { const s = kv(); s.m.set(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ OWNER_CORRECTIONS: { value: "off", actor: "owner", at: new Date(T0).toISOString() } })); return s; })()]) {
      const gw = new mod.OmegaGateway(ctx, { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: untouchableDb() });
      assert.deepEqual(await gw.recordCorrection({ input: BODY, actor: "owner@example.com", actor_sub: OWNER }), { ok: false, error: "disabled" });
      assert.deepEqual(await call(accessEnv(gw), owner), { status: 409, body: { ok: false, error: "disabled" } });
    }
  } finally { Date.now = RealNow; }
  // The sweep reads nothing either.
  assert.deepEqual(await sendOwnerCorrections({ DB: untouchableDb(), AGENTS: { syscall: async () => { throw new Error("must not be called"); } } }), { status: "disabled" });
});

/**
 * A D1 whose hour's-count pre-check, once armed, waits until `n` calls have all read it: every call has passed the dedup
 * lookup and the cap before any of them inserts (the race of simultaneous POSTs, forced).
 */
function racingD1(n) {
  const db = d1(), inner = db.prepare;
  let arrived = 0, open;
  const opened = new Promise((resolve) => { open = resolve; });
  db.armed = false;
  db.prepare = (sql) => {
    const st = inner(sql);
    if (!db.armed || !sql.startsWith("SELECT COUNT(*) AS n FROM owner_corrections WHERE created_ms")) return st;
    const bind = st.bind;
    st.bind = (...a) => {
      const b = bind(...a), first = b.first;
      b.first = async () => { const r = await first(); if (++arrived === n) open(); await opened; return r; };
      return b;
    };
    return st;
  };
  return db;
}

test("H3F-6 race-safe: simultaneous calls that all pass the pre-checks store one row per correction and never pass the cap", async () => {
  const who = { actor: "owner:owner@example.com", owner: true, now: T0 };
  // The same correction twice at once: both read "no row" and "under the cap"; INSERT OR IGNORE lands one.
  resetOwnerCorrectionsSchemaForTests();
  let db = racingD1(2);
  db.armed = true;
  let env = { OWNER_CORRECTIONS: "on", DB: db };
  const [a, b] = await Promise.all([recordOwnerCorrection(env, BODY, who), recordOwnerCorrection(env, BODY, who)]);
  assert.deepEqual([a.ok, b.ok, a.correction_id === b.correction_id, [a.deduplicated, b.deduplicated].sort()], [true, true, true, [false, true]]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_corrections").get().n, 1);
  // Two different corrections at once with one slot left in the hour: one lands, the other is rate_limited.
  resetOwnerCorrectionsSchemaForTests();
  db = racingD1(2);
  env = { OWNER_CORRECTIONS: "on", DB: db };
  for (let i = 0; i < CORRECTIONS_PER_HOUR - 1; i++) assert.equal((await recordOwnerCorrection(env, { ...BODY, text: `Note ${"abcdefghijklmnopqrstuvwxyzABC"[i]}.` }, who)).ok, true);
  db.armed = true;
  const both = await Promise.all([recordOwnerCorrection(env, { ...BODY, text: "Last one, first." }, who), recordOwnerCorrection(env, { ...BODY, text: "Last one, second." }, who)]);
  assert.deepEqual(both.map((x) => x.ok ? "ok" : x.error).sort(), ["ok", "rate_limited"]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_corrections").get().n, CORRECTIONS_PER_HOUR);
});
