export const ROOM_STANCES: readonly string[];
export const THREAD_WALL_BUDGET_MS: number;
export const THREAD_SCHEMA_SQL: string[];

export interface LiveRoomTask { kind: "live_room"; event_id: string; bar_time: string; candle_key: string; context: Record<string, unknown> | null; enqueued_at: string }

export function liveRoomEnabled(env: unknown): boolean;
export function buildLiveRoomTask(input: { barTime: string; context?: Record<string, unknown> | null; hud?: Record<string, unknown> | null; enqueuedAt?: string }): LiveRoomTask;
export function m15KeyForClose(closeIso: string): string;
export function ensureThreadSchema(db: unknown): Promise<void>;
export function resetThreadSchemaCacheForTests(): void;
export function rowToThreadMessage(row: Record<string, unknown> | null): Record<string, any> | null;
export function isFifteenMinuteClose(closeTime: unknown): boolean;
export function buildFifteenMinuteCandles(bars5m: unknown, options?: { limit?: number }): Array<{ close_time: string; o: number; h: number; l: number; c: number; v: number | null }>;
export function validateRoomModerator(obj: unknown, h1Decision: string): { valid: boolean; errors: string[] };
export function buildMessageTree(messages: Array<Record<string, any>>): Array<Record<string, any>>;
export function listThreads(db: unknown, options?: { kind?: string; limit?: number }): Promise<Array<Record<string, any>>>;
export function readThread(db: unknown, id: string): Promise<Record<string, any> | null>;
export function readLive(db: unknown, options?: { since?: number; limit?: number }): Promise<Array<Record<string, any>>>;
export function listH1Threads(db: unknown, options?: { limit?: number }): Promise<Array<Record<string, any>>>;
export function readH1Thread(db: unknown, candleKey: string): Promise<Record<string, any> | null>;
export interface HudAgentsTask { kind: "hud_agents"; event_id: string; candle_key: string; enqueued_at: string }
export function hudEvidenceLines(reading: unknown): string[];
export function readHudThread(db: unknown, candleKey: string): Promise<Array<Record<string, any>>>;
export function m5ContextFromSeries(kv: any, barTime: string): Promise<Record<string, any> | null>;
