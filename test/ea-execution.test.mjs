import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dealFrom, storeDeal, listDeals, dealStats, setControl, controlEvents, omegaOverview, resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { eaSignal, heartbeatFrom, storeHeartbeat, readControl, EA_CONTROL_KEY, HEARTBEAT_FIELD_NAMES } from "../src/ea-signal.mjs";

/** Minimal D1 adapter over node:sqlite; ai_syntheses holds one BUY decision for the signal. */
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY, candle_key TEXT, ai_analysis TEXT)");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
function kv() {
  const m = new Map();
  return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}
const OPEN = Date.parse("2026-11-09T06:00:00Z");
const KEY = "OANDA:XAUUSD:60:" + OPEN;
const BUY = { decision: { decision: "BUY", confidence: 0.62, entry_price: 4107.13, stop_loss: 4094.09, take_profit: 4135.78, risk_reward: 2.2, trade_plan: { action: "ENTER_MARKET" } } };
function env() {
  resetEaExecutionSchemaForTests();
  const DB = d1();
  DB.raw.prepare("INSERT INTO ai_syntheses (candle_key, ai_analysis) VALUES (?, ?)").run(KEY, JSON.stringify(BUY));
  return { DB, SIGNAL_CACHE: kv() };
}
const DEAL = { deal_ticket: 7001, position_ticket: 5001, mode: "demo", side: "BUY", volume: 0.05, entry_price: 4107.2, exit_price: 4135.5, profit: 141.5, commission: -0.7, swap: 0, reason: "tp", signal_id: KEY, opened_ms: OPEN + 3_600_000, closed_ms: OPEN + 5 * 3_600_000, currency: "USD", login: 123456 };

test("a deal keeps known fields only, never the account; a bad body is refused", () => {
  const { deal } = dealFrom(DEAL);
  assert.equal(deal.side, "BUY");
  assert.equal(deal.reason, "tp");
  assert.equal(deal.login, undefined, "no account number");
  assert.equal(dealFrom({ ...DEAL, reason: "weird" }).deal.reason, "other");
  assert.match(dealFrom({ ...DEAL, side: "LONG" }).error, /side/);
  assert.match(dealFrom({ ...DEAL, deal_ticket: 1.5 }).error, /deal_ticket/);
  assert.match(dealFrom({ ...DEAL, volume: 0 }).error, /volume/);
  assert.match(dealFrom([]).error, /object/);
});

test("a deal is stored once; the list is newest first; the statistics use the net result", async () => {
  const e = env();
  assert.deepEqual(await storeDeal(e, DEAL), { ok: true, stored: true });
  assert.deepEqual(await storeDeal(e, DEAL), { ok: true, stored: false }, "a repeated report changes nothing");
  await storeDeal(e, { ...DEAL, deal_ticket: 7002, side: "SELL", profit: -60, commission: -0.7, reason: "sl", closed_ms: DEAL.closed_ms + 3_600_000 });
  const deals = await listDeals(e);
  assert.deepEqual(deals.map((d) => d.deal_ticket), [7002, 7001]);
  const s = dealStats(deals);
  assert.equal(s.trades, 2);
  assert.equal(s.win_rate, 0.5);
  assert.equal(s.net, 80.1);
  assert.equal(s.profit_factor, 2.32, "140.8 / 60.7");
  assert.equal(s.max_drawdown, 60.7);
  assert.deepEqual(dealStats([]), { trades: 0, wins: 0, losses: 0, win_rate: null, net: 0, profit_factor: null, average_win: null, average_loss: null, max_drawdown: 0 });
});

test("Omega's control: pause stops entries, kill closes, each change is audited with its actor", async () => {
  const e = env();
  const now = OPEN + 3_700_000;
  assert.equal((await readControl(e)).mode, "active");
  assert.match((await setControl(e, { mode: "paused", actor: "owner@example.com" })).error, /reason/, "a pause needs a reason");
  assert.match((await setControl(e, { mode: "paused", reason: "news" })).error, /actor/);
  assert.match((await setControl(e, { mode: "off", reason: "x", actor: "a" })).error, /mode/);

  const paused = await setControl(e, { mode: "paused", reason: "CPI", actor: "owner@example.com" }, { now });
  assert.equal(paused.ok, true);
  let s = await eaSignal(e, { now });
  assert.equal(s.paused, true);
  assert.equal(s.kill, false);
  assert.equal(s.side, "BUY", "the signal stays visible; the EA only skips new entries");

  await setControl(e, { mode: "killed", reason: "drawdown", actor: "owner@example.com" }, { now: now + 1000 });
  s = await eaSignal(e, { now });
  assert.equal(s.kill, true);
  assert.equal(s.kill_source, "omega");
  assert.equal(s.paused, false, "kill wins over pause");

  await setControl(e, { mode: "active", actor: "owner@example.com" }, { now: now + 2000 });
  s = await eaSignal({ ...e, EA_SIGNALS_ENABLED: "false" }, { now });
  assert.equal(s.kill_source, "env", "the server's kill switch stays above Omega");

  const events = await controlEvents(e);
  assert.deepEqual(events.map((x) => [x.previous_mode, x.mode]), [["killed", "active"], ["paused", "killed"], ["active", "paused"]]);
  assert.equal(events[2].actor, "owner@example.com");
  assert.ok(e.SIGNAL_CACHE.map.has(EA_CONTROL_KEY));
});

test("the heartbeat keeps each open position's known fields; the overview has everything Omega shows", async () => {
  const hb = heartbeatFrom({ mode: "demo", positions: 1, floating_pnl: 12.5, currency: "USD", account: 99, positions_detail: [{ ticket: 5001, side: "buy", volume: 0.05, entry: 4107.2, sl: 4094.1, tp: 4135.8, profit: 12.5, opened_ms: OPEN, login: 1 }, { ticket: "x", side: "BUY" }, "junk"] });
  assert.equal(hb.positions_detail.length, 1);
  assert.equal(hb.positions_detail[0].side, "BUY");
  assert.equal(hb.positions_detail[0].login, undefined);
  assert.equal(hb.account, undefined);
  assert.equal(heartbeatFrom({ positions_detail: Array.from({ length: 40 }, (_, i) => ({ ticket: i, side: "SELL" })) }).positions_detail.length, 20);

  const e = env();
  const now = OPEN + 3_700_000;
  await storeHeartbeat(e, { mode: "demo", positions: 1, positions_detail: [{ ticket: 5001, side: "BUY", volume: 0.05 }] }, { now: now - 60_000 });
  await storeDeal(e, { ...DEAL, closed_ms: now - 1000 });
  const o = await omegaOverview(e, { now });
  assert.equal(o.ea.connected, true);
  assert.equal(o.heartbeat.positions_detail[0].ticket, 5001);
  assert.equal(o.signal.side, "BUY");
  assert.equal(o.control.mode, "active");
  assert.equal(o.deals.length, 1);
  assert.equal(o.stats.today.trades, 1);
  assert.equal(o.stats.month.net, 140.8);
  assert.equal((await omegaOverview(e, { now: now + 3_600_000 })).ea.connected, false, "a heartbeat older than 15 minutes is stale");
});

test("the MQL5 EA honours pause, and reports only fields the server keeps", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ea/mt5/CryptophysXAUUSD.mq5", import.meta.url), "utf8");
  assert.match(src, /JsonBool\(json, "paused"\)/, "the EA reads the pause");
  assert.match(src, /input string DealUrl/);
  const keysOf = (fn) => {
    const body = src.slice(src.indexOf(fn), src.indexOf("\n  }\n", src.indexOf(fn)));
    return [...body.matchAll(/\\"([a-z_]+)\\":/g)].map((m) => m[1]);
  };
  const dealKeys = keysOf("void QueueDeal");
  assert.ok(dealKeys.length >= 15);
  const { deal } = dealFrom(Object.fromEntries(dealKeys.map((k) => [k, k === "side" ? "BUY" : k === "deal_ticket" ? 1 : k === "volume" ? 0.1 : k === "profit" ? 1 : "x"])));
  for (const k of dealKeys) assert.ok(k in deal, `the server keeps the deal field "${k}"`);
  const hbKeys = keysOf("void Heartbeat");
  assert.ok(hbKeys.length >= 14);
  for (const k of hbKeys) assert.ok(HEARTBEAT_FIELD_NAMES.includes(k), `the server keeps the heartbeat field "${k}"`);
  const posKeys = keysOf("string PositionsJson");
  const kept = heartbeatFrom({ positions_detail: [Object.fromEntries(posKeys.map((k) => [k, k === "side" ? "BUY" : k === "signal_id" ? "s" : 1]))] }).positions_detail[0];
  for (const k of posKeys) assert.ok(k in kept, `the server keeps the position field "${k}"`);
});
