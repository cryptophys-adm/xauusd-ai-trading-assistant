export const INDICATOR_REGISTRY_VERSION: string;
export function lifecycleOf(manifest: any, parity: any[]): string;
export function registryEntry(manifest: any, input?: Record<string, any>): Record<string, any>;
export function indicatorAgents(env: any, options?: { now?: number }): Promise<Record<string, any>>;
