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

test("PW4 the stricter filter (2026-11-19, per-analyst text): whole sentences only, no positional wording, Matrix, ratios", async () => {
  const { readingSentences, publicPhrase } = await import("../src/public-warroom.mjs");
  const long = "The momentum indicators across the session have stayed weak and the structure keeps printing lower highs with every bounce being sold into by larger participants, which is enough to justify a high-confidence sell.";
  assert.ok(long.length > 200);
  assert.deepEqual(readingSentences(long, { len: 260 }), [], "a forbidden word deep in a long sentence still refuses it");
  assert.deepEqual(readingSentences("Gold drifted lower through London. " + "x".repeat(230) + "."), ["Gold drifted lower through London."], "too long: dropped, never clipped");
  assert.deepEqual(readingSentences("Structure is bearish. Waiting for the next candle to confirm the move. Staying flat here. No setup is trade-ready. Pattern #1 holds."), ["Structure is bearish."]);
  assert.deepEqual(readingSentences("The Decision Matrix sees a bearish confluence."), ["The Matrix sees a bearish confluence."]);
  assert.equal(publicPhrase("Price respects the Fibonacci 0.618 level."), true, "a ratio is no price");
  assert.equal(publicPhrase("Price respects 3741.80."), false);
  assert.equal(publicPhrase("The environment is stable enough to trade, but the direction is unconfirmed."), false, "trade readiness is positional");
});

test("PW5 the room scene: roster, metrics, filtered claim and rebuttal per analyst; never a stance or confidence", async () => {
  const { publicRoomScene } = await import("../src/public-warroom.mjs");
  const row = { bar_close: "2026-11-19T01:45:00.000Z", bias: "BEARISH", agents_heard: 3, body_json: JSON.stringify({
    conclusion: { stance: "SELL", confidence: 0.88, reasons: ["The dollar index near 19-month highs pulls gold lower."] },
    agents: [{ agent: "supertrend", status: "ok", stance: "WAIT", bias: "BULLISH", confidence: 0.4, metrics: ["the supertrend"] }, { agent: "fabio_amt", status: "ok", stance: "SELL", bias: "BEARISH", confidence: 0.8 }, { agent: "decision_matrix", status: "failed" }] }) };
  const msgs = [
    { step: "open:supertrend", agent: "supertrend", body_json: JSON.stringify({ claim: "The supertrend stays below price. Wait for the next close before acting.", bias: "BULLISH", metrics: ["the supertrend indicator"] }) },
    { step: "open:fabio_amt", agent: "fabio_amt", body_json: JSON.stringify({ claim: "Sellers dominate the footprint order flow below the value area.", bias: "BEARISH", metrics: ["the value area range", "the footprint order flow"] }) },
    { step: "debate:fabio_amt", agent: "fabio_amt", body_json: JSON.stringify({ argument: "I disagree with the bullish momentum claim. Sell at 3741.", rebuts: ["supertrend", "ghost"], bias: "BEARISH" }) }
  ];
  const s = publicRoomScene(row, msgs, "15m");
  assert.deepEqual([s.source, s.bias, s.moderator.length], ["15m", "bearish", 1]);
  assert.deepEqual(s.analysts.map((a) => a.id), ["supertrend", "fabio_amt"], "a failed seat is not on the roster");
  const st = s.analysts[0], fa = s.analysts[1];
  assert.deepEqual([st.bias, st.claim, st.metrics], ["bullish", ["The supertrend stays below price."], ["the supertrend indicator"]]);
  assert.deepEqual([fa.claim, fa.rebuttal, fa.rebuts], [["Sellers dominate the footprint order flow below the value area."], ["I disagree with the bullish momentum claim."], ["supertrend"]]);
  assert.doesNotMatch(JSON.stringify(s), /SELL|WAIT|stance|confidence|0\.88|0\.8\b|3741/);
});

test("PW6 the 1H, 4H and 1D rooms keep their statements in the run document's steps: the scene reads them there", async () => {
  const { publicRoomScene, readPublicWarRoomScene } = await import("../src/public-warroom.mjs");
  const steps = [
    { id: 2, step: "open:h1", agent: "h1", body_json: JSON.stringify({ claim: "The hourly candle closed below the prior low.", bias: "BEARISH", metrics: ["the last closed candles"] }) },
    { id: 3, step: "debate:risk", agent: "risk", body_json: JSON.stringify({ argument: "The range is still wide for this timeframe.", rebuts: ["h1"], bias: "NEUTRAL" }) },
    { id: 4, step: "shadow:risk", agent: "risk", body_json: JSON.stringify({ argument: "A shadow answer is never shown." }) }
  ];
  const row = { bar_close: "2026-11-19T02:00:00.000Z", bias: "BEARISH", body_json: JSON.stringify({ conclusion: { reasons: ["Lower closes dominate the hour."] }, agents: [{ agent: "h1", status: "ok" }, { agent: "risk", status: "ok" }], thread_id: "tf:H1", steps }) };
  const s = publicRoomScene(row, null, "1h");
  assert.deepEqual(s.analysts.map((a) => [a.id, a.claim, a.rebuttal, a.rebuts]), [["h1", ["The hourly candle closed below the prior low."], [], []], ["risk", [], ["The range is still wide for this timeframe."], ["h1"]]]);
  assert.doesNotMatch(JSON.stringify(s), /shadow answer/);
  // With steps in the document, no agent_thread_messages query is made.
  const seen = [];
  const env = { DB: { prepare: (sql) => ({ bind: () => ({ first: async () => (sql.includes("room_runs") ? row : null), all: async () => { seen.push(sql); return { results: [] }; } }) }) } };
  const out = await readPublicWarRoomScene(env);
  assert.equal(out.rooms["1h"].analysts.length, 2);
  assert.deepEqual(seen, [], "the thread table is not read");
});

test("2026-11-22 (the frontend session on the CTA home): positional wording and spelled-out dollar amounts are refused", async () => {
  const { publicPhrase, SPOKEN_AMOUNT } = await import("../src/public-warroom.mjs");
  for (const refused of [
    "I would not take any move until price action stabilizes or a setup triggers.",
    "The average range is sitting at one hundred two dollars.",
    "That is one hundred and two dollars of range.",
    "The average range is about twenty-five dollars per hour.",
    "A spike increases the risk of being stopped out.",
    "Momentum would take a move above the range to confirm."
  ]) assert.equal(publicPhrase(refused), false, refused);
  for (const kept of ["The US dollar strength weighs on gold.", "A dollar rally would pressure gold.", "The 4H trend and the dollar move apart.", "Momentum is fading on the 4H chart."]) assert.equal(publicPhrase(kept), true, kept);
  assert.equal(SPOKEN_AMOUNT.test("one hundred two dollars"), true);
});
