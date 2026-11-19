// The bridge sync's D1 and KV cost (owner 2026-11-14: "B. penuh tanpa fase shadow"): the bridge row is written
// on a change that matters or every BRIDGE_WRITE_EVERY_MS, a reported deal is written once, and the kill switch
// is read once a sync (never cached). Counted on the sync as production runs it (eaSignal computed in it).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, bridgeStateKey, executorFrom, BRIDGE_WRITE_EVERY_MS, resetOmegaBrokerSchemaForTests, writeSettings } from "../src/omega-broker.mjs";
import { EA_CONTROL_KEY } from "../src/ea-signal.mjs";

function counted() {
  const db = new DatabaseSync(":memory:");
  const log = [];
  return {
    log,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { log.push(sql); const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { log.push(sql); return db.prepare(sql).get(...params) ?? null; },
        async all() { log.push(sql); return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
function kv() {
  const m = new Map(), gets = [];
  return { map: m, gets, get: async (k) => { gets.push(k); return m.get(k) ?? null; }, put: async (k, v) => { m.set(k, v); } };
}

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const T0 = Date.parse("2026-11-11T10:00:00Z");
const state = (over = {}) => ({
  connected: true, trade_allowed: true, server: "AnyBroker-Demo", received_ms: T0,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, bid: 4101, ask: 4101.2, spread_points: 20 },
  positions: [],
  deals: [{ deal_ticket: 9001, position_ticket: 8001, side: "BUY", volume: 0.01, entry_price: 4090, exit_price: 4100, profit: 10, opened_ms: T0 - 3_600_000, closed_ms: T0 - 600_000, source: "omega" }],
  ...over
});
const bridgeWrites = (log) => log.filter((s) => s.startsWith("UPDATE omega_bridge")).length;
const dealStatements = (log) => log.filter((s) => /ea_deals/.test(s) && !/CREATE/.test(s)).length;

test("prices and equity alone write the bridge row every 30 seconds; a change that matters writes it at once", async () => {
  resetOmegaBrokerSchemaForTests();
  const env = { DB: counted(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: false }, actor: "owner@example.com" }, { now: T0 });
  const sync = (now, over) => bridgeSync(env, { state: state({ received_ms: now, ...over }), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0" }, { now });
  await sync(T0);
  env.DB.log.length = 0; env.SIGNAL_CACHE.gets.length = 0;
  // Five syncs 5 seconds apart, the quote and equity moving each time.
  for (let i = 1; i <= 5; i++) await sync(T0 + i * 5_000, { symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, bid: 4101 + i, ask: 4101.2 + i }, account: { trade_mode: "demo", currency: "USD", equity: 10_000 + i } });
  assert.equal(bridgeWrites(env.DB.log), 0, "no write within 30 seconds for prices alone");
  assert.equal(dealStatements(env.DB.log), 0, "a stored deal is not written again");
  assert.equal(env.SIGNAL_CACHE.gets.filter((k) => k === EA_CONTROL_KEY).length, 5, "the kill switch is read once a sync");
  // 30 seconds after the last write: written.
  env.DB.log.length = 0;
  await sync(T0 + BRIDGE_WRITE_EVERY_MS);
  assert.equal(bridgeWrites(env.DB.log), 1);
  // A position opens: written at once, 5 seconds later.
  env.DB.log.length = 0;
  await sync(T0 + BRIDGE_WRITE_EVERY_MS + 5_000, { positions: [{ ticket: 77, side: "BUY", volume: 0.01, open_price: 4102, sl: 4095, tp: 4110 }] });
  assert.equal(bridgeWrites(env.DB.log), 1);
  // Its stop moves: written at once.
  env.DB.log.length = 0;
  await sync(T0 + BRIDGE_WRITE_EVERY_MS + 10_000, { positions: [{ ticket: 77, side: "BUY", volume: 0.01, open_price: 4102, sl: 4100, tp: 4110 }] });
  assert.equal(bridgeWrites(env.DB.log), 1);
  // The terminal disconnects: written at once.
  env.DB.log.length = 0;
  await sync(T0 + BRIDGE_WRITE_EVERY_MS + 15_000, { connected: false, positions: [{ ticket: 77, side: "BUY", volume: 0.01, open_price: 4102, sl: 4100, tp: 4110 }] });
  assert.equal(bridgeWrites(env.DB.log), 1);
});

test("bridgeStateKey ignores the quote, equity and times, and sees connection, positions, orders and deals", () => {
  const a = executorFrom(state());
  assert.equal(bridgeStateKey(a), bridgeStateKey(executorFrom(state({ received_ms: T0 + 5000, symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, bid: 4200, ask: 4200.3 }, account: { trade_mode: "demo", currency: "USD", equity: 9000 } }))));
  assert.notEqual(bridgeStateKey(a), bridgeStateKey(executorFrom(state({ trade_allowed: false }))));
  assert.notEqual(bridgeStateKey(a), bridgeStateKey(executorFrom(state({ orders: [{ ticket: 5, type: "buy_limit", volume_current: 0.01, price_open: 4090 }] }))));
  assert.notEqual(bridgeStateKey(a), bridgeStateKey(executorFrom(state({ deals: [] }))));
});

test("a KILL set between two syncs is read by the next sync", async () => {
  resetOmegaBrokerSchemaForTests();
  const env = { DB: counted(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  const sync = (now) => bridgeSync(env, { state: state({ received_ms: now }), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0" }, { now });
  await sync(T0);
  await env.SIGNAL_CACHE.put(EA_CONTROL_KEY, JSON.stringify({ mode: "killed", reason: "test", actor: "owner", at: new Date(T0 + 1000).toISOString() }));
  env.SIGNAL_CACHE.gets.length = 0;
  await sync(T0 + 5_000);
  assert.equal(env.SIGNAL_CACHE.gets.filter((k) => k === EA_CONTROL_KEY).length, 1);
});

test("realtime without writes: each sync's quote, account and positions go to the pushed overview, not to D1", async () => {
  const { liveBridgeFields } = await import("../src/omega-broker.mjs");
  const now = Date.parse("2026-11-16T10:00:05Z");
  const state = { connected: true, received_ms: now - 400, symbol: { name: "XAUUSD", bid: 4012.35, ask: 4012.55, spread_points: 20, atr_points: 210 }, account: { balance: 1000, equity: 1003.2, day_realized_pl: 1.5 }, positions: [{ ticket: 7, side: "BUY", volume: 0.01, profit: 3.2 }] };
  const live = liveBridgeFields(state, { now });
  assert.deepEqual([live.bid, live.ask, live.equity, live.positions.length, live.synced_age_ms, live.state_age_ms, live.live], [4012.35, 4012.55, 1003.2, 1, 0, 400, true]);
  assert.equal(liveBridgeFields({ connected: false }, { now }), null, "no quote, nothing to overlay");
  // The quote alone still writes nothing (the 30-second rule stands).
  assert.equal(bridgeStateKey(executorFrom(state)), bridgeStateKey(executorFrom({ ...state, symbol: { ...state.symbol, bid: 4013.1 }, account: { ...state.account, equity: 1004 } })));
});

test("the subscriber count is asked of the hub at most every 30 seconds per isolate", async () => {
  const { hubSubscribers, resetSubscribersCacheForTests, SUBSCRIBERS_TTL_MS } = await import("../src/push-hub.mjs");
  resetSubscribersCacheForTests();
  let asks = 0;
  const env = { PUSH_HUB: { getByName: () => ({ subscribers: async () => { asks += 1; return 2; } }) } };
  const t = Date.parse("2026-11-16T10:00:00Z");
  for (let i = 0; i < 6; i++) assert.equal(await hubSubscribers(env, "omega-overview", { now: t + i * 5_000 }), 2);
  assert.equal(asks, 1, "six syncs in 30 s, one billed ask");
  await hubSubscribers(env, "omega-overview", { now: t + SUBSCRIBERS_TTL_MS });
  assert.equal(asks, 2);
  assert.equal(await hubSubscribers({}, "omega-overview"), 0, "no binding: nobody listens");
});

test("UI audit DEF-10: the badge's light status reads one bridge row and the settings, never the deals or intents", async () => {
  const { brokerStatus } = await import("../src/omega-broker.mjs");
  resetOmegaBrokerSchemaForTests();
  const env = { DB: counted(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true }, actor: "owner@example.com" }, { now: T0 });
  await bridgeSync(env, { state: state({ positions: [{ ticket: 1, side: "BUY", volume: 0.01 }] }), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0" }, { now: T0 });
  env.DB.log.length = 0;
  const s = await brokerStatus(env, { now: T0 + 10_000 });
  assert.equal(s.armed, true);
  assert.equal(s.positions, 1);
  assert.ok(!env.DB.log.some((q) => /ea_deals|omega_intents|omega_events/.test(q)), env.DB.log.join("\n"));
  assert.equal((await brokerStatus(env, { now: T0 + 120_000 })).connected, false, "a state older than a minute is not connected");
});

test("the light sync (owner 2026-11-19, step 1): idle syncs reuse the last full plan for 5 s; any position, result or change plans in full", async () => {
  const { LIGHT_SYNC_MAX_AGE_MS } = await import("../src/omega-broker.mjs");
  resetOmegaBrokerSchemaForTests();
  const env = { DB: counted(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true }, actor: "owner@example.com" }, { now: T0 });
  const sync = (now, over = {}, extra = {}) => bridgeSync(env, { state: state({ received_ms: now, deals: [], ...over }), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0", ...extra }, { now });
  const full = (log) => log.some((s) => /FROM omega_settings/.test(s));
  await sync(T0);
  // Idle, the quote moving: four light syncs inside 5 s, each 3 statements (connection, bridge row, open intents).
  for (let i = 1; i <= 4; i++) {
    env.DB.log.length = 0;
    const r = await sync(T0 + i * 1_000, { symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, bid: 4101 + i, ask: 4101.2 + i, spread_points: 20 } });
    assert.equal(r.light, true, `sync ${i}`);
    assert.equal(full(env.DB.log), false);
    assert.equal(env.DB.log.length, 3, env.DB.log.join("\n"));
  }
  // 5 s after the full plan: planned in full again.
  env.DB.log.length = 0;
  assert.equal((await sync(T0 + LIGHT_SYNC_MAX_AGE_MS)).light, undefined);
  assert.ok(full(env.DB.log));
  // An open position: always the full plan (management is never slower).
  const pos = [{ ticket: 77, side: "BUY", volume: 0.01, open_price: 4102, sl: 4095, tp: 4110 }];
  await sync(T0 + 6_000, { positions: pos });
  env.DB.log.length = 0;
  assert.equal((await sync(T0 + 6_500, { positions: pos })).light, undefined);
  assert.ok(full(env.DB.log));
  // A result from the terminal: the full plan.
  await sync(T0 + 7_000);
  assert.equal((await sync(T0 + 7_500, {}, { results: [{ id: "x", ok: true }] })).light, undefined);
  // An intent queued by the owner between two light syncs is still delivered.
  await sync(T0 + 8_000);
  env.DB.log.length = 0;
  await env.DB.prepare("INSERT INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES ('manual:c:1', 'close_all', ?, 'pending', ?, ?)").bind(JSON.stringify({ id: "manual:c:1", kind: "close_all" }), T0 + 8_100, T0 + 8_100).run();
  const r = await sync(T0 + 8_500);
  assert.equal(r.light, true);
  assert.deepEqual(r.intents.map((i) => i.id), ["manual:c:1"]);
  assert.ok(env.DB.log.some((s) => /UPDATE omega_intents SET status = 'sent'/.test(s)), "marked sent");
  assert.equal(r.stream_mode, "fast", "an intent to deliver: fast");
});

test("stream mode (owner 2026-11-19, step 2; bridge 1.7.0): calm with nothing to manage, fast with a position, an order, an intent, a lost terminal or the switch off", async () => {
  const { bridgeStreamMode } = await import("../src/omega-broker.mjs");
  const ex = { connected: true, positions: [], orders: [] };
  assert.equal(bridgeStreamMode({}, { executor: ex }), "calm");
  assert.equal(bridgeStreamMode({}, { executor: { ...ex, positions: [{ ticket: 1 }] } }), "fast");
  assert.equal(bridgeStreamMode({}, { executor: { ...ex, orders: [{ ticket: 2 }] } }), "fast");
  assert.equal(bridgeStreamMode({}, { executor: ex, intents: [{ id: "open:1:BUY" }] }), "fast");
  assert.equal(bridgeStreamMode({}, { executor: { ...ex, connected: false } }), "fast");
  assert.equal(bridgeStreamMode({}, { executor: null }), "fast");
  assert.equal(bridgeStreamMode({}, { executor: ex, recovery: { directive: "restart_terminal" } }), "fast");
  assert.equal(bridgeStreamMode({}, { executor: ex, reviewStarted: true }), "fast");
  assert.equal(bridgeStreamMode({ OMEGA_BRIDGE_CALM: "off" }, { executor: ex }), "fast");

  resetOmegaBrokerSchemaForTests();
  const env = { DB: counted(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true }, actor: "owner@example.com" }, { now: T0 });
  const sync = (now, over = {}) => bridgeSync(env, { state: state({ received_ms: now, deals: [], ...over }), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now });
  assert.equal((await sync(T0)).stream_mode, "calm", "full plan, idle");
  const light = await sync(T0 + 1_000);
  assert.deepEqual([light.light, light.stream_mode], [true, "calm"], "light plan, idle");
  assert.equal((await sync(T0 + 2_000, { positions: [{ ticket: 77, side: "BUY", volume: 0.01, open_price: 4102, sl: 4095, tp: 4110 }] })).stream_mode, "fast");
});
