export interface OmegaSettings {
  enabled: boolean;
  live_armed: boolean;
  risk_pct: number;
  max_positions: number;
  max_daily_loss_pct: number;
  max_spread_points: number;
  max_signal_age_ms: number;
}
export const OMEGA_DEFAULTS: Readonly<OmegaSettings>;
export const RISK_PCT_MAX: number;
export const EXECUTOR_MAX_AGE_MS: number;
export const INTENT_ID_MAX: number;
export function floorToStep(v: number, step: number): number;
export function settingsFrom(body: unknown, current?: Partial<OmegaSettings>): { settings?: OmegaSettings; error?: string };
export function openId(issuedMs: number, side: string): string;
export function closeId(ticket: number | string): string;
export function closeAllId(key: string): string;
export function planIntents(input?: {
  signal?: Record<string, any> | null;
  control?: Record<string, any> | null;
  settings?: Partial<OmegaSettings>;
  executor?: Record<string, any> | null;
  now?: number;
  engineEnabled?: boolean;
  recentIntentIds?: string[];
}): { intents: Record<string, any>[]; notes: { code: string }[] };
