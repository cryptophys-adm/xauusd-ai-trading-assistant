export const ACTION_TTL_MS: number;
export function ensurePositionSchema(db: unknown): Promise<void>;
export function resetPositionSchemaCacheForTests(): void;
export function pendingPositionActions(db: unknown, options?: { now?: number }): Promise<Array<Record<string, any>>>;
export function markPositionActions(db: unknown, ids: string[], status: string): Promise<void>;
