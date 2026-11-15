// Gold's trading week in New York time, for the bridge's local recovery (2026-11-15). The bridge is its own
// package on the VPS, so it keeps this copy of src/market-hours.mjs goldClosedAt; test/omega-hours.test.mjs
// in the repository root keeps the two equal.
const NY_WEEK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Gold does not trade from Friday 17:00 to Sunday 18:00 New York time: true for an instant in that window. */
export function goldClosedAt(ms) {
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return (p.weekday === "Fri" && minutes >= 17 * 60) || p.weekday === "Sat" || (p.weekday === "Sun" && minutes < 18 * 60);
}
