export const BROKER_TRIGGER_KEY: string;
export const BROKER_TRIGGER_FRESH_MS: number;
export const BROKER_TRIGGER_WINDOW_BARS: number;
export function exec5mMode(env: unknown): "on" | "off";
export function triggerFrom(p: unknown, now?: number): Record<string, any> | null;
export function storeBrokerTrigger(env: unknown, payload: unknown, options?: { now?: number }): Promise<Record<string, any>>;
export function readBrokerTrigger(env: unknown, options?: { now?: number }): Promise<{ latest: Record<string, any>; recent: Array<Record<string, any>> } | null>;
export function brokerTriggerFields(broker: unknown): Record<string, any>;
