export const LADDER: readonly string[];
export const RISK_PROFILE_SCHEMA: string;
export function decideProfile(row: Record<string, any>, ctx: Record<string, any>): Record<string, any>;
export function runProfileAgent(db: unknown, row: Record<string, any>, options?: Record<string, any>): Promise<Record<string, any>>;
export function ownerSetProfile(db: unknown, input?: Record<string, any>): Promise<Record<string, any>>;
export function profileReport(rows: Record<string, any>[]): Record<string, any>;
export function relayProfileChanges(env: unknown, options?: { now?: number; publish?: unknown }): Promise<Record<string, any>>;
