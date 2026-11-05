export const TRADE_PLAN_ACTIONS: readonly string[];
export const TRADE_PLAN_EXIT_REASONS: readonly string[];
export const TRADE_PLAN_ZONE_SIDES: readonly string[];
export const TRADE_PLAN_RULE: string;
export function validateTradePlan(raw: unknown, decision?: Record<string, unknown>): { plan: Record<string, unknown> | null; errors: string[] };
