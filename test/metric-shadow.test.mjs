// Metric interpretations, not prose, in shadow (owner 2026-11-14): the menu each agent may cite, the grounding
// of its answer, the price rule, and the stored comparison with its live stance.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { metricMenu, checkMetricAnswer, noLevels, runMetricShadow, scoreMetricShadow, readMetricShadow, compareMetricShadow, resetMetricShadowSchemaCacheForTests } from "../src/metric-shadow.mjs";

const candles = Array.from({ length: 25 }, (_, i) => ({ o: 4000 + i, h: 4003 + i, l: 3998 + i, c: 4001 + i }));

test("the menu holds the agent's own data: statements as L1..Ln, fields by path, candles as distances and ratios, never a price level", () => {
  const menu = metricMenu({ candles_15m: candles, ranges_15m: [5, 5, 5], confirmations: { chart_prophet_r38: { buy_confirmed: true } } });
  const ids = menu.map((m) => m.id);
  assert.ok(ids.includes("candles_15m.change_4") && ids.includes("candles_15m.range_ratio") && ids.includes("confirmations.chart_prophet_r38.buy_confirmed"));
  assert.ok(!ids.some((id) => /\.(close|high_20|low_20)$/.test(id)), ids.join(", "));
  assert.ok(menu.every((m) => !(typeof m.value === "number" && Math.abs(m.value) >= 1000)));
  const hud = metricMenu({ hud: "Supertrend", reading: ["Verified by parity: trend up since 4,012.5", "Not yet calibrated: flip soon"] });
  assert.deepEqual(hud.filter((m) => /^L\d/.test(m.id)).map((m) => m.value), ["Verified by parity: trend up since [level]", "Not yet calibrated: flip soon"]);
  assert.equal(noLevels(4012.5), null);
  assert.equal(noLevels(0.62), 0.62);
});

test("an answer is valid in form, and grounded by the share of its metrics on the menu", () => {
  const menu = metricMenu({ candles_15m: candles });
  const answer = { stance: "BUY", confidence: 0.6, metrics: [
    { id: "candles_15m.change_4", value: 4, reading: "rising_4_bars", implication: "bullish", weight: 0.6 },
    { id: "rsi_14", value: 71, reading: "overbought", implication: "bearish", weight: 0.4 }
  ] };
  const check = checkMetricAnswer(answer, menu);
  assert.deepEqual([check.valid, check.cited, check.grounded], [true, 2, 1]);
  assert.equal(checkMetricAnswer({ stance: "BUY", confidence: 0.6, metrics: [{ id: "x", reading: "a sentence that is far too long to be a reading label at all, really", implication: "bullish", weight: 1 }] }, menu).valid, false);
  assert.equal(checkMetricAnswer({ stance: "MAYBE", confidence: 0.6, metrics: answer.metrics }, menu).valid, false);
});

function d1() {
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return {}; }, async first() { return raw.prepare(sql).get(...params) ?? null; }, async all() { return { results: raw.prepare(sql).all(...params) }; } });
  return { raw, prepare: (sql) => stmt(sql) };
}

test("the arm stores each answer beside the live stance, once per bar, and scores both on the same 15m outcome", async () => {
  resetMetricShadowSchemaCacheForTests();
  const DB = d1();
  const barTime = "2026-11-16T10:15:00.000Z";
  const answer = { stance: "SELL", confidence: 0.55, metrics: [{ id: "candles_15m.change_4", value: -4, reading: "falling_4_bars", implication: "bearish", weight: 1 }] };
  const AI = { async run() { return { response: JSON.stringify(answer), usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } }; } };
  // 20 flat bars up to the room's bar (ATR history), then a falling series: SELL is right, BUY is wrong.
  const close = Date.parse(barTime);
  const bars = Array.from({ length: 27 }, (_, n) => {
    const k = n - 20, o = k <= 0 ? 4000 : 4000 - 3 * (k - 1);
    const bar = k <= 0 ? { open: o, high: o + 2, low: o - 2, close: o } : { open: o, high: o, low: o - 6, close: o - 5 };
    return { open_time: new Date(close + (k - 1) * 900_000).toISOString(), close_time: new Date(close + k * 900_000).toISOString(), ...bar };
  });
  const kv = new Map([["market-data:v2:series:OANDA:XAUUSD|15m", JSON.stringify({ candles: bars })]]);
  const env = { DB, AI, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null } };
  const args = { room: "M15", barTime, agents: [{ agent: "technical", stance: "BUY" }], dataFor: () => ({ candles_15m: candles }), roleFor: () => "You are the Technical Analyst.", clock: () => close + 60_000 };
  const first = await runMetricShadow(env, args);
  assert.equal(first.stored, 1, JSON.stringify(first));
  assert.equal((await runMetricShadow(env, args)).skipped, 1);
  const row = DB.raw.prepare("SELECT * FROM metric_shadow_outputs").get();
  assert.deepEqual([row.agent, row.stance, row.control_stance, row.status, row.cited, row.grounded], ["technical", "SELL", "BUY", "ok", 1, 1]);
  assert.ok(!/\b\d{4}\.\d/.test(row.metrics_json), "no price level is stored");
  const scored = await scoreMetricShadow(env, { now: close + 7 * 900_000 });
  assert.equal(scored.scored, 1);
  const view = await readMetricShadow(env, { now: close + 86_400_000 });
  const t = view.agents.find((a) => a.agent === "technical");
  assert.deepEqual([t.validity, t.grounding_rate, t.stance_agreement], [1, 1, 0]);
  assert.equal(t.hit_rate, 1);
  assert.equal(t.control_hit_rate, 0);
  // The hourly cap: a new bar with the hour's budget spent calls nothing.
  const capped = await runMetricShadow({ ...env, METRIC_SHADOW_MAX_CALLS_PER_HOUR: "1" }, { ...args, barTime: "2026-11-16T10:30:00.000Z" });
  assert.deepEqual([capped.status, capped.called], ["budget_exhausted", 0]);
  // METRIC_SHADOW off: nothing runs.
  assert.equal((await runMetricShadow({ ...env, METRIC_SHADOW: "off" }, args)).status, "disabled");
});

test("the comparison per agent", () => {
  const rows = [
    { agent: "risk", status: "ok", stance: "WAIT", control_stance: "WAIT", cited: 3, grounded: 3, result: "hit", control_result: "hit", usage_tokens: 900, latency_ms: 2000 },
    { agent: "risk", status: "invalid_output", stance: null, control_stance: "BUY", cited: 0, grounded: 0, usage_tokens: 800, latency_ms: 1800 }
  ];
  const [r] = compareMetricShadow(rows);
  assert.deepEqual([r.calls, r.validity, r.grounding_rate, r.stance_agreement, r.tokens_per_call], [2, 0.5, 1, 1, 850]);
});
