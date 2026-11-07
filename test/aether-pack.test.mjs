import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { pullLearnedPack, packCandidates, packProblems, shadowCandidates, packStatus, resetAetherPackSchemaCacheForTests, TUNING_GRID, MAX_CANDIDATES_PER_FAMILY } from "../src/aether-pack.mjs";
import { CANDIDATES } from "../src/shadow-versions.mjs";

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

const NOW = Date.parse("2026-11-09T14:10:00Z");
const param = (family, value, id = `k-param-${family}-${value}`) => ({
  item_id: id, version: 1, kind: "param_candidate", label: "learned", audience: { agents: ["moderator"], charts: ["60"] }, situation: { family },
  text: `Test in shadow a latch that expires after ${value} hourly candles instead of 50.`,
  params: { family, grid: `TUNING_GRID.${family}.stateMaxAge`, values: { stateMaxAge: value }, hypothesis: "fewer stuck episodes", metric: "paired sign test" },
  content_sha256: "c".repeat(64), proposal_id: "knw_00000000-0000-4000-8000-000000000001"
});
const caution = { item_id: "k-caution-prophet-60-london", version: 1, kind: "caution", label: "learned", audience: { agents: ["prophet", "moderator"], charts: ["60"] }, situation: { chart: "60", session: "london" }, text: "Wrong in 67% of its decisive calls.", params: null };
const pack = (items, sha = "a".repeat(64)) => ({ version: "cryptophys.learned-pack.v1", sha256: sha, canon: {}, use: "shadow testing only; never a live prompt", items });

test("the pack must be a learned pack with a hash; anything else is refused", () => {
  assert.deepEqual(packProblems(pack([caution])), []);
  assert.ok(packProblems({ ...pack([]), version: "x" }).includes("unsupported_version"));
  assert.ok(packProblems({ ...pack([]), sha256: "nope" }).includes("sha_invalid"));
  assert.ok(packProblems(pack([{ ...caution, label: "canon" }])).includes("item_not_learned"), "learned is never presented as canon");
  assert.deepEqual(packProblems(null), ["not_an_object"]);
});

test("only approved parameter items inside the reviewed TUNING_GRID become shadow candidates, at most 3 per family", () => {
  assert.deepEqual(TUNING_GRID.gmi_v12_70.stateMaxAge, [8, 12, 16, 24]);
  const { candidates, ignored } = packCandidates(pack([
    param("gmi_v12_70", 16), param("gmi_v12_70", 24, "k-param-gmi-24"), param("prophet_r37", 16), param("prophet_r37", 12, "k-param-prophet-12"),
    param("prophet_r37", 20, "k-param-prophet-20"), param("prophet_r38", 16), caution
  ]), { now: NOW });
  assert.deepEqual(candidates.map((c) => c.id), ["gmi_v12_70@latch16", "prophet_r37@latch16"]);
  const reasons = Object.fromEntries(ignored.map((i) => [i.item, i.reason]));
  assert.match(reasons["k-param-gmi-24@1"], /already runs 3 candidates/, "gmi already runs latch8 and latch12");
  assert.match(reasons["k-param-prophet-12@1"], /already runs or was stopped/, "a retired point is not restarted");
  assert.match(reasons["k-param-prophet-20@1"], /not in the reviewed grid/);
  assert.match(reasons["k-param-prophet_r38-16@1"], /not in TUNING_GRID/);
  const c = candidates[0];
  assert.deepEqual(c.params, { stateMaxAge: 16 });
  assert.equal(c.role, "candidate");
  assert.equal(c.origin.source, "aether");
  assert.equal(c.origin.item_id, "k-param-gmi_v12_70-16");
  assert.equal(c.review.by, "2026-12-09", "30 days after it was first seen");
  assert.ok(MAX_CANDIDATES_PER_FAMILY === 3);
  assert.equal(CANDIDATES.length, 3, "the hand-written candidates are unchanged");
});

test("the hourly pull stores the pack, keeps the first-seen time, and fails soft", async () => {
  resetAetherPackSchemaCacheForTests();
  const db = d1();
  assert.deepEqual(await pullLearnedPack({ DB: db }, { now: NOW }), { status: "disabled" });
  assert.deepEqual(await shadowCandidates({ DB: db }), CANDIDATES, "no pack: the hand-written candidates only");

  let current = pack([param("prophet_r37", 16), caution]);
  const env = { DB: db, AETHER: { learnedPack: async () => current } };
  const first = await pullLearnedPack(env, { now: NOW });
  assert.deepEqual([first.status, first.items, first.changed], ["ok", 2, true]);
  const again = await pullLearnedPack(env, { now: NOW + 3_600_000 });
  assert.equal(again.changed, false);
  const ids = (await shadowCandidates(env, { now: NOW + 3_600_000 })).map((c) => c.id);
  assert.deepEqual(ids, [...CANDIDATES.map((c) => c.id), "prophet_r37@latch16"]);
  const later = (await shadowCandidates(env, { now: NOW + 86_400_000 })).at(-1);
  assert.equal(later.review.by, "2026-12-09", "the review clock starts when the item was first pulled");

  current = { bad: true };
  assert.equal((await pullLearnedPack(env, { now: NOW + 7_200_000 })).status, "refused");
  const down = { DB: db, AETHER: { learnedPack: async () => { throw new Error("aether down"); } } };
  assert.equal((await pullLearnedPack(down, { now: NOW + 7_200_000 })).status, "transport_failed");
  assert.equal((await shadowCandidates(down)).length, CANDIDATES.length + 1, "the last good pack stays in use");

  const status = await packStatus(env, { now: NOW });
  assert.equal(status.pulled, true);
  assert.equal(status.use, "shadow testing only; never a live prompt");
  assert.deepEqual(status.shadow_candidates.map((c) => c.id), ["prophet_r37@latch16"]);
  assert.equal(status.items.length, 2);
  assert.equal(JSON.stringify(status).includes("card_ids"), false);
});
