import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { buildStrategy } from "../src/strategy-engine.mjs";
import {
  slimInputs, gzipJson, gunzipJson, captureStrategyInputs, scoreStrategyCaptures, stanceOutcomes, strategyInputsStatus,
  resetStrategyInputsSchemaCacheForTests, CAPTURE_AFTER_CLOSE_MS, STRATEGY_INPUTS_DAYS, OUTCOME
} from "../src/strategy-inputs.mjs";

const NOW = Date.parse("2026-11-06T14:20:00Z");
const op = (id, bias, confidence = 0.6) => ({ id, status: "ok", stance: "WAIT", bias, confidence, text: "a long room message the engine never reads", evidence: ["x"], model: "m" });
const room = (biases, bar_close, extra = {}) => ({ bar_close, thread_id: "t", openings: biases.map((b, i) => op("a" + i, b)), conclusion: { status: "ok", stance: "WAIT", bias: null, confidence: 0.6, summary: "text" }, debate: [{ text: "x" }], ...extra });
const bull = ["BULLISH", "BULLISH", "BULLISH", "NEUTRAL"], bear = ["BEARISH", "BEARISH", "BEARISH", "NEUTRAL"];
const h1Bars = Array.from({ length: 20 }, (_, i) => ({ open: 4000 + i, high: 4006 + i, low: 3996 + i, close: 4001 + i, extra: "dropped" }));
const m15Bars = Array.from({ length: 10 }, (_, i) => ({ open: 4040, high: 4045, low: i === 5 ? 4031 : 4036, close: 4040 }));
const snapshot = (tf, close, extra = {}) => ({
  timeframe: tf, candle_key: `OANDA:XAUUSD:${tf}:1`, computed_at: "2026-11-06T14:01:00.000Z", raw_payload: { big: "x".repeat(500) },
  huds: {
    interstellar_eyes: { fields: { close, camarilla: { [tf]: { h3: 4048, h4: 4060, h5: 4075, l3: 4038, l4: 4026, l5: 4010 }, D: { h3: 4090, h4: 4110, h5: 4140, l3: 4000, l4: 3980, l5: 3950 } } }, source: "pine", received_at: "x" },
    chronos_matrix: { fields: { daily_cpr: { pivot: 4020, tc: 4024, bc: 4016 }, weekly_cpr: { pivot: 3960, tc: 3965, bc: 3955 } } },
    fabio_amt: { fields: { poc: 4052, vah: 4068, val: 4030 } },
    decision_matrix: { fields: { verdict: 1, gate: 1, conflict: false, is_chaos: false } },
    trade_management: { fields: { conflict: false, gate: 1 } },
    prophet: { fields: { t_enc: 1 } },
    kinetic_engine: { fields: { is_chaos: false } },
    r37_funnel: { fields: { buy_confirmed: false, sell_confirmed: false } },
    ...extra
  }
});
const rooms = (d1, h4, h1, m15) => ({
  D1: room(d1, "2026-11-05T22:00:00.000Z"), H4: room(h4, "2026-11-06T14:00:00.000Z"),
  H1: room(h1, "2026-11-06T14:00:00.000Z"), M15: { ...room(m15, null), bar_time: "2026-11-06T14:15:00.000Z" }
});
const input = (over = {}) => ({
  rooms: rooms(bull, bull, bull, bull), news: { tldr: { status: "ok", stance: "SELL", confidence: 0.7, text: "x" }, items: [{ title: "y" }] },
  h1Snapshot: snapshot("60", 4040), m15Snapshot: snapshot("15", 4040), h4Snapshot: snapshot("240", 4040), d1Snapshot: null,
  confirmations: { h1_prophet_r38: { buy_confirmed: false, sell_confirmed: false }, m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: true } },
  h1Bars, m15Bars, h4Bars: [], d1Bars: [], w1Bars: [], h1Chain: { decision: "WAIT", confidence: 0, candle_key: "k", reasoning: "x" }, now: NOW, ...over
});

test("the slim record gives exactly the strategy of the full inputs, in every state", () => {
  const variants = [
    input(),
    input({ confirmations: null }),
    input({ rooms: rooms(bull, bull, bear, bull) }),
    input({ rooms: rooms(bear, bear, bear, bear), news: { tldr: { status: "ok", stance: "BUY", confidence: 0.9 } } }),
    input({ h1Snapshot: snapshot("60", 4040, { prophet: { fields: { t_enc: 4 } } }) }),
    input({ m15Bars: [], h1Snapshot: snapshot("60", 4100), m15Snapshot: snapshot("15", 4100) }),
    input({ now: NOW + 10 * 3_600_000 })
  ];
  const states = new Set();
  for (const v of variants) {
    const full = buildStrategy(v), slim = buildStrategy(slimInputs(v));
    assert.deepEqual(slim, full);
    states.add(full.state);
  }
  assert.ok(states.size >= 4, `several engine states are covered: ${[...states]}`);
  const slim = slimInputs(input());
  const text = JSON.stringify(slim);
  assert.ok(!text.includes("a long room message") && !text.includes("raw_payload") && !text.includes("reasoning"), "room texts and unused fields are dropped");
});

test("the record is gzip-compressed and round-trips", async () => {
  const slim = slimInputs(input());
  const gz = await gzipJson(slim);
  assert.deepEqual(await gunzipJson(gz), slim);
  assert.ok(gz.length < JSON.stringify(slim).length);
});

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}
const H = 3_600_000, Q = 900_000;
const T0 = Date.parse("2026-11-09T08:00:00Z");
const timed = (n, startMs, ms, base = 4000) => Array.from({ length: n }, (_, i) => ({ open_time: new Date(startMs + i * ms).toISOString(), close_time: new Date(startMs + (i + 1) * ms).toISOString(), open: base, high: base + 4, low: base - 4, close: base + (i % 3) - 1 }));

test("one capture per closed H1 bar, 40 minutes or more after its close; the live decision is kept", async () => {
  resetStrategyInputsSchemaCacheForTests();
  const env = { DB: d1() };
  const lastClose = T0; // the H1 bar 07:00-08:00 is the last closed one
  const load = async (_env, { now }) => input({ h1Bars: timed(20, lastClose - 20 * H, H), m15Bars: timed(40, lastClose - 30 * Q, Q, 4040), now });
  const early = await captureStrategyInputs(env, { now: lastClose + 25 * 60_000, load, build: buildStrategy });
  assert.equal(early.status, "waiting");
  const first = await captureStrategyInputs(env, { now: lastClose + CAPTURE_AFTER_CLOSE_MS, load, build: buildStrategy });
  assert.equal(first.status, "captured");
  assert.equal(first.candle_key, "OANDA:XAUUSD:60:" + (lastClose - H));
  assert.equal((await captureStrategyInputs(env, { now: lastClose + 55 * 60_000, load, build: buildStrategy })).status, "already_captured");
  assert.equal((await captureStrategyInputs(env, { now: lastClose + 2 * H + 45 * 60_000, load, build: buildStrategy })).status, "stale", "no new H1 bar (weekend): nothing is captured");
  let loads = 0;
  const counted = async (e, o) => { loads += 1; return load(e, o); };
  await captureStrategyInputs(env, { now: lastClose + 55 * 60_000, load: counted, build: buildStrategy });
  await captureStrategyInputs(env, { now: lastClose + H + 10 * 60_000, load: counted, build: buildStrategy });
  assert.equal(loads, 0, "a captured hour and an early sweep never load the inputs");
  const row = env.DB.raw.prepare("SELECT * FROM strategy_inputs").get();
  assert.equal(row.version, "cryptophys.strategy-inputs.v1");
  const stored = await gunzipJson(row.inputs_gz);
  assert.equal(buildStrategy(stored).decision, row.live_decision, "the stored inputs reproduce the live decision");
  assert.equal(row.score_close, new Date(lastClose + 2 * Q).toISOString(), "scored from the last 15m bar closed at the capture (08:30)");
});

test("each stance's outcome is scored once its 4-hour horizon closed; old captures are dropped after 60 days", async () => {
  resetStrategyInputsSchemaCacheForTests();
  const m15 = timed(120, T0 - 40 * Q, Q);
  // A rally after the capture: BUY hits, SELL misses, WAIT missed the opportunity.
  for (let i = 41; i < 120; i++) { const lift = (i - 40) * 3; Object.assign(m15[i], { open: 4000 + lift, high: 4004 + lift, low: 3998 + lift, close: 4002 + lift }); }
  const closeMs = Date.parse(m15[39].close_time);
  assert.equal(stanceOutcomes(m15.slice(0, 50), closeMs), null, "pending until 16 bars have closed");
  assert.deepEqual(stanceOutcomes(m15, closeMs), { BUY: "hit", SELL: "miss", WAIT: "missed_opportunity" });
  const env = { DB: d1(), SIGNAL_CACHE: { async get(k) { return k === "market-data:v2:series:OANDA:XAUUSD|15m" ? JSON.stringify({ candles: m15 }) : null; } } };
  await scoreStrategyCaptures(env, { now: T0 }); // ensures the schema
  const ins = env.DB.raw.prepare("INSERT INTO strategy_inputs (candle_key, captured_at, score_close, version, inputs_gz) VALUES (?, ?, ?, 'v', 'x')");
  ins.run("fresh", new Date(closeMs).toISOString(), m15[39].close_time);
  ins.run("gone", new Date(closeMs - 2 * 86_400_000).toISOString(), new Date(closeMs - 2 * 86_400_000).toISOString());
  ins.run("old", new Date(T0 - (STRATEGY_INPUTS_DAYS + 1) * 86_400_000).toISOString(), null);
  const now = closeMs + OUTCOME.horizon * Q + 60_000;
  const r = await scoreStrategyCaptures(env, { now });
  assert.equal(r.scored, 2);
  assert.equal(r.pruned, 1);
  const rows = Object.fromEntries(env.DB.raw.prepare("SELECT candle_key, outcomes_json FROM strategy_inputs").all().map((x) => [x.candle_key, JSON.parse(x.outcomes_json)]));
  assert.deepEqual(rows.fresh, { BUY: "hit", SELL: "miss", WAIT: "missed_opportunity" });
  assert.deepEqual(rows.gone, { no_data: true }, "bars no longer cached: marked, never retried");
  assert.equal(rows.old, undefined);
  const status = await strategyInputsStatus(env);
  assert.equal(status.captured, 2);
  assert.equal(status.scored, 1);
  assert.equal(status.retention_days, 60);
});

test("a weekend hour is never loaded: no gold bar opened in it (resource audit 2026-11-14)", async () => {
  resetStrategyInputsSchemaCacheForTests();
  const env = { DB: d1() };
  let loads = 0;
  const load = async () => { loads += 1; return input({ h1Bars: [], m15Bars: [] }); };
  const saturday = Date.parse("2026-11-14T12:45:00Z");
  const r = await captureStrategyInputs(env, { now: saturday, load, build: buildStrategy });
  assert.equal(r.status, "market_closed");
  assert.equal(loads, 0);
  // Sunday's first hour after the reopen (23:00 UTC in winter) is captured as usual: it is loaded.
  await captureStrategyInputs(env, { now: Date.parse("2026-11-16T00:45:00Z"), load, build: buildStrategy });
  assert.equal(loads, 1);
});
