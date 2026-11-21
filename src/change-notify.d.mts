export const AUDIT_NOTIFY_KEY: string;
export const AUDIT_DEBOUNCE_MS: number;
export const AUDIT_ACTIONS: Record<string, string>;
export function actorLabel(actor: unknown): string;
export function valueWords(key: string, v: unknown): string;
export function auditSweep(state: unknown, rows: unknown[], options?: { now?: number; context?: Record<string, unknown> }): { state: Record<string, any>; lines: string[] };
export function runAuditNotify(env: unknown, options?: { now?: number; send?: ((text: string) => Promise<unknown>) | null }): Promise<Record<string, unknown>>;
