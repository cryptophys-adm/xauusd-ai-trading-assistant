// OS1 UI: the answers behind the three new status lines (the Omega page's server check and recovery hold, the Data feeds
// card's bar age), from the real code. Each scenario runs the Omega Worker's routes (workers/xauusd-omega/src/omega.mjs
// handle: POST /omega/api/bridge/sync, POST /omega/api/connection, POST /omega/api/bridge/feed-sync, GET
// /omega/api/overview) in front of a freshly bundled AI Worker's OmegaGateway (src/index.ts; bridgeSync and the watchdog's
// recovery hold, src/recovery-hold.mjs #647; setConnection's near-match warning and the overview's server_check,
// src/server-check.mjs #650; feedSync and feedOverview's content_stale and last_bar_age_ms, src/feed-stale.mjs #649) over a
// migrated D1, with the F4 seed's Access JWTs, keys and envelope code (test/support/nexus-f4-seed.mjs). Every login and
// password is a placeholder; the server names are invented ("Placeholder-Live 2" is the broker's name the terminal once
// reported, so it is the near-match hint's known name).
// test/fixtures/nexus-os1/*.json are this seed's answers, each overview cut to the fields the new lines read (`pick`):
//   overview-pending.json          connection stored 2 min ago, the terminal not logged in yet: server_check pending;
//   overview-ok.json               logged in on the exact stored name: ok;
//   overview-disconnected.json     logged in on the exact name, then disconnected: "disconnected" (never not_seen), and
//                                  after 3 restarts the recovery hold WITHOUT a cause;
//   overview-not-seen.json         "Placeholder-Live-2" typed (the broker's is "Placeholder-Live 2"): not_seen with
//                                  did_you_mean, and the hold WITH cause server_not_seen;
//   overview-not-seen-viewer.json  the same read by the CI service token (viewer.can_control false);
//   overview-not-seen-space.json   "Placeholder-Live2" typed (differs by one space only): not_seen with did_you_mean, the
//                                  last recovery a dispatch (no hold yet);
//   overview-not-seen-plain.json   "Other-Server" typed: not_seen, no near match, no hint;
//   overview-feeds.json            three feed bridges: "oanda" syncing with bars that stopped 21 min ago (content_stale),
//                                  "backup" syncing without a bar ever (last_bar_age_ms null), "live" with a bar two minutes old;
//   overview-feeds-viewer.json     the same read by the CI service token;
//   replies.json                   POST /omega/api/connection: saved (no warning), near_match (hyphen) and near_match_space.
// test/nexus-os1-status.test.mjs checks each file against this seed, byte for byte. Regenerate them after a contract
// change: node test/support/nexus-os1-seed.mjs --write
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildEnvelope } from "../../workers/xauusd-omega/public/omega-crypto.js";
import { resetKeyCacheForTests } from "../../workers/xauusd-omega/src/omega.mjs";
import { access, caller, ctx, deterministic, kidOf, KEYS, loadWorkerModule, migratedD1, OWNER_SUB } from "./nexus-f4-seed.mjs";
import { kv } from "../fixtures/mode-shadow.mjs";

/** The fixture's clock: 05:00 UTC, 12:00 GMT+7 on Friday 27 November 2026 (gold open). */
export const NOW = Date.parse("2026-11-27T05:00:00Z");
const M = 60_000;
/** The broker's server name as the terminal once reported it (an account seen on it). */
export const KNOWN_SERVER = "Placeholder-Live 2";
/** The typed names: a hyphen for the space, the space left out, and a name with no near match. */
export const TYPED = Object.freeze({ hyphen: "Placeholder-Live-2", space: "Placeholder-Live2", plain: "Other-Server" });
const CREDS = Object.freeze({ login: "demo-login", password: "placeholder-pw" });

/** The fields of the overview the new lines read; the rest of the body is the F4 fixtures' (test/fixtures/nexus-f4). */
export function pick(ov) {
  const b = ov?.broker ?? {};
  return {
    broker: {
      connection: b.connection ?? null,
      bridge: { terminal_connected: b.bridge?.terminal_connected ?? null, server: b.bridge?.server ?? null },
      autonomous_watchdog: b.autonomous_watchdog ?? null,
      server_check: b.server_check ?? null,
      feeds: b.feeds ?? []
    },
    viewer: ov?.viewer ?? null
  };
}

/** The executor bridge's sync body: a demo terminal on `server`, connected or not (the terminal echoes the typed name). */
const executorState = (at, connected, server) => ({ connected, trade_allowed: true, server, received_ms: at - 1000, trade_mode: "demo",
  account: { trade_mode: "demo", currency: "USD", balance: 1000, equity: 1000 }, symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100 }, positions: [] });

/** One scenario on its own D1 and its own copy of the AI Worker (its schema memo is per module). */
async function scenario(a, run) {
  const mod = await loadWorkerModule();
  const call = caller(a);
  const kid = await kidOf(KEYS.executor);
  return deterministic(async (at) => {
    resetKeyCacheForTests();
    const db = await migratedD1();
    const gw = new mod.OmegaGateway(ctx, { DB: db, SIGNAL_CACHE: kv(), CORPUS_ORACLE_MODE: "shadow" });
    const env = { ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com", ACCESS_AUD: "c".repeat(64), OWNER_ACCESS_SUB: OWNER_SUB, OMEGA_BRIDGE_CLIENT_ID: "f4bridge.access", OMEGA_FEED_CLIENT_ID: "f4feed.access", OMEGA: gw };
    const must = (r, what) => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${JSON.stringify(r).slice(0, 400)}`); return r; };
    const sync = async (t, connected, server) => { at(t); return must(await call(env, a.bridge, { path: "/omega/api/bridge/sync", body: { public_key: KEYS.executor, kid, bridge_version: "1.8.0", results: [], state: executorState(t, connected, server) } }), "executor sync"); };
    const connect = async (t, server) => { at(t); return must(await call(env, a.owner, { path: "/omega/api/connection", body: { server, envelope: await buildEnvelope(KEYS.executor, kid, { server, ...CREDS }), trade_symbol: null, units_per_usd: null } }), "connection"); };
    const overview = async (token = a.owner) => { at(NOW); return pick(must(await call(env, token, { method: "GET", path: "/omega/api/overview" }), "overview").body); };
    // An hour before: the terminal is logged in on the broker's own name (the account is seen on it).
    await sync(NOW - 60 * M, true, KNOWN_SERVER);
    return run({ sync, connect, overview, call, env, at, must });
  });
}

/** Restarts every 3 minutes (the watchdog's cooldown) from `from`: the 4th disconnected sync is held. */
async function disconnectedSyncs(sync, from, n, server) {
  for (let i = 0; i < n; i++) await sync(from + i * 3 * M, false, server);
}

/** A feed's M1 bars from `fromMs` (n bars); the overview carries only their age, never a bar or a price. */
const bars = (fromMs, n) => Array.from({ length: n }, (_, i) => [fromMs + i * M, 3600 + i, 3601 + i, 3599 + i, 3600.5 + i, 10, 20]);

/** The seeded answers (see the header). Deterministic: a fresh D1 and AI Worker for every scenario. */
export async function seedOs1() {
  const a = await access();
  const replies = {};
  const out = {};

  out.pending = await scenario(a, async ({ sync, connect, overview }) => {
    replies.saved = await connect(NOW - 2 * M, KNOWN_SERVER);
    await sync(NOW - M, false, KNOWN_SERVER);
    return overview();
  });
  out.ok = await scenario(a, async ({ sync, connect, overview }) => {
    await connect(NOW - 10 * M, KNOWN_SERVER);
    await sync(NOW - 30_000, true, KNOWN_SERVER);
    return overview();
  });
  out.disconnected = await scenario(a, async ({ sync, connect, overview }) => {
    await connect(NOW - 20 * M, KNOWN_SERVER);
    await sync(NOW - 19 * M, true, KNOWN_SERVER);
    await disconnectedSyncs(sync, NOW - 18 * M, 5, KNOWN_SERVER);
    return overview();
  });
  const notSeen = await scenario(a, async ({ sync, connect, overview }) => {
    replies.near_match = await connect(NOW - 20 * M, TYPED.hyphen);
    await disconnectedSyncs(sync, NOW - 18 * M, 5, TYPED.hyphen);
    return { owner: await overview(), viewer: await overview(a.viewer) };
  });
  out.notSeen = notSeen.owner;
  out.notSeenViewer = notSeen.viewer;
  out.notSeenSpace = await scenario(a, async ({ sync, connect, overview }) => {
    replies.near_match_space = await connect(NOW - 14 * M, TYPED.space);
    await sync(NOW - 8 * M, false, TYPED.space);
    await sync(NOW - M, false, TYPED.space);
    return overview();
  });
  out.notSeenPlain = await scenario(a, async ({ sync, connect, overview }) => {
    await connect(NOW - 14 * M, TYPED.plain);
    await sync(NOW - M, false, TYPED.plain);
    return overview();
  });
  const feeds = await scenario(a, async ({ call, env, at, must, overview }) => {
    const fkid = await kidOf(KEYS.feed);
    // Each feed on its own broker server (a corpus source is per server and symbol).
    const SERVER = { backup: "BackupBroker-Demo", live: "LiveBroker-Demo", oanda: "FeedBroker-Demo" };
    const feedSync = async (t, id, corpus = null) => {
      at(t);
      return must(await call(env, a.feed, { path: "/omega/api/bridge/feed-sync", body: { bridge_id: id, public_key: KEYS.feed, kid: fkid, bridge_version: "1.8.2", state: { connected: true, server: SERVER[id], symbol: { name: "XAUUSD" } }, ...(corpus ? { corpus } : {}) } }), `feed sync ${id}`);
    };
    const corpus = (id, from, n) => ({ timeframe: "M1", server: SERVER[id], symbol: "XAUUSD", bars: bars(from, n) });
    for (const id of ["backup", "live", "oanda"]) await feedSync(NOW - 30 * M, id);
    for (const id of ["live", "oanda"]) {
      at(NOW - 29 * M);
      must(await call(env, a.owner, { path: "/omega/api/feed-connection", body: { bridge_id: id, server: SERVER[id], envelope: await buildEnvelope(KEYS.feed, fkid, { server: SERVER[id], ...CREDS }) } }), `feed login ${id}`);
    }
    // "oanda": bars until 21 minutes ago, then none while it keeps syncing; "live": a bar a minute old; "backup": no bar.
    await feedSync(NOW - 20 * M, "oanda", corpus("oanda", NOW - 25 * M, 5));
    await feedSync(NOW - 30_000, "oanda");
    await feedSync(NOW - 30_000, "live", corpus("live", NOW - 5 * M, 5));
    await feedSync(NOW - 20_000, "backup");
    return { owner: await overview(), viewer: await overview(a.viewer) };
  });
  out.feeds = feeds.owner;
  out.feedsViewer = feeds.viewer;
  return { ...out, replies };
}

export const FILES = Object.freeze({
  "overview-pending.json": "pending", "overview-ok.json": "ok", "overview-disconnected.json": "disconnected",
  "overview-not-seen.json": "notSeen", "overview-not-seen-viewer.json": "notSeenViewer", "overview-not-seen-space.json": "notSeenSpace",
  "overview-not-seen-plain.json": "notSeenPlain", "overview-feeds.json": "feeds", "overview-feeds-viewer.json": "feedsViewer", "replies.json": "replies"
});

// CLI: `node test/support/nexus-os1-seed.mjs --write` rewrites the fixtures from the seed (after a contract change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedOs1();
  const dir = new URL("../fixtures/nexus-os1/", import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const [name, key] of Object.entries(FILES)) await writeFile(new URL(name, dir), JSON.stringify(out[key], null, 2) + "\n");
  console.log(`wrote ${Object.keys(FILES).length} fixtures to test/fixtures/nexus-os1/`);
}
