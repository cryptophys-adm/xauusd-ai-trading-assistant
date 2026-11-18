// The public War Room reading (owner 2026-11-18, confirmed: "Real-time analysis"): bias, reasons and metrics of a room,
// the news digest's reading of gold; never the decision, its confidence, a price or order wording.
import test from "node:test";
import assert from "node:assert/strict";
import { publicRoomReading, publicNewsReading, readPublicWarRoom, readingSentences, WARROOM_SOURCES } from "../src/public-warroom.mjs";

const ROW = {
  bar_close: "2026-11-18T17:00:00.000Z", bias: "BEARISH", agents_heard: 10,
  body_json: JSON.stringify({ conclusion: { stance: "SELL", confidence: 0.88, summary: "Decision SELL, bias bearish: the dollar leads.",
    reasons: ["Rounding-top breakout and double-top formation sit below key Fibonacci levels, signalling a clear bearish move.", "Sell below 3741.80 with a stop at 3760.", "US dollar strength and gold ETF outflows add macro pressure to the downside.", "The confidence is high, so short now."],
    metrics: ["rounding top breakout", "US dollar strength", "entry trigger", "footprint matrix order flow"] } })
};

test("PW1 a room's reading: bias, reasons and metrics; never the decision, its confidence, a price or order wording", () => {
  const r = publicRoomReading(ROW, "1h");
  assert.deepEqual([r.source, r.label, r.bias, r.analysts, r.at], ["1h", "1H", "bearish", 10, "2026-11-18T17:00:00.000Z"]);
  assert.deepEqual(r.reasons, [
    "Rounding-top breakout and double-top formation sit below key Fibonacci levels, signalling a clear bearish move.",
    "US dollar strength and gold ETF outflows add macro pressure to the downside."
  ]);
  assert.deepEqual(r.metrics, ["rounding top breakout", "US dollar strength", "footprint matrix order flow"]);
  const s = JSON.stringify(r);
  assert.doesNotMatch(s, /SELL|0\.88|confidence|stance|3741|3760|stop/i);
  assert.equal(publicRoomReading({ ...ROW, bias: null, body_json: "{}" }, "1h"), null, "no bias, no reading");
  assert.equal(publicRoomReading(ROW, "news"), null);
  assert.deepEqual(Object.keys(WARROOM_SOURCES), ["15m", "1h", "4h", "1d", "news"]);
});

test("PW2 the news reading: the digest's bias, summary, reasons, counts and headlines without prices or signals", () => {
  const daily = {
    run_at: "r1", window_to: "2026-11-18T17:00:00.000Z", counts: { BULLISH: 3, BEARISH: 9, NEUTRAL: 5 },
    tldr: { status: "ok", stance: "BEARISH", confidence: 0.7, summary: "A firm dollar and ETF outflows weigh on gold. Traders should sell rallies.", reasons: ["Fed speakers stay hawkish.", "Gold slid to 3,740 overnight."] },
    items: [
      { title: "Dollar firms as Fed speakers stay hawkish", bias: "BEARISH", published_at: "2026-11-18T12:00:00Z" },
      { title: "Gold falls to $3,740 as yields climb", bias: "BEARISH" },
      { title: "Analysts say buy the dip in gold", bias: "BULLISH" },
      { title: "ETF holdings steady", bias: null },
      { title: "Central banks keep adding gold", bias: "BULLISH" }
    ]
  };
  const n = publicNewsReading(daily);
  assert.deepEqual([n.source, n.bias, n.at], ["news", "bearish", "2026-11-18T17:00:00.000Z"]);
  assert.deepEqual(n.summary, ["A firm dollar and ETF outflows weigh on gold."]);
  assert.deepEqual(n.reasons, ["Fed speakers stay hawkish."]);
  assert.deepEqual(n.counts, { bullish: 3, bearish: 9, neutral: 5 });
  assert.deepEqual(n.items.map((i) => [i.title, i.bias]), [["Dollar firms as Fed speakers stay hawkish", "bearish"], ["Central banks keep adding gold", "bullish"]]);
  assert.doesNotMatch(JSON.stringify(n), /0\.7|confidence|stance|3,740|buy|sell/i);
  assert.equal(publicNewsReading(null), null);
  assert.deepEqual(readingSentences("Go long here. Gold eased. Footprint order flow shows sellers in control. Place a limit order."), ["Gold eased.", "Footprint order flow shows sellers in control."]);
});

test("PW3 the reader: the latest concluded run of the source's room; news from the digest; an unknown source refused", async () => {
  const asked = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({ first: async () => { asked.push([sql, a]); return ROW; } }) }) } };
  const r = await readPublicWarRoom(env, { source: "1h" });
  assert.equal(r.bias, "bearish");
  assert.match(asked[0][0], /FROM room_runs WHERE room = \? AND status = 'concluded' ORDER BY bar_close DESC LIMIT 1/);
  assert.deepEqual(asked[0][1], ["tf:H1"]);
  await readPublicWarRoom(env, { source: "15m" });
  assert.deepEqual(asked[1][1], ["warroom"]);
  const news = await readPublicWarRoom(env, { source: "news" }, { readNewsDaily: async () => ({ tldr: { status: "ok", stance: "BULLISH", summary: "Gold firmed.", reasons: [] }, items: [] }) });
  assert.equal(news.bias, "bullish");
  assert.match((await readPublicWarRoom(env, { source: "5m" })).error, /source must be one of 15m, 1h, 4h, 1d, news/);
  const empty = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  assert.match((await readPublicWarRoom(empty, { source: "1d" })).error, /no reading/);
});
