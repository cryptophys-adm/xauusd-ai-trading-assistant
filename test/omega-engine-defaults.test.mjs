// The Omega Engine form's Default button and its "set, applied" notes (owner 2026-11-20: "Follow the active profile";
// workers/xauusd-nexus-dashboard/ui/src/lib/engineDefaults.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { engineDefaultsFor, appliedNotes, appliedValue, OMEGA_FORM_DEFAULTS } from "../workers/xauusd-nexus-dashboard/ui/src/lib/engineDefaults.ts";
import { PROFILES, effectiveLimits } from "../src/account-spec.mjs";
import { OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

const limitsOf = (id) => ({ target_risk_pct: PROFILES[id].target_risk_pct, max_positions: PROFILES[id].max_positions, daily_loss_pct: PROFILES[id].daily_loss_pct });

test("ED1 Default fills the profile's risk, positions and daily loss with OMEGA_DEFAULTS' spread and signal age", () => {
  assert.deepEqual(engineDefaultsFor(limitsOf("conservative")), { risk_pct: 2, max_positions: 2, max_daily_loss_pct: 6, max_spread_points: 60, max_signal_age_min: 10 });
  assert.deepEqual(engineDefaultsFor(limitsOf("safe")), { risk_pct: 1, max_positions: 1, max_daily_loss_pct: 3, max_spread_points: 60, max_signal_age_min: 10 });
  assert.deepEqual(engineDefaultsFor(limitsOf("aggressive")), { risk_pct: 5, max_positions: 3, max_daily_loss_pct: 10, max_spread_points: 60, max_signal_age_min: 10 });
});

test("ED2 no active profile, or Custom, falls back to OMEGA_DEFAULTS; the UI copy matches the engine's", () => {
  assert.deepEqual(OMEGA_FORM_DEFAULTS, { risk_pct: OMEGA_DEFAULTS.risk_pct, max_positions: OMEGA_DEFAULTS.max_positions, max_daily_loss_pct: OMEGA_DEFAULTS.max_daily_loss_pct, max_spread_points: OMEGA_DEFAULTS.max_spread_points, max_signal_age_min: OMEGA_DEFAULTS.max_signal_age_ms / 60_000 });
  assert.deepEqual(engineDefaultsFor(null), OMEGA_FORM_DEFAULTS);
  assert.deepEqual(engineDefaultsFor(limitsOf("custom")), OMEGA_FORM_DEFAULTS);
  // The overview's engine_defaults win over the built-in copy when served.
  assert.equal(engineDefaultsFor(null, { max_spread_points: 80 }).max_spread_points, 80);
  // Default carries no switch: never enabled, live_armed or a profile.
  assert.deepEqual(Object.keys(engineDefaultsFor(limitsOf("conservative"))).sort(), ["max_daily_loss_pct", "max_positions", "max_signal_age_min", "max_spread_points", "risk_pct"]);
});

test("ED3 the applied value is effectiveLimits' for every profile and setting", () => {
  const pairs = [["risk_pct", "target_risk_pct"], ["max_positions", "max_positions"], ["max_daily_loss_pct", "daily_loss_pct"]];
  for (const id of Object.keys(PROFILES)) {
    for (const v of [0.01, 0.5, 1, 2, 3, 5, 6, 8, 10, 20]) {
      const settings = { risk_pct: v, max_positions: Math.max(1, Math.round(v)), max_daily_loss_pct: v };
      const lim = effectiveLimits(id, settings);
      for (const [k, p] of pairs) assert.equal(appliedValue(settings[k], PROFILES[id][p]), lim[k], `${id} ${k} ${settings[k]}`);
    }
  }
});

test("ED4 a note under each field above what the profile applies, none within the cap, for Custom or an empty field", () => {
  const c = limitsOf("conservative");
  assert.deepEqual(appliedNotes({ risk_pct: "5", max_positions: "3", max_daily_loss_pct: "8" }, c, "Conservative"),
    { risk_pct: "5% set, 2% applied (Conservative cap)", max_positions: "3 set, 2 applied (Conservative cap)", max_daily_loss_pct: "8% set, 6% applied (Conservative cap)" });
  assert.deepEqual(appliedNotes({ risk_pct: "2", max_positions: "1", max_daily_loss_pct: "6" }, c, "Conservative"), { risk_pct: null, max_positions: null, max_daily_loss_pct: null });
  assert.deepEqual(appliedNotes({ risk_pct: "", max_positions: "", max_daily_loss_pct: "" }, c, "Conservative"), { risk_pct: null, max_positions: null, max_daily_loss_pct: null });
  assert.deepEqual(appliedNotes({ risk_pct: "9", max_positions: "5", max_daily_loss_pct: "20" }, limitsOf("custom"), "Custom"), { risk_pct: null, max_positions: null, max_daily_loss_pct: null });
  assert.deepEqual(appliedNotes({ risk_pct: "9" }, null, null), { risk_pct: null, max_positions: null, max_daily_loss_pct: null });
  assert.equal(appliedNotes({ risk_pct: "1.5" }, limitsOf("safe"), "Safe").risk_pct, "1.5% set, 1% applied (Safe cap)");
});
