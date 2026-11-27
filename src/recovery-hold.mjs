// Recovery backoff (orchestrator 2026-11-27, after 20 terminal restarts in an hour on a server name the terminal did
// not know: "Monex-Live-2" for "Monex-Live 2"). Cerebrum's watchdog (src/omega-broker.mjs) dispatched
// `restart_terminal` every 3 minutes for as long as the terminal stayed disconnected, with no end. Now, after
// RECOVERY_RESTART_CAP consecutive `restart_terminal` dispatches on the same connection version with no connected
// terminal in between, it stops: it records one `autonomous_recovery` event with status "held" (relayed once to the
// Cerebrum Telegram by src/ea-heartbeat-relay.mjs, shown as the Omega overview's last_recovery) and answers each sync
// with the directive "hold" instead of a restart. Bridge 1.7.0+ hands any directive to its recovery handler, which
// throttles it like a restart (once per 3 minutes: an Escape key on the terminal's display and the ini's trading
// switches checked) and restarts the terminal only for restart_terminal or remediate_algo_trading; and a sync that
// carries a directive skips the bridge's own local restart. So the server side stops the restarts on its own. It
// re-arms on a new connection version (the owner enters the connection again) or once the terminal reports
// connected (event `terminal_connected`).
// Pure; no I/O.

export const RECOVERY_RESTART_CAP = 3;
export const HOLD_DIRECTIVE = "hold";
export const HOLD_REASON = "recovery_held";

const parse = (s) => { if (s && typeof s === "object") return s; try { return JSON.parse(s); } catch { return null; } };

/**
 * Pure: whether the watchdog holds instead of dispatching another restart.
 * `recent`: the newest cerebrum `autonomous_recovery` rows ({ ms, detail }), newest first (a few are enough).
 * `connVersion`: the stored connection's version. `connectedMs`: when the terminal last reported connected (or 0).
 * Returns { hold, recorded, streak }: hold = no more restarts; recorded = the "held" event already exists.
 */
export function recoveryHold({ recent = [], connVersion, connectedMs = 0, cap = RECOVERY_RESTART_CAP } = {}) {
  const v = Number(connVersion);
  if (!Number.isFinite(v)) return { hold: false, recorded: false, streak: 0 };
  let streak = 0;
  for (const row of Array.isArray(recent) ? recent : []) {
    const d = parse(row?.detail) || {};
    const ms = Number(row?.ms);
    if (!Number.isFinite(ms) || ms <= Number(connectedMs || 0) || Number(d.conn_version) !== v) break;
    if (d.status === "held") return { hold: true, recorded: true, streak: Number(d.dispatches) || cap };
    if (d.status !== "dispatched" || d.directive !== "restart_terminal") break;
    streak += 1;
  }
  return { hold: streak >= cap, recorded: false, streak };
}

/** Pure: the "held" event's detail (no server name, no login: the connection version and the count only). */
export function heldDetail({ connVersion, streak, reason }) {
  return {
    directive: "restart_terminal",
    reason: String(reason || "terminal_disconnected"),
    status: "held",
    conn_version: Number(connVersion),
    dispatches: Number(streak),
    action_id: `hold:${Number(connVersion)}`,
    message: `${Number(streak)} terminal restarts did not reconnect; no more restarts until the connection is entered again or the terminal connects. Check the server name exactly (spaces, hyphens, case).`
  };
}

/** Pure: the directive a held sync answers (the bridge throttles it and restarts nothing). */
export function holdRecovery(connVersion) {
  return { directive: HOLD_DIRECTIVE, reason: HOLD_REASON, action_id: `hold:${Number(connVersion)}` };
}
