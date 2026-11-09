export const LEDGER_VERSION: string;
export function runSignalLedger(env: unknown, options?: { now?: number; readStrategy?: ((env: any, options?: { now?: number }) => Promise<any>) | null; h1Decisions?: boolean }): Promise<Record<string, unknown>>;
export function readLedger(env: unknown, options?: { days?: number; now?: number }): Promise<Record<string, unknown>>;
export function ensureLedgerSchema(db: unknown): Promise<void>;
export function ingestStrategy(env: unknown, strategy: any, options?: { now?: number }): Promise<number>;
export function ingestDecision(env: unknown, decision: any, options?: { now?: number }): Promise<number>;
