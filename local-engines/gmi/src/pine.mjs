// Pine Script v6 series semantics used by the local GMI engine.
// Series are plain arrays indexed oldest -> newest; `null` is Pine `na`.
// Comparisons involving na are false, as in Pine.

export const isNum = (x) => typeof x === "number" && Number.isFinite(x);
export const nz = (x, fallback = 0) => (isNum(x) ? x : fallback);
export const gt = (a, b) => isNum(a) && isNum(b) && a > b;
export const lt = (a, b) => isNum(a) && isNum(b) && a < b;
export const ge = (a, b) => isNum(a) && isNum(b) && a >= b;
export const le = (a, b) => isNum(a) && isNum(b) && a <= b;
export const eq = (a, b) => isNum(a) && isNum(b) && a === b;
export const ne = (a, b) => isNum(a) && isNum(b) && a !== b;
export const sign = (x) => (isNum(x) ? Math.sign(x) : null);
export const max2 = (a, b) => (isNum(a) && isNum(b) ? Math.max(a, b) : null);
export const min2 = (a, b) => (isNum(a) && isNum(b) ? Math.min(a, b) : null);

function windowValues(src, i, len) {
  if (!Number.isInteger(len) || len < 1 || i - len + 1 < 0) return null;
  return src.slice(i - len + 1, i + 1);
}

/** ta.sma: na until `len` values exist; na if any value in the window is na. */
export function sma(src, len) {
  return src.map((_, i) => {
    const w = windowValues(src, i, len);
    if (!w || w.some((v) => !isNum(v))) return null;
    return w.reduce((a, b) => a + b, 0) / len;
  });
}

/** math.sum: na until `len` values exist; na if any value is na. */
export function sum(src, len) {
  return src.map((_, i) => {
    const w = windowValues(src, i, len);
    if (!w || w.some((v) => !isNum(v))) return null;
    return w.reduce((a, b) => a + b, 0);
  });
}

/** ta.ema: alpha = 2/(len+1), seeded with ta.sma when the previous value is na. */
export function ema(src, len) {
  const alpha = 2 / (len + 1);
  const seed = sma(src, len);
  const out = [];
  let prev = null;
  for (let i = 0; i < src.length; i++) {
    let v;
    if (!isNum(prev)) v = seed[i];
    else v = isNum(src[i]) ? alpha * src[i] + (1 - alpha) * prev : null;
    out.push(isNum(v) ? v : null);
    prev = out[i];
  }
  return out;
}

/** ta.change(src) = src - src[1]. */
export function change(src) {
  return src.map((v, i) => (i > 0 && isNum(v) && isNum(src[i - 1]) ? v - src[i - 1] : null));
}

/** ta.highest / ta.lowest over `len` bars (na values ignored; na until len bars exist). */
export function highest(src, len) {
  return src.map((_, i) => {
    const w = windowValues(src, i, len);
    const vals = w ? w.filter(isNum) : [];
    return vals.length ? Math.max(...vals) : null;
  });
}
export function lowest(src, len) {
  return src.map((_, i) => {
    const w = windowValues(src, i, len);
    const vals = w ? w.filter(isNum) : [];
    return vals.length ? Math.min(...vals) : null;
  });
}

/** ta.stdev (biased/population). */
export function stdev(src, len) {
  const mean = sma(src, len);
  return src.map((_, i) => {
    if (!isNum(mean[i])) return null;
    let s = 0;
    for (let k = i - len + 1; k <= i; k++) s += (src[k] - mean[i]) ** 2;
    return Math.sqrt(s / len);
  });
}

/**
 * ta.linreg(src, length, offset) for a per-bar length series.
 * Least squares over the last `length` values (x = 0 oldest .. length-1
 * newest), evaluated at x = length - 1 - offset.
 */
export function linregAt(src, i, length, offset) {
  if (!Number.isInteger(length) || length < 1 || i - length + 1 < 0) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let x = 0; x < length; x++) {
    const y = src[i - length + 1 + x];
    if (!isNum(y)) return null;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = length * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (length * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / length;
  return intercept + slope * (length - 1 - offset);
}

/** ta.percentrank: % of the previous `len` values <= current value. */
export function percentrank(src, len) {
  return src.map((v, i) => {
    if (!isNum(v) || i - len < 0) return null;
    let count = 0;
    for (let k = 1; k <= len; k++) if (le(src[i - k], v)) count++;
    return (count / len) * 100;
  });
}

/** ta.pivothigh / ta.pivotlow: value confirmed `right` bars later (strict on both sides). */
export function pivot(src, left, right, high) {
  return src.map((_, i) => {
    const p = i - right;
    if (p - left < 0) return null;
    const value = src[p];
    if (!isNum(value)) return null;
    for (let k = p - left; k <= p + right; k++) {
      if (k === p || !isNum(src[k])) continue;
      if (high ? src[k] >= value : src[k] <= value) return null;
    }
    return value;
  });
}

/** ta.barssince(cond): bars since cond was last true; na if never. */
export function barssince(cond) {
  let last = null;
  return cond.map((c, i) => {
    if (c) last = i;
    return last === null ? null : i - last;
  });
}

/** ta.crossover(a, b) / ta.crossunder(a, b) at bar i. */
export const crossover = (a, b, i) => i > 0 && gt(a[i], b[i]) && le(a[i - 1], b[i - 1]);
export const crossunder = (a, b, i) => i > 0 && lt(a[i], b[i]) && ge(a[i - 1], b[i - 1]);
