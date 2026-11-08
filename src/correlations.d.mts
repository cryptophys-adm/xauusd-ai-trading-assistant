export const CORRELATIONS_VERSION: string;
export const GOLD: Readonly<Record<string, string>>;
export const ASSETS: ReadonlyArray<Readonly<Record<string, string>>>;
export const WINDOWS: Readonly<{ short: number; long: number }>;
export function closes(record: unknown, now?: number): Array<{ t: number; close: number }>;
export function asOf(series: Array<{ t: number; close: number }>, grid: number[], maxAge?: number): Array<number | null>;
export function pearson(x: Array<number | null>, y: Array<number | null>): { r: number | null; n: number };
export function buildCorrelations(input: Record<string, any>): Record<string, any>;
export function readCorrelations(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
