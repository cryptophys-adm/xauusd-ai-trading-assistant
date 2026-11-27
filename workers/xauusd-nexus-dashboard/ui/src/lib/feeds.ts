// F4: the Data feeds page (Live › Data feeds, #/feeds; owner 2026-11-27: "tempatkan di nexus > live"). The pure model of
// the page: its one read (the Omega overview's broker.feeds, F1's feedOverview in src/feed-bridge.mjs: one row per
// data-only feed bridge, never an account amount), the tones of each feed, and its two writes, POST and DELETE
// /omega/api/feed-connection (the Omega Worker's routes, workers/xauusd-omega/src/omega.mjs: a person, same origin, JSON),
// with every code they answer. A feed's login is sealed in the browser by the seal function the page passes in (the
// Omega page's own buildEnvelope, the executor form's RSA-3072 envelope) to THAT feed's public_key and kid. The
// password is read from the form, sealed and dropped: it is never kept in state, stored, logged or put in a message.
// No React here.
import { intelGet } from "./intel";
import { whenText } from "./pmLines";

/** The page's one read (GET only, lib/intel.ts intelGet's allow-list): the Omega page's overview, every 30 s. */
export const FEEDS_READS = {
  overview: { path: "/omega/api/overview", everyMs: 30_000, chart: false }
} as const;
/** The page's two writes (POST stores a feed's login, DELETE clears it). */
export const FEED_CONNECTION_PATH = "/omega/api/feed-connection";

export const readFeeds = (): Promise<unknown> => intelGet(FEEDS_READS, "overview");

// The same rules as src/feed-bridge.mjs FEED_ID_RE and src/omega-broker.mjs KID_RE, SERVER_RE.
const FEED_ID_RE = /^[a-z0-9-]{1,24}$/;
const KID_RE = /^[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export const SERVER_RE = /^[A-Za-z0-9._ -]{1,64}$/;

export type FeedConnection = { version: number; status: "none" | "stored" | "cleared" | string; server: string | null; sealed_to_current_key: boolean; updated_ms: number | null };
export type Feed = {
  bridge_id: string;
  kid: string | null;
  public_key: string | null;
  bridge_version: string | null;
  synced_age_ms: number | null;
  fresh: boolean;
  terminal_connected: boolean;
  server: string | null;
  symbol: string | null;
  connection: FeedConnection;
  /** OS1 (#649, src/feed-stale.mjs): the age of the feed's newest bar, or null when it has sent none. */
  last_bar_age_ms: number | null;
  /** Syncing, but its bars stopped (the server's flag: it alone knows gold's trading hours). */
  content_stale: boolean;
};

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const text = (x: unknown, n = 64): string | null => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : null);

/** One row of broker.feeds, or null when it is not one (an unknown shape is left out, never shown half). */
export function feedOf(x: any): Feed | null {
  if (!x || typeof x !== "object" || typeof x.bridge_id !== "string" || !FEED_ID_RE.test(x.bridge_id)) return null;
  const c = x.connection && typeof x.connection === "object" ? x.connection : {};
  return {
    bridge_id: x.bridge_id,
    kid: typeof x.kid === "string" && KID_RE.test(x.kid) ? x.kid : null,
    public_key: typeof x.public_key === "string" && B64_RE.test(x.public_key) && x.public_key.length <= 1024 ? x.public_key : null,
    bridge_version: text(x.bridge_version, 16),
    synced_age_ms: isNum(x.synced_age_ms) && x.synced_age_ms >= 0 ? x.synced_age_ms : null,
    fresh: x.fresh === true,
    terminal_connected: x.terminal_connected === true,
    server: text(x.server),
    symbol: text(x.symbol, 32),
    connection: {
      version: Number.isInteger(c.version) && c.version > 0 ? c.version : 0,
      status: typeof c.status === "string" && c.status ? c.status.slice(0, 16) : "none",
      server: text(c.server),
      sealed_to_current_key: c.sealed_to_current_key === true,
      updated_ms: isNum(c.updated_ms) && c.updated_ms > 0 ? c.updated_ms : null
    },
    last_bar_age_ms: isNum(x.last_bar_age_ms) && x.last_bar_age_ms >= 0 ? x.last_bar_age_ms : null,
    content_stale: x.content_stale === true
  };
}

/** The overview's feeds, or null when the body carries no broker (Omega not deployed, a failed read, not_found). */
export function feedsOf(body: any): Feed[] | null {
  const broker = body && typeof body === "object" ? body.broker : null;
  if (!broker || typeof broker !== "object" || !Array.isArray(broker.feeds)) return null;
  return broker.feeds.map(feedOf).filter((f: Feed | null): f is Feed => f != null);
}

/** The owner gate: the overview's viewer.can_control, the same gate as the Omega page's broker connection form. */
export const canControlOf = (body: any): boolean => body?.viewer?.can_control === true;

/** A status tone (ok cyan, late amber, fault red, off grey); never green. */
export type StatusTone = "ok" | "late" | "fault" | "off";
export type Reading = { tone: StatusTone; label: string; text: string };

/** "12s ago", "6 min ago", "2 h ago". */
export function ageText(ms: number | null): string {
  if (!isNum(ms)) return "never";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${Math.max(1, s)}s ago`;
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Fresh (synced within 2 minutes, FEED_SEEN_MS) ok; stale late; never synced off. */
export function syncOf(f: Feed): Reading {
  if (f.synced_age_ms == null) return { tone: "off", label: "never synced", text: "never synced" };
  return f.fresh ? { tone: "ok", label: "fresh", text: `synced ${ageText(f.synced_age_ms)}` } : { tone: "late", label: "stale", text: `last sync ${ageText(f.synced_age_ms)}` };
}

/** The feed's newest bar: its age ("—" when it has sent none, never "0 s"), late while the server flags it stale. */
export function lastBarOf(f: Feed): { tone: StatusTone | null; text: string } {
  if (f.last_bar_age_ms == null) return { tone: null, text: "—" };
  return { tone: f.content_stale ? "late" : null, text: ageText(f.last_bar_age_ms) };
}

/** The bars-stopped warning's lines: the age, and the remedy (for the owner the form is below; a viewer has none). */
export function barsStoppedOf(f: Feed, canControl: boolean): { age: string; remedy: string } | null {
  if (!f.content_stale) return null;
  return { age: f.last_bar_age_ms == null ? "Last bar —" : `Last bar ${ageText(f.last_bar_age_ms)}`, remedy: canControl ? "Re-enter the feed login below." : "Re-enter the feed login." };
}

/** The feed terminal's own login to its broker, as its last sync reported it. */
export const terminalOf = (f: Feed): Reading => (f.terminal_connected ? { tone: "ok", label: "connected", text: "connected" } : { tone: "fault", label: "not connected", text: "not connected" });

/** A stored login sealed to a key the feed no longer has (it was reinstalled): it gets no login until it is set again. */
export const oldKey = (f: Feed): boolean => f.connection.status === "stored" && !f.connection.sealed_to_current_key;

/** The feed's login as Omega holds it: stored (ok), stored to an old key (late), disconnected or not set (off). */
export function loginOf(f: Feed): Reading {
  const v = f.connection.version ? ` · v${f.connection.version}` : "";
  if (f.connection.status === "stored") return oldKey(f) ? { tone: "late", label: "old key", text: `stored to an old key${v}` } : { tone: "ok", label: "stored", text: `stored${v}` };
  if (f.connection.status === "cleared") return { tone: "off", label: "disconnected", text: `disconnected${v}` };
  return { tone: "off", label: "not set", text: "not set" };
}

/** When the login was last set or cleared: "Fri 27 Nov 04:59 UTC · 11:59 GMT+7". */
export const loginWhen = (f: Feed): string => whenText(f.connection.updated_ms);

// ---------------------------------------------------------------- the writes

/** Every code the page shows after a refused write: its own checks, the Omega Worker's routes and src/feed-bridge.mjs. */
export const LOCAL_ERRORS = ["fields_required", "server_invalid", "no_feed_key", "key_check_failed", "reason_required", "network"] as const;
export const SERVER_ERRORS = [
  "feed_bridge_not_seen", "kid_mismatch", "forbidden", "access_denied", "cross_origin_refused", "content_type_must_be_json", "body_too_large",
  "invalid_json", "body must be a JSON object", "feed_unavailable", "feed_connection_failed", "omega_binding_missing", "envelope_too_large",
  "a reason is required to disconnect", "server must be 1-64 letters, digits, dot, dash, underscore or space",
  "bridge_id must be 1-24 lower-case letters, digits or dashes"
] as const;

/** The words after a refused write's code: what happened and what to do. Never any field's value. */
export function errorWords(code: string): string {
  if (code.startsWith("envelope")) return "The sealed login was malformed. Reload the page and retry.";
  switch (code) {
    case "feed_bridge_not_seen": return "The feed bridge has not synced yet. Start it on the VPS first, then retry.";
    case "kid_mismatch": return "The feed's key changed. Reload the page and retry.";
    case "fields_required": return "Fill in the login, password and server.";
    case "server_invalid":
    case "server must be 1-64 letters, digits, dot, dash, underscore or space": return "Type the server exactly as MT5 shows it (letters, digits, dot, dash, underscore or space).";
    case "no_feed_key": return "This feed has not sent its key yet. Wait for its next sync.";
    case "key_check_failed": return "The feed's key does not match its id. Reload the page and retry.";
    case "reason_required":
    case "a reason is required to disconnect": return "Write a reason to disconnect.";
    case "forbidden": return "A person makes this change, never a service token.";
    case "access_denied": return "Cloudflare Access refused the request. Sign in again.";
    case "cross_origin_refused": return "The request did not come from this page. Nothing changed.";
    case "content_type_must_be_json":
    case "body_too_large":
    case "invalid_json":
    case "body must be a JSON object":
    case "bridge_id must be 1-24 lower-case letters, digits or dashes": return "The request was malformed. Nothing changed.";
    case "feed_unavailable": return "The AI Worker has no feed bridges yet. Nothing changed.";
    case "feed_connection_failed":
    case "omega_binding_missing": return "Omega could not reach the AI Worker. Nothing changed.";
    case "network": return "No answer from Omega. Nothing changed.";
    default: return "Nothing changed.";
  }
}

export type WriteResult = { ok: true; version: number | null; server: string | null } | { ok: false; error: string };

/**
 * Pure: an answer as the page reads it (the Omega page's omegaJson rule): a 2xx without `ok: false` is done; else the
 * failure's code, its `error` (at most 120 characters) or "HTTP <status>".
 */
export function replyResult(status: number, data: any): WriteResult {
  const ok = status >= 200 && status < 300;
  if (!ok || data?.ok === false) return { ok: false, error: typeof data?.error === "string" && data.error ? data.error.slice(0, 120) : `HTTP ${status}` };
  return { ok: true, version: Number.isInteger(data?.version) ? data.version : null, server: typeof data?.server === "string" ? data.server : null };
}

/** One write: same origin, JSON (the Omega Worker refuses anything else). Never throws. */
async function write(method: "POST" | "DELETE", body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetchImpl(FEED_CONNECTION_PATH, { method, credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: "network" };
  }
  const data: any = await res.json().catch(() => ({}));
  return replyResult(res.status, data);
}

/** The form as the submit reads it: a field's value, and a reset that empties every field. */
export type FeedForm = { value(name: "login" | "password" | "server"): string; reset(): void };
/** The shared envelope code: the Omega page's buildEnvelope (RSA-OAEP SHA-256 wrapping an AES-256-GCM key). */
export type Seal = (publicKeySpkiBase64: string, kid: string, creds: { server: string; login: string; password: string }) => Promise<unknown>;

/**
 * The owner's submit of a feed's login: the fields read from the form, sealed with `seal` to THIS feed's public_key and
 * kid (never the executor bridge's), then POST { bridge_id, server, envelope }. Every field is cleared afterwards,
 * whatever the outcome. The password exists only in this call; a refusal carries a code, never a value.
 */
export async function submitFeedLogin(feed: Feed, form: FeedForm, { seal, fetchImpl = fetch }: { seal: Seal; fetchImpl?: typeof fetch }): Promise<WriteResult> {
  try {
    const login = form.value("login").trim(), password = form.value("password"), server = form.value("server").trim();
    if (!login || !password || !server) return { ok: false, error: "fields_required" };
    if (!SERVER_RE.test(server)) return { ok: false, error: "server_invalid" };
    if (!feed.public_key || !feed.kid) return { ok: false, error: "no_feed_key" };
    let envelope: unknown;
    try { envelope = await seal(feed.public_key, feed.kid, { server, login, password }); } catch { return { ok: false, error: "key_check_failed" }; }
    return await write("POST", { bridge_id: feed.bridge_id, server, envelope }, fetchImpl);
  } finally {
    form.reset();
  }
}

/** The owner's disconnect of a feed: a reason is required (refused here, before any request, without one). */
export async function disconnectFeed(feed: Pick<Feed, "bridge_id">, reason: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult> {
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (!why) return { ok: false, error: "reason_required" };
  return write("DELETE", { bridge_id: feed.bridge_id, reason: why }, fetchImpl);
}
