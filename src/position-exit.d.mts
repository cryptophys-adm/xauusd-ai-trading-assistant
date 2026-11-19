export const EXIT_NOTICE_MAX_AGE_MS: number;
export const EXIT_NOTICE_MAX: number;
export function omegaCloseReasonText(reason: unknown): string;
export function exitReasonText(dealReason: unknown, intentReason?: string | null, profit?: number | null): string;
export function exitDealsToAnnounce(deals?: Array<Record<string, any>>, options?: { openTickets?: unknown[]; delegated?: unknown[]; now?: number }): Array<Record<string, any>>;
export function exitFacts(d: Record<string, any>, options?: { total?: Record<string, number> | null; intentReason?: string | null }): Record<string, any>;
export function exitNoticeMessage(x: Record<string, any>, label?: string): string;
export function announceExits(db: unknown, deals: Array<Record<string, any>>, options?: { openTickets?: unknown[]; delegated?: unknown[]; now?: number; label?: string; send?: ((t: string) => Promise<unknown>) | null; log?: ((action: string, detail: unknown) => Promise<unknown>) | null }): Promise<Array<Record<string, any>>>;
