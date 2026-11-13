// The decision model (owner 2026-11-13: "1-3"; docs/RFC_CUSTOM_MODEL.md step 3). A GitHub Actions
// workflow (.github/workflows/train-model.yml, scripts/train_gbm.py) trains LightGBM classifiers on the
// custom model's dataset once a day and writes their trees, as compact JSON, to KV `model:gbm:v1`. The
// AI Worker evaluates those trees itself: no runtime, no network, a few microseconds per prediction.
//   - Shadow only, like the baseline (src/model-baseline.mjs): each new dataset row stores the gbm's
//     probabilities next to the baseline's (`shadow_json.gbm`), only for a model trained before the
//     decision; once labeled they make the gbm's prospective record (`/api/model/gbm`).
//   - It feeds no room, decision or Omega.
// A compact tree is a leaf value, or [feature index, threshold, default_left 0|1, missing 0 None |
// 1 Zero | 2 NaN, left, right], LightGBM's numerical decision exactly (the trainer checks the export
// reproduces LightGBM's predictions on every row before it writes). Switch MODEL_GBM_MODE (on).

export const MODEL_GBM_VERSION = "cryptophys.model-gbm.v1";
export const MODEL_GBM_KEY = "model:gbm:v1";
const CACHE_MS = 10 * 60_000;
let cache = null;
export function resetGbmCacheForTests() { cache = null; }

const num = (x) => typeof x === "number" && Number.isFinite(x);
const r4 = (x) => Math.round(x * 10_000) / 10_000;
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function modelGbmMode(env) {
  return String(env?.MODEL_GBM_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/** Pure: one compact tree's leaf for the feature vector `x` (NaN = missing). */
export function walkTree(node, x) {
  let n = node;
  for (let depth = 0; Array.isArray(n); depth++) {
    if (depth > 64) return 0;
    const [f, t, defaultLeft, missing, left, right] = n;
    let v = x[f];
    if (Number.isNaN(v) && missing !== 2) v = 0;
    if ((missing === 1 && v === 0) || (missing === 2 && Number.isNaN(v))) n = defaultLeft ? left : right;
    else n = v <= t ? left : right;
  }
  return num(n) ? n : 0;
}

/** Pure: a model's probability for a feature set (named features; a missing one is NaN). */
export function predictGbm(model, features, names) {
  if (!Array.isArray(model?.trees) || !model.trees.length || !Array.isArray(names)) return null;
  const x = names.map((k) => (num(features?.[k]) ? features[k] : NaN));
  let z = 0;
  for (const t of model.trees) z += walkTree(t, x);
  return r4(sigmoid(z));
}

/** Pure: the problems of a stored gbm (empty when it may be used). */
export function gbmProblems(g) {
  if (!g || typeof g !== "object") return ["not_an_object"];
  const out = [];
  if (g.version !== MODEL_GBM_VERSION) out.push("unsupported_version");
  if (!Array.isArray(g.features) || !g.features.every((k) => typeof k === "string" && /^[a-z0-9_]{1,64}$/.test(k))) out.push("features_invalid");
  if (!Number.isFinite(Date.parse(g.trained_at))) out.push("trained_at_invalid");
  for (const [id, m] of Object.entries(g.models || {})) {
    if (!/^(tight|wide)_(long|short)$/.test(id) || !Array.isArray(m?.trees) || !num(m?.base_rate)) out.push(`model_invalid:${id}`);
  }
  return out;
}

/** The stored gbm (validated), cached a few minutes per isolate, or null. Never throws. */
export async function readGbm(env, { now = Date.now() } = {}) {
  if (modelGbmMode(env) === "off" || !env?.SIGNAL_CACHE) return null;
  if (cache && now - cache.at < CACHE_MS) return cache.model;
  let model = null;
  try { model = JSON.parse((await env.SIGNAL_CACHE.get(MODEL_GBM_KEY)) || "null"); } catch { model = null; }
  if (model && gbmProblems(model).length) model = null;
  cache = { at: now, model };
  return model;
}

/** Pure: the gbm's shadow predictions for one feature set ({ model_id, tight: { long, long_base, ... } }). */
export function gbmPredictions(gbm, features) {
  if (!gbm?.models || !Object.keys(gbm.models).length) return null;
  const out = { model_id: gbm.model_id };
  for (const [id, m] of Object.entries(gbm.models)) {
    const [set, side] = id.split("_");
    out[set] = { ...(out[set] || {}), [side]: predictGbm(m, features, gbm.features), [`${side}_base`]: m.base_rate };
  }
  return out;
}

/** The status for the API: the trainer's walk-forward checks and top features (never the trees). */
export function gbmStatus(gbm, prospective = null) {
  if (!gbm) return null;
  const top = Object.fromEntries(Object.entries(gbm.models || {}).map(([id, m]) => [id, m.top_features ?? []]));
  return { version: gbm.version, model_id: gbm.model_id, trained_at: gbm.trained_at, rows: gbm.rows, features: (gbm.features || []).length, status: gbm.status, checks: gbm.checks, top_features: top, prospective: prospective ?? {} };
}

/**
 * Pure: the gbm's block in the model report for Aether (owner 2026-11-13: "lanjutkan perluas model report gbm
 * ke Aether"): the trainer's walk-forward checks, the prospective record and the features it split on by gain;
 * never a tree, a threshold or a leaf. Shadow only, so `connected` is always false. Null without a model.
 */
export function gbmReport(gbm, prospective = {}) {
  if (!gbm || !gbm.model_id) return null;
  const SCORES = ["train", "n", "hit_rate", "brier", "brier_base", "skill", "auc", "picked", "picked_mean_r", "all_mean_r"];
  const walk_forward = {};
  for (const [id, check] of Object.entries(gbm.checks || {})) {
    if (check?.status !== "ok") continue;
    const scores = Object.fromEntries(SCORES.filter((k) => k in check).map((k) => [k, num(check[k]) ? check[k] : null]));
    const top = (gbm.models?.[id]?.top_features || []).slice(0, 12).filter((f) => /^[a-z0-9_]{1,64}$/.test(String(f?.feature)) && num(f?.gain)).map((f) => ({ feature: f.feature, gain: f.gain }));
    walk_forward[id] = { ...scores, top_features: top };
  }
  return { model_id: gbm.model_id, trained_at: gbm.trained_at, rows: Number(gbm.rows) || 0, features: (gbm.features || []).length, status: gbm.status === "ok" ? "ok" : "not_enough_rows", walk_forward, prospective: prospective || {}, connected: false };
}
