// Gold priced in USD on ANY broker (owner 2026-11-19: "Harusnya bisa universal apapun broker, nama pair maupun
// servernya"). No list of names, servers or currency codes decides: the instrument is identified by its USD profit,
// its 1-100 oz contract and its price against the reference; the account's money by its own trades.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { GOLD_CONTRACT_SIZE_MIN, GOLD_CONTRACT_SIZE_MAX, goldSymbolCheck, goldSymbolText, goldPriceProblem, accountMoney, measuredUnitsPerUsd, moneyText, snapPowerOfTen, referenceFrom, REFERENCE_H4_CLOSES } from "../src/gold-symbol.mjs";
import { GOLD_CONTRACT_SIZE_MIN as BRIDGE_MIN, GOLD_CONTRACT_SIZE_MAX as BRIDGE_MAX } from "../bridge/omega-bridge/src/symbols.mjs";
import { executorFrom, bridgeSymbolFrom, toUsd, redactAccount, liveBridgeFields } from "../src/omega-broker.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { omegaSymbolIssue } from "../src/health-alerts.mjs";

const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");
const USD_GOLD = { name: "GOLD", currency_profit: "USD", currency_base: "XAU", contract_size: 100 };

test("G1. no list of gold names, brokers or currency codes decides anything, in the EA, the bridge or the server", () => {
  // The old 13-name list and the USC/USX list are gone from the code (comments may still tell the history).
  const code = (t) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const sources = [ea, readFileSync(new URL("../bridge/omega-bridge/src/symbols.mjs", import.meta.url), "utf8"), readFileSync(new URL("../src/gold-symbol.mjs", import.meta.url), "utf8")];
  for (const t of sources) {
    assert.ok(!/GOLD_USD_SYMBOLS|GOLD_SYMBOL_CANDIDATES|CENT_CURRENCIES|isCentCurrency|onGoldList|name_not_allowed/.test(code(t)));
  }
  assert.ok(!/"XAUUSD\.m"|"XAUUSDm"|"GOLD\.m"/.test(code(ea)), "the EA names no gold symbol in code");
  assert.deepEqual([BRIDGE_MIN, BRIDGE_MAX], [GOLD_CONTRACT_SIZE_MIN, GOLD_CONTRACT_SIZE_MAX]);
  assert.match(ea, /const double GOLD_CONTRACT_SIZE_MIN = 1\.0;/);
  assert.match(ea, /const double GOLD_CONTRACT_SIZE_MAX = 100\.0;/);
  // No broker or server name in the server's or the bridge's code.
  const dirs = ["../src/", "../bridge/omega-bridge/src/"];
  for (const d of dirs) for (const f of readdirSync(new URL(d, import.meta.url)).filter((x) => x.endsWith(".mjs"))) {
    assert.ok(!/\b(fxpro|monex|exness|dupoin|valetax|icmarkets|pepperstone)\b/i.test(code(readFileSync(new URL(d + f, import.meta.url), "utf8"))), `${d}${f}`);
  }
});

test("G2. OmegaExecutor (1.19+) finds gold by its contract and price on any server; never falls back; says why", () => {
  assert.match(ea, /int total = SymbolsTotal\(false\);/, "every symbol the server offers");
  assert.match(ea, /if\(SymbolInfoString\(sym, SYMBOL_CURRENCY_PROFIT\) != "USD"\) return "profit_currency_not_usd";/);
  assert.match(ea, /if\(size < GOLD_CONTRACT_SIZE_MIN \|\| size > GOLD_CONTRACT_SIZE_MAX\) return "contract_size_out_of_range";/);
  assert.match(ea, /if\(g_refPrice <= 0\.0\) return "no_reference_price";/, "no reference, no choice");
  assert.match(ea, /if\(g_refPrice <= 0\.0\)\s*lastProblem = "no_reference_price";/, "no scan, and nothing added to Market Watch, without a reference");
  assert.match(ea, /SymbolSelect\(c, false\);\s*StringReplace\(g_scanSelected/, "a symbol the scan added and that is not gold leaves Market Watch");
  assert.match(ea, /if\(MathAbs\(bid - g_refPrice\) \/ g_refPrice > GOLD_PRICE_TOLERANCE\) return "price_not_gold";/);
  assert.match(ea, /const string REFERENCE_PATH = "omega\/reference\.txt";/);
  assert.match(ea, /g_symbolError = "no_usd_gold_symbol \(" \+ lastProblem \+ "\)";\s*\n\s*return "";/);
  // Fail closed: an open intent without a verified symbol is refused; the corpus is not written.
  assert.match(ea, /if\(ResolveGoldSymbol\(\) == ""\)\s*\{\s*AppendResult\(id, false, 0, "symbol_error", nowMs\);/);
  // Never silent: state.json carries the contract, the refusal and the broker's company.
  assert.match(ea, /\\"currency_profit\\":\\"%s\\",\\"currency_base\\":\\"%s\\",\\"contract_size\\":%\.4f[,}]/);
  assert.match(ea, /\\"symbol_error\\":\\"%s\\",/);
  assert.match(ea, /EscapeJson\(AccountInfoString\(ACCOUNT_COMPANY\)\)/);
});

test("G3. goldSymbolCheck: any name; USD profit, 1-100 oz, no symbol_error; the price tells gold from anything else", () => {
  for (const name of ["GOLD", "XAUUSD.m", "GoldOne", "Au.spot", "XAU/USD", "gold"]) assert.deepEqual(goldSymbolCheck({ ...USD_GOLD, name }), { ok: true, problem: null }, name);
  assert.equal(goldSymbolCheck({ ...USD_GOLD, name: "GOLDEURO", currency_profit: "EUR" }).problem, "profit_currency_not_usd");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, contract_size: 1000 }).problem, "contract_size_out_of_range");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, contract_size: 0.1 }).problem, "contract_size_out_of_range");
  assert.equal(goldSymbolCheck({ name: "GOLD" }).problem, "currency_not_reported", "an EA older than 1.14 is never verified");
  assert.equal(goldSymbolCheck({ ...USD_GOLD, contract_size: null }).problem, "contract_size_not_reported");
  assert.equal(goldSymbolCheck({ name: "" }).problem, "no_symbol");
  assert.equal(goldSymbolCheck(USD_GOLD, "no_usd_gold_symbol (no_reference_price)").problem, "symbol_error:no_usd_gold_symbol (no_reference_price)");
  // The price: gold within 2% of the reference; silver, gold in grams, an index are not gold whatever their name.
  assert.equal(goldPriceProblem({ bid: 4101 }, 4100), null);
  for (const bid of [30.5, 131.8, 21500, 3700]) assert.equal(goldPriceProblem({ bid }, 4100), "symbol_price_mismatch", String(bid));
  assert.equal(goldPriceProblem({ bid: 0 }, 4100), "symbol_price_unverified");
  assert.equal(goldPriceProblem({ bid: 4101 }, null), "symbol_price_unverified");
  assert.match(goldSymbolText(goldSymbolCheck({ ...USD_GOLD, currency_profit: "EUR" }), { ...USD_GOLD, currency_profit: "EUR" }), /GOLD refused: its profit currency is EUR, not USD\. No new entries\./);
  assert.equal(goldSymbolText(goldSymbolCheck(USD_GOLD), USD_GOLD), "GOLD (USD, 100 oz a lot)");
});

test("G4. the server keeps the contract, the EA's refusal and the bridge's resolution, checked", () => {
  const ex = executorFrom({ connected: true, server: "OtherBroker-Server Demo", symbol: { ...USD_GOLD, chart: "GOLD" }, symbol_error: null, bridge_symbol: { status: "confirmed", server: "OtherBroker-Server Demo", chart_symbol: "GOLD", learned: "GOLD", tried: [] } });
  assert.deepEqual([ex.symbol.currency_profit, ex.symbol.contract_size, ex.symbol.chart, ex.symbol_error, ex.bridge_symbol.status], ["USD", 100, "GOLD", null, "confirmed"]);
  const refused = executorFrom({ connected: true, symbol: { name: "" }, symbol_error: "no_usd_gold_symbol (no_reference_price)" });
  assert.equal(refused.symbol_error, "no_usd_gold_symbol (no_reference_price)");
  assert.equal(bridgeSymbolFrom({ status: "bogus" }).status, null);
  assert.equal(bridgeSymbolFrom("x"), null);
});

const NOW = Date.parse("2026-11-17T10:00:00Z");
const SYM = { ...USD_GOLD, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 };
const executor = (symbol, extra = {}) => ({ connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, money: { units_per_usd: 1, source: "usd", problem: null } }, symbol, positions: [], ...extra });
const signal = { side: "BUY", action: "ENTER", entry: 4101.2, stop: 4091.2, tp1: 4121.2, issued_ms: NOW - 5_000, decided_ms: NOW - 5_000, expires_ms: NOW + 600_000 };
const plan = (ex) => planIntents({ signal, settings: { ...OMEGA_DEFAULTS, enabled: true }, executor: ex, now: NOW, engineEnabled: true });

test("G5. no new entry unless the symbol is verified gold priced in USD; a GOLDEURO-only server opens nothing", () => {
  const ok = plan(executor(SYM));
  assert.ok(ok.intents.some((it) => it.kind === "open"), `opens on verified USD gold: ${JSON.stringify(ok.notes)}`);
  // Any name the broker uses: what counts is the contract and the price.
  assert.ok(plan(executor({ ...SYM, name: "Au.spot" })).intents.some((it) => it.kind === "open"));
  // A USD-priced symbol that is not gold (silver, an index) never opens, whatever its name.
  for (const bid of [30.5, 21500]) {
    const p = plan(executor({ ...SYM, name: "XAUUSD", bid, ask: bid + 0.02 }));
    assert.ok(!p.intents.some((it) => it.kind === "open") && p.notes.some((n) => n.code === "symbol_price_mismatch"), String(bid));
  }
  for (const [label, ex] of [
    ["GOLDEURO", executor({ ...SYM, name: "GOLDEURO", currency_profit: "EUR" })],
    ["EUR profit", executor({ ...SYM, currency_profit: "EUR" })],
    ["1000 oz", executor({ ...SYM, contract_size: 1000 })],
    ["EA 1.13 (no contract)", executor({ ...SYM, currency_profit: null, contract_size: null })],
    ["EA refusal", executor({ ...SYM, name: "", bid: 0, ask: 0 }, { symbol_error: "no_usd_gold_symbol (no_reference_price)" })],
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
  assert.match(euro.subject, /GOLDEURO refused: its profit currency is EUR, not USD\. No new entries\./);
  const own = await omegaSymbolIssue({ DB: db(st({ name: "" }, { symbol_error: "no_usd_gold_symbol (no_reference_price)" })) }, NOW);
  assert.equal(own.detail.problem, "symbol_error:no_usd_gold_symbol (no_reference_price)");
  // No connection stored: nothing to say.
  assert.equal(await omegaSymbolIssue({ DB: db({ ...st({ name: "GOLDEURO" }), conn: { status: "none" } }) }, NOW), null);
  // No fresh EA state, the bridge tried every name.
  const exhausted = await omegaSymbolIssue({ DB: db({ bridge: { state: "null" }, conn: { status: "stored" }, event: { ms: NOW - 60_000, detail: JSON.stringify({ status: "exhausted", server: "NoGold-Demo", tried: ["XAUUSD", "GOLD"] }) } }) }, NOW);
  assert.equal(exhausted.key, "omega_symbol:bridge_exhausted");
  assert.match(exhausted.subject, /no gold chart symbol works on NoGold-Demo \(tried XAUUSD, GOLD\)/);
});

test("G7. the account's money: USD is one dollar; any other currency is measured from its own trades, or the owner's value until it trades", () => {
  const gold = { name: "Au", currency_profit: "USD", contract_size: 1, tick_size: 0.01, bid: 3768.65, ask: 3768.68 };
  // A SELL of 3 lots (1 oz each) from 3771.45, now at 3768.68: 2.77 dollars a lot in its favour, profit 831 units.
  const pos = [{ symbol: "Au", side: "SELL", volume: 3, open_price: 3771.45, profit: 831 }];
  assert.deepEqual(measuredUnitsPerUsd({ positions: pos, symbol: gold }), { units_per_usd: 100, samples: 1 });
  // A closed BUY of 0.5 lot from 4000 to 4012 (12 dollars) with 6 units of profit: 1 unit a dollar.
  const deals = [{ symbol: "XAUUSD", side: "BUY", volume: 0.5, entry_price: 4000, exit_price: 4012, profit: 6 }];
  assert.deepEqual(measuredUnitsPerUsd({ deals, symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 1, tick_size: 0.01 } }), { units_per_usd: 1, samples: 1 });
  // A move under 50 ticks is mostly spread: not used.
  assert.equal(measuredUnitsPerUsd({ deals: [{ ...deals[0], exit_price: 4000.3 }], symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 1, tick_size: 0.01 } }), null);
  // Any currency code, no list: USX, USC, ZZC, EUR alike.
  for (const currency of ["USX", "USC", "ZZC"]) assert.deepEqual([accountMoney({ currency, positions: pos, symbol: gold }).units_per_usd, accountMoney({ currency, positions: pos, symbol: gold }).source], [100, "measured"], currency);
  assert.deepEqual(accountMoney({ currency: "USD" }), { currency: "USD", units_per_usd: 1, source: "usd", measured: null, problem: null });
  // Not USD, no trade yet: the owner's value; without it nothing opens.
  assert.equal(accountMoney({ currency: "ZZC" }).problem, "money_unverified");
  assert.deepEqual([accountMoney({ currency: "ZZC", ownerUnitsPerUsd: 100 }).units_per_usd, accountMoney({ currency: "ZZC", ownerUnitsPerUsd: 100 }).source], [100, "owner"]);
  // A measurement that disagrees with the owner's value or with "USD" refuses.
  assert.equal(accountMoney({ currency: "ZZC", positions: pos, symbol: gold, ownerUnitsPerUsd: 1 }).problem, "money_mismatch");
  assert.equal(accountMoney({ currency: "USD", positions: pos, symbol: gold }).problem, "money_mismatch", "a 'USD' account whose trades pay 100 a dollar is not trusted");
  assert.match(moneyText(accountMoney({ currency: "ZZC" })), /not USD and the account has no trade yet/);
  assert.equal(moneyText(accountMoney({ currency: "USX", positions: pos, symbol: gold })), "USX: 100 a dollar (measured from 1 trades)");
  // Converted with an exact number (orchestrator review of #477): a measurement of 99.7 that agrees with the owner's 100
  // converts with 100; without the owner's value a measurement within 1% of a power of ten is that power.
  const near = [{ symbol: "Au", side: "SELL", volume: 3, open_price: 3771.45, profit: 828.5 }]; // 828.5 / 831 = 99.7 a dollar
  assert.equal(measuredUnitsPerUsd({ positions: near, symbol: gold }).units_per_usd, 99.699158);
  assert.deepEqual([accountMoney({ currency: "USX", positions: near, symbol: gold, ownerUnitsPerUsd: 100 }).units_per_usd, accountMoney({ currency: "USX", positions: near, symbol: gold, ownerUnitsPerUsd: 100 }).source], [100, "owner_verified"]);
  assert.match(moneyText(accountMoney({ currency: "USX", positions: near, symbol: gold, ownerUnitsPerUsd: 100 })), /the owner's value, confirmed by 1 trades/);
  assert.equal(accountMoney({ currency: "USX", positions: near, symbol: gold }).units_per_usd, 100);
  assert.deepEqual([snapPowerOfTen(99.7), snapPowerOfTen(1.004), snapPowerOfTen(0.92), snapPowerOfTen(1000.5), snapPowerOfTen(97)], [100, 1, 0.92, 1000, 97], "a currency's rate (0.92) is kept");
});

test("G8. amounts become USD once, where the bridge state enters, with the measured ratio; ratios are unchanged", () => {
  const raw = { connected: true, server: "Any-Live", account: { currency: "USC", balance: 5450, equity: 5300, day_start_balance: 5450, day_realized_pl: -150, margin_free: 5000 },
    symbol: { name: "Au", currency_profit: "USD", contract_size: 1, tick_size: 0.01, tick_value: 1, margin_per_lot: 4000, bid: 4101, ask: 4101.03 },
    positions: [{ ticket: 1, symbol: "Au", side: "BUY", volume: 1, open_price: 4099.5, profit: 150 }], deals: [{ deal_ticket: 9, profit: 250, commission: -10, swap: -5 }] };
  const ex = executorFrom(raw);
  assert.deepEqual([ex.account.money.units_per_usd, ex.account.money.source, ex.account.cent], [100, "measured", true]);
  assert.equal(ex.account.currency, "USC", "the account keeps its currency for the label");
  assert.deepEqual([ex.account.balance, ex.account.equity, ex.account.day_start_balance, ex.account.day_realized_pl, ex.account.margin_free], [54.5, 53, 54.5, -1.5, 50]);
  assert.deepEqual([ex.symbol.tick_value, ex.symbol.margin_per_lot, ex.symbol.bid], [0.01, 40, 4101], "a tick of 1 oz is $0.01; prices are not amounts");
  assert.deepEqual([ex.positions[0].profit, ex.deals[0].profit, ex.deals[0].commission, ex.deals[0].swap], [1.5, 2.5, -0.1, -0.05]);
  // The measurement reads the raw state (the account's own units), and the raw state is what D1 keeps: converting
  // leaves it untouched, so reading the stored state again measures 100 again, never 1.
  assert.deepEqual([raw.account.balance, raw.positions[0].profit, raw.deals[0].profit], [5450, 150, 250]);
  assert.equal(executorFrom(JSON.parse(JSON.stringify(raw))).account.money.units_per_usd, 100);
  // What D1 keeps is the converted executor: read back with `stored` it is never divided again, even when the money
  // came from the owner's value (no trade to measure), and the live push converts the raw state with the same value.
  const ownedRaw = executorFrom({ ...raw, positions: [], deals: [] }, { ownerUnitsPerUsd: 100 });
  const kept = JSON.parse(JSON.stringify(ownedRaw));
  const back = executorFrom(kept, { stored: true });
  assert.deepEqual([ownedRaw.account.balance, back.account.balance, back.account.money.units_per_usd, back.account.money.source, back.account.cent], [54.5, 54.5, 100, "owner", true]);
  assert.equal(executorFrom(kept, { ownerUnitsPerUsd: 100 }).account.balance, 0.545, "without `stored` it would be divided twice (the bug this guards)");
  assert.equal(liveBridgeFields({ ...raw, positions: [], deals: [] }, { ownerUnitsPerUsd: 100 }).balance, 54.5);
  // With no trade and no owner value nothing is converted and the money is unverified.
  const fresh = executorFrom({ ...raw, positions: [], deals: [] });
  assert.deepEqual([fresh.account.money.problem, fresh.account.balance], ["money_unverified", 5450]);
  // The owner's value until a trade measures it.
  const owned = executorFrom({ ...raw, positions: [], deals: [] }, { ownerUnitsPerUsd: 100 });
  assert.deepEqual([owned.account.money.source, owned.account.balance], ["owner", 54.5]);
  // A USD account keeps its amounts.
  const usd = executorFrom({ ...raw, account: { ...raw.account, currency: "USD" }, positions: [], deals: [], symbol: { ...raw.symbol, contract_size: 100, tick_value: 1 } });
  assert.deepEqual([usd.account.cent, usd.account.balance, usd.symbol.tick_value, usd.symbol.tick_value_problem], [false, 5450, 1, null]);
  assert.equal(toUsd(null), null);
});

test("G9. the terminal's journal line never carries the account number", () => {
  assert.equal(redactAccount("'5012345': authorization on Cent-Live failed (Invalid account)"), "'[account]': authorization on Cent-Live failed (Invalid account)");
  assert.equal(redactAccount("initializing of OmegaExecutor (GOLD,M1) failed with code 0 (symbol synchronization timeout)"), "initializing of OmegaExecutor (GOLD,M1) failed with code 0 (symbol synchronization timeout)");
  assert.equal(redactAccount("price 4012.55 and 12345.67"), "price 4012.55 and 12345.67", "prices keep their digits");
  assert.equal(bridgeSymbolFrom({ status: "trial", terminal_error: "'87654321' authorization failed" }).terminal_error, "'[account]' authorization failed");
  assert.equal(executorFrom({ connected: false, terminal_error: "login 87654321 failed" }).terminal_error, "login [account] failed");
});

test("G10. no entry while the account's money is unverified or disagrees; the owner's value lets a new account start", () => {
  const cent = (money) => ({ ...executor(SYM), account: { trade_mode: "demo", currency: "ZZC", balance: 10_000, equity: 10_000, day_start_balance: 10_000, money } });
  const off = plan(cent({ units_per_usd: null, source: null, problem: "money_unverified" }));
  assert.ok(!off.intents.some((it) => it.kind === "open") && off.notes.some((n) => n.code === "money_unverified"), JSON.stringify(off.notes));
  const bad = plan(cent({ units_per_usd: 100, source: "measured", problem: "money_mismatch" }));
  assert.ok(bad.notes.some((n) => n.code === "money_mismatch"));
  const ok = plan(cent({ units_per_usd: 100, source: "owner", problem: null }));
  assert.ok(ok.intents.some((it) => it.kind === "open"), JSON.stringify(ok.notes));
});

test("G11. incident 2026-11-18 on any broker: a cent account is sized on the real dollar risk, measured from its own position", () => {
  // The account as the bridge reported it at 13:21 UTC: 5450 units, gold 1 oz a lot, min lot 1, tick 0.01 reported as
  // worth 0.01 (in dollars, while balance and profit are in cents). An open SELL 3 at 3771.45, now 3774.25, -840.
  const raw = { connected: true, server: "Any-Real", executor: { version: "1.17" },
    account: { trade_mode: "real", currency: "USX", balance: 5450, equity: 5450, day_start_balance: 5450, margin_free: 5450, leverage: 10000 },
    symbol: { name: "GoldOne", currency_profit: "USD", currency_base: "USD", contract_size: 1, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 0.01,
      volume_min: 1, volume_max: 1000, volume_step: 1, stops_level_points: 0, bid: 3774.22, ask: 3774.25, spread_points: 3, margin_per_lot: 37.74 },
    positions: [{ ticket: 361755789, symbol: "GoldOne", side: "SELL", volume: 3, open_price: 3771.45, sl: 3786.42, profit: -840 }], deals: [] };
  const ex = executorFrom(raw);
  assert.deepEqual([ex.account.money.units_per_usd, ex.account.cent], [100, true], "measured, not read from the code USX");
  assert.deepEqual([ex.account.balance, ex.positions[0].profit, ex.symbol.margin_per_lot], [54.5, -8.4, 0.3774]);
  assert.deepEqual([ex.symbol.tick_value, ex.symbol.tick_value_reported, ex.symbol.tick_value_problem], [0.01, 0.01, null], "1 oz x 0.01 = $0.01 a tick");
  const loss = ((3786.42 - 3771.45) / ex.symbol.tick_size) * ex.symbol.tick_value * 3;
  assert.equal(Math.round(loss * 100) / 100, 44.91);
  const sig = { side: "SELL", action: "ENTER", entry: 3774.25, stop: 3786.42, tp1: 3762.83, issued_ms: NOW - 5_000, decided_ms: NOW - 5_000, expires_ms: NOW + 600_000 };
  const p = planIntents({ signal: sig, settings: { ...OMEGA_DEFAULTS, enabled: true, live_armed: true }, executor: { ...ex, positions: [], received_ms: NOW - 1000 }, now: NOW, engineEnabled: true });
  assert.ok(!p.intents.some((it) => it.kind === "open"), `no open: ${JSON.stringify(p.notes)}`);
  assert.ok(p.notes.some((n) => n.code === "volume_below_min"), JSON.stringify(p.notes));
});

test("G12. a tick value that is neither contract x tick size in dollars nor that in the account's units opens nothing", () => {
  const sym = { ...SYM, tick_value: 7 };
  const ex = executorFrom({ connected: true, account: { currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000 }, symbol: sym });
  assert.equal(ex.symbol.tick_value_problem, "tick_value_mismatch");
  const p = plan({ ...ex, received_ms: NOW - 1000, account: { ...ex.account, trade_mode: "demo" } });
  assert.ok(!p.intents.some((it) => it.kind === "open"));
  assert.ok(p.notes.some((n) => n.code === "tick_value_mismatch"), JSON.stringify(p.notes));
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

test("G13. the reference the EA finds gold by: price, its own time and past 4h closes; none while the feed runs on the broker's bars", () => {
  const NOW = Date.parse("2026-11-19T10:00:00Z");
  const h4 = { candles: Array.from({ length: 20 }, (_, i) => ({ close_time: new Date(NOW - (20 - i) * 14_400_000).toISOString(), close: 3700 + i })) };
  const r = referenceFrom({ price: 3734.1, marketMs: NOW - 120_000, h4, fallbackSince: null, now: NOW });
  assert.deepEqual([r.price, r.market_ms, r.closes.length, REFERENCE_H4_CLOSES], [3734.1, NOW - 120_000, 12, 12]);
  assert.deepEqual(r.closes.at(-1), [NOW - 14_400_000, 3719], "oldest first, the newest last");
  // The MT5 fallback: the feed's price after its start is the broker's own: no reference at all.
  assert.equal(referenceFrom({ price: 3734.1, marketMs: NOW - 60_000, h4, fallbackSince: NOW - 3_600_000, now: NOW }), null);
  // A price from before the fallback is still independent; its closes stop at the fallback's start.
  const before = referenceFrom({ price: 3734.1, marketMs: NOW - 8 * 3_600_000, h4, fallbackSince: NOW - 6 * 3_600_000, now: NOW });
  assert.ok(before.closes.every(([t]) => t <= NOW - 6 * 3_600_000));
  assert.equal(referenceFrom({ price: 0, marketMs: NOW, h4, now: NOW }), null);
});

test("G14. OmegaExecutor 1.20: a chosen symbol is checked again; choosing needs the price path; futures and ambiguous contracts refused", () => {
  assert.match(ea, /#property version\s+"1\.20"/);
  assert.match(ea, /if\(g_tradeSymbol != "" && GoldSymbolProblem\(g_tradeSymbol, g_refPrice > 0\.0, false\) == ""\)/, "re-checked against a fresh reference, kept without one");
  assert.match(ea, /if\(!checkPath\) return "";\s*return PricePathProblem\(sym\);/, "the price path decides a choice");
  assert.match(ea, /if\(MathAbs\(syms\[i\] \/ sN - g_refC\[i\] \/ rN\) > PATH_TOLERANCE\) return "price_path_mismatch";/);
  assert.match(ea, /if\(SymbolInfoInteger\(sym, SYMBOL_EXPIRATION_TIME\) > 0\) return "expiring_contract";/);
  assert.match(ea, /if\(best != "" && sizesDiffer\)\s*\{\s*lastProblem = "ambiguous_gold_symbols \(/);
  assert.match(ea, /bool fresh = price > 0\.0 && priceMs > 0 && nowMs - priceMs <= \(long\)REFERENCE_MAX_AGE_SEC \* 1000;/, "aged on the price's own time");
});
