// Wrong server name (orchestrator 2026-11-27, brief A; incident: the owner saved "Monex-Live-2", the broker's server is
// "Monex-Live 2", and the terminal never logged in while it echoed the typed name in its state). The terminal reports
// the server name it was configured with even while disconnected, so a state naming the stored server is no proof of a
// login: only `connected === true` with the exact stored name is. Five minutes after a connection is entered without
// that, the connection is "not_seen": the Omega overview says so, one `server_not_seen` event goes to the Cerebrum
// Telegram (src/ea-heartbeat-relay.mjs; the name the owner typed only) and the recovery hold (src/recovery-hold.mjs)
// names this cause. It clears on the same condition. A near-match hint compares the typed name with names the terminal
// has reported before (accounts seen), folding case, spaces, hyphens and underscores only: a warning, never a refusal
// (the name may be new). Pure; no I/O.

export const SERVER_SEEN_WAIT_MS = 5 * 60_000;

/** Pure: a server name folded for comparison (case, spaces, hyphens and underscores; nothing else). */
export function foldServerName(name) {
  return String(name ?? "").toLowerCase().replace(/[\s\-_]+/g, "");
}

/** Pure: a known name that folds to the typed one but is not it exactly, or null. */
export function nearMatch(typed, known = []) {
  const t = String(typed ?? "").trim();
  const f = foldServerName(t);
  if (!f) return null;
  for (const k of Array.isArray(known) ? known : []) {
    const name = String(k ?? "").trim();
    if (name && name !== t && foldServerName(name) === f) return name;
  }
  return null;
}

/**
 * Pure: whether the terminal has logged into the stored server. `conn`: { status, server, updated_ms }.
 * Returns null (no stored connection), { status: "ok" }, { status: "pending" } (under SERVER_SEEN_WAIT_MS) or
 * { status: "not_seen", message }.
 */
export function serverCheck({ conn, executor, now }) {
  if (conn?.status !== "stored" || !conn?.server) return null;
  if (executor?.connected === true && String(executor?.server ?? "") === String(conn.server)) return { status: "ok" };
  const since = Number(conn.updated_ms);
  if (!Number.isFinite(since) || now - since < SERVER_SEEN_WAIT_MS) return { status: "pending" };
  return { status: "not_seen", message: notSeenMessage(conn.server) };
}

export function notSeenMessage(server) {
  return `The terminal has not logged into a server named exactly '${String(server)}'. Check spaces, hyphens and case, then enter the connection again.`;
}
