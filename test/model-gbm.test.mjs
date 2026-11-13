// Owner 2026-11-13 ("1-3"): the decision model trained daily by GitHub Actions (scripts/train_gbm.py) is
// evaluated by the AI Worker from compact LightGBM trees, in shadow only (src/model-gbm.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { walkTree, predictGbm, gbmProblems, gbmPredictions, gbmStatus, readGbm, resetGbmCacheForTests, MODEL_GBM_KEY, MODEL_GBM_VERSION } from "../src/model-gbm.mjs";
import { prospectiveRecord } from "../src/model-baseline.mjs";

// One stump per missing type: [feature, threshold, default_left, missing (0 None, 1 Zero, 2 NaN), left, right].
const NONE = [0, 0.5, 0, 0, -1, 1], ZERO = [0, 0.5, 1, 1, -2, 2], NAN = [0, 0.5, 0, 2, -3, 3];

test("G1. the trees decide as LightGBM's numerical split does, missing values included", () => {
  assert.equal(walkTree(NONE, [0.2]), -1);
  assert.equal(walkTree(NONE, [0.9]), 1);
  assert.equal(walkTree(NONE, [NaN]), -1, "missing type None: a missing value reads as 0");
  assert.equal(walkTree(ZERO, [0]), -2, "missing type Zero: 0 follows the default side (left)");
  assert.equal(walkTree(ZERO, [NaN]), -2, "and so does a missing value");
  assert.equal(walkTree(ZERO, [0.9]), 2);
  assert.equal(walkTree(NAN, [NaN]), 3, "missing type NaN: the default side (right)");
  assert.equal(walkTree(NAN, [0.1]), -3);
  assert.equal(walkTree(1.25, [0]), 1.25, "a tree may be a single leaf");
  const deep = [0, 0.5, 0, 0, [1, 2, 1, 2, -0.5, 0.25], 0.75];
  assert.equal(walkTree(deep, [0.1, 3]), 0.25);
  // Probability = sigmoid(sum of the leaves); a missing named feature is NaN.
  const model = { trees: [NONE, NAN], base_rate: 0.4 };
  assert.equal(predictGbm(model, { a: 0.9 }, ["a"]), Math.round((1 / (1 + Math.exp(-(1 + 3)))) * 10_000) / 10_000);
  assert.equal(predictGbm(model, {}, ["a"]), Math.round((1 / (1 + Math.exp(-(-1 + 3)))) * 10_000) / 10_000);
  assert.equal(predictGbm({ trees: [] }, {}, ["a"]), null);
});

const GBM = { version: MODEL_GBM_VERSION, model_id: "gbm@2026-11-14T04:17Z", trained_at: "2026-11-14T04:17:30Z", rows: 400, features: ["w_h1_lean"], status: "ok",
  checks: { tight_long: { status: "ok", n: 120, skill: 0.05, auc: 0.62 } },
  models: { tight_long: { base_rate: 0.4, n: 400, trees: [[0, 0, 0, 0, -0.5, 0.5]], top_features: [{ feature: "w_h1_lean", gain: 12.5 }] }, tight_short: { base_rate: 0.5, n: 400, trees: [[0, 0, 0, 0, 0.5, -0.5]], top_features: [] } } };

test("G2. a stored model is validated, read once per isolate and gives point-in-time shadow predictions; the status never shows the trees", async () => {
  assert.deepEqual(gbmProblems(GBM), []);
  assert.ok(gbmProblems({ ...GBM, version: "x" }).includes("unsupported_version"));
  assert.ok(gbmProblems({ ...GBM, features: ["Bad Name"] }).includes("features_invalid"));
  assert.ok(gbmProblems({ ...GBM, models: { other: { trees: [] } } }).some((p) => p.startsWith("model_invalid")));
  resetGbmCacheForTests();
  let reads = 0;
  const env = { SIGNAL_CACHE: { async get(k) { reads += 1; return k === MODEL_GBM_KEY ? JSON.stringify(GBM) : null; } } };
  assert.equal((await readGbm(env, { now: 0 })).model_id, GBM.model_id);
  await readGbm(env, { now: 60_000 });
  assert.equal(reads, 1, "cached");
  resetGbmCacheForTests();
  assert.equal(await readGbm({ ...env, MODEL_GBM_MODE: "off" }), null);
  resetGbmCacheForTests();
  assert.equal(await readGbm({ SIGNAL_CACHE: { async get() { return JSON.stringify({ ...GBM, version: "old" }); } } }), null, "an invalid model is not used");
  const p = gbmPredictions(GBM, { w_h1_lean: 0.8 });
  assert.ok(p.tight.long > 0.5 && p.tight.short < 0.5);
  assert.equal(p.tight.long_base, 0.4);
  const status = gbmStatus(GBM, prospectiveRecord([]));
  assert.ok(!JSON.stringify(status).includes("trees"), "no trees in the API");
  assert.equal(status.top_features.tight_long[0].feature, "w_h1_lean");
});

test("G3. the training workflow keeps the dataset and the model out of the public log and artifacts", () => {
  const wf = readFileSync(new URL("../.github/workflows/train-model.yml", import.meta.url), "utf8");
  assert.doesNotMatch(wf, /upload-artifact/);
  assert.doesNotMatch(wf, /\bcat\b[^\n]*(dataset|model)\.json/);
  assert.match(wf, /kv key put "model:gbm:v1"/);
  assert.match(wf, /> \/dev\/null/);
  assert.match(wf, /rm -f "\$RUNNER_TEMP\/dataset\.json" "\$RUNNER_TEMP\/model\.json"/);
  const py = readFileSync(new URL("../scripts/train_gbm.py", import.meta.url), "utf8");
  assert.match(py, /DECISION_OUTPUTS = re\.compile\(r"\^\(stance\|bias\|confidence\|plan_\)"\)/, "the trainer uses the baseline's pre-decision rule");
  assert.match(py, /do not reproduce LightGBM's predictions/, "the export is checked before it is written");
});
