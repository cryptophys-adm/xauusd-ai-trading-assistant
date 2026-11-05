// H1 decision `trade_plan` (RFC_HUD_AGENTS §7): the rows the HUDs cannot recompute
// locally (action, entry, invalidation, take profit, exit reason, progressive stop,
// zone) are produced by the Reasoner and validated here like the decision prices.
// Advisory only. An invalid plan is dropped (null) with its errors recorded; it never
// changes the decision itself.

export const TRADE_PLAN_ACTIONS = Object.freeze(["ENTER_LIMIT", "ENTER_MARKET", "HOLD", "REDUCE", "EXIT"]);
export const TRADE_PLAN_EXIT_REASONS = Object.freeze(["NONE", "TARGET", "INVALIDATION", "OPPOSITE_SIGNAL", "RISK_STATE"]);
export const TRADE_PLAN_ZONE_SIDES = Object.freeze(["DEMAND", "SUPPLY"]);

export const TRADE_PLAN_RULE =
  "Also return trade_plan. For WAIT or NO_TRADE it is null. For BUY or SELL it is an object with: " +
  `action (one of ${TRADE_PLAN_ACTIONS.join(", ")}), entry, invalidation and take_profit (numbers equal to entry_price, stop_loss and take_profit), ` +
  `exit_reason (one of ${TRADE_PLAN_EXIT_REASONS.join(", ")}), progressive_stop (number or null) and zone (null or {low, high, side: DEMAND or SUPPLY}). ` +
  "Use only price levels present in the evidence. Advisory only, never an order.";

const PRICE_TOLERANCE = 0.01;

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function same(a, b) {
  return Math.abs(a - b) <= PRICE_TOLERANCE;
}

/**
 * Validate a Reasoner trade_plan against the already validated decision.
 * decision: { decision, entry_price, stop_loss, take_profit }.
 * Returns { plan, errors }: plan is the normalized object or null.
 */
export function validateTradePlan(raw, decision = {}) {
  const side = String(decision?.decision || "").toUpperCase();
  const directional = side === "BUY" || side === "SELL";
  if (raw == null) return { plan: null, errors: [] };
  if (!directional) return { plan: null, errors: ["trade_plan_without_direction"] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { plan: null, errors: ["trade_plan_not_object"] };

  const errors = [];
  const action = String(raw.action ?? "").toUpperCase();
  if (!TRADE_PLAN_ACTIONS.includes(action)) errors.push("trade_plan_action_invalid");
  const exitReason = String(raw.exit_reason ?? "NONE").toUpperCase();
  if (!TRADE_PLAN_EXIT_REASONS.includes(exitReason)) errors.push("trade_plan_exit_reason_invalid");

  const entry = raw.entry, invalidation = raw.invalidation, takeProfit = raw.take_profit;
  if (![entry, invalidation, takeProfit].every(positive)) errors.push("trade_plan_prices_invalid");
  else {
    const ordered = side === "BUY" ? invalidation < entry && entry < takeProfit : takeProfit < entry && entry < invalidation;
    if (!ordered) errors.push("trade_plan_prices_out_of_order");
    // One set of levels: the plan must match the decision's validated prices.
    if (positive(decision.entry_price) && !same(entry, decision.entry_price)) errors.push("trade_plan_entry_mismatch");
    if (positive(decision.stop_loss) && !same(invalidation, decision.stop_loss)) errors.push("trade_plan_invalidation_mismatch");
    if (positive(decision.take_profit) && !same(takeProfit, decision.take_profit)) errors.push("trade_plan_take_profit_mismatch");
  }

  let progressiveStop = null;
  if (raw.progressive_stop != null) {
    if (!positive(raw.progressive_stop)) errors.push("trade_plan_progressive_stop_invalid");
    else if (positive(invalidation) && positive(takeProfit)) {
      const inRange = side === "BUY"
        ? raw.progressive_stop >= invalidation && raw.progressive_stop < takeProfit
        : raw.progressive_stop <= invalidation && raw.progressive_stop > takeProfit;
      if (!inRange) errors.push("trade_plan_progressive_stop_out_of_range");
      else progressiveStop = raw.progressive_stop;
    }
  }

  let zone = null;
  if (raw.zone != null) {
    const z = raw.zone;
    const zoneSide = String(z?.side ?? "").toUpperCase();
    if (!z || typeof z !== "object" || !positive(z.low) || !positive(z.high) || z.low > z.high || !TRADE_PLAN_ZONE_SIDES.includes(zoneSide)) {
      errors.push("trade_plan_zone_invalid");
    } else {
      zone = { low: z.low, high: z.high, side: zoneSide };
    }
  }

  if (errors.length) return { plan: null, errors };
  return {
    plan: { action, entry, invalidation, take_profit: takeProfit, exit_reason: exitReason, progressive_stop: progressiveStop, zone },
    errors: []
  };
}
