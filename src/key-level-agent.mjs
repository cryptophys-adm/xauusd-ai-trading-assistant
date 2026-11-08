// Key Level Agent (owner decision 2026-11-06): key levels are not only Camarilla. The agent
// gathers every key level of every chart, groups the ones that stack inside a narrow band into a
// zone, and a zone confirmed by at least two independent sources becomes a candidate key level.
// Deterministic: no model call; every price comes from closed bars or the HUD snapshots computed
// from them.
//
// Sources, each weighted by its kind and by its timeframe (15m 1, 1H 1.5, 4H 2, daily 2.5, weekly 3):
//   Camarilla        H3/L3 0.6, H4/L4 1.0, H5/L5 0.8, of the 15m, 1H, 4H, daily and weekly sets
//   pivot ranges     the daily and weekly pivot 1.0, CPR top and bottom 0.7
//   value area       the point of control 0.9, value area high and low 0.8, of the 15m, 1H, 4H and D1 charts
//   swings           the last swing highs and lows (2-bar fractals) of the 15m, 1H, 4H and D1 bars, 0.9
//   previous day     high and low 1.0, close 0.6; previous week high and low 1.0
//   round numbers    every 50 dollars 0.8, every 25 dollars 0.4, near price
//   order blocks     the best bullish and bearish block of each chart, top and bottom 0.7 (P6, 2026-11-07)
//   supertrend       the Supertrend line of each chart 0.6 (P6, 2026-11-07)
//   chart plane      every GMI chart object of each chart, through the four level readers
//                    (src/level-readers.mjs, owner decision 2026-11-08): bands, liquidity,
//                    projection and session, each with its own base weight
// A zone is a run of levels, sorted by price, whose span stays within the tolerance (0.3 x the 1H
// ATR, at least 1 dollar). Its score is the sum of its weights; its sources are the distinct
// (kind, timeframe) pairs. Strength: strong (score >= 6), medium (>= 3), weak. Candidate (owner decision
// 2026-11-06, tightened after production showed 14 of 18 zones at 2+ sources): 3+ sources and at
// least medium strength.

import { readPlane, READERS } from "./level-readers.mjs";

export const KEY_LEVEL_VERSION = "cryptophys.key-level-agent.v1";
export const TF_WEIGHT = Object.freeze({ "15": 1, "60": 1.5, "240": 2, D: 2.5, "1D": 2.5, W: 3 });
const TF_NAME = { "15": "15m", "60": "1H", "240": "4H", D: "daily", "1D": "daily", W: "weekly" };
const CAMARILLA_WEIGHT = { h3: 0.6, l3: 0.6, h4: 1, l4: 1, h5: 0.8, l5: 0.8 };
const SWING_LOOKBACK = 60, SWINGS_PER_SIDE = 4, ROUND_RANGE_ATR = 4;
export const CANDIDATE_MIN_SOURCES = 3, CANDIDATE_MIN_SCORE = 3;

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const r2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** The last swing highs and lows of closed bars: 2-bar fractals, newest first. */
export function swings(bars, { lookback = SWING_LOOKBACK, perSide = SWINGS_PER_SIDE } = {}) {
  const b = (bars || []).filter((x) => isNum(x?.high) && isNum(x?.low)).slice(-lookback);
  const highs = [], lows = [];
  for (let i = b.length - 3; i >= 2; i--) {
    const h = b[i].high, l = b[i].low;
    if (h > b[i - 1].high && h > b[i - 2].high && h >= b[i + 1].high && h >= b[i + 2].high && highs.length < perSide) highs.push(h);
    if (l < b[i - 1].low && l < b[i - 2].low && l <= b[i + 1].low && l <= b[i + 2].low && lows.length < perSide) lows.push(l);
  }
  return { highs, lows };
}

/**
 * Every raw key level of every chart. A Camarilla level, a pivot or a CPR edge has ONE value: the
 * daily, weekly and 4H sets appear in several snapshots, computed at different times (production
 * 2026-11-06: the D1 snapshot still held the 5 November set beside the current one, and both were
 * counted as two sources). The freshest snapshot wins; "1D" is the daily set ("D").
 */
export function rawLevels({ snapshots = {}, bars = {}, price = null, atrH1 = null } = {}) {
  const out = [], seen = new Set();
  const add = (p, kind, tf, label, weight, { unique = true, reader = null } = {}) => {
    if (!isNum(p)) return;
    const key = unique ? `${kind}:${tf}:${label}` : `${kind}:${tf}:${label}:${r2(p)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ price: r2(p), kind, tf, label, weight: r2(weight * (TF_WEIGHT[tf] ?? 1)), ...(reader ? { reader } : {}) });
  };
  const ORDER = ["15", "60", "240", "1D"];
  const fresh = Object.entries(snapshots).filter(([, snap]) => snap?.huds).sort(([a, x], [b, y]) => {
    const tx = Date.parse(x.computed_at ?? ""), ty = Date.parse(y.computed_at ?? "");
    if (Number.isFinite(tx) && Number.isFinite(ty) && tx !== ty) return ty - tx;
    return ORDER.indexOf(String(x.timeframe ?? a)) - ORDER.indexOf(String(y.timeframe ?? b));
  });
  for (const [chart, snap] of fresh) {
    const cam = snap.huds.interstellar_eyes?.fields?.camarilla || {};
    for (const [rawTf, lv] of Object.entries(cam)) {
      const tf = rawTf === "1D" ? "D" : rawTf;
      if (!lv || !TF_NAME[tf]) continue;
      for (const [k, w] of Object.entries(CAMARILLA_WEIGHT)) add(lv[k], "camarilla", tf, `${TF_NAME[tf]} Camarilla ${k.toUpperCase()}`, w);
    }
    const ch = snap.huds.chronos_matrix?.fields || {};
    for (const [tf, cpr] of [["D", ch.daily_cpr], ["W", ch.weekly_cpr]]) {
      if (!cpr) continue;
      add(cpr.pivot, "pivot", tf, `${TF_NAME[tf]} pivot`, 1);
      add(cpr.tc, "pivot", tf, `${TF_NAME[tf]} CPR top`, 0.7);
      add(cpr.bc, "pivot", tf, `${TF_NAME[tf]} CPR bottom`, 0.7);
    }
    // P6: the order blocks of each chart and its Supertrend line (a dynamic support or resistance).
    const obf = snap.huds.order_blocks?.fields || {};
    const obTf = String(snap.timeframe ?? chart);
    if (TF_NAME[obTf]) {
      add(obf.bull_top, "order block", obTf, `${TF_NAME[obTf]} bullish order block top`, 0.7);
      add(obf.bull_bottom, "order block", obTf, `${TF_NAME[obTf]} bullish order block bottom`, 0.7);
      add(obf.bear_top, "order block", obTf, `${TF_NAME[obTf]} bearish order block top`, 0.7);
      add(obf.bear_bottom, "order block", obTf, `${TF_NAME[obTf]} bearish order block bottom`, 0.7);
      add(snap.huds.supertrend?.fields?.line, "supertrend", obTf, `${TF_NAME[obTf]} Supertrend line`, 0.6);
    }
    const va = snap.huds.fabio_amt?.fields || {};
    const tf = String(snap.timeframe ?? chart);
    if (TF_NAME[tf]) {
      add(va.poc, "value", tf, `${TF_NAME[tf]} point of control`, 0.9);
      add(va.vah, "value", tf, `${TF_NAME[tf]} value area high`, 0.8);
      add(va.val, "value", tf, `${TF_NAME[tf]} value area low`, 0.8);
      // The four level readers of the chart plane. Session levels carry the daily timeframe and
      // one label for every chart, so the freshest snapshot's value is the one counted.
      for (const l of readPlane(snap.chart_plane, tf)) {
        const ltf = l.tf ?? tf;
        add(l.price, l.kind, ltf, l.tf ? l.label : `${TF_NAME[tf]} ${l.label}`, l.weight, { unique: l.unique !== false, reader: l.reader });
      }
    }
  }
  for (const [tf, series] of [["15", bars.M15], ["60", bars.H1], ["240", bars.H4], ["D", bars.D1]]) {
    const { highs, lows } = swings(series);
    highs.forEach((h) => add(h, "swing", tf, `${TF_NAME[tf]} swing high`, 0.9, { unique: false }));
    lows.forEach((l) => add(l, "swing", tf, `${TF_NAME[tf]} swing low`, 0.9, { unique: false }));
  }
  const pd = (bars.D1 || []).at(-1);
  if (pd) {
    add(pd.high, "previous", "D", "previous day high", 1);
    add(pd.low, "previous", "D", "previous day low", 1);
    add(pd.close, "previous", "D", "previous day close", 0.6);
  }
  const pw = (bars.W1 || []).at(-1);
  if (pw) {
    add(pw.high, "previous", "W", "previous week high", 1);
    add(pw.low, "previous", "W", "previous week low", 1);
  }
  if (isNum(price) && isNum(atrH1)) {
    const lo = price - ROUND_RANGE_ATR * atrH1, hi = price + ROUND_RANGE_ATR * atrH1;
    for (let p = Math.ceil(lo / 25) * 25; p <= hi; p += 25) add(p, "round", "15", `round ${p}`, p % 50 === 0 ? 0.8 : 0.4, { unique: false });
  }
  return out.sort((a, b) => a.price - b.price);
}

/** Groups sorted levels into zones whose span stays within `tolerance`. */
export function clusterLevels(levels, tolerance, price = null) {
  const zones = [];
  for (const l of levels) {
    const z = zones.at(-1);
    if (z && l.price - z.low <= tolerance) z.members.push(l);
    else zones.push({ low: l.price, members: [l] });
  }
  return zones.map((z) => {
    const m = z.members;
    const low = Math.min(...m.map((x) => x.price)), high = Math.max(...m.map((x) => x.price));
    const score = m.reduce((s, x) => s + x.weight, 0);
    const center = m.reduce((s, x) => s + x.price * x.weight, 0) / score;
    const sources = [...new Set(m.map((x) => `${x.kind}:${x.tf}`))];
    const strength = score >= 6 ? "strong" : score >= 3 ? "medium" : "weak";
    const sorted = [...m].sort((a, b) => b.weight - a.weight);
    const role = !isNum(price) ? null : price >= low - tolerance / 3 && price <= high + tolerance / 3 ? "at price" : center < price ? "support" : "resistance";
    return {
      low: r2(low), high: r2(high), price: r2(center), score: r2(score), sources: sources.length,
      candidate: sources.length >= CANDIDATE_MIN_SOURCES && score >= CANDIDATE_MIN_SCORE, strength, role,
      label: sorted.slice(0, 3).map((x) => x.label).join(" / ") + (m.length > 3 ? ` +${m.length - 3}` : ""),
      members: sorted.map((x) => ({ price: x.price, label: x.label, kind: x.kind, weight: x.weight, ...(x.reader ? { reader: x.reader } : {}) }))
    };
  });
}

/** The Key Level Agent's reading: every zone near price, the candidates first among equals. */
export function buildKeyLevels({ snapshots = {}, bars = {}, price = null, atrH1 = null } = {}) {
  const tolerance = Math.max(1, isNum(atrH1) ? 0.3 * atrH1 : 1);
  const raw = rawLevels({ snapshots, bars, price, atrH1 });
  const zones = clusterLevels(raw, tolerance, price);
  const near = isNum(price) && isNum(atrH1) ? zones.filter((z) => Math.abs(z.price - price) <= 4 * atrH1) : zones;
  const candidates = near.filter((z) => z.candidate);
  const nearestCandidate = (role) => candidates.filter((z) => z.role === role).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0] ?? null;
  const sup = nearestCandidate("support"), res = nearestCandidate("resistance"), at = candidates.find((z) => z.role === "at price") ?? null;
  const fmt = (z) => `${z.low === z.high ? z.low.toFixed(2) : `${z.low.toFixed(2)}–${z.high.toFixed(2)}`} (${z.strength}, ${z.sources} sources: ${z.label})`;
  const summary = !isNum(price) ? "No price yet." : [
    at ? `Price is inside a candidate zone at ${fmt(at)}.` : null,
    sup ? `Nearest candidate support ${fmt(sup)}.` : "No candidate support within four 1H ranges.",
    res ? `Nearest candidate resistance ${fmt(res)}.` : "No candidate resistance within four 1H ranges."
  ].filter(Boolean).join(" ");
  // How many levels each chart-plane reader contributed (the other sources have no reader).
  const readers = Object.fromEntries(Object.entries(READERS).map(([id, r]) => [id, { name: r.name, role: r.role, levels: raw.filter((l) => l.reader === id).length }]));
  return {
    version: KEY_LEVEL_VERSION, price: r2(price), atr_h1: r2(atrH1), tolerance: r2(tolerance),
    raw_count: raw.length, readers, zones: near, candidates, summary
  };
}
