export declare const SERVER_SEEN_WAIT_MS: number;
export declare function foldServerName(name: unknown): string;
export declare function nearMatch(typed: unknown, known?: unknown[]): string | null;
export declare function serverCheck(input: { conn: unknown; executor: unknown; now: number; seen?: boolean }): { status: "ok" | "disconnected" | "pending" | "not_seen"; message?: string } | null;
export declare function loggedInOn(conn: unknown, executor: unknown): boolean;
export declare function notSeenMessage(server: unknown): string;
