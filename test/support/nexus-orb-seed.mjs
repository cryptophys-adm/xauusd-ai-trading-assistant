// C4 (the Nexus Opening range page, #/orb): the page's fixtures, each the real route's answer on a seeded AI Worker or
// market-data environment. No network. test/nexus-orb-page.test.mjs checks every file against this seed, byte for byte;
// after a change to a route or a rule, regenerate them: node test/support/nexus-orb-seed.mjs --write
//
//   orb.json (B14's contract, not written here)   GET /api/orb on test/support/orb-view-seed.mjs (Tue 24 Nov 10:00 UTC:
//                                     London live, broken up and retesting, its long plan picked; New York of the day
//                                     before over with a release inside its range); the seed checks it equals it.
//   orb-candles.json                  GET /api/ohlcv?timeframe=M15&limit=200 (readChartCandles) on the same bars.
//   orb-decision.json                 GET /api/engine/decision (readLatestDecision) on the same environment: no arm.
//   orb-agents.json                   GET /api/strategy-agents' registry part (agentCatalog, agentStatuses, the plan
//                                     learner's records, suspendedPatterns): orb_breakout live, London held back.
//   orb-overlap.json                  GET /api/orb on Mon 23 Nov 15:00 UTC (the mockup's hour) over the feed's 15m bars of
//                                     test/fixtures/nexus-intel/chart-patterns.json: London live with its long side
//                                     invalidated, New York live, broken up and held, its long plan a limit at the high;
//                                     New York holds the long side in the overlap. Ten recent setups, every exit.
//   orb-overlap-candles.json          the same bars through readChartCandles.
//   orb-overlap-decision.json         the latest decision: BUY on orb_breakout's New York plan, armed, the selection's
//                                     candidates from the real pickStrategy, session_range from sessionRangeReading.
//   orb-overlap-agents.json           the registry: orb_breakout live, neither session held back.
//   orb-mismatch.json                 GET /api/orb on Mon 16 Mar 2026 16:00 UTC: London silent (session_clock_mismatch,
//                                     the US on summer time, the UK not), New York formed with no breakout.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readOrbView } from "../../src/orb-view.mjs";
import { sessionRangeReading } from "../../src/opening-range.mjs";
import { STRATEGY_AGENTS, agentCatalog, agentContext, agentStatuses, strategyAgentsMode, suspendedAgents, suspendedPatterns, DEFAULT_AGENT } from "../../src/strategy-agents.mjs";
import { DECISION_LATEST_KEY, MIN_CONFIDENCE, pickStrategy, readLatestDecision, decisionEngineEnabled } from "../../src/decision-engine.mjs";
import { CONTROL_ARM, PLAN_LEARNING_KEY, ensurePlanLearningSchema } from "../../src/plan-learning.mjs";
import { readChartCandles } from "../../market-data-ingestion/src/chart-reader.mjs";
import { seedOrbEnv, orbBars, STRATEGY, NOW } from "./orb-view-seed.mjs";
import { d1, kv } from "./liquidity-view-seed.mjs";

const M15 = 15 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const SERIES_KEY = "market-data:v2:series:OANDA:XAUUSD|15m";
/** The feed's bars as the market-data cache keeps them: the bar's open in seconds beside its ISO times. */
const cached = (bars) => bars.map((b) => ({ time: Date.parse(b.open_time) / 1000, ...b }));
const orb = STRATEGY_AGENTS.find((a) => a.id === "orb_breakout");

/** The page's clock for each scenario: 2 minutes after the last bar's close. */
export const CONTRACT_NOW = NOW;
export const OVERLAP_NOW = Date.parse("2026-11-23T15:00:30Z");
export const MISMATCH_NOW = Date.parse("2026-03-16T16:00:30Z");

/** The /api/ohlcv answer (the market-data Worker's readChartCandles) on the bars in a store. */
async function candles(store) {
  const r = await readChartCandles({ MARKET_DATA_CACHE: store }, { timeframe: "M15", limit: 200 });
  return r.body;
}
/** The /api/strategy-agents registry part on the plan learner's records, as the route builds it (src/index.ts). */
function agentsBody(env, records, latest) {
  return {
    status: "ok", mode: strategyAgentsMode(env), default_agent: DEFAULT_AGENT,
    agents: agentCatalog(agentStatuses(env, { records }), { suspended: suspendedAgents(records).map((x) => x.id) }).map((a) => ({ ...a, record: records.find((r) => r.agent === a.id) ?? null })),
    suspended_patterns: suspendedPatterns(records),
    latest: latest ? { decision_key: latest.decision_key, bar_close: latest.bar_close, stance: latest.stance ?? null, chosen: latest.trade ? (latest.trade.strategy ?? DEFAULT_AGENT) : null, plans: latest.strategy_plans ?? null } : null
  };
}

// ---------------------------------------------------------------- B14's contract scenario

async function contract() {
  const env = await seedOrbEnv();
  await env.SIGNAL_CACHE.put(SERIES_KEY, JSON.stringify({ candles: cached(orbBars()) }));
  const view = { status: "ok", ...(await readOrbView(env, { now: CONTRACT_NOW, strategy: STRATEGY })) };
  const latest = await readLatestDecision(env);
  const learned = JSON.parse(await env.SIGNAL_CACHE.get(PLAN_LEARNING_KEY));
  return {
    view,
    candles: await candles(env.SIGNAL_CACHE),
    decision: { status: "ok", enabled: decisionEngineEnabled(env), decision: latest },
    agents: agentsBody(env, learned.agents, latest)
  };
}

// ---------------------------------------------------------------- the mockup's hour: both windows live

const cp = JSON.parse(readFileSync(new URL("../fixtures/nexus-intel/chart-patterns.json", import.meta.url), "utf8"));
/** The chart-patterns fixture's 60 closed 15m bars of Mon 23 Nov (00:00 to 15:00 UTC) in the series' shape. */
export const overlapBars = () => cp.charts["15"].ohlcv.map((b) => ({ open_time: iso(b.time * 1000), close_time: iso(b.time * 1000 + M15), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
/** Key zones around the ranges: one holds London's high, one New York's low, two above are the plan's targets. */
const OVERLAP_ZONES = [
  { low: 4097.2, high: 4097.9, price: 4097.5, candidate: false, label: "zone" },
  { low: 4095, high: 4095.6, price: 4095.3, candidate: true, label: "zone" },
  { low: 4103.6, high: 4104.4, price: 4104, candidate: true, label: "zone" },
  { low: 4107.6, high: 4108.4, price: 4108, candidate: true, label: "zone" }
];
const OVERLAP_STRATEGY = Object.freeze({ price: 4100, atr_h1: 2.19, key_levels: { zones: OVERLAP_ZONES } });
const OVERLAP_RECORDS = [{ agent: "orb_breakout", setups: 71, mean_r: 0.1, fill_rate: 0.68, target_rate: 0.4, stop_rate: 0.4, patterns: [
  { pattern: "orb_london", setups: 38, mean_r: 0.14, fill_rate: 0.71, target_rate: 0.41 },
  { pattern: "orb_new_york", setups: 33, mean_r: 0.06, fill_rate: 0.64, target_rate: 0.38 }
] }];
/** Ten setups of the agent, newest first, one of each exit the control arm records (src/signal-ledger.mjs). */
const OVERLAP_SETUPS = [
  ["orb_new_york", "2026-11-23T14:45:00Z", "BUY", 0, "open", null],
  ["orb_london", "2026-11-23T09:30:00Z", "BUY", 0, "resolved", { s: "unfilled", r: 0, f: 0 }],
  ["orb_new_york", "2026-11-20T14:15:00Z", "SELL", 1, "resolved", { s: "target", r: 1.1, f: 1 }],
  ["orb_london", "2026-11-20T09:00:00Z", "BUY", 0, "resolved", { s: "stop", r: -1, f: 1 }],
  ["orb_london", "2026-11-19T08:45:00Z", "BUY", 1, "resolved", { s: "lapse", r: 0.6, f: 1 }],
  ["orb_london", "2026-11-18T09:15:00Z", "SELL", 0, "resolved", { s: "target_before_entry", r: 0, f: 0 }],
  ["orb_london", "2026-11-17T09:00:00Z", "BUY", 0, "resolved", { s: "target", r: 1.3, f: 1 }],
  ["orb_new_york", "2026-11-16T14:00:00Z", "SELL", 1, "resolved", { s: "stop", r: -1, f: 1 }],
  ["orb_london", "2026-11-16T09:45:00Z", "BUY", 0, "resolved", { s: "time", r: 0.2, f: 1 }],
  ["orb_new_york", "2026-11-13T14:30:00Z", "BUY", 0, "resolved", { s: "invalidated", r: 0, f: 0 }]
];

async function overlap() {
  const bars = overlapBars(), store = kv(), db = d1();
  await store.put(SERIES_KEY, JSON.stringify({ candles: cached(bars) }));
  const ctx = { ...agentContext({ bars }), price: OVERLAP_STRATEGY.price, atr: OVERLAP_STRATEGY.atr_h1, levels: OVERLAP_ZONES.map((z) => ({ ...z, major: z.candidate })) };
  const plan = orb.plan(1, ctx);
  // The strategy arm's pick on the long side over three speakers (src/decision-engine.mjs pickStrategy): the opening
  // range at 62%, the zone pullback at 58% with its own plan, the triangles agent under the 40% floor; the strategy
  // engine leans long (alignment 0.9).
  const zonePlan = { agent: "zone_pullback", entry: 4097.5, stop: 4095.9, tp1: 4100.06, tp2: 4103.6, at_level: false, rrr: { tp1: 1.6, tp2: 3.81 } };
  const linesPlan = { agent: "pattern_lines", entry: 4098.6, stop: 4096.9, tp1: 4101.2, tp2: null, at_level: false, rrr: { tp1: 1.53 } };
  const selection = pickStrategy({
    side: "long", stance: "BUY", armed: [], quorum: { long_share: 0.5, short_share: 0.2 }, strategy: { direction: "LONG", alignment: 0.9 },
    speakers: [{ id: "orb_breakout" }, { id: "zone_pullback" }, { id: "pattern_lines" }],
    plans: { orb_breakout: { plan }, zone_pullback: { plan: zonePlan }, pattern_lines: { plan: linesPlan } },
    agentConfidence: { orb_breakout: { long: 0.62 }, zone_pullback: { long: 0.58 }, pattern_lines: { long: 0.38 } }
  });
  const record = {
    decision_key: `OANDA:XAUUSD:15:${Date.parse("2026-11-23T14:45:00Z")}`, bar_close: "2026-11-23T15:00:00.000Z", stance: "BUY", bias: "BULLISH",
    trade: { side: "BUY", strategy: "orb_breakout", pattern: "orb_new_york", chart: "15m", entry: plan.entry, stop: plan.stop },
    strategy_plans: { long: { orb_breakout: { status: "live", ...plan }, zone_pullback: { status: "live", ...zonePlan } }, short: {} },
    selection, armed: { mode: "armed", version: 7, ids: ["orb_breakout"] }, rules: { min_confidence: MIN_CONFIDENCE },
    session_range: sessionRangeReading(bars, { atr: OVERLAP_STRATEGY.atr_h1 })
  };
  await store.put(DECISION_LATEST_KEY, JSON.stringify(record));
  await store.put(PLAN_LEARNING_KEY, JSON.stringify({ agents: OVERLAP_RECORDS }));
  await ensurePlanLearningSchema(db);
  const ins = db.raw.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, pattern, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, version, results_json, updated_at) VALUES (?, ?, 'orb_breakout', ?, ?, ?, ?, 1, ?, 1, 1, 1, 2.19, 'intraday', ?, ?, 'normal-trending', 'intraday|normal-trending', ?, 1, ?, ?)");
  for (const [pattern, at, side, atLevel, status, res] of OVERLAP_SETUPS) {
    const t = Date.parse(at);
    ins.run(`k:${t}:${side}`, `OANDA:XAUUSD:15:${t - M15}`, pattern, iso(t), iso(t), iso(t), side, atLevel ? "ENTER_MARKET" : "ENTER_LIMIT", atLevel, status, res ? JSON.stringify({ [CONTROL_ARM]: res }) : null, iso(t));
  }
  const env = { DB: db, SIGNAL_CACHE: store, INTEL_VIEWS: "on", STRATEGY_AGENTS_LIVE: "orb_breakout" };
  const latest = await readLatestDecision(env);
  return {
    view: { status: "ok", ...(await readOrbView(env, { now: OVERLAP_NOW, strategy: OVERLAP_STRATEGY })) },
    candles: await candles(store),
    decision: { status: "ok", enabled: decisionEngineEnabled(env), decision: latest },
    agents: agentsBody(env, OVERLAP_RECORDS, latest)
  };
}

// ---------------------------------------------------------------- 2026-03-16: London's clock mismatch

/** Flat bars at 2600 (high 2602, low 2598) through Monday 16 March 2026 to 16:00 UTC: New York's range forms, no break. */
export function mismatchBars() {
  const out = [];
  for (let t = Date.parse("2026-03-15T22:00:00Z"); t < Date.parse("2026-03-16T16:00:00Z"); t += M15) out.push({ open_time: iso(t), close_time: iso(t + M15), open: 2600, high: 2602, low: 2598, close: 2600, volume: 100 });
  return out;
}

async function mismatch() {
  const store = kv();
  await store.put(SERIES_KEY, JSON.stringify({ candles: cached(mismatchBars()) }));
  return { view: { status: "ok", ...(await readOrbView({ DB: d1(), SIGNAL_CACHE: store, INTEL_VIEWS: "on", STRATEGY_AGENTS_LIVE: "orb_breakout" }, { now: MISMATCH_NOW, strategy: { price: 2600, atr_h1: 8, key_levels: { zones: [] } } })) } };
}

/** Every file the seed writes, from its scenarios. */
export async function seedOrbPage() {
  const [c, o, m] = [await contract(), await overlap(), await mismatch()];
  return {
    contractView: c.view,
    files: {
      "orb-candles.json": c.candles, "orb-decision.json": c.decision, "orb-agents.json": c.agents,
      "orb-overlap.json": o.view, "orb-overlap-candles.json": o.candles, "orb-overlap-decision.json": o.decision, "orb-overlap-agents.json": o.agents,
      "orb-mismatch.json": m.view
    }
  };
}

// CLI: `node test/support/nexus-orb-seed.mjs --write` rewrites the fixtures from the seed (orb.json stays B14's).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const { contractView, files } = await seedOrbPage();
  const dir = new URL("../fixtures/nexus-intel/", import.meta.url);
  const pinned = JSON.parse(readFileSync(new URL("orb.json", dir), "utf8"));
  if (JSON.stringify(pinned) !== JSON.stringify(contractView)) { console.error("orb.json is not the contract scenario's answer: run test/orb-view.test.mjs"); process.exit(1); }
  for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, dir), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote ${Object.keys(files).length} fixtures`);
}
