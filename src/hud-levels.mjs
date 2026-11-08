// Numeric market structure for the Nexus charts (owner decision 2026-11-06): the Camarilla levels
// and central pivot ranges a HUD snapshot already carries, and the regime sensors as six axes
// in [0, 1] for a radar. Display only: nothing here enters the H1 decision lane, and no number is
// computed that the snapshot does not hold (a missing field reads null, never a default).
//
// Calibration follows src/hud-reading.mjs: Camarilla, pivots and close are pure formulas of
// closed bars, so they read "computed from verified bars" when the candle's bar is verified;
// the regime sensors are engine internals and read "not yet calibrated".

/** HUD snapshot timeframes the levels endpoint serves. */
export const LEVEL_TIMEFRAMES = Object.freeze(["15", "60", "240", "1D"]);

const TF_LABEL = { "15": "15-minute", "60": "1-hour", "240": "4-hour", D: "Daily", W: "Weekly" };
const LEVEL_KEYS = ["h6", "h5", "h4", "h3", "l3", "l4", "l5", "l6"];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v) => (isNum(v) ? Math.max(0, Math.min(1, v)) : null);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

function camarillaRows(f, chartTf) {
  const cam = f?.camarilla && typeof f.camarilla === "object" ? f.camarilla : {};
  const rows = [];
  for (const [tf, levels] of Object.entries(cam)) {
    if (!levels || typeof levels !== "object" || !LEVEL_KEYS.every((k) => isNum(levels[k]))) continue;
    rows.push({ tf, label: TF_LABEL[tf] ?? tf, band: f?.band?.[tf] ?? null, levels: Object.fromEntries(LEVEL_KEYS.map((k) => [k, levels[k]])) });
  }
  // The chart's own timeframe first, then the higher ones from the nearest up.
  const rank = (tf) => (tf === chartTf || (chartTf === "1D" && tf === "D") ? -1 : ["15", "60", "240", "D", "W"].indexOf(tf));
  return rows.sort((a, b) => rank(a.tf) - rank(b.tf));
}

function cprRow(c) {
  if (!c || typeof c !== "object" || !isNum(c.pivot) || !isNum(c.tc) || !isNum(c.bc)) return null;
  return { pivot: c.pivot, tc: c.tc, bc: c.bc, width: isNum(c.width) ? c.width : r2(c.tc - c.bc), position: c.position ?? null };
}

/**
 * The regime as six axes in [0, 1], each with its raw value:
 * trend (Hurst), efficiency (Kaufman ratio), stretch (|z| of 3), participation (volume of 2x
 * its average), cycle alignment (|cycle intensity| of 3) and order (1 − entropy).
 */
function regime(huds) {
  const p = huds?.prophet?.fields ?? {}, k = huds?.kinetic_engine?.fields ?? {};
  const axes = [
    { key: "trend", label: "Trend", raw: p.hurst ?? null, value: r2(clamp01(p.hurst)) },
    { key: "efficiency", label: "Efficiency", raw: p.efficiency_ratio ?? null, value: r2(clamp01(p.efficiency_ratio)) },
    { key: "stretch", label: "Stretch", raw: p.kww_zscore ?? null, value: isNum(p.kww_zscore) ? r2(clamp01(Math.abs(p.kww_zscore) / 3)) : null },
    { key: "participation", label: "Volume", raw: p.volume_ratio ?? null, value: isNum(p.volume_ratio) ? r2(clamp01(p.volume_ratio / 2)) : null },
    { key: "cycle_alignment", label: "Cycles", raw: p.cycle_intensity ?? null, value: isNum(p.cycle_intensity) ? r2(clamp01(Math.abs(p.cycle_intensity) / 3)) : null },
    { key: "order", label: "Order", raw: k.entropy ?? null, value: isNum(k.entropy) ? r2(clamp01(1 - k.entropy)) : null }
  ];
  return { axes, chaos: k.is_chaos === true, z: isNum(p.kww_zscore) ? p.kww_zscore : null };
}

/** Levels and regime of one HUD snapshot. `barsVerified` comes from hud-store barsVerified. */
export function hudLevels(snapshot, { barsVerified = false } = {}) {
  const huds = snapshot?.huds ?? {};
  const eyes = huds.interstellar_eyes?.fields ?? {};
  const chronos = huds.chronos_matrix?.fields ?? {};
  const close = isNum(eyes.close) ? eyes.close : isNum(huds.fabio_amt?.fields?.close) ? huds.fabio_amt.fields.close : null;
  return {
    candle_key: snapshot?.candle_key ?? null,
    timeframe: snapshot?.timeframe ?? null,
    computed_at: snapshot?.computed_at ?? null,
    bars_verified: barsVerified === true,
    close,
    camarilla: camarillaRows(eyes, snapshot?.timeframe),
    cpr: { daily: cprRow(chronos.daily_cpr), weekly: cprRow(chronos.weekly_cpr) },
    regime: regime(huds),
    calibration: { levels: barsVerified ? "computed_from_verified_bars" : "not_yet_calibrated", regime: "not_yet_calibrated" },
    // Every price object GMI draws on the chart (the producer's chart plane), for the Nexus chart
    // layers (owner decision 2026-11-08). Unverified context: no TradingView alert carries it.
    chart_plane: snapshot?.chart_plane && typeof snapshot.chart_plane === "object" ? snapshot.chart_plane : null
  };
}
