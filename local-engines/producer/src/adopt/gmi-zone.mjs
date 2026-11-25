// Z1b (owner 2026-11-23: "Langsung prioritaskan"; docs/RFC_DEMAND_SUPPLY_ZONES.md §4b): GMI v12.70's Aegis validated
// order blocks as demand and supply boxes, for the chart plane.
//
// A duplicate, outside the GMI core: local-engines/gmi/src/gmi-core.mjs is hashed (provenance) and is not edited. The
// core computes the validated blocks (its "Aegis validated order blocks" loop) but returns them only as the last bar's
// in_ob_bull / in_ob_bear flags. This module repeats that loop line for line, on the same inputs:
//   - obProgressiveUpdate from local-engines/gmi/src/mizan.mjs, and pivot / highest / lowest / nz / gt / lt / isNum from
//     local-engines/gmi/src/pine.mjs, imported unedited;
//   - ATR(14) by pineAtr (src/prophet-r37-oscillator.mjs, unedited), atrVal = max(ATR, mintick), as the core;
//   - volume = the bar's volume when finite, else na, as the core;
//   - the cfg is GMI_DEFAULTS (gmi-core.mjs, the frozen object itself) with the caller's overrides, as the core's
//     `{ ...GMI_DEFAULTS, ...options }`: ob_pivot_len 5, max_nodes_ob 60, ob_max_age 120, max_ob_per_direction 30,
//     ob_close_only false, mitig_buffer 0.25, max_wick_atr 3.0.
// One core serves every chart: gmi-core-tf.mjs (computeGmiOnChart: 5m, 15m, 1H) and gmi-core-htf.mjs
// (computeGmiOnHtfChart: 4H, 1D) are one-line re-exports of gmi-core.mjs's computeGmiOnChart since B4, so the loop,
// its inputs and the cfg are the same on every chart. local-engines/producer/test/gmi-zone.test.mjs holds the duplicate's
// per-bar in_ob_bull / in_ob_bear equal to the core's on every bar, and fails if the core drifts.
// Output at the last bar, from the blocks still active:
//   - a bullish block (the core's `bot`, direction 1) is demand, a bearish one (`top`, direction -1) supply;
//   - top and bottom as the loop holds them at the last bar (after its progressive mitigation), 3 dp;
//   - age_bars = the last bar's index - the block's activation bar (the bar its volume pivot confirmed; ob_max_age
//     counts from it), on the window the core runs on (hud-snapshot.mjs's 1000 bars);
//   - touches = obProgressiveUpdate's own `touched` events on the block that left it valid (every bar after the
//     activation bar whose range met the block's edges as they stood then; each such bar trims the block, so
//     consecutive bars count one each); not capped here (src/zone-types.mjs caps at 3);
//   - the `perSide` (4) nearest to the last close on each side, demand first, nearest first: at most 8 boxes a chart.
// No price is invented: a block without finite edges is skipped; no bars gives null.
// B20 extends this file (it never re-creates it); B11 adds adopt/context.mjs (the 1000-bar window).

import { GMI_DEFAULTS } from "../../../gmi/src/gmi-core.mjs";
import { obProgressiveUpdate } from "../../../gmi/src/mizan.mjs";
import { isNum, nz, gt, lt, pivot, highest, lowest } from "../../../gmi/src/pine.mjs";
import { pineAtr } from "../../../../src/prophet-r37-oscillator.mjs";

export const GMI_ZONE_ADOPT_VERSION = "cryptophys.adopt.gmi-zone.v1";
/** Z1b's per-side cap (the Aegis constants stay GMI_DEFAULTS'). */
export const GMI_ZONE_RULES = Object.freeze({ per_side: 4 });

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Pure: the core's Aegis validated order-block loop on `bars` (closed chart bars, oldest first: the series
 * computeGmiOnChart runs on). Returns { boxes, in_ob_bull, in_ob_bear }: `boxes` the active blocks at the last bar
 * [{ side, top, bottom, age_bars, touches }], the `perSide` nearest to the last close on each side; `in_ob_bull` and
 * `in_ob_bear` the core's per-bar flags (one boolean a bar). `cfg`: GMI_DEFAULTS overrides, with `mintick` (0.001) and
 * `perSide` (4). Null without bars or a finite last close.
 */
export function aegisBoxes(bars, { mintick = 0.001, perSide = GMI_ZONE_RULES.per_side, ...options } = {}) {
  const chart = Array.isArray(bars) ? bars : [];
  const n = chart.length, last = n - 1, lastClose = chart[last]?.close;
  if (n < 1 || !isNum(lastClose)) return null;
  const cfg = { ...GMI_DEFAULTS, ...options };
  const high = chart.map((b) => b.high), low = chart.map((b) => b.low), close = chart.map((b) => b.close);
  const volume = chart.map((b) => (isNum(b.volume) ? b.volume : null));
  const atr14 = pineAtr(chart, 14);
  const atrVal = atr14.map((a) => (isNum(a) ? Math.max(a, mintick) : null));

  // --- The core's loop (gmi-core.mjs, "Aegis validated order blocks -> in_ob_bull / in_ob_bear"), line for line. The
  // only additions are bookkeeping it does not read: each side's `touches` counter.
  const P = cfg.ob_pivot_len;
  const volPivot = pivot(volume, P, P, true);
  const rangeHigh = highest(high, P), rangeLow = lowest(low, P);
  const inObBull = new Array(n).fill(false), inObBear = new Array(n).fill(false);
  let dirState = 0;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const prior = dirState;
    if (i - P >= 0) dirState = gt(high[i - P], rangeHigh[i]) ? 0 : lt(low[i - P], rangeLow[i]) ? 1 : prior;
    if (isNum(volPivot[i])) {
      const j = i - P;
      const refAtr = Math.max(nz(atr14[j], atrVal[i]), mintick);
      const srcAtr = Math.max(nz(atr14[j], atr14[j]), mintick);
      const spanCap = Math.max(srcAtr * cfg.max_wick_atr, mintick);
      const mid = (high[j] + low[j]) / 2;
      const node = { activation: i, start: j, atr: refAtr, top: null, bot: null };
      if (dirState === 0) {
        const top = high[j], bottom = Math.max(mid, high[j] - spanCap);
        node.top = { upper: top, lower: bottom, span: Math.max(top - bottom, mintick), active: true, touches: 0 };
      } else if (dirState === 1) {
        const top = Math.min(mid, low[j] + spanCap), bottom = low[j];
        node.bot = { upper: top, lower: bottom, span: Math.max(top - bottom, mintick), active: true, touches: 0 };
      }
      nodes.push(node);
      let bulls = nodes.filter((x) => x.bot?.active).length, bears = nodes.filter((x) => x.top?.active).length;
      let k = 0;
      while (k < nodes.length && (bulls > cfg.max_ob_per_direction || bears > cfg.max_ob_per_direction)) {
        const c = nodes[k];
        const pb = c.bot?.active && bulls > cfg.max_ob_per_direction, pr = c.top?.active && bears > cfg.max_ob_per_direction;
        if (pb || pr) { if (c.bot?.active) bulls--; if (c.top?.active) bears--; nodes.splice(k, 1); } else k++;
      }
      while (nodes.length > cfg.max_nodes_ob) nodes.shift();
    }
    for (let k = nodes.length - 1; k >= 0; k--) {
      const node = nodes[k];
      if (i - node.activation > cfg.ob_max_age) { if (node.top) node.top.active = false; if (node.bot) node.bot.active = false; }
      for (const [side, dir] of [["top", -1], ["bot", 1]]) {
        const z = node[side];
        if (!z?.active) continue;
        const u = obProgressiveUpdate(dir, z.upper, z.lower, z.span, node.atr, high[i], low[i], close[i], cfg.mitig_buffer, i > node.activation, cfg.ob_close_only, mintick);
        z.upper = u.top; z.lower = u.bottom;
        if (u.touched && !u.invalid) { if (dir === -1) inObBear[i] = true; else inObBull[i] = true; z.touches++; }
        if (u.invalid) z.active = false;
      }
      if (!node.top?.active && !node.bot?.active) nodes.splice(k, 1);
    }
  }

  // --- The active blocks at the last bar, the `perSide` nearest to its close on each side.
  const dist = (b) => (lastClose < b.bottom ? b.bottom - lastClose : lastClose > b.top ? lastClose - b.top : 0);
  const boxes = [];
  for (const [key, side] of [["bot", "demand"], ["top", "supply"]]) {
    const own = [];
    for (const node of nodes) {
      const z = node[key];
      if (!z?.active || !isNum(z.upper) || !isNum(z.lower) || z.upper < z.lower) continue;
      own.push({ side, top: r3(z.upper), bottom: r3(z.lower), age_bars: last - node.activation, touches: z.touches, d: dist({ top: z.upper, bottom: z.lower }) });
    }
    // Nearest first; at an equal distance the younger block first.
    own.sort((a, b) => a.d - b.d || a.age_bars - b.age_bars);
    for (const { d, ...box } of own.slice(0, Math.max(0, perSide))) boxes.push(box);
  }
  return { boxes, in_ob_bull: inObBull, in_ob_bear: inObBear };
}
