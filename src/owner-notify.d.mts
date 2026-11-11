export const OWNER_NOTIFY_MAX_PER_HOUR: number;
export function ownerNoticeText(input: unknown): string | null;
export function notifyOwner(env: any, input: unknown, options: { now?: number; send: (text: string) => Promise<void> }): Promise<{ sent: boolean; reason?: string }>;
