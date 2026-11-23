// B9: one seeded AI Worker environment for GET /api/chart-patterns (src/chart-patterns-view.mjs): the feed's four charts
// in KV (synthetic shapes the detector reads as patterns), the pattern calibration, the latest decision with a pattern
// agent's plan, and an in-memory D1 (node:sqlite, test/support/liquidity-view-seed.mjs d1()) with engine_decisions and
// the Projection Agent's outcome_scores. test/fixtures/nexus-intel/chart-patterns.json (the Nexus Chart patterns page's
// contract) is this seed's answer with ?history=24 and STRATEGY as the memo. No network.
import { path } from "./pattern-fixtures.mjs";
import { d1, kv, NOW } from "./liquidity-view-seed.mjs";
import { buildKeyLevels } from "../../src/key-level-agent.mjs";
import { atr } from "../../src/strategy-engine.mjs";
import { DECISION_LATEST_KEY } from "../../src/decision-engine.mjs";
import { PATTERN_CALIBRATION_KEY, PATTERN_CALIBRATION_VERSION, CALIBRATION } from "../../src/pattern-calibration.mjs";
import { SCORING_VERSION } from "../../src/outcome-scoring.mjs";

export { NOW, d1, kv };
const M15 = 15 * 60_000, HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

/** Shapes (bar, price) of 60 bars each; every chart ends at NOW, its last close near 4100. */
const SHAPES = {
  "15": { pts: [[0, 80], [20, 80], [30, 100], [34, 90], [38, 100], [42, 90], [46, 100], [50, 90], [54, 100], [56, 95], [59, 104]], k: 0.4, ms: M15, interval: "15m" },
  "60": { pts: [[0, 70], [30, 70], [40, 110], [44, 90], [48, 107], [52, 93], [56, 104], [59, 99]], k: 0.6, ms: HOUR, interval: "1h" },
  "240": { pts: [[0, 130], [24, 130], [34, 100], [38, 110], [42, 96], [46, 104], [50, 93], [54, 99], [57, 91], [59, 94]], k: 1, ms: 4 * HOUR, interval: "4h" },
  D: { pts: [[0, 80], [20, 82], [30, 100], [36, 90], [42, 100], [50, 86], [59, 87]], k: 2, ms: 24 * HOUR, interval: "1D" }
};
export function chartBars(tf) {
  const s = SHAPES[tf], last = s.pts.at(-1)[1];
  const base = 4100 - s.k * last;
  return path(s.pts.map(([i, p]) => [i, base + s.k * p]), { barMs: s.ms, start: NOW - 60 * s.ms, wick: 0.3 * s.k })
    .map((b) => ({ open_time: iso(Date.parse(b.close_time) - s.ms), close_time: b.close_time, open: Math.round(b.open * 100) / 100, high: Math.round(b.high * 100) / 100, low: Math.round(b.low * 100) / 100, close: Math.round(b.close * 100) / 100, volume: 100 }));
}
const BARS = Object.fromEntries(Object.keys(SHAPES).map((tf) => [tf, chartBars(tf)]));

/** The strategy memo the view is given: the Key Level Agent's real reading of these bars (patterns and zones). */
const price = BARS["15"].at(-1).close, atrH1 = atr(BARS["60"]);
export const STRATEGY = Object.freeze({
  price: Math.round(price * 100) / 100, atr_h1: Math.round(atrH1 * 100) / 100,
  key_levels: buildKeyLevels({ bars: { M15: BARS["15"], H1: BARS["60"], H4: BARS["240"], D1: BARS.D }, price, atrH1 })
});
const PATTERNS = STRATEGY.key_levels.patterns;
/** The pattern the trade's agent planned (a 15m breakout up), and the one pattern_inside planned (a forming 1H pattern). */
export const TRADED = PATTERNS.find((p) => p.tf === "15" && p.status === "confirmed" && p.direction > 0 && !p.id.startsWith("measured_move")) ?? null;
export const INSIDE = PATTERNS.find((p) => p.tf === "60" && p.status === "forming" && !p.id.startsWith("measured_move")) ?? null;

/** The stored calibration (v2: pooled, by_tf and open), as runPatternCalibration writes it. */
function calibration() {
  const rec = (n, target, rate, factor, active) => ({ n, target, failed: n - target - 2, expired: 2, rate, factor, active });
  const pooled = { rectangle_top: rec(31, 17, 0.548, 1.21, true), triangle_ascending: rec(24, 11, 0.458, 1.04, true), triple_top: rec(9, 3, 0.333, 1, false), measured_move_up: rec(40, 15, 0.375, 0.9, true) };
  const chart = (n, target) => ({ n, target, failed: n - target - 1, expired: 1, rate: Math.round((target / n) * 1000) / 1000, shrunk_rate: 0.47, active: n >= 20, bars_to_target: target ? { n: target, median: 6, p90: 14 } : null });
  return {
    version: PATTERN_CALIBRATION_VERSION, computed_at: iso(NOW - 20 * 60_000), rules: { ...CALIBRATION },
    charts: { "15": { bars: 2000, from: iso(NOW - 21 * 86_400_000), to: iso(NOW), breakouts: 90 } },
    base_rate: 0.44, resolved: 140, pending: 3, patterns: pooled,
    by_tf: { "15": { resolved: 90, rate: 0.46, bars_to_target: { n: 41, median: 6, p90: 15 }, patterns: { rectangle_top: chart(21, 12), triangle_ascending: chart(14, 6), measured_move_up: chart(25, 9) } } },
    open: {
      "15": [{ id: "rectangle_top", name: "rectangle top", direction: 1, status: "confirmed", upper: 4098.4, lower: 4094.4, target: 4102.4, height: 4, breakout_close: iso(NOW - 5 * M15), bars_at_calibration: 4, h: 30 }],
      "60": [], "240": [], D: []
    }
  };
}

/** The decision Omega trades with: a pattern agent's plan (TP1 at a key zone, the measured target TP2) and pattern_inside's. */
function decisionRecord() {
  const t = TRADED, f = INSIDE;
  const plans = { long: {}, short: {} };
  plans.long.zone_pullback = { status: "live", entry: 4096.5, stop: 4093.9, tp1: 4101.2, tp2: 4104.8, at_level: false, rrr: { tp1: 1.81, tp2: 3.19 }, setup: "a pullback to the nearest candidate support" };
  if (t) plans.long.pattern_lines = { status: "live", entry: t.upper, stop: Math.round((t.lower - 0.5) * 100) / 100, tp1: Math.round((t.upper + 2.1) * 100) / 100, tp2: t.target, at_level: true, rrr: { tp1: 1.05, tp2: 1.4 }, setup: `the Projection Agent's 15m ${t.name}, broken upward (on gold it reached its target 55% of 31 times)`, pattern: t.id };
  if (f) plans.short.pattern_inside = { status: "shadow", entry: f.upper, stop: Math.round((f.upper + 1.2) * 100) / 100, tp1: Math.round(((f.upper + f.lower) / 2) * 100) / 100, tp2: Math.round((f.lower + 0.3) * 100) / 100, at_level: false, rrr: { tp1: 1.2, tp2: 2.1 }, setup: `the Projection Agent's forming 1H ${f.name}, not broken yet: a swing from its upper line toward its lower line`, pattern: f.id };
  return {
    decision_key: `OANDA:XAUUSD:15:${NOW}`, bar_close: iso(NOW), stance: "BUY", trading_mode: "intraday",
    trade: { side: "BUY", agent: "pattern_lines", strategy: "pattern_lines", pattern: t?.id ?? null, entry: plans.long.pattern_lines?.entry ?? 4100, tp1: plans.long.pattern_lines?.tp1 ?? 4102, tp2: plans.long.pattern_lines?.tp2 ?? 4104 },
    selection: { mode: "auto", agent: "pattern_lines", score: 0.61, candidates: [{ id: "pattern_lines", score: 0.61, eligible: true }, { id: "zone_pullback", score: 0.48, eligible: true }] },
    strategy_plans: plans,
    chart_patterns: PATTERNS.slice(0, 16).map((p) => ({ tf: p.tf, id: p.id, status: p.status, direction: p.direction, upper: p.upper, lower: p.lower, target: p.target }))
  };
}

/**
 * The seeded environment. `decisionInKv: false` leaves decision-engine:latest out (the view reads engine_decisions);
 * `calibration: false` leaves the calibration out.
 */
export async function seedChartPatternsEnv({ decisionInKv = true, calibration: withCalibration = true, env: extra = {} } = {}) {
  const env = { DB: d1(), SIGNAL_CACHE: kv(), ...extra };
  const raw = env.DB.raw;
  const kvPut = (k, v) => env.SIGNAL_CACHE.m.set(k, typeof v === "string" ? v : JSON.stringify(v));
  for (const [tf, s] of Object.entries(SHAPES)) kvPut(`market-data:v2:series:OANDA:XAUUSD|${s.interval}`, { candles: BARS[tf] });
  if (withCalibration) kvPut(PATTERN_CALIBRATION_KEY, calibration());
  const latest = decisionRecord();
  if (decisionInKv) kvPut(DECISION_LATEST_KEY, latest);

  // engine_decisions: three closed 15m decisions with their pattern snapshots (the newest is the latest decision).
  raw.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, stance TEXT NOT NULL, confidence REAL, source TEXT NOT NULL, decision_json TEXT NOT NULL)");
  const ins = raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, 0.6, 'council', ?)");
  const older = (k, stance, cp) => { const close = NOW - k * M15; ins.run(`OANDA:XAUUSD:15:${close}`, iso(close), iso(close + 40_000), stance, JSON.stringify({ decision_key: `OANDA:XAUUSD:15:${close}`, bar_close: iso(close), stance, trade: stance === "WAIT" ? null : { agent: "zone_pullback" }, chart_patterns: cp })); };
  older(2, "WAIT", [{ tf: "60", id: "rectangle_top", status: "forming", direction: 0, upper: 4103.1, lower: 4096.2, target: null }]);
  older(1, "BUY", [{ tf: "15", id: "rectangle_top", status: "confirmed", direction: 1, upper: 4098.4, lower: 4094.4, target: 4102.4 }, { tf: "240", id: "wedge_falling", status: "forming", direction: 0, upper: 4101, lower: 4094, target: null }]);
  ins.run(latest.decision_key, latest.bar_close, iso(NOW + 40_000), "BUY", JSON.stringify(latest));

  // outcome_scores: the Projection Agent's stances in the 15m, 1H and 4H rooms (none scored in D1 yet), another agent,
  // an older scoring version and one outside the 30-day window (neither counts).
  raw.exec("CREATE TABLE outcome_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, source TEXT NOT NULL, timeframe TEXT NOT NULL, candle_key TEXT NOT NULL, statement_close TEXT NOT NULL, stance TEXT NOT NULL, confidence REAL, result TEXT NOT NULL, direction INTEGER, entry REAL, atr REAL, threshold REAL, max_up REAL, max_down REAL, brier REAL, session TEXT, scoring_version TEXT NOT NULL, scored_at TEXT NOT NULL, UNIQUE(subject, timeframe, candle_key))");
  const os = raw.prepare("INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, result, brier, scoring_version, scored_at) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?, ?)");
  let k = 0;
  const score = (subject, tf, stance, result, { ageH = 5, version = SCORING_VERSION, brier = 0.2 } = {}) => { k += 1; const at = iso(NOW - ageH * HOUR - k * 60_000); os.run(subject, tf, `${tf}:${k}`, at, stance, result, brier, version, iso(NOW)); };
  for (const r of ["hit", "hit", "hit", "miss", "neutral"]) score("agent:projection", "15", "BUY", r);
  for (const r of ["hit", "missed_opportunity"]) score("agent:projection", "15", "WAIT", r, { brier: null });
  for (const r of ["hit", "miss", "miss"]) score("agent:projection", "60", "SELL", r);
  score("agent:projection", "240", "WAIT", "hit", { brier: null });
  score("agent:technical", "15", "BUY", "miss");
  score("agent:projection", "15", "BUY", "miss", { version: "cryptophys.outcome-scoring.v2" });
  score("agent:projection", "15", "BUY", "miss", { ageH: 40 * 24 });
  env.DB.seen.length = 0;
  env.SIGNAL_CACHE.puts.length = 0;
  return env;
}
