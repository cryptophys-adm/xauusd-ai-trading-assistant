export const PUBLIC_ANALYSIS_VERSION: string;
export const ANALYSIS_CHARTS: Readonly<Record<string, string>>;
export const ANALYSIS_FORBIDDEN_KEYS: readonly string[];
export function titleOf(name: string): string;
export function publicAnalysis(keyLevels: unknown, options?: { structure?: unknown; now?: number }): Record<string, any>;
export function analysisLeaks(value: unknown, path?: string): string[];
