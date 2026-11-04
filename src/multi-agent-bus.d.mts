export const BUS_DEFAULT_MODEL: string;
export const BUS_DEFAULT_FALLBACK_MODEL: string;
export const BUS_AGENTS: readonly string[];
export const BUS_ROUNDS: number;
export const BUS_MODERATOR_ROUND: number;
export const BUS_WALL_BUDGET_MS: number;
export const BUS_MAX_TOKENS: Readonly<{ agent: number; moderator: number }>;
export const BUS_STANCES: readonly string[];
export const BUS_SCHEMA_SQL: string[];
export const AGENT_JSON_SCHEMA: Record<string, unknown>;
export const MODERATOR_JSON_SCHEMA: Record<string, unknown>;

export interface MultiAgentBusTask {
  kind: "multi_agent_bus";
  event_id: string;
  candle_key: string;
  input_fingerprint: string;
  enqueued_at: string;
}

export function busEnabled(env: unknown): boolean;
export function buildMultiAgentBusTask(input: { candleKey: string; inputFingerprint: string; enqueuedAt?: string }): MultiAgentBusTask;
export function ensureBusSchema(db: unknown): Promise<void>;
export function resetBusSchemaCacheForTests(): void;
export function buildBusEvidence(row: Record<string, unknown> | null): any;
export function agentMessages(agent: string, round: number, evidence: unknown, roundOneMessages?: unknown[]): Array<{ role: string; content: string }>;
export function moderatorMessages(evidence: unknown, messages: unknown[]): Array<{ role: string; content: string }>;
export function validateAgentOutput(obj: unknown, expected: { agent: string; round: number }): { valid: boolean; errors: string[] };
export function validateModeratorOutput(obj: unknown): { valid: boolean; errors: string[] };
export function parseModelObject(result: unknown): { obj: Record<string, unknown> | null; text: string; truncated?: boolean };
export function callBusModel(env: unknown, options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function rowToMessage(row: Record<string, unknown>): Record<string, unknown>;
export function runMultiAgentBus(env: unknown, task: MultiAgentBusTask, options?: { clock?: () => number }): Promise<{ status: string; calls: number; messages?: number }>;
export function readBus(db: unknown, candleKey: string | null): Promise<Record<string, unknown>>;
