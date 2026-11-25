import type { FeatureSwitchEntry, FeatureSwitchRow } from "./feature-switches.mjs";
export function resetFeatureSwitchMemoForTests(): void;
export function readOverridesRaw(kv: unknown, opts?: { now?: number; fresh?: boolean }): Promise<{ ok: boolean; raw: string | null }>;
export function withFeatureSwitches<T>(env: T, opts?: { now?: number }): Promise<T>;
export function featureSwitchesPayload(env: unknown, opts?: { now?: number; canControl?: boolean }): Promise<{
  version: string; at: string; viewer: { can_control: boolean }; groups: Array<{ id: string; label: string }>; switches: FeatureSwitchRow[];
}>;
export function featureSwitchLine(e: FeatureSwitchEntry, before: Partial<FeatureSwitchRow> | null, after: FeatureSwitchRow, opts?: { reset?: boolean }): string;
export function setFeatureSwitch(env: unknown, input?: { key?: unknown; value?: unknown; reset?: boolean; actor?: string; actor_sub?: string | null; now?: number; send?: ((t: string) => Promise<unknown>) | null }): Promise<{
  ok: boolean; error?: string; detail?: string; switch?: FeatureSwitchRow; changed?: boolean; audit?: string; veto?: { force: string; rule: string; source: string };
}>;
