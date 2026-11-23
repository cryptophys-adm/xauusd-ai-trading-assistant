// "Omega with limit entry" (docs/RFC_OMEGA_LIMIT_ENTRY.md §8, stage 2, measurement only): the maker counterfactual on
// the same simulated account as v4, its fill, its misses and cancels, its knobs, the maker/taker pairing, the cron step
// beside v4 and the execution report's limit block (R only, no price key at any depth).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { replayOmega4, decisionFromRow, runOmega4, MAX_REPLAY_MINUTES, OMEGA4_CHECKPOINT_KEY, ENGINE_CODE_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import {
  replayOmegaLimit, limitKnobs, limitCancelReason, runOmegaLimit, LIMIT_KNOB_START, LIMIT_KNOB_BOUNDS, LIMIT_KNOBS_SOURCE, OMEGA_LIMIT_CHECKPOINT_KEY, OMEGA_LIMIT_VERSION
} from "../src/ledger-omega-limit.mjs";
import { planIntents, OMEGA_DEFAULTS, LIMIT_ENTRY_AVAILABLE } from "../src/omega-engine.mjs";
import { makerTaker, limitStats, executionReport, limitReport, readLedger, readExecutionReport, runOmega4Step, resetLedgerSchemaCacheForTests, EXECUTION_REPORT_SCHEMA, REPORT_FORBIDDEN_KEYS } from "../src/signal-ledger.mjs";
import { DECISION_SCHEMA_SQL } from "../src/decision-engine.mjs";

const M1 = 60_000, M5 = 5 * M1, M15 = 15 * M1;
const C = Date.parse("2026-11-19T12:00:00Z"); // a 15m close
const key = (close) => `OANDA:XAUUSD:15:${close - M15}`;
const levels = (pairs) => pairs.map(([low, high]) => ({ low, high }));
function path(from, to, price, wiggle = 0.05) {
  const out = [];
  for (let t = from; t < to; t += M1) {
    const o = price(t), c = price(t + M1);
    out.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: Math.max(o, c) + wiggle, low: Math.min(o, c) - wiggle, close: c });
  }
  return out;
}
const lerp = (pts) => (t) => {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, pa] = pts[i - 1], [b, pb] = pts[i]; return Math.round((pa + ((pb - pa) * (t - a)) / (b - a)) * 1000) / 1000; }
  return pts.at(-1)[1];
};
const conf = (short, long = 0.6) => ({ zone_pullback: { long, short } });
function decision({ close, stance = "SELL", decidedAfter = 2 * M1, trade = null, score = -0.3, shares = [0.2, 0.8], lv = [], mode = "scalp", regime = "normal-ranging" }) {
  return {
    decision_key: key(close), bar_close: new Date(close).toISOString(), decided_at: new Date(close + decidedAfter).toISOString(), stance, confidence: 0.7,
    trade, guardrails: { long: { entry_trigger: { fired: false, note: "waiting" } }, short: { entry_trigger: { fired: false, note: "waiting" } } },
    quorum: { score, long_share: shares[0], short_share: shares[1] }, key_levels: lv, agent_confidence: conf(0.85), agent_confidence_prev: conf(0.85),
    trading_mode: mode, strategy_execution: false, context: { regime_1h: regime }, strategy: { atr_h1: 5 }
  };
}
const sellTrade = (entry, stop, tp) => ({ side: "SELL", action: "ENTER_LIMIT", entry, stop, tp, tp1: tp, target: "tp1", agent: "zone_pullback" });
const dec = (d) => decisionFromRow({ decision_json: JSON.stringify(d) });
const WARM = 5 * 3600_000;
const base = (overrides = {}) => ({ settings: { ...OMEGA_DEFAULTS, enabled: true }, profileAt: () => "aggressive", from: C, ...overrides });
const LV = levels([[1940, 1942]]);

/** A SELL at the 2000 level (stop 2020, target 1970), price under it at the decision, then the path `pts` after. */
function sellCase(pts, { mode = "scalp", later = [], to = C + 60 * M1 } = {}) {
  const d0 = decision({ close: C, trade: sellTrade(2000, 2020, 1970), lv: LV, mode });
  return { bars: path(C - WARM, to, lerp(pts)), decisions: [dec(d0), ...later.map(dec)], to };
}

test("L1. a limit fills when a bar reaches the level, then v4 manages it: the TP ladder's lock and the sl_plus exit, through planIntents", () => {
  assert.equal(LIMIT_ENTRY_AVAILABLE, true, "stage 3 turned limit entries on live; the replay stays a measurement");
  // Price 1998 at the decision (2 under the SELL level: in the band 0.35 x 20 = 7), up to the level at C + 8, then the
  // ladder case's drop to 1995.5 and the rise back through the locked stop.
  const pts = [[C + 3 * M1, 1998], [C + 8 * M1, 2000], [C + 15 * M1, 1995.5], [C + 22 * M1, 1995.5], [C + 36 * M1, 2003]];
  const later = [decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, lv: LV })];
  const { bars, decisions, to } = sellCase(pts, { later });
  const trace = [];
  let calls = 0;
  // SLG1 (2026-11-23): the lock below is the "legacy" one (MFE 4.5 never reaches the profit-lock gate's 1R of 20).
  const run = replayOmegaLimit({ ...base({ settings: { ...OMEGA_DEFAULTS, enabled: true, profit_lock_gate: "legacy" } }), bars, decisions, to, trace, plan: (input) => { calls += 1; return planIntents(input); } });
  // Every call is planIntents (the main plans and the placement probes).
  assert.equal(calls, run.plans + run.limit.probes);
  assert.deepEqual([run.limit.placed, run.limit.filled, run.limit.missed], [1, 1, 0]);
  const r = run.records[key(C)];
  assert.equal(r.limit_status, "closed");
  // The SELL limit fills in the minute whose bid high reaches 2000 (C + 7: its close is 2000, its high 2000.05).
  assert.equal(r.limit_filled_at, new Date(C + 7 * M1).toISOString());
  const j = JSON.parse(r.limit_json);
  assert.equal(j.version, OMEGA_LIMIT_VERSION);
  // Placed at the first minute after the decision (decided at C + 2), its gates passed.
  assert.deepEqual([j.entry_policy.placed_at, j.entry_policy.wait_min, j.entry_policy.away_r], [new Date(C + 2 * M1).toISOString(), 5, 0.1]);
  assert.deepEqual(j.entry_policy.knobs, limitKnobs("scalp"));
  // v4's management after the fill: the planIntents ladder lock on a closed M5 candle, then the locked stop.
  const lock = trace.filter((s) => s.now > C + 7 * M1).flatMap((s) => s.output.intents.map((it) => ({ ...it, at: s.now }))).find((it) => /^ladder_lock_tp0/.test(String(it.reason)));
  assert.ok(lock, "the ladder's lock is planned on the filled position");
  assert.equal(lock.kind, "modify_sl");
  assert.equal(lock.at % M5, 0);
  assert.equal(r.limit_exit, "sl_plus");
  assert.ok(r.r_limit > 0 && r.r_limit < 0.05, String(r.r_limit));
  assert.equal(j.sl_moves, 1);
  // The fill is a v4 trade at the level: the plan's distances from it, never a market open.
  const managed = trace.find((s) => s.now === C + 8 * M1).input.executor.positions[0];
  assert.deepEqual([managed.open_price, managed.sl, managed.tp, managed.intent_id], [2000, 2020, 1970, `open:${C}:S`]);
  assert.equal(trace.some((s) => s.now < C + 7 * M1 && s.input.executor.positions.length), false, "nothing opened at market before the fill");
  // v4 on the same signal entered at market (1998), the taker side of the pair.
  const v4 = replayOmega4({ ...base(), bars, decisions, to }).records[key(C)];
  assert.ok(v4.omega4_status === "open" || v4.omega4_status === "closed", v4.omega4_status);
  assert.equal(v4.omega4_filled_at, new Date(C + 2 * M1).toISOString(), "at market, the minute after the decision");
  assert.equal(r.regime, "normal-ranging");
});

test("L2. an unfilled limit expires at max_pending_life (scalp 30 minutes from its placement)", () => {
  const { bars, decisions, to } = sellCase([[C + 3 * M1, 1998], [C + 90 * M1, 1997]], { to: C + 90 * M1 });
  const run = replayOmegaLimit({ ...base(), bars, decisions, to });
  const r = run.records[key(C)];
  assert.deepEqual([r.limit_status, r.limit_gate, r.r_limit, r.limit_filled_at], ["missed", "pending_expired", null, null]);
  const j = JSON.parse(r.limit_json);
  assert.deepEqual([j.placed_at, j.ended_at, j.life_min], [new Date(C + 2 * M1).toISOString(), new Date(C + 32 * M1).toISOString(), 30]);
  // Intraday rests 60 minutes, swing 240.
  const intra = sellCase([[C + 3 * M1, 1998], [C + 300 * M1, 1997]], { mode: "intraday", to: C + 300 * M1 });
  assert.equal(JSON.parse(replayOmegaLimit({ ...base(), ...intra }).records[key(C)].limit_json).life_min, 60);
  const swing = sellCase([[C + 3 * M1, 1998], [C + 300 * M1, 1997]], { mode: "swing", to: C + 300 * M1 });
  assert.equal(JSON.parse(replayOmegaLimit({ ...base(), ...swing }).records[key(C)].limit_json).life_min, 240);
  // Still resting when the span ends: "resting", carried in the checkpoint, and missed in the run that ends it.
  const part = replayOmegaLimit({ ...base(), bars, decisions, to: C + 20 * M1 });
  assert.equal(part.records[key(C)].limit_status, "resting");
  assert.equal(part.checkpoint.entry.pending.key, key(C));
  const rest = replayOmegaLimit({ ...base({ from: part.checkpoint.at_ms }), bars, decisions, to, state: JSON.parse(JSON.stringify(part.checkpoint)) });
  assert.deepEqual([rest.records[key(C)].limit_status, rest.records[key(C)].limit_gate], ["missed", "pending_expired"]);
});

test("L3. limit_through_price: price already through the level at placement is a missed entry, never a market fallback", () => {
  // Bid 2001 over the SELL level 2000: a SELL limit must rest above the bid.
  const { bars, decisions, to } = sellCase([[C + 3 * M1, 2001], [C + 60 * M1, 1990]]);
  const trace = [];
  const run = replayOmegaLimit({ ...base(), bars, decisions, to, trace });
  const r = run.records[key(C)];
  assert.deepEqual([r.limit_status, r.limit_gate], ["missed", "limit_through_price"]);
  assert.equal(JSON.parse(r.limit_json).away_r, -0.05);
  assert.equal(trace.some((s) => s.input.executor.positions.length), false, "no position at all");
  // v4 took it at market (inside its 0.35 band): the pair counts the miss as 0R against v4's trade.
  const v4 = replayOmega4({ ...base(), bars, decisions, to }).records[key(C)];
  assert.ok(v4.omega4_status === "closed" || v4.omega4_status === "open", v4.omega4_status);
});

test("L4. limit_out_of_band: the level further than placement_band x the plan's stop from price", () => {
  // Bid 1992: 8 under the SELL level, the band is 0.35 x 20 = 7.
  const { bars, decisions, to } = sellCase([[C + 3 * M1, 1992], [C + 60 * M1, 2000.5]]);
  const r = replayOmegaLimit({ ...base(), bars, decisions, to }).records[key(C)];
  assert.deepEqual([r.limit_status, r.limit_gate], ["missed", "limit_out_of_band"]);
  assert.equal(JSON.parse(r.limit_json).away_r, 0.4);
  // At 6.8 under (0.34 of the stop) it is placed, and price reaching 2000 later fills it.
  const ok = sellCase([[C + 3 * M1, 1993.2], [C + 20 * M1, 2000.2], [C + 60 * M1, 2000.2]]);
  const placed = replayOmegaLimit({ ...base(), ...ok });
  assert.equal(placed.records[key(C)].limit_status === "open" || placed.records[key(C)].limit_status === "closed", true, JSON.stringify(placed.records[key(C)]));
});

test("L5. a cancel on the quorum share drop: the SELL side's share falls by more than cancel_share_drop from the placing decision", () => {
  const pts = [[C + 3 * M1, 1998], [C + 120 * M1, 1997]];
  // Intraday (60 minutes of life): the next 15m decision, a WAIT, holds short_share 0.7 against the placing 0.8.
  const drop = sellCase(pts, { mode: "intraday", later: [decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, shares: [0.3, 0.7], mode: "intraday" })], to: C + 120 * M1 });
  const r = replayOmegaLimit({ ...base(), ...drop }).records[key(C)];
  assert.deepEqual([r.limit_status, r.limit_gate], ["missed", "quorum_share_drop"]);
  assert.equal(JSON.parse(r.limit_json).ended_at, new Date(C + M15 + M1).toISOString(), "at the minute the decision is made");
  // A drop of 0.03 is no reason (and a WAIT alone never is): the order rests to its life.
  const small = sellCase(pts, { mode: "intraday", later: [decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, shares: [0.23, 0.77], mode: "intraday" })], to: C + 120 * M1 });
  assert.equal(replayOmegaLimit({ ...base(), ...small }).records[key(C)].limit_gate, "pending_expired");
  // The pure reason, at the knob's edge: more than 0.05 cancels, exactly 0.05 does not.
  const pending = { side: "SELL", close_ms: C, placed_ms: C + 3 * M1, share0: 0.8, profile: "aggressive", knobs: limitKnobs("intraday") };
  const at = (share) => limitCancelReason({ pending, now: C + 20 * M1, decision: { close_ms: C + M15, stance: "WAIT", quorum: { short_share: share } } });
  assert.deepEqual([at(0.74), at(0.75), at(0.8)], ["quorum_share_drop", null, null]);
});

test("L6. a cancel when the decision turns against the order, and the deterministic hard cancels", () => {
  const later = [decision({ close: C + M15, stance: "BUY", decidedAfter: M1, score: 0.3, shares: [0.8, 0.2], trade: null, mode: "intraday" })];
  const c = sellCase([[C + 3 * M1, 1998], [C + 120 * M1, 1997]], { mode: "intraday", later, to: C + 120 * M1 });
  const r = replayOmegaLimit({ ...base(), ...c }).records[key(C)];
  assert.deepEqual([r.limit_status, r.limit_gate], ["missed", "decision_against"]);
  // Kill, pause, a news blackout, the daily loss floor and a downgrade cancel at once, in that order.
  const pending = { side: "SELL", close_ms: C, placed_ms: C, share0: 0.8, profile: "aggressive", knobs: limitKnobs("intraday") };
  const args = { pending, now: C + M1, settings: OMEGA_DEFAULTS, profile: "aggressive", equity: 1000, dayStart: 1000 };
  assert.equal(limitCancelReason({ ...args, mode: "killed", blackout: {} }), "kill");
  assert.equal(limitCancelReason({ ...args, mode: "paused" }), "paused");
  assert.equal(limitCancelReason({ ...args, blackout: { reason: "NFP" } }), "blackout");
  assert.equal(limitCancelReason({ ...args, equity: 980 }), "daily_loss_limit", "the smaller of the setting (2 %) and Aggressive's 10 %");
  assert.equal(limitCancelReason({ ...args, equity: 981 }), null);
  assert.equal(limitCancelReason({ ...args, equity: 900, settings: { ...OMEGA_DEFAULTS, max_daily_loss_pct: 20 } }), "daily_loss_limit", "Aggressive caps a 20 % setting at 10 %");
  assert.equal(limitCancelReason({ ...args, equity: 901, settings: { ...OMEGA_DEFAULTS, max_daily_loss_pct: 20 } }), null);
  assert.equal(limitCancelReason({ ...args, profile: "safe" }), "profile_downgrade");
  assert.equal(limitCancelReason({ ...args, now: C + 60 * M1 }), "pending_expired");
  assert.equal(limitCancelReason({ ...args, now: C + 59 * M1 }), null);
  // Paused in the replay's EA control history: the resting order goes at that minute.
  const paused = replayOmegaLimit({ ...base(), ...sellCase([[C + 3 * M1, 1998], [C + 60 * M1, 1997]]), control: [{ at_ms: C + 10 * M1, mode: "paused" }] }).records[key(C)];
  assert.deepEqual([paused.limit_gate, JSON.parse(paused.limit_json).ended_at], ["paused", new Date(C + 10 * M1).toISOString()]);
});

test("L7. the knobs: the RFC's start values per mode, every value clamped to ADR-0020 A7's bounds", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(LIMIT_KNOB_START).map(([m, k]) => [m, [k.max_pending_life, k.move_max_atr, k.cancel_share_drop, k.placement_band]])),
    { scalp: [30, 0.25, 0.05, 0.35], intraday: [60, 0.5, 0.05, 0.35], swing: [240, 0.5, 0.05, 0.35], range: [60, 0.25, 0.05, 0.35] });
  assert.deepEqual([LIMIT_KNOB_BOUNDS.scalp.max_pending_life, LIMIT_KNOB_BOUNDS.intraday.max_pending_life, LIMIT_KNOB_BOUNDS.swing.max_pending_life, LIMIT_KNOB_BOUNDS.range.max_pending_life], [{ min: 15, max: 60 }, { min: 30, max: 240 }, { min: 60, max: 720 }, { min: 30, max: 240 }]);
  assert.deepEqual(limitKnobs("scalp"), { mode: "scalp", max_pending_life: 30, move_max_atr: 0.25, cancel_share_drop: 0.05, placement_band: 0.35, source: LIMIT_KNOBS_SOURCE });
  assert.equal(LIMIT_KNOBS_SOURCE, "start_values");
  const low = limitKnobs("scalp", { max_pending_life: 5, move_max_atr: -1, cancel_share_drop: 0, placement_band: 0 });
  assert.deepEqual([low.max_pending_life, low.move_max_atr, low.cancel_share_drop, low.placement_band, low.source], [15, 0, 0.03, 0.1, "overrides_clamped"]);
  const high = limitKnobs("swing", { max_pending_life: 5000, move_max_atr: 2, cancel_share_drop: 0.5, placement_band: 1 });
  assert.deepEqual([high.max_pending_life, high.move_max_atr, high.cancel_share_drop, high.placement_band], [720, 0.5, 0.1, 0.6]);
  assert.equal(limitKnobs("range", { max_pending_life: 1000 }).max_pending_life, 240);
  assert.equal(limitKnobs(null).mode, "intraday", "an unknown mode reads as intraday");
  assert.equal(limitKnobs("intraday", { placement_band: "x" }).placement_band, 0.35, "a value that is not a number keeps the start value");
  // A clamped band in the replay: 0.9 asked, 0.6 used, so 8 under a 20 stop (0.4) is placed.
  const c = sellCase([[C + 3 * M1, 1992], [C + 60 * M1, 1991]]);
  const r = replayOmegaLimit({ ...base(), ...c, knobsFor: (m) => limitKnobs(m, { placement_band: 0.9 }) }).records[key(C)];
  assert.equal(r.limit_gate, "pending_expired");
  assert.equal(JSON.parse(r.limit_json).knobs.placement_band, 0.6);
});

test("L8. maker against taker on each signal: a miss counts 0R, pairs once both are final, and the counts per mode", () => {
  const row = (o) => ({ omega4_status: "closed", r_omega4: 0.5, limit_status: "closed", r_limit: 1.2, ...o });
  assert.deepEqual(makerTaker(row()), { maker_r: 1.2, taker_r: 0.5, dr: 0.7, better: "maker", both_traded: true });
  assert.deepEqual(makerTaker(row({ limit_status: "missed", limit_gate: "limit_through_price", r_limit: null })), { maker_r: 0, taker_r: 0.5, dr: -0.5, better: "taker", both_traded: false });
  assert.deepEqual(makerTaker(row({ omega4_status: "skipped", r_omega4: null, r_limit: -1 })), { maker_r: -1, taker_r: 0, dr: -1, better: "taker", both_traded: false });
  assert.equal(makerTaker(row({ r_limit: 0.5 })).better, "even");
  assert.equal(makerTaker(row({ limit_status: "resting" })), null, "not final yet");
  assert.equal(makerTaker(row({ omega4_status: "open" })), null);
  assert.equal(makerTaker(row({ omega4_status: "skipped", limit_status: "skipped" })), null, "neither traded");
  const st = limitStats([
    row({ limit_gate: null }), row({ limit_status: "missed", limit_gate: "pending_expired", r_limit: null }), row({ limit_status: "missed", limit_gate: "limit_out_of_band", r_limit: null, r_omega4: -1 }),
    row({ limit_status: "skipped", limit_gate: "max_positions", omega4_status: "skipped", r_limit: null, r_omega4: null }), row({ limit_status: "resting", r_limit: null })
  ]);
  assert.deepEqual([st.decisions, st.filled, st.missed, st.resting, st.placed, st.fill_rate], [5, 1, 2, 1, 3, 0.333]);
  assert.deepEqual(st.missed_by, { pending_expired: 1, limit_out_of_band: 1 });
  assert.deepEqual(st.paired, { n: 3, both_traded: 1, maker_better: 2, taker_better: 1, even: 0, maker_r: 1.2, taker_r: 0, mean_dr: 0.4 });
});

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of DECISION_SCHEMA_SQL) db.exec(sql);
  db.exec("CREATE TABLE IF NOT EXISTS ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER, position_ticket INTEGER, mode TEXT, side TEXT, volume REAL, entry_price REAL, exit_price REAL, stop_loss REAL, take_profit REAL, profit REAL, commission REAL DEFAULT 0, swap REAL DEFAULT 0, reason TEXT, signal_id TEXT, opened_ms INTEGER, closed_ms INTEGER, currency TEXT, received_at TEXT, source TEXT, strategy TEXT, account_ref TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)");
  db.exec("CREATE TABLE omega_accounts (account_ref TEXT PRIMARY KEY, profile TEXT, last_balance REAL, last_seen_ms INTEGER, created_ms INTEGER)");
  db.prepare("INSERT INTO omega_accounts VALUES ('acct_x', 'aggressive', 1000, ?, ?)").run(C, C - 86_400_000);
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); } }; };
const insertDecisions = (db, decisions) => { for (const d of decisions) db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, 0.7, 'engine', ?)").run(d.decision_key, d.bar_close, d.decided_at, d.stance, JSON.stringify(d)); };

/** A day of 1m bars with a decision every 15 minutes (BUY, SELL, WAIT in turn), the level 1 better than price. */
function dayCase(hours = 24) {
  const start = C - hours * 3600_000;
  const price = (t) => Math.round((2000 + 8 * Math.sin(t / 3_600_000) + 2 * Math.sin(t / 420_000)) * 1000) / 1000;
  const bars = path(start - WARM, C, price, 0.3);
  const decisions = [];
  for (let close = start, i = 0; close < C; close += M15, i++) {
    const px = price(close + 2 * M1), side = i % 3 === 0 ? "SELL" : i % 3 === 1 ? "BUY" : "WAIT", dir = side === "BUY" ? 1 : -1, e = px - dir;
    decisions.push(dec(decision({ close, stance: side, score: side === "BUY" ? 0.3 : -0.3, shares: side === "BUY" ? [0.8, 0.2] : [0.2, 0.8], mode: ["scalp", "intraday", "swing"][i % 3], regime: i % 2 ? "normal-ranging" : "normal-trending",
      trade: side === "WAIT" ? null : { side, action: "ENTER_LIMIT", entry: e, stop: e - dir * 6, tp: e + dir * 9, tp1: e + dir * 9, agent: "zone_pullback" }, lv: levels([[px - 12, px - 11], [px + 11, px + 12]]) })));
  }
  return { start, bars, decisions };
}

test("L9. the cron step: the limit replay after v4 in one ledger run, on v4's rows, never past v4, within the run's bound; resumed runs equal one run", async () => {
  const { start, bars, decisions } = dayCase(24);
  // Resumed from the checkpoint through KV, the records of one long run.
  const one = replayOmegaLimit({ ...base({ from: start }), bars, decisions, to: C });
  let state = null, from = start;
  const merged = {};
  for (;;) {
    const r = replayOmegaLimit({ ...base({ from }), bars, decisions, to: C, state, maxSteps: 137 });
    Object.assign(merged, r.records);
    state = JSON.parse(JSON.stringify(r.checkpoint));
    from = state.at_ms;
    if (!r.more) break;
  }
  assert.deepEqual(merged, one.records);
  assert.ok(one.limit.filled > 3 && one.limit.missed > 3, JSON.stringify(one.limit));

  resetLedgerSchemaCacheForTests();
  const db = d1(), cache = kv(), env = { DB: db, SIGNAL_CACHE: cache };
  insertDecisions(db, decisions);
  // v4 catches up first: the limit replay gets what v4 left of the 720 minutes, and never goes past v4's last minute.
  const first = await runOmega4Step(env, { now: C, bars });
  assert.equal(first.replay.minutes, MAX_REPLAY_MINUTES);
  assert.deepEqual([first.limit.status], ["no_budget"]);
  let step = first, n = 1;
  while ((step.replay.more || step.limit.more || step.limit.status !== "caught_up") && n < 30) {
    step = await runOmega4Step(env, { now: C, bars });
    n += 1;
    if (step.limit.status === "ok") {
      assert.ok(step.replay.minutes + step.limit.minutes <= MAX_REPLAY_MINUTES, JSON.stringify(step));
      const v4At = JSON.parse(cache.m.get(OMEGA4_CHECKPOINT_KEY)).at_ms, limAt = JSON.parse(cache.m.get(OMEGA_LIMIT_CHECKPOINT_KEY)).at_ms;
      assert.ok(limAt <= v4At, "never past v4");
    }
  }
  assert.equal(step.limit.status, "caught_up", JSON.stringify(step));
  // Each decision has one row: v4's (omega4_*) and the limit's (limit_*) side by side, the regime with it.
  const rows = db.raw.prepare("SELECT * FROM ledger_omega4").all();
  assert.equal(rows.length, Object.keys(one.records).length);
  for (const r of rows) {
    const want = one.records[r.decision_key];
    assert.deepEqual([r.limit_status, r.limit_gate, r.limit_exit, r.r_limit, r.regime], [want.limit_status, want.limit_gate, want.limit_exit, want.r_limit, want.regime], r.decision_key);
    assert.ok(r.omega4_status !== "pending" || r.limit_status === "pending", "v4's own rows, not placeholders");
  }
  // The view: the limit block per mode, with its fill rate and the pairs against v4.
  const ledger = await readLedger(env, { days: 30, now: C });
  assert.equal(ledger.rules.limit.version, OMEGA_LIMIT_VERSION);
  const scalp = ledger.by_mode.scalp.limit;
  assert.equal(scalp.policy, "limit");
  assert.ok(scalp.decisions > 0 && scalp.fill_rate != null && scalp.paired.n > 0, JSON.stringify(scalp));
  assert.equal(scalp.paired.maker_better + scalp.paired.taker_better + scalp.paired.even, scalp.paired.n);
  // A second step writes nothing new.
  const again = await runOmega4Step(env, { now: C, bars });
  assert.ok(again.limit.status === "caught_up" || again.limit.written === 0, JSON.stringify(again.limit));
  // LEDGER_OMEGA_LIMIT "off" stops it.
  assert.equal((await runOmega4Step({ ...env, LEDGER_OMEGA_LIMIT: "off" }, { now: C, bars })).limit.status, "off");
  // Without v4's checkpoint the limit replay waits.
  assert.equal((await runOmegaLimit({ DB: db, SIGNAL_CACHE: kv() }, { now: C, bars })).status, "waiting_for_v4");
  // The steady state (a 5-minute cron): both replay the same few minutes, and the limit replay reuses what v4 loaded.
  resetLedgerSchemaCacheForTests();
  const s = d1(), sc = kv(), senv = { DB: s, SIGNAL_CACHE: sc };
  insertDecisions(s, decisions);
  let at = C - 6 * 3600_000, last = null;
  for (let i = 0; i < 30; i++) { last = await runOmega4Step(senv, { now: at, bars }); if (!last.replay.more && last.limit.status === "caught_up") break; }
  for (let i = 0; i < 3; i++) {
    at += 5 * M1;
    last = await runOmega4Step(senv, { now: at, bars });
    assert.deepEqual([last.limit.status, last.limit.reused, last.limit.minutes], ["ok", true, last.replay.minutes], JSON.stringify(last));
  }
});

/** Every key of a value at any depth. */
const keysOf = (v, out = []) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

test("L10. the execution report to Aether: the limit block per mode and regime, R only, no price key at any depth (schema v2)", async () => {
  assert.equal(EXECUTION_REPORT_SCHEMA, "cryptophys.execution-report.v1", "v1 kept: the limit block is an added top-level field, which Aether's validator allows");
  const { bars, decisions } = dayCase(24);
  resetLedgerSchemaCacheForTests();
  const db = d1(), cache = kv(), env = { DB: db, SIGNAL_CACHE: cache };
  insertDecisions(db, decisions);
  for (let i = 0; i < 30; i++) { const s = await runOmega4Step(env, { now: C, bars }); if (!s.replay.more && s.limit.status === "caught_up") break; }
  const report = await readExecutionReport(env, { now: C });
  const lim = report.limit;
  assert.equal(lim.version, OMEGA_LIMIT_VERSION);
  assert.equal(lim.knobs_source, "start_values");
  assert.deepEqual(Object.keys(lim.modes), ["scalp", "intraday", "swing", "range"]);
  const s = lim.modes.scalp;
  for (const k of ["decisions", "placed", "filled", "missed", "fill_rate", "missed_by", "skipped", "maker", "taker", "paired", "regimes"]) assert.ok(k in s, k);
  for (const k of ["trades", "expectancy_r", "profit_factor", "total_r"]) { assert.ok(k in s.maker, k); assert.ok(k in s.taker, k); }
  for (const k of ["n", "maker_better", "taker_better", "mean_dr"]) assert.ok(k in s.paired, k);
  assert.ok(s.decisions > 0);
  assert.deepEqual(Object.keys(s.regimes).sort(), ["normal-ranging", "normal-trending"]);
  assert.equal(Object.values(s.regimes).reduce((a, g) => a + g.decisions, 0), s.decisions);
  // No price key anywhere in the limit block, nor in the report, nor any of Aether's forbidden keys.
  const price = ["entry", "stop", "sl", "tp", "tp1", "tp2", "take_profit", "level", "price"];
  assert.deepEqual(keysOf(lim).filter((k) => price.includes(k)), []);
  assert.deepEqual(keysOf(report).filter((k) => REPORT_FORBIDDEN_KEYS.includes(k)), []);
  // A gate or regime code that would collide with a forbidden key is renamed, never dropped.
  const odd = limitReport([{ trading_mode: "scalp", issued_ms: C, regime: "price", limit_status: "skipped", limit_gate: "stop", omega4_status: "skipped" }]);
  assert.deepEqual(keysOf(odd).filter((k) => REPORT_FORBIDDEN_KEYS.includes(k)), []);
  assert.deepEqual(odd.modes.scalp.skipped, { code_stop: 1 });
  assert.ok("code_price" in odd.modes.scalp.regimes);
  // The pure report without ledger_omega4 rows still carries the block (empty).
  assert.equal(executionReport([], { now: C }).limit.modes.swing.decisions, 0);
});

test("L11. v4 is untouched: its parity era's hash still holds, and its records are the same with the limit replay beside it", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  const { start, bars, decisions } = dayCase(6);
  const before = replayOmega4({ ...base({ from: start }), bars, decisions, to: C });
  replayOmegaLimit({ ...base({ from: start }), bars, decisions, to: C });
  assert.deepEqual(replayOmega4({ ...base({ from: start }), bars, decisions, to: C }), before);
  assert.equal(JSON.stringify(before.records).includes("limit"), false);
});

test("L12. the limit replay's extra cost per signal on two days of 1m bars, beside v4's", () => {
  const { start, bars, decisions } = dayCase(48);
  const signals = decisions.filter((d) => d.stance !== "WAIT").length;
  let t0 = performance.now();
  const v4 = replayOmega4({ ...base({ from: start }), bars, decisions, to: C });
  const v4ms = performance.now() - t0;
  t0 = performance.now();
  const lim = replayOmegaLimit({ ...base({ from: start }), bars, decisions, to: C });
  const ms = performance.now() - t0;
  console.log(`limit replay: ${bars.length} 1m bars, ${signals} signals (${lim.limit.placed} placed, ${lim.limit.filled} filled, ${lim.limit.missed} missed), ${lim.plans} planIntents + ${lim.limit.probes} probes, ${ms.toFixed(0)} ms, ${(ms / signals).toFixed(2)} ms a signal (v4 ${v4.plans} planIntents, ${v4ms.toFixed(0)} ms, ${(v4ms / signals).toFixed(2)} ms a signal)`);
  assert.ok(ms < 10_000, `${ms} ms`);
});
