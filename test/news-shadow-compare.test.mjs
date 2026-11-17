// Measurement phase B for the news shadow (owner 2026-11-17 "A dan B"): one daily reading of each headline set by
// the analyst, compared; shadow-metered and gated; it feeds nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { runNewsShadowCompare, readNewsShadowCompare, readingMessages, cleanReading, agreement, NEWS_COMPARE_METER } from "../src/news-shadow-compare.mjs";

function memDb() {
  const tables = { news_shadow_compare: new Map(), ai_usage_daily: [] };
  const stmt = (sql) => {
    let args = [];
    const s = {
      bind: (...a) => { args = a; return s; },
      run: async () => {
        if (/INSERT OR REPLACE INTO news_shadow_compare/.test(sql)) {
          const [day, at, tv_n, shadow_n, tv_json, shadow_json, agree_gold, agree_dollar, agree_impact, status] = args;
          tables.news_shadow_compare.set(day, { day, at, tv_n, shadow_n, tv_json, shadow_json, agree_gold, agree_dollar, agree_impact, status });
        }
        return {};
      },
      first: async () => (/SELECT day FROM news_shadow_compare/.test(sql) ? tables.news_shadow_compare.get(args[0]) ?? null : null),
      all: async () => {
        if (/FROM news_shadow_compare ORDER BY day DESC/.test(sql)) return { results: [...tables.news_shadow_compare.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, args[0]) };
        return { results: [] };
      }
    };
    return s;
  };
  return { tables, prepare: stmt };
}
const NIGHT = Date.parse("2026-11-17T21:10:00Z");
const items = {
  tv: [{ title: "US CPI rises more than expected; gold slips", published_at: "2026-11-17T13:30:00Z" }],
  shadow: [{ title: "Gold falls after hot US inflation data", source: "fxstreet", published_at: "2026-11-17T13:31:00Z" }]
};
const env = (over = {}) => ({ DB: memDb(), NEWS_INGESTION: { shadowItems: async () => items }, SIGNAL_CACHE: { get: async () => null }, ...over });
const answer = (obj) => async (_env, req) => { answer.calls.push(req); return { status: "answered", obj }; };

test("NB1. the readings: headlines only, a fixed schema, cleaned; agreement field by field", () => {
  const msgs = readingMessages([{ title: "Gold falls", published_at: "2026-11-17T13:31:00Z" }]);
  assert.match(msgs[1].content, /- Gold falls \(2026-11-17T13:31Z\)/);
  assert.doesNotMatch(JSON.stringify(msgs), /\d{4}\.\d/, "no price");
  assert.equal(cleanReading({ gold_bias: "UP", dollar_bias: "BEARISH", impact: "HIGH", catalysts: [] }), null);
  assert.deepEqual(agreement({ gold_bias: "BEARISH", dollar_bias: "BULLISH", impact: "HIGH" }, { gold_bias: "BEARISH", dollar_bias: "NEUTRAL", impact: "HIGH" }), { gold: true, dollar: false, impact: true });
});

test("NB2. once a day after 21:00 UTC, two shadow-metered calls, stored with the agreement", async () => {
  answer.calls = [];
  const e = env();
  const call = answer({ gold_bias: "BEARISH", dollar_bias: "BULLISH", impact: "HIGH", catalysts: ["US CPI"] });
  assert.equal((await runNewsShadowCompare(e, { now: Date.parse("2026-11-17T14:00:00Z"), call })).status, "waiting");
  const r = await runNewsShadowCompare(e, { now: NIGHT, call });
  assert.equal(r.status, "compared");
  assert.deepEqual(r.agreement, { gold: true, dollar: true, impact: true });
  assert.equal(answer.calls.length, 2);
  assert.ok(answer.calls.every((c) => c.meterSource === NEWS_COMPARE_METER && c.meterSource.startsWith("shadow:")), "metered as shadow: the switch and its breaker hold it");
  assert.equal((await runNewsShadowCompare(e, { now: NIGHT + 3_600_000, call })).status, "done", "once a day");
  assert.equal(answer.calls.length, 2);
  const report = await readNewsShadowCompare(e);
  assert.deepEqual([report.compared, report.agreement_rate.gold, report.rows[0].shadow.catalysts], [1, 1, ["US CPI"]]);
});

test("NB3. gated: the variable, the shadow switch, and a side without headlines", async () => {
  answer.calls = [];
  const call = answer({ gold_bias: "NEUTRAL", dollar_bias: "NEUTRAL", impact: "LOW", catalysts: [] });
  assert.equal((await runNewsShadowCompare(env({ NEWS_SHADOW_COMPARE: "off" }), { now: NIGHT, call })).status, "off");
  assert.equal((await runNewsShadowCompare(env({ SHADOW_MODE: "off" }), { now: NIGHT, call })).status, "shadow_off");
  const noTv = env({ NEWS_INGESTION: { shadowItems: async () => ({ tv: [], shadow: items.shadow }) } });
  const r = await runNewsShadowCompare(noTv, { now: NIGHT, call });
  assert.equal(r.status, "no_tv_headlines", "TradingView's pull was held back all day: said, not guessed");
  assert.equal(answer.calls.length, 1, "only the side with headlines is read");
});
