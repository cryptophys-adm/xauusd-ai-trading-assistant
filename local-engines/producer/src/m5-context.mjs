// B2: the 5m execution context is derived from the 5m parity records, not computed a
// second time. buildM5LocalCalculations (m5-local-producer.mjs, part of the prophet_m5 and
// gmi_m5 hashes) computes the records the AI Worker compares with the 5m webhooks; this
// file only reshapes the prophet record of the same bar into the cryptophys.local-context.v1
// shape the live room and the H1 chain read, plus the last 12 closed 5m bars.
//
// The context itself always declares informational_unverified. Whether its bar is verified
// is decided in the AI Worker, against the parity registry (src/m5-verification.mjs), so the
// label follows approval and never trusts the producer's word.
// This file is not part of any engine hash: editing it never resets a parity approval.
const RECENT_BARS = 12;

/**
 * Context for the bar of `built` (the result of buildM5LocalCalculations), or null when the
 * prophet record is missing. `m5Bars` are the closed 5m candles the records were built from.
 */
export function m5ContextFromRecords(built, m5Bars) {
  const prophet = (built?.records || []).find((r) => r.engine === "prophet");
  const r38 = prophet?.values?.comparable?.prophet_r38;
  const bars = Array.isArray(m5Bars) ? m5Bars : [];
  const last = bars.at(-1);
  if (!r38 || !last || Date.parse(last.open_time) !== Date.parse(built.candle_time)) return null;
  return {
    schema_version: "cryptophys.local-context.v1",
    engine: "prophet_r38_5m",
    trust_status: "informational_unverified",
    source: "m5_parity_record",
    symbol: prophet.symbol,
    timeframe: "5",
    candle_key: built.candle_key,
    // The bar's close: the live room meets when a 5m close is also a 15m close.
    candle_time: last.close_time,
    bias: prophet.values.bias,
    buy_confirmed: r38.buy_confirmed === true,
    sell_confirmed: r38.sell_confirmed === true,
    d_enc: r38.d_enc ?? null,
    t_enc: r38.t_enc ?? null,
    recent_bars: bars.slice(-RECENT_BARS).map((b) => ({ t: b.close_time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? null })),
    note: "Same values as this bar's 5m parity record; the AI Worker labels it VERIFIED 5m only while prophet_m5 and gmi_m5 are approved."
  };
}
