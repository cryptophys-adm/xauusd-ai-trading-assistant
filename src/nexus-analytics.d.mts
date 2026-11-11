export const NEXUS_ANALYTICS_VERSION: string;

export function computeDisparityMetrics(options?: { bridge?: unknown; intents?: any[]; ledger?: any[] }): Record<string, any>;
export function computeScorecardsMetrics(options?: { cards?: any[]; stuck?: any[]; compliance?: unknown }): Record<string, any>;
export function computeShadowMetrics(options?: { shadow?: unknown; knowledge?: unknown }): Record<string, any>;
export function computeRegimeMetrics(options?: { regime?: unknown }): Record<string, any>;
export function deriveQuorumWeightingInput(options: { disparity?: any; scorecards?: any; shadow?: any; regime?: any; baseQuorumShare?: number }): Record<string, any>;

export function collectNexusAnalytics(env: unknown, options?: { now?: number; days?: number }): Promise<Record<string, any>>;
