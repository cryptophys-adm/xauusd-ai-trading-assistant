// Platform ADR-0020 Amendment 8 (owner 2026-11-20, "setuju", then "keduanya"; docs/RFC_PM_A8.md): the Position Council
// may loosen an open position's tightened stop once, within bounds and with a measured reason, and move its take profit
// nearer or further. Behind the owner's switch pm_loosen_enabled, off by default; off, everything is as before.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { positionFacts, positionAction, ruleAction, positionCouncilMessages, cleanCouncilA8, councilText, runPositionManager, POSITION_COUNCIL_SCHEMA, POSITION_COUNCIL_SCHEMA_A8 } from "../src/position-manager.mjs";
import { positionManagerIntents, planIntents, manageIntents, isProtected, loosenRecords, settingsFrom, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { pmLoosenKnobs, PM_LOOSEN_KNOB_START, PM_LOOSEN_KNOB_BOUNDS, PM_LOOSEN_KNOB_FACTS } from "../src/pm-loosen-knobs.mjs";
import { actionMessage, resetPositionSchemaCacheForTests, ensurePositionSchema } from "../src/position-actions.mjs";
import { bridgeSync, writeSettings, readSettings, applyOmegaPolicy, resetOmegaBrokerSchemaForTests, OMEGA_POLICY_KEY } from "../src/omega-broker.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { pmOffOutputs } from "./fixtures/pm-a8-off.mjs";

// A BUY opened at 4000.00 with its original stop at 3990.00 (1R = 10.00) and its target (TP1) at 4020.00; ATR(14, 15m)
// 4.00 at entry. The stop was tightened to 3996.00 (or to 4005.00, past break-even).
const sym = (bid, extra = {}) => ({ bid, ask: Math.round((bid + 0.2) * 100) / 100, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0, tick_size: 0.01, tick_value: 1, atr_value: 6.5, ...extra });
const DEC = { stance: "BUY", quorum: { long_share: 0.7, short_share: 0.2 }, quorum_prev: { long_share: 0.7, short_share: 0.2 }, agent_confidence: { zone_pullback: { long: 0.7, short: 0.2 } }, agent_confidence_prev: { zone_pullback: { long: 0.7, short: 0.2 } } };
const INTENT = { tp: 4020, sl: 3990, entry: 4000, strategy: "zone_pullback", mode: "intraday", r_dist: 10, atr_entry: 4 };
const pos = (over = {}) => ({ ticket: 7, side: "BUY", open_price: 4000, sl: 3996, tp: 4020, volume: 0.1, intent_id: "open:1:B", magic: 920200, source: "omega", ...over });
const C = (over = {}) => ({ momentum: "holding", thesis: "intact", reason: "r", stop: "loosen", stop_reason: "atr_expansion", target: "keep", target_reason: "none", ...over });
const facts = (bid, over = {}, L = {}, { levels = [], decision = DEC, ladder = false, intent = INTENT } = {}) =>
  positionFacts({ position: pos(over), sym: sym(bid), openIntent: intent, levels, decision, ladder, loosen: { atr_now: 6.5, ...L } });
const pick = (a) => [a.action, a.rule, a.sl ?? a.tp ?? null];
const h = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

test("A8-1 the switch: off by default, a boolean, owner-only on the page; Aether's policy never writes it", async () => {
  assert.equal(OMEGA_DEFAULTS.pm_loosen_enabled, false);
  assert.equal(settingsFrom({ pm_loosen_enabled: true }, OMEGA_DEFAULTS).settings.pm_loosen_enabled, true);
  assert.match(settingsFrom({ pm_loosen_enabled: "yes" }, OMEGA_DEFAULTS).error, /pm_loosen_enabled must be true or false/);
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, pm_loosen_enabled: true }).settings.pm_loosen_enabled, true, "carried through any other change");
  // Aether's policy writes the risk settings back and carries the owner's switch as stored, both ways.
  for (const stored of [true, false]) {
    resetOmegaBrokerSchemaForTests();
    const e = env();
    await writeSettings(e, { body: { pm_loosen_enabled: stored }, actor: "owner" }, { now: NOW });
    await e.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ risk_pct: 0.4, max_positions: 2, pm_loosen_enabled: !stored, doctrine_sha: "a".repeat(64) }));
    const r = await applyOmegaPolicy({ ...e, OMEGA_POLICY_AUTO: "true" }, { now: NOW + 1 });
    assert.equal(r.status, "applied");
    assert.equal((await readSettings(e)).settings.pm_loosen_enabled, stored);
  }
});

test("A8-2 switch off: positionFacts, positionAction, the council's messages and schema and Omega's intents are byte for byte the same", () => {
  const o = pmOffOutputs();
  // Taken from the code at ad21475 (before the amendment) with test/fixtures/pm-a8-off.mjs.
  assert.equal(h(o.facts), "51d837cdc426341bb7791239493dbbb6770f8e70ab4e68b9f9fbd3151b740ae8");
  assert.equal(h(o.actions), "5b45c5488e77feb12cd5377958940f329b1b323febe2eddb4e12f3a3e600caac");
  assert.equal(h(o.messages), "d0e4d6a88f9715df6f7cdd39ac4783ea203b457bfe62cfab2ffcf3aaf63d7837");
  assert.equal(h(o.schema), "771517a3d9db6714ae96a3df3202905e226b68f37550f097e5d56b8f704ae982");
  assert.equal(h(o.cleaned), "f7aaeb96726f1c3b12522ed0a7971bbd7c40c164291fabf341cc288f593af2ef");
  assert.equal(h(o.intents), "1053821649c5907cbc383eeaf2a56d6e7c5232eac9543b957b448d616f9b1a74");
  assert.equal(h(o.plans), "8ed666e830cc4361bd49c9e5196798d1bfa5690a29c20cd4cc9c65cf5f581d9c");
  assert.equal(o.actions.length, 4842);
  // With the switch off an amendment action that reached Omega anyway is dropped, and no intent carries its fields.
  const r = positionManagerIntents({ positions: [pos()], sym: sym(4003), actions: [{ id: "pm:7:1", ticket: 7, action: "sl", rule: "loosen_atr_expansion", sl: 3993 }] });
  assert.deepEqual([r.intents, r.dropped[0].reason], [[], "the council's stop and target moves are switched off (ADR-0020 Amendment 8, pm_loosen_enabled)"]);
});

test("A8-3 the knobs per mode: start values, clamped to their bounds; the platform names avoid the trading words", () => {
  assert.deepEqual(pmLoosenKnobs("swing"), { mode: "swing", ...PM_LOOSEN_KNOB_START.swing, source: "start_values" });
  assert.deepEqual(pmLoosenKnobs("nonsense"), { mode: "intraday", ...PM_LOOSEN_KNOB_START.intraday, source: "start_values" });
  assert.deepEqual(pmLoosenKnobs("scalp", { atr_expand: 9, back_share: 0.01 }), { mode: "scalp", atr_expand: 2.5, back_share: 0.25, source: "overrides_clamped" });
  assert.deepEqual(pmLoosenKnobs("range", { atr_expand: 1, back_share: 3 }), { mode: "range", atr_expand: 1.2, back_share: 1, source: "overrides_clamped" });
  for (const m of ["scalp", "intraday", "swing", "range"]) {
    for (const k of ["atr_expand", "back_share"]) {
      const v = PM_LOOSEN_KNOB_START[m][k], b = PM_LOOSEN_KNOB_BOUNDS[m][k];
      assert.ok(v >= b.min && v <= b.max, `${m}.${k} inside its bound`);
    }
  }
  for (const name of Object.values(PM_LOOSEN_KNOB_FACTS)) {
    for (const m of ["scalp", "intraday", "swing", "range"]) assert.doesNotMatch(name.replace("<mode>", m), /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/);
  }
});

test("A8-4 the bounds: back toward the original stop by the mode's share, never past it; from break-even never into loss; only a tightened stop", () => {
  // Intraday: back_share 0.5 of the 6.00 between 3996 and 3990.
  assert.deepEqual(pick(positionAction(facts(4003), C())), ["sl", "loosen_atr_expansion", 3993]);
  assert.match(positionAction(facts(4003), C()).why, /intraday; the stop from 0\.4R at risk to 0\.7R at risk \(1R at entry\); 30 pips/);
  // Swing (0.6) and a share of 1 still never pass the original stop.
  assert.equal(positionAction(facts(4003, {}, {}, { intent: { ...INTENT, mode: "swing" } }), C()).sl, 3992.4);
  const f1 = facts(4003);
  const all = positionAction({ ...f1, loosen: { ...f1.loosen, knobs: { atr_expand: 1.5, back_share: 1 } } }, C());
  assert.equal(all.sl, 3990, "all the way back is the original stop, never past it");
  // At break-even or better: never back into loss (the entry is the floor).
  const be = positionAction(facts(4012, { sl: 4005 }), C());
  assert.deepEqual(pick(be), ["sl", "loosen_atr_expansion", 4000]);
  assert.match(be.why, /from 0\.5R locked to break-even/);
  assert.deepEqual(pick(positionAction(facts(4012, { sl: 4000.5 }), C())), ["sl", "loosen_atr_expansion", 4000]);
  const atBe = positionAction(facts(4003, { sl: 4000 }), C());
  assert.equal(atBe.action, "hold");
  assert.match(atBe.why, /refused: no room between the stop and its bound/);
  // A stop never tightened (still the original) is never loosened; a SELL mirrors the BUY.
  assert.match(positionAction(facts(4003, { sl: 3990 }), C()).why, /refused: the stop was never tightened/);
  const sell = positionFacts({ position: pos({ side: "SELL", sl: 4004, tp: 3980 }), sym: sym(3997), openIntent: { ...INTENT, tp: 3980, sl: 4010 }, levels: [], decision: { ...DEC, stance: "SELL", quorum: { long_share: 0.2, short_share: 0.7 }, quorum_prev: { long_share: 0.2, short_share: 0.7 }, agent_confidence: { zone_pullback: { long: 0.2, short: 0.7 } }, agent_confidence_prev: { zone_pullback: { long: 0.2, short: 0.7 } } }, loosen: { atr_now: 6.5 } });
  assert.deepEqual(pick(positionAction(sell, C())), ["sl", "loosen_atr_expansion", 4007]);
  // Once per position; a delegated position never; an unreadable record never.
  assert.match(positionAction(facts(4003, {}, { loosened: true }), C()).why, /loosened once already/);
  assert.match(positionAction(facts(4003, {}, { delegated: true }), C()).why, /delegated position's stop is never loosened/);
  assert.match(positionAction(facts(4003, {}, { unreadable: true }), C()).why, /cannot be read/);
  // The council's consensus: the thesis intact and the momentum not weakening.
  assert.match(positionAction(facts(4003), C({ thesis: "weakening" })).why, /no consensus to give the position room/);
  assert.match(positionAction(facts(4003), C({ momentum: "weakening" })).why, /no consensus/);
  // Never over a close, a lock, TP2 or at the loss band: the fixed rules come first.
  assert.equal(positionAction(facts(3994.8, { sl: 3993 }), C()).rule, "hold_to_stop");
  assert.equal(positionAction(facts(4012, { sl: 3996 }), C()).rule, "breakeven", "the break-even lock first");
});

test("A8-5 a measured reason that holds: ATR(14, 15m) expansion, a key level just outside the stop, a high-impact release", () => {
  // ATR: 6.5 / 4 = 1.63x at entry, over intraday's 1.5x; 5.9 is not; the last tighten's ATR wins over the entry's.
  assert.equal(positionAction(facts(4003, {}, { atr_now: 5.9 }), C()).action, "hold");
  assert.match(positionAction(facts(4003, {}, { atr_now: 5.9 }), C()).why, /ATR\(14, 15m\) 5\.9 is below 1\.5x the reference 4/);
  assert.equal(positionAction(facts(4003, {}, { atr_ref: 5 }), C()).action, "hold", "6.5 / 5 = 1.3x the last tighten's ATR");
  assert.match(positionAction(facts(4003, {}, { atr_ref: 4.2 }), C()).why, /the last tighten/);
  assert.match(positionAction(facts(4003, {}, {}, { intent: { ...INTENT, atr_entry: undefined } }), C()).why, /no ATR reference was recorded/);
  // A key level just outside the stop, between it and its bound: the stop clears it by two spreads, never past the bound.
  const kl = C({ stop_reason: "key_level_outside" });
  assert.deepEqual(pick(positionAction(facts(4003, {}, {}, { levels: [{ low: 3993.5, high: 3994.5 }] }), kl)), ["sl", "loosen_key_level_outside", 3993.1]);
  assert.equal(positionAction(facts(4003, {}, {}, { levels: [{ low: 3992, high: 3995 }] }), kl).sl, 3993, "a wide level: the bound");
  assert.match(positionAction(facts(4003, {}, {}, { levels: [{ low: 3980, high: 3981 }] }), kl).why, /no key level lies just outside the stop/);
  // A scheduled high-impact USD release in the calendar's window.
  const rel = C({ stop_reason: "high_impact_release" });
  assert.match(positionAction(facts(4003), rel).why, /no high-impact release is in the calendar's window/);
  const r = positionAction(facts(4003, {}, { release: { title: "Non-Farm Employment Change", time: "2026-11-20T13:30:00.000Z" } }), rel);
  assert.deepEqual(pick(r), ["sl", "loosen_high_impact_release", 3993]);
  assert.match(r.why, /a high-impact release is scheduled \(Non-Farm Employment Change, 13:30 UTC\)/);
  // No reason named (an unknown one is cleaned to none): nothing.
  assert.match(positionAction(facts(4003), cleanCouncilA8(C({ stop_reason: "gut_feeling" }))).why, /no measured reason named/);
});

test("A8-6 a silent council changes nothing, and nothing loosens or moves mechanically", () => {
  for (const f of [facts(4003), facts(4012, { sl: 4005 }), facts(4003, {}, { release: { title: "CPI", time: "t" } }, { levels: [{ low: 4010, high: 4011 }, { low: 3993.5, high: 3994.5 }] })]) {
    assert.deepEqual(positionAction(f, null), ruleAction(f, null));
    assert.ok(!["loosen", "tp_"].some((x) => String(positionAction(f, null).rule).startsWith(x)));
  }
  // A council that keeps both is today's answer.
  const keep = C({ stop: "keep", stop_reason: "none" });
  assert.deepEqual(positionAction(facts(4003), keep), ruleAction(facts(4003), keep));
  // The runner without the council's answer stores no loosening (council_failed: no action).
  assert.equal(positionAction(facts(4003), null).action, "hold");
});

test("A8-7 the target both ways with a measured reason; never the wrong side of price; a target further never with a looser stop", () => {
  const before = [{ low: 4010, high: 4011 }], beyond = [{ low: 4030, high: 4031 }];
  // Nearer: a key level before the target; momentum fading (the quorum's share fell); the agent's confidence dropped.
  assert.deepEqual(pick(positionAction(facts(4003, {}, {}, { levels: before }), C({ stop: "keep", target: "nearer", target_reason: "key_level_before" }))), ["tp", "tp_nearer_key_level_before", 4010]);
  const fading = { ...DEC, quorum: { long_share: 0.55, short_share: 0.3 } };
  assert.deepEqual(pick(positionAction(facts(4003, {}, {}, { levels: before, decision: fading }), C({ stop: "keep", target: "nearer", target_reason: "momentum_fading" }))), ["tp", "tp_nearer_momentum_fading", 4010]);
  assert.match(positionAction(facts(4003, {}, {}, { levels: before }), C({ stop: "keep", target: "nearer", target_reason: "momentum_fading" })).why, /the quorum's share on the side did not fall/);
  const dropped = { ...DEC, agent_confidence: { zone_pullback: { long: 0.5, short: 0.2 } } };
  assert.match(positionAction(facts(4003, {}, {}, { levels: before, decision: dropped }), C({ stop: "keep", target: "nearer", target_reason: "confidence_drop" })).why, /target moved nearer 4020 → 4010 \(the zone_pullback confidence dropped 0\.7 to 0\.5\)/);
  // Without a level ahead: back to TP1 only when the target is beyond it.
  assert.deepEqual(pick(positionAction(facts(4003, { tp: 4030 }, {}, { decision: dropped }), C({ stop: "keep", target: "nearer", target_reason: "confidence_drop" }))), ["tp", "tp_nearer_confidence_drop", 4020]);
  assert.match(positionAction(facts(4003, {}, {}, { decision: dropped }), C({ stop: "keep", target: "nearer", target_reason: "confidence_drop" })).why, /not beyond TP1/);
  // A level behind price is never a target (the wrong side of price).
  assert.match(positionAction(facts(4012, { sl: 4005 }, {}, { levels: [{ low: 4008, high: 4009 }], intent: { ...INTENT, tp: 4030 } }), C({ stop: "keep", target: "nearer", target_reason: "key_level_before" })).why, /no key level stands before the target/);
  // Further: a key level beyond (target not at TP1, so not TP2), or ATR expansion with the confidence rising.
  assert.deepEqual(pick(positionAction(facts(4003, { tp: 4025 }, {}, { levels: beyond }), C({ stop: "keep", target: "further", target_reason: "key_level_beyond" }))), ["tp", "tp_further_key_level_beyond", 4030]);
  const rising = { ...DEC, agent_confidence_prev: { zone_pullback: { long: 0.6, short: 0.2 } } };
  assert.equal(positionAction(facts(4003, { tp: 4025 }, {}, { levels: beyond, decision: rising }), C({ stop: "keep", target: "further", target_reason: "atr_expansion_trend" })).tp, 4030);
  assert.match(positionAction(facts(4003, { tp: 4025 }, {}, { levels: beyond }), C({ stop: "keep", target: "further", target_reason: "atr_expansion_trend" })).why, /confidence is not rising/);
  assert.match(positionAction(facts(4003, { tp: 4025 }, {}, { levels: beyond }), C({ stop: "keep", thesis: "weakening", target: "further", target_reason: "key_level_beyond" })).why, /no consensus to extend/);
  // A loosening and a target further asked together: the stop only, the target waits.
  const both = positionAction(facts(4003, { tp: 4025 }, {}, { levels: beyond }), C({ target: "further", target_reason: "key_level_beyond" }));
  assert.deepEqual(pick(both), ["sl", "loosen_atr_expansion", 3993]);
  assert.match(both.why, /the target waits: a target moved further never comes with a looser stop/);
  // Omega: a council target move never carries a stop; a modify_sltp with a looser stop and a further target is refused.
  const a8 = { original: { 7: { sl: 3990, mode: "intraday", r_dist: 10 } }, loosened: {}, stops: {}, blocked: null, riskCheck: () => null, veto: () => false };
  const drops = (a, p = pos(), s = sym(4003)) => positionManagerIntents({ positions: [p], sym: s, actions: [{ id: "pm:7:9", ticket: 7, ...a }], sltp: true, a8 }).dropped.map((d) => d.reason);
  assert.match(drops({ action: "tp", rule: "tp_further_key_level_beyond", tp: 4030, sl: 3993 })[0], /never carries a stop/);
  assert.match(drops({ action: "tp", rule: "tp2_breakeven", tp: 4030, sl: 3993 })[0], /looser than the broker's/);
  assert.match(drops({ action: "tp", rule: "tp_nearer_key_level_before", tp: 4003 })[0], /wrong side of price/);
  assert.match(drops({ action: "tp", rule: "tp_nearer_key_level_before", tp: 4025 })[0], /is not nearer than the broker's \(4020\)/);
  assert.match(drops({ action: "tp", rule: "tp_further_key_level_beyond", tp: 4015 })[0], /is not further out than the broker's/);
  const ok = positionManagerIntents({ positions: [pos()], sym: sym(4003), actions: [{ id: "pm:7:9", ticket: 7, action: "tp", rule: "tp_nearer_key_level_before", tp: 4010 }], a8 });
  assert.deepEqual(ok.intents, [{ id: "pm:7:t:9", kind: "modify_tp", ticket: 7, tp: 4010, reason: "pm_tp_nearer_key_level_before", from_tp: 4020, mode: "intraday", tp_r_from: 2, tp_r_to: 1 }]);
  // Under the TP ladder a nearer target passes; a further one waits for the TP1 lock (Amendment 4).
  const ex = (positions) => ({ connected: true, received_ms: 1_000, positions, executor: { version: "1.21" }, account: { trade_mode: "demo", equity: 10_000, day_start_balance: 10_000 }, symbol: sym(4003) });
  const ladderPlan = (a) => planIntents({ executor: ex([pos()]), now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: true, pm_loosen_enabled: true }, pmActions: [a], pmLoosen: { loosened: {}, original: a8.original } });
  assert.ok(ladderPlan({ id: "pm:7:9", ticket: 7, action: "tp", rule: "tp_nearer_key_level_before", tp: 4010 }).intents.some((i) => i.id === "pm:7:t:9"));
  const held = ladderPlan({ id: "pm:7:9", ticket: 7, action: "tp", rule: "tp_further_key_level_beyond", tp: 4030 });
  assert.ok(!held.intents.some((i) => i.id === "pm:7:t:9"));
  assert.match(held.pm_dropped[0].reason, /TP ladder holds the target/);
  // The Position Manager does not even ask under the ladder hold.
  assert.match(positionAction(facts(4003, { tp: 4025 }, {}, { levels: beyond, ladder: true }), C({ stop: "keep", target: "further", target_reason: "key_level_beyond" })).why, /TP ladder holds the target/);
});

// ---------------------------------------------------------------------------------------------------- Omega's check
const A8 = (over = {}) => ({ original: { 7: { sl: 3990, mode: "intraday", r_dist: 10 } }, loosened: {}, stops: {}, blocked: null, riskCheck: () => null, veto: () => false, ...over });
const LOOSEN = { id: "pm:7:9", ticket: 7, action: "sl", rule: "loosen_atr_expansion", sl: 3993 };
const pmi = (a = LOOSEN, a8 = A8(), p = pos(), s = sym(4003)) => positionManagerIntents({ positions: [p], sym: s, actions: [a], a8 });

test("A8-8 Omega checks every bound again: the original stop, the share, break-even, once, the veto, the arm, the budget", () => {
  assert.deepEqual(pmi().intents, [{ id: "pm:7:s:9", kind: "modify_sl", ticket: 7, sl: 3993, tp: 4020, reason: "pm_loosen_atr_expansion", loosen: true, from_sl: 3996, orig_sl: 3990, mode: "intraday", risk_r_before: 0.4, risk_r_after: 0.7 }]);
  const why = (...args) => pmi(...args).dropped.map((d) => d.reason)[0];
  assert.match(why({ ...LOOSEN, sl: 3989 }), /beyond the original entry stop 3990/);
  assert.match(why({ ...LOOSEN, sl: 3992 }), /more than 50% of the way back to 3990/);
  assert.match(why({ ...LOOSEN, sl: 3997 }), /not looser than the broker's \(3996\)/);
  assert.match(why({ ...LOOSEN, sl: 3999 }, A8(), pos({ sl: 4005 }), sym(4012)), /from break-even or better the stop never goes back into loss/);
  assert.equal(pmi({ ...LOOSEN, sl: 4000 }, A8(), pos({ sl: 4005 }), sym(4012)).intents.length, 1, "to the entry is not into loss");
  assert.match(why(LOOSEN, A8({ loosened: { 7: { from_sl: 3996 } } })), /loosened once already/);
  assert.match(why(LOOSEN, A8({ original: {} })), /original entry stop is unknown/);
  assert.match(why(LOOSEN, A8(), pos({ sl: 3990 })), /not looser than the broker's|never tightened/);
  assert.match(why(LOOSEN, A8(), pos({ delegated: true, intent_id: "deleg:7" })), /delegated position is never loosened/);
  assert.match(why(LOOSEN, A8({ veto: () => true })), /Decision Engine vetoes the position's side/);
  assert.match(why(LOOSEN, A8({ blocked: "Omega is paused" })), /no loosening: Omega is paused/);
  assert.match(why(LOOSEN, A8({ riskCheck: () => "the daily loss budget would not hold at the new stop (-1)" })), /daily loss budget would not hold/);
  // The tightest commanded stop is the current one (a stale snapshot never makes the bound wider).
  assert.match(why(LOOSEN, A8({ stops: { 7: [3998] } })), /more than 50% of the way back/);
});

test("A8-9 the daily loss budget and the profile caps at the new stop, in the plan; the arm and the pause", () => {
  const ex = (over = {}) => ({ connected: true, received_ms: 1_000, positions: [pos()], executor: { version: "1.21" }, account: { trade_mode: "demo", equity: 10_000, day_start_balance: 10_000, ...over }, symbol: sym(4003) });
  const plan = (over = {}, settings = {}, extra = {}) => planIntents({ executor: ex(over), now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: false, pm_loosen_enabled: true, ...settings }, pmActions: [LOOSEN], pmLoosen: { loosened: {}, original: A8().original }, ...extra });
  assert.ok(plan().intents.some((i) => i.id === "pm:7:s:9" && i.loosen === true));
  // 0.1 lot: at 3993 the position risks 100 from the bid 4003; the 2% floor is 9,800, so 9,895 equity leaves -5.
  const tight = plan({ equity: 9_895 });
  assert.ok(!tight.intents.some((i) => i.id === "pm:7:s:9"));
  assert.match(tight.pm_dropped[0].reason, /no loosening: the daily loss budget would not hold at the new stop/);
  assert.ok(plan({ equity: 9_905 }).intents.some((i) => i.id === "pm:7:s:9"), "it holds by 5");
  // A real account not armed, and a pause: refused.
  assert.match(plan({ trade_mode: "real" }).pm_dropped[0].reason, /not armed live/);
  assert.match(plan({}, {}, { control: { mode: "paused" } }).pm_dropped[0].reason, /Omega is paused/);
  // The profile's hard cap per trade (Safe: 2%) at the new stop, from the entry: 0.1 lot x 7.00 = 0.7% passes; 0.3 lot
  // (2.1%) does not, though the day's budget would hold (the bid 4001: 240 at risk, 60 left above the 3% floor).
  const safe = (volume) => planIntents({ executor: { ...ex(), positions: [pos({ volume })], symbol: sym(4001) }, now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: false, pm_loosen_enabled: true, max_daily_loss_pct: 3 }, pmActions: [LOOSEN], pmLoosen: { loosened: {}, original: A8().original }, account: { profile: "safe", spec_status: "validated" } });
  assert.ok(safe(0.1).intents.some((i) => i.id === "pm:7:s:9"));
  assert.match(safe(0.3).pm_dropped[0].reason, /the profile's hard cap per trade \(2%\)/);
  // The tick value unverified: no loosening.
  const tv = planIntents({ executor: { ...ex(), symbol: sym(4003, { tick_value_problem: "tick_value_mismatch" }) }, now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: false, pm_loosen_enabled: true }, pmActions: [LOOSEN], pmLoosen: { loosened: {}, original: A8().original } });
  assert.match(tv.pm_dropped[0].reason, /tick_value_mismatch/);
});

test("A8-10 after a loosening the position counts as unprotected again; its later mechanical locks wait until they pass the stop before it", () => {
  assert.equal(isProtected(pos({ sl: 4005 })), true);
  assert.equal(isProtected(pos({ sl: 4005, loosened: true })), false);
  // A second BUY waits (same_side_unprotected) while the loosened one is open, whatever its stop.
  const sig = { side: "BUY", action: "ENTER_MARKET", entry: 4012, stop: 4007, tp1: 4022, issued_ms: 1_000, expires_ms: 1_000 + 3_600_000, blackout: false, kill: false, paused: false };
  const ex = { connected: true, received_ms: 1_000, positions: [pos({ sl: 4005 })], executor: { version: "1.21" }, account: { trade_mode: "demo", currency: "USD", equity: 10_000, day_start_balance: 10_000, balance: 10_000 },
    symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4012, ask: 4012.2, spread_points: 20 } };
  const base = { signal: sig, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true, max_positions: 3, tp_ladder: false }, executor: ex, now: 1_000, engineEnabled: true };
  assert.ok(planIntents(base).intents.some((i) => i.kind === "open"), "protected: a second position may open");
  const after = planIntents({ ...base, pmLoosen: { loosened: { 7: { from_sl: 4008, sl: 4005 } }, original: {} } });
  assert.ok(!after.intents.some((i) => i.kind === "open"));
  assert.ok(after.notes.some((n) => n.code === "same_side_unprotected"));
  // The records: a loosening the broker refused is none; pending, sent, done and expired ones are.
  assert.deepEqual(loosenRecords([
    { payload: JSON.stringify({ id: "pm:7:s:1", kind: "modify_sl", ticket: 7, sl: 3993, from_sl: 3996, loosen: true }), status: "done" },
    { payload: { id: "pm:8:s:1", kind: "modify_sl", ticket: 8, sl: 3993, from_sl: 3996, loosen: true }, status: "failed" },
    { payload: { id: "pm:9:s:1", kind: "modify_sl", ticket: 9, sl: 3993, from_sl: 3996, loosen: true }, status: "expired" },
    { payload: { id: "ms:10:lad:1", kind: "modify_sl", ticket: 10, sl: 3999 }, status: "done" }
  ]), { 7: { from_sl: 3996, sl: 3993, id: "pm:7:s:1" }, 9: { from_sl: 3996, sl: 3993, id: "pm:9:s:1" } });
  // The ladder after a loosening from 4005: its lock at the entry (TP0) is held; a lock beyond 4005 passes.
  const KL = { feed_basis: 0, feed_basis_known: true, key_levels: "4009:4010,4019:4020", power: 0.6, power_ms: 1_000 };
  const S = { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: true, ladder_lock_pips: 30 };
  const lad = (bid, from) => manageIntents({ positions: [pos({ sl: 3999, tp: 4030 })], sym: sym(bid), settings: S, signal: KL, positionMeta: { "open:1:B": { mode: "scalp", r_dist: 10 } }, ...(from ? { loosenedFrom: { 7: from } } : {}) }).filter((i) => i.kind === "modify_sl").map((i) => i.sl);
  assert.equal(lad(4004).length, 1, "without a loosening the ladder locks break-even");
  assert.deepEqual(lad(4004, 4005), [], "held: the lock would not pass the stop before the loosening");
  assert.deepEqual(lad(4013, 4005), [4009], "a lock beyond 4005 passes");
  // The Position Manager's own lock too.
  const pmLock = positionManagerIntents({ positions: [pos({ sl: 3999 })], sym: sym(4012), actions: [{ id: "pm:7:2", ticket: 7, action: "sl", rule: "breakeven", sl: 4000.2 }], loosenedFrom: { 7: 4005 } });
  assert.match(pmLock.dropped[0].reason, /a lock waits until it is tighter than 4005/);
  // The Position Manager already holds such a lock itself (no "not applied" line every bar), and lets a tighter one by.
  const pmHeld = positionAction(facts(4012, { sl: 3999 }, { loosened: true, from_sl: 4005 }), null);
  assert.deepEqual([pmHeld.action, pmHeld.rule], ["hold", "lock_waits_loosened"]);
  assert.deepEqual(pick(positionAction(facts(4012, { sl: 3999 }, { loosened: true, from_sl: 4000 }), null)), ["sl", "breakeven", 4000.2]);
});

test("A8-11 in the sync that loosens, no mechanical stop or target move for that position (no re-tightening from a stale snapshot)", () => {
  const KL = { feed_basis: 0, feed_basis_known: true, key_levels: "4009:4010,4019:4020", power: 0.6, power_ms: 1_000, side: "NONE" };
  const ex = { connected: true, received_ms: 1_000, positions: [pos({ sl: 4005, tp: 4030 })], executor: { version: "1.21" }, account: { trade_mode: "demo", equity: 10_000, day_start_balance: 10_000 }, symbol: sym(4016) };
  const base = { executor: ex, now: 1_000, engineEnabled: true, signal: KL, positionMeta: { "open:1:B": { mode: "scalp", r_dist: 10 } }, pmLoosen: { loosened: {}, original: { 7: { sl: 3990, mode: "scalp", r_dist: 10 } } } };
  const off = planIntents({ ...base, settings: { enabled: true, tp_ladder: true } });
  assert.ok(off.intents.some((i) => i.kind === "modify_sl" && String(i.id).startsWith("ms:7:lad:")), "the ladder locks TP1 on this snapshot");
  const loosen = { id: "pm:7:9", ticket: 7, action: "sl", rule: "loosen_atr_expansion", sl: 4002 };
  const on = planIntents({ ...base, settings: { enabled: true, tp_ladder: true, pm_loosen_enabled: true }, pmActions: [loosen] });
  const stops = on.intents.filter((i) => i.ticket === 7 && ["modify_sl", "modify_sltp", "modify_tp"].includes(i.kind));
  assert.deepEqual(stops.map((i) => [i.id, i.sl]), [["pm:7:s:9", 4002]]);
  // With the switch on, a tightening records the ATR it was made at (the reference of a later loosening); off, nothing.
  assert.equal(planIntents({ ...base, settings: { enabled: true, tp_ladder: true, pm_loosen_enabled: true } }).intents.find((i) => String(i.id).startsWith("ms:7:lad:")).atr, 6.5);
  assert.equal(off.intents.find((i) => String(i.id).startsWith("ms:7:lad:")).atr, undefined);
});

test("A8-12 the council's schema and messages with the switch on; its asks are stored after its reason", () => {
  assert.deepEqual(POSITION_COUNCIL_SCHEMA_A8.required, [...POSITION_COUNCIL_SCHEMA.required, "stop", "stop_reason", "target", "target_reason"]);
  const msgs = positionCouncilMessages(facts(4003), { levels: [] });
  assert.match(msgs[0].content, /Amendment 8/);
  assert.match(msgs[0].content, /you never choose the action, a size or a price/);
  const ev = JSON.parse(msgs[1].content);
  assert.deepEqual(ev.amendment_8, { original_stop: 3990, stop_tightened: true, loosened_once: false, atr_15m_now: 6.5, atr_15m_reference: 4, atr_reference_from: "entry", atr_expand_threshold: 1.5, back_share: 0.5, high_impact_release: null });
  assert.equal(councilText(cleanCouncilA8(C())), "holding, thesis intact: r [stop loosen: atr_expansion]");
  assert.equal(councilText(cleanCouncilA8({ momentum: "holding", thesis: "intact", reason: "r" })), "holding, thesis intact: r", "the stored text is today's without an ask");
  assert.equal(cleanCouncilA8({ momentum: "up" }), null);
});

test("A8-13 the Telegram lines: \"Stop loosened\" and \"TP moved\", with the reason, the mode and R", () => {
  const row = { ticket: 7, side: "BUY", pips: 30, action: "sl", rule: "loosen_atr_expansion", sl: 3993, why: positionAction(facts(4003), C()).why, council: "holding, thesis intact: r [stop loosen: atr_expansion]" };
  const line = actionMessage(row);
  assert.match(line, /^XAUUSD POSITION MANAGER · #7 BUY · \+30 pips · Stop loosened to 3993 · applied at the broker\nstop loosened 3996 → 3993 \(ATR\(14, 15m\) 6\.5 is 1\.63x the 4 at entry \(threshold 1\.5x\)\); intraday; the stop from 0\.4R at risk to 0\.7R at risk/);
  assert.match(actionMessage({ ...row, action: "tp", rule: "tp_nearer_key_level_before", sl: null, tp: 4010, why: "w" }, { applied: false, reason: "x" }), /TP moved nearer to 4010 · NOT applied: x/);
  assert.match(actionMessage({ ticket: 7, side: "BUY", pips: 1, action: "sl", rule: "breakeven", sl: 4000.2, why: "w" }), /· stop to 4000\.2 · applied/, "today's lines are unchanged");
});

// ---------------------------------------------------------------------------------------------------- the runner and the sync
function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
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
const NOW = Date.parse("2026-11-20T15:30:00Z");
function env() { resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests(); return { DB: d1(), SIGNAL_CACHE: (() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; })(), OMEGA_ENGINE_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c", POSITION_MANAGER_MODE: "live", POSITION_COUNCIL_DAILY_USD: "5" }; }

test("A8-14 the runner: with the switch on it asks the amendment's schema and stores the loosening; once only; off, today's call", async () => {
  const e = env();
  await writeSettings(e, { body: { enabled: true, tp_ladder: false, pm_loosen_enabled: true }, actor: "owner" }, { now: NOW });
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, PRIMARY KEY (day, source, model))");
  const calls = [];
  const call = async (_e, req) => { calls.push(req); return { status: "answered", obj: C({ reason: "ATR doubled into the session open" }) }; };
  const base = { call, executor: { positions: [pos()], symbol: sym(4003) }, openIntents: { "open:1:B": INTENT }, signal: null, decision: DEC, events: [] };
  const r = await runPositionManager(e, { ...base, now: NOW });
  assert.deepEqual(r.positions.map((p) => [p.action, p.rule]), [["sl", "loosen_atr_expansion"]]);
  assert.equal(calls[0].schema, POSITION_COUNCIL_SCHEMA_A8);
  const row = e.DB.raw.prepare("SELECT sl, status, council FROM position_actions WHERE rule = 'loosen_atr_expansion'").get();
  assert.deepEqual({ ...row }, { sl: 3993, status: "pending", council: "holding, thesis intact: ATR doubled into the session open [stop loosen: atr_expansion]" });
  // The next bar: one loosening is pending, so none again.
  const r2 = await runPositionManager(e, { ...base, now: NOW + 300_000 });
  assert.equal(r2.positions[0].action, "hold");
  assert.match(e.DB.raw.prepare("SELECT why FROM position_actions WHERE bar = ?").get(Math.floor((NOW + 300_000) / 300_000)).why, /loosened once already/);
  // Off: today's schema and no amendment fields.
  await writeSettings(e, { body: { pm_loosen_enabled: false }, actor: "owner" }, { now: NOW });
  await runPositionManager(e, { ...base, now: NOW + 600_000 });
  assert.equal(calls.at(-1).schema, POSITION_COUNCIL_SCHEMA);
  // A silent council: no action at all.
  await writeSettings(e, { body: { pm_loosen_enabled: true }, actor: "owner" }, { now: NOW });
  const silent = await runPositionManager(e, { ...base, call: async () => ({ status: "failed" }), now: NOW + 900_000, executor: { positions: [pos({ ticket: 8 })], symbol: sym(4003) } });
  assert.deepEqual(silent.positions.map((p) => [p.action, p.rule]), [["hold", "inside_band"]]);
});

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const STATE = (over = {}) => ({
  connected: true, server: "AnyBroker-Demo", received_ms: NOW - 1000, executor: { version: "1.21" },
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4003, ask: 4003.2, spread_points: 20, atr_value: 6.5 },
  positions: [], ...over
});
async function withTelegram(fn) {
  const sent = [], orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes("api.telegram.org")) sent.push(JSON.parse(init.body).text); return new Response("{}"); };
  try { await fn(sent); } finally { globalThis.fetch = orig; }
  return sent;
}
const sync = (e, over = {}, now = NOW) => bridgeSync(e, { state: STATE(), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0", ...over }, { now, signal: null });

test("A8-15 the sync: the loosening reaches the broker once, is said as \"Stop loosened\" and logged in omega_events with R only", async () => {
  const e = env();
  await sync(e);
  await writeSettings(e, { body: { enabled: true, tp_ladder: false, pm_loosen_enabled: true }, actor: "owner" }, { now: NOW });
  await ensurePositionSchema(e.DB);
  e.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES ('open:1:B', 'open', ?, 'done', ?, ?)").run(JSON.stringify({ id: "open:1:B", kind: "open", side: "BUY", entry: 4000, sl: 3990, tp: 4020, mode: "intraday", r_dist: 10, atr_entry: 4 }), NOW - 3_600_000, NOW - 3_600_000);
  const at = NOW - 60_000, bar = Math.floor(at / 300_000);
  const why = positionAction(facts(4003), C()).why;
  const ins = (id, b) => e.DB.raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, council, status) VALUES (?, 7, ?, ?, 'BUY', 30, 4003, 'sl', 'loosen_atr_expansion', 3993, NULL, ?, 'holding, thesis intact: r [stop loosen: atr_expansion]', 'pending')").run(id, b, at, why);
  ins(`pm:7:${bar}`, bar);
  const P = pos();
  const planned = await withTelegram(async () => { await sync(e, { state: STATE({ positions: [P] }) }); });
  assert.equal(planned.filter((t) => /POSITION MANAGER/.test(t)).length, 0, "said when the broker answers");
  const it = JSON.parse(e.DB.raw.prepare("SELECT payload FROM omega_intents WHERE id LIKE 'pm:7:s:%'").get().payload);
  assert.deepEqual([it.kind, it.sl, it.loosen, it.from_sl, it.orig_sl, it.reason], ["modify_sl", 3993, true, 3996, 3990, "pm_loosen_atr_expansion"]);
  const answered = await withTelegram(async () => { await sync(e, { results: [{ id: it.id, ok: true, ticket: 7, executed_ms: NOW + 1_500 }], state: STATE({ positions: [P] }) }, NOW + 2_000); });
  const line = answered.find((t) => /POSITION MANAGER/.test(t));
  assert.match(line, /#7 BUY · \+30 pips · Stop loosened to 3993 · applied at the broker/);
  assert.match(line, /intraday; the stop from 0\.4R at risk to 0\.7R at risk/);
  const ev = e.DB.raw.prepare("SELECT actor, detail FROM omega_events WHERE action = 'pm_stop_loosened'").all();
  assert.equal(ev.length, 1);
  const detail = JSON.parse(ev[0].detail);
  assert.deepEqual(detail, { intent_id: it.id, ticket: 7, rule: "loosen_atr_expansion", mode: "intraday", applied: true, risk_r_before: 0.4, risk_r_after: 0.7 });
  assert.doesNotMatch(ev[0].detail, /399\d|login|account/, "no price, no account");
  // A second loosening of the same position: dropped, once only.
  ins(`pm:7:${bar + 1}`, bar + 1);
  const again = await withTelegram(async () => { await sync(e, { state: STATE({ positions: [{ ...P, sl: 3993 }] }) }, NOW + 3_000); });
  assert.match(again.find((t) => /POSITION MANAGER/.test(t)), /Stop loosened to 3993 · NOT applied: no loosening: this position was loosened once already/);
});
