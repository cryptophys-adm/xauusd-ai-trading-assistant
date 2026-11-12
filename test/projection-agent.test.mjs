// Owner 2026-11-12: "ya kerjakan kalibrasi bobot pola chart; Projection Agent sekarang harus masuk ke room."
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { replayOccurrences, calibrationFrom, calibratePatterns, patternFactor, runPatternCalibration, readPatternCalibration, PATTERN_CALIBRATION_KEY, CALIBRATION } from "../src/pattern-calibration.mjs";
import { patternLevels, detectPatterns } from "../src/chart-patterns.mjs";
import { rawLevels } from "../src/key-level-agent.mjs";
import { projectionReading } from "../src/projection-agent.mjs";
import { resetThreadSchemaCacheForTests, buildLiveRoomTask } from "../src/agent-threads.mjs";
import { runWarRoomBar, readWarRoom } from "../src/war-room.mjs";

const M = 15 * 60_000;
/** A deterministic wave with drift: patterns form and break out on it. */
function wave(n, { step = M, start = Date.parse("2026-10-01T00:00:00Z"), base = 3900 } = {}) {
  let p = base, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p += Math.sin(i / 9) * 3 + Math.sin(i / 37) * 2 + (rnd() - 0.5) * 5;
    return { open_time: new Date(start + i * step).toISOString(), close_time: new Date(start + (i + 1) * step).toISOString(), open: o, high: Math.max(o, p) + rnd() * 2, low: Math.min(o, p) - rnd() * 2, close: p };
  });
}

test("C1. the replay follows each breakout to its target, its other line or the horizon, one at a time per pattern and direction", () => {
  const bars = wave(700);
  const occ = replayOccurrences(bars, { tf: "15" });
  assert.ok(occ.length >= 10, `breakouts found: ${occ.length}`);
  assert.ok(occ.every((o) => ["target", "failed", "expired", "pending"].includes(o.outcome)));
  assert.ok(occ.every((o) => !o.id.startsWith("event_")), "event patterns need the release history");
  // One breakout per pattern and direction at a time: no two of the same base start at the same bar.
  const keys = occ.map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(occ.some((o) => o.outcome !== "pending"));
});

test("C2. the calibration shrinks each pattern toward the base rate, acts only from the minimum sample, and stays within its bounds", () => {
  const mk = (id, target, failed, expired = 0) => [
    ...Array.from({ length: target }, () => ({ id, outcome: "target" })),
    ...Array.from({ length: failed }, () => ({ id, outcome: "failed" })),
    ...Array.from({ length: expired }, () => ({ id, outcome: "expired" }))
  ];
  const occ = [...mk("double_top", 18, 6), ...mk("rounding_top", 2, 20, 8), ...mk("flag", 4, 1), { id: "flag", outcome: "pending" }];
  const c = calibrationFrom(occ);
  assert.equal(c.resolved, 59);
  assert.equal(c.pending, 1);
  assert.equal(c.base_rate, Math.round((24 / 59) * 1000) / 1000);
  const base = 24 / 59;
  const dt = c.patterns.double_top;
  assert.deepEqual([dt.n, dt.target, dt.active], [24, 18, true]);
  assert.equal(dt.factor, Math.round(Math.min(1.5, ((18 + 10 * base) / 34) / base) * 1000) / 1000);
  assert.ok(dt.factor > 1, "a pattern that reaches its target more than the others weighs more");
  const rt = c.patterns.rounding_top;
  assert.ok(rt.active && rt.factor < 1 && rt.factor >= CALIBRATION.factor_min, JSON.stringify(rt));
  assert.deepEqual([c.patterns.flag.n, c.patterns.flag.active, c.patterns.flag.factor], [5, false, 1], "too few breakouts: the default weights");
  assert.equal(patternFactor(c, "double_top"), dt.factor);
  assert.equal(patternFactor(c, "flag"), 1);
  assert.equal(patternFactor(null, "double_top"), 1);
  assert.deepEqual(calibrationFrom([]), { base_rate: null, resolved: 0, pending: 0, patterns: {} });
});

test("C3. the factor scales a broken-out pattern's levels (at most 1); a forming pattern keeps its defaults", () => {
  const confirmed = { id: "double_top", name: "Double top", status: "confirmed", direction: -1, upper: 4000, lower: 3950, target: 3900 };
  const forming = { id: "flag", name: "Flag", status: "forming", direction: 0, upper: 3990, lower: 3970 };
  const plain = patternLevels([confirmed, forming]);
  assert.deepEqual(plain.map((l) => l.weight), [0.8, 0.7, 0.5, 0.6, 0.6]);
  const up = patternLevels([confirmed, forming], { factorOf: (id) => (id === "double_top" ? 1.4 : 0.5) });
  assert.deepEqual(up.map((l) => l.weight), [1, 0.98, 0.7, 0.6, 0.6], "1.4 x 0.8 caps at 1; the forming flag stays at its defaults");
  const down = patternLevels([confirmed], { factorOf: () => 0.5 });
  assert.deepEqual(down.map((l) => l.weight), [0.4, 0.35, 0.25]);
  // Through the Key Level Agent: the factor reaches the raw levels (which also carry the chart's own scale).
  const at = (factorOf) => rawLevels({ patterns: { "60": [confirmed] }, factorOf }).filter((l) => l.reader === "projection").map((l) => l.weight);
  const full = at(() => 1), half = at(() => 0.5);
  assert.equal(full.length, 3);
  half.forEach((w, i) => assert.ok(Math.abs(w / full[i] - 0.5) < 0.02, `${w} vs ${full[i]}`));
});

test("C4. the hourly run writes the calibration to KV from the cached series; off writes nothing", async () => {
  const store = new Map([
    ["market-data:v2:series:OANDA:XAUUSD|15m", JSON.stringify({ candles: wave(400) })],
    ["market-data:v2:series:OANDA:XAUUSD|1h", JSON.stringify({ candles: wave(300, { step: 4 * M }) })]
  ]);
  const env = { SIGNAL_CACHE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } } };
  const r = await runPatternCalibration(env, { now: Date.parse("2026-11-12T19:10:00Z") });
  assert.equal(r.status, "ok");
  const cal = await readPatternCalibration(env);
  assert.equal(cal.version, "cryptophys.pattern-calibration.v1");
  assert.deepEqual(Object.keys(cal.charts), ["15", "60", "240", "D"]);
  assert.equal(cal.charts["15"].bars, 400);
  assert.equal(cal.charts.D.bars, 0);
  assert.ok(cal.resolved > 0);
  assert.equal(await readPatternCalibration({ ...env, PATTERN_CALIBRATION_MODE: "off" }), null);
  store.delete(PATTERN_CALIBRATION_KEY);
  assert.deepEqual(await runPatternCalibration({ ...env, PATTERN_CALIBRATION_MODE: "off" }), { status: "disabled" });
  assert.equal(store.has(PATTERN_CALIBRATION_KEY), false);
  // Deterministic: the same bars give the same calibration.
  const a = calibratePatterns({ "15": wave(300) }, { now: 0 }), b = calibratePatterns({ "15": wave(300) }, { now: 0 });
  assert.deepEqual(a, b);
});

test("C5. the Projection Agent's room data: patterns and projection levels as distances in bar ranges, never a price", () => {
  const bars = wave(120);
  const close = bars.at(-1).close;
  const plane = { projection: { fib: { levels: { "0.618": close - 6, "0.786": close - 9 } }, trendlines: { resistance: { price_now: close + 4 } } } };
  const cal = { base_rate: 0.4, patterns: {} };
  const reading = projectionReading({ bars, plane, calibration: cal, timeframe: "15 minutes" });
  assert.equal(reading.available, true);
  assert.equal(reading.unit, "distance from the last close in average bar ranges");
  assert.deepEqual(reading.levels.map((l) => [l.level, l.side]), [["Fibonacci 0.618 (OTE)", "below"], ["Fibonacci 0.786 (OTE)", "below"], ["tactical resistance trendline", "above"]]);
  assert.ok(reading.levels.every((l) => l.ranges > 0 && l.ranges < 20));
  assert.equal(reading.all_patterns_reached_target_pct, 40);
  // A pattern with a record on gold carries it.
  const ids = detectPatterns(bars.slice(-60)).map((p) => p.id);
  assert.ok(ids.length > 0, "the wave forms patterns");
  const withRec = projectionReading({ bars, plane, calibration: { base_rate: 0.4, patterns: { [ids[0]]: { n: 25, rate: 0.6, factor: 1.3, active: true } } } });
  assert.deepEqual(withRec.patterns[0].record_on_gold, { breakouts: 25, reached_target_pct: 60, weight_factor: 1.3, measured_enough: true });
  // No price anywhere: no number with four digits before the point.
  assert.doesNotMatch(JSON.stringify(reading), /\b\d{4}(\.\d+)?\b/);
  assert.deepEqual(projectionReading({ bars: bars.slice(0, 1) }), { timeframe: "", available: false, note: "not enough closed bars" });
});

test("C6. the 15m Live War Room: the Projection Agent speaks after the Risk Manager, from its own data without a price", async () => {
  resetThreadSchemaCacheForTests();
  const BAR = "2026-11-05T14:45:00.000Z";
  const K15 = "OANDA:XAUUSD:15:" + (Date.parse(BAR) - M);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, ticker TEXT, timeframe TEXT, timestamp TEXT, prophet_metrics TEXT, gmi_metrics TEXT, ai_analysis TEXT, ai_model TEXT)");
  db.exec("CREATE TABLE bus_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, candle_key TEXT NOT NULL, round INTEGER NOT NULL, agent TEXT NOT NULL, ts TEXT NOT NULL, insight TEXT NOT NULL, confidence REAL, refs_json TEXT, model TEXT, status TEXT, latency_ms INTEGER, fallback_used INTEGER DEFAULT 0, usage_tokens INTEGER)");
  const wrap = (sql, params = []) => ({ bind: (...a) => wrap(sql, a), run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; }, first: async () => db.prepare(sql).get(...params) ?? null, all: async () => ({ results: db.prepare(sql).all(...params) }) });
  const store = new Map();
  const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, String(v)); } };
  const bars = wave(80, { start: Date.parse(BAR) - 80 * M });
  store.set("market-data:v2:series:OANDA:XAUUSD|15m", JSON.stringify({ candles: bars }));
  const close = bars.at(-1).close;
  store.set("hud:15:" + K15, JSON.stringify({ schema_version: "cryptophys.hud-snapshot.v1", symbol: "OANDA:XAUUSD", timeframe: "15", candle_key: K15, computed_at: BAR, huds: {}, chart_plane: { projection: { fib: { levels: { "0.618": close - 6 } } } } }));
  const calls = [];
  const ai = { calls, run: async (model, request) => {
    calls.push(request);
    const sys = request.messages[0].content, user = request.messages[1].content;
    const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
    const content = /moderator of the XAUUSD Live War Room/.test(sys) ? { stance: "WAIT", confidence: 0.6, summary: "Stay flat: no confirmation.", reasons: ["No trigger."], dissent: [], metrics: ["the closed 15m candles"] }
      : /Consensus Discussion/.test(sys) ? { agent, stance: "WAIT", confidence: 0.5, rebuts: ["technical"], argument: "The move lacks follow-through.", metrics: ["the candles"] }
      : { agent, stance: "WAIT", confidence: 0.5, claim: "My own data supports waiting for the next candle.", metrics: ["my own readings of this chart"] };
    return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 50 } };
  } };
  const ctx = { schema_version: "cryptophys.local-context.v1", trust_status: "informational_unverified", symbol: "OANDA:XAUUSD", timeframe: "5", candle_time: BAR, bias: "NEUTRAL", buy_confirmed: false, sell_confirmed: false, d_enc: 0,
    recent_bars: Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.parse(BAR) - (11 - i) * 300_000).toISOString(), o: 4100, h: 4103, l: 4098, c: 4101, v: 10 })) };
  const env = { DB: { prepare: (sql) => wrap(sql) }, AI: ai, SIGNAL_CACHE: kv, WEBHOOK_BUFFER: kv, WAR_ROOM_ENABLED: "true", WAR_ROOM_MAX_CALLS_PER_HOUR: "112" };
  const r = await runWarRoomBar(env, buildLiveRoomTask({ barTime: BAR, context: ctx }));
  assert.equal(r.status, "complete");
  const room = await readWarRoom(env.DB);
  assert.deepEqual(room.roster.map((x) => x.id).slice(0, 4), ["news", "technical", "risk", "projection"]);
  assert.equal(room.roster[3].name, "Projection Agent");
  const opening = calls.find((c) => /"agent":"projection"/.test(c.messages[1].content) && /Your only role: where a move projects on the 15m chart/.test(c.messages[0].content + c.messages[1].content));
  assert.ok(opening, "the Projection Agent opened with its role");
  const data = JSON.parse(opening.messages[1].content.split("YOUR DATA:\n")[1]);
  assert.equal(data.timeframe, "15 minutes");
  assert.deepEqual(data.levels.map((l) => [l.level, l.side]), [["Fibonacci 0.618 (OTE)", "below"]]);
  assert.doesNotMatch(JSON.stringify(data), /\b\d{4}(\.\d+)?\b/, "no price in its data");
});
