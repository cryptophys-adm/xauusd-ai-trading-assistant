export const CROWD_REPLAY_VERSION: string;
export const CROWD_CONTROL: Readonly<Record<string, any>>;
export const CROWD_CANDIDATES: ReadonlyArray<Readonly<Record<string, any>>>;
export function weightOf(hits: number, decisive: number, params: { prior: number; weight_range: readonly number[] }): number;
export function crowdStance(entries: Array<{ agent: string; stance: string }>, weights: Record<string, number>, neutralBand: number): "BUY" | "SELL" | "WAIT";
export function replayArm(arm: Record<string, any>, rows: unknown[], rooms: unknown[], options?: { horizonMs?: number }): Map<string, string>;
export function compareCrowd(input: Record<string, any>): Record<string, any>;
export function readCrowdReplay(env: unknown, options?: { days?: number; now?: number; useCache?: boolean }): Promise<Record<string, any>>;
export function resetCrowdReplayCacheForTests(): void;
