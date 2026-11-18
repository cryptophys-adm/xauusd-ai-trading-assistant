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
// Cent accounts (owner 2026-11-18, "Setuju"): some servers name gold off the list (e.g. "GoldOne") and some accounts
// are in US cents (USC). The owner may set the account's gold symbol with the connection (Setup → Connection & EA):
// that one exact name then counts as well, under the same contract checks, and on a cent account a profit currency of
// USC (US cents) passes beside USD. An owner-set name off the list must also price within MAPPED_PRICE_TOLERANCE of the
// reference gold price before any entry (omega-engine gate "symbol_price_mismatch"): a name alone never proves gold.
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

export const MAPPED_PRICE_TOLERANCE = 0.02;
// The symbol name the owner may set: what MT5 allows in a symbol name, at most 32 characters.
export const TRADE_SYMBOL_RE = /^[A-Za-z0-9._#+-]{1,32}$/;

const ALLOWED = new Set(GOLD_USD_SYMBOLS);

/**
 * Pure: whether an account currency is US cents: "USC" (some servers write "USc") or "USX" (FxPro's GoldOne cent
 * account, 2026-11-18: a balance of 5450 USX was $54.50).
 */
export const CENT_CURRENCIES = Object.freeze(["USC", "USX"]);
export const isCentCurrency = (c) => typeof c === "string" && CENT_CURRENCIES.includes(c.trim().toUpperCase());

/** Pure: the owner-set trade symbol, or null when none or malformed. */
export function ownerTradeSymbol(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return TRADE_SYMBOL_RE.test(s) ? s : null;
}

/** Pure: whether `name` is on the USD gold list (false for an owner-set name off it). */
export const onGoldList = (name) => ALLOWED.has(name);

/**
 * Pure: whether a reported symbol is USD gold. `sym` is the executor's symbol block (name, currency_profit,
 * contract_size); `symbolError` the EA's own refusal, if any; `ownerSymbol` the name the owner set with the connection
 * (also allowed, exactly); `cent` whether the account is in US cents (then a USC profit currency passes too).
 * Returns { ok, problem } with problem one of
 * symbol_error:<reason>, no_symbol, name_not_allowed, currency_not_reported, profit_currency_not_usd,
 * contract_size_not_reported, contract_size_out_of_range; null when ok.
 */
export function goldSymbolCheck(sym, symbolError = null, { ownerSymbol = null, cent = false } = {}) {
  if (typeof symbolError === "string" && symbolError) return { ok: false, problem: `symbol_error:${symbolError.slice(0, 96)}` };
  const name = typeof sym?.name === "string" ? sym.name : "";
  if (!name) return { ok: false, problem: "no_symbol" };
  const owner = ownerTradeSymbol(ownerSymbol);
  if (!ALLOWED.has(name) && name !== owner) return { ok: false, problem: "name_not_allowed" };
  if (typeof sym?.currency_profit !== "string" || !sym.currency_profit) return { ok: false, problem: "currency_not_reported" };
  if (sym.currency_profit !== "USD" && !(cent && isCentCurrency(sym.currency_profit))) return { ok: false, problem: "profit_currency_not_usd" };
  const size = sym?.contract_size;
  if (typeof size !== "number" || !Number.isFinite(size)) return { ok: false, problem: "contract_size_not_reported" };
  if (size < GOLD_CONTRACT_SIZE_MIN || size > GOLD_CONTRACT_SIZE_MAX) return { ok: false, problem: "contract_size_out_of_range" };
  return { ok: true, problem: null };
}

/** Pure: goldSymbolCheck on a stored executor state, with its owner-set symbol and cent flag. */
export function goldCheckOf(st) {
  return goldSymbolCheck(st?.symbol, st?.symbol_error ?? null, { ownerSymbol: st?.owner_symbol ?? null, cent: st?.account?.cent === true });
}

/**
 * Pure: why an owner-set symbol off the list does not price as gold, or null. Its bid must lie within
 * MAPPED_PRICE_TOLERANCE of the reference price (the signal's entry); with no bid or no reference it is refused.
 */
export function mappedPriceProblem(sym, reference) {
  if (!sym?.name || onGoldList(sym.name)) return null;
  const bid = sym?.bid;
  if (typeof bid !== "number" || !(bid > 0) || typeof reference !== "number" || !(reference > 0)) return "mapped_price_unverified";
  return Math.abs(bid - reference) / reference <= MAPPED_PRICE_TOLERANCE ? null : "mapped_price_mismatch";
}

/** Pure: a readable line for the Omega page and the health alert. */
export function goldSymbolText(check, sym) {
  if (check?.ok) return `${sym?.name} (USD, ${sym?.contract_size} oz a lot)`;
  const name = typeof sym?.name === "string" && sym.name ? sym.name : "no symbol";
  const why = {
    no_symbol: "the EA found no USD gold symbol on this server",
    name_not_allowed: "the name is not on the USD gold list (set the account's gold symbol in Setup → Connection & EA)",
    currency_not_reported: "the EA did not report the profit currency (OmegaExecutor 1.14 or later needed)",
    profit_currency_not_usd: `its profit currency is ${sym?.currency_profit}, not USD`,
    contract_size_not_reported: "the EA did not report the contract size (OmegaExecutor 1.14 or later needed)",
    contract_size_out_of_range: `its contract size ${sym?.contract_size} is outside ${GOLD_CONTRACT_SIZE_MIN}-${GOLD_CONTRACT_SIZE_MAX} oz`,
  }[check?.problem] ?? String(check?.problem ?? "refused").replace(/^symbol_error:/, "the EA refused it: ").replace(/_/g, " ");
  return `${name} refused: ${why}. No new entries.`;
}
