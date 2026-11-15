export const MAX_DAY_THREADS: number;
export function warRoomThreadIds(sinceIso: string, untilMs?: number): string[] | null;
export function warRoomThreadFilter(sinceIso: string, untilMs?: number, alias?: string): { sql: string; binds: string[] };
export function barTimeFloor(iso: string): string;
