export const LEDGER_ALERTS_VERSION: string;
export const LEDGER_ALERTS_SCHEMA_SQL: string[];
export function resetLedgerAlertsSchemaCacheForTests(): void;
export function ledgerAlertsEnabled(env: unknown): boolean;
export function signalEvents(row: Record<string, any>): string[];
export function formatAlert(row: Record<string, any>, event: string): string;
export function sendLedgerAlerts(env: unknown, options?: { send?: (text: string) => Promise<void>; now?: number; max?: number; days?: number }): Promise<Record<string, unknown>>;
export function readLedgerAlerts(env: any, opts?: { days?: number; now?: number; limit?: number }): Promise<Record<string, any>>;
