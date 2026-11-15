export const BUS_ARCHIVE_KEY: string;
export function archiveBusMessages(env: unknown): Promise<{ status: "skipped" | "absent" | "failed" | "archived"; reason?: string; [k: string]: unknown }>;
