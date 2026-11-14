// News without TradingView, in shadow (owner 2026-11-14; docs/RFC_CONTENT_AGENT.md P0).
import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseGdelt, symbolsOf, similarity, compareWithTradingView, runNewsShadow, readNewsShadow, NEWS_SOURCES } from "../src/news-sources.mjs";

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
  assert.deepEqual(r.sources.down, { ok: false, status: 403, ms: r.sources.down.ms, items: 0, relevant: 0, last_hour: 0 });
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
