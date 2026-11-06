import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resetThreadSchemaCacheForTests } from "../src/agent-threads.mjs";
import {
  runNewsDaily, readNewsDaily, newsDeskEvidence, collectDailyArticles, marketContext, validateTags, validateNewsTldr,
  NEWS_DAILY_BATCH
} from "../src/news-daily.mjs";

const NOW = Date.parse("2026-11-06T01:06:00.000Z");
const H = 3600_000;

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE news_analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, analysis_key TEXT, fetched_at TEXT, analyzed_at TEXT, article_count INTEGER, evidence_json TEXT)`);
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { map: m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };

const article = (n, hoursAgo) => ({ id: `tag:reuters.com,2026:n${n}`, title: `Headline number ${n} about gold and the dollar`, summary: "", url: `https://www.tradingview.com/news/n${n}/`, source: "", published_at: Math.floor((NOW - hoursAgo * H) / 1000), symbols: ["OANDA:XAUUSD"] });
function addAnalysis(db, hoursAgo, articles) {
  db.raw.prepare("INSERT INTO news_analyses (analysis_key, analyzed_at, article_count, evidence_json) VALUES (?, ?, ?, ?)").run(
    "k" + hoursAgo, new Date(NOW - hoursAgo * H).toISOString(), articles.length, JSON.stringify({ articles })
  );
}
function closes(stepMs, first, last, count = 40) {
  const end = Math.floor(NOW / stepMs) * stepMs;
  return JSON.stringify({ candles: Array.from({ length: count }, (_, i) => {
    const open = end - (count - i) * stepMs;
    const c = first + ((last - first) * i) / (count - 1);
    return { open_time: new Date(open).toISOString(), close_time: new Date(open + stepMs).toISOString(), open: c, high: c + 1, low: c - 1, close: c };
  }) });
}

/** Tags every headline from its number (odd BULLISH, even BEARISH); the TLDR follows. */
function fakeAI({ tldr = null } = {}) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push(request);
      const user = request.messages[1].content;
      let content;
      if (/Write the TLDR/.test(request.messages[0].content + user)) content = tldr || { stance: "BULLISH", confidence: 0.6, summary: "A softer dollar and dovish rate talk supported gold over the day.", reasons: ["Most headlines point to lower yields.", "Gold rose with the dollar falling."] };
      else {
        const items = JSON.parse(user.slice(user.lastIndexOf("HEADLINES:") + "HEADLINES:".length).trim());
        content = { items: items.map((it) => ({ n: it.n, bias: Number(it.title.match(/number (\d+)/)[1]) % 2 ? "BULLISH" : "BEARISH", why: "The headline points to a weaker dollar for gold." })) };
      }
      return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 30 } };
    }
  };
}
function env(ai) {
  const db = fakeD1();
  addAnalysis(db, 1, [article(1, 0.5), article(2, 0.8)]);
  addAnalysis(db, 5, [article(3, 5), article(2, 0.8)]); // article 2 repeats: counted once
  addAnalysis(db, 30, [article(9, 30)]); // older than 24 hours: left out
  return {
    DB: db, AI: ai, NEWS_DAILY_ENABLED: "true", NEWS_DAILY_MAX_CALLS_PER_HOUR: "6",
    SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|1h": closes(H, 4000, 4040), "market-data:v2:series:TVC:DXY|4h": closes(4 * H, 100, 99) })
  };
}

test.beforeEach(() => resetThreadSchemaCacheForTests());

test("the articles are the unique headlines of the last 24 hours, newest first", async () => {
  const items = await collectDailyArticles(env(fakeAI()).DB, NOW);
  assert.deepEqual(items.map((i) => i.id.split(":").at(-1)), ["n1", "n2", "n3"]);
  assert.equal(items[0].published_at, new Date(Math.floor((NOW - 0.5 * H) / 1000) * 1000).toISOString());
});

test("market context: the 24-hour moves of gold and the dollar; absent series stay null", async () => {
  const c = await marketContext(env(fakeAI()), NOW);
  assert.ok(c.gold.change_24h_percent > 0);
  assert.ok(c.dollar.change_24h_percent < 0);
  assert.equal(c.oil, null);
});

test("tags and the TLDR are checked: every headline once, a valid bias, plain sentences", () => {
  assert.equal(validateTags({ items: [{ n: 1, bias: "BULLISH", why: "A weaker dollar helps gold." }] }, [1]).valid, true);
  assert.ok(validateTags({ items: [{ n: 1, bias: "UP", why: "x" }] }, [1]).errors.includes("bias_invalid"));
  assert.ok(validateTags({ items: [] }, [1]).errors.includes("items_incomplete"));
  assert.equal(validateNewsTldr({ stance: "NEUTRAL", confidence: 0.4, summary: "Mixed news.", reasons: ["Both sides.", ""] }).valid, true);
  assert.equal(validateNewsTldr({ stance: "BUY", confidence: 0.4, summary: "x", reasons: ["y"] }).valid, false);
});

test("a run tags each headline, writes the TLDR, and the desks read it; an unchanged day spends nothing", async () => {
  const ai = fakeAI();
  const e = env(ai);
  const r = await runNewsDaily(e, { now: NOW, clock: () => NOW });
  assert.equal(r.status, "complete");
  assert.equal(ai.calls.length, 2, "one tag batch and the TLDR");
  const d = await readNewsDaily(e.DB);
  assert.deepEqual(d.items.map((i) => i.bias), ["BULLISH", "BEARISH", "BULLISH"]);
  assert.deepEqual(d.counts, { bullish: 2, bearish: 1, neutral: 0, untagged: 0 });
  assert.equal(d.tldr.status, "ok");
  assert.equal(d.tldr.stance, "BULLISH");
  assert.ok(d.context.gold);
  const desk = await newsDeskEvidence(e.DB);
  assert.equal(desk.consensus, "BULLISH");
  assert.equal(desk.window, "the last 24 hours");

  assert.equal((await runNewsDaily(e, { now: NOW + 60_000, clock: () => NOW + 60_000 })).status, "unchanged");
  assert.equal(ai.calls.length, 2);
});

test("a new headline is the only one tagged on the next run (cached tags), then a new TLDR", async () => {
  const ai = fakeAI();
  const e = env(ai);
  await runNewsDaily(e, { now: NOW, clock: () => NOW });
  addAnalysis(e.DB, 0.1, [article(4, 0.05)]);
  const r = await runNewsDaily(e, { now: NOW + 60_000, clock: () => NOW + 60_000 });
  assert.equal(r.tagged_now, 1);
  const lastTag = ai.calls.at(-2).messages[1].content;
  assert.match(lastTag, /number 4/);
  assert.doesNotMatch(lastTag, /number 1 /);
  assert.equal((await readNewsDaily(e.DB)).items.length, 4);
});

test("off behind the flag; no article means no call; batches hold at most 20 headlines", async () => {
  const ai = fakeAI();
  assert.deepEqual(await runNewsDaily({ ...env(ai), NEWS_DAILY_ENABLED: "false" }), { status: "disabled" });
  const empty = env(ai);
  empty.DB.raw.exec("DELETE FROM news_analyses");
  assert.deepEqual(await runNewsDaily(empty, { now: NOW }), { status: "no_articles" });
  assert.equal(ai.calls.length, 0);
  assert.equal(NEWS_DAILY_BATCH, 20);
});
