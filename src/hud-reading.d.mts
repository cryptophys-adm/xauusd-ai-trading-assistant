export const HUD_READING_VERSION: string;
export const HUD_NAMES: Readonly<Record<string, string>>;
export const HUD_IDS: readonly string[];
export interface HudReading { agent_id: string; name: string; version: string; available: boolean; lines: Array<{ text: string; verified: boolean }> }
export function readHud(agentId: string, hud?: { fields?: Record<string, unknown>; verified?: string[] }): HudReading;
export function verifiedFields(hud: unknown, approvedComparable: unknown): string[];
