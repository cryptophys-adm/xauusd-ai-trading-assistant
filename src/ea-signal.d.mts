export const EA_SIGNAL_VERSION: string;
export const EA_HEARTBEAT_KEY: string;
export function eaSignalFrom(input: Record<string, any>): Record<string, any>;
export function eaSignal(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function heartbeatFrom(body: unknown, options?: { now?: number }): Record<string, any> | null;
export function storeHeartbeat(env: unknown, body: unknown, options?: { now?: number }): Promise<{ ok: boolean; error?: string }>;
export function eaStatus(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
