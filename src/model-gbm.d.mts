export const MODEL_GBM_VERSION: string;
export function readGbm(env: unknown, options?: { now?: number }): Promise<Record<string, any> | null>;
export function gbmStatus(gbm: unknown, prospective?: unknown): Record<string, any> | null;
