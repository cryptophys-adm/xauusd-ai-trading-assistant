const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function getBearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function normalizeArticle(item) {
  return {
    title: item.title || "",
    url: item.url || "",
    domain: item.domain || "",
    language: item.language || "",
    published_at: item.seendate || "",
    source_country: item.sourcecountry || ""
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        worker: "xauusd-fundamental-news-ingestion",
        status: "ok",
        provider: "GDELT DOC API",
        auth_configured: Boolean(env.INGEST_SECRET)
      });
    }

    if (url.pathname !== "/pull" || request.method !== "POST") {
      return json({ error: "Not found", endpoints: ["GET /health", "POST /pull"] }, 404);
    }

    if (!env.INGEST_SECRET) {
      return json({ error: "INGEST_SECRET is not configured" }, 503);
    }

    if (getBearer(request) !== env.INGEST_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Cache successful upstream results briefly to reduce GDELT request volume.
    const cacheKey = new Request(new URL("/_internal/gdelt-cache", url.origin).toString(), { method: "GET" });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      return json({ ...payload, cache: "hit" }, 200, { "cache-control": "no-store" });
    }

    // Keep the query focused and the requested result count small.
    const query = '("gold price" OR XAUUSD OR "Federal Reserve" OR "US inflation" OR "Treasury yields")';
    const params = new URLSearchParams({
      query,
      mode: "ArtList",
      format: "json",
      maxrecords: "10",
      sort: "HybridRel",
      timespan: "24h"
    });

    try {
      const response = await fetch("https://api.gdeltproject.org/api/v2/doc/doc?" + params.toString(), {
        headers: {
          "accept": "application/json",
          "user-agent": "XAUUSD-Fundamental-News-Ingestion/1.1"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (response.status === 429) {
        return json({
          error: "GDELT rate limit reached",
          upstream_status: 429,
          hint: "Wait before retrying. Successful results are cached for 5 minutes to reduce upstream requests."
        }, 503, { "retry-after": "60" });
      }

      if (!response.ok) {
        return json({
          error: "GDELT request failed",
          upstream_status: response.status
        }, 502);
      }

      const payload = await response.json();
      const articles = Array.isArray(payload.articles) ? payload.articles.map(normalizeArticle) : [];
      const result = {
        worker: "xauusd-fundamental-news-ingestion",
        provider: "GDELT DOC API",
        fetched_at: new Date().toISOString(),
        count: articles.length,
        articles
      };

      const cacheResponse = new Response(JSON.stringify(result), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300"
        }
      });
      ctx.waitUntil(cache.put(cacheKey, cacheResponse));
      return json({ ...result, cache: "miss" });
    } catch (error) {
      return json({
        error: "News ingestion request failed",
        detail: error instanceof Error ? error.message : "Unknown error"
      }, 502);
    }
  }
};
