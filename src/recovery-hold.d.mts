export declare const RECOVERY_RESTART_CAP: number;
export declare const RECOVERY_STREAK_GAP_MS: number;
export declare const REARM_FRESH_MS: number;
export declare const HOLD_DIRECTIVE: string;
export declare const HOLD_REASON: string;
export declare function recoveryHold(input?: { recent?: Array<{ ms: number; detail: unknown }>; connVersion?: number; connectedMs?: number; now?: number | null; cap?: number; gapMs?: number }): { hold: boolean; recorded: boolean; streak: number };
export declare function heldDetail(input: { connVersion: number; streak: number; reason?: string }): Record<string, unknown>;
export declare function holdRecovery(connVersion: number): { directive: string; reason: string; action_id: string };
export declare function shouldRearm(input: { executor: unknown; now: number; lastRecoveryMs: number | null; lastRearmMs: number | null }): boolean;
