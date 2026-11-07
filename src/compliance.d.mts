export const COMPLIANCE_VERSION: string;
export function runComplianceChecks(env: unknown, options?: { now?: number; limit?: number }): Promise<Record<string, unknown>>;
export function readCompliance(env: unknown, options?: { days?: number; now?: number }): Promise<Record<string, unknown>>;
