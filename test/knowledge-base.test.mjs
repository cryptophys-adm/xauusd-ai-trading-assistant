import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyRefs, collectRefs, renderModule, renderJson, GENERATED_MODULE, GENERATED_JSON } from "../scripts/build-knowledge-base.mjs";
import { knowledgeForPrompt } from "../src/knowledge-prompt.mjs";
import { KNOWLEDGE_BASE_V4 } from "../src/knowledge-base.generated.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("every Pine line cited by knowledge-base v4 still contains the quoted text", () => {
  assert.ok(collectRefs().length >= 40, "expected the KB to cite the Pine sources extensively");
  assert.deepEqual(verifyRefs(), []);
});

test("generated knowledge-base v4 files are up to date", () => {
  assert.equal(read(GENERATED_MODULE), renderModule(), "stale: run `node scripts/build-knowledge-base.mjs --write`");
  assert.equal(read(GENERATED_JSON), renderJson(), "stale: run `node scripts/build-knowledge-base.mjs --write`");
});

test("knowledge base covers every compared webhook field", () => {
  const d = KNOWLEDGE_BASE_V4.field_dictionary;
  for (const f of ["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype"]) assert.ok(d.prophet_r38.fields[f], `prophet_r38.${f}`);
  for (const f of ["direction", "d_enc", "b_enc", "structure_subtype", "bull_event", "bear_event"]) assert.ok(d.prophet_r37_ssot.fields[f], `prophet_r37_ssot.${f}`);
  for (const f of ["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"]) assert.ok(d.gmi_v12_70.fields[f], `gmi_v12_70.${f}`);
  assert.equal(KNOWLEDGE_BASE_V4.provenance.pine_sources.length, 3);
});

test("prompt view drops line references but keeps meanings and provenance summary", () => {
  const technical = knowledgeForPrompt("technical");
  assert.ok(!technical.includes('"contains"'));
  assert.ok(technical.includes("BULLISH STRUCTURE STATE"));
  assert.ok(technical.includes("content_sha256"));
  assert.ok(technical.length < JSON.stringify(KNOWLEDGE_BASE_V4).length * 0.8);
  const news = knowledgeForPrompt("news");
  assert.ok(news.includes("news_policy") && !news.includes("field_dictionary"));
});
