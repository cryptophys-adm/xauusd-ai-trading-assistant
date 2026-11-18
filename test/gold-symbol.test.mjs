// USD gold only (owner 2026-11-17, PR #405: "setuju", then "b"). One list in three places (the EA, the bridge,
// the server), exact names, the contract checked, fail closed, never silent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOLD_USD_SYMBOLS, GOLD_CONTRACT_SIZE_MIN, GOLD_CONTRACT_SIZE_MAX, goldSymbolCheck, goldSymbolText, goldCheckOf, mappedPriceProblem, isCentCurrency } from "../src/gold-symbol.mjs";
import { GOLD_SYMBOL_CANDIDATES, GOLD_CONTRACT_SIZE_MIN as BRIDGE_MIN, GOLD_CONTRACT_SIZE_MAX as BRIDGE_MAX } from "../bridge/omega-bridge/src/symbols.mjs";
import { executorFrom, bridgeSymbolFrom, centToUsd, redactAccount } from "../src/omega-broker.mjs";
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
  // 1.17: USD, or USC (US cents) on a cent account only.
  assert.match(ea, /if\(profitCur != "USD" && !\(IsCentAccount\(\) && profitUp == "USC"\)\) return "profit_currency_not_usd";/);
  // 1.17: the owner's one exact name (omega/trade_symbol.txt from the bridge) is allowed, under the same checks.
  assert.match(ea, /if\(name != "" && name == g_ownerSymbol\) return true;/);
  assert.match(ea, /const string TRADE_SYMBOL_PATH = "omega\/trade_symbol\.txt";/);
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
  assert.match(euro.subject, /GOLDEURO refused: the name is not on the USD gold list \(set the account's gold symbol in Setup → Connection & EA\)\. No new entries\./);
  const own = await omegaSymbolIssue({ DB: db(st({ name: "" }, { symbol_error: "no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)" })) }, NOW);
  assert.equal(own.detail.problem, "symbol_error:no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)");
  // No connection stored: nothing to say.
  assert.equal(await omegaSymbolIssue({ DB: db({ ...st({ name: "GOLDEURO" }), conn: { status: "none" } }) }, NOW), null);
  // No fresh EA state, the bridge tried every name.
  const exhausted = await omegaSymbolIssue({ DB: db({ bridge: { state: "null" }, conn: { status: "stored" }, event: { ms: NOW - 60_000, detail: JSON.stringify({ status: "exhausted", server: "NoGold-Demo", tried: ["XAUUSD", "GOLD"] }) } }) }, NOW);
  assert.equal(exhausted.key, "omega_symbol:bridge_exhausted");
  assert.match(exhausted.subject, /no gold chart symbol works on NoGold-Demo \(tried XAUUSD, GOLD\)/);
});

test("G7. cent accounts: the owner's exact gold symbol passes the same checks; USC profit only on a cent account", () => {
  const goldOne = { ...USD_GOLD, name: "GoldOne" };
  assert.equal(goldSymbolCheck(goldOne).problem, "name_not_allowed", "off the list without the owner's name");
  assert.equal(goldSymbolCheck(goldOne, null, { ownerSymbol: "GoldOne" }).ok, true);
  assert.equal(goldSymbolCheck({ ...goldOne, name: "goldone" }, null, { ownerSymbol: "GoldOne" }).ok, false, "exact, case-sensitive");
  assert.equal(goldSymbolCheck({ ...goldOne, contract_size: 1000 }, null, { ownerSymbol: "GoldOne" }).problem, "contract_size_out_of_range");
  assert.equal(goldSymbolCheck({ ...goldOne, currency_profit: "USC" }, null, { ownerSymbol: "GoldOne" }).problem, "profit_currency_not_usd");
  assert.equal(goldSymbolCheck({ ...goldOne, currency_profit: "USC" }, null, { ownerSymbol: "GoldOne", cent: true }).ok, true);
  assert.equal(goldSymbolCheck({ ...goldOne, currency_profit: "EUR" }, null, { ownerSymbol: "GoldOne", cent: true }).ok, false);
  assert.equal(goldCheckOf({ symbol: goldOne, owner_symbol: "GoldOne", account: { cent: true } }).ok, true);
  assert.ok(isCentCurrency("USC") && isCentCurrency("USc") && !isCentCurrency("USD"));
  // A name off the list must price as gold: within 2% of the reference, else refused; a listed name is not asked.
  assert.equal(mappedPriceProblem({ name: "GoldOne", bid: 4101 }, 4100), null);
  assert.equal(mappedPriceProblem({ name: "GoldOne", bid: 2050 }, 4100), "mapped_price_mismatch");
  assert.equal(mappedPriceProblem({ name: "GoldOne", bid: 0 }, 4100), "mapped_price_unverified");
  assert.equal(mappedPriceProblem({ name: "GoldOne", bid: 4101 }, null), "mapped_price_unverified");
  assert.equal(mappedPriceProblem({ name: "GOLD", bid: 1 }, 4100), null);
});

test("G8. a USC account's amounts become USD once, where the bridge state enters; ratios are unchanged", () => {
  const raw = { connected: true, server: "Cent-Live", account: { currency: "USC", balance: 5450, equity: 5300, day_start_balance: 5450, day_realized_pl: -150, margin_free: 5000 },
    symbol: { name: "GoldOne", currency_profit: "USD", contract_size: 100, tick_size: 0.01, tick_value: 100, margin_per_lot: 4000, bid: 4101 },
    positions: [{ ticket: 1, side: "BUY", volume: 0.01, profit: -150 }], deals: [{ deal_ticket: 9, profit: 250, commission: -10, swap: -5 }] };
  const ex = executorFrom(raw);
  assert.equal(ex.account.cent, true);
  assert.equal(ex.account.currency, "USC", "the account keeps its currency for the label");
  assert.deepEqual([ex.account.balance, ex.account.equity, ex.account.day_start_balance, ex.account.day_realized_pl, ex.account.margin_free], [54.5, 53, 54.5, -1.5, 50]);
  assert.deepEqual([ex.symbol.tick_value, ex.symbol.margin_per_lot, ex.symbol.bid], [1, 40, 4101], "prices are not amounts");
  assert.deepEqual([ex.positions[0].profit, ex.deals[0].profit, ex.deals[0].commission, ex.deals[0].swap], [-1.5, 2.5, -0.1, -0.05]);
  // The loss a stop risks, as a share of equity, is the same before and after.
  const pct = (eq, tv) => ((10 / 0.01) * tv * 0.01) / eq;
  assert.equal(Math.round(pct(5300, 100) * 1e9), Math.round(pct(ex.account.equity, ex.symbol.tick_value) * 1e9));
  const usd = executorFrom({ ...raw, account: { ...raw.account, currency: "USD" }, symbol: { ...raw.symbol, tick_value: 1 } });
  assert.deepEqual([usd.account.cent, usd.account.balance, usd.symbol.tick_value, usd.symbol.tick_value_problem], [false, 5450, 1, null], "a USD account keeps its amounts");
  assert.equal(centToUsd(null), null);
});

test("G9. the terminal's journal line never carries the account number", () => {
  assert.equal(redactAccount("'5012345': authorization on Cent-Live failed (Invalid account)"), "'[account]': authorization on Cent-Live failed (Invalid account)");
  assert.equal(redactAccount("initializing of OmegaExecutor (GOLD,M1) failed with code 0 (symbol synchronization timeout)"), "initializing of OmegaExecutor (GOLD,M1) failed with code 0 (symbol synchronization timeout)");
  assert.equal(redactAccount("price 4012.55 and 12345.67"), "price 4012.55 and 12345.67", "prices keep their digits");
  assert.equal(bridgeSymbolFrom({ status: "trial", terminal_error: "'87654321' authorization failed" }).terminal_error, "'[account]' authorization failed");
  assert.equal(executorFrom({ connected: false, terminal_error: "login 87654321 failed" }).terminal_error, "login [account] failed");
});

test("G10. the engine opens on the owner's GoldOne only when it prices as gold; a cent account sizes in USD", () => {
  const goldOne = { ...SYM, name: "GoldOne" };
  const cent = (sym) => ({ ...executor(sym), owner_symbol: "GoldOne", account: { trade_mode: "demo", currency: "USC", cent: true, balance: 10_000, equity: 10_000, day_start_balance: 10_000 } });
  const ok = plan(cent(goldOne));
  assert.ok(ok.intents.some((it) => it.kind === "open"), `opens: ${JSON.stringify(ok.notes)}`);
  const off = plan(cent({ ...goldOne, bid: 2050, ask: 2050.2 }));
  assert.ok(!off.intents.some((it) => it.kind === "open"));
  assert.ok(off.notes.some((n) => n.code === "symbol_price_mismatch"), JSON.stringify(off.notes));
  const noOwner = plan({ ...cent(goldOne), owner_symbol: null });
  assert.ok(noOwner.notes.some((n) => n.code === "symbol_unverified"));
});

test("G11. incident 2026-11-18: FxPro GoldOne on a USX (cent) account is sized on the real dollar risk", () => {
  // The account as the bridge reported it at 13:21 UTC: 5450 USX ($54.50), GoldOne 1 oz a lot, min lot 1, tick 0.01
  // worth 0.01 (in USD, while balance and profit are in cents). Omega opened SELL 3 at 3771.45, stop 3786.42.
  const raw = { connected: true, server: "FxPro-MT5", executor: { version: "1.17" },
    account: { trade_mode: "real", currency: "USX", balance: 5450, equity: 5450, day_start_balance: 5450, margin_free: 5450, leverage: 10000 },
    symbol: { name: "GoldOne", currency_profit: "USD", currency_base: "USD", contract_size: 1, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 0.01,
      volume_min: 1, volume_max: 1000, volume_step: 1, stops_level_points: 0, bid: 3771.45, ask: 3771.48, spread_points: 3, margin_per_lot: 37.74 },
    positions: [{ ticket: 361755789, side: "SELL", volume: 3, open_price: 3771.45, sl: 3786.42, profit: -840 }], deals: [] };
  const ex = executorFrom(raw);
  assert.equal(ex.account.cent, true, "USX is US cents");
  assert.deepEqual([ex.account.balance, ex.positions[0].profit, ex.symbol.margin_per_lot], [54.5, -8.4, 0.3774]);
  assert.deepEqual([ex.symbol.tick_value, ex.symbol.tick_value_reported, ex.symbol.tick_value_problem], [0.01, 0.01, null], "1 oz x 0.01 = $0.01 a tick");
  // The loss at the stop of the 3 lots, in USD: 1497 ticks x $0.01 x 3 = $44.91 (82% of $54.50), not 0.8%.
  const loss = ((3786.42 - 3771.45) / ex.symbol.tick_size) * ex.symbol.tick_value * 3;
  assert.equal(Math.round(loss * 100) / 100, 44.91);
  // The engine on that state: the minimum lot (1 oz) risks $14.97 of $54.50 at that stop, far over any cap: no open.
  const sig = { side: "SELL", action: "ENTER", entry: 3771.48, stop: 3786.42, tp1: 3762.83, issued_ms: NOW - 5_000, decided_ms: NOW - 5_000, expires_ms: NOW + 600_000 };
  const p = planIntents({ signal: sig, settings: { ...OMEGA_DEFAULTS, enabled: true, live_armed: true }, executor: { ...ex, positions: [], received_ms: NOW - 1000, owner_symbol: "GoldOne" }, now: NOW, engineEnabled: true });
  assert.ok(!p.intents.some((it) => it.kind === "open"), `no open: ${JSON.stringify(p.notes)}`);
  assert.ok(p.notes.some((n) => n.code === "volume_below_min"), JSON.stringify(p.notes));
});

test("G12. a tick value that is neither contract x tick size nor that in cents opens nothing", () => {
  const sym = { ...SYM, tick_value: 7 };
  const ex = executorFrom({ connected: true, account: { currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000 }, symbol: sym });
  assert.equal(ex.symbol.tick_value_problem, "tick_value_mismatch");
  const p = plan({ ...ex, received_ms: NOW - 1000, account: { ...ex.account, trade_mode: "demo" } });
  assert.ok(!p.intents.some((it) => it.kind === "open"));
  assert.ok(p.notes.some((n) => n.code === "tick_value_mismatch"), JSON.stringify(p.notes));
  // A EUR account keeps the broker's figure (its own currency).
  assert.equal(executorFrom({ account: { currency: "EUR" }, symbol: sym }).symbol.tick_value, 7);
});

test("G13. 'perbaiki deal': a deal stored in cents (USX) reads in USD; the exposure line names the dollar risk", async () => {
  const { dealInUsd } = await import("../src/ea-execution.mjs");
  const { DEAL_NET_SQL, DEAL_MONEY_COLUMNS_SQL, positionExposure, exposureText } = await import("../src/gold-symbol.mjs");
  // The incident's deal: -1254 USX stored before #461.
  assert.deepEqual(dealInUsd({ deal_ticket: 356158606, profit: -1254, commission: 0, swap: 0, currency: "USX" }),
    { deal_ticket: 356158606, profit: -12.54, commission: 0, swap: 0, currency: "USD", currency_stored: "USX" });
  const usd = { deal_ticket: 1, profit: -5, commission: -0.1, swap: 0, currency: "USD" };
  assert.equal(dealInUsd(usd), usd, "a USD row is unchanged");
  // The SQL the money readers use, on SQLite.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY, profit REAL, commission REAL, swap REAL, currency TEXT)");
  db.exec("INSERT INTO ea_deals (profit, commission, swap, currency) VALUES (-1254, 0, 0, 'USX'), (-5, -0.1, 0, 'USD'), (300, 0, 0, 'usc'), (2, 0, 0, NULL)");
  assert.equal(Math.round(db.prepare(`SELECT SUM(${DEAL_NET_SQL}) AS n FROM ea_deals`).get().n * 100) / 100, -12.54 - 5.1 + 3 + 2);
  assert.deepEqual({ ...db.prepare(`SELECT ${DEAL_MONEY_COLUMNS_SQL} FROM ea_deals WHERE id = 1`).get() }, { profit: -12.54, commission: 0, swap: 0 });
  // Exposure: the 3 GoldOne lots (1 oz) at a 14.97 stop on $54.50.
  const x = positionExposure({ side: "SELL", volume: 3, open_price: 3771.45, sl: 3786.42 }, { currency_profit: "USD", contract_size: 1 }, 54.5);
  assert.deepEqual(x, { usd_per_dollar: 3, risk_at_sl_usd: 44.91, risk_at_sl_pct: 82.4 });
  assert.equal(exposureText(x), "≈ $3 per $1 move · risk at SL $44.91 (82.4%)");
  // 0.10 lot of a 100 oz contract: $10 per $1 move; a stop already locking profit has no risk.
  assert.deepEqual(positionExposure({ side: "BUY", volume: 0.1, open_price: 4000, sl: 4005 }, { currency_profit: "USD", contract_size: 100 }, 1000), { usd_per_dollar: 10, risk_at_sl_usd: null, risk_at_sl_pct: null });
  assert.equal(positionExposure({ side: "BUY", volume: 1, open_price: 1, sl: 0.9 }, { currency_profit: "EUR", contract_size: 100 }, 1000), null);
});
