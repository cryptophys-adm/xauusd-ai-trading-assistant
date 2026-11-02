/**
 * Source-derived translation of Mizan's prophet_structure_core call used by
 * the owner-designated GMI Pine source.
 *
 * This is NOT full GMI parity. The oscillator and ATR inputs must already match
 * the TradingView source; exact published Mizan /4 identity and TV fixtures are
 * still required before any parity/provenance approval.
 */

export const PROPHET_R37_STRUCTURE_SOURCE = Object.freeze({
  pineExport: "prophet_structure_core",
  parameters: Object.freeze({
    legacyMode: false,
    stateMaxAge: 50,
    pivotLeft: 5,
    pivotRight: 2,
    bodyFloorAtr: 0.10,
    wickBodyRatio: 1.5
  }),
  outputFields: Object.freeze([
    "d_enc", "b_enc", "state_bar", "bull_event_bar", "bear_event_bar",
    "subtype", "oscillator_ph", "oscillator_pl", "bear_div_event",
    "bull_div_event", "bear_div_origin_bar", "bear_div_origin_value",
    "bull_div_origin_bar", "bull_div_origin_value", "last_price_ph",
    "last_price_pl"
  ])
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const pineGt = (a, b) => finite(a) && finite(b) && a > b;
const pineLt = (a, b) => finite(a) && finite(b) && a < b;
const pineEq = (a, b) => finite(a) && finite(b) && a === b;
const minPine = (a, b) => finite(a) && finite(b) ? Math.min(a, b) : null;
const maxPine = (a, b) => finite(a) && finite(b) ? Math.max(a, b) : null;

function pivotAt(values, index, left, right, high) {
  const pivotIndex = index - right;
  if (pivotIndex < left || pivotIndex < 0) return null;
  const value = values[pivotIndex];
  if (!finite(value)) return null;
  const start = pivotIndex - left;
  const end = pivotIndex + right;
  if (start < 0 || end > index) return null;
  for (let i = start; i <= end; i++) {
    if (i === pivotIndex || !finite(values[i])) continue;
    // Pine ta.pivothigh/low accepts equal values according to its own tie
    // semantics. Strict comparison here avoids inventing a duplicate pivot;
    // tied-window behavior remains a fixture requirement.
    if (high ? values[i] >= value : values[i] <= value) return null;
  }
  return value;
}

function normalizeCandle(candle, index) {
  if (!candle || typeof candle !== "object") throw new TypeError(`candles[${index}] must be an object`);
  const bar_index = candle.bar_index ?? index;
  if (!Number.isSafeInteger(bar_index)) throw new TypeError(`candles[${index}].bar_index must be an integer`);
  for (const key of ["open", "high", "low", "close"]) {
    if (!finite(candle[key])) throw new TypeError(`candles[${index}].${key} must be finite`);
  }
  if (candle.high < candle.low || candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close)) {
    throw new RangeError(`candles[${index}] has inconsistent OHLC`);
  }
  for (const key of ["oscillator", "volume_ratio", "atr"]) {
    if (candle[key] != null && !finite(candle[key])) throw new TypeError(`candles[${index}].${key} must be finite or null`);
  }
  return {
    ...candle, bar_index,
    oscillator: candle.oscillator ?? null,
    volume_ratio: candle.volume_ratio ?? null,
    has_volume: candle.has_volume === true,
    atr: candle.atr ?? null
  };
}

/**
 * Replays the exact source-ordered structure state machine for an ordered,
 * closed-candle sequence. Provide full warm-up history; the function does not
 * infer missing candles or manufacture oscillator/ATR values.
 */
export function replayProphetR37Structure(inputCandles, options = {}) {
  if (!Array.isArray(inputCandles)) throw new TypeError("candles must be an array");
  const cfg = {
    legacyMode: false,
    stateMaxAge: 50,
    pivotLeft: 5,
    pivotRight: 2,
    bodyFloorAtr: 0.10,
    wickBodyRatio: 1.5,
    ...options
  };
  for (const key of ["stateMaxAge", "pivotLeft", "pivotRight"]) {
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  for (const key of ["bodyFloorAtr", "wickBodyRatio"]) {
    if (!finite(cfg[key]) || cfg[key] < 0) throw new RangeError(`${key} must be a non-negative finite number`);
  }
  const candles = inputCandles.map(normalizeCandle);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].bar_index <= candles[i - 1].bar_index) {
      throw new RangeError("bar_index must be strictly increasing");
    }
  }

  const oscillator = candles.map(c => c.oscillator);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const out = [];
  let lastPhValue = null, lastPricePh = null, lastPhIndex = null;
  let lastPlValue = null, lastPricePl = null, lastPlIndex = null;
  let dState = 0, bState = 0, stateBar = null, bullEventBar = null, bearEventBar = null, subtype = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], bar = c.bar_index;
    const oscillatorPh = pivotAt(oscillator, i, cfg.pivotLeft, cfg.pivotRight, true);
    const oscillatorPl = pivotAt(oscillator, i, cfg.pivotLeft, cfg.pivotRight, false);
    const prevOsc = i > 0 ? oscillator[i - 1] : null;
    const crossUp = pineLt(prevOsc, 0) && pineGt(c.oscillator, 0) ||
      (pineEq(c.oscillator, 0) && pineLt(prevOsc, 0));
    const crossDown = pineGt(prevOsc, 0) && pineLt(c.oscillator, 0) ||
      (pineEq(c.oscillator, 0) && pineGt(prevOsc, 0));
    let bearDivEvent = false, bullDivEvent = false;
    let bearDivOriginBar = null, bearDivOriginValue = null;
    let bullDivOriginBar = null, bullDivOriginValue = null;

    if ((crossUp || crossDown) && (Math.abs(dState) < 3 || !cfg.legacyMode)) {
      dState = 0; bState = 1;
      if (!cfg.legacyMode) {
        subtype = 0; stateBar = null; bullEventBar = null; bearEventBar = null;
      }
    }

    if (oscillatorPh !== null) {
      const pivotPrice = highs[i - cfg.pivotRight];
      if (pineGt(pivotPrice, lastPricePh) && pineLt(oscillatorPh, lastPhValue) && pineGt(oscillatorPh, 0)) {
        dState = -1; bState = 2; bearEventBar = bar;
        bearDivEvent = true; bearDivOriginBar = lastPhIndex; bearDivOriginValue = lastPhValue;
        if (!cfg.legacyMode) bullEventBar = null;
      }
      lastPhValue = oscillatorPh;
      lastPricePh = pivotPrice;
      lastPhIndex = candles[i - cfg.pivotRight].bar_index;
    }

    if (oscillatorPl !== null) {
      const pivotPrice = lows[i - cfg.pivotRight];
      if (pineLt(pivotPrice, lastPricePl) && pineGt(oscillatorPl, lastPlValue) && pineLt(oscillatorPl, 0)) {
        dState = 1; bState = 2; bullEventBar = bar;
        bullDivEvent = true; bullDivOriginBar = lastPlIndex; bullDivOriginValue = lastPlValue;
        if (!cfg.legacyMode) bearEventBar = null;
      }
      lastPlValue = oscillatorPl;
      lastPricePl = pivotPrice;
      lastPlIndex = candles[i - cfg.pivotRight].bar_index;
    }

    const body = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const effectiveBody = cfg.legacyMode ? body : (finite(c.atr) ? Math.max(body, c.atr * cfg.bodyFloorAtr) : null);
    const bottomRejection = effectiveBody !== null && lowerWick > effectiveBody * cfg.wickBodyRatio;
    const topRejection = effectiveBody !== null && upperWick > effectiveBody * cfg.wickBodyRatio;
    const realVolume = cfg.legacyMode ? pineGt(c.volume_ratio, 1) : (c.has_volume && pineGt(c.volume_ratio, 1));

    if (dState === -1) {
      if (pineGt(c.close, lastPricePh)) {
        if (topRejection || (cfg.legacyMode ? !realVolume : (c.has_volume && !realVolume))) {
          dState = 3; bState = -4; subtype = 1; bearEventBar = bar;
          if (!cfg.legacyMode) bullEventBar = null;
        } else {
          dState = -3; bState = 3; subtype = 2; bullEventBar = bar;
          if (!cfg.legacyMode) bearEventBar = null;
        }
        stateBar = bar;
      } else if (pineLt(c.close, i > 0 ? lows[i - 1] : null) && pineLt(c.close, c.open)) {
        bState = -3; bearEventBar = bar;
        if (!cfg.legacyMode) bullEventBar = null;
      }
    }

    if (dState === 1) {
      if (pineLt(c.close, lastPricePl)) {
        if (bottomRejection || (cfg.legacyMode ? !realVolume : (c.has_volume && !realVolume))) {
          dState = -3; bState = 3; subtype = 3; bullEventBar = bar;
          if (!cfg.legacyMode) bearEventBar = null;
        } else {
          dState = 3; bState = -4; subtype = 4; bearEventBar = bar;
          if (!cfg.legacyMode) bullEventBar = null;
        }
        stateBar = bar;
      } else if (pineGt(c.close, i > 0 ? highs[i - 1] : null) && pineGt(c.close, c.open)) {
        bState = 3; bullEventBar = bar;
        if (!cfg.legacyMode) bearEventBar = null;
      }
    }

    if (!cfg.legacyMode && (dState === 3 || dState === -3) && stateBar !== null &&
        bar - stateBar > cfg.stateMaxAge) {
      dState = 0; bState = 1; subtype = 0; stateBar = null;
      bullEventBar = null; bearEventBar = null;
    }

    out.push({
      bar_index: bar,
      d_enc: dState, b_enc: bState, state_bar: stateBar,
      bull_event_bar: bullEventBar, bear_event_bar: bearEventBar, subtype,
      oscillator_ph: oscillatorPh, oscillator_pl: oscillatorPl,
      bear_div_event: bearDivEvent, bull_div_event: bullDivEvent,
      bear_div_origin_bar: bearDivOriginBar, bear_div_origin_value: bearDivOriginValue,
      bull_div_origin_bar: bullDivOriginBar, bull_div_origin_value: bullDivOriginValue,
      last_price_ph: lastPricePh, last_price_pl: lastPricePl
    });
  }
  return out;
}
