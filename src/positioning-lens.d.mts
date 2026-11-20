export function runCotStep(env: unknown, options?: { now?: number; fetchImpl?: unknown }): Promise<Record<string, any>>;
export function positioningNow(env: unknown, options?: { now?: number; knobs?: Record<string, unknown> }): Promise<Record<string, any> | null>;
export function cotFreshness(env: unknown, options?: { now?: number }): Promise<Record<string, any>>;
