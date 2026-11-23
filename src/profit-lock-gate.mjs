// SLG1, one profit-lock gate (owner decision 2026-11-23, relayed by the orchestrator: "one shared gate"). No stop moves
// into profit (break-even, the ladder's lock, key-level SL+, the Position Manager's break-even, its TP1 lock and its
// TP2 with break-even) until the position's maximum favourable excursion (MFE) reaches the mode's threshold on a
// CLOSED bar of the mode's timeframe:
//   scalp     max(1.0R, 1.0 x ATR(14, M15)) on closed M5 bars
//   intraday  max(1.0R, 1.5 x ATR(14, M15)) on closed M15 bars
//   swing     max(1.0R, 1.0 x ATR(H1))      on closed H1 bars
//   range     max(0.75 x the TP distance, 1.0 x ATR(14, M15)) on closed M15 bars
// R is the stop distance placed at entry (the open intent's r_dist); with it unknown only the ATR term counts (range:
// with the plan's TP unknown, likewise). A mode that is not one of these four counts as intraday (as the Position
// Manager's band does). TP2's extension waits for the gate too, and tp2_breakeven's any-profit trigger is gone.
// At the gate the first lock is break-even plus the spread plus 0.1 x ATR(M5); the key-level SL+ and the ladder's lock
// may go further only after it. TP1 still takes the whole position; the initial stop, cut_loss, take_profit_weakening,
// the A8 loosening and lock_tp1's meaning after the gate are unchanged.
//
// MFE is the favourable EXTREME (the wick high of a BUY, the low of a SELL) of the closed bars of the mode's timeframe
// since the fill, built from the broker's M1 bars (the corpus live, v4's 1m bars in the replay), so it only moves when
// such a bar closes. A bar is closed once its end is at or before now; only the minutes from the fill's minute on count
// (a minute that started before the fill is left out). The bars read are bounded to the last GATE_LOOKBACK_MIN minutes
// (CORPUS_READ_MAX, about a day): a position older than that is measured over the minutes available, which can only
// keep the gate closed longer. When MFE cannot be measured (no closed bar since the fill, no ATR, no position data) the
// gate stays CLOSED: no stop moves into profit.
//
// The Omega setting `profit_lock_gate` is the switch: "on" (default) | "legacy". "legacy" is today's engine byte for
// byte (no gate is computed or read). It is the owner's switch only; Aether's policy never writes it. It is in
// ERA_SWITCHES. A read-only brake (src/ledger-omega4.mjs profitLockBrake) may ask the owner, once, to consider
// "legacy"; it never flips the setting.

export const PROFIT_LOCK_GATE_MODES = Object.freeze(["on", "legacy"]);
/** The gate per mode: the timeframe of the closed bars, the R multiple (or the TP share for range), the ATR term. */
export const PROFIT_LOCK_GATE = Object.freeze({
  scalp: Object.freeze({ tf: "M5", tf_min: 5, r: 1.0, atr_k: 1.0, atr_tf: "M15" }),
  intraday: Object.freeze({ tf: "M15", tf_min: 15, r: 1.0, atr_k: 1.5, atr_tf: "M15" }),
  swing: Object.freeze({ tf: "H1", tf_min: 60, r: 1.0, atr_k: 1.0, atr_tf: "H1" }),
  range: Object.freeze({ tf: "M15", tf_min: 15, tp_share: 0.75, atr_k: 1.0, atr_tf: "M15" })
});
/** The first lock at the gate: break-even plus the spread plus this many ATR(M5). */
export const GATE_BE_ATR_M5 = 0.1;
/** The M1 minutes the gate reads back from now at most (src/corpus-oracle.mjs CORPUS_READ_MAX). */
export const GATE_LOOKBACK_MIN = 1500;
const M1 = 60_000;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Pure: whether the gate is on in these settings (anything but "legacy", the default "on" included). */
export function profitLockGateOn(settings) {
  return settings?.profit_lock_gate !== "legacy";
}

/** Pure: the gate's mode for a position's mode at entry: one of the four, else intraday. */
export function gateMode(mode) {
  return typeof mode === "string" && Object.hasOwn(PROFIT_LOCK_GATE, mode) ? mode : "intraday";
}

/**
 * Pure: the ATR(M5) the first lock's buffer uses: the broker's M5 ATR (the signal's m5_atr) when it is there, else
 * ATR(14, M15) / sqrt(3) (the square-root-of-time scaling from 15 to 5 minutes), else 0.
 */
export function gateAtrM5(signal, sym) {
  if (positive(Number(signal?.m5_atr))) return Number(signal.m5_atr);
  return positive(Number(sym?.atr_value)) ? Number(sym.atr_value) / Math.sqrt(3) : 0;
}

/** Pure: the first lock at the gate, break-even plus the spread plus 0.1 x ATR(M5), on the position's side. */
export function gateBreakEven({ open, dir, spread = 0, atrM5 = 0, digits = 2 }) {
  const px = open + dir * ((finite(spread) ? spread : 0) + GATE_BE_ATR_M5 * (finite(atrM5) ? atrM5 : 0));
  return Number(px.toFixed(Math.max(0, Math.min(10, digits))));
}

/** Pure: whether a stop sits at or beyond the entry (a lock into profit, break-even included). */
export function stopInProfit(sl, open, dir, point = 0.01) {
  return finite(sl) && sl > 0 && finite(open) && dir * (sl - open) >= -point / 2;
}

/**
 * Pure: one position's gate facts. `position` { ticket, side, open_price, opened_ms }; `meta` { mode, r_dist, tp_dist }
 * (its open intent: the mode and the stop distance at entry, and for range the plan's TP distance); `bars` the broker's
 * M1 bars ({ t: minute open ms, h, l }); `atrM15` ATR(14, M15) (the terminal's); `atrH1` the latest decision's ATR(H1).
 * Returns { open, mode, tf, mfe_px, mfe_r, mfe_atr, need_px, need, bars, last_close_ms, reason }: `open` true only when
 * the closed bars' favourable extreme since the fill reached need_px.
 */
export function gateFacts({ position: p, meta = null, bars = [], atrM15 = null, atrH1 = null, now }) {
  const mode = gateMode(meta?.mode);
  const rule = PROFIT_LOCK_GATE[mode];
  const out = { open: false, mode, tf: rule.tf, mfe_px: null, mfe_r: null, mfe_atr: null, need_px: null, need: null, bars: 0, last_close_ms: null, reason: null };
  const buy = p?.side === "BUY", dir = buy ? 1 : -1;
  const open = Number(p?.open_price ?? p?.entry), openedMs = Number(p?.opened_ms);
  if ((p?.side !== "BUY" && p?.side !== "SELL") || !finite(open) || !(openedMs > 0) || !finite(now)) return { ...out, reason: "no_position_data" };
  const atr = rule.atr_tf === "H1" ? Number(atrH1) : Number(atrM15);
  const rDist = positive(Number(meta?.r_dist)) ? Number(meta.r_dist) : null;
  const tpDist = positive(Number(meta?.tp_dist)) ? Number(meta.tp_dist) : null;
  // The closed bars of the mode's timeframe since the fill: a bucket counts once its end is at or before now.
  const tf = rule.tf_min * M1;
  const fromMs = Math.max(Math.ceil(openedMs / M1) * M1, now - GATE_LOOKBACK_MIN * M1);
  const lastEnd = Math.floor(now / tf) * tf;
  let ext = null, n = 0, lastClose = null;
  for (const b of Array.isArray(bars) ? bars : []) {
    const t = Number(b?.t);
    if (!finite(t) || t < fromMs || t + M1 > lastEnd) continue;
    const x = Number(buy ? b.h : b.l);
    if (!finite(x)) continue;
    n += 1;
    ext = ext == null ? x : buy ? Math.max(ext, x) : Math.min(ext, x);
    const end = Math.floor(t / tf) * tf + tf;
    if (lastClose == null || end > lastClose) lastClose = end;
  }
  out.bars = n;
  out.last_close_ms = lastClose;
  if (!positive(atr)) return { ...out, reason: rule.atr_tf === "H1" ? "no_atr_h1" : "no_atr_m15" };
  const base = rule.tp_share != null ? (tpDist != null ? rule.tp_share * tpDist : null) : rDist != null ? rule.r * rDist : null;
  const atrTerm = rule.atr_k * atr;
  const need = base != null && base > atrTerm ? base : atrTerm;
  out.need_px = r2(need);
  out.need = base != null && base > atrTerm ? (rule.tp_share != null ? `${rule.tp_share} x TP distance` : `${rule.r}R`) : `${rule.atr_k} x ATR(${rule.atr_tf})`;
  if (ext == null) return { ...out, reason: "no_closed_bar" };
  const mfe = Math.max(0, dir * (ext - open));
  out.mfe_px = r2(mfe);
  out.mfe_r = rDist != null ? r3(mfe / rDist) : null;
  out.mfe_atr = r3(mfe / atr);
  out.open = mfe >= need - 1e-9;
  out.reason = out.open ? "reached" : "below";
  return out;
}

/** Pure: the facts a missing gate reads as while the gate is on: closed (MFE not measured). */
export const GATE_UNMEASURED = Object.freeze({ open: false, mode: null, tf: null, mfe_px: null, mfe_r: null, mfe_atr: null, need_px: null, need: null, bars: 0, last_close_ms: null, reason: "unmeasured" });

/** Pure: a gate's state in words, for a reason or a log line ("MFE 0.8R (1.1 ATR) of 1.5 x ATR(M15) on closed M15 bars"). */
export function gateText(g) {
  if (!g) return "the profit-lock gate has no measurement";
  if (g.mfe_px == null) return `the MFE cannot be measured yet (${g.reason ?? "unmeasured"}${g.tf ? `, closed ${g.tf} bars` : ""})`;
  const r = g.mfe_r != null ? `${g.mfe_r}R, ` : "";
  return `MFE ${g.mfe_px} (${r}${g.mfe_atr} ATR) on closed ${g.tf} bars against ${g.need_px} (${g.need})`;
}

/**
 * Pure: the gate facts of each position ({ [ticket]: facts }). `metaOf(p)` gives { mode, r_dist, tp_dist } of its open
 * intent. The same function serves the live sync, the Position Manager's run and v4's replay.
 */
export function gatesFor({ positions = [], metaOf = () => null, bars = [], atrM15 = null, atrH1 = null, now }) {
  const out = {};
  for (const p of Array.isArray(positions) ? positions : []) {
    if (p?.ticket == null) continue;
    out[String(p.ticket)] = gateFacts({ position: p, meta: metaOf(p), bars, atrM15, atrH1, now });
  }
  return out;
}

/** Pure: the earliest minute the gate needs for these positions (the read's start), or null without one. */
export function gateReadSince(positions = [], now) {
  const opened = (Array.isArray(positions) ? positions : []).map((p) => Number(p?.opened_ms)).filter((x) => x > 0);
  if (!opened.length || !finite(now)) return null;
  return Math.max(Math.floor(Math.min(...opened) / M1) * M1, now - GATE_LOOKBACK_MIN * M1);
}
