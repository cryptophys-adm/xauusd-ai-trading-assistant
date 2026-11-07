import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  SCORING, SCORING_VERSION, atrAt, scoreStance, normalizeStance, sessionOf, detectStuckStates, indicatorStances,
  scoreRecentStatements, detectRecentStuckStates, scorecards, listStuckStates, resetOutcomeSchemaCacheForTests
} from "../src/outcome-scoring.mjs";

const H = 3_600_000;
const T0 = Date.parse("2026-11-04T00:00:00.000Z");

/** H1 bars from [open, high, low, close] tuples, starting at `start`. */
function barsFrom(rows, { start = T0, ms = H } = {}) {
  return rows.map(([o, h, l, c], i) => ({ time: (start + i * ms) / 1000, open_time: new Date(start + i * ms).toISOString(), close_time: new Date(start + (i + 1) * ms).toISOString(), open: o, high: h, low: l, close: c, volume: 100 }));
}
/** 15 flat bars of range 10 (ATR 10, threshold 5 at k = 0.5), then the given bars. */
const base = Array.from({ length: 15 }, () => [100, 105, 95, 100]);
const closeOf = (bars, i) => Date.parse(bars[i].close_time);

test("the scoring definition is the one the owner approved", () => {
  assert.deepEqual({ ...SCORING }, { horizon: 4, atrPeriod: 14, thresholdAtr: 0.5, waitTargetAtr: 1, stuckCandles: 8, stuckRangeAtr: 3 });
  assert.equal(SCORING_VERSION, "cryptophys.outcome-scoring.v3");
});

test("ATR is the simple average true range of the last 14 bars", () => {
  const bars = barsFrom(base);
  assert.equal(atrAt(bars, 14), 10);
  assert.equal(atrAt(bars, 13), null, "needs a previous close for the first true range");
});

test("BUY / SELL: hit, miss, same-bar both is a miss, neutral; pending until the horizon closes", () => {
  const up = barsFrom([...base, [100, 103, 99, 102], [102, 106, 101, 105], [105, 106, 104, 105], [105, 106, 104, 105]]);
  const i = 14;
  assert.equal(scoreStance({ stance: "BUY", bars: up, closeMs: closeOf(up, i) }).result, "hit");
  assert.equal(scoreStance({ stance: "SELL", bars: up, closeMs: closeOf(up, i) }).result, "miss");
  const both = barsFrom([...base, [100, 106, 94, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
  assert.equal(scoreStance({ stance: "BUY", bars: both, closeMs: closeOf(both, i) }).result, "miss", "ambiguous bar counts against the stance");
  const flat = barsFrom([...base, [100, 102, 98, 100], [100, 102, 98, 100], [100, 102, 98, 100], [100, 102, 98, 100]]);
  assert.equal(scoreStance({ stance: "SELL", bars: flat, closeMs: closeOf(flat, i) }).result, "neutral");
  assert.equal(scoreStance({ stance: "BUY", bars: flat.slice(0, -1), closeMs: closeOf(flat, i) }).result, "pending");
});

test("WAIT: hit when nothing moves, missed_opportunity with the direction of the first move", () => {
  const i = 14;
  const flat = barsFrom([...base, [100, 102, 98, 100], [100, 102, 98, 100], [100, 102, 98, 100], [100, 102, 98, 100]]);
  assert.equal(scoreStance({ stance: "WAIT", bars: flat, closeMs: closeOf(flat, i) }).result, "hit");
  // A clean fall to 1 x ATR (10) before any 0.5 x ATR (5) rise: a 2:1 SELL would have won.
  const down = barsFrom([...base, [100, 101, 96, 97], [97, 98, 89, 90], [90, 91, 89, 90], [90, 91, 89, 90]]);
  const s = scoreStance({ stance: "WAIT", bars: down, closeMs: closeOf(down, i) });
  assert.deepEqual([s.result, s.direction], ["missed_opportunity", -1]);
  assert.equal(s.max_down, 11, "the full horizon is measured for reporting");
});

test("v3: a WAIT misses only a 2:1 move; a whipsaw or a 1:1 move is a hit", () => {
  const i = 14;
  // The first bar that reaches the threshold touches both sides: neither BUY nor SELL is a hit.
  const whipsaw = barsFrom([...base, [100, 106, 94, 100], [100, 108, 99, 107], [107, 109, 106, 108], [108, 110, 107, 109]]);
  assert.equal(scoreStance({ stance: "WAIT", bars: whipsaw, closeMs: closeOf(whipsaw, i) }).result, "hit");
  // A 1:1 rise (+6, a BUY hit) that never reaches 1 x ATR: not worth taking, WAIT was right.
  const oneToOne = barsFrom([...base, [100, 103, 99, 102], [102, 106, 101, 105], [105, 106, 104, 105], [105, 106, 104, 105]]);
  assert.equal(scoreStance({ stance: "BUY", bars: oneToOne, closeMs: closeOf(oneToOne, i) }).result, "hit", "BUY scoring is unchanged (1:1)");
  assert.equal(scoreStance({ stance: "WAIT", bars: oneToOne, closeMs: closeOf(oneToOne, i) }).result, "hit");
  // A 2:1 rise: +11 before any -5, so the WAIT missed it.
  const clean = barsFrom([...base, [100, 103, 99, 102], [102, 106, 101, 105], [105, 111, 104, 110], [110, 111, 109, 110]]);
  const s = scoreStance({ stance: "WAIT", bars: clean, closeMs: closeOf(clean, i) });
  assert.deepEqual([s.result, s.direction], ["missed_opportunity", 1]);
  // The stop first: -5 before +10, then the rise: no 2:1 BUY, and no 2:1 SELL either.
  const stopFirst = barsFrom([...base, [100, 101, 94, 96], [96, 112, 95, 111], [111, 112, 110, 111], [111, 112, 110, 111]]);
  assert.equal(scoreStance({ stance: "WAIT", bars: stopFirst, closeMs: closeOf(stopFirst, i) }).result, "hit");
});

test("confidence gives a Brier score; HOLD and CLOSE are not scored; missing bars are no_data", () => {
  const up = barsFrom([...base, [100, 106, 99, 105], [105, 106, 104, 105], [105, 106, 104, 105], [105, 106, 104, 105]]);
  assert.equal(scoreStance({ stance: "BUY", confidence: 0.8, bars: up, closeMs: closeOf(up, 14) }).brier.toFixed(2), "0.04");
  assert.equal(scoreStance({ stance: "HOLD", bars: up, closeMs: closeOf(up, 14) }).result, "not_scored");
  assert.equal(scoreStance({ stance: "BUY", bars: up, closeMs: closeOf(up, 14) + 1 }).result, "no_data");
  assert.equal(normalizeStance("NO_TRADE"), "WAIT");
  assert.equal(sessionOf(Date.parse("2026-11-05T14:00:00Z")), "new_york");
});

test("stuck state: the 2026-11-05 bull-trap latch is flagged; a short run, a small range or a change is not", () => {
  // Nine H1 candles, subtype 1 throughout, closes 4065 -> 4140 -> 4120 (range 85 > 3 x ATR 15).
  const series = [4065, 4089, 4125, 4130, 4140, 4141, 4115, 4127, 4120].map((c, i) => ({ candle_key: "k" + i, high: c + 6, low: c - 6, fields: { subtype: 1, gate: -1 } }));
  const found = detectStuckStates(series, 15);
  assert.deepEqual(found.map(f => [f.field, f.candles, f.first_candle_key]), [["subtype", 9, "k0"], ["gate", 9, "k0"]]);
  assert.deepEqual(detectStuckStates(series.slice(-7), 15), [], "fewer than 8 candles");
  assert.deepEqual(detectStuckStates(series, 40), [], "range not above 3 x ATR");
  const changed = series.map((c, i) => (i === 4 ? { ...c, fields: { subtype: 0, gate: -1 } } : c));
  assert.deepEqual(detectStuckStates(changed, 15).map(f => f.field), ["gate"]);
});

test("indicator stances come from the parity-approved comparable fields", () => {
  const p = { values: { comparable: { prophet_r38: { direction: 1 }, prophet_r37_ssot: { direction: 0 } } } };
  const g = { values: { comparable: { gmi_v12_70: { verdict: -3 } } } };
  assert.deepEqual(indicatorStances(p, g).map(s => [s.subject, s.stance]), [["indicator:prophet_r38", "BUY"], ["indicator:prophet_r37", "WAIT"], ["indicator:gmi_v12_70", "SELL"]]);
});

// ------------------------------------------------------------- end to end on SQLite

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { db.prepare(sql).run(...params); return { success: true }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}
function kv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, String(v)); } };
}

test("scoreRecentStatements scores chain, bus, HUD, indicator and room stances once their horizon closes", async () => {
  resetOutcomeSchemaCacheForTests();
  // H1: 15 base bars, the scored candle (index 14 closes the base), then 4 bars rising 6 each.
  const h1 = barsFrom([...base, [100, 104, 99, 103], [103, 108, 102, 107], [107, 109, 106, 108], [108, 110, 107, 109]]);
  const now = Date.parse(h1.at(-1).close_time) + 60_000;
  const key = "OANDA:XAUUSD:60:" + Date.parse(h1[14].open_time);
  // 15m: the same shape, the room meets at the close of bar 14.
  const m15 = barsFrom([...base, [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]], { start: Date.parse(h1[0].open_time) + 30 * H, ms: 900_000 });
  const m15Now = Date.parse(m15.at(-1).close_time) + 60_000;
  const env = {
    DB: d1(),
    SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|1h": JSON.stringify({ candles: h1 }), "market-data:v2:series:OANDA:XAUUSD|15m": JSON.stringify({ candles: m15 }) }),
    WEBHOOK_BUFFER: kv({
      ["localcalc:" + key + ":prophet"]: JSON.stringify({ values: { comparable: { prophet_r38: { direction: 1 }, prophet_r37_ssot: { direction: -1 } } } }),
      ["localcalc:" + key + ":gmi"]: JSON.stringify({ values: { comparable: { gmi_v12_70: { verdict: 0 } } } })
    })
  };
  const db = env.DB.raw;
  db.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence) VALUES (?, 'WAIT', 0.3)").run(key);
  db.prepare("INSERT INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, status) VALUES ('r', ?, 2, 'technical', '1', ?, 0.6, 'ok')").run(key, JSON.stringify({ stance: "BUY" }));
  db.prepare("INSERT INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, status) VALUES ('r', ?, 1, 'news', '0', ?, 0.6, 'ok')").run(key, JSON.stringify({ stance: "SELL" }));
  db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, stance, confidence, body_json, status) VALUES (?, ?, 'hud:prophet', 'prophet', '1', 'SELL', 0.5, '{}', 'ok')").run("hud1h:" + key, key);
  db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, status) VALUES ('live15m:x', 'b', 'technical', 'technical', ?, '1', 'WAIT', 0.7, '{}', 'ok')").run(m15[14].close_time);
  db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, status) VALUES ('live15m:x', 'b', 'risk', 'risk', ?, '1', 'HOLD', 0.7, '{}', 'ok')").run(m15[14].close_time);

  const first = await scoreRecentStatements(env, { now: Math.max(now, m15Now) });
  assert.equal(first.status, "ok");
  const rows = Object.fromEntries(db.prepare("SELECT subject, timeframe, result, stance FROM outcome_scores").all().map(r => [r.subject + "@" + r.timeframe, r.result]));
  assert.deepEqual(rows, {
    "chain:h1@60": "missed_opportunity",        // WAIT while price rose 10 (threshold 5)
    "bus:technical@60": "hit",                   // round 2 only: the round-1 news post is not scored
    "hud:prophet@60": "miss",
    "indicator:prophet_r38@60": "hit",
    "indicator:prophet_r37@60": "miss",
    "indicator:gmi_v12_70@60": "missed_opportunity",
    "room:technical@15": "hit"                   // WAIT on a quiet 15m; HOLD is not scored
  });
  const again = await scoreRecentStatements(env, { now: Math.max(now, m15Now) });
  assert.equal(again.scores, 0, "idempotent per candle");
  // A row from an older scoring version is rescored and replaced, once.
  db.prepare("UPDATE outcome_scores SET scoring_version = 'cryptophys.outcome-scoring.v1', result = 'stale' WHERE subject = 'chain:h1'").run();
  db.prepare("UPDATE outcome_runs SET scoring_version = 'cryptophys.outcome-scoring.v1' WHERE timeframe = '60'").run();
  const rescored = await scoreRecentStatements(env, { now: Math.max(now, m15Now) });
  assert.ok(rescored.scores > 0);
  assert.equal(db.prepare("SELECT result FROM outcome_scores WHERE subject = 'chain:h1'").get().result, "missed_opportunity");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outcome_scores WHERE scoring_version <> '" + SCORING_VERSION + "'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outcome_scores").get().n, 7);

  const cards = await scorecards(env.DB, { days: 30, now: Math.max(now, m15Now) });
  const chain = cards.find(c => c.subject === "chain:h1");
  assert.deepEqual([chain.wait.n, chain.wait.missed_opportunity, chain.wait.accuracy], [1, 1, 0]);
  const tech = cards.find(c => c.subject === "bus:technical");
  assert.deepEqual([tech.directional.hit_rate, tech.brier], [1, 0.16]);
});

test("detectRecentStuckStates opens an episode on approved records and clears it when the state changes", async () => {
  resetOutcomeSchemaCacheForTests();
  const closes = [4065, 4089, 4125, 4130, 4140, 4141, 4115, 4127, 4120];
  const rows = [...Array.from({ length: 15 }, () => [4060, 4067, 4053, 4060]), ...closes.map(c => [c, c + 6, c - 6, c])];
  const h1 = barsFrom(rows);
  const records = {};
  h1.slice(15).forEach((b) => {
    const key = "OANDA:XAUUSD:60:" + Date.parse(b.open_time);
    records["localcalc:" + key + ":prophet"] = JSON.stringify({ values: { comparable: { prophet_r37_ssot: { structure_subtype: 1, b_enc: -4 } } } });
  });
  const env = { DB: d1(), SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|1h": JSON.stringify({ candles: h1 }) }), WEBHOOK_BUFFER: kv(records) };
  const result = await detectRecentStuckStates(env, { lookback: 9 });
  assert.equal(result.stuck, 2);
  const open = await listStuckStates(env.DB);
  assert.deepEqual(open.map(s => [s.field, s.status, s.candles]).sort(), [["prophet_r37.b_enc", "open", 9], ["prophet_r37.structure_subtype", "open", 9]]);

  // The latch releases on the latest candle: both episodes clear.
  const lastKey = "OANDA:XAUUSD:60:" + Date.parse(h1.at(-1).open_time);
  await env.WEBHOOK_BUFFER.put("localcalc:" + lastKey + ":prophet", JSON.stringify({ values: { comparable: { prophet_r37_ssot: { structure_subtype: 0, b_enc: 2 } } } }));
  await detectRecentStuckStates(env, { lookback: 9 });
  assert.ok((await listStuckStates(env.DB)).every(s => s.status === "cleared"));
});

test("P7: the agents of the Live War Room 15m and the 1H War Room are scored by their final stance, once per bar", async () => {
  resetOutcomeSchemaCacheForTests();
  const h1 = barsFrom([...base, [100, 104, 99, 103], [103, 108, 102, 107], [107, 109, 106, 108], [108, 110, 107, 109]]);
  const now = Date.parse(h1.at(-1).close_time) + 60_000;
  const key = "OANDA:XAUUSD:60:" + Date.parse(h1[14].open_time);
  const m15 = barsFrom([...base, [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]], { start: Date.parse(h1[0].open_time) + 30 * H, ms: 900_000 });
  const m15Now = Date.parse(m15.at(-1).close_time) + 60_000;
  const env = { DB: d1(), SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|1h": JSON.stringify({ candles: h1 }), "market-data:v2:series:OANDA:XAUUSD|15m": JSON.stringify({ candles: m15 }) }), WEBHOOK_BUFFER: kv({}) };
  const db = env.DB.raw;
  const msg = db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')");
  const close15 = m15[14].close_time;
  msg.run("warroom:" + close15.slice(0, 10), close15, "open:technical", "technical", close15, close15, "BUY", 0.6, "{}");
  msg.run("warroom:" + close15.slice(0, 10), close15, "debate:technical", "technical", close15, close15, "WAIT", 0.6, "{}");
  msg.run("warroom:" + close15.slice(0, 10), close15, "conclusion", "moderator", close15, close15, "WAIT", 0.7, "{}");
  const run = h1[14].open_time, ts = h1[15].close_time;
  msg.run("tf:H1", run, "brief", "system", null, ts, null, null, JSON.stringify({ candle_key: key }));
  msg.run("tf:H1", run, "open:risk", "risk", null, ts, "WAIT", 0.5, "{}");
  msg.run("tf:H1", run, "open:kinetic_engine", "kinetic_engine", null, ts, "SELL", 0.5, "{}");
  // A re-convened session (#hud) of the same bar wins over the first.
  msg.run("tf:H1", run + "#hud", "brief", "system", null, ts, null, null, JSON.stringify({ candle_key: key }));
  msg.run("tf:H1", run + "#hud", "open:kinetic_engine", "kinetic_engine", null, ts, "BUY", 0.5, "{}");

  const out = await scoreRecentStatements(env, { now: Math.max(now, m15Now) });
  assert.equal(out.agent_scores, 4, JSON.stringify(out));
  const rows = Object.fromEntries(db.prepare("SELECT subject, timeframe, stance, result FROM outcome_scores WHERE subject LIKE 'agent:%'").all().map(r => [r.subject + "@" + r.timeframe, r.stance + " " + r.result]));
  assert.deepEqual(rows, {
    "agent:technical@15": "WAIT hit",          // the Consensus Discussion answer, not the opening BUY
    "agent:moderator@15": "WAIT hit",
    "agent:risk@60": "WAIT missed_opportunity",
    "agent:kinetic_engine@60": "BUY hit"       // the re-convened session's stance
  });
  const again = await scoreRecentStatements(env, { now: Math.max(now, m15Now) });
  assert.equal(again.agent_scores ?? 0, 0, "once per bar");
});
