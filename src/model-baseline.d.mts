export const MODEL_BASELINE_VERSION: string;
export function runModelBaseline(env: unknown, options?: { now?: number; loadRows?: () => Promise<unknown[]>; loadLiveNotes?: () => Promise<unknown[]>; loadGbm?: () => Promise<unknown> }): Promise<Record<string, any> & { status: string }>;
export function readBaseline(env: unknown): Promise<Record<string, any> | null>;
export function baselineStatus(baseline: unknown): Record<string, any> | null;
export function prospectiveRecord(rows: unknown[]): Record<string, any>;
