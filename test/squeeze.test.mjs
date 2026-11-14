// The squeeze guardrail (owner 2026-11-13: "jika masuk zone kejepit abstain, sehingga akan no trade", then
// "no trade"): no entry while the nearest key zones below and above price are less than one 1H average
// range apart.
import test from "node:test";
import assert from "node:assert/strict";
import { squeezeOf, SQUEEZE_RULE } from "../src/strategy-engine.mjs";
import { assess, buildDecisionRecord, decide, decisionKeyFor, guardrailsFor, squeezeGuardEnabled } from "../src/decision-engine.mjs";
import { guardrailIds } from "../src/doctrine-facts.mjs";

const zone = (low, high, candidate = true) => ({ low, high, price: (low + high) / 2, candidate, ...(candidate ? {} : { qualified: true }) });
const strategyOf = (zones, price = 4000, atr = 10) => ({ decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price, atr_h1: atr, key_levels: { zones }, plan: { at_level: true } });

test("squeezeOf: the corridor between the nearest candidate zones below and above price, against one 1H average range", () => {
  assert.equal(SQUEEZE_RULE.corridor_atr, 1);
  // 3 below, 4 above: 7 apart, less than the 10 of one 1H average range.
  assert.deepEqual(squeezeOf(strategyOf([zone(3990, 3997), zone(4004, 4010), zone(3960, 3962), zone(4040, 4042)])), { squeezed: true, corridor: 7, corridor_atr: 0.7, needed: 10, below: { low: 3990, high: 3997 }, above: { low: 4004, high: 4010 } });
  // Exactly one range apart is room enough; so is anything wider.
  assert.equal(squeezeOf(strategyOf([zone(3990, 3995), zone(4005, 4010)])).squeezed, false);
  assert.deepEqual([squeezeOf(strategyOf([zone(3980, 3985), zone(4030, 4032)])).corridor, squeezeOf(strategyOf([zone(3980, 3985), zone(4030, 4032)])).corridor_atr], [45, 4.5]);
  // Qualified zones that are not candidates are too dense to measure room with: they do not count.
  assert.equal(squeezeOf(strategyOf([zone(3990, 3997, false), zone(4004, 4010, false), zone(3960, 3962), zone(4040, 4042)])).squeezed, false);
  // A candidate price is at (inside it, or within a third of the agent's tolerance: 1 here) is the place of the trade, not a wall.
  const at = squeezeOf(strategyOf([zone(3996, 3999.5), zone(4004, 4010), zone(3960, 3962)]));
  assert.deepEqual([at.squeezed, at.below, at.corridor], [false, { low: 3960, high: 3962 }, 42]);
  assert.equal(squeezeOf(strategyOf([zone(3996, 4002), zone(4004, 4010), zone(3990, 3994)])).squeezed, false, "inside a zone: the next ones are 10 apart");
  // No candidate on one side: room to move. No price or range: nothing to measure.
  assert.deepEqual(squeezeOf(strategyOf([zone(4004, 4010)])), { squeezed: false, corridor: null, corridor_atr: null, needed: 10, below: null, above: { low: 4004, high: 4010 } });
  assert.equal(squeezeOf(strategyOf([], 4000, 0)), null);
  assert.equal(squeezeOf(null), null);
  assert.equal(squeezeOf(strategyOf([zone(3990, 3997), zone(4004, 4010)]), { corridorAtr: 0.5 }).squeezed, false, "the rule's width is a parameter");
});

test("the room guardrail: squeezed, neither side may trade; the council's BUY becomes WAIT; the record keeps the corridor", () => {
  const CLOSE = "2026-11-10T10:00:00.000Z", NOW = Date.parse(CLOSE) + 60_000;
  const r = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
  const loadedOf = (zones) => ({
    inputs: { calendar: { events: [] }, m15Bars: [] }, strategy: strategyOf(zones),
    global: { timeframes: [r("D1", 0.5), r("H4", 0.4), r("H1", 0.3), r("M15", 0.35, "BUY"), r("NEWS", 0.2), r("MACRO", 0.1)] }, correlations: null, regime: "normal-trending"
  });
  const open = [zone(3995, 3998), zone(3980, 3980), zone(4030, 4032), zone(4050, 4050)];
  const tight = [zone(3990, 3997), zone(4004, 4010), zone(3960, 3962), zone(4040, 4042), zone(4060, 4062)];
  const council = { answer: { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "limit", target: "tp1", summary: "Decision BUY, bias bullish: the rooms lean up.", reasons: ["The rooms lean bullish."], risks: [], weighed: [] } };
  const record = (zones, env = {}) => { const loaded = loadedOf(zones); return buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, assessment: assess(loaded, { now: NOW, env }), council, now: NOW, env }); };

  // Room to move: the check passes and says how far apart the zones are.
  const free = record(open);
  const room = free.guardrails.long.checks.find((c) => c.id === "room");
  assert.deepEqual([room.pass, free.stance, free.squeeze.squeezed, free.squeeze.corridor_atr], [true, "BUY", false, 3.2]);
  assert.match(room.detail, /^the key zones below and above price are 32\.00 apart \(3\.2 times the 1H average range; at least 1 needed\)$/);

  // Squeezed: the same failed check on both sides, so the council's BUY is held back.
  const a = assess(loadedOf(tight), { now: NOW, env: {} });
  for (const g of [a.guards.long, a.guards.short]) {
    assert.equal(g.allowed, false);
    assert.deepEqual(g.checks.filter((c) => !c.pass && c.id === "room").map((c) => c.detail), ["price is squeezed: the key zones below (3990.00–3997.00) and above (4004.00–4010.00) are 7.00 apart, less than one 1H average range (10.00)"]);
  }
  assert.equal(a.guards.long.checks.filter((c) => !c.pass).length, 1, "on the long side the squeeze is the only failed check");
  const held = record(tight);
  assert.deepEqual([held.stance, held.trade, held.squeeze.squeezed, held.squeeze.corridor], ["WAIT", null, true, 7]);
  assert.equal(decide({ answer: { ...council.answer }, guards: a.guards, strategy: loadedOf(tight).strategy, quorum: a.quorum }).stance, "WAIT");

  // The switch: SQUEEZE_GUARD "off" leaves the check out (the corridor is still recorded).
  assert.deepEqual([squeezeGuardEnabled({}), squeezeGuardEnabled({ SQUEEZE_GUARD: "OFF" })], [true, false]);
  const off = record(tight, { SQUEEZE_GUARD: "off" });
  assert.deepEqual([off.stance, off.guardrails.long.checks.some((c) => c.id === "room"), off.squeeze.squeezed], ["BUY", false, true]);
  // Without a price the check passes: there is nothing to measure (the levels check holds the side back).
  assert.equal(guardrailsFor(1, { cards: [], quorum: { long_share: 0, short_share: 0, score: 0 }, strategy: null, inputs: {}, env: {} }).checks.find((c) => c.id === "room").pass, true);
  // The doctrine facts name the guardrail.
  assert.deepEqual(guardrailIds({}).slice(-2), ["room", "confidence"]);
  assert.equal(guardrailIds({ SQUEEZE_GUARD: "off" }).includes("room"), false);
});
