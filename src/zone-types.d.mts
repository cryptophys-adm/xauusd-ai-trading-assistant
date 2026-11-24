export const ZONE_TYPES_VERSION: string;
export const ZONE_TF_WEIGHT: Readonly<Record<string, number>>;
export const ZONE_TF_NAME: Readonly<Record<string, string>>;
export const ZONE_SOURCE_WEIGHT: Readonly<Record<"whale_active" | "whale_mitigation" | "prophet_best" | "rbs" | "sbr" | "qm_buy" | "qm_sell" | "gmi_flag", number>>;
export const ZONE_RULES: Readonly<{ dominance: number; medium: number; strong: number; touch_band_atr: number; touch_bars: number; touch_gap: number; touch_cap: number; around: number }>;
export const ZONE_NEED: Readonly<{ risk: number; atr: number }>;
export const ZONE_TREND_LEAN: number;

export type ZoneType = "demand" | "supply" | "mixed" | "none";
export type ZoneStrength = "strong" | "medium" | "weak" | null;
export type ZoneFreshness = "fresh" | "tested" | "worn" | null;
export interface ZoneDs { type: ZoneType; strength: ZoneStrength; score: number | null; freshness: ZoneFreshness; touches: number | null; sources: string[] }
export interface ZoneWords { type: ZoneType; strength: ZoneStrength; freshness: ZoneFreshness }
export interface AroundZone { low: number | null; high: number | null; zone_type?: ZoneType; zone_strength?: ZoneStrength; zone_freshness?: ZoneFreshness; zone_rank?: "candidate" | "qualified" }
export interface OpposingAhead {
  o_type: ZoneType | null; o_strength: ZoneStrength; o_freshness: ZoneFreshness; o_rank: "candidate" | "qualified" | null;
  room_atr: number | null; room_r: number | null; need_r: number | null; trend_lean: number | null; with_trend: boolean; would_block: boolean;
}
export interface DsBox { source: string; tf: string; side: "demand" | "supply"; bottom: number | null; top: number | null; weight: number | null; point?: boolean; at_price?: boolean }

export function keyLevelZoneTypesMode(env: unknown): "on" | "off";
export function zoneNeed(risk: number, atrH1: number): number;
export function dsEvidence(input?: { snapshots?: Record<string, any>; bars15?: unknown[]; atrH1?: number | null }): { boxes: DsBox[]; bars: Array<Record<string, any>>; atr_h1: number | null };
export function boxTypes(box: DsBox, zone: { low: number; high: number; role?: string | null }): boolean;
export function zoneTouches(low: number, high: number, bars: unknown[], band: number | null): number | null;
export function freshnessOf(touches: number | null): ZoneFreshness;
export function zoneTypes<T extends Record<string, any>>(zones: T[], evidence: { boxes?: DsBox[]; bars?: unknown[]; atr_h1?: number | null }): T[];
export function decisive(zone: unknown): boolean;
export function zoneWords(zone: unknown): ZoneWords | null;
export function typedZones(zones: unknown): boolean;
export function aroundSet(zones: unknown[] | null | undefined, price: number | null | undefined, n?: number): AroundZone[];
export function zoneAhead(plan: { entry?: number; stop?: number } | null | undefined, around: AroundZone[] | null | undefined, options?: { dir?: number; atrH1?: number | null; trend?: number | null }): OpposingAhead | null;
export function withZoneAhead<T extends Record<string, any> | null>(plan: T, strategy: any, dir: number): T;
