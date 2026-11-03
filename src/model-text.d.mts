export function chatMessages(lines: string[]): Array<{ role: "system" | "user"; content: string }>;
export function cleanModelText(text: string): string;
export function extractJsonObject(text: string): Record<string, unknown> | null;
