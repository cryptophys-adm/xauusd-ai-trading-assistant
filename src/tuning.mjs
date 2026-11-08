// Aether phase A8 (RFC_AETHER_KNOWLEDGE_GUARDIAN §9, K7): the tuning read model, GET /api/tuning.
//
// For every family and parameter in the reviewed TUNING_GRID (src/aether-pack.mjs), it shows each
// grid point and where it stands:
//   - running: a shadow candidate, with its discovery test (Holm-adjusted, §9.3) and its holdout;
//   - stopped: a retired candidate and why;
//   - untested: no candidate yet. A point starts only when a person approves it in Aether
//     (the calibrator proposes the next untested point; O5) or by a reviewed PR here.
// Read-only and deterministic: it is built from the shadow view, never starts or stops anything,
// and never reaches a room, a prompt or a decision. Promotion is always an owner PR.

import { TUNING_GRID } from "./aether-pack.mjs";
import { RETIRED_CANDIDATES, SHADOW_MIN_SAMPLE, SHADOW_SIGNIFICANCE, HOLDOUT_BARS, REVIEW_MIN_DECISIVE_PAIRS } from "./shadow-versions.mjs";

export const TUNING_VERSION = "cryptophys.tuning.v1";
/** The active engine's value of each tunable parameter (src/prophet-r37-kernel.mjs, Prophet R38 core). */
export const ACTIVE_VALUES = Object.freeze({ stateMaxAge: 50 });

const pointId = (family, param, value) => (param === "stateMaxAge" ? `${family}@latch${value}` : `${family}@${param}${value}`);

/** Pure: the tuning view from a shadow view (readShadowVersions). */
export function tuningView(shadow, { grid = TUNING_GRID, retired = RETIRED_CANDIDATES, crowd = null } = {}) {
  const families = [];
  for (const [family, params] of Object.entries(grid)) {
    const f = (shadow?.families || []).find((x) => x.family === family);
    for (const [param, values] of Object.entries(params)) {
      const points = values.map((value) => {
        const id = pointId(family, param, value);
        const live = f?.candidates?.find((k) => k.id === id);
        if (live) {
          return {
            value, id, status: "running", source: live.origin?.source === "aether" ? "aether" : "repository",
            verdict: live.verdict,
            discovery: live.discovery, holdout: live.holdout,
            decisive_pairs: live.paired.candidate_better + live.paired.control_better,
            review: live.review ? { by: live.review.by, due: live.review.due } : null
          };
        }
        const stopped = retired.find((r) => r.id === id);
        if (stopped) return { value, id, status: "stopped", retired_on: stopped.retired_on, reason: stopped.reason, p_value: stopped.result?.p_value ?? null };
        return { value, id, status: "untested" };
      });
      families.push({
        family, name: f?.name ?? family, param, active_value: ACTIVE_VALUES[param] ?? null,
        holm: f?.holm ?? null,
        points,
        next_untested: points.find((p) => p.status === "untested")?.value ?? null
      });
    }
  }
  return {
    version: TUNING_VERSION,
    use: "shadow testing only; never a live prompt or decision; promotion is an owner PR",
    statistics: {
      test: "paired one-sided exact sign test on bars where exactly one arm is right",
      alpha: SHADOW_SIGNIFICANCE,
      multiple_testing: "Holm–Bonferroni per family per calendar month (live tests and candidates stopped that month)",
      min_discovery_bars: SHADOW_MIN_SAMPLE,
      holdout_bars: HOLDOUT_BARS,
      holdout_rule: "the newest bars, never used by the discovery test; the candidate must be no worse there",
      review_min_decisive_pairs: REVIEW_MIN_DECISIVE_PAIRS
    },
    holm_month: shadow?.holm_month ?? null,
    window_days: shadow?.window_days ?? null,
    families,
    // Deterministic replays of fixed parameters (src/tuning-replay.mjs): the reputation weights behind the crowd line.
    replays: crowd ? { crowd } : {}
  };
}
