export const RECO_KEY: string;
export const RECO_MIN_GAP_MS: number;
export const RECO_RULES: Readonly<Record<string, number>>;
export function rBucket(r: unknown): string | null;
export function recommendationOf(card: Record<string, any>): { verdict: "recommended" | "neutral" | "not_recommended"; reason: string; rules: Record<string, any>[] };
export function buildCards(input?: Record<string, any>): Record<string, any>[];
export function exitsOf(rows: Record<string, any>[], n?: number): Record<string, any>;
export function computeRecommendations(env: unknown, opts?: { now?: number; force?: boolean }): Promise<{ status: string; [k: string]: unknown }>;
export function readRecommendations(env: unknown): Promise<Record<string, any> | null>;
