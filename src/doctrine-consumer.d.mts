export interface DoctrineRule {
  id: string;
  class: "constitutional" | "operational";
  rule: string;
  canon_rule?: string;
  since?: string;
  amended?: {
    amendment_id: string;
    action: string;
    executed_at: string;
  } | null;
}

export interface EffectiveDoctrinePayload {
  version: string;
  rules: DoctrineRule[];
  applied: any[];
  council: any | null;
  facts: any | null;
  source: string;
  cached_at: string;
}

export const DOCTRINE_KV_KEY: string;
export const DOCTRINE_MEMORY_TTL_MS: number;
export const DOCTRINE_KV_TTL_SECONDS: number;
export const CANON_DOCTRINE_RULES: readonly DoctrineRule[];

export function resetDoctrineConsumerCacheForTests(): void;
export function normaliseDoctrineRules(rawRules: unknown): readonly DoctrineRule[];
export function fetchEffectiveDoctrine(env?: any, options?: { force?: boolean; now?: number }): Promise<EffectiveDoctrinePayload>;
export function getEffectiveDoctrine(env?: any, options?: { force?: boolean; now?: number }): Promise<readonly DoctrineRule[]>;
export function formatDoctrineDirectives(rules: readonly DoctrineRule[], options?: { role?: string }): string;
