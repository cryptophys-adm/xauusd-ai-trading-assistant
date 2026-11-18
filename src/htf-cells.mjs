// Range mode, step 1 (owner 2026-11-18, confirmed: "Setuju"): the H4/D1 trend filter and the evidence gate per cell.
//
// The replay showed the range strategies win on one side and lose on the other: selling the top of a range in a
// downtrend paid, buying its bottom lost 0/11. So for the range strategies (RANGE_GATED_AGENTS):
//   1. The HTF trend: H4 and D1, each "up", "down" or "flat" from its EMA(50) and the EMA's slope over 5 closed bars,
//      combined ("mixed" when they disagree). A side is "with", "against" or "neutral" to it.
//   2. Against a clear HTF trend a range strategy does not trade (htf_against). Its counter-trend trades are the
//      reversal probation's (a later step), never this gate's. An unknown trend (too few bars) trades nothing.
//   3. With the trend or with no clear trend, a range strategy trades only in a cell (agent x side x HTF context)
//      whose own replayed record passes CELL_GATE: at least 30 resolved setups at +0.10R or better. Fewer setups
//      collect; a record below the bar holds the cell.
// Every other agent is untouched. Nothing here sizes a trade or bypasses a risk check: a gated trade has no side.

export const RANGE_GATED_AGENTS = Object.freeze(["range_fade", "sweep_reversal"]);
export const CELL_GATE = Object.freeze({ min_setups: 30, min_mean_r: 0.10 });
export const HTF_RULES = Object.freeze({ ema_period: 50, slope_bars: 5, min_bars: 56 });
export const HTF_CONTEXTS = Object.freeze(["with", "against", "neutral", "unknown"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const closeMsOf = (b) => (isNum(b?.close_ms) ? b.close_ms : Date.parse(b?.close_time ?? ""));
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Pure: one timeframe's trend at `closeMs` from its bars closed by then: "up", "down", "flat", or null (too few). */
export function tfTrend(bars, closeMs, rules = HTF_RULES) {
  const closed = (Array.isArray(bars) ? bars : []).filter((b) => isNum(b?.close) && isNum(closeMsOf(b)) && closeMsOf(b) <= closeMs)
    .sort((a, b) => closeMsOf(a) - closeMsOf(b));
  if (closed.length < rules.min_bars) return null;
  const k = 2 / (rules.ema_period + 1);
  let ema = closed.slice(0, rules.ema_period).reduce((s, b) => s + b.close, 0) / rules.ema_period;
  const emas = [];
  for (let i = rules.ema_period; i < closed.length; i += 1) { ema = closed[i].close * k + ema * (1 - k); emas.push(ema); }
  if (emas.length <= rules.slope_bars) return null;
  const now = emas.at(-1), before = emas.at(-1 - rules.slope_bars), last = closed.at(-1).close;
  if (last > now && now > before) return "up";
  if (last < now && now < before) return "down";
  return "flat";
}

/** Pure: the HTF trend from H4 and D1: both agree, or one is flat and the other not: that way; they disagree: "mixed". */
export function htfTrend(h4, d1) {
  if (h4 == null || d1 == null) return null;
  if (h4 === d1) return h4;
  if (h4 === "flat") return d1;
  if (d1 === "flat") return h4;
  return "mixed";
}

/** Pure: a side's context to the HTF trend: "with", "against", "neutral" (flat or mixed) or "unknown". */
export function htfContext(side, trend) {
  if (trend == null || (side !== "BUY" && side !== "SELL")) return "unknown";
  if (trend === "up") return side === "BUY" ? "with" : "against";
  if (trend === "down") return side === "SELL" ? "with" : "against";
  return "neutral";
}

/** Pure: the HTF trend and both timeframes' own at `closeMs`. */
export function htfAt({ h4 = [], d1 = [] } = {}, closeMs) {
  const a = tfTrend(h4, closeMs), b = tfTrend(d1, closeMs);
  return { h4: a, d1: b, trend: htfTrend(a, b) };
}

/** The H4 and D1 bars of the market-data cache (empty on any failure). */
export async function loadHtfBars(env) {
  const read = async (tf) => {
    try {
      const rec = JSON.parse((await env?.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${tf}`)) || "null");
      return Array.isArray(rec?.candles) ? rec.candles : [];
    } catch { return []; }
  };
  const [h4, d1] = await Promise.all([read("4h"), read("1D")]);
  return { h4, d1 };
}

export const cellKey = (agent, side, context) => `${agent}|${side}|${context}`;

/**
 * Pure: each gated agent's record per cell from resolved setups ({ agent, side, htf, results: { [arm]: { r } } }, `arm`
 * the plan as it is): [{ agent, side, context, setups, mean_r, status }], status per cellStatus.
 */
export function cellRecords(setups, { arm, gated = RANGE_GATED_AGENTS } = {}) {
  const by = new Map();
  for (const s of setups || []) {
    if (!gated.includes(s?.agent) || (s.side !== "BUY" && s.side !== "SELL")) continue;
    const r = s.results?.[arm]?.r;
    if (!isNum(r)) continue;
    const context = HTF_CONTEXTS.includes(s.htf) ? s.htf : "unknown";
    const k = cellKey(s.agent, s.side, context);
    const c = by.get(k) ?? { agent: s.agent, side: s.side, context, n: 0, r: 0 };
    c.n += 1; c.r += r;
    by.set(k, c);
  }
  return [...by.values()].sort((a, b) => cellKey(a.agent, a.side, a.context).localeCompare(cellKey(b.agent, b.side, b.context)))
    .map((c) => { const mean = r3(c.r / c.n); return { agent: c.agent, side: c.side, context: c.context, setups: c.n, mean_r: mean, status: cellStatus(c.n, mean) }; });
}

/** Pure: "pass" (30+ setups at +0.10R or better), "collecting" (under 30) or "below_bar". */
export function cellStatus(setups, meanR, gate = CELL_GATE) {
  if (!(setups >= gate.min_setups)) return "collecting";
  return isNum(meanR) && meanR >= gate.min_mean_r ? "pass" : "below_bar";
}

/**
 * Pure: the gate on a signal (the EA signal of src/ea-signal.mjs). For a range strategy's BUY or SELL it adds `htf_trend`,
 * `htf_context` and `cell_gate`, and when the trade may not go live it has no side (awaiting_reason htf_against,
 * htf_unknown, cell_collecting or cell_below_bar), as the strategy arm does. Any other signal is unchanged.
 */
export function applyCellGate(sig, { htf = null, cells = [], gated = RANGE_GATED_AGENTS } = {}) {
  if (!sig || (sig.side !== "BUY" && sig.side !== "SELL") || !gated.includes(sig.trade_agent)) return sig;
  const context = htfContext(sig.side, htf?.trend ?? null);
  const cell = (Array.isArray(cells) ? cells : []).find((c) => c.agent === sig.trade_agent && c.side === sig.side && c.context === context) ?? null;
  const gate = { agent: sig.trade_agent, side: sig.side, context, setups: cell?.setups ?? 0, mean_r: cell?.mean_r ?? null, status: cell?.status ?? "collecting" };
  const out = { ...sig, htf_trend: htf?.trend ?? "unknown", htf_h4: htf?.h4 ?? "unknown", htf_d1: htf?.d1 ?? "unknown", htf_context: context, cell_gate: `${gate.status}:${gate.setups}:${gate.mean_r ?? "na"}` };
  const reason = context === "unknown" ? "htf_unknown" : context === "against" ? "htf_against" : gate.status === "pass" ? null : gate.status === "collecting" ? "cell_collecting" : "cell_below_bar";
  if (!reason) return out;
  return { ...out, awaiting_signal_id: out.signal_id, awaiting_side: out.side, awaiting_reason: reason, signal_id: "", side: "NONE", action: "", entry: 0, stop: 0, tp1: 0 };
}

/** Pure: the readable line for a gated signal (Omega page notes). */
export function cellGateText(sig) {
  const [status, setups, mean] = String(sig?.cell_gate ?? "").split(":");
  const who = `${sig?.trade_agent ?? "?"} ${sig?.awaiting_side ?? sig?.side ?? "?"}`;
  if (sig?.awaiting_reason === "htf_against") return `${who} against the H4/D1 trend (${sig.htf_trend}; H4 ${sig.htf_h4}, D1 ${sig.htf_d1}): range strategies fade only with the trend`;
  if (sig?.awaiting_reason === "htf_unknown") return `${who}: the H4/D1 trend is unknown (too few bars), so no range trade`;
  if (sig?.awaiting_reason === "cell_collecting") return `${who} (${sig.htf_context}): collecting evidence, ${setups}/${CELL_GATE.min_setups} setups`;
  if (sig?.awaiting_reason === "cell_below_bar") return `${who} (${sig.htf_context}): ${mean}R per setup over ${setups} setups, under the +${CELL_GATE.min_mean_r}R bar`;
  return status ? `${who} (${sig?.htf_context}): cell ${status}` : "";
}
