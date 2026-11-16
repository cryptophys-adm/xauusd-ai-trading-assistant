// Call for Councils P1 (docs/RFC_CALL_FOR_COUNCILS.md §1.0, §3): the topic grammar and the evidence pack of every
// topic type, built over node:sqlite with the schema production runs (schema.sql, every migration, the run-time
// schemas). No pack holds a price field; every ref is a council.v1 ref; the same evidence hashes the same.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTopicKey, topicCatalog, buildEvidencePack, canonicalJson, finalizePack, priceKeysIn, stripPrices, evRef, REF_RE, PRICE_FIELDS,
  TOPIC_TYPES, SEAT_IDS, patternsOf, tally, exitsOf, tradeOf, lossRuns, omegaExit, ledgerExit, TRADES_SQL, quantiles
} from "../src/cfc-pack.mjs";
import { AGENT_IDS, STRATEGY_AGENTS } from "../src/strategy-agents.mjs";
import { PLAN_LEARNING_KEY } from "../src/plan-learning.mjs";
import { SCORING_VERSION } from "../src/outcome-scoring.mjs";
import { NOW, M15, database, seedEnv, seedTrades } from "./support/cfc-fixtures.mjs";

test("the topic grammar accepts every agent, every pattern it trades, every type; it refuses anything else", () => {
  for (const a of STRATEGY_AGENTS) {
    for (const key of [`strategy:${a.id}`, `strategy:${a.id}:exits`, `strategy:${a.id}@intraday|normal-trending`, `strategy:${a.id}:exits@none|unknown`]) assert.equal(parseTopicKey(key).ok, true, key);
    for (const p of patternsOf(a.id)) assert.deepEqual(parseTopicKey(`strategy:${a.id}:${p}`).pattern, p);
  }
  assert.ok(patternsOf("pattern_peaks").length > 0 && patternsOf("pattern_inside").length > 0, "the pattern families and inside the pattern trade patterns");
  assert.deepEqual(patternsOf("zone_pullback"), []);
  const t = parseTopicKey("strategy:zone_pullback:exits");
  assert.deepEqual([t.type, t.agent, t.focus, t.pattern], ["strategy", "zone_pullback", "exits", null]);
  for (const key of ["seat:risk", "seat:risk@15", "seat:moderator@1D", "engine:15", "engine:model", "risk:london", "risk:scalp", "risk:high-ranging", "news:release_horizon", "news:drift", "execution:rejected_intents", "data:parity", "data:prophet_r38", "cost:shadow", "cost:shadow:metric_opening", "knowledge:note-1.v2", "free:sl-plus-review"]) assert.equal(parseTopicKey(key).ok, true, key);
  assert.equal(parseTopicKey("risk:london").dimension, "session");
  assert.equal(parseTopicKey("risk:normal-trending").dimension, "regime");
  for (const bad of [undefined, null, 42, "", "strategy", "strategy:", "nope:x", "strategy:unknown_agent", "strategy:zone_pullback:double_top", "strategy:pattern_peaks:not_a_pattern",
    "strategy:zone_pullback@intraday", "strategy:zone_pullback@intraday|sideways", "strategy:zone_pullback:exits:more", "strategy:a@b@c", "seat:system", "seat:nobody", "seat:risk@5",
    "engine:60", "risk:weekend", "news:other", "execution:orders", "data:anything", "cost:UPPER", "cost:has space", "knowledge:", "free:Has_Caps", "free:x y",
    "strategy:zone_pullback\n", "x".repeat(121), "seat:risk@15'; DROP TABLE x"]) assert.equal(parseTopicKey(bad).ok, false, String(bad));
  assert.ok(!SEAT_IDS.includes("system") && SEAT_IDS.includes("risk") && SEAT_IDS.includes("moderator"));
});

test("the catalogue offers a valid key for every agent, pattern and type", () => {
  const cat = topicCatalog();
  assert.deepEqual(Object.keys(cat).sort(), [...TOPIC_TYPES].sort());
  for (const keys of Object.values(cat).map((c) => c.keys)) for (const k of keys) assert.equal(parseTopicKey(k).ok, true, k);
  for (const id of AGENT_IDS) assert.ok(cat.strategy.keys.includes(`strategy:${id}`) && cat.strategy.keys.includes(`strategy:${id}:exits`), id);
  for (const c of cat.strategy.contexts) assert.equal(parseTopicKey(`strategy:zone_pullback@${c}`).ok, true, c);
});

test("canonical JSON sorts keys; the sha256 is deterministic and changes with the evidence", async () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], e: undefined, f: NaN }), '{"a":[{"c":null,"d":2}],"b":1,"f":null}');
  const a = await finalizePack({ topic: "free:x", type: "free", as_of: "2026-11-16T12:00:00.000Z", sections: { z: 1, a: { y: 2, x: 3 } }, refs: ["ev:xauusd/a/b", "ev:xauusd/a/b", "not a ref"] });
  const b = await finalizePack({ topic: "free:x", type: "free", as_of: "2026-11-16T12:00:00.000Z", sections: { a: { x: 3, y: 2 }, z: 1 }, refs: ["ev:xauusd/a/b"] });
  assert.equal(a.sha256, b.sha256);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(a.refs, ["ev:xauusd/a/b"], "refs are unique and valid");
  const c = await finalizePack({ topic: "free:x", type: "free", as_of: "2026-11-16T12:00:00.000Z", sections: { a: { x: 4, y: 2 }, z: 1 }, refs: [] });
  assert.notEqual(a.sha256, c.sha256);
});

test("prices are dropped at any depth and never become a ref", () => {
  assert.deepEqual(stripPrices({ entry: 1, keep: { stop: 2, tp1: 3, r: 1.5, rows: [{ price: 4, n: 1 }] } }), { keep: { r: 1.5, rows: [{ n: 1 }] } });
  assert.deepEqual(priceKeysIn({ a: [{ levels: [] }] }), [".a[0].levels"]);
  for (const f of PRICE_FIELDS) assert.equal(evRef("signal_ledger", "x", { field: f }), null, f);
  assert.match(evRef("outcome_summary", "engine:15/30d", { asOf: "2026-11-16T12:00Z", field: "hit_rate" }), REF_RE);
  assert.equal(evRef("outcome_summary", "engine:15/30d", { asOf: "2026-11-16T12:00Z", field: "hit_rate" }), "ev:xauusd/outcome_summary/engine:15/30d@2026-11-16T12:00Z#hit_rate");
  assert.match(evRef("a", "id with @ and # and space"), REF_RE);
});

test("exits keep both SL+ definitions apart; the stop share counts the stop and SL+", () => {
  const rows = [["stop", 0, "sl_plus"], ["stop", 1, "stop"], ["target", 0, "trailed_target"], ["time", 0, "time"]].map(([exit, plus, omega], i) => tradeOf({ id: `decision:k${i}`, candle_key: `OANDA:XAUUSD:15:${NOW + i * M15}`, opened_at: new Date(NOW).toISOString(), side: "BUY", status: "closed", exit_reason: exit, sl_plus_triggered: plus, r_tp1: exit === "target" ? 2 : -1, omega_status: "closed", omega_exit: omega, r_omega: omega === "trailed_target" ? 1.5 : -0.5, agent: null, strategy: null }));
  assert.equal(rows[0].agent, "zone_pullback", "a decision without an agent is the default agent's");
  assert.deepEqual(rows.map((t) => t.plan.exit), ["stop", "sl_plus", "target", "time"], "the ledger's SL+ is its breakeven stop");
  const e = exitsOf(rows);
  assert.equal(e.omega.stop_share, 0.5);
  assert.equal(e.ledger.stop_share, 0.5);
  assert.deepEqual(e.omega.exits.map((x) => x.exit).sort(), ["sl_plus", "stop", "time", "trailed_target"]);
  assert.equal(tally([]).stop_share, null);
  assert.deepEqual(lossRuns(rows, omegaExit), { n: 4, longest_losing_run: 2, max_drawdown_r: 1, current_losing_run: 1 });
  assert.equal(lossRuns(rows, ledgerExit).longest_losing_run, 2);
  assert.deepEqual(quantiles([3, 1, 2]), { n: 3, p10: 1, p25: 1, p50: 2, p75: 3, p90: 3, mean: 2 });
});

const assertPack = (pack, topic, type) => {
  assert.equal(pack.schema, "council_pack.v1");
  assert.equal(pack.topic, topic);
  assert.equal(pack.type, type);
  assert.equal(pack.as_of, new Date(NOW).toISOString());
  assert.match(pack.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(priceKeysIn(pack), [], `${topic}: no price field`);
  for (const r of pack.refs) assert.match(r, REF_RE, r);
  assert.ok(pack.sections.prior?.unavailable, "prior says why it is empty");
  const text = JSON.stringify(pack);
  for (const p of ["4001.25", "3995.5", "4012.75", "4010.37", "3990.11", "4020.33"]) assert.ok(!text.includes(p), `${topic}: price ${p} leaked`);
  assert.ok(!/@cf\//.test(text), `${topic}: no model identifier`);
};

test("strategy pack: zone_pullback and ENTER_LIMIT apart, SL+ in both definitions, no price, refs, a deterministic sha", async () => {
  const env = await seedEnv();
  await seedTrades(env, { agent: "zone_pullback", n: 24, exits: [["stop", "sl_plus"], ["sl_plus", "stop"], ["target", "trailed_target"]], action: "ENTER_LIMIT" });
  await seedTrades(env, { agent: "zone_pullback", n: 6, exits: [["target", "target"]], action: "ENTER_MARKET", tag: "m" });
  await seedTrades(env, { agent: "sweep_reversal", n: 5, exits: [["stop", "stop"]], action: "ENTER_MARKET" });
  await env.SIGNAL_CACHE.put(PLAN_LEARNING_KEY, JSON.stringify({ generated_at: new Date(NOW).toISOString(), agents: [{ agent: "zone_pullback", setups: 40, mean_r: 0.1, contexts: [{ context: "intraday|normal-trending", setups: 22, mean_r: -0.1 }] }], walk_forward: { verdict: "collecting", independent: 12 } }));
  const db = env.DB.db;
  db.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, opened_at, decided_at, last_seen_at, side, entry, stop, tp1, atr_h1, mode, regime, context, status, results_json, version, updated_at) VALUES ('s1', 'k', 'zone_pullback', ?, ?, ?, 'BUY', 4001.25, 3995.5, 4012.75, 6.5, 'intraday', 'normal-trending', 'intraday|normal-trending', 'resolved', ?, 'v', ?)")
    .run(new Date(NOW - 86_400_000).toISOString(), new Date(NOW - 86_400_000).toISOString(), new Date(NOW - 86_400_000).toISOString(), JSON.stringify({ "e0@s1": { s: "stop", r: -1, f: 1 }, "e0.1@s0.8": { s: "target", r: 2, f: 1 } }), new Date(NOW).toISOString());
  const pack = await buildEvidencePack(env, "strategy:zone_pullback", { now: NOW });
  assertPack(pack, "strategy:zone_pullback", "strategy");
  const s = pack.sections;
  assert.deepEqual(Object.keys(s).sort(), ["calendar", "entry_actions", "excursions", "executions", "exits", "held", "invalidation", "prior", "record", "scope", "scores", "setups", "trades"].sort());
  assert.equal(s.trades.n, 30, "only zone_pullback's trades");
  assert.equal(s.exits.headline, "omega");
  assert.ok(s.exits.omega.exits.some((x) => x.exit === "sl_plus") && s.exits.ledger.exits.some((x) => x.exit === "sl_plus"), "SL+ in both definitions");
  assert.equal(s.entry_actions.this_topic.ENTER_LIMIT.omega.n, 24);
  assert.equal(s.entry_actions.this_topic.ENTER_MARKET.omega.n, 6);
  assert.equal(s.entry_actions.all_agents.ENTER_MARKET.omega.n, 11, "the limit entry is reported apart, for every agent too");
  assert.equal(s.invalidation.stopped.p50, 0.885, "the stop distance in ATR, not in price");
  assert.equal(s.setups.arms.length, 20);
  assert.equal(s.record.record.agent, "zone_pullback");
  assert.equal(s.record.walk_forward.verdict, "collecting");
  assert.ok(pack.refs.some((r) => r.startsWith("ev:xauusd/signal_ledger/decision:OANDA:XAUUSD:15:")), "the trades are refs");
  assert.ok(pack.refs.some((r) => r.startsWith("ev:xauusd/plan_learning/state@")));
  const again = await buildEvidencePack(env, "strategy:zone_pullback", { now: NOW });
  assert.equal(again.sha256, pack.sha256, "the same evidence at the same as_of hashes the same");
  const later = await buildEvidencePack(env, "strategy:zone_pullback", { now: NOW + 60_000 });
  assert.notEqual(later.sha256, pack.sha256);
});

test("strategy packs work for every agent and every pattern, with a context filter", async () => {
  const env = await seedEnv();
  const pats = patternsOf("pattern_peaks");
  await seedTrades(env, { agent: "pattern_peaks", pattern: pats[0], n: 4, exits: [["stop", "stop"]] });
  await seedTrades(env, { agent: "pattern_peaks", pattern: pats[1], n: 3, exits: [["target", "target"]], tag: "b" });
  for (const id of AGENT_IDS) {
    const pack = await buildEvidencePack(env, `strategy:${id}`, { now: NOW });
    assertPack(pack, `strategy:${id}`, "strategy");
    assert.equal(pack.sections.scope.agent, id);
  }
  const fam = await buildEvidencePack(env, "strategy:pattern_peaks", { now: NOW });
  assert.equal(fam.sections.trades.n, 7);
  assert.deepEqual(fam.sections.exits.by_pattern.map((x) => x.value).sort(), [pats[0], pats[1]].sort());
  const one = await buildEvidencePack(env, `strategy:pattern_peaks:${pats[0]}`, { now: NOW });
  assert.equal(one.sections.trades.n, 4);
  assert.equal(one.sections.exits.omega.stop_share, 1);
  const ctx = await buildEvidencePack(env, "strategy:pattern_peaks@swing|normal-trending", { now: NOW });
  assert.equal(ctx.sections.trades.n, 0, "the context filter");
  assert.ok(ctx.sections.scores.unavailable);
});

test("every other type builds a pack from the tables that exist, says unavailable otherwise, and holds no price", async () => {
  const env = await seedEnv();
  await seedTrades(env, { agent: "zone_pullback", n: 8, exits: [["stop", "stop"], ["target", "target"]] });
  const db = env.DB.db;
  db.prepare("INSERT INTO scorecard_snapshots (days, scoring_version, computed_at, body) VALUES (30, ?, ?, ?)").run(SCORING_VERSION, new Date(NOW).toISOString(),
    JSON.stringify([{ subject: "agent:risk", source: "room", timeframe: "15", n: 80, directional: { n: 60, hit: 10, miss: 50, neutral: 0, hit_rate: 0.167 }, wait: { n: 20, hit: 2, missed_opportunity: 10, accuracy: 0.1 }, brier: 0.3, by_session: {} }, { subject: "engine:15", source: "engine", timeframe: "15", n: 90, directional: { n: 60, hit: 36, miss: 24, hit_rate: 0.6 }, wait: { n: 30 }, brier: 0.2, by_session: {} }]));
  db.prepare("INSERT INTO econ_releases (release_key, series, kind, title, currency, time, importance, actual, forecast, previous, fetched_at, updated_at) VALUES ('USD:x:nfp', 'nfp', 'nfp', 'Non-Farm Payrolls', 'USD', ?, 1, 250, 180, 150, ?, ?)").run(new Date(NOW - 10 * 86_400_000 + 30 * 60_000).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString());
  db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'agent:cerebrum', 'autonomous_recovery', ?)").run(NOW - 3600_000, JSON.stringify({ price: 4001.25 }));
  db.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES ('i1', 'open', ?, 'failed', ?, ?, ?)").run(JSON.stringify({ entry: 4001.25 }), JSON.stringify({ ok: false, error: "invalid stops at 3995.5" }), NOW - 3600_000, NOW);
  db.prepare("INSERT INTO stuck_states (field, value, first_candle_key, last_candle_key, candles, price_range, atr, status, detected_at, updated_at) VALUES ('prophet_r38.d_enc', '-1', 'a', 'b', 30, 13, 6.5, 'open', ?, ?)").run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
  db.prepare("INSERT INTO ai_usage_daily (day, source, model, calls, prompt_tokens, completion_tokens) VALUES ('2026-11-15', 'warroom_agent', '@cf/openai/gpt-oss-120b', 10, 60000, 6000)").run();
  const keys = ["seat:risk@15", "seat:moderator", "engine:15", "engine:model", "risk:london", "risk:intraday", "news:release_horizon", "news:drift", "execution:recoveries", "execution:rejected_intents", "data:prophet_r38", "data:parity", "cost:warroom_agent", "cost:shadow", "knowledge:note-1", "free:sl-plus-review"];
  const packs = {};
  for (const key of keys) {
    const pack = await buildEvidencePack(env, key, { now: NOW });
    assertPack(pack, key, key.split(":")[0]);
    packs[key] = pack;
  }
  assert.equal(packs["seat:risk@15"].sections.reputation["30d"].charts[0].reputation.weight, 0.415);
  assert.ok(packs["seat:risk@15"].sections.reputation["7d"].unavailable, "no 7-day snapshot: said, not invented");
  assert.ok(packs["seat:risk@15"].sections.room_runs.unavailable);
  assert.equal(packs["engine:15"].sections.decisions.n, 8);
  assert.equal(packs["engine:15"].sections.scores["30d"].directional.hit_rate, 0.6);
  assert.ok(packs["engine:model"].sections.baseline.unavailable);
  assert.equal(packs["risk:intraday"].sections.trades.n, 8);
  assert.ok(packs["risk:intraday"].sections.loss_runs.omega.n === 8);
  assert.equal(packs["news:release_horizon"].sections.releases.n, 1);
  assert.ok(packs["news:release_horizon"].sections.losing_trades_near_releases.inside_a_release_window >= 1, "a losing trade lived through the release");
  assert.ok(packs["news:drift"].sections.drift_alerts.unavailable);
  assert.equal(packs["execution:recoveries"].sections.omega_events.recoveries.length, 1);
  assert.deepEqual(packs["execution:rejected_intents"].sections.intents.failed_errors, [{ error: "invalid stops at #", n: 1 }], "numbers are taken out of the terminal's text");
  assert.equal(packs["data:prophet_r38"].sections.stuck_states.rows[0].range_atr, 2, "the stuck range in ATR, not in price");
  assert.equal(packs["cost:warroom_agent"].sections.usage.this_source.length, 1);
  assert.ok(!JSON.stringify(packs["cost:warroom_agent"]).includes("gpt-oss"), "the model is used for the rate only");
  assert.ok(packs["knowledge:note-1"].sections.item.unavailable);
  assert.ok(packs["free:sl-plus-review"].sections.sections.unavailable);
});

test("an invalid topic is refused before any read", async () => {
  const touched = [];
  const env = { DB: { prepare(sql) { touched.push(sql); throw new Error("no read expected"); } } };
  assert.match((await buildEvidencePack(env, "strategy:nobody")).error, /unknown strategy agent/);
  assert.deepEqual(touched, []);
});

test("the trades query searches the ledger's opened_at index and the decision's primary key", () => {
  const db = database();
  db.exec("ALTER TABLE signal_ledger ADD COLUMN sl_plus_triggered INTEGER NOT NULL DEFAULT 0");
  for (const col of ["trading_mode TEXT", "entry_action TEXT", "omega_status TEXT", "omega_closed_at TEXT", "omega_exit TEXT", "r_omega REAL", "omega_json TEXT"]) { try { db.exec(`ALTER TABLE signal_ledger ADD COLUMN ${col}`); } catch { /* there */ } }
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${TRADES_SQL}`).all("2026-01-01", 10).map((r) => r.detail).join(" | ");
  assert.match(plan, /SEARCH l USING INDEX idx_signal_ledger_opened/, plan);
  assert.match(plan, /SEARCH e USING INDEX sqlite_autoindex_engine_decisions_1/, plan);
});
