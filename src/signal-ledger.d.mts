export const LEDGER_VERSION: string;
export function runSignalLedger(env: unknown, options?: { now?: number; readStrategy?: ((env: any, options?: { now?: number }) => Promise<any>) | null }): Promise<Record<string, unknown>>;
export function readLedger(env: unknown, options?: { days?: number; now?: number }): Promise<Record<string, unknown>>;
