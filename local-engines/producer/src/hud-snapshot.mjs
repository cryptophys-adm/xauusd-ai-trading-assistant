// Phase C2: HUD snapshot for one closed chart bar (M15, H1, H4 or D1; H4 and D1 for the
// timeframe War Rooms, owner decision 2026-11-06).
//
// One snapshot carries the data of each Pine HUD section (RFC_HUD_AGENTS §1.2) as
// numbers, booleans and small enum tokens, never rendered *_txt strings. It is built
// from the same local engines as the parity lane (Prophet R38 core, the GMI-embedded
// Prophet R37 core, GMI v12.70), computed again here on the same closed bars, plus the
// Mizan formulas for Camarilla and CPR (CryptophysMizanLib camarilla_extended,
// daily_cpr_stats; GMI weekly CPR).
//
// Verification is per field and is decided by the AI Worker, not here: `parity` maps
// the fields that are TradingView alert fields to their path in the parity-approved
// local record (for example "prophet_r38.d_enc"). The AI Worker marks a field verified
// only when it equals the approved record of the same candle. Every other field is an
// engine internal that no comparator has checked yet and is read as unverified.
// A HUD whose data is not computed locally (Grid Bot Protocol) is absent, never invented.
//
// This module is not part of any approved implementation hash: it only imports the
// hashed engines, so changing it never touches the approved H1 or 5m identities.
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";
import { replayProphetR37ClosedBars } from "../../../src/prophet-r37-oscillator.mjs";
import { computeGmiOnChart } from "../../gmi/src/gmi-core-tf.mjs";
import { computeGmiOnHtfChart } from "../../gmi/src/gmi-core-htf.mjs";
import { CHART_TICKERID, prophetR38TEnc, prophetConsensusDir } from "./h1-producer.mjs";
import { computeMacroAether } from "./macro-aether.mjs";

export const HUD_SNAPSHOT_VERSION = "cryptophys.hud-snapshot.v1";
const CHART = Object.freeze({
  H1: { minutes: 60, period: "60", minBars: 320 },
  M15: { minutes: 15, period: "15", minBars: 320 },
  // H4 and D1 (Pine v6 timeframe.period "240" and "1D"); GMI on them runs on gmi-core-htf.mjs.
  H4: { minutes: 240, period: "240", minBars: 320, htf: true, own: "240" },
  D1: { minutes: 1440, period: "1D", minBars: 320, htf: true, own: "D" }
});
const WINDOW = 1000;
const NY = "America/New_York";

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (finite(x) ? x : null);
const bars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);
const round = (x, d = 4) => (finite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function nyMinutes(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t) => Number(p.find((x) => x.type === t)?.value);
  return get("hour") * 60 + get("minute");
}
const inSession = (m, start, end) => (start <= end ? m >= start && m < end : m >= start || m < end);

/** Mizan camarilla_extended from one previous bar. */
export function camarilla(prev) {
  if (!prev || ![prev.high, prev.low, prev.close].every(finite)) return null;
  const range = Math.max(prev.high - prev.low, 0.0001);
  const h4 = prev.close + range * 1.1 / 2, h3 = prev.close + range * 1.1 / 4;
  const l3 = prev.close - range * 1.1 / 4, l4 = prev.close - range * 1.1 / 2;
  const h5 = h4 + 1.168 * (h4 - h3), l5 = l4 - 1.168 * (l3 - l4);
  const h6 = h5 + 1.168 * (h5 - h4), l6 = l5 - 1.168 * (l4 - l5);
  return { h6: round(h6, 3), h5: round(h5, 3), h4: round(h4, 3), h3: round(h3, 3), l3: round(l3, 3), l4: round(l4, 3), l5: round(l5, 3), l6: round(l6, 3) };
}

/** Where a price sits among the Camarilla levels, from "above_h6" down to "below_l6". */
export function camarillaBand(price, levels) {
  if (!finite(price) || !levels) return null;
  const order = [["h6", "above_h6"], ["h5", "h5_h6"], ["h4", "h4_h5"], ["h3", "h3_h4"], ["l3", "l3_h3"], ["l4", "l4_l3"], ["l5", "l5_l4"], ["l6", "l6_l5"]];
  for (const [level, band] of order) if (price >= levels[level]) return band;
  return "below_l6";
}

/** Floor-pivot CPR from one previous completed bar (Mizan daily_cpr_stats, GMI weekly CPR). */
export function cpr(prev, price) {
  if (!prev || ![prev.high, prev.low, prev.close].every(finite)) return null;
  const p = (prev.high + prev.low + prev.close) / 3, bc = (prev.high + prev.low) / 2, tc = 2 * p - bc;
  const top = Math.max(bc, tc), bottom = Math.min(bc, tc);
  const position = !finite(price) ? null : price > top ? "above_tc" : price < bottom ? "below_bc" : "inside";
  return { pivot: round(p, 3), tc: round(top, 3), bc: round(bottom, 3), width: round(top - bottom, 3), position };
}

/** Last bar of a native series that closed at or before `ms`. */
function lastClosedAt(series, ms) {
  let found = null;
  for (const b of series) if (Date.parse(b.close_time) <= ms) found = b;
  return found;
}

/** Macro & Aether rows; a failure leaves them absent, never invented. */
function macroAether(chartBars, bundle, chart, mintick) {
  try {
    const m = computeMacroAether({ chartBars, external: bundle?.external_series || {}, chartKey: chart, mintick });
    if (!m) return {};
    const { open_fvg_targets: targets, ...fields } = m;
    return { ...fields, open_fvg_targets_bull: targets?.bull ?? null, open_fvg_targets_bear: targets?.bear ?? null };
  } catch {
    return {};
  }
}

/**
 * buildHudSnapshot(bundle, { chart: "H1" | "M15" | "H4" | "D1", now, mintick })
 */
export function buildHudSnapshot(bundle, { chart = "H1", now = Date.now(), mintick = 0.001 } = {}) {
  const spec = CHART[chart];
  if (!spec) throw Object.assign(new Error(`unsupported HUD chart: ${chart}`), { code: "unsupported_hud_chart" });
  const tf = bundle?.timeframes || {};
  const chartBars = bars(tf[chart]).slice(-WINDOW);
  if (chartBars.length < spec.minBars) throw Object.assign(new Error(`insufficient ${chart} history: ${chartBars.length}`), { code: "insufficient_hud_history" });
  const last = chartBars.at(-1);
  const openMs = Date.parse(last.open_time), closeMs = Date.parse(last.close_time);
  if (!finite(openMs) || closeMs > now) throw Object.assign(new Error(`latest ${chart} bar is not closed`), { code: "hud_bar_not_closed" });

  const r38 = calculateProphetR38Core(chartBars.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: spec.minutes, gmi_closed_only: true, mintick,
    higher_timeframes: { M15: bars(tf.M15), H1: bars(tf.H1), H4: bars(tf.H4), D1: bars(tf.D1), W1: bars(tf.W1) }
  });
  const o = r38.outputs.at(-1);
  const conf = o.confirmation || {}, st = o.structure || {}, sensors = o.sensors || {}, osc = o.oscillator || {}, htf = o.htf_alignment || {}, ob = o.order_blocks || {};
  const tEnc = prophetR38TEnc({
    dEnc: st.d_enc, bEnc: st.b_enc, proFast: osc.fast, zScore: sensors.kww_zscore_50, hurst: sensors.hurst_rs_100,
    inten: sensors.cycle_intensity, kaufmanEr: sensors.efficiency_ratio_14, volAnom: finite(sensors.volume_ratio_20) ? sensors.volume_ratio_20 : 1.0
  });
  const r37 = replayProphetR37ClosedBars(chartBars.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), { mintick });
  const s37 = r37.structure.at(-1);
  const prophetDir37 = prophetConsensusDir({ proFast: r37.pro_fast.at(-1), dEnc: s37.d_enc, subtype: s37.subtype });

  let gmi = null, gmiError = null;
  try {
    gmi = spec.htf ? computeGmiOnHtfChart(bundle, { chart, mintick }) : computeGmiOnChart(bundle, { chart, mintick });
    if (gmi.open_time !== last.open_time) { gmi = null; gmiError = "gmi_bar_mismatch"; }
  } catch (error) { gmiError = typeof error?.code === "string" ? error.code : "gmi_failed"; }
  const g = gmi?.comparable || {}, gd = gmi?.diagnostics || {}, zones = gd.zones || {};
  const close = last.close;

  // A chart bar's own previous bar for the chart-timeframe Camarilla; for higher timeframes
  // the last native bar closed at this chart bar's close (request.security, lookahead off).
  const previousChartBar = chartBars.at(-2) ?? null;
  const higher = { "240": tf.H4, D: tf.D1, W: tf.W1 };
  const camarillaByTf = { [spec.period]: camarilla(previousChartBar) };
  // On the H4 or D1 chart its own timeframe is the chart entry above (the previous bar).
  for (const [key, frame] of Object.entries(higher)) if (key !== spec.own) camarillaByTf[key] = camarilla(lastClosedAt(bars(frame), closeMs));
  const dailyPrev = lastClosedAt(bars(tf.D1), openMs);
  const weeklyPrev = lastClosedAt(bars(tf.W1), openMs);
  const ny = nyMinutes(openMs);

  const hud = (fields, parity = {}) => ({ fields, parity: Object.fromEntries(Object.entries(parity).filter(([f]) => f in fields)) });
  const R38 = (f) => "prophet_r38." + f, GMI = (f) => "gmi_v12_70." + f;
  const huds = {
    r37_funnel: hud({
      buy_candidate: conf.buy_candidate === true, sell_candidate: conf.sell_candidate === true,
      buy_price_confirm: conf.bullish_price_confirm === true, sell_price_confirm: conf.bearish_price_confirm === true,
      buy_structure_confirm: conf.bullish_structure_confirm === true, sell_structure_confirm: conf.bearish_structure_confirm === true,
      buy_volume_pass: conf.buy_volume_pass === true, sell_volume_pass: conf.sell_volume_pass === true,
      buy_confirmed: conf.buy_confirmed === true, sell_confirmed: conf.sell_confirmed === true,
      buy_high_quality: conf.buy_high_quality === true, sell_high_quality: conf.sell_high_quality === true,
      gate_status: typeof conf.gate_status === "string" ? conf.gate_status : null
    }, { buy_confirmed: R38("buy_confirmed"), sell_confirmed: R38("sell_confirmed"), buy_high_quality: R38("buy_high_quality"), sell_high_quality: R38("sell_high_quality") }),
    prophet: hud({
      d_enc: num(st.d_enc), structure_subtype: num(st.subtype_code), t_enc: num(tEnc), b_enc: num(st.b_enc),
      cycle_intensity: num(sensors.cycle_intensity), kww_zscore: round(sensors.kww_zscore_50), hurst: round(sensors.hurst_rs_100),
      efficiency_ratio: round(sensors.efficiency_ratio_14), volume_ratio: round(sensors.volume_ratio_20),
      oscillator_fast: round(osc.fast), oscillator_slow: round(osc.slow)
    }, { d_enc: R38("d_enc"), structure_subtype: R38("structure_subtype"), t_enc: R38("t_enc") }),
    trade_management: hud({
      prophet_dir: num(g.prophet_dir ?? prophetDir37), gmi_dir: num(g.gmi_dir), conflict: typeof g.conflict === "boolean" ? g.conflict : null, gate: num(g.gate),
      cycle_intensity: num(sensors.cycle_intensity), kww_zscore: round(sensors.kww_zscore_50),
      ob_filter_status: typeof ob.ob_filter_status === "string" ? ob.ob_filter_status : null,
      buy_trade_ready: ob.buy_trade_ready === true, sell_trade_ready: ob.sell_trade_ready === true,
      active_bull_ob: num(ob.active_bull_ob_count), active_bear_ob: num(ob.active_bear_ob_count)
    }, gmi ? { prophet_dir: GMI("prophet_dir"), gmi_dir: GMI("gmi_dir"), conflict: GMI("conflict"), gate: GMI("gate") } : {}),
    interstellar_eyes: hud({
      close: round(close, 3),
      camarilla: camarillaByTf,
      band: Object.fromEntries(Object.entries(camarillaByTf).map(([key, levels]) => [key, camarillaBand(close, levels)]))
    }),
    ...(gmi ? {
      kinetic_engine: hud({ theta: round(gd.s_theta), omega: round(gd.s_omega), alpha: round(gd.s_alpha), entropy: round(gd.entropy), is_chaos: gd.is_chaos === true }),
      fabio_amt: hud({ close: round(close, 3), poc: round(gd.poc, 3), vah: round(gd.vah, 3), val: round(gd.val, 3), footprint_status: typeof gd.fp_status === "string" ? gd.fp_status : null }),
      tactical_muscles: hud({ pct_rank: num(gd.pct_rank) }),
      gabfx_price_action: hud({ in_qm_buy: zones.inQmBuy === true, in_qm_sell: zones.inQmSell === true, in_rbs: zones.inRbs === true, in_sbr: zones.inSbr === true }),
      playbook_execution: hud({ htf_state: num(gd.htf_state), mtf_state: num(gd.mtf_state), ltf_state: num(gd.ltf_state), ext_state: num(gd.ext_state) }),
      decision_matrix: hud({ verdict: num(g.verdict), gate: num(g.gate), conflict: g.conflict === true, branch: typeof gd.branch === "string" ? gd.branch : null, is_chaos: gd.is_chaos === true }, { verdict: GMI("verdict"), gate: GMI("gate"), conflict: GMI("conflict") })
    } : {}),
    chronos_matrix: hud({
      session_new_york: inSession(ny, 8 * 60, 17 * 60), session_london: inSession(ny, 3 * 60, 12 * 60), session_tokyo: inSession(ny, 19 * 60, 4 * 60),
      daily_cpr: cpr(dailyPrev, close), weekly_cpr: cpr(weeklyPrev, close),
      ...(gmi ? { verdict: num(g.verdict) } : {})
    }, gmi ? { verdict: GMI("verdict") } : {}),
    aegis_footprint: hud({
      d_enc: num(st.d_enc),
      ...(gmi ? {
        footprint_status: typeof gd.fp_status === "string" ? gd.fp_status : null,
        in_bull_order_block: zones.in_ob_bull === true, in_bear_order_block: zones.in_ob_bear === true,
        in_bull_mitigation: zones.in_mitig_bull === true, in_bear_mitigation: zones.in_mitig_bear === true, volume_veto: zones.veto === true
      } : {})
    }, { d_enc: R38("d_enc") }),
    macro_aether: hud({
      weighted_global_z: round(htf.weighted_global_z), alignment_code: num(htf.alignment_code),
      z_by_timeframe: Object.fromEntries(Object.entries(htf.z_by_timeframe || {}).map(([k, v]) => [k, round(v)])),
      ...(gmi ? { global_hurst: round(gd.global_h) } : {}),
      // The other rows of the Pine HUD: consolidation gravity, Z3 spread, macro cycle and
      // shift (DXY/USDT 4h), asset gravity (WTI), Q-gravity and SMRI (macro-aether.mjs).
      ...macroAether(chartBars, bundle, chart, mintick)
    })
  };

  return {
    schema_version: HUD_SNAPSHOT_VERSION,
    symbol: CHART_TICKERID,
    timeframe: spec.period,
    candle_key: [CHART_TICKERID, spec.period, String(openMs)].join(":"),
    candle_time: new Date(openMs).toISOString(),
    computed_at: new Date(now).toISOString(),
    not_computed: ["grid_bot_protocol", ...(gmi ? [] : ["kinetic_engine", "fabio_amt", "tactical_muscles", "gabfx_price_action", "playbook_execution", "decision_matrix"])],
    gmi_error: gmiError,
    huds
  };
}
