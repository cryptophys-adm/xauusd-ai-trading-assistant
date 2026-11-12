// Synthetic bars for the chart-pattern tests: straight legs between turning points [bar, price].
// Each bar opens at the previous close; its high and low reach `wick` beyond the body.
export function path(points, { wick = 0.3, start = Date.parse("2026-11-02T00:00:00Z"), barMs = 3_600_000 } = {}) {
  const closes = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [i0, p0] = points[k], [i1, p1] = points[k + 1];
    for (let i = i0; i < i1; i++) closes[i] = p0 + (p1 - p0) * (i - i0) / (i1 - i0);
  }
  closes[points.at(-1)[0]] = points.at(-1)[1];
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, close_time: new Date(start + (i + 1) * barMs).toISOString() };
  });
}
/** Overrides single bars: { [index]: { high, low, close, open } }. */
export function withBars(bars, overrides) {
  return bars.map((b, i) => (overrides[i] ? { ...b, ...overrides[i] } : b));
}
