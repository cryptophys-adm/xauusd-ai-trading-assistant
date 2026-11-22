/** The server's error code as shown: at most 24 characters (mockup "Nexus data states"). */
const CODE_MAX = 24;

/**
 * A failed read, as a code: the route (no query string), the HTTP status (0 when the request never got an answer)
 * and the server's error code. Its message is the line every panel shows: "/api/ledger 502",
 * "/api/calendar 503 not_configured", "/api/ledger net" (offline).
 */
export class ApiError extends Error {
  readonly path: string;
  readonly route: string;
  readonly status: number;
  readonly code: string | null;
  /** The failed response's `Date` (server ms; fourth review of #520), null when it had none or never answered. */
  readonly date: number | null;
  constructor(path: string, status: number, code?: string | null, date: number | null = null) {
    const route = path.split("?")[0];
    const c = code ? String(code).slice(0, CODE_MAX) : null;
    super(`${route} ${status ? status : "net"}${c ? ` ${c}` : ""}`);
    this.name = "ApiError";
    this.path = path;
    this.route = route;
    this.status = status;
    this.code = c;
    this.date = date;
  }
}

/** The message of anything thrown, for a poll's `error`. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The routes whose own HTTP cache the page keeps (third review of #520): /api/ohlcv answers with max-age=30, so the
 * chart's candle reads (the price chart, Omega's terminal chart) share it instead of reading through.
 */
export const CACHED_ROUTES = ["/api/ohlcv"];

/**
 * `cache` of a get(): "no-store" for the poll and retry reads (re-review of #520: the browser holds a second GET of a
 * URL behind one in flight, its cache lock of up to ~20 s, so Retry now past a hung read would wait on it; a poll
 * wants the answer of now anyway); the browser's default for CACHED_ROUTES. An explicit `cache` wins.
 */
export type GetOptions = { cache?: RequestCache };

/** The options of a chart read (candles, the chart plane): the browser's own cache, never no-store. */
export const CHART_READ: GetOptions = { cache: "default" };

export function cacheOf(path: string, opts: GetOptions = {}): RequestCache {
  return opts.cache ?? (CACHED_ROUTES.includes(path.split("?")[0]) ? "default" : "no-store");
}

/**
 * Read-only API of the Nexus Worker: /api/ohlcv and /api/local-lane are its own RPC reads; every
 * other /api/* path is proxied to the AI Worker. Same origin, GET only: Nexus never changes state.
 * A failure throws an ApiError (above); so does a good answer that is not JSON (fifth review of #520: a captive
 * portal's or an SPA fallback's 200 HTML page is "/api/x 200 not_json", never a good read of null data).
 */
export async function get<T = any>(path: string, opts: GetOptions = {}): Promise<T> {
  return (await fetchJson<T>(path, cacheOf(path, opts))).data;
}

/** A read's answer with its response's `Date` (server ms, whole seconds; null when the response had none). */
export type Dated<T = any> = { data: T; date: number | null };

/** The base a path is resolved against where there is no page (Node tests): an origin nothing can share. */
const SAFE_BASE = "https://nexus.invalid/";

/**
 * Whether a path is on this origin (fifth review of #520): it starts with "/", carries no control character (the URL
 * parser drops tab, CR and LF, so "/\t/evil.example/x" resolves to "//evil.example/x", another origin in a browser),
 * and resolves against the page to the page's own origin (never "//host", "/\\host" or a URL).
 */
export function sameOrigin(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const here = typeof location !== "undefined" && location?.href ? location.href : SAFE_BASE;
  try {
    return new URL(path, here).origin === new URL(here).origin;
  } catch {
    return false;
  }
}

/**
 * A poll or retry read with its response's `Date` (fourth review of #520), for the server clock that ages a hub
 * replay (pollState.ts serverClock). Two rules keep that clock true:
 * - same-origin only: `Date` is not a CORS-safelisted response header, so it is readable only on this origin's
 *   /api/* (another origin throws before any request);
 * - always no-store: a cached response carries the cache's Date, so a cache hit would move the offset.
 * A failed read's ApiError carries its Date too (a 502 is still the server's clock).
 */
export async function getDated<T = any>(path: string): Promise<Dated<T>> {
  if (!sameOrigin(path)) throw new ApiError(path, 0, "cross_origin");
  return fetchJson<T>(path, "no-store");
}

async function fetchJson<T>(path: string, cache: RequestCache): Promise<Dated<T>> {
  let r: Response;
  try {
    r = await fetch(path, { headers: { accept: "application/json" }, cache });
  } catch {
    throw new ApiError(path, 0, null);
  }
  const date = httpDate(r.headers.get("date"));
  // Only a JSON content type is parsed: an HTML page (a captive portal, an SPA fallback) is never a body.
  const json = /\bjson\b/i.test(r.headers.get("content-type") ?? "");
  let body: any = null, parsed = false;
  if (json) {
    try { body = await r.json(); parsed = true; } catch { /* not JSON after all */ }
  }
  if (r.status === 404 && parsed && body && body.status === "not_found") return { data: body as T, date };
  if (!r.ok) {
    const code = body && typeof body === "object" ? (typeof body.error === "string" ? body.error : typeof body.status === "string" ? body.status : null) : null;
    throw new ApiError(path, r.status, code, date);
  }
  if (!parsed) throw new ApiError(path, r.status, "not_json", date);
  return { data: body as T, date };
}

/** A `Date` header as ms, null when missing or not a date (api.ts imports nothing, so Node tests run it). */
function httpDate(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
