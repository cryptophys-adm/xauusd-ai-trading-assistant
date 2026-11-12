export const GLOBAL_CONCLUSION_VERSION: string;
export const GLOBAL_WEIGHTS: Readonly<Record<"D1" | "H4" | "H1" | "M15" | "NEWS", number>>;
export function roomLean(openings: unknown[] | null | undefined): number | null;
export const NEWS_TLDR_SHARE: number;
export function newsLean(news: any): number | null;
export function buildGlobalConclusion(input?: Record<string, any>): Record<string, any>;
export function readGlobalConclusion(env: any, options?: { now?: number }): Promise<Record<string, any>>;
