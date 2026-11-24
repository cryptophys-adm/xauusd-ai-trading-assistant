// MS2 fixtures (test/mode-shadow.test.mjs): a 15m decision whose live mode is intraday, in a ranging 1H regime, with a
// range of 32 15m bars under price (range_fade sees its bottom) and strongly bearish news (swing vetoes a long on it);
// a sqlite D1, a KV; and the "off" scenario, written against modules passed in, so the same code runs on this tree and
// on the tree before MS2 (the pinned hashes in the test were taken with it on a git-archive of main fdc6c38, after SS1,
// B15, B16 and V3L; before main was merged in they were taken on 0a7491f).
import { DatabaseSync } from "node:sqlite";

export const CLOSE = "2026-11-09T13:15:00.000Z";
export const NOW = Date.parse(CLOSE) + 70_000;
const M1 = 60_000, M15 = 15 * M1, HOUR = 60 * M1, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

export function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), batch: async (sts) => { for (const s of sts) await s.run(); }, raw: db };
}
export function kv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
export const failingAi = { run: async () => { throw new Error("model down"); } };

const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
const global = () => ({ timeframes: [row("D1", 0.5), row("H4", 0.4), row("H1", 0.3), row("M15", 0.35, "BUY"), row("NEWS", 0.2), row("MACRO", 0.1)] });
export const ZONES = Object.freeze([
  { low: 3995, high: 3998, price: 3996.5, candidate: true, label: "S1" },
  { low: 3980, high: 3980, price: 3980, candidate: true, label: "S2" },
  { low: 4030, high: 4032, price: 4031, candidate: true, label: "R1" },
  { low: 4050, high: 4050, price: 4050, candidate: true, label: "R2" }
]);
/** 32 closed 15m bars between 3998 and 4025 (a 2.7 ATR range), the last one closing at 4000, at its bottom. */
export function rangeBars(closeMs = Date.parse(CLOSE), n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const open = closeMs - (n - i) * M15, top = i % 4 === 1 ? 4025 : 4018, bottom = i % 4 === 3 ? 3998 : 4003;
    return { open_time: iso(open), close_time: iso(open + M15), open: (top + bottom) / 2, high: top, low: bottom, close: i === n - 1 ? 4000 : (top + bottom) / 2, volume: 100 };
  });
}
export const strategy = (decision = "BUY") => ({ decision, state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones: ZONES.map((z) => ({ ...z })) }, plan: { at_level: true } });
export const loaded = ({ regime = "normal-ranging", news = -0.9, decision = "BUY", bars = true } = {}) => ({ inputs: { calendar: { events: [] }, news: { lean: news }, m15Bars: bars ? rangeBars() : [] }, strategy: strategy(decision), global: global(), correlations: null, regime });
/** The agents live in the fixture: the default (always) and range_fade (a range strategy). */
export const ENV_BASE = Object.freeze({ MODEL_RATE_LIMIT_RETRY_MS: "0", STRATEGY_AGENTS_LIVE: "range_fade" });

/** 1m bars from `from`, rising one point a minute from 4000 (the long plans reach their targets). */
export const risingBars = (from, n = 180) => Array.from({ length: n }, (_, i) => ({ open_time: iso(from + i * M1), close_time: iso(from + (i + 1) * M1), open: 4000 + i * 0.25, high: 4000.5 + i * 0.25, low: 3999.5 + i * 0.25, close: 4000.25 + i * 0.25 }));

export const PLAN_COLUMNS = "setup_key, decision_key, agent, pattern, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, resolved_at, results_json, version, updated_at, htf";

/** A resolved live setup row in the columns every version of the table has (the selector's evidence). */
export function insertSetup(db, { key, mode, r, openedMs, regime = "trend", agent = "zone_pullback", side = "BUY", stop = 5 }) {
  db.raw.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, resolved_at, results_json, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 4000, ?, 4015, 10, ?, 'ENTER_LIMIT', 1, ?, ?, 'resolved', ?, ?, 'cryptophys.plan-learning.v2', ?)")
    .run(key, `OANDA:XAUUSD:15:${openedMs - M15}`, agent, iso(openedMs), iso(openedMs), iso(openedMs), side, side === "BUY" ? 4000 - stop : 4000 + stop, mode, regime, `${mode}|${regime}`, iso(openedMs + HOUR), JSON.stringify({ "e0@s1": { r, s: r > 0 ? "target" : "stop", f: 1 } }), iso(openedMs + HOUR));
}

/**
 * The scenario both trees run with MODE_SHADOW_EVIDENCE and MODE_PROBATION "off": one decision (the record), the plan
 * learner on it (the setups and its state), and three daily selector runs that end in a council-approved switch (each
 * outcome, the change rows, the control, the events and the Telegram lines). `mods`: { de, pl, ms, au, rt }.
 */
export async function offScenario({ de, pl, ms, au, rt }, extraEnv = {}) {
  de.resetDecisionSchemaCacheForTests(); pl.resetPlanLearningSchemaCacheForTests(); ms.resetModeSchemaForTests(); au.resetAiUsageSchemaCacheForTests(); rt.resetRoomTuningCacheForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), AI: failingAi, ...ENV_BASE, ...extraEnv };
  await env.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "intraday");
  const out = await de.runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW + 5_000, loaded: loaded() });
  const decision_json = env.DB.raw.prepare("SELECT decision_json FROM engine_decisions").get()?.decision_json ?? null;
  const later = Date.parse(CLOSE) + 3 * HOUR;
  const learning = await pl.runPlanLearning(env, { now: later, bars: risingBars(Date.parse(CLOSE)) });
  const plan_rows = env.DB.raw.prepare(`SELECT ${PLAN_COLUMNS} FROM plan_setups ORDER BY setup_key`).all();
  const plan_state = await env.SIGNAL_CACHE.get(pl.PLAN_LEARNING_KEY);

  // The selector on its own database: swing better than intraday, a candidate, a refusal, then an approval.
  ms.resetModeSchemaForTests(); au.resetAiUsageSchemaCacheForTests();
  const sel = { DB: d1(), SIGNAL_CACHE: kv(), ...extraEnv };
  pl.resetPlanLearningSchemaCacheForTests();
  await pl.ensurePlanLearningSchema(sel.DB);
  const T = Date.parse("2026-11-18T12:00:00Z");
  for (let i = 0; i < 40; i++) insertSetup(sel.DB, { key: `s${String(i).padStart(3, "0")}`, mode: "swing", r: 0.4 + (i % 2 ? 0.05 : -0.05), openedMs: T - 10 * DAY + i * M1 });
  for (let i = 0; i < 40; i++) insertSetup(sel.DB, { key: `i${String(i).padStart(3, "0")}`, mode: "intraday", r: 0.05 + (i % 2 ? 0.05 : -0.05), openedMs: T - 10 * DAY + i * M1 });
  await sel.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "intraday");
  const events = [], lines = [];
  const log = async (action, detail) => { events.push({ action, detail }); };
  const notify = async (t) => { lines.push(t); };
  const seats = (verdict) => async () => ({ status: "answered", obj: { verdict, reason: `${verdict} on the evidence` } });
  const runs = [];
  runs.push(await ms.runModeSelector(sel, { now: T, regime: "trend", call: seats("reject"), log, notify }));
  runs.push(await ms.runModeSelector(sel, { now: T + DAY, regime: "trend", call: seats("reject"), log, notify }));
  runs.push(await ms.runModeSelector(sel, { now: T + 2 * DAY, regime: "trend", call: seats("approve"), log, notify }));
  const changes = sel.DB.raw.prepare("SELECT * FROM omega_mode_changes ORDER BY id").all();
  const control = await sel.SIGNAL_CACHE.get(ms.MODE_CONTROL_KEY);
  return { decided: { status: out.status, stance: out.stance, source: out.source }, decision_json, learning, plan_rows, plan_state, selector: { runs, changes, control, events, lines, mode: await sel.SIGNAL_CACHE.get(de.TRADING_MODE_KEY) } };
}
