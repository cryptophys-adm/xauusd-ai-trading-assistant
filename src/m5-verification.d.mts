export const M5_VERIFIED_LABEL: string;
export const M5_UNVERIFIED_LABEL: string;
export function m5CandleKeyForClose(closeIso: string, symbol?: string): string | null;
export function verifiedM5Reading(env: unknown, closeIso: string): Promise<Record<string, unknown> & { verified: boolean }>;
export function m5ParityApproved(db: unknown): Promise<boolean>;
