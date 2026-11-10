export function warRoomEnabled(env: unknown): boolean;
export function runWarRoomBar(env: unknown, task: unknown, options?: { clock?: () => number }): Promise<Record<string, unknown>>;
export function readWarRoom(db: unknown, options?: { barTime?: string | null }): Promise<Record<string, any> | null>;
export function readTldr(db: unknown): Promise<Record<string, any>>;
export function agentName(id: string): string;
export const MISSED_ROOM_AFTER_MS: number;
export function runMissedWarRoom(env: any, options?: { now?: number; clock?: () => number }): Promise<Record<string, any>>;
