import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resetThreadSchemaCacheForTests } from "../src/agent-threads.mjs";
import {
  runTimeframeThread, runPendingTimeframeThreads, readTimeframeThread, validateTfConclusion, tfEvidence,
  tfThreadsEnabled, TF_THREAD_CHARTS, TF_AGENTS
} from "../src/timeframe-threads.mjs";

const H4_MS = 4 * 3600_000;
// OANDA H4 bars open at 22:00 UTC (17:00 New York), so 02:00, 06:00, ... 22:00.
const LAST_OPEN = Date.parse("2026-11-05T18:00:00.000Z");
const H4_KEY = "OANDA:XAUUSD:240:" + LAST_OPEN;
const NOW = LAST_OPEN + H4_MS + 5 * 60_000;

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };

function h4Series(count = 60) {
  const candles = Array.from({ length: count }, (_, i) => {
    const open = LAST_OPEN - (count - 1 - i) * H4_MS;
    const base = 4000 + Math.sin(i / 3) * 20 + i;
    return { open_time: new Date(open).toISOString(), close_time: new Date(open + H4_MS).toISOString(), open: base, high: base + 12, low: base - 9, close: base + 3, volume: 1000 + i };
  });
  return JSON.stringify({ candles });
}
const prophetRecord = () => JSON.stringify({ engine: "prophet", timeframe: "240", values: { comparable: {
  prophet_r38: { direction: 1, buy_confirmed: false, sell_confirmed: false, t_enc: 2, d_enc: 1, structure_subtype: 0 },
  prophet_r37_ssot: { direction: 1, d_enc: 1, b_enc: 2, structure_subtype: 0, bull_event: false, bear_event: false }
} } });
const gmiRecord = () => JSON.stringify({ engine: "gmi", timeframe: "240", values: {
  comparable: { gmi_v12_70: { verdict: 2, gate: 1, gmi_dir: 1, prophet_dir: 1, conflict: false } },
  diagnostics: { branch: "trend", htf_state: 1, ltf_state: 1, fp_status: "neutral" }
} });

/** Each desk answers from its Required JSON line; the moderator writes the TLDR. */
function fakeAI({ conclusion = null, fail = new Set(), confidence = 0.35 } = {}) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      const sys = request.messages[0].content, user = request.messages[1].content;
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      let content;
      if (/moderator of the XAUUSD/.test(sys)) content = conclusion || { stance: "WAIT", confidence: 0.5, summary: "The four-hour bias leans up but has no confirmation yet, so the desks prefer to wait.", reasons: ["Structure points up without a confirmed signal.", "Volatility is normal for this chart."] };
      else if (fail.has(agent)) throw new Error("model down");
      else content = { agent, stance: "WAIT", confidence, claim: "My own data on this chart supports waiting for the next candle." };
      return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 40 } };
    }
  };
}

function env(ai, { records = true, overrides = {} } = {}) {
  const buffer = records ? { ["localcalc:" + H4_KEY + ":prophet"]: prophetRecord(), ["localcalc:" + H4_KEY + ":gmi"]: gmiRecord() } : {};
  return {
    DB: fakeD1(), AI: ai, WEBHOOK_BUFFER: kv(buffer),
    SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|4h": h4Series() }),
    TF_THREADS_ENABLED: "true", TF_THREADS_MAX_CALLS_PER_HOUR: "24", ...overrides
  };
}
const fixedClock = () => NOW;

test.beforeEach(() => resetThreadSchemaCacheForTests());

test("only H4 and D1 run here; five desks with one role each", () => {
  assert.deepEqual(Object.keys(TF_THREAD_CHARTS), ["H4", "D1"]);
  assert.deepEqual(Object.keys(TF_AGENTS), ["structure", "gmi", "technical", "macro", "risk"]);
  assert.equal(tfThreadsEnabled({ TF_THREADS_ENABLED: "true" }), true);
  assert.equal(tfThreadsEnabled({}), false);
});

test("the TLDR needs a stance, a plain summary and one to three reasons; blank reasons are dropped", () => {
  assert.equal(validateTfConclusion({ stance: "WAIT", confidence: 0.5, summary: "The bias leans up but waits for confirmation.", reasons: ["Structure points up.", " "] }).valid, true);
  assert.deepEqual(validateTfConclusion({ stance: "LONG", confidence: 0.5, summary: "x", reasons: ["y"] }).errors.includes("stance_invalid"), true);
  assert.equal(validateTfConclusion({ stance: "WAIT", confidence: 1.4, summary: "Wait.", reasons: ["Why."] }).valid, false);
  assert.equal(validateTfConclusion({ stance: "WAIT", confidence: 0.4, summary: "Wait.", reasons: [] }).valid, false);
  assert.equal(validateTfConclusion(null).valid, false);
});

test("evidence is the closed bar of that chart; a bar not in the series gives no evidence", async () => {
  const e = await tfEvidence(env(fakeAI()), "H4", H4_KEY);
  assert.equal(e.bar_open, new Date(LAST_OPEN).toISOString());
  assert.equal(e.technical.recent.length, 8);
  assert.ok(e.technical.average_range_14 > 0);
  assert.equal(e.structure.r38.direction, 1);
  assert.equal(e.gmi.branch, "trend");
  assert.equal(await tfEvidence(env(fakeAI()), "H4", "OANDA:XAUUSD:240:" + (LAST_OPEN + H4_MS)), null);
});

test("an H4 thread: the brief, five openings and the moderator's TLDR; the rerun spends nothing", async () => {
  const ai = fakeAI();
  const e = env(ai);
  const r = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(r.status, "complete");
  assert.equal(r.openings + 1, ai.calls.length);
  for (const call of ai.calls) {
    const text = call.request.messages.map((m) => m.content).join("\n");
    assert.doesNotMatch(text, /stop loss":|take_profit|lot size/i);
  }

  const thread = await readTimeframeThread(e.DB, "H4");
  assert.equal(thread.tf, "H4");
  assert.equal(thread.candle_key, H4_KEY);
  assert.equal(thread.conclusion.status, "ok");
  assert.equal(thread.conclusion.stance, "WAIT");
  assert.ok(thread.conclusion.reasons.length >= 1);
  assert.deepEqual(thread.posts.slice(0, 3).map((p) => p.id), ["structure", "gmi", "technical"]);
  assert.match(thread.posts[0].calibration, /not yet calibrated/);
  assert.equal(thread.posts.every((p) => p.status === "ok"), true);

  const again = await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.deepEqual(again, { status: "already_complete", calls: 0 });
  assert.equal(await readTimeframeThread(e.DB, "D1"), null);
  assert.equal(await readTimeframeThread(e.DB, "W1"), null);
});

test("an uncalibrated desk speaks at confidence <= 0.4; bar-based desks keep theirs", async () => {
  const e = env(fakeAI({ confidence: 0.9 }));
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  const thread = await readTimeframeThread(e.DB, "H4");
  const by = Object.fromEntries(thread.posts.map((p) => [p.id, p]));
  assert.equal(by.structure.status, "ok");
  assert.equal(by.structure.confidence, 0.4);
  assert.equal(by.gmi.confidence, 0.4);
  assert.equal(by.technical.confidence, 0.9);
});

test("no local records means no thread and no model calls", async () => {
  const ai = fakeAI();
  assert.deepEqual(await runTimeframeThread(env(ai, { records: false }), { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock }), { status: "no_local_records" });
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(await runTimeframeThread(env(ai), { chart: "M5", candleKey: H4_KEY }), { status: "unsupported_chart" });
});

test("the hourly budget caps the calls: the rest are stored as budget_exhausted", async () => {
  const ai = fakeAI();
  const e = env(ai, { overrides: { TF_THREADS_MAX_CALLS_PER_HOUR: "2" } });
  await runTimeframeThread(e, { chart: "H4", candleKey: H4_KEY }, { clock: fixedClock });
  assert.equal(ai.calls.length, 2);
  const thread = await readTimeframeThread(e.DB, "H4");
  assert.equal(thread.posts.filter((p) => p.status === "budget_exhausted").length, thread.posts.length - 2);
});

test("the pending runner is off behind the flag and picks the latest closed H4 bar", async () => {
  const ai = fakeAI();
  assert.deepEqual(await runPendingTimeframeThreads(env(ai, { overrides: { TF_THREADS_ENABLED: "false" } }), { now: NOW }), { status: "disabled" });
  assert.equal(ai.calls.length, 0);
  const out = await runPendingTimeframeThreads(env(ai), { now: NOW, clock: fixedClock });
  assert.equal(out.status, "ok");
  assert.equal(out.charts.H4.status, "complete");
  assert.equal(out.charts.D1, undefined, "no daily series cached: no D1 key");
});
