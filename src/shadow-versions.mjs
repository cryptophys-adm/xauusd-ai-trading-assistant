// Shadow indicator versions (RFC_INDICATOR_AGENT_PLATFORM P3).
//
// A shadow version is a candidate improvement of an active indicator. It is computed
// on every closed H1 bar from the same pulled TradingView bars, stored, and scored by
// the deterministic outcome scoring (src/outcome-scoring.mjs). It never reaches a
// room, a prompt, the evidence or a decision.
//
// Every candidate is compared with a CONTROL: the active, parity-approved engine code
// replayed with its default parameters on the very same bars and the same history
// window. The comparison is therefore like for like: same bars, same warm-up, only
// the candidate's change differs. The control is also checked against the approved
// local records (`localcalc:*`), so a drift in the replay is visible.
//
// The engine files stay untouched (their provenance hashes are unchanged): a version
// only passes different parameters to the existing pure functions.
//
// Promotion is never automatic. The read model reports whether a candidate is better
// on the RFC criteria; the owner decides, and promotion is a separate reviewed PR.

import { replayProphetR37ClosedBars } from "./prophet-r37-oscillator.mjs";
import { replayProphetR37Structure } from "./prophet-r37-kernel.mjs";
import { calculateProphetR38Core } from "../local-engines/prophet-r38/src/core.mjs";
import { prophetConsensusDir } from "../local-engines/producer/src/h1-producer.mjs";
import { SCORING, SCORING_VERSION, scoreStance, atrAt, ensureOutcomeSchema } from "./outcome-scoring.mjs";

const SYMBOL = "OANDA:XAUUSD";
const SERIES_KEY = "market-data:v2:series:" + SYMBOL + "|1h";
const MINTICK = 0.001; // the H1 producer's default
/** Bars of history every stored output has behind it (the replay warm-up). */
export const SHADOW_WARMUP_BARS = 300;
/** RFC §4: a version without a TradingView reference needs this many scored statements. */
export const SHADOW_MIN_SAMPLE = 200;
const STUCK_FIELDS = ["d_enc", "b_enc", "subtype"];

export const SHADOW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS shadow_outputs (
  version_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  close_time TEXT NOT NULL,
  stance TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (version_id, candle_key)
)`,
  "CREATE INDEX IF NOT EXISTS idx_shadow_outputs_close ON shadow_outputs(version_id, close_time)"
];

let schemaReady = false;
export async function ensureShadowSchema(db) {
  if (schemaReady) return;
  for (const sql of SHADOW_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetShadowSchemaCacheForTests() { schemaReady = false; }

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const stanceOf = (d) => (d === 1 ? "BUY" : d === -1 ? "SELL" : "WAIT");
const sign = (x) => (finite(x) ? Math.sign(x) : 0);

// ------------------------------------------------------------------ engine families

/** Prophet R37 (GMI-embedded shared core): direction = GMI r10_prophet_consensus_dir. */
function replayR37(bars, structureOptions) {
  const candles = bars.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const r = replayProphetR37ClosedBars(candles, { mintick: MINTICK });
  const structure = structureOptions
    ? replayProphetR37Structure(candles.map((c, i) => ({ ...c, oscillator: r.pro_fast[i], volume_ratio: r.proAnom[i], has_volume: r.hasVolume[i], atr: r.atrValues[i] })), structureOptions)
    : r.structure;
  return structure.map((s, i) => {
    const dir = prophetConsensusDir({ proFast: r.pro_fast[i], dEnc: s.d_enc, subtype: s.subtype });
    return { stance: stanceOf(sign(dir)), fields: { d_enc: s.d_enc, b_enc: s.b_enc, subtype: s.subtype } };
  });
}

/** Prophet R38: direction = the closed-bar BUY/SELL confirmation (as in the H1 producer). */
function replayR38(bars, options = {}) {
  const r = calculateProphetR38Core(bars.map((b) => ({ ...b, confirmed: true })), { timeframe_minutes: 60, gmi_closed_only: true, mintick: MINTICK, ...options });
  return r.outputs.map((o) => {
    const buy = o.confirmation?.buy_confirmed === true, sell = o.confirmation?.sell_confirmed === true;
    return { stance: buy ? "BUY" : sell ? "SELL" : "WAIT", fields: { d_enc: o.structure?.d_enc ?? null, b_enc: o.structure?.b_enc ?? null, subtype: o.structure?.subtype_code ?? null } };
  });
}

export const ENGINE_FAMILIES = Object.freeze({
  prophet_r37: { name: "Prophet R37 (GMI shared core)", active_subject: "indicator:prophet_r37", local_field: "prophet_r37_ssot", replay: replayR37 },
  prophet_r38: { name: "Prophet R38", active_subject: "indicator:prophet_r38", local_field: "prophet_r38", replay: replayR38 }
});

/** Controls: the active engine code replayed with its defaults (one per family). */
export const CONTROLS = Object.freeze(Object.keys(ENGINE_FAMILIES).map((family) => Object.freeze({
  id: family + "@active", family, role: "control", timeframe: "60", params: null,
  change: "none: the active, parity-approved engine code with its default parameters"
})));

/**
 * Candidate versions. P3 ships the framework and the controls only; candidates are added
 * by later phases (P5: the structure-latch expiry), each with its own id and parameters.
 */
export const CANDIDATES = Object.freeze([]);

export function shadowVersions(candidates = CANDIDATES) {
  return [...CONTROLS, ...candidates];
}

const keyOf = (bar) => `${SYMBOL}:60:${Date.parse(bar.open_time)}`;

/** Pure: per-bar outputs of one version over `bars` (oldest first). */
export function computeVersion(version, bars) {
  const family = ENGINE_FAMILIES[version.family];
  if (!family) throw new Error("unknown engine family " + version.family);
  return family.replay(bars, version.params || undefined);
}

// ------------------------------------------------------------------ storage and scoring

async function loadH1Bars(env) {
  let record = null;
  try { record = JSON.parse((await env.SIGNAL_CACHE?.get?.(SERIES_KEY)) || "null"); } catch { record = null; }
  const candles = Array.isArray(record?.candles) ? record.candles : [];
  return candles.filter((c) => [c.open, c.high, c.low, c.close].every(finite) && c.open_time && c.close_time)
    .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
}

async function runBatch(db, statements, chunk = 100) {
  for (let i = 0; i < statements.length; i += chunk) {
    const part = statements.slice(i, i + chunk);
    if (typeof db.batch === "function") await db.batch(part);
    else for (const s of part) await s.run();
  }
}

const INSERT_SCORE_SQL =
  "INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, confidence, result, direction, entry, atr, threshold, max_up, max_down, brier, session, scoring_version, scored_at) VALUES (?, 'shadow', '60', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) " +
  "ON CONFLICT(subject, timeframe, candle_key) DO UPDATE SET stance = excluded.stance, result = excluded.result, direction = excluded.direction, entry = excluded.entry, atr = excluded.atr, threshold = excluded.threshold, max_up = excluded.max_up, max_down = excluded.max_down, session = excluded.session, scoring_version = excluded.scoring_version, scored_at = excluded.scored_at " +
  "WHERE outcome_scores.scoring_version <> excluded.scoring_version";

/**
 * Computes every shadow version over the cached H1 bars, stores the outputs of the closed
 * bars that have at least SHADOW_WARMUP_BARS of history (first computation wins, so a
 * stored output never changes), then scores every stored output whose horizon has closed.
 * Run once an hour by the parity sweep cron. Never touches a decision.
 */
export async function runShadowVersions(env, { now = Date.now(), candidates = CANDIDATES } = {}) {
  if (!env?.DB || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  await ensureShadowSchema(env.DB);
  await ensureOutcomeSchema(env.DB);
  const bars = (await loadH1Bars(env)).filter((b) => Date.parse(b.close_time) <= now);
  if (bars.length <= SHADOW_WARMUP_BARS) return { status: "insufficient_history", bars: bars.length };
  const computedAt = new Date(now).toISOString();
  const versions = shadowVersions(candidates);
  const summary = { status: "ok", bars: bars.length, versions: {} };
  for (const version of versions) {
    const outputs = computeVersion(version, bars);
    const inserts = [];
    for (let i = SHADOW_WARMUP_BARS; i < bars.length; i++) {
      inserts.push(env.DB.prepare("INSERT INTO shadow_outputs (version_id, timeframe, candle_key, close_time, stance, fields_json, computed_at) VALUES (?, '60', ?, ?, ?, ?, ?) ON CONFLICT(version_id, candle_key) DO NOTHING")
        .bind(version.id, keyOf(bars[i]), bars[i].close_time, outputs[i].stance, JSON.stringify(outputs[i].fields), computedAt));
    }
    await runBatch(env.DB, inserts);

    // Score stored outputs not yet scored by the current scoring version.
    const subject = "shadow:" + version.id;
    const pending = (await env.DB.prepare(
      "SELECT so.candle_key, so.close_time, so.stance FROM shadow_outputs so WHERE so.version_id = ? AND so.close_time >= ? AND NOT EXISTS (SELECT 1 FROM outcome_scores os WHERE os.subject = ? AND os.timeframe = '60' AND os.candle_key = so.candle_key AND os.scoring_version = ?)"
    ).bind(version.id, bars[0].close_time, subject, SCORING_VERSION).all()).results || [];
    const scores = [];
    for (const row of pending) {
      const s = scoreStance({ stance: row.stance, bars, closeMs: Date.parse(row.close_time) });
      if (["pending", "no_data", "not_scored"].includes(s.result)) continue;
      scores.push(env.DB.prepare(INSERT_SCORE_SQL).bind(subject, row.candle_key, row.close_time, s.stance, s.result, s.direction, s.entry, s.atr, s.threshold, s.max_up, s.max_down, s.session, SCORING_VERSION, computedAt));
    }
    await runBatch(env.DB, scores);
    summary.versions[version.id] = { stored: inserts.length, scored: scores.length };
  }
  return summary;
}

// ------------------------------------------------------------------ comparison (read model)

/** Stuck episodes over an ordered output series: a run of one value of `field` lasting ≥ n
 *  candles whose high-low range exceeds m × ATR (the stuck-state definition of RFC §5.3). */
export function stuckEpisodes(rows, barsByKey, atrByKey, { n = SCORING.stuckCandles, m = SCORING.stuckRangeAtr } = {}) {
  const out = {};
  for (const field of STUCK_FIELDS) {
    let episodes = 0, stuckCandles = 0, runStart = 0, counted = false;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && rows[i].fields[field] !== rows[i - 1].fields[field]) { runStart = i; counted = false; }
      const len = i - runStart + 1;
      if (len < n || rows[i].fields[field] === null || rows[i].fields[field] === undefined) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = runStart; j <= i; j++) { const b = barsByKey.get(rows[j].candle_key); if (b) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); } }
      const atr = atrByKey.get(rows[i].candle_key);
      if (finite(atr) && hi - lo > m * atr) {
        if (!counted) { episodes += 1; counted = true; }
        stuckCandles += 1;
      }
    }
    out[field] = { episodes, stuck_candles: stuckCandles };
  }
  return out;
}

function tally(scores) {
  const t = { n: 0, directional: { n: 0, hit: 0, miss: 0, neutral: 0 }, wait: { n: 0, hit: 0, missed_opportunity: 0 } };
  for (const s of scores) {
    t.n += 1;
    if (s.stance === "WAIT") { t.wait.n += 1; t.wait[s.result] = (t.wait[s.result] || 0) + 1; }
    else { t.directional.n += 1; t.directional[s.result] = (t.directional[s.result] || 0) + 1; }
  }
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  const right = t.directional.hit + t.wait.hit;
  const decided = t.directional.hit + t.directional.miss + t.wait.hit + t.wait.missed_opportunity;
  return {
    ...t,
    directional: { ...t.directional, hit_rate: rate(t.directional.hit, t.directional.hit + t.directional.miss) },
    wait: { ...t.wait, accuracy: rate(t.wait.hit, t.wait.n) },
    // One number for the comparison: right calls over decided calls (a directional neutral is undecided).
    accuracy: rate(right, decided)
  };
}

/**
 * The shadow view: per family, the control and each candidate over the same bars, with
 * the RFC promotion criteria. Read-only; `days` bounds the window of scored bars.
 */
const READ_CACHE_MS = 5 * 60_000;
const readCache = new Map(); // days -> { at, value }: the view changes once an hour
export function resetShadowReadCacheForTests() { readCache.clear(); }

export async function readShadowVersions(env, { days = 30, now = Date.now(), candidates = CANDIDATES, cache = true } = {}) {
  const hit = cache ? readCache.get(days) : null;
  if (hit && now - hit.at < READ_CACHE_MS) return hit.value;
  const value = await buildShadowView(env, { days, now, candidates });
  if (cache) readCache.set(days, { at: now, value });
  return value;
}

async function buildShadowView(env, { days, now, candidates }) {
  await ensureShadowSchema(env.DB);
  await ensureOutcomeSchema(env.DB);
  const since = new Date(now - days * 86_400_000).toISOString();
  const bars = await loadH1Bars(env);
  const barsByKey = new Map(bars.map((b) => [keyOf(b), b]));
  const atrByKey = new Map(bars.map((b, i) => [keyOf(b), atrAt(bars, i)]));
  const versions = shadowVersions(candidates);
  const load = async (id) => {
    const outputs = ((await env.DB.prepare("SELECT candle_key, close_time, stance, fields_json FROM shadow_outputs WHERE version_id = ? AND close_time >= ? ORDER BY close_time").bind(id, since).all()).results || [])
      .map((r) => ({ candle_key: r.candle_key, close_time: r.close_time, stance: r.stance, fields: JSON.parse(r.fields_json || "{}") }));
    const scores = (await env.DB.prepare("SELECT candle_key, stance, result FROM outcome_scores WHERE subject = ? AND timeframe = '60' AND scoring_version = ? AND statement_close >= ?").bind("shadow:" + id, SCORING_VERSION, since).all()).results || [];
    return { outputs, scores };
  };
  const data = new Map();
  for (const v of versions) data.set(v.id, await load(v.id));

  const families = [];
  for (const [family, spec] of Object.entries(ENGINE_FAMILIES)) {
    const control = versions.find((v) => v.family === family && v.role === "control");
    const c = data.get(control.id);
    // Control check: the replay must agree with the approved local records it shadows.
    let agree = 0, compared = 0;
    for (const row of c.outputs.slice(-24)) {
      let local = null;
      try { local = JSON.parse((await env.WEBHOOK_BUFFER?.get?.("localcalc:" + row.candle_key + ":prophet")) || "null"); } catch { local = null; }
      const f = local?.values?.comparable?.[spec.local_field];
      if (!f) continue;
      compared += 1;
      const localStance = stanceOf(sign(f.direction));
      if (localStance === row.stance && f.structure_subtype === row.fields.subtype && f.d_enc === row.fields.d_enc) agree += 1;
    }
    const controlScores = new Map(c.scores.map((s) => [s.candle_key, s]));
    const entry = {
      family, name: spec.name, active_subject: spec.active_subject,
      control: {
        id: control.id, change: control.change,
        outputs: c.outputs.length, scored: tally(c.scores),
        stuck: stuckEpisodes(c.outputs, barsByKey, atrByKey),
        matches_approved_local_records: { compared, agree }
      },
      candidates: []
    };
    for (const cand of versions.filter((v) => v.family === family && v.role === "candidate")) {
      const d = data.get(cand.id);
      // Like for like: only bars scored for both the candidate and the control.
      const shared = d.scores.filter((s) => controlScores.has(s.candle_key));
      const controlShared = shared.map((s) => controlScores.get(s.candle_key));
      const mine = tally(shared), theirs = tally(controlShared);
      const stuck = stuckEpisodes(d.outputs, barsByKey, atrByKey);
      const controlStuck = entry.control.stuck;
      const differ = shared.filter((s) => controlScores.get(s.candle_key).stance !== s.stance).length;
      const criteria = {
        higher_outcome_score: mine.accuracy !== null && theirs.accuracy !== null ? mine.accuracy > theirs.accuracy : null,
        no_worse_calibration: "not_applicable: indicator directions carry no confidence (Brier needs one)",
        no_new_stuck_states: STUCK_FIELDS.every((f) => stuck[f].episodes <= controlStuck[f].episodes),
        reference_parity: cand.reference === "none" ? "not_applicable: local-only version (option b); owner decision 1 decides whether promotion needs a Pine candidate" : "pending",
        minimum_sample: shared.length >= SHADOW_MIN_SAMPLE
      };
      const better = criteria.higher_outcome_score === true && criteria.no_new_stuck_states === true;
      entry.candidates.push({
        id: cand.id, change: cand.change, params: cand.params, reference: cand.reference ?? "none", lifecycle: "candidate (shadow)",
        same_bars: shared.length, differing_stances: differ,
        scored: mine, control_on_same_bars: theirs,
        stuck,
        criteria,
        verdict: !criteria.minimum_sample ? "collecting" : better ? "better_than_active: ready for owner review" : "not_better",
        latest: d.outputs.slice(-6).map((o) => ({ close_time: o.close_time, stance: o.stance, ...o.fields }))
      });
    }
    entry.control.latest = c.outputs.slice(-6).map((o) => ({ close_time: o.close_time, stance: o.stance, ...o.fields }));
    families.push(entry);
  }
  return { window_days: days, scoring_version: SCORING_VERSION, warmup_bars: SHADOW_WARMUP_BARS, min_sample: SHADOW_MIN_SAMPLE, families };
}
