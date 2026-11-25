export const CLOSE_RECONCILE: Readonly<{ window_ms: number; reason: string; live_lookback_ms: number; backfill_days: number; deal_lookback_ms: number; limit: number; backfill_limit: number }>;
export const CLOSE_RECONCILE_BACKFILL_KEY: string;
export const RECONCILED_FROM: string;
export interface ReconciledCloseResult { ok: true; ticket: number | null; error: null; executed_ms: number | null; fill_price: number | null; slippage_pts: null; latency_ms: number | null; reconciled: true; reconciled_from: string; deal_ticket: number | null }
export function reconcilableClose(row: unknown): boolean;
export function openedVolume(kind: unknown, payload: unknown): number | null;
export function reconciledResult(intent: unknown, deal: unknown): ReconciledCloseResult;
export function planCloseReconcile(input?: { intents?: unknown[]; deals?: unknown[]; openVolumes?: Record<string, number>; openTickets?: Set<number> | number[]; sinceMs?: number; untilMs?: number; windowMs?: number }): { matches: Array<{ id: string; ticket: number; deal_ticket: number; result: ReconciledCloseResult }>; skipped: Array<{ ticket: number; why: string }> };
export function reconcileLostCloses(db: unknown, options?: { now?: number; openTickets?: Set<number> | null; sinceMs?: number; untilMs?: number; limit?: number; log?: ((action: string, detail: Record<string, unknown>) => unknown) | null; backfill?: boolean }): Promise<{ status: string; candidates: number; reconciled: number; ids: string[]; last_created_ms?: number; error?: string }>;
export function openTicketsOf(state: unknown): Set<number> | null;
export function closeReconcileBackfill(env: unknown, options?: { now?: number }): Promise<{ status: string; candidates?: number; reconciled?: number; error?: string | null }>;
