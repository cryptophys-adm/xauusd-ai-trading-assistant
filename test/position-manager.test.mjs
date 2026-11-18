// The 5-minute Position Manager (owner 2026-11-17: live directly, risk-reducing only, USD 5 a day): the rules, the
// council on measured inputs, fail safe, the Omega intents checked against the live price, the cap and the report.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { positionFacts, positionAction, positionCouncilMessages, cleanCouncil, runPositionManager, positionReport, actionMessage, POSITION_COUNCIL_METER, THRESHOLD_PIPS } from "../src/position-manager.mjs";
import { resetPositionSchemaCacheForTests, pendingPositionActions } from "../src/position-actions.mjs";
import { positionManagerIntents, planIntents } from "../src/omega-engine.mjs";

const sym = (bid, extra = {}) => ({ bid, ask: bid + 0.2, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0, ...extra });
const decision = (over = {}) => ({ stance: "SELL", quorum: { long_share: 0.05, short_share: 0.9 }, quorum_prev: { long_share: 0.05, short_share: 0.9 },
  agent_confidence: { zone_pullback: { long: 0.3, short: 0.8 } }, agent_confidence_prev: { zone_pullback: { long: 0.3, short: 0.8 } }, ...over });
// A SELL opened at 3880.00, plan TP (TP1) 3870.00, stop 3890.00; key levels below for TP2.
const pos = (over = {}) => ({ ticket: 101, side: "SELL", open_price: 3880, sl: 3890, tp: 3870, volume: 0.01, intent_id: "open:1:S", magic: 20251109, comment: "omega", ...over });
const intent = { tp: 3870, strategy: "zone_pullback" };
const levels = [{ low: 3850, high: 3852 }, { low: 3860, high: 3862 }];
const facts = (bid, over = {}, dec = decision()) => positionFacts({ position: pos(over), sym: sym(bid), openIntent: intent, levels, decision: dec });

test("PM1. the rules, in pips (1 pip = 0.10)", () => {
  // +35 pips (price 3876.30 ask for a SELL), council weakening: close.
  const f = facts(3876.3);
  assert.equal(f.pips, 35, "a SELL's exit is priced at the ask (bid + spread): 3880.00 - 3876.50");
  assert.deepEqual(positionAction(f, { momentum: "weakening", thesis: "weakening" }).action, "close");
  // +35 and still strong: stop to break-even plus the spread.
  const be = positionAction(f, { momentum: "holding", thesis: "intact" });
  assert.deepEqual([be.action, be.rule, be.sl], ["sl", "breakeven", 3880 - 0.2]);
  // Council failed: no action (fail safe).
  assert.equal(positionAction(f, null).action, "none");
  // 30 pips beyond TP1 (3870 - 3.00 = 3867.00): the stop locks TP1, no council needed.
  const lock = positionAction(facts(3866.8), null);
  assert.deepEqual([lock.action, lock.rule, lock.sl], ["sl", "lock_tp1", 3870]);
  // TP2 at the broker once: the target still at TP1 moves out to the next key level below (3862).
  const tp2 = positionAction(facts(3878.8), null);
  assert.deepEqual([tp2.action, tp2.tp], ["tp", 3862]);
});

test("PM2. a loss of 30 pips: cut when the decision, the agent's confidence or the quorum turned; else hold to the stop", () => {
  const loss = (dec, council = { momentum: "holding", thesis: "intact" }) => positionAction(facts(3882.8, {}, dec), council);
  assert.equal(facts(3882.8).pips, -30);
  assert.equal(loss(decision()).action, "hold", "still strong: held to the original stop");
  assert.equal(loss(decision({ stance: "WAIT" })).action, "close", "the decision turned WAIT");
  assert.equal(loss(decision({ stance: "BUY" })).action, "close", "the decision turned to the other side");
  assert.equal(loss(decision({ agent_confidence: { zone_pullback: { long: 0.3, short: 0.6 } } })).action, "close", "the agent's measured confidence dropped");
  assert.equal(loss(decision({ quorum: { long_share: 0.2, short_share: 0.7 } })).action, "close", "the quorum's share on the side fell");
  assert.equal(loss(decision(), { momentum: "weakening", thesis: "broken" }).action, "close", "the council calls the thesis broken");
  assert.equal(loss(decision({ agent_confidence_prev: {} })).action, "none", "a missing measured input: no action");
  assert.equal(positionAction(null, null).action, "none");
});

test("PM3. the council sees measured inputs only and never its own confidence; its answer is checked", () => {
  const msgs = positionCouncilMessages(facts(3876.1), { levels });
  const ev = JSON.parse(msgs[1].content);
  assert.deepEqual(Object.keys(ev.measured).sort(), ["agent", "agent_confidence_15m_ago", "agent_confidence_now", "agent_trend", "decision_stance", "quorum_share_15m_ago", "quorum_share_with_position"]);
  assert.doesNotMatch(msgs[1].content, /"confidence":/, "never the council's self-reported confidence");
  assert.match(msgs[0].content, /you never choose the action, a size or a price/);
  assert.equal(cleanCouncil({ momentum: "up", thesis: "intact" }), null);
});

test("PM4. Omega: intents only that reduce risk, checked against the live price; never an open or a wider stop", () => {
  const positions = [pos()];
  const actions = [
    { id: "pm:101:7000", ticket: 101, action: "sl", rule: "breakeven", sl: 3879.8 },
    { id: "pm:999:7000", ticket: 999, action: "close", rule: "cut_loss" }
  ];
  let r = positionManagerIntents({ positions, sym: sym(3876.1), actions });
  assert.deepEqual(r.intents.map((i) => [i.id, i.kind, i.sl]), [["pm:101:s:7000", "modify_sl", 3879.8]]);
  assert.ok(r.intents.every((i) => i.id.length <= 31));
  // A wider stop (above 3890 for a SELL) is refused; so is a stop on the wrong side of price.
  assert.equal(positionManagerIntents({ positions, sym: sym(3876.1), actions: [{ id: "pm:101:1", ticket: 101, action: "sl", rule: "x", sl: 3895 }] }).intents.length, 0);
  assert.equal(positionManagerIntents({ positions, sym: sym(3882), actions: [{ id: "pm:101:1", ticket: 101, action: "sl", rule: "x", sl: 3881 }] }).intents.length, 0, "no room: price is above the new stop");
  // A target moved inward is refused; out to TP2 passes.
  assert.equal(positionManagerIntents({ positions, sym: sym(3876.1), actions: [{ id: "pm:101:1", ticket: 101, action: "tp", rule: "tp2_target", tp: 3875 }] }).intents.length, 0);
  assert.equal(positionManagerIntents({ positions, sym: sym(3876.1), actions: [{ id: "pm:101:1", ticket: 101, action: "tp", rule: "tp2_target", tp: 3862 }] }).intents[0].kind, "modify_tp");
  // In the plan: a close from the manager, and no open intent from it.
  const executor = { connected: true, received_ms: 1_000, positions, account: { trade_mode: "demo" }, symbol: sym(3876.1) };
  const plan = planIntents({ executor, now: 1_000, engineEnabled: true, settings: { enabled: true }, pmActions: [{ id: "pm:101:7001", ticket: 101, action: "close", rule: "take_profit_weakening" }] });
  assert.ok(plan.intents.some((i) => i.id === "pm:101:c:7001" && i.kind === "close" && i.reason === "pm_take_profit_weakening"));
  assert.ok(!plan.intents.some((i) => i.kind === "open"));
});

function memDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, PRIMARY KEY (day, source, model))");
  const wrap = (sql) => { let args = []; const s = { bind: (...a) => { args = a; return s; }, run: async () => db.prepare(sql).run(...args), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }) }; return s; };
  return { prepare: wrap, raw: db };
}

test("PM5. the runner: once per position and 5m bar, live only, Telegram per action, the daily cap stops the council", async () => {
  resetPositionSchemaCacheForTests();
  const db = memDb(), sent = [], calls = [];
  const kv = new Map();
  const env = { DB: db, POSITION_MANAGER_MODE: "live", POSITION_COUNCIL_DAILY_USD: "5", SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
  const call = async (_e, req) => { calls.push(req); return { status: "answered", obj: { momentum: "weakening", thesis: "weakening", reason: "momentum fading at the zone" } }; };
  const base = { call, send: async (t) => sent.push(t), executor: { positions: [pos()], symbol: sym(3876.1) }, openIntents: { "open:1:S": intent }, signal: null, decision: decision() };
  const now = Date.parse("2026-11-17T08:00:30Z");
  assert.equal((await runPositionManager({ ...env, POSITION_MANAGER_MODE: "off" }, { ...base, now })).status, "off");
  const r = await runPositionManager(env, { ...base, now });
  assert.deepEqual(r.positions.map((p) => [p.action, p.rule]), [["close", "take_profit_weakening"]]);
  assert.equal(calls[0].meterSource, POSITION_COUNCIL_METER);
  assert.match(sent[0], /POSITION MANAGER · #101 SELL · \+37 pips · closed/);
  assert.equal((await runPositionManager(env, { ...base, now: now + 60_000 })).positions.length, 0, "once per 5m bar");
  assert.deepEqual((await pendingPositionActions(db, { now: now + 60_000 })).map((a) => a.action), ["close"]);
  // The cap reached: no council call, no action, one Telegram line a day.
  db.raw.prepare("INSERT INTO ai_usage_daily VALUES ('2026-11-17', 'position_council', '@cf/openai/gpt-oss-120b', 1, 100000000, 10000000, 0)").run();
  const before = calls.length;
  const capped = await runPositionManager(env, { ...base, now: now + 300_000 });
  assert.equal(calls.length, before, "no council call past the cap");
  assert.deepEqual(capped.positions.map((p) => [p.action, p.rule]), [["none", "daily_cap"]]);
  assert.ok(sent.some((t) => /paused for today/.test(t)));
});

test("PM6. the daily report: a close against holding to the original stop and target", () => {
  const rows = [{ ticket: 101, side: "SELL", action: "close", rule: "take_profit_weakening", status: "applied", at_ms: 1000, pips: 35, price: 3876.5, orig_sl: 3890, orig_tp: 3870, basis: 0 }];
  // After the close price went back up to the original stop: holding would have lost 100 pips; the close saved 135.
  const bars = [{ open_time: 2000, high: 3885, low: 3875, close: 3884 }, { open_time: 3000, high: 3891, low: 3884, close: 3890 }];
  const rep = positionReport(rows, bars, { now: 10_000 });
  assert.deepEqual([rep.items[0].held_pips, rep.items[0].saved_pips, rep.saved_pips], [-100, 135, 135]);
  assert.equal(THRESHOLD_PIPS, 30);
  assert.match(actionMessage({ ticket: 1, side: "BUY", pips: -31, action: "close", why: "cut", council: null }), /-31 pips · closed/);
});

test("PM-R the profit and loss band in R of the stop at entry, per mode (owner 2026-11-18: \"Per mode\")", async () => {
  const { pmBand, PM_R_BAND } = await import("../src/position-manager.mjs");
  assert.deepEqual({ ...PM_R_BAND }, { scalp: 0.3, intraday: 0.5, range: 0.5, swing: 0.7 });
  // A 140-pip stop (14.00): scalp 42 pips, intraday and range 70, swing 98.
  assert.deepEqual(pmBand({ r_dist: 14, mode: "scalp" }), { pips: 42, r: 0.3, mode: "scalp", r_dist_pips: 140 });
  assert.equal(pmBand({ r_dist: 14, mode: "range" }).pips, 70);
  assert.equal(pmBand({ r_dist: 14, mode: "swing" }).pips, 98);
  // No mode on the intent: the decision's, else intraday. No r_dist: |entry - sl|. Neither: 30 pips.
  assert.equal(pmBand({ r_dist: 14 }, "swing").mode, "swing");
  assert.equal(pmBand({ r_dist: 14 }).mode, "intraday");
  assert.equal(pmBand({ entry: 3880, sl: 3890, mode: "intraday" }).pips, 50);
  assert.deepEqual(pmBand({ tp: 3870 }), { pips: 30, r: null, mode: "intraday", r_dist_pips: null });

  // A SELL from 3880 with a 10.00 stop on intraday: the band is 50 pips. +35 is inside it (no council needed, no action).
  const ri = { tp: 3870, strategy: "zone_pullback", mode: "intraday", r_dist: 10 };
  const fR = (bid, dec = decision()) => positionFacts({ position: pos(), sym: sym(bid), openIntent: ri, levels: [], decision: dec });
  const inside = positionAction(fR(3876.3), { momentum: "weakening", thesis: "weakening" });
  assert.deepEqual([inside.action, inside.rule], ["hold", "inside_band"]);
  assert.match(inside.why, /±50 pip band \(±0\.5R intraday\)/);
  // +55 pips (0.55R) and weakening: closed, and the line says the R.
  const take = positionAction(fR(3874.3), { momentum: "weakening", thesis: "weakening" });
  assert.deepEqual([take.action, take.rule], ["close", "take_profit_weakening"]);
  assert.match(take.why, /\+55 pips \(\+0\.55R, band 0\.5R intraday\)/);
  // -30 pips is no longer a cut on intraday with a 100-pip stop; -52 with the decision turned is.
  assert.equal(positionAction(fR(3882.8, decision({ stance: "WAIT" })), { momentum: "weakening", thesis: "broken" }).action, "hold");
  const cut = positionAction(fR(3885, decision({ stance: "WAIT" })), { momentum: "weakening", thesis: "intact" });
  assert.deepEqual([cut.action, cut.rule], ["close", "cut_loss"]);
  // Scalp with the same stop: 30 pips, as before.
  const fs = positionFacts({ position: pos(), sym: sym(3876.3), openIntent: { ...ri, mode: "scalp" }, levels: [], decision: decision() });
  assert.equal(fs.band_pips, 30);
  assert.equal(positionAction(fs, { momentum: "weakening", thesis: "weakening" }).action, "close");
  // lock_tp1 stays at 30 pips beyond TP1 whatever the band.
  assert.equal(positionAction(positionFacts({ position: pos(), sym: sym(3866.8), openIntent: ri, levels: [], decision: decision() }), null).rule, "lock_tp1");
});
