/**
 * The candidate key-level zones shown beside price (owner 2026-11-11: listed by price; owner 2026-11-12: the same
 * zones on the Omega chart). One selection for the War Room panel and the Omega chart, so both show the same six.
 * The zones are the Key Level Agent's, on the feed's prices (OANDA via TradingView), from GET /api/conclusion/global
 * → strategy.key_levels.
 */
export interface KeyZone { low: number; high: number; price?: number; role?: string; strength?: string; [k: string]: unknown }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ref = (z: KeyZone) => (isNum(z.price) ? z.price : (z.low + z.high) / 2);

/** The `n` candidates nearest to price, highest first; [] without a price. */
export function nearestCandidates(k: any, n = 6): KeyZone[] {
  if (!k || !isNum(k.price)) return [];
  const price = k.price as number;
  return ((k.candidates ?? []) as KeyZone[])
    .filter((z) => z && isNum(z.low) && isNum(z.high))
    .slice()
    .sort((a, b) => Math.abs(ref(a) - price) - Math.abs(ref(b) - price))
    .slice(0, n)
    .sort((a, b) => b.high - a.high || b.low - a.low);
}

/** "#rrggbb" at an alpha, for a line's strength. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
