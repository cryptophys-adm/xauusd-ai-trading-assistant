// Strategy recommendation cards (RFC §3; owner 2026-11-17 "Ya, semua, live"): deterministic, read-only, no price.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recommendationOf, buildCards, exitsOf, rBucket, computeRecommendations, readRecommendations, RECO_KEY } from "../src/strategy-recommendation.mjs";
import { AGENT_IDS } from "../src/strategy-agents.mjs";

const card = (over = {}) => ({ id: "sweep_reversal", as_of: "2026-11-17T11:00Z", context: "scalp|low-ranging", record: { setups: 40, mean_r: 0.2 }, context_record: { setups: 10, mean_r: -0.3 }, exits: { n: 25, stop_or_locked_share: 0.4 }, breaker: { suspended: false }, ...over });

test("RC1. the verdict: not recommended on any bad rule, recommended only past every bar, neutral otherwise (collecting under 15)", () => {
  assert.equal(recommendationOf(card()).verdict, "recommended", "a context under 15 setups does not count");
  assert.equal(recommendationOf(card({ breaker: { suspended: true } })).reason, "breaker_suspended");
  assert.equal(recommendationOf(card({ record: { setups: 15, mean_r: -0.01 } })).reason, "record_negative");
  assert.equal(recommendationOf(card({ record: { setups: 14, mean_r: -0.5 } })).reason, "collecting", "below 15 a negative record is not judged");
  assert.equal(recommendationOf(card({ context_record: { setups: 15, mean_r: -0.1 } })).reason, "context_negative");
  assert.equal(recommendationOf(card({ exits: { n: 20, stop_or_locked_share: 0.65 } })).reason, "omega_stop_share");
  assert.equal(recommendationOf(card({ exits: { n: 19, stop_or_locked_share: 0.9 } })).verdict, "recommended", "under 20 Omega trades the stop share is not judged");
  assert.deepEqual([recommendationOf(card({ exits: { n: 20, stop_or_locked_share: 0.55 } })).verdict, recommendationOf(card({ exits: { n: 20, stop_or_locked_share: 0.55 } })).reason], ["neutral", "below_recommend_bar"], "0.50..0.65: neither");
  assert.equal(recommendationOf(card({ record: { setups: 29, mean_r: 0.5 } })).verdict, "neutral", "30 setups to recommend");
  assert.equal(recommendationOf(card({ record: { setups: 40, mean_r: 0.09 } })).verdict, "neutral", "+0.10 R to recommend");
  const r = recommendationOf(card());
  assert.ok(r.rules.every((x) => typeof x.ref === "string" && x.ref.startsWith("ev:xauusd/")), "each rule has an evidence ref");
  assert.ok(r.rules.some((x) => x.ref === "ev:xauusd/plan_learning/agent:sweep_reversal@2026-11-17T11:00Z#mean_r"));
});

test("RC2. the cards: one per agent in catalog order, Omega's exits from the last 20, no price field anywhere", () => {
  assert.deepEqual([rBucket(-1), rBucket(-0.2), rBucket(0), rBucket(1.5), rBucket(2), rBucket(null)], ["le_-1", "-1_0", "0_1", "1_2", "ge_2", null]);
  const rows = [...Array(25)].map((_, i) => ({ agent: "range_fade", omega_exit: i < 10 ? "stop" : i < 15 ? "sl_plus" : "target", sl_plus_triggered: i % 2 }));
  const ex = exitsOf([...rows, { agent: null, omega_exit: null, sl_plus_triggered: 1 }]);
  assert.deepEqual([ex.range_fade.n, ex.range_fade.stop_share, ex.range_fade.sl_plus_share, ex.range_fade.stop_or_locked_share, ex.range_fade.breakeven_share], [20, 0.5, 0.25, 0.75, 0.5]);
  assert.deepEqual([ex.zone_pullback.n, ex.zone_pullback.ledger_n], [0, 1], "an unattributed trade is the default agent's; without an Omega exit it counts only in the ledger");
  const records = [{ agent: "range_fade", setups: 40, mean_r: -0.2, contexts: [] }, { agent: "zone_pullback", setups: 50, mean_r: 0.3, contexts: [{ context: "scalp|low-ranging", setups: 20, mean_r: 0.1 }] }];
  const cards = buildCards({ records, context: "scalp|low-ranging", exits: ex, arms: { version: 3, armed: [{ id: "zone_pullback", armed_at: 1794907654442, armed_by: "owner@example.com" }] }, asOf: "2026-11-17T11:00Z" });
  assert.deepEqual(cards.map((c) => c.id), AGENT_IDS);
  const zp = cards.find((c) => c.id === "zone_pullback"), rf = cards.find((c) => c.id === "range_fade");
  assert.deepEqual([zp.recommendation.verdict, zp.arm.armed, zp.arm.version, zp.context_record.setups], ["recommended", true, 3, 20]);
  assert.equal(rf.recommendation.verdict, "not_recommended");
  assert.equal(rf.breaker.suspended, true, "a live agent with a negative record past 30 setups is held");
  assert.doesNotMatch(JSON.stringify(cards), /"(entry|stop|tp1|tp2|price|sl|tp|profit|volume)":/, "no price, money or volume field");
});

test("RC3. computed on the ledger step into KV at most every 15 minutes; read by the page without D1", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE plan_setups (setup_key TEXT PRIMARY KEY, agent TEXT, context TEXT, status TEXT, results_json TEXT, opened_at TEXT);
    CREATE TABLE signal_ledger (id TEXT, source TEXT, candle_key TEXT, status TEXT, omega_exit TEXT, sl_plus_triggered INTEGER, closed_at TEXT);
    CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, decision_json TEXT);
    CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created_ms INTEGER, updated_ms INTEGER);
    CREATE TABLE ea_deals (deal_ticket INTEGER, source TEXT, strategy TEXT, profit REAL, commission REAL, swap REAL);`);
  db.prepare("INSERT INTO plan_setups VALUES ('s1', 'zone_pullback', 'scalp|low-ranging', 'resolved', ?, '2026-11-17T10:00:00Z')").run(JSON.stringify({ e0_s1: { r: 1.4 }, "e0@s1": { r: 1.4 } }));
  db.prepare("INSERT INTO engine_decisions VALUES ('k1', ?)").run(JSON.stringify({ trade: { agent: "sweep_reversal" } }));
  db.prepare("INSERT INTO signal_ledger VALUES ('decision:k1', 'decision', 'k1', 'closed', 'stop', 0, '2026-11-17T10:30:00Z')").run();
  db.prepare("INSERT INTO omega_intents VALUES ('open:1:B', 'open', ?, 'done', '{}', 1, 1)").run(JSON.stringify({ strategy: "sweep_reversal" }));
  db.prepare("INSERT INTO ea_deals VALUES (1, 'omega', 'sweep_reversal', 12, -1, 0), (1, 'omega', 'sweep_reversal', 12, -1, 0), (2, 'omega', 'sweep_reversal', -5, -1, 0)").run();
  const wrap = (sql) => { let a = []; const s = { bind: (...x) => { a = x; return s; }, run: async () => db.prepare(sql).run(...a), first: async () => db.prepare(sql).get(...a) ?? null, all: async () => ({ results: db.prepare(sql).all(...a) }) }; return s; };
  const kv = new Map([["plan-learning:state:v1", JSON.stringify({ agents: [{ agent: "zone_pullback", setups: 1, mean_r: 1.4, contexts: [{ context: "scalp|low-ranging", setups: 1, mean_r: 1.4 }] }] })]]);
  const env = { DB: { prepare: wrap }, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
  const t0 = Date.parse("2026-11-17T11:00:00Z");
  const r = await computeRecommendations(env, { now: t0 });
  assert.equal(r.status, "computed");
  assert.equal((await computeRecommendations(env, { now: t0 + 5 * 60_000 })).status, "waiting");
  const doc = await readRecommendations(env);
  assert.ok(kv.has(RECO_KEY));
  assert.equal(doc.context, "scalp|low-ranging");
  const sr = doc.cards.find((c) => c.id === "sweep_reversal");
  assert.deepEqual([sr.exits.n, sr.exits.stop_share, sr.executed.opened, sr.executed.closed, sr.executed.win_share], [1, 1, 1, 2, 0.5], "a deal counted once per ticket");
  assert.equal(doc.cards.find((c) => c.id === "zone_pullback").recommendation.reason, "collecting");
});
