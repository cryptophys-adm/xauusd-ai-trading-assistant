// Prophet R38 setup state of the latest closed bar (owner report 2026-11-09: the H1 HUD showed
// "BUY · READY" while the H1 decision stayed WAIT).
//
// prophet_r38.buy_confirmed / sell_confirmed are one-bar EVENTS: true only on the bar where the
// V2 gate passed. The Prophet HUD's entry instruction ("BUY · READY", "SELL · READY") is a STATE
// that outlives that bar: it stays while the setup is still inside its confirmation window, the
// gate has passed within this setup and the cycle alignment still points the same way. Only the
// events travel in the alert payloads, so the decision lane never saw the state and read every
// later bar as "no signal".
//
// This module reproduces that state from the same R38 core outputs the H1 producer uses, and
// local-publisher attaches it to the prophet record as values.setup. It lives OUTSIDE the hashed
// engine files on purpose: h1-producer.mjs and core.mjs are part of every parity identity, and a
// change there would make the approved engines re-earn their 24 matches. values.setup is not a
// comparable field (no alert carries it), so parity never compares it.
//
// Pine (The-Prophet-v7.02-R38, non-legacy):
//   decision_buy_setup_active = latest_is_buy and buy_window_active and inten == 3.0      (line 424)
//   last_buy_passed           = buy_pass_bar within the current setup                      (line 428)
//   "BUY · READY"             = decision_buy_setup_active and last_buy_passed and buy_macro_ok (line 675)
//   buy_macro_ok              = is_macro_bull (z_score > 0) and gmi_z_alignment_code == 1  (line 655)
// The GMI z-alignment is not reproduced locally: buy_ready here is Pine's READY before its macro
// check, and macro_z_bull / macro_z_bear carry the z-score half. The decision policy's GMI
// validator rules (conflict, gate, verdict) cover the GMI side.
import { calculateProphetR38Core } from "../../prophet-r38/src/core.mjs";

export const PROPHET_SETUP_VERSION = "cryptophys.prophet-setup.v1";
// Same slice as h1-producer.mjs (H1_WINDOW), so the core sees the same bars.
const H1_WINDOW = 1000;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const bars = (frame) => (Array.isArray(frame?.candles) ? frame.candles : []);

/** Bars since the last `<side>_confirmed` event, or null when the current setup has not passed. */
function passAge(outputs, i, side) {
  if (outputs[i]?.confirmation?.[`${side}_passed_current_setup`] !== true) return null;
  for (let j = i; j >= 0; j--) if (outputs[j]?.confirmation?.[`${side}_confirmed`] === true) return i - j;
  return null;
}

/**
 * The setup state of the last output of calculateProphetR38Core, or null without a confirmation
 * block. Pure: no I/O, no model.
 */
export function prophetSetupState(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return null;
  const i = outputs.length - 1;
  const o = outputs[i];
  const c = o?.confirmation;
  if (!c || typeof c !== "object") return null;
  const inten = finite(o.sensors?.cycle_intensity) ? o.sensors.cycle_intensity : null;
  const z = o.sensors?.kww_zscore_50;
  const buyWindow = c.buy_window_active === true, sellWindow = c.sell_window_active === true;
  const buySetupActive = buyWindow && inten === 3;
  const sellSetupActive = sellWindow && inten === -3;
  const buyPassed = c.buy_passed_current_setup === true;
  const sellPassed = c.sell_passed_current_setup === true;
  const buyReady = buySetupActive && buyPassed;
  const sellReady = sellSetupActive && sellPassed;
  const superseded = buyWindow && inten === -3 ? "BUY" : sellWindow && inten === 3 ? "SELL" : null;
  const gate = typeof c.gate_status === "string" ? c.gate_status : "NO_ACTIVE_SETUP";
  const instruction = buyReady ? "BUY_READY"
    : sellReady ? "SELL_READY"
      : superseded === "BUY" ? "BUY_SETUP_SUPERSEDED_BY_TREND"
        : superseded === "SELL" ? "SELL_SETUP_SUPERSEDED_BY_TREND"
          : buySetupActive || sellSetupActive ? gate
            : "NO_SETUP";
  return {
    version: PROPHET_SETUP_VERSION,
    confirmation_window: finite(c.confirmation_window) ? c.confirmation_window : null,
    cycle_intensity: inten,
    buy_setup_active: buySetupActive,
    sell_setup_active: sellSetupActive,
    buy_passed: buyPassed,
    sell_passed: sellPassed,
    buy_pass_age: passAge(outputs, i, "buy"),
    sell_pass_age: passAge(outputs, i, "sell"),
    buy_ready: buyReady,
    sell_ready: sellReady,
    superseded_by_trend: superseded,
    macro_z_bull: finite(z) ? z > 0 : null,
    macro_z_bear: finite(z) ? z < 0 : null,
    gate_status: gate,
    instruction,
    // The one-bar events of this bar, so a reader can check the state against the record.
    buy_confirmed: c.buy_confirmed === true,
    sell_confirmed: c.sell_confirmed === true,
    note: "Local lane only (no alert carries it). buy_ready / sell_ready is the Prophet HUD's READY before its macro check: the gate passed within the current setup's confirmation window and the cycle alignment still holds. The GMI z-alignment of Pine's buy_macro_ok is not reproduced; use the GMI validator fields."
  };
}

/**
 * The H1 setup state built exactly as the H1 producer builds its record: the last H1_WINDOW H1
 * bars, confirmed, with the native TradingView higher timeframes. Returns { candle_key, state }.
 */
export function h1ProphetSetup(bundle, { mintick = 0.001 } = {}) {
  const h1 = bars(bundle?.timeframes?.H1).slice(-H1_WINDOW);
  const last = h1.at(-1);
  if (!last) return { candle_key: null, state: null };
  const r38 = calculateProphetR38Core(h1.map((b) => ({ ...b, confirmed: true })), {
    timeframe_minutes: 60,
    gmi_closed_only: true,
    mintick,
    higher_timeframes: {
      M15: bars(bundle.timeframes.M15), H1: h1, H4: bars(bundle.timeframes.H4),
      D1: bars(bundle.timeframes.D1), W1: bars(bundle.timeframes.W1)
    }
  });
  return { candle_key: "OANDA:XAUUSD:60:" + Date.parse(last.open_time), state: prophetSetupState(r38.outputs) };
}

/**
 * Attaches values.setup to the prophet record of a built H1 candle when the state is for the same
 * candle and agrees with the record's one-bar events; otherwise leaves the record untouched and
 * says why. Never throws: a failure here must not block the engine publish.
 */
export function attachProphetSetup(built, bundle, { mintick = 0.001 } = {}) {
  const record = (built?.records || []).find((r) => r?.engine === "prophet");
  if (!record) return { status: "no_prophet_record" };
  let setup;
  try { setup = h1ProphetSetup(bundle, { mintick }); }
  catch (error) { return { status: "setup_failed", error: typeof error?.code === "string" ? error.code : String(error?.message || "").slice(0, 120) }; }
  if (!setup.state) return { status: "no_state" };
  if (setup.candle_key !== built.candle_key) return { status: "candle_mismatch" };
  const r38 = record.values?.comparable?.prophet_r38;
  if (r38 && (r38.buy_confirmed !== setup.state.buy_confirmed || r38.sell_confirmed !== setup.state.sell_confirmed)) return { status: "inconsistent_with_record" };
  record.values.setup = setup.state;
  return { status: "attached", instruction: setup.state.instruction };
}
