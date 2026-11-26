// Z2 (docs/RFC_DEMAND_SUPPLY_ZONES.md §5): the zone_ahead check of the Decision Engine's guardrails, its plan filter
// outside the consensus and the quorum, the record, the council, the doctrine facts, the public recap, rule_version and
// MS2's shadow replay. Switches: ZONE_PRIORITY ("on" in wrangler.jsonc since the live-capture replay of 2026-11-25; unset reads "off") and ZONE_AHEAD_MODE.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as pp from "../src/public-projection.mjs";
import * as pa from "../src/public-analysis.mjs";
import * as pl from "../src/plan-learning.mjs";
import { guardrailIds } from "../src/doctrine-facts.mjs";
import { ruleVersionOf } from "../src/mode-shadow.mjs";
import { withRoom } from "../src/room-tuning.mjs";
import { DEFAULT_AGENT } from "../src/strategy-agents.mjs";
import { ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { gunzipJson } from "../src/strategy-inputs.mjs";
import {
  zonePriorityMode, zoneAheadMode, zoneAheadFails, zonePlanPasses, zoneAheadCheck, zoneRuleToken, zoneAhead, ZONE_AHEAD_MODES, ZONE_AHEAD_RULE, ZONE_TREND_LEAN
} from "../src/zone-types.mjs";
import { zoneScenario, zoneInputs, ZONE_ENV, CLOSE, NOW } from "./support/zone-types-fixture.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";
import { CAPTURE_2026_11_20_22 } from "./fixtures/z2-capture-2026-11-20-22.mjs";

const mods = { se, de, ea, pp, pa, pl };
// Z2b (test/zone-aim.test.mjs) shares ZONE_PRIORITY: these tests pin Z2 alone, every Z2b rule left off.
const Z2B_OFF = "tp,stop,factor";
const ON = Object.freeze({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "trend" });
const M15 = 15 * 60_000;
const KEY = `OANDA:XAUUSD:15:${Date.parse(CLOSE) - M15}`;

// ---------------------------------------------------------------- fixtures
const ds = (type, strength = "medium") => ({ type, strength, score: 1, freshness: "fresh", touches: 0, sources: [] });
/** A long at 4000 at a strong demand zone (stop 7 below), with a supply zone 3.5 ahead (0.5R; need max(7, 7.5) = 1.07R). */
const unitZones = ({ supply = ds("supply"), low = 4003.5, high = 4005 } = {}) => [
  { low: 3980, high: 3982, price: 3981, candidate: true, label: "s2", ds: ds("demand") },
  { low: 3995, high: 3999, price: 3997, candidate: true, label: "s1", ds: ds("demand", "strong") },
  { low, high, price: (low + high) / 2, candidate: true, label: "r0", ...(supply ? { ds: supply } : {}) },
  { low: 4015, high: 4017, price: 4016, candidate: true, label: "r1", ds: ds("supply") },
  { low: 4030, high: 4032, price: 4031, candidate: true, label: "r2", ds: ds("none") }
];
const unitStrategy = (trend, zones = unitZones()) => ({ price: 4000, atr_h1: 10, trend, direction: "LONG", plan: { at_level: true }, setup: { type: "none" }, key_levels: { zones } });
const QUORUM = Object.freeze({ long_share: 0.8, short_share: 0.1, neutral_share: 0.1, score: 0.6, bias: "BULLISH" });
const guard = (strategy, env = {}, dir = 1) => de.guardrailsFor(dir, { cards: [], quorum: QUORUM, strategy, inputs: {}, now: NOW, env });
const check = (g) => g.checks.find((c) => c.id === "zone_ahead") ?? null;

/** The Z0 fixture's decision with bearish witnesses: the short's entry sits inside a strong demand zone, against the trend. */
const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
const bearLoaded = () => {
  const inputs = zoneInputs();
  return { inputs, strategy: se.buildStrategy(inputs), global: { timeframes: [row("D1", -0.5), row("H4", -0.45), row("H1", -0.4), row("M15", -0.35, "SELL"), row("NEWS", -0.2), row("MACRO", -0.1)] }, correlations: null, regime: "normal-trending" };
};
const SELL = Object.freeze({ answer: { stance: "SELL", bias: "BEARISH", confidence: 0.7, entry_type: "limit", target: "tp1", summary: "Decision SELL, bias bearish: the witnesses lean bearish.", reasons: ["The witnesses lean bearish."], risks: [], weighed: ["D1"] } });

/** An agent's plan: a long at 4000, stop 3990, targets 4020 and 4030, with an opposing zone record. */
const oa = (over = {}) => ({ o_type: "supply", o_strength: "medium", o_freshness: "fresh", o_rank: "candidate", room_atr: 0.5, room_r: 0.5, need_r: 1, trend_lean: 0, with_trend: false, would_block: true, ...over });
const agentPlan = (opposing, extra = {}) => ({ entry: 4000, stop: 3990, tp1: 4020, tp2: 4030, rrr: { tp1: 2, tp2: 3 }, risk: 10, at_level: true, entry_note: "e", stop_note: "s", tp1_note: "t1", tp2_note: "t2", ...(opposing ? { opposing_ahead: opposing } : {}), ...extra });

// ---------------------------------------------------------------- the switches

test("Z2-1 the switches: ZONE_PRIORITY (unset reads off), ZONE_AHEAD_MODE, untyped zones read off; wrangler.jsonc sets on and trend", () => {
  assert.equal(zonePriorityMode({}), "off");
  assert.equal(zonePriorityMode({ ZONE_PRIORITY: " On " }), "on");
  assert.deepEqual(ZONE_AHEAD_MODES, ["trend", "all", "record", "off"]);
  assert.equal(zoneAheadMode({}), "off");
  assert.equal(zoneAheadMode({ ZONE_PRIORITY: "on" }), "trend", "trend is the mode's default");
  for (const m of ZONE_AHEAD_MODES) assert.equal(zoneAheadMode({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: m.toUpperCase() }), m);
  assert.equal(zoneAheadMode({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "nonsense" }), "trend");
  assert.equal(zoneAheadMode({ ZONE_PRIORITY: "off", ZONE_AHEAD_MODE: "all" }), "off");
  // KEY_LEVEL_ZONE_TYPES off (env or the strategy's modes): untyped zones, so no Z rule acts.
  assert.equal(zoneAheadMode({ ...ON, KEY_LEVEL_ZONE_TYPES: "off" }), "off");
  assert.equal(zoneAheadMode(ON, { zoneTypes: "off" }), "off");
  assert.equal(ZONE_TREND_LEAN, se.STRATEGY_PARAMS.lean);
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(w, /"ZONE_PRIORITY": "on"/, "on after the live-capture replay (2026-11-25)");
  assert.match(w, /"ZONE_AHEAD_MODE": "trend"/);
});

// ---------------------------------------------------------------- the check

test("Z2-2 the check: supply 0.5R ahead of a long fails with a neutral or opposing trend and passes with the trend; 'all' fails it; 'record' adds no check but keeps would_block", () => {
  const neutral = guard(unitStrategy(0), ON);
  assert.deepEqual(neutral.checks.map((c) => c.id), ["market_open", "fresh", "quorum", "no_veto", "levels", "reward", "zone_ahead", "room"], "after reward");
  assert.deepEqual([neutral.plan.opposing_ahead.room_r, neutral.plan.opposing_ahead.need_r], [0.5, 1.07]);
  assert.deepEqual(check(neutral), { id: "zone_ahead", pass: false, detail: "the nearest medium fresh supply zone lies 0.35 ATR ahead of the long entry (0.5R), short of the 1.07R it needs, and the trend (lean 0) is not with the trade" });
  assert.equal(neutral.zone_ahead, "trend");
  assert.equal(check(guard(unitStrategy(-0.3), ON)).pass, false, "an opposing trend");
  assert.equal(check(guard(unitStrategy(0.14), ON)).pass, false, "a lean under 0.15 is no exemption");
  const withTrend = guard(unitStrategy(0.15), ON);
  assert.deepEqual(check(withTrend), { id: "zone_ahead", pass: true, detail: "the nearest medium fresh supply zone lies 0.35 ATR ahead of the long entry (0.5R), short of the 1.07R it needs, but the trend (lean +0.15) is with the trade: noted only" });
  assert.equal(withTrend.allowed, guard(unitStrategy(0.15)).allowed, "the side is as open as without Z2");
  // 'all' (owner-set only): no trend exemption.
  const all = guard(unitStrategy(0.3), { ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "all" });
  assert.equal(check(all).pass, false);
  assert.match(check(all).detail, /the owner's 'all' mode exempts no trend/);
  // 'record': no check; the plan keeps would_block (Z0's record).
  const record = guard(unitStrategy(0), { ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "record" });
  assert.equal(check(record), null);
  assert.equal(record.plan.opposing_ahead.would_block, true);
  assert.equal(record.zone_ahead, "record");
  // Room beyond need passes; no plan passes; no zone passes.
  assert.match(check(guard(unitStrategy(0, unitZones({ low: 4010, high: 4011 })), ON)).detail, /at least the 1\.07R it needs$/);
  assert.deepEqual(check(de.guardrailsFor(1, { cards: [], quorum: QUORUM, strategy: null, inputs: {}, now: NOW, env: ON })), { id: "zone_ahead", pass: true, detail: "no plan to check" });
  assert.deepEqual(zoneAheadCheck({ entry: 1, stop: 0, opposing_ahead: oa({ o_type: null, o_strength: null, o_freshness: null, o_rank: null, room_atr: null, room_r: null, would_block: false }) }, "trend", 1), { pass: true, detail: "no demand or supply zone against the trade within reach" });
});

test("Z2-3 off: ZONE_PRIORITY off, ZONE_AHEAD_MODE off and untyped zones give checks that deep-equal TP1-KZ's (no Z2 key on the side)", () => {
  for (const t of [0, 0.3, -0.3]) {
    const before = guard(unitStrategy(t));
    for (const env of [{ ZONE_PRIORITY: "off", ZONE_AHEAD_MODE: "all" }, { ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "off" }, { ...ON, KEY_LEVEL_ZONE_TYPES: "off" }]) {
      const g = guard(unitStrategy(t), env);
      assert.equal(JSON.stringify(g), JSON.stringify(before), JSON.stringify(env));
    }
    assert.equal("zone_ahead" in before, false);
  }
});

test("Z2-4 trend: a with-trend plan with an opposing zone inside need leaves g.cautions and the council's cautions deep-equal to TP1-KZ's", () => {
  const on = guard(unitStrategy(0.3), ON), off = guard(unitStrategy(0.3));
  assert.equal(check(on).pass, true);
  assert.deepEqual(on.cautions, off.cautions);
  const ev = (g) => de.councilEvidence({ barClose: CLOSE, cards: [], quorum: QUORUM, guards: { long: g, short: g } });
  assert.deepEqual(ev(on).long.cautions, ev(off).long.cautions);
  // The live fixture: the BUY's supply lies 1.8R ahead with the trend; cautions as before, through the record too.
  const loaded = bearLoaded();
  const a = de.assess(loaded, { now: NOW, env: { ...ZONE_ENV, ...ON } }), b = de.assess(loaded, { now: NOW, env: ZONE_ENV });
  for (const side of ["long", "short"]) assert.deepEqual(a.guards[side].cautions, b.guards[side].cautions, side);
});

test("Z2-5 an untyped or weak zone never blocks; a zone outside aroundSet never blocks", () => {
  assert.equal(check(guard(unitStrategy(0, unitZones({ supply: ds("supply", "weak") })), ON)).pass, true, "weak");
  assert.equal(check(guard(unitStrategy(0, unitZones({ supply: ds("mixed") })), ON)).pass, true, "mixed");
  assert.equal(check(guard(unitStrategy(0, unitZones({ supply: ds("none") })), ON)).pass, true, "none");
  assert.equal(check(guard(unitStrategy(0, unitZones({ supply: null })), ON)).pass, true, "untyped");
  // Twelve qualified zones nearer to price fill the recorded set: the decisive supply just ahead of the entry is outside it.
  const near = Array.from({ length: 12 }, (_, i) => ({ low: 3979 + i, high: 3979.5 + i, price: 3979.25 + i, candidate: false, qualified: true, ds: ds("none") }));
  const far = { low: 4003.5, high: 4005, price: 4004, candidate: true, ds: ds("supply", "strong") };
  const zones = [...near, { low: 3995, high: 3999, price: 3997, candidate: false, qualified: true, ds: ds("demand", "strong") }, far];
  const g = guard({ ...unitStrategy(0, zones), price: 3985 }, ON);
  assert.ok(g.plan, "a plan");
  assert.equal(g.plan.opposing_ahead.o_type, null);
  assert.equal(check(g).pass, true);
  // The full zone list would have chosen it.
  const all = zones.map((z) => ({ low: z.low, high: z.high, zone_type: z.ds.type, zone_strength: z.ds.strength, zone_freshness: z.ds.freshness, zone_rank: z.candidate ? "candidate" : "qualified" }));
  assert.equal(zoneAhead(g.plan, all, { dir: 1, atrH1: 10, trend: 0 }).o_type, "supply");
});

// ---------------------------------------------------------------- the filter (outside the quorum)

test("Z2-6 the filter: a plan into supply within need is out of liveAgentPlans, skipped on the non-arm path and ineligible in pickStrategy", () => {
  const blocked = agentPlan(oa()), clear = agentPlan(oa({ room_r: 1.5, room_atr: 1.5, would_block: false }));
  const g = { allowed: true, checks: [], plan: clear, min_rrr: 1.5, target_rule: "rrr", zone_ahead: "trend", plans: { [DEFAULT_AGENT]: { status: "live", plan: clear }, sweep_reversal: { status: "live", plan: blocked } } };
  const { zone_ahead: _, ...gOff } = g;
  assert.deepEqual(de.liveAgentPlans(g).map(([id]) => id), [DEFAULT_AGENT]);
  assert.deepEqual(de.liveAgentPlans(gOff).map(([id]) => id), [DEFAULT_AGENT, "sweep_reversal"]);
  assert.equal(zonePlanPasses(blocked, g), false);
  assert.equal(zonePlanPasses(blocked, { zone_ahead: "record" }), true);
  assert.equal(zonePlanPasses(agentPlan(oa({ would_block: false, with_trend: true })), { zone_ahead: "all" }), false, "'all': with the trend, short of need");
  assert.equal(zonePlanPasses(agentPlan(null), g), true, "no record: passes");
  // The execution non-arm path: the council's sweep_reversal is skipped; the default agent trades.
  const answer = { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "limit", target: "tp1", strategy: "sweep_reversal" };
  const guards = (side) => ({ long: side, short: { ...side, allowed: false }, strategy_execution: true, consensus: { long: [{ id: "sweep_reversal", voice: 2 }, { id: DEFAULT_AGENT, voice: 1 }], short: [], lean: 0.5 } });
  assert.equal(de.decide({ answer, guards: guards(g), quorum: QUORUM }).trade.agent, DEFAULT_AGENT);
  assert.equal(de.decide({ answer, guards: guards(gOff), quorum: QUORUM }).trade.agent, "sweep_reversal");
  const allBlocked = { ...g, plans: { [DEFAULT_AGENT]: { status: "live", plan: blocked }, sweep_reversal: { status: "live", plan: blocked } } };
  const d = de.decide({ answer, guards: guards(allBlocked), quorum: QUORUM });
  assert.equal(d.stance, "WAIT");
  assert.deepEqual(d.overruled.failed.map((f) => f.check), ["zone_ahead"]);
  // pickStrategy: ineligible, zone_ahead: false; the other one is picked. Without the mode: today's candidates.
  const speakers = [{ id: "sweep_reversal", voice: 2 }, { id: DEFAULT_AGENT, voice: 1 }];
  const pick = (zoneAhead) => de.pickStrategy({ side: "long", speakers, plans: g.plans, agentConfidence: { sweep_reversal: { long: 0.9 }, [DEFAULT_AGENT]: { long: 0.6 } }, quorum: QUORUM, strategy: { direction: "LONG", alignment: 0.5 }, armed: [], stance: "BUY", opts: {}, ...(zoneAhead ? { zoneAhead } : {}) });
  const on = pick("trend"), off = pick(null);
  assert.equal(off.agent, "sweep_reversal");
  assert.equal(on.agent, DEFAULT_AGENT);
  assert.deepEqual(on.candidates.find((c) => c.id === "sweep_reversal"), { ...off.candidates.find((c) => c.id === "sweep_reversal"), eligible: false, rrr: null, zone_ahead: false });
  assert.ok(off.candidates.every((c) => !("zone_ahead" in c)));
  assert.equal(pick("record").agent, "sweep_reversal");
});

test("Z2-7 agentsConsensus, the STRATEGY_AGENTS witness, the agents' confidence and the quorum deep-equal the run without Z2", () => {
  const loaded = bearLoaded();
  const a = de.assess(loaded, { now: NOW, env: { ...ZONE_ENV, ...ON } }), b = de.assess(loaded, { now: NOW, env: ZONE_ENV });
  assert.deepEqual(a.guards.consensus, b.guards.consensus);
  assert.deepEqual(a.guards.agent_confidence, b.guards.agent_confidence);
  assert.deepEqual(a.cards, b.cards);
  assert.ok(a.cards.some((c) => c.key === "STRATEGY_AGENTS"));
  assert.deepEqual(a.quorum, b.quorum);
  assert.deepEqual(a.guards.short.plans, b.guards.short.plans, "the plans themselves are unchanged");
  // The short's plans run into the demand zone holding the entry: out of liveAgentPlans with Z2 only.
  assert.ok(de.liveAgentPlans(b.guards.short).length >= 1);
  assert.deepEqual(de.liveAgentPlans(a.guards.short), []);
});

// ---------------------------------------------------------------- the record, the council, the facts and the recap

test("Z2-8 the record: a SELL held back by zone_ahead alone writes zone_blocked; ZONE_PRIORITY off is today's SELL", () => {
  const loaded = bearLoaded();
  const on = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment: de.assess(loaded, { now: NOW, env: { ...ZONE_ENV, ...ON } }), council: SELL, now: NOW, env: { ...ZONE_ENV, ...ON } });
  const off = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment: de.assess(loaded, { now: NOW, env: ZONE_ENV }), council: SELL, now: NOW, env: ZONE_ENV });
  assert.equal(off.stance, "SELL");
  assert.equal(off.trade.opposing_ahead.would_block, true, "Z0 recorded it, and it traded");
  assert.equal("zone_blocked" in off, false);
  assert.equal(on.stance, "WAIT");
  assert.deepEqual(on.overruled.failed.map((f) => f.check), ["zone_ahead"]);
  assert.deepEqual(on.guardrails.short.checks.filter((c) => !c.pass).map((c) => c.id), ["zone_ahead"]);
  assert.equal(on.zone_blocked.side, "short");
  assert.equal(on.zone_blocked.agent, DEFAULT_AGENT);
  assert.deepEqual(on.zone_blocked.opposing_ahead, { o_type: "demand", o_strength: "strong", o_freshness: "worn", o_rank: "candidate", room_atr: 0, room_r: 0, need_r: 1, trend_lean: 0.75, with_trend: false, would_block: true });
  assert.deepEqual(on.zone_blocked.plan.opposing_ahead, on.zone_blocked.opposing_ahead);
  assert.equal(on.zone_blocked.plan.entry, off.trade.entry);
  // Cautions, vetoes, witnesses, quorum and key levels are the same.
  for (const k of ["cautions", "vetoes", "witnesses", "quorum", "key_levels", "strategy_plans"]) assert.deepEqual(on[k], off[k], k);
  // No zone_blocked while another check fails too (the long fails its quorum) or when the side passes.
  assert.equal(de.zoneBlockedOf({ long: { checks: [{ id: "quorum", pass: false }, { id: "zone_ahead", pass: false }], plan: {} }, short: { checks: [{ id: "zone_ahead", pass: true }], plan: {} } }), null);
});

test("Z2-9 the council, only when on: plan words, opposing_zone_ahead_atr and with_trend; one sentence; nothing in cautions", () => {
  const loaded = bearLoaded();
  const ev = (env) => { const a = de.assess(loaded, { now: NOW, env }); return de.councilEvidence({ barClose: CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards }); };
  const on = ev({ ...ZONE_ENV, ...ON }), off = ev(ZONE_ENV);
  assert.deepEqual([on.short.plan.opposing_zone_ahead_atr, on.short.plan.with_trend], [0, false]);
  assert.deepEqual([on.long.plan.opposing_zone_ahead_atr, on.long.plan.with_trend], [1.78, true]);
  assert.equal(on.long.plan.zone_types.entry.type, "demand");
  const strip = (p) => { const { zone_types, opposing_zone_ahead_atr, with_trend, ...rest } = p; return rest; };
  assert.deepEqual(strip(on.long.plan), off.long.plan);
  assert.ok(!("with_trend" in off.long.plan));
  for (const side of ["long", "short"]) assert.deepEqual(on[side].cautions, off[side].cautions);
  const sys = (e) => de.councilMessages(e)[0].content;
  assert.ok(sys(on).includes(de.ZONE_PRIORITY_PROMPT));
  assert.equal(sys(off).includes(de.ZONE_PRIORITY_PROMPT), false);
  // One sentence: the same evidence without the zone words and the check reads the prompt without it. (The filter's own
  // effect shows here too: the short's plans run into the demand zone, so the short lists no strategies with Z2 on.)
  const bare = (e) => ({ ...e, ...Object.fromEntries(["long", "short"].map((k) => [k, { ...e[k], checks: e[k].checks.filter((c) => c.check !== "zone_ahead"), plan: e[k].plan ? strip(e[k].plan) : null }])) });
  assert.equal(sys(on).replace(` ${de.ZONE_PRIORITY_PROMPT}`, ""), sys(bare(on)), "one sentence");
  assert.ok(off.short.strategies && !on.short.strategies, "the filter: liveAgentPlans leaves the short's plans out");
  // 'record': the words and the sentence stay, the check is gone.
  const rec = ev({ ...ZONE_ENV, ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "record" });
  assert.equal(rec.short.checks.some((c) => c.check === "zone_ahead"), false);
  assert.ok(sys(rec).includes(de.ZONE_PRIORITY_PROMPT));
});

test("Z2-10 doctrine-facts: guardrailIds with ZONE_PRIORITY off is byte-identical to today's; on adds zone_ahead after reward", () => {
  const today = guardrailIds({});
  assert.deepEqual(today, ["market_open", "fresh", "quorum", "no_veto", "levels", "reward", "room", "confidence"]);
  assert.equal(JSON.stringify(guardrailIds({ ZONE_PRIORITY: "off", ZONE_AHEAD_MODE: "all" })), JSON.stringify(today));
  assert.deepEqual(guardrailIds(ON), ["market_open", "fresh", "quorum", "no_veto", "levels", "reward", "zone_ahead", "room", "confidence"]);
  assert.deepEqual(guardrailIds({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "record" }), today);
});

test("Z2-11 no detail reads like a price; the public recap of a zone-blocked decision equals the one without the check", () => {
  const details = [];
  for (const t of [0, 0.3, -0.3]) for (const m of ["trend", "all"]) details.push(check(guard(unitStrategy(t), { ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: m })).detail);
  const loaded = bearLoaded();
  const env = { ...ZONE_ENV, ...ON };
  const rec = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment: de.assess(loaded, { now: NOW, env }), council: SELL, now: NOW, env });
  details.push(...["long", "short"].map((s) => rec.guardrails[s].checks.find((c) => c.id === "zone_ahead").detail), ...rec.overruled.failed.map((f) => f.detail));
  details.push(zoneAheadCheck(agentPlan(oa({ o_type: null })), "trend", 1).detail, zoneAheadCheck(agentPlan(null), "trend", -1).detail, zoneAheadCheck(null, "trend", 1).detail);
  for (const s of details) assert.doesNotMatch(s, pp.PRICE_LIKE, s);
  const recap = (r) => pp.publicRecap({ decision_key: KEY, bar_close: CLOSE, stance: r.stance, bias: r.bias, decision_json: JSON.stringify(r) });
  const without = { ...rec, guardrails: Object.fromEntries(["long", "short"].map((s) => [s, { ...rec.guardrails[s], checks: rec.guardrails[s].checks.filter((c) => c.id !== "zone_ahead") }])) };
  assert.deepEqual(recap(rec), recap(without));
  assert.deepEqual(recap(rec).held_back.short, []);
  assert.deepEqual(pp.recapLeaks(recap(rec)), []);
});

// ---------------------------------------------------------------- the engine, rule_version and MS2

test("Z2-12 'all' logs one warning line per decision; trend logs none", async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (s) => lines.push(String(s));
  try {
    for (const mode of ["all", "trend"]) {
      de.resetDecisionSchemaCacheForTests();
      const run = { DB: d1(), SIGNAL_CACHE: kv(), AI: { run: async () => { throw new Error("model down"); } }, ...ZONE_ENV, ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: mode, MODE_SHADOW_EVIDENCE: "off" };
      await run.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "intraday");
      await de.runDecisionEngine(run, { barClose: CLOSE, now: NOW, clock: () => NOW + 5_000, loaded: bearLoaded() });
    }
  } finally { console.warn = warn; }
  const z = lines.filter((l) => l.includes("zone_ahead_mode_all"));
  assert.equal(z.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(z[0])), ["event", "decision_key", "stance", "blocked"]);
  assert.deepEqual(JSON.parse(z[0]).blocked, ["short"]);
});

test("Z2-13 rule_version gains zone_ahead@1 while the check is in the guardrails; off and record are as before", () => {
  assert.equal(ZONE_AHEAD_RULE, "zone_ahead@1");
  assert.equal(ruleVersionOf({}), "tp1_kz:on");
  assert.equal(ruleVersionOf({ ZONE_PRIORITY: "off" }), "tp1_kz:on");
  assert.equal(ruleVersionOf(ON), "tp1_kz:on+zone_ahead@1");
  assert.equal(ruleVersionOf({ ...ON, TP1_KEY_ZONE_MODE: "off" }), "tp1_kz:off+zone_ahead@1");
  assert.equal(ruleVersionOf({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "all" }), "tp1_kz:on+zone_ahead@1:all");
  assert.equal(ruleVersionOf({ ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "record" }), "tp1_kz:on");
  assert.equal(zoneRuleToken({ ...ON, KEY_LEVEL_ZONE_TYPES: "off" }), null);
});

test("Z2-14 MS2's shadow replay reproduces zone_ahead from the record; room-tuning keeps the check as recorded", () => {
  const loaded = bearLoaded();
  const env = { ...ZONE_ENV, ...ON };
  const assessment = de.assess(loaded, { now: NOW, env });
  const rec = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment, council: SELL, now: NOW, env });
  const shadows = de.shadowModeDecisions({ loaded, assessment, council: SELL, env, now: NOW });
  const off = de.shadowModeDecisions({ loaded, assessment: de.assess(loaded, { now: NOW, env: ZONE_ENV }), council: SELL, env: ZONE_ENV, now: NOW });
  // Without Z2 the other modes sell into the demand zone (Z0 recorded would_block); with it they wait on zone_ahead.
  const trading = off.filter((r) => r.stance === "SELL");
  assert.ok(trading.length >= 1);
  for (const r of trading) {
    const s = shadows.find((x) => x.mode === r.mode);
    assert.deepEqual([s.stance, s.reason], ["WAIT", "zone_ahead"], r.mode);
    // From the record alone: decision.key_levels, the trade's entry and stop, atr_h1 and the recorded trend_lean.
    const t = r.trade;
    const again = zoneAhead({ entry: t.entry, stop: t.stop }, rec.key_levels, { dir: -1, atrH1: rec.strategy.atr_h1, trend: t.opposing_ahead.trend_lean });
    assert.deepEqual(again, t.opposing_ahead);
    assert.equal(zoneAheadFails(again, "trend"), true, "the replay blocks it as the shadow did");
  }
  // The live record replays the same way: the guardrail check from the recorded zone_blocked.
  const z = rec.zone_blocked;
  assert.deepEqual(zoneAhead(z.plan, rec.key_levels, { dir: -1, atrH1: rec.strategy.atr_h1, trend: z.opposing_ahead.trend_lean }), z.opposing_ahead);
  assert.equal(zoneAheadCheck(z.plan, "trend", -1).detail, rec.guardrails.short.checks.find((c) => c.id === "zone_ahead").detail);
  // room-tuning's withRoom recomputes the room check only: zone_ahead stays as recorded.
  const d = { checks: { long: rec.guardrails.long.checks, short: rec.guardrails.short.checks }, room: { measured: true, ratio: 0.2 } };
  const replayed = withRoom(d, 1);
  for (const side of ["long", "short"]) assert.deepEqual(replayed.checks[side].find((c) => c.id === "zone_ahead"), d.checks[side].find((c) => c.id === "zone_ahead"));
});

test("Z2-15 ZONE_PRIORITY off: the whole scenario is byte-identical to TP1-KZ's (the run without the variable)", async () => {
  const base = await zoneScenario(mods, { db: d1, kv });
  for (const env of [{ ZONE_PRIORITY: "off", ZONE_AHEAD_MODE: "trend" }, { ZONE_PRIORITY: "on", ZONE_AIM_OFF: Z2B_OFF, ZONE_AHEAD_MODE: "off" }]) {
    const off = await zoneScenario(mods, { db: d1, kv, env });
    for (const k of ["strategy", "guards", "record", "evidence", "messages", "signal", "management", "recap", "analysis", "stored", "planRows"]) assert.equal(JSON.stringify(off[k]), JSON.stringify(base[k]), `${JSON.stringify(env)} ${k}`);
  }
  // On, the BUY stands (its supply is 1.8R ahead); the EA signal, management fields and the public output are unchanged.
  const on = await zoneScenario(mods, { db: d1, kv, env: ON });
  assert.equal(on.record.stance, "BUY");
  for (const k of ["signal", "management", "recap", "analysis"]) assert.equal(JSON.stringify(on[k]), JSON.stringify(base[k]), k);
  assert.deepEqual(on.planRows.map(({ rule_version, ...r }) => r), base.planRows.map(({ rule_version, ...r }) => r));
  assert.ok(on.planRows.every((r) => r.rule_version === "tp1_kz:on+zone_ahead@1"));
});

test("Z2-16 the frozen 2026-11-20 22:00 capture (production, SELECT only) gives the expected check", async () => {
  const slim = await gunzipJson(CAPTURE_2026_11_20_22);
  const strategy = se.buildStrategy(slim);
  const got = {};
  for (const [dir, side] of [[1, "long"], [-1, "short"]]) {
    const g = de.guardrailsFor(dir, { cards: [], quorum: QUORUM, strategy, inputs: slim, now: slim.now, env: ON });
    got[side] = { check: check(g), opposing: g.plan?.opposing_ahead ?? null };
  }
  assert.deepEqual(got, EXPECTED_2026_11_20_22);
  for (const side of ["long", "short"]) assert.doesNotMatch(got[side].check.detail, pp.PRICE_LIKE);
});
// A SELL-trend hour (trend lean -0.78): a counter-trend long meets a strong worn supply zone 0.33 ATR ahead and fails; the
// with-trend short has no decisive demand zone within reach and passes.
const EXPECTED_2026_11_20_22 = {
  long: {
    check: { id: "zone_ahead", pass: false, detail: "the nearest strong worn supply zone lies 0.33 ATR ahead of the long entry (0.4R), short of the 1R it needs, and the trend (lean -0.78) is not with the trade" },
    opposing: { o_type: "supply", o_strength: "strong", o_freshness: "worn", o_rank: "candidate", room_atr: 0.33, room_r: 0.4, need_r: 1, trend_lean: -0.78, with_trend: false, would_block: true }
  },
  short: {
    check: { id: "zone_ahead", pass: true, detail: "no demand or supply zone against the trade within reach" },
    opposing: { o_type: null, o_strength: null, o_freshness: null, o_rank: null, room_atr: null, room_r: null, need_r: 1, trend_lean: -0.78, with_trend: true, would_block: false }
  }
};

test("Z2-17 no hashed engine function changes: ENGINE_CODE_HASH recomputes to 2e40fac9… (the Z6 sd marker moved it, after Z6, B5 and Z3a); the behaviour hash is ecfe3f90…", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(ENGINE_CODE_HASH, "2e40fac9a9553d261c395b42c3eb25e73f47713e65a09291b6fa6bf59f3dd4b8");
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
});
