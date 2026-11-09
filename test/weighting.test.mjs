import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  WEIGHTING_DEFAULT, WEIGHTING_GRID, weightingId, weightingProblems, neighbourPoints, agentWeight, weightFromSums,
  autoDecision, rollbackDecision, applyWeighting, activeWeighting, weightingState, resetWeightingCacheForTests,
  ACTIVATION_COOLDOWN_DAYS, ROLLBACK_MIN_ROOMS, quorumFor, weightingMessage, completePoint
} from "../src/weighting.mjs";
import { replayQuorum, compareWeighting, loadH1Rooms, loadRooms } from "../src/weighting-replay.mjs";
import { regimeMap, regimeAt, atrShares, REGIMES } from "../src/market-regime.mjs";
import { reputationOf, buildCrowdLine, quorumAllows } from "../src/reputation.mjs";
import { quorumOf, consensusInput } from "../src/h1-consensus.mjs";
import { weightingReport } from "../src/aether-push.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

const H = 3_600_000, DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

test.beforeEach(() => resetWeightingCacheForTests());

test("the default equation is exactly the P7 reputation weight; the grid holds the default", () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ close_ms: T0 + i * H, result: i % 3 ? "hit" : "miss", brier: 0.2 });
  for (let i = 0; i < 6; i++) rows.push({ close_ms: T0 + (40 + i) * H, result: "neutral", brier: null });
  const at = T0 + 3 * DAY;
  const w = agentWeight(rows, WEIGHTING_DEFAULT, at);
  const card = { n: 36, directional: { hit: 20, miss: 10 }, wait: {} };
  assert.equal(w.weight, reputationOf(card).weight);
  assert.equal(w.decisive, 30);
  assert.deepEqual(weightingProblems(WEIGHTING_DEFAULT), []);
  assert.equal(weightingId(WEIGHTING_DEFAULT), "weighting@p10-r0.25_2-d30-h0-b0-q0.5-g0-v0");
  assert.deepEqual(weightingProblems(completePoint({ prior: 10, weight_range: [0.25, 2], days: 30, half_life_days: null, calibration_beta: 0, quorum_share: 0.6 })), [], "a v2 point gains the regime keys at their defaults");
  assert.ok(weightingProblems({ ...WEIGHTING_DEFAULT, quorum_share: 0.7 }).includes("off_grid:quorum_share"));
  assert.ok(weightingProblems({ ...WEIGHTING_DEFAULT, extra: 1 }).includes("unknown_key:extra"));
  const points = neighbourPoints(WEIGHTING_DEFAULT);
  assert.equal(points.length, Object.values(WEIGHTING_GRID).reduce((n, v) => n + v.length - 1, 0), "one parameter away, each grid value");
  assert.ok(points.every((p) => !weightingProblems(p.params).length && p.id !== weightingId(WEIGHTING_DEFAULT)));
  assert.match(points.find((p) => p.changed === "quorum_share").change, /more than 55% of the weight/);
});

test("components: a half-life discounts old calls, the calibration term rewards a calibrated agent, the range clamps", () => {
  const at = T0 + 20 * DAY;
  const old = Array.from({ length: 20 }, (_, i) => ({ close_ms: T0 + i * H, result: "hit", brier: 0.05 }));
  const recent = Array.from({ length: 20 }, (_, i) => ({ close_ms: at - 2 * DAY + i * H, result: "miss", brier: 0.6 }));
  const flat = agentWeight([...old, ...recent], WEIGHTING_DEFAULT, at);
  const decayed = agentWeight([...old, ...recent], { ...WEIGHTING_DEFAULT, half_life_days: 7 }, at);
  assert.ok(decayed.weight < flat.weight, "recent misses weigh more with a half-life");
  const calibrated = agentWeight(old, { ...WEIGHTING_DEFAULT, calibration_beta: 1 }, at);
  assert.ok(calibrated.calibration > 0 && calibrated.weight > agentWeight(old, WEIGHTING_DEFAULT, at).weight);
  assert.equal(weightFromSums({ H: 1000, D: 1000 }, { ...WEIGHTING_DEFAULT, weight_range: [0.5, 1.5] }).weight, 1.5);
  assert.equal(weightFromSums({}, WEIGHTING_DEFAULT).weight, 1, "no record weighs 1");
});

test("replayQuorum: point in time (a call counts only once its horizon closed) and the quorum share", () => {
  const rooms = [{ candle_key: "k1", close_ms: T0 + 10 * H, bias: "BULLISH", entries: [{ agent: "a", bias: "BULLISH" }, { agent: "b", bias: "BEARISH" }, { agent: "c", bias: "BULLISH" }] }];
  const d = replayQuorum(WEIGHTING_DEFAULT, [], rooms).get("k1");
  assert.equal(d.stance, "BUY");
  assert.equal(d.share, 0.667);
  assert.equal(replayQuorum({ ...WEIGHTING_DEFAULT, quorum_share: 0.6 }, [], rooms).get("k1").stance, "BUY");
  // b becomes heavy only from calls whose outcome was known before the room met.
  const rows = Array.from({ length: 40 }, (_, i) => ({ agent: "b", close_ms: T0 + i * 60_000, result: "hit", brier: null }));
  assert.equal(replayQuorum(WEIGHTING_DEFAULT, rows, [{ ...rooms[0], close_ms: T0 + 3 * H }]).get("k1").stance, "BUY", "horizon not closed: b still weighs 1");
  const heavy = replayQuorum(WEIGHTING_DEFAULT, rows, rooms).get("k1");
  assert.equal(heavy.share, 0.526, "b's record now weighs 1.8 against the two bullish agents' 1 each");
  assert.equal(replayQuorum({ ...WEIGHTING_DEFAULT, quorum_share: 0.55 }, rows, rooms).get("k1").stance, "WAIT");
  assert.equal(replayQuorum(WEIGHTING_DEFAULT, [], [{ ...rooms[0], bias: "NEUTRAL" }]).get("k1").stance, "WAIT");
});

/** 320 rooms of 5 agents: 3 of 5 bullish rooms lose on a BUY, 4 of 5 bullish rooms win on it. */
function market() {
  const rooms = [], outcomes = new Map();
  for (let i = 0; i < 320; i++) {
    const strong = i % 2 === 0;
    const entries = ["a", "b", "c", "d", "e"].map((agent, j) => ({ agent, bias: j < (strong ? 4 : 3) ? "BULLISH" : "NEUTRAL" }));
    const key = `OANDA:XAUUSD:60:${T0 + i * H}`;
    rooms.push({ candle_key: key, close_ms: T0 + (i + 1) * H, bias: "BULLISH", stance: "BUY", entries });
    outcomes.set(key, strong ? { BUY: "hit", WAIT: "missed_opportunity" } : { BUY: "miss", WAIT: "hit" });
  }
  return { rooms, outcome: (k, s) => outcomes.get(k)?.[s] ?? null };
}

test("compareWeighting: the quorum 0.6 point wins on discovery and holdout; untouched points stay not_better", () => {
  const { rooms, outcome } = market();
  const r = compareWeighting({ rows: [], rooms, outcome, now: T0 + 20 * DAY, moderator: new Map(rooms.map((x) => [x.candle_key, "BUY"])) });
  const q6 = r.candidates.find((c) => c.id === weightingId({ ...WEIGHTING_DEFAULT, quorum_share: 0.6 }));
  assert.equal(q6.verdict, "better_than_active: activated automatically");
  assert.ok(q6.discovery.p_holm < 0.05 && q6.holdout.complete);
  const q55 = r.candidates.find((c) => c.id === weightingId({ ...WEIGHTING_DEFAULT, quorum_share: 0.55 }));
  assert.equal(q55.differing_decisions, 0);
  assert.equal(q55.verdict, "not_better");
  assert.equal(r.control.moderator_agreement, 1);
  assert.equal(r.reverse, null);
  const report = weightingReport({ ...r, window_days: 30, active: { id: weightingId(WEIGHTING_DEFAULT), params: WEIGHTING_DEFAULT, change: "none" }, agents: [{ agent: "a", family: "trend", weight: 1, accuracy: 0.5, calibration: 0, decisive: 0, n: 0 }] });
  assert.doesNotMatch(JSON.stringify(report), /"(entry|stop|take_profit|price|position_size)/, "no price, level or size in the report");
  assert.equal(report.candidates.find((c) => c.id === q6.id).verdict, q6.verdict);
});

test("automatic choice (owner decisions 2026-11-09, no operator): the best better point; cooldown; never a rolled-back point; the reverse shadow", () => {
  const q6 = { ...WEIGHTING_DEFAULT, quorum_share: 0.6 }, hl7 = { ...WEIGHTING_DEFAULT, half_life_days: 7 };
  const cand = (params, verdict, p_holm, accuracy = 0.62) => ({ id: weightingId(params), params, verdict, change: "c", discovery: { p_holm, accuracy, control_accuracy: 0.55 }, holdout: { accuracy: 0.6 } });
  const state = { id: weightingId(WEIGHTING_DEFAULT), params: WEIGHTING_DEFAULT, history: [] };
  const now = T0 + 30 * DAY;
  assert.equal(autoDecision(state, { candidates: [cand(q6, "not_better", 0.01)] }, { now }).action, "none");
  const d = autoDecision(state, { candidates: [cand(q6, "better_than_active: activated automatically", 0.03), cand(hl7, "better_than_active: activated automatically", 0.01)] }, { now });
  assert.equal(d.action, "activate");
  assert.equal(d.id, weightingId(hl7), "the lowest Holm-adjusted p first");
  assert.equal(autoDecision({ ...state, history: [{ kind: "activated", at: new Date(now - DAY).toISOString() }] }, { candidates: [cand(q6, "better_than_active", 0.01)] }, { now }).action, "none", `${ACTIVATION_COOLDOWN_DAYS}-day cooldown`);
  assert.equal(autoDecision({ ...state, history: [{ kind: "rolled_back", from: weightingId(q6), at: new Date(now - 30 * DAY).toISOString() }] }, { candidates: [cand(q6, "better_than_active", 0.01)] }, { now }).action, "none", "a rolled-back point never returns");
  assert.equal(rollbackDecision({ previous: WEIGHTING_DEFAULT }, { reverse: { rooms: ROLLBACK_MIN_ROOMS - 1, previous_better: 30, active_better: 2, p_value: 0.001 } }).rollback, false);
  assert.equal(rollbackDecision({ previous: WEIGHTING_DEFAULT }, { reverse: { rooms: ROLLBACK_MIN_ROOMS, previous_better: 30, active_better: 2, p_value: 0.001 } }).rollback, true);
  assert.equal(rollbackDecision({ previous: WEIGHTING_DEFAULT }, { reverse: { rooms: 300, previous_better: 12, active_better: 10, p_value: 0.4 } }).rollback, false);
});

test("applyWeighting end to end on D1, per timeframe: activates by itself, the kill switch, the rollback, the Telegram line", async () => {
  const env = { DB: d1() };
  const params = { ...WEIGHTING_DEFAULT, quorum_share: 0.6 };
  const replay = { candidates: [{ id: weightingId(params), params, verdict: "better_than_active: activated automatically", change: "BUY or SELL needs more than 60% of the weight", discovery: { p_holm: 0.01, accuracy: 0.62, control_accuracy: 0.54 }, holdout: { accuracy: 0.6 } }] };
  const now = T0 + 40 * DAY;
  assert.equal((await activeWeighting(env, { timeframe: "240" })).mode, "default");
  const a = await applyWeighting(env, { timeframe: "240", replay, now });
  assert.equal(a.status, "activated");
  assert.match(weightingMessage(a), /^Auto-tuning \(4-hour room\): new weighting active\. Change: BUY or SELL needs more than 60% of the weight\. Replay: right in 62% of decided calls against 54% before/);
  const w = await activeWeighting(env, { timeframe: "240", now, useCache: false });
  assert.equal(w.id, weightingId(params));
  assert.equal((await activeWeighting(env, { timeframe: "60", useCache: false })).mode, "default", "the 1H room has its own state");
  assert.equal((await activeWeighting({ ...env, WEIGHTING_MODE: "default" }, { timeframe: "240" })).params.quorum_share, 0.5, "kill switch");
  assert.equal((await applyWeighting(env, { timeframe: "240", replay, now: now + 3600_000 })).status, "unchanged", "cooldown");
  const back = await applyWeighting(env, { timeframe: "240", replay: { ...replay, reverse: { rooms: 150, previous_better: 40, active_better: 5, p_value: 0.0001 } }, now: now + 10 * DAY });
  assert.equal(back.status, "rolled_back");
  assert.match(weightingMessage(back), /rolled back to the previous point/);
  const s = await weightingState(env, { timeframe: "240", useCache: false });
  assert.equal(s.id, weightingId(WEIGHTING_DEFAULT));
  assert.deepEqual(s.history.map((h) => h.kind), ["activated", "rolled_back"]);
  assert.equal((await applyWeighting(env, { timeframe: "240", replay, now: now + 30 * DAY })).status, "unchanged", "never re-activated");
  assert.equal(weightingMessage({ status: "unchanged" }), null);
});

test("regimes: volatility tercile x efficiency ratio from the timeframe's own bars; the regime component and the high-volatility quorum", () => {
  const bars = [];
  for (let i = 0; i < 200; i++) {
    const trend = i > 150 ? (i - 150) * 2 : 0, range = i > 185 ? 6 : 1;
    const c = 4000 + trend + (i % 2 ? 0.3 : -0.3);
    bars.push({ open: c, high: c + range, low: c - range, close: c, open_time: new Date(T0 + i * H).toISOString(), close_time: new Date(T0 + (i + 1) * H).toISOString() });
  }
  const map = regimeMap(bars);
  assert.equal(regimeAt(bars, 10, atrShares(bars)), null, "no regime without history");
  assert.equal(map.get(T0 + 200 * H), "high-trending");
  assert.match(map.get(T0 + 120 * H), /-ranging$/);
  assert.ok([...map.values()].every((r) => REGIMES.includes(r)));
  assert.equal(quorumFor({ ...WEIGHTING_DEFAULT, high_vol_quorum_bonus: 0.1 }, "high-trending"), 0.6);
  assert.equal(quorumFor({ ...WEIGHTING_DEFAULT, high_vol_quorum_bonus: 0.1 }, "normal-trending"), 0.5);
  // An agent right in trends and wrong in ranges: the regime component follows the bar's regime.
  const at = T0 + 20 * DAY;
  const rows = [...Array.from({ length: 30 }, (_, i) => ({ close_ms: T0 + i * H, result: "hit", brier: null, regime: "high-trending" })), ...Array.from({ length: 30 }, (_, i) => ({ close_ms: T0 + (40 + i) * H, result: "miss", brier: null, regime: "low-ranging" }))];
  const p = { ...WEIGHTING_DEFAULT, regime_prior: 10 };
  assert.ok(agentWeight(rows, p, at, { regime: "high-trending" }).weight > agentWeight(rows, WEIGHTING_DEFAULT, at).weight);
  assert.ok(agentWeight(rows, p, at, { regime: "low-ranging" }).weight < agentWeight(rows, WEIGHTING_DEFAULT, at).weight);
  assert.equal(agentWeight(rows, p, at, { regime: null }).weight, agentWeight(rows, WEIGHTING_DEFAULT, at).weight, "no regime: the whole record");
});

test("the crowd line carries its quorum share and weighting; quorumAllows and quorumOf obey it", () => {
  const entries = [{ id: "a", stance: "BUY", bias: "BULLISH" }, { id: "b", stance: "WAIT", bias: "BULLISH" }, { id: "c", stance: "WAIT", bias: "NEUTRAL" }, { id: "d", stance: "WAIT", bias: "BULLISH" }, { id: "e", stance: "WAIT", bias: "NEUTRAL" }];
  const crowd = buildCrowdLine(entries, {}, { quorumShare: 0.6, weighting: "weighting@q" });
  assert.equal(crowd.weighted_biases.BULLISH, 0.6);
  assert.equal(crowd.quorum_share, 0.6);
  assert.equal(quorumAllows("BUY", crowd), false, "0.6 is not more than 0.6");
  assert.equal(quorumAllows("BUY", buildCrowdLine(entries)), true, "default 0.5");
  const room = { bar_open: "x", roster: [], openings: [{ id: "a", name: "A", status: "ok", stance: "BUY", confidence: 0.6, claim: "c" }], debate: [], conclusion: { status: "ok", stance: "BUY", bias: "BULLISH", confidence: 0.6, summary: "s", reasons: ["r"], dissent: [] }, crowd };
  const q = quorumOf(consensusInput(room));
  assert.equal(q.needed, 0.6);
  assert.equal(q.stance, "WAIT");
  assert.equal(q.weighting, "weighting@q");
});

test("loadH1Rooms: the final bias per agent (debate over opening), the latest session, the moderator's bias", async () => {
  const db = d1();
  db.db.exec(`CREATE TABLE agent_thread_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, run_id TEXT, step TEXT, agent TEXT, ts TEXT, stance TEXT, body_json TEXT, status TEXT)`);
  const key = "OANDA:XAUUSD:60:" + T0;
  const put = (run, step, agent, stance, body) => db.db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, stance, body_json, status) VALUES ('tf:H1', ?, ?, ?, ?, ?, ?, 'ok')").run(run, step, agent, new Date(T0 + H).toISOString(), stance, JSON.stringify(body));
  for (const run of ["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z#hud"]) {
    put(run, "brief", "moderator", null, { candle_key: key });
    put(run, "open:a", "a", "WAIT", { bias: "NEUTRAL" });
    put(run, "open:b", "b", "BUY", { bias: "BULLISH" });
    put(run, "debate:a", "a", "WAIT", { bias: run.endsWith("#hud") ? "BULLISH" : "BEARISH" });
    put(run, "conclusion", "moderator", "BUY", { bias: "BULLISH" });
  }
  const rooms = await loadH1Rooms(db, "2026-09-01T00:00:00Z");
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].close_ms, T0 + H);
  assert.equal(rooms[0].bias, "BULLISH");
  assert.deepEqual(rooms[0].entries, [{ agent: "a", bias: "BULLISH" }, { agent: "b", bias: "BULLISH" }], "the #hud session and the debate answer win");
  // The 15m room: thread warroom:<day>, keyed by its bar time (close); the outcome key is the bar's open.
  const close = T0 + 2 * H;
  const put15 = (step, agent, stance, body) => db.db.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, ts, stance, body_json, status, bar_time) VALUES ('warroom:2026-10-01', ?, ?, ?, ?, ?, ?, 'ok', ?)").run(new Date(close).toISOString(), step, agent, new Date(close).toISOString(), stance, JSON.stringify(body), new Date(close).toISOString());
  db.db.exec("ALTER TABLE agent_thread_messages ADD COLUMN bar_time TEXT");
  put15("open:x", "x", "SELL", { bias: "BEARISH" });
  put15("conclusion", "moderator", "WAIT", { bias: "BEARISH" });
  const r15 = await loadRooms(db, "15", "2026-09-01T00:00:00Z");
  assert.equal(r15[0].candle_key, "OANDA:XAUUSD:15:" + (close - 900_000));
  assert.equal(r15[0].close_ms, close);
});
