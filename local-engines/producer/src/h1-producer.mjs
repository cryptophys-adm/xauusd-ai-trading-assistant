// Builds local_computation records for the latest closed H1 bar from raw
// TradingView OHLCV (market-data bundle). These records feed the AI Worker's
// local_computation lane and are compared, field by field, with the
// TradingView webhook outputs for the same candle (autonomous parity registry).
//
// Webhook field derivations follow the Pine sources exactly where the local
// kernels expose the inputs:
//   prophet_r38 (The-Prophet-v7.02-R38, non-legacy V2 gate):
//     direction   = buy_confirmed ? 1 : sell_confirmed ? -1 : 0
//     t_enc       = trade-management block (R38 lines 215-233)
//   prophet_r37_ssot (GMI v12.70 embedded shared core):
//     direction   = r10_prophet_consensus_dir (GMI lines 1313-1316)
//     bull_event  = prophet_bull_event_bar != 0 (na -> false)
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";
import { replayProphetR37ClosedBars } from "../../../src/prophet-r37-oscillator.mjs";
import { computeGmi } from "../../gmi/src/gmi-core.mjs";
import { ENGINE_PROVENANCE } from "./provenance.generated.mjs";

export const LOCAL_CALCULATION_CONTRACT_VERSION = "cryptophys.local-calculation.v1";
export const CHART_TICKERID = "OANDA:XAUUSD";
export const CHART_TIMEFRAME_PERIOD = "60"; // Pine timeframe.period for 1H
const PRICE_DISCOVERY_THRESHOLD = 0.45;
const MACRO_FILTER_Z = 1.0;
const MIN_H1_BARS = 150;
const H1_WINDOW = 1000;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const sign = (x) => (finite(x) ? (x > 0 ? 1 : x < 0 ? -1 : 0) : 0);

/** Same key the AI Worker derives for a webhook without explicit candle_key. */
export function webhookCandleKey(openTimeMs) {
  return [CHART_TICKERID, CHART_TIMEFRAME_PERIOD, String(openTimeMs)].join(":");
}

/** R38 non-legacy t_enc (trade-management encoding). */
export function prophetR38TEnc({ dEnc, bEnc, proFast, zScore, hurst, inten, kaufmanEr, volAnom }) {
  const strongTrend = finite(hurst) && hurst > 0.60;
  if (dEnc === 3) return strongTrend && finite(zScore) && Math.abs(zScore) >= MACRO_FILTER_Z ? 5 : 4;
  if (finite(proFast) && proFast >= PRICE_DISCOVERY_THRESHOLD) return 6;
  if (finite(proFast) && proFast <= -PRICE_DISCOVERY_THRESHOLD) return -6;
  if (dEnc === -3) return 1;
  if (inten === 3 && finite(kaufmanEr) && kaufmanEr > 0.5 && finite(volAnom) && volAnom >= 0.85) return strongTrend ? 1 : 0;
  if (inten === -3 && finite(kaufmanEr) && kaufmanEr > 0.5 && finite(volAnom) && volAnom >= 0.85) return strongTrend ? -1 : 0;
  if ((bEnc === 3 || bEnc === -3) && !strongTrend) return 3;
  return 0;
}

/** GMI r10_prophet_consensus_dir from the shared-core outputs. */
export function prophetConsensusDir({ proFast, dEnc, subtype }) {
  const divDir = (subtype === 2 || subtype === 3 || dEnc === 1) ? 1 : (subtype === 1 || subtype === 4 || dEnc === -1) ? -1 : 0;
  const dir = sign(proFast);
  const conflict = dir !== 0 && divDir !== 0 && dir !== divDir;
  return conflict ? 0 : dir !== 0 ? dir : divDir;
}

const bars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

/**
 * Returns { candle_key, candle_time, bar, records } for the last closed H1 bar.
 * records contains mizan, prophet and gmi local_computation payloads. GMI
 * fields come from the local GMI v12.70 engine (local-engines/gmi); when it
 * cannot run (insufficient history) the gmi record is omitted, never faked.
 */
export function buildH1LocalCalculations(bundle, { now = Date.now(), mintick = 0.001 } = {}) {
  const h1 = bars(bundle?.timeframes?.H1).slice(-H1_WINDOW);
  if (h1.length < MIN_H1_BARS) {
    throw Object.assign(new Error(`insufficient H1 history: ${h1.length} < ${MIN_H1_BARS}`), { code: "insufficient_h1_history" });
  }
  const last = h1.at(-1);
  const openMs = Date.parse(last.open_time);
  if (!finite(openMs) || Date.parse(last.close_time) > now) {
    throw Object.assign(new Error("latest H1 bar is not closed"), { code: "h1_bar_not_closed" });
  }

  // Prophet R38 on the H1 chart, HTF from native TradingView series.
  const r38 = calculateProphetR38Core(h1.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: 60,
    gmi_closed_only: true,
    mintick,
    higher_timeframes: {
      M15: bars(bundle.timeframes.M15), H1: h1, H4: bars(bundle.timeframes.H4),
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

  // GMI-embedded shared Prophet core (Mizan prophet_structure_core) on H1.
  const r37 = replayProphetR37ClosedBars(
    h1.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    { mintick }
  );
  const s = r37.structure.at(-1);
  const proFast37 = r37.pro_fast.at(-1);
  const eventFlag = (bar) => bar !== null && bar !== undefined && bar !== 0;

  const candle = { o: last.open, h: last.high, l: last.low, c: last.close, volume: finite(last.volume) ? last.volume : 0 };
  const candleKey = webhookCandleKey(openMs);
  const candleTime = new Date(openMs).toISOString();
  const computedAt = new Date(now).toISOString();
  const base = { schema_version: LOCAL_CALCULATION_CONTRACT_VERSION, symbol: CHART_TICKERID, timeframe: CHART_TIMEFRAME_PERIOD, candle_time: candleTime, candle_key: candleKey, computed_at: computedAt };
  const mizanDependency = { source_hash: ENGINE_PROVENANCE.mizan.source_hash, implementation_hash: ENGINE_PROVENANCE.mizan.implementation_hash };

  const mizan = {
    ...base,
    engine: "mizan",
    calculation_version: "mizan-shared-core-h1@" + ENGINE_PROVENANCE.mizan.implementation_hash.slice(0, 12),
    values: {
      candle,
      prophet_structure_core: { d_enc: s.d_enc, b_enc: s.b_enc, subtype: s.subtype, bull_event: eventFlag(s.bull_event_bar), bear_event: eventFlag(s.bear_event_bar) },
      calculate_prophet_tensor: { pro_fast: proFast37, pro_slow: r37.pro_slow.at(-1), pro_core: r37.pro_core.at(-1) },
      comparable: {}
    },
    provenance: { source: "local-engines/producer h1", source_hash: ENGINE_PROVENANCE.mizan.source_hash, implementation_hash: ENGINE_PROVENANCE.mizan.implementation_hash, files: ENGINE_PROVENANCE.mizan.files }
  };

  const prophet = {
    ...base,
    engine: "prophet",
    calculation_version: "prophet-h1@" + ENGINE_PROVENANCE.prophet.implementation_hash.slice(0, 12),
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
      source: "local-engines/producer h1", source_hash: ENGINE_PROVENANCE.prophet.source_hash,
      implementation_hash: ENGINE_PROVENANCE.prophet.implementation_hash, files: ENGINE_PROVENANCE.prophet.files,
      dependencies: { mizan: mizanDependency }
    }
  };

  const records = [mizan, prophet];
  let gmiError = null;
  try {
    const gmi = computeGmi(bundle, { mintick });
    if (gmi.open_time !== last.open_time) throw Object.assign(new Error("GMI evaluated a different bar"), { code: "gmi_bar_mismatch" });
    records.push({
      ...base,
      engine: "gmi",
      calculation_version: "gmi-v12.70-h1@" + ENGINE_PROVENANCE.gmi.implementation_hash.slice(0, 12),
      values: {
        candle,
        bias: gmi.comparable.gmi_dir === 1 ? "BULLISH" : gmi.comparable.gmi_dir === -1 ? "BEARISH" : "NEUTRAL",
        comparable: { gmi_v12_70: gmi.comparable },
        diagnostics: gmi.diagnostics,
        scope_note: "Only comparable.gmi_v12_70 fields are parity-checked; diagnostics are unverified internals."
      },
      provenance: {
        source: "local-engines/gmi h1", source_hash: ENGINE_PROVENANCE.gmi.source_hash,
        implementation_hash: ENGINE_PROVENANCE.gmi.implementation_hash, files: ENGINE_PROVENANCE.gmi.files,
        dependencies: { mizan: mizanDependency }
      }
    });
  } catch (error) {
    gmiError = typeof error?.code === "string" ? error.code : "gmi_failed";
  }
  return { candle_key: candleKey, candle_time: candleTime, bar: candle, records, gmi_error: gmiError };
}
