export const LOCAL_ENGINE_INPUT_CONTRACT = "cryptophys.local-engine-input.v1";

const HISTORY_REQUIREMENTS = Object.freeze({
  mizan: Object.freeze({ M5: 300 }),
  prophet: Object.freeze({ M5: 101, M15: 51, H1: 51, H4: 51, D1: 51, W1: 51 }),
  gmi: Object.freeze({ M5: 300, M15: 51, H1: 51, H4: 51, D1: 51, W1: 51 })
});

function countFor(bundle, timeframe) {
  if (["D1", "W1"].includes(timeframe)) {
    return bundle?.context_timeframes?.[timeframe]?.candle_count ??
      bundle?.context_timeframes?.[timeframe]?.candles?.length ?? 0;
  }
  return bundle?.timeframes?.[timeframe]?.candle_count ??
    bundle?.timeframes?.[timeframe]?.candles?.length ?? 0;
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
    volume_available: bundle.volume_available === true
  };
}

/**
 * Packages closed candle history for the local engine workers. This module
 * never computes or labels indicator outputs; the source/parity gates remain
 * independent of whether enough candles are present.
 */
export function buildLocalEngineInput(bundle, engine) {
  if (!["mizan", "prophet", "gmi"].includes(engine)) {
    throw new TypeError("engine must be mizan, prophet, or gmi");
  }

  const historyGaps = sourceHistoryGaps(bundle, engine);
  const missingDependencies = [];
  let sourceGate = "blocked_source_identity";

  if (engine === "mizan") {
    missingDependencies.push(
      "approved caller-specific Mizan calculation contract",
      "exact installed/published MizanLib import-version match",
      "TradingView closed-candle output fixtures for claimed features"
    );
  } else if (engine === "prophet") {
    sourceGate = "blocked_source_parity";
    missingDependencies.push(
      "exact MizanLib /4 dependency identity",
      "R38 feature-level TradingView output fixtures",
      "full R38 deterministic implementation; the R37 shared-core kernel is not the full Prophet engine"
    );
  } else {
    sourceGate = "blocked_missing_gmi_inputs";
    missingDependencies.push(
      "M1 intrabar OHLCV arrays required by request.security_lower_tf on an M5 chart",
      "TVC:DXY H4 history",
      "CRYPTOCAP:USDT H4 history",
      "TVC:USOIL history",
      "TradingView-compatible footprint/order-flow evidence",
      "exact MizanLib /4 dependency identity and GMI feature-level TradingView fixtures"
    );
  }

  if (engine === "gmi") {
    if (countFor(bundle, "M5") < 300) historyGaps.push({
      code: "volume_profile_lookback_not_satisfied",
      timeframe: "M5",
      required_bars: 300,
      available_bars: countFor(bundle, "M5")
    });
    if (countFor(bundle, "D1") < 21) historyGaps.push({
      code: "daily_cpr_20_day_warmup_not_satisfied",
      timeframe: "D1",
      required_bars: 21,
      available_bars: countFor(bundle, "D1")
    });
  }

  const historyReady = historyGaps.length === 0;
  const inputs = dataForEngine(bundle);
  return {
    schema_version: LOCAL_ENGINE_INPUT_CONTRACT,
    engine,
    symbol: inputs.symbol,
    requested_at: new Date().toISOString(),
    data_status: historyReady ? "history_ready_for_shadow" : "blocked_insufficient_history",
    calculation_status: sourceGate,
    calculation_allowed_for_trusted_evidence: false,
    parity_status: "not_proven",
    history_requirements: HISTORY_REQUIREMENTS[engine],
    history_gaps: historyGaps,
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
      history_gaps: result.history_gaps,
      missing_dependencies: result.missing_dependencies
    }];
  }));
}
