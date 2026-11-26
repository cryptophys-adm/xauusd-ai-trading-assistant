// Track A PR 7: the London and New York opening ranges on gold's 15m chart, for the orb_breakout strategy agent
// (src/strategy-agents.mjs). Pure; imports only the session clock (src/market-hours.mjs).
//   - The Chronos clock: London opens at 03:00 and New York at 08:00 New York time; each range is the first three
//     closed 15m bars of its session, contiguous and with valid times.
//   - London is silent (session_clock_mismatch) when 03:00 New York is not 08:00 in London (the weeks the US and the UK
//     change their clocks on different dates), as the Pine SSOT's own session clock is.
//   - A range with a high-impact release inside it is not traded (range_event).
//   - The window lasts until the session's last 15m bar before its end hour (11:45 London, 16:45 New York, New York
//     time; sessionWindow's end_ms); after it, no plan.
import { sessionWindow, goldPausedAt } from "./market-hours.mjs";

export const OPENING_RANGE_SESSIONS = Object.freeze([
  Object.freeze({ name: "London", key: "orb_london", label: "London" }),
  Object.freeze({ name: "New York", key: "orb_new_york", label: "New York" })
]);
const BAR_MS = 15 * 60_000;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));
const LONDON_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The London clock "HH:MM" of an instant. */
const londonClock = (ms) => LONDON_HOUR.format(new Date(ms));

/** Switch: off while the strategy agents are off, or orb_breakout is in STRATEGY_AGENTS_OFF; on otherwise. */
export function orbMode(env) {
  const mode = String(env?.STRATEGY_AGENTS_MODE ?? "on").trim().toLowerCase();
  const off = String(env?.STRATEGY_AGENTS_OFF ?? "").split(",").map((s) => s.trim().toLowerCase());
  return mode === "off" || off.includes("orb_breakout") ? "off" : "on";
}

/**
 * Track A PR 8: the opening-range edges as key levels (src/key-level-agent.mjs rawLevels). Off with ORB_LEVELS "off" or
 * while orbMode is off; on otherwise.
 */
export function orbLevelsMode(env) {
  return String(env?.ORB_LEVELS ?? "on").trim().toLowerCase() === "off" || orbMode(env) === "off" ? "off" : "on";
}
/** The modes entry the strategy inputs carry: { orbLevels: "off" } while off, nothing while on (the inputs as before). */
export const orbLevelsModes = (env) => (orbLevelsMode(env) === "off" ? { orbLevels: "off" } : {});

/** Pure: a high-impact USD release ({ time, impact, currency }, src/econ-calendar.mjs) whose time falls in [from, to). */
const eventInside = (events, from, to) => (Array.isArray(events) ? events : []).some((e) => {
  const t = toMs(e?.time ?? e?.at ?? e?.release_ms);
  const usd = e?.currency == null || String(e.currency).toUpperCase() === "USD";
  return isNum(t) && t >= from && t < to && usd && String(e?.impact ?? e?.importance ?? "").toLowerCase().startsWith("high");
});

/**
 * Pure: each session's opening range as of the last closed bar of `bars15` (oldest first; { open_time, close_time,
 * high, low, close }). Per session: { key, session, status, open_ms, range_end_ms, end_ms, high, low, mid, width }.
 * status "ok" | "range_incomplete" | "session_clock_mismatch" | "range_event" | "not_formed" | "window_over" |
 * "market_paused". `now` defaults to the last bar's close.
 */
export function openingRanges(bars15, { events = [], now = undefined } = {}) {
  const bars = (Array.isArray(bars15) ? bars15 : []).filter((b) => b && [b.high, b.low, b.close].every(isNum));
  const lastClose = bars.length ? toMs(bars.at(-1).close_time) : NaN;
  const at = isNum(now) ? now : lastClose;
  return OPENING_RANGE_SESSIONS.map((s) => {
    const base = { key: s.key, session: s.label, status: "not_formed", open_ms: null, range_end_ms: null, end_ms: null, high: null, low: null, mid: null, width: null };
    if (!isNum(at)) return { ...base, status: "range_incomplete" };
    const w = sessionWindow(s.name, at);
    if (!w) return { ...base, status: "range_incomplete" };
    const out = { ...base, open_ms: w.open_ms, range_end_ms: w.range_end_ms, end_ms: w.end_ms };
    if (s.name === "London" && londonClock(w.open_ms) !== "08:00") return { ...out, status: "session_clock_mismatch" };
    if (at < w.range_end_ms) return out;
    if (at >= w.end_ms) return { ...out, status: "window_over" };
    if (goldPausedAt(at)) return { ...out, status: "market_paused" };
    // Exactly three contiguous closed 15m bars from the open, each with valid times and closed by now.
    const range = [];
    for (let k = 0; k < 3; k++) {
      const open = w.open_ms + k * BAR_MS;
      const b = bars.find((x) => toMs(x.open_time) === open);
      if (!b || toMs(b.close_time) !== open + BAR_MS || !(toMs(b.close_time) <= lastClose) || !(toMs(b.close_time) <= at)) return { ...out, status: "range_incomplete" };
      range.push(b);
    }
    if (eventInside(events, w.open_ms, w.range_end_ms)) return { ...out, status: "range_event" };
    const high = Math.max(...range.map((b) => b.high)), low = Math.min(...range.map((b) => b.low));
    return { ...out, status: "ok", high, low, mid: (high + low) / 2, width: high - low };
  });
}
