// Builds local_computation records for the latest closed 15m bar (verified 15m lane, owner
// decision 2026-11-05). Same engines and comparable fields as the H1 and 5m producers, computed
// on the 15m chart, so the AI Worker's parity registry can compare them with the TradingView
// webhooks of the existing Prophet R38 and GMI alerts installed on the 15m chart.
//
// It mirrors m5-local-producer.mjs, which is part of the approved 5m hashes and is never edited
// for 15m. Registry ids are timeframe-scoped (prophet_m15, gmi_m15, mizan_m15): approval on H1
// or 5m never carries over, and 15m results never touch those identities.
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";
import { replayProphetR37ClosedBars } from "../../../src/prophet-r37-oscillator.mjs";
import { computeGmiOnChart } from "../../gmi/src/gmi-core-tf.mjs";
import { LOCAL_CALCULATION_CONTRACT_VERSION, CHART_TICKERID, prophetR38TEnc, prophetConsensusDir } from "./h1-producer.mjs";
import { ENGINE_PROVENANCE } from "./provenance.generated.mjs";

export const M15_TIMEFRAME_PERIOD = "15"; // Pine timeframe.period for 15m
const MIN_M15_BARS = 400;
const M15_WINDOW = 1000;
const M15_MS = 15 * 60 * 1000;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const bars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

/** Same key the AI Worker derives for a 15m webhook without explicit candle_key. */
export function m15WebhookCandleKey(openTimeMs) {
  return [CHART_TICKERID, M15_TIMEFRAME_PERIOD, String(openTimeMs)].join(":");
}

const identity = (engine) => ({ source_hash: ENGINE_PROVENANCE[engine].source_hash, implementation_hash: ENGINE_PROVENANCE[engine].implementation_hash });

/**
 * Returns { candle_key, candle_time, bar, records, gmi_error } for the last
 * closed 15m bar. records holds mizan, prophet and gmi local_computation
 * payloads with timeframe "15". When GMI cannot run, its record is omitted,
 * never faked.
 */
export function buildM15LocalCalculations(bundle, { now = Date.now(), mintick = 0.001 } = {}) {
  const m15 = bars(bundle?.timeframes?.M15).slice(-M15_WINDOW);
  if (m15.length < MIN_M15_BARS) {
    throw Object.assign(new Error(`insufficient 15m history: ${m15.length} < ${MIN_M15_BARS}`), { code: "insufficient_m15_history" });
  }
  const last = m15.at(-1);
  const openMs = Date.parse(last.open_time);
  if (!finite(openMs) || Date.parse(last.close_time) > now) {
    throw Object.assign(new Error("latest 15m bar is not closed"), { code: "m15_bar_not_closed" });
  }
  if (Date.parse(last.close_time) - openMs !== M15_MS) {
    throw Object.assign(new Error("latest bar is not a 15m bar"), { code: "m15_bar_invalid" });
  }

  // Prophet R38 on the 15m chart, HTF from native TradingView series.
  const r38 = calculateProphetR38Core(m15.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: 15,
    gmi_closed_only: true,
    mintick,
    higher_timeframes: {
      M15: bars(bundle.timeframes.M15), H1: bars(bundle.timeframes.H1), H4: bars(bundle.timeframes.H4),
      D1: bars(bundle.timeframes.D1), W1: bars(bundle.timeframes.W1)
    }
  });
  const o = r38.outputs.at(-1);
  const buy = o.confirmation?.buy_confirmed === true;
  const sell = o.confirmation?.sell_confirmed === true;
  const tEnc = prophetR38TEnc({
    dEnc: o.structure?.d_enc, bEnc: o.structure?.b_enc, proFast: o.oscillator?.fast,
    zScore: o.sensors?.kww_zscore_50, hurst: o.sensors?.hurst_rs_100, inten: o.sensors?.cycle_intensity,
    kaufmanEr: o.sensors?.efficiency_ratio_14, volAnom: finite(o.sensors?.volume_ratio_20) ? o.sensors.volume_ratio_20 : 1.0
  });

  // GMI-embedded shared Prophet core (Mizan prophet_structure_core) on 15m.
  const r37 = replayProphetR37ClosedBars(
    m15.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    { mintick }
  );
  const s = r37.structure.at(-1);
  const proFast37 = r37.pro_fast.at(-1);
  const eventFlag = (bar) => bar !== null && bar !== undefined && bar !== 0;

  const candle = { o: last.open, h: last.high, l: last.low, c: last.close, volume: finite(last.volume) ? last.volume : 0 };
  const candleKey = m15WebhookCandleKey(openMs);
  const candleTime = new Date(openMs).toISOString();
  const base = {
    schema_version: LOCAL_CALCULATION_CONTRACT_VERSION, symbol: CHART_TICKERID, timeframe: M15_TIMEFRAME_PERIOD,
    candle_time: candleTime, candle_key: candleKey, computed_at: new Date(now).toISOString()
  };
  const mizanDependency = identity("mizan");

  const mizan = {
    ...base,
    engine: "mizan",
    calculation_version: "mizan-shared-core-m15@" + ENGINE_PROVENANCE.mizan.implementation_hash.slice(0, 12),
    values: {
      candle,
      prophet_structure_core: { d_enc: s.d_enc, b_enc: s.b_enc, subtype: s.subtype, bull_event: eventFlag(s.bull_event_bar), bear_event: eventFlag(s.bear_event_bar) },
      calculate_prophet_tensor: { pro_fast: proFast37, pro_slow: r37.pro_slow.at(-1), pro_core: r37.pro_core.at(-1) },
      comparable: {}
    },
    provenance: { source: "local-engines/producer m15", ...identity("mizan"), files: ENGINE_PROVENANCE.mizan.files }
  };

  const prophet = {
    ...base,
    engine: "prophet",
    calculation_version: "prophet-m15@" + ENGINE_PROVENANCE.prophet_m15.implementation_hash.slice(0, 12),
    values: {
      candle,
      bias: buy ? "BULLISH" : sell ? "BEARISH" : "NEUTRAL",
      comparable: {
        prophet_r38: {
          direction: buy ? 1 : sell ? -1 : 0,
          buy_confirmed: buy,
          sell_confirmed: sell,
          buy_high_quality: o.confirmation?.buy_high_quality === true,
          sell_high_quality: o.confirmation?.sell_high_quality === true,
          t_enc: tEnc,
          d_enc: o.structure?.d_enc,
          structure_subtype: o.structure?.subtype_code
        },
        prophet_r37_ssot: {
          direction: prophetConsensusDir({ proFast: proFast37, dEnc: s.d_enc, subtype: s.subtype }),
          d_enc: s.d_enc,
          b_enc: s.b_enc,
          structure_subtype: s.subtype,
          bull_event: eventFlag(s.bull_event_bar),
          bear_event: eventFlag(s.bear_event_bar)
        }
      },
      scope_note: "Only comparable.* fields are parity-checked; other R38 internals remain unverified."
    },
    provenance: {
      source: "local-engines/producer m15", ...identity("prophet_m15"), files: ENGINE_PROVENANCE.prophet_m15.files,
      dependencies: { mizan: mizanDependency }
    }
  };

  const records = [mizan, prophet];
  let gmiError = null;
  try {
    const gmi = computeGmiOnChart(bundle, { chart: "M15", mintick });
    if (gmi.open_time !== last.open_time) throw Object.assign(new Error("GMI evaluated a different bar"), { code: "gmi_bar_mismatch" });
    records.push({
      ...base,
      engine: "gmi",
      calculation_version: "gmi-v12.70-m15@" + ENGINE_PROVENANCE.gmi_m15.implementation_hash.slice(0, 12),
      values: {
        candle,
        bias: gmi.comparable.gmi_dir === 1 ? "BULLISH" : gmi.comparable.gmi_dir === -1 ? "BEARISH" : "NEUTRAL",
        comparable: { gmi_v12_70: gmi.comparable },
        diagnostics: gmi.diagnostics,
        scope_note: "Only comparable.gmi_v12_70 fields are parity-checked; diagnostics are unverified internals."
      },
      provenance: {
        source: "local-engines/gmi m15", ...identity("gmi_m15"), files: ENGINE_PROVENANCE.gmi_m15.files,
        dependencies: { mizan: mizanDependency }
      }
    });
  } catch (error) {
    gmiError = typeof error?.code === "string" ? error.code : "gmi_failed";
  }
  return { candle_key: candleKey, candle_time: candleTime, bar: candle, records, gmi_error: gmiError };
}
