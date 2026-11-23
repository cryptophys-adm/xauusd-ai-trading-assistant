export function runLensStep(env: unknown, options?: { now?: number; notify?: ((text: string) => Promise<unknown>) | null }): Promise<Record<string, any>>;
export function lensStatus(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function pushLensReport(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function lensHealthIssues(env: unknown, now?: number): Promise<Array<Record<string, any>>>;
export function runLiquidityStep(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function roomContextLine(env: unknown, chart: string, options?: { now?: number }): Promise<Record<string, any> | null>;
/** B16: what the 15m and 1H rooms read of lens B (env LENS_ROOM_LINE): "conditions" (default) or "brief". */
export const LENS_ROOM_LINES: readonly ["conditions", "brief"];
export function lensRoomLine(env: unknown): "conditions" | "brief";
export const LIQUIDITY_ROOM_CHARTS: readonly ["M15", "H1"];
export function roomConditionsLine(env: unknown, chart: string, context: unknown): string | null;
