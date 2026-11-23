/**
 * Scales, ticks and the whole chart model for the Performance equity and drawdown charts (owner-approved mockup
 * "Nexus data states", part B, 2026-11-22): pure functions, no React and no imports, so
 * test/nexus-perf-charts.test.mjs runs them in Node. Performance.tsx only draws what chartModel returns.
 *
 * - y: R ticks on clean steps (1, 2 or 5 × 10^k), always through 0;
 * - x: close time, ticks at 00:00 UTC: Mondays (every 2nd or 4th when they would crowd) in a window longer than about
 *   two weeks, days (every 2nd to 6th when they would crowd) in a short one; a label that would pass either edge of the
 *   plot is skipped, so it never runs into the "UTC" tag or the drawdown's lowest R label;
 * - equity: a step line that starts at 0 at the window start and moves only at a close;
 * - peak and drawdown as the ledger counts them (src/signal-ledger.mjs performance: the points are cumulative R, the
 *   peak starts at 0);
 * - the selected trade, the card, the keys and the summary.
 */

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
/** The minus sign, not the hyphen, in printed values. */
const MINUS = "−";

/** The smallest R step: round() keeps six decimals, so a smaller step would round to 0. */
const MIN_STEP = 1e-6;

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
  // A flat line (on either side of 0) gets one full step; the step never rounds to 0 (a tiny span had a NaN domain).
  if (!(b - a > 1e-9)) { if (a < 0) { b = 0; a = -1; } else b = a + 1; }
  const step = Math.max(MIN_STEP, niceStep(b - a, maxTicks));
  const nlo = round(Math.floor(a / step + 1e-9) * step) || 0, nhi = round(Math.ceil(b / step - 1e-9) * step) || 0;
  const ticks: number[] = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) ticks.push(round(v) === 0 ? 0 : round(v));
  return { lo: nlo, hi: nhi, step, ticks };
}

/** Day strides for a short window, then Monday strides; 7 and its multiples sit on Mondays. */
const DAY_STRIDES = [1, 2, 3, 4, 5, 6];
const WEEK_STRIDES = [7, 14, 28];
/** A window longer than this many days takes Mondays only (a 30D window on a wide screen drifted to every 2nd day). */
export const WEEKS_FROM_DAYS = 15;
/** The least gap between two time labels, for the at-least-two rule. */
export const LABEL_GAP_PX = 8;
/** At most this many labels on the time axis (a 90D window on a desktop takes every 2nd Monday). */
export const MAX_X_LABELS = 8;

function ticksFor(fromMs: number, toMs: number, stride: number): number[] {
  const first = Math.ceil(fromMs / DAY) * DAY;
  const ticks: number[] = [];
  if (stride < 7) {
    for (let t = first; t <= toMs; t += DAY) if (Math.round(t / DAY) % stride === 0) ticks.push(t);
  } else {
    // 1970-01-01 was a Thursday: day n is a Monday when (n + 3) % 7 === 0.
    let t = first;
    while ((Math.round(t / DAY) + 3) % 7 !== 0) t += DAY;
    for (; t <= toMs; t += stride * DAY) ticks.push(t);
  }
  return ticks;
}

/**
 * Ticks at 00:00 UTC between `startMs` and `endMs` for a plot `widthPx` wide, at least `minPx` apart and at most
 * `maxLabels`: in a window of up to WEEKS_FROM_DAYS days every day or every 2nd … 6th day, then Mondays; in a longer
 * one every Monday, every 2nd or 4th Monday; at least two when a shorter stride leaves room between them. `edgePx`
 * (half a label's width) keeps every tick that far inside both edges, so its label clears the plot's edges
 * (fitAxisLabels), and the Monday strides count from the first Monday that clears the left edge (a phone's 30D window
 * keeps two labels).
 */
export function utcDayTicks(startMs: number, endMs: number, widthPx: number, minPx = 64, edgePx = 0, maxLabels = MAX_X_LABELS): { stride: number; ticks: number[] } {
  if (!(endMs > startMs) || !(widthPx > 0)) return { stride: 7, ticks: [] };
  const days = (endMs - startMs) / DAY;
  const pxPerDay = widthPx / days;
  const inset = (Math.max(0, edgePx) / pxPerDay) * DAY;
  const from = startMs + inset, to = endMs - inset;
  const strides = days > WEEKS_FROM_DAYS ? WEEK_STRIDES : [...DAY_STRIDES, ...WEEK_STRIDES];
  let at = strides.findIndex((s) => s * pxPerDay >= minPx && ticksFor(from, to, s).length <= maxLabels);
  if (at < 0) at = strides.length - 1;
  let pick = { stride: strides[at], ticks: ticksFor(from, to, strides[at]) };
  // At least two labels where a shorter stride still leaves a gap between them (a phone's 14D window).
  for (let i = at - 1; pick.ticks.length < 2 && edgePx > 0 && i >= 0 && strides[i] * pxPerDay >= 2 * edgePx + LABEL_GAP_PX; i--) {
    const ticks = ticksFor(from, to, strides[i]);
    if (ticks.length >= 2) pick = { stride: strides[i], ticks };
  }
  return pick;
}

/** The width-per-character estimate of the monospace axis text, in em (JetBrains Mono and the fallbacks are 0.6). */
export const CHAR_EM = 0.62;

/** The estimated width in px of `text` in the monospace axis font at `fontPx`. */
export function labelWidth(text: string, fontPx: number): number {
  return text.length * fontPx * CHAR_EM;
}

/**
 * The edge guard: keeps the ticks whose label, centred at `xOf(t)`, fits between `minX` and `maxX` (the plot's left
 * and right edges). Past the right edge a label runs into the "UTC" tag; at the left edge it crowds the drawdown's
 * lowest R label.
 */
export function fitAxisLabels(ticks: number[], xOf: (t: number) => number, labelOf: (t: number) => string, minX: number, maxX: number, fontPx: number): number[] {
  return ticks.filter((t) => {
    const x = xOf(t), half = labelWidth(labelOf(t), fontPx) / 2;
    return x - half >= minX - 1e-9 && x + half <= maxX + 1e-9;
  });
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

export type EquityIn = { t: string | number | null; r: number | null; id?: string };
/** `key` names the trade for the selection: `id:<id>`, else `t:<close>#<k>` (k counts earlier id-less rows at that close). */
export type EquityRow = { t: number; r: number; trade: number; peak: number; dd: number; id: string; key: string };

/**
 * The ledger's points (cumulative R at each close) with close time in ms, the trade's own R, the running peak
 * (from 0, as the ledger counts it) and the drawdown from that peak (≤ 0). Points without a time or without an R
 * are dropped (a null R is no trade, not a close at 0R); the rest are sorted by close time (stable). Each row has a
 * unique fallback key when it has no id: two id-less closes at one time are two trades (rowKey).
 */
export function equityRows(points: EquityIn[]): EquityRow[] {
  const rows = points
    .filter((p) => p.r != null && p.t != null)
    .map((p) => ({ t: typeof p.t === "number" ? p.t : Date.parse(String(p.t)), r: Number(p.r), id: p.id ?? "" }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.r))
    .sort((a, b) => a.t - b.t);
  let peak = 0, prev = 0;
  const seen = new Map<number, number>();
  return rows.map((p) => {
    peak = Math.max(peak, p.r);
    let key = `id:${p.id}`;
    if (!p.id) { const k = seen.get(p.t) ?? 0; seen.set(p.t, k + 1); key = `t:${p.t}#${k}`; }
    const row = { t: p.t, r: p.r, trade: round(p.r - prev), peak, dd: round(p.r - peak), id: p.id, key };
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

/** Below this measured width the charts take the phone layout: smaller text and margins, fewer ticks, the card in flow. */
export const NARROW = 560;

/** The sizes of both charts at a measured width (px): margins, heights, font, tick spacing. */
export type ChartLayout = {
  width: number; narrow: boolean; font: number; left: number; right: number; plotW: number;
  eqH: number; eqTop: number; eqBottom: number; ddH: number; ddTop: number; ddBottom: number; ddAxisY: number;
  minTickPx: number; eqMaxTicks: number;
};

export function chartLayout(width: number): ChartLayout {
  const narrow = width > 0 && width < NARROW;
  const left = narrow ? 34 : 48, right = narrow ? 46 : 72;
  return {
    width, narrow, font: narrow ? 10 : 11, left, right, plotW: Math.max(1, width - left - right),
    eqH: narrow ? 180 : 240, eqTop: 10, eqBottom: narrow ? 174 : 234,
    ddH: narrow ? 86 : 110, ddTop: 4, ddBottom: narrow ? 64 : 88, ddAxisY: narrow ? 81 : 105,
    minTickPx: narrow ? 56 : 72, eqMaxTicks: narrow ? 4 : 6,
  };
}

export type XTick = { t: number; x: number; label: string };
export type ChartModel = ChartLayout & {
  rows: EquityRow[]; times: number[]; n: number;
  /** The x domain: the window, widened to a close outside it. */
  x0: number; x1: number;
  last: EquityRow | null; ddIdx: number; ddRow: EquityRow | null; peakMax: number;
  eqScale: { lo: number; hi: number; step: number; ticks: number[] };
  ddScale: { lo: number; hi: number; step: number; ticks: number[] };
  stride: number; xTicks: XTick[];
  X: (t: number) => number; Ye: (v: number) => number; Yd: (v: number) => number;
  eqLine: string; peakLine: string; ddLine: string; eqArea: string; ddArea: string; zeroY: number;
  /** The deepest drawdown's marker and its value label (right of the point when it fits, else left). */
  ddMark: { x: number; y: number; labelX: number; labelY: number; anchor: "start" | "end"; text: string } | null;
  /** "max −1.40R · Oct 23" or "no drawdown", on a phone too. */
  ddHeadline: string;
};

/** Everything the two charts draw, from the ledger's points, the window and the measured width. */
export function chartModel(points: EquityIn[], startMs: number, endMs: number, width: number): ChartModel {
  const L = chartLayout(width);
  const rows = equityRows(points);
  const times = rows.map((x) => x.t);
  const n = rows.length;
  const x0 = Math.min(startMs, times[0] ?? startMs);
  const x1 = Math.max(endMs, times[n - 1] ?? endMs);
  const last = rows[n - 1] ?? null;
  const ddIdx = maxDrawdownIndex(rows.map((x) => x.dd));
  const ddRow = ddIdx >= 0 ? rows[ddIdx] : null;
  const peakMax = rows.reduce((m, x) => Math.max(m, x.peak), 0);

  const eqScale = niceTicks(Math.min(0, ...rows.map((x) => x.r)), peakMax, L.eqMaxTicks);
  const ddScale = niceTicks(ddRow ? ddRow.dd : -1, 0, 3);
  const X = linear(x0, x1, L.left, L.left + L.plotW);
  const Ye = linear(eqScale.lo, eqScale.hi, L.eqBottom, L.eqTop);
  const Yd = linear(ddScale.lo, 0, L.ddBottom, L.ddTop);

  const { stride, ticks } = utcDayTicks(x0, x1, L.plotW, L.minTickPx, labelWidth("Nov 23", L.font) / 2);
  const xTicks = fitAxisLabels(ticks, X, utcDayLabel, L.left, L.left + L.plotW, L.font).map((t) => ({ t, x: X(t), label: utcDayLabel(t) }));

  const eqLine = stepPath(stepPoints(times, rows.map((x) => x.r), x0, x1).map((p) => ({ x: X(p.t), y: Ye(p.v) })));
  const peakLine = stepPath(stepPoints(times, rows.map((x) => x.peak), x0, x1).map((p) => ({ x: X(p.t), y: Ye(p.v) })));
  const ddLine = stepPath(stepPoints(times, rows.map((x) => x.dd), x0, x1).map((p) => ({ x: X(p.t), y: Yd(p.v) })));
  const zeroY = Ye(0);
  const eqArea = `${eqLine}V${zeroY.toFixed(1)}H${L.left.toFixed(1)}Z`;
  const ddArea = `${ddLine}V${L.ddTop.toFixed(1)}H${L.left.toFixed(1)}Z`;

  let ddMark: ChartModel["ddMark"] = null;
  if (ddRow) {
    const x = X(ddRow.t), y = Yd(ddRow.dd), text = rValue(ddRow.dd);
    const right = x + 6 + labelWidth(text, L.font) <= width;
    ddMark = { x, y, labelX: x + (right ? 6 : -6), labelY: y - 8, anchor: right ? "start" : "end", text };
  }
  const ddHeadline = ddRow ? `max ${rValue(ddRow.dd)} · ${utcDayLabel(ddRow.t)}` : "no drawdown";

  return {
    ...L, rows, times, n, x0, x1, last, ddIdx, ddRow, peakMax, eqScale, ddScale, stride, xTicks, X, Ye, Yd,
    eqLine, peakLine, ddLine, eqArea, ddArea, zeroY, ddMark, ddHeadline,
  };
}

/** The close nearest to a pointer at `offsetX` px from the chart's left edge; -1 with no trades. */
export function pointerIndex(m: Pick<ChartModel, "x0" | "x1" | "left" | "plotW" | "times">, offsetX: number): number {
  return nearestIndex(m.times, m.x0 + ((offsetX - m.left) / m.plotW) * (m.x1 - m.x0));
}

/**
 * The selection's key: the trade's id, else its close time and its place among id-less closes at that time
 * (equityRows). The selection follows its trade when the window slides (an index would silently point at another
 * trade) and clears when the trade leaves the window.
 */
export function rowKey(row: Pick<EquityRow, "key">): string {
  return row.key;
}
/** The index of the row with `key` in `rows`; -1 for none or when the trade has left the window. */
export function indexOfKey(rows: Pick<EquityRow, "key">[], key: string | null): number {
  if (key == null) return -1;
  return rows.findIndex((x) => rowKey(x) === key);
}
/** The selected index from indexOfKey's answer: null when the key is not in the rows (0 is the first trade). */
export function activeIndex(found: number): number | null {
  return found >= 0 ? found : null;
}
/**
 * Whether leaving the chart clears the selection: only for a mouse. On touch, pointerleave fires with every
 * pointerup, so a tap's card would vanish at once; a tap clears with a tap elsewhere.
 */
export function pointerClears(pointerType: string): boolean {
  return pointerType === "mouse";
}

/**
 * The keys on the focused chart: → the next trade (the first from none), ← the previous (the last from none), Home the
 * first, End the last, Esc clears. `handled` false leaves the key to the browser.
 */
export function keyStep(key: string, active: number | null, n: number): { active: number | null; handled: boolean } {
  if (key === "Escape") return active != null ? { active: null, handled: true } : { active, handled: false };
  if (!(n > 0)) return { active: null, handled: false };
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  if (key === "ArrowRight") return { active: clamp(active == null ? 0 : active + 1), handled: true };
  if (key === "ArrowLeft") return { active: clamp(active == null ? n - 1 : active - 1), handled: true };
  if (key === "Home") return { active: 0, handled: true };
  if (key === "End") return { active: n - 1, handled: true };
  return { active, handled: false };
}

/** What the card and the live line say about trade `i`. */
export type CardFields = { utc: string; local: string; ordinal: string; trade: string; equity: string; peak: string; dd: string; live: string };
export function cardFields(rows: EquityRow[], i: number | null): CardFields | null {
  const row = i == null ? undefined : rows[i];
  if (!row || i == null) return null;
  const ordinal = `Trade ${i + 1} of ${rows.length}`;
  const f = { utc: utcStamp(row.t), local: localStamp(row.t), ordinal, trade: rValue(row.trade), equity: rValue(row.r), peak: rValue(row.peak), dd: rValue(row.dd) };
  return { ...f, live: `${ordinal}, closed ${f.utc}: trade ${f.trade}, equity at ${f.equity}, peak ${f.peak}, drawdown ${f.dd}.` };
}

/**
 * The card's height in px as drawn, rounded up: the UTC close, the local close on its own line, which trade, and the
 * Equity, Peak and Drawdown pairs (114.25 px in Chromium at 11px, in UTC, Asia/Jakarta and America/New_York, at 390,
 * 1024 and 1440). The page measures the real card and passes that; this is the first frame's value and the phone
 * box's minimum height (min-h-[115px]), so the first tap does not shift the page.
 */
export const CARD_H = 115;
/** The desktop card beside the point: right of it when it fits, else left; kept inside the equity chart's height. */
export function cardPosition(ax: number, ay: number, width: number, eqH: number, cardW = 236, cardH = CARD_H): { left: number; top: number } {
  return {
    left: ax + 14 + cardW <= width ? ax + 14 : Math.max(0, ax - 14 - cardW),
    top: Math.max(0, Math.min(eqH - cardH, ay - 60)),
  };
}

/** The chart's aria-label. */
export function chartSummary(m: Pick<ChartModel, "last" | "n" | "peakMax" | "ddRow">, policyLabel: string, days: number): string {
  return `Equity curve, ${policyLabel}: ${rValue(m.last?.r ?? 0)} after ${m.n} closed trade${m.n === 1 ? "" : "s"} in ${days} days, ` +
    `peak ${rValue(m.peakMax)}; drawdown ${m.ddRow ? `max ${rValue(m.ddRow.dd)} on ${utcDayLabel(m.ddRow.t)}` : "none"}. ` +
    `Left and right arrow keys step through the trades.`;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
function f1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}
