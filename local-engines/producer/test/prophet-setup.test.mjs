import test from "node:test";
import assert from "node:assert/strict";
import { prophetSetupState, h1ProphetSetup, attachProphetSetup, PROPHET_SETUP_VERSION } from "../src/prophet-setup.mjs";
import { buildH1LocalCalculations } from "../src/h1-producer.mjs";
import { validateLocalCalculation, containsCredentialFields } from "../../../src/evidence-fusion.mjs";
import { identityOf } from "../../../src/parity-registry.mjs";

// A bar of R38 core output with only the fields the setup state reads.
const out = (confirmation, inten = 3, z = 0.4) => ({ confirmation: { confirmation_window: 3, gate_status: "NO_ACTIVE_SETUP", ...confirmation }, sensors: { cycle_intensity: inten, kww_zscore_50: z } });
const none = { buy_window_active: false, sell_window_active: false, buy_passed_current_setup: false, sell_passed_current_setup: false, buy_confirmed: false, sell_confirmed: false };

test("READY outlives the one-bar event: the state follows Pine's decision_buy_setup_active and last_buy_passed", () => {
  const event = out({ ...none, buy_window_active: true, buy_passed_current_setup: true, buy_confirmed: true, gate_status: "BUY_CONFIRMED" });
  const later = out({ ...none, buy_window_active: true, buy_passed_current_setup: true, gate_status: "BUY_CONFIRMED" });
  const onEvent = prophetSetupState([out(none), event]);
  assert.equal(onEvent.version, PROPHET_SETUP_VERSION);
  assert.deepEqual([onEvent.buy_ready, onEvent.buy_pass_age, onEvent.buy_confirmed, onEvent.instruction], [true, 0, true, "BUY_READY"]);
  const twoLater = prophetSetupState([out(none), event, later, later]);
  assert.deepEqual([twoLater.buy_ready, twoLater.buy_pass_age, twoLater.buy_confirmed, twoLater.confirmation_window], [true, 2, false, 3], "two bars after the event the setup is still READY");
  assert.equal(twoLater.macro_z_bull, true);
  assert.equal(twoLater.sell_ready, false);
  assert.equal(twoLater.sell_pass_age, null);
});

test("no READY without the cycle alignment, outside the window, or before the gate passes", () => {
  const passed = { ...none, buy_window_active: true, buy_passed_current_setup: true, gate_status: "BUY_CONFIRMED" };
  const event = out({ ...passed, buy_confirmed: true });
  const mixed = prophetSetupState([event, out(passed, 1)]);
  assert.deepEqual([mixed.buy_ready, mixed.buy_setup_active, mixed.buy_passed, mixed.buy_pass_age, mixed.instruction], [false, false, true, 1, "NO_SETUP"], "inten 1: the setup is not active");
  const superseded = prophetSetupState([event, out(passed, -3)]);
  assert.deepEqual([superseded.buy_ready, superseded.superseded_by_trend, superseded.instruction], [false, "BUY", "BUY_SETUP_SUPERSEDED_BY_TREND"]);
  const expired = prophetSetupState([event, out({ ...none, gate_status: "NO_ACTIVE_SETUP" })]);
  assert.deepEqual([expired.buy_ready, expired.buy_pass_age, expired.instruction], [false, null, "NO_SETUP"], "window over: no setup");
  const waiting = prophetSetupState([out({ ...none, buy_window_active: true, gate_status: "BUY_WAIT_PRICE" })]);
  assert.deepEqual([waiting.buy_ready, waiting.buy_setup_active, waiting.buy_passed, waiting.instruction], [false, true, false, "BUY_WAIT_PRICE"], "active but not passed: the gate reading");
  const sell = prophetSetupState([out({ ...none, sell_window_active: true, sell_passed_current_setup: true, sell_confirmed: true, gate_status: "SELL_CONFIRMED" }, -3, -0.8)]);
  assert.deepEqual([sell.sell_ready, sell.sell_pass_age, sell.macro_z_bear, sell.instruction], [true, 0, true, "SELL_READY"]);
  assert.equal(prophetSetupState([]), null);
  assert.equal(prophetSetupState([{ sensors: {} }]), null);
});

const HOUR = 3600_000;
function series(count, minutes, endOpenMs) {
  const step = minutes * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const openMs = endOpenMs - (count - 1 - i) * step;
    const open = 3900 + Math.sin(i / 9) * 15 + i * 0.02;
    const close = open + Math.sin(i / 3) * 3;
    return {
      time: openMs / 1000, open_time: new Date(openMs).toISOString(), close_time: new Date(openMs + step).toISOString(),
      open, high: Math.max(open, close) + 1.5, low: Math.min(open, close) - 1.2, close, volume: 1000 + (i % 17) * 40
    };
  });
}
const now = Date.parse("2026-11-03T10:03:00Z");
const lastH1Open = Date.parse("2026-11-03T09:00:00Z");
function bundle() {
  return {
    timeframes: {
      H1: { candles: series(1000, 60, lastH1Open) },
      M15: { candles: series(2000, 15, lastH1Open + 45 * 60_000) },
      H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) },
      D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) },
      W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
    }
  };
}

test("attached to the H1 prophet record: same candle, same events, valid contract, identity unchanged", () => {
  const built = buildH1LocalCalculations(bundle(), { now });
  const prophet = built.records.find((r) => r.engine === "prophet");
  const identityBefore = identityOf(prophet);
  const result = attachProphetSetup(built, bundle(), {});
  assert.equal(result.status, "attached", JSON.stringify(result));
  const setup = prophet.values.setup;
  assert.equal(setup.version, PROPHET_SETUP_VERSION);
  assert.equal(setup.confirmation_window, 3, "1H window: 3 closed bars");
  assert.equal(setup.buy_confirmed, prophet.values.comparable.prophet_r38.buy_confirmed);
  assert.equal(setup.sell_confirmed, prophet.values.comparable.prophet_r38.sell_confirmed);
  assert.equal(typeof setup.buy_ready, "boolean");
  assert.deepEqual(identityOf(prophet), identityBefore, "values.setup is not part of the parity identity");
  assert.deepEqual(prophet.values.comparable, buildH1LocalCalculations(bundle(), { now }).records[1].values.comparable, "the comparable fields are untouched");
  assert.equal(validateLocalCalculation(prophet, { candle_key: prophet.candle_key }, now).valid, true);
  assert.equal(containsCredentialFields(prophet), false);
  assert.equal(built.records.find((r) => r.engine === "gmi").values.setup, undefined);
  assert.equal(h1ProphetSetup(bundle()).candle_key, built.candle_key);
});

test("a state for another candle, or one that disagrees with the record, is not attached", () => {
  const built = buildH1LocalCalculations(bundle(), { now });
  const other = bundle();
  other.timeframes.H1.candles.pop();
  assert.equal(attachProphetSetup(built, other, {}).status, "candle_mismatch");
  const prophet = built.records.find((r) => r.engine === "prophet");
  prophet.values.comparable.prophet_r38.buy_confirmed = !prophet.values.comparable.prophet_r38.buy_confirmed;
  assert.equal(attachProphetSetup(built, bundle(), {}).status, "inconsistent_with_record");
  assert.equal(prophet.values.setup, undefined);
  assert.equal(attachProphetSetup({ records: [] }, bundle(), {}).status, "no_prophet_record");
  assert.equal(attachProphetSetup({ records: [{ engine: "prophet", values: {} }], candle_key: "x" }, { timeframes: { H1: { candles: [] } } }, {}).status, "no_state");
});
