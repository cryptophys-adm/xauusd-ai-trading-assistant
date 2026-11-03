export interface EngineIdentity {
  engine: "mizan" | "prophet" | "gmi";
  sourceHash: string;
  implementationHash: string;
  mizanSourceHash: string | null;
  mizanImplementationHash: string | null;
}
export interface ParityPolicy { promoteAfter: number; absTolerance: number; relTolerance: number }
export interface ParityComparison {
  status: "match" | "mismatch" | "incomplete" | "not_comparable";
  compared?: number;
  mismatches?: Array<Record<string, unknown>>;
  missing?: string[];
  reason?: string;
  absent_sources?: string[];
}
export const PARITY_REGISTRY_VERSION: string;
export const PARITY_FIELDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
export const INPUT_FIELDS: readonly string[];
export const DEFAULT_POLICY: Readonly<ParityPolicy>;
export const SCHEMA_SQL: string[];
export function policyFromEnv(env?: Record<string, unknown>): ParityPolicy;
export function normalizeHash(value: unknown): string | null;
export function identityOf(record: unknown): EngineIdentity | null;
export function requiredSourcesFor(engine: string): string[];
export function compareWithWebhooks(record: unknown, webhookPayloads: Record<string, unknown>, policy?: ParityPolicy): ParityComparison;
export function ensureSchema(db: D1Database): Promise<void>;
export function resetSchemaCacheForTests(): void;
export function registerIdentity(db: D1Database, id: EngineIdentity, now?: string): Promise<void>;
export function recordComparison(db: D1Database, id: EngineIdentity, candleKey: string, comparison: ParityComparison, policy?: ParityPolicy, now?: string): Promise<{ counted: boolean; result?: string; reason?: string }>;
export function isTrusted(db: D1Database, id: EngineIdentity): Promise<boolean>;
export function listRegistry(db: D1Database, limit?: number): Promise<Array<Record<string, unknown>>>;
