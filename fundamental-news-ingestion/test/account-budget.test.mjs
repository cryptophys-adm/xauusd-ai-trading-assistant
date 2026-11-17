// One budget for the account (owner 2026-11-17, "setuju perbaikan alert dan kuota"; task #89): the chart, the
// calendar and news share the TradingView quota through this gateway; the chart comes first, news degrades first.
import test from "node:test";
import assert from "node:assert/strict";
import { admitCalls, budgetConfig, budgetHeadroom, chartReserve, ACCOUNT_SAFETY_MARGIN, NEWS_DAILY_CAP, CALENDAR_DAILY_CAP, PROVIDER_DAILY_LIMIT, CHART_PER_HOUR_FLOOR } from "../src/provider-usage.mjs";

const { runTvOhlcv, runTvEconomicCalendar } = await import(new URL("../src/index.mjs", import.meta.url).href);

const at = (hh, mm = 0, d = 16) => Date.UTC(2026, 10, d, hh, mm); // 2026-11-16 is a Monday
const hours = (n, perHour) => Array.from({ length: 24 }, (_, h) => (h < n ? perHour : 0));
/** A day of calls: the chart at `perHour` for `n` completed hours plus the other callers' totals. */
function day(n, perHour, { calendar = 0, news = 0 } = {}) {
  const chart = n * perHour;
  return {
    total: chart + calendar + news,
    by_caller: {
      pull_adapter: { calls: chart, by_hour: hours(n, perHour) },
      ...(calendar ? { calendar: { calls: calendar, by_hour: [] } } : {}),
      ...(news ? { news_cron: { calls: news, by_hour: [] } } : {})
    }
  };
}
const config = budgetConfig({});

test("Q1. the account cap is the quota less the safety margin; env can tune each cap", () => {
  assert.deepEqual(config, { limit: PROVIDER_DAILY_LIMIT, margin: ACCOUNT_SAFETY_MARGIN, cap: 480, news_cap: NEWS_DAILY_CAP, calendar_cap: CALENDAR_DAILY_CAP });
  assert.deepEqual(budgetConfig({ TV_PROVIDER_DAILY_LIMIT: "600", TV_ACCOUNT_SAFETY_MARGIN: "30", TV_NEWS_DAILY_CAP: "10", TV_CALENDAR_DAILY_CAP: "5" }), { limit: 600, margin: 30, cap: 570, news_cap: 10, calendar_cap: 5 });
  assert.equal(budgetConfig({ TV_ACCOUNT_SAFETY_MARGIN: "9999" }).cap, 1, "the margin never takes the whole quota");
});

test("Q2. the chart comes first: admitted up to the cap, never held for news or the calendar", () => {
  // 2026-11-16 replayed: ~20 chart calls an hour; at 22:00 the day stood at 440 plus news and calendar.
  const busy = day(22, 20, { calendar: 20, news: 10 }); // 470
  assert.equal(admitCalls(busy, { caller: "pull_adapter", wanted: 8, now: at(22, 30), config }).allowed, true, "470 + 8 = 478 within 480");
  const full = admitCalls(busy, { caller: "pull_adapter", wanted: 12, now: at(22, 30), config });
  assert.deepEqual([full.allowed, full.reason, full.retry_at], [false, "account_cap", "2026-11-17T00:00:00.000Z"], "482 > 480: refused before the provider's 500");
  assert.equal(admitCalls(busy, { caller: "gold_history", wanted: 1, now: at(22, 30), config }).allowed, true, "gold's 1H history counts as chart");
});

test("Q3. news degrades first: refused while the chart's need to midnight and the calendar's rest would not fit", () => {
  // 10:00 on a weekday, the chart at 20 an hour: it still needs 20 x 14 = 280 to midnight.
  const morning = day(10, 20, { calendar: 10, news: 20 }); // 230
  const news = admitCalls(morning, { caller: "news_cron", wanted: 3, now: at(10), config });
  assert.equal(news.allowed, false, "230 + 3 + 280 + 20 (calendar left) = 533 > 480");
  assert.equal(news.reason, "reserved_for_chart");
  // A quiet chart (the weekend's 1 an hour) leaves room.
  assert.equal(admitCalls(day(10, 1, { news: 20 }), { caller: "news_cron", wanted: 3, now: at(10, 0, 15), config }).allowed, true);
  // The daily news cap holds whatever the chart does.
  const capped = admitCalls(day(10, 1, { news: NEWS_DAILY_CAP - 1 }), { caller: "news_ai_worker", wanted: 3, now: at(10, 0, 15), config });
  assert.deepEqual([capped.allowed, capped.reason], [false, "news_daily_cap"]);
});

test("Q4. the calendar comes after the chart and before news, within its own daily cap", () => {
  const morning = day(10, 20, { calendar: 10, news: 20 });
  // 230 + 1 + 280 = 511 > 480: the calendar waits too at 10:00 on a heavy chart day...
  assert.equal(admitCalls(morning, { caller: "calendar", wanted: 1, now: at(10), config }).reason, "reserved_for_chart");
  // ...but late in the day, when the chart's need is small, it runs while news (holding the calendar's rest) may not.
  const evening = day(21, 20, { calendar: 10, news: 10 }); // 440
  assert.equal(admitCalls(evening, { caller: "calendar", wanted: 1, now: at(22, 30), config }).allowed, true, "440 + 1 + 30 = 471");
  assert.equal(admitCalls(evening, { caller: "news_cron", wanted: 3, now: at(22, 30), config }).allowed, false, "440 + 3 + 30 + 20 = 493");
  assert.equal(admitCalls(day(2, 1, { calendar: CALENDAR_DAILY_CAP }), { caller: "calendar", now: at(3), config }).reason, "calendar_daily_cap");
});

test("Q5. the chart's floor before the day has a completed hour (00:xx UTC): news no longer runs unchecked", () => {
  const r = chartReserve({ total: 4, by_caller: {} }, { now: at(0, 30, 17), wanted: 3, limit: 480 });
  assert.equal(r.chart_per_hour, CHART_PER_HOUR_FLOOR, "a Tuesday");
  assert.equal(chartReserve({ total: 4, by_caller: {} }, { now: at(0, 30, 21), wanted: 3, limit: 480 }).chart_per_hour, 0, "a Saturday: the market is closed");
});

test("Q6. the headroom report: what the day can still spend, and how much of it news gets", () => {
  // 2026-11-16 at 23:45 replayed under the new cap: 443 chart calls; the chart barely needs more before midnight.
  const h = budgetHeadroom(day(23, 19, { calendar: 20, news: 15 }), { now: at(23, 45), config }); // 437 + 35 = 472
  assert.equal(h.cap, 480);
  assert.equal(h.chart_today, 437);
  assert.equal(h.calendar_left, CALENDAR_DAILY_CAP - 20);
  assert.ok(h.headroom <= 480 - 472, "the projection includes the chart's need and the calendar's rest");
  assert.equal(h.news_room, 0, "nothing left for news");
  // A quiet morning: plenty of room, news within its cap.
  const q = budgetHeadroom(day(4, 2, { news: 3 }), { now: at(4, 0, 15), config });
  assert.equal(q.news_room, NEWS_DAILY_CAP - 3);
});

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

test("Q7. exhaustion: a chart job past the cap answers like the provider's quota, without calling it; the calendar waits", async () => {
  const env = { OAUTH_STORE: new MemoryKV(), TV_MCP_METADATA_URL: "https://mcp.example.com/.well-known/oauth-authorization-server" };
  const dayKey = new Date().toISOString().slice(0, 10);
  await env.OAUTH_STORE.put(`tv_mcp:calls:${dayKey}:pull_adapter`, JSON.stringify({ date: dayKey, caller: "pull_adapter", calls: 480, failed: 0, by_hour: Array(24).fill(0) }));
  let provider = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { provider += 1; throw new Error("the provider must not be called"); };
  try {
    const chart = await runTvOhlcv(env, [{ symbol: "OANDA:XAUUSD", interval: "1m", count: 5 }, { symbol: "TVC:USOIL", interval: "5m", count: 5 }]);
    assert.equal(chart.status, 429);
    assert.equal(chart.body.error, "account_budget_exhausted");
    assert.match(chart.body.quota_cooldown_until, /T00:00:00\.000Z$/, "until the next UTC midnight, so the pull adapter stops asking");
    assert.deepEqual(chart.body.results, []);
    const cal = await runTvEconomicCalendar(env, { date_from: "2026-11-17", date_to: "2026-11-17" });
    assert.equal(cal.status, 503);
    assert.equal(cal.body.error, "account_cap");
    assert.equal(provider, 0, "no provider call and nothing counted");
    // The switch leaves the check out (the provider would be called again).
    const off = await runTvOhlcv({ ...env, TV_ACCOUNT_BUDGET: "off" }, [{ symbol: "OANDA:XAUUSD", interval: "1m", count: 5 }]);
    assert.notEqual(off.body?.error, "account_budget_exhausted");
  } finally {
    globalThis.fetch = realFetch;
  }
});
