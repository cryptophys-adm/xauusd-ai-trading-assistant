// The Knowledge Council's Nexus and Omega seats (owner 2026-11-11): the facts this Worker reports to
// Aether every hour, read from the running code, variables and stored Omega settings.
import test from "node:test";
import assert from "node:assert/strict";
import { doctrineFacts, guardrailIds, pushDoctrineFacts, DOCTRINE_FACTS_SCHEMA } from "../src/doctrine-facts.mjs";
import { decide, modeThresholds, tradeFor, MIN_RRR } from "../src/decision-engine.mjs";

test("the facts report: both seats, the Decision Engine's thresholds per trading mode, no price and no account", async () => {
  const f = await doctrineFacts({ GLOBAL_DECISION_WEIGHTED: "true", CF_VERSION_METADATA: { id: "ver-123" } }, { now: Date.parse("2026-11-11T03:00:00Z") });
  assert.equal(f.schema, DOCTRINE_FACTS_SCHEMA);
  assert.equal(f.seats.nexus.version_id, "ver-123");
  const n = f.seats.nexus.facts, o = f.seats.omega.facts;
  assert.equal(n["decision.engine_enabled"], true);
  assert.equal(n["decision.trading_mode"], "intraday");
  assert.deepEqual([n["decision.quorum_min"], n["decision.lean"], n["decision.min_rrr"], n["decision.min_confidence"]], [0.5, 0.15, 1.5, 0.4]);
  assert.ok(Math.abs(Object.values(n["decision.witness_weights"]).reduce((s, w) => s + w, 0) - 1) < 1e-9);
  assert.deepEqual(n["decision.guardrails"], ["market_open", "fresh", "quorum", "no_veto", "levels", "reward", "confidence"]);
  // Owner 2026-11-11: the confirmation candle is the trigger of a market order, not a gate of the decision.
  assert.equal(n["decision.confirmation_required"], false);
  // 2026-11-12: the broker's 5m confirmation times market orders while OMEGA_EXEC_5M is on (the default).
  assert.equal(n["decision.execution_trigger"], "prophet_candle_for_market_orders_broker_5m");
  assert.deepEqual([n["calendar.blackout_before_min"], n["calendar.blackout_after_min"], n["parity.approval_candles"], n["weighting.mode"]], [120, 30, 24, "auto"]);
  assert.ok(Object.keys(n).every((k) => !k.startsWith("omega.")) && Object.keys(o).every((k) => k.startsWith("omega.")), "each fact in its own seat");
  assert.deepEqual([o["omega.risk_pct"], o["omega.max_spread_points"], o["omega.max_signal_age_min"], o["omega.rollover_quarantine_utc"]], [0.5, 60, 10, "21:55-22:15"]);
  assert.doesNotMatch(JSON.stringify(f), /entry|stop_loss|take_profit|login|password|account/i);
  const scalp = await doctrineFacts({ TRADING_MODE: "scalp", WEIGHTING_MODE: "default", BLACKOUT_MINUTES: "60" });
  assert.deepEqual([scalp.seats.nexus.facts["decision.quorum_min"], scalp.seats.nexus.facts["decision.min_rrr"], scalp.seats.nexus.facts["weighting.mode"], scalp.seats.nexus.facts["calendar.blackout_before_min"]], [0.45, 1.2, "default", 60]);
  assert.equal((await doctrineFacts({ DECISION_ENGINE: "off" })).seats.nexus.facts["decision.engine_enabled"], false);
  assert.equal((await doctrineFacts({ OMEGA_EXEC_5M: "off" })).seats.nexus.facts["decision.execution_trigger"], "prophet_candle_for_market_orders", "the switch off: TradingView's 5m or 15m confirmation");
  assert.ok(guardrailIds({}).includes("quorum"));
});

test("the Omega seat reports the stored settings in force", async () => {
  const db = { prepare: (sql) => ({ bind: () => ({ first: async () => null, run: async () => ({}) }), run: async () => ({}), first: async () => (/omega_settings/.test(sql) ? { settings: JSON.stringify({ risk_pct: 1, max_spread_points: 80 }), version: 2 } : null) }) };
  const f = await doctrineFacts({ DB: db });
  assert.equal(f.seats.omega.facts["omega.risk_pct"], 1);
  assert.equal(f.seats.omega.facts["omega.max_spread_points"], 80);
});

test("the push: a no-op without the binding, never throws, reports the result", async () => {
  assert.equal((await pushDoctrineFacts({})).status, "disabled");
  let got = null;
  const ok = await pushDoctrineFacts({ AETHER: { ingestDoctrineFacts: async (f) => { got = f; return { accepted: true, seats: ["nexus", "omega"] }; } } });
  assert.equal(ok.status, "ok");
  assert.equal(got.schema, DOCTRINE_FACTS_SCHEMA);
  const failed = await pushDoctrineFacts({ AETHER: { ingestDoctrineFacts: async () => { throw new Error("schema must be x"); } } });
  assert.equal(failed.status, "failed");
});

test("audit fix: the trade honours its trading mode's reward threshold (scalp 1.2R was turned into WAIT by a fixed 1.5R)", () => {
  assert.deepEqual(modeThresholds("SCALP"), { mode: "scalp", quorum_min: 0.45, min_rrr: 1.2, lean: 0.1 });
  assert.equal(modeThresholds("unknown").mode, "intraday");
  const plan = { entry: 100, stop: 99, tp1: 101.3, tp2: 101.35, rrr: { tp1: 1.3, tp2: 1.35 }, at_level: false };
  assert.equal(tradeFor("BUY", plan), null, `the default stays ${MIN_RRR}R`);
  assert.equal(tradeFor("BUY", plan, { minRrr: 1.2 }).target, "tp1");
  const guards = { long: { allowed: true, checks: [], plan, min_rrr: 1.2 }, short: { allowed: false, checks: [], plan: null } };
  const d = decide({ answer: { stance: "BUY", bias: "BULLISH", confidence: 0.6, entry_type: "limit", target: "tp1" }, guards, quorum: { bias: "BULLISH" } });
  assert.equal(d.stance, "BUY", JSON.stringify(d.overruled));
  const intraday = decide({ answer: { stance: "BUY", bias: "BULLISH", confidence: 0.6, entry_type: "limit", target: "tp1" }, guards: { ...guards, long: { ...guards.long, min_rrr: 1.5 } }, quorum: { bias: "BULLISH" } });
  assert.equal(intraday.stance, "WAIT");
  assert.match(intraday.overruled.failed[0].detail, /1\.5R/);
});
