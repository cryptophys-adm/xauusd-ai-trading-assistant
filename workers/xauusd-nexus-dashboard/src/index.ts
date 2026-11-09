/**
 * xauusd-nexus-dashboard (nexus.cryptophys.work)
 *
 * Serves the Nexus UI, a React SPA in the Cerebrum Console obsidian design (ui/, built into
 * ui/dist and served as Workers Static Assets), plus read-only data routes:
 *   GET /api/ohlcv       closed TradingView bars via the MarketDataReader RPC (no secret, no MCP call)
 *   GET /api/local-lane  read-only diagnostics of the pull adapter
 *   GET /api/aether/overview  Aether's read-only overview, via its AetherReader RPC (the Aether page)
 *   GET /aether          the SPA's Aether page (owner 2026-11-09: nexus.cryptophys.work/aether, behind
 *                        the same Cloudflare Access sign-in as the rest of Nexus)
 *   GET /api/*           everything else is proxied to the AI Worker's read-only dashboard API, over the
 *                        AI_WORKER Service Binding (never the public internet, so the AI Worker's /api
 *                        can sit behind Cloudflare Access without breaking Nexus)
 * Nexus never changes state: advisory only, no orders.
 */

/** Host of the proxied requests; the AI_WORKER binding delivers them without leaving Cloudflare. */
const AI_WORKER_BASE = "https://ai.cryptophys.work";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

interface MarketDataReader {
  candles(options: { timeframe?: string; limit?: number }): Promise<{ status: number; body: unknown }>;
  diagnostics(): Promise<{ status: number; body: unknown }>;
}
interface AetherReader {
  overview(): Promise<unknown>;
}
interface Env {
  MARKET_DATA?: MarketDataReader;
  AETHER?: AetherReader;
  AI_WORKER?: { fetch(request: Request): Promise<Response> };
  OMEGA_PAGE?: { fetch(request: Request): Promise<Response> };
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/ohlcv") {
      if (typeof env.MARKET_DATA?.candles !== "function") return json({ error: "market_data_binding_missing" }, 503);
      try {
        const { status, body } = await env.MARKET_DATA.candles({
          timeframe: url.searchParams.get("timeframe") || "H1",
          limit: Number(url.searchParams.get("limit") || "300")
        });
        return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, "cache-control": "public, max-age=30" } });
      } catch {
        return json({ error: "market_data_unavailable" }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/local-lane") {
      if (typeof env.MARKET_DATA?.diagnostics !== "function") return json({ error: "market_data_binding_missing" }, 503);
      try {
        const { status, body } = await env.MARKET_DATA.diagnostics();
        return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, "cache-control": "no-store" } });
      } catch {
        return json({ error: "market_data_diagnostics_failed" }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/aether/overview") {
      if (typeof env.AETHER?.overview !== "function") return json({ error: "aether_binding_missing" }, 503);
      try {
        return new Response(JSON.stringify(await env.AETHER.overview()), { status: 200, headers: { ...JSON_HEADERS, "cache-control": "no-store" } });
      } catch {
        return json({ error: "aether_unavailable" }, 502);
      }
    }

    if (url.pathname === "/omega" || url.pathname.startsWith("/omega/")) {
      if (typeof env.OMEGA_PAGE?.fetch !== "function") return json({ error: "omega_binding_missing" }, 503);
      return env.OMEGA_PAGE.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      // Read-only: only GET and HEAD reach the AI Worker from Nexus.
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
      if (typeof env.AI_WORKER?.fetch !== "function") return json({ error: "ai_worker_binding_missing" }, 503);
      try {
        const r = await env.AI_WORKER.fetch(new Request(AI_WORKER_BASE + url.pathname + url.search, { method: request.method, headers: { accept: "application/json" } }));
        const headers = new Headers(r.headers);
        headers.set("access-control-allow-origin", "*");
        return new Response(r.body, { status: r.status, headers });
      } catch {
        return json({ error: "proxy_failed" }, 502);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "*" } });
    }

    // Earlier page paths now live in the SPA.
    if (url.pathname === "/shadow") return Response.redirect(url.origin + "/#/shadow", 302);
    if (url.pathname === "/dashboard") return Response.redirect(url.origin + "/", 302);

    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      // Page paths of the SPA (no hash): the shell; the app reads the path.
      const shell = url.pathname === "/aether" || url.pathname === "/aether/";
      const res = await env.ASSETS.fetch(shell ? new Request(url.origin + "/", { method: request.method, headers: request.headers }) : request);
      const headers = new Headers(res.headers);
      // Hashed bundles are immutable; the HTML shell is always revalidated.
      headers.set("cache-control", url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "strict-origin-when-cross-origin");
      return new Response(res.body, { status: res.status, headers });
    }

    return json({ error: "Not found", endpoints: ["GET /", "GET /#/shadow", "GET /aether", "GET /api/ohlcv", "GET /api/local-lane", "GET /api/aether/overview", "GET /api/*"] }, 404);
  }
};
