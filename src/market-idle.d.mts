export const IDLE_AFTER_CLOSE_MS: number;
export function marketIdleAt(env: unknown, now?: number): boolean;
export function idleHeartbeatDue(scheduledTime?: number): boolean;
