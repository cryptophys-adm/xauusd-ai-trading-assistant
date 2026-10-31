const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
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
  async fetch(request, env) {
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

    const query = [
      '"gold price"',
      'XAUUSD',
      'Federal Reserve OR Fed rates',
      'US inflation OR CPI',
      'Treasury yields OR US dollar',
      'geopolitical risk OR central bank gold'
    ].join(" OR ");

    const params = new URLSearchParams({
      query,
      mode: "ArtList",
      format: "json",
      maxrecords: "25",
      sort: "HybridRel",
      timespan: "24h"
    });

    try {
      const response = await fetch("https://api.gdeltproject.org/api/v2/doc/doc?" + params.toString(), {
        headers: { "accept": "application/json", "user-agent": "XAUUSD-Fundamental-News-Ingestion/1.0" },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        return json({
          error: "GDELT request failed",
          upstream_status: response.status
        }, 502);
      }

      const payload = await response.json();
      const articles = Array.isArray(payload.articles) ? payload.articles.map(normalizeArticle) : [];

      return json({
        worker: "xauusd-fundamental-news-ingestion",
        provider: "GDELT DOC API",
        fetched_at: new Date().toISOString(),
        count: articles.length,
        articles
      });
    } catch (error) {
      return json({
        error: "News ingestion request failed",
        detail: error instanceof Error ? error.message : "Unknown error"
      }, 502);
    }
  }
};
