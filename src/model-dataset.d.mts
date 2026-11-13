export const MODEL_DATASET_VERSION: string;
export function runModelDataset(env: unknown, options?: { now?: number }): Promise<Record<string, any> & { status: string }>;
export function readModelDatasetSummary(env: unknown): Promise<Record<string, any> | null>;
export function readModelDataset(env: unknown, options?: { since?: string; limit?: number }): Promise<Record<string, any> | null>;
