export const NEWS_LOOKBACK_MS = 60 * 60 * 1000;

const PUBLISHED_FIELDS = ["published_at", "publishedAt", "published", "pubDate", "published_date", "publishedDate", "datetime", "date", "time"];
const URL_FIELDS = ["url", "link", "canonical_url", "canonicalUrl"];
const ID_FIELDS = ["id", "uuid", "article_id", "articleId"];
const TITLE_FIELDS = ["title", "headline"];

function parsePublishedAt(article) {
  for (const field of PUBLISHED_FIELDS) {
    const value = article?.[field];
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const parsed = value < 1e12 ? value * 1000 : value;
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    url.hash = "";
    const queryEntries = [];
    url.searchParams.forEach((itemValue, key) => {
      if (!/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) queryEntries.push([key, itemValue]);
    });
    queryEntries.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    url.hostname = url.hostname.toLowerCase();
    url.search = new URLSearchParams(queryEntries).toString();
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().toLowerCase().replace(/#.*$/, "");
  }
}

function articleIdentity(article, publishedAt) {
  for (const field of URL_FIELDS) {
    const normalized = normalizeUrl(article[field]);
    if (normalized) return "url:" + normalized;
  }
  for (const field of ID_FIELDS) {
    const value = article[field];
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) return "id:" + normalized;
    }
  }
  for (const field of TITLE_FIELDS) {
    const value = article[field];
    if (typeof value === "string" && value.trim()) {
      return "title:" + value.trim().toLowerCase().replace(/\s+/g, " ") + ":" + publishedAt;
    }
  }
  return "content:" + JSON.stringify(article);
}

/**
 * Fail-closed news gate: only timestamped articles published in the preceding
 * hour are retained, and duplicates are removed before they reach Workers AI.
 * Missing or unparseable publication timestamps are not treated as fresh.
 */
export function filterRecentUniqueArticles(articles, now = Date.now(), maxAgeMs = NEWS_LOOKBACK_MS) {
  if (!Array.isArray(articles)) return [];
  const seen = new Set();
  const result = [];
  for (const article of articles) {
    if (!article || typeof article !== "object" || Array.isArray(article)) continue;
    const publishedAt = parsePublishedAt(article);
    if (publishedAt === null || publishedAt > now || now - publishedAt > maxAgeMs) continue;
    const identity = articleIdentity(article, publishedAt);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(article);
  }
  return result;
}
