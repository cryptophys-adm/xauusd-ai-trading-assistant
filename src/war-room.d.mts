export function warRoomEnabled(env: unknown): boolean;
export function runWarRoomBar(env: unknown, task: unknown, options?: { clock?: () => number }): Promise<Record<string, unknown>>;
export function readWarRoom(db: unknown, options?: { barTime?: string | null }): Promise<Record<string, any> | null>;
export function readTldr(db: unknown): Promise<Record<string, any>>;
