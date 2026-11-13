// The custom model's dataset (owner 2026-11-13: "Kekuatan utama system platform ini adalah auto learningnya
// dan knowledge mastering, end goalnya mampu membuat custom model sendiri dari knowledge ini khusus untuk EA
// dan XAUUSD Trading Assistant"; docs/RFC_CUSTOM_MODEL.md, step 1). One row per Decision Engine decision
// (D1 engine_decisions, one per 15m close):
//   features  numbers only, point in time: what the decision knew when it was made (its witnesses, quorum,
//             guardrails, plan, structure, context) and the 15m bars up to its close. No price: every
//             distance is in ATR, so a model learns gold's behaviour, not its price level.
//   labels    for a long and a short from the decision bar's close, whichever barrier price touched first
//             on the bars after it (1m where the 1m series reaches): the target 1.5 ATR away, the stop
//             1 ATR away, or neither within 4 hours (expired, with the move at the horizon in R). A bar
//             that touches both counts as the stop (conservative). The ATR is the 15m ATR(14) at the
//             decision's close. No spread: the labels measure the market, not an execution.
// The labels do not depend on the decision's stance, so a model can learn when to trade and when to wait.
// Never feeds a room, a decision or Omega: it only records. Switch: MODEL_DATASET_MODE = "on" (default) | "off".
import { ledgerSeries, atrAt, toMs, sessionAt } from "./signal-ledger.mjs";
import { WITNESS_PRIORS } from "./witness-weighting.mjs";

export const MODEL_DATASET_VERSION = "cryptophys.model-dataset.v1";
export const LABEL_RULES = Object.freeze({ stop_atr: 1, target_atr: 1.5, horizon_ms: 4 * 3600_000, atr_period: 14 });
/** A row whose bars never arrive (a gap in every series) stops waiting after this. */
export const LABEL_GIVE_UP_MS = 7 * 86_400_000;
const BATCH = 200;
const M15 = 15 * 60_000;

const num = (x) => typeof x === "number" && Number.isFinite(x);
const r4 = (x) => Math.round(x * 10_000) / 10_000;
const dir = (s) => (s === "BUY" || s === "BULLISH" || s === "up" ? 1 : s === "SELL" || s === "BEARISH" || s === "down" ? -1 : 0);
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export function modelDatasetMode(env) {
  return String(env?.MODEL_DATASET_MODE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * Pure: the bar features at a decision's close from the 15m bars (oldest first) up to index `k` (the bar
 * that closes at the decision): moves and the range position in ATR, and the ATR against its own mean.
 */
export function barFeatures(m15, k, atr) {
  if (!num(atr) || atr <= 0 || k < 0 || !m15[k]) return {};
  const c = m15[k].close, out = {};
  for (const n of [1, 4, 16, 96]) if (k - n >= 0) out[`px_move_${n}`] = r4((c - m15[k - n].close) / atr);
  const w = m15.slice(Math.max(0, k - 19), k + 1);
  const hi = Math.max(...w.map((b) => b.high)), lo = Math.min(...w.map((b) => b.low));
  if (hi > lo) out.px_range_pos_20 = r4((c - lo) / (hi - lo));
  out.px_bar_body = r4((c - m15[k].open) / atr);
  out.px_bar_range = r4((m15[k].high - m15[k].low) / atr);
  const longer = [];
  for (let j = Math.max(1, k - 95); j <= k; j++) { const a = atrAt(m15, j); if (num(a)) longer.push(a); }
  if (longer.length >= 20) out.atr_rel_96 = r4(atr / (longer.reduce((s, x) => s + x, 0) / longer.length));
  return out;
}

/**
 * Pure: the numeric features of one stored decision (engine_decisions decision_json), point in time.
 * `atr` is the 15m ATR at its close (for the plan's risk in ATR), `bars` the bar features (barFeatures).
 */
export function datasetFeatures(decision, { atr = null, bars = {} } = {}) {
  const d = decision && typeof decision === "object" ? decision : {};
  const f = {};
  const put = (k, v) => { if (num(v)) f[k] = r4(v); };
  const closeMs = toMs(d.bar_close);
  if (Number.isFinite(closeMs)) {
    const t = new Date(closeMs), h = t.getUTCHours() + t.getUTCMinutes() / 60;
    put("time_hour_sin", Math.sin((2 * Math.PI * h) / 24));
    put("time_hour_cos", Math.cos((2 * Math.PI * h) / 24));
    put("time_weekday", t.getUTCDay());
    f[`session_${sessionAt(closeMs - M15)}`] = 1;
  }
  put("stance", dir(d.stance));
  put("bias", dir(d.bias));
  put("confidence", d.confidence);
  if (d.trading_mode) f[`mode_${slug(d.trading_mode)}`] = 1;
  put("feed_mt5_fallback", d.feed === "mt5_fallback" ? 1 : 0);
  // The witnesses: each one's lean, confidence, weight and whether it counted.
  const witnesses = Array.isArray(d.witnesses) ? d.witnesses : [];
  for (const key of Object.keys(WITNESS_PRIORS)) {
    const w = witnesses.find((x) => x?.key === key);
    const k = `w_${key.toLowerCase()}`;
    put(`${k}_available`, w?.available && !w?.stale ? 1 : 0);
    if (!w) continue;
    put(`${k}_lean`, w.available && !w.stale ? (num(w.lean) ? w.lean : 0) : 0);
    put(`${k}_weight`, w.weight);
    put(`${k}_confidence`, w.confidence);
    put(`${k}_decision`, dir(w.decision));
    if (w.state) f[`${k}_state_${slug(w.state)}`] = 1;
    if (w.phase) f[`${k}_phase_${slug(w.phase)}`] = 1;
  }
  const q = d.quorum || {};
  for (const k of ["score", "long_share", "short_share", "neutral_share", "weight", "witnesses"]) put(`quorum_${k}`, q[k]);
  // The guardrails of both sides: each check, whether the side was allowed, the entry trigger.
  for (const side of ["long", "short"]) {
    const g = d.guardrails?.[side];
    if (!g) continue;
    put(`g_${side}_allowed`, g.allowed ? 1 : 0);
    for (const c of Array.isArray(g.checks) ? g.checks : []) if (c?.id) put(`g_${side}_${slug(c.id)}`, c.pass ? 1 : 0);
    put(`g_${side}_trigger_fired`, g.entry_trigger?.fired ? 1 : 0);
  }
  // The plan the decision traded (none on a WAIT): its side, entry kind, reward and risk in ATR.
  const t = d.trade || {};
  put("plan_side", dir(t.side));
  if (t.action) f[`plan_action_${slug(t.action)}`] = 1;
  put("plan_rrr", t.rrr);
  put("plan_rrr_target2", t.rrr_all?.tp2);
  if (num(t.risk) && num(atr) && atr > 0) put("plan_risk_atr", t.risk / atr);
  put("plan_at_level", t.at_level === undefined ? undefined : t.at_level ? 1 : 0);
  // The swing structure per chart (display data on the decision since #290).
  for (const [tf, s] of Object.entries(d.structure || {})) put(`structure_${slug(tf)}`, dir(s?.trend));
  // The context: regime, news and calendar leans, the cross assets' daily moves, the next release.
  const c = d.context || {};
  if (c.regime_1h) f[`regime_${slug(c.regime_1h)}`] = 1;
  put("news_weighted_lean", c.market?.sentiment?.weighted_lean);
  put("news_composite", c.market?.sentiment?.composite);
  put("calendar_consensus_lean", c.market?.calendar?.consensus_lean);
  put("calendar_surprise_lean", c.market?.calendar?.surprise_lean);
  put("events_active", Array.isArray(c.events?.active) ? c.events.active.length : undefined);
  const next = Array.isArray(c.events?.next) ? c.events.next.map((e) => toMs(e?.time)).filter(Number.isFinite).sort((a, b) => a - b)[0] : undefined;
  if (Number.isFinite(next) && Number.isFinite(closeMs)) put("events_next_hours", Math.max(0, Math.min(48, (next - closeMs) / 3_600_000)));
  for (const a of Array.isArray(c.cross_assets) ? c.cross_assets : []) {
    const k = slug(a?.name).replace(/^us_/, "");
    put(`x_${k}_change_1d`, a?.change_1d);
    put(`x_${k}_corr`, a?.correlation_with_gold);
  }
  for (const [k, v] of Object.entries(bars || {})) put(k, v);
  return f;
}

/**
 * Pure: the first barrier price touches after `fromMs` for a trade in `side` (+1 long, -1 short) from
 * `ref`, on `bars` (closed, oldest first; any span). Returns { outcome: "target" | "stop" | "expired" |
 * "pending", r, mfe, mae, at } in R (1 R = the stop distance), or pending while the horizon is not covered.
 */
export function tripleBarrier(bars, { fromMs, ref, atr, side, rules = LABEL_RULES }) {
  if (!num(ref) || !num(atr) || atr <= 0 || !side) return { outcome: "pending" };
  const risk = rules.stop_atr * atr, endMs = fromMs + rules.horizon_ms;
  const stop = ref - side * risk, target = ref + side * rules.target_atr * atr;
  let mfe = 0, mae = 0, last = null;
  for (const b of bars) {
    const open = toMs(b.open_time), close = toMs(b.close_time);
    if (open < fromMs) continue;
    if (close > endMs) break;
    const fav = side > 0 ? b.high - ref : ref - b.low, adv = side > 0 ? ref - b.low : b.high - ref;
    mfe = Math.max(mfe, fav / risk); mae = Math.max(mae, adv / risk);
    const hitStop = side > 0 ? b.low <= stop : b.high >= stop;
    const hitTarget = side > 0 ? b.high >= target : b.low <= target;
    const at = new Date(close).toISOString();
    if (hitStop) return { outcome: "stop", r: -1, mfe: r4(mfe), mae: r4(mae), at };
    if (hitTarget) return { outcome: "target", r: r4(rules.target_atr / rules.stop_atr), mfe: r4(mfe), mae: r4(mae), at };
    last = b;
  }
  // Pending until the series reaches the horizon's end (a market break inside it does not keep it pending).
  if (!bars.length || toMs(bars.at(-1).close_time) < endMs) return { outcome: "pending" };
  if (!last) return { outcome: "no_bars" }; // the market was closed for the whole horizon

  return { outcome: "expired", r: r4((side * (last.close - ref)) / risk), mfe: r4(mfe), mae: r4(mae), at: new Date(endMs).toISOString() };
}

export const MODEL_DATASET_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS model_dataset (
    decision_key TEXT PRIMARY KEY,
    bar_close TEXT NOT NULL,
    version TEXT NOT NULL,
    stance TEXT,
    features_json TEXT NOT NULL,
    ref_close REAL,
    atr REAL,
    label_status TEXT NOT NULL DEFAULT 'pending',
    long_outcome TEXT, long_r REAL, long_mfe REAL, long_mae REAL,
    short_outcome TEXT, short_r REAL, short_mfe REAL, short_mae REAL,
    labeled_at TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_model_dataset_status ON model_dataset(label_status, bar_close)",
  "CREATE INDEX IF NOT EXISTS idx_model_dataset_close ON model_dataset(bar_close)"
];
let schemaReady = false;
export function resetModelDatasetSchemaForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of MODEL_DATASET_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/** Pure: the index of the 15m bar closing at `closeMs` in `m15` (oldest first), or -1. */
function barIndex(m15, closeMs) {
  let lo = 0, hi = m15.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, t = toMs(m15[mid].close_time);
    if (t === closeMs) return mid;
    if (t < closeMs) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/**
 * Every ledger step (5 minutes): new decisions become rows (features at their close), and rows whose
 * 4-hour horizon has passed get their labels. Idempotent, at most 200 of each per run. Never throws.
 */
export async function runModelDataset(env, { now = Date.now(), series = null } = {}) {
  if (modelDatasetMode(env) === "off") return { status: "disabled" };
  if (!env?.DB) return { status: "unavailable" };
  try {
    await ensureSchema(env.DB);
    const { bars, m15 } = series ?? (await ledgerSeries(env));
    const created = new Date(now).toISOString();
    // 1. New decisions (backfills the stored history on the first runs).
    const fresh = (await env.DB.prepare("SELECT d.decision_key, d.bar_close, d.stance, d.decision_json FROM engine_decisions d WHERE NOT EXISTS (SELECT 1 FROM model_dataset m WHERE m.decision_key = d.decision_key) ORDER BY d.bar_close LIMIT ?").bind(BATCH).all()).results || [];
    let added = 0;
    for (const r of fresh) {
      let decision = null;
      try { decision = JSON.parse(r.decision_json); } catch { decision = null; }
      if (!decision) continue;
      const k = barIndex(m15, toMs(r.bar_close));
      const atr = k >= 1 ? atrAt(m15, k, LABEL_RULES.atr_period) : null;
      const features = datasetFeatures({ ...decision, bar_close: decision.bar_close ?? r.bar_close }, { atr, bars: k >= 0 ? barFeatures(m15, k, atr) : {} });
      const res = await env.DB.prepare("INSERT OR IGNORE INTO model_dataset (decision_key, bar_close, version, stance, features_json, ref_close, atr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(r.decision_key, r.bar_close, MODEL_DATASET_VERSION, r.stance, JSON.stringify(features), k >= 0 ? m15[k].close : null, num(atr) ? r4(atr) : null, created).run();
      added += Number(res?.meta?.changes) || 0;
    }
    // 2. Labels once the horizon is covered by closed bars.
    const due = new Date(now - LABEL_RULES.horizon_ms).toISOString();
    const pending = (await env.DB.prepare("SELECT decision_key, bar_close, ref_close, atr FROM model_dataset WHERE label_status = 'pending' AND bar_close <= ? ORDER BY bar_close LIMIT ?").bind(due, BATCH).all()).results || [];
    let labeled = 0, unavailable = 0;
    for (const r of pending) {
      const fromMs = toMs(r.bar_close);
      const long = tripleBarrier(bars, { fromMs, ref: r.ref_close, atr: r.atr, side: 1 });
      const short = tripleBarrier(bars, { fromMs, ref: r.ref_close, atr: r.atr, side: -1 });
      if (long.outcome === "pending" || long.outcome === "no_bars" || short.outcome === "pending") {
        // No reference bar (its 15m bar was never cached), a closed market, or bars that never came.
        if (!num(r.ref_close) || !num(r.atr) || long.outcome === "no_bars" || now - fromMs > LABEL_GIVE_UP_MS) {
          await env.DB.prepare("UPDATE model_dataset SET label_status = 'unavailable', labeled_at = ? WHERE decision_key = ?").bind(created, r.decision_key).run();
          unavailable += 1;
        }
        continue;
      }
      await env.DB.prepare("UPDATE model_dataset SET label_status = 'labeled', long_outcome = ?, long_r = ?, long_mfe = ?, long_mae = ?, short_outcome = ?, short_r = ?, short_mfe = ?, short_mae = ?, labeled_at = ? WHERE decision_key = ?")
        .bind(long.outcome, long.r, long.mfe, long.mae, short.outcome, short.r, short.mfe, short.mae, created, r.decision_key).run();
      labeled += 1;
    }
    return { status: "ok", added, labeled, unavailable };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}

/** The dataset's size: rows by label status, the outcomes per side, its span and its feature count. */
export async function readModelDatasetSummary(env) {
  if (!env?.DB) return null;
  try {
    await ensureSchema(env.DB);
    const by = (await env.DB.prepare("SELECT label_status, COUNT(*) AS n, MIN(bar_close) AS first, MAX(bar_close) AS last FROM model_dataset GROUP BY label_status").all()).results || [];
    const outcomes = (await env.DB.prepare("SELECT 'long' AS side, long_outcome AS outcome, COUNT(*) AS n, ROUND(AVG(long_r), 3) AS mean_r FROM model_dataset WHERE label_status = 'labeled' GROUP BY long_outcome UNION ALL SELECT 'short', short_outcome, COUNT(*), ROUND(AVG(short_r), 3) FROM model_dataset WHERE label_status = 'labeled' GROUP BY short_outcome").all()).results || [];
    const latest = await env.DB.prepare("SELECT features_json FROM model_dataset ORDER BY bar_close DESC LIMIT 1").first();
    let features = 0;
    try { features = Object.keys(JSON.parse(latest?.features_json || "{}")).length; } catch { features = 0; }
    return { version: MODEL_DATASET_VERSION, rules: { ...LABEL_RULES }, by_status: by, outcomes, latest_feature_count: features };
  } catch { return null; }
}

/**
 * The labeled rows for training, oldest first from `since` (ISO), with the plan's own outcome from the
 * Signal Ledger where the decision traded (r_tp1, r_omega). At most 2000 per call; `next` pages on.
 */
export async function readModelDataset(env, { since = "", limit = 1000 } = {}) {
  if (!env?.DB) return null;
  await ensureSchema(env.DB);
  const n = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const rows = (await env.DB.prepare(
    "SELECT m.decision_key, m.bar_close, m.version, m.stance, m.features_json, m.long_outcome, m.long_r, m.long_mfe, m.long_mae, m.short_outcome, m.short_r, m.short_mfe, m.short_mae, l.r_tp1 AS plan_r_tp1, l.r_omega AS plan_r_omega, l.omega_status AS plan_omega_status " +
    "FROM model_dataset m LEFT JOIN signal_ledger l ON l.id = 'decision:' || m.decision_key WHERE m.label_status = 'labeled' AND m.bar_close > ? ORDER BY m.bar_close LIMIT ?"
  ).bind(String(since || ""), n).all().catch(() => env.DB.prepare(
    "SELECT decision_key, bar_close, version, stance, features_json, long_outcome, long_r, long_mfe, long_mae, short_outcome, short_r, short_mfe, short_mae FROM model_dataset WHERE label_status = 'labeled' AND bar_close > ? ORDER BY bar_close LIMIT ?"
  ).bind(String(since || ""), n).all())).results || [];
  const out = rows.map((r) => {
    let features = {};
    try { features = JSON.parse(r.features_json); } catch { features = {}; }
    const { features_json, ...rest } = r;
    return { ...rest, features };
  });
  return { version: MODEL_DATASET_VERSION, rules: { ...LABEL_RULES }, rows: out, next: out.length === n ? out.at(-1).bar_close : null };
}
