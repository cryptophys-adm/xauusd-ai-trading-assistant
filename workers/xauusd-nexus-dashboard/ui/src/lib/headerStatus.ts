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
  if (!hasRoom) return { code: "OFFLINE", detail: null, tone: "fault", title: "The War Room could not be read" };
  const mins = Math.round(age / 60_000);
  const detail = !Number.isFinite(age) ? null : mins < 120 ? `${mins}m` : `${Math.round(mins / 60)}h`;
  return { code: "BEHIND", detail, tone: "late", title: detail ? `Last 15m room ${detail} ago; market open` : "No current 15m room; market open" };
}

export function omegaCell(s: OmegaStatus | null): OmegaCell {
  if (!s) return { code: "—", detail: null, tone: "off", title: "Omega status could not be read", positions: null, broker: null, filled: false };
  const broker = s.broker || null;
  if (s.connected && s.armed) return { code: "ARMED", detail: null, tone: "ok", title: "Bridge connected, Omega engine toggle on", positions: s.positions, broker, filled: true };
  if (s.connected) return { code: "READY", detail: null, tone: "ok", title: "Bridge connected, Omega engine toggle off", positions: s.positions > 0 ? s.positions : null, broker, filled: false };
  if (s.armed) return { code: "NO BRIDGE", detail: null, tone: "fault", title: "Omega engine toggle on, but the bridge is not connected", positions: null, broker: null, filled: true };
  return { code: "OFF", detail: null, tone: "off", title: "Bridge not connected, Omega engine toggle off", positions: null, broker: null, filled: false };
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
