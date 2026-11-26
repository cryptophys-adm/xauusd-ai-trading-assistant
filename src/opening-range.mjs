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

// ---------------------------------------------------------------- Track A PR 9: the reading for the council
/** The breakout and retest bands of the reading, in 1H ATR (the strategy agents' AGENT_RULES.breakout; a test pins them equal). */
export const ORB_READING_BANDS = Object.freeze({ beyond_atr: 0.1, retest_atr: 0.15 });
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const sessionWord = (label) => (label === "New York" ? "new_york" : "london");

/**
 * Pure (Track A PR 9): the opening range of the session window open at the last closed bar of `bars15`, for the
 * council and the War Room's Technical Analyst, or null outside a window (and for London in the weeks its clock does
 * not match). New York's when both are open. Distances in `atr` (the 1H ATR) units, never a price:
 * { session, minutes_since_open, bars_left, range: { bars, width_atr, status }, last_bar: { side, from_edge_atr,
 * from_mid_atr }, breakout: { way, bars_since, held, retesting }, invalidated }. last_bar, breakout and invalidated
 * only once the range is formed (status "ok").
 */
export function sessionRangeReading(bars15, { atr = null, events = [], bands = ORB_READING_BANDS } = {}) {
  const bars = (Array.isArray(bars15) ? bars15 : []).filter((b) => b && [b.high, b.low, b.close].every(isNum) && isNum(toMs(b.open_time)) && isNum(toMs(b.close_time)));
  if (!bars.length) return null;
  const at = toMs(bars.at(-1).close_time);
  const open = openingRanges(bars, { events, now: at }).filter((r) => isNum(r.open_ms) && isNum(r.end_ms) && at > r.open_ms && at < r.end_ms && r.status !== "session_clock_mismatch" && r.status !== "window_over");
  if (!open.length) return null;
  const r = open.at(-1);
  const k = isNum(atr) && atr > 0 ? atr : null;
  const inAtr = (v) => (k && isNum(v) ? r2(v / k) : null);
  const rangeBars = bars.filter((b) => toMs(b.open_time) >= r.open_ms && toMs(b.open_time) < r.range_end_ms).length;
  const out = {
    session: sessionWord(r.session), minutes_since_open: Math.round((at - r.open_ms) / 60_000), bars_left: Math.max(0, Math.round((r.end_ms - at) / BAR_MS)),
    range: { bars: rangeBars, width_atr: r.status === "ok" ? inAtr(r.width) : null, status: r.status }
  };
  if (r.status !== "ok") return out;
  const c = bars.at(-1).close;
  const side = c > r.high ? "above" : c < r.low ? "below" : "inside";
  const fromEdge = side === "above" ? c - r.high : side === "below" ? r.low - c : Math.min(c - r.low, r.high - c);
  out.last_bar = { side, from_edge_atr: inAtr(fromEdge), from_mid_atr: inAtr(c - r.mid) };
  // The first 15m close beyond an edge by the breakout band (the agent's trigger); none without the ATR.
  const after = bars.filter((b) => toMs(b.open_time) >= r.range_end_ms);
  let way = null, i = -1;
  if (k) {
    i = after.findIndex((b) => b.close - r.high >= bands.beyond_atr * k || r.low - b.close >= bands.beyond_atr * k);
    if (i >= 0) way = after[i].close - r.high >= bands.beyond_atr * k ? "up" : "down";
  }
  if (!way) { out.breakout = { way: null, bars_since: null, held: null, retesting: null }; out.invalidated = false; return out; }
  const dir = way === "up" ? 1 : -1, edge = dir > 0 ? r.high : r.low, since = after.slice(i + 1);
  out.breakout = {
    way, bars_since: after.length - 1 - i,
    // Held: no close back inside the range since the break.
    held: since.every((b) => dir * (b.close - edge) >= 0),
    // Retesting: the last close within the retest band of the broken edge.
    retesting: Math.abs(c - edge) <= bands.retest_atr * k
  };
  // Invalidated: a close back through the range's middle since the break (the agent's end of the side).
  out.invalidated = since.some((b) => dir * (b.close - r.mid) < 0);
  return out;
}

/**
 * Pure (Track A PR 9): the 1H ATR(14) of closed 15m bars, from the hours they make up (an hour of four closed 15m bars,
 * by its UTC start), the strategy engine's true-range mean; null with fewer than two hours. The War Room reads the 15m
 * series only.
 */
export function h1AtrOf15(bars15, n = 14) {
  const hours = new Map();
  for (const b of Array.isArray(bars15) ? bars15 : []) {
    const o = toMs(b?.open_time);
    if (!isNum(o) || ![b.high, b.low, b.close].every(isNum)) continue;
    const h = Math.floor(o / 3_600_000) * 3_600_000, x = hours.get(h);
    if (!x) hours.set(h, { t: h, high: b.high, low: b.low, close: b.close, last: o, n: 1 });
    else { x.high = Math.max(x.high, b.high); x.low = Math.min(x.low, b.low); if (o > x.last) { x.last = o; x.close = b.close; } x.n++; }
  }
  const c = [...hours.values()].filter((x) => x.n === 4).sort((a, b) => a.t - b.t);
  if (c.length < 2) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  const last = tr.slice(-n);
  return last.reduce((s, v) => s + v, 0) / last.length;
}
