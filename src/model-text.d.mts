export function chatMessages(lines: string[]): Array<{ role: "system" | "user"; content: string }>;
export function cleanModelText(text: string): string;
export function extractJsonObject(text: string): Record<string, unknown> | null;
export const MAX_TOKENS: Readonly<{ analyst: number; counselor: number; reasoner: number; bus_agent: number; bus_moderator: number }>;
export function extractModelText(result: unknown): string;
