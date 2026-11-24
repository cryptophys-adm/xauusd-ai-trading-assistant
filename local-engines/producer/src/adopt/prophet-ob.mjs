// Z1a (owner 2026-11-23: "Langsung prioritaskan"; docs/RFC_DEMAND_SUPPLY_ZONES.md §4): every active Prophet R38 order
// block as a demand or supply box, for the chart plane.
//
// An adapter, outside the Prophet core: local-engines/prophet-r38/src/core.mjs is hashed (provenance) and is not
// edited. The core already returns every active zone at the last bar (orderBlockEngine's active_order_block_zones),
// but the HUD only carries its single best block per side, and only at cycle intensity +3/-3. This module reads that
// list and nothing else:
//   - dir 1 is demand, dir -1 is supply;
//   - top and bottom as the core holds them at the last bar (after its mitigation trims), 3 dp;
//   - age_bars = the last bar's index - born (the window the core ran on: hud-snapshot.mjs's 1000 bars);
//   - high_volume is the core's own highVolume flag (core.mjs, the source bar's volume over its dynamic multiple);
//   - touches with the core's own rule: a bar within 0.15 x the chart's ATR(14) of the box, on the 40 bars before the
//     last, a touch at least 3 bars after the one counted before it (core.mjs key_level_touch_lookback,
//     ob_retest_band_atr); not capped here (the core caps at 3 only in its score; src/zone-types.mjs caps at 3);
//   - the `perSide` (4) nearest to the last close on each side: at most 8 boxes a chart.
// No price is invented: a zone without finite edges is skipped; no list gives null.
// B20 extends this file; B11 adds adopt/context.mjs (the 1000-bar window). Neither is part of this PR.

export const PROPHET_OB_ADOPT_VERSION = "cryptophys.adopt.prophet-ob.v1";
/** The core's own touch rule (core.mjs orderBlockEngine defaults) and Z1a's per-side cap. */
export const PROPHET_OB_RULES = Object.freeze({ per_side: 4, touch_band_atr: 0.15, touch_bars: 40, touch_gap: 3 });

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Pure: the touches of [bottom, top] on `bars` before the last one, with the core's rule (band = 0.15 x ATR, 0 without
 * an ATR, as the core's touchBand).
 */
export function prophetTouches(bottom, top, bars, atr) {
  const i = (Array.isArray(bars) ? bars.length : 0) - 1;
  const band = finite(atr) ? atr * PROPHET_OB_RULES.touch_band_atr : 0;
  let touches = 0, lastTouchBack = -10000;
  for (let back = 1; back <= PROPHET_OB_RULES.touch_bars; back++) {
    const k = i - back;
    if (k >= 0 && bars[k].low <= top + band && bars[k].high >= bottom - band) {
      if (back - lastTouchBack >= PROPHET_OB_RULES.touch_gap) { touches++; lastTouchBack = back; }
    }
  }
  return touches;
}

/**
 * Pure: the active Prophet order blocks of `ob` (the core's last-bar order_blocks output) as boxes
 * [{ side, top, bottom, age_bars, high_volume, touches }], the `perSide` nearest to the last close of `chartBars` (the
 * bars the core ran on) on each side, demand first, nearest first. `atr` is the chart's ATR(14) at the last bar
 * (the core's sensors.atr14). Null without the core's list or bars.
 */
export function prophetZones(ob, chartBars, { perSide = PROPHET_OB_RULES.per_side, atr = null } = {}) {
  const list = ob?.active_order_block_zones;
  const bars = Array.isArray(chartBars) ? chartBars : [];
  const last = bars.length - 1, close = bars[last]?.close;
  if (!Array.isArray(list) || last < 0 || !finite(close)) return null;
  const dist = (z) => (close < z.bottom ? z.bottom - close : close > z.top ? close - z.top : 0);
  const out = [];
  for (const [dir, side] of [[1, "demand"], [-1, "supply"]]) {
    const own = list.filter((z) => z?.dir === dir && finite(z.top) && finite(z.bottom) && z.top >= z.bottom && Number.isInteger(z.born));
    // A stable sort: equal distances keep the core's order (newest first).
    for (const z of own.map((z) => ({ z, d: dist(z) })).sort((a, b) => a.d - b.d).slice(0, Math.max(0, perSide)).map((x) => x.z)) {
      out.push({ side, top: r3(z.top), bottom: r3(z.bottom), age_bars: last - z.born, high_volume: z.highVolume === true, touches: prophetTouches(z.bottom, z.top, bars, atr) });
    }
  }
  return out;
}
