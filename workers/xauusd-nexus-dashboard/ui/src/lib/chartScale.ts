/**
 * Scales and ticks for the Performance equity and drawdown charts (owner-approved mockup "Nexus data states",
 * part B, 2026-11-22): pure functions, no React and no imports, so test/nexus-perf-charts.test.mjs runs them in Node.
 *
 * - y: R ticks on clean steps (1, 2 or 5 × 10^k), always through 0;
 * - x: close time, ticks at 00:00 UTC: Mondays, every 2nd or 4th Monday when they would crowd, days in a short window;
 * - equity: a step line that starts at 0 at the window start and moves only at a close;
 * - peak and drawdown as the ledger counts them (src/signal-ledger.mjs performance: the peak starts at 0).
 */

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
/** The minus sign, not the hyphen, in printed values. */
const MINUS = "−";

/** A clean step for `span` in about `maxTicks` intervals: 1, 2 or 5 × 10^k (0.5R, 1R, 2R, 5R, 10R …). */
export function niceStep(span: number, maxTicks = 5): number {
  const raw = Math.abs(span) / Math.max(1, maxTicks);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return round(m * mag);
}

/**
 * The domain and ticks for values `lo`..`hi`, widened to include 0 and snapped outward to the step. An empty or
 * one-sided span still gets one step, so a flat line sits on a labelled axis.
 */
export function niceTicks(lo: number, hi: number, maxTicks = 5): { lo: number; hi: number; step: number; ticks: number[] } {
  let a = Math.min(0, lo, hi), b = Math.max(0, lo, hi);
  if (!(b - a > 1e-9)) { if (a < 0) b = 0; else b = a + 1; }
  const step = niceStep(b - a, maxTicks);
  const nlo = round(Math.floor(a / step + 1e-9) * step), nhi = round(Math.ceil(b / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) ticks.push(round(v) === 0 ? 0 : round(v));
  return { lo: nlo, hi: nhi, step, ticks };
}

/** Day strides the time axis may use; 7 and its multiples sit on Mondays. */
const STRIDES = [1, 2, 7, 14, 28];

/**
 * Ticks at 00:00 UTC between `startMs` and `endMs` for a plot `widthPx` wide, at least `minPx` apart: every day, every
 * 2nd day, every Monday, every 2nd or 4th Monday (counted from the first Monday in the window).
 */
export function utcDayTicks(startMs: number, endMs: number, widthPx: number, minPx = 64): { stride: number; ticks: number[] } {
  if (!(endMs > startMs) || !(widthPx > 0)) return { stride: 7, ticks: [] };
  const pxPerDay = (widthPx * DAY) / (endMs - startMs);
  const stride = STRIDES.find((s) => s * pxPerDay >= minPx) ?? STRIDES[STRIDES.length - 1];
  const first = Math.ceil(startMs / DAY) * DAY;
  const ticks: number[] = [];
  if (stride < 7) {
    for (let t = first; t <= endMs; t += DAY) if (Math.round(t / DAY) % stride === 0) ticks.push(t);
  } else {
    // 1970-01-01 was a Thursday: day n is a Monday when (n + 3) % 7 === 0.
    let t = first;
    while ((Math.round(t / DAY) + 3) % 7 !== 0) t += DAY;
    for (; t <= endMs; t += stride * DAY) ticks.push(t);
  }
  return { stride, ticks };
}

/** "Nov 16" (UTC). */
export function utcDayLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())}`;
}

/** "Nov 11 08:12 UTC". */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${utcDayLabel(ms)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** "15:12 local", with the local date when it is not the UTC date ("Nov 12 01:12 local"). */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getDate() === d.getUTCDate() && d.getMonth() === d.getUTCMonth();
  return `${sameDay ? "" : `${MONTHS[d.getMonth()]} ${two(d.getDate())} `}${hm} local`;
}

/** An axis label in R: "0", "+2R", "−2R", "+0.5R". */
export function rTick(v: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  return `${v > 0 ? "+" : MINUS}${round(Math.abs(v))}R`;
}

/** A value in R with two decimals: "+2.70R", "−1.80R", "0.00R". */
export function rValue(v: number): string {
  const a = Math.abs(v).toFixed(2);
  if (a === "0.00") return "0.00R";
  return `${v > 0 ? "+" : MINUS}${a}R`;
}

export type EquityIn = { t: string | number; r: number; id?: string };
export type EquityRow = { t: number; r: number; trade: number; peak: number; dd: number; id: string };

/**
 * The ledger's points (cumulative R at each close) with close time in ms, the trade's own R, the running peak
 * (from 0, as the ledger counts it) and the drawdown from that peak (≤ 0). Points without a time are dropped; the
 * rest are sorted by close time.
 */
export function equityRows(points: EquityIn[]): EquityRow[] {
  const rows = points
    .map((p) => ({ t: typeof p.t === "number" ? p.t : Date.parse(String(p.t)), r: Number(p.r), id: p.id ?? "" }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.r))
    .sort((a, b) => a.t - b.t);
  let peak = 0, prev = 0;
  return rows.map((p) => {
    peak = Math.max(peak, p.r);
    const row = { t: p.t, r: p.r, trade: round(p.r - prev), peak, dd: round(p.r - peak), id: p.id };
    prev = p.r;
    return row;
  });
}

/**
 * The vertices of a step line in data space: from `v0` at `startMs`, then at each point's time first the old
 * value and then the new one, held to `endMs`. `values[i]` belongs to `times[i]` (sorted).
 */
export function stepPoints(times: number[], values: number[], startMs: number, endMs: number, v0 = 0): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [{ t: startMs, v: v0 }];
  let cur = v0;
  for (let i = 0; i < times.length; i++) {
    out.push({ t: times[i], v: cur });
    cur = values[i];
    out.push({ t: times[i], v: cur });
  }
  out.push({ t: Math.max(endMs, times[times.length - 1] ?? endMs), v: cur });
  return out;
}

/** An SVG path ("M x,y H x V y …") through step vertices already in pixels. */
export function stepPath(pts: { x: number; y: number }[]): string {
  if (!pts.length) return "";
  let d = `M${f1(pts[0].x)},${f1(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = pts[i - 1];
    if (p.x !== q.x) d += `H${f1(p.x)}`;
    if (p.y !== q.y) d += `V${f1(p.y)}`;
  }
  return d;
}

/** The index of the deepest drawdown (the first, when it repeats); -1 when the curve never fell below its peak. */
export function maxDrawdownIndex(dds: number[]): number {
  let at = -1, min = 0;
  for (let i = 0; i < dds.length; i++) if (dds[i] < min - 1e-9) { min = dds[i]; at = i; }
  return at;
}

/** The index of the time in sorted `times` nearest to `t` (the earlier one on a tie); -1 for none. */
export function nearestIndex(times: number[], t: number): number {
  if (!times.length) return -1;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && t - times[lo - 1] <= times[lo] - t) return lo - 1;
  return lo;
}

/** A linear map from [d0, d1] to [r0, r1]. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
function f1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}
