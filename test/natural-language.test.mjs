import test from "node:test";
import assert from "node:assert/strict";
import { naturalLanguageErrors, describeDegradedEvidence } from "../src/natural-language.mjs";
import { validateAgentOutput, validateModeratorOutput } from "../src/multi-agent-bus.mjs";
import { validateRoomModerator } from "../src/agent-threads.mjs";

test("plain sentences pass the natural-language check", () => {
  assert.deepEqual(naturalLanguageErrors("The H1 decision is WAIT. Gold drifted from 4046 to 4031, e.g. a mild pullback."), []);
  assert.deepEqual(naturalLanguageErrors("The setup is neutral vs. the prior session."), []);
});

test("field names, evidence paths and key=value pairs are rejected", () => {
  assert.ok(naturalLanguageErrors("buy_confirmed is true").includes("not_natural_language:field_name"));
  assert.ok(naturalLanguageErrors("see h1.decision for details").includes("not_natural_language:evidence_path"));
  assert.ok(naturalLanguageErrors("decision=WAIT").includes("not_natural_language:key_value"));
  assert.ok(naturalLanguageErrors("trust_status approved_by_parity").length > 0);
});

test("agent and moderator validators enforce natural language", () => {
  const agent = { agent: "technical", round: 1, stance: "WAIT", confidence: 0.5, insight: "m5.bias is NEUTRAL", refs: ["m5.bias"], responds_to: null };
  assert.ok(validateAgentOutput(agent, { agent: "technical", round: 1 }).errors.includes("not_natural_language:evidence_path"));
  assert.equal(validateAgentOutput({ ...agent, insight: "The 5m bias is neutral." }, { agent: "technical", round: 1 }).valid, true, "refs may still hold paths");
  assert.ok(validateModeratorOutput({ stance: "WAIT", confidence: 0.5, agreed: true, summary: "h1_chain_decision says WAIT", dissent: [] }).errors.includes("not_natural_language:field_name"));
  assert.ok(validateRoomModerator({ stance: "WAIT", confidence: 0.5, summary: "decision=WAIT" }, "WAIT").errors.includes("not_natural_language:key_value"));
});

test("degraded WAIT reasoning reads as plain language", () => {
  const text = describeDegradedEvidence(["local_calculation:mizan", "local_calculation:prophet", "local_calculation:gmi", "fundamental_news_analysis"], ["news:completed_news_analysis_missing"]);
  assert.match(text, /^No trade for this candle\. The decision is WAIT because/);
  assert.match(text, /MizanLib, Prophet and GMI/);
  assert.match(text, /no fresh, validated news analysis/);
  assert.deepEqual(naturalLanguageErrors(text), []);
  assert.deepEqual(naturalLanguageErrors(describeDegradedEvidence(["webhook:gmi_v12_70"], ["candle_stale"])), []);
});
