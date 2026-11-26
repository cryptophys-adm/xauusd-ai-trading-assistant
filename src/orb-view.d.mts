export const ORB_VIEW_SCHEMA: string;
export const RECENT_SESSIONS: number;
export const VIEW_BARS: number;
export function nextRange(now: number): { session: string; open_ms: number } | null;
export function sessionCard(range: Record<string, any>, options?: { bars?: unknown[]; at?: number; atrH1?: number | null; events?: unknown[]; zones?: unknown[]; record?: unknown }): Record<string, any>;
export function readOrbView(env: unknown, options?: { now?: number; strategy?: unknown }): Promise<Record<string, any>>;
