export const DECISION_TEXT_FIELDS: readonly string[];
export const DECISION_TEXT_RULE: string;
export function decisionTextErrors(decision: unknown): Record<string, string[]>;
export function plainDecisionText(env: unknown, decision: Record<string, unknown>, options?: { clock?: () => number }): Promise<{ decision: Record<string, unknown>; status: string; rewritten: string[] }>;
