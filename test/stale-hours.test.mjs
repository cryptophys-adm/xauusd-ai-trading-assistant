// Stale readings around gold's daily break and quiet news nights (owner 2026-11-18, confirmed: "Perbaiki keduanya").
import test from "node:test";
import assert from "node:assert/strict";
import { goldPausedAt, goldPausedMsBetween } from "../src/market-hours.mjs";
import { isRoomStale, buildGlobalConclusion } from "../src/global-conclusion.mjs";

const H = 3_600_000;
const t = (iso) => Date.parse(iso);

test("SH1 the daily break and the weekend are paused hours; trading hours are not", () => {
  // November (US standard time): the break is 22:00–23:00 UTC Monday to Thursday.
  assert.equal(goldPausedAt(t("2026-11-18T22:30:00Z")), true, "Wednesday's break");
  assert.equal(goldPausedAt(t("2026-11-18T21:30:00Z")), false);
  assert.equal(goldPausedAt(t("2026-11-18T23:30:00Z")), false);
  assert.equal(goldPausedAt(t("2026-11-21T12:00:00Z")), true, "Saturday");
  // Daylight time (July): the break is 21:00–22:00 UTC.
  assert.equal(goldPausedAt(t("2026-07-15T21:30:00Z")), true);
  assert.equal(goldPausedAt(t("2026-07-15T22:30:00Z")), false);
  assert.equal(goldPausedMsBetween(t("2026-11-18T22:00:00Z"), t("2026-11-19T00:04:00Z")), H);
  // Friday 22:00 to Sunday 23:00 UTC in November: 49 hours.
  assert.equal(goldPausedMsBetween(t("2026-11-20T21:00:00Z"), t("2026-11-23T00:00:00Z")), 49 * H);
});

test("SH2 the 1H room of 22:00 is current at the 00:00 decision after the break; three trading hours later it is stale", () => {
  assert.equal(isRoomStale("2026-11-18T22:00:00.000Z", t("2026-11-19T00:02:00Z"), 2 * H), false, "the break hour is not age");
  assert.equal(isRoomStale("2026-11-18T22:00:00.000Z", t("2026-11-19T01:05:00Z"), 2 * H), true);
  assert.equal(isRoomStale("2026-11-18T19:00:00.000Z", t("2026-11-18T21:05:00Z"), 2 * H), true, "no break between: as before");
});

test("SH3 the News witness ages from its last hourly check, not from its last new headline", () => {
  const news = { run_at: "2026-11-18T19:06:00.000Z", checked_at: "2026-11-19T00:06:00.000Z", tldr: { status: "ok", stance: "BEARISH", confidence: 0.7, summary: "x", reasons: [] }, items: [] };
  const now = t("2026-11-19T00:15:00Z");
  const g = (n) => buildGlobalConclusion({ news: n, now }).timeframes.find((x) => x.key === "NEWS");
  assert.equal(g(news).stale, false, "checked 9 minutes ago");
  assert.equal(g({ ...news, checked_at: undefined }).stale, true, "without a check: 19:06 is over 3 trading hours old");
  assert.equal(g({ ...news, checked_at: "2026-11-18T20:00:00.000Z" }).stale, true, "the checks stopped: stale");
});
