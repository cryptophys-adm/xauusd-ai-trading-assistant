// USD gold only (owner 2026-11-17, PR #405: "setuju", then "b"). One list in three places (the EA, the bridge,
// the server), exact names, the contract checked, fail closed, never silent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOLD_USD_SYMBOLS, GOLD_CONTRACT_SIZE_MIN, GOLD_CONTRACT_SIZE_MAX, goldSymbolCheck, goldSymbolText } from "../src/gold-symbol.mjs";
import { GOLD_SYMBOL_CANDIDATES, GOLD_CONTRACT_SIZE_MIN as BRIDGE_MIN, GOLD_CONTRACT_SIZE_MAX as BRIDGE_MAX } from "../bridge/omega-bridge/src/symbols.mjs";
import { executorFrom, bridgeSymbolFrom } from "../src/omega-broker.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { omegaSymbolIssue } from "../src/health-alerts.mjs";

const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");
const eaList = (() => {
  const m = ea.match(/string GOLD_USD_SYMBOLS\[\] = \{([\s\S]*?)\};/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
})();

const USD_GOLD = { name: "GOLD", currency_profit: "USD", currency_base: "XAU", contract_size: 100 };

test("G1. one list of exact USD gold names in the EA, the bridge and the server; the same contract range", () => {
  assert.deepEqual(eaList, [...GOLD_USD_SYMBOLS]);
  assert.deepEqual([...GOLD_SYMBOL_CANDIDATES], [...GOLD_USD_SYMBOLS]);
  assert.deepEqual([BRIDGE_MIN, BRIDGE_MAX], [GOLD_CONTRACT_SIZE_MIN, GOLD_CONTRACT_SIZE_MAX]);
  assert.match(ea, /const double GOLD_CONTRACT_SIZE_MIN = 1\.0;/);
  assert.match(ea, /const double GOLD_CONTRACT_SIZE_MAX = 100\.0;/);
  assert.ok(!GOLD_USD_SYMBOLS.some((n) => /EUR|AUD|GBP|JPY|CHF|CNH/i.test(n)), "no gold priced in another currency");
});

test("G2. the EA matches names exactly, checks the contract and never falls back", () => {
  assert.match(ea, /#property version\s+"1\.1[4-9]"/);
  assert.ok(!/StringFind\(up, "GOLD"\)|StringFind\(up, "XAUUSD"\) == 0/.test(ea), "no prefix match");
  assert.ok(!/IsGoldSymbolName/.test(ea), "the prefix matcher is gone");
  assert.ok(!/firstExisting/.test(ea), "no fallback to a symbol without a price");
  assert.ok(!/g_tradeSymbol = _Symbol;\s*\n\s*return g_tradeSymbol;\s*\n\s*\}\s*$/m.test(ea.split("string ResolveGoldSymbol()")[1]?.split("//+")[0] ?? ""), "no fallback to the chart symbol");
  assert.match(ea, /if\(GOLD_USD_SYMBOLS\[i\] == name\) return true;/);
  assert.match(ea, /SymbolInfoString\(sym, SYMBOL_CURRENCY_PROFIT\) != "USD"\) return "profit_currency_not_usd"/);
  assert.match(ea, /size < GOLD_CONTRACT_SIZE_MIN \|\| size > GOLD_CONTRACT_SIZE_MAX\) return "contract_size_out_of_range"/);
  assert.match(ea, /g_symbolError = "no_usd_gold_symbol \(" \+ lastProblem \+ "\)";\s*\n\s*return "";/);
  // Fail closed: an open intent without a verified symbol is refused; the corpus is not written.
  assert.match(ea, /if\(ResolveGoldSymbol\(\) == ""\)\s*\{\s*AppendResult\(id, false, 0, "symbol_error", nowMs\);/);
  assert.match(ea, /if\(sym == ""\) return; \/\/ no USD gold symbol/);
  // Never silent: state.json carries the contract and the refusal.
  assert.match(ea, /\\"currency_profit\\":\\"%s\\",\\"currency_base\\":\\"%s\\",\\"contract_size\\":%\.4f[,}]/);
  assert.match(ea, /\\"symbol_error\\":\\"%s\\",/);
});

test("G3. goldSymbolCheck: exact name, USD profit, 1-100 oz, no symbol_error; GOLDEURO refused", () => {
  assert.deepEqual(goldSymbolCheck(USD_GOLD), { ok: true, problem: null });
  assert.deepEqual(goldSymbolCheck({ ...USD_GOLD, name: "XAUUSD.m" }), { ok: true, problem: null });
  assert.equal(goldSymbolCheck({ ...USD_GOLD, name: "GOLDEURO", currency_profit: "EUR" }).problem, "name_not_allowed");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, name: "GOLDEURO" }).problem, "name_not_allowed", "the name alone refuses it");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, name: "gold" }).problem, "name_not_allowed", "case-sensitive");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, name: "XAUUSD_mini" }).problem, "name_not_allowed", "no prefix");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, currency_profit: "EUR" }).problem, "profit_currency_not_usd");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, contract_size: 1000 }).problem, "contract_size_out_of_range");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, contract_size: 0.1 }).problem, "contract_size_out_of_range");
  assert.equal(goldSymbolCheck({ name: "GOLD" }).problem, "currency_not_reported", "an EA older than 1.14 is never verified");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, contract_size: null }).problem, "contract_size_not_reported");
  assert.equal(goldSymbolCheck({ name: "" }).problem, "no_symbol");
  assert.equal(goldSymbolCheck(USD_GOLD, "no_usd_gold_symbol (GOLD:no_price)").problem, "symbol_error:no_usd_gold_symbol (GOLD:no_price)");
  assert.match(goldSymbolText(goldSymbolCheck({ ...USD_GOLD, currency_profit: "EUR" }), { ...USD_GOLD, currency_profit: "EUR" }), /GOLD refused: its profit currency is EUR, not USD\. No new entries\./);
  assert.equal(goldSymbolText(goldSymbolCheck(USD_GOLD), USD_GOLD), "GOLD (USD, 100 oz a lot)");
});

test("G4. the server keeps the contract, the EA's refusal and the bridge's resolution, checked", () => {
  const ex = executorFrom({ connected: true, server: "FxPro-MT5 Demo", symbol: { ...USD_GOLD, chart: "GOLD" }, symbol_error: null, bridge_symbol: { status: "confirmed", server: "FxPro-MT5 Demo", chart_symbol: "GOLD", learned: "GOLD", tried: [] } });
  assert.deepEqual([ex.symbol.currency_profit, ex.symbol.contract_size, ex.symbol.chart, ex.symbol_error, ex.bridge_symbol.status], ["USD", 100, "GOLD", null, "confirmed"]);
  const refused = executorFrom({ connected: true, symbol: { name: "" }, symbol_error: "no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)" });
  assert.equal(refused.symbol_error, "no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)");
  assert.equal(bridgeSymbolFrom({ status: "bogus" }).status, null);
  assert.equal(bridgeSymbolFrom("x"), null);
});

const NOW = Date.parse("2026-11-17T10:00:00Z");
const SYM = { ...USD_GOLD, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 };
const executor = (symbol, extra = {}) => ({ connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000 }, symbol, positions: [], ...extra });
const signal = { side: "BUY", action: "ENTER", entry: 4101.2, stop: 4091.2, tp1: 4121.2, issued_ms: NOW - 5_000, decided_ms: NOW - 5_000, expires_ms: NOW + 600_000 };
const plan = (ex) => planIntents({ signal, settings: { ...OMEGA_DEFAULTS, enabled: true }, executor: ex, now: NOW, engineEnabled: true });

test("G5. no new entry unless the symbol is verified USD gold; a GOLDEURO-only server opens nothing", () => {
  const ok = plan(executor(SYM));
  assert.ok(ok.intents.some((it) => it.kind === "open"), `opens on verified USD gold: ${JSON.stringify(ok.notes)}`);
  for (const [label, ex] of [
    ["GOLDEURO", executor({ ...SYM, name: "GOLDEURO", currency_profit: "EUR" })],
    ["EUR profit", executor({ ...SYM, currency_profit: "EUR" })],
    ["1000 oz", executor({ ...SYM, contract_size: 1000 })],
    ["EA 1.13 (no contract)", executor({ ...SYM, currency_profit: null, contract_size: null })],
    ["EA refusal", executor({ ...SYM, name: "", bid: 0, ask: 0 }, { symbol_error: "no_usd_gold_symbol (GOLDEURO:name_not_allowed)" })],
  ]) {
    const p = plan(ex);
    assert.ok(!p.intents.some((it) => it.kind === "open"), `${label}: no open`);
    assert.ok(p.notes.some((n) => n.code === "symbol_unverified"), `${label}: says why`);
  }
  // An open Omega position is still managed and can be closed on an opposite signal.
  const pos = { ticket: 7, side: "SELL", volume: 0.01, open_price: 4110, sl: 4120, tp: 4090, source: "omega", magic: 920200, intent_id: "x" };
  const p = plan(executor({ ...SYM, name: "GOLDEURO", currency_profit: "EUR" }, { positions: [pos] }));
  assert.ok(p.intents.some((it) => it.kind === "close" && it.ticket === 7), "the opposite position is still closed");
});

function db(rows) {
  return {
    prepare(sql) {
      const stmt = { bind: () => stmt, first: async () => (sql.includes("omega_bridge") ? rows.bridge : sql.includes("omega_connection") ? rows.conn : sql.includes("bridge_symbol") ? rows.event : null), all: async () => ({ results: [] }), run: async () => ({}) };
      return stmt;
    }
  };
}

test("G6. the health alert names a refused symbol, and the bridge's exhausted search while no EA runs", async () => {
  const st = (symbol, extra = {}) => ({ bridge: { state: JSON.stringify({ server: "Euro-Demo", received_ms: NOW - 2000, symbol, ...extra }) }, conn: { status: "stored" } });
  assert.equal(await omegaSymbolIssue({ DB: db(st(SYM)) }, NOW), null);
  const euro = await omegaSymbolIssue({ DB: db(st({ ...SYM, name: "GOLDEURO", currency_profit: "EUR" })) }, NOW);
  assert.equal(euro.kind, "omega_symbol");
  assert.match(euro.subject, /GOLDEURO refused: the name is not on the USD gold list\. No new entries\./);
  const own = await omegaSymbolIssue({ DB: db(st({ name: "" }, { symbol_error: "no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)" })) }, NOW);
  assert.equal(own.detail.problem, "symbol_error:no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)");
  // No connection stored: nothing to say.
  assert.equal(await omegaSymbolIssue({ DB: db({ ...st({ name: "GOLDEURO" }), conn: { status: "none" } }) }, NOW), null);
  // No fresh EA state, the bridge tried every name.
  const exhausted = await omegaSymbolIssue({ DB: db({ bridge: { state: "null" }, conn: { status: "stored" }, event: { ms: NOW - 60_000, detail: JSON.stringify({ status: "exhausted", server: "NoGold-Demo", tried: ["XAUUSD", "GOLD"] }) } }) }, NOW);
  assert.equal(exhausted.key, "omega_symbol:bridge_exhausted");
  assert.match(exhausted.subject, /no gold chart symbol works on NoGold-Demo \(tried XAUUSD, GOLD\)/);
});
