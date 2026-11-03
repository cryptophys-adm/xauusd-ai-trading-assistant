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
