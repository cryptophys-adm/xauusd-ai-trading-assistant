// B15 (Track B): LIQUIDITY, lens B's council-only card in the Decision Engine (src/decision-engine.mjs liquidityCard,
// withLiquidity, liquidityQuorum; docs/RFC_POSITIONING_LIQUIDITY.md §5.2). The card joins neither the quorum nor
// decision.witnesses, has no witness-weighting or witness-tuning key, and changes no gate: quorum, guardrails, power,
// pickStrategy, witnesses and witness_weights are byte for byte the same with it on or off. LIQUIDITY_WITNESS "off": no
// card, no decision.liquidity, the council's messages as before. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  assess, buildDecisionRecord, councilEvidence, councilMessages, decide, pickStrategy, quorumOf, runDecisionEngine, resetDecisionSchemaCacheForTests, validateCouncil,
  liquidityCard, liquidityCardWeight, liquidityQuorum, liquidityWitnessEnabled, withLiquidity, LIQUIDITY_WITNESS, LIQUIDITY_PROMPT, LEAN
} from "../src/decision-engine.mjs";
import { lensKnobs } from "../src/lens-policy.mjs";
import { LIQUIDITY_STATE_FRESH_MS, SWEEP_WITH_MAX_AGE_MIN } from "../src/liquidity-lens.mjs";
import { WITNESS_KEYS as WEIGHTING_KEYS, WITNESS_PRIORS } from "../src/witness-weighting.mjs";
import { WITNESS_KEYS as TUNING_KEYS, TUNED_WITNESSES } from "../src/witness-tuning.mjs";
import { eaSignalFromDecision, managementFields } from "../src/ea-signal.mjs";
import { PRICE_LIKE } from "../src/public-projection.mjs";

const CLOSE = "2026-11-09T13:15:00.000Z";
const NOW = Date.parse(CLOSE) + 70_000;
const M1 = 60_000;

const row = (key, lean, action = "WAIT", over = {}) => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false, ...over });
const globalOf = (over = {}) => ({ timeframes: [row("D1", 0.5), row("H4", 0.4), row("H1", 0.3), row("M15", 0.35, "BUY"), row("NEWS", 0.2), row("MACRO", 0.1)].map((r) => ({ ...r, ...(over[r.key] || {}) })) });
const ZONES = [
  { low: 3995, high: 3998, price: 3996.5, candidate: true, label: "S1" },
  { low: 3980, high: 3980, price: 3980, candidate: true, label: "S2" },
  { low: 4030, high: 4032, price: 4031, candidate: true, label: "R1" },
  { low: 4050, high: 4050, price: 4050, candidate: true, label: "R2" }
];
const STRATEGY = { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones: ZONES }, plan: { at_level: true } };

/** Lens B's state and knobs as runDecisionEngine loads them: a reclaimed sweep `age` minutes old in a state `stateAge` minutes old. */
function lensB({ side = "sell_side", age = 3, stateAge = 2, reclaimed = true, available = true, knobs = null, sweep = true } = {}) {
  return {
    state: { at_ms: NOW - stateAge * M1, facts: { available, ...(sweep ? { sweep: { side, age_min: age, vol_pctl: 0.97, reclaimed } } : { sweep: null }) } },
    knobs: knobs ?? lensKnobs("liquidity", "intraday", { baseline: "sufficient" })
  };
}
const loadedOf = (over = {}) => ({ inputs: { calendar: { events: [] } }, strategy: STRATEGY, global: globalOf(over.global), correlations: null, regime: "normal-trending", liquidity: lensB(), ...over.loaded });
const card = (key, lean, over = {}) => ({ key, label: key, weight: 0.1, available: true, stale: false, lean, ...over });
const omit = (o, k) => { const { [k]: _, ...rest } = o; return rest; };

test("LW1. the weight: min(0.06, 0.1 x lens B's council weight in force); none while lens B is off, floored or stale", () => {
  assert.deepEqual(LIQUIDITY_WITNESS, { share: 0.1, cap: 0.06, lean: 0.6 });
  assert.deepEqual([0.36, 0.3, 0.6, 0.8, 0].map(liquidityCardWeight), [0.036, 0.03, 0.06, 0.06, 0]);
  for (const x of [null, undefined, -0.1, Number.NaN, "0.36"]) assert.equal(liquidityCardWeight(x), null);
  const cards = [card("H1", 0.4)];
  // The anchors per mode (0.4 / 0.3 / 0.2 / 0.3) give 0.04 / 0.03 / 0.02 / 0.03; Aether's top of the scalp bound (0.8) is capped at 0.06.
  for (const [mode, w] of [["scalp", 0.04], ["intraday", 0.03], ["swing", 0.02], ["range", 0.03]]) {
    assert.equal(liquidityCard(lensB({ knobs: lensKnobs("liquidity", mode, { baseline: "sufficient" }) }), cards, { now: NOW }).weight, w, mode);
  }
  const aether = lensKnobs("liquidity", "scalp", { baseline: "sufficient", policy: { values: { "liquidity.council_weight_scalp": 0.8 } } });
  assert.equal(aether.weight, 0.8);
  const c = liquidityCard(lensB({ knobs: aether }), cards, { now: NOW });
  assert.deepEqual([c.weight, c.lens_weight], [0.06, 0.8]);
  // Off (the owner's switch), floored (lensKnobs active false), the facts unavailable, the state stale: no card.
  assert.equal(liquidityCard(lensB({ knobs: lensKnobs("liquidity", "intraday", { enabled: false }) }), cards, { now: NOW }), null, "switch off");
  const floored = lensKnobs("liquidity", "intraday", { baseline: "sufficient", floor: { liquidity: { at_ms: 1, doctrine_sha: "a" } } });
  assert.equal(floored.active, false);
  assert.equal(liquidityCard(lensB({ knobs: floored }), cards, { now: NOW }), null, "floored");
  assert.equal(liquidityCard(lensB({ available: false }), cards, { now: NOW }), null, "no facts");
  assert.equal(liquidityCard(lensB({ stateAge: 0 }), cards, { now: NOW + LIQUIDITY_STATE_FRESH_MS + 1 }), null, "stale state");
  assert.ok(liquidityCard(lensB({ stateAge: 0, age: 0 }), cards, { now: NOW + LIQUIDITY_STATE_FRESH_MS }), "fresh at exactly 15 minutes");
  for (const x of [null, undefined, {}, { state: null, knobs: null }]) assert.equal(liquidityCard(x, cards, { now: NOW }), null);
});

test("LW2. the lean: +-0.6 only from a fresh reclaimed sweep with another counting witness leaning the same way; else 0", () => {
  const bull = [card("H1", 0.4), card("D1", -0.3)];
  const up = liquidityCard(lensB({ side: "sell_side" }), bull, { now: NOW });
  assert.deepEqual([up.lean, up.side, up.sweep, up.sweep_age_min, up.lean_reason, up.agreeing], [0.6, "BULLISH", "sell_side", 5, "sweep_with_agreeing_witness", ["H1"]]);
  const down = liquidityCard(lensB({ side: "buy_side" }), bull, { now: NOW });
  assert.deepEqual([down.lean, down.side, down.agreeing, down.lean_reason], [-0.6, "BEARISH", ["D1"], "sweep_with_agreeing_witness"]);
  // No agreeing witness: neutral (|lean| < LEAN), stale, unavailable, only the other way, or another LIQUIDITY card.
  const none = [card("H1", LEAN - 0.01), card("H4", 0.5, { stale: true }), card("M15", 0.5, { available: false }), card("D1", -0.4), card("LIQUIDITY", 0.6), card("NEWS", null)];
  const alone = liquidityCard(lensB({ side: "sell_side" }), none, { now: NOW });
  assert.deepEqual([alone.lean, alone.side, alone.lean_reason, alone.agreeing, alone.sweep], [0, "NEUTRAL", "no_agreeing_witness", [], "sell_side"]);
  assert.equal(liquidityCard(lensB({ side: "sell_side" }), [card("H1", LEAN)], { now: NOW }).lean, 0.6, "LEAN itself leans");
  // The sweep's age at the decision is its facts' age plus the state's: 10 + 5 = 15 counts, 10 + 6 = 16 does not.
  assert.equal(liquidityCard(lensB({ age: 10, stateAge: 5 }), bull, { now: NOW }).lean, 0.6);
  const old = liquidityCard(lensB({ age: 10, stateAge: 6 }), bull, { now: NOW });
  assert.deepEqual([old.lean, old.lean_reason, old.sweep, old.sweep_age_min], [0, "sweep_stale", null, null]);
  assert.equal(SWEEP_WITH_MAX_AGE_MIN, 15);
  // Not reclaimed, or no sweep: 0.
  assert.deepEqual([liquidityCard(lensB({ reclaimed: false }), bull, { now: NOW }).lean, liquidityCard(lensB({ reclaimed: false }), bull, { now: NOW }).lean_reason], [0, "not_reclaimed"]);
  assert.deepEqual([liquidityCard(lensB({ sweep: false }), bull, { now: NOW }).lean, liquidityCard(lensB({ sweep: false }), bull, { now: NOW }).lean_reason], [0, "no_sweep"]);
  // The card never counts, and carries no price: its summary has no price-like number.
  for (const c of [up, down, alone, old]) {
    assert.deepEqual([c.key, c.counts, c.available, c.stale, c.decision, c.confidence, c.at], ["LIQUIDITY", false, true, false, null, null, null]);
    assert.doesNotMatch(c.summary, PRICE_LIKE);
    assert.match(c.summary, /Council only: it never counts in the quorum\.$/);
  }
});

test("LW3. no witness-weighting or witness-tuning key: WITNESS_KEYS and WITNESS_PRIORS as today; LIQUIDITY only in the council's weighed list", () => {
  assert.deepEqual([...WEIGHTING_KEYS], ["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY", "KEY_LEVELS", "REGIME", "TREND_TF", "MACRO_DRIVERS", "SESSION", "CALENDAR", "STRATEGY_AGENTS"]);
  assert.deepEqual({ ...WITNESS_PRIORS }, { D1: 0.1263, H4: 0.1263, H1: 0.1263, M15: 0.0947, NEWS: 0.0632, MACRO: 0.0315, STRATEGY: 0.0632, KEY_LEVELS: 0.0395, REGIME: 0.0395, TREND_TF: 0.0395, MACRO_DRIVERS: 0.0237, SESSION: 0.02, CALENDAR: 0.08, STRATEGY_AGENTS: 0.1263 });
  assert.deepEqual([...TUNING_KEYS], ["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY", "KEY_LEVELS", "REGIME", "TREND_TF", "MACRO_DRIVERS", "SESSION", "CALENDAR", "STRATEGY_AGENTS"]);
  assert.ok(!TUNED_WITNESSES.includes("LIQUIDITY"));
  // The council may name it in weighed (its own local list).
  const o = { stance: "WAIT", bias: "NEUTRAL", confidence: 0.5, entry_type: "limit", target: "tp1", summary: "Decision WAIT, bias neutral: the rooms disagree.", reasons: ["The rooms disagree."], risks: [], weighed: ["liquidity", "H1", "NOPE"] };
  validateCouncil(o);
  assert.deepEqual(o.weighed, ["LIQUIDITY", "H1"]);
});

test("LW4. the card changes no gate: quorum, guardrails, power, pickStrategy, witnesses and witness_weights byte for byte on vs off", () => {
  const envOn = { GLOBAL_DECISION_WEIGHTED: "true", TRADING_MODE: "intraday" };
  const envOff = { ...envOn, LIQUIDITY_WITNESS: "off" };
  assert.deepEqual([liquidityWitnessEnabled({}), liquidityWitnessEnabled(envOn), liquidityWitnessEnabled(envOff), liquidityWitnessEnabled({ LIQUIDITY_WITNESS: " OFF " }), liquidityWitnessEnabled({ LIQUIDITY_WITNESS: "x" })], [true, true, false, false, true]);
  for (const [name, loaded] of [["leaning", loadedOf()], ["no agreeing witness", loadedOf({ loaded: { liquidity: lensB({ side: "buy_side" }) } })], ["bearish rooms", loadedOf({ global: { D1: { lean: -0.5 }, H4: { lean: -0.6 }, H1: { lean: -0.4 }, M15: { lean: -0.35, action: "SELL" } }, loaded: { liquidity: lensB({ side: "buy_side" }) } })]]) {
    const on = assess(loaded, { now: NOW, env: envOn }), off = assess(loaded, { now: NOW, env: envOff });
    assert.ok(on.liquidity?.card, `${name}: a card`);
    assert.equal(off.liquidity, undefined, `${name}: none off`);
    assert.equal(JSON.stringify(on.quorum), JSON.stringify(off.quorum), `${name}: quorum`);
    assert.equal(JSON.stringify(on.cards), JSON.stringify(off.cards), `${name}: witnesses`);
    assert.ok(!on.cards.some((c) => c.key === "LIQUIDITY"), `${name}: not a witness`);
    assert.equal(JSON.stringify(on.guards), JSON.stringify(off.guards), `${name}: guardrails`);
    assert.equal(JSON.stringify([on.witness_weights, on.witness_weights_source, on.witness_weights_id]), JSON.stringify([off.witness_weights, off.witness_weights_source, off.witness_weights_id]), `${name}: witness_weights`);
    assert.ok(!("LIQUIDITY" in on.witness_weights));
    assert.deepEqual(quorumOf(on.cards, { now: NOW }), on.quorum);
    // pickStrategy and the decision with the strategy arm live.
    for (const a of [on, off]) { a.guards.arms = { mode: "live", known: true, ids: [], version: 1 }; a.guards.strategy_execution = true; }
    const ask = { stance: on.quorum.score >= 0 ? "BUY" : "SELL", bias: "NEUTRAL", confidence: 0.7, entry_type: "limit", target: "tp1", summary: "x", reasons: ["x"], risks: [], weighed: [] };
    assert.equal(JSON.stringify(decide({ answer: ask, guards: on.guards, strategy: STRATEGY, quorum: on.quorum })), JSON.stringify(decide({ answer: ask, guards: off.guards, strategy: STRATEGY, quorum: off.quorum })), `${name}: decide`);
    const pick = (a) => pickStrategy({ side: "long", speakers: a.guards.consensus?.long ?? [], plans: a.guards.long.plans, agentConfidence: a.guards.agent_confidence, quorum: a.quorum, strategy: STRATEGY, armed: [], stance: "BUY", opts: {} });
    assert.equal(JSON.stringify(pick(on)), JSON.stringify(pick(off)), `${name}: pickStrategy`);
    // The records: the same but decision.liquidity; the EA signal (power and all) the same.
    for (const a of [on, off]) delete a.guards.arms;
    const council = { answer: { ...ask, summary: "Decision WAIT, bias neutral: the rooms are mixed.", reasons: ["The rooms are mixed."], stance: "WAIT" }, model: "m" };
    const rOn = buildDecisionRecord({ key: "k", barClose: CLOSE, loaded, assessment: on, council, now: NOW, env: envOn });
    const rOff = buildDecisionRecord({ key: "k", barClose: CLOSE, loaded, assessment: off, council, now: NOW, env: envOff });
    assert.ok(rOn.liquidity && !("liquidity" in rOff));
    assert.equal(JSON.stringify(omit(rOn, "liquidity")), JSON.stringify(rOff), `${name}: the record without decision.liquidity`);
    assert.deepEqual(Object.keys(rOn.liquidity), ["card", "quorum_with_liquidity"]);
    const sig = (r) => eaSignalFromDecision({ decision: { ...r, decision_key: "OANDA:XAUUSD:15:" + (Date.parse(CLOSE) - 900_000) }, now: NOW });
    const mgmt = (r) => managementFields({ ...r, decision_key: "OANDA:XAUUSD:15:" + (Date.parse(CLOSE) - 900_000) });
    assert.equal(JSON.stringify(sig(rOn)), JSON.stringify(sig(rOff)), `${name}: the signal`);
    assert.equal(JSON.stringify(mgmt(rOn)), JSON.stringify(mgmt(rOff)), `${name}: the management fields and the power`);
    assert.equal(mgmt(rOn).power, Math.max(-1, Math.min(1, rOn.quorum.score)));
  }
});

test("LW5. quorum_with_liquidity: the quorum with the card added at its weight, informational (each side's quorum check at the mode)", () => {
  const cards = [card("H1", 0.4, { weight: 0.3 }), card("D1", -0.4, { weight: 0.3 }), card("NEWS", 0.05, { weight: 0.1 })];
  const c = liquidityCard(lensB({ side: "sell_side" }), cards, { now: NOW });
  const q = liquidityQuorum(cards, c, { now: NOW, env: { TRADING_MODE: "intraday" } });
  const raw = quorumOf([...cards, c], { now: NOW });
  assert.deepEqual([q.long_share, q.short_share, q.neutral_share, q.score, q.share_needed_above, q.witnesses], [raw.long_share, raw.short_share, raw.neutral_share, raw.score, raw.share_needed_above, 4]);
  assert.equal(q.long_share, 0.52, "0.33 / 0.63 with the card's 0.03 on the long side");
  assert.deepEqual([q.quorum_min, q.long_met, q.short_met, q.met], [0.5, true, false, true]);
  assert.deepEqual([quorumOf(cards, { now: NOW }).long_share, quorumOf(cards, { now: NOW }).short_share], [0.5, 0.5], "without the card neither side has the quorum");
  assert.equal(liquidityQuorum(cards, c, { now: NOW, env: { TRADING_MODE: "swing" } }).met, false, "swing asks 60 %");
  // withLiquidity: the cards themselves, plus the card.
  assert.equal(withLiquidity(cards, null), cards);
  const w = withLiquidity(cards, c);
  assert.deepEqual([w.length, w.slice(0, 3).every((x, i) => x === cards[i]), w.at(-1)], [4, true, c]);
});

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function kv() { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; }
const ANSWER = { stance: "WAIT", bias: "BULLISH", confidence: 0.6, entry_type: "limit", target: "tp1", summary: "Decision WAIT, bias bullish: the rooms lean up but the trigger has not printed.", reasons: ["The higher rooms lean bullish."], risks: [], weighed: ["H1", "LIQUIDITY"] };
function ai() {
  const calls = [];
  return { calls, async run(_model, input) { calls.push(input); return { choices: [{ message: { content: JSON.stringify(ANSWER) }, finish_reason: "stop" }], usage: { total_tokens: 30 } }; } };
}
async function run(env) {
  resetDecisionSchemaCacheForTests();
  const e = { DB: fakeD1(), SIGNAL_CACHE: kv(), AI: ai(), MODEL_RATE_LIMIT_RETRY_MS: "0", GLOBAL_DECISION_WEIGHTED: "true", TRADING_MODE: "intraday", ...env };
  const r = await runDecisionEngine(e, { barClose: CLOSE, now: NOW, clock: () => NOW, loaded: loadedOf({ loaded: { positioning: null } }) });
  assert.equal(r.status, "decided", JSON.stringify(r));
  const record = JSON.parse(e.DB.raw.prepare("SELECT decision_json FROM engine_decisions").get().decision_json);
  return { record, messages: e.AI.calls[0].messages };
}

test("LW6. end to end: the council reads LIQUIDITY (counts false, one prompt sentence); off, its messages are those of the cards alone and the record has no decision.liquidity", async () => {
  const on = await run({});
  const off = await run({ LIQUIDITY_WITNESS: "off" });
  const evOn = JSON.parse(on.messages[1].content.replace(/^EVIDENCE:\n/, ""));
  const evOff = JSON.parse(off.messages[1].content.replace(/^EVIDENCE:\n/, ""));
  const liq = evOn.witnesses.find((w) => w.key === "LIQUIDITY");
  assert.deepEqual(Object.keys(liq), ["key", "name", "role", "weight", "counts", "lean", "own_decision", "confidence", "summary"]);
  assert.deepEqual([liq.counts, liq.weight, liq.lean, liq.own_decision, liq.confidence], [false, 0.03, 0.6, null, null]);
  assert.equal(evOn.witnesses.at(-1).key, "LIQUIDITY");
  assert.ok(!evOff.witnesses.some((w) => w.key === "LIQUIDITY"));
  assert.ok(on.messages[0].content.includes(LIQUIDITY_PROMPT));
  assert.ok(!off.messages[0].content.includes("LIQUIDITY"));
  // On, the evidence is off's plus the card: the same witnesses before it, the same quorum, sides and context.
  assert.equal(JSON.stringify({ ...evOn, witnesses: evOn.witnesses.slice(0, -1) }), JSON.stringify(evOff));
  assert.equal(on.messages[0].content.replace(` ${LIQUIDITY_PROMPT}`, ""), off.messages[0].content);
  // Off: exactly the messages the council read before B15 (the evidence of assessment.cards, no card, no sentence).
  const env = { GLOBAL_DECISION_WEIGHTED: "true", TRADING_MODE: "intraday", LIQUIDITY_WITNESS: "off" };
  const a = assess(loadedOf({ loaded: { positioning: null } }), { now: NOW, env: { ...env, COUNCIL_KNOBS: {}, ROOM_CORRIDOR_ATR: 1 } });
  assert.equal(JSON.stringify(evOff.witnesses), JSON.stringify(councilEvidence({ barClose: CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards }).witnesses));
  assert.equal(councilMessages({ ...evOff })[0].content, off.messages[0].content);
  // The records: decision.witnesses are the cards (no LIQUIDITY); on carries decision.liquidity, off none; the rest equal.
  assert.ok(!on.record.witnesses.some((w) => w.key === "LIQUIDITY"));
  assert.equal(off.record.liquidity, undefined);
  assert.deepEqual(Object.keys(on.record.liquidity), ["card", "quorum_with_liquidity"]);
  assert.deepEqual([on.record.liquidity.card.lean, on.record.liquidity.card.counts], [0.6, false]);
  assert.deepEqual(on.record.weighed, ["H1", "LIQUIDITY"]);
  assert.equal(JSON.stringify(omit(on.record, "liquidity")), JSON.stringify(off.record));
  // No price in what the council sees of the card.
  assert.doesNotMatch(JSON.stringify(liq), PRICE_LIKE);
});
