export const LOCAL_ENGINE_INPUT_CONTRACT = "cryptophys.local-engine-input.v1";

// Source-derived minimum warm-up for the known R38 Prophet and GMI callers.
// This is a shared-input floor for those call sites, NOT a claim that every
// export in MizanLib has been reproduced or that the local engines are parity-safe.
const HISTORY_REQUIREMENTS = Object.freeze({
  mizan: Object.freeze({ M5: 300, M15: 51, H1: 51, H4: 51, D1: 51, W1: 51 }),
  prophet: Object.freeze({ M5: 101, M15: 51, H1: 51, H4: 51, D1: 51, W1: 51 }),
  gmi: Object.freeze({ M5: 300, M15: 51, H1: 51, H4: 51, D1: 51, W1: 51 })
});

const SOURCE_CALLER_CONTRACTS = Object.freeze({
  mizan: {
    role: "shared Pine library; input/history contract is defined by its verified callers, not as a standalone signal engine",
    known_callers: ["The Prophet v7.02 R38", "Global Multiverse Interceptor v12.70 SSOT"],
    history_floor_scope: "union of known R38/GMI call-site warm-ups; not sufficient proof for all library exports",
    blockers: ["installed published library revision not proven to match repository SSOT", "no TradingView output fixtures"]
  },
  prophet: {
    source: "pinescript/ssot/The-Prophet-v7.02-R38.txt",
    import: "cryptophys/CryptophysMizanLib/4",
    call_site_requirements: {
      M5: "hurst_rs(close, 100) requires 101 bars; local oscillator also uses 13/34/55 cycle lengths and 20-bar volume ratios",
      M15_H1_H4_D1_W1: "default HTF kww_zscore(close, 50)[1] requires 51 closed bars"
    },
    blockers: ["full R38 implementation not present; R37 shared-core is not equivalent", "feature-level TradingView fixtures absent"]
  },
  gmi: {
    source: "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt",
    import: "cryptophys/CryptophysMizanLib/4",
    call_site_requirements: {
      M5: "volume-profile/profile lookback uses 300 bars; MTF KWW z-score uses 50-bar warm-up",
      D1: "daily CPR width uses a 20-day mean and needs 21 completed daily bars",
      W1: "weekly timeframe calculations and MTF alignment require closed weekly context"
    },
    input_series: {
      lower_tf: "OANDA:XAUUSD 1m (request.security_lower_tf intrabars)",
      external: ["TVC:DXY 4h", "CRYPTOCAP:USDT 4h", "TVC:USOIL chart timeframe (5m)"]
    },
    blockers: ["no local GMI calculator yet", "feature-level TradingView fixtures absent"]
  }
});

// GMI inputs beyond the chart series. Each is reported as unavailable only
// when the TradingView-native series is actually missing from the bundle.
const GMI_EXTRA_INPUTS = Object.freeze([
  { code: "missing_intrabar_ohlcv", lookup: (b) => b?.timeframes?.M1, min: 300, source_call: "request.security_lower_tf", required_resolution: "dyn_ltf (M1 on the configured M5 workflow)", fields: ["time", "open", "high", "low", "close", "volume"], blocks: ["footprint_from_arrays", "ext_profile_calc", "ext_update_intra"] },
  { code: "missing_external_series", symbol: "TVC:DXY", timeframe: "H4", lookup: (b) => b?.external_series?.["TVC:DXY"]?.H4, min: 51, blocks: ["macro_kinematics", "macro_penalty"] },
  { code: "missing_external_series", symbol: "CRYPTOCAP:USDT", timeframe: "H4", lookup: (b) => b?.external_series?.["CRYPTOCAP:USDT"]?.H4, min: 51, blocks: ["macro_kinematics", "macro_penalty"] },
  { code: "missing_external_series", symbol: "TVC:USOIL", timeframe: "M5", lookup: (b) => b?.external_series?.["TVC:USOIL"]?.M5, min: 51, blocks: ["oil RSI macro context"] }
]);

function gmiUnavailableInputs(bundle) {
  return GMI_EXTRA_INPUTS
    .filter((item) => (item.lookup(bundle)?.candle_count ?? item.lookup(bundle)?.candles?.length ?? 0) < item.min)
    .map(({ lookup, min, ...rest }) => ({ ...rest, required_bars: min, available_bars: lookup(bundle)?.candle_count ?? lookup(bundle)?.candles?.length ?? 0, blocks: [...rest.blocks], ...(rest.fields ? { fields: [...rest.fields] } : {}) }));
}

function countFor(bundle, timeframe) {
  const native = bundle?.timeframes?.[timeframe];
  const context = bundle?.context_timeframes?.[timeframe];
  const count = (frame) => frame?.candle_count ?? frame?.candles?.length ?? 0;
  return Math.max(count(native), ["D1", "W1"].includes(timeframe) ? count(context) : 0);
}

function sourceHistoryGaps(bundle, engine) {
  const gaps = [];
  for (const [timeframe, required] of Object.entries(HISTORY_REQUIREMENTS[engine])) {
    const actual = countFor(bundle, timeframe);
    if (actual < required) gaps.push({
      code: "insufficient_history",
      timeframe,
      required_bars: required,
      available_bars: actual
    });
  }
  if (bundle?.volume_available !== true) {
    gaps.push({ code: "volume_unavailable_or_incomplete", field: "volume" });
  }
  if (engine === "gmi" && countFor(bundle, "D1") < 21) gaps.push({
    code: "daily_cpr_20_day_warmup_not_satisfied",
    timeframe: "D1",
    required_bars: 21,
    available_bars: countFor(bundle, "D1")
  });
  return gaps;
}

function dataForEngine(bundle) {
  return {
    schema_version: bundle.schema_version,
    symbol: bundle.source?.canonical_symbol || "OANDA:XAUUSD",
    provider: bundle.source?.provider || null,
    provider_symbol: bundle.source?.provider_symbol || null,
    fetched_at: bundle.fetched_at,
    latest_closed_m5_close_time: bundle.latest_closed_m5_close_time,
    timeframes: bundle.timeframes,
    context_timeframes: bundle.context_timeframes || {},
    external_series: bundle.external_series || {},
    volume_available: bundle.volume_available === true
  };
}

/**
 * Packages normalized closed-candle inputs for local-engine consumers.
 * It never computes indicator outputs. History readiness is separate from
 * source identity, feature availability, and TradingView parity.
 */
export function buildLocalEngineInput(bundle, engine) {
  if (!["mizan", "prophet", "gmi"].includes(engine)) {
    throw new TypeError("engine must be mizan, prophet, or gmi");
  }

  const historyGaps = sourceHistoryGaps(bundle, engine);
  const missingDependencies = [];
  let calculationStatus = "blocked_source_identity";
  let unavailableInputs = [];

  if (engine === "mizan") {
    missingDependencies.push(
      "installed/published MizanLib revision must be matched to the checked-in SSOT",
      "caller-specific feature outputs require closed-candle TradingView fixtures",
      "this is a shared library contract, not a complete standalone Mizan signal engine"
    );
  } else if (engine === "prophet") {
    calculationStatus = "blocked_source_parity";
    missingDependencies.push(
      "full deterministic Prophet R38 implementation (R37 shared-core is not the full R38 engine)",
      "feature-level closed-candle TradingView R38 fixtures",
      "verified equality between the installed published MizanLib /4 and the source used by this repository"
    );
  } else {
    unavailableInputs = gmiUnavailableInputs(bundle);
    calculationStatus = unavailableInputs.length ? "blocked_missing_gmi_inputs" : "blocked_no_local_gmi_calculator";
    missingDependencies.push(
      ...unavailableInputs.map((item) => item.symbol ? `${item.symbol} ${item.timeframe} history` : "M1 intrabar OHLCV arrays for request.security_lower_tf"),
      "deterministic local GMI calculator (not implemented)",
      "feature-level GMI TradingView fixtures and verified MizanLib /4 identity"
    );
  }

  const historyReady = historyGaps.length === 0;
  const inputs = dataForEngine(bundle);
  return {
    schema_version: LOCAL_ENGINE_INPUT_CONTRACT,
    engine,
    symbol: inputs.symbol,
    requested_at: new Date().toISOString(),
    data_status: historyReady ? "history_ready_for_shadow" : "blocked_insufficient_history",
    calculation_status: calculationStatus,
    calculation_allowed_for_trusted_evidence: false,
    parity_status: "not_proven",
    source_caller_contract: SOURCE_CALLER_CONTRACTS[engine],
    history_requirements: HISTORY_REQUIREMENTS[engine],
    history_requirement_scope: engine === "mizan"
      ? "minimum union for known Prophet R38/GMI callers; not a universal requirement for every MizanLib export"
      : "source-derived warm-up floor for the checked-in caller; does not prove full-engine parity",
    history_gaps: historyGaps,
    unavailable_inputs: unavailableInputs,
    missing_dependencies: missingDependencies,
    inputs
  };
}

export function buildLocalEngineReadiness(bundle) {
  return Object.fromEntries(["mizan", "prophet", "gmi"].map((engine) => {
    const result = buildLocalEngineInput(bundle, engine);
    return [engine, {
      data_status: result.data_status,
      calculation_status: result.calculation_status,
      calculation_allowed_for_trusted_evidence: result.calculation_allowed_for_trusted_evidence,
      parity_status: result.parity_status,
      history_requirements: result.history_requirements,
      history_requirement_scope: result.history_requirement_scope,
      history_gaps: result.history_gaps,
      unavailable_inputs: result.unavailable_inputs,
      missing_dependencies: result.missing_dependencies
    }];
  }));
}
