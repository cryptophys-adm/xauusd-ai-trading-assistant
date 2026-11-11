export const DOCTRINE_FACTS_SCHEMA: string;
export function guardrailIds(env?: any): string[];
export function nexusFacts(env: any): Promise<Record<string, unknown>>;
export function omegaFacts(env: any): Promise<Record<string, unknown>>;
export function doctrineFacts(env: any, options?: { now?: number }): Promise<Record<string, any>>;
export function pushDoctrineFacts(env: any, options?: { now?: number }): Promise<Record<string, any>>;
