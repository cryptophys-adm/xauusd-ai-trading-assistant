export const MODEL_GBM_VERSION: string;
export function readGbm(env: unknown, options?: { now?: number }): Promise<Record<string, any> | null>;
export function gbmStatus(gbm: unknown, prospective?: unknown, promotion?: unknown): Record<string, any> | null;
export function gbmReport(gbm: unknown, prospective?: unknown): Record<string, any> | null;
export const MODEL_GBM_PROMOTION_KEY: string;
export function readGbmPromotion(env: unknown): Promise<Record<string, any> | null>;
export function modelGbmConnectMode(env: unknown): "on" | "off";
