export const INTRABAR_RECHECK_AFTER_MS: number;
export const INTRABAR_RECHECK_WITHIN_MS: number;
export function candleWindow(candleKey: string): { tf: string; openMs: number; closeMs: number; series: string } | null;
export function intrabarFingerprint(candles: unknown, window: { series: string; openMs: number; closeMs: number }): { series: string; count: number; hash: string; bars: Array<{ at: number; v: number | null; d: number }> };
export function compareFingerprints(before: any, after: any): { same: boolean; changed: number[]; added: number[]; removed: number[] } | null;
export function readIntrabars(env: unknown, candleKey: string): Promise<Record<string, any> | null>;
export function recheckMismatchIntrabars(env: unknown, options?: { now?: number; limit?: number }): Promise<Record<string, any>>;
