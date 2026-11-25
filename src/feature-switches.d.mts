export type FeatureSwitchValues = readonly string[] | { readonly type: "tokens"; readonly tokens: readonly string[] };
export type FeatureSwitchValue = string | string[];
export interface FeatureSwitchEntry {
  readonly key: string; readonly label: string; readonly description: string; readonly group: string;
  readonly worker: "ai" | "omega"; readonly values: FeatureSwitchValues; readonly config_only: readonly string[];
  readonly default_value: FeatureSwitchValue; readonly config_value: FeatureSwitchValue | null;
  readonly era_switch: boolean; readonly restarts_mode_evidence: boolean; readonly emergency_stop: boolean; readonly read_only: boolean;
  readonly write: "feature-switch" | "omega-settings"; readonly resolve: "env" | "agent-veto" | "omega-settings";
  read(raw: unknown): FeatureSwitchValue; toEnv?(value: FeatureSwitchValue): string;
}
export interface FeatureSwitchRow {
  key: string; label: string; description: string; group: string; worker: "ai" | "omega";
  values: string[] | { type: "tokens"; tokens: string[]; on: string[] }; value: FeatureSwitchValue; source: "override" | "config" | "default";
  config_value: FeatureSwitchValue | null; default_value: FeatureSwitchValue; set_by: string | null; set_at: string | null;
  era_switch: boolean; restarts_mode_evidence: boolean; emergency_stop: boolean; read_only: boolean; write: "feature-switch" | "omega-settings";
  [k: string]: unknown;
}
export const FEATURE_SWITCHES_VERSION: string;
export const FEATURE_SWITCH_OVERRIDE_KEY: string;
export const FEATURE_SWITCH_VETO_MIGRATION_KEY: string;
export const FEATURE_SWITCH_MEMO_MS: number;
export const FEATURE_SWITCH_GROUPS: ReadonlyArray<{ readonly id: string; readonly label: string }>;
export const FEATURE_SWITCHES: readonly FeatureSwitchEntry[];
export const FEATURE_SWITCH_KEYS: readonly string[];
export function isSet(raw: unknown): boolean;
export function switchByKey(key: unknown): FeatureSwitchEntry | null;
export function isTokens(e: unknown): boolean;
export function readSwitch(e: FeatureSwitchEntry, raw: unknown): FeatureSwitchValue;
export function envForm(e: FeatureSwitchEntry, value: FeatureSwitchValue): string;
export function normalizeValue(e: FeatureSwitchEntry, value: unknown): { value: FeatureSwitchValue } | { error: "invalid_value" };
export function validOverride(e: FeatureSwitchEntry | null, o: unknown): boolean;
export function parseOverrides(raw: unknown): Record<string, any>;
export function overridePatch(doc: unknown): { patch: Record<string, string>; ignored: string[] };
export function resolveEnvSwitch(e: FeatureSwitchEntry, input?: { override?: unknown; env?: Record<string, unknown> }): { value: FeatureSwitchValue; source: "override" | "config" | "default"; set_by: string | null; set_at: string | null };
export function roleWord(actor: unknown): string | null;
export function isoOrNull(v: unknown): string | null;
export function valuesField(e: FeatureSwitchEntry, value: FeatureSwitchValue): FeatureSwitchRow["values"];
export function switchRow(e: FeatureSwitchEntry, input: { value: FeatureSwitchValue; source: string; config_value?: FeatureSwitchValue | null; set_by?: string | null; set_at?: string | null }): FeatureSwitchRow;
export function valueText(v: unknown): string;
