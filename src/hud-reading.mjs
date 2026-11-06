// Phase C3: deterministic plain-language readings of the Pine HUD snapshots
// (local-engines/producer/src/hud-snapshot.mjs). Follows src/webhook-interpretation.mjs:
// codes are decoded exactly as the Pine sources and local engines define them, every
// sentence is plain English, and nothing here is a trade signal.
//
// Each line carries one of three calibration tiers:
// - `verified`: every field it describes is a parity verified field of the snapshot (the
//   AI Worker sets `verified` per field after comparing it with the approved local record
//   of the same candle);
// - `derived` ("computed from verified bars"): the line is a pure formula of closed bars
//   (Camarilla levels and bands, central pivot ranges, trading sessions), and the AI Worker
//   confirmed this candle's own bar equals TradingView's in the parity input check
//   (`bars_verified`). Owner decision 2026-11-06: such lines count as calibrated evidence;
// - neither: an engine internal no TradingView comparator has checked ("not yet calibrated").
// Agents receive the lines, never the raw codes, so they interpret meaning instead of
// echoing identifiers.
import { TRADE_MANAGEMENT, GMI_VERDICTS, GMI_GATES, describeStructure } from "./webhook-interpretation.mjs";

export const HUD_READING_VERSION = "cryptophys.hud-reading.v2";

/** Display names, one per Pine HUD section (owner decision: agent name = HUD name). */
export const HUD_NAMES = Object.freeze({
  r37_funnel: "R37 Funnel",
  prophet: "Prophet",
  trade_management: "Trade Management",
  interstellar_eyes: "The Interstellar Eyes",
  kinetic_engine: "Kinetic Engine (TVA)",
  fabio_amt: "Fabio AMT Sensors",
  chronos_matrix: "Chronos Matrix",
  aegis_footprint: "Aegis Footprint Matrix",
  tactical_muscles: "Tactical Muscles",
  macro_aether: "Macro & Aether Sensors",
  gabfx_price_action: "GABFX Price Action",
  playbook_execution: "Playbook Execution",
  decision_matrix: "Decision Matrix",
  grid_bot_protocol: "Grid Bot Protocol"
});
export const HUD_IDS = Object.freeze(Object.keys(HUD_NAMES));

const R38_GATE = {
  NO_ACTIVE_SETUP: "no buy or sell setup is active",
  BUY_CONFIRMED: "the buy setup is confirmed",
  BUY_WAIT_PRICE: "a buy setup is waiting for price confirmation",
  BUY_WAIT_STRUCTURE: "a buy setup is waiting for structure confirmation",
  BUY_WAIT_VOLUME: "a buy setup is waiting for volume confirmation",
  BUY_WAIT: "a buy setup is waiting for its last confirmation",
  SELL_CONFIRMED: "the sell setup is confirmed",
  SELL_WAIT_PRICE: "a sell setup is waiting for price confirmation",
  SELL_WAIT_STRUCTURE: "a sell setup is waiting for structure confirmation",
  SELL_WAIT_VOLUME: "a sell setup is waiting for volume confirmation",
  SELL_WAIT: "a sell setup is waiting for its last confirmation"
};
const OB_FILTER = {
  "BULL OB PASS": "a qualified bullish order block supports a long",
  "BEAR OB PASS": "a qualified bearish order block supports a short",
  BLOCK_NO_ACTIVE_BULL_OB: "the cycles point up but no active bullish order block exists",
  BLOCK_NO_ACTIVE_BEAR_OB: "the cycles point down but no active bearish order block exists",
  BLOCK_NO_QUALIFIED_BULL_OB: "the cycles point up but no bullish order block is qualified",
  BLOCK_NO_QUALIFIED_BEAR_OB: "the cycles point down but no bearish order block is qualified",
  BLOCK_TREND_UNRESOLVED: "the cycles do not agree, so the order-block filter is blocked"
};
const FOOTPRINT = {
  "NO LTF DATA": "no one-minute intrabar data was available",
  "BULL SQUEEZE": "a bull squeeze: sellers were absorbed and price broke the previous high",
  "BEAR SQUEEZE": "a bear squeeze: buyers were absorbed and price broke the previous low",
  "BUY WALL LIMIT": "a buy wall: heavy absorbed selling on a small-bodied candle",
  "SELL WALL LIMIT": "a sell wall: heavy absorbed buying on a small-bodied candle",
  "BULL ABSORPTION": "bullish absorption: selling pressure was absorbed",
  "BEAR ABSORPTION": "bearish absorption: buying pressure was absorbed",
  "BULLISH CVD DIV": "a bullish cumulative-delta divergence",
  "BEARISH CVD DIV": "a bearish cumulative-delta divergence",
  "BUY CONTROL": "buyers in control of the recent order flow",
  "SELL CONTROL": "sellers in control of the recent order flow",
  NEUTRAL: "balanced order flow"
};
const GMI_BRANCH = {
  initial: "no decision branch fired beyond the base verdict",
  entropy_trap: "the entropy trap, which forces a neutral verdict",
  volume_veto: "the volume veto, which forces a neutral verdict inside a zone",
  gabfx_buy: "the GABFX price-action buy branch", gabfx_sell: "the GABFX price-action sell branch",
  fabio_m1_buy: "the Fabio first-model buy branch", fabio_m1_sell: "the Fabio first-model sell branch",
  fabio_m2_buy: "the Fabio second-model buy branch", fabio_m2_sell: "the Fabio second-model sell branch",
  jma_long: "the JMA long branch", jma_short: "the JMA short branch",
  kin_rev_long: "the kinetic reversal long branch", kin_rev_short: "the kinetic reversal short branch"
};
const BAND = {
  above_h6: "above the H6 extension", h5_h6: "between H5 and H6", h4_h5: "between H4 and H5 (breakout territory)",
  h3_h4: "between H3 and H4", l3_h3: "inside the H3 to L3 range", l4_l3: "between L4 and L3",
  l5_l4: "between L5 and L4 (breakdown territory)", l6_l5: "between L6 and L5", below_l6: "below the L6 extension"
};
const TF_NAMES = { "15": "15-minute", "60": "1-hour", "240": "4-hour", D: "daily", W: "weekly" };
const CPR_POSITION = { above_tc: "above the top of the central pivot range", below_bc: "below the bottom of the central pivot range", inside: "inside the central pivot range" };

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const dir = (v) => (v > 0 ? "bullish" : v < 0 ? "bearish" : "neutral");
const price = (v) => (isNum(v) ? v.toFixed(2) : null);
const fixed = (v, d = 2) => (isNum(v) ? v.toFixed(d) : null);

function cycle(v) {
  return v === 3 ? "all three Prophet cycles point up" : v === -3 ? "all three Prophet cycles point down" : "the three Prophet cycles do not agree";
}

/**
 * readHud(agentId, { fields, verified, bars_verified }) ->
 *   { agent_id, name, available, lines: [{ text, verified, derived }] }.
 * `verified` is the list of field names the AI Worker confirmed against the approved record;
 * `bars_verified` is true when the AI Worker confirmed this candle's bar against TradingView.
 */
export function readHud(agentId, hud = {}) {
  const f = hud?.fields && typeof hud.fields === "object" ? hud.fields : {};
  const ok = new Set(Array.isArray(hud?.verified) ? hud.verified : []);
  const barsOk = hud?.bars_verified === true;
  const lines = [];
  const add = (text, uses = []) => { if (text) lines.push({ text, verified: uses.length > 0 && uses.every((u) => ok.has(u)), derived: false }); };
  // A statement that is a pure formula of closed bars (no engine internal behind it).
  const addFromBars = (text) => { if (text) lines.push({ text, verified: false, derived: barsOk }); };

  switch (agentId) {
    case "r37_funnel": {
      const buy = f.buy_confirmed === true, sell = f.sell_confirmed === true;
      add(buy ? `The funnel confirmed a buy on this closed candle${f.buy_high_quality ? ", and it passed the high-quality filter" : ""}.`
        : sell ? `The funnel confirmed a sell on this closed candle${f.sell_high_quality ? ", and it passed the high-quality filter" : ""}.`
          : "The funnel confirmed neither a buy nor a sell on this closed candle.",
      buy ? ["buy_confirmed", "buy_high_quality"] : sell ? ["sell_confirmed", "sell_high_quality"] : ["buy_confirmed", "sell_confirmed"]);
      if (R38_GATE[f.gate_status]) add(`Its setup gate says ${R38_GATE[f.gate_status]}.`);
      const stages = [];
      if (f.buy_candidate || f.sell_candidate) stages.push(`a ${f.buy_candidate ? "buy" : "sell"} candidate cross printed`);
      for (const [key, name] of [["price_confirm", "price"], ["structure_confirm", "structure"], ["volume_pass", "volume"]]) {
        const b = f["buy_" + key] === true, s = f["sell_" + key] === true;
        if (b || s) stages.push(`the ${name} stage passes for ${b && s ? "both sides" : b ? "buys" : "sells"}`);
      }
      add(stages.length ? `Funnel stages: ${stages.join("; ")}.` : "No funnel stage is passing right now.");
      break;
    }
    case "prophet": {
      // Owner decision 2026-11-06: Prophet reads as one indicator. The R38 signal and the R37
      // consensus direction come from the same snapshot (hud-store passes them in) and are alert
      // fields, so each is verified by parity on its own.
      if (typeof f.buy_confirmed === "boolean" || typeof f.sell_confirmed === "boolean") {
        const buy = f.buy_confirmed === true, sell = f.sell_confirmed === true;
        add(buy ? `Prophet's signal: a confirmed BUY on this closed candle${f.buy_high_quality ? " that also passed the high-quality filter" : ""}.`
          : sell ? `Prophet's signal: a confirmed SELL on this closed candle${f.sell_high_quality ? " that also passed the high-quality filter" : ""}.`
            : "Prophet's signal: no buy or sell confirmation on this closed candle.",
        buy ? ["buy_confirmed"] : sell ? ["sell_confirmed"] : ["buy_confirmed", "sell_confirmed"]);
      }
      if (isNum(f.prophet_dir)) {
        add(f.prophet_dir ? `Prophet's direction is ${dir(f.prophet_dir)}, with momentum and structure in agreement.` : "Prophet has no clear direction: its momentum and structure do not agree, or both are flat.", ["prophet_dir"]);
      }
      const structure = describeStructure(f.d_enc, f.structure_subtype);
      add(`Prophet's structure shows ${structure.text}.`, ["d_enc", "structure_subtype"]);
      if (TRADE_MANAGEMENT[f.t_enc]) add(`Its momentum and trade-management state is ${TRADE_MANAGEMENT[f.t_enc]}.`, ["t_enc"]);
      // Prophet audit (2026-11-06): the Prophet HUD on TradingView shows a state, not only WAIT.
      // With the setup gate of the same snapshot, Prophet reads its bias and setup in one line.
      // The direction above (R37 consensus) is Prophet's bias; this line is its setup and cycles,
      // worded so the two never read as conflicting biases.
      if (R38_GATE[f.gate_status]) {
        const risk = f.t_enc === 4 ? "; a risk veto calls for reducing risk" : f.t_enc === 3 ? "; a reversal is being watched" : "";
        add(`Prophet's setup: ${R38_GATE[f.gate_status]}, and ${cycle(f.cycle_intensity)}${risk}.`);
      } else add(`On the cycle read, ${cycle(f.cycle_intensity)}.`);
      const parts = [];
      if (isNum(f.kww_zscore)) parts.push(`the price z-score is ${fixed(f.kww_zscore)}`);
      if (isNum(f.hurst)) parts.push(`the Hurst exponent is ${fixed(f.hurst)} (${f.hurst > 0.6 ? "a strong trend" : f.hurst < 0.45 ? "mean reverting" : "a weak trend"})`);
      if (isNum(f.efficiency_ratio)) parts.push(`the efficiency ratio is ${fixed(f.efficiency_ratio)} (${f.efficiency_ratio > 0.5 ? "efficient, directional movement" : "noisy movement"})`);
      if (isNum(f.volume_ratio)) parts.push(`volume runs at ${fixed(f.volume_ratio)} times its 20-bar average`);
      if (parts.length) add(`Regime sensors: ${parts.join("; ")}.`);
      if (isNum(f.oscillator_fast) && isNum(f.oscillator_slow)) add(`The fast oscillator is ${fixed(f.oscillator_fast)} against the slow ${fixed(f.oscillator_slow)}, so momentum is ${f.oscillator_fast > f.oscillator_slow ? "rising" : "falling"}.`);
      break;
    }
    case "trade_management": {
      if (isNum(f.prophet_dir) || isNum(f.gmi_dir)) {
        add(`Prophet reads ${dir(f.prophet_dir)} and GMI reads ${dir(f.gmi_dir)}${f.conflict ? ", and they are in conflict" : ""}.`, ["prophet_dir", "gmi_dir", "conflict"]);
      }
      if (GMI_GATES[f.gate] !== undefined) add(`The shared gate reports that ${GMI_GATES[f.gate]}.`, ["gate"]);
      add(`For trade management, ${cycle(f.cycle_intensity)}${isNum(f.kww_zscore) ? ` and the price z-score is ${fixed(f.kww_zscore)}` : ""}.`);
      if (OB_FILTER[f.ob_filter_status]) add(`The order-block filter says ${OB_FILTER[f.ob_filter_status]}.`);
      if (isNum(f.active_bull_ob) && isNum(f.active_bear_ob)) add(`There are ${f.active_bull_ob} active bullish and ${f.active_bear_ob} active bearish order blocks.`);
      add(f.buy_trade_ready ? "A long setup is trade-ready on the order-block rules." : f.sell_trade_ready ? "A short setup is trade-ready on the order-block rules." : "No setup is trade-ready on the order-block rules.");
      break;
    }
    case "interstellar_eyes": {
      const bands = f.band && typeof f.band === "object" ? f.band : {};
      for (const [tf, band] of Object.entries(bands)) {
        const levels = f.camarilla?.[tf];
        if (!BAND[band] || !levels) continue;
        addFromBars(`On the ${TF_NAMES[tf] ?? tf} Camarilla levels, price ${price(f.close)} is ${BAND[band]} (H4 ${price(levels.h4)}, H3 ${price(levels.h3)}, L3 ${price(levels.l3)}, L4 ${price(levels.l4)}).`);
      }
      break;
    }
    case "kinetic_engine": {
      if (isNum(f.theta)) add(`The adaptive channel angle is ${fixed(f.theta)} degrees, with angular velocity ${fixed(f.omega)} and acceleration ${fixed(f.alpha)}.`);
      if (isNum(f.omega) && isNum(f.theta)) add(Math.sign(f.omega) === Math.sign(f.theta) || f.omega === 0 ? "The trend angle is still building in its own direction." : "The trend angle is turning against its own direction, an early reversal sign.");
      if (isNum(f.entropy)) add(`Market entropy is ${fixed(f.entropy)}, so the regime is ${f.is_chaos ? "chaotic" : f.entropy >= 0.8 ? "close to chaos" : "orderly"}.`);
      break;
    }
    case "fabio_amt": {
      if (isNum(f.vah) && isNum(f.val)) {
        const where = isNum(f.close) ? (f.close > f.vah ? "above the value area (bullish imbalance)" : f.close < f.val ? "below the value area (bearish imbalance)" : "inside the value area (balance)") : null;
        add(`The value area runs from ${price(f.val)} to ${price(f.vah)} with the point of control at ${price(f.poc)}${where ? `; price is ${where}` : ""}.`);
      }
      if (FOOTPRINT[f.footprint_status]) add(`The footprint shows ${FOOTPRINT[f.footprint_status]}.`);
      break;
    }
    case "chronos_matrix": {
      const sessions = [f.session_tokyo && "Tokyo", f.session_london && "London", f.session_new_york && "New York"].filter(Boolean);
      addFromBars(sessions.length ? `Active sessions on this candle: ${sessions.join(" and ")}.` : "No major session is active on this candle.");
      for (const [key, name] of [["daily_cpr", "daily"], ["weekly_cpr", "weekly"]]) {
        const c = f[key];
        if (c && CPR_POSITION[c.position]) addFromBars(`Price is ${CPR_POSITION[c.position]} of the ${name} pivot (pivot ${price(c.pivot)}, range ${price(c.bc)} to ${price(c.tc)}).`);
      }
      if (GMI_VERDICTS[f.verdict] !== undefined) add(`The GMI verdict for this candle is ${GMI_VERDICTS[f.verdict]}.`, ["verdict"]);
      break;
    }
    case "aegis_footprint": {
      const structure = describeStructure(f.d_enc, null);
      add(`The price-action structure shows ${structure.text}.`, ["d_enc"]);
      if (FOOTPRINT[f.footprint_status]) add(`The footprint matrix shows ${FOOTPRINT[f.footprint_status]}.`);
      const zones = [f.in_bull_order_block && "a bullish order block", f.in_bear_order_block && "a bearish order block", f.in_bull_mitigation && "a bullish mitigation zone", f.in_bear_mitigation && "a bearish mitigation zone"].filter(Boolean);
      if ("in_bull_order_block" in f) add(zones.length ? `Price is inside ${zones.join(" and ")}.` : "Price is not inside any validated order block or mitigation zone.");
      if (f.volume_veto) add("Volume is dead, so the volume veto is active.");
      break;
    }
    case "tactical_muscles": {
      if (isNum(f.pct_rank)) add(`The JMA momentum percentile rank is ${f.pct_rank}, ${f.pct_rank >= 90 ? "an overbought extreme" : f.pct_rank <= 10 ? "an oversold extreme" : "away from the extremes"}.`);
      break;
    }
    case "macro_aether": {
      if (isNum(f.weighted_global_z)) {
        const align = { 1: "aligned bullish", "-1": "aligned bearish", 2: "in conflict with the chart", 0: "neutral" }[f.alignment_code] ?? "not resolved";
        add(`The multi-timeframe z-score is ${fixed(f.weighted_global_z)}, so the higher timeframes are ${align}.`);
      }
      const z = f.z_by_timeframe && typeof f.z_by_timeframe === "object" ? Object.entries(f.z_by_timeframe).filter(([, v]) => isNum(v)) : [];
      if (z.length) add(`Per timeframe the z-scores are ${z.map(([k, v]) => `${{ M15: "15-minute", H1: "1-hour", H4: "4-hour", D1: "daily", W1: "weekly" }[k] ?? k} ${fixed(v)}`).join(", ")}.`);
      if (isNum(f.global_hurst)) add(`The weighted global Hurst exponent is ${fixed(f.global_hurst)}, ${f.global_hurst > 0.5 ? "a persistent, trending macro regime" : "an anti-persistent macro regime"}.`);
      if (f.macro_cycle) add(`The macro cycle from the dollar index and USDT dominance is ${f.macro_cycle === "risk_on" ? "risk on, both falling, which is safe for gold" : "risk off: the dollar or USDT dominance is rising, a headwind for gold"}.`);
      if (f.macro_shift) {
        const shift = { reversal_due: isNum(f.macro_shift_bars_4h) ? `a macro reversal is projected in about ${f.macro_shift_bars_4h} four-hour bars` : "a macro reversal is projected", stagnant: "the macro kinematics are stagnant", accelerating_dollar_up: "the dollar and USDT side is accelerating up, against gold", accelerating_dollar_down: "the dollar and USDT side is accelerating down, in favour of gold", neutral: "the macro kinematics are neutral" }[f.macro_shift];
        if (shift) add(`On the macro shift, ${shift}.`);
      }
      if (f.asset_gravity && isNum(f.oil_rsi)) add(`WTI oil has an RSI of ${fixed(f.oil_rsi, 1)} on this timeframe, so the asset gravity reads ${{ bias_price_down: "a bias for gold to fall", bias_price_up: "a bias for gold to rise", neutral: "neutral" }[f.asset_gravity]}.`);
      if (f.consolidation_gravity && isNum(f.consolidation_gravity_pct)) add(`The volume profile pulls ${{ bullish_pull: "upward", bearish_pull: "downward", balanced: "evenly" }[f.consolidation_gravity]} (${f.consolidation_gravity_pct > 0 ? "+" : ""}${fixed(f.consolidation_gravity_pct, 1)}%).`);
      if (isNum(f.kinetic_spread)) add(`The kinetic band is ${fixed(f.kinetic_spread, 2)} wide${isNum(f.kinetic_spread_pct) ? `, ${fixed(f.kinetic_spread_pct, 2)}% of price` : ""}.`);
      if (f.q_gravity) add(`Unfilled fair value gaps pull ${{ pull_up: "price up", pull_down: "price down", balanced: "both ways evenly" }[f.q_gravity]}${isNum(f.q_gravity_pct) ? ` (${fixed(f.q_gravity_pct, 1)}%)` : ""}.`);
      if (f.smr_phase && isNum(f.smri)) add(`The smart-money reservoir index is ${fixed(f.smri, 1)}%, ${{ mark_up: "a mark-up phase", mark_down: "a mark-down phase", equilibrium: "equilibrium" }[f.smr_phase]}.`);
      break;
    }
    case "gabfx_price_action": {
      const zones = [f.in_qm_buy && "a quasimodo buy level", f.in_qm_sell && "a quasimodo sell level", f.in_rbs && "a resistance-turned-support level", f.in_sbr && "a support-turned-resistance level"].filter(Boolean);
      add(zones.length ? `Price is within one ATR of ${zones.join(" and ")}.` : "Price is not near any active quasimodo or flip level.");
      break;
    }
    case "playbook_execution": {
      const htf = { 1: "bullish", "-1": "bearish", 0: "neutral because entropy is high" }[f.htf_state];
      const mtf = { 1: "a bullish structure", "-1": "a bearish structure", 0: "no structure signal" }[f.mtf_state];
      const ltf = { 2: "a strong bullish order-flow signal", "-2": "a strong bearish order-flow signal", 1: "bullish order flow with rising momentum", "-1": "bearish order flow with falling momentum", 0: "no order-flow signal" }[f.ltf_state];
      const ext = { 1: "momentum is decelerating", 2: "Prophet's fast oscillator is overextended", 0: "no extension" }[f.ext_state];
      if (htf || mtf || ltf) add(`Playbook layers: the higher timeframe is ${htf ?? "not reported"}, the middle layer shows ${mtf ?? "nothing"}, and the lower layer shows ${ltf ?? "nothing"}.`);
      if (ext) add(`Extension check: ${ext}.`);
      break;
    }
    case "decision_matrix": {
      if (GMI_VERDICTS[f.verdict] !== undefined) add(`The action verdict is ${GMI_VERDICTS[f.verdict]}${f.conflict ? ", neutralised by a conflict" : ""}.`, ["verdict", "conflict"]);
      if (GMI_GATES[f.gate] !== undefined) add(`The execution gate reports that ${GMI_GATES[f.gate]}.`, ["gate"]);
      if (GMI_BRANCH[f.branch]) add(`The verdict came from ${GMI_BRANCH[f.branch]}.`);
      add(f.is_chaos ? "The system guard reports chaos." : "The system guard reports an orderly market.");
      break;
    }
    default:
      break;
  }
  return { agent_id: agentId, name: HUD_NAMES[agentId] ?? agentId, version: HUD_READING_VERSION, available: lines.length > 0, lines };
}

/** Calibration counts of one reading: { verified_lines, derived_lines, total_lines }. */
export function calibrationCounts(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return {
    verified_lines: list.filter((l) => l?.verified).length,
    derived_lines: list.filter((l) => !l?.verified && l?.derived).length,
    total_lines: list.length
  };
}

/** Calibrated statements: verified by parity or computed from verified bars. */
export const calibratedLines = (c) => (Number(c?.verified_lines) || 0) + (Number(c?.derived_lines) || 0);

/** One plain sentence for a calibration count, or `none` when nothing is calibrated. */
export function calibrationNote(c, none = "not yet calibrated") {
  const v = Number(c?.verified_lines) || 0, d = Number(c?.derived_lines) || 0, t = c?.total_lines;
  if (!v && !d) return none;
  const parts = [];
  if (v) parts.push(`${v} verified by parity`);
  if (d) parts.push(`${d} computed from verified bars`);
  return `${parts.join(", ")} (of ${t} statement${t === 1 ? "" : "s"})`;
}

/** Verified field names of one HUD: parity fields equal to the approved local record. */
export function verifiedFields(hud, approvedComparable) {
  const out = [];
  if (!hud?.parity || !approvedComparable) return out;
  for (const [field, path] of Object.entries(hud.parity)) {
    const [source, key] = String(path).split(".");
    const approved = approvedComparable?.[source];
    if (approved && key in approved && approved[key] === hud.fields?.[field]) out.push(field);
  }
  return out;
}
