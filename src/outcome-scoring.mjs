// RFC_INDICATOR_AGENT_PLATFORM P1: deterministic outcome scoring and the stuck-state
// detector. Owner approval 2026-11-05: horizon 4 candles, threshold 0.5 x ATR(14);
// stuck when a state is unchanged for 8 H1 candles while the price range exceeds 3 x ATR.
//
// Parity proves a local port equals TradingView. Outcome scoring measures whether a
// statement turned out right. It reads only prices, never model text, and never changes
// any decision, prompt or evidence: it writes its own tables and serves /api/scorecards.
//
// Prices come from the pull adapter's closed TradingView bars. Its MARKET_DATA_CACHE KV
// is the AI Worker's SIGNAL_CACHE namespace (same id in both wrangler files), keys
// market-data:v2:series:<symbol>|<interval>.

// v2 (owner approval 2026-11-05): WAIT is a missed opportunity only when a BUY or a SELL on
// the same candle would have been a hit (a clean move to the threshold without first touching
// the other side). v1 counted any touch of the threshold, which a 4-candle horizon at
// 0.5 x ATR almost always gives, so nearly every WAIT read as missed (chain 1/35, room 0/56).
//
// v3 (owner approval 2026-11-05): v2 still read WAIT as missed on H1 (chain 1/35). Over 4 H1
// candles some side almost always reaches 0.5 x ATR first, so a 1:1 trade "wins" nearly
// always. A WAIT now misses an opportunity only when a 2:1 trade would have won: price
// reaches 1 x ATR (waitTargetAtr) on one side before touching 0.5 x ATR (thresholdAtr) on
// the other. BUY and SELL scoring is unchanged (1:1 at 0.5 x ATR).
import { reputationFromScorecards, REPUTATION_DAYS } from "./reputation.mjs";

export const SCORING_VERSION = "cryptophys.outcome-scoring.v3";
export const SCORING = Object.freeze({ horizon: 4, atrPeriod: 14, thresholdAtr: 0.5, waitTargetAtr: 1, stuckCandles: 8, stuckRangeAtr: 3 });

const SYMBOL = "OANDA:XAUUSD";
const SERIES_KEY_PREFIX = "market-data:v2:series:";
export const SCORED_TIMEFRAMES = Object.freeze({
  "60": { series: SYMBOL + "|1h", ms: 3_600_000, lookback: 36 },
  "15": { series: SYMBOL + "|15m", ms: 900_000, lookback: 96 }
});

export const OUTCOME_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS outcome_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  statement_close TEXT NOT NULL,
  stance TEXT NOT NULL,
  confidence REAL,
  result TEXT NOT NULL,
  direction INTEGER,
  entry REAL,
  atr REAL,
  threshold REAL,
  max_up REAL,
  max_down REAL,
  brier REAL,
  session TEXT,
  scoring_version TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  UNIQUE(subject, timeframe, candle_key)
)`,
  "CREATE INDEX IF NOT EXISTS idx_outcome_scores_close ON outcome_scores(statement_close)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_scores_subject ON outcome_scores(subject, statement_close)",
  `CREATE TABLE IF NOT EXISTS outcome_runs (
  timeframe TEXT NOT NULL,
  candle_key TEXT NOT NULL,
  statements INTEGER NOT NULL,
  scored_at TEXT NOT NULL,
  PRIMARY KEY (timeframe, candle_key)
)`,
  `CREATE TABLE IF NOT EXISTS stuck_states (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  first_candle_key TEXT NOT NULL,
  last_candle_key TEXT NOT NULL,
  candles INTEGER NOT NULL,
  price_range REAL NOT NULL,
  atr REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'cleared')),
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (field, first_candle_key)
)`,
  "CREATE INDEX IF NOT EXISTS idx_stuck_states_status ON stuck_states(status, updated_at)"
];

let schemaReady = false;
export async function ensureOutcomeSchema(db) {
  if (schemaReady) return;
  for (const sql of OUTCOME_SCHEMA_SQL) await db.prepare(sql).run();
  // Migration 0006 adds the column on D1; this keeps runtime-created schemas in step.
  try { await db.prepare("ALTER TABLE outcome_runs ADD COLUMN scoring_version TEXT").run(); } catch { /* already there */ }
  schemaReady = true;
}
export function resetOutcomeSchemaCacheForTests() { schemaReady = false; }

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const parse = (raw, fallback = null) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

/** BUY / SELL are directional, WAIT is flat. HOLD and CLOSE manage a position and are not scored. */
export function normalizeStance(stance) {
  const s = String(stance ?? "").trim().toUpperCase();
  if (s === "BUY" || s === "LONG") return "BUY";
  if (s === "SELL" || s === "SHORT") return "SELL";
  if (s === "WAIT" || s === "NO_TRADE" || s === "NEUTRAL") return "WAIT";
  return null;
}

/** Simple average of the true range of the `period` bars ending at `index` (needs a previous close). */
export function atrAt(bars, index, period = SCORING.atrPeriod) {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const b = bars[i], prev = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  return sum / period;
}

/** UTC session of a statement by its candle close. */
export function sessionOf(closeMs) {
  const h = new Date(closeMs).getUTCHours();
  return h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "new_york" : "late";
}

/**
 * Scores one stance on `bars` (closed bars of one timeframe, oldest first) for the bar that
 * closes at closeMs. The entry is that bar's close; the next `horizon` bars decide.
 * - BUY / SELL: hit when the favourable excursion reaches the threshold first, miss when the
 *   adverse one does (both within the same bar counts as a miss), neutral when neither does.
 * - WAIT: hit when neither excursion reaches the threshold, missed_opportunity otherwise
 *   (direction +1 / -1 of the first move, 0 when both came within the same bar).
 * Returns { result: "pending" } until the horizon has closed, "no_data" when the bar or
 * its ATR history is missing, "not_scored" for stances outside the definition.
 */
export function scoreStance({ stance, confidence = null, bars, closeMs, horizon = SCORING.horizon, period = SCORING.atrPeriod, k = SCORING.thresholdAtr, waitTarget = SCORING.waitTargetAtr }) {
  const s = normalizeStance(stance);
  if (!s) return { result: "not_scored" };
  const i = bars.findIndex((b) => Date.parse(b.close_time) === closeMs);
  if (i < 0) return { result: "no_data" };
  const atr = atrAt(bars, i, period);
  if (!finite(atr) || atr <= 0) return { result: "no_data" };
  if (bars.length - 1 - i < horizon) return { result: "pending" };
  const entry = bars[i].close;
  const threshold = k * atr;
  let maxUp = 0, maxDown = 0;
  // The first bar whose excursion reaches the threshold decides a directional stance.
  let first = null;
  for (let j = i + 1; j <= i + horizon; j++) {
    const up = bars[j].high - entry, down = entry - bars[j].low;
    maxUp = Math.max(maxUp, up);
    maxDown = Math.max(maxDown, down);
    if (!first && (up >= threshold || down >= threshold)) first = { up: up >= threshold, down: down >= threshold };
  }
  const directional = (side) => (!first ? "neutral" : first.up && first.down ? "miss" : (side === "BUY" ? first.up : first.down) ? "hit" : "miss");
  let result, direction = null;
  if (s === "WAIT") {
    // A WAIT missed an opportunity only when a 2:1 trade would have won: the target
    // (waitTarget x ATR) on one side before the stop (k x ATR) on the other, bar by bar;
    // a bar touching both counts as the stop (conservative).
    const target = waitTarget * atr;
    const wins = (side) => {
      for (let j = i + 1; j <= i + horizon; j++) {
        const fav = side === "BUY" ? bars[j].high - entry : entry - bars[j].low;
        const adv = side === "BUY" ? entry - bars[j].low : bars[j].high - entry;
        if (adv >= threshold) return false;
        if (fav >= target) return true;
      }
      return false;
    };
    const buy = wins("BUY"), sell = wins("SELL");
    result = buy || sell ? "missed_opportunity" : "hit";
    if (result === "missed_opportunity") direction = buy ? 1 : -1;
  } else {
    result = directional(s);
  }
  const p = finite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null;
  const y = result === "hit" ? 1 : 0;
  return {
    result, stance: s, direction, entry, atr, threshold,
    max_up: maxUp, max_down: maxDown,
    brier: p === null ? null : (p - y) ** 2,
    session: sessionOf(closeMs)
  };
}

/**
 * Stuck states over an ordered series (oldest first) of { candle_key, high, low, fields }.
 * A field is stuck when its value is unchanged for at least `n` candles up to the latest one
 * while the high-low range of those candles exceeds m x atr (the ATR at the latest candle).
 */
export function detectStuckStates(series, atr, { n = SCORING.stuckCandles, m = SCORING.stuckRangeAtr } = {}) {
  if (!Array.isArray(series) || !series.length || !finite(atr) || atr <= 0) return [];
  const latest = series.at(-1);
  const out = [];
  for (const [field, value] of Object.entries(latest.fields || {})) {
    if (value === null || value === undefined) continue;
    const key = JSON.stringify(value);
    let start = series.length - 1;
    while (start > 0 && JSON.stringify(series[start - 1].fields?.[field]) === key) start--;
    const run = series.slice(start);
    if (run.length < n) continue;
    const range = Math.max(...run.map((c) => c.high)) - Math.min(...run.map((c) => c.low));
    if (range > m * atr) {
      out.push({ field, value: key, candles: run.length, first_candle_key: run[0].candle_key, last_candle_key: latest.candle_key, price_range: range, atr });
    }
  }
  return out;
}

// ------------------------------------------------------------------ statements

/** H1 indicator stances from the parity-approved local records (deterministic, no model). */
export function indicatorStances(prophet, gmi) {
  const out = [];
  const sign = (x) => (finite(x) ? Math.sign(x) : null);
  const stanceOf = (d) => (d === 1 ? "BUY" : d === -1 ? "SELL" : d === 0 ? "WAIT" : null);
  const r38 = prophet?.values?.comparable?.prophet_r38, r37 = prophet?.values?.comparable?.prophet_r37_ssot;
  const g = gmi?.values?.comparable?.gmi_v12_70;
  if (r38) out.push({ subject: "indicator:prophet_r38", stance: stanceOf(sign(r38.direction)) });
  if (r37) out.push({ subject: "indicator:prophet_r37", stance: stanceOf(sign(r37.direction)) });
  if (g) out.push({ subject: "indicator:gmi_v12_70", stance: stanceOf(sign(g.verdict)) });
  return out.filter((s) => s.stance).map((s) => ({ ...s, source: "indicator", confidence: null }));
}

/** Every stance stated about one closed H1 candle: chain, bus, HUD agents, indicators. */
export async function h1Statements(env, candleKey) {
  const db = env.DB;
  const out = [];
  const decision = await db.prepare("SELECT decision, confidence FROM trade_decisions WHERE candle_key = ? ORDER BY id DESC LIMIT 1").bind(candleKey).first();
  if (decision) out.push({ subject: "chain:h1", source: "chain", stance: decision.decision, confidence: decision.confidence ?? null });
  try {
    const bus = (await db.prepare("SELECT agent, round, insight, confidence, ts FROM bus_messages WHERE candle_key = ? AND status = 'ok' AND (round = 2 OR agent = 'moderator') ORDER BY ts").bind(candleKey).all()).results || [];
    const latest = new Map();
    for (const row of bus) latest.set(row.agent, row);
    for (const [agent, row] of latest) out.push({ subject: "bus:" + agent, source: "bus", stance: parse(row.insight, {})?.stance, confidence: row.confidence ?? null });
  } catch { /* bus tables absent */ }
  try {
    const hud = (await db.prepare("SELECT step, stance, confidence FROM agent_thread_messages WHERE thread_id = ? AND status = 'ok'").bind("hud1h:" + candleKey).all()).results || [];
    for (const row of hud) out.push({ subject: row.step === "moderator" ? "hud:moderator" : row.step, source: "hud", stance: row.stance, confidence: row.confidence ?? null });
  } catch { /* thread tables absent */ }
  const [prophet, gmi] = await Promise.all(["prophet", "gmi"].map(async (e) => parse(await env.WEBHOOK_BUFFER?.get?.("localcalc:" + candleKey + ":" + e))));
  out.push(...indicatorStances(prophet, gmi));
  return out;
}

/** Live 15m room stances by bar close (ISO), for bars closing at or after `sinceIso`. */
export async function roomStatements(env, sinceIso) {
  const byBar = new Map();
  try {
    const rows = (await env.DB.prepare("SELECT bar_time, step, stance, confidence FROM agent_thread_messages WHERE thread_id LIKE 'live15m:%' AND status = 'ok' AND bar_time >= ?").bind(sinceIso).all()).results || [];
    for (const row of rows) {
      const list = byBar.get(row.bar_time) || [];
      list.push({ subject: "room:" + row.step, source: "room", stance: row.stance, confidence: row.confidence ?? null });
      byBar.set(row.bar_time, list);
    }
  } catch { /* thread tables absent */ }
  return byBar;
}

/**
 * P7 (RFC §7): the agents of the rooms that meet today, by bar. Each agent's final stance (its
 * Consensus Discussion answer, else its opening) and the moderator's conclusion are scored as
 * "agent:<id>" on the room's timeframe, so reputation follows the agent from bar to bar.
 *   15: the Live War Room 15m (threads warroom:<day>), keyed by the 15m bar close;
 *   60: the 1H War Room (thread tf:H1), keyed by the H1 candle key (a re-convened session wins).
 */
export async function agentStatements(env, timeframe, sinceIso) {
  const byKey = new Map();
  const add = (key, row) => {
    if (!key || !row.stance) return;
    const list = byKey.get(key) || new Map();
    const agent = row.step === "conclusion" ? "moderator" : String(row.agent);
    const prior = list.get(agent);
    // The Consensus Discussion answer is the final stance; a later session (#hud) wins.
    if (!prior || row.step.startsWith("debate:") || row.step === "conclusion" || String(row.run_id) > String(prior.run_id)) list.set(agent, { subject: "agent:" + agent, source: "room", stance: row.stance, confidence: row.confidence ?? null, run_id: row.run_id, step: row.step });
    byKey.set(key, list);
  };
  try {
    if (timeframe === "15") {
      const rows = (await env.DB.prepare("SELECT run_id, bar_time, step, agent, stance, confidence FROM agent_thread_messages WHERE thread_id LIKE 'warroom:%' AND status = 'ok' AND bar_time >= ? AND (step LIKE 'open:%' OR step LIKE 'debate:%' OR step = 'conclusion') ORDER BY run_id, CASE WHEN step LIKE 'open:%' THEN 0 ELSE 1 END").bind(sinceIso).all()).results || [];
      for (const r of rows) add(r.bar_time, r);
    } else if (timeframe === "60") {
      const rows = (await env.DB.prepare("SELECT m.run_id, m.step, m.agent, m.stance, m.confidence, json_extract(b.body_json, '$.candle_key') AS candle_key FROM agent_thread_messages m JOIN agent_thread_messages b ON b.thread_id = m.thread_id AND b.run_id = m.run_id AND b.step = 'brief' WHERE m.thread_id = 'tf:H1' AND m.status = 'ok' AND m.ts >= ? AND (m.step LIKE 'open:%' OR m.step LIKE 'debate:%' OR m.step = 'conclusion') ORDER BY m.run_id, CASE WHEN m.step LIKE 'open:%' THEN 0 ELSE 1 END").bind(sinceIso).all()).results || [];
      for (const r of rows) add(r.candle_key, r);
    }
  } catch { /* thread tables absent */ }
  return new Map([...byKey].map(([k, m]) => [k, [...m.values()].map(({ run_id: _r, step: _s, ...st }) => st)]));
}

/** The outcome_runs timeframe that marks a bar whose room agents were scored. */
export const AGENT_RUN_SUFFIX = ":agents";

async function loadBars(env, timeframe) {
  const record = parse(await env.SIGNAL_CACHE?.get?.(SERIES_KEY_PREFIX + SCORED_TIMEFRAMES[timeframe].series));
  const candles = Array.isArray(record?.candles) ? record.candles : [];
  return candles.filter((c) => [c.open, c.high, c.low, c.close].every(finite) && c.close_time).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
}

async function insertScore(db, row) {
  // A row scored by an older scoring version is replaced; a current row is final.
  await db.prepare(
    "INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, confidence, result, direction, entry, atr, threshold, max_up, max_down, brier, session, scoring_version, scored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(subject, timeframe, candle_key) DO UPDATE SET stance = excluded.stance, confidence = excluded.confidence, result = excluded.result, direction = excluded.direction, entry = excluded.entry, atr = excluded.atr, threshold = excluded.threshold, max_up = excluded.max_up, max_down = excluded.max_down, brier = excluded.brier, session = excluded.session, scoring_version = excluded.scoring_version, scored_at = excluded.scored_at " +
    "WHERE outcome_scores.scoring_version <> excluded.scoring_version"
  ).bind(row.subject, row.source, row.timeframe, row.candle_key, row.statement_close, row.stance, row.confidence, row.result, row.direction, row.entry, row.atr, row.threshold, row.max_up, row.max_down, row.brier, row.session, SCORING_VERSION, row.scored_at).run();
}

/**
 * Scores every statement whose horizon has closed, once per (timeframe, candle). Run by the
 * parity sweep cron. Idempotent: outcome_runs marks a scored candle; outcome_scores is unique
 * per (subject, timeframe, candle).
 */
export async function scoreRecentStatements(env, { now = Date.now() } = {}) {
  if (!env?.DB || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  await ensureOutcomeSchema(env.DB);
  const scoredAt = new Date(now).toISOString();
  const summary = { status: "ok", candles: 0, scores: 0 };
  for (const [timeframe, spec] of Object.entries(SCORED_TIMEFRAMES)) {
    const bars = await loadBars(env, timeframe);
    if (bars.length < SCORING.atrPeriod + SCORING.horizon + 1) continue;
    const ready = bars.slice(SCORING.atrPeriod, bars.length - SCORING.horizon).slice(-spec.lookback);
    if (!ready.length) continue;
    const keyOf = (bar) => `${SYMBOL}:${timeframe}:${Date.parse(bar.open_time)}`;
    const done = new Set(((await env.DB.prepare("SELECT candle_key FROM outcome_runs WHERE timeframe = ? AND scored_at >= ? AND scoring_version = ?").bind(timeframe, new Date(now - 3 * 86_400_000).toISOString(), SCORING_VERSION).all()).results || []).map((r) => r.candle_key));
    const rooms = timeframe === "15" ? await roomStatements(env, ready[0].close_time) : null;
    for (const bar of ready) {
      const candleKey = keyOf(bar);
      if (done.has(candleKey)) continue;
      const closeMs = Date.parse(bar.close_time);
      const statements = timeframe === "60" ? await h1Statements(env, candleKey) : rooms.get(bar.close_time) || [];
      let written = 0;
      for (const st of statements) {
        const score = scoreStance({ stance: st.stance, confidence: st.confidence, bars, closeMs });
        if (["pending", "no_data", "not_scored"].includes(score.result)) continue;
        await insertScore(env.DB, { ...score, subject: st.subject, source: st.source, timeframe, candle_key: candleKey, statement_close: bar.close_time, confidence: finite(st.confidence) ? st.confidence : null, scored_at: scoredAt });
        written += 1;
      }
      await env.DB.prepare("INSERT INTO outcome_runs (timeframe, candle_key, statements, scored_at, scoring_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(timeframe, candle_key) DO UPDATE SET statements = excluded.statements, scored_at = excluded.scored_at, scoring_version = excluded.scoring_version").bind(timeframe, candleKey, written, scoredAt, SCORING_VERSION).run();
      summary.candles += 1;
      summary.scores += written;
    }
    // P7: the room agents of the same bars, once per bar (their own run marker).
    const agentRun = timeframe + AGENT_RUN_SUFFIX;
    const agentsDone = new Set(((await env.DB.prepare("SELECT candle_key FROM outcome_runs WHERE timeframe = ? AND scored_at >= ? AND scoring_version = ?").bind(agentRun, new Date(now - 3 * 86_400_000).toISOString(), SCORING_VERSION).all()).results || []).map((r) => r.candle_key));
    const byKey = await agentStatements(env, timeframe, timeframe === "60" ? new Date(Date.parse(ready[0].open_time) - 3_600_000).toISOString() : ready[0].close_time);
    for (const bar of ready) {
      const candleKey = keyOf(bar);
      if (agentsDone.has(candleKey)) continue;
      const statements = byKey.get(timeframe === "60" ? candleKey : bar.close_time) || [];
      if (!statements.length) continue;
      const closeMs = Date.parse(bar.close_time);
      let written = 0;
      for (const st of statements) {
        const score = scoreStance({ stance: st.stance, confidence: st.confidence, bars, closeMs });
        if (["pending", "no_data", "not_scored"].includes(score.result)) continue;
        await insertScore(env.DB, { ...score, subject: st.subject, source: st.source, timeframe, candle_key: candleKey, statement_close: bar.close_time, confidence: finite(st.confidence) ? st.confidence : null, scored_at: scoredAt });
        written += 1;
      }
      await env.DB.prepare("INSERT INTO outcome_runs (timeframe, candle_key, statements, scored_at, scoring_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(timeframe, candle_key) DO UPDATE SET statements = excluded.statements, scored_at = excluded.scored_at, scoring_version = excluded.scoring_version").bind(agentRun, candleKey, written, scoredAt, SCORING_VERSION).run();
      summary.agent_scores = (summary.agent_scores || 0) + written;
    }
  }
  return summary;
}

/** Reputation of the agents of one timeframe's room (src/reputation.mjs), from the 30-day scorecards. */
export async function agentReputation(db, timeframe, { days = REPUTATION_DAYS, now = Date.now() } = {}) {
  try { return reputationFromScorecards(await scorecards(db, { days, now }), timeframe); } catch { return {}; }
}

const STUCK_FIELDS = Object.freeze({
  "prophet_r37.structure_subtype": (p) => p?.values?.comparable?.prophet_r37_ssot?.structure_subtype,
  "prophet_r37.b_enc": (p) => p?.values?.comparable?.prophet_r37_ssot?.b_enc,
  "prophet_r37.d_enc": (p) => p?.values?.comparable?.prophet_r37_ssot?.d_enc,
  "prophet_r38.d_enc": (p) => p?.values?.comparable?.prophet_r38?.d_enc,
  "prophet_r38.t_enc": (p) => p?.values?.comparable?.prophet_r38?.t_enc,
  "gmi_v12_70.verdict": (_, g) => g?.values?.comparable?.gmi_v12_70?.verdict,
  "gmi_v12_70.gate": (_, g) => g?.values?.comparable?.gmi_v12_70?.gate,
  "gmi_v12_70.conflict": (_, g) => g?.values?.comparable?.gmi_v12_70?.conflict
});

/**
 * Stuck-state detection on the parity-approved H1 records of the last 24 closed candles.
 * Opens or extends one stuck_states row per (field, first candle); closes open rows whose
 * field is no longer stuck.
 */
export async function detectRecentStuckStates(env, { now = Date.now(), lookback = 24 } = {}) {
  if (!env?.DB || !env?.SIGNAL_CACHE || !env?.WEBHOOK_BUFFER) return { status: "unavailable" };
  await ensureOutcomeSchema(env.DB);
  const bars = await loadBars(env, "60");
  if (bars.length < SCORING.atrPeriod + 2) return { status: "no_bars" };
  const window = bars.slice(-lookback);
  const series = [];
  for (const bar of window) {
    const candleKey = `${SYMBOL}:60:${Date.parse(bar.open_time)}`;
    const [p, g] = await Promise.all(["prophet", "gmi"].map(async (e) => parse(await env.WEBHOOK_BUFFER.get("localcalc:" + candleKey + ":" + e))));
    if (!p && !g) { series.length = 0; continue; } // a gap breaks the run: never span missing candles
    series.push({ candle_key: candleKey, high: bar.high, low: bar.low, fields: Object.fromEntries(Object.entries(STUCK_FIELDS).map(([f, read]) => [f, read(p, g) ?? null])) });
  }
  const atr = atrAt(bars, bars.length - 1);
  const found = detectStuckStates(series, atr);
  const at = new Date(now).toISOString();
  for (const s of found) {
    await env.DB.prepare(
      "INSERT INTO stuck_states (field, value, first_candle_key, last_candle_key, candles, price_range, atr, status, detected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) " +
      "ON CONFLICT(field, first_candle_key) DO UPDATE SET last_candle_key = excluded.last_candle_key, candles = excluded.candles, price_range = excluded.price_range, atr = excluded.atr, status = 'open', updated_at = excluded.updated_at"
    ).bind(s.field, s.value, s.first_candle_key, s.last_candle_key, s.candles, s.price_range, s.atr, at, at).run();
  }
  const open = ((await env.DB.prepare("SELECT field, first_candle_key FROM stuck_states WHERE status = 'open'").all()).results || []);
  const still = new Set(found.map((s) => s.field + "|" + s.first_candle_key));
  for (const row of open) {
    if (!still.has(row.field + "|" + row.first_candle_key)) {
      await env.DB.prepare("UPDATE stuck_states SET status = 'cleared', updated_at = ? WHERE field = ? AND first_candle_key = ?").bind(at, row.field, row.first_candle_key).run();
    }
  }
  return { status: "ok", stuck: found.length };
}

/** Rolling scorecards per subject over the last `days`. */
export async function scorecards(db, { days = 30, now = Date.now() } = {}) {
  await ensureOutcomeSchema(db);
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = (await db.prepare("SELECT subject, source, timeframe, stance, result, brier, session FROM outcome_scores WHERE statement_close >= ? AND scoring_version = ?").bind(since, SCORING_VERSION).all()).results || [];
  const cards = new Map();
  for (const r of rows) {
    const id = r.subject + "|" + r.timeframe;
    const c = cards.get(id) || { subject: r.subject, source: r.source, timeframe: r.timeframe, n: 0, directional: { n: 0, hit: 0, miss: 0, neutral: 0 }, wait: { n: 0, hit: 0, missed_opportunity: 0 }, brier_sum: 0, brier_n: 0, by_session: {} };
    c.n += 1;
    if (r.stance === "WAIT") { c.wait.n += 1; c.wait[r.result] = (c.wait[r.result] || 0) + 1; }
    else { c.directional.n += 1; c.directional[r.result] = (c.directional[r.result] || 0) + 1; }
    if (finite(r.brier)) { c.brier_sum += r.brier; c.brier_n += 1; }
    const s = (c.by_session[r.session] ||= { n: 0, hit: 0 });
    s.n += 1; if (r.result === "hit") s.hit += 1;
    cards.set(id, c);
  }
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  return [...cards.values()].map(({ brier_sum, brier_n, ...c }) => ({
    ...c,
    directional: { ...c.directional, hit_rate: rate(c.directional.hit, c.directional.hit + c.directional.miss) },
    wait: { ...c.wait, accuracy: rate(c.wait.hit, c.wait.n) },
    brier: brier_n ? Math.round((brier_sum / brier_n) * 1000) / 1000 : null
  })).sort((a, b) => a.subject.localeCompare(b.subject) || a.timeframe.localeCompare(b.timeframe));
}

export async function listStuckStates(db, { limit = 50 } = {}) {
  await ensureOutcomeSchema(db);
  return ((await db.prepare("SELECT field, value, first_candle_key, last_candle_key, candles, price_range, atr, status, detected_at, updated_at FROM stuck_states ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?").bind(limit).all()).results || []);
}
