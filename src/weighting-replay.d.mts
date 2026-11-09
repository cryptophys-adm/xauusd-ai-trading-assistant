export const WEIGHTING_REPLAY_VERSION: string;
export const REPLAY_DAYS: Readonly<Record<string, number>>;
export function replayQuorum(params: Record<string, any>, rows: unknown[], rooms: unknown[], options?: { horizonMs?: number }): Map<string, { stance: string; share: number | null }>;
export function compareWeighting(input: Record<string, any>): Record<string, any>;
export function roomsFromRows(rows: unknown[], closeOf: (key: string) => number): Array<Record<string, any>>;
export function loadRooms(db: unknown, timeframe: string, sinceIso: string): Promise<Array<Record<string, any>>>;
export function loadH1Rooms(db: unknown, sinceIso: string): Promise<Array<Record<string, any>>>;
export function readWeightingReplay(env: unknown, options?: { timeframe?: string; days?: number; now?: number; useCache?: boolean }): Promise<Record<string, any>>;
export function resetWeightingReplayCacheForTests(): void;
