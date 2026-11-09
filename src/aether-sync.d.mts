export const AETHER_SYNC_VERSION: string;
export const LOCAL_KB_SHA: string;
export function combineSync(input: Record<string, any>): Record<string, any>;
export function aetherSyncStatus(env: unknown, options?: { now?: number }): Promise<Record<string, any> | null>;
export function syncAlerts(status: Record<string, any> | null): { key: string; kind: string; subject: string; detail: Record<string, any> }[];
