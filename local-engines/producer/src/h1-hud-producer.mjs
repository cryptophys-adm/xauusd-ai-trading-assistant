// Phase C2b scaffold: HUD local-computation records (H1).
// Computes a minimal subset of RFC §1.2 fields; full field coverage follows in later PRs.
import { buildH1LocalCalculations } from "./h1-producer.mjs";

export const HUD_CALCULATION_CONTRACT_VERSION = "cryptophys.hud-calculation.v1";

export function buildH1HudCalculations(bundle, { now = Date.now(), mintick = 0.001 } = {}) {
  const base = buildH1LocalCalculations(bundle, { now, mintick });
  const candleKey = base.candle_key;
  const candleTime = base.candle_time;
  const computedAt = base.computed_at;
  const candle = base.records.find(r => r.engine === "prophet")?.values?.candle;
  const prophetComparable = base.records.find(r => r.engine === "prophet")?.values?.comparable?.prophet_r38 || {};
  const gmiComparable = base.records.find(r => r.engine === "gmi")?.values?.comparable?.gmi_v12_70 || {};

  const prophetHud = {
    schema_version: HUD_CALCULATION_CONTRACT_VERSION,
    engine: "prophet_hud",
    symbol: base.symbol,
    timeframe: base.timeframe,
    candle_time: candleTime,
    candle_key: candleKey,
    computed_at: computedAt,
    calculation_version: "prophet-hud-h1@scaffold",
    values: {
      candle,
      comparable: {
        prophet_r38_hud: {
          cshi_score: null,
          cycle_intensity: null,
          d_enc: prophetComparable.d_enc ?? null,
          structure_subtype: prophetComparable.structure_subtype ?? null,
          t_enc: prophetComparable.t_enc ?? null
        }
      }
    },
    provenance: base.records.find(r => r.engine === "prophet")?.provenance
  };

  const gmiHud = {
    schema_version: HUD_CALCULATION_CONTRACT_VERSION,
    engine: "gmi_hud",
    symbol: base.symbol,
    timeframe: base.timeframe,
    candle_time: candleTime,
    candle_key: candleKey,
    computed_at: computedAt,
    calculation_version: "gmi-hud-h1@scaffold",
    values: {
      candle,
      comparable: {
        gmi_v12_70_hud: {
          verdict: gmiComparable.verdict ?? null,
          gate: gmiComparable.gate ?? null,
          gmi_dir: gmiComparable.gmi_dir ?? null,
          prophet_dir: gmiComparable.prophet_dir ?? null,
          conflict: gmiComparable.conflict ?? null
        }
      }
    },
    provenance: base.records.find(r => r.engine === "gmi")?.provenance
  };

  return [prophetHud, gmiHud];
}
