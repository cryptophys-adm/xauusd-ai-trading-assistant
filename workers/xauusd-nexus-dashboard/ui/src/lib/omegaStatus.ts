// OS1: the Omega page's two new status lines, as pure, null-safe reads of the Omega overview (GET /omega/api/overview)
// and of the connection Save's answer (POST /omega/api/connection). No React here.
//   - The server check (#650, src/server-check.mjs serverCheck and the overview's broker.server_check): null with no
//     stored connection, else { status: ok | pending | not_seen | disconnected, message?, did_you_mean? }. The hint
//     did_you_mean is shown exactly as the API sends it (no trim, no case change): it differs from the typed name only
//     in case, spaces, hyphens or underscores, so those are the point.
//   - The Save warning (setConnection in src/omega-broker.mjs): warning { code: "server_name_near_match", did_you_mean,
//     message }; the connection is saved all the same.
//   - The recovery hold (#647, src/recovery-hold.mjs heldDetail, the overview's broker.autonomous_watchdog.last_recovery):
//     status "held" with dispatches, conn_version, message and optionally cause "server_not_seen".
// Every text from the API is kept as text (React escapes it); nothing here builds markup.
import type { StatusTone } from "./feeds";

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** A backend sentence: a non-empty string, at most `n` characters (trimmed for display only). */
const sentence = (x: unknown, n = 400): string | null => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : null);
/** A server name exactly as sent (src/omega-broker.mjs SERVER_RE: 1-64 letters, digits, dot, dash, underscore or space). */
const SERVER_NAME_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const serverName = (x: unknown): string | null => (typeof x === "string" && SERVER_NAME_RE.test(x) && x.trim() ? x : null);

// ---------------------------------------------------------------- the server check

export type ServerCheckStatus = "ok" | "pending" | "not_seen" | "disconnected";
export type ServerCheck = { status: ServerCheckStatus; message: string | null; didYouMean: string | null };
const STATUSES: readonly ServerCheckStatus[] = ["ok", "pending", "not_seen", "disconnected"];

/** The overview's broker.server_check, or null (no stored connection, an unknown status, a body without a broker). */
export function serverCheckOf(body: any): ServerCheck | null {
  const sc = body?.broker?.server_check;
  if (!sc || typeof sc !== "object" || !STATUSES.includes(sc.status)) return null;
  const status = sc.status as ServerCheckStatus;
  return {
    status,
    message: status === "not_seen" ? sentence(sc.message) : null,
    // The hint is the Omega page's only, and only beside not_seen (the overview sends it nowhere else).
    didYouMean: status === "not_seen" ? serverName(sc.did_you_mean) : null
  };
}

export type ServerCheckReading = { tone: StatusTone; label: string; text: string };

/** The line's chip and words: ok cyan, pending amber, not_seen red, disconnected grey (no "check the name" there). */
export function serverCheckReading(sc: ServerCheck): ServerCheckReading {
  switch (sc.status) {
    case "ok": return { tone: "ok", label: "server seen", text: "Logged in on the exact stored server name." };
    case "pending": return { tone: "late", label: "checking server", text: "Waiting for the terminal's first login on this name." };
    case "disconnected": return { tone: "off", label: "disconnected", text: "Logged in on this name before; not connected now." };
    default: return { tone: "fault", label: "server not seen", text: sc.message ?? "The terminal has not logged into this exact server name." };
  }
}

export const SERVER_CHECK_HINT = "Only a login on the exact stored server name counts: the terminal reports the typed name even while it is not connected. Five minutes after a connection is entered without one, the server is not seen. Once it has been seen, a later disconnect is only disconnected.";

// ---------------------------------------------------------------- the Save's answer

export type SaveWarning = { message: string | null; didYouMean: string | null };

/** The Save's near-match warning, or null. The connection is saved either way. */
export function saveWarningOf(reply: any): SaveWarning | null {
  const w = reply?.warning;
  if (!w || typeof w !== "object" || w.code !== "server_name_near_match") return null;
  return { message: sentence(w.message), didYouMean: serverName(w.did_you_mean) };
}

/** The Save's success line (the page's own words, unchanged by OS1). */
export function savedText(reply: any): string {
  const v = Number.isInteger(reply?.version) ? `v${reply.version}` : "";
  const server = typeof reply?.server === "string" && reply.server ? ` for ${reply.server}` : "";
  const sym = typeof reply?.trade_symbol === "string" && reply.trade_symbol ? ` (gold symbol ${reply.trade_symbol})` : "";
  return `Saved${v ? ` ${v}` : ""}${server}${sym}; applied at next bridge sync.`;
}

/** The connection form's message: its tone class, its words, and on a saved near match the warning. */
export type ConnectionMsg = { tone: string; text: string; warning?: SaveWarning | null };

/** The message after a successful Save. */
export const savedMsg = (reply: any): ConnectionMsg => ({ tone: "text-ok", text: savedText(reply), warning: saveWarningOf(reply) });

// ---------------------------------------------------------------- the recovery hold

export type RecoveryHeld = { ms: number | null; message: string | null; dispatches: number | null; connVersion: number | null; serverNotSeen: boolean };

/** The watchdog's last recovery when it is a hold, or null (none, a dispatch, an unknown shape). */
export function recoveryHeldOf(body: any): RecoveryHeld | null {
  const r = body?.broker?.autonomous_watchdog?.last_recovery;
  if (!r || typeof r !== "object" || r.status !== "held") return null;
  return {
    ms: isNum(r.ms) && r.ms > 0 ? r.ms : null,
    message: sentence(r.message),
    dispatches: Number.isInteger(r.dispatches) && r.dispatches >= 0 ? r.dispatches : null,
    connVersion: Number.isInteger(r.conn_version) && r.conn_version > 0 ? r.conn_version : null,
    serverNotSeen: r.cause === "server_not_seen"
  };
}

/** The hold's facts after its message: "3 dispatches · connection v2 · server not seen". */
export function recoveryHeldFacts(h: RecoveryHeld): string[] {
  return [
    h.dispatches != null ? `${h.dispatches} ${h.dispatches === 1 ? "dispatch" : "dispatches"}` : null,
    h.connVersion != null ? `connection v${h.connVersion}` : null,
    h.serverNotSeen ? "server not seen" : null
  ].filter((x): x is string => x != null);
}

export const RECOVERY_HELD_HINT = "Cerebrum stopped restarting the terminal after 3 restarts that did not reconnect. It resumes on a new connection or once the terminal is healthy again.";
