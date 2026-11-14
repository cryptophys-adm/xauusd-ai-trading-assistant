export const ALLOCATION_RULES: Readonly<Record<string, any>>;
export const ALLOCATION_STATE_KEY: string;
export const ROOM_TIMEFRAME: Readonly<Record<string, string>>;
export function allocationEnabled(env: unknown): boolean;
export function readAllocationState(env: unknown): Promise<{ rooms: Record<string, Record<string, any>> }>;
export function decideAllocation(input: Record<string, unknown>): { next: Record<string, any>; changes: Record<string, any>[] };
export function rosterSplit(roster: string[], roomState: unknown, options: { room: string; barTime: string; rules?: Record<string, any> }): { live: string[]; shadow: string[]; benched: string[] };
export function syncAgentAllocation(env: unknown, options?: { now?: number; cards?: unknown[]; send?: ((text: string) => Promise<unknown>) | null }): Promise<Record<string, any>>;
export function readAllocationEvents(db: unknown, options?: { limit?: number }): Promise<Record<string, any>[]>;
