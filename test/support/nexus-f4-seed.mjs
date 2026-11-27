// F4 UI: the answers the Nexus Data feeds page (Live › Data feeds, #/feeds) reads and gets, from the real code. The Omega
// Worker's routes (workers/xauusd-omega/src/omega.mjs handle: GET /omega/api/overview, POST /omega/api/bridge/sync,
// POST /omega/api/bridge/feed-sync, POST and DELETE /omega/api/feed-connection, GET /omega/api/bridge/key) in front of the
// bundled AI Worker's OmegaGateway (src/index.ts: overview with broker.feeds from feedOverview, bridgeSync, feedSync,
// setFeedConnection, clearFeedConnection; src/feed-bridge.mjs) over a migrated D1 and a KV store, with an Access JWT per
// caller: the owner (a person), a CI service token (a signed-in viewer that may not change anything), the executor
// bridge's and the feed bridge's own service tokens. The feed's login is sealed with the Omega Worker's own envelope code
// (workers/xauusd-omega/public/omega-crypto.js) to each feed's key. The keys below are public keys only (throwaway
// RSA-3072, no private key kept anywhere), and every login and password is an obvious placeholder.
// test/fixtures/nexus-f4/*.json are this seed's answers:
//   overview-empty.json   the owner's overview with the executor bridge synced and no feed bridge yet (broker.feeds []);
//   overview-fresh.json   the owner's overview with one feed, "oanda": synced 12 s ago, its terminal connected, its login
//                         stored (v1) and sealed to its current key;
//   overview-viewer.json  the same state read by the CI service token (viewer.can_control false);
//   overview-stale.json   later: "oanda" reinstalled with a new key (its stored login is sealed to the old one) and last
//                         synced 6 minutes ago, and a second feed, "backup", fresh, its terminal not connected, its login
//                         cleared by the owner;
//   bridge-key.json       GET /omega/api/bridge/key: the EXECUTOR's key (the feed form must never seal to it);
//   replies.json          { case: { status, body } }: POST stored, feed_bridge_not_seen, kid_mismatch and each other code
//                         the POST route and setFeedConnection answer; DELETE cleared and each code the DELETE answers.
// test/nexus-feeds-page.test.mjs checks each file against this seed, byte for byte. Regenerate them after a contract
// change: node test/support/nexus-f4-seed.mjs --write
import { readFile, readdir, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { handle as omegaHandle, resetKeyCacheForTests } from "../../workers/xauusd-omega/src/omega.mjs";
import { buildEnvelope } from "../../workers/xauusd-omega/public/omega-crypto.js";
import { resetFeedSchemaForTests } from "../../src/feed-bridge.mjs";
import { resetOmegaBrokerSchemaForTests } from "../../src/omega-broker.mjs";
import { resetCorpusSchemaCacheForTests } from "../../src/corpus-oracle.mjs";
import { kv } from "../fixtures/mode-shadow.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
/** The fixture's clock: 05:00 UTC, 12:00 GMT+7 on Friday 27 November 2026. */
export const NOW = Date.parse("2026-11-27T05:00:00Z");
export const ORIGIN = "https://nexus.cryptophys.work";
/** The service tokens' client ids (OMEGA_BRIDGE_CLIENT_ID, OMEGA_FEED_CLIENT_ID). */
const BRIDGE_ID = "f4bridge.access", FEED_ID = "f4feed.access";
/** Placeholders only: never a real login, password or server of anyone. */
export const PLACEHOLDER = Object.freeze({ login: "demo-login", password: "placeholder-pw", server: "OANDA-Demo-1" });

// ------------------------------------------------------------------ the keys (public halves only, throwaway)
const FEED_KEY = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAn4Zw0PGypKtwoIIcJWLAUbC1xZ4JcsK5dqaBtM3OnKq7le3mOAaCMgaq4cC3rhMkrRXvQceWHHPOKrgjw5B9azLG+oGUbWAjERcqJ2i17iyq1deQn0nOpfbVHHlyyqW4JVTHwg3pwMtVD1ptnkG4ikKRXSdEWHRHZITwHW15l4HySRYwaTNKwr/u3WWgjeRsPMl3XtFoZWIe1tdr9IoTNRAzDiIckTBHfBf3EC+aUJImOpKcGXC7AdBXH5UpOnJTPrq6QebLNRcEaCzmeAgoi1q/WgDjLmocLmd8vY6UtLMh8Uor0F6yc6P2I70r4VAliDAJ/HC8SOPWbr3wF45tQnprFSjKmt82zP6LZCmEh0TM8Wiy7qayqxunwqUcfWyn7/wroygTPgbvAvhyAz1jSUeShvdgNNF/HXY4g7/j4NTniK05HMA3PLBOCpU7Nc1K+2Z9Exfl5dgstIAQ7P4l4DCybPNG48uNrodnoCIzO05mBoJHv7BTQcUTvYAqoRCLAgMBAAE=";
const FEED_KEY_NEW = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAumjBA47NennOM7/70JvdoT32JwaGBoavIA5RGBeiMjPQi75/9OGlBoykkpNCJHxkCitpKONOI7ezQ4kLCUFCAt4wT6vyNkuZpXAnaxDzL0PiFLkvXseZhZXm0/RwW8/ZW5yxyzdyMBLx6txKmlh9PwWMTG90gVWY5EkEQmz9LZIIxY2nHJWeT92iTBozkTPZl406EyDEVJhKF5srzsDmo6M7TOCkyRdl+3jJiyB6uOmW1/zrKJyK7ZN9ooOyJS6+TSEz4K564hWu/fjwhdZ63wG4c2qe/ify9ZUP3saI/L1wOua3trBwhG25bfEFPU7jHPTx9POMpJ03iJZdi+r/L2SxgLOV4WgBB23V1RG5OWlrWHdgEHkByJa16S6w71wo7dApbP4L8xlC8xzGYoHhtK2/FtWkG/3ZbejuQH61DzGm72uM1cObh9vVZm0q4Dzt+muWqKskFIqX1jFgLi78TF/Fh0jcOrdQzgQTClZMNhzQpbUQe+22u9DkiBpN0h9dAgMBAAE=";
const EXECUTOR_KEY = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0elNEp61tRXlccwGLuzXGRLGXPwuYgRDkjStAjBeirLmXRi02nDyLg43jP/NRSB00GDVYxKyI4asvSIzSjpCcy5eeQ//8nyV7s2fMgJjRzEYhybMrZiNnea4TEnY61K5aANOSrLoIOR1r49IMgHg+2taVAuVS4HYEPxIGZi+dM14T0nZ8AAKt0HUtpotnbUuc7Tt2yCJnHUuKwvTXhx5k4g4+MvYinKKRzWR04s+fxTfWdSg3QKAmI9tDDAo/ckbGw/CcQ6SbfEF4T6wO6rTy9QrsD/NQ9iY3aYapykPDoibLYJno6x6bBhGV3Hbq2WmRpDrgUTW0CXPJJ1+U5vTBpxqH2RgCTn/1avdt6WVU4cEsrhSbc26bezPJkFLK+LkYYqkcfsa/8ECeawR4QRJM2FjOmORCVdcerKkXFUF+VyFRLMqvX0TBXqtjqFiInV4eSzFY2XrmFftiZapth+Qtsfv0FaLbTXqh1I5NW6PYKfd8GEqOlKhMfhzeMyUyPinAgMBAAE=";
const kidOf = async (spki) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(spki, "base64"))).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
/** The feed's key, the key it has after a reinstall, and the executor bridge's key (with their kids). */
export const KEYS = Object.freeze({ feed: FEED_KEY, feedNew: FEED_KEY_NEW, executor: EXECUTOR_KEY });

// ------------------------------------------------------------------ the Access JWT (as test/support/nexus-h3f-seed.mjs)
export const TEAM = "cryptophys.cloudflareaccess.com", AUD = "c".repeat(64);
const NOW_S = Math.floor(NOW / 1000);
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
export async function access() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const jwt = async (claims) => {
    const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW_S + 3600, ...claims });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return {
    opts: { fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: NOW_S },
    owner: await jwt({ email: "owner@example.com", sub: "owner-sub-f4-fixture" }),
    viewer: await jwt({ common_name: "ci.access" }),
    bridge: await jwt({ common_name: BRIDGE_ID }),
    feed: await jwt({ common_name: FEED_ID })
  };
}

// ------------------------------------------------------------------ the bundled AI Worker and a migrated D1 (as H3f)
async function loadWorkerModule() {
  const out = await build({
    entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-f4-ui-"));
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

/** Date.now at the fixture's clock (moved by `at`), no network; restored afterwards. */
async function deterministic(fn) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  let clock = NOW;
  Date.now = () => clock;
  globalThis.fetch = async () => { throw new Error("no network in the seed"); };
  try { return await fn((ms) => { clock = ms; }); } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}

/** One request through the Omega Worker's handler, as the browser sends it from the Nexus origin: { status, body }. */
export function caller(a) {
  return async (env, token, { method = "POST", path = "/omega/api/feed-connection", body = {}, raw = null, headers = {} } = {}) => {
    const req = new Request(`${ORIGIN}${path}`, {
      method, body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
      headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), origin: ORIGIN, "content-type": "application/json", ...headers }
    });
    const r = await omegaHandle(req, env, a.opts);
    return { status: r.status, body: await r.json() };
  };
}

/** The executor bridge's sync (its own service token): a demo terminal on another broker, no position. */
const executorSync = (at) => ({ public_key: EXECUTOR_KEY, bridge_version: "1.8.0", results: [], state: { connected: true, server: "ExecBroker-Demo", received_ms: at - 1000, trade_mode: "demo", account: { currency: "USD" }, symbol: { name: "XAUUSD" }, positions: [] } });
/** A feed bridge's sync (the feed's own service token): its key and a terminal state; never an account kept. */
const feedSyncBody = (bridgeId, publicKey, kid, { connected = true, server = PLACEHOLDER.server } = {}) => ({ bridge_id: bridgeId, public_key: publicKey, kid, bridge_version: "1.9.0", state: { connected, server, symbol: { name: "XAUUSD" } } });

/** The seeded answers (see the header). Deterministic: a fresh D1, store and key cache on every call. */
export async function seedF4() {
  const mod = await loadWorkerModule();
  const a = await access();
  const call = caller(a);
  const kids = { feed: await kidOf(FEED_KEY), feedNew: await kidOf(FEED_KEY_NEW), executor: await kidOf(EXECUTOR_KEY) };
  return deterministic(async (at) => {
    resetKeyCacheForTests();
    resetFeedSchemaForTests();
    resetOmegaBrokerSchemaForTests();
    resetCorpusSchemaCacheForTests();
    const db = await migratedD1();
    const gw = new mod.OmegaGateway(ctx, { DB: db, SIGNAL_CACHE: kv() });
    const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA_BRIDGE_CLIENT_ID: BRIDGE_ID, OMEGA_FEED_CLIENT_ID: FEED_ID, OMEGA: gw };
    const must = (r, what) => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${JSON.stringify(r)}`); return r; };
    const overview = (token) => call(env, token, { method: "GET", path: "/omega/api/overview" }).then((r) => must(r, "overview").body);
    const sealed = (spki, kid) => buildEnvelope(spki, kid, PLACEHOLDER);
    const replies = {};

    // Ten minutes before: the executor bridge syncs; no feed bridge has connected yet.
    at(NOW - 600_000);
    must(await call(env, a.bridge, { path: "/omega/api/bridge/sync", body: { ...executorSync(NOW - 600_000), kid: kids.executor } }), "executor sync");
    const empty = await overview(a.owner);
    const bridgeKey = must(await call(env, a.owner, { method: "GET", path: "/omega/api/bridge/key" }), "bridge key").body;
    // A login for a feed bridge that has never synced.
    replies.feed_bridge_not_seen = await call(env, a.owner, { body: { bridge_id: "oanda", server: PLACEHOLDER.server, envelope: await sealed(FEED_KEY, kids.feed) } });

    // The feed bridge "oanda" syncs, the owner stores its login, the feed syncs again and gets it.
    at(NOW - 20_000);
    must(await call(env, a.feed, { path: "/omega/api/bridge/feed-sync", body: feedSyncBody("oanda", FEED_KEY, kids.feed) }), "feed sync");
    at(NOW - 15_000);
    replies.stored = must(await call(env, a.owner, { body: { bridge_id: "oanda", server: PLACEHOLDER.server, envelope: await sealed(FEED_KEY, kids.feed) } }), "stored");
    at(NOW - 12_000);
    must(await call(env, a.feed, { path: "/omega/api/bridge/feed-sync", body: feedSyncBody("oanda", FEED_KEY, kids.feed) }), "feed sync 2");
    at(NOW);
    const fresh = await overview(a.owner);
    const viewer = await overview(a.viewer);

    // Each refusal of the POST (the route's personJson, the binding, setFeedConnection's checks) and of the DELETE.
    const good = { bridge_id: "oanda", server: PLACEHOLDER.server, envelope: await sealed(FEED_KEY, kids.feed) };
    replies.server_invalid = await call(env, a.owner, { body: { ...good, server: "<script>" } });
    replies.bridge_id_invalid = await call(env, a.owner, { body: { ...good, bridge_id: "Bad Id!" } });
    replies.envelope_invalid = await call(env, a.owner, { body: { ...good, envelope: { v: 2 } } });
    replies.forbidden = await call(env, a.viewer, { body: good });
    replies.access_denied = await call(env, null, { body: good });
    replies.cross_origin_refused = await call(env, a.owner, { body: good, headers: { origin: "https://evil.example" } });
    replies.content_type_must_be_json = await call(env, a.owner, { body: good, headers: { "content-type": "text/plain" } });
    replies.body_too_large = await call(env, a.owner, { body: { ...good, pad: "x".repeat(17_000) } });
    replies.invalid_json = await call(env, a.owner, { raw: "{not json" });
    replies.not_an_object = await call(env, a.owner, { raw: "[]" });
    replies.feed_unavailable = await call({ ...env, OMEGA: { overview: async () => ({}) } }, a.owner, { body: good });
    replies.feed_connection_failed = await call({ ...env, OMEGA: { overview: async () => ({}), setFeedConnection: async () => { throw new Error("rpc down"); } } }, a.owner, { body: good });
    replies.delete_reason_required = await call(env, a.owner, { method: "DELETE", body: { bridge_id: "oanda", reason: "  " } });
    replies.delete_forbidden = await call(env, a.viewer, { method: "DELETE", body: { bridge_id: "oanda", reason: "rotate the feed login" } });

    // A minute on: "oanda" is reinstalled with a new key; a login sealed to its old key is refused.
    at(NOW + 60_000);
    must(await call(env, a.feed, { path: "/omega/api/bridge/feed-sync", body: feedSyncBody("oanda", FEED_KEY_NEW, kids.feedNew) }), "feed reinstalled");
    replies.kid_mismatch = await call(env, a.owner, { body: good });
    // Seven minutes on: a second feed, "backup", has synced (its terminal not logged in) and the owner cleared its login.
    at(NOW + 410_000);
    must(await call(env, a.feed, { path: "/omega/api/bridge/feed-sync", body: feedSyncBody("backup", FEED_KEY, kids.feed, { connected: false, server: "Backup-Demo" }) }), "backup sync");
    at(NOW + 415_000);
    replies.cleared = must(await call(env, a.owner, { method: "DELETE", body: { bridge_id: "backup", reason: "rotate the feed login" } }), "cleared");
    at(NOW + 420_000);
    const stale = await overview(a.owner);
    return { empty, fresh, viewer, stale, bridgeKey, replies, kids };
  });
}

// CLI: `node test/support/nexus-f4-seed.mjs --write` rewrites the fixtures from the seed (after a contract change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedF4();
  const dir = new URL("../fixtures/nexus-f4/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const files = { "overview-empty.json": out.empty, "overview-fresh.json": out.fresh, "overview-viewer.json": out.viewer, "overview-stale.json": out.stale, "bridge-key.json": out.bridgeKey, "replies.json": out.replies };
  for (const [name, body] of Object.entries(files)) await writeFile(new URL(name, dir), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote ${Object.keys(files).length} fixtures to test/fixtures/nexus-f4/`);
}
