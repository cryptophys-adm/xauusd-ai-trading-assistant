// Chart patterns: the Projection Agent's pattern knowledge (owner 2026-11-12: "adopsi semua yang ada di
// buku untuk main muscle knowledge Projection Agent"; "Fibonacci, cone, dan trendline, dan tambahan 53
// pola chart ... dan 10 pola event"). The catalogue follows the 53 chart patterns and 10 event patterns
// of Thomas N. Bulkowski, "Encyclopedia of Chart Patterns" (2nd ed., Wiley 2005), by chapter number.
//
// What is taken from the book is the method, written here from scratch: how each pattern is recognised
// on closed bars, which price confirms it (the breakout), the measure rule (the pattern's height
// projected from the breakout), the return to the breakout price (throwback, pullback) and the busted
// pattern. The book's statistics are NOT copied: they come from daily charts of US stocks (1991-2004)
// and say nothing about gold on 15m to daily bars. Sizes that the book gives in percent are expressed
// here in multiples of the chart's own average true range (ATR). Each pattern's own hit rate on XAUUSD
// has to be measured before it earns more weight (learned knowledge, never canon).
//
// Deterministic and pure: no model call, no clock; every price comes from the bars given. A pattern
// gives the Projection Agent levels (src/level-readers.mjs `patternLevels`): its breakout lines, and
// once it broke out, the broken line (where a throwback or pullback returns) and the measured target.
//
// Event patterns: gold has no earnings, drug approvals, store sales or analyst ratings. The event here
// is a released high-impact USD figure with a direction for gold (D1 econ_releases). Five of the ten
// event patterns have such a reading; the other five are catalogued as not applicable.

export const CHART_PATTERNS_VERSION = "cryptophys.chart-patterns.v1";
export const MAX_PATTERNS_PER_CHART = 5;

const C = (n, id, name, group, sides, extra = {}) => Object.freeze({ n, id, name, part: n <= 53 ? "chart" : "event", group, sides, applies: true, ...extra });
/** Every pattern of the book, by chapter. `sides`: the breakout directions the pattern is traded in. */
export const PATTERN_CATALOG = Object.freeze([
  C(1, "broadening_bottom", "broadening bottom", "lines", "both"),
  C(2, "broadening_right_angled_ascending", "right-angled ascending broadening formation", "lines", "both"),
  C(3, "broadening_right_angled_descending", "right-angled descending broadening formation", "lines", "both"),
  C(4, "broadening_top", "broadening top", "lines", "both"),
  C(5, "broadening_wedge_ascending", "ascending broadening wedge", "lines", "both"),
  C(6, "broadening_wedge_descending", "descending broadening wedge", "lines", "both"),
  C(7, "bump_and_run_bottom", "bump-and-run reversal bottom", "curve", "up"),
  C(8, "bump_and_run_top", "bump-and-run reversal top", "curve", "down"),
  C(9, "cup_with_handle", "cup with handle", "curve", "up"),
  C(10, "cup_with_handle_inverted", "inverted cup with handle", "curve", "down"),
  C(11, "diamond_bottom", "diamond bottom", "lines", "both"),
  C(12, "diamond_top", "diamond top", "lines", "both"),
  C(13, "double_bottom_adam_adam", "double bottom (Adam & Adam)", "peaks", "up"),
  C(14, "double_bottom_adam_eve", "double bottom (Adam & Eve)", "peaks", "up"),
  C(15, "double_bottom_eve_adam", "double bottom (Eve & Adam)", "peaks", "up"),
  C(16, "double_bottom_eve_eve", "double bottom (Eve & Eve)", "peaks", "up"),
  C(17, "double_top_adam_adam", "double top (Adam & Adam)", "peaks", "down"),
  C(18, "double_top_adam_eve", "double top (Adam & Eve)", "peaks", "down"),
  C(19, "double_top_eve_adam", "double top (Eve & Adam)", "peaks", "down"),
  C(20, "double_top_eve_eve", "double top (Eve & Eve)", "peaks", "down"),
  C(21, "flag", "flag", "pole", "both"),
  C(22, "flag_high_and_tight", "high and tight flag", "pole", "up"),
  C(23, "gap", "gap", "gaps", "both"),
  C(24, "head_and_shoulders_bottom", "head-and-shoulders bottom", "peaks", "up"),
  C(25, "head_and_shoulders_bottom_complex", "complex head-and-shoulders bottom", "peaks", "up"),
  C(26, "head_and_shoulders_top", "head-and-shoulders top", "peaks", "down"),
  C(27, "head_and_shoulders_top_complex", "complex head-and-shoulders top", "peaks", "down"),
  C(28, "horn_bottom", "horn bottom", "bars", "up"),
  C(29, "horn_top", "horn top", "bars", "down"),
  C(30, "island_reversal", "island reversal", "gaps", "both"),
  C(31, "island_long", "long island", "gaps", "both"),
  C(32, "measured_move_down", "measured move down", "legs", "down"),
  C(33, "measured_move_up", "measured move up", "legs", "up"),
  C(34, "pennant", "pennant", "pole", "both"),
  C(35, "pipe_bottom", "pipe bottom", "bars", "up"),
  C(36, "pipe_top", "pipe top", "bars", "down"),
  C(37, "rectangle_bottom", "rectangle bottom", "lines", "both"),
  C(38, "rectangle_top", "rectangle top", "lines", "both"),
  C(39, "rounding_bottom", "rounding bottom", "curve", "up"),
  C(40, "rounding_top", "rounding top", "curve", "both"),
  C(41, "scallop_ascending", "ascending scallop", "curve", "both"),
  C(42, "scallop_ascending_inverted", "inverted ascending scallop", "curve", "up"),
  C(43, "scallop_descending", "descending scallop", "curve", "both"),
  C(44, "scallop_descending_inverted", "inverted descending scallop", "curve", "down"),
  C(45, "three_falling_peaks", "three falling peaks", "peaks", "down"),
  C(46, "three_rising_valleys", "three rising valleys", "peaks", "up"),
  C(47, "triangle_ascending", "ascending triangle", "lines", "both"),
  C(48, "triangle_descending", "descending triangle", "lines", "both"),
  C(49, "triangle_symmetrical", "symmetrical triangle", "lines", "both"),
  C(50, "triple_bottom", "triple bottom", "peaks", "up"),
  C(51, "triple_top", "triple top", "peaks", "down"),
  C(52, "wedge_falling", "falling wedge", "lines", "both"),
  C(53, "wedge_rising", "rising wedge", "lines", "both"),
  // Event patterns. For gold the event is a released USD figure (econ_releases) or the bar it moved.
  C(54, "dead_cat_bounce", "dead-cat bounce", "event", "down", { gold: "a sharp event decline, a partial bounce, then the decline resumes" }),
  C(55, "dead_cat_bounce_inverted", "inverted dead-cat bounce", "event", "up", { gold: "a sharp event rise, a partial giveback, then the rise resumes" }),
  C(56, "event_surprise_bearish", "bearish release surprise", "event", "down", { book: "bad earnings surprise", gold: "a release that surprised against gold: a close below the release bar's low" }),
  C(57, "event_surprise_bullish", "bullish release surprise", "event", "up", { book: "good earnings surprise", gold: "a release that surprised for gold: a close above the release bar's high" }),
  C(58, "fda_drug_approval", "FDA drug approval", "event", "both", { applies: false, gold: "no such event for gold" }),
  C(59, "event_flag", "release flag", "event", "both", { book: "earnings flag", gold: "a flag that forms after a release bar moved price sharply" }),
  C(60, "same_store_sales_bad", "bad same-store sales", "event", "down", { applies: false, gold: "no such event for gold" }),
  C(61, "same_store_sales_good", "good same-store sales", "event", "up", { applies: false, gold: "no such event for gold" }),
  C(62, "stock_downgrade", "stock downgrade", "event", "both", { applies: false, gold: "no such event for gold" }),
  C(63, "stock_upgrade", "stock upgrade", "event", "both", { applies: false, gold: "no such event for gold" })
]);
const BY_ID = new Map(PATTERN_CATALOG.map((p) => [p.id, p]));
export const patternInfo = (id) => BY_ID.get(id) ?? null;

// ---------------------------------------------------------------- bars, range, pivots

const num = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (num(v) ? Math.round(v * 100) / 100 : null);

/** Bars as { o, h, l, c, t } (t: close time in ms, or null), invalid ones dropped. */
export function normBars(bars) {
  const out = [];
  for (const b of Array.isArray(bars) ? bars : []) {
    const h = b?.high ?? b?.h, l = b?.low ?? b?.l, c = b?.close ?? b?.c, o = b?.open ?? b?.o;
    if (![h, l, c].every(num) || h < l || l <= 0) continue;
    const ct = Date.parse(String(b?.close_time ?? ""));
    const t = Number.isFinite(ct) ? ct : num(b?.t) ? b.t : null;
    out.push({ o: num(o) ? o : c, h, l, c, t });
  }
  return out;
}

/** The mean true range of the bars (all of them: the pattern sizes compare with the chart's own range). */
export function meanRange(b) {
  if (b.length < 2) return null;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

/**
 * The turning points: k-bar fractal highs and lows, alternating (of two highs in a row the higher stays),
 * plus the provisional extreme after the last confirmed one. [{ i, p, t: "H"|"L", prov? }].
 */
export function zigzag(b, k = 2) {
  const piv = [];
  const push = (x) => {
    const last = piv.at(-1);
    if (last && last.t === x.t) { if (x.t === "H" ? x.p > last.p : x.p < last.p) piv[piv.length - 1] = x; return; }
    piv.push(x);
  };
  for (let i = k; i < b.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(b[i].h > b[i - j].h && b[i].h >= b[i + j].h)) isH = false;
      if (!(b[i].l < b[i - j].l && b[i].l <= b[i + j].l)) isL = false;
    }
    if (isH && isL) push(piv.at(-1)?.t === "H" ? { i, p: b[i].l, t: "L" } : { i, p: b[i].h, t: "H" });
    else if (isH) push({ i, p: b[i].h, t: "H" });
    else if (isL) push({ i, p: b[i].l, t: "L" });
  }
  const last = piv.at(-1);
  if (last && last.i < b.length - 1) {
    let best = null;
    for (let i = last.i + 1; i < b.length; i++) {
      const p = last.t === "H" ? b[i].l : b[i].h;
      if (!best || (last.t === "H" ? p < best.p : p > best.p)) best = { i, p, t: last.t === "H" ? "L" : "H", prov: true };
    }
    if (best) piv.push(best);
  }
  return piv;
}

/** Least squares through points [{ i, p }]: { m, at(x) }. */
function fit(points) {
  const n = points.length;
  const mx = points.reduce((s, q) => s + q.i, 0) / n, my = points.reduce((s, q) => s + q.p, 0) / n;
  let sxx = 0, sxy = 0;
  for (const q of points) { sxx += (q.i - mx) ** 2; sxy += (q.i - mx) * (q.p - my); }
  const m = sxx > 0 ? sxy / sxx : 0;
  return { m, at: (x) => my + m * (x - mx) };
}

/** Quadratic least squares of ys over x = 0..n-1: { a, vertex, r2 } (a > 0 opens up). */
function quadFit(ys) {
  const n = ys.length;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let x = 0; x < n; x++) { const x2 = x * x; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; t0 += ys[x]; t1 += x * ys[x]; t2 += x2 * ys[x]; }
  const det = s4 * (s2 * s0 - s1 * s1) - s3 * (s3 * s0 - s1 * s2) + s2 * (s3 * s1 - s2 * s2);
  if (!det) return null;
  const a = (t2 * (s2 * s0 - s1 * s1) - s3 * (t1 * s0 - s1 * t0) + s2 * (t1 * s1 - s2 * t0)) / det;
  const bb = (s4 * (t1 * s0 - t0 * s1) - t2 * (s3 * s0 - s1 * s2) + s2 * (s3 * t0 - s2 * t1)) / det;
  const cc = (s4 * (s2 * t0 - s1 * t1) - s3 * (s3 * t0 - s2 * t1) + t2 * (s3 * s1 - s2 * s2)) / det;
  const mean = t0 / n;
  let ssr = 0, sst = 0;
  for (let x = 0; x < n; x++) { const f = a * x * x + bb * x + cc; ssr += (ys[x] - f) ** 2; sst += (ys[x] - mean) ** 2; }
  return { a, vertex: a ? -bb / (2 * a) : null, r2: sst > 0 ? 1 - ssr / sst : 0, at: (x) => a * x * x + bb * x + cc };
}

/** How many bars in a row around bar i stay within `depth` of its extreme (a narrow spike or a wide turn). */
function turnWidth(b, i, type, depth) {
  const ok = (j) => (type === "H" ? b[j].h >= b[i].h - depth : b[j].l <= b[i].l + depth);
  let w = 1;
  for (let j = i - 1; j >= 0 && ok(j); j--) w++;
  for (let j = i + 1; j < b.length && ok(j); j++) w++;
  return w;
}
const ADAM_MAX_BARS = 3;
const shape = (b, piv, depth) => (turnWidth(b, piv.i, piv.t, 0.3 * depth) <= ADAM_MAX_BARS ? "adam" : "eve");

/** The trend into bar x: "up" or "down" (the close against the close up to 10 bars before). */
function priorTrend(b, x) {
  const from = Math.max(0, x - 10);
  return b[x].c >= b[from].c ? "up" : "down";
}

const P = (id, start, end, levels) => ({ id, start, end, ...levels });

// ---------------------------------------------------------------- two boundary lines (chapters 1-6, 11-12, 37-38, 47-49, 52-53)

const slopeClass = (s) => (s >= 0.3 ? "up" : s <= -0.3 ? "down" : "flat");
const LINE_IDS = {
  "flat|flat": (t) => (t === "up" ? "rectangle_top" : "rectangle_bottom"),
  "flat|up": () => "triangle_ascending",
  "down|flat": () => "triangle_descending",
  "down|up": () => "triangle_symmetrical",
  "up|down": (t) => (t === "up" ? "broadening_top" : "broadening_bottom"),
  "up|flat": () => "broadening_right_angled_ascending",
  "flat|down": () => "broadening_right_angled_descending"
};

function linePatterns(b, piv, A) {
  const n = b.length;
  for (let m = Math.min(9, piv.length); m >= 5; m--) {
    const pts = piv.slice(-m);
    const highs = pts.filter((q) => q.t === "H"), lows = pts.filter((q) => q.t === "L");
    const x0 = pts[0].i, x1 = pts.at(-1).i, span = x1 - x0;
    if (highs.length < 2 || lows.length < 2 || span < 8) continue;
    const top = fit(highs), bot = fit(lows);
    const w0 = top.at(x0) - bot.at(x0), w1 = top.at(x1) - bot.at(x1);
    const H = Math.max(w0, w1);
    if (!(H > 1.2 * A) || Math.min(w0, w1) < -0.1 * H) continue;
    const tol = 0.2 * H;
    if (highs.some((q) => Math.abs(q.p - top.at(q.i)) > tol) || lows.some((q) => Math.abs(q.p - bot.at(q.i)) > tol)) continue;
    const st = slopeClass(top.m * span / H), sb = slopeClass(bot.m * span / H);
    const conv = w1 < 0.7 * w0, div = w1 > 1.4 * w0;
    let id = LINE_IDS[`${st}|${sb}`]?.(priorTrend(b, x0)) ?? null;
    if (st === "up" && sb === "up") id = conv ? "wedge_rising" : div ? "broadening_wedge_ascending" : null;
    if (st === "down" && sb === "down") id = conv ? "wedge_falling" : div ? "broadening_wedge_descending" : null;
    if (!id) continue;
    const upper = top.at(n - 1), lower = bot.at(n - 1);
    if (!(upper > lower)) continue;
    const hi = Math.max(...b.slice(x0, x1 + 1).map((x) => x.h)), lo = Math.min(...b.slice(x0, x1 + 1).map((x) => x.l));
    // The measure rule: the height from the breakout. A wedge aims at where it began.
    const targetUp = id === "wedge_falling" ? hi : upper + H, targetDown = id === "wedge_rising" ? lo : lower - H;
    return [P(id, x0, x1, { upper, lower, height: H, target_up: targetUp, target_down: targetDown })];
  }
  return [];
}

/** Diamond: the swings widen, then narrow (the highest high and the lowest low sit inside the pattern). */
function diamondPatterns(b, piv, A) {
  for (let m = Math.min(9, piv.length); m >= 6; m--) {
    const pts = piv.slice(-m);
    const highs = pts.filter((q) => q.t === "H"), lows = pts.filter((q) => q.t === "L");
    if (highs.length < 3 || lows.length < 3) continue;
    const hi = Math.max(...highs.map((q) => q.p)), lo = Math.min(...lows.map((q) => q.p)), R = hi - lo;
    if (!(R > 2 * A)) continue;
    const g = 0.2 * R;
    const inner = (list, ext, sign) => sign * (ext - list[0].p) >= g && sign * (ext - list.at(-1).p) >= g;
    if (!inner(highs, hi, 1) || !inner(lows, lo, -1)) continue;
    const x0 = pts[0].i, x1 = pts.at(-1).i;
    const upper = highs.at(-1).p, lower = lows.at(-1).p;
    if (!(upper > lower)) continue;
    return [P(priorTrend(b, x0) === "up" ? "diamond_top" : "diamond_bottom", x0, x1, { upper, lower, height: R, target_up: upper + R, target_down: lower - R })];
  }
  return [];
}

// ---------------------------------------------------------------- peaks and valleys (chapters 13-20, 24-27, 45-46, 50-51)

/** Peaks patterns on one side: `sign` +1 reads tops (highs), -1 reads bottoms (lows, mirrored). */
function peakPatterns(b, piv, A, sign) {
  const out = [];
  const top = sign > 0 ? "H" : "L";
  const v = (q) => sign * q.p;                       // mirrored price: larger is "higher"
  const real = (x) => sign * x;                      // back to a price
  const tops = piv.filter((q) => q.t === top);
  const between = (a, c) => piv.filter((q) => q.t !== top && q.i > a.i && q.i < c.i).sort((x, y) => v(x) - v(y))[0] ?? null;
  const eq = (a, c, depth) => Math.abs(a.p - c.p) <= Math.max(0.5 * A, 0.15 * depth);
  const name = (s) => (sign > 0 ? s.replace("@", "top") : s.replace("@", "bottom"));

  if (tops.length >= 2) {
    const [p1, p2] = tops.slice(-2);
    const valley = between(p1, p2);
    if (valley) {
      const depth = Math.min(v(p1), v(p2)) - v(valley);
      if (depth >= 1.5 * A && p2.i - p1.i >= 4 && eq(p1, p2, depth)) {
        const peak = Math.max(v(p1), v(p2));
        out.push(P(name(`double_@_${shape(b, p1, depth)}_${shape(b, p2, depth)}`), p1.i, p2.i, sidesOf(sign, real(v(valley)), real(peak), peak - v(valley))));
      }
    }
  }
  if (tops.length >= 3) {
    const [p1, p2, p3] = tops.slice(-3);
    const v1 = between(p1, p2), v2 = between(p2, p3);
    if (v1 && v2) {
      const base = Math.min(v(v1), v(v2));
      const peak = Math.max(v(p1), v(p2), v(p3));
      const depth = Math.min(v(p1), v(p2), v(p3)) - base;
      if (depth >= 1.5 * A) {
        if (eq(p1, p2, depth) && eq(p2, p3, depth) && eq(p1, p3, depth)) out.push(P(name("triple_@"), p1.i, p3.i, sidesOf(sign, real(base), real(peak), peak - base)));
        // The head stands above both shoulders, which sit at about one height; the neckline joins the two valleys.
        const neck = fit([v1, v2]);
        const headOver = v(p2) - Math.max(v(p1), v(p3));
        const headHeight = v(p2) - sign * neck.at(p2.i);
        if (headHeight > 0 && headOver >= Math.max(0.5 * A, 0.15 * headHeight) && Math.abs(p1.p - p3.p) <= 0.35 * headHeight) {
          const line = neck.at(b.length - 1);
          out.push(P(name("head_and_shoulders_@"), p1.i, p3.i, sidesOf(sign, line, p2.p, headHeight)));
        }
      }
      // Three peaks, each lower than the one before (three valleys, each higher).
      const step = 0.5 * A;
      if (v(p1) - v(p2) >= step && v(p2) - v(p3) >= step && v(p1) - base >= 2 * A) {
        out.push(P(sign > 0 ? "three_falling_peaks" : "three_rising_valleys", p1.i, p3.i, sidesOf(sign, real(base), p1.p, v(p1) - base)));
      }
    }
  }
  // Complex head and shoulders: two heads of one height between two shoulders, or two shoulders on a side.
  if (tops.length >= 4) {
    const [a, h1, h2, d] = tops.slice(-4);
    const lowsIn = piv.filter((q) => q.t !== top && q.i > a.i && q.i < d.i);
    if (lowsIn.length >= 3) {
      const base = Math.min(...lowsIn.map(v)), head = Math.max(v(h1), v(h2)), height = head - base;
      if (height >= 2 * A && Math.abs(h1.p - h2.p) <= 0.2 * height && Math.min(v(h1), v(h2)) - Math.max(v(a), v(d)) >= 0.5 * A && Math.abs(a.p - d.p) <= 0.35 * height) {
        const neck = fit([lowsIn[0], lowsIn.at(-1)]);
        out.push(P(name("head_and_shoulders_@_complex"), a.i, d.i, sidesOf(sign, neck.at(b.length - 1), real(head), head - sign * neck.at(h1.i))));
      }
    }
  }
  if (tops.length >= 5) {
    const [s1, s2, h, s3, s4] = tops.slice(-5);
    const lowsIn = piv.filter((q) => q.t !== top && q.i > s1.i && q.i < s4.i);
    if (lowsIn.length >= 4) {
      const base = Math.min(...lowsIn.map(v)), height = v(h) - base;
      const sh = [s1, s2, s3, s4].map(v);
      if (height >= 2 * A && v(h) - Math.max(...sh) >= 0.5 * A && Math.max(...sh) - Math.min(...sh) <= 0.35 * height) {
        const neck = fit([lowsIn[0], lowsIn.at(-1)]);
        out.push(P(name("head_and_shoulders_@_complex"), s1.i, s4.i, sidesOf(sign, neck.at(b.length - 1), h.p, v(h) - sign * neck.at(h.i))));
      }
    }
  }
  return out;
}
/** A top (sign +1) breaks down through `confirm`; a close back beyond `invalid` busts it. Bottoms mirror. */
function sidesOf(sign, confirm, invalid, height) {
  return sign > 0
    ? { lower: confirm, upper: invalid, height, target_down: confirm - height, target_up: invalid + height }
    : { upper: confirm, lower: invalid, height, target_up: confirm + height, target_down: invalid - height };
}

// ---------------------------------------------------------------- two tall bars (chapters 28-29 horns, 35-36 pipes)

function spikePatterns(b, A) {
  const out = [], n = b.length;
  const range = (i) => b[i].h - b[i].l;
  for (let i = n - 1; i >= Math.max(12, n - 14) && !out.length; i--) {
    for (const sign of [1, -1]) {
      const ext = (j) => (sign > 0 ? b[j].h : -b[j].l);          // the spike's tip, mirrored
      const tall = (j) => range(j) >= 1.5 * A;
      const tipOf = (js) => Math.max(...js.map(ext));
      const standsOut = (js) => { for (let j = Math.max(0, js[0] - 10); j < js[0]; j++) if (ext(j) >= tipOf(js) - 0.25 * A) return false; for (let j = i + 1; j < n; j++) if (ext(j) > tipOf(js)) return false; return true; };
      const emit = (id, js) => {
        const tip = sign * tipOf(js), base = sign > 0 ? Math.min(...js.map((j) => b[j].l)) : Math.max(...js.map((j) => b[j].h));
        out.push(P(id, js[0], i, sidesOf(sign, base, tip, Math.abs(tip - base))));
      };
      if (tall(i) && tall(i - 1) && Math.abs(ext(i) - ext(i - 1)) <= 0.3 * A && standsOut([i - 1, i])) emit(sign > 0 ? "pipe_top" : "pipe_bottom", [i - 1, i]);
      else if (i >= 2 && tall(i) && tall(i - 2) && Math.abs(ext(i) - ext(i - 2)) <= 0.3 * A && ext(i - 1) <= Math.min(ext(i), ext(i - 2)) - 0.4 * A && standsOut([i - 2, i])) emit(sign > 0 ? "horn_top" : "horn_bottom", [i - 2, i]);
      if (out.length) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- a pole and a pause (chapters 21, 22, 34, and the event flag 59)

/** Pure: a flag or pennant after a pole that ends at bar `poleEnd` (or the steepest recent pole when null). */
function polePatterns(b, A, { poleEnd = null, idPrefix = "" } = {}) {
  const n = b.length;
  const candidates = poleEnd != null ? [poleEnd] : Array.from({ length: 16 }, (_, k) => n - 5 - k).filter((i) => i >= 6);
  for (const e of candidates) {
    // The pole: the largest net move into bar e over 3 to 12 bars.
    const lens = [3, 5, 8, 12].filter((len) => e - len >= 0).sort((x, y) => Math.abs(b[e].c - b[e - y].c) - Math.abs(b[e].c - b[e - x].c));
    for (const len of lens.slice(0, 1)) {
      const s = e - len;
      const move = b[e].c - b[s].c, dir = Math.sign(move), pole = Math.abs(move);
      if (pole < 3.5 * A) continue;
      // The pole ends at its tip: no close from its start to now lies beyond the close of bar e.
      if (b.slice(s).some((x) => dir * (x.c - b[e].c) > 0.1 * A)) continue;
      const rest = b.slice(e + 1);
      if (rest.length < 4 || rest.length > 20) continue;
      // The pause, measured from the pole's tip (the pole's own bars are not part of it).
      const hi = Math.max(dir > 0 ? b[e].h : -Infinity, ...rest.map((x) => x.h)), lo = Math.min(dir < 0 ? b[e].l : Infinity, ...rest.map((x) => x.l));
      const height = hi - lo;
      // The pause is small against the pole and gives back less than half of it.
      const giveback = dir > 0 ? b[e].h - lo : hi - b[e].l;
      if (height > 0.5 * pole || giveback > 0.5 * pole) continue;
      const half = Math.floor(rest.length / 2);
      const rng = (xs) => Math.max(...xs.map((x) => x.h)) - Math.min(...xs.map((x) => x.l));
      const narrowing = rest.length >= 6 && rng(rest.slice(half)) < 0.6 * rng(rest.slice(0, half));
      const tight = dir > 0 && pole >= 8 * A && giveback <= 0.3 * pole;
      const id = idPrefix ? "event_flag" : tight ? "flag_high_and_tight" : narrowing ? "pennant" : "flag";
      return [P(id, s, n - 1, { upper: hi, lower: lo, height: pole, target_up: dir > 0 ? lo + pole : hi + height, target_down: dir < 0 ? hi - pole : lo - height, pole_dir: dir })];
    }
  }
  return [];
}

// ---------------------------------------------------------------- gaps and islands (chapters 23, 30, 31)

function gapPatterns(b, A) {
  const out = [], n = b.length, min = 0.15 * A;
  const gaps = [];
  for (let i = Math.max(1, n - 40); i < n; i++) {
    if (b[i].l > b[i - 1].h + min) gaps.push({ i, dir: 1, lo: b[i - 1].h, hi: b[i].l });
    else if (b[i].h < b[i - 1].l - min) gaps.push({ i, dir: -1, lo: b[i].h, hi: b[i - 1].l });
  }
  // An island: a gap in, a gap out the other way at about the same price, the bars between left alone.
  for (let k = gaps.length - 1; k >= 1 && !out.length; k--) {
    const exit = gaps[k], enter = gaps[k - 1];
    if (enter.dir === exit.dir || !(Math.min(enter.hi, exit.hi) > Math.max(enter.lo, exit.lo))) continue;
    const isle = b.slice(enter.i, exit.i);
    const hi = Math.max(...isle.map((x) => x.h)), lo = Math.min(...isle.map((x) => x.l));
    const id = isle.length <= 5 ? "island_reversal" : "island_long";
    // An island is small against the move it ends, so its height gives no target: its edges are the levels.
    out.push(P(id, enter.i, exit.i, { ...sidesOf(enter.dir, enter.dir > 0 ? lo : hi, enter.dir > 0 ? hi : lo, hi - lo), target_up: null, target_down: null }));
  }
  // The last open gap: its edges hold as support (an up gap) or resistance (a down gap) until it closes.
  for (let k = gaps.length - 1; k >= 0; k--) {
    const g = gaps[k];
    if (g.i < n - 15) break;
    const after = b.slice(g.i + 1);
    const closed = g.dir > 0 ? after.some((x) => x.l <= g.lo) : after.some((x) => x.h >= g.hi);
    if (!closed) { out.push(P("gap", g.i - 1, g.i, { upper: g.hi, lower: g.lo, height: g.hi - g.lo, target_up: null, target_down: null, gap_dir: g.dir })); break; }
  }
  return out;
}

// ---------------------------------------------------------------- two legs (chapters 32, 33)

function measuredMoves(b, piv, A) {
  const out = [], n = b.length;
  if (piv.length < 3) return out;
  // The larger first leg wins when the last turns read both ways.
  let best = null;
  for (const off of [0, 1]) {
    const [p0, p1, p2] = piv.slice(piv.length - 3 - off, piv.length - off);
    if (!p0 || !p2 || p0.t !== p2.t) continue;
    const dir = p0.t === "L" ? 1 : -1;
    const leg = dir * (p1.p - p0.p), back = dir * (p1.p - p2.p);
    if (leg < 3 * A || back < 0.3 * leg || back > 0.7 * leg) continue;
    const target = p2.p + dir * leg;
    const after = b.slice(p2.i);
    if (dir > 0 ? after.some((x) => x.h >= target || x.l < p2.p) : after.some((x) => x.l <= target || x.h > p2.p)) continue;
    if (!best || leg > best.height) best = P(dir > 0 ? "measured_move_up" : "measured_move_down", p0.i, n - 1, dir > 0
      ? { upper: p1.p, lower: p2.p, height: leg, target_up: target, target_down: null }
      : { lower: p1.p, upper: p2.p, height: leg, target_down: target, target_up: null });
  }
  if (best) out.push(best);
  return out;
}

// ---------------------------------------------------------------- curves (chapters 7-10, 39-44)

function roundedPatterns(b, piv, A) {
  const out = [], n = b.length;
  // Rounding bottoms and tops: the closes follow a bowl (a dome) whose turn sits inside the window.
  for (const W of [n, 45, 30]) {
    if (W > n || W < 24) continue;
    const win = b.slice(n - W), q = quadFit(win.map((x) => x.c));
    if (!q || q.r2 < 0.75 || !num(q.vertex) || q.vertex < 0.25 * W || q.vertex > 0.75 * W) continue;
    const hi = Math.max(...win.map((x) => x.h)), lo = Math.min(...win.map((x) => x.l)), depth = hi - lo;
    if (depth < 3 * A) continue;
    const rim = win.slice(0, Math.max(2, Math.round(0.1 * W)));
    if (q.a > 0) out.push(P("rounding_bottom", n - W, n - 1, sidesOf(-1, Math.max(...rim.map((x) => x.h)), lo, depth)));
    else out.push(P("rounding_top", n - W, n - 1, sidesOf(1, Math.min(...rim.map((x) => x.l)), hi, depth)));
    break;
  }
  // Cups and scallops from the last turns: rim A, the rounded turn B, rim C (and the handle after C).
  for (const sign of [1, -1]) {
    const rimT = sign > 0 ? "H" : "L";
    const v = (q) => sign * q.p;
    for (const off of [0, 1]) {
      const seq = piv.slice(0, piv.length - off);
      const c = seq.at(-1)?.t === rimT ? seq.at(-1) : seq.at(-2);
      if (!c || c.t !== rimT) continue;
      const ci = seq.indexOf(c), bt = seq[ci - 1], a = seq[ci - 2];
      if (!a || !bt) continue;
      const depth = Math.min(v(a), v(c)) - v(bt);
      const span = c.i - a.i;
      if (depth < 2 * A || span < 10 || turnWidth(b, bt.i, bt.t, 0.3 * depth) < 4) continue;
      const handle = seq[ci + 1] ?? null;
      const diff = v(c) - v(a);
      if (Math.abs(diff) <= 0.3 * depth && handle && handle.i - c.i <= 0.5 * span) {
        const back = v(c) - v(handle);
        if (back >= 0.1 * depth && back <= 0.5 * depth) out.push(P(sign > 0 ? "cup_with_handle" : "cup_with_handle_inverted", a.i, handle.i, sidesOf(-sign, c.p, handle.p, depth)));
      } else if (diff > 0.3 * depth) {
        // The far rim ends beyond the near one: a J (ascending scallop), or its mirror (inverted descending).
        out.push(P(sign > 0 ? "scallop_ascending" : "scallop_descending_inverted", a.i, c.i, sign > 0
          ? { upper: c.p, lower: bt.p, height: depth, target_up: c.p + depth, target_down: bt.p - depth }
          : { lower: c.p, upper: bt.p, height: depth, target_down: c.p - depth, target_up: bt.p + depth }));
      } else if (diff < -0.3 * depth) {
        // The far rim stops short of the near one: a backward J (descending scallop), or its mirror.
        out.push(P(sign > 0 ? "scallop_descending" : "scallop_ascending_inverted", a.i, c.i, sign > 0
          ? { lower: bt.p, upper: c.p, height: depth, target_down: bt.p - depth, target_up: c.p + depth }
          : { upper: bt.p, lower: c.p, height: depth, target_up: bt.p + depth, target_down: c.p - depth }));
      }
      break;
    }
  }
  // Bump and run: a trend line, then price runs far from it (the bump) and comes back to it.
  for (const sign of [1, -1]) {
    const base = piv.filter((q) => q.t === (sign > 0 ? "L" : "H") && q.i <= 0.6 * n);
    if (base.length < 3) continue;
    const line = fit(base);
    // The lead-in is a real trend line: it slopes with the trend and its turns sit on it.
    if (sign * line.m < 0.05 * A || base.some((q) => Math.abs(q.p - line.at(q.i)) > 0.5 * A)) continue;
    const away = (i) => sign * ((sign > 0 ? b[i].h : b[i].l) - line.at(i));
    const split = Math.round(0.4 * n);
    let lead = 0, bump = 0, bumpAt = -1;
    for (let i = base[0].i; i < n; i++) { const d = away(i); if (i < split) lead = Math.max(lead, d); else if (d > bump) { bump = d; bumpAt = i; } }
    if (!(lead > 0.5 * A) || bump < 2 * lead || bump < 4 * A || bumpAt > n - 3 || bumpAt < base.at(-1).i) continue;
    if (sign * (b[n - 1].c - line.at(n - 1)) > 0.6 * bump) continue;
    out.push(P(sign > 0 ? "bump_and_run_top" : "bump_and_run_bottom", base[0].i, n - 1, sidesOf(sign, line.at(n - 1), sign > 0 ? b[bumpAt].h : b[bumpAt].l, lead)));
  }
  return out;
}

// ---------------------------------------------------------------- event patterns (chapters 54-57, 59)

/**
 * Pure: the event patterns of the bars. `events`: released figures [{ time (ISO or ms), gold_direction
 * (+1 bullish for gold, -1 bearish), title }]. The dead-cat bounces need no calendar: the event is the
 * bar that moved price by 4 ATR or more.
 */
function eventPatterns(b, A, events = []) {
  const out = [], n = b.length;
  // Dead-cat bounce (and its mirror): a drop of 4 ATR in one bar (6 in two), a bounce of 20 to 60 %, then lower again.
  for (let e = n - 3; e >= Math.max(3, n - 25) && !out.length; e--) {
    for (const len of [1, 2]) {
      const s = e - len, move = b[e].c - b[s].c, dir = Math.sign(move), size = Math.abs(move);
      if (s < 0 || size < (len === 1 ? 4 : 6) * A) continue;
      const rest = b.slice(e + 1);
      const tip = dir < 0 ? Math.min(...b.slice(s, e + 1).map((x) => x.l)) : Math.max(...b.slice(s, e + 1).map((x) => x.h));
      const bounce = dir < 0 ? Math.max(...rest.map((x) => x.h)) - tip : tip - Math.min(...rest.map((x) => x.l));
      if (bounce < 0.2 * size || bounce > 0.6 * size) continue;
      const back = dir < 0 ? tip + bounce : tip - bounce;
      out.push(P(dir < 0 ? "dead_cat_bounce" : "dead_cat_bounce_inverted", s, n - 1, sidesOf(-dir, tip, back, bounce)));
      break;
    }
  }
  // A release that surprised: its bar's high and low are the breakout lines, in the release's direction for gold.
  const withTime = b.every((x) => num(x.t));
  if (withTime && b.length >= 2) {
    const barMs = b[n - 1].t - b[n - 2].t;
    const released = (Array.isArray(events) ? events : []).map((ev) => ({ t: typeof ev?.time === "number" ? ev.time : Date.parse(String(ev?.time ?? "")), dir: Math.sign(Number(ev?.gold_direction) || 0), title: typeof ev?.title === "string" ? ev.title.slice(0, 60) : null }))
      .filter((ev) => Number.isFinite(ev.t) && ev.dir).sort((x, y) => y.t - x.t);
    for (const ev of released) {
      const i = b.findIndex((x) => ev.t < x.t && ev.t >= x.t - barMs);
      if (i < 1 || i < n - 20) continue;
      const height = b[i].h - b[i].l;
      if (height < 1.2 * A) continue;
      out.push({ ...P(ev.dir > 0 ? "event_surprise_bullish" : "event_surprise_bearish", i, i, sidesOf(-ev.dir, ev.dir > 0 ? b[i].h : b[i].l, ev.dir > 0 ? b[i].l : b[i].h, height)), event: ev.title });
      // A flag after the release bar's move.
      const flag = polePatterns(b, A, { poleEnd: i, idPrefix: "event" })[0];
      if (flag) out.push({ ...flag, event: ev.title });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- detection

/** More specific patterns first when two read the same bars. */
const RANK = ["head_and_shoulders", "triple", "double", "diamond", "cup", "event", "dead_cat", "island", "pipe", "horn", "flag", "pennant", "wedge", "triangle", "rectangle", "broadening", "bump", "three", "rounding", "scallop", "measured", "gap"];
const rankOf = (id) => { const k = RANK.findIndex((p) => id.startsWith(p)); return k < 0 ? RANK.length : k; };

/**
 * Pure: the chart patterns of a series of closed bars, the freshest and most specific first, at most
 * `max`. Each: { id, name, chapter, status ("forming", "confirmed", "busted"), direction (+1, -1 or 0),
 * upper, lower, height, target, start_bar, end_bar, bars_ago }. A pattern whose target was reached, or
 * whose last turn is more than `recent` bars old, is left out.
 */
export function detectPatterns(bars, { events = [], max = MAX_PATTERNS_PER_CHART, recent = 15 } = {}) {
  const b = normBars(bars);
  if (b.length < 20) return [];
  const A = meanRange(b);
  if (!(A > 0)) return [];
  const n = b.length, found = [];
  let late = false;
  const run = (fn) => { try { found.push(...fn().map((p) => (late ? { ...p, late: true } : p))); } catch { /* one detector never takes the others down */ } };
  for (const drop of [0, 1, 2]) {
    // Without the last one or two turns: only to keep following a pattern after it broke out.
    late = drop > 0;
    const all = zigzag(b);
    // A pattern's turns are confirmed ones; the provisional last swing only serves the legs and the handle.
    const turns = all.filter((q) => !q.prov);
    const piv = drop ? turns.slice(0, turns.length - drop) : turns;
    if (!drop) { run(() => measuredMoves(b, all, A)); run(() => roundedPatterns(b, all, A)); }
    if (piv.length < 3) break;
    run(() => peakPatterns(b, piv, A, 1));
    run(() => peakPatterns(b, piv, A, -1));
    run(() => diamondPatterns(b, piv, A));
    run(() => linePatterns(b, piv, A));
  }
  late = false;
  run(() => spikePatterns(b, A));
  run(() => polePatterns(b, A));
  run(() => gapPatterns(b, A));
  run(() => eventPatterns(b, A, events));

  const out = [], seen = new Set();
  const eps = 0.1 * A;
  for (const p of found.sort((x, y) => y.end - x.end || rankOf(x.id) - rankOf(y.id))) {
    const info = BY_ID.get(p.id);
    if (!info || seen.has(p.id) || !num(p.upper) && !num(p.lower)) continue;
    if (n - 1 - p.end > recent) continue;
    const c = b[n - 1].c;
    let direction = 0;
    if (num(p.upper) && c > p.upper + eps) direction = 1;
    else if (num(p.lower) && c < p.lower - eps) direction = -1;
    // A one-sided pattern that closed beyond its other side is busted: it then reads the other way.
    if (p.late && !direction) continue;
    const busted = direction !== 0 && ((info.sides === "up" && direction < 0) || (info.sides === "down" && direction > 0));
    const target = direction > 0 ? p.target_up : direction < 0 ? p.target_down : null;
    if (direction && num(target)) {
      const since = b.slice(p.end);
      if (direction > 0 ? since.some((x) => x.h >= target) : since.some((x) => x.l <= target)) continue;
    }
    if (direction && num(target) && target <= 0) continue;
    seen.add(p.id);
    out.push({
      id: p.id, name: info.name, chapter: info.n, status: !direction ? "forming" : busted ? "busted" : "confirmed", direction,
      upper: r2(p.upper), lower: r2(p.lower), height: r2(p.height), target: num(target) ? r2(target) : null,
      target_up: num(p.target_up) && p.target_up > 0 ? r2(p.target_up) : null, target_down: num(p.target_down) && p.target_down > 0 ? r2(p.target_down) : null,
      start_bar: p.start, end_bar: p.end, bars_ago: n - 1 - p.end, ...(p.event ? { event: p.event } : {})
    });
  }
  return out.sort((x, y) => (y.status !== "forming") - (x.status !== "forming") || x.bars_ago - y.bars_ago || rankOf(x.id) - rankOf(y.id)).slice(0, max);
}

/**
 * Pure: the levels a pattern gives the Projection Agent. Forming: its two breakout lines. Broken out: the
 * broken line (where a throwback or pullback returns) and the measured target; the other line stays, lighter.
 */
export function patternLevels(patterns) {
  const out = [];
  const add = (price, label, weight) => { if (num(price) && price > 0) out.push({ price, kind: "pattern", label, weight, unique: false }); };
  for (const p of Array.isArray(patterns) ? patterns : []) {
    if (p.status === "forming") {
      add(p.upper, `${p.name}: upper breakout line`, 0.6);
      add(p.lower, `${p.name}: lower breakout line`, 0.6);
      continue;
    }
    const up = p.direction > 0, word = p.status === "busted" ? "busted " : "";
    add(up ? p.upper : p.lower, `${word}${p.name}: broken ${up ? "upper" : "lower"} line (${up ? "throwback" : "pullback"} level)`, 0.8);
    add(p.target, `${word}${p.name}: measured target`, p.status === "busted" ? 0.6 : 0.7);
    add(up ? p.lower : p.upper, `${p.name}: ${up ? "lower" : "upper"} line`, 0.5);
  }
  return out;
}
