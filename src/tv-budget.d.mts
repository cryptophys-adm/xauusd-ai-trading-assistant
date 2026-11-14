export const TV_BUDGET_SCHEMA_SQL: string;
export function resetTvBudgetSchemaForTests(): void;
export function reserveTvCalls(db: unknown, input: { day: string; wanted: number; daily: number; now?: number }): Promise<{ allowed: number; used: number; daily: number }>;
export function releaseTvCalls(db: unknown, input: { day: string; count: number; now?: number }): Promise<{ used: number | null }>;
export function readTvBudget(db: unknown, day: string): Promise<Record<string, any> | null>;
