import test from "node:test";
import assert from "node:assert/strict";
import { plainDecisionText, decisionTextErrors, DECISION_TEXT_RULE } from "../src/plain-decision.mjs";
import { naturalLanguageErrors } from "../src/natural-language.mjs";

// Real production reasoner text (2026-11-05 04:00 UTC candle).
const CODE_LIKE = {
  decision: "WAIT", confidence: 0.35, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null,
  reasoning: "Prophet base bias is NEUTRAL (prophet_r37_ssot.direction = 0 = flat or internally conflicted). GMI shows conflict (true) and verdict 0 with gate -1, blocking the setup.",
  confirmation: "BUY confirmation requires prophet_r38.buy_confirmed == true and gmi_v12_70.conflict == false.",
  invalidation: "Invalidation occurs if t_enc == 4."
};
const PLAIN = {
  reasoning: "Prophet R37 reads no clear direction, and GMI v12.70 reports a conflict with its confluence gate at minus 1, so the setup is blocked and the verdict is 0.",
  confirmation: "A buy needs a confirmed Prophet R38 buy signal while GMI v12.70 shows no conflict.",
  invalidation: "The wait stance is invalidated when Prophet R38 enters its cut-loss risk state, code 4."
};

function fakeAI(reply) {
  const calls = [];
  return { calls, run: async (model, request) => { calls.push({ model, request }); const content = typeof reply === "function" ? reply(request) : reply; return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 50 } }; } };
}

test("detects field names, key paths, key = value and == comparisons in decision text", () => {
  const bad = decisionTextErrors(CODE_LIKE);
  assert.deepEqual(Object.keys(bad).sort(), ["confirmation", "invalidation", "reasoning"]);
  assert.ok(bad.confirmation.includes("not_natural_language:comparison"));
  assert.deepEqual(decisionTextErrors({ ...CODE_LIKE, ...PLAIN }), {});
  assert.deepEqual(naturalLanguageErrors(DECISION_TEXT_RULE).filter(e => e !== "not_natural_language:key_value"), [], "the rule itself shows no field names");
});

test("plain text makes no model call", async () => {
  const env = { AI: fakeAI({}) };
  const r = await plainDecisionText(env, { ...CODE_LIKE, ...PLAIN });
  assert.equal(r.status, "plain");
  assert.equal(env.AI.calls.length, 0);
});

test("code-like text is rewritten once; decision, confidence and prices never change", async () => {
  const env = { AI: fakeAI(PLAIN) };
  const r = await plainDecisionText(env, CODE_LIKE);
  assert.equal(r.status, "rewritten");
  assert.equal(env.AI.calls.length, 1);
  assert.equal(r.decision.reasoning, PLAIN.reasoning);
  assert.equal(r.decision.confirmation, PLAIN.confirmation);
  assert.equal(r.decision.invalidation, PLAIN.invalidation);
  for (const k of ["decision", "confidence", "entry_price", "stop_loss", "take_profit", "risk_reward", "position_size_pct"]) assert.equal(r.decision[k], CODE_LIKE[k]);
  assert.deepEqual(r.decision.text_rewritten, ["reasoning", "confirmation", "invalidation"]);
  assert.match(env.AI.calls[0].request.messages.map(m => m.content).join("\n"), /The decision is WAIT and it stays exactly that/);
});

test("a rewrite that adds a number, or still reads like code, keeps the original field", async () => {
  const env = { AI: fakeAI({ reasoning: "Prophet is neutral; enter near 4072 later.", confirmation: "Needs buy_confirmed to be true.", invalidation: PLAIN.invalidation }) };
  const r = await plainDecisionText(env, CODE_LIKE);
  assert.equal(r.status, "partially_rewritten");
  assert.equal(r.decision.reasoning, CODE_LIKE.reasoning, "a new number (4072) is rejected");
  assert.equal(r.decision.confirmation, CODE_LIKE.confirmation, "a rewrite that still reads like code is rejected");
  assert.equal(r.decision.invalidation, PLAIN.invalidation);
});

test("indicator names and timeframes are not treated as new numbers", async () => {
  const env = { AI: fakeAI({ invalidation: "Prophet R38 on the H1 chart and GMI v12.70 on the 15m chart enter the cut-loss state, code 4." }) };
  const r = await plainDecisionText(env, { decision: "WAIT", invalidation: "Invalidation occurs if t_enc == 4." });
  assert.equal(r.status, "rewritten");
});

test("a failed model call leaves the decision untouched", async () => {
  const env = { AI: { run: async () => { throw new Error("down"); } }, MULTI_AGENT_FALLBACK_MODEL: "" };
  const r = await plainDecisionText(env, CODE_LIKE);
  assert.equal(r.status, "rewrite_failed");
  assert.deepEqual(r.decision, CODE_LIKE);
});
