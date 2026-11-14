// Neuron allocation, read-only (owner 2026-11-14): each agent's neurons per day from its room messages, priced
// with its model's input/output mix of the day, beside its 30-day hit rate.
import test from "node:test";
import assert from "node:assert/strict";
import { buildAllocation, blendedRates } from "../src/neuron-allocation.mjs";
import { neuronsOf } from "../src/ai-usage.mjs";

const GEMMA = "@cf/google/gemma-4-26b-a4b-it", OSS = "@cf/openai/gpt-oss-120b";

test("an agent's neurons follow its model's mix of the day, and add up to the meter", () => {
  const usage = [
    { day: "2026-11-13", model: GEMMA, prompt_tokens: 900_000, completion_tokens: 100_000 },
    { day: "2026-11-13", model: OSS, prompt_tokens: 400_000, completion_tokens: 100_000 }
  ];
  const rates = blendedRates(usage);
  const rows = [
    { day: "2026-11-13", room: "M15", agent: "risk", model: GEMMA, calls: 100, tokens: 600_000 },
    { day: "2026-11-13", room: "M15", agent: "technical", model: GEMMA, calls: 60, tokens: 400_000 },
    { day: "2026-11-13", room: "M15", agent: "moderator", model: OSS, calls: 20, tokens: 500_000 }
  ];
  const cards = [
    { subject: "agent:risk", timeframe: "15", directional: { n: 40, hit: 12, miss: 18, hit_rate: 0.4 } },
    { subject: "agent:technical", timeframe: "15", directional: { n: 30, hit: 18, miss: 6, hit_rate: 0.75 } },
    { subject: "agent:technical", timeframe: "60", directional: { n: 10, hit: 5, miss: 5, hit_rate: 0.5 } }
  ];
  const v = buildAllocation({ rows, rates, cards, days: 1 });
  const meter = neuronsOf(GEMMA, 900_000, 100_000) + neuronsOf(OSS, 400_000, 100_000);
  assert.ok(Math.abs(v.total_neurons - meter) <= 2, `${v.total_neurons} vs ${meter}`);
  const risk = v.agents.find((a) => a.agent === "risk");
  const tech = v.agents.find((a) => a.agent === "technical");
  assert.equal(risk.hit_rate, 0.4);
  assert.equal(risk.scored, 30);
  // The technical agent sits in the 15m room only: its record counts every timeframe, shows the 15m one.
  assert.equal(tech.hit_rate, round((18 + 5) / (18 + 6 + 5 + 5)));
  assert.deepEqual(Object.keys(tech.by_timeframe), ["15"]);
  assert.equal(v.agents.find((a) => a.agent === "moderator").hit_rate, null);
  assert.ok(Math.abs(v.agents.reduce((s, a) => s + a.share, 0) - 1) < 0.01);
  assert.equal(v.rooms_by_day.length, 1);
  assert.deepEqual(Object.keys(v.rooms_by_day[0].by_agent).sort(), ["moderator", "risk", "technical"]);
  assert.ok(v.agents.every((a) => a.status === "live" && a.grounding_rate === null));
  assert.deepEqual(v.changes, []);
});

test("a day without a meter row is priced at the input rate (a floor), and an unknown model is not priced", () => {
  const v = buildAllocation({ rows: [
    { day: "2026-11-12", room: "H1", agent: "risk", model: GEMMA, calls: 1, tokens: 1_000_000 },
    { day: "2026-11-12", room: "H1", agent: "risk", model: "@cf/unknown/model", calls: 1, tokens: 500 }
  ], rates: new Map(), cards: [] });
  const risk = v.agents[0];
  assert.equal(risk.neurons, neuronsOf(GEMMA, 1_000_000, 0));
  assert.equal(risk.unpriced_tokens, 500);
});

function round(x) { return Math.round(x * 1000) / 1000; }
