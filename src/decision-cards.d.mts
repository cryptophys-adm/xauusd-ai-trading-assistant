export const DECISION_CARD_VERSION: string;
export function loadDecisionCards(env: unknown, options?: { chart?: string; limit?: number }): Promise<Record<string, unknown>[]>;
