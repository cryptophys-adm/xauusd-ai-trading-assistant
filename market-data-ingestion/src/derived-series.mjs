// Locally derived series (owner decision 2026-11-05, TradingView MCP budget 800 a day).
//
// XAUUSD 5m and 15m are built from the XAUUSD 1m pull, and USOIL 15m and 1h from the
// USOIL 5m pull, instead of being pulled again. A derived bar is the standard OHLCV
// aggregation of its source bars: the first open, the highest high, the lowest low, the
// last close and the summed volume (null when any source volume is null).
//
// Rules:
//   - Buckets are aligned to epoch multiples of the interval (UTC), as TradingView's
//     intraday bars are.
//   - A bucket is emitted only when it is complete: it has ended, and the source has been
//     observed through its end. Either a source bar closes at or after the bucket end, or
//     the source was fetched at least one source interval after it (a quiet minute
//     produces no 1m bar).
//   - A bucket without any source bar (market closed) produces no bar, as on TradingView.
//   - History comes from the native series already cached. A derived series is pulled
//     natively only to bootstrap an empty cache or to fill a gap the source no longer
//     covers.
//   - Once a day the derived bars are compared with a small native pull
//     (verifyDerivedSeries), so a divergence from TradingView is visible.

const finite = (x) => typeof x === "number" && Number.isFinite(x);

/** Aggregates closed source candles into complete `spec.seconds` buckets opening after `after`. */
export function aggregateCandles(source, { seconds, sourceSeconds, nowSec, fetchedAtSec = -Infinity, after = -Infinity }) {
  const sorted = [...(source || [])].filter((c) => finite(c?.time)).sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];
  const observedThrough = Math.max(sorted.at(-1).time + sourceSeconds, finite(fetchedAtSec) ? fetchedAtSec - sourceSeconds : -Infinity);
  const buckets = new Map();
  for (const c of sorted) {
    const start = Math.floor(c.time / seconds) * seconds;
    if (start <= after) continue;
    const list = buckets.get(start) || [];
    list.push(c);
    buckets.set(start, list);
  }
  const out = [];
  for (const [start, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const end = start + seconds;
    if (end > nowSec || observedThrough < end) continue;
    const volumes = list.map((c) => c.volume);
    out.push({
      time: start,
      open_time: new Date(start * 1000).toISOString(),
      close_time: new Date(end * 1000).toISOString(),
      open: list[0].open,
      high: Math.max(...list.map((c) => c.high)),
      low: Math.min(...list.map((c) => c.low)),
      close: list.at(-1).close,
      volume: volumes.every(finite) ? volumes.reduce((s, v) => s + v, 0) : null
    });
  }
  return out;
}

/**
 * Whether the source can extend the derived series: the source must reach back to the
 * first missing bucket. Otherwise the gap needs a native pull.
 */
export function sourceCovers(derivedLast, source, seconds) {
  const first = source?.[0];
  if (!derivedLast || !first) return false;
  return first.time <= derivedLast.time + seconds;
}

const sameNumber = (a, b) => (a === null && b === null) || (finite(a) && finite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

/** Compares derived bars with native bars on their common closed open times. */
export function compareWithNative(derived, native) {
  const byTime = new Map((derived || []).map((c) => [c.time, c]));
  let compared = 0;
  const mismatches = [];
  for (const n of native || []) {
    const d = byTime.get(n.time);
    if (!d) continue;
    compared += 1;
    const fields = ["open", "high", "low", "close", "volume"].filter((k) => !sameNumber(d[k], n[k]));
    if (fields.length) mismatches.push({ open_time: n.open_time, fields, derived: Object.fromEntries(fields.map((k) => [k, d[k]])), native: Object.fromEntries(fields.map((k) => [k, n[k]])) });
  }
  return { compared, mismatched: mismatches.length, mismatches: mismatches.slice(0, 5) };
}
