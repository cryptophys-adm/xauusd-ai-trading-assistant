import test from "node:test";
import assert from "node:assert/strict";
import { validateTradePlan, TRADE_PLAN_RULE } from "../src/trade-plan.mjs";
import { naturalLanguageErrors } from "../src/natural-language.mjs";

const BUY = { decision: "BUY", entry_price: 4060, stop_loss: 4050, take_profit: 4080 };
const SELL = { decision: "SELL", entry_price: 4060, stop_loss: 4070, take_profit: 4040 };
const buyPlan = (extra = {}) => ({ action: "ENTER_LIMIT", entry: 4060, invalidation: 4050, take_profit: 4080, exit_reason: "NONE", progressive_stop: null, zone: { low: 4055, high: 4061, side: "DEMAND" }, ...extra });

test("a valid BUY plan is normalized", () => {
  const r = validateTradePlan(buyPlan({ action: "enter_limit", progressive_stop: 4058 }), BUY);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.plan, { action: "ENTER_LIMIT", entry: 4060, invalidation: 4050, take_profit: 4080, exit_reason: "NONE", progressive_stop: 4058, zone: { low: 4055, high: 4061, side: "DEMAND" } });
});

test("a valid SELL plan with mirrored levels", () => {
  const r = validateTradePlan({ action: "ENTER_MARKET", entry: 4060, invalidation: 4070, take_profit: 4040, exit_reason: "NONE", progressive_stop: 4065, zone: null }, SELL);
  assert.deepEqual(r.errors, []);
  assert.equal(r.plan.progressive_stop, 4065);
});

test("WAIT/NO_TRADE never carry a plan", () => {
  assert.deepEqual(validateTradePlan(null, { decision: "WAIT" }), { plan: null, errors: [] });
  const r = validateTradePlan(buyPlan(), { decision: "WAIT" });
  assert.equal(r.plan, null);
  assert.deepEqual(r.errors, ["trade_plan_without_direction"]);
});

test("invalid plans are dropped with their reasons", () => {
  const cases = [
    [buyPlan({ action: "YOLO" }), "trade_plan_action_invalid"],
    [buyPlan({ exit_reason: "BORED" }), "trade_plan_exit_reason_invalid"],
    [buyPlan({ entry: "4060" }), "trade_plan_prices_invalid"],
    [buyPlan({ invalidation: 4065 }), "trade_plan_prices_out_of_order"],
    [buyPlan({ entry: 4061 }), "trade_plan_entry_mismatch"],
    [buyPlan({ progressive_stop: 4045 }), "trade_plan_progressive_stop_out_of_range"],
    [buyPlan({ zone: { low: 4062, high: 4055, side: "DEMAND" } }), "trade_plan_zone_invalid"],
    [buyPlan({ zone: { low: 4055, high: 4061, side: "SIDEWAYS" } }), "trade_plan_zone_invalid"],
    ["ENTER", "trade_plan_not_object"]
  ];
  for (const [raw, error] of cases) {
    const r = validateTradePlan(raw, BUY);
    assert.equal(r.plan, null, error);
    assert.ok(r.errors.includes(error), `${error}: ${r.errors.join(",")}`);
  }
});

test("unknown keys (for example grid levels) are not carried", () => {
  const r = validateTradePlan(buyPlan({ grid: { bot: 1, top: 2 }, size: 5 }), BUY);
  assert.deepEqual(Object.keys(r.plan).sort(), ["action", "entry", "exit_reason", "invalidation", "progressive_stop", "take_profit", "zone"]);
});

test("the prompt rule itself is plain enough to sit in the Reasoner prompt", () => {
  assert.match(TRADE_PLAN_RULE, /For WAIT or NO_TRADE it is null/);
  assert.ok(Array.isArray(naturalLanguageErrors(TRADE_PLAN_RULE)));
});
