// News without TradingView, in shadow (owner 2026-11-14; docs/RFC_CONTENT_AGENT.md P0).
import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseGdelt, symbolsOf, similarity, compareWithTradingView, runNewsShadow, readNewsShadow, inBackoff, NEWS_SOURCES, BACKOFF_AFTER_FAILURES, ITEMS_PREFIX, readShadowDays, shadowReport, shadowItemsSince, timeMs } from "../src/news-sources.mjs";

class MemoryKV { constructor() { this.map = new Map(); } async get(k) { return this.map.has(k) ? this.map.get(k) : null; } async put(k, v) { this.map.set(k, v); } }
const NOW = Date.parse("2026-11-16T14:05:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toUTCString();

const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[Gold climbs as the dollar &amp; yields slip]]></title><link>https://example.com/a</link><pubDate>${ago(10)}</pubDate></item>
<item><title>EUR/JPY consolidates near highs</title><link>https://example.com/b</link><pubDate>${ago(20)}</pubDate></item>
<item><title>Oil extends losses on OPEC supply worries</title><link>https://example.com/c</link><pubDate>${ago(90)}</pubDate></item>
</channel></rss>`;
const ATOM = `<feed><entry><title>Powell: policy is well positioned</title><link href="https://fed.example/s1"/><updated>${new Date(NOW - 30 * 60_000).toISOString()}</updated></entry></feed>`;

test("RSS and Atom items with their title, link and time; CDATA, tags and entities decoded", () => {
  const items = parseFeed(RSS);
  assert.deepEqual(items.map((i) => i.title), ["Gold climbs as the dollar & yields slip", "EUR/JPY consolidates near highs", "Oil extends losses on OPEC supply worries"]);
  assert.equal(items[0].url, "https://example.com/a");
  assert.equal(items[0].published_at, new Date(NOW - 10 * 60_000).toISOString());
  assert.deepEqual(parseFeed(ATOM), [{ title: "Powell: policy is well positioned", url: "https://fed.example/s1", published_at: new Date(NOW - 30 * 60_000).toISOString() }]);
  assert.deepEqual(parseFeed("not xml"), []);
  assert.deepEqual(parseGdelt({ articles: [{ title: "Gold hits a record", url: "https://g.example/1", seendate: "20261116T134500Z" }] }), [{ title: "Gold hits a record", url: "https://g.example/1", published_at: "2026-11-16T13:45:00.000Z" }]);
  assert.deepEqual(parseGdelt(null), []);
});

test("a headline is tagged with the system's symbols; the Fed's own feeds are about the dollar", () => {
  assert.deepEqual(symbolsOf("Gold climbs as the dollar & yields slip"), ["OANDA:XAUUSD", "TVC:DXY"]);
  assert.deepEqual(symbolsOf("Oil extends losses on OPEC supply worries"), ["TVC:USOIL"]);
  assert.deepEqual(symbolsOf("EUR/JPY consolidates near highs"), []);
  assert.deepEqual(symbolsOf("Board announces a new member", "fed"), ["TVC:DXY"]);
  assert.ok(similarity("Gold climbs as dollar slips", "Gold climbs while the dollar slips") >= 0.5);
  assert.ok(similarity("Gold climbs", "Oil falls") < 0.5);
});

test("the comparison with TradingView over the last hour: overlap, each side's own stories, who had them first", () => {
  const mine = [
    { title: "Gold climbs as the dollar slips", published_at: new Date(NOW - 12 * 60_000).toISOString() },
    { title: "Powell says policy is well positioned", published_at: new Date(NOW - 30 * 60_000).toISOString() },
    { title: "Old gold story", published_at: new Date(NOW - 2 * 3_600_000).toISOString() }
  ];
  const tv = [
    { title: "Gold climbs as the dollar slips further", published_at: new Date(NOW - 8 * 60_000).toISOString() },
    { title: "US CPI comes in hot", published_at: new Date(NOW - 20 * 60_000).toISOString() }
  ];
  assert.deepEqual(compareWithTradingView(mine, tv, { now: NOW }), { shadow_recent: 2, tv_recent: 2, overlap: 1, shadow_only: 1, tv_only: 1, lead_minutes: 4 });
  assert.equal(compareWithTradingView([], [], { now: NOW }).lead_minutes, null);
  // TradingView's published_at as it is stored: epoch seconds, as a number or as digits.
  const tvSeconds = [
    { title: "Gold climbs as the dollar slips further", published_at: Math.floor((NOW - 8 * 60_000) / 1000) },
    { title: "US CPI comes in hot", published_at: String(Math.floor((NOW - 20 * 60_000) / 1000)) }
  ];
  assert.deepEqual(compareWithTradingView(mine, tvSeconds, { now: NOW }), { shadow_recent: 2, tv_recent: 2, overlap: 1, shadow_only: 1, tv_only: 1, lead_minutes: 4 });
});

test("an hourly shadow run: relevant, de-duplicated headlines; failing sources recorded; nothing thrown; the switch", async () => {
  const kv = new MemoryKV();
  const sources = [
    { id: "a", kind: "rss", url: "https://a.example/rss" },
    { id: "b", kind: "rss", url: "https://b.example/rss" },
    { id: "fed", kind: "rss", url: "https://fed.example/atom", topic: "fed" },
    { id: "down", kind: "rss", url: "https://down.example/rss" },
    { id: "gdelt", kind: "gdelt", url: "https://gdelt.example/doc" }
  ];
  const fetcher = async (url) => {
    if (url.startsWith("https://down")) return new Response("forbidden", { status: 403 });
    if (url.startsWith("https://fed")) return new Response(ATOM);
    if (url.startsWith("https://gdelt")) return new Response(JSON.stringify({ articles: [{ title: "Gold climbs as the dollar and yields slip", url: "https://g.example/1", seendate: "20261116T135500Z" }] }));
    return new Response(RSS);
  };
  const tvArticles = [{ title: "Gold climbs as the dollar and yields slip lower", published_at: new Date(NOW - 5 * 60_000).toISOString() }];
  const r = await runNewsShadow({ OAUTH_STORE: kv }, { tvArticles, now: NOW, fetcher, sources });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.sources.down, { ok: false, status: 403, consecutive_failures: 1, ms: r.sources.down.ms, items: 0, relevant: 0, last_hour: 0 });
  assert.deepEqual([r.sources.a.items, r.sources.a.relevant, r.sources.a.last_hour], [3, 2, 1], "EUR/JPY is not relevant; the oil story is older than an hour");
  // The same RSS from two sources and GDELT's near-identical story count once.
  const last = JSON.parse(await kv.get("news:shadow:last"));
  assert.deepEqual(last.headlines.map((h) => h.source), ["a", "fed", "a"]);
  assert.deepEqual([r.shadow_recent, r.tv_recent, r.overlap], [2, 1, 1]);
  const health = await readNewsShadow({ OAUTH_STORE: kv }, NOW);
  assert.equal("headlines" in health.last, false, "the health report carries no headline");
  assert.deepEqual([health.today.runs, health.today.sources.down.failed_runs, health.today.sources.a.ok_runs], [1, 1, 1]);
  // A fetch that throws is a failed source, not a failed run.
  const broken = await runNewsShadow({ OAUTH_STORE: new MemoryKV() }, { now: NOW, fetcher: async () => { throw new Error("boom"); }, sources });
  assert.deepEqual([broken.status, broken.sources.a.ok, broken.sources.a.error], ["ok", false, "boom"]);
  assert.deepEqual(await runNewsShadow({ NEWS_SHADOW_MODE: "off" }, { now: NOW, fetcher, sources }), { status: "off" });
  assert.ok(NEWS_SOURCES.length >= 5 && NEWS_SOURCES.every((s) => /^https:\/\//.test(s.url)));
});

test("GDELT: its own time limit, a 429 named as rate limited, and a backoff after failing runs in a row", async () => {
  const gdelt = NEWS_SOURCES.find((x) => x.id === "gdelt");
  assert.equal(gdelt.timeoutMs, 20_000, "production 2026-11-14: 17 of 17 runs past the 6-second limit");
  assert.equal(gdelt.backoff, true);
  assert.ok(NEWS_SOURCES.filter((x) => x.id !== "gdelt").every((x) => !x.backoff && x.timeoutMs == null), "the feeds keep the 6-second limit");
  const at = (h) => Date.UTC(2026, 10, 16, h, 5);
  assert.equal(inBackoff(gdelt, BACKOFF_AFTER_FAILURES - 1, at(1)), false);
  assert.equal(inBackoff(gdelt, BACKOFF_AFTER_FAILURES, at(1)), true);
  assert.equal(inBackoff(gdelt, BACKOFF_AFTER_FAILURES, at(6)), false, "every 6th hour it is asked again");
  assert.equal(inBackoff({ id: "rss" }, 10, at(1)), false, "a source without backoff is always asked");

  const kv = new MemoryKV();
  const sources = [{ id: "g", kind: "gdelt", backoff: true, url: "https://g.example/doc" }];
  let asked = 0;
  const limited = async () => { asked += 1; return new Response("Please limit requests", { status: 429 }); };
  let r;
  for (let i = 0; i < BACKOFF_AFTER_FAILURES; i++) r = await runNewsShadow({ OAUTH_STORE: kv }, { now: at(1 + i % 4), fetcher: limited, sources });
  assert.deepEqual([r.sources.g.status, r.sources.g.error, r.sources.g.consecutive_failures], [429, "rate_limited", BACKOFF_AFTER_FAILURES]);
  assert.equal(asked, BACKOFF_AFTER_FAILURES);
  // Backing off: not asked, the count of failures kept, the day counts it as skipped, not failed.
  r = await runNewsShadow({ OAUTH_STORE: kv }, { now: at(4), fetcher: limited, sources });
  assert.equal(asked, BACKOFF_AFTER_FAILURES);
  assert.deepEqual([r.sources.g.skipped, r.sources.g.consecutive_failures], ["backoff", BACKOFF_AFTER_FAILURES]);
  const day = JSON.parse(await kv.get("news:shadow:day:2026-11-16"));
  assert.deepEqual([day.sources.g.failed_runs, day.sources.g.skipped_runs], [BACKOFF_AFTER_FAILURES, 1]);
  // On the 6th hour it is asked again; an answer ends the backoff.
  r = await runNewsShadow({ OAUTH_STORE: kv }, { now: at(6), fetcher: async () => new Response(JSON.stringify({ articles: [] })), sources });
  assert.deepEqual([r.sources.g.ok, r.sources.g.consecutive_failures], [true, undefined]);
  r = await runNewsShadow({ OAUTH_STORE: kv }, { now: at(7), fetcher: limited, sources });
  assert.equal(r.sources.g.consecutive_failures, 1, "counted from zero again");
});


test("measurement phase A (2026-11-17): each headline kept once a day with its first-seen time; the report matches, times and flags", async () => {
  const kv = new MemoryKV();
  const sources = [{ id: "a", kind: "rss", url: "https://a.example/rss" }, { id: "gdelt", kind: "gdelt", url: "https://gdelt.example/doc" }];
  const limited = async (url) => (url.startsWith("https://gdelt") ? new Response("slow down", { status: 429 }) : new Response(RSS));
  const tvArticles = [
    { title: "Gold climbs as the dollar and yields slip", url: "https://tv.example/1", published_at: new Date(NOW - 2 * 60_000).toISOString() },
    { title: "US CPI rises more than expected in October", url: "https://tv.example/2", published_at: new Date(NOW - 3 * 60_000).toISOString() }
  ];
  await runNewsShadow({ OAUTH_STORE: kv }, { tvArticles, tvStatus: "ok", now: NOW, fetcher: limited, sources });
  // The next hour: the same headlines are not stored twice, and TradingView's pull was refused for the chart.
  await runNewsShadow({ OAUTH_STORE: kv }, { tvArticles: [], tvStatus: "reserved_for_chart", now: NOW + 3_600_000, fetcher: limited, sources });
  const day = JSON.parse(await kv.get(ITEMS_PREFIX + "2026-11-16"));
  assert.equal(Object.keys(day.shadow).length, 2, "gold and oil from source a, once");
  assert.equal(Object.keys(day.tv).length, 2);
  assert.deepEqual(Object.values(day.shadow).map((x) => x.f), [new Date(NOW).toISOString(), new Date(NOW).toISOString()], "first-seen kept from the first hour");
  assert.deepEqual([day.hours["14"].tv_status, day.hours["15"].tv_status], ["ok", "reserved_for_chart"]);

  const report = shadowReport(await readShadowDays({ OAUTH_STORE: kv }, 2, NOW + 3_600_000), { now: NOW + 3_600_000 });
  assert.deepEqual(report.coverage, { shadow_items: 2, tv_items: 2, overlap: 1, shadow_only: 1, tv_only: 1, tv_hours_pulled: 1, hours: 2 });
  assert.equal(report.latency_minutes.shadow.a.n, 2);
  assert.equal(report.latency_minutes.shadow.a.median, 10, "first seen 10 minutes after the gold story's publication (the oil one is 90)");
  assert.equal(report.latency_minutes.lead_shadow_over_tv.median, 0, "both first seen in the same hourly run");
  assert.deepEqual(report.high_impact.tv_only.map((x) => x.title), ["US CPI rises more than expected in October"], "a high-impact story only TradingView carried is named");
  assert.equal(report.reliability.gdelt.rate_limited, 2);
  assert.equal(report.reliability.gdelt.unreliable, true, "GDELT is flagged");
  assert.equal(report.reliability.a.unreliable, false);
  assert.equal(report.quality.relevance_by_source.a, 0.667, "2 of 3 headlines relevant, both runs");
  assert.deepEqual(report.quality.script_mix.shadow, { latin: 2 });
  assert.deepEqual(report.days.map((d) => d.date), ["2026-11-15", "2026-11-16"], "oldest first");
  // Phase B reads the last hours of both sides through the Worker's RPC.
  const recent = await shadowItemsSince({ OAUTH_STORE: kv }, 24, NOW + 3_600_000);
  assert.deepEqual([recent.shadow.length, recent.tv.length], [2, 2]);
  assert.ok(recent.shadow.every((x) => x.title && x.source));
  assert.deepEqual((await shadowItemsSince({ OAUTH_STORE: kv }, 1, NOW + 3 * 3_600_000)).shadow, [], "first seen more than an hour ago");
});

test("the report (2026-11-25 fix): a headline stored again under the next UTC day counts once, with its earliest first-seen", async () => {
  // As stored in production: the hourly run at 00:04 UTC finds the same feed items and keeps them again under the new day.
  const kv = new MemoryKV();
  const sources = [{ id: "a", kind: "rss", url: "https://a.example/rss" }];
  const rss = `<rss><channel><item><title>Gold climbs as the dollar and yields slip</title><link>https://a.example/g</link><pubDate>Mon, 16 Nov 2026 22:50:00 GMT</pubDate></item></channel></rss>`;
  const fetcher = async () => new Response(rss);
  const late = Date.parse("2026-11-16T23:04:00Z"), next = Date.parse("2026-11-17T00:04:00Z");
  await runNewsShadow({ OAUTH_STORE: kv }, { now: late, fetcher, sources });
  await runNewsShadow({ OAUTH_STORE: kv }, { now: next, fetcher, sources });
  assert.equal(Object.keys(JSON.parse(await kv.get(ITEMS_PREFIX + "2026-11-16")).shadow).length, 1);
  assert.equal(Object.keys(JSON.parse(await kv.get(ITEMS_PREFIX + "2026-11-17")).shadow).length, 1, "stored again under the new day (the old keys)");
  const report = shadowReport(await readShadowDays({ OAUTH_STORE: kv }, 2, next), { now: next });
  assert.equal(report.coverage.shadow_items, 1, "counted once over the window");
  assert.deepEqual(report.days.map((d) => [d.date, d.shadow]), [["2026-11-16", 1], ["2026-11-17", 0]], "on the day it was first seen");
  assert.deepEqual(report.latency_minutes.shadow.a, { median: 14, p90: 14, n: 1 }, "23:04 less 22:50, not 00:04");

  // Pure, and in any order of days: the earliest first-seen wins; another headline of the second day still counts.
  const gold = { s: "a", t: "Gold climbs as the dollar and yields slip", u: "https://a.example/g", p: "2026-11-16T22:50:00.000Z" };
  const days = [
    { date: "2026-11-17", items: { shadow: { g: { ...gold, f: "2026-11-17T00:04:00.000Z" }, o: { s: "b", t: "Oil extends losses on OPEC supply worries", u: "https://b.example/o", p: "2026-11-17T00:00:00.000Z", f: "2026-11-17T00:04:00.000Z" } }, tv: {}, hours: {} } },
    { date: "2026-11-16", items: { shadow: { g: { ...gold, f: "2026-11-16T23:04:00.000Z" } }, tv: {}, hours: {} } }
  ];
  const r = shadowReport(days, { now: next });
  assert.equal(r.coverage.shadow_items, 2);
  assert.deepEqual(r.days.map((d) => [d.date, d.shadow]), [["2026-11-17", 1], ["2026-11-16", 1]]);
  assert.deepEqual([r.latency_minutes.shadow.a.median, r.latency_minutes.shadow.b.median], [14, 4]);
});

test("the report (2026-11-25 fix): TradingView's epoch-second publication times give its latency, the six-hour window and the lead", () => {
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
  const title = "Gold climbs as the dollar and yields slip";
  const days = [{
    date: "2026-11-16",
    items: {
      shadow: { g: { s: "a", t: title, u: "https://a.example/g", p: "2026-11-16T13:00:00.000Z", f: "2026-11-16T14:05:00.000Z" } },
      tv: {
        t1: { t: title, u: "https://tv.example/1", p: sec("2026-11-16T14:50:00Z"), f: "2026-11-16T15:05:00.000Z" },
        t2: { t: "US CPI rises more than expected in October", u: "https://tv.example/2", p: String(sec("2026-11-16T14:35:00Z")), f: "2026-11-16T15:05:00.000Z" }
      },
      hours: {}
    }
  }];
  const r = shadowReport(days, { now: Date.parse("2026-11-16T16:00:00Z") });
  assert.deepEqual(r.latency_minutes.tv, { median: 15, p90: 15, n: 2 }, "15 and 30 minutes, from seconds as a number and as digits (pct rounds the rank down)");
  assert.equal(r.coverage.overlap, 1);
  assert.deepEqual(r.latency_minutes.lead_shadow_over_tv, { median: 60, p90: 60, n: 1 }, "the shadow saw it an hour earlier");
  assert.equal(r.high_impact.tv_only[0].published_at, "2026-11-16T14:35:00.000Z", "shown as ISO");

  // The same title published more than six hours apart is another story: the window now applies to seconds too.
  days[0].items.tv.t1.p = sec("2026-11-16T20:00:00Z");
  days[0].items.tv.t1.f = "2026-11-16T20:05:00.000Z";
  const apart = shadowReport(days, { now: Date.parse("2026-11-16T21:00:00Z") });
  assert.equal(apart.coverage.overlap, 0);
  assert.equal(apart.latency_minutes.lead_shadow_over_tv.n, 0);

  // Seconds, milliseconds and ISO read the same; nothing else is a time.
  const ms = Date.parse("2026-11-16T14:50:00Z");
  assert.deepEqual([timeMs(ms / 1000), timeMs(ms), timeMs(String(ms / 1000)), timeMs(" 2026-11-16T14:50:00Z ")], [ms, ms, ms, ms]);
  assert.ok([null, undefined, "", "soon", 0, -5, NaN, {}].every((v) => Number.isNaN(timeMs(v))));
});
