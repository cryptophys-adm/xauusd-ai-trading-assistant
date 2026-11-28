// Call for Councils P1 (docs/RFC_CALL_FOR_COUNCILS.md §1.2, §8): the deterministic suggestion flags for every topic
// type, their thresholds, every strategy agent and pattern covered, the dedup (one open per topic, a 7-day
// fingerprint cooldown, 3 new a day) and the hourly run over node:sqlite.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cfcMode, runCfcTriggers, readSuggestions, strategyFlags, riskFlags, engineFlags, modelFlags, seatFlags, knowledgeFlags, newsFlags, executionFlags,
  dataFlags, costFlags, computeFlags, selectNew, stopShare, fingerprintOf, CFC_RULES, CFC_SCHEMA_SQL, OPEN_KEYS_SQL, RECENT_FINGERPRINTS_SQL,
  CREATED_SINCE_SQL, SUGGESTIONS_SQL, resetCfcSchemaCacheForTests, MODEL_GATE_KEY
} from "../src/cfc-triggers.mjs";
import { parseTopicKey, priceKeysIn, patternsOf } from "../src/cfc-pack.mjs";
import { AGENT_IDS, agentStatuses } from "../src/strategy-agents.mjs";
import { SCORING_VERSION } from "../src/outcome-scoring.mjs";
import { NOW, database, seedEnv, seedTrades, MODEL } from "./support/cfc-fixtures.mjs";

const trade = (agent, exit, { pattern = null, i = 0, session = "london", mode = "intraday", regime = "normal-trending", omega = exit } = {}) => ({
  id: `decision:${agent}:${pattern}:${i}`, key: `k${i}`, opened_at: new Date(NOW - i * 3_600_000).toISOString(), agent, pattern, session, mode, regime,
  plan: { exit, r: exit === "target" ? 2 : -1, closed_at: new Date(NOW - i * 3_600_000 + 1_800_000).toISOString() }, omega: { exit: omega, r: omega === "target" ? 1.5 : -1, closed_at: new Date(NOW - i * 3_600_000 + 1_800_000).toISOString() }
});
/** `stops` of the newest `n` trades end at the stop (the rest at the target). */
const run = (agent, n, stops, opts = {}) => Array.from({ length: n }, (_, i) => trade(agent, i < stops ? (i % 2 ? "sl_plus" : "stop") : "target", { ...opts, i }));
const keys = (list) => list.map((c) => c.topic_key);
const ALL_LIVE = { STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") };

test("CFC_MODE: suggest by default, off and on accepted, anything else fails closed", () => {
  assert.equal(cfcMode({}), "suggest");
  assert.equal(cfcMode({ CFC_MODE: "" }), "suggest");
  assert.equal(cfcMode({ CFC_MODE: "OFF" }), "off");
  assert.equal(cfcMode({ CFC_MODE: "on" }), "on");
  assert.equal(cfcMode({ CFC_MODE: "yes" }), "off");
});

test("strategy stop share: 20 resolved trades and 0.65, SL+ counted as a stop, per definition", () => {
  const statuses = agentStatuses(ALL_LIVE);
  const flag = (trades) => strategyFlags({ trades, statuses, wanted: statuses }).filter((c) => c.rule === "stop_share");
  assert.deepEqual(keys(flag(run("zone_pullback", 20, 13))), ["strategy:zone_pullback:exits"], "13 of 20 = 0.65 fires");
  assert.deepEqual(flag(run("zone_pullback", 20, 12)), [], "12 of 20 = 0.60 does not");
  assert.deepEqual(flag(run("zone_pullback", 19, 19)), [], "19 trades are too few");
  assert.deepEqual(flag([...run("zone_pullback", 20, 5), ...run("zone_pullback", 20, 20).map((t, i) => ({ ...t, id: "old" + i }))]), [], "only the newest 20 count");
  const only = flag(run("zone_pullback", 20, 0).map((t, i) => ({ ...t, omega: { ...t.omega, exit: i < 14 ? "sl_plus" : "target" } })));
  assert.deepEqual(only[0].signal.fired_by, ["omega"], "Omega's locked stop alone can fire it");
  assert.equal(only[0].signal.shares.ledger.stop_share, 0);
  assert.deepEqual(priceKeysIn(only), []);
  assert.equal(stopShare([{ exit: "stop" }], 2).stop_share, null);
});

test("every strategy agent and every pattern it trades is covered; an agent that is off is not", () => {
  const statuses = agentStatuses(ALL_LIVE);
  const trades = AGENT_IDS.flatMap((id) => run(id, 20, 20));
  assert.deepEqual(keys(strategyFlags({ trades, statuses, wanted: statuses })).sort(), AGENT_IDS.map((id) => `strategy:${id}:exits`).sort());
  const off = agentStatuses({ ...ALL_LIVE, STRATEGY_AGENTS_OFF: "range_fade" });
  assert.ok(!keys(strategyFlags({ trades, statuses: off, wanted: off })).includes("strategy:range_fade:exits"));
  for (const id of AGENT_IDS.filter((a) => patternsOf(a).length)) {
    const p = patternsOf(id).at(-1);
    const got = keys(strategyFlags({ trades: run(id, 20, 20, { pattern: p }), statuses, wanted: statuses }));
    assert.ok(got.includes(`strategy:${id}:${p}`), `${id}: its pattern ${p}`);
  }
  // A shadow agent trades nothing: the plan learner's replay of its own plan counts for it.
  const shadow = agentStatuses({});
  assert.equal(shadow.breakout_retest, "shadow");
  const setups = Array.from({ length: 20 }, (_, i) => ({ agent: "breakout_retest", pattern: null, s: i < 15 ? "stop" : "target", f: 1 }));
  const viaReplay = strategyFlags({ trades: [], setups, statuses: shadow, wanted: shadow });
  assert.deepEqual(keys(viaReplay), ["strategy:breakout_retest:exits"]);
  assert.deepEqual(viaReplay[0].signal.fired_by, ["replay"]);
  assert.deepEqual(strategyFlags({ setups: setups.map((s) => ({ ...s, f: 0 })), statuses: shadow, wanted: shadow }), [], "unfilled setups do not count");
});

test("breakers and the plan learner's contexts", () => {
  const statuses = agentStatuses({ STRATEGY_AGENTS_LIVE: "sweep_reversal" });
  const records = [
    { agent: "sweep_reversal", setups: 31, mean_r: -0.2, contexts: [{ context: "intraday|normal-trending", setups: 20, mean_r: -0.05 }, { context: "scalp|low-ranging", setups: 19, mean_r: -1 }] },
    { agent: "range_fade", setups: 40, mean_r: -0.3, contexts: [] },
    { agent: "pattern_peaks", setups: 20, mean_r: 0.1, patterns: [{ pattern: patternsOf("pattern_peaks")[0], setups: 15, mean_r: -0.4 }] }
  ];
  const withBreaker = agentStatuses({ STRATEGY_AGENTS_LIVE: "sweep_reversal" }, { records });
  const got = strategyFlags({ records, statuses: withBreaker, wanted: statuses });
  assert.deepEqual(keys(got).sort(), ["strategy:pattern_peaks:" + patternsOf("pattern_peaks")[0], "strategy:sweep_reversal", "strategy:sweep_reversal@intraday|normal-trending"].sort(), "range_fade is shadow: no suspension to tell; a context needs 20 setups");
  assert.equal(got.find((c) => c.rule === "agent_suspended").signal.min_setups, 30);
});

test("risk, engine, model, seat, knowledge, news, execution, data and cost flags at their thresholds", () => {
  assert.deepEqual(keys(riskFlags(run("zone_pullback", 20, 13, { session: "asia", mode: "scalp", regime: "high-ranging" }))).sort(), ["risk:asia", "risk:high-ranging", "risk:scalp"]);
  assert.deepEqual(riskFlags(run("zone_pullback", 20, 12)), []);
  const card = (subject, tf, hit, miss) => ({ subject, timeframe: tf, n: hit + miss, directional: { n: hit + miss, hit, miss, hit_rate: hit / (hit + miss) }, wait: { n: 0 } });
  assert.deepEqual(keys(engineFlags({ cards7: [card("engine:15", "15", 15, 15)], cards30: [card("engine:15", "15", 60, 40)] })), ["engine:15"], "50% against 60%, 30 decisive");
  assert.deepEqual(engineFlags({ cards7: [card("engine:15", "15", 15, 14)], cards30: [card("engine:15", "15", 60, 40)] }), [], "29 decisive calls");
  assert.deepEqual(engineFlags({ cards7: [card("engine:15", "15", 16, 14)], cards30: [card("engine:15", "15", 60, 40)] }), [], "a 6.7-point drop");
  assert.deepEqual(keys(modelFlags({ previous: "promoted", current: "not_promoted" })), ["engine:model"]);
  assert.deepEqual(modelFlags({ previous: null, current: "not_promoted" }), []);
  const low = { subject: "agent:risk", timeframe: "15", n: 300, directional: { hit: 10, miss: 200 }, wait: { hit: 0, missed_opportunity: 50 } };
  assert.deepEqual(keys(seatFlags([low, { ...low, subject: "agent:nobody" }, { ...low, timeframe: "5" }, { ...low, subject: "agent:technical", directional: { hit: 100, miss: 100 } }])), ["seat:risk@15", "seat:nobody@15"]);
  assert.deepEqual(keys(computeFlags({ cards30: [low, { ...low, subject: "agent:nobody" }] }, { now: NOW })), ["seat:risk@15"], "a key the grammar refuses is dropped");
  const retired = [{ item_id: "note-1", version: 2, status: "retired", retired_at: new Date(NOW - 86_400_000).toISOString(), reason: "worse live: 10 of 40 decided calls right" }, { item_id: "note-2", version: 1, status: "retired", retired_at: new Date(NOW - 86_400_000).toISOString(), reason: "no longer in Aether's pack" }, { item_id: "note-3", version: 1, status: "retired", retired_at: new Date(NOW - 9 * 86_400_000).toISOString(), reason: "worse live: old" }];
  assert.deepEqual(keys(knowledgeFlags(retired, { now: NOW })), ["knowledge:note-1"]);
  const losing = run("zone_pullback", 3, 3), release = [{ release_key: "USD:r", title: "CPI", kind: "cpi", time: losing[1].opened_at }];
  const near = [{ ...release[0], time: losing[0].opened_at }, release[0], { ...release[0], release_key: "USD:r2", time: losing[2].opened_at }];
  assert.deepEqual(keys(newsFlags(losing, near, { now: NOW })), ["news:release_horizon"]);
  assert.deepEqual(newsFlags(losing.slice(0, 2), near, { now: NOW }), [], "two losing trades are not enough");
  assert.deepEqual(keys(executionFlags({ recoveries: 3, failedIntents: 2 })), ["execution:recoveries"]);
  assert.deepEqual(keys(executionFlags({ recoveries: 0, failedIntents: 3 })), ["execution:rejected_intents"]);
  assert.deepEqual(keys(dataFlags({ stuck: [{ field: "gmi_v12_70.verdict", status: "open", candles: 24 }, { field: "prophet_r38.d_enc", status: "open", candles: 23 }], alerts: [{ kind: "parity_revoked", status: "open" }, { kind: "market_data_stale", status: "resolved" }] })), ["data:gmi_v12_70"], "S5: an open parity_revoked alert no longer flags a topic");
  const day = (d) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10);
  const usage = [
    ...[1, 2, 3].map((d) => ({ day: day(d), source: "warroom_agent", model: MODEL, calls: 100, prompt_tokens: 600_000, completion_tokens: 60_000 })),
    ...[8, 9].map((d) => ({ day: day(d), source: "warroom_agent", model: MODEL, calls: 50, prompt_tokens: 600_000, completion_tokens: 60_000 }))
  ];
  const cost = costFlags({ usage, switches: [{ at: new Date(NOW - 86_400_000).toISOString(), mode: "off", actor: "cost-breaker" }, { at: new Date(NOW).toISOString(), mode: "off", actor: "owner:x" }], now: NOW });
  assert.deepEqual(keys(cost), ["cost:warroom_agent", "cost:shadow"]);
  assert.equal(cost[0].signal.growth, 0.5);
  assert.ok(!JSON.stringify(cost).includes(MODEL), "no model identifier in a signal");
});

test("the flags come in a fixed order and every key is valid", () => {
  const statuses = agentStatuses(ALL_LIVE);
  const flags = computeFlags({ strategy: { trades: run("zone_pullback", 20, 20), statuses, wanted: statuses }, trades: run("zone_pullback", 20, 20), execution: { recoveries: 5 }, data: { alerts: [{ kind: "market_data_stale", status: "open" }] } }, { now: NOW });
  assert.deepEqual(keys(flags), ["strategy:zone_pullback:exits", "risk:intraday", "risk:london", "risk:normal-trending", "execution:recoveries", "data:market_feed"]);
  for (const c of flags) { assert.equal(parseTopicKey(c.topic_key).ok, true); assert.deepEqual(priceKeysIn(c.signal), []); assert.equal(typeof c.signal.summary, "string"); }
});

test("dedup: one open per topic key, a 7-day fingerprint cooldown, at most 3 new a day", async () => {
  const c = (topic_key, rule = "stop_share") => ({ topic_key, rule, fingerprint: `${topic_key}|${rule}` });
  const list = [c("strategy:a:exits"), c("strategy:a:exits", "agent_suspended"), c("risk:london"), c("risk:asia"), c("engine:15"), c("data:market_feed"), c("cost:shadow")];
  const sel = selectNew(list, { open: new Set(["risk:london"]), recent: new Set(["risk:asia|stop_share"]), createdToday: 1 });
  assert.deepEqual(keys(sel.insert), ["strategy:a:exits", "engine:15"], "3 a day, one already made today");
  assert.deepEqual(keys(sel.touch), ["risk:london"]);
  assert.deepEqual(sel.skipped.map((x) => [x.topic_key, x.why]), [["strategy:a:exits", "same_topic_this_run"], ["risk:asia", "cooldown"], ["data:market_feed", "daily_cap"], ["cost:shadow", "daily_cap"]]);
  assert.deepEqual(selectNew(list, { createdToday: 3 }).insert, []);
  assert.match(await fingerprintOf({ topic_key: "risk:asia", rule: "stop_share" }), /^[0-9a-f]{64}$/);
  assert.equal(await fingerprintOf({ topic_key: "risk:asia", rule: "stop_share" }), await fingerprintOf({ topic_key: "risk:asia", rule: "stop_share" }));
});

test("the hourly run stores at most 3 a day, refreshes the open ones, waits out the cooldown; off writes nothing", async () => {
  resetCfcSchemaCacheForTests();
  const env = { ...(await seedEnv()), STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") };
  for (const [agent, i] of [["zone_pullback", 0], ["sweep_reversal", 1], ["range_fade", 2], ["breakout_retest", 3]]) await seedTrades(env, { agent, n: 20, exits: [["stop", "sl_plus"], ["stop", "stop"], ["stop", "stop"], ["target", "target"]], start: NOW - (8 - i) * 86_400_000 });
  const off = await runCfcTriggers({ ...env, CFC_MODE: "off" }, { now: NOW });
  assert.deepEqual(off, { status: "off" });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM cfc_suggestions").get().n, 0);
  const first = await runCfcTriggers(env, { now: NOW });
  assert.equal(first.status, "ok", JSON.stringify(first));
  assert.equal(first.created.length, 3, "at most 3 new suggestions a day");
  assert.ok(first.flags > 3);
  const again = await runCfcTriggers(env, { now: NOW + 3_600_000 });
  assert.deepEqual(again.created, [], "the day's cap holds");
  assert.equal(again.refreshed, 3, "the open ones are refreshed");
  const next = await runCfcTriggers(env, { now: NOW + 86_400_000 });
  assert.equal(next.created.length, 3, "a new day, three more");
  const rows = env.DB.db.prepare("SELECT topic_key, status FROM cfc_suggestions").all();
  assert.equal(new Set(rows.map((r) => r.topic_key)).size, rows.length, "one row per topic key");
  assert.ok(rows.every((r) => r.status === "open"));
  assert.throws(() => env.DB.db.prepare("INSERT INTO cfc_suggestions (topic_key, type, rule, fingerprint, signal_json, created_at, last_seen_at) VALUES (?, 'risk', 'r', 'f', '{}', 'x', 'x')").run(rows[0].topic_key), /UNIQUE/, "the database itself keeps one open suggestion per topic");
  // A dismissed suggestion (phase P2) is not suggested again within 7 days.
  env.DB.db.prepare("UPDATE cfc_suggestions SET status = 'dismissed' WHERE topic_key = ?").run(rows[0].topic_key);
  const cooled = await runCfcTriggers(env, { now: NOW + 2 * 86_400_000 });
  assert.ok(!cooled.created.includes(rows[0].topic_key), "the fingerprint's cooldown");
  const view = await readSuggestions(env, { now: NOW + 2 * 86_400_000 });
  assert.equal(view.mode, "suggest");
  assert.ok(view.suggestions.length >= 6);
  assert.equal(view.suggestions[0].status, "open", "open ones first");
  for (const s of view.suggestions) { assert.equal(parseTopicKey(s.topic_key).ok, true); assert.equal(typeof s.signal.summary, "string"); assert.deepEqual(priceKeysIn(s.signal), []); }
  assert.ok(!JSON.stringify(view).includes("4001.25"), "no price in a suggestion");
});

test("the model gate's last status is kept in KV, and its disconnection is suggested once", async () => {
  resetCfcSchemaCacheForTests();
  const env = await seedEnv();
  const { MODEL_BASELINE_KEY } = await import("../src/model-baseline.mjs");
  await env.SIGNAL_CACHE.put(MODEL_BASELINE_KEY, JSON.stringify({ promotion: { status: "promoted" } }));
  await runCfcTriggers(env, { now: NOW });
  assert.equal(JSON.parse(await env.SIGNAL_CACHE.get(MODEL_GATE_KEY)).status, "promoted");
  await env.SIGNAL_CACHE.put(MODEL_BASELINE_KEY, JSON.stringify({ promotion: { status: "not_promoted" } }));
  const r = await runCfcTriggers(env, { now: NOW + 3_600_000 });
  assert.ok(r.created.includes("engine:model"), JSON.stringify(r));
});

test("the suggestions' queries search their indexes", () => {
  const db = database();
  for (const sql of CFC_SCHEMA_SQL) db.exec(sql);
  const plan = (sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(" | ");
  assert.match(plan(OPEN_KEYS_SQL, []), /USING (COVERING )?INDEX idx_cfc_suggestions_open/);
  assert.match(plan(RECENT_FINGERPRINTS_SQL, ["x"]), /USING (COVERING )?INDEX idx_cfc_suggestions_(created|fingerprint)/);
  assert.match(plan(CREATED_SINCE_SQL, ["x"]), /USING (COVERING )?INDEX idx_cfc_suggestions_created/);
  assert.match(plan(SUGGESTIONS_SQL, [5]), /SCAN cfc_suggestions USING INDEX idx_cfc_suggestions_created/);
  assert.ok(CFC_RULES.daily_cap === 3 && CFC_RULES.cooldown_days === 7 && CFC_RULES.strategy.last_n === 20 && CFC_RULES.strategy.stop_share === 0.65);
  assert.ok(SCORING_VERSION);
});
