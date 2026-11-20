export function runLensStep(env: unknown, options?: { now?: number; notify?: ((text: string) => Promise<unknown>) | null }): Promise<Record<string, any>>;
export function lensStatus(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function pushLensReport(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function lensHealthIssues(env: unknown, now?: number): Promise<Array<Record<string, any>>>;
export function runLiquidityStep(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function roomContextLine(env: unknown, chart: string, options?: { now?: number }): Promise<Record<string, any> | null>;
