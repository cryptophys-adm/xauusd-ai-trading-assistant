// H3f UI: the answers the Nexus correction control reads and gets, from the real code. The Omega Worker's route
// (workers/xauusd-omega/src/omega.mjs handle: POST /omega/api/correction and GET /omega/api/feature-switches) in front of
// the bundled AI Worker's OmegaGateway (src/index.ts: recordCorrection, featureSwitches, setFeatureSwitch) over a migrated
// D1 and a KV store, with an Access JWT per caller, as test/owner-corrections-route-h3f.test.mjs runs them; and one Call
// for Councils session read by the real readSession (src/cfc-session.mjs) with seats' refs from the real evRef and
// cleanSeat, a War Room and a 1H room read by the real readWarRoom and readTimeframeThread, and the strategy council's
// verdicts read by the real readCouncilVerdicts: each output's own `ev_ref` (#588) is what the control rates.
// test/fixtures/nexus-h3f/*.json are this seed's answers:
//   feature-switches-off.json     the owner's GET with OWNER_CORRECTIONS off (its default): the control is hidden;
//   feature-switches-on.json      the owner's GET after the owner turned it on in FS1 (viewer.can_control true);
//   feature-switches-viewer.json  the same state read by another signed-in person (viewer.can_control false);
//   correction-replies.json       { case: { status, body } }: 200, a deduplicated 200, 200 with redactions [price],
//                                 [secret] and [secret, price], and each 4xx/5xx code the route answers;
//   council-session.json          GET /api/council/session's session: seat opinions with and without cited refs, the
//                                 owner's message, the moderator's options (one option_id the route refuses: no ev_ref);
//   war-room.json                 GET /api/war-room/latest's body: the 15m room's openings, rebuttal and conclusion;
//   thread-h1.json                GET /api/threads/timeframe?chart=H1's body: the 1H room;
//   strategy-verdicts.json        readCouncilVerdicts (GET /api/strategy-agents agents[].verdicts): one with its ev_ref.
// test/nexus-correction-control.test.mjs checks each file against this seed, byte for byte. Regenerate them after a
// contract change: node test/support/nexus-h3f-seed.mjs --write
import { readFile, readdir, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { handle as omegaHandle, resetKeyCacheForTests } from "../../workers/xauusd-omega/src/omega.mjs";
import { resetFeatureSwitchMemoForTests } from "../../src/feature-switch-store.mjs";
import { resetOwnerCorrectionsSchemaForTests, CORRECTIONS_PER_HOUR } from "../../src/owner-corrections.mjs";
import { evRef } from "../../src/cfc-pack.mjs";
import { cleanSeat, ensureSessionSchema, readSession, resetSessionSchemaForTests } from "../../src/cfc-session.mjs";
import { ensureThreadSchema, resetThreadSchemaCacheForTests } from "../../src/agent-threads.mjs";
import { resetRoomRunsSchemaCacheForTests } from "../../src/room-runs.mjs";
import { readWarRoom } from "../../src/war-room.mjs";
import { readTimeframeThread } from "../../src/timeframe-threads.mjs";
import { readCouncilVerdicts, COUNCIL_KEY } from "../../src/strategy-council.mjs";
import { kv } from "../fixtures/mode-shadow.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
/** The fixture's clock: 09:05 UTC, 16:05 GMT+7, five minutes after the 15m close of the engine decision below. */
export const NOW = Date.parse("2026-11-25T09:05:00Z");
export const OWNER = "owner-sub-h3f-fixture";
export const ORIGIN = "https://nexus.cryptophys.work";
/** The Decision Engine's record the control rates (test/fixtures/nexus-ez1/conclusion-global.json `engine`). */
export const ENGINE_KEY = "OANDA:XAUUSD:15:1795096800000";
export const ENGINE_TARGET = Object.freeze({ ref: `ev:xauusd/engine_decisions/${ENGINE_KEY}`, subject: "agent:council", as_of: "2026-11-19T14:00:00.000Z" });
const RATE = { source: "nexus_engine", label: "owner_rating", rating: "up", category: null, text: null, target: ENGINE_TARGET };
const CORRECT = { source: "nexus_engine", label: "owner_correction", rating: null, category: "invalidation_too_tight", text: "The stop sat inside the noise; it belongs under the sweep low.", target: ENGINE_TARGET };
/** A token-like secret, as the route test's (never a real credential). */
const SECRET = "Bearer abcdefghijklmnopqrstuvwxyz0123";

// ------------------------------------------------------------------ the Access JWT (as test/owner-corrections-route-h3f.test.mjs)
const TEAM = "cryptophys.cloudflareaccess.com", AUD = "c".repeat(64), NOW_S = Math.floor(NOW / 1000);
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function access() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const jwt = async (claims) => {
    const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW_S + 600, ...claims });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return {
    opts: { fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: NOW_S },
    owner: await jwt({ email: "owner@example.com", sub: OWNER }),
    viewer: await jwt({ email: "viewer@example.com", sub: "viewer-sub-h3f" }),
    service: await jwt({ common_name: "ci.access" })
  };
}

// ------------------------------------------------------------------ the bundled AI Worker and a migrated D1 (as H3F-4)
async function loadWorkerModule() {
  const out = await build({
    entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"], write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-h3f-ui-"));
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
const ctx = { waitUntil: () => {}, passThroughOnException() {} };

/**
 * The seed's clock and randomness: Date.now at the fixture's clock (moved on by `tick`), crypto.getRandomValues from a
 * counter (so each correction_id is the same on every run), no network. Restored afterwards.
 */
async function deterministic(fn) {
  const realNow = Date.now, realRandom = crypto.getRandomValues.bind(crypto), realFetch = globalThis.fetch;
  let clock = NOW, n = 0;
  Date.now = () => clock;
  crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = (n * 37 + i * 11 + 0xa1) & 255; n += 1; return a; };
  globalThis.fetch = async () => { throw new Error("no network in the seed"); };
  try { return await fn((ms) => { clock += ms; }); } finally { Date.now = realNow; crypto.getRandomValues = realRandom; globalThis.fetch = realFetch; }
}

/** One request through the Omega Worker's handler: { status, body }. */
function caller(a) {
  return async (env, token, { method = "POST", path = "/omega/api/correction", body = RATE, raw = null, headers = {} } = {}) => {
    const req = new Request(`${ORIGIN}${path}`, {
      method, body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
      headers: { "cf-access-jwt-assertion": token, origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }
    });
    const r = await omegaHandle(req, env, a.opts);
    return { status: r.status, body: await r.json() };
  };
}

/** The seeded answers (see the header). Deterministic: a fresh store, D1, memo and key cache on every call. */
export async function seedH3f() {
  const mod = await loadWorkerModule();
  const a = await access();
  const call = caller(a);
  return deterministic(async (tick) => {
    resetKeyCacheForTests();
    resetFeatureSwitchMemoForTests();
    resetOwnerCorrectionsSchemaForTests();
    const store = kv(), db = await migratedD1();
    const gw = new mod.OmegaGateway(ctx, { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: db });
    const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_ACCESS_SUB: OWNER, OMEGA: gw };
    const fs = (token) => call(env, token, { method: "GET", path: "/omega/api/feature-switches" }).then((r) => r.body);
    const replies = {};
    // Off (the default): the GET says off and a POST is 409 disabled.
    const off = await fs(a.owner);
    replies.disabled = await call(env, a.owner);
    // The owner turns it on in FS1 (the panel's route), past the 30 s memo.
    const on = await call(env, a.owner, { path: "/omega/api/feature-switches", body: { key: "OWNER_CORRECTIONS", value: "on" } });
    if (on.status !== 200 || on.body?.switch?.value !== "on") throw new Error(`OWNER_CORRECTIONS on: ${JSON.stringify(on)}`);
    tick(31_000);
    const owner = await fs(a.owner);
    const viewer = await fs(a.viewer);
    // 200s: a rating, the same again (deduplicated), and the masking of a price, a secret and both.
    replies.rated = await call(env, a.owner);
    replies.deduplicated = await call(env, a.owner);
    replies.corrected = await call(env, a.owner, { body: CORRECT });
    replies.price = await call(env, a.owner, { body: { ...CORRECT, text: "The stop at 4095.5 sat inside the noise." } });
    replies.secret = await call(env, a.owner, { body: { ...CORRECT, text: `Too sure for a range; ${SECRET} pasted by mistake.` } });
    replies.secret_price = await call(env, a.owner, { body: { ...CORRECT, text: `The stop at 4095.5 was inside the noise; ${SECRET} pasted by mistake.` } });
    // 400: the shape (the route's correctionRequest and personJson), then the AI Worker's own refusals.
    const bad = {
      unknown_field: { ...RATE, stop_loss: 4000 }, invalid_source: { ...RATE, source: "chat_rating" }, invalid_label: { ...RATE, label: "owner_decision" },
      rating_required: { ...RATE, rating: null }, invalid_rating: { ...RATE, rating: "sideways" }, invalid_category: { ...RATE, category: "too_tight" },
      invalid_target: { ...RATE, target: { ...ENGINE_TARGET, ref: "engine_decisions d_1" } }, invalid_subject: { ...RATE, target: { ...ENGINE_TARGET, subject: "owner" } },
      invalid_as_of: { ...RATE, target: { ...ENGINE_TARGET, as_of: "yesterday" } }, invalid_text: { ...CORRECT, text: 42 }, text_too_long: { ...CORRECT, text: "x".repeat(501) },
      invalid_evidence_refs: { ...RATE, evidence_refs: ["not a ref"] }, too_many_refs: { ...RATE, evidence_refs: Array.from({ length: 11 }, (_, i) => `ev:xauusd/engine_decisions/k${i}`) },
      category_or_text_required: { ...CORRECT, category: null, text: "  " },
      // The text is only a zero-width space: the route sees text, the AI Worker's normalised text is empty.
      empty: { ...CORRECT, category: null, text: "​" }
    };
    for (const [name, body] of Object.entries(bad)) replies[name] = await call(env, a.owner, { body });
    replies.invalid_json = await call(env, a.owner, { raw: "{not json" });
    replies.not_an_object = await call(env, a.owner, { raw: "[]" });
    // 403, 413, 415.
    replies.owner_only = await call(env, a.viewer);
    replies.forbidden = await call(env, a.service);
    replies.cross_origin_refused = await call(env, a.owner, { headers: { origin: "https://evil.example" } });
    replies.same_origin_only = await call(env, a.owner, { headers: { "sec-fetch-site": "cross-site" } });
    replies.body_too_large = await call(env, a.owner, { body: { ...CORRECT, text: "x".repeat(5000) } });
    replies.content_type_must_be_json = await call(env, a.owner, { headers: { "content-type": "text/plain" } });
    // 429: two hours on, the hour's 30 corrections, then the 31st.
    tick(2 * 3_600_000);
    for (let i = 0; i < CORRECTIONS_PER_HOUR; i++) {
      const x = await call(env, a.owner, { body: { ...CORRECT, text: `Note ${i + 1} on this decision.` } });
      if (x.status !== 200) throw new Error(`the hour's correction ${i + 1}: ${JSON.stringify(x)}`);
      tick(1_000);
    }
    replies.rate_limited = await call(env, a.owner, { body: { ...CORRECT, text: "One more note." } });
    // 502 (the RPC throws) and 503 (an AI Worker without the RPC).
    replies.correction_failed = await call({ ...env, OMEGA: { overview: async () => ({}), recordCorrection: async () => { throw new Error("rpc down"); } } }, a.owner);
    replies.correction_unavailable = await call({ ...env, OMEGA: { overview: async () => ({}) } }, a.owner);
    return { off, owner, viewer, replies, session: await councilSession(), ...(await rooms()), verdicts: await strategyVerdicts() };
  });
}

/** One Call for Councils session as GET /api/council/session reads it: the seats' refs from the pack, as cleanSeat keeps them. */
async function councilSession() {
  resetSessionSchemaForTests();
  const db = await migratedD1();
  await ensureSessionSchema(db);
  const asOf = "2026-11-25T08:45:00.000Z";
  const pack = { refs: [
    evRef("plan_setups", "zp_2026-11-25T08:30:00Z_BUY", { field: "results_json" }),
    evRef("engine_decisions", ENGINE_KEY, { field: "stance" }),
    evRef("scorecard_snapshots", "7d", { asOf, field: "agent:technical" })
  ] };
  const created = NOW - 20 * 60_000;
  // The moderator's options as cleanOptions stores them; "tighten_stop" ends in a price word, so its ev_ref is null (optionRef).
  const options = { summary: "Two seats see the stop inside the noise; one sees too few setups.", options: [
    { option_id: "widen_to_sweep", rank: 1, kind: "repository_task", title: "Place the stop under the sweep low", hypothesis: "Fewer setups stop out inside the noise.", change: "small", risk: "low", dissent: null, spec: "Place the zone pullback stop under the sweep low." },
    { option_id: "tighten_stop", rank: 2, kind: "repository_task", title: "Keep the stop, tighten the entry", hypothesis: "A deeper entry keeps the same risk.", change: "small", risk: "medium", dissent: "Projection Agent", spec: "Enter deeper in the zone." },
    { option_id: "no_change", rank: 3, kind: "no_change", title: "No change (the control)", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null }
  ] };
  await db.prepare("INSERT INTO council_sessions (id, topic_key, topic_text, type, question, state, participants, pack_hash, pack_json, calls, options, reason, created_by, created_ms, updated_ms) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
    .bind("cfc_h3f_fixture", "strategy:zone_pullback", "strategy", "Is the zone pullback stop too tight?", "awaiting_owner", JSON.stringify(["risk", "technical", "projection"]), "h".repeat(64), JSON.stringify(pack), 8, JSON.stringify(options), "owner", created, NOW).run();
  const seat = (s, o) => ({ seat: s, ...cleanSeat(o, pack.refs) });
  const msgs = [
    ["position", seat("risk", { stance: "amend", opinion: "The stop sits inside the last swing's noise; most stopped setups would have reached the target.", proposal: "Widen the stop to the sweep low.", refs: [pack.refs[0], pack.refs[1]] }), created + 60_000],
    // A ref the platform's form cannot parse (":" after "#"): REF_RE passes, the control does not show.
    ["position", seat("technical", { stance: "support", opinion: "The setups that held came from the deeper zones.", proposal: null, refs: [pack.refs[2]] }), created + 120_000],
    ["position", seat("projection", { stance: "abstain", opinion: "Too few setups to tell.", proposal: null, refs: [] }), created + 180_000]
  ];
  for (const [round, m, ms] of msgs) {
    await db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("cfc_h3f_fixture", round, m.seat, m.stance, m.opinion, m.proposal, JSON.stringify(m.reply_to ?? []), JSON.stringify(m.refs ?? []), ms).run();
  }
  await db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, 'owner', 'owner', NULL, ?, NULL, ?, NULL, ?)")
    .bind("cfc_h3f_fixture", "Which setups were stopped inside the noise?", JSON.stringify(["risk"]), created + 240_000).run();
  return readSession({ DB: db }, "cfc_h3f_fixture");
}

/** A migrated D1 of the rooms (as test/ev-refs-h3f.test.mjs seeds them): the 15m War Room and the 1H room of one run each. */
const BAR = "2026-11-25T08:45:00.000Z", H1_RUN = "2026-11-25T09:00:00.000Z", H1_KEY = "OANDA:XAUUSD:60:" + Date.parse("2026-11-25T08:00:00Z");
async function rooms() {
  resetThreadSchemaCacheForTests();
  resetRoomRunsSchemaCacheForTests();
  const db = await migratedD1();
  await ensureThreadSchema(db);
  const thread = (id, kind, at) => db.raw.prepare("INSERT OR IGNORE INTO agent_threads (id, kind, ref_key, title, post_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)").run(id, kind, id, id, at, at);
  const msg = (t, run, step, agent, ts, bar, body, { stance = "WAIT", status = "ok" } = {}) => db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, model, status, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 0.6, ?, 'm', ?, 500)").run(t, run, step, agent, bar, ts, stance, JSON.stringify(body), status);
  const room = (t, run, bar, k) => {
    const at = (m) => new Date(Date.parse(run) + m * 60_000).toISOString();
    msg(t, run, "brief", "system", at(1), bar, { roster: ["technical", "risk"], candle_key: k, bar_time: bar }, { status: "info" });
    msg(t, run, "open:technical", "technical", at(2), bar, { claim: "The last closed candles made a lower high under the session open.", bias: "BEARISH", metrics: ["ema"] }, { stance: "SELL" });
    msg(t, run, "open:risk", "risk", at(2), bar, { claim: "Volatility is ordinary; no confirmation has closed.", bias: "NEUTRAL", metrics: ["atr"] });
    msg(t, run, "debate:risk", "risk", at(3), bar, { argument: "Without the R38 confirmation the short has no entry yet.", bias: "BEARISH", rebuts: ["technical"], metrics: ["atr"] });
    msg(t, run, "conclusion", "moderator", at(4), bar, { summary: "The room leans short, but no confirmation candle has closed, so the decision waits.", bias: "BEARISH", reasons: ["Lower high under the session open."], dissent: [], majority: "2/2" });
  };
  thread("warroom:2026-11-25", "warroom", BAR);
  room("warroom:2026-11-25", BAR, BAR, null);
  thread("tf:H1", "timeframe", H1_RUN);
  room("tf:H1", H1_RUN, H1_RUN, H1_KEY);
  const war = await readWarRoom(db, { barTime: BAR });
  const h1 = await readTimeframeThread(db, "H1", { runId: H1_RUN });
  // As the route sends them (JSON: an undefined key is dropped).
  return JSON.parse(JSON.stringify({ war: { status: "ok", enabled: true, room: war }, h1: { status: "ok", enabled: true, thread: h1 } }));
}

/** The strategy council's KV document (as runStrategyCouncil writes it), read by readCouncilVerdicts. */
async function strategyVerdicts() {
  const store = kv();
  await store.put(COUNCIL_KEY, JSON.stringify({ version: "cryptophys.strategy-council.v1", day: "2026-11-25", computed_at: "2026-11-25T00:20:00.000Z", acting: "propose", ceiling: "propose", auto: false, max_armed: 2, rules: {},
    verdicts: { zone_pullback: { walk_forward: { status: "pass", n: 41, mean_r: 0.12, low: 0.02, holdout_n: 10, holdout_mean_r: 0.08 }, live_mean_r: 0.1, proposal: "keep", reason: "the walk-forward holds", source: "council", allowed: ["keep", "disarm"], pinned: false } } }));
  return readCouncilVerdicts({ SIGNAL_CACHE: store });
}

// CLI: `node test/support/nexus-h3f-seed.mjs --write` rewrites the fixtures from the seed (after a contract change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedH3f();
  const dir = new URL("../fixtures/nexus-h3f/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const files = { "feature-switches-off.json": out.off, "feature-switches-on.json": out.owner, "feature-switches-viewer.json": out.viewer, "correction-replies.json": out.replies, "council-session.json": out.session, "war-room.json": out.war, "thread-h1.json": out.h1, "strategy-verdicts.json": out.verdicts };
  for (const [name, body] of Object.entries(files)) await writeFile(new URL(name, dir), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote ${Object.keys(files).length} fixtures to test/fixtures/nexus-h3f/`);
}
