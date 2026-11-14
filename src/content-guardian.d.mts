export const CONTENT_GUARDIAN_VERSION: string;
export const CONTENT_CHECKS: readonly string[];
export function checkContentDraft(input?: { text?: string; chart?: boolean; decisionTimes?: string[]; delayHours?: number; allowLevels?: boolean; now?: number }): { version: string; pass: boolean; failures: { check: string; detail: string }[] };
