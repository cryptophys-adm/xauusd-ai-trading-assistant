// Builds local_computation records for the latest closed H4 or D1 bar (owner decision
// 2026-11-05: Threads per timeframe D1, H4, H1 and 15m, each calibrated against the
// TradingView alerts of the same chart). Same engines and comparable fields as the H1 and
// 15m producers, computed on the H4 or D1 chart.
//
// The candle key matches the TradingView webhook: Pine v6 timeframe.period is "240" on the
// 4-hour chart and "1D" on the daily chart, and `time` is the bar open (OANDA H4 and D1
// bars open at 17:00 New York, not on epoch multiples). Registry ids are timeframe-scoped
// (prophet_h4, gmi_h4, mizan_h4, prophet_d1, gmi_d1, mizan_d1), so no other approval moves.
// GMI runs on gmi-core-htf.mjs (dyn_ltf M5 on H4, M15 on D1).
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";
import { replayProphetR37ClosedBars } from "../../../src/prophet-r37-oscillator.mjs";
import { computeGmiOnHtfChart } from "../../gmi/src/gmi-core-htf.mjs";
import { LOCAL_CALCULATION_CONTRACT_VERSION, CHART_TICKERID, prophetR38TEnc, prophetConsensusDir } from "./h1-producer.mjs";
import { ENGINE_PROVENANCE } from "./provenance.generated.mjs";

/** Chart specs: Pine timeframe.period, bar length and the engine identities. */
export const HTF_CHARTS = Object.freeze({
  H4: { period: "240", minutes: 240, prophet: "prophet_h4", gmi: "gmi_h4", tag: "h4" },
  D1: { period: "1D", minutes: 1440, prophet: "prophet_d1", gmi: "gmi_d1", tag: "d1" }
});
const MIN_HTF_BARS = 330; // GMI needs vp_lookback (300) + 20 bars
const HTF_WINDOW = 1000;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const bars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

/** Same key the AI Worker derives for an H4 or D1 webhook without explicit candle_key. */
export function htfWebhookCandleKey(chart, openTimeMs) {
  return [CHART_TICKERID, HTF_CHARTS[chart].period, String(openTimeMs)].join(":");
}

const identity = (engine) => ({ source_hash: ENGINE_PROVENANCE[engine].source_hash, implementation_hash: ENGINE_PROVENANCE[engine].implementation_hash });

/**
 * Returns { candle_key, candle_time, bar, records, gmi_error } for the last closed bar of
 * `chart` ("H4" or "D1"). records holds mizan, prophet and gmi local_computation payloads
 * with timeframe "240" or "1D". When GMI cannot run, its record is omitted, never faked.
 */
export function buildHtfLocalCalculations(bundle, { chart = "H4", now = Date.now(), mintick = 0.001 } = {}) {
  const spec = HTF_CHARTS[chart];
  if (!spec) throw Object.assign(new Error(`unsupported chart: ${chart}`), { code: "unsupported_chart" });
  const series = bars(bundle?.timeframes?.[chart]).slice(-HTF_WINDOW);
  if (series.length < MIN_HTF_BARS) {
    throw Object.assign(new Error(`insufficient ${chart} history: ${series.length} < ${MIN_HTF_BARS}`), { code: "insufficient_" + spec.tag + "_history" });
  }
  const last = series.at(-1);
  const openMs = Date.parse(last.open_time);
  if (!finite(openMs) || Date.parse(last.close_time) > now) {
    throw Object.assign(new Error(`latest ${chart} bar is not closed`), { code: spec.tag + "_bar_not_closed" });
  }

  // Prophet R38 on the chart, other timeframes from the cached TradingView series.
  const r38 = calculateProphetR38Core(series.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: spec.minutes,
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

  // GMI-embedded shared Prophet core (Mizan prophet_structure_core) on the chart.
  const r37 = replayProphetR37ClosedBars(
    series.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    { mintick }
  );
  const s = r37.structure.at(-1);
  const proFast37 = r37.pro_fast.at(-1);
  const eventFlag = (bar) => bar !== null && bar !== undefined && bar !== 0;

  const candle = { o: last.open, h: last.high, l: last.low, c: last.close, volume: finite(last.volume) ? last.volume : 0 };
  const candleKey = htfWebhookCandleKey(chart, openMs);
  const candleTime = new Date(openMs).toISOString();
  const base = {
    schema_version: LOCAL_CALCULATION_CONTRACT_VERSION, symbol: CHART_TICKERID, timeframe: spec.period,
    candle_time: candleTime, candle_key: candleKey, computed_at: new Date(now).toISOString()
  };
  const mizanDependency = identity("mizan");

  const mizan = {
    ...base,
    engine: "mizan",
    calculation_version: "mizan-shared-core-" + spec.tag + "@" + ENGINE_PROVENANCE.mizan.implementation_hash.slice(0, 12),
    values: {
      candle,
      prophet_structure_core: { d_enc: s.d_enc, b_enc: s.b_enc, subtype: s.subtype, bull_event: eventFlag(s.bull_event_bar), bear_event: eventFlag(s.bear_event_bar) },
      calculate_prophet_tensor: { pro_fast: proFast37, pro_slow: r37.pro_slow.at(-1), pro_core: r37.pro_core.at(-1) },
      comparable: {}
    },
    provenance: { source: "local-engines/producer " + spec.tag, ...identity("mizan"), files: ENGINE_PROVENANCE.mizan.files }
  };

  const prophet = {
    ...base,
    engine: "prophet",
    calculation_version: "prophet-" + spec.tag + "@" + ENGINE_PROVENANCE[spec.prophet].implementation_hash.slice(0, 12),
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
      source: "local-engines/producer " + spec.tag, ...identity(spec.prophet), files: ENGINE_PROVENANCE[spec.prophet].files,
      dependencies: { mizan: mizanDependency }
    }
  };

  const records = [mizan, prophet];
  let gmiError = null;
  try {
    const gmi = computeGmiOnHtfChart(bundle, { chart, mintick });
    if (gmi.open_time !== last.open_time) throw Object.assign(new Error("GMI evaluated a different bar"), { code: "gmi_bar_mismatch" });
    records.push({
      ...base,
      engine: "gmi",
      calculation_version: "gmi-v12.70-" + spec.tag + "@" + ENGINE_PROVENANCE[spec.gmi].implementation_hash.slice(0, 12),
      values: {
        candle,
        bias: gmi.comparable.gmi_dir === 1 ? "BULLISH" : gmi.comparable.gmi_dir === -1 ? "BEARISH" : "NEUTRAL",
        comparable: { gmi_v12_70: gmi.comparable },
        diagnostics: gmi.diagnostics,
        scope_note: "Only comparable.gmi_v12_70 fields are parity-checked; diagnostics are unverified internals."
      },
      provenance: {
        source: "local-engines/gmi " + spec.tag, ...identity(spec.gmi), files: ENGINE_PROVENANCE[spec.gmi].files,
        dependencies: { mizan: mizanDependency }
      }
    });
  } catch (error) {
    gmiError = typeof error?.code === "string" ? error.code : "gmi_failed";
  }
  return { candle_key: candleKey, candle_time: candleTime, bar: candle, records, gmi_error: gmiError };
}
