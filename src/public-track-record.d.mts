export const TRACK_RECORD_VERSION: string;
export const SCENARIOS: ReadonlyArray<{ id: string; label: string }>;
export function publicManagedSource(env: any): "v3" | "v4";
export function summarise(rs: number[]): Record<string, number | null>;
export function publicTrackRecord(input?: Record<string, any>): Record<string, any>;
export function forbiddenKeys(value: unknown, found?: string[]): string[];
export function resetTrackRecordMemoForTests(): void;
export function readPublicTrackRecord(env: any, opts?: { now?: number }): Promise<Record<string, any>>;
