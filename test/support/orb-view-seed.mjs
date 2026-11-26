// B14: one seeded AI Worker environment for GET /api/orb (src/orb-view.mjs): the feed's 15m series in KV (synthetic
// bars with a London opening range broken upward and held), the economic calendar (a high-impact release inside the
// previous New York range), the latest decision with orb_breakout's London long plan (and the trade it picked), the plan
// learner's state with the agent's per-session records, and an in-memory D1 (node:sqlite, liquidity-view-seed d1())
// with plan_setups rows of the agent. test/fixtures/nexus-intel/orb.json (the Nexus ORB page's contract) is this seed's
// answer with STRATEGY as the memo. No network.
import { d1, kv } from "./liquidity-view-seed.mjs";
import { STRATEGY_AGENTS, agentContext } from "../../src/strategy-agents.mjs";
import { DECISION_LATEST_KEY } from "../../src/decision-engine.mjs";
import { ensurePlanLearningSchema, PLAN_LEARNING_KEY, CONTROL_ARM } from "../../src/plan-learning.mjs";
import { CALENDAR_KEY } from "../../src/econ-calendar.mjs";

export { d1, kv };
const M15 = 15 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
/** Tuesday 2026-11-24: London opens 08:00Z; the read is at 10:00:30Z (a London window is live, New York's is over). */
export const LDN = Date.UTC(2026, 10, 24, 8, 0);
export const NOW = Date.UTC(2026, 10, 24, 10, 0, 30);
const PREV_NY = Date.UTC(2026, 10, 23, 13, 0);

/** Flat bars at 2600 from Monday 07:00Z; London's range 2595-2605, a close above it at 08:45, then holding above. */
export function orbBars() {
  const at = { [LDN]: [2605, 2597, 2600], [LDN + M15]: [2604, 2595, 2601], [LDN + 2 * M15]: [2603, 2596, 2602], [LDN + 3 * M15]: [2610, 2603, 2609] };
  for (let t = LDN + 4 * M15; t < LDN + 8 * M15; t += M15) at[t] = [2608, 2604, 2606];
  const out = [];
  for (let t = Date.UTC(2026, 10, 23, 7, 0); t < LDN + 8 * M15; t += M15) {
    const [high, low, close] = at[t] ?? [2602, 2598, 2600];
    out.push({ open_time: iso(t), close_time: iso(t + M15), open: close, high, low, close, volume: 100 });
  }
  return out;
}
const ZONES = [
  { low: 2604.5, high: 2606, price: 2605.2, candidate: true, label: "zone" },
  { low: 2629, high: 2631, price: 2630, candidate: true, label: "zone" },
  { low: 2569, high: 2571, price: 2570, candidate: false, label: "zone" }
];
/** The strategy memo the view is given. */
export const STRATEGY = Object.freeze({ price: 2605.5, atr_h1: 8, key_levels: { zones: ZONES } });
const orb = STRATEGY_AGENTS.find((a) => a.id === "orb_breakout");
const LEVELS = ZONES.map((z) => ({ ...z, major: z.candidate }));
export const PLAN = orb.plan(1, { ...agentContext({ bars: orbBars() }), price: 2605.5, atr: 8, levels: LEVELS });

export async function seedOrbEnv({ decisionInKv = true, env: extra = {} } = {}) {
  const db = d1(), store = kv();
  await store.put("market-data:v2:series:OANDA:XAUUSD|15m", JSON.stringify({ candles: orbBars() }));
  await store.put(CALENDAR_KEY, JSON.stringify({ events: [{ title: "Retail sales", currency: "USD", time: iso(PREV_NY + 30 * 60_000), impact: "High" }, { title: "German PMI", currency: "EUR", time: iso(LDN + 15 * 60_000), impact: "High" }] }));
  const record = {
    decision_key: `OANDA:XAUUSD:15:${Date.UTC(2026, 10, 24, 9, 45)}`, bar_close: iso(Date.UTC(2026, 10, 24, 10, 0)),
    trade: { side: "BUY", strategy: "orb_breakout", pattern: "orb_london", chart: "15m", entry: PLAN.entry, stop: PLAN.stop },
    strategy_plans: { long: { orb_breakout: { status: "live", ...PLAN } }, short: {} },
    session_range: { session: "london", minutes_since_open: 120, bars_left: 27, range: { bars: 3, width_atr: 1.25, status: "ok" } }
  };
  if (decisionInKv) await store.put(DECISION_LATEST_KEY, JSON.stringify(record));
  await store.put(PLAN_LEARNING_KEY, JSON.stringify({ agents: [{ agent: "orb_breakout", setups: 20, mean_r: -0.1, patterns: [
    { pattern: "orb_london", setups: 16, mean_r: -0.2, fill_rate: 0.5, target_rate: 0.1 },
    { pattern: "orb_new_york", setups: 4, mean_r: 0.3, fill_rate: 0.25, target_rate: 1 }
  ] }] }));
  await ensurePlanLearningSchema(db);
  db.raw.exec("CREATE TABLE IF NOT EXISTS engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT, decision_json TEXT)");
  if (!decisionInKv) db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decision_json) VALUES (?, ?, ?)").run(record.decision_key, record.bar_close, JSON.stringify(record));
  const ins = db.raw.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, pattern, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, version, results_json, updated_at) VALUES (?, ?, 'orb_breakout', ?, ?, ?, ?, 1, ?, 1, 1, 1, 8, 'intraday', ?, ?, 'normal-trending', 'intraday|normal-trending', ?, 1, ?, ?)");
  const rows = [
    ["orb_london", Date.UTC(2026, 10, 23, 9, 0), "BUY", 1, "resolved", { [CONTROL_ARM]: { s: "stop", r: -1, f: 1 } }],
    ["orb_new_york", Date.UTC(2026, 10, 20, 14, 0), "SELL", 0, "resolved", { [CONTROL_ARM]: { s: "target_before_entry", r: 0, f: 0 } }],
    ["orb_london", Date.UTC(2026, 10, 24, 9, 0), "BUY", 1, "open", null]
  ];
  for (const [pattern, t, side, at, status, res] of rows) ins.run(`k:${t}:${side}`, `OANDA:XAUUSD:15:${t - M15}`, pattern, iso(t), iso(t), iso(t), side, at ? "ENTER_MARKET" : "ENTER_LIMIT", at, status, res ? JSON.stringify(res) : null, iso(t));
  return { DB: db, SIGNAL_CACHE: store, INTEL_VIEWS: "on", STRATEGY_AGENTS_LIVE: "orb_breakout", ...extra };
}
