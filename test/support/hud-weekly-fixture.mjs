// ZF2 fixtures (test/hud-weekly.test.mjs, local-engines/producer/test/hud-snapshot-weekly.test.mjs): closed weekly bars as
// OANDA's (open Sunday 22:00 UTC, 260 of them, the bundle's retain), trending with swings and a volume spike every 17th
// bar, so the weekly chart has whale zones and Prophet order blocks.
export const WEEK = 7 * 86_400_000;
export const WEEKLY_END = Date.parse("2026-11-22T22:00:00Z");

/** `n` closed weekly bars ending at `end` (the last bar's close). */
export function weeklyBars(n = 260, end = WEEKLY_END) {
  return Array.from({ length: n }, (_, i) => {
    const openMs = end - (n - i) * WEEK;
    const o = 1800 + i * 8 + Math.sin(i / 7) * 60 + Math.sin(i / 3) * 15;
    const c = o + Math.sin(i / 2.3) * 30;
    return {
      time: openMs / 1000, open_time: new Date(openMs).toISOString(), close_time: new Date(openMs + WEEK).toISOString(),
      open: o, high: Math.max(o, c) + 12 + (i % 5) * 3, low: Math.min(o, c) - 12 - (i % 4) * 3, close: c,
      volume: 1e5 + (i % 9) * 4e4 + (i % 17 === 0 ? 5e5 : 0)
    };
  });
}
