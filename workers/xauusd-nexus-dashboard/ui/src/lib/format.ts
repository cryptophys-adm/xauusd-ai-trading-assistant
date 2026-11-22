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

/** Trading and system acronyms that stay in capitals in a label made from a key (codes as written). */
const ACRONYMS = new Set(["atr", "mfe", "mae", "sl", "tp", "tv", "ev", "r", "pf", "dd", "ema", "vwap", "poc", "vah", "val", "kww", "utc", "ea", "id"]);

/**
 * A snake_case key as a sentence-case label: "mfe_r" → "MFE R", "entry_shift_atr" → "Entry shift ATR",
 * "tp_moves" → "TP moves". Acronyms (also with a number: "tp1", "ema114") and timeframes ("h1", "m15") stay in
 * capitals, since .tbl th, .label, .chip and .eyebrow no longer upper-case their text.
 */
export function humanKey(k: string): string {
  const words = String(k).replace(/_/g, " ").split(" ").map((w) => {
    const m = /^([a-z]+)(\d*)$/i.exec(w);
    if (!m) return w;
    const head = m[1].toLowerCase();
    return ACRONYMS.has(head) || (m[2] && /^[mhdw]$/.test(head)) ? w.toUpperCase() : w;
  });
  return words.join(" ").replace(/^./, (c) => c.toUpperCase());
}
