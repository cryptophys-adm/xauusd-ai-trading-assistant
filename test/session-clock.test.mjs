// Track A PR 2: one session clock. SESSIONS and nyHour move from src/decision-engine.mjs to src/market-hours.mjs
// (the Decision Engine re-exports SESSIONS); sessionOpenMs and sessionWindow give the opens and windows the opening
// ranges (PR 7) read. sessionAt is unchanged, and so is ENGINE_CODE_HASH.
import test from "node:test";
import assert from "node:assert/strict";
import { SESSIONS, nyHour, sessionOpenMs, sessionWindow, nextGoldChange } from "../src/market-hours.mjs";
import { SESSIONS as ENGINE_SESSIONS, sessionAt, marketOpenAt } from "../src/decision-engine.mjs";
import { SESSION_OPEN_HOURS_NY } from "../src/liquidity-lens.mjs";
import { ENGINE_CODE_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";

const at = (iso) => Date.parse(iso);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// The Decision Engine's sessionAt as it was before this PR (its own SESSIONS, nyHour and filter), for the sweep.
const OLD_SESSIONS = [{ name: "Tokyo", from: 19, to: 28 }, { name: "London", from: 3, to: 12 }, { name: "New York", from: 8, to: 17 }];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function oldNyHour(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  return Number(p.find((x) => x.type === "hour")?.value ?? 0) + Number(p.find((x) => x.type === "minute")?.value ?? 0) / 60;
}
function oldSessionAt(now) {
  const d = new Date(now), h = oldNyHour(now);
  const open = marketOpenAt(now);
  const active = open ? OLD_SESSIONS.filter((x) => (h >= x.from && h < x.to) || (h + 24 >= x.from && h + 24 < x.to)).map((x) => x.name) : [];
  const next = new Date(nextGoldChange(now).at);
  return {
    day: DAYS[d.getUTCDay()], date: d.toISOString().slice(0, 10), time_utc: d.toISOString().slice(11, 16), new_york_hour: Math.floor(h),
    market_open: open, active, overlap: active.length > 1,
    liquidity: !open ? "closed" : active.length > 1 ? "high" : active.length ? "normal" : "thin",
    next_change: { to: open ? "closed" : "open", at: next.toISOString(), minutes: Math.round((next.getTime() - now) / 60_000) }
  };
}

test("SC1 one clock: the Decision Engine re-exports SESSIONS, and the liquidity lens's opens are its opens", () => {
  assert.equal(ENGINE_SESSIONS, SESSIONS);
  assert.deepEqual(SESSIONS.map((s) => [s.name, s.from, s.to]), [["Tokyo", 19, 28], ["London", 3, 12], ["New York", 8, 17]]);
  assert.ok(Object.isFrozen(SESSIONS) && SESSIONS.every(Object.isFrozen));
  assert.deepEqual([...SESSION_OPEN_HOURS_NY], SESSIONS.map((s) => s.from), "src/liquidity-lens.mjs SESSION_OPEN_HOURS_NY");
  assert.equal(nyHour(at("2026-11-23T13:30:00Z")), 8.5, "EST: UTC-5");
  assert.equal(nyHour(at("2026-03-16T12:15:00Z")), 8.25, "EDT: UTC-4");
});

test("SC2 sessionAt is identical over a sweep across both US clock changes and both European ones", () => {
  let n = 0;
  for (const [from, to] of [["2026-03-07T00:00:00Z", "2026-03-30T00:00:00Z"], ["2026-10-24T00:00:00Z", "2026-11-02T00:00:00Z"]]) {
    for (let t = at(from); t < at(to); t += 15 * 60_000, n++) assert.deepEqual(sessionAt(t), oldSessionAt(t), iso(t));
  }
  assert.ok(n > 3000);
});

test("SC3 sessionOpenMs: the latest open at or before the instant, in both daylight regimes", () => {
  // 2026-03-16: US daylight time (from 2026-03-08), UK still on GMT (until 2026-03-29).
  assert.equal(iso(sessionOpenMs("London", at("2026-03-16T12:00:00Z"))), "2026-03-16T07:00:00.000Z");
  assert.equal(iso(sessionOpenMs("New York", at("2026-03-16T12:00:00Z"))), "2026-03-16T12:00:00.000Z", "at the open itself");
  assert.equal(iso(sessionOpenMs("London", at("2026-03-16T06:59:00Z"))), "2026-03-15T07:00:00.000Z", "before today's open: yesterday's");
  // US standard time.
  assert.equal(iso(sessionOpenMs("London", at("2026-11-23T10:00:00Z"))), "2026-11-23T08:00:00.000Z");
  assert.equal(iso(sessionOpenMs("New York", at("2026-11-23T14:00:00Z"))), "2026-11-23T13:00:00.000Z");
  // Tokyo opens at 19:00 New York time and runs past midnight.
  assert.equal(iso(sessionOpenMs("Tokyo", at("2026-11-24T03:00:00Z"))), "2026-11-24T00:00:00.000Z");
  assert.equal(iso(sessionOpenMs("Tokyo", at("2026-11-24T09:00:00Z"))), "2026-11-24T00:00:00.000Z", "still the open of the evening before");
  // Across the US clock change (2026-11-01): the open moves by an hour in UTC, never in New York time.
  assert.equal(iso(sessionOpenMs("London", at("2026-10-30T12:00:00Z"))), "2026-10-30T07:00:00.000Z");
  assert.equal(iso(sessionOpenMs("London", at("2026-11-02T12:00:00Z"))), "2026-11-02T08:00:00.000Z");
  assert.equal(sessionOpenMs("Sydney", at("2026-11-23T10:00:00Z")), null);
  assert.equal(sessionOpenMs("London", NaN), null);
});

test("SC4 sessionWindow: the opening range of 3 bars and the last 15-minute bar before the session's end", () => {
  const lon = sessionWindow("London", at("2026-03-16T09:00:00Z"));
  assert.deepEqual([iso(lon.open_ms), iso(lon.range_end_ms), iso(lon.end_ms)], ["2026-03-16T07:00:00.000Z", "2026-03-16T07:45:00.000Z", "2026-03-16T15:45:00.000Z"], "11:45 New York time");
  const ny = sessionWindow("New York", at("2026-11-23T15:00:00Z"));
  assert.deepEqual([iso(ny.open_ms), iso(ny.range_end_ms), iso(ny.end_ms)], ["2026-11-23T13:00:00.000Z", "2026-11-23T13:45:00.000Z", "2026-11-23T21:45:00.000Z"], "16:45 New York time");
  const tokyo = sessionWindow("Tokyo", at("2026-11-24T03:00:00Z"));
  assert.deepEqual([iso(tokyo.open_ms), iso(tokyo.end_ms)], ["2026-11-24T00:00:00.000Z", "2026-11-24T08:45:00.000Z"], "the next New York day at 03:45");
  assert.equal(sessionWindow("New York", at("2026-11-23T15:00:00Z"), { rangeBars: 2 }).range_end_ms - ny.open_ms, 30 * 60_000);
  for (const t = { v: at("2026-10-25T00:00:00Z") }; t.v < at("2026-11-05T00:00:00Z"); t.v += 3_600_000) {
    for (const s of ["London", "New York"]) {
      const w = sessionWindow(s, t.v);
      assert.ok(w.open_ms <= t.v && w.range_end_ms - w.open_ms === 45 * 60_000, `${s} ${iso(t.v)}`);
      assert.equal(nyHour(w.end_ms), s === "London" ? 11.75 : 16.75, `${s} ends at the same New York time across the change (${iso(t.v)})`);
    }
  }
  assert.equal(sessionWindow("Sydney", at("2026-11-23T10:00:00Z")), null);
});

test("SC6 the latest open across both 2026 clock changes, every 7 minutes, for every session", () => {
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const clock = (ms) => Object.fromEntries(ny.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  let n = 0;
  for (const [from, to] of [["2026-03-05T00:00:00Z", "2026-03-12T00:00:00Z"], ["2026-10-29T00:00:00Z", "2026-11-05T00:00:00Z"]]) {
    for (let t = at(from); t < at(to); t += 7 * 60_000) {
      for (const s of SESSIONS) {
        const open = sessionOpenMs(s.name, t);
        const c = clock(open);
        assert.ok(open <= t && t - open < 25 * 3_600_000, `${s.name} ${iso(t)} → ${iso(open)}`);
        assert.deepEqual([c.hour, c.minute], [s.from % 24, 0], `${s.name} ${iso(t)} opens at ${s.from % 24}:00 New York time`);
        assert.equal(sessionWindow(s.name, t).open_ms, open);
        n++;
      }
    }
  }
  assert.ok(n > 8000);
  // The spring-forward Sunday has 23 hours: from Monday 00:00 New York the latest Tokyo open is Sunday's, not Saturday's.
  assert.equal(iso(sessionOpenMs("Tokyo", at("2026-03-09T04:30:00Z"))), "2026-03-08T23:00:00.000Z");
  assert.equal(iso(sessionOpenMs("London", at("2026-03-09T04:30:00Z"))), "2026-03-08T07:00:00.000Z", "Sunday's London open");
});

test("SC5 ENGINE_CODE_HASH is unchanged by the move", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
});
