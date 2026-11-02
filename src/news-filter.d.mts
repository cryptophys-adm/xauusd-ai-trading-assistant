export const NEWS_LOOKBACK_MS: number;
export function filterRecentUniqueArticles(
  articles: unknown,
  now?: number,
  maxAgeMs?: number
): unknown[];
