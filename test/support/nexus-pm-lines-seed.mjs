// C5 UI: the answers the Omega page's Position Manager lines panel reads and gets, from the real code. GET
// /api/omega/position-manager is the AI Worker's readPositionManager (src/position-manager.mjs) over B5's breaker state
// (src/pm-line-breaker.mjs), wrapped as the route sends it (src/index.ts: { status: "ok", ...body }); the state is made by
// the real pmLineBreakerTick over seeded closes (position_actions with lines_json, their intents and ea_deals, and the
// broker's 1m bars that settle each close's hold), and the owner's turn-on by the real setPmLine. POST
// /omega/api/pm-lines is the Omega Worker's own route (workers/xauusd-omega/src/omega.mjs handle) with an Access JWT per
// caller, in front of setPmLine as OmegaGateway.setPmLine calls it (src/index.ts).
// test/fixtures/nexus-pm-lines/*.json are this seed's answers:
//   lines-on.json        every line on: seven lines with closes (one under 15 closes with a negative mean, still on), the
//                        other ten without any (nulls);
//   lines-off.json       the same closes with pm_fast_cut's last 15 below 0R: its breaker tripped at TRIP (off_since);
//   lines-hand-off.json  lines-off's state read with PM_LINES_OFF "tp2_target pm_fast_cut": tp2_target off by hand only
//                        (off_since null), pm_fast_cut off by both;
//   lines-new.json       no breaker state yet: all 17 lines on, no closes, nulls;
//   lines-after-on.json  lines-off's state after the owner turned pm_fast_cut back on: on, a fresh window (no closes);
//   lines-error.json     the read failed (D1 down): { status, version, error, rows: [] }, no lines;
//   post-replies.json    { case: { status, body } }: the turn-on and each code the route and setPmLine answer.
// test/nexus-pm-lines.test.mjs checks each file against this seed, byte for byte. Regenerate them after a contract change:
// node test/support/nexus-pm-lines-seed.mjs --write
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PM_LINE_BREAKER_KEY, clearPmLineMemo, lineTag, pmLineBreakerTick, setPmLine } from "../../src/pm-line-breaker.mjs";
import { readPositionManager } from "../../src/position-manager.mjs";
import { ensurePositionSchema, resetPositionSchemaCacheForTests } from "../../src/position-actions.mjs";
import { corpusSource } from "../../src/corpus-oracle.mjs";
import { handle as omegaHandle, resetKeyCacheForTests } from "../../workers/xauusd-omega/src/omega.mjs";
import { d1, kv } from "../fixtures/mode-shadow.mjs";

/** The read's clock: 2026-11-25 09:00 UTC, 16:00 GMT+7. */
export const NOW = Date.parse("2026-11-25T09:00:00Z");
/** pm_fast_cut's breaker trips at this tick: Mon 23 Nov 16:35 UTC, 23:35 GMT+7 (the mockup's off since). */
export const TRIP = Date.parse("2026-11-23T16:35:00Z");
/** The owner turns pm_fast_cut back on at this time. */
export const TURN_ON = NOW + 60_000;
export const OWNER = "owner-sub-c5-fixture";
export const ORIGIN = "https://nexus.cryptophys.work";
const M1 = 60_000, HOUR = 3_600_000;

/**
 * The closes per line: n closes, the mean R of the last 15 (`mean`, of all when fewer) and of R against holding to the
 * plan (`vs`). R moves by +a, -a, 0 around the mean, so every run of 15 averages exactly `mean` (no line on its way there
 * trips by accident). `trip` lines get the off mean in the off worlds.
 */
const LINES = [
  { id: "take_profit_weakening", n: 23, mean: 0.31, vs: 0.12, a: 0.2 },
  { id: "cut_loss", n: 12, mean: -0.38, vs: 0.21, a: 0.15 },
  { id: "breakeven", n: 41, mean: 0.08, vs: 0.03, a: 0.05 },
  { id: "lock_tp1", n: 17, mean: 1.12, vs: -0.06, a: 0.3 },
  { id: "tp2_breakeven", n: 12, mean: 0.64, vs: 0.09, a: 0.2 },
  { id: "pm_fast_tp", n: 19, mean: 0.47, vs: 0.05, a: 0.2 },
  { id: "pm_fast_cut", n: 16, mean: 0.06, offMean: -0.29, vs: 0.07, offVs: -0.11, a: 0.1 }
];
const r2 = (x) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ the AI Worker's tables and the seeded closes
const ACCOUNT = "acct_0c5f00d1e2a3b4c5", SERVER = "Demo-Server", SYMBOL = "XAUUSD";

function aiEnv(extra = {}) {
  resetPositionSchemaCacheForTests();
  clearPmLineMemo();
  const db = d1();
  db.raw.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER)");
  db.raw.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER, position_ticket INTEGER, side TEXT, volume REAL, entry_price REAL, exit_price REAL, profit REAL, commission REAL DEFAULT 0, swap REAL DEFAULT 0, currency TEXT, reason TEXT, closed_ms INTEGER)");
  db.raw.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT)");
  db.raw.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  db.raw.exec("CREATE TABLE ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, PRIMARY KEY (day, source, model))");
  db.raw.exec("CREATE TABLE broker_bars_1m (account_ref TEXT NOT NULL, source TEXT NOT NULL, minute_ms INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, tick_volume INTEGER, spread_points INTEGER, digits INTEGER, connection_version INTEGER, received_ms INTEGER NOT NULL, legacy_ref INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_ref, source, minute_ms))");
  // The bridge's state: the account and symbol the holds read their bars by; no position open.
  db.raw.prepare("INSERT INTO omega_bridge (id, state) VALUES (1, ?)").run(JSON.stringify({ account_ref: ACCOUNT, server: SERVER, symbol: { name: SYMBOL, digits: 2, point: 0.01 }, positions: [] }));
  return { DB: db, SIGNAL_CACHE: kv(), POSITION_MANAGER_MODE: "live", ...extra };
}

/**
 * One closed BUY position the line closed: its open (entry 2000, stop 1990, target 2020, 0.01 lot: 1R = 10 USD), the
 * line's applied close with its lines_json, the done close intent, the exit deal (net R x 10 USD) a minute later, and two
 * broker 1m bars that touch neither stop nor target: one at the action and the last minute the hold reads (its 24 hours),
 * which closes at the hold's R (holdR marks an untouched hold at its window's last close once the 24 hours have passed).
 */
function closed(env, { ticket, line, r, rHold, at }) {
  const raw = env.DB.raw, bar = Math.floor(at / 300_000);
  raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, 'open', ?, 'done', ?, ?)").run(`open:${ticket}:B`, JSON.stringify({ side: "BUY", volume: 0.01, entry: 2000, sl: 1990, tp: 2020, r_dist: 10 }), JSON.stringify({ ok: true, ticket }), at - 600_000);
  raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, why, status, lines_json) VALUES (?, ?, ?, ?, 'BUY', 'close', ?, 'seeded', 'applied', ?)").run(`pm:${ticket}:${bar}`, ticket, bar, at, line, JSON.stringify({ present: [], cause: lineTag(line) }));
  raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, 'close', ?, 'done', ?, ?)").run(`pm:${ticket}:c:${bar}`, JSON.stringify({ ticket, reason: `pm_${line}` }), JSON.stringify({ ok: true }), at + 1000);
  raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, side, volume, entry_price, exit_price, profit, currency, reason, closed_ms) VALUES (?, ?, 'BUY', 0.01, 2000, ?, ?, 'USD', 'expert', ?)").run(ticket * 10, ticket, r2(2000 + r * 10), r2(r * 10), at + M1);
  const c = r2(2000 + rHold * 10), minute = Math.floor(at / M1) * M1;
  const bar1m = raw.prepare("INSERT INTO broker_bars_1m (account_ref, source, minute_ms, o, h, l, c, tick_volume, spread_points, digits, received_ms) VALUES (?, ?, ?, 2000, ?, ?, ?, 100, 20, 2, ?)");
  for (const t of [minute, minute + 24 * HOUR - M1]) bar1m.run(ACCOUNT, corpusSource(SERVER, SYMBOL), t, r2(Math.max(c, 2000) + 0.5), r2(Math.min(c, 2000) - 0.5), c, t + M1);
}

/**
 * Every line's closes, interleaved 127 minutes apart from 2026-11-09 08:00 UTC (all settled before TRIP): 24 hours is no
 * multiple of the step, so no other close's bar is the last of a hold's window.
 */
async function seedCloses(env, { off }) {
  await ensurePositionSchema(env.DB);
  const rows = [];
  for (const l of LINES) {
    const mean = off && l.offMean != null ? l.offMean : l.mean, vs = off && l.offVs != null ? l.offVs : l.vs;
    for (let i = 0; i < l.n; i++) {
      const r = r2(mean + [l.a, -l.a, 0][i % 3]);
      rows.push({ line: l.id, i, r, rHold: r2(r - vs) });
    }
  }
  // Interleaved by index so each line's closes spread over the whole span.
  rows.sort((x, y) => x.i - y.i || LINES.findIndex((l) => l.id === x.line) - LINES.findIndex((l) => l.id === y.line));
  const start = Date.parse("2026-11-09T08:00:00Z");
  const step = 127 * M1;
  rows.forEach((row, k) => closed(env, { ticket: 5000 + k, line: row.line, r: row.r, rHold: row.rHold, at: start + k * step }));
  if (start + rows.length * step + 24 * HOUR > TRIP) throw new Error("the seeded closes must settle before TRIP");
}

/** The breaker's ticks: at TRIP until every close is counted (40 tickets a run), then once at NOW. */
async function ticks(env) {
  for (let i = 0; i < 10; i++) {
    const r = await pmLineBreakerTick(env, { now: TRIP });
    if (r.status === "failed") throw new Error(`tick: ${JSON.stringify(r)}`);
    if (!r.counted?.length) break;
  }
  const last = await pmLineBreakerTick(env, { now: NOW });
  if (last.status === "failed") throw new Error(`tick: ${JSON.stringify(last)}`);
}

/**
 * GET /api/omega/position-manager?limit=1 (the panel's read: it shows the lines, not the actions) as the route sends it
 * (src/index.ts; JSON: an undefined key is dropped).
 */
async function read(env, now = NOW) {
  clearPmLineMemo();
  return JSON.parse(JSON.stringify({ status: "ok", ...(await readPositionManager(env, { now, limit: 1 })) }));
}

// ------------------------------------------------------------------ the Access JWT (as test/support/nexus-h3f-seed.mjs)
const TEAM = "cryptophys.cloudflareaccess.com", AUD = "d".repeat(64), NOW_S = Math.floor(TURN_ON / 1000);
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
    viewer: await jwt({ email: "viewer@example.com", sub: "viewer-sub-c5" }),
    service: await jwt({ common_name: "ci.access" })
  };
}

/** OmegaGateway.setPmLine as src/index.ts binds it (the send is the Omega Telegram path; none in the seed). */
const gateway = (env) => ({ overview: async () => ({}), setPmLine: (input) => setPmLine(env, { line: input?.line, enabled: input?.enabled, actor: String(input?.actor ?? "owner"), send: null }, { now: TURN_ON }) });

/** One request through the Omega Worker's handler: { status, body }. */
function caller(a) {
  return async (env, token, { method = "POST", body = { line: "pm_fast_cut", enabled: true }, raw = null, headers = {} } = {}) => {
    const req = new Request(`${ORIGIN}/omega/api/pm-lines`, {
      method, body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
      headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }
    });
    const r = await omegaHandle(req, env, a.opts);
    return { status: r.status, body: await r.json() };
  };
}

/** The seeded answers (see the header). Deterministic: a fresh D1, store, memo and key cache on every call. */
export async function seedPmLines() {
  resetKeyCacheForTests();
  const a = await access(), call = caller(a);
  const omega = (ai) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_ACCESS_SUB: OWNER, OMEGA: gateway(ai) });

  // Every line on.
  const onEnv = aiEnv();
  await seedCloses(onEnv, { off: false });
  await ticks(onEnv);
  const on = await read(onEnv);

  // pm_fast_cut's breaker trips at TRIP.
  const offEnv = aiEnv();
  await seedCloses(offEnv, { off: true });
  await ticks(offEnv);
  const off = await read(offEnv);

  // The same state with PM_LINES_OFF naming tp2_target and pm_fast_cut (the hand switch; a tick records it).
  const hand = { ...offEnv, PM_LINES_OFF: "tp2_target pm_fast_cut" };
  await pmLineBreakerTick(hand, { now: NOW });
  const handOff = await read(hand);
  const replies = {};
  // setPmLine refuses a line PM_LINES_OFF names (the button's answer for pm_fast_cut on this state).
  replies.off_by_PM_LINES_OFF = await call(omega(hand), a.owner);
  // PM_LINES_OFF is cleared again (the next tick records it), then the owner turns pm_fast_cut back on.
  await pmLineBreakerTick(offEnv, { now: NOW });
  replies.ok = await call(omega(offEnv), a.owner);
  if (replies.ok.status !== 200) throw new Error(`turn on: ${JSON.stringify(replies.ok)}`);
  const afterOn = await read(offEnv, TURN_ON);
  // Each refusal: the route's checks (personJson, the owner, the body), the AI Worker's, and the binding's.
  replies.unknown_line = await call(omega(offEnv), a.owner, { body: { line: "not_a_line", enabled: true } });
  replies.enabled_not_true = await call(omega(offEnv), a.owner, { body: { line: "pm_fast_cut", enabled: false } });
  replies.unavailable = await call(omega({}), a.owner);
  replies.owner_only = await call(omega(offEnv), a.viewer);
  replies.forbidden = await call(omega(offEnv), a.service);
  replies.access_denied = await call(omega(offEnv), null);
  replies.cross_origin_refused = await call(omega(offEnv), a.owner, { headers: { origin: "https://evil.example" } });
  replies.same_origin_only = await call(omega(offEnv), a.owner, { headers: { "sec-fetch-site": "cross-site" } });
  replies.content_type_must_be_json = await call(omega(offEnv), a.owner, { headers: { "content-type": "text/plain" } });
  replies.body_too_large = await call(omega(offEnv), a.owner, { body: { line: "pm_fast_cut", enabled: true, pad: "x".repeat(300) } });
  replies.invalid_json = await call(omega(offEnv), a.owner, { raw: "{not json" });
  replies.not_an_object = await call(omega(offEnv), a.owner, { raw: "[]" });
  replies.pm_lines_unavailable = await call({ ...omega(offEnv), OMEGA: { overview: async () => ({}) } }, a.owner);
  replies.pm_lines_failed = await call({ ...omega(offEnv), OMEGA: { overview: async () => ({}), setPmLine: async () => { throw new Error("rpc down"); } } }, a.owner);
  replies.omega_binding_missing = await call({ ...omega(offEnv), OMEGA: null }, a.owner);
  replies.method_not_allowed = await call(omega(offEnv), a.owner, { method: "GET" });

  // No breaker state yet, and a failed read.
  const fresh = await read(aiEnv());
  const broken = aiEnv({ DB: { prepare() { throw new Error("D1_ERROR: the database is unavailable"); } } });
  const error = await read(broken);
  if (await broken.SIGNAL_CACHE.get(PM_LINE_BREAKER_KEY)) throw new Error("a read never writes the breaker state");
  return { on, off, handOff, fresh, afterOn, error, replies: JSON.parse(JSON.stringify(replies)) };
}

// CLI: `node test/support/nexus-pm-lines-seed.mjs --write` rewrites the fixtures from the seed (after a contract change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedPmLines();
  const dir = new URL("../fixtures/nexus-pm-lines/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const files = { "lines-on.json": out.on, "lines-off.json": out.off, "lines-hand-off.json": out.handOff, "lines-new.json": out.fresh, "lines-after-on.json": out.afterOn, "lines-error.json": out.error, "post-replies.json": out.replies };
  for (const [name, body] of Object.entries(files)) await writeFile(new URL(name, dir), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote ${Object.keys(files).length} fixtures to test/fixtures/nexus-pm-lines/`);
}
