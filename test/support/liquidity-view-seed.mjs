// B8: one seeded AI Worker environment for GET /api/liquidity (src/liquidity-view.mjs): an in-memory D1 (node:sqlite)
// that records every statement, and a KV that records every write. test/fixtures/nexus-intel/liquidity.json (the
// Nexus Liquidity page's contract) is this seed's answer; liquidity-unavailable.json is the same with no recent bars.
import { DatabaseSync } from "node:sqlite";
import { BROKER_BARS_SQL, LIQUIDITY_STATE_KEY, baselineKey, backfillKey, backfillIdentity, backfillVersionsKey } from "../../src/liquidity-lens.mjs";
import { LENS_READINGS_SQL } from "../../src/lens-policy.mjs";
import { DECISION_LATEST_KEY } from "../../src/decision-engine.mjs";

export const NOW = Date.parse("2026-11-23T15:00:00Z"); // Monday 10:00 in New York: the market is open
export const REF = "acct_00112233aabbccdd";
export const SERVER = "Demo-MT5";
export const SOURCE = "mt5:demo-mt5:XAUUSD";
export const LOGIN_HASH = "f".repeat(64);
export const BASIS = 0.35;
const M1 = 60_000, M5 = 5 * M1, M15 = 15 * M1, HOUR = 3_600_000;

export function d1() {
  const db = new DatabaseSync(":memory:");
  const seen = [];
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { seen.push(sql); const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => { seen.push(sql); return db.prepare(sql).get(...params) ?? null; },
    all: async () => { seen.push(sql); return { results: db.prepare(sql).all(...params) }; }
  });
  return { prepare: (sql) => wrap(sql), raw: db, seen };
}
export function kv() {
  const m = new Map(), puts = [];
  return { m, puts, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { puts.push(k); m.set(k, String(v)); }, delete: async (k) => { puts.push(k); m.delete(k); } };
}

const iso = (ms) => new Date(ms).toISOString();
const feedClose = (i) => Math.round((4100 + 1.5 * Math.sin(i / 3)) * 100) / 100;
const facts = (over = {}) => ({
  available: true, baseline: "insufficient", baseline_weeks: 2, baseline_reset_at: null, basis: "rolling_hour_of_day", minute_at: iso(NOW - 2 * M1),
  vol_pctl: 0.62, vol_pctl_15m: 0.41, vol_spike: false, thin: false, spread_ratio: 1.1, spread_spike: false,
  sweep: { side: "sell_side", age_min: 12, vol_pctl: 0.97, reclaimed: true },
  pools: { above: 1, below: 0, equal_highs: 1, equal_lows: 0 }, hvn: { inside: false, above: 0, below: 1 }, ...over
});

/** The Key Level Agent's zones on the feed's scale, as readStrategy returns them (the memo the view is given). */
export const STRATEGY = Object.freeze({
  price: 4100.2, atr_h1: 6.1,
  key_levels: { zones: [{ low: 4097.5, high: 4098.9, price: 4098.2, candidate: true }, { low: 4110, high: 4111, price: 4110.5, qualified: true }, { low: 4120, high: 4121, price: 4120.5 }] }
});

/**
 * The seeded environment. `available: false` gives the state of an archive with no recent bar (facts.available false,
 * reason archive_stale, no levels); `feed: false` leaves the feed's series out (no basis is known).
 */
export async function seedLiquidityEnv({ available = true, feed = true } = {}) {
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  const raw = env.DB.raw;
  raw.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, kid TEXT, public_key TEXT, bridge_version TEXT, state TEXT, synced_ms INTEGER)");
  raw.exec("CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, server TEXT, kid TEXT, envelope TEXT, updated_by TEXT, updated_ms INTEGER)");
  raw.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  raw.exec("CREATE TABLE limit_council (id TEXT PRIMARY KEY, kind TEXT NOT NULL, open_id TEXT, ticket INTEGER, bar INTEGER, at_ms INTEGER NOT NULL, status TEXT NOT NULL, choice TEXT, rule TEXT, price REAL, max_move REAL, reason TEXT, council TEXT, facts TEXT, updated_ms INTEGER)");
  raw.exec("CREATE TABLE position_actions (id TEXT PRIMARY KEY, ticket INTEGER NOT NULL, bar INTEGER NOT NULL, at_ms INTEGER NOT NULL, side TEXT NOT NULL, pips REAL, price REAL, action TEXT NOT NULL, rule TEXT NOT NULL, sl REAL, tp REAL, why TEXT, council TEXT, orig_sl REAL, orig_tp REAL, basis REAL, status TEXT NOT NULL)");
  for (const q of [...BROKER_BARS_SQL, ...LENS_READINGS_SQL]) raw.exec(q);
  raw.prepare("INSERT INTO omega_bridge (id, state, synced_ms) VALUES (1, ?, ?)").run(JSON.stringify({ account_ref: REF, server: SERVER, connected: true, received_ms: NOW - 1000, account: { login_hash: LOGIN_HASH }, symbol: { name: "XAUUSD", digits: 2, spread_points: 20 } }), NOW - 1000);
  raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 92, 'stored', ?)").run(SERVER);

  // The feed's closed 5m bars (two hours) and 15m bars (fifteen hours), and the broker's M1 bars at the basis.
  const kvPut = (k, v) => env.SIGNAL_CACHE.m.set(k, typeof v === "string" ? v : JSON.stringify(v));
  if (feed) {
    const c5 = Array.from({ length: 24 }, (_, j) => { const close = NOW - (23 - j) * M5; const c = feedClose(j); return { open_time: iso(close - M5), close_time: iso(close), open: c - 0.2, high: c + 0.6, low: c - 0.6, close: c, volume: 100 }; });
    kvPut("market-data:v2:series:OANDA:XAUUSD|5m", { candles: c5 });
    const c15 = Array.from({ length: 60 }, (_, j) => { const close = NOW - (59 - j) * M15; const c = 4100 + Math.sin(j / 4) * 4; return { open_time: iso(close - M15), close_time: iso(close), open: c - 0.5, high: c + 1.5, low: c - 1.5, close: c, volume: 300 }; });
    kvPut("market-data:v2:series:OANDA:XAUUSD|15m", { candles: c15 });
  }
  const ins = raw.prepare("INSERT INTO broker_bars_1m (account_ref, source, minute_ms, o, h, l, c, tick_volume, spread_points, digits, connection_version, received_ms, legacy_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 92, ?, 0)");
  for (let t = NOW - 2 * HOUR; t < NOW; t += M1) {
    const j = Math.round((t + M1 - (NOW - 23 * M5)) / M5);
    const c = (t + M1 - (NOW - 23 * M5)) % M5 === 0 && j >= 0 && j < 24 ? Math.round((feedClose(j) + BASIS) * 100) / 100 : 4100.3;
    ins.run(REF, SOURCE, t, c, c + 0.3, c - 0.3, c, 40, 18, NOW);
  }

  // Lens B's state, baseline and backfill (KV), as the ledger step writes them.
  const levels = available ? [{ low: 4096.1, high: 4096.1, kind: "sweep" }, { low: 4098, high: 4099, kind: "hvn" }, { low: 4103.2, high: 4103.6, kind: "pool" }] : [];
  kvPut(LIQUIDITY_STATE_KEY, {
    at_ms: NOW - 2 * M1, identity: `${REF}|${SOURCE}|2`, mode: "intraday",
    facts: available ? facts() : { available: false, reason: "archive_stale", baseline: "insufficient", baseline_weeks: 2, baseline_reset_at: null },
    levels, medians: { 34: 18 }, median_any: 18, baseline: "insufficient", baseline_weeks: 2, baseline_at: NOW - 30 * M1, archive_last_ms: available ? NOW - 2 * M1 : NOW - 3 * HOUR
  });
  const hours = {};
  for (let h = 0; h < 168; h++) if (h % 24 >= 1) hours[h] = { n: 480, weeks: 2, q1: Array.from({ length: 101 }, (_, i) => i * 2), q15: Array.from({ length: 101 }, (_, i) => i * 30), spread_median: 18 };
  kvPut(baselineKey(REF), { identity: `${REF}|${SOURCE}|2`, updated_ms: NOW - 30 * M1, hours, baseline: "insufficient", baseline_weeks: 2, reset_at: null, hour_ms: NOW - HOUR });
  const versions = [90, 92];
  kvPut(backfillVersionsKey(REF, SOURCE), { at: iso(NOW - 20 * HOUR), versions });
  kvPut(backfillKey(backfillIdentity(REF, SOURCE, versions)), { status: "copied", at: iso(NOW - 20 * HOUR), versions, sent: 3083, added: 2419, from_ms: NOW - 9 * 86_400_000, to_ms: NOW - 8 * 86_400_000, rebuilt: true });

  // The decision Omega manages with (its key zones on the feed's scale).
  kvPut(DECISION_LATEST_KEY, { decision_key: `OANDA:XAUUSD:15:${NOW - 30 * M1}`, bar_close: iso(NOW - 15 * M1), trading_mode: "intraday", quorum: { score: 0.3, long_share: 0.6, short_share: 0.3 }, key_levels: [{ low: 4097.5, high: 4098.9 }, { low: 4110, high: 4111 }] });

  // The readings of the last 24 hours (facts only), the sweeps and their outcomes, the blocks and maker choices.
  const reading = raw.prepare("INSERT INTO liquidity_readings (at_ms, account_ref, mode, baseline, facts_json, levels_json) VALUES (?, ?, 'intraday', 'insufficient', ?, '[]')");
  reading.run(NOW - 30 * HOUR, REF, JSON.stringify(facts()));
  reading.run(NOW - 10 * M1, REF, JSON.stringify(facts({ excluded: "session_open", sweep: null })));
  reading.run(NOW - 5 * M1, REF, JSON.stringify(facts({ vol_spike: true, vol_pctl: 0.97 })));
  const lr = raw.prepare("INSERT INTO lens_readings (id, lens, kind, at_ms, mode, side, outcome, detail_json, scored_ms) VALUES (?, ?, ?, ?, 'intraday', ?, ?, ?, ?)");
  const sweep = (k, side, outcome, replay = false) => { const t = NOW - k * HOUR; lr.run(`sweep:${t}:${side}`, "liquidity", "sweep", t, side === "buy_side" ? -1 : 1, outcome, JSON.stringify({ vol_pctl: 0.96, atr15: 3.2, ...(replay ? { replay: true } : {}) }), outcome ? NOW : null); };
  sweep(1, "sell_side", null);
  sweep(3, "buy_side", "hit");
  sweep(5, "sell_side", "miss");
  sweep(7, "buy_side", "neutral");
  sweep(200, "sell_side", "hit", true);
  const other = (kind, k, side, outcome) => { const t = NOW - k * HOUR; lr.run(`${kind}:${t}:${side > 0 ? "B" : "S"}`, "liquidity", kind, t, side, outcome, null, outcome ? NOW : null); };
  other("block", 2, 1, "hit");
  other("block", 4, -1, null);
  other("maker", 6, 1, "hit");
  other("maker", 8, -1, "miss");
  other("maker", 9, 1, "neutral");
  lr.run("h4:x", "positioning", "h4", NOW - 4 * HOUR, 1, "hit", null, NOW);

  // The entry council's skip on a sweep against, the deferred modifications, the Position Manager's action citing a sweep.
  raw.prepare("INSERT INTO limit_council (id, kind, open_id, at_ms, status, choice, rule, price, reason, facts, updated_ms) VALUES (?, 'entry', ?, ?, 'decided', 'skip', 'council_skip:liquidity_sweep_against', 4101.5, 'a reclaimed buy-side sweep argues against the long', ?, ?)")
    .run("entry:1", "o:1", NOW - 3 * HOUR, JSON.stringify({ side: "BUY", mode: "intraday", issued_ms: NOW - 3 * HOUR, plan: { entry: 4101.5, stop: 4095 } }), NOW - 3 * HOUR);
  raw.prepare("INSERT INTO limit_council (id, kind, at_ms, status, choice, rule, facts) VALUES ('entry:2', 'entry', ?, 'decided', 'place_limit', 'liquidity_thin', '{}')").run(NOW - 4 * HOUR);
  raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'engine', 'plan', ?)").run(NOW - 50 * M1, JSON.stringify({ notes: "liquidity_modify_deferred", details: { liquidity_modify_deferred: "pm:9001:s:1,pm:9002:t:1" } }));
  raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'engine', 'plan', ?)").run(NOW - 40 * M1, JSON.stringify({ notes: "" }));
  raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, status) VALUES ('pm:9001:1', 9001, 1, ?, 'BUY', 12, 4101, 'tp', 'tp_nearer_liquidity_sweep_against', 4095, 4104, 'a reclaimed buy-side sweep (liquidity_sweep_against)', 'applied')").run(NOW - 70 * M1);
  raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, why, status) VALUES ('pm:9003:1', 9003, 1, ?, 'SELL', 'hold', 'hold_thesis_intact', 'the council calls the thesis intact', 'noted')").run(NOW - 60 * M1);
  env.DB.seen.length = 0;
  env.SIGNAL_CACHE.puts.length = 0;
  return env;
}
