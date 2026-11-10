// Micro-grid / order-book producer for the 5m lane (backlog B-04).
// Produces an `order_imbalance` value in [-1, 1] (positive = bid pressure,
// negative = ask pressure) from whatever micro-structure input is available:
// an order book ({ bids, asks }), a list of trades, or 5m bars. Never throws.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const qty = (x) => {
  if (Array.isArray(x)) return Number(x[1] ?? x[0] ?? 0);
  if (x && typeof x === "object") return Number(x.qty ?? x.size ?? x.volume ?? x.amount ?? x.q ?? 0);
  return Number(x) || 0;
};
const px = (x) => {
  if (Array.isArray(x)) return Number(x[0]);
  if (x && typeof x === "object") return Number(x.price ?? x.px ?? x.p ?? 0);
  return NaN;
};

/** Pure: imbalance from an order book with bids/asks (arrays of [price, qty] or objects). */
export function orderImbalanceFromBook(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : Array.isArray(book?.bid) ? book.bid : [];
  const asks = Array.isArray(book?.asks) ? book.asks : Array.isArray(book?.ask) ? book.ask : [];
  let bidVol = 0, askVol = 0;
  for (const b of bids) bidVol += Math.max(0, qty(b));
  for (const a of asks) askVol += Math.max(0, qty(a));
  const total = bidVol + askVol;
  if (!total) return null;
  return Math.max(-1, Math.min(1, (bidVol - askVol) / total));
}

/** Pure: imbalance from a list of trades ({ side/ aggressor, qty/volume }). */
export function orderImbalanceFromTrades(trades) {
  let buy = 0, sell = 0;
  for (const t of trades || []) {
    const q = Math.max(0, Number(t?.qty ?? t?.size ?? t?.volume ?? t?.amount ?? 0));
    const side = String(t?.side ?? t?.aggressor ?? t?.taker ?? "").toLowerCase();
    if (side.startsWith("b")) buy += q;
    else if (side.startsWith("s")) sell += q;
    else if (isNum(t?.price) && isNum(t?.mid)) { if (t.price >= t.mid) buy += q; else sell += q; }
  }
  const total = buy + sell;
  if (!total) return null;
  return Math.max(-1, Math.min(1, (buy - sell) / total));
}

/** Pure: imbalance from 5m bars: signed volume of up vs down bars (a micro proxy). */
export function orderImbalanceFromBars(bars) {
  let up = 0, down = 0;
  for (const b of bars || []) {
    const v = Math.max(0, Number(b?.v ?? b?.volume ?? b?.V ?? 0));
    const o = Number(b?.o ?? b?.open ?? b?.Open);
    const c = Number(b?.c ?? b?.close ?? b?.Close);
    if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
    if (c >= o) up += v; else down += v;
  }
  const total = up + down;
  if (!total) return null;
  return Math.max(-1, Math.min(1, (up - down) / total));
}

/** Pure: one entry point. Accepts a book, a context, bars, or a number. */
export function orderImbalance(input) {
  if (isNum(input)) return Math.max(-1, Math.min(1, input));
  if (!input) return null;
  if (isNum(input.order_imbalance)) return Math.max(-1, Math.min(1, input.order_imbalance));
  if (isNum(input.imbalance)) return Math.max(-1, Math.min(1, input.imbalance));
  if (Array.isArray(input.bids) || Array.isArray(input.asks) || Array.isArray(input.bid) || Array.isArray(input.ask)) {
    return orderImbalanceFromBook(input);
  }
  if (Array.isArray(input.trades)) return orderImbalanceFromTrades(input.trades);
  if (Array.isArray(input.recent_bars)) return orderImbalanceFromBars(input.recent_bars);
  if (Array.isArray(input.bars)) return orderImbalanceFromBars(input.bars);
  if (Array.isArray(input)) {
    // could be bars or trades
    if (input.length && (input[0]?.o !== undefined || input[0]?.open !== undefined || input[0]?.c !== undefined)) {
      return orderImbalanceFromBars(input);
    }
    return orderImbalanceFromTrades(input);
  }
  if (input.order_book || input.book || input.depth) {
    return orderImbalance(input.order_book || input.book || input.depth);
  }
  return null;
}

// Aliases / compatibility
export const computeOrderImbalance = orderImbalance;
export const buildOrderBookImbalance = orderImbalance;
export const microGridImbalance = orderImbalance;
export const orderBookImbalance = orderImbalance;

export default orderImbalance;
