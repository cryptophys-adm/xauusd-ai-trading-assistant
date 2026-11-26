// Track A PR 7: the London and New York opening ranges (src/opening-range.mjs) and the orb_breakout strategy agent
// (src/strategy-agents.mjs), the plan learner's record of its two sessions, and the agent in the Decision Engine.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openingRanges, orbMode, OPENING_RANGE_SESSIONS } from "../src/opening-range.mjs";
import { STRATEGY_AGENTS, AGENT_RULES, agentStatuses, agentContext, suspendedPatterns, PATTERN_BREAKER } from "../src/strategy-agents.mjs";
import { setupsFrom, setupOutcome, agentRecords, decisionPlans, CONTROL_ARM } from "../src/plan-learning.mjs";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import { zoneInputs, zoneGlobal, ZONE_ENV, CLOSE, NOW } from "./support/zone-types-fixture.mjs";
import { execFileSync } from "node:child_process";
import { orbLevelsMode, orbLevelsModes } from "../src/opening-range.mjs";
import { rawLevels, buildKeyLevels, clusterLevels, familyOf, ORB_LEVEL_WEIGHT } from "../src/key-level-agent.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import { pickStrategy } from "../src/decision-engine.mjs";
import { applyRangeMode, RANGE_GATED_AGENTS } from "../src/htf-cells.mjs";

const M15 = 15 * 60_000;
const orb = STRATEGY_AGENTS.find((a) => a.id === "orb_breakout");
const iso = (ms) => new Date(ms).toISOString();
// Tuesday 2026-11-24, US and UK standard time: London opens 08:00Z (03:00 New York), New York 13:00Z.
const LDN = Date.UTC(2026, 10, 24, 8, 0), NYO = Date.UTC(2026, 10, 24, 13, 0);
/** 15m bars from `from` to `to` (open times), flat at 2600 unless `at` gives [high, low, close] for an open time. */
function series(from, to, at = {}) {
  const out = [];
  for (let t = from; t < to; t += M15) {
    const [high, low, close] = at[t] ?? [2602, 2598, 2600];
    out.push({ open_time: iso(t), close_time: iso(t + M15), open: close, high, low, close });
  }
  return out;
}
/** The London range 2595-2605 (three bars), a close above it at 08:45, then bars holding above the range's middle. */
function londonBreak({ until = LDN + 2 * 3_600_000, hold = [2608, 2604, 2606] } = {}) {
  const at = { [LDN]: [2605, 2597, 2600], [LDN + M15]: [2604, 2595, 2601], [LDN + 2 * M15]: [2603, 2596, 2602], [LDN + 3 * M15]: [2610, 2603, 2609] };
  for (let t = LDN + 4 * M15; t < until; t += M15) at[t] = hold;
  return series(LDN - 4 * M15, until, at);
}
const ctx = (bars, over = {}) => ({ ...agentContext({ bars }), price: 2605.5, atr: 8, levels: [{ low: 2629, high: 2631, price: 2630, major: true }, { low: 2569, high: 2571, price: 2570, major: true }], ...over });

test("ORB-1 openingRanges: the first three 15m bars of each session, its window and why a range is not traded", () => {
  const bars = londonBreak();
  const [london, ny] = openingRanges(bars);
  assert.deepEqual(OPENING_RANGE_SESSIONS.map((s) => s.key), ["orb_london", "orb_new_york"]);
  assert.deepEqual([london.status, london.open_ms, london.range_end_ms, london.high, london.low, london.mid, london.width], ["ok", LDN, LDN + 3 * M15, 2605, 2595, 2600, 10]);
  // London ends at its last 15m bar before 12:00 New York (16:45Z in standard time).
  assert.equal(london.end_ms, Date.UTC(2026, 10, 24, 16, 45));
  // New York has not opened yet today: its latest open is yesterday's, whose window is over.
  assert.equal(ny.status, "window_over");
  // Before the range closes: not formed; after the window: over.
  assert.equal(openingRanges(series(LDN - 4 * M15, LDN + 2 * M15))[0].status, "not_formed");
  assert.equal(openingRanges(bars, { now: Date.UTC(2026, 10, 24, 16, 45) })[0].status, "window_over");
  // A missing range bar: incomplete.
  assert.equal(openingRanges(bars.filter((b) => b.open_time !== iso(LDN + M15)))[0].status, "range_incomplete");
  // A high-impact USD release inside the range: not traded; a medium one, one of another currency or one after the range: traded.
  const ev = (time, impact = "High", currency = "USD") => [{ title: "release", time: iso(time), impact, currency }];
  assert.equal(openingRanges(bars, { events: ev(LDN + 30 * 60_000) })[0].status, "range_event");
  assert.equal(openingRanges(bars, { events: ev(LDN + 30 * 60_000, "Medium") })[0].status, "ok");
  assert.equal(openingRanges(bars, { events: ev(LDN + 30 * 60_000, "High", "EUR") })[0].status, "ok");
  assert.equal(openingRanges(bars, { events: ev(LDN + 3 * M15) })[0].status, "ok", "the range's end is outside it");
  // The New York range of the same day.
  const nyBars = series(NYO - 4 * M15, NYO + 4 * M15, { [NYO]: [2612, 2600, 2605] });
  const n = openingRanges(nyBars)[1];
  assert.deepEqual([n.status, n.open_ms, n.end_ms, n.high, n.low], ["ok", NYO, Date.UTC(2026, 10, 24, 21, 45), 2612, 2598]);
});

test("ORB-2 the weeks the US and the UK change clocks on different dates: London is silent (session_clock_mismatch)", () => {
  // Tuesday 2026-10-27: the UK on winter time since 25 October, the US on summer time until 1 November. 03:00 New York
  // is 07:00 in London, not 08:00.
  const open = Date.UTC(2026, 9, 27, 7, 0);
  const bars = series(open - 4 * M15, open + 8 * M15, { [open + 3 * M15]: [2610, 2603, 2609] });
  const [london] = openingRanges(bars);
  assert.deepEqual([london.status, london.open_ms], ["session_clock_mismatch", open]);
  assert.equal(orb.plan(1, ctx(bars)), null);
  // The week after (both on winter time) London is read again.
  assert.equal(openingRanges(londonBreak())[0].status, "ok");
});

test("ORB-3 the plan: a 15m close beyond the range, entry on the retest of the broken edge, the stop behind the middle; never a stop entry", () => {
  const bars = londonBreak();
  const p = orb.plan(1, ctx(bars));
  assert.deepEqual([p.agent, p.pattern, p.chart, p.valid_until_ms, p.at_level, p.entry, p.tp1], ["orb_breakout", "orb_london", "15m", Date.UTC(2026, 10, 24, 16, 45), true, 2605.5, 2629]);
  // The middle (2600) is below the breakout bar's low (2603): the stop is the middle less the pad.
  assert.equal(p.stop, 2600 - AGENT_RULES.pad_atr * 8);
  assert.match(p.stop_note, /middle of the London opening range/);
  assert.match(p.setup, /a 15m close above the London opening range/);
  assert.ok(!/\d/.test(`${p.setup.replace("15m", "")} ${p.entry_note} ${p.stop_note}`), "notes in words only (the chart name aside)");
  // Price well above the edge: a limit at the edge (below price for a long), never an entry above price.
  const far = orb.plan(1, ctx(bars, { price: 2609 }));
  assert.deepEqual([far.at_level, far.entry], [false, 2605]);
  for (const price of [2605.5, 2607, 2609, 2612]) {
    const q = orb.plan(1, ctx(bars, { price }));
    if (q) assert.ok(q.entry <= price, `long entry at or below price ${price}`);
  }
  // No short plan: nothing closed below the range.
  assert.equal(orb.plan(-1, ctx(bars, { price: 2596 })), null);
});

test("ORB-4 no plan: back inside the range, a close back through the middle, a range too narrow or too wide, a held pattern", () => {
  const bars = londonBreak();
  const B = AGENT_RULES.breakout;
  // Price back inside the range by more than the retest band.
  assert.equal(orb.plan(1, ctx(bars, { price: 2605 - B.retest_atr * 8 - 0.5 })), null);
  // A close back through the middle after the break ends the side for the window.
  const failed = londonBreak().map((b) => (b.open_time === iso(LDN + 5 * M15) ? { ...b, low: 2598, close: 2599 } : b));
  assert.equal(orb.plan(1, ctx(failed)), null);
  // No 15m close beyond the edge by the breakout band.
  const weak = londonBreak({ hold: [2604, 2601, 2603] }).map((b) => (b.open_time === iso(LDN + 3 * M15) ? { ...b, high: 2606, close: 2605.2 } : b));
  assert.equal(orb.plan(1, ctx(weak, { price: 2604 })), null);
  // The range's width against the 1H ATR (10 here): under the floor or over the ceiling.
  assert.equal(orb.plan(1, ctx(bars, { atr: 10 / (AGENT_RULES.orb.min_width_atr * 0.9) })), null, "too narrow");
  assert.equal(orb.plan(1, ctx(bars, { atr: 10 / (AGENT_RULES.orb.max_width_atr * 1.1) })), null, "too wide");
  // The breaker holds orb_london back.
  assert.equal(orb.plan(1, ctx(bars, { suspendedPatterns: ["orb_breakout:orb_london"] })), null);
  assert.ok(orb.plan(1, ctx(bars, { suspendedPatterns: ["orb_breakout:orb_new_york"] })));
  // A release inside the range (the engine's calendar events reach the agent through agentContext).
  assert.equal(orb.plan(1, { ...ctx(bars), ...agentContext({ bars, events: [{ time: iso(LDN + 30 * 60_000), impact: "High", currency: "USD" }] }), price: 2605.5, atr: 8, levels: ctx(bars).levels }), null);
  assert.deepEqual(agentContext({}).events, []);
});

test("ORB-5 the short side mirrors the long, and New York wins where both sessions have a plan on a side", () => {
  const at = { [LDN]: [2605, 2597, 2600], [LDN + M15]: [2604, 2595, 2599], [LDN + 2 * M15]: [2603, 2596, 2598], [LDN + 3 * M15]: [2597, 2590, 2591] };
  for (let t = LDN + 4 * M15; t < LDN + 8 * M15; t += M15) at[t] = [2596, 2592, 2594];
  const short = orb.plan(-1, ctx(series(LDN - 4 * M15, LDN + 8 * M15, at), { price: 2594.5 }));
  assert.deepEqual([short.pattern, short.at_level, short.entry, short.stop, short.tp1], ["orb_london", true, 2594.5, 2600 + AGENT_RULES.pad_atr * 8, 2571]);
  assert.ok(short.entry >= 2594.5, "short entry at or above price");
  // One day with both: London broke up in the morning and New York's range (above it) broke up after 13:45Z.
  const both = { ...Object.fromEntries(londonBreak({ until: NYO }).map((b) => [Date.parse(b.open_time), [b.high, b.low, b.close]])) };
  both[NYO] = [2615, 2608, 2610]; both[NYO + M15] = [2614, 2607, 2611]; both[NYO + 2 * M15] = [2613, 2606, 2612]; both[NYO + 3 * M15] = [2620, 2614, 2619];
  for (let t = NYO + 4 * M15; t < NYO + 6 * M15; t += M15) both[t] = [2618, 2614, 2616];
  const day = series(LDN - 4 * M15, NYO + 6 * M15, both);
  const [l, n] = openingRanges(day);
  assert.deepEqual([l.status, n.status], ["ok", "ok"]);
  const p = orb.plan(1, ctx(day, { price: 2615.5 }));
  assert.equal(p.pattern, "orb_new_york");
  // With New York held, London's plan is the one left on that side.
  const q = orb.plan(1, ctx(day, { price: 2615.5, suspendedPatterns: ["orb_breakout:orb_new_york"] }));
  assert.equal(q?.pattern, "orb_london");
});

test("ORB-6 the switches: live in the shipped wrangler.jsonc (owner, 2026-11-26), off through STRATEGY_AGENTS_OFF or the agents' mode", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const live = text.match(/"STRATEGY_AGENTS_LIVE":\s*"([^"]*)"/)[1];
  assert.ok(live.split(",").includes("orb_breakout"));
  assert.equal(agentStatuses({ STRATEGY_AGENTS_LIVE: live }).orb_breakout, "live");
  assert.equal(agentStatuses({ STRATEGY_AGENTS_LIVE: live, STRATEGY_AGENTS_OFF: "orb_breakout" }).orb_breakout, "off");
  assert.deepEqual([orbMode({}), orbMode({ STRATEGY_AGENTS_OFF: "Orb_Breakout" }), orbMode({ STRATEGY_AGENTS_MODE: "off" })], ["on", "off", "off"]);
  assert.equal(orb.version, 1);
  assert.deepEqual(Object.keys(orb.variants), ["orb_london", "orb_new_york"]);
});

test("ORB-7 plan learning: each session is its own pattern, the plan lapses at the window's end, the breaker holds a session at 15", () => {
  // After 12:00Z price drifts higher, short of the target.
  const bars = londonBreak({ until: Date.UTC(2026, 10, 24, 18, 0) }).map((b) => (Date.parse(b.open_time) >= Date.UTC(2026, 10, 24, 12) ? { ...b, open: 2611, high: 2612, low: 2608, close: 2611 } : b));
  const close = LDN + 4 * M15 + M15;
  const p = orb.plan(1, ctx(bars.filter((b) => Date.parse(b.close_time) <= close)));
  const row = { decision_key: `OANDA:XAUUSD:15:${close - M15}`, decided_at: iso(close), side: "BUY", atr_h1: 8, mode: "intraday", regime: "normal-trending", plans: { long: { orb_breakout: { ...p, pattern: p.pattern, chart: p.chart, valid_until_ms: p.valid_until_ms } } } };
  const [d] = decisionPlans(row);
  assert.deepEqual([d.agent, d.pattern, d.chart, d.valid_until_ms], ["orb_breakout", "orb_london", "15m", p.valid_until_ms]);
  const [s] = setupsFrom([d]);
  assert.deepEqual([s.pattern, s.chart, s.valid_until_ms], ["orb_london", "15m", Date.UTC(2026, 10, 24, 16, 45)]);
  // Price holds above the entry and never reaches the target: the winner closes at the window's end ("lapse").
  const out = setupOutcome(s, bars.filter((b) => Date.parse(b.open_time) >= close), { now: Date.UTC(2026, 10, 25) });
  assert.equal(out.results[CONTROL_ARM].s, "lapse");
  assert.ok(out.results[CONTROL_ARM].r > 0);
  // The record per session; the breaker holds one with 15 resolved setups and a negative mean, not the other.
  const res = (pattern, r) => ({ agent: "orb_breakout", pattern, chart: "15m", context: "intraday|normal-trending", results: { [CONTROL_ARM]: { s: r < 0 ? "stop" : "target", r, f: 1 } } });
  const rec = agentRecords([...Array.from({ length: PATTERN_BREAKER.min_setups }, () => res("orb_london", -1)), ...Array.from({ length: 20 }, () => res("orb_new_york", 0.5))]);
  assert.deepEqual(rec[0].patterns.map((x) => [x.pattern, x.setups, x.mean_r]), [["orb_london", 15, -1], ["orb_new_york", 20, 0.5]]);
  assert.deepEqual(rec[0].pattern_charts.map((x) => x.key), ["orb_london@15m", "orb_new_york@15m"]);
  assert.deepEqual(suspendedPatterns(rec).map((x) => `${x.agent}:${x.id}`), ["orb_breakout:orb_london"]);
  assert.equal(PATTERN_BREAKER.min_setups, 15);
});

test("ORB-8 the Decision Engine: the scenario's London breakout is an orb_breakout plan; a release in the range or the switch off silences it", () => {
  const decide = (env, events = []) => {
    const inputs = { ...zoneInputs(), calendar: { events } };
    const strategy = se.buildStrategy(inputs);
    const loaded = { inputs, strategy, global: zoneGlobal(), correlations: null, regime: "normal-trending" };
    const assessment = de.assess(loaded, { now: NOW, env });
    return de.buildDecisionRecord({ key: `OANDA:XAUUSD:15:${Date.parse(CLOSE) - M15}`, barClose: CLOSE, loaded, assessment, council: null, now: NOW, env });
  };
  const on = decide({ ...ZONE_ENV, STRATEGY_AGENTS_OFF: "" });
  const plan = on.strategy_plans.short.orb_breakout;
  assert.deepEqual([plan.pattern, plan.chart, plan.at_level, plan.valid_until_ms], ["orb_london", "15m", false, Date.UTC(2026, 10, 20, 16, 45)]);
  assert.ok(plan.entry > plan.tp1 && plan.stop > plan.entry, "a short limit above its target, the stop above it");
  assert.equal(on.strategy_plans.long.orb_breakout, undefined);
  const release = decide({ ...ZONE_ENV, STRATEGY_AGENTS_OFF: "" }, [{ title: "release", currency: "USD", time: "2026-11-20T08:30:00.000Z", impact: "High" }]);
  assert.equal(release.strategy_plans.short.orb_breakout, undefined);
  const off = decide(ZONE_ENV);
  assert.equal(off.strategy_plans.short.orb_breakout, undefined);
  // Everything but the new agent's plan is the same with it on or off.
  const strip = (r) => JSON.stringify({ ...r, strategy_plans: { long: r.strategy_plans.long, short: Object.fromEntries(Object.entries(r.strategy_plans.short).filter(([k]) => k !== "orb_breakout")) } });
  assert.equal(strip(on), strip(off));
});

// ---------------------------------------------------------------- Track A PR 7 acceptance, completed in PR 8

test("ORB-9 the window's end: a plan at the 11:30 and 16:30 New York closes, none at 11:45 or 16:45", () => {
  // London: its window's last close is 11:30 New York (16:30Z in standard time); New York's 16:30 New York (21:30Z).
  const long = londonBreak({ until: Date.UTC(2026, 10, 24, 17, 0) });
  const upTo = (bars, t) => bars.filter((b) => Date.parse(b.close_time) <= t);
  assert.equal(orb.plan(1, ctx(upTo(long, Date.UTC(2026, 10, 24, 16, 30))))?.pattern, "orb_london");
  assert.equal(orb.plan(1, ctx(upTo(long, Date.UTC(2026, 10, 24, 16, 45)))), null);
  const at = { [NYO]: [2605, 2597, 2600], [NYO + M15]: [2604, 2595, 2601], [NYO + 2 * M15]: [2603, 2596, 2602], [NYO + 3 * M15]: [2610, 2603, 2609] };
  for (let t = NYO + 4 * M15; t < Date.UTC(2026, 10, 24, 22, 0); t += M15) at[t] = [2608, 2604, 2606];
  const ny = series(NYO - 4 * M15, Date.UTC(2026, 10, 24, 22, 0), at);
  assert.equal(orb.plan(1, ctx(upTo(ny, Date.UTC(2026, 10, 24, 21, 30))))?.pattern, "orb_new_york");
  assert.equal(orb.plan(1, ctx(upTo(ny, Date.UTC(2026, 10, 24, 21, 45)))), null);
});

test("ORB-10 the spring weeks too: 2026-03-16, London's 03:00 New York is 07:00 in London (session_clock_mismatch)", () => {
  const open = Date.UTC(2026, 2, 16, 7, 0);
  const bars = series(open - 4 * M15, open + 8 * M15, { [open + 3 * M15]: [2610, 2603, 2609] });
  assert.deepEqual([openingRanges(bars)[0].status, openingRanges(bars)[0].open_ms], ["session_clock_mismatch", open]);
  assert.equal(orb.plan(1, ctx(bars)), null);
});

test("ORB-11 the gates: pickStrategy can pick orb_breakout; the range mode keeps it out (not a range agent)", () => {
  const plan = orb.plan(1, ctx(londonBreak()));
  const picked = pickStrategy({ side: "long", speakers: [{ id: "orb_breakout" }], plans: { orb_breakout: { status: "live", plan } }, agentConfidence: { orb_breakout: { long: 0.7 } }, quorum: { long_share: 0.8 }, stance: "BUY", opts: { minRrr: 1 } });
  assert.deepEqual([picked.agent, picked.trade?.strategy, picked.trade?.pattern, picked.trade?.chart], ["orb_breakout", "orb_breakout", "orb_london", "15m"]);
  assert.equal(RANGE_GATED_AGENTS.includes("orb_breakout"), false);
  const sig = { trading_mode: "range", side: "BUY", trade_agent: "orb_breakout", signal_id: "s1", action: "ENTER_LIMIT", entry: 1, stop: 1, tp1: 1 };
  assert.deepEqual([applyRangeMode(sig, { regime: "normal-ranging" }).side, applyRangeMode(sig, { regime: "normal-ranging" }).awaiting_reason], ["NONE", "range_mode_agent"]);
});

test("ORB-12 words only: no three-to-five-digit number in the agent's fits, setup or notes; a fresh process imports either module first", () => {
  const p = orb.plan(1, ctx(londonBreak()));
  for (const text of [orb.fits, orb.label, ...Object.values(orb.variants), p.setup, p.entry_note, p.stop_note]) assert.ok(!/\d{3,5}/.test(text), text);
  for (const first of ["opening-range", "strategy-agents"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const a = await import(${JSON.stringify(new URL(`../src/${first}.mjs`, import.meta.url).href)}); const m = await import(${JSON.stringify(new URL("../src/strategy-agents.mjs", import.meta.url).href)}); console.log(m.AGENT_IDS.length, m.AGENT_IDS.includes("orb_breakout"), typeof a.openingRanges === "function" || typeof a.agentContext === "function");`], { encoding: "utf8" }).trim();
    assert.equal(out, "14 true true", first);
  }
});

// ---------------------------------------------------------------- Track A PR 8: the edges as key levels

test("ORB-13 rawLevels: the live range's edges in the session family on the 15m chart, words only; none outside the window or off", () => {
  const bars = londonBreak();
  const edges = rawLevels({ bars: { M15: bars } }).filter((l) => /opening range/.test(l.label));
  assert.deepEqual(edges.map((l) => [l.label, l.price, l.kind, l.tf, l.weight, l.reader]), [
    ["London opening range low", 2595, "open", "15", ORB_LEVEL_WEIGHT, "session"],
    ["London opening range high", 2605, "open", "15", ORB_LEVEL_WEIGHT, "session"]
  ]);
  assert.equal(ORB_LEVEL_WEIGHT, 0.5);
  assert.equal(familyOf("open"), "session");
  assert.ok(edges.every((l) => !/\d/.test(l.label)), "labels in words");
  const none = (b, opts = {}) => rawLevels({ bars: { M15: b }, ...opts }).filter((l) => /opening range/.test(l.label)).length;
  assert.equal(none(bars, { orbLevels: "off" }), 0, "off");
  assert.equal(none(series(LDN - 4 * M15, LDN + 2 * M15)), 0, "not formed");
  // At 17:00Z London's window is over; New York's range (13:00 to 13:45Z) is live, so only its edges are there.
  const late = rawLevels({ bars: { M15: londonBreak({ until: Date.UTC(2026, 10, 24, 17, 0) }) } }).filter((l) => /opening range/.test(l.label)).map((l) => l.label);
  assert.deepEqual(late, ["New York opening range low", "New York opening range high"], "London after its window");
  assert.equal(none(bars.filter((b) => b.open_time !== iso(LDN + M15))), 0, "a range bar missing");
});

test("ORB-14 the edges never make a candidate alone: one family, weight 0.5, beside other levels or not", () => {
  // Alone: a zone of the two edges' session family only.
  const lone = clusterLevels(rawLevels({ bars: { M15: londonBreak() } }).filter((l) => /opening range/.test(l.label)), 3, 2600);
  assert.ok(lone.length >= 1 && lone.every((z) => !z.candidate && z.sources === 1));
  // Beside two other families at the same price: three families, the session family's 0.5 the only addition.
  const others = [{ price: 2605, kind: "swing", tf: "60", label: "1H swing high", weight: 1.35 }, { price: 2605.2, kind: "pivot", tf: "D", label: "daily pivot", weight: 2.5 }];
  const edge = rawLevels({ bars: { M15: londonBreak() } }).filter((l) => l.label === "London opening range high");
  const [withEdge] = clusterLevels([...others, ...edge].sort((a, b) => a.price - b.price), 1, 2590);
  const [without] = clusterLevels(others, 1, 2590);
  assert.deepEqual([withEdge.sources, without.sources, Math.round((withEdge.score - without.score) * 100) / 100], [3, 2, 0.5]);
});

test("ORB-15 the switch: ORB_LEVELS and orb_breakout's switch; it travels in the inputs only when off; buildKeyLevels honours it", async () => {
  assert.deepEqual([orbLevelsMode({}), orbLevelsMode({ ORB_LEVELS: "OFF" }), orbLevelsMode({ STRATEGY_AGENTS_OFF: "orb_breakout" }), orbLevelsMode({ STRATEGY_AGENTS_MODE: "off" })], ["on", "off", "off", "off"]);
  assert.deepEqual([orbLevelsModes({}), orbLevelsModes({ ORB_LEVELS: "off" })], [{}, { orbLevels: "off" }]);
  assert.equal("orbLevels" in (await se.loadStrategyInputs({}, { now: NOW })).modes, false, "the default inputs are as before");
  assert.equal((await se.loadStrategyInputs({ ORB_LEVELS: "off" }, { now: NOW })).modes.orbLevels, "off");
  assert.deepEqual(slimInputs({ ...zoneInputs(), modes: { orbLevels: "off" } }).modes, { orbLevels: "off" }, "the capture keeps it");
  assert.equal("modes" in slimInputs({ ...zoneInputs(), modes: { orbLevels: "on" } }), false);
  const args = { bars: { M15: londonBreak() }, price: 2600, atrH1: 8 };
  const has = (r) => r.zones.some((z) => (z.members ?? []).some((m) => /opening range/.test(m.label)));
  assert.equal(has(buildKeyLevels(args)), true);
  assert.equal(has(buildKeyLevels({ ...args, orbLevels: "off" })), false);
});

test("ORB-16 the zone scenario with the edges on: only the zones they join change (wider, the session family added), the candidates do not", () => {
  const on = se.buildStrategy(zoneInputs()), off = se.buildStrategy({ ...zoneInputs(), modes: { orbLevels: "off" } });
  const cand = (s) => JSON.stringify(s.key_levels.zones.filter((z) => z.candidate).map((z) => [z.low, z.high, z.score, z.role]));
  assert.equal(cand(on), cand(off), "the candidates are those of off");
  const touched = on.key_levels.zones.filter((z) => (z.members ?? []).some((m) => /opening range/.test(m.label)));
  assert.deepEqual(touched.map((z) => [z.candidate, z.families.includes("session")]), [[false, true], [false, true]]);
  assert.equal(on.key_levels.zones.length, off.key_levels.zones.length);
  // The public reading carries the words only.
  assert.ok(!JSON.stringify(on.key_levels.summary ?? "").match(/opening range (high|low)[^,;]*\d{3,5}/));
});
