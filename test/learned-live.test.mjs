// Owner 2026-11-13: "Apakah menyambungkan ini masih manual? Jika iya, buat agar autonomous". A learned
// note the shadow arm found better goes live by itself for exactly what was tested (the agent, the 1H
// chart), and retires by itself when a person rejects it or it turns worse live.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  planPromotions, liveItemProblems, binomialLower, runLearnedPromotion, effectiveLearnedPack, liveItems, promotedKeys,
  readLearnedLive, promotionMessage, resetLearnedLiveForTests, LIVE_RULES
} from "../src/learned-live.mjs";
import { pullLearnedPack, resetAetherPackSchemaCacheForTests } from "../src/aether-pack.mjs";
import { shadowItems, resetShadowKnowledgeSchemaCacheForTests } from "../src/shadow-knowledge.mjs";
import { learnedBlock, LEARNED_HEADER } from "../src/learned-knowledge.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

const NOW = Date.parse("2026-11-20T00:00:00Z");
const ITEM = { item_id: "k-role-chronos-matrix-calibration-talk", version: 1, kind: "role_reminder", label: "learned", audience: { agents: ["chronos_matrix", "moderator"], charts: [] }, situation: { check: "calibration_talk" }, text: "In the last 7 days the Chronos Matrix agent spoke of calibration in 11% of its rooms; its role forbids it.", content_sha256: "c".repeat(64), review: "auto" };
const BETTER = { subject: "shadow-agent:chronos_matrix@k-role-chronos-matrix-calibration-talkv1", agent: "chronos_matrix", item_id: ITEM.item_id, item_version: 1, verdict: "better_than_active: ready for owner review", discovery: { bars: 200, accuracy: 0.62, control_accuracy: 0.5, p_value: 0.01, p_holm: 0.02 }, holdout: { bars: 100, complete: true }, paired: {} };
const pack = (items) => ({ version: "cryptophys.learned-pack.v1", sha256: "a".repeat(64), items });

test("P1. a better verdict promotes the note for the tested agent on the 1H chart only; others do not", () => {
  const plan = planPromotions({ candidates: [BETTER, { ...BETTER, agent: "risk", verdict: "not_better" }], packItems: [ITEM], now: NOW });
  assert.equal(plan.promote.length, 1);
  const it = plan.promote[0].item;
  assert.deepEqual(it.audience, { agents: ["chronos_matrix"], charts: ["60"] }, "never the moderator, never another chart");
  assert.equal(it.situation.chart, "60");
  assert.equal(it.review.auto, true);
  assert.deepEqual(liveItemProblems(it), []);
  // Not in Aether's pack (rejected), already live or retired, or not a text item: nothing.
  assert.equal(planPromotions({ candidates: [BETTER], packItems: [], now: NOW }).promote.length, 0);
  assert.equal(planPromotions({ candidates: [BETTER], packItems: [ITEM], retired: [{ item_id: ITEM.item_id, version: 1 }], now: NOW }).promote.length, 0);
  assert.equal(planPromotions({ candidates: [BETTER], packItems: [{ ...ITEM, kind: "param_candidate" }], now: NOW }).promote.length, 0);
  // A note with a price or an order word never goes live.
  assert.equal(planPromotions({ candidates: [BETTER], packItems: [{ ...ITEM, text: "Sell below 3880 when the stop loss is near." }], now: NOW }).promote.length, 0);
  assert.ok(liveItemProblems({ ...it, audience: { agents: ["moderator"], charts: ["60"] } }).includes("audience_invalid"));
});

test("P2. a live note retires when Aether drops it or when the agent is significantly worse live", () => {
  const live = [{ item_id: ITEM.item_id, version: 1, item: { audience: { agents: ["chronos_matrix"] } }, verdict: [{ agent: "chronos_matrix", discovery: { control_accuracy: 0.5 } }], promoted_at: "2026-11-15T00:00:00Z" }];
  assert.match(planPromotions({ live, packItems: [], now: NOW }).retire[0].reason, /no longer in Aether's pack/);
  const calls = (right, wrong) => [...Array(right).fill({ stance: "SELL", result: "hit" }), ...Array(wrong).fill({ stance: "SELL", result: "miss" })];
  const key = `${ITEM.item_id}@1`;
  assert.equal(planPromotions({ live, packItems: [ITEM], scored: { [key]: calls(12, 18) }, now: NOW }).retire.length, 0, "fewer than 40 decided calls: keep watching");
  assert.equal(planPromotions({ live, packItems: [ITEM], scored: { [key]: calls(22, 22) }, now: NOW }).retire.length, 0, "as good as in the test");
  const worse = planPromotions({ live, packItems: [ITEM], scored: { [key]: calls(12, 32) }, now: NOW });
  assert.match(worse.retire[0].reason, /^worse live: 12 of 44/);
  assert.ok(binomialLower(12, 44, 0.5) < 0.01 && binomialLower(22, 44, 0.5) > 0.5);
  assert.equal(promotionMessage({}), null);
  assert.match(promotionMessage({ retired: worse.retire }), /retired: k-role-chronos-matrix-calibration-talk v1/);
});

test("P3. the hourly run promotes, the prompts read it, the shadow arm stops testing it, and a rejection retires it", async () => {
  resetLearnedLiveForTests(); resetAetherPackSchemaCacheForTests(); resetShadowKnowledgeSchemaCacheForTests();
  const env = { DB: d1(), LEARNED_KNOWLEDGE_ENABLED: "true", AETHER: { learnedPack: async () => pack([ITEM]) } };
  assert.equal((await runLearnedPromotion(env, { knowledge: { candidates: [BETTER] }, now: NOW })).status, "no_pack", "nothing before Aether's pack was ever pulled");
  await pullLearnedPack(env, { now: NOW });
  assert.equal((await shadowItems(env)).length, 1, "tested while not promoted");
  const r = await runLearnedPromotion(env, { knowledge: { candidates: [BETTER] }, now: NOW });
  assert.equal(r.promoted, 1);
  assert.match(r.message, /\+ live: k-role-chronos-matrix-calibration-talk v1 for chronos_matrix on the 1H room/);
  assert.equal((await runLearnedPromotion(env, { knowledge: { candidates: [BETTER] }, now: NOW + 3_600_000 })).promoted, 0, "idempotent");
  const eff = await effectiveLearnedPack(env, { now: NOW + 10 * 60_000 });
  assert.equal(eff.live_items, 1);
  assert.ok(learnedBlock(env, { agent: "chronos_matrix", chart: "60", session: "london", pack: eff })?.startsWith(LEARNED_HEADER), "the agent's 1H prompt reads it");
  assert.equal(learnedBlock(env, { agent: "chronos_matrix", chart: "15", session: "london", pack: eff }), null, "not another chart");
  assert.equal(learnedBlock(env, { agent: "moderator", chart: "60", session: "london", pack: eff }), null, "not the moderator");
  assert.equal((await shadowItems(env)).length, 0, "the shadow arm no longer spends calls on it");
  assert.ok((await promotedKeys(env)).has(`${ITEM.item_id}@1`));
  // A person rejects it in Aether: the next pull drops it, the next run retires it.
  env.AETHER.learnedPack = async () => pack([]);
  await pullLearnedPack(env, { now: NOW + 7_200_000 });
  const gone = await runLearnedPromotion(env, { knowledge: { candidates: [BETTER] }, now: NOW + 7_200_000 });
  assert.equal(gone.retired, 1);
  assert.equal((await liveItems(env, { now: NOW + 7_200_000 })).length, 0);
  const view = await readLearnedLive(env);
  assert.equal(view.items[0].status, "retired");
  assert.equal(view.rules.chart, LIVE_RULES.chart);
});

test("P4. switching it off retires every live note at once", async () => {
  resetLearnedLiveForTests(); resetAetherPackSchemaCacheForTests();
  const env = { DB: d1(), AETHER: { learnedPack: async () => pack([ITEM]) } };
  await pullLearnedPack(env, { now: NOW });
  await runLearnedPromotion(env, { knowledge: { candidates: [BETTER] }, now: NOW });
  const off = await runLearnedPromotion({ ...env, LEARNED_AUTO_PROMOTION: "off" }, { knowledge: { candidates: [BETTER] }, now: NOW + 1 });
  assert.equal(off.status, "disabled");
  assert.equal(off.retired, 1);
  assert.deepEqual(await liveItems({ ...env, LEARNED_AUTO_PROMOTION: "off" }), []);
});
