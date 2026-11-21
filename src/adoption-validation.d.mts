export const ADOPTION_VALIDATION_VERSION: string;

export const EVIDENCE_TYPES: Readonly<{
  REALIZED_PRODUCTION: "realized_production";
  HISTORICAL_REPLAY: "historical_replay";
  SHADOW_RUNTIME: "shadow_runtime";
  MONTE_CARLO_SIMULATION: "monte_carlo_simulation";
}>;

export const EVIDENCE_DISCLAIMERS: Readonly<Record<string, string>>;

export const VALIDATION_GATES: Readonly<{
  STRATEGY_AGENT: Readonly<{ min_setups: number; min_mean_r: number; description: string }>;
  PATTERN: Readonly<{ min_setups: number; min_mean_r: number; description: string }>;
  CONSENSUS_VOICE: Readonly<{ record_min_setups: number; voice_min: number; voice_max: number; description: string }>;
  OMEGA_PARITY: Readonly<{ min_trades: number; max_abs_diff_r: number; min_direction_match: number; min_p_value: number; description: string }>;
  PLAN_LEARNER: Readonly<{
    rfc: Readonly<{ min_setups: number; min_decisive: number; holdout_share: number; holdout_min: number; margin_r: number; p_value_max: number }>;
    backlog_item_23: Readonly<{ min_setups: number; min_decisive: number }>;
    reconciliation_required: boolean;
    reconciliation_note: string;
  }>;
  SHADOW_CANDIDATE: Readonly<{ min_decisive_pairs: number; min_shared_bars: number; description: string }>;
  ROOM_QUORUM: Readonly<{ min_scored_rooms: number; description: string }>;
}>;

export const GATE_STATUSES: Readonly<{
  COLLECTING: "collecting";
  FAILED: "failed";
  PASSED_SHADOW_GATE: "passed_shadow_gate";
}>;

export const DEFAULT_GATE_RULES: Readonly<{
  min_setups: number;
  min_decisive: number;
  holdout_share: number;
  holdout_min: number;
  margin_r: number;
  p_value_max: number;
  max_drawdown_tolerance_ratio: number;
  min_opportunity_capture_rate: number;
}>;

export interface TradeMetrics {
  trades: number;
  wins: number;
  losses: number;
  even: number;
  win_rate: number | null;
  loss_rate: number | null;
  even_rate: number | null;
  avg_win_r: number | null;
  avg_loss_r: number | null;
  mean_r: number | null;
  expectancy_r: number | null;
  total_r: number | null;
  profit_factor: number | null;
  max_drawdown_r: number | null;
  equity: Array<{ id: string; t: string | null; r: number | null }>;
}

export function calculateTradeMetrics(trades?: unknown[], options?: { rKey?: string }): TradeMetrics;

export interface PairedComparison {
  paired_count: number;
  decisive_pairs: number;
  candidate_better: number;
  baseline_better: number;
  ties: number;
  net_diff_r: number | null;
  mean_diff_r: number | null;
  p_value: number | null;
  pairs: Array<Record<string, any>>;
}

export function evaluatePairedDifference(
  baselineTrades?: unknown[],
  candidateTrades?: unknown[],
  options?: { rKey?: string; tolerance?: number }
): PairedComparison;

export interface OpportunityCaptureMetrics {
  baseline_signals: number;
  candidate_signals: number;
  filtered_signals: number;
  opportunity_capture_rate: number | null;
  true_filters: number;
  false_filters: number;
  neutral_filters: number;
  filter_precision: number | null;
  avoided_loss_r: number | null;
  missed_profit_r: number | null;
  net_filter_benefit_r: number | null;
}

export function evaluateOpportunityCapture(options?: {
  baselineSignals?: unknown[] | number;
  candidateSignals?: unknown[] | number;
  filterEvaluations?: unknown[];
}): OpportunityCaptureMetrics;

export function segmentMetrics(
  trades: unknown[],
  keyExtractor: string | ((trade: any) => string)
): Record<string, TradeMetrics>;

export interface ChronologicalPartition {
  total_items: number;
  independent_count: number;
  leak_free: boolean;
  discovery: { count: number; start_ms: number | null; end_ms: number | null; items: Array<Record<string, any>> };
  holdout: { count: number; start_ms: number | null; end_ms: number | null; items: Array<Record<string, any>> };
}

export function partitionChronological(
  items?: unknown[],
  options?: { holdoutShare?: number; holdoutMin?: number; minSetups?: number }
): ChronologicalPartition;

export interface GateEvaluation {
  status: "collecting" | "failed" | "passed_shadow_gate";
  verdicts: Record<string, { pass: boolean; note: string; [key: string]: any }>;
  rules_applied: Record<string, any>;
  reconciliation_flags: string[];
}

export function evaluateValidationGates(report: Record<string, any>, options?: { rules?: Record<string, any> }): GateEvaluation;

export function generateComparisonReport(options?: {
  baseline?: Record<string, any>;
  candidate?: Record<string, any>;
  evidence_type?: string;
  window?: { start_ms?: number | null; end_ms?: number | null };
  pairs?: Array<Record<string, any>>;
  filter_evaluations?: Array<Record<string, any>>;
  costs?: { spread_points?: number; slippage_points?: number; model?: string };
  missing_data?: { missing_bars?: number; stale_bars?: number; gaps?: number };
  rules?: Record<string, any>;
  now?: number;
}): Record<string, any>;

export function formatComparisonReportMarkdown(report: Record<string, any>): string;
