// The one gold contract Omega may trade: XAU priced in USD (owner 2026-11-17, PR #405: "setuju", then "b").
//
// Broker servers name gold differently (FxPro "GOLD", Monex "XAUUSD.m"), and some list other gold contracts
// beside it: GOLDEURO (gold in euro), GOLDgr, XAUAUD. A name match alone once let the EA take any symbol that
// started with GOLD or XAUUSD, and fall back to a symbol without a price or to the chart symbol. Now a symbol
// counts only when:
//   1. its name is one of GOLD_USD_SYMBOLS exactly (no prefix, substring or case-folded match);
//   2. its profit currency is USD;
//   3. its contract size is GOLD_CONTRACT_SIZE_MIN to GOLD_CONTRACT_SIZE_MAX troy ounces a lot;
//   4. the EA reported no symbol_error for it.
// Anything else is refused: no new entries (planIntents gate "symbol_unverified"), the Omega page and the
// health report say why, and a health alert opens. Open positions keep their management and can be closed.
//
// The same list is in ea/mt5/OmegaExecutor.mq5 (GOLD_USD_SYMBOLS) and bridge/omega-bridge/src/symbols.mjs
// (GOLD_SYMBOL_CANDIDATES); test/gold-symbol.test.mjs keeps the three equal.

export const GOLD_USD_SYMBOLS = Object.freeze([
  "XAUUSD", "GOLD", "XAUUSD.m", "XAUUSDm",
  "XAUUSD.s", "XAUUSD.v", "XAUUSD.pro", "XAUUSD.r",
  "XAUUSD.ecn", "XAUUSDc", "XAUUSDz", "GOLD.m", "GOLDm",
]);
export const GOLD_CONTRACT_SIZE_MIN = 1;
export const GOLD_CONTRACT_SIZE_MAX = 100;

const ALLOWED = new Set(GOLD_USD_SYMBOLS);

/**
 * Pure: whether a reported symbol is USD gold. `sym` is the executor's symbol block (name, currency_profit,
 * contract_size); `symbolError` the EA's own refusal, if any. Returns { ok, problem } with problem one of
 * symbol_error:<reason>, no_symbol, name_not_allowed, currency_not_reported, profit_currency_not_usd,
 * contract_size_not_reported, contract_size_out_of_range; null when ok.
 */
export function goldSymbolCheck(sym, symbolError = null) {
  if (typeof symbolError === "string" && symbolError) return { ok: false, problem: `symbol_error:${symbolError.slice(0, 96)}` };
  const name = typeof sym?.name === "string" ? sym.name : "";
  if (!name) return { ok: false, problem: "no_symbol" };
  if (!ALLOWED.has(name)) return { ok: false, problem: "name_not_allowed" };
  if (typeof sym?.currency_profit !== "string" || !sym.currency_profit) return { ok: false, problem: "currency_not_reported" };
  if (sym.currency_profit !== "USD") return { ok: false, problem: "profit_currency_not_usd" };
  const size = sym?.contract_size;
  if (typeof size !== "number" || !Number.isFinite(size)) return { ok: false, problem: "contract_size_not_reported" };
  if (size < GOLD_CONTRACT_SIZE_MIN || size > GOLD_CONTRACT_SIZE_MAX) return { ok: false, problem: "contract_size_out_of_range" };
  return { ok: true, problem: null };
}

/** Pure: a readable line for the Omega page and the health alert. */
export function goldSymbolText(check, sym) {
  if (check?.ok) return `${sym?.name} (USD, ${sym?.contract_size} oz a lot)`;
  const name = typeof sym?.name === "string" && sym.name ? sym.name : "no symbol";
  const why = {
    no_symbol: "the EA found no USD gold symbol on this server",
    name_not_allowed: "the name is not on the USD gold list",
    currency_not_reported: "the EA did not report the profit currency (OmegaExecutor 1.14 or later needed)",
    profit_currency_not_usd: `its profit currency is ${sym?.currency_profit}, not USD`,
    contract_size_not_reported: "the EA did not report the contract size (OmegaExecutor 1.14 or later needed)",
    contract_size_out_of_range: `its contract size ${sym?.contract_size} is outside ${GOLD_CONTRACT_SIZE_MIN}-${GOLD_CONTRACT_SIZE_MAX} oz`,
  }[check?.problem] ?? String(check?.problem ?? "refused").replace(/^symbol_error:/, "the EA refused it: ").replace(/_/g, " ");
  return `${name} refused: ${why}. No new entries.`;
}
