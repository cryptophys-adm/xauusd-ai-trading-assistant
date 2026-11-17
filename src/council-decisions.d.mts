export const DECISIONS_AGENT: string;
export const DECISIONS_CAPABILITY: string;
export const PLATFORM_STATES: readonly string[];
export function decisionsPollOn(env: unknown): boolean;
export function cleanUpdate(u: unknown): { proposal_id: string; state: string; reason: string | null; refs: Record<string, string>; at: string } | null;
export function pollCouncilDecisions(env: unknown, input?: Record<string, any>): Promise<Record<string, any>>;
export function platformStates(env: unknown, ids: string[]): Promise<Record<string, any>>;
export function decisionsPollStatus(env: unknown): Promise<{ on: boolean; last_polled_at: string | null; last_status: string | null }>;
export function resetDecisionsSchemaForTests(): void;
