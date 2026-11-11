export type WitnessKey =
  | "D1"
  | "H4"
  | "H1"
  | "M15"
  | "NEWS"
  | "MACRO"
  | "STRATEGY"
  | "KEY_LEVELS"
  | "REGIME"
  | "TREND_TF"
  | "MACRO_DRIVERS"
  | "SESSION";

export const WITNESS_KEYS: readonly WitnessKey[];
export const WITNESS_PRIORS: Readonly<Record<WitnessKey, number>>;
export const WITNESS_MIN_WEIGHT: number;
export const WITNESS_MAX_WEIGHT: number;
export const WITNESS_WEIGHTS_KV_KEY: string;

export function validateWitnessWeights(weights: unknown): {
  valid: boolean;
  errors: string[];
  normalised: Record<WitnessKey, number>;
};

export function deriveWitnessWeights(options?: {
  basePriors?: Record<string, number>;
  regime?: any;
  analytics?: any;
  witnessScores?: any;
}): Record<WitnessKey, number>;

export function resolveActiveWitnessWeights(env?: any): Promise<Record<WitnessKey, number>>;
