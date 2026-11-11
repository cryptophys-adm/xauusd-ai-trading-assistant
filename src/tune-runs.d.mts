export const TUNE_RUNS_VERSION: string;
export const TUNE_RUNS_KEEP_DAYS: number;
export const TUNE_RUNS_SCHEMA_SQL: string[];
export function resetTuneRunsSchemaCacheForTests(): void;
export function replaySummary(replay: unknown): Record<string, any> | null;
export function tuneRunRow(run: { step: string; startedMs: number; finishedMs: number; versionId?: string | null; replay?: any; applied?: any; pushed?: any; error?: string | null }): Record<string, any>;
export function recordTuneRun(env: unknown, run: Record<string, any>, options?: { now?: number }): Promise<{ status: string; error?: string }>;
export function runTuneStep<T extends { replay?: any; applied?: any; pushed?: any }>(env: unknown, step: string, fn: () => Promise<T>, options?: { clock?: () => number }): Promise<Partial<T> & { error: string | null }>;
export function readTuneRuns(env: unknown, options?: { step?: string | null; limit?: number }): Promise<Record<string, any>>;
