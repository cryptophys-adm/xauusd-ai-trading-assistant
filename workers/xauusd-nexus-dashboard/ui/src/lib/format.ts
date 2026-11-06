export const fmt = (v: unknown): string =>
  v === undefined || v === null ? "—" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);

export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function listOf(body: any, key: string): any[] {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[key])) return body[key];
  return [];
}

export function navigate(hash: string) { window.location.hash = hash; }

export function pct(x?: number | null): string {
  return x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`;
}

export function utc(iso?: string | null): string {
  if (!iso) return "—";
  return String(iso).replace("T", " ").slice(0, 16) + " UTC";
}

/** "OANDA:XAUUSD:60:<open ms>" as the bar's open time in UTC. */
export function candleWhen(key?: string | null): string {
  const ms = Number(String(key ?? "").split(":").pop());
  return Number.isFinite(ms) && ms > 0 ? utc(new Date(ms).toISOString()) : String(key ?? "—");
}
