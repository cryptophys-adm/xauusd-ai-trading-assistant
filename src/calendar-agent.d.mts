export const CALENDAR_AGENT_VERSION: string;
export const HORIZON: Readonly<{ before_ms: number; after_ms: number }>;
export const EVENT_RULES: ReadonlyArray<Record<string, any>>;
export function parseValue(v: unknown): number | null;
export function ruleOf(title: unknown): Record<string, any>;
export function projectEvent(e: Record<string, any>, now?: number): Record<string, any> | null;
export function calendarOutlook(events: unknown[], now?: number, options?: { impacts?: string[] }): Record<string, any>;
