// GET /api/chart-patterns (Track B, B9): the Nexus Chart patterns page's read of the Projection Agent's chart patterns
// (src/chart-patterns.mjs detectPatterns, as the Key Level Agent runs it), cryptophys.chart-patterns-view.v1. Nexus only
// (behind Cloudflare Access): one of the few read routes that carry prices, and every price here is the TradingView
// feed's (OANDA:XAUUSD closed bars, `scale.prices` "feed"): the bars, the pattern lines and targets, the key zones and
// the pattern agents' plans. There is no broker price in this view.
//
//   reads    the strategy memo (readStrategyMemo: key_levels.patterns and zones, price, atr_h1), KV the feed's
//            15m/1h/4h/1D series, chart-patterns:calibration:v1 (readPatternCalibration), decision-engine:latest;
//            D1 SELECTs of engine_decisions (the decision when KV has none, and ?history), outcome_scores (the
//            Projection Agent's seat). A table that does not exist yet reads as empty ("no such table" gives []).
//   never    a write, a DDL statement, readLatestDecision/readDecisions/readAllocationEvents (they run DDL),
//            scorecards() (it runs DDL and writes a snapshot); an account, login, server or identity key.
//   TP1-KZ2  a pattern's measured target is only ever the far target (`far_target`, `target_up`/`target_down`,
//            `far_targets`): no key of this view is called `target`, and a plan's tp1/tp2 are the plan's own (post
//            TP1-KZ2: TP1 at the key zone, the measured target TP2 or named in tp2_note).
//   later    held, breakout_bars_ago, bars_since_breakout, horizon_bars, bars_left (A10/A12), seat.horizon_bars and a
//            seat judged on "horizon" (A12), patterns[].plan.reach (a later PR) are null until those merge.
import { detectPatterns, patternInfo } from "./chart-patterns.mjs";
import { chartPatternsMode } from "./projection-agent.mjs";
import { readPatternCalibration, patternCalibrationMode } from "./pattern-calibration.mjs";
import { atr } from "./strategy-engine.mjs";
import { DECISION_LATEST_KEY } from "./decision-engine.mjs";
import { SCORING, SCORING_VERSION } from "./outcome-scoring.mjs";
import { reputationOf, ROOM_TIMEFRAME, REPUTATION_DAYS } from "./reputation.mjs";

export const CHART_PATTERNS_VIEW_SCHEMA = "cryptophys.chart-patterns-view.v1";
/** The bars of each chart: the detector's own window (the strategy's last 60 closed bars), so start_bar/end_bar index them. */
export const VIEW_CHART_BARS = 60;
/** ?history: the default and the most decisions' pattern snapshots. */
export const HISTORY_DEFAULT = 0;
export const HISTORY_MAX = 24;
/** The Projection Agent's seat in the rooms, scored as "agent:projection" (src/outcome-scoring.mjs). */
export const PROJECTION_SUBJECT = "agent:projection";
/** The charts: the Key Level Agent's timeframe keys, their label, series and bar length. */
export const VIEW_CHARTS = Object.freeze([
  Object.freeze({ tf: "15", label: "15m", interval: "15m", interval_s: 900 }),
  Object.freeze({ tf: "60", label: "1H", interval: "1h", interval_s: 3_600 }),
  Object.freeze({ tf: "240", label: "4H", interval: "4h", interval_s: 14_400 }),
  Object.freeze({ tf: "D", label: "daily", interval: "1D", interval_s: 86_400 })
]);
const SYMBOL = "OANDA:XAUUSD";
const LABEL = Object.fromEntries(VIEW_CHARTS.map((c) => [c.tf, c.label]));

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (finite(v) ? v : null);
const str = (v) => (typeof v === "string" && v ? v : null);
const parse = (s, d = null) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? d); } catch { return d; } };
const noTable = (e) => /no such table/i.test(String(e?.message ?? e));
const isoMs = (s) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : null; };

/** A SELECT's rows; a table not created yet is none. Any other error throws (the route answers chart_patterns_unavailable). */
async function select(db, sql, ...params) {
  if (!db?.prepare) return [];
  try { return (await db.prepare(sql).bind(...params).all())?.results ?? []; } catch (e) { if (noTable(e)) return []; throw e; }
}
async function kvJson(kv, key) {
  try { return parse(await kv?.get?.(key), null); } catch { return null; }
}

/** ?history=N: an integer 0..HISTORY_MAX (anything else is the default). */
export function historyParam(value) {
  if (value === null || value === undefined || value === "") return HISTORY_DEFAULT;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(HISTORY_MAX, n) : HISTORY_DEFAULT;
}

/** Pure: one feed bar as /api/ohlcv's candle ({ time: open time in unix seconds, open, high, low, close, volume }). */
export function ohlcvRow(c, intervalS) {
  const close = isoMs(c?.close_time), open = isoMs(c?.open_time);
  const t = open ?? (close !== null ? close - intervalS * 1000 : null);
  return { time: t === null ? null : Math.floor(t / 1000), open: num(c?.open), high: num(c?.high), low: num(c?.low), close: num(c?.close), volume: num(c?.volume) };
}

/** Pure: the Key Level Agent's zone that holds this pattern's levels (the strongest), or null. */
export function patternZone(p, zones) {
  const chart = LABEL[String(p?.tf)] ?? p?.chart;
  if (!chart || !p?.name || !Array.isArray(zones)) return null;
  const mine = (m) => typeof m?.label === "string" && (m.label.startsWith(`${chart} ${p.name}:`) || m.label.startsWith(`${chart} busted ${p.name}:`));
  const z = zones.filter((x) => Array.isArray(x?.members) && x.members.some(mine)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (!z) return null;
  return {
    low: r2(z.low), high: r2(z.high), price: r2(z.price), score: r2(z.score), strength: str(z.strength), role: str(z.role),
    candidate: z.candidate === true, qualified: z.qualified === true, levels: z.members.filter(mine).map((m) => m.label)
  };
}

/** Pure: the measured target a pattern projects in a direction (+1 up, -1 down), the far target only. */
const measuredIn = (p, dir) => (dir > 0 ? num(p.target_up) : dir < 0 ? num(p.target_down) : null);

/**
 * Pure: the pattern agent's plan for this pattern at the decision (strategy_plans, slimPlan: the plan's own tp1 and
 * tp2, post TP1-KZ2), matched by pattern id and chart (the plan's setup names "the Projection Agent's <chart> ..."),
 * with the pattern's measured target as the far target; null when no agent planned it.
 */
export function patternPlan(p, plans) {
  const chart = LABEL[String(p?.tf)] ?? p?.chart;
  for (const [side, dir] of [["long", 1], ["short", -1]]) {
    for (const [agent, a] of Object.entries(plans?.[side] ?? {})) {
      if (!a || a.pattern !== p.id) continue;
      const m = /the Projection Agent's (?:forming )?(15m|1H|4H|daily) /.exec(String(a.setup ?? ""));
      if (!m || m[1] !== chart) continue;
      if (p.direction && p.direction !== dir) continue;
      return {
        agent, side: dir > 0 ? "BUY" : "SELL", status: str(a.status), at_level: a.at_level === true,
        entry: r2(a.entry), stop: r2(a.stop), tp1: r2(a.tp1), tp2: r2(a.tp2),
        rrr: { tp1: num(a.rrr?.tp1), tp2: num(a.rrr?.tp2) }, far_target: r2(measuredIn(p, dir)), reach: null
      };
    }
  }
  return null;
}

/**
 * Pure: one detected pattern as the view shows it: detectPatterns' fields (the measured target in the breakout's
 * direction as `far_target`), its chart, its record on gold (on its chart and pooled), its key zone and its plan.
 * The A10/A12 fields are null until they merge.
 */
export function viewPattern(p, { calibration = null, zones = null, plans = null } = {}) {
  const tf = String(p.tf);
  const chartRec = calibration?.by_tf?.[tf]?.patterns?.[p.id] ?? null, pooled = calibration?.patterns?.[p.id] ?? null;
  return {
    tf, chart: LABEL[tf] ?? str(p.chart), id: p.id, name: p.name ?? patternInfo(p.id)?.name ?? null, chapter: num(p.chapter),
    group: patternInfo(p.id)?.group ?? null, status: p.status, direction: finite(p.direction) ? p.direction : 0,
    upper: num(p.upper), lower: num(p.lower), height: num(p.height),
    far_target: num(p.target), target_up: num(p.target_up), target_down: num(p.target_down),
    start_bar: num(p.start_bar), end_bar: num(p.end_bar), bars_ago: num(p.bars_ago),
    line_from: str(p.line_from), line_to: str(p.line_to), upper_from: num(p.upper_from), lower_from: num(p.lower_from),
    event: str(p.event),
    held: null, breakout_bars_ago: null, bars_since_breakout: null, horizon_bars: null, bars_left: null,
    record: { chart: chartRec, pooled },
    zone: patternZone(p, zones),
    plan: patternPlan(p, plans)
  };
}

/** Pure: the far targets (the patterns' measured targets, never a TP1), the nearest first. */
export function farTargets(patterns, { price = null, atrH1 = null } = {}) {
  const out = [];
  for (const p of patterns) {
    const dirs = p.direction ? [p.direction] : [1, -1];
    for (const d of dirs) {
      const at = measuredIn(p, d);
      if (!finite(at)) continue;
      out.push({ tf: p.tf, chart: p.chart, id: p.id, name: p.name, status: p.status, direction: d, price: at, distance_atr: finite(price) && finite(atrH1) && atrH1 > 0 ? r2(Math.abs(at - price) / atrH1) : null });
    }
  }
  const order = (tf) => VIEW_CHARTS.findIndex((c) => c.tf === tf);
  return out.sort((a, b) => (a.distance_atr ?? Infinity) - (b.distance_atr ?? Infinity) || order(a.tf) - order(b.tf));
}

/** Pure: the stored calibration as the view shows it (every key present; an open breakout's `target` is its far target). */
export function viewCalibration(cal) {
  const c = cal && typeof cal === "object" ? cal : null;
  const open = c?.open && typeof c.open === "object"
    ? Object.fromEntries(Object.entries(c.open).map(([tf, rows]) => [tf, (Array.isArray(rows) ? rows : []).map(({ target, ...r }) => ({ ...r, far_target: num(target) }))]))
    : null;
  return {
    version: str(c?.version), computed_at: str(c?.computed_at), base_rate: num(c?.base_rate), resolved: num(c?.resolved), pending: num(c?.pending),
    patterns: c?.patterns && typeof c.patterns === "object" ? c.patterns : null, by_tf: c?.by_tf && typeof c.by_tf === "object" ? c.by_tf : null, open
  };
}

/** Pure: the seat's card of one room from grouped outcome_scores rows ({ stance, result, n, brier_sum, brier_n }). */
export function seatRoom(timeframe, rows) {
  const card = { n: 0, directional: { n: 0, hit: 0, miss: 0, neutral: 0 }, wait: { n: 0, hit: 0, missed_opportunity: 0 } };
  let bs = 0, bn = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    card.n += n;
    const box = r.stance === "WAIT" ? card.wait : card.directional;
    box.n += n;
    if (r.result in box) box[r.result] += n;
    if (finite(Number(r.brier_sum)) && Number(r.brier_n) > 0) { bs += Number(r.brier_sum); bn += Number(r.brier_n); }
  }
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  card.directional.hit_rate = rate(card.directional.hit, card.directional.hit + card.directional.miss);
  card.wait.accuracy = rate(card.wait.hit, card.wait.n);
  card.brier = bn ? Math.round((bs / bn) * 1000) / 1000 : null;
  const rep = reputationOf(card);
  return { timeframe, n: card.n, directional: card.directional, wait: card.wait, brier: card.brier, reputation: { decisive: rep.decisive, accuracy: rep.accuracy, shrunk: rep.shrunk, weight: rep.weight } };
}

/**
 * The view (cryptophys.chart-patterns-view.v1). `strategy` is the shared memo (readStrategyMemo), or null: the
 * patterns are then detected here on the same bars (no event patterns: those need the release history). `history`
 * is ?history (0..24 decisions' stored pattern snapshots). Throws on a D1 error.
 */
export async function readChartPatternsView(env, { now = Date.now(), strategy = null, history = HISTORY_DEFAULT } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  const mode = chartPatternsMode(env), calibrationMode = patternCalibrationMode(env);

  // The feed's closed bars of each chart, the detector's window.
  const charts = {}, bars = {};
  for (const c of VIEW_CHARTS) {
    const rec = await kvJson(kv, `market-data:v2:series:${SYMBOL}|${c.interval}`);
    const list = (Array.isArray(rec?.candles) ? rec.candles : [])
      .filter((x) => finite(x?.close) && x.close > 0 && isoMs(x.close_time) !== null && isoMs(x.close_time) <= now)
      .sort((a, b) => isoMs(a.close_time) - isoMs(b.close_time)).slice(-VIEW_CHART_BARS);
    bars[c.tf] = list;
    charts[c.tf] = { label: c.label, interval_s: c.interval_s, ohlcv: list.map((x) => ohlcvRow(x, c.interval_s)) };
  }
  const price = finite(strategy?.price) ? r2(strategy.price) : r2(bars["15"].at(-1)?.close ?? null);
  const atrH1 = finite(strategy?.atr_h1) ? r2(strategy.atr_h1) : r2(atr(bars["60"]));

  // The decision: KV decision-engine:latest, else the newest engine_decisions row (never readLatestDecision: DDL).
  let record = await kvJson(kv, DECISION_LATEST_KEY);
  if (!record?.decision_key) {
    try { record = parse((await db?.prepare?.("SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT 1")?.all?.())?.results?.[0]?.decision_json, null); }
    catch { record = null; }
  }
  const decision = {
    decision_key: str(record?.decision_key), bar_close: str(record?.bar_close),
    trade_agent: str(record?.trade?.agent), council_strategy: str(record?.selection?.agent)
  };

  // The patterns: the Key Level Agent's (the strategy memo's key_levels.patterns), else detected here; none when off.
  const calibration = await readPatternCalibration(env);
  let found = [];
  if (mode !== "off") {
    if (Array.isArray(strategy?.key_levels?.patterns)) found = strategy.key_levels.patterns;
    else for (const c of VIEW_CHARTS) { let list = []; try { list = detectPatterns(bars[c.tf]); } catch { list = []; } found.push(...list.map((p) => ({ tf: c.tf, chart: c.label, ...p }))); }
  }
  const zones = Array.isArray(strategy?.key_levels?.zones) ? strategy.key_levels.zones : null;
  const patterns = found.filter((p) => p && typeof p.id === "string" && LABEL[String(p.tf)]).map((p) => viewPattern(p, { calibration, zones, plans: record?.strategy_plans ?? null }));

  // The Projection Agent's seat: its scored stances per room over the reputation window (outcome_scores, SELECT only).
  const since = new Date(now - REPUTATION_DAYS * 86_400_000).toISOString();
  const scored = await select(db, "SELECT timeframe, stance, result, COUNT(*) AS n, SUM(brier) AS brier_sum, COUNT(brier) AS brier_n FROM outcome_scores WHERE subject = ? AND statement_close >= ? AND scoring_version = ? GROUP BY timeframe, stance, result", PROJECTION_SUBJECT, since, SCORING_VERSION);
  const seat = {
    rooms: Object.fromEntries(Object.entries(ROOM_TIMEFRAME).map(([room, tf]) => [room, seatRoom(tf, scored.filter((r) => String(r.timeframe) === tf))])),
    judged_on: "bar", horizon_bars: null,
    scoring: { version: SCORING_VERSION, candles: SCORING.horizon, threshold_atr: SCORING.thresholdAtr, window_days: REPUTATION_DAYS }
  };

  // ?history: the newest decisions' pattern snapshots as the decision record kept them (chart_patterns).
  const n = historyParam(history);
  const historyRows = n ? (await select(db, "SELECT decision_key, bar_close, stance, json_extract(decision_json, '$.trade.agent') AS trade_agent, json_extract(decision_json, '$.chart_patterns') AS chart_patterns FROM engine_decisions ORDER BY bar_close DESC LIMIT ?", n)).map((r) => ({
    decision_key: str(r.decision_key), bar_close: str(r.bar_close), stance: str(r.stance), trade_agent: str(r.trade_agent),
    patterns: (parse(r.chart_patterns, []) ?? []).filter((p) => p && typeof p.id === "string").map((p) => ({
      tf: String(p.tf), chart: LABEL[String(p.tf)] ?? null, id: p.id, name: patternInfo(p.id)?.name ?? null, status: str(p.status),
      direction: finite(p.direction) ? p.direction : 0, upper: num(p.upper), lower: num(p.lower), far_target: num(p.target)
    }))
  })) : [];

  return {
    schema: CHART_PATTERNS_VIEW_SCHEMA,
    mode, calibration_mode: calibrationMode,
    scale: { prices: "feed", symbol: SYMBOL },
    price, atr_h1: atrH1,
    decision, charts, patterns,
    far_targets: farTargets(patterns, { price, atrH1 }),
    calibration: viewCalibration(calibration),
    seat, history: historyRows
  };
}
