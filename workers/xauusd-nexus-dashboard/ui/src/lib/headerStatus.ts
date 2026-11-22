import type { OmegaStatus } from "./omega";

/**
 * The header's status cells (owner 2026-11-22, header mockup approved: "lanjut buat PR header"): short codes and
 * numbers instead of worded chips. The header shows no market direction, so it uses no green; the tones are
 * ok (cyan), late (amber), fault (red) and off (grey). Pure functions, so the states are tested.
 */
export type Tone = "ok" | "late" | "fault" | "off";
export type Cell = { code: string; detail: string | null; tone: Tone; title: string };
export type OmegaCell = Cell & { positions: number | null; broker: string | null; filled: boolean };

const p2 = (n: number) => String(n).padStart(2, "0");
const hhmmUtc = (ms: number) => { const d = new Date(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };

/** The 15m War Room is live while its last bar closed under 45 minutes ago (owner 2026-11-13: never green on an old room). */
export const ROOM_LIVE_MS = 45 * 60_000;

export function roomCell({ barMs, hasRoom, error, closed, now = Date.now() }: { barMs: number; hasRoom: boolean; error: boolean; closed: boolean; now?: number }): Cell {
  const age = Number.isFinite(barMs) ? now - barMs : NaN;
  if (!error && hasRoom && Number.isFinite(age) && age < ROOM_LIVE_MS) {
    return { code: "LIVE", detail: hhmmUtc(barMs), tone: "ok", title: `15m room, last bar closed ${hhmmUtc(barMs)} UTC` };
  }
  if (closed) return { code: "CLOSED", detail: null, tone: "off", title: "Market closed" };
  // A failed read is OFFLINE even with an older room still on screen: it says the read failed, not that the room is late.
  if (error || !hasRoom) return { code: "OFFLINE", detail: null, tone: "fault", title: "The War Room could not be read" };
  const mins = Math.round(age / 60_000);
  const detail = !Number.isFinite(age) ? null : mins < 120 ? `${mins}m` : `${Math.round(mins / 60)}h`;
  return { code: "BEHIND", detail, tone: "late", title: detail ? `Last 15m room ${detail} ago; market open` : "No current 15m room; market open" };
}

/**
 * The Omega cell from /omega/api/status (owner 2026-11-22: "Ya status sebenarnya"). `armed` there is only the engine
 * toggle; the execution state needs the fields of xauusd #516 (live_armed, control_mode, limit_fault, account_mode,
 * engine_enabled). Without them (an older Omega) the cell never claims ARMED: it says ON.
 *   KILLED  red    control killed (or EA_SIGNALS_ENABLED false)
 *   PAUSED  amber  control paused
 *   STOP    red    engine on, no new entries: a limit the EA never answered (or another limit fault)
 *   MKT     amber  engine on, limit entries stopped, entering at market (the EA answered without a ticket)
 *   NO BRIDGE red  engine on, bridge not connected
 *   ARMED   cyan   engine on, bridge connected, and LIVE armed or a demo account (a contest account needs the arm)
 *   ON      amber  engine on, bridge connected, a real account not live-armed (or the state unknown)
 *   READY   cyan   bridge connected, engine off;  OFF grey: neither;  — : unreadable
 */
export function omegaCell(s: OmegaStatus | null): OmegaCell {
  if (!s) return { code: "—", detail: null, tone: "off", title: "Omega status could not be read", positions: null, broker: null, filled: false };
  const broker = s.connected ? s.broker || null : null;
  const pos = s.positions > 0 ? s.positions : null;
  const why = s.control_reason ? ` (${s.control_reason})` : "";
  const acct = s.account_mode ? `, ${s.account_mode} account` : "";
  if (s.control_mode === "killed") return { code: "KILLED", detail: null, tone: "fault", title: `Omega killed${why}`, positions: pos, broker, filled: true };
  if (s.control_mode === "paused") return { code: "PAUSED", detail: null, tone: "late", title: `Omega paused${why}`, positions: pos, broker, filled: true };
  const engineOn = s.armed && s.engine_enabled !== false;
  // The two fail-closed faults differ (owner 2026-11-21): no_answer stops every new entry; no_ticket stops limit
  // entries only and Omega keeps entering at market, until the owner saves the settings.
  if (engineOn && s.limit_fault?.why === "no_ticket") return { code: "MKT", detail: null, tone: "late", title: "Limit entries stopped, entering at market: the EA answered without a ticket; until you save the Omega settings", positions: pos, broker, filled: true };
  if (engineOn && s.limit_fault) return { code: "STOP", detail: null, tone: "fault", title: s.limit_fault.why === "no_answer" ? "No new entries: a limit the EA never answered; until the EA answers or you save the Omega settings" : `No new entries: limit fault (${s.limit_fault.why}); until you save the Omega settings`, positions: pos, broker, filled: true };
  if (engineOn && !s.connected) return { code: "NO BRIDGE", detail: null, tone: "fault", title: "Omega engine on, but the bridge is not connected", positions: null, broker: null, filled: true };
  if (engineOn) {
    // Only a demo account trades without the LIVE arm (src/omega-engine.mjs: trade_mode !== "demo" && !live_armed → disarmed).
    const armed = s.live_armed === true || s.account_mode === "demo";
    return armed
      ? { code: "ARMED", detail: null, tone: "ok", title: `Engine on, bridge connected${acct}${s.live_armed ? ", LIVE armed" : ""}`, positions: s.positions, broker, filled: true }
      : { code: "ON", detail: null, tone: "late", title: s.account_mode === "real" ? "Engine on, real account not LIVE armed" : "Engine on; the live arm is not known", positions: s.positions, broker, filled: false };
  }
  const offWhy = s.armed && s.engine_enabled === false ? " (OMEGA_ENGINE_ENABLED off)" : "";
  if (s.connected) return { code: "READY", detail: null, tone: "ok", title: `Bridge connected, Omega engine off${offWhy}`, positions: pos, broker, filled: false };
  return { code: "OFF", detail: null, tone: "off", title: `Bridge not connected, Omega engine off${offWhy}`, positions: null, broker: null, filled: false };
}

/** UTC to the second, then the viewer's local time and its offset ("GMT+7"; "local" when the viewer is on UTC). */
export function clockParts(now: Date) {
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
