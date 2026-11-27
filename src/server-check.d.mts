export declare const SERVER_SEEN_WAIT_MS: number;
export declare function foldServerName(name: unknown): string;
export declare function nearMatch(typed: unknown, known?: unknown[]): string | null;
export declare function serverCheck(input: { conn: unknown; executor: unknown; now: number }): { status: "ok" | "pending" | "not_seen"; message?: string } | null;
export declare function notSeenMessage(server: unknown): string;
