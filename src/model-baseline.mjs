// The baseline model (owner 2026-11-13: "strengthen autonomous learning & knowledge looping";
// docs/RFC_CUSTOM_MODEL.md step 2). It learns by itself, every hour, from the custom model's dataset
// (src/model-dataset.mjs): one L2-regularised logistic regression per label set and side, predicting
// whether price reaches the target before the stop from the decision's point-in-time features.
//   - Walk-forward check every hour: trained on the oldest 70 % of the decisive rows, judged on the
//     newest 30 % (Brier score against the base rate, AUC, and the mean R of the rows it would pick);
//     then trained again on every row for the next hour's predictions.
//   - Shadow only: each new decision gets the model's probabilities when its dataset row is written
//     (the model trained before it, so point in time), and once the row is labeled the predictions are
//     scored against what happened (the prospective record, the honest verdict).
//   - It never feeds a room, a decision or Omega; promotion needs the verdict of RFC §4 and the owner.
// Deterministic (batch gradient descent, fixed steps), a few hundred milliseconds of CPU. Its report goes
// to Aether as knowledge (src/aether-push.mjs pushModelReport). KV `model:baseline:v1`; switch
// MODEL_BASELINE_MODE = "on" (default) | "off".

export const MODEL_BASELINE_VERSION = "cryptophys.model-baseline.v1";
export const MODEL_BASELINE_KEY = "model:baseline:v1";
export const MODEL_REPORT_SCHEMA = "cryptophys.model-report.v1";
export const BASELINE = Object.freeze({ min_rows: 150, min_test: 40, train_share: 0.7, feature_presence: 0.2, steps: 300, learning_rate: 0.3, l2: 0.02, retrain_ms: 55 * 60_000, top_features: 12 });
/** The label sets a model learns: the dataset's columns for each. */
export const LABEL_SETS = Object.freeze(["tight", "wide"]);
const SIDES = Object.freeze(["long", "short"]);

const num = (x) => typeof x === "number" && Number.isFinite(x);
const r4 = (x) => Math.round(x * 10_000) / 10_000;
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
/** P(Z > z) for a standard normal (Abramowitz-Stegun 26.2.17, error below 1e-7). */
function upperTail(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * poly;
  return z >= 0 ? tail : 1 - tail;
}

/** Switch of the autonomous connection to the council: MODEL_AUTO_CONNECT = "on" (default) | "off". */
export function modelGateMode(env) {
  return String(env?.MODEL_AUTO_CONNECT ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

export function modelBaselineMode(env) {
  return String(env?.MODEL_BASELINE_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * Features a model never uses: the decision's own outputs (its stance, bias, confidence and the plan it
 * chose). The model must read only what was known before the council answered, so the council can be
 * given its advice (promotionGate, modelAdvice) on the same footing as it was trained.
 */
export const DECISION_OUTPUTS = /^(stance|bias|confidence|plan_)/;

/** Pure: the features a model uses: known before the decision, present in at least `presence` of the rows, not constant. */
export function selectFeatures(rows, { presence = BASELINE.feature_presence } = {}) {
  const count = new Map();
  for (const r of rows) for (const [k, v] of Object.entries(r.features || {})) if (num(v) && !DECISION_OUTPUTS.test(k)) count.set(k, (count.get(k) || 0) + 1);
  const keys = [...count.entries()].filter(([, n]) => n >= presence * rows.length).map(([k]) => k).sort();
  const scale = {};
  for (const k of keys) {
    const xs = rows.map((r) => r.features?.[k]).filter(num);
    const m = mean(xs), sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    if (sd > 1e-9) scale[k] = [r4(m), r4(sd)];
  }
  return scale;
}

/** Pure: a row's standardised feature vector (a missing feature reads as its mean). */
function vector(features, keys, scale) {
  return keys.map((k) => { const v = features?.[k]; const [m, sd] = scale[k]; return num(v) ? Math.max(-6, Math.min(6, (v - m) / sd)) : 0; });
}

/** Pure: fit a logistic regression on `rows` ({ features, y }) with fixed steps. */
export function fitLogistic(rows, { scale = selectFeatures(rows), steps = BASELINE.steps, lr = BASELINE.learning_rate, l2 = BASELINE.l2 } = {}) {
  const keys = Object.keys(scale);
  const X = rows.map((r) => vector(r.features, keys, scale)), y = rows.map((r) => r.y);
  const base = Math.min(0.99, Math.max(0.01, mean(y) ?? 0.5));
  let b = Math.log(base / (1 - base));
  const w = new Array(keys.length).fill(0);
  const n = rows.length;
  for (let s = 0; s < steps; s++) {
    const g = new Array(keys.length).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < keys.length; j++) z += w[j] * X[i][j];
      const e = sigmoid(z) - y[i];
      gb += e;
      for (let j = 0; j < keys.length; j++) g[j] += e * X[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < keys.length; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
  }
  return { keys, scale, weights: w.map(r4), bias: r4(b), base_rate: r4(base), n };
}

/** Pure: a fitted model's probability for one feature set. */
export function predict(model, features) {
  if (!model?.keys?.length) return null;
  const x = vector(features, model.keys, model.scale);
  let z = model.bias;
  for (let j = 0; j < x.length; j++) z += model.weights[j] * x[j];
  return r4(sigmoid(z));
}

/** Pure: the area under the ROC curve (ties count half), or null without both classes. */
export function auc(ps, ys) {
  const pos = [], neg = [];
  ps.forEach((p, i) => (ys[i] ? pos : neg).push(p));
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const a of pos) for (const c of neg) s += a > c ? 1 : a === c ? 0.5 : 0;
  return r4(s / (pos.length * neg.length));
}

/** Pure: the model's scores on held-out rows ({ features, y, r }) against the base rate it was trained with. */
export function judge(model, rows) {
  const ps = rows.map((r) => predict(model, r.features)), ys = rows.map((r) => r.y);
  const brier = mean(ps.map((p, i) => (p - ys[i]) ** 2)), brierBase = mean(ys.map((y) => (model.base_rate - y) ** 2));
  const picked = rows.filter((r, i) => ps[i] >= 0.5);
  return {
    n: rows.length, hit_rate: r4(mean(ys)), brier: r4(brier), brier_base: r4(brierBase),
    skill: brierBase > 0 ? r4(1 - brier / brierBase) : null, auc: auc(ps, ys),
    picked: picked.length, picked_hit_rate: picked.length ? r4(mean(picked.map((r) => r.y))) : null,
    picked_mean_r: picked.length ? r4(mean(picked.map((r) => r.r))) : null, all_mean_r: r4(mean(rows.map((r) => r.r)))
  };
}

/** Pure: the rows of one label set and side that a model learns from (decisive: target or stop), oldest first. */
export function decisiveRows(rows, set, side) {
  return rows.map((r) => ({ bar_close: r.bar_close, features: r.features, ...r.labels?.[set]?.[side] }))
    .filter((r) => r.outcome === "target" || r.outcome === "stop")
    .map((r) => ({ bar_close: r.bar_close, features: r.features, y: r.outcome === "target" ? 1 : 0, r: num(r.r) ? r.r : r.outcome === "target" ? 1.5 : -1 }))
    .sort((a, b) => (a.bar_close < b.bar_close ? -1 : 1));
}

/** Pure: the whole baseline from the labeled rows ({ bar_close, features, labels: { tight: { long, short }, wide } }). */
export function trainBaseline(rows, { now = Date.now(), rules = BASELINE } = {}) {
  const models = {}, checks = {};
  for (const set of LABEL_SETS) for (const side of SIDES) {
    const id = `${set}_${side}`;
    const data = decisiveRows(rows, set, side);
    const cut = Math.floor(data.length * rules.train_share);
    if (data.length < rules.min_rows || data.length - cut < rules.min_test) { checks[id] = { status: "not_enough_rows", rows: data.length, needed: rules.min_rows }; continue; }
    const check = fitLogistic(data.slice(0, cut));
    checks[id] = { status: "ok", train: cut, train_from: data[0].bar_close, test_from: data[cut].bar_close, ...judge(check, data.slice(cut)) };
    const model = fitLogistic(data);
    const top = model.keys.map((k, j) => ({ feature: k, weight: model.weights[j] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, rules.top_features);
    models[id] = { ...model, top_features: top };
  }
  const trained = Object.keys(models);
  return {
    version: MODEL_BASELINE_VERSION, model_id: `baseline@${new Date(now).toISOString().slice(0, 16)}Z`, trained_at: new Date(now).toISOString(),
    rows: rows.length, models, checks, status: trained.length ? "ok" : "not_enough_rows"
  };
}

/** Pure: the shadow predictions of a baseline for one feature set ({ tight: { long, short }, wide: ... }). */
export function shadowPredictions(baseline, features) {
  if (!baseline?.models || !Object.keys(baseline.models).length) return null;
  const out = { model_id: baseline.model_id };
  for (const [id, m] of Object.entries(baseline.models)) {
    const [set, side] = id.split("_");
    out[set] = { ...(out[set] || {}), [side]: predict(m, features), [`${side}_base`]: m.base_rate };
  }
  return out;
}

/**
 * Pure: the prospective record: the shadow predictions made before each decision, scored once its labels
 * arrived ({ shadow, labels } rows). Per model: Brier against the base rate it knew, and the R of its picks.
 */
export function prospectiveRecord(rows) {
  const out = {};
  for (const set of LABEL_SETS) for (const side of SIDES) {
    const scored = rows.map((r) => ({ p: r.shadow?.[set]?.[side], base: r.shadow?.[set]?.[`${side}_base`], l: r.labels?.[set]?.[side] }))
      .filter((x) => num(x.p) && num(x.base) && (x.l?.outcome === "target" || x.l?.outcome === "stop"));
    if (!scored.length) continue;
    const y = (x) => (x.l.outcome === "target" ? 1 : 0), rOf = (x) => (num(x.l.r) ? x.l.r : y(x) ? 1.5 : -1);
    const brier = mean(scored.map((x) => (x.p - y(x)) ** 2)), brierBase = mean(scored.map((x) => (x.base - y(x)) ** 2));
    // Paired gain per decision (the base rate's squared error minus the model's): a one-sided z test.
    const gains = scored.map((x) => (x.base - y(x)) ** 2 - (x.p - y(x)) ** 2);
    const g = mean(gains), sd = Math.sqrt(mean(gains.map((d) => (d - g) ** 2)) * (gains.length / Math.max(1, gains.length - 1)));
    const z = sd > 0 ? g / (sd / Math.sqrt(gains.length)) : 0;
    const picked = scored.filter((x) => x.p >= 0.5);
    out[`${set}_${side}`] = {
      n: scored.length, brier: r4(brier), brier_base: r4(brierBase), skill: brierBase > 0 ? r4(1 - brier / brierBase) : null, p_value: r4(upperTail(z)),
      auc: auc(scored.map((x) => x.p), scored.map(y)), picked: picked.length,
      picked_mean_r: picked.length ? r4(mean(picked.map(rOf))) : null, all_mean_r: r4(mean(scored.map(rOf)))
    };
  }
  return out;
}

/**
 * The gate that connects the model to the decision by itself (owner 2026-11-13: "Apakah menyambungkan ini
 * masih manual? Jika iya, buat agar autonomous"). A label set's model is promoted when, on its
 * prospective record (decisions it had not seen), BOTH sides hold at least 300 decisive decisions, beat
 * the base rate significantly (paired Brier gain, one-sided p < 0.05), and rank outcomes better than
 * chance (AUC at least 0.55). It is demoted as soon as that no longer holds. Promoted, its probabilities
 * go to the Decision Engine council as advice (context.model); the guardrails stay the gate.
 */
export const GATE = Object.freeze({ min_n: 300, alpha: 0.05, min_auc: 0.55 });

/** Pure: the promotion state from a baseline's prospective record. */
export function promotionGate(prospective, { gate = GATE } = {}) {
  const passing = [];
  const reasons = [];
  for (const set of LABEL_SETS) {
    const l = prospective?.[`${set}_long`], s = prospective?.[`${set}_short`];
    const fail = [];
    for (const [side, r] of [["long", l], ["short", s]]) {
      if (!r) { fail.push(`${side}: no prospective record`); continue; }
      if (r.n < gate.min_n) fail.push(`${side}: ${r.n} of ${gate.min_n} decisions`);
      else {
        if (!(r.skill > 0) || !(r.p_value < gate.alpha)) fail.push(`${side}: not better than the base rate (skill ${r.skill}, p ${r.p_value})`);
        if (!(r.auc >= gate.min_auc)) fail.push(`${side}: AUC ${r.auc}`);
      }
    }
    if (!fail.length) passing.push({ set, skill: Math.min(l.skill, s.skill) });
    else reasons.push(`${set}: ${fail.join("; ")}`);
  }
  if (!passing.length) return { status: "not_promoted", set: null, reason: reasons.join(" | ") };
  const best = passing.sort((a, b) => b.skill - a.skill)[0];
  return { status: "promoted", set: best.set, reason: `${best.set}: both sides beat the base rate on ${gate.min_n}+ decisions it had not seen` };
}

/** Pure: the owner's Telegram line when the gate changed (null otherwise). */
export function gateMessage(previous, next) {
  const was = previous?.status === "promoted" ? previous.set : null, now = next?.status === "promoted" ? next.set : null;
  if (was === now) return null;
  if (now) return `🤖 Baseline model connected (autonomous): its ${now} probabilities now go to the Decision Engine council as advice. ${next.reason}. The guardrails still decide what can trade.`;
  return `🤖 Baseline model disconnected (autonomous): the council no longer receives its advice. ${next?.reason ?? ""}`.trim();
}

/** Pure: the report for Aether (cryptophys.model-report.v1): measures and feature names only, never a price. */
export function modelReport(baseline, prospective, { now = Date.now(), liveNotes = [] } = {}) {
  if (!baseline || baseline.status !== "ok") return null;
  const models = {};
  for (const [id, check] of Object.entries(baseline.checks || {})) {
    if (check.status !== "ok") continue;
    const { train_from, test_from, status, ...scores } = check;
    models[id] = { ...scores, top_features: (baseline.models[id]?.top_features || []).map((f) => ({ feature: f.feature, weight: f.weight })) };
  }
  // For Cerebrum (owner 2026-11-13: "Pastikan Modul training ini punya visualisasi di cerebrum"): whether the
  // model is connected to the council and the gate it must pass, and the learned notes live by themselves.
  const promotion = baseline.promotion ? { status: baseline.promotion.status, set: baseline.promotion.set ?? null, reason: String(baseline.promotion.reason ?? "").slice(0, 400), since: baseline.promotion.since ?? null } : null;
  const live_notes = (liveNotes || []).slice(0, 20).map((n) => ({ item_id: String(n.item_id), version: Number(n.version), status: String(n.status), agents: (n.agents || []).map(String).slice(0, 8), chart: n.chart ?? null, promoted_at: n.promoted_at ?? null, retired_at: n.retired_at ?? null, reason: n.reason ? String(n.reason).slice(0, 300) : null }));
  return { schema: MODEL_REPORT_SCHEMA, generated_at: new Date(now).toISOString(), model_id: baseline.model_id, rows: baseline.rows, label_sets: LABEL_SETS, walk_forward: models, prospective: prospective || {}, promotion, gate: { ...GATE }, live_notes };
}

/** The stored baseline, or null (mode off, none yet, unreadable). */
export async function readBaseline(env) {
  if (modelBaselineMode(env) === "off") return null;
  try { return JSON.parse((await env?.SIGNAL_CACHE?.get?.(MODEL_BASELINE_KEY)) || "null"); } catch { return null; }
}

/** The status for the API: the walk-forward checks, the prospective record and the top features (no weights table). */
export function baselineStatus(baseline) {
  if (!baseline) return null;
  const top = Object.fromEntries(Object.entries(baseline.models || {}).map(([id, m]) => [id, m.top_features]));
  return { version: baseline.version, model_id: baseline.model_id, trained_at: baseline.trained_at, rows: baseline.rows, status: baseline.status, checks: baseline.checks, prospective: baseline.prospective || {}, promotion: baseline.promotion ?? null, gate: { ...GATE }, top_features: top };
}

/**
 * Hourly (from the ledger step): retrain from every labeled row when the stored model is older than
 * BASELINE.retrain_ms, keep it in KV, and return the report for Aether. `loadRows` gives the labeled rows.
 * Never throws.
 */
export async function runModelBaseline(env, { now = Date.now(), loadRows, loadLiveNotes = async () => [] } = {}) {
  if (modelBaselineMode(env) === "off") return { status: "disabled" };
  if (!env?.SIGNAL_CACHE || typeof loadRows !== "function") return { status: "unavailable" };
  try {
    const current = await readBaseline(env);
    if (current?.trained_at && now - Date.parse(current.trained_at) < BASELINE.retrain_ms) return { status: "fresh", model_id: current.model_id };
    const rows = await loadRows();
    const baseline = trainBaseline(rows, { now });
    baseline.prospective = prospectiveRecord(rows);
    const gate = modelGateMode(env) === "off" ? { status: "not_promoted", set: null, reason: "MODEL_AUTO_CONNECT is off" } : promotionGate(baseline.prospective);
    // A promoted set needs its model; without one (too few rows now) it is not connected.
    baseline.promotion = gate.status === "promoted" && !baseline.models[`${gate.set}_long`] ? { status: "not_promoted", set: null, reason: `${gate.set}: no trained model` } : { ...gate, since: gate.status === "promoted" && current?.promotion?.set === gate.set ? current.promotion.since : gate.status === "promoted" ? baseline.trained_at : null };
    await env.SIGNAL_CACHE.put(MODEL_BASELINE_KEY, JSON.stringify(baseline), { expirationTtl: 7 * 86_400 });
    const skills = Object.fromEntries(Object.entries(baseline.checks).map(([id, c]) => [id, c.status === "ok" ? c.skill : c.status]));
    return { status: baseline.status, model_id: baseline.model_id, rows: rows.length, skills, promotion: baseline.promotion.status, gate_message: gateMessage(current?.promotion, baseline.promotion), report: modelReport(baseline, baseline.prospective, { now, liveNotes: await loadLiveNotes().catch(() => []) }) };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}
