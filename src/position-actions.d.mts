export const ACTION_TTL_MS: number;
export function ensurePositionSchema(db: unknown): Promise<void>;
export function resetPositionSchemaCacheForTests(): void;
export function pendingPositionActions(db: unknown, options?: { now?: number }): Promise<Array<Record<string, any>>>;
export function markPositionActions(db: unknown, ids: string[], status: string): Promise<void>;
export function actionIdOfIntent(intentId: unknown): string | null;
export function positionActionRows(db: unknown, ids: string[]): Promise<Record<string, Record<string, any>>>;
export function expireStalePositionActions(db: unknown, options?: { now?: number }): Promise<Array<Record<string, any>>>;
export function actionMessage(row: Record<string, any>, outcome?: { applied: boolean; reason?: string }): string;
