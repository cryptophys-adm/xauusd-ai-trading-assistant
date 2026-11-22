export const PATTERN_CALIBRATION_VERSION: string;
export const PATTERN_CALIBRATION_KEY: string;
export function runPatternCalibration(env: unknown, options?: { now?: number }): Promise<Record<string, any> & { status: string }>;
export function readPatternCalibration(env: unknown): Promise<Record<string, any> | null>;
export const HORIZON_DEFAULT_BARS: number;
export function patternHorizonMode(env: unknown): "on" | "off";
/**
 * Bars a pattern's breakout on a chart is followed for: the pattern's own p90 when it is active on that chart and its
 * own bars_to_target has at least min_sample targets, else the chart's p90 from min_sample targets, else
 * HORIZON_DEFAULT_BARS (30); never above h when h is given.
 */
export function horizonFor(calibration: unknown, tf: string, id: string, h?: number | null, options?: { min_sample?: number }): number;
