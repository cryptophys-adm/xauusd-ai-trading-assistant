import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LEARNED_PACK, learnedItemProblems, selectNotes, learnedBlock, learnedPackInfo, noteApplies, BUDGETS, LEARNED_HEADER, learnedKnowledgeEnabled } from "../src/learned-knowledge.mjs";
import { canonicalPack, generatedModule, PACK_JSON, GENERATED_MODULE } from "../scripts/build-learned-knowledge.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const cards = Array.from({ length: 12 }, (_, i) => "card:OANDA:XAUUSD:60:" + (1794000000000 + i * 3600000));
const item = (id, over = {}) => ({
  item_id: id, version: 1, kind: "caution", label: "learned",
  audience: { agents: ["r37_funnel", "moderator"], charts: ["60"] }, situation: { chart: "60", session: "london" },
  text: "On the hourly chart in the London session, the Prophet funnel agent was wrong in 71% of its decisive calls over 30 days, against 48% in its other situations.",
  evidence: { window_days: 30, wrong_pct: 71, baseline_wrong_pct: 48, decisive: 14 },
  provenance: { card_ids: cards, canon_sha: "a".repeat(64), source: "aether" }, content_sha256: "b".repeat(64),
  review: { shadow_verdict: "better_than_active: ready for owner review", promoted_on: "2026-12-01" }, ...over
});

test("the bundled pack is generated from knowledge/learned/pack.json and every item passes the rules", () => {
  const pack = JSON.parse(read(PACK_JSON));
  assert.equal(read(GENERATED_MODULE), generatedModule(pack), "run node scripts/build-learned-knowledge.mjs --write");
  assert.equal(LEARNED_PACK.content_sha256, canonicalPack(pack).content_sha256);
  for (const it of LEARNED_PACK.items) assert.deepEqual(learnedItemProblems(it), [], it.item_id);
});

test("an item ships only with provenance, a shadow verdict, plain words, no levels and its numbers in its evidence", () => {
  assert.deepEqual(learnedItemProblems(item("c.ok")), []);
  assert.ok(learnedItemProblems(item("c.n", { text: "Wrong in 90% of 12 calls." })).some((e) => e.startsWith("text_number_not_in_evidence")));
  assert.ok(learnedItemProblems(item("c.p", { text: "Below 4050 it was wrong.", evidence: { level: 4050 } })).includes("text_price_like_number"));
  assert.ok(learnedItemProblems(item("c.o", { text: "Sell when it turns red." })).includes("text_order_wording"));
  assert.ok(learnedItemProblems(item("c.v", { review: null })).includes("shadow_verdict_missing"), "never without a shadow verdict");
  assert.ok(learnedItemProblems(item("c.k", { kind: "param_candidate" })).includes("kind_not_text"));
  assert.ok(learnedItemProblems(item("c.c", { provenance: { card_ids: cards.slice(0, 3), canon_sha: "a".repeat(64) } })).includes("provenance_missing"));
});

test("selection is deterministic: audience, chart and session; budgets cut whole notes", () => {
  const pack = { items: [item("c1"), item("c2", { situation: { chart: "60", session: "asia" } }), item("r1", { kind: "role_reminder", situation: { check: "calibration_talk" }, text: "In the last 7 days the Prophet funnel agent talked about calibration in 12% of the rooms it spoke in. Its role and the owner rules forbid this.", evidence: { window_days: 7, rate_pct: 12 } })] };
  const ctx = { agent: "r37_funnel", chart: "60", session: "london" };
  assert.deepEqual(selectNotes(pack, ctx).map((n) => n.item_id), ["c1", "r1"], "the Asia caution does not match a London bar; the role reminder always applies");
  assert.deepEqual(selectNotes(pack, { ...ctx, chart: "240" }).map((n) => n.item_id), [], "audience charts 60 only");
  assert.equal(noteApplies(pack.items[0], { agent: "gmi", chart: "60", session: "london" }), false);
  const long = { items: Array.from({ length: 5 }, (_, i) => item("c" + i)) };
  assert.equal(selectNotes(long, ctx).length, 2, `agents get at most ${BUDGETS.agent.items} notes within ${BUDGETS.agent.chars} characters`);
  assert.equal(selectNotes(long, { ...ctx, agent: "moderator" }).length, 3, "the moderator up to 3");
});

test("off by default: no block, no brief entry; on: the RFC block after the data", () => {
  const pack = { version: "v", content_sha256: "c".repeat(64), items: [item("c1")] };
  const ctx = { agent: "r37_funnel", chart: "60", session: "london", pack };
  assert.equal(learnedKnowledgeEnabled({}), false);
  assert.equal(learnedBlock({}, ctx), null, "turning it off restores today's prompts");
  const block = learnedBlock({ LEARNED_KNOWLEDGE_ENABLED: "true" }, ctx);
  assert.ok(block.startsWith(LEARNED_HEADER));
  assert.match(block, /\n- On the hourly chart in the London session/);
  assert.deepEqual(learnedPackInfo({ LEARNED_KNOWLEDGE_ENABLED: "true" }, { roster: ["r37_funnel", "gmi"], chart: "60", session: "london", pack }), {
    enabled: true, version: "v", sha: "c".repeat(64), items: 1, items_by_agent: { r37_funnel: ["c1@1"], moderator: ["c1@1"] }
  });
  assert.equal(learnedPackInfo({}, { roster: ["r37_funnel"], pack }).enabled, false);
});

test("the build script adds only items with a better_than_active shadow verdict", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "learned-"));
  const exportFile = path.join(dir, "export.json"), tuningFile = path.join(dir, "tuning.json");
  writeFileSync(exportFile, JSON.stringify({ learned_pack: { items: [item("c1", { review: undefined }), item("c2", { review: undefined })] } }));
  writeFileSync(tuningFile, JSON.stringify({ replays: { knowledge: { candidates: [{ item_id: "c1", item_version: 1, verdict: "better_than_active: ready for owner review" }, { item_id: "c2", item_version: 1, verdict: "not_better" }] } } }));
  const script = new URL("../scripts/build-learned-knowledge.mjs", import.meta.url).pathname;
  const run = (items) => execFileSync(process.execPath, [script, "--add", exportFile, "--tuning", tuningFile, "--items", items], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(run("c1@1"), /"items":1/, "a dry run (no --write) reports the result and writes nothing");
  assert.throws(() => run("c2@1"), /not_better|shadow verdict/);
  assert.throws(() => run("zz@1"), /not in the export/);
});
