export const KEY_LEVEL_VERSION: string;
export const TF_WEIGHT: Readonly<Record<string, number>>;
export function swings(bars: unknown[], options?: { lookback?: number; perSide?: number }): { highs: number[]; lows: number[] };
export function rawLevels(input?: Record<string, any>): Array<Record<string, any>>;
export function clusterLevels(levels: Array<Record<string, any>>, tolerance: number, price?: number | null): Array<Record<string, any>>;
export function buildKeyLevels(input?: Record<string, any>): Record<string, any>;
