// Informational (unverified) local computation for the last closed 5m bar.
// Unlike the H1 producer, there is no TradingView webhook comparator for 5m,
// so these outputs are NEVER trusted evidence and are not published to the
// AI Worker's local_computation lane. They exist only for UI context (Fase A).
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";

const CHART_TICKERID = "OANDA:XAUUSD";

export function buildM5ProphetContext(bars5m, { mintick = 0.001 } = {}) {
  const slice = Array.isArray(bars5m) ? bars5m.slice(-200) : [];
  if (slice.length < 50) {
    throw Object.assign(new Error("insufficient 5m history"), { code: "insufficient_5m_history" });
  }
  const last = slice.at(-1);
  const r38 = calculateProphetR38Core(slice.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: 5,
    gmi_closed_only: true,
    mintick,
    higher_timeframes: {}
  });
  const o = r38.outputs.at(-1) || {};
  const buy = o.confirmation?.buy_confirmed === true;
  const sell = o.confirmation?.sell_confirmed === true;
  return {
    schema_version: "cryptophys.local-context.v1",
    engine: "prophet_r38_5m",
    trust_status: "informational_unverified",
    symbol: CHART_TICKERID,
    timeframe: "5",
    candle_time: last.close_time,
    bias: buy ? "BULLISH" : sell ? "BEARISH" : "NEUTRAL",
    buy_confirmed: buy,
    sell_confirmed: sell,
    d_enc: o.structure?.d_enc ?? null,
    t_enc: null,
    // Last 12 closed 5m bars for the live room (Phase 3b). Informational only.
    recent_bars: slice.slice(-12).map((b) => ({ t: b.close_time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? null })),
    note: "Unverified 5m context. No webhook comparator exists; do not use as trusted evidence."
  };
}

export const internals = { buildM5ProphetContext };
