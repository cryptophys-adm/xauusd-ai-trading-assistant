// RM1b fixtures (test/room-waive.test.mjs): a scalp 15m decision at 10:00 UTC whose short side fails on the room alone
// (the key zones below and above price 0.8 of a 1H average range apart), with every witness and TREND_TF bearish, and
// the decision of 09:45 in D1 with a corridor whose lower edge the 10:00 close is below. The scenario runs the
// assessment, the decision record, the council's evidence and messages, the EA signal and Omega's intents, then the same
// decision through runDecisionEngine on a sqlite D1 (the stored record, the council's messages as the model received
// them, the signal and the intents of the stored record). It is written against modules passed in, so the same code runs
// on this tree and on main before RM1b (the pinned hash in the test was taken with it on a git-archive of main 738960c).

export const CLOSE = "2026-11-24T10:00:00.000Z";
export const NOW = Date.parse(CLOSE) + 60_000;
const M15 = 15 * 60_000, H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const zone = (low, high) => ({ low, high, price: (low + high) / 2, candidate: true });
/** Price at a whole number between a demand zone 5 below and a supply zone 3 above (1H ATR 10): squeezed, 0.8 apart. */
export const ZONES = Object.freeze([zone(3990, 3995), zone(4003, 4008), zone(3960, 3962), zone(4040, 4042)]);
export const strategyOf = (price = 4000) => ({ decision: "SELL", state: "SETUP_READY", direction: "SHORT", confidence: 0.6, alignment: 0.6, headline: "The short setup is ready.", price, atr_h1: 10, key_levels: { zones: ZONES.map((z) => ({ ...z })) }, plan: { at_level: false } });
const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
/** Closed bars falling by `step` each, the last closing at 4000 (TREND_TF reads them bearish). */
const fall = (n, ms, step) => Array.from({ length: n }, (_, i) => { const open = Date.parse(CLOSE) - (n - i) * ms; const c = 4000 + (n - 1 - i) * step; return { open_time: iso(open), close_time: iso(open + ms), open: c + step / 2, high: c + step, low: c - step, close: c, volume: 1 }; });
const rising = (n, ms, step) => fall(n, ms, -step);
/** Closed bars swinging 1 either side of 4000 (a range of 4), the last closing at 4000: TREND_TF about 0, neutral. */
const flat = (n, ms) => Array.from({ length: n }, (_, i) => { const open = Date.parse(CLOSE) - (n - i) * ms; const c = i === n - 1 ? 4000 : 4000 + (i % 2 ? 1 : -1); return { open_time: iso(open), close_time: iso(open + ms), open: 4000, high: c + 2, low: c - 2, close: c, volume: 1 }; });
export function loadedOf({ price = 4000, trend = "down" } = {}) {
  const bars = trend === "down" ? fall : trend === "up" ? rising : flat;
  return {
    inputs: { calendar: { events: [] }, m15Bars: [], h1Bars: bars(40, H, 3), h4Bars: bars(40, 4 * H, 8), d1Bars: bars(40, 24 * H, 20) },
    strategy: strategyOf(price),
    global: { timeframes: [row("D1", -0.5), row("H4", -0.4), row("H1", -0.3), row("M15", -0.35, "SELL"), row("NEWS", -0.2), row("MACRO", -0.1)] }, correlations: null, regime: "normal-trending"
  };
}
export const RW_ENV = Object.freeze({ MODEL_RATE_LIMIT_RETRY_MS: "0", TRADING_MODE: "scalp", GLOBAL_DECISION_WEIGHTED: "true", STRATEGY_EXECUTION: "off", TP1_KEY_ZONE_MODE: "off" });
/** The decision of `minutesBefore` before CLOSE with a corridor around 4002 (below 3998-4001, above 4009-4012, 0.8 wide). */
export function earlierRecord(minutesBefore = 15, squeeze = { squeezed: true, corridor: 8, corridor_atr: 0.8, needed: 10, below: { low: 3998, high: 4001 }, above: { low: 4009, high: 4012 } }) {
  const close = Date.parse(CLOSE) - minutesBefore * 60_000;
  return { decision_key: `OANDA:XAUUSD:15:${close - M15}`, bar_close: iso(close), decided_at: iso(close + 60_000), stance: "WAIT", confidence: 0.5, source: "fallback", squeeze };
}
/** The engine's stored decisions: [record] into engine_decisions. */
export async function seed(de, db, records) {
  await de.ensureDecisionSchema(db);
  for (const r of records) await db.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(r.decision_key, r.bar_close, r.decided_at, r.stance, r.confidence, r.source, JSON.stringify(r)).run();
}
/** Omega's intents for a signal on a fresh demo executor (the plan the engine would send now). */
export function intentsOf(oe, signal) {
  const issued = Number(signal?.issued_ms) || Date.parse(CLOSE);
  const executor = {
    connected: true, received_ms: issued + 58_000,
    account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
    symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4000, ask: 4000.2, spread_points: 20 },
    positions: [], orders: []
  };
  return oe.planIntents({ signal, control: { mode: "active" }, settings: { ...oe.OMEGA_DEFAULTS, enabled: true, tp_ladder: false }, executor, now: issued + 60_000, engineEnabled: true });
}

/**
 * The scenario. `mods`: { de, ea, oe } (decision-engine, ea-signal, omega-engine); `db`, `kv` make a D1 and a KV; `env`
 * extra env; `earlier` the stored decisions before CLOSE; `prepare(run)` may write the run's KV first (a hold, an
 * override) and return the env the engine runs with (FS1's resolved copy, say).
 */
export async function roomScenario({ de, ea, oe }, { db, kv, env: extraEnv = {}, earlier = [earlierRecord(15)], loaded: loadedIn = null, prepare = null } = {}) {
  const env = { ...RW_ENV, ...extraEnv };
  const loaded = loadedIn ?? loadedOf();
  // The pure path, with the corridors given as runDecisionEngine reads them.
  const corridors = { bar_close: CLOSE, earlier: earlier.map((r) => ({ bar_close: r.bar_close, squeeze: r.squeeze })) };
  const assessment = de.assess({ ...loaded, room_corridors: corridors }, { now: NOW, env });
  const key = `OANDA:XAUUSD:15:${Date.parse(CLOSE) - M15}`;
  const record = de.buildDecisionRecord({ key, barClose: CLOSE, loaded, assessment, council: null, now: NOW, env });
  const evidence = de.councilEvidence({ barClose: CLOSE, cards: assessment.cards, quorum: assessment.quorum, guards: assessment.guards });
  const messages = de.councilMessages(evidence);
  const signal = ea.eaSignalFromDecision({ decision: record, now: NOW });
  const intents = intentsOf(oe, signal);
  // The engine itself on a sqlite D1: the earlier decisions stored, the council's messages as the model got them.
  de.resetDecisionSchemaCacheForTests?.();
  const seen = [];
  const store = kv();
  let run = { DB: db(), SIGNAL_CACHE: store, AI: { run: async (_model, input) => { seen.push(input?.messages ?? null); throw new Error("model down"); } }, ...env };
  await run.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "scalp");
  await seed(de, run.DB, earlier);
  if (typeof prepare === "function") run = (await prepare(run)) ?? run;
  const out = await de.runDecisionEngine(run, { barClose: CLOSE, now: NOW, clock: () => NOW + 5_000, loaded: { ...loaded } });
  const storedText = run.DB.raw.prepare("SELECT decision_json FROM engine_decisions WHERE bar_close = ?").get(CLOSE)?.decision_json ?? null;
  const stored = storedText ? JSON.parse(storedText) : null;
  const storedSignal = stored ? ea.eaSignalFromDecision({ decision: stored, now: NOW }) : null;
  const storedIntents = storedSignal ? intentsOf(oe, storedSignal) : null;
  return { guards: { long: assessment.guards.long, short: assessment.guards.short }, record, evidence, messages, signal, intents, engine: { status: out.status, stance: out.stance }, stored: storedText, council_seen: seen.slice(0, 1), storedSignal, storedIntents };
}
