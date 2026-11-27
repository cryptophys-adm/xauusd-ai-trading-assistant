import type { TrustedIdentity } from "./trusted-identities.mjs";
export interface EngineIdentity {
  engine: string;
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
  null_fields?: string[];
}
export interface ParityGroup {
  engine: string;
  source: string;
  kind: "hud" | "witness" | string;
  fields: Readonly<Record<string, string>>;
  nullEqual?: boolean;
  requireFinite?: boolean;
}
export interface GroupIdentity extends EngineIdentity { group: string; parentEngine: string }
export interface CompareOptions {
  fieldMap?: Record<string, readonly string[] | Record<string, string>>;
  nullEqual?: boolean;
  requireFinite?: boolean;
}
export const PARITY_REGISTRY_VERSION: string;
export const PARITY_FIELDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
export const INPUT_FIELDS: readonly string[];
export const DEFAULT_POLICY: Readonly<ParityPolicy>;
export const SCHEMA_SQL: string[];
export function policyFromEnv(env?: Record<string, unknown>): ParityPolicy;
export function normalizeHash(value: unknown): string | null;
export const BASE_ENGINES: readonly string[];
export function scopedEngine(engine: unknown, timeframe: unknown): string | null;
export function identityOf(record: unknown): EngineIdentity | null;
export function requiredSourcesFor(engine: string): string[];
export function compareWithWebhooks(record: unknown, webhookPayloads: Record<string, unknown>, policy?: ParityPolicy, options?: CompareOptions): ParityComparison;
export const PARITY_GROUPS: Readonly<Record<string, Readonly<ParityGroup>>>;
export function parityGroupProblems(groups?: Record<string, ParityGroup>): string[];
export function groupsFor(engine: string, groups?: Record<string, ParityGroup>): string[];
export function groupCompareOptions(groupId: string, groups?: Record<string, ParityGroup>): { fieldMap: Record<string, Record<string, string>>; nullEqual: boolean; requireFinite: boolean } | null;
export function groupIdentityOf(record: unknown, groupId: string, groups?: Record<string, ParityGroup>): GroupIdentity | null;
export function ensureSchema(db: D1Database): Promise<void>;
export function resetSchemaCacheForTests(): void;
export function registerIdentity(db: D1Database, id: EngineIdentity, now?: string): Promise<void>;
export function recordComparison(db: D1Database, id: EngineIdentity, candleKey: string, comparison: ParityComparison, policy?: ParityPolicy, now?: string): Promise<{ counted: boolean; result?: string; reason?: string }>;
export function isTrusted(db: D1Database, id: EngineIdentity, table?: readonly TrustedIdentity[]): Promise<boolean>;
export function registryApproved(db: D1Database, id: EngineIdentity): Promise<boolean>;
export function listRegistry(db: D1Database, limit?: number): Promise<Array<Record<string, unknown>>>;
