// The Omega status cell of this page, the same rules as the Nexus header (workers/xauusd-nexus-dashboard/ui/src/
// lib/headerStatus.ts, omegaCell and clockParts). This page has no build step, so it is a plain-JS copy;
// test/omega-page-status.test.mjs runs both copies over the same cases so they cannot drift.
// Tones: ok cyan, late amber, fault red, off grey; green stays for bullish only.

const p2 = (n) => String(n).padStart(2, "0");

/** The cell from GET ./api/status (null when unreadable). */
export function omegaCell(s) {
  if (!s) return { code: "—", detail: null, tone: "off", title: "Omega status could not be read", positions: null, broker: null, filled: false };
  const broker = s.connected ? s.broker || null : null;
  const pos = s.positions > 0 ? s.positions : null;
  const why = s.control_reason ? ` (${s.control_reason})` : "";
  const acct = s.account_mode ? `, ${s.account_mode} account` : "";
  if (s.control_mode === "killed") return { code: "KILLED", detail: null, tone: "fault", title: `Omega killed${why}`, positions: pos, broker, filled: true };
  if (s.control_mode === "paused") return { code: "PAUSED", detail: null, tone: "late", title: `Omega paused${why}`, positions: pos, broker, filled: true };
  const engineOn = s.armed && s.engine_enabled !== false;
  if (engineOn && s.limit_fault?.why === "no_ticket") return { code: "MKT", detail: null, tone: "late", title: "Limit entries stopped, entering at market: the EA answered without a ticket; until you save the Omega settings", positions: pos, broker, filled: true };
  if (engineOn && s.limit_fault) return { code: "STOP", detail: null, tone: "fault", title: s.limit_fault.why === "no_answer" ? "No new entries: a limit the EA never answered; until the EA answers or you save the Omega settings" : `No new entries: limit fault (${s.limit_fault.why}); until you save the Omega settings`, positions: pos, broker, filled: true };
  if (engineOn && !s.connected) return { code: "NO BRIDGE", detail: null, tone: "fault", title: "Omega engine on, but the bridge is not connected", positions: null, broker: null, filled: true };
  if (engineOn) {
    const armed = s.live_armed === true || s.account_mode === "demo";
    return armed
      ? { code: "ARMED", detail: null, tone: "ok", title: `Engine on, bridge connected${acct}${s.live_armed ? ", LIVE armed" : ""}`, positions: s.positions, broker, filled: true }
      : { code: "ON", detail: null, tone: "late", title: s.account_mode === "real" ? "Engine on, real account not LIVE armed" : "Engine on; the live arm is not known", positions: s.positions, broker, filled: false };
  }
  const offWhy = s.armed && s.engine_enabled === false ? " (OMEGA_ENGINE_ENABLED off)" : "";
  if (s.connected) return { code: "READY", detail: null, tone: "ok", title: `Bridge connected, Omega engine off${offWhy}`, positions: pos, broker, filled: false };
  return { code: "OFF", detail: null, tone: "off", title: `Bridge not connected, Omega engine off${offWhy}`, positions: null, broker: null, filled: false };
}

/** The status read, validated the way the Nexus header reads it (lib/omega.ts). */
export function readStatus(d) {
  if (!d || typeof d !== "object") return null;
  const mode = ["active", "paused", "killed"].includes(d.control_mode) ? d.control_mode : null;
  const account = ["demo", "real", "contest"].includes(d.account_mode) ? d.account_mode : null;
  return {
    connected: d.connected === true, armed: d.armed === true, broker: d.broker ?? null, positions: Number(d.positions) || 0,
    live_armed: typeof d.live_armed === "boolean" ? d.live_armed : null, control_mode: mode,
    control_reason: typeof d.control_reason === "string" ? d.control_reason.slice(0, 60) : null,
    limit_fault: d.limit_fault && typeof d.limit_fault === "object" ? { why: String(d.limit_fault.why ?? "limit_fault").slice(0, 40) } : null,
    account_mode: account, engine_enabled: typeof d.engine_enabled === "boolean" ? d.engine_enabled : null
  };
}

/**
 * Fills what an older Omega's ./api/status lacks (before xauusd #516: control_mode, account_mode) from the overview
 * this page already reads, so the kill console shows KILLED and PAUSED in either deploy order (review of #517).
 * An env kill (EA_SIGNALS_ENABLED false) reaches the overview as signal.kill with kill_source "env".
 */
export function withOverview(status, o) {
  if (!o) return status;
  const killed = o.signal?.kill === true;
  const mode = killed ? "killed" : ["active", "paused", "killed"].includes(o.control?.mode) ? o.control.mode : null;
  const reason = killed ? (o.signal?.kill_source === "env" ? "env_kill_switch" : o.signal?.kill_source || o.control?.reason || null) : o.control?.reason || null;
  const ACCOUNT = { real: "real", live: "real", demo: "demo", contest: "contest" };
  const account = ACCOUNT[o.broker?.bridge?.trade_mode] ?? ACCOUNT[o.heartbeat?.mode] ?? null;
  if (!status) {
    // Status unreadable: still show a kill or a pause, never hide it behind a dash.
    return mode === "killed" || mode === "paused"
      ? { connected: false, armed: false, broker: null, positions: 0, live_armed: null, control_mode: mode, control_reason: reason ? String(reason).slice(0, 60) : null, limit_fault: null, account_mode: account, engine_enabled: null }
      : null;
  }
  return {
    ...status,
    control_mode: status.control_mode ?? mode,
    control_reason: status.control_mode ? status.control_reason : (reason ? String(reason).slice(0, 60) : null),
    account_mode: status.account_mode ?? account
  };
}

/** The EA cell from the overview: its heartbeat age, or OFF. */
export function eaCell(ea) {
  if (!ea) return { code: "EA", detail: "—", tone: "off", title: "EA status not read yet" };
  const age = ea?.heartbeat_age_ms;
  const s = age == null ? null : Math.round(age / 1000);
  const detail = s == null ? null : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
  if (ea?.connected) return { code: "EA", detail, tone: "ok", title: `EA heartbeat ${detail ?? "—"} ago` };
  return { code: "EA", detail: detail ? `OFF ${detail}` : "OFF", tone: "fault", title: detail ? `No EA heartbeat for ${detail}` : "No EA heartbeat yet" };
}

/** UTC to the second, then the viewer's local time and its offset ("GMT+7"; "local" when the viewer is on UTC). */
export function clockParts(now) {
  const off = -now.getTimezoneOffset();
  const abs = Math.abs(off);
  const zone = off === 0 ? "local" : `GMT${off > 0 ? "+" : "-"}${Math.floor(abs / 60)}${abs % 60 ? `:${p2(abs % 60)}` : ""}`;
  return {
    utc: `${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}:${p2(now.getUTCSeconds())}`,
    utcShort: `${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}`,
    local: `${p2(now.getHours())}:${p2(now.getMinutes())}`,
    zone
  };
}
