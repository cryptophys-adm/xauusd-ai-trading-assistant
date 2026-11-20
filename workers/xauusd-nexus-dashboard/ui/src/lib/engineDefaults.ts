/**
 * The Engine form's Default button and its "set, applied" notes (owner 2026-11-20: "Follow the active profile").
 * Pure, so a node test pins it to src/account-spec.mjs effectiveLimits and src/omega-engine.mjs OMEGA_DEFAULTS.
 *
 * Default fills the form only; the owner still presses Save (the audited settings path). It never sets `enabled`,
 * `live_armed` or the profile.
 */

/** The active profile's own values, as the Omega overview serves them (accounts[].profile_limits; null for Custom). */
export type ProfileLimits = { target_risk_pct: number | null; max_positions: number | null; daily_loss_pct: number | null };
/** The Engine form's values. */
export type EngineFormValues = { risk_pct: number; max_positions: number; max_daily_loss_pct: number; max_spread_points: number; max_signal_age_min: number };

/** OMEGA_DEFAULTS (src/omega-engine.mjs), used when the overview carries no engine_defaults. */
export const OMEGA_FORM_DEFAULTS: EngineFormValues = Object.freeze({ risk_pct: 0.5, max_positions: 1, max_daily_loss_pct: 2, max_spread_points: 60, max_signal_age_min: 10 });

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * What Default fills: risk, positions and daily loss from the active profile, spread and signal age from
 * OMEGA_DEFAULTS. A value the profile does not set (Custom) or no active profile: OMEGA_DEFAULTS.
 */
export function engineDefaultsFor(limits: ProfileLimits | null | undefined, defaults?: Partial<EngineFormValues> | null): EngineFormValues {
  const d: EngineFormValues = { ...OMEGA_FORM_DEFAULTS };
  for (const k of Object.keys(d) as (keyof EngineFormValues)[]) {
    const v = num(defaults?.[k]);
    if (v != null) d[k] = v;
  }
  return {
    risk_pct: num(limits?.target_risk_pct) ?? d.risk_pct,
    max_positions: num(limits?.max_positions) ?? d.max_positions,
    max_daily_loss_pct: num(limits?.daily_loss_pct) ?? d.max_daily_loss_pct,
    max_spread_points: d.max_spread_points,
    max_signal_age_min: d.max_signal_age_min,
  };
}

/** The smaller of the setting and the profile's cap, as effectiveLimits takes it; null without a setting. */
export function appliedValue(setting: unknown, cap: unknown): number | null {
  const s = num(setting), c = num(cap);
  if (s == null) return null;
  return c == null ? s : Math.min(s, c);
}

export type AppliedNotes = { risk_pct: string | null; max_positions: string | null; max_daily_loss_pct: string | null };

/**
 * Under each field whose value is above what the profile applies: "5% set, 2% applied (Conservative cap)". Null where
 * the value applies as it is (Custom, no active profile, an empty field, a value within the cap).
 */
export function appliedNotes(form: { risk_pct?: unknown; max_positions?: unknown; max_daily_loss_pct?: unknown }, limits: ProfileLimits | null | undefined, label: string | null | undefined): AppliedNotes {
  const name = label ? `${label} cap` : "profile cap";
  const note = (setting: unknown, cap: unknown, unit: string): string | null => {
    const s = num(setting), a = appliedValue(setting, cap);
    return s != null && a != null && a < s ? `${s}${unit} set, ${a}${unit} applied (${name})` : null;
  };
  return {
    risk_pct: note(form.risk_pct, limits?.target_risk_pct, "%"),
    max_positions: note(form.max_positions, limits?.max_positions, ""),
    max_daily_loss_pct: note(form.max_daily_loss_pct, limits?.daily_loss_pct, "%"),
  };
}
