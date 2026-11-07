import test from "node:test";
import assert from "node:assert/strict";
import {
  reputationOf, reputationFromScorecards, buildCrowdLine, finalEntries, crowdRule, stuckCautions, roomReputation,
  familyOf, REPUTATION_PRIOR, WEIGHT_RANGE
} from "../src/reputation.mjs";

const card = (subject, timeframe, { hit = 0, miss = 0, neutral = 0, wait = 0, waitHit = 0, missed = 0 } = {}) => ({
  subject, timeframe, n: hit + miss + neutral + wait,
  directional: { n: hit + miss + neutral, hit, miss, neutral, hit_rate: hit + miss ? hit / (hit + miss) : null },
  wait: { n: wait, hit: waitHit, missed_opportunity: missed, accuracy: wait ? waitHit / wait : null }, brier: 0.2
});

test("reputation: accuracy shrunk toward 50 % with ten pseudo-observations; weight 2 x shrunk accuracy within 0.25 to 2", () => {
  assert.equal(REPUTATION_PRIOR, 10);
  assert.deepEqual([...WEIGHT_RANGE], [0.25, 2]);
  const fresh = reputationOf(card("agent:x", "15"));
  assert.deepEqual([fresh.decisive, fresh.accuracy, fresh.shrunk, fresh.weight], [0, null, 0.5, 1], "a new agent weighs 1");
  const lucky = reputationOf(card("agent:x", "15", { hit: 2 }));
  assert.equal(lucky.weight, 1.167, "two hits barely move it");
  const good = reputationOf(card("agent:x", "15", { hit: 60, miss: 20, neutral: 5, wait: 20, waitHit: 15, missed: 5 }));
  assert.equal(good.decisive, 100);
  assert.equal(good.accuracy, 0.75);
  assert.equal(good.weight, 1.455);
  assert.equal(reputationOf(card("agent:x", "15", { miss: 400 })).weight, 0.25, "floored");
  const map = reputationFromScorecards([card("agent:risk", "15", { hit: 5 }), card("agent:risk", "60", { miss: 5 }), card("chain:h1", "60", { hit: 9 })], "60");
  assert.deepEqual(Object.keys(map), ["risk"]);
  assert.ok(map.risk.weight < 1);
});

test("the crowd line: raw and weighted biases, a disagreement index, and the families against the crowd", () => {
  const entries = [
    { id: "technical", stance: "WAIT", bias: "BULLISH" }, { id: "kinetic_engine", stance: "BUY", bias: "BULLISH" },
    { id: "risk", stance: "WAIT", bias: "NEUTRAL" }, { id: "fabio_amt", stance: "WAIT", bias: "BEARISH" }, { id: "moderator", stance: "WAIT" }
  ];
  const raw = buildCrowdLine(entries);
  assert.equal(raw.agents, 4, "the moderator is not part of the crowd");
  assert.deepEqual(raw.biases, { BULLISH: 2, BEARISH: 1, NEUTRAL: 1 });
  assert.equal(raw.weighted_bias, "BULLISH");
  assert.deepEqual(raw.disagreeing_families, ["volume"]);
  assert.ok(raw.disagreement > 0.9, "a three-way split is close to 1");
  // A volume agent with a strong record turns the weighted crowd although the head count leans up.
  const weighted = buildCrowdLine(entries, { fabio_amt: { weight: 2, decisive: 120 }, technical: { weight: 0.4, decisive: 80 }, kinetic_engine: { weight: 0.4, decisive: 80 } });
  assert.equal(weighted.bias, "BULLISH", "unweighted");
  assert.equal(weighted.weighted_bias, "BEARISH");
  assert.equal(weighted.scored_agents, 3);
  assert.deepEqual(weighted.disagreeing_families, ["price action", "trend"]);
  assert.equal(buildCrowdLine([{ id: "a", stance: "WAIT", bias: "BULLISH" }, { id: "b", stance: "BUY" }]).disagreement, 0, "unanimous");
  assert.match(crowdRule(weighted), /^CROWD LINE .*3 of 4 agents have a record\): the weighted crowd leans bearish/);
  assert.equal(familyOf("aegis_footprint"), "order flow");
});

test("final entries: the Consensus Discussion answer replaces the opening; stored and read shapes both work", () => {
  const stored = finalEntries([{ id: 7, agent: "risk", status: "ok", stance: "WAIT", bias: "NEUTRAL" }, { id: 8, agent: "technical", status: "agent_failed" }], [{ id: 9, agent: "risk", status: "ok", stance: "SELL", bias: "BEARISH" }]);
  assert.deepEqual(stored, [{ id: "risk", stance: "SELL", bias: "BEARISH", confidence: null }]);
  const read = finalEntries([{ id: "risk", status: "ok", stance: "WAIT" }], []);
  assert.equal(read[0].id, "risk");
});

test("open stuck states caution the agents that read the stuck field; every roster agent gets a record", () => {
  const c = stuckCautions([{ field: "prophet_r37.structure_subtype", status: "open", candles: 9, price_range: 34, atr: 10 }, { field: "gmi_v12_70.gate", status: "closed", candles: 8, price_range: 40, atr: 10 }]);
  assert.deepEqual(Object.keys(c).sort(), ["h1", "prophet", "r37_funnel"]);
  assert.equal(c.prophet[0], "the Prophet R37 structure has not changed for 9 candles while price moved 3.4 times the ATR");
  const rep = roomReputation(["prophet", "risk"], { risk: { n: 3, decisive: 3, weight: 1.1 } }, c);
  assert.equal(rep.prophet.weight, 1, "no record yet: weight 1");
  assert.equal(rep.prophet.family, "structure");
  assert.ok(rep.prophet.caution.length === 1 && !rep.risk.caution);
});
