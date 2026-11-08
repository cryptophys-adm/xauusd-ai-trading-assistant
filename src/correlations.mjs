// Nexus correlations panel (backlog 11.3, owner request 2026-11-07 "Nexus vs KIRA"): DXY, the US
// 10-year yield and silver beside gold, with their change and the rolling correlation of their 4h
// returns with gold's. Deterministic, read-only, from the pull adapter's cached 4h series
// (SIGNAL_CACHE). Context only: it never reaches a room, a prompt or a decision.
//
// Alignment is as-of: each asset's close is the last one at or before each gold 4h close, and no
// older than one bar, so series whose 4h bars start at different hours still line up.

export const CORRELATIONS_VERSION = "cryptophys.correlations.v1";
const KEY = (k) => "market-data:v2:series:" + k;
const H4 = 14_400_000;
export const GOLD = Object.freeze({ id: "gold", name: "Gold", symbol: "OANDA:XAUUSD", key: "OANDA:XAUUSD|4h", unit: "pct" });
export const ASSETS = Object.freeze([
  Object.freeze({ id: "dxy", name: "US Dollar Index", symbol: "TVC:DXY", key: "TVC:DXY|4h", unit: "pct" }),
  // A yield: its change is in basis points, and its returns are differences, not ratios.
  Object.freeze({ id: "us10y", name: "US 10-year yield", symbol: "TVC:US10Y", key: "TVC:US10Y|4h", unit: "bp" }),
  Object.freeze({ id: "silver", name: "Silver", symbol: "OANDA:XAGUSD", key: "OANDA:XAGUSD|4h", unit: "pct" })
]);
/** Rolling windows in 4h bars: about one trading week and about one trading month. */
export const WINDOWS = Object.freeze({ short: 30, long: 120 });

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r = (x, d = 3) => (finite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

export function closes(record, now = Date.now()) {
  const candles = Array.isArray(record?.candles) ? record.candles : [];
  return candles.filter((c) => finite(c.close) && c.close_time && Date.parse(c.close_time) <= now)
    .map((c) => ({ t: Date.parse(c.close_time), close: c.close })).sort((a, b) => a.t - b.t);
}

/** Pure: the asset's close at or before each grid time, within one bar; null otherwise. */
export function asOf(series, grid, maxAge = H4) {
  const out = [];
  let j = 0;
  for (const t of grid) {
    while (j + 1 < series.length && series[j + 1].t <= t) j += 1;
    const s = series[j];
    out.push(s && s.t <= t && t - s.t <= maxAge ? s.close : null);
  }
  return out;
}

const ret = (unit) => (a, b) => (finite(a) && finite(b) ? (unit === "bp" ? b - a : (a > 0 && b > 0 ? Math.log(b / a) : null)) : null);

/** Pure: Pearson correlation of two equal-length arrays over the pairs where both are numbers. */
export function pearson(x, y) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(([a, b]) => finite(a) && finite(b));
  const n = pairs.length;
  if (n < 10) return { r: null, n };
  const mx = pairs.reduce((s, [a]) => s + a, 0) / n, my = pairs.reduce((s, [, b]) => s + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [a, b] of pairs) { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; }
  return { r: sxx > 0 && syy > 0 ? r(sxy / Math.sqrt(sxx * syy)) : null, n };
}

/** Pure: the panel from gold's and the assets' closes ({ t, close }, oldest first). */
export function buildCorrelations({ gold, assets }) {
  const grid = gold.map((g) => g.t);
  const goldRet = gold.map((g, i) => (i ? ret("pct")(gold[i - 1].close, g.close) : null));
  const changeOf = (vals, unit, bars) => {
    const last = vals.at(-1), prev = vals.length > bars ? vals[vals.length - 1 - bars] : null;
    if (!finite(last) || !finite(prev)) return null;
    return unit === "bp" ? r((last - prev) * 100, 1) : r(((last - prev) / prev) * 100, 2);
  };
  const goldCloses = gold.map((g) => g.close);
  const rows = assets.map(({ spec, series }) => {
    const aligned = asOf(series, grid);
    const rets = aligned.map((v, i) => (i ? ret(spec.unit)(aligned[i - 1], v) : null));
    const corr = (w) => pearson(goldRet.slice(-w), rets.slice(-w));
    const short = corr(WINDOWS.short), long = corr(WINDOWS.long);
    return {
      id: spec.id, name: spec.name, symbol: spec.symbol, unit: spec.unit,
      last: series.at(-1)?.close ?? null, last_close_time: series.length ? new Date(series.at(-1).t).toISOString() : null,
      change: { "4h": changeOf(aligned, spec.unit, 1), "1d": changeOf(aligned, spec.unit, 6), "5d": changeOf(aligned, spec.unit, 30) },
      correlation: { short: short.r, short_n: short.n, long: long.r, long_n: long.n },
      available: series.length > 0
    };
  });
  return {
    version: CORRELATIONS_VERSION, timeframe: "4h", windows: WINDOWS,
    note: "Pearson correlation of 4h returns with gold (log returns; yield changes for US10Y), as-of aligned to gold's 4h closes. Context only.",
    gold: { name: GOLD.name, symbol: GOLD.symbol, last: gold.at(-1)?.close ?? null, last_close_time: gold.length ? new Date(gold.at(-1).t).toISOString() : null, change: { "4h": changeOf(goldCloses, "pct", 1), "1d": changeOf(goldCloses, "pct", 6), "5d": changeOf(goldCloses, "pct", 30) } },
    assets: rows
  };
}

/** GET /api/correlations: from the cached 4h series. */
export async function readCorrelations(env, { now = Date.now() } = {}) {
  const get = async (key) => { try { return JSON.parse((await env.SIGNAL_CACHE?.get?.(KEY(key))) || "null"); } catch { return null; } };
  const gold = closes(await get(GOLD.key), now);
  const assets = [];
  for (const spec of ASSETS) assets.push({ spec, series: closes(await get(spec.key), now) });
  return buildCorrelations({ gold, assets });
}
