// F4, the Nexus Data feeds page (Live › Data feeds, #/feeds; owner 2026-11-27 "Setuju", placement "tempatkan di nexus >
// live"; F1 #629 live): its fixtures (test/fixtures/nexus-f4/*.json, the seeded answers of the real Omega routes and the
// bundled AI Worker: test/support/nexus-f4-seed.mjs), its place in the Live group, its one read (the Omega page's own
// overview path, from its allow-list) and its two writes (POST and DELETE /omega/api/feed-connection, same origin, JSON,
// replayed through the real Omega Worker route), sealing with the Omega page's own envelope code to THE FEED's key (never
// the executor's), every field cleared after a submit, the error texts, the empty state, the disconnect's required
// reason, the password never outside the sealed envelope, the owner gate (a viewer sees status only) and the tones.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createHash, privateDecrypt, constants, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { seedF4, access, caller, ORIGIN, PLACEHOLDER, TEAM, AUD } from "./support/nexus-f4-seed.mjs";
import { envelopeError } from "../src/omega-broker.mjs";
import { feedSync, setFeedConnection, clearFeedConnection, feedOverview, resetFeedSchemaForTests } from "../src/feed-bridge.mjs";
import { resetKeyCacheForTests } from "../workers/xauusd-omega/src/omega.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-f4/${f}`));
const EMPTY = fixture("overview-empty.json"), FRESH = fixture("overview-fresh.json"), VIEWER = fixture("overview-viewer.json"), STALE = fixture("overview-stale.json");
const BRIDGE_KEY = fixture("bridge-key.json"), REPLIES = fixture("replies.json");
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
const SECRETS = [PLACEHOLDER.password, PLACEHOLDER.login];

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/feeds"; export { FeedsView, FeedCard, DisconnectDialog, DATA_ONLY } from "./src/pages/Feeds"; export { buildEnvelope } from "./src/pages/Omega"; export { render, VIEWS, F4_VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
async function view(d, props = {}) {
  const u = await ui();
  const html = u.render(({ d: body }) => u.FeedsView({ d: body, ...props }), d);
  clean(html);
  return html;
}
/** A form as the page's submit reads it, recording its resets. */
const formOf = (values) => {
  const f = { values: { ...values }, resets: 0, value: (n) => f.values[n] ?? "", reset: () => { f.resets += 1; f.values = { login: "", password: "", server: "" }; } };
  return f;
};
/** A fetch that records each request and answers with one reply ({ status, body }), or throws for "network". */
const fakeFetch = (reply = REPLIES.stored) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); if (reply === "network") throw new TypeError("Failed to fetch"); return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }); };
  fn.calls = calls;
  return fn;
};
const feedOfBody = async (body, id) => (await ui()).feedsOf(body).find((f) => f.bridge_id === id);

test("F4-1 the fixtures are the seed's answers, byte for byte; each feed row has exactly F1's fields, no envelope, no secret", async () => {
  const seed = await seedF4();
  const hint = "regenerate with `node test/support/nexus-f4-seed.mjs --write` after a contract change";
  assert.deepEqual(EMPTY, seed.empty, `overview-empty.json: ${hint}`);
  assert.deepEqual(FRESH, seed.fresh, `overview-fresh.json: ${hint}`);
  assert.deepEqual(VIEWER, seed.viewer, `overview-viewer.json: ${hint}`);
  assert.deepEqual(STALE, seed.stale, `overview-stale.json: ${hint}`);
  assert.deepEqual(BRIDGE_KEY, seed.bridgeKey);
  assert.deepEqual(REPLIES, seed.replies);
  assert.deepEqual(EMPTY.broker.feeds, []);
  for (const d of [FRESH, VIEWER, STALE]) for (const f of d.broker.feeds) {
    assert.deepEqual(Object.keys(f), ["bridge_id", "role", "kid", "public_key", "bridge_version", "synced_age_ms", "fresh", "terminal_connected", "server", "symbol", "connection"]);
    assert.deepEqual(Object.keys(f.connection), ["version", "status", "server", "sealed_to_current_key", "updated_ms"]);
  }
  const all = JSON.stringify([EMPTY, FRESH, VIEWER, STALE, REPLIES]);
  assert.doesNotMatch(all, /envelope"|wrapped_key|ciphertext/, "the overview never carries a sealed login");
  for (const s of SECRETS) assert.equal(all.includes(s), false, `no ${s} in any fixture`);
  assert.deepEqual([FRESH.viewer.can_control, VIEWER.viewer.can_control], [true, false]);
  assert.notEqual(FRESH.broker.bridge.kid, FRESH.broker.feeds[0].kid, "the executor bridge and the feed have their own keys");
  assert.equal(BRIDGE_KEY.kid, FRESH.broker.bridge.kid);
});

test("F4-2 NAV: Live › Data feeds after System status, at /#/feeds, key feeds, icon RadioTower; the route in PAGES; the Omega page holds no feed card", () => {
  const shell = src("components/AppShell.tsx");
  const nav = shell.slice(shell.indexOf("export const NAV_GROUPS"), shell.indexOf("export const NAV ="));
  assert.deepEqual([...nav.matchAll(/\{ title: "([^"]+)"/g)].map((m) => m[1]), ["Live", "Execution", "Councils", "Analytics", "Market", "Intelligence", "Settings"]);
  const live = nav.slice(nav.indexOf('{ title: "Live"'), nav.indexOf('{ title: "Execution"'));
  assert.deepEqual([...live.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]), ["War Room", "System status", "Data feeds"]);
  assert.match(live, /\{ label: "Data feeds", href: "\/#\/feeds", key: "feeds", icon: RadioTower \}/);
  assert.match(shell, /import \{[^}]*\bRadioTower\b[^}]*\} from "lucide-react";/);
  const app = src("App.tsx");
  assert.match(app, /import Feeds from "\.\/pages\/Feeds";/);
  assert.match(app, /status: Status, feeds: Feeds,/);
  const omega = src("pages/Omega.tsx");
  for (const t of ["feed-connection", "Data feeds", "broker.feeds", "Feeds"]) assert.equal(omega.includes(t), false, `Omega.tsx: ${t}`);
  assert.match(omega, /\["engine", "Engine"\], \["profile", "Risk profile"\], \["connection", "Connection & EA"\]/, "the Setup tabs are as before");
});

test("F4-3 one read, the Omega page's own overview path, from the page's allow-list; the writes only to /omega/api/feed-connection", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(u.FEEDS_READS, { overview: { path: "/omega/api/overview", everyMs: 30_000, chart: false } });
  assert.match(src("pages/Omega.tsx"), /omegaJson\("\/omega\/api\/overview"\)/, "the Omega page reads the same path");
  assert.equal(u.FEED_CONNECTION_PATH, "/omega/api/feed-connection");
  const lib = src("lib/feeds.ts"), page = src("pages/Feeds.tsx");
  assert.match(lib, /intelGet\(FEEDS_READS, "overview"\)/);
  assert.equal((lib.match(/fetchImpl\(/g) ?? []).length, 1, "one fetch: the write");
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code(page), /\bfetch\(|\/omega\/api\//, "the page itself requests nothing but through lib/feeds.ts");
  assert.doesNotMatch(lib + page, /bridge\/key/, "never the executor's key route");
});

test("F4-4 sealing uses THE FEED's public key and kid with the shared seal function, never the executor bridge's", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  for (const [body, id] of [[FRESH, "oanda"], [STALE, "oanda"], [STALE, "backup"]]) {
    const feed = await feedOfBody(body, id);
    const raw = body.broker.feeds.find((f) => f.bridge_id === id);
    const seals = [];
    const seal = async (...args) => { seals.push(args); return { v: 1, kid: args[1] }; };
    const f = fakeFetch();
    await u.submitFeedLogin(feed, formOf(PLACEHOLDER), { seal, fetchImpl: f });
    assert.equal(seals.length, 1);
    assert.deepEqual(seals[0], [raw.public_key, raw.kid, { server: PLACEHOLDER.server, login: PLACEHOLDER.login, password: PLACEHOLDER.password }]);
    assert.notEqual(seals[0][1], body.broker.bridge.kid, "not the executor's kid");
    assert.notEqual(seals[0][0], BRIDGE_KEY.public_key, "not the executor's public key");
    assert.deepEqual(f.calls.map((c) => c.url), ["/omega/api/feed-connection"], "no read of /omega/api/bridge/key");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { bridge_id: id, server: PLACEHOLDER.server, envelope: { v: 1, kid: raw.kid } });
  }
  assert.equal(STALE.broker.feeds.find((f) => f.bridge_id === "oanda").kid, "97f95ff94b0dbbdc", "after a reinstall: the feed's new key");
  // The shared seal function: the Omega page's own buildEnvelope (one implementation in the UI), as the page passes it.
  const page = src("pages/Feeds.tsx");
  assert.match(page, /import \{ buildEnvelope \} from "\.\/Omega";/);
  assert.match(page, /submitFeedLogin\(feed, formOf\(form\), \{ seal: buildEnvelope \}\)/);
  const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const subtle = files(`${UI}src`).filter((f) => /crypto\.subtle\.(encrypt|importKey|generateKey)/.test(readFileSync(f, "utf8"))).map((f) => f.slice(UI.length));
  assert.deepEqual(subtle, ["src/pages/Omega.tsx"], "the envelope code exists once, in the Omega page, never reimplemented");
  assert.match(src("pages/Omega.tsx"), /\nexport async function buildEnvelope\(publicKeySpkiBase64: string, kid: string, creds: \{ server: string; login: string; password: string \}\) \{/);
  // The executor form still seals to the executor bridge's key, as before.
  assert.match(src("pages/Omega.tsx"), /const key = await omegaJson\("\/omega\/api\/bridge\/key"\);\n\s*const envelope = await buildEnvelope\(key\.public_key, key\.kid, \{ server, login, password \}\);\n\s*const out = await omegaJson\("\/omega\/api\/connection", "POST"/);
});

test("F4-5 every field is cleared after a submit, whether it was saved, refused, unanswered, unsealable or incomplete", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const feed = await feedOfBody(FRESH, "oanda");
  const seal = async (_k, kid) => ({ v: 1, kid });
  const cases = [
    ["saved", PLACEHOLDER, seal, fakeFetch(REPLIES.stored), { ok: true, version: 1, server: PLACEHOLDER.server }],
    ["refused", PLACEHOLDER, seal, fakeFetch(REPLIES.kid_mismatch), { ok: false, error: "kid_mismatch" }],
    ["network", PLACEHOLDER, seal, fakeFetch("network"), { ok: false, error: "network" }],
    ["seal throws", PLACEHOLDER, async () => { throw new Error(`the bridge key does not match its id ${PLACEHOLDER.password}`); }, fakeFetch(), { ok: false, error: "key_check_failed" }],
    ["no password", { ...PLACEHOLDER, password: "" }, seal, fakeFetch(), { ok: false, error: "fields_required" }],
    ["bad server", { ...PLACEHOLDER, server: "<script>" }, seal, fakeFetch(), { ok: false, error: "server_invalid" }]
  ];
  for (const [name, values, s, f, want] of cases) {
    const form = formOf(values);
    const r = await u.submitFeedLogin(feed, form, { seal: s, fetchImpl: f });
    assert.deepEqual(r, want, name);
    assert.equal(form.resets, 1, `${name}: the form is reset once`);
    assert.deepEqual(form.values, { login: "", password: "", server: "" }, `${name}: every field empty`);
    for (const x of SECRETS) assert.equal(JSON.stringify(r).includes(x), false, `${name}: no field value in the result`);
  }
  // The inputs are uncontrolled, so a reset empties them: no value or defaultValue, no React state for any field.
  const page = src("pages/Feeds.tsx");
  assert.doesNotMatch(page, /\bvalue=\{|defaultValue|useRef/);
  assert.match(page, /reset: \(\) => form\.reset\(\)/);
  assert.equal((page.match(/name="(login|password|server)"/g) ?? []).length, 3);
});

test("F4-6 the error texts: feed_bridge_not_seen (start the bridge first), kid_mismatch (reload and retry); every other code inline with role=alert", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(u.errorWords("feed_bridge_not_seen"), "The feed bridge has not synced yet. Start it on the VPS first, then retry.");
  assert.equal(u.errorWords("kid_mismatch"), "The feed's key changed. Reload the page and retry.");
  assert.deepEqual([REPLIES.feed_bridge_not_seen.status, REPLIES.feed_bridge_not_seen.body.error], [400, "feed_bridge_not_seen"]);
  assert.deepEqual([REPLIES.kid_mismatch.status, REPLIES.kid_mismatch.body.error], [400, "kid_mismatch"]);
  const feed = await feedOfBody(FRESH, "oanda");
  for (const [k, r] of Object.entries(REPLIES).filter(([, r]) => r.status !== 200)) {
    const res = u.replyResult(r.status, r.body);
    assert.equal(res.ok, false, k);
    const html = await view(FRESH, { ui: { oanda: { msg: { kind: "error", code: res.error } } } });
    assert.match(html, /<p role="alert" class="text-\[11\.5px\] text-fault"><span class="mono break-all">Refused: /, k);
    assert.ok(html.includes(`Refused: ${res.error.replace(/'/g, "&#x27;")}`), k);
    assert.ok(html.includes(u.errorWords(res.error).replace(/'/g, "&#x27;")), k);
    assert.notEqual(u.errorWords(res.error), "Nothing changed.", `${k}: its own words`);
    // The same code from a fetch: submitFeedLogin answers it.
    assert.deepEqual(await u.submitFeedLogin(feed, formOf(PLACEHOLDER), { seal: async () => ({}), fetchImpl: fakeFetch(r) }), { ok: false, error: res.error }, k);
  }
  for (const code of u.LOCAL_ERRORS) assert.notEqual(u.errorWords(code), "Nothing changed.", code);
  for (const code of u.SERVER_ERRORS) assert.notEqual(u.errorWords(code), "Nothing changed.", code);
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["F4Error_feed_bridge_not_seen", "F4Error_kid_mismatch", "F4Local_network", "F4RefusedNoBody"]) assert.ok(names.includes(n), n);
});

test("F4-7 the empty state: \"No feed bridge has connected yet\"; no feed list at all is its own state", { skip: NO_UI_DEPS }, async () => {
  const html = await view(EMPTY);
  assert.ok(html.includes("No feed bridge has connected yet"));
  assert.ok(html.includes("A feed bridge shows here after its first sync from the VPS."));
  assert.doesNotMatch(html, /<form|Save feed login/);
  for (const d of [null, {}, { error: "Not found" }, { broker: {} }]) {
    const h = await view(d);
    assert.ok(h.includes("No feed data") && !h.includes("No feed bridge has connected yet"), JSON.stringify(d));
  }
});

test("F4-8 the disconnect needs a reason: refused before any request without one; the confirm box stays disabled; DELETE { bridge_id, reason }", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  for (const reason of ["", "   ", null]) {
    const f = fakeFetch(REPLIES.cleared);
    assert.deepEqual(await u.disconnectFeed({ bridge_id: "backup" }, reason, f), { ok: false, error: "reason_required" });
    assert.equal(f.calls.length, 0, "no request without a reason");
  }
  const f = fakeFetch(REPLIES.cleared);
  assert.deepEqual(await u.disconnectFeed({ bridge_id: "backup" }, "  rotate the feed login ", f), { ok: true, version: 1, server: null });
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { bridge_id: "backup", reason: "rotate the feed login" });
  assert.deepEqual(REPLIES.delete_reason_required.body, { ok: false, error: "a reason is required to disconnect" }, "the server refuses one too");
  assert.equal(u.errorWords("a reason is required to disconnect"), "Write a reason to disconnect.");
  const box = u.render(() => u.DisconnectDialog({ feed: { bridge_id: "oanda" }, onDone: () => {} }), null);
  clean(box);
  assert.ok(box.includes("Disconnect the oanda feed?") && box.includes("Reason (required)") && box.includes('aria-required="true"'));
  assert.match(box, /<button type="button" disabled=""[^>]*>Disconnect<\/button>/, "disabled until a reason is written");
  const cd = src("components/ConfirmDialog.tsx");
  assert.match(cd, /const ready = \(options\.typed == null \|\| text === options\.typed\) && \(!hasReason \|\| why\.trim\(\) !== ""\);/);
  assert.match(src("pages/Feeds.tsx"), /const r = await disconnectFeed\(feed, reason \?\? ""\);/);
  // The owner's Disconnect only where a login is stored.
  const html = await view(STALE);
  assert.match(html, /id="feed-oanda-disconnect" class="btn btn-danger">Disconnect</, "oanda has a stored login");
  assert.match(html, /disabled="" id="feed-backup-disconnect"|id="feed-backup-disconnect" disabled=""|<button type="button" id="feed-backup-disconnect" disabled=""/, "backup's login is cleared");
});

test("F4-9 the password never leaves the browser unsealed: the request carries it only inside the envelope, which the feed's private key opens and the real route stores", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // A throwaway feed key pair made here (its private half lives only in this test).
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const kid = createHash("sha256").update(Buffer.from(spki, "base64")).digest("hex").slice(0, 16);
  const feed = u.feedOf({ ...FRESH.broker.feeds[0], public_key: spki, kid });
  const f = fakeFetch(REPLIES.stored);
  const r = await u.submitFeedLogin(feed, formOf(PLACEHOLDER), { seal: u.buildEnvelope, fetchImpl: f });
  assert.equal(r.ok, true);
  const { url, init } = f.calls[0];
  for (const s of SECRETS) {
    assert.equal(init.body.includes(s), false, `${s} is not in the request body`);
    assert.equal(JSON.stringify(init.headers).includes(s), false);
    assert.equal(url.includes(s), false);
  }
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["bridge_id", "server", "envelope"]);
  assert.equal(envelopeError(body.envelope), null, "the server's own envelope check passes");
  assert.equal(body.envelope.kid, kid);
  // Opened with the feed's private key: AES-256-GCM under the RSA-OAEP SHA-256 wrapped key (docs/OMEGA_BRIDGE_PROTOCOL.md).
  const aes = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(body.envelope.wrapped_key, "base64"));
  const ct = Buffer.from(body.envelope.ciphertext, "base64");
  const d = createDecipheriv("aes-256-gcm", aes, Buffer.from(body.envelope.iv, "base64"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const opened = JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8"));
  assert.deepEqual(opened, { server: PLACEHOLDER.server, login: PLACEHOLDER.login, password: PLACEHOLDER.password });
  // No field value in any rendered state, and nothing kept, stored or logged by the page or its model.
  for (const v of u.F4_VIEWS) { const html = u.render(v.View, v.fixture); for (const s of SECRETS) assert.equal(html.includes(s), false, `${v.name}: ${s}`); }
  const code = src("pages/Feeds.tsx") + src("lib/feeds.ts");
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|\.message\b/);
  assert.doesNotMatch(src("pages/Feeds.tsx"), /useState<[^>]*>\(\s*""|setPassword|setLogin/, "no React state holds a field");
});

test("F4-10 the writes leave the Nexus origin same-origin and JSON, as the executor form's; replayed through the real Omega Worker they are stored and cleared", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The executor's form (Omega.tsx omegaJson) sends the same init.
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /credentials: "same-origin",\n\s*headers: \{\n\s*accept: "application\/json",\n\s*\.\.\.\(body !== undefined \? \{ "content-type": "application\/json" \} : \{\}\),/);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const kid = createHash("sha256").update(Buffer.from(spki, "base64")).digest("hex").slice(0, 16);
  // The real Omega Worker route in front of the real src/feed-bridge.mjs over an in-memory D1 (as OmegaGateway wires it).
  resetFeedSchemaForTests();
  resetKeyCacheForTests();
  const db = new DatabaseSync(":memory:");
  const st = (sql, p = []) => ({ bind: (...a) => st(sql, a.map((v) => (v === undefined ? null : v))), run: async () => { db.prepare(sql).run(...p); return {}; }, first: async () => db.prepare(sql).get(...p) ?? null, all: async () => ({ results: db.prepare(sql).all(...p) }) });
  const dbEnv = { DB: { prepare: (sql) => st(sql) } };
  await feedSync(dbEnv, { bridgeId: "oanda", state: { connected: true, server: PLACEHOLDER.server }, publicKey: spki, kid, bridgeVersion: "1.9.0" });
  const OMEGA = { overview: async () => ({}), setFeedConnection: (i) => setFeedConnection(dbEnv, i), clearFeedConnection: (i) => clearFeedConnection(dbEnv, i) };
  const a = await access();
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA };
  const { handle } = await import("../workers/xauusd-omega/src/omega.mjs");
  const sent = [];
  // The browser's request: the page's init at the Nexus origin (a same-origin POST or DELETE carries Origin), its Access cookie as the JWT.
  const browserFetch = async (path, init) => {
    sent.push({ path, method: init.method, credentials: init.credentials, type: init.headers["content-type"] });
    const req = new Request(new URL(path, ORIGIN), { method: init.method, body: init.body, headers: { ...init.headers, origin: ORIGIN, "cf-access-jwt-assertion": a.owner } });
    return handle(req, env, a.opts);
  };
  const feed = u.feedOf({ ...FRESH.broker.feeds[0], public_key: spki, kid });
  const stored = await u.submitFeedLogin(feed, formOf(PLACEHOLDER), { seal: u.buildEnvelope, fetchImpl: browserFetch });
  assert.deepEqual(stored, { ok: true, version: 1, server: PLACEHOLDER.server });
  const row = db.prepare("SELECT status, kid, envelope FROM omega_feed_connections WHERE bridge_id = 'oanda'").get();
  assert.deepEqual([row.status, row.kid], ["stored", kid]);
  for (const s of SECRETS) assert.equal(row.envelope.includes(s), false, "only the sealed envelope is stored");
  const cleared = await u.disconnectFeed(feed, "rotate the feed login", browserFetch);
  assert.deepEqual(cleared, { ok: true, version: 2, server: null });
  assert.equal((await feedOverview(dbEnv))[0].connection.status, "cleared");
  assert.deepEqual(sent, [
    { path: "/omega/api/feed-connection", method: "POST", credentials: "same-origin", type: "application/json" },
    { path: "/omega/api/feed-connection", method: "DELETE", credentials: "same-origin", type: "application/json" }
  ]);
});

test("F4-11 the owner gate is viewer.can_control (the broker connection form's): a viewer sees status only, no form, no input, no button", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.match(src("pages/Omega.tsx"), /const canControl = Boolean\(viewer\.can_control\);/, "the executor form's gate");
  assert.match(src("lib/feeds.ts"), /export const canControlOf = \(body: any\): boolean => body\?\.viewer\?\.can_control === true;/);
  assert.deepEqual([u.canControlOf(FRESH), u.canControlOf(VIEWER), u.canControlOf({}), u.canControlOf(null)], [true, false, false, false]);
  const owner = await view(FRESH), viewer = await view(VIEWER);
  assert.match(owner, /<form id="feed-oanda-form"/);
  assert.equal((owner.match(/<input /g) ?? []).length, 3);
  assert.ok(owner.includes("Save feed login") && owner.includes(">Disconnect<"));
  for (const t of ["<form", "<input", "<button", "Save feed login", "Disconnect", "Feed login"]) assert.equal(viewer.includes(t), false, `viewer: ${t}`);
  for (const t of ["oanda", "synced 12s ago", "connected", "OANDA-Demo-1", "stored · v1", "read only"]) assert.ok(viewer.includes(t), `viewer sees ${t}`);
  const staleViewer = await view({ ...STALE, viewer: VIEWER.viewer });
  assert.ok(staleViewer.includes("Login sealed to an old key"), "the warning is status: a viewer sees it");
  assert.doesNotMatch(staleViewer, /<form|<button/);
});

test("F4-12 the card's readings and tones: fresh ok, stale late, never off; terminal ok or fault; login ok, old key late, cleared or none off; no green, no account, no price; times UTC · GMT+7", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const fresh = await feedOfBody(FRESH, "oanda"), stale = await feedOfBody(STALE, "oanda"), backup = await feedOfBody(STALE, "backup");
  assert.deepEqual(u.syncOf(fresh), { tone: "ok", label: "fresh", text: "synced 12s ago" });
  assert.deepEqual(u.syncOf(stale), { tone: "late", label: "stale", text: "last sync 6 min ago" });
  assert.deepEqual(u.syncOf({ ...fresh, synced_age_ms: null, fresh: false }), { tone: "off", label: "never synced", text: "never synced" });
  assert.deepEqual([u.terminalOf(fresh).tone, u.terminalOf(backup).tone], ["ok", "fault"]);
  assert.deepEqual(u.loginOf(fresh), { tone: "ok", label: "stored", text: "stored · v1" });
  assert.deepEqual(u.loginOf(stale), { tone: "late", label: "old key", text: "stored to an old key · v1" });
  assert.deepEqual(u.loginOf(backup), { tone: "off", label: "disconnected", text: "disconnected · v1" });
  assert.deepEqual(u.loginOf({ ...fresh, connection: { version: 0, status: "none", server: null, sealed_to_current_key: false, updated_ms: null } }), { tone: "off", label: "not set", text: "not set" });
  assert.deepEqual([u.oldKey(fresh), u.oldKey(stale), u.oldKey(backup)], [false, true, false], "the warning only for a stored login on an old key");
  assert.equal(u.loginWhen(fresh), "Fri 27 Nov 04:59 UTC · 11:59 GMT+7");
  const html = await view(STALE);
  assert.ok(html.includes("Login sealed to an old key") && html.includes("border-late-fill/35"));
  assert.equal((html.match(/Data feed \(no trading\)/g) ?? []).length, 2, "each feed is labelled a data feed, not a trading account");
  const code = src("pages/Feeds.tsx") + src("lib/feeds.ts");
  assert.doesNotMatch(code, /\b(text|bg|border)-(bull|bear|green|emerald)\b|emerald|rose-|\bstyle=|dangerouslySetInnerHTML/);
  assert.doesNotMatch(code, /balance|equity|\bbid\b|\bask\b|positions/i, "no account data and no price exists for a feed");
  assert.doesNotMatch(html, /\d{3,}\.\d{2}\b/, "no price on the page");
});
