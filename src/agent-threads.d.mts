export const ROOM_STANCES: readonly string[];
export const THREAD_WALL_BUDGET_MS: number;
export const LIVE_ROOM_WALL_BUDGET_MS: number;
export const THREAD_SCHEMA_SQL: string[];

export interface NewsThreadTask { kind: "news_thread"; event_id: string; analysis_key: string; candle_key: string; enqueued_at: string }
export interface LiveRoomTask { kind: "live_room"; event_id: string; bar_time: string; candle_key: string; context: Record<string, unknown> | null; enqueued_at: string }

export function liveRoomEnabled(env: unknown): boolean;
export function buildNewsThreadTask(input: { analysisKey: string; enqueuedAt?: string }): NewsThreadTask;
export function buildLiveRoomTask(input: { barTime: string; context?: Record<string, unknown> | null; enqueuedAt?: string }): LiveRoomTask;
export function ensureThreadSchema(db: unknown): Promise<void>;
export function resetThreadSchemaCacheForTests(): void;
export function rowToThreadMessage(row: Record<string, unknown> | null): Record<string, any> | null;
export function runNewsThread(env: unknown, task: { analysis_key: string }, options?: { clock?: () => number }): Promise<{ status: string; calls: number }>;
export function liveRoomSignature(input: { m5: unknown; h1: unknown; newsKey: unknown }): string;
export function validateRoomModerator(obj: unknown, h1Decision: string): { valid: boolean; errors: string[] };
export function runLiveRoomBar(env: unknown, task: { bar_time: string; context?: unknown }, options?: { clock?: () => number }): Promise<{ status: string; calls: number }>;
export function buildMessageTree(messages: Array<Record<string, any>>): Array<Record<string, any>>;
export function listThreads(db: unknown, options?: { kind?: string; limit?: number }): Promise<Array<Record<string, any>>>;
export function readThread(db: unknown, id: string): Promise<Record<string, any> | null>;
export function readLive(db: unknown, options?: { since?: number; limit?: number }): Promise<Array<Record<string, any>>>;
