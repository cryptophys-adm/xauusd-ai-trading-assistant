// The Knowledge Council's Nexus and Omega seats (owner 2026-11-11): the facts this Worker reports to
// Aether every hour, read from the running code, variables and stored Omega settings.
import test from "node:test";
import { resetLensStateMemoForTests } from "../src/lens-policy.mjs";
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
  assert.deepEqual(n["decision.guardrails"], ["market_open", "fresh", "quorum", "no_veto", "levels", "reward", "room", "confidence"]);
  // Owner 2026-11-11: the confirmation candle is the trigger of a market order, not a gate of the decision.
  assert.equal(n["decision.confirmation_required"], false);
  // 2026-11-12: the broker's 5m confirmation times market orders while OMEGA_EXEC_5M is on (the default).
  assert.equal(n["decision.execution_trigger"], "prophet_candle_for_market_orders_broker_5m");
  assert.deepEqual([n["calendar.blackout_before_min"], n["calendar.blackout_after_min"], n["parity.approval_candles"], n["weighting.mode"]], [120, 30, 24, "auto"]);
  // The Positioning & Liquidity analyst (docs/RFC_POSITIONING_LIQUIDITY.md §10): both lenses in the Nexus seat. Aether's
  // validator (cryptophys-aether src/doctrine.mjs validateFacts: seatOf is "omega" for omega.* and "nexus" for anything
  // else) refuses the whole report when a fact sits in the other seat, and a report over 16384 bytes (2026-11-20: #505
  // put liquidity.* in the Omega seat and every facts push was refused).
  const seatOf = (k) => (k.startsWith("omega.") ? "omega" : "nexus");
  assert.deepEqual(Object.keys(n).filter((k) => seatOf(k) !== "nexus"), [], "the Nexus seat holds no omega.* fact");
  assert.deepEqual(Object.keys(o).filter((k) => seatOf(k) !== "omega"), [], "the Omega seat holds omega.* facts only");
  assert.ok(Object.keys(n).every((k) => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(k)), "every fact name passes Aether's pattern");
  assert.ok(JSON.stringify(f).length <= 16_384, `the report fits Aether's limit (${JSON.stringify(f).length} bytes)`);
  assert.equal(n["positioning.de_weight_swing"], 0.05);
  assert.equal(n["liquidity.council_weight_scalp"], 0.4);
  assert.ok(Object.keys(n).filter((k) => k.startsWith("liquidity.")).length >= 34 && Object.keys(n).filter((k) => k.startsWith("positioning.")).length >= 14);
  assert.deepEqual([o["omega.risk_pct"], o["omega.max_spread_points"], o["omega.max_signal_age_min"], o["omega.rollover_quarantine_utc"]], [0.5, 60, 10, "21:55-23:15"]);
  // The quarantine fact follows US daylight time (owner 2026-11-28): the summer window in UTC.
  assert.equal((await doctrineFacts({}, { now: Date.parse("2026-07-14T03:00:00Z") })).seats.omega.facts["omega.rollover_quarantine_utc"], "20:55-22:15");
  assert.doesNotMatch(JSON.stringify(f), /entry|stop_loss|take_profit|login|password|account/i);
  const scalp = await doctrineFacts({ TRADING_MODE: "scalp", WEIGHTING_MODE: "default", BLACKOUT_MINUTES: "60" });
  assert.deepEqual([scalp.seats.nexus.facts["decision.quorum_min"], scalp.seats.nexus.facts["decision.min_rrr"], scalp.seats.nexus.facts["weighting.mode"], scalp.seats.nexus.facts["calendar.blackout_before_min"]], [0.45, 0, "default", 60], "scalp: the nearest key level, no reward minimum (owner 2026-11-12)");
  assert.equal((await doctrineFacts({ DECISION_ENGINE: "off" })).seats.nexus.facts["decision.engine_enabled"], false);
  assert.equal((await doctrineFacts({ OMEGA_EXEC_5M: "off" })).seats.nexus.facts["decision.execution_trigger"], "prophet_candle_for_market_orders", "the switch off: TradingView's 5m or 15m confirmation");
  assert.ok(guardrailIds({}).includes("quorum"));
});

test("a lens switched off reports its switch, and its weight stays inside the doctrine's bound", async () => {
  const db = { prepare: (sql) => ({ bind: () => ({ first: async () => null, run: async () => ({}) }), run: async () => ({}), first: async () => (/omega_settings/.test(sql) ? { settings: JSON.stringify({ positioning_enabled: false, liquidity_enabled: false }), version: 3 } : null) }) };
  resetLensStateMemoForTests();
  const n = (await doctrineFacts({ DB: db })).seats.nexus.facts;
  resetLensStateMemoForTests();
  assert.deepEqual([n["positioning.enabled"], n["liquidity.enabled"]], [false, false]);
  assert.deepEqual([n["positioning.de_weight_swing"], n["liquidity.council_weight_scalp"]], [0.05, 0.4], "the knob, not the switch's 0");
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
  // Since 2026-11-12 the scalp target is the nearest key level, with no reward minimum ("Tanpa batas RRR").
  assert.deepEqual(modeThresholds("SCALP"), { mode: "scalp", quorum_min: 0.45, min_rrr: 0, lean: 0.1, target: "nearest" });
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

test("ADR-0020 Amendment 10: the limits per profile under the settings in force, the account's profile and its limits in force", async () => {
  const accounts = [
    { account_ref: "acct_aaaaaaaaaaaaaaaa", profile: "conservative", ceiling: "aggressive", last_seen_ms: 5, created_ms: 1 },
    { account_ref: "acct_bbbbbbbbbbbbbbbb", profile: "custom", ceiling: "custom", last_seen_ms: 9, created_ms: 2 }
  ];
  const settings = { risk_pct: 3, max_positions: 2, max_daily_loss_pct: 6 };
  const dbWith = (state) => ({
    prepare: (sql) => ({
      bind: () => ({ first: async () => null, run: async () => ({}) }),
      run: async () => ({}),
      all: async () => ({ results: /FROM omega_accounts/.test(sql) ? accounts : [] }),
      first: async () => (/omega_settings/.test(sql) ? { settings: JSON.stringify(settings), version: 4 } : /FROM omega_bridge/.test(sql) ? { state: state ? JSON.stringify(state) : null } : null)
    })
  });
  const o = (await doctrineFacts({ DB: dbWith({ server: "x", account_ref: "acct_aaaaaaaaaaaaaaaa", connected: true }) })).seats.omega.facts;
  assert.deepEqual(["safe", "conservative", "aggressive", "custom"].map((p) => [o[`omega.risk_pct_${p}`], o[`omega.max_daily_loss_pct_${p}`], o[`omega.max_positions_${p}`]]),
    [[1, 3, 1], [2, 6, 2], [3, 6, 2], [3, 6, 2]], "each profile: the smaller of its cap and the setting");
  assert.deepEqual([o["omega.profile"], o["omega.effective_risk_pct"], o["omega.effective_max_daily_loss_pct"], o["omega.effective_max_positions"]], ["conservative", 2, 6, 2], "the connected account");
  assert.deepEqual([o["omega.risk_pct"], o["omega.max_daily_loss_pct"], o["omega.max_positions"]], [3, 6, 2], "the single facts stay, as information");
  const idle = (await doctrineFacts({ DB: dbWith(null) })).seats.omega.facts;
  assert.equal(idle["omega.profile"], "custom", "no bridge state: the account seen last");
  assert.doesNotMatch(JSON.stringify(idle), /acct_/, "never the account reference");
  const none = (await doctrineFacts({})).seats.omega.facts;
  assert.equal(none["omega.profile"], undefined, "no account seen: no profile fact");
  assert.equal(none["omega.risk_pct_safe"], 0.5, "the per-profile facts stand on the defaults");
});
