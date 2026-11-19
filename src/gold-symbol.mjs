// The one instrument Omega may trade: gold priced in US dollars, on ANY broker, whatever the broker names it and
// whatever server it runs on (owner 2026-11-19: "Harusnya bisa universal apapun broker, nama pair maupun servernya").
//
// Nothing here depends on a name. Until 2026-11-19 a symbol counted only when its name was on a list of 13 gold
// names (XAUUSD, GOLD, XAUUSD.m, ...) kept in three places, a cent account only when its currency was USC or USX, and
// a broker whose gold had another name needed the owner to type it. Now the instrument and the account are identified
// by what the terminal reports, and anything that cannot be verified is refused with a reason:
//   1. the instrument: its profit currency is USD (gold priced in another currency is another instrument), its
//      contract is 1 to 100 troy ounces a lot, the EA reported no problem with it, and its price lies within
//      GOLD_PRICE_TOLERANCE of the reference gold price (goldPriceProblem). The price is what tells gold from silver,
//      gold in euro (GOLDEURO), gold in grams (GOLDgr) or gold in another currency (XAUAUD): a name never did.
//   2. the account's money (accountMoney): how many units of the account currency make one US dollar. "USD" is one by
//      definition (ISO 4217); any other currency is MEASURED from the account's own trades (a position's or a closed
//      deal's profit against its price move, volume and contract: profit = move x volume x contract x units per USD),
//      or, before the account has traded, taken from the value the owner gave with the connection; the broker's tick
//      value is never trusted for it (2026-11-18: GoldOne reported a tick value in dollars on a cent account). A
//      measurement that disagrees with "USD" or with the owner's value by more than MONEY_TOLERANCE, or no value at
//      all, opens nothing (gate money_unverified).
// Open positions keep their management and can always be closed; only new entries are refused.

export const GOLD_CONTRACT_SIZE_MIN = 1;
export const GOLD_CONTRACT_SIZE_MAX = 100;
// The instrument's price against the reference gold price (the signal's entry): within 2%.
export const GOLD_PRICE_TOLERANCE = 0.02;
// A measured account-money ratio against "USD" or the owner's value: within 5%.
export const MONEY_TOLERANCE = 0.05;
// The symbol name the owner may set (optional, a hint only): what MT5 allows in a symbol name, at most 32 characters.
export const TRADE_SYMBOL_RE = /^[A-Za-z0-9._#+-]{1,32}$/;

/**
 * Deals stored before #461 (2026-11-18) kept the cent account's currency and amounts in cents; deals stored since are
 * in USD. Only these two currency codes were ever stored that way, so this list describes old rows, not brokers: no
 * new row is written in a currency other than USD (toUsd).
 */
const LEGACY_CENT_DEAL_CURRENCIES = Object.freeze(["USC", "USX"]);
export const isLegacyCentDeal = (c) => typeof c === "string" && LEGACY_CENT_DEAL_CURRENCIES.includes(c.trim().toUpperCase());

/**
 * SQL for an ea_deals row's money in USD (owner 2026-11-18, "perbaiki deal"): a deal stored before the cent fix (#461)
 * kept the account's cent currency (USX, USC) and its amounts in cents; deals stored since are in USD with currency
 * "USD". Readers that add up money select `${DEAL_PROFIT_SQL} AS profit` etc. so both read in USD.
 */
const DEAL_IS_CENT_SQL = `UPPER(TRIM(COALESCE(currency, ''))) IN (${LEGACY_CENT_DEAL_CURRENCIES.map((c) => `'${c}'`).join(", ")})`;
const inUsd = (expr) => `(CASE WHEN ${DEAL_IS_CENT_SQL} THEN (${expr}) / 100.0 ELSE (${expr}) END)`;
export const DEAL_PROFIT_SQL = inUsd("profit");
export const DEAL_COMMISSION_SQL = inUsd("commission");
export const DEAL_SWAP_SQL = inUsd("swap");
export const DEAL_MONEY_COLUMNS_SQL = `${DEAL_PROFIT_SQL} AS profit, ${DEAL_COMMISSION_SQL} AS commission, ${DEAL_SWAP_SQL} AS swap`;
export const DEAL_NET_SQL = inUsd("COALESCE(profit, 0) + COALESCE(commission, 0) + COALESCE(swap, 0)");

/**
 * Pure: a position's exposure in USD (owner 2026-11-18, "baris eksposur"), so a lot is never ambiguous across brokers
 * and cent accounts: `usd_per_dollar` (what a $1 move in gold does), `risk_at_sl_usd` and `risk_at_sl_pct` of equity
 * (null without a stop on the loss side). Only for a USD-profit symbol with a known contract size; else null.
 */
export function positionExposure(p, sym, equity) {
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  if (!p || !sym || sym.currency_profit !== "USD" || !fin(sym.contract_size) || !(sym.contract_size > 0) || !fin(p.volume) || !(p.volume > 0)) return null;
  const perDollar = Math.round(p.volume * sym.contract_size * 1e6) / 1e6;
  const lossSide = fin(p.sl) && p.sl > 0 && fin(p.open_price) && ((p.side === "BUY" && p.sl < p.open_price) || (p.side === "SELL" && p.sl > p.open_price));
  const risk = lossSide ? Math.round(Math.abs(p.open_price - p.sl) * perDollar * 100) / 100 : null;
  const pct = risk != null && fin(equity) && equity > 0 ? Math.round((risk / equity) * 1000) / 10 : null;
  return { usd_per_dollar: perDollar, risk_at_sl_usd: risk, risk_at_sl_pct: pct };
}

/** Pure: the exposure as one line, e.g. "≈ $3 per $1 move · risk at SL $44.91 (82.4%)". */
export function exposureText(x) {
  if (!x) return "";
  const usd = (v) => `$${Number(v.toFixed(2))}`;
  return `≈ ${usd(x.usd_per_dollar)} per $1 move${x.risk_at_sl_usd != null ? ` · risk at SL ${usd(x.risk_at_sl_usd)}${x.risk_at_sl_pct != null ? ` (${x.risk_at_sl_pct}%)` : ""}` : " · no stop on the loss side"}`;
}

/** Pure: the owner-set trade symbol (a hint the EA tries first, under the same checks), or null when none or malformed. */
export function ownerTradeSymbol(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return TRADE_SYMBOL_RE.test(s) ? s : null;
}

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/**
 * Pure: the account units per US dollar measured from its own trades on a USD-priced instrument, or null. Each open
 * position (profit against the move from its open price to the price it would close at) and each closed deal
 * (profit against the move from entry to exit) gives profit / (move x volume x contract). Only moves of at least
 * 50 ticks count (a small move is mostly spread); the median of the latest eight is kept.
 */
export function measuredUnitsPerUsd({ positions = [], deals = [], symbol = null } = {}) {
  const contract = symbol?.contract_size, tick = fin(symbol?.tick_size) && symbol.tick_size > 0 ? symbol.tick_size : 0.01;
  if (!fin(contract) || !(contract > 0) || symbol?.currency_profit !== "USD") return null;
  const ratios = [];
  const add = (side, from, to, volume, profit) => {
    if (!fin(from) || !fin(to) || !fin(volume) || !(volume > 0) || !fin(profit) || profit === 0) return;
    const move = side === "BUY" ? to - from : side === "SELL" ? from - to : NaN;
    if (!fin(move) || Math.abs(move) < 50 * tick) return;
    const r = profit / (move * volume * contract);
    if (fin(r) && r > 0) ratios.push(r);
  };
  for (const p of Array.isArray(positions) ? positions : []) {
    if (p?.symbol && symbol?.name && p.symbol !== symbol.name) continue;
    add(p?.side, p?.open_price, p?.side === "BUY" ? symbol?.bid : symbol?.ask, p?.volume, p?.profit);
  }
  for (const d of Array.isArray(deals) ? deals : []) {
    if (d?.symbol && symbol?.name && d.symbol !== symbol.name) continue;
    add(d?.side, d?.entry_price, d?.exit_price, d?.volume, d?.profit);
  }
  if (!ratios.length) return null;
  return { units_per_usd: Math.round(median(ratios.slice(0, 8)) * 1e6) / 1e6, samples: Math.min(ratios.length, 8) };
}

/**
 * Pure: the account's money as Omega reads it: { currency, units_per_usd, source, problem }. source is "usd" (the
 * account currency is USD), "measured" (its own trades), "owner_verified" (the owner's value, which the trades confirm),
 * "owner" (the value the owner gave, until a trade measures
 * it) or null; problem is null, "money_unverified" (no value) or "money_mismatch" (a measurement disagrees).
 */
/** Pure: a measured ratio within 1% of 10^n (n = -3..6) is exactly 10^n; any other ratio (a currency's rate) is kept. */
export function snapPowerOfTen(v) {
  if (!fin(v) || !(v > 0)) return v;
  const p = 10 ** Math.round(Math.log10(v));
  return Math.abs(v - p) <= p * 0.01 && p >= 1e-3 && p <= 1e6 ? p : v;
}

export function accountMoney({ currency, positions = [], deals = [], symbol = null, ownerUnitsPerUsd = null } = {}) {
  const cur = typeof currency === "string" ? currency.trim() : "";
  const measured = measuredUnitsPerUsd({ positions, deals, symbol });
  const off = (a, b) => Math.abs(a - b) > b * MONEY_TOLERANCE;
  const owner = fin(ownerUnitsPerUsd) && ownerUnitsPerUsd > 0 ? ownerUnitsPerUsd : null;
  if (cur.toUpperCase() === "USD") {
    if (measured && off(measured.units_per_usd, 1)) return { currency: cur, units_per_usd: 1, source: "usd", measured: measured.units_per_usd, problem: "money_mismatch" };
    return { currency: cur, units_per_usd: 1, source: "usd", measured: measured?.units_per_usd ?? null, problem: null };
  }
  if (measured) {
    if (owner && off(measured.units_per_usd, owner)) return { currency: cur || null, units_per_usd: measured.units_per_usd, source: "measured", owner, problem: "money_mismatch" };
    // Converted with an exact number (orchestrator review of #477): the owner's value when the measurement agrees with it
    // (the measurement verifies, the declared value converts); otherwise a measurement within 1% of a power of ten is
    // that power (a cent account is 100 by construction, a median of 99.7 would scale every amount by 0.3%).
    if (owner) return { currency: cur || null, units_per_usd: owner, source: "owner_verified", measured: measured.units_per_usd, samples: measured.samples, problem: null };
    return { currency: cur || null, units_per_usd: snapPowerOfTen(measured.units_per_usd), source: "measured", measured: measured.units_per_usd, samples: measured.samples, problem: null };
  }
  if (owner) return { currency: cur || null, units_per_usd: owner, source: "owner", problem: null };
  return { currency: cur || null, units_per_usd: null, source: null, problem: "money_unverified" };
}

/**
 * Pure: whether a reported symbol is gold Omega may trade. `sym` is the executor's symbol block; `symbolError` the EA's
 * own refusal, if any. No name is checked. Returns { ok, problem } with problem one of symbol_error:<reason>,
 * no_symbol, currency_not_reported, profit_currency_not_usd, contract_size_not_reported, contract_size_out_of_range;
 * null when ok. The price (goldPriceProblem) and the account's money (accountMoney) are checked beside it.
 */
export function goldSymbolCheck(sym, symbolError = null) {
  if (typeof symbolError === "string" && symbolError) return { ok: false, problem: `symbol_error:${symbolError.slice(0, 200)}` };
  const name = typeof sym?.name === "string" ? sym.name : "";
  if (!name) return { ok: false, problem: "no_symbol" };
  if (typeof sym?.currency_profit !== "string" || !sym.currency_profit) return { ok: false, problem: "currency_not_reported" };
  if (sym.currency_profit !== "USD") return { ok: false, problem: "profit_currency_not_usd" };
  const size = sym?.contract_size;
  if (typeof size !== "number" || !Number.isFinite(size)) return { ok: false, problem: "contract_size_not_reported" };
  if (size < GOLD_CONTRACT_SIZE_MIN || size > GOLD_CONTRACT_SIZE_MAX) return { ok: false, problem: "contract_size_out_of_range" };
  return { ok: true, problem: null };
}

/** Pure: goldSymbolCheck on a stored executor state. */
export function goldCheckOf(st) {
  return goldSymbolCheck(st?.symbol, st?.symbol_error ?? null);
}

/**
 * Pure: why the instrument does not price as gold, or null. Its bid must lie within GOLD_PRICE_TOLERANCE of the
 * reference gold price (the signal's entry); with no bid or no reference it is refused. Every symbol, whatever its name.
 */
export function goldPriceProblem(sym, reference) {
  const bid = sym?.bid;
  if (!fin(bid) || !(bid > 0) || !fin(reference) || !(reference > 0)) return "symbol_price_unverified";
  return Math.abs(bid - reference) / reference <= GOLD_PRICE_TOLERANCE ? null : "symbol_price_mismatch";
}

/** Pure: a readable line for the Omega page and the health alert. */
/**
 * Pure: the EA's refusal in words. OmegaExecutor 1.20 refuses to pick between gold symbols with different contracts
 * ("ambiguous_gold_symbols (GOLD:100,GoldOne:1): ..."): the names and contracts are shown as reported, so the owner knows
 * what to type; reason codes are spelled out, symbol names are never altered.
 */
export function eaRefusalText(problem) {
  const p = String(problem).replace(/^symbol_error:/, "");
  const amb = p.match(/ambiguous_gold_symbols \(([^)]*)\)/);
  if (amb) {
    const list = amb[1].split(",").filter(Boolean).map((x) => { const [n, c] = x.split(":"); return `${n} (${c} oz)`; }).join(", ");
    return `several symbols on this server are gold priced in USD with different contracts: ${list}. Name the account's gold symbol with the connection (Setup, Connection & EA)`;
  }
  const words = { no_usd_gold_symbol: "no gold priced in USD found", no_reference_price: "no reference gold price yet (the server sends none while its feed runs on this broker's bars)",
    price_not_gold: "its price is not gold's", price_path_mismatch: "its past prices do not follow gold's", no_history: "its price history is still loading",
    expiring_contract: "it is a contract with an expiry, not spot gold", no_reference_path: "no past reference prices yet" };
  return `the EA refused it: ${p.replace(/\b(no_usd_gold_symbol|no_reference_price|price_not_gold|price_path_mismatch|no_history|expiring_contract|no_reference_path)\b/g, (w) => words[w])}`;
}

export function goldSymbolText(check, sym) {
  if (check?.ok) return `${sym?.name} (USD, ${sym?.contract_size} oz a lot)`;
  const name = typeof sym?.name === "string" && sym.name ? sym.name : "no symbol";
  const why = {
    no_symbol: "the EA found no gold priced in USD on this server",
    currency_not_reported: "the EA did not report the profit currency (OmegaExecutor 1.14 or later needed)",
    profit_currency_not_usd: `its profit currency is ${sym?.currency_profit}, not USD`,
    contract_size_not_reported: "the EA did not report the contract size (OmegaExecutor 1.14 or later needed)",
    contract_size_out_of_range: `its contract size ${sym?.contract_size} is outside ${GOLD_CONTRACT_SIZE_MIN}-${GOLD_CONTRACT_SIZE_MAX} oz`,
  }[check?.problem] ?? eaRefusalText(String(check?.problem ?? "refused"));
  return `${name} refused: ${why}. No new entries.`;
}

/** Pure: a readable line for the account's money, e.g. "USX: 100 a dollar (measured from 3 trades)". */
export function moneyText(m) {
  if (!m) return "";
  if (m.problem === "money_unverified") return `${m.currency ?? "The account currency"} is not USD and the account has no trade yet to measure it against the dollar: set its value with the connection (e.g. 100 for a cent account). No new entries.`;
  if (m.problem === "money_mismatch") return `${m.currency}: the account's trades measure ${m.measured ?? m.units_per_usd} a dollar, not ${m.source === "usd" ? 1 : m.owner}. No new entries.`;
  if (m.source === "usd") return "USD";
  const how = m.source === "measured" ? `measured from ${m.samples ?? "its"} trades`
    : m.source === "owner_verified" ? `the owner's value, confirmed by ${m.samples ?? "its"} trades` : "the owner's value, until a trade measures it";
  return `${m.currency}: ${m.units_per_usd} a dollar (${how})`;
}

/**
 * The reference OmegaExecutor finds gold by (orchestrator review of #477): the feed's last 5-minute close and its time,
 * and its last REFERENCE_H4_CLOSES closed 4-hour closes ([close_ms, close], oldest first) for the EA's price-path check.
 * Null while the feed runs on the broker's own bars (the MT5 fallback, `fallbackSinceMs`): a broker is never checked
 * against itself. Pure: `h4` is the cached 4h series ({ candles }), `fallbackSince` the fallback's start or null.
 */
export const REFERENCE_H4_CLOSES = 12;
// `excluded`: [from_ms, to_ms] intervals the feed ran on the broker's bars (the last recorded MT5 fallback, until the
// series is healed from TradingView): a 4h bar overlapping one is the broker's own and is left out.
export function referenceFrom({ price, marketMs = null, h4 = null, fallbackSince = null, excluded = [], now = Date.now() } = {}) {
  const p = Number(price), at = Number(marketMs);
  if (!(p > 0)) return null;
  if (fallbackSince != null && (!(at > 0) || at > fallbackSince)) return null;
  const spans = (Array.isArray(excluded) ? excluded : []).filter((x) => Array.isArray(x) && Number(x[0]) > 0).map(([a, b]) => [Number(a), Number(b) > 0 ? Number(b) : now]);
  if (spans.some(([a, b]) => at > 0 && at > a && at <= b + 300_000)) return null;
  const closes = (Array.isArray(h4?.candles) ? h4.candles : [])
    .map((c) => [Date.parse(c?.close_time), Number(c?.close)])
    .filter(([t, c]) => Number.isFinite(t) && t <= now && c > 0 && (fallbackSince == null || t <= fallbackSince)
      && !spans.some(([a, b]) => t > a && t - 14_400_000 < b))
    .sort((a, b) => a[0] - b[0]).slice(-REFERENCE_H4_CLOSES);
  return { price: p, market_ms: at > 0 ? at : null, closes };
}
