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
