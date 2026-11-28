// Gold's trading week in New York time (2026-11-15: the Decision Engine and the War Room read "Sunday
// 22:00 to Friday 22:00 UTC", which is right only during US daylight time; in November the reopen is
// 23:00 UTC). Gold does not trade from Friday 17:00 to Sunday 18:00 New York time, so the UTC hours of
// the close and the reopen move by one hour with US daylight saving time.

const NY_WEEK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const HOUR = 3_600_000;

/** Gold does not trade from Friday 17:00 to Sunday 18:00 New York time: true for an instant in that window. */
export function goldClosedAt(ms) {
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return (p.weekday === "Fri" && minutes >= 17 * 60) || p.weekday === "Sat" || (p.weekday === "Sun" && minutes < 18 * 60);
}

/** The next weekly close (while open) or reopen (while closed) after `now`; both fall on a full UTC hour. */
export function nextGoldChange(now) {
  const closed = goldClosedAt(now);
  let t = Math.floor(now / HOUR) * HOUR + HOUR;
  for (let i = 0; i < 24 * 8; i++, t += HOUR) if (goldClosedAt(t) !== closed) return { to: closed ? "open" : "closed", at: t };
  return null;
}

/**
 * Gold does not trade at an instant: the weekend (goldClosedAt) or the daily break, 17:00 to 18:00 New York time from
 * Monday to Thursday (22:00–23:00 UTC in US standard time, 21:00–22:00 in daylight time).
 */
export function goldPausedAt(ms) {
  if (goldClosedAt(ms)) return true;
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return ["Mon", "Tue", "Wed", "Thu"].includes(p.weekday) && Number(p.hour) === 17;
}

/**
 * Pure: how long gold did not trade between two instants (weekends and daily breaks), in ms. The breaks fall on full
 * hours, so each hour is read at its middle; at most 31 days are walked.
 */
export function goldPausedMsBetween(startMs, endMs) {
  if (!(endMs > startMs)) return 0;
  let paused = 0;
  const stop = Math.min(endMs, startMs + 31 * 24 * HOUR);
  for (let t = startMs; t < stop;) {
    const next = Math.min(stop, Math.floor(t / HOUR) * HOUR + HOUR);
    if (goldPausedAt(t + (next - t) / 2)) paused += next - t;
    t = next;
  }
  return paused;
}

/**
 * Pure: true when bar `t` (ms, a bar's time, its open or close as the series stamps them) follows a trading pause after
 * the bar before it (`prevT`): the two are more than one bar (`barMs`) apart and gold was paused between them (the
 * weekend or a daily break). Contiguous bars are never after a pause, so a D1 bar spanning the daily break is not, nor
 * a data hole in trading hours.
 */
export function barAfterPause(prevT, t, barMs) {
  if (![prevT, t, barMs].every(Number.isFinite) || !(barMs > 0) || !(t - prevT > barMs)) return false;
  return goldPausedMsBetween(prevT, t) > 0;
}

/**
 * The daily rollover quarantine (owner 2026-11-28 ~02:25Z: "Ya, perbaiki (Recommended)"): from 5 minutes before the
 * daily break to 15 minutes after the reopen, 16:55-18:15 New York time, the same clock as goldPausedAt. That is
 * 21:55-23:15 UTC in US standard time and 20:55-22:15 UTC in US daylight time.
 */
export const ROLLOVER_QUARANTINE_NY = "16:55-18:15";
export function rolloverQuarantineAt(ms) {
  if (!Number.isFinite(ms)) return false;
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return minutes >= 16 * 60 + 55 && minutes < 18 * 60 + 15;
}

// ---------------------------------------------------------------- the session clock (Track A PR 2)
// One clock for every reader of the sessions: the Decision Engine's market context (sessionAt), the opening ranges
// and the session windows. src/liquidity-lens.mjs keeps its own New York hour-of-week clock; a test pins its
// SESSION_OPEN_HOURS_NY to these opens.

/** New York clock hours of the sessions, as the Chronos Matrix (and the Nexus session clock) define them. */
export const SESSIONS = Object.freeze([
  Object.freeze({ name: "Tokyo", from: 19, to: 28 }),
  Object.freeze({ name: "London", from: 3, to: 12 }),
  Object.freeze({ name: "New York", from: 8, to: 17 })
]);

/** The New York clock hour of an instant, with minutes as a fraction (moves with US daylight time). */
export function nyHour(ms) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
    return Number(p.find((x) => x.type === "hour")?.value ?? 0) + Number(p.find((x) => x.type === "minute")?.value ?? 0) / 60;
  } catch { return (new Date(ms).getUTCHours() + 19) % 24; }
}

const NY_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const SESSION_BAR_MS = 15 * 60_000;
/** The New York calendar date and clock of an instant. */
function nyParts(ms) {
  const p = Object.fromEntries(NY_DATE.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}
/** The instant of a full New York clock hour on a New York date (UTC-4 in daylight time, UTC-5 in standard time). */
function nyLocalMs(y, m, d, h) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, h) + off * HOUR;
    const p = nyParts(t);
    if (p.y === y && p.m === m && p.d === d && p.h === h && p.min === 0) return t;
  }
  return null;
}
const sessionNamed = (name) => SESSIONS.find((s) => s.name === name) ?? null;

/**
 * Pure: the latest open of a session at or before `ms`, as an instant: the session's New York `from` hour on the New
 * York date of `ms`, or on the day before when that is still ahead. Null for an unknown session or a bad instant.
 */
export function sessionOpenMs(name, ms) {
  const s = sessionNamed(name);
  if (!s || !Number.isFinite(ms)) return null;
  const today = nyParts(ms);
  const open = nyLocalMs(today.y, today.m, today.d, s.from % 24);
  if (open != null && open <= ms) return open;
  // The previous New York date by the calendar, not 24 hours back: the spring-forward Sunday has 23 hours, and 24
  // hours back from Monday 00:00-01:00 lands on Saturday (Track A PR 2 review).
  const prev = new Date(Date.UTC(today.y, today.m - 1, today.d - 1));
  return nyLocalMs(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), s.from % 24);
}

/**
 * Pure: the session window around its latest open at or before `ms`: open_ms; range_end_ms, the close of the opening
 * range of `rangeBars` 15-minute bars; end_ms, the close of the session's last 15-minute bar before its `to` hour
 * (London 11:45 and New York 16:45 New York time). Null for an unknown session or a bad instant.
 */
export function sessionWindow(name, ms, { rangeBars = 3 } = {}) {
  const s = sessionNamed(name);
  const open = sessionOpenMs(name, ms);
  if (!s || open == null) return null;
  const endDay = nyParts(open + (s.to - s.from) * HOUR);
  const to = nyLocalMs(endDay.y, endDay.m, endDay.d, s.to % 24);
  if (to == null) return null;
  return { open_ms: open, range_end_ms: open + rangeBars * SESSION_BAR_MS, end_ms: to - SESSION_BAR_MS };
}
