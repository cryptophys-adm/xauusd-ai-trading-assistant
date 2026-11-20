// The knobs of the council's bounded stop loosening (platform ADR-0020 Amendment 8, owner 2026-11-20; docs/RFC_PM_A8.md):
// one table for the Position Manager (src/position-manager.mjs) and Omega's check of its actions (src/omega-engine.mjs).
// Start values per mode, clamped to the bounds xauusd proposes for the platform's doctrine facts. No reader of the
// platform's omega.pm_loosen_* facts exists yet, so the start values hold. Amending a bound is the owner's. Pure.

const MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);

/** The start values per mode: the ATR(14, 15m) expansion ratio that counts as a measured reason, and the share of the way back. */
export const PM_LOOSEN_KNOB_START = Object.freeze({
  scalp: Object.freeze({ atr_expand: 1.6, back_share: 0.4 }),
  intraday: Object.freeze({ atr_expand: 1.5, back_share: 0.5 }),
  swing: Object.freeze({ atr_expand: 1.5, back_share: 0.6 }),
  range: Object.freeze({ atr_expand: 1.8, back_share: 0.4 })
});
const shared = Object.freeze({ atr_expand: Object.freeze({ min: 1.2, max: 2.5 }), back_share: Object.freeze({ min: 0.25, max: 1 }) });
/** The bounds per mode (proposed to the platform; ratio ATR now / ATR reference, and a fraction of the way back). */
export const PM_LOOSEN_KNOB_BOUNDS = Object.freeze({ scalp: shared, intraday: shared, swing: shared, range: shared });
/** The platform fact each knob is read from once a reader exists; none does yet, so the start values hold. */
export const PM_LOOSEN_KNOB_FACTS = Object.freeze({ atr_expand: "omega.pm_loosen_atr_expand_<mode>", back_share: "omega.pm_loosen_back_share_<mode>" });
export const PM_LOOSEN_KNOBS_SOURCE = "start_values";

/**
 * Pure: the knobs of `mode` (an unknown mode reads as intraday): the start values, or the numbers in `overrides`, each
 * clamped to its bound. `source` says where they came from.
 */
export function pmLoosenKnobs(mode, overrides = null) {
  const m = MODES.includes(mode) ? mode : "intraday";
  const start = PM_LOOSEN_KNOB_START[m], bounds = PM_LOOSEN_KNOB_BOUNDS[m];
  const out = { mode: m };
  let overridden = false;
  for (const k of Object.keys(start)) {
    const v = Number(overrides?.[k]);
    const raw = overrides && overrides[k] != null && Number.isFinite(v) ? v : start[k];
    if (raw !== start[k]) overridden = true;
    out[k] = Math.min(bounds[k].max, Math.max(bounds[k].min, raw));
  }
  out.source = overridden ? "overrides_clamped" : PM_LOOSEN_KNOBS_SOURCE;
  return out;
}
