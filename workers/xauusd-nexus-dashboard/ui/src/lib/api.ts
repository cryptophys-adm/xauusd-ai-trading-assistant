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
  constructor(path: string, status: number, code?: string | null) {
    const route = path.split("?")[0];
    const c = code ? String(code).slice(0, CODE_MAX) : null;
    super(`${route} ${status ? status : "net"}${c ? ` ${c}` : ""}`);
    this.name = "ApiError";
    this.path = path;
    this.route = route;
    this.status = status;
    this.code = c;
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
 * A failure throws an ApiError (above).
 */
export async function get<T = any>(path: string, opts: GetOptions = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { headers: { accept: "application/json" }, cache: cacheOf(path, opts) });
  } catch {
    throw new ApiError(path, 0, null);
  }
  const body = await r.json().catch(() => null);
  if (r.status === 404 && body && body.status === "not_found") return body as T;
  if (!r.ok) {
    const code = body && typeof body === "object" ? (typeof body.error === "string" ? body.error : typeof body.status === "string" ? body.status : null) : null;
    throw new ApiError(path, r.status, code);
  }
  return body as T;
}
