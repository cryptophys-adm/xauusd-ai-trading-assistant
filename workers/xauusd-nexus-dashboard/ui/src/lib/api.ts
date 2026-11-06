/**
 * Read-only API of the Nexus Worker: /api/ohlcv and /api/local-lane are its own RPC reads; every
 * other /api/* path is proxied to the AI Worker. Same origin, GET only: Nexus never changes state.
 */
export async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  const body = await r.json().catch(() => null);
  if (r.status === 404 && body && body.status === "not_found") return body as T;
  if (!r.ok) throw new Error((body && (body.error || body.status)) || `HTTP ${r.status}`);
  return body as T;
}
