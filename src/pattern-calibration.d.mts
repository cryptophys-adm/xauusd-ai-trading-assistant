export const PATTERN_CALIBRATION_VERSION: string;
export const PATTERN_CALIBRATION_KEY: string;
export function runPatternCalibration(env: unknown, options?: { now?: number }): Promise<Record<string, any> & { status: string }>;
export function readPatternCalibration(env: unknown): Promise<Record<string, any> | null>;
