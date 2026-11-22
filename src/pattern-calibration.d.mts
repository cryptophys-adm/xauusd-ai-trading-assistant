export const PATTERN_CALIBRATION_VERSION: string;
export const PATTERN_CALIBRATION_KEY: string;
export function runPatternCalibration(env: unknown, options?: { now?: number }): Promise<Record<string, any> & { status: string }>;
export function readPatternCalibration(env: unknown): Promise<Record<string, any> | null>;
export const HORIZON_DEFAULT_BARS: number;
export function patternHorizonMode(env: unknown): "on" | "off";
export function horizonFor(calibration: unknown, tf: string, id: string, h?: number | null, options?: { min_sample?: number }): number;
