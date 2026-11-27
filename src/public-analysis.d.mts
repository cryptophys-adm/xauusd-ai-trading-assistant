export const PUBLIC_ANALYSIS_VERSION: string;
export const ANALYSIS_CHARTS: Readonly<Record<string, string>>;
export const KEY_MAP_CHARTS: readonly string[];
export const CHART_ZONE_MIN_SOURCES: number;
export const ANALYSIS_FORBIDDEN_KEYS: readonly string[];
export function titleOf(name: string): string;
/** At most `max` characters, cut at a word boundary, without a dangling separator. */
export function cutAtWord(s: string, max: number): string;
export function publicAnalysis(keyLevels: unknown, options?: { structure?: unknown; now?: number; charts?: unknown }): Record<string, any>;
export function analysisLeaks(value: unknown, path?: string): string[];
export const PROJECTION_MAX_HEIGHTS: number;
export function publicProjectionOf(p: any): number | null;
