// The four level readers of the chart plane (owner decision 2026-11-08, PR 2 of the key-level
// plan). Each reads one family of the GMI chart objects that the HUD snapshot's `chart_plane`
// carries (local-engines/producer/src/chart-plane.mjs) and hands the Key Level Agent its levels,
// with a base weight (the agent multiplies it by the chart's timeframe weight). Deterministic, no
// model call; a missing plane or field yields no level, never a default.
//
//   Band Agent        KWW +-1.618 0.7, KWW MA 0.5, EMA 114 0.6, VWAP 0.6 (15m and 1H only), TVA
//                     channel edges 0.5: where price is stretched from its mean.
//   Liquidity Agent   RBS/SBR 1.0, QM 0.9, active whale zone edges 0.9, mitigation block edges 0.7,
//                     the three nearest open FVG targets per side 0.7 x their mass (0.3 to 1.5), HVN
//                     0.8, LVN 0.5 (a thin area price crosses fast, not a wall).
//   Projection Agent  Fibonacci OTE 0.618 and 0.786 0.8, 0.5 0.6, extensions 1.272 and 1.618 0.7
//                     (targets), the probability cone p90/p10 0.4, the tactical trendlines at the bar
//                     0.5, PA support and resistance 0.6.
//   Session Agent     True Openings: month 1.0, year 1.0, week and day 0.8, Asia, London, NY AM, NY PM
//                     0.5; the trading day open 0.6 and week open 0.8; the session profile POC 0.9,
//                     VAH and VAL 0.8. Session levels are one value for every chart, so they carry
//                     the daily timeframe ("D") and the freshest snapshot wins.
// The TDM POC/VAH/VAL and the previous day and week high/low are already read elsewhere (the
// value area of each chart and the bars), so the readers skip them.

export const LEVEL_READERS_VERSION = "cryptophys.level-readers.v1";
export const READERS = Object.freeze({
  band: { name: "Band Agent", role: "where price is stretched from its mean (KWW, EMA 114, VWAP, TVA)" },
  liquidity: { name: "Liquidity Agent", role: "where orders wait (FVG, whale zones, QM, RBS/SBR, LVN/HVN)" },
  projection: { name: "Projection Agent", role: "where a move projects (Fibonacci, the probability cone, trendlines)" },
  session: { name: "Session Agent", role: "the opens and the session volume profile" }
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Pure: the Band Agent's levels of one chart plane. */
export function bandLevels(plane, tf) {
  const b = plane?.bands, out = [];
  if (!b) return out;
  const add = (price, label, weight) => { if (isNum(price)) out.push({ price, kind: "band", label, weight }); };
  add(b.kww?.plus_1618, "KWW +1.618σ", 0.7);
  add(b.kww?.minus_1618, "KWW −1.618σ", 0.7);
  add(b.kww?.ma, "KWW mean", 0.5);
  add(b.ema_114, "EMA 114", 0.6);
  if (tf === "15" || tf === "60") add(b.vwap, "VWAP", 0.6);
  add(b.tva?.upper, "TVA channel top", 0.5);
  add(b.tva?.lower, "TVA channel bottom", 0.5);
  return out;
}

/** Pure: the Liquidity Agent's levels of one chart plane. */
export function liquidityLevels(plane) {
  const l = plane?.liquidity, out = [];
  if (!l) return out;
  const add = (price, label, weight, kind = "liquidity") => { if (isNum(price)) out.push({ price, kind, label, weight, unique: false }); };
  add(l.gabfx?.rbs, "RBS flip level", 1.0);
  add(l.gabfx?.sbr, "SBR flip level", 1.0);
  add(l.gabfx?.qm_buy, "QM buy level", 0.9);
  add(l.gabfx?.qm_sell, "QM sell level", 0.9);
  for (const z of l.whale_zones || []) {
    const name = z.state === "active" ? `whale ${z.role} zone` : `whale mitigation block (${z.role})`;
    const w = z.state === "active" ? 0.9 : 0.7;
    add(z.top, `${name} top`, w, "whale");
    add(z.bottom, `${name} bottom`, w, "whale");
  }
  for (const [side, list] of [["bull", l.fvg?.bull], ["bear", l.fvg?.bear]]) {
    for (const f of (list || []).slice(0, 3)) add(f.price, `open ${side === "bull" ? "bullish" : "bearish"} FVG target`, Math.round(0.7 * clamp(Number(f.mass) || 0, 0.3, 1.5) * 100) / 100, "fvg");
  }
  add(l.profile?.hvn_bull, "high-volume node below", 0.8, "volume node");
  add(l.profile?.hvn_bear, "high-volume node above", 0.8, "volume node");
  for (const p of l.profile?.lvn_bull || []) add(p, "low-volume node below", 0.5, "volume node");
  for (const p of l.profile?.lvn_bear || []) add(p, "low-volume node above", 0.5, "volume node");
  return out;
}

/** Pure: the Projection Agent's levels of one chart plane. */
export function projectionLevels(plane) {
  const p = plane?.projection, out = [];
  if (!p) return out;
  const add = (price, label, weight, kind = "fibonacci") => { if (isNum(price)) out.push({ price, kind, label, weight }); };
  const fib = p.fib?.levels || {};
  add(fib["0.618"], "Fibonacci 0.618 (OTE)", 0.8);
  add(fib["0.786"], "Fibonacci 0.786 (OTE)", 0.8);
  add(fib["0.5"], "Fibonacci 0.5", 0.6);
  add(fib["1.272"], "Fibonacci 1.272 extension", 0.7);
  add(fib["1.618"], "Fibonacci 1.618 extension", 0.7);
  add(p.cone?.p90, "probability cone p90", 0.4, "cone");
  add(p.cone?.p10, "probability cone p10", 0.4, "cone");
  add(p.trendlines?.resistance?.price_now, "tactical resistance trendline", 0.5, "trendline");
  add(p.trendlines?.support?.price_now, "tactical support trendline", 0.5, "trendline");
  add(p.pa?.resistance, "PA resistance", 0.6, "pa");
  add(p.pa?.support, "PA support", 0.6, "pa");
  return out;
}

/** Pure: the Session Agent's levels of one chart plane (daily timeframe, one value for every chart). */
export function sessionLevels(plane) {
  const s = plane?.session, out = [];
  if (!s) return out;
  const add = (price, label, weight, kind = "open") => { if (isNum(price)) out.push({ price, kind, label, weight, tf: "D" }); };
  const o = s.opens || {};
  add(o.year, "true year open", 1.0);
  add(o.month, "true month open", 1.0);
  add(o.week, "true week open", 0.8);
  add(o.day, "true day open", 0.8);
  add(o.asia, "true Asia open", 0.5);
  add(o.london, "true London open", 0.5);
  add(o.ny_am, "true NY AM open", 0.5);
  add(o.ny_pm, "true NY PM open", 0.5);
  add(s.baselines?.day_open, "trading day open", 0.6);
  add(s.baselines?.week_open, "trading week open", 0.8);
  const cur = s.profile?.current;
  add(cur?.poc, "session point of control", 0.9, "session profile");
  add(cur?.vah, "session value area high", 0.8, "session profile");
  add(cur?.val, "session value area low", 0.8, "session profile");
  return out;
}

/** Pure: every reader's levels of one chart plane, tagged with the reader. */
export function readPlane(plane, tf) {
  if (!plane || typeof plane !== "object") return [];
  return [
    ...bandLevels(plane, tf).map((l) => ({ ...l, reader: "band" })),
    ...liquidityLevels(plane).map((l) => ({ ...l, reader: "liquidity" })),
    ...projectionLevels(plane).map((l) => ({ ...l, reader: "projection" })),
    ...sessionLevels(plane).map((l) => ({ ...l, reader: "session" }))
  ];
}

/**
 * Pure: the setup type at price for a side (dir +1 long, -1 short), from the 15m chart plane, with
 * the 1H plane for the Fibonacci leg when the 15m has none:
 *   continuation_pullback  with the trend: price in the OTE band (0.618 to 0.786) of a leg in the
 *                          trade's direction, or back at the KWW mean to -1 sigma (z between -1.618
 *                          and 0 for a long), with a liquidity level with the trade within `near`
 *                          (an open FVG target, RBS/SBR, an active whale zone);
 *   reversal_sweep         price stretched beyond 1.618 sigma against the trade (z <= -1.618 for a
 *                          long) at a QM level or a whale zone with the trade;
 *   none                   otherwise.
 * Returns { type, evidence[] }. Context for the 15m location layer; it never decides alone.
 */
export function setupType({ dir, price, m15Plane = null, h1Plane = null, near = null } = {}) {
  const none = { type: "none", evidence: [] };
  if (!dir || !isNum(price) || !m15Plane) return none;
  const z = m15Plane.bands?.kww?.zscore;
  const tol = isNum(near) ? near : isNum(m15Plane.atr) ? 0.35 * m15Plane.atr : null;
  if (!isNum(tol)) return none;
  const within = (p) => isNum(p) && Math.abs(p - price) <= tol;
  const inside = (zone) => isNum(zone?.top) && isNum(zone?.bottom) && price >= zone.bottom - tol && price <= zone.top + tol;
  const liq = m15Plane.liquidity || {};
  const side = dir > 0 ? "support" : "resistance";
  const ev = [];
  const fvg = (dir > 0 ? liq.fvg?.bull : liq.fvg?.bear) || [];
  if (fvg.some((f) => within(f.price))) ev.push(`at an open ${dir > 0 ? "bullish" : "bearish"} FVG target`);
  if (within(dir > 0 ? liq.gabfx?.rbs : liq.gabfx?.sbr)) ev.push(`at the ${dir > 0 ? "RBS" : "SBR"} flip level`);
  const whale = (liq.whale_zones || []).find((w) => w.role === side && inside(w));
  if (whale) ev.push(`inside a whale ${whale.state === "active" ? side + " zone" : "mitigation block"}`);
  const qm = within(dir > 0 ? liq.gabfx?.qm_buy : liq.gabfx?.qm_sell);

  // Reversal: stretched against the trade, at a QM level or a whale zone with it.
  if (typeof z === "number" && z * dir <= -1.618 && (qm || whale)) {
    return { type: "reversal_sweep", evidence: [`stretched ${z.toFixed(2)}σ from the KWW mean`, ...(qm ? [`at the QM ${dir > 0 ? "buy" : "sell"} level`] : []), ...(whale ? [ev.at(-1)] : [])] };
  }
  // Continuation: a pullback inside the OTE band of a leg with the trade, or to the mean.
  const leg = [m15Plane.projection?.fib, h1Plane?.projection?.fib].find((f) => f && f.direction === (dir > 0 ? "up" : "down"));
  const ote = leg ? [leg.levels?.["0.618"], leg.levels?.["0.786"]].filter(isNum) : [];
  const inOte = ote.length === 2 && price >= Math.min(...ote) - tol && price <= Math.max(...ote) + tol;
  const meanPullback = typeof z === "number" && z * dir <= 0 && z * dir > -1.618;
  const liqWithTrade = ev.length > 0;
  if ((inOte || meanPullback) && liqWithTrade) {
    return { type: "continuation_pullback", evidence: [...(inOte ? [`inside the Fibonacci OTE band of the ${leg === m15Plane.projection?.fib ? "15m" : "1H"} leg`] : []), ...(meanPullback ? [`back at the KWW mean (${z.toFixed(2)}σ)`] : []), ...ev] };
  }
  return none;
}
