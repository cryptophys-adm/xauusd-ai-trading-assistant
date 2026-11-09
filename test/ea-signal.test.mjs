import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eaSignalFrom, heartbeatFrom, storeHeartbeat, eaStatus, EA_HEARTBEAT_KEY } from "../src/ea-signal.mjs";

const OPEN = Date.parse("2026-11-09T06:00:00Z");
const KEY = "OANDA:XAUUSD:60:" + OPEN;
const BUY = { decision: { decision: "BUY", confidence: 0.62, entry_price: 4107.13, stop_loss: 4094.09, take_profit: 4135.78, risk_reward: 2.2, position_size_pct: null, trade_plan: { action: "ENTER_MARKET" } } };

test("the EA signal: one flat object; BUY or SELL with valid levels, else side NONE; never a size", () => {
  const s = eaSignalFrom({ candleKey: KEY, analysis: BUY, marketPrice: 4108.5, marketMs: OPEN + 3600_000, now: OPEN + 3_700_000 });
  assert.equal(s.side, "BUY");
  assert.equal(s.action, "ENTER_MARKET");
  assert.deepEqual([s.entry, s.stop, s.tp1], [4107.13, 4094.09, 4135.78]);
  assert.equal(s.issued_ms, OPEN + 3600_000, "the decided bar's close");
  assert.equal(s.expires_ms, OPEN + 2 * 3600_000, "the next H1 decision replaces it");
  assert.equal(s.signal_id, KEY);
  assert.equal(s.market_price, 4108.5);
  assert.ok(Object.values(s).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v)), "flat: no nested object for the EA's reader");
  assert.ok(!Object.keys(s).some((k) => /size|lot|volume/i.test(k)), "the server never sizes a position");
  assert.equal(eaSignalFrom({ candleKey: KEY, analysis: { decision: { decision: "WAIT" } } }).side, "NONE");
  assert.equal(eaSignalFrom({ candleKey: KEY, analysis: { decision: { ...BUY.decision, stop_loss: 4110 } } }).side, "NONE", "a stop on the wrong side is never sent");
  assert.equal(eaSignalFrom({ candleKey: KEY, analysis: { decision: { ...BUY.decision, decision: "SELL" } } }).side, "NONE", "SELL levels must be inverted");
  assert.equal(eaSignalFrom({ candleKey: KEY, analysis: BUY, kill: true }).kill, true);
  assert.equal(eaSignalFrom({ candleKey: KEY, analysis: { decision: { ...BUY.decision, trade_plan: { action: "ENTER_LIMIT" } } } }).action, "ENTER_LIMIT");
});

test("the MQL5 EA reads only fields the server sends, and keeps its safety inputs", () => {
  const src = readFileSync(new URL("../ea/mt5/CryptophysXAUUSD.mq5", import.meta.url), "utf8");
  const keys = [...src.matchAll(/Json(?:String|Number|Bool)\(json, "([a-z_]+)"\)/g)].map((m) => m[1]);
  const fields = Object.keys(eaSignalFrom({ candleKey: KEY, analysis: BUY }));
  assert.ok(keys.length >= 10);
  for (const k of new Set(keys)) assert.ok(fields.includes(k), `the EA reads "${k}", which the signal carries`);
  for (const input of ["RiskPercent", "MaxDailyLossPercent", "MaxSpreadPoints", "MaxSignalAgeMinutes", "AllowLiveAccount", "CfAccessClientId", "CfAccessClientSecret"]) assert.match(src, new RegExp(`input [a-z]+ +${input}`), input);
  assert.match(src, /input bool   AllowLiveAccount      = false;/, "a live account trades only after the owner opts in");
  assert.match(src, /CF-Access-Client-Id: /);
  assert.doesNotMatch(src, /ACCOUNT_LOGIN/, "the heartbeat never sends the account number");
});

test("the heartbeat keeps known fields only, no account number; the status shows signal and heartbeat", async () => {
  const hb = heartbeatFrom({ ea: "cryptophys-xauusd", version: "1.00", mode: "live", trading_allowed: true, positions: 1, last_signal_id: KEY, daily_loss_pct: 0.4, login: 123456, password: "x" }, { now: OPEN });
  assert.equal(hb.mode, "live");
  assert.equal(hb.positions, 1);
  assert.equal(hb.login, undefined);
  assert.equal(hb.password, undefined);
  assert.equal(heartbeatFrom({ mode: "weird" }).mode, "unknown");
  assert.equal(heartbeatFrom("nope"), null);
  const store = new Map();
  const env = {
    SIGNAL_CACHE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ candle_key: KEY, ai_analysis: JSON.stringify(BUY) }) }) }) },
    EA_SIGNALS_ENABLED: "false"
  };
  assert.deepEqual(await storeHeartbeat(env, { mode: "demo", positions: 0 }, { now: OPEN }), { ok: true });
  assert.ok(store.has(EA_HEARTBEAT_KEY));
  const status = await eaStatus(env, { now: OPEN + 3_700_000 });
  assert.equal(status.heartbeat.mode, "demo");
  assert.equal(status.signal.side, "BUY");
  assert.equal(status.signal.kill, true, "EA_SIGNALS_ENABLED false is the server's kill switch");
});
