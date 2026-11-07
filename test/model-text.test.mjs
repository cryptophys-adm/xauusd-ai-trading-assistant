import test from "node:test";
import assert from "node:assert/strict";
import { chatMessages, cleanModelText, extractJsonObject } from "../src/model-text.mjs";

test("chatMessages splits role into system and task into user", () => {
  const m = chatMessages(["You are the Analyst.", "Do X.", "EVIDENCE:", "{}"]);
  assert.equal(m.length, 2);
  assert.equal(m[0].role, "system");
  assert.match(m[0].content, /^You are the Analyst\./);
  assert.equal(m[1].role, "user");
  assert.equal(m[1].content, "Do X.\nEVIDENCE:\n{}");
});

test("cleanModelText strips reasoning traces and stray </think>", () => {
  assert.equal(cleanModelText("<think>plan</think>\n{\"a\":1}"), "{\"a\":1}");
  assert.equal(cleanModelText("No markdown. No explanation.\n</think>\n\n{\"a\":1}"), "{\"a\":1}");
});

test("cleanModelText truncates degenerate repetition but keeps separators", () => {
  const garbage = "Gold is neutral.\n" + "* ".repeat(500);
  assert.equal(cleanModelText(garbage), "Gold is neutral.\n[truncated: repetitive model output]");
  const rule = "Header\n" + "-".repeat(80) + "\nBody";
  assert.equal(cleanModelText(rule), rule);
  assert.equal(cleanModelText("a\u0000b"), "ab");
});

test("extractJsonObject tolerates fences, prose and trailing text", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"recommendation\":\"NEUTRAL\"}\n```"), { recommendation: "NEUTRAL" });
  assert.deepEqual(extractJsonObject("Here: {\"a\": {\"b\": 2}} done"), { a: { b: 2 } });
  assert.deepEqual(extractJsonObject("{bad} then {\"ok\":true}"), { ok: true });
  assert.equal(extractJsonObject("no json"), null);
  assert.equal(extractJsonObject("[1,2]"), null);
});

test("extractModelText reads chat.completion content and never returns the raw object", async () => {
  const { extractModelText } = await import("../src/model-text.mjs");
  assert.equal(extractModelText({ response: "legacy" }), "legacy");
  assert.equal(extractModelText({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }), "answer");
  const cut = extractModelText({ object: "chat.completion", choices: [{ message: { content: null, reasoning: "thinking..." }, finish_reason: "length" }], usage: {} });
  assert.match(cut, /^\[no answer: the model used its whole token budget on reasoning\]$/);
  assert.ok(!cut.includes("chat.completion"));
  assert.match(extractModelText({ foo: 1 }), /^\[no answer/);
});

// Model migration (owner decision 2026-11-07): glm-5.3-flash and nemotron-3-120b-a12b stop answering
// on 2026-11-20; each model family takes its own request form.
import { MODELS, modelFamily, modelRequests, isRequestShapeError, runModel, responsesIncomplete, extractModelText } from "../src/model-text.mjs";
import { roleModels, parseModelObject, MODERATOR_DEFAULT_MODEL, BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL } from "../src/multi-agent-bus.mjs";
import { stepRole } from "../src/agent-threads.mjs";

const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

test("request forms per model family: gpt-oss reasons by effort, gemma-4 answers with thinking off", () => {
  assert.deepEqual(["@cf/openai/gpt-oss-120b", "@cf/google/gemma-4-26b-a4b-it", "@cf/zai-org/glm-5.3-flash", "@cf/zai-org/glm-4.7-flash", "@cf/nvidia/nemotron-3-120b-a12b", "x"].map(modelFamily), ["gpt-oss", "gemma-4", "glm-5", "glm-4", "nemotron", "chat"]);
  const oss = modelRequests(MODELS.GPT_OSS_120B, { messages: msgs, maxTokens: 900, effort: "high", schemaName: "x", schema });
  assert.equal(oss.length, 3);
  assert.deepEqual(oss[0].response_format, { type: "json_schema", json_schema: { name: "x", strict: true, schema } });
  assert.equal(oss[0].reasoning_effort, "high");
  assert.equal(oss[0].max_tokens, 900);
  assert.equal(oss[1].response_format, undefined, "then without the schema");
  assert.deepEqual(oss[2], { input: msgs, reasoning: { effort: "high" } }, "then the Responses form");
  assert.equal(modelRequests(MODELS.GPT_OSS_20B, { messages: msgs, maxTokens: 9, effort: "max" })[0].reasoning_effort, "high");
  assert.equal(modelRequests(MODELS.GPT_OSS_20B, { messages: msgs, maxTokens: 9 }).length, 2, "no schema: chat, then Responses");
  const gemma = modelRequests(MODELS.GEMMA_4, { messages: msgs, maxTokens: 500, schemaName: "x", schema });
  assert.ok(gemma.every((r) => r.chat_template_kwargs.enable_thinking === false && r.max_tokens === 500));
  assert.ok(gemma[0].response_format && !gemma[1].response_format);
  assert.equal(modelRequests("@cf/zai-org/glm-4.7-flash", { messages: msgs, maxTokens: 100 })[0].max_tokens, 200, "glm-4.7 reasons without effort control: twice the budget");
  assert.equal(modelRequests("@cf/zai-org/glm-5.3-flash", { messages: msgs, maxTokens: 100, effort: "medium" })[0].reasoning_effort, "low", "never medium on glm-5.3 (maps to max)");
});

test("a request form the model rejects falls back to the next; any other error is thrown", async () => {
  assert.equal(isRequestShapeError(new Error("AiError: 5006: Error: oneOf at '/' not met")), true);
  assert.equal(isRequestShapeError(new Error("JSON Mode couldn't be met")), true);
  assert.equal(isRequestShapeError(new Error("3021: rate limiting")), false);
  assert.equal(isRequestShapeError(Object.assign(new Error("x"), { name: "TimeoutError" })), false);
  const seen = [];
  const ai = { run: async (model, input) => { seen.push(input); if (input.response_format) throw new Error("5006: response_format is not supported"); return { response: '{"a":"b"}' }; } };
  const r = await runModel(ai, MODELS.GEMMA_4, { messages: msgs, maxTokens: 10, schemaName: "x", schema });
  assert.equal(r.variant, 1);
  assert.equal(seen.length, 2);
  const down = { run: async () => { throw new Error("3040: Capacity temporarily exceeded"); } };
  await assert.rejects(runModel(down, MODELS.GEMMA_4, { messages: msgs, maxTokens: 10, schemaName: "x", schema }), /3040/);
});

test("the Responses API shape (gpt-oss): its message text is the answer; an incomplete one is a truncation", () => {
  const ok = { object: "response", status: "completed", output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"a":"b"}' }] }], usage: { total_tokens: 30 } };
  assert.equal(extractModelText(ok), '{"a":"b"}');
  assert.deepEqual(parseModelObject(ok).obj, { a: "b" });
  const cut = { object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "..." }] }] };
  assert.equal(responsesIncomplete(cut), true);
  assert.match(extractModelText(cut), /whole token budget on reasoning/);
  assert.equal(parseModelObject(cut).truncated, true);
  assert.equal(extractModelText({ response: { a: 1 } }), '{"a":1}', "JSON mode may return the parsed object");
});

test("models per role: the role's variable, then MULTI_AGENT_MODEL, then the default; the moderator concludes on gpt-oss-120b", () => {
  assert.deepEqual(roleModels({}, "agent"), { primary: BUS_DEFAULT_MODEL, fallback: BUS_DEFAULT_FALLBACK_MODEL });
  assert.deepEqual(roleModels({}, "moderator"), { primary: MODERATOR_DEFAULT_MODEL, fallback: MODELS.GEMMA_4 });
  assert.deepEqual([BUS_DEFAULT_MODEL, BUS_DEFAULT_FALLBACK_MODEL, MODERATOR_DEFAULT_MODEL], [MODELS.GEMMA_4, MODELS.GPT_OSS_20B, MODELS.GPT_OSS_120B]);
  assert.deepEqual(roleModels({ MULTI_AGENT_MODEL: "m", MULTI_AGENT_FALLBACK_MODEL: "" }, "moderator"), { primary: "m", fallback: "" }, "the legacy variables override every role");
  assert.deepEqual(roleModels({ MULTI_AGENT_MODEL: "m", MODERATOR_MODEL: "mod", MODERATOR_FALLBACK_MODEL: "f" }, "moderator"), { primary: "mod", fallback: "f" });
  assert.deepEqual(["conclusion", "moderator", "tldr", "open:risk", "debate:risk", "tag:1", "technical"].map(stepRole), ["moderator", "moderator", "moderator", "agent", "agent", "agent", "agent"]);
});
