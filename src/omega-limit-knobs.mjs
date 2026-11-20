// The limit entry's knobs (docs/RFC_OMEGA_LIMIT_ENTRY.md §7, owner 2026-11-20): one table for the live engine
// (src/omega-engine.mjs, stage 3) and the ledger's limit policy (src/ledger-omega-limit.mjs, stage 2). Start values per
// mode, clamped to ADR-0020 Amendment 7's doctrine bounds. No reader of the platform's omega.limit_* facts exists yet
// (stage 4), so the start values hold. Pure; imports nothing.

const MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);

/** The start values per mode (RFC §7, narrowed in the platform session's review of 2026-11-20). */
export const LIMIT_KNOB_START = Object.freeze({
  scalp: Object.freeze({ max_pending_life: 30, move_max_atr: 0.25, cancel_share_drop: 0.05, placement_band: 0.35 }),
  intraday: Object.freeze({ max_pending_life: 60, move_max_atr: 0.5, cancel_share_drop: 0.05, placement_band: 0.35 }),
  swing: Object.freeze({ max_pending_life: 240, move_max_atr: 0.5, cancel_share_drop: 0.05, placement_band: 0.35 }),
  range: Object.freeze({ max_pending_life: 60, move_max_atr: 0.25, cancel_share_drop: 0.05, placement_band: 0.35 })
});
const shared = { move_max_atr: Object.freeze({ min: 0, max: 0.5 }), cancel_share_drop: Object.freeze({ min: 0.03, max: 0.1 }), placement_band: Object.freeze({ min: 0.1, max: 0.6 }) };
/** The doctrine bounds per mode (ADR-0020 A7, cryptophys-cloud-platform ed43279): minutes, × ATR(14) 15m, share, × stop. */
export const LIMIT_KNOB_BOUNDS = Object.freeze({
  scalp: Object.freeze({ max_pending_life: Object.freeze({ min: 15, max: 60 }), ...shared }),
  intraday: Object.freeze({ max_pending_life: Object.freeze({ min: 30, max: 240 }), ...shared }),
  swing: Object.freeze({ max_pending_life: Object.freeze({ min: 60, max: 720 }), ...shared }),
  range: Object.freeze({ max_pending_life: Object.freeze({ min: 30, max: 240 }), ...shared })
});
/** The platform fact each knob is read from once a reader exists (RFC §7); none does yet, so the start values hold. */
export const LIMIT_KNOB_FACTS = Object.freeze({ max_pending_life: "omega.limit_life_min_<mode>", move_max_atr: "omega.limit_move_max_atr_<mode>", cancel_share_drop: "omega.limit_cancel_share_drop_<mode>", placement_band: "omega.limit_band_<mode>" });
export const LIMIT_KNOBS_SOURCE = "start_values";

/**
 * Pure: the knobs of `mode` (an unknown mode reads as intraday): the start values, or the numbers in `overrides`, each
 * clamped to its doctrine bound. `source` says where they came from.
 */
export function limitKnobs(mode, overrides = null) {
  const m = MODES.includes(mode) ? mode : "intraday";
  const start = LIMIT_KNOB_START[m], bounds = LIMIT_KNOB_BOUNDS[m];
  const out = { mode: m };
  let overridden = false;
  for (const k of Object.keys(start)) {
    const v = Number(overrides?.[k]);
    const raw = overrides && overrides[k] != null && Number.isFinite(v) ? v : start[k];
    if (raw !== start[k]) overridden = true;
    out[k] = Math.min(bounds[k].max, Math.max(bounds[k].min, raw));
  }
  out.source = overridden ? "overrides_clamped" : LIMIT_KNOBS_SOURCE;
  return out;
}
