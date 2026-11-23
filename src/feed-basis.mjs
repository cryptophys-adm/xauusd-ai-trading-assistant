// The broker's basis against the TradingView feed (moved from src/ea-signal.mjs for B8, which re-exports it): pure,
// no I/O, so a read view (src/liquidity-view.mjs) can put a broker price on the feed's scale without loading the
// signal's module. The function is the one eaSignal calls, unchanged.

const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Pure: the broker's price minus the feed's, the median over the feed's closed 5m bars matched with the
 * broker's M1 bar closing at the same minute (at least 3 of them), or null. Omega moves the key levels,
 * which are on the feed's scale, onto the broker's with it.
 */
export function feedBasis(brokerM1 = [], feedCandles = []) {
  const closeAt = new Map((brokerM1 || []).filter((b) => Number.isFinite(b?.t) && isPrice(b?.c)).map((b) => [b.t + 60_000, b.c]));
  const offs = (feedCandles || []).map((c) => ({ ms: Date.parse(String(c?.close_time ?? "")), close: c?.close })).filter((c) => Number.isFinite(c.ms) && isPrice(c.close) && closeAt.has(c.ms)).map((c) => closeAt.get(c.ms) - c.close).sort((a, b) => a - b);
  if (offs.length < 3) return null;
  const mid = Math.floor(offs.length / 2);
  const median = offs.length % 2 ? offs[mid] : (offs[mid - 1] + offs[mid]) / 2;
  return Math.round(median * 100) / 100;
}
