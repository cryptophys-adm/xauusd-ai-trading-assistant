export const ZONE_TYPES_VERSION: string;
export const ZONE_TF_WEIGHT: Readonly<Record<string, number>>;
export const ZONE_TF_NAME: Readonly<Record<string, string>>;
export const ZONE_SOURCE_WEIGHT: Readonly<Record<"whale_active" | "whale_mitigation" | "prophet_best" | "rbs" | "sbr" | "qm_buy" | "qm_sell" | "gmi_flag", number>>;
export const ZONE_PROPHET_WEIGHT: Readonly<{ active: number; high_volume: number }>;
export type ZoneSource = "prophet_zone" | "prophet_best" | "whale" | "gabfx" | "gmi_flag";
export const ZONE_SOURCES: readonly ZoneSource[];
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
export interface DsBox { source: string; tf: string; side: "demand" | "supply"; bottom: number | null; top: number | null; weight: number | null; point?: boolean; at_price?: boolean; touches?: number | null }

export function keyLevelZoneTypesMode(env: unknown): "on" | "off";
export function zoneSourcesOffMode(env: unknown): ZoneSource[];
export function zoneSourcesModes(env: unknown): { zoneSourcesOff?: ZoneSource[] };
export function zoneSourcesList(list: unknown): ZoneSource[];
export function zoneNeed(risk: number, atrH1: number): number;
export function dsEvidence(input?: { snapshots?: Record<string, any>; bars15?: unknown[]; atrH1?: number | null; sourcesOff?: unknown }): { boxes: DsBox[]; bars: Array<Record<string, any>>; atr_h1: number | null };
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
// Z2: the zone_ahead check.
export type ZoneAheadMode = "trend" | "all" | "record" | "off";
export const ZONE_AHEAD_MODES: readonly ZoneAheadMode[];
export const ZONE_AHEAD_RULE: string;
export function zonePriorityMode(env: unknown): "on" | "off";
export function zoneAheadMode(env: unknown, modes?: { zoneTypes?: string } | null): ZoneAheadMode;
export function zoneAheadChecks(mode: unknown): boolean;
export function zoneAheadFails(oa: OpposingAhead | null | undefined, mode: unknown): boolean;
export function zonePlanPasses(plan: { opposing_ahead?: OpposingAhead | null } | null | undefined, g: { zone_ahead?: ZoneAheadMode } | null | undefined): boolean;
export function zoneAheadCheck(plan: { opposing_ahead?: OpposingAhead | null } | null | undefined, mode: ZoneAheadMode, dir: number): { pass: boolean; detail: string };
export function zoneRuleToken(env: unknown): string | null;
// Z2b: execution plans aimed by zone type.
export type ZoneAimToken = "tp" | "stop" | "factor";
export type ZoneAimTpMode = "label" | "qualified";
export interface ZoneAim { tp: ZoneAimTpMode | null; stop: boolean; factor: boolean }
export interface ZoneRule { rule: "tp_typed" | "stop_skip"; base_tp1_r?: number | null; base_stop_atr?: number | null; held?: "rrr" }
export const ZONE_AIM_RULE: string;
export const ZONE_AIM_TOKENS: readonly ZoneAimToken[];
export const ZONE_AIM_TP_MODES: readonly ZoneAimTpMode[];
export const ZONE_AIM: Readonly<{ tp2_gap_atr: number; tp2_min_r: number; stop_gap_atr: number; stop_pad_atr: number; stop_cap_atr: number; stop_fallback_atr: number; factor_own: number; factor_opposite: number }>;
export function zoneAimOffMode(env: unknown): ZoneAimToken[];
export function zoneAimTpMode(env: unknown): ZoneAimTpMode;
export function zoneAimMode(env: unknown, modes?: { zoneTypes?: string } | null): ZoneAim | null;
export function zoneAimRuleToken(env: unknown): string | null;
export function zoneFactorOf(plan: { zone_types?: Record<string, ZoneWords | null> | null } | null | undefined, dir: number): number | null;
export interface ZoneAimContext { dir: number; atrH1: number | null; trend?: number | null; aim: ZoneAim | null; keyZone?: boolean; typedTargets?: boolean; stopFromZones?: boolean; levels?: Array<Record<string, any>> }
export function zoneAim<T extends Record<string, any> | null>(plan: T, around: AroundZone[] | null | undefined, ctx: ZoneAimContext): T;
export function zoneAimHeld<T extends Record<string, any> | null>(plan: T, around: AroundZone[] | null | undefined, ctx: ZoneAimContext, passes?: (plan: Record<string, any>) => boolean): T;
export function zoneAimBase(plan: { entry?: number; zone_rules?: ZoneRule[] } | null | undefined, atrH1: number | null | undefined, dir: number): { entry: number; stop: number; tp1: number } | null;
