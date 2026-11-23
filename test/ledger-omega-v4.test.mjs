// The Signal Ledger's Omega policy v4 (owner 2026-11-20: "pastikan omega performance sama dengan omega yang live
// sekarang"): the replay calls the live engine's own functions (planIntents, the Position Manager's positionFacts and
// positionAction, the TP ladder, reentryGate), and a parity check compares it with the live account's real trades.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  replayOmega4, minuteBars, aggregate, structureOf, parseCouncil, decisionFromRow, profileTimeline, balanceTimeline,
  omegaParity, liveTradesFrom, liveExitCode, exitClass, runOmega4, runOmegaParity, PARITY_PASS, OMEGA4_CHECKPOINT_KEY, OMEGA4_PARITY_KEY,
  PARITY_MIN_TRADES, MAX_REPLAY_MINUTES, mergeMinuteBars, archiveMinuteBars, readArchivedBars, nextEra, currentEra, eraStep, eraView, eraSwitches, engineCodeSource, sha256Hex,
  ENGINE_CODE, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, ERA_SWITCHES, ERA_ADOPTABLE_CODE_HASHES, ERA_ADOPTABLE_BEHAVIOUR_HASH, ERA_SEED_MS, OMEGA4_ERA_KEY
} from "../src/ledger-omega4.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { structureOf as adapterStructureOf } from "../market-data-ingestion/src/broker-trigger.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { ledgerView, readLedger, resetLedgerSchemaCacheForTests, OMEGA4_VERSION } from "../src/signal-ledger.mjs";
import { DECISION_SCHEMA_SQL } from "../src/decision-engine.mjs";

// The replay fixtures (V2-V6), shared with ENGINE_BEHAVIOUR_HASH (test/fixtures/engine-behaviour.mjs).
import { M1, M5, M15, C, WARM, key, levels, path, decision, sellTrade, dec, base, ladderCase, breakevenCase, cutLossCase, tp2Case } from "./fixtures/omega-v4-replay.mjs";
// SLG1 (2026-11-23): V3, V4, V6, V9 and V12 replay the locks the profit-lock gate now holds (their moves never reach the
// gate: MFE below 1R); they run with profit_lock_gate "legacy", which is the engine before the gate byte for byte
// (test/profit-lock-gate.test.mjs replays the same fixtures with the gate on).
const LEGACY = { settings: { ...OMEGA_DEFAULTS, enabled: true, profit_lock_gate: "legacy" } };
const legacySettings = (db, at) => {
  db.raw.exec("CREATE TABLE IF NOT EXISTS omega_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_ms INTEGER)");
  db.raw.prepare("INSERT INTO omega_settings VALUES (1, ?, 1, 'owner', ?)").run(JSON.stringify(LEGACY.settings), at);
};

test("V1. the 5m structure is the pull adapter's structureOf; councils, decisions, profiles and balances parse", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ high: 2000 + (i % 5) + 0.7, low: 2000 + (i % 5) - 0.4, close: 2000 + (i % 3) }));
  assert.deepEqual(structureOf(bars), adapterStructureOf(bars));
  assert.equal(structureOf(bars.slice(0, 14)), null);
  assert.deepEqual(parseCouncil("weakening, thesis broken: the quorum fell"), { momentum: "weakening", thesis: "broken", reason: "the quorum fell" });
  assert.equal(parseCouncil(null), null);
  assert.equal(parseCouncil("maybe"), null);
  // The D1 json_extract row and the full decision_json give the same decision for the live functions.
  const d = decision({ close: C, trade: sellTrade(2000, 2020, 1970), lv: levels([[1960, 1962]]) });
  const fromRow = decisionFromRow({ decision_key: d.decision_key, stance: d.stance, decided_at: d.decided_at, confidence: 0.7, trade: JSON.stringify(d.trade), trig_long: JSON.stringify(d.guardrails.long.entry_trigger), trig_short: JSON.stringify(d.guardrails.short.entry_trigger), quorum: JSON.stringify(d.quorum), key_levels: JSON.stringify(d.key_levels), conf: JSON.stringify(d.agent_confidence), conf_prev: JSON.stringify(d.agent_confidence_prev), mode: "scalp", sx: 0, regime: "ranging", atr_h1: 5 });
  const full = dec(d);
  for (const k of ["decision_key", "stance", "trade", "quorum", "key_levels", "agent_confidence", "agent_confidence_prev", "trading_mode", "strategy_execution", "close_ms", "decided_ms"]) assert.deepEqual(fromRow[k], full[k], k);
  assert.equal(full.close_ms, C);
  const profileAt = profileTimeline([{ at_ms: C + 10, from_profile: "conservative", to_profile: "safe" }, { at_ms: C + 20, from_profile: "safe", to_profile: "conservative" }], "aggressive");
  assert.deepEqual([profileAt(C), profileAt(C + 10), profileAt(C + 15), profileAt(C + 25)], ["conservative", "safe", "safe", "conservative"]);
  const balanceAt = balanceTimeline({ last: 500, lastMs: C + 100, deals: [{ closed_ms: C + 10, net: 20 }, { closed_ms: C + 50, net: -5 }] });
  assert.deepEqual([balanceAt(C), balanceAt(C + 10), balanceAt(C + 60)], [485, 505, 500]);
  const m1 = minuteBars(path(C, C + 15 * M1, () => 2000));
  assert.equal(aggregate(m1, M5).length, 3);
});

// A SELL at 2000, stop 2020 (so the scalp band of the Position Manager is 0.3 x 20 = 6.0, 60 pips), target 1970.
test("V2. v4 is planIntents: the same intents as a direct planIntents call on each step's inputs", () => {
  const { bars, decisions } = ladderCase();
  const trace = [];
  let calls = 0;
  const run = replayOmega4({ ...base(), bars, decisions, to: C + 40 * M1, trace, plan: (input) => { calls += 1; return planIntents(input); } });
  assert.ok(run.plans > 10 && calls === run.plans && trace.length === run.plans, JSON.stringify({ plans: run.plans, calls }));
  for (const step of trace) assert.deepEqual(planIntents(step.input), step.output);
  // The open is planIntents' own: its id, its volume (sized within the profile) and the plan's distances from the fill.
  const open = trace.flatMap((s) => s.output.intents).find((it) => it.kind === "open");
  assert.equal(open.id, `open:${C}:S`);
  assert.equal(open.entry, 2000);
  assert.equal(open.sl, 2020);
  assert.equal(open.tp, 1970);
});

test("V3. a v4 trade hits the TP ladder's lock on a closed M5 candle and exits at the locked stop (sl_plus)", () => {
  const { bars, decisions } = ladderCase();
  const trace = [];
  const run = replayOmega4({ ...base(LEGACY), bars, decisions, to: C + 40 * M1, trace });
  const lock = trace.flatMap((s) => s.output.intents.map((it) => ({ ...it, at: s.now }))).find((it) => /^ladder_lock_tp0/.test(String(it.reason)));
  assert.ok(lock, "a ladder lock was planned");
  assert.equal(lock.kind, "modify_sl");
  assert.ok(lock.sl < 2000 && lock.sl > 1999, String(lock.sl));
  assert.equal(lock.at % M5, 0, "on the M5 candle's close");
  const r = run.records[key(C)];
  assert.equal(r.omega4_status, "closed");
  assert.equal(r.omega4_exit, "sl_plus");
  assert.ok(r.r_omega4 > 0 && r.r_omega4 < 0.05, String(r.r_omega4));
  const j = JSON.parse(r.omega4_json);
  assert.equal(j.sl_moves, 1);
  assert.ok(j.protected_at);
  assert.equal(r.omega4_size, 1);
  assert.equal(run.records[key(C + M15)], undefined, "a WAIT is no record");
});

test("V4. the Position Manager's break-even lock applies as the mechanical fallback when no council verdict is recorded", () => {
  // Stop 5 (band 0.3 x 5 = 1.5, 15 pips; the ladder's scalp step is 3.0): at 3 minutes past the 5m close the SELL is
  // 2 in profit, no council answered, so the stop goes to break-even plus the spread; price comes back to it.
  const trace = [];
  const run = replayOmega4({ ...base(LEGACY), ...breakevenCase(), trace });
  const pm = trace.flatMap((s) => s.output.intents.map((it) => ({ ...it, at: s.now }))).find((it) => it.reason === "pm_breakeven");
  assert.ok(pm, JSON.stringify(trace.map((s) => s.output.intents)));
  assert.equal(pm.kind, "modify_sl");
  assert.equal(pm.sl, 1999.8, "the entry less the spread for a SELL");
  assert.equal(pm.at, C + 8 * M1, "3 minutes past the 5m close");
  assert.deepEqual(trace.find((s) => s.now === pm.at).input.pmActions.map((a) => [a.id, a.action, a.rule]), [[`pm:${Math.floor(C / M1) * 10 + 2}:${Math.floor(pm.at / M5)}`, "sl", "breakeven"]]);
  const r = run.records[key(C)];
  const j = JSON.parse(r.omega4_json);
  assert.deepEqual(j.pm, [{ at: new Date(pm.at).toISOString(), rule: "breakeven", council: "fallback" }]);
  assert.equal(r.omega4_exit, "sl_plus");
  assert.equal(r.r_omega4, 0.04, "(2000 - 1999.8) / 5");
});

test("V5. a cut loss needs a measured reason and the council's recorded verdict; the re-entry cooldown then skips the next SELL", () => {
  // The SELL goes 9 against (band 6.0). The 13:15 SELL decision carries the agent's short confidence dropping 0.85 to
  // 0.70 (a measured reason); the council's recorded verdict for that position and 5m bar reads the thesis broken.
  // PM-1M (2026-11-23): the 1m fast layer off (the engine before it): its impulse rule tightens this stop first
  // (test/pm-fast.test.mjs replays the same fixture with the layer on).
  const { bars, decisions, to, councils, settings: settings0 } = cutLossCase();
  const settings = { ...settings0, pm_fast_1m: "off" };
  const trace = [];
  const run = replayOmega4({ ...base({ settings }), bars, decisions, to, trace, councils });
  const r = run.records[key(C)];
  assert.equal(r.omega4_exit, "pm_cut_loss");
  assert.equal(r.omega4_closed_at, new Date(C + 18 * M1).toISOString());
  assert.ok(r.r_omega4 < -0.3 && r.r_omega4 > -0.6, String(r.r_omega4));
  assert.deepEqual(JSON.parse(r.omega4_json).pm, [{ at: new Date(C + 18 * M1).toISOString(), rule: "cut_loss", council: "recorded" }]);
  // Without the council's answer nothing is cut: the position holds to its stop.
  const silent = replayOmega4({ ...base({ settings }), bars, decisions, to });
  assert.equal(silent.records[key(C)].omega4_status, "open");
  // The second SELL: held while the first is open (max_positions 1), then by the cooldown after the cut, until its signal ages out.
  const next = run.records[key(C + M15)];
  assert.equal(next.omega4_status, "skipped");
  assert.equal(next.omega4_gate, "reentry_cooldown");
  assert.ok(trace.some((s) => s.now === C + 17 * M1 && s.output.notes.some((n) => n.code === "max_positions")), "the book is full while the first SELL is open");
  assert.ok(trace.some((s) => s.now === C + 19 * M1 && s.output.notes.some((n) => n.code === "reentry_cooldown")));
  assert.equal(run.checkpoint.reentry.side, "SELL");
});

test("V6. TP2 with the break-even stop: one modify_sltp on the council's verdict, then the moved target is taken", () => {
  // In profit inside the band, the target still at TP1 (1985), a key level beyond it (1975-1977): under the TP ladder
  // the council's "strengthening, thesis intact" sends TP2 out with the stop at break-even plus the spread.
  const trace = [];
  const run = replayOmega4({ ...base(LEGACY), ...tp2Case(), trace });
  const sltp = trace.flatMap((s) => s.output.intents).find((it) => it.reason === "pm_tp2_breakeven");
  assert.ok(sltp, "tp2_breakeven planned");
  assert.equal(sltp.kind, "modify_sltp");
  assert.deepEqual([sltp.sl, sltp.tp], [1999.8, 1977]);
  const r = run.records[key(C)];
  assert.equal(r.omega4_exit, "trailed_target");
  assert.equal(r.r_omega4, 1.15, "(2000 - 1977) / 20");
  assert.equal(exitClass(r.omega4_exit), "target");
});

test("V7. the parity check: matched per decision and side, the exit table, pass or fail at the thresholds on the current era's trades only, insufficient below 20", () => {
  const era = { behaviour_hash: "b".repeat(64), code_hash: "a".repeat(64), switches: [], since_ms: C - 3600_000, commit: "abc123def456", reason: "behaviour change", previous: [{ behaviour_hash: "c".repeat(64), code_hash: "d".repeat(64), switches: [], reason: "seed", since_ms: C - 7200_000, until_ms: C - 3600_000, commit: null }] };
  const issued = (i) => C + i * M15;
  const N = PARITY_MIN_TRADES;
  const rows = Array.from({ length: N }, (_, i) => ({ decision_key: key(issued(i)), side: "SELL", trading_mode: "scalp", omega4_status: "closed", omega4_exit: i === 0 ? "trailed_target" : "stop", omega4_filled_at: new Date(issued(i) + 3 * M1).toISOString(), r_omega4: -1 }));
  const live = (same, dr, n = N) => Array.from({ length: n }, (_, i) => ({ signal_issued_ms: issued(i), side: "SELL", opened_ms: issued(i) + 3 * M1 + 30_000, r: -1 - dr, exit: i === 0 ? "target" : i < same ? "stop" : "pm_cut_loss" }));
  const ok = omegaParity({ ledgerRows: rows, liveTrades: live(N, 0.1), era, now: C });
  assert.deepEqual([ok.status, ok.pass, ok.trades_compared, ok.live_trades, ok.min_trades], ["pass", true, 20, 20, 20]);
  assert.equal(ok.same_exit_share, 1);
  assert.equal(ok.mean_abs_dr, 0.1, "exactly at the |dR| threshold");
  assert.equal(ok.trades[0].entry_diff_s, -30);
  assert.deepEqual(ok.era, {
    since: new Date(C - 3600_000).toISOString(), commit: "abc123def456", reason: "behaviour change", behaviour_hash: "bbbbbbbbbbbb", code_hash: "aaaaaaaaaaaa", hash: "aaaaaaaaaaaa", switches: [], seeded: false, adopted: false, carried: [],
    previous: [{ since: new Date(C - 7200_000).toISOString(), until: new Date(C - 3600_000).toISOString(), commit: null, reason: "seed", behaviour_hash: "cccccccccccc", code_hash: "dddddddddddd", hash: "dddddddddddd", switches: [] }]
  });
  assert.equal(omegaParity({ ledgerRows: rows, liveTrades: live(18, 0), era, now: C }).status, "pass", "18 of 20 is 90 %");
  const fail = omegaParity({ ledgerRows: rows, liveTrades: live(17, 0), era, now: C });
  assert.deepEqual([fail.status, fail.pass, fail.same_exit_share], ["fail", false, 0.85]);
  assert.match(fail.trades[19].cause, /exit pm_cut_loss live, stop in v4/);
  assert.equal(omegaParity({ ledgerRows: rows, liveTrades: live(N, 0.11), era, now: C }).status, "fail", "mean |dR| 0.11");
  // Fewer than 20 live trades in the era: insufficient, never pass, however well they match.
  const few = omegaParity({ ledgerRows: rows.slice(0, 19), liveTrades: live(19, 0, 19), era, now: C });
  assert.deepEqual([few.status, few.pass, few.live_trades, few.same_exit_share, few.mean_abs_dr], ["insufficient", false, 19, 1, 0]);
  // Trades opened before the era are shown, labelled earlier, and not counted.
  const later = { ...era, since_ms: issued(5) };
  const split = omegaParity({ ledgerRows: rows, liveTrades: live(N, 0), era: later, now: C });
  assert.deepEqual([split.trades.length, split.trades_compared, split.earlier.trades_compared, split.status], [20, 15, 5, "insufficient"]);
  assert.deepEqual([split.trades[0].live_code, split.trades[19].live_code], ["earlier", "current"]);
  // Without an era the seed (2026-11-19 17:48 UTC, after #491) applies: these 12:00 trades are all earlier.
  assert.equal(omegaParity({ ledgerRows: rows, liveTrades: live(N, 0), now: C }).trades_compared, 0);
  // A live trade v4 did not take, and a v4 trade live did not take, both count against it.
  const extra = omegaParity({ ledgerRows: [...rows, { decision_key: key(issued(40)), side: "SELL", omega4_status: "closed", omega4_exit: "stop", r_omega4: -1 }], liveTrades: [...live(N, 0), { signal_issued_ms: issued(50), side: "SELL", r: 1, exit: "target" }], era, now: C });
  assert.deepEqual([extra.trades_compared, extra.v4_only, extra.matched, extra.same_exit_share, extra.status], [22, 1, 20, 0.909, "pass"]);
  // A decision live still holds open is not a v4-only trade (not compared until both are final).
  const held = omegaParity({ ledgerRows: [...rows, { decision_key: key(issued(40)), side: "SELL", omega4_status: "closed", omega4_exit: "stop", r_omega4: -1 }], liveTrades: live(N, 0), liveOpen: [{ signal_issued_ms: issued(40), side: "SELL" }], era, now: C });
  assert.deepEqual([held.trades_compared, held.v4_only, held.status], [20, 0, "pass"]);
  assert.ok(PARITY_PASS.same_exit_min === 0.9 && PARITY_PASS.mean_abs_dr_max === 0.1);
  // The live exits: the deal's reason, a stop at or past the entry is SL+, a close by the EA is Omega's close intent.
  assert.equal(liveExitCode({ reason: "tp" }), "target");
  assert.equal(liveExitCode({ reason: "sl", side: "SELL", entry_price: 2000, stop_loss: 1999.8 }), "sl_plus");
  assert.equal(liveExitCode({ reason: "sl", side: "SELL", entry_price: 2000, stop_loss: 2020 }), "stop");
  assert.equal(liveExitCode({ reason: "expert" }, "pm_take_profit_weakening"), "pm_take_profit_weakening");
  const trades = liveTradesFrom({
    deals: [{ position_ticket: 7, side: "SELL", volume: 0.01, profit: 6, reason: "expert", opened_ms: C, closed_ms: C + M5 }, { position_ticket: 7, side: "SELL", volume: 0.01, profit: 4, reason: "tp", opened_ms: C, closed_ms: C + M15 }, { position_ticket: 8, side: "BUY", volume: 0.01, profit: -2, reason: "sl", opened_ms: C, closed_ms: C + M5 }],
    opens: { 7: { entry: 2000, sl: 2020, volume: 0.02, r_dist: 20, signal_issued_ms: C, side: "SELL", mode: "scalp" }, 8: { entry: 2000, sl: 1990, volume: 0.02, signal_issued_ms: C + M15, side: "BUY" } }, closes: { 7: "pm_take_profit_weakening" }
  });
  assert.equal(trades.length, 1, "ticket 8 is still open (0.01 of its 0.02 closed)");
  assert.deepEqual([trades[0].r, trades[0].exit, trades[0].partial_exits], [0.25, "target", 1], "10 USD over 20 / 0.01 x 1 x 0.02 = 40 USD");
  assert.equal(JSON.stringify(trades).includes("2020"), false, "no price leaves");
});

test("V8. the replay's cost per signal on two days of 1m bars (the 5-minute cron's CPU budget)", () => {
  const start = C - 2 * 86_400_000;
  const price = (t) => Math.round((2000 + 8 * Math.sin(t / 3_600_000) + 2 * Math.sin(t / 420_000)) * 1000) / 1000;
  const bars = path(start - WARM, C, price, 0.3);
  const decisions = [];
  for (let close = start, i = 0; close < C; close += M15, i++) {
    const px = price(close + 2 * M1), side = i % 3 === 0 ? "SELL" : i % 3 === 1 ? "BUY" : "WAIT", dir = side === "BUY" ? 1 : -1;
    decisions.push(dec(decision({ close, stance: side, score: side === "BUY" ? 0.3 : -0.3, shares: side === "BUY" ? [0.8, 0.2] : [0.2, 0.8], trade: side === "WAIT" ? null : { side, action: "ENTER_LIMIT", entry: px, stop: px - dir * 6, tp: px + dir * 9, tp1: px + dir * 9, agent: "zone_pullback" }, lv: levels([[px - 12, px - 11], [px + 11, px + 12]]) })));
  }
  const signals = decisions.filter((d) => d.stance !== "WAIT").length;
  const t0 = performance.now();
  const run = replayOmega4({ ...base({ from: start }), bars, decisions, to: C });
  const ms = performance.now() - t0;
  const traded = Object.values(run.records).filter((r) => r.omega4_status === "closed" || r.omega4_status === "open").length;
  console.log(`v4 replay: ${bars.length} 1m bars, ${signals} signals (${traded} traded), ${run.plans} planIntents calls, ${ms.toFixed(0)} ms, ${(ms / signals).toFixed(2)} ms a signal`);
  assert.ok(traded > 10, String(traded));
  assert.ok(ms < 10_000, `${ms} ms`);
});

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of DECISION_SCHEMA_SQL) db.exec(sql);
  db.exec("CREATE TABLE IF NOT EXISTS ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER, position_ticket INTEGER, mode TEXT, side TEXT, volume REAL, entry_price REAL, exit_price REAL, stop_loss REAL, take_profit REAL, profit REAL, commission REAL DEFAULT 0, swap REAL DEFAULT 0, reason TEXT, signal_id TEXT, opened_ms INTEGER, closed_ms INTEGER, currency TEXT, received_at TEXT, source TEXT, strategy TEXT, account_ref TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)");
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

test("V9. the cron step: v4 rows in D1 beside v3, the checkpoint, the view's omega4 block and the hourly parity in GET /api/ledger", async () => {
  resetLedgerSchemaCacheForTests();
  const db = d1(), cache = kv();
  const env = { DB: db, SIGNAL_CACHE: cache };
  const { bars, decisions } = ladderCase();
  // The live USD account: its profile and its last balance (never its number).
  db.raw.exec("CREATE TABLE omega_accounts (account_ref TEXT PRIMARY KEY, profile TEXT, last_balance REAL, last_seen_ms INTEGER, created_ms INTEGER)");
  db.raw.prepare("INSERT INTO omega_accounts VALUES ('acct_x', 'aggressive', 1000.4, ?, ?)").run(C + 30 * M1, C - 86_400_000);
  legacySettings(db, C - 7200_000);
  for (const d of decisions) {
    const full = JSON.parse(JSON.stringify(d));
    db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, 'engine', ?)").run(full.decision_key, full.bar_close, full.decided_at, full.stance, 0.7, JSON.stringify(full));
  }
  db.raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, mode, side, volume, entry_price, stop_loss, profit, reason, opened_ms, closed_ms, currency, source, account_ref) VALUES (1, 42, 'unknown', 'SELL', 0.01, 2000, 1999.6, 0.4, 'sl', ?, ?, 'USD', 'omega', 'acct_x')").run(C + 3 * M1 + 20_000, C + 25 * M1);
  const now = C + 40 * M1;
  const run = await runOmega4(env, { now, bars });
  assert.equal(run.status, "ok", JSON.stringify(run));
  assert.ok(run.ms >= 0);
  // The run's work, printed by the ledger_omega4 log line.
  assert.deepEqual([run.decisions, run.more, run.archived], [2, false, bars.length]);
  assert.ok(run.minutes > 0 && run.plans > 0 && run.position_actions > 0, JSON.stringify(run));
  const row = db.raw.prepare("SELECT * FROM ledger_omega4 WHERE decision_key = ?").get(key(C));
  assert.deepEqual([row.omega4_status, row.omega4_exit], ["closed", "sl_plus"]);
  assert.ok(JSON.parse(cache.m.get(OMEGA4_CHECKPOINT_KEY)).at_ms > C);
  // A second run from the checkpoint writes nothing new.
  assert.equal((await runOmega4(env, { now: now + M1, bars })).written, 0);
  // The live trade on the same decision, closed by the ladder's locked stop: parity passes.
  db.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, 'open', ?, 'done', ?, ?, ?)").run(`open:${C}:S`, JSON.stringify({ side: "SELL", volume: 0.01, entry: 2000, sl: 2020, r_dist: 20, signal_issued_ms: C, mode: "scalp" }), JSON.stringify({ ok: true, ticket: 42 }), C + 3 * M1, C + 3 * M1);
  // The era holding this code (as if it had started an hour before the trade).
  cache.m.set(OMEGA4_ERA_KEY, JSON.stringify({ behaviour_hash: ENGINE_BEHAVIOUR_HASH, code_hash: ENGINE_CODE_HASH, switches: ["profit_lock_gate=legacy"], since_ms: C - 3600_000, commit: "c0ffee", reason: "behaviour change", previous: [], carried: [] }));
  const parity = await runOmegaParity(env, { now });
  assert.equal(parity.status, "checked", JSON.stringify(parity));
  const stored = JSON.parse(cache.m.get(OMEGA4_PARITY_KEY));
  assert.equal(stored.trades_compared, 1);
  assert.equal(stored.trades[0].same_exit, true);
  assert.ok(Math.abs(stored.trades[0].dr) <= 0.1, JSON.stringify(stored.trades[0]));
  assert.deepEqual([stored.status, stored.pass, stored.min_trades], ["insufficient", false, 20], "one trade is not a sample");
  assert.equal(stored.era.commit, "c0ffee");
  // The era in force holds this behaviour (the old shape's adoption is V16).
  assert.deepEqual([stored.era.since, stored.era.behaviour_hash, stored.era.reason], [new Date(C - 3600_000).toISOString(), ENGINE_BEHAVIOUR_HASH.slice(0, 12), "behaviour change"]);
  assert.equal(JSON.stringify(stored).includes("acct_"), false, "no account reference");
  assert.equal((await runOmegaParity(env, { now: now + 60_000 })).status, "fresh", "at most once an hour");
  const ledger = await readLedger(env, { days: 30, now });
  assert.equal(ledger.rules.omega4.version, OMEGA4_VERSION);
  assert.ok(ledger.rules.omega4.approximations.length >= 5);
  assert.equal(ledger.all.omega4.trades, 1);
  assert.deepEqual(ledger.all.omega4.exits, { sl_plus: 1 });
  assert.equal(ledger.by_mode.scalp.omega4.trades, 1);
  assert.equal(ledger.parity.status, "insufficient");
  // The 1m bars the replay read are archived in D1.
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_bars_1m").get().n, bars.length);
});

test("V10. the view pairs v4 with v3 on the ledger's own rows and counts the decisions the ledger held back", () => {
  const items = [{ id: `decision:${key(C)}`, source: "decision", opened_at: new Date(C).toISOString(), status: "closed", trading_mode: "scalp", omega_status: "closed", r_omega: 0.5, omega_size: 1, omega4_status: "closed", r_omega4: 0.8 }];
  const omega4 = [
    { decision_key: key(C), side: "SELL", trading_mode: "scalp", omega4_status: "closed", omega4_exit: "pm_take_profit_weakening", r_omega4: 0.8, omega4_closed_at: new Date(C + M15).toISOString() },
    { decision_key: key(C + M15), side: "SELL", trading_mode: "scalp", omega4_status: "closed", omega4_exit: "stop", r_omega4: -1, omega4_closed_at: new Date(C + 2 * M15).toISOString() },
    { decision_key: key(C + 2 * M15), side: "SELL", trading_mode: "scalp", omega4_status: "skipped", omega4_gate: "reentry_cooldown" }
  ];
  const v = ledgerView(items, { days: 30, omega4 });
  assert.equal(v.all.omega4.trades, 2);
  assert.equal(v.all.omega4.total_r, -0.2);
  assert.equal(v.all.omega4.in_ledger, 1);
  assert.deepEqual(v.all.omega4.skipped, { reentry_cooldown: 1 });
  assert.deepEqual(v.all.omega4.paired, { trades: 1, v4_r: 0.8, v3_r: 0.5, v4_better: 1, v3_better: 0 });
  assert.equal(v.by_source.h1_decision.omega4.trades, 0);
  assert.equal(v.all.omega.trades, 1, "v3 is unchanged beside it");
});

/** A day of 1m bars with a decision every 15 minutes (BUY, SELL, WAIT in turn). */
function dayCase(hours = 24) {
  const start = C - hours * 3600_000;
  const price = (t) => Math.round((2000 + 8 * Math.sin(t / 3_600_000) + 2 * Math.sin(t / 420_000)) * 1000) / 1000;
  const bars = path(start - WARM, C, price, 0.3);
  const decisions = [];
  for (let close = start, i = 0; close < C; close += M15, i++) {
    const px = price(close + 2 * M1), side = i % 3 === 0 ? "SELL" : i % 3 === 1 ? "BUY" : "WAIT", dir = side === "BUY" ? 1 : -1;
    decisions.push(dec(decision({ close, stance: side, score: side === "BUY" ? 0.3 : -0.3, shares: side === "BUY" ? [0.8, 0.2] : [0.2, 0.8], trade: side === "WAIT" ? null : { side, action: "ENTER_LIMIT", entry: px, stop: px - dir * 6, tp: px + dir * 9, tp1: px + dir * 9, agent: "zone_pullback" }, lv: levels([[px - 12, px - 11], [px + 11, px + 12]]) })));
  }
  return { start, bars, decisions };
}

test("V11. the catch-up bound: at most MAX_REPLAY_MINUTES a run, and runs resumed from the checkpoint give exactly the one long run's records", async () => {
  assert.equal(MAX_REPLAY_MINUTES, 720);
  const { start, bars, decisions } = dayCase(24);
  const one = replayOmega4({ ...base({ from: start }), bars, decisions, to: C });
  assert.equal(one.more, false);
  let state = null, from = start, runs = 0;
  const merged = {};
  for (;;) {
    const r = replayOmega4({ ...base({ from }), bars, decisions, to: C, state, maxSteps: 137 });
    runs += 1;
    assert.ok(r.steps <= 137);
    Object.assign(merged, r.records);
    state = JSON.parse(JSON.stringify(r.checkpoint)); // through KV
    from = state.at_ms;
    if (!r.more) break;
  }
  assert.ok(runs >= 10, String(runs));
  assert.ok(Object.values(one.records).filter((x) => x.omega4_status === "closed").length > 10);
  assert.deepEqual(merged, one.records);
  // The cron step stops at its bound and carries the rest.
  resetLedgerSchemaCacheForTests();
  const db = d1(), cache = kv();
  const env = { DB: db, SIGNAL_CACHE: cache };
  for (const d of decisions) db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, 0.7, 'engine', ?)").run(d.decision_key, d.bar_close, d.decided_at, d.stance, JSON.stringify(d));
  const first = await runOmega4(env, { now: C, bars, maxMinutes: 300 });
  assert.deepEqual([first.status, first.minutes, first.more], ["ok", 300, true], JSON.stringify(first));
  let n = 1, last = first;
  while (last.more && n < 20) { last = await runOmega4(env, { now: C, bars, maxMinutes: 300 }); n += 1; }
  assert.equal(last.more, false);
  assert.ok(n >= 4, String(n));
});

test("V12. the 1m archive: merged with the KV series without duplicates, and the replay goes on from it once KV no longer reaches back", async () => {
  const a = [{ t: 1, o: 1, h: 1, l: 1, c: 1 }, { t: 2, o: 2, h: 2, l: 2, c: 2 }];
  const b = [{ t: 2, o: 9, h: 9, l: 9, c: 9 }, { t: 3, o: 3, h: 3, l: 3, c: 3 }];
  assert.deepEqual(mergeMinuteBars(a, b).map((x) => [x.t, x.c]), [[1, 1], [2, 2], [3, 3]], "one bar a minute, the archive's first");
  const { bars, decisions } = ladderCase();
  const setup = () => {
    resetLedgerSchemaCacheForTests();
    const db = d1(), cache = kv(), env = { DB: db, SIGNAL_CACHE: cache };
    for (const d of decisions) db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, 0.7, 'engine', ?)").run(d.decision_key, d.bar_close, d.decided_at, d.stance, JSON.stringify(d));
    // The account's profile (as V9): without one the default 0.5 % risk sizes the minimum lot out.
    db.raw.exec("CREATE TABLE omega_accounts (account_ref TEXT PRIMARY KEY, profile TEXT, last_balance REAL, last_seen_ms INTEGER, created_ms INTEGER)");
    db.raw.prepare("INSERT INTO omega_accounts VALUES ('acct_x', 'aggressive', 1000, ?, ?)").run(C, C - 86_400_000);
    legacySettings(db, C - 7200_000);
    db.raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, mode, side, volume, profit, reason, opened_ms, closed_ms, currency, source, account_ref) VALUES (9, 9, 'unknown', 'SELL', 0.01, 0, 'tp', ?, ?, 'USD', 'omega', 'acct_x')").run(C - 86_400_000, C - 86_000_000);
    return { db, cache, env };
  };
  const end = C + 40 * M1;
  // The reference: one run with every bar in KV.
  const ref = setup();
  await runOmega4(ref.env, { now: end, bars });
  const want = ref.db.raw.prepare("SELECT omega4_status, omega4_exit, r_omega4, omega4_closed_at FROM ledger_omega4 WHERE decision_key = ?").get(key(C));
  assert.deepEqual([want.omega4_status, want.omega4_exit], ["closed", "sl_plus"]);
  // A run while the trade is open (C + 10), then KV rolls: it now starts at C + 5, after the warm-up the replay needs.
  const t = setup();
  const before = bars.filter((x) => Date.parse(x.close_time) <= C + 10 * M1);
  assert.equal((await runOmega4(t.env, { now: C + 10 * M1, bars: before })).open, 1);
  assert.equal(t.db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_bars_1m").get().n, before.length);
  assert.equal(await archiveMinuteBars(t.env, before, { now: C + 10 * M1 }), 0, "only newer minutes are written");
  const rolled = bars.filter((x) => Date.parse(x.open_time) >= C + 5 * M1);
  await runOmega4(t.env, { now: end, bars: rolled });
  assert.deepEqual(t.db.raw.prepare("SELECT omega4_status, omega4_exit, r_omega4, omega4_closed_at FROM ledger_omega4 WHERE decision_key = ?").get(key(C)), want);
  assert.equal(t.db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_bars_1m").get().n, bars.length, "no duplicate minute");
  assert.equal((await readArchivedBars(t.env, C - WARM, C)).length, WARM / M1);
  // Neither KV nor the archive reaches the checkpoint: the open trade is marked out (data_gap) and the replay restarts.
  const g = setup();
  await runOmega4(g.env, { now: C + 10 * M1, bars: before });
  g.db.raw.exec("DELETE FROM ledger_bars_1m");
  await runOmega4(g.env, { now: end + 5 * 3600_000, bars: path(C + 20 * M1, end + 5 * 3600_000, () => 2001) });
  assert.equal(g.db.raw.prepare("SELECT omega4_exit FROM ledger_omega4 WHERE decision_key = ?").get(key(C)).omega4_exit, "data_gap");
});

test("V13. the engine's code hash: the committed hash is the source's (informational, recorded in the era)", async () => {
  for (const [file, [mod, names]] of Object.entries(ENGINE_CODE)) for (const n of names) assert.ok(n in mod, `${file}.${n}`);
  const hash = await sha256Hex(engineCodeSource());
  assert.equal(ENGINE_CODE_HASH, hash, `the engine's code changed: set ENGINE_CODE_HASH in src/ledger-omega4.mjs to "${hash}" (the era carries over while ENGINE_BEHAVIOUR_HASH holds)`);
  assert.match(engineCodeSource(), /planIntents=function planIntents/);
  // The Positioning & Liquidity analyst (2026-11-20) changed the behaviour, so this code is not adoptable as the first
  // fingerprint's: an old-shape era starts a new one at the deploy.
  assert.ok(!ERA_ADOPTABLE_CODE_HASHES.includes(ENGINE_CODE_HASH));
  assert.notEqual(ENGINE_BEHAVIOUR_HASH, ERA_ADOPTABLE_BEHAVIOUR_HASH);
});

test("V14. the engine's behaviour hash: the committed fingerprint is the fixtures' outputs with every switch at its default", async () => {
  const text = engineBehaviourSource();
  const hash = await sha256Hex(text);
  assert.equal(ENGINE_BEHAVIOUR_HASH, hash, `the engine's behaviour changed with its switches at their defaults: set ENGINE_BEHAVIOUR_HASH in src/ledger-omega4.mjs to "${hash}" (a new parity era starts at its deploy)`);
  assert.equal(engineBehaviourSource(), text, "deterministic");
  // The three fixture sets, outputs only.
  const names = text.split("\n").map((l) => l.slice(0, l.indexOf("=")));
  assert.ok(names.filter((n) => n.startsWith("market/hand/")).length >= 60);
  assert.deepEqual(names.filter((n) => !n.startsWith("market/hand/") && n.endsWith("/records")), ["market/replay/aggressive/records", "market/replay/safe_no_ladder/records", "v4/ladder/records", "v4/breakeven_fallback/records", "v4/cut_loss/records", "v4/cut_loss_silent/records", "v4/tp2_breakeven/records", "gate/retrace/retrace/records", "fast/v4/cut_loss/records", "fast/v4/tp_anticipation/records"]);
  assert.deepEqual(names.filter((n) => n.startsWith("pm/")), ["pm/facts", "pm/actions", "pm/messages", "pm/schema", "pm/cleaned", "pm/intents", "pm/plans"]);
  // The switch signature: the switches off their defaults, sorted.
  assert.deepEqual(ERA_SWITCHES, ["entry_order", "pm_loosen_enabled", "positioning_enabled", "liquidity_enabled", "profit_lock_gate", "change_thresholds", "pm_fast_1m"]);
  // The 1m fast-protect layer (PM-1M) is on by default: "off" starts a new era.
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, pm_fast_1m: "off" }), ["pm_fast_1m=off"]);
  // The change thresholds (CH1) are all on by default: a token turned off starts a new era.
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, change_thresholds: "off" }), ["change_thresholds=off"]);
  // The profit-lock gate (SLG1) is on by default: "legacy" starts a new era.
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, profit_lock_gate: "legacy" }), ["profit_lock_gate=legacy"]);
  // The lens switches are on by default: at their defaults they add nothing; a lens switched off starts a new era.
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, liquidity_enabled: false }), ["liquidity_enabled=false"]);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, positioning_enabled: false, liquidity_enabled: false }), ["liquidity_enabled=false", "positioning_enabled=false"]);
  assert.ok(names.filter((n) => n.startsWith("liquidity/spike/")).length >= 20 && text.includes("liquidity_spread_spike"), "the fingerprint covers the lens's gate");
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ entry_order: "market", pm_loosen_enabled: false, risk_pct: 2 }), []);
  assert.deepEqual(eraSwitches({ pm_loosen_enabled: true, entry_order: "council" }), ["entry_order=council", "pm_loosen_enabled"]);
});

test("V15. the era: behaviour hash and switch signature; a source-only change carries it, a behaviour or switch change starts a new one", () => {
  const T = ERA_SEED_MS + 86_400_000;
  // No era stored: the seed after #491.
  const seed = nextEra(null, { behaviour: "b1", code: "c1", switches: [], now: T, commit: "k1" });
  assert.deepEqual([seed.changed, seed.era.since_ms, seed.era.behaviour_hash, seed.era.code_hash, seed.era.seeded, seed.era.reason, seed.events], [true, ERA_SEED_MS, "b1", "c1", true, "seed", ["era seeded"]]);
  assert.equal(ERA_SEED_MS, Date.parse("2026-11-19T17:48:00Z"));
  // The same behaviour, code and switches: unchanged, nothing written.
  assert.deepEqual(nextEra(seed.era, { behaviour: "b1", code: "c1", switches: [], now: T + 1 }), { era: seed.era, changed: false, events: [] });
  // The same behaviour with a new code hash: carried over (same since), the code hash recorded, logged once.
  const carried = nextEra(seed.era, { behaviour: "b1", code: "c2", switches: [], now: T + 60_000, deployedMs: T, commit: "k2" });
  assert.deepEqual([carried.changed, carried.era.since_ms, carried.era.code_hash, carried.era.reason, carried.events], [true, ERA_SEED_MS, "c2", "seed", ["era carried (behaviour identical)"]]);
  assert.deepEqual(carried.era.carried, [{ code_hash: "c2", from: "c1", at_ms: T + 60_000, commit: "k2" }]);
  assert.equal(nextEra(carried.era, { behaviour: "b1", code: "c2", switches: [], now: T + 120_000 }).changed, false, "seen once");
  // Another behaviour hash: a new era from the deploy time, the old one kept.
  const next = nextEra(carried.era, { behaviour: "b2", code: "c3", switches: [], now: T + 3600_000, deployedMs: T + 600_000, commit: "k3" });
  assert.deepEqual([next.era.since_ms, next.era.commit, next.era.reason, next.era.seeded, next.events], [T + 600_000, "k3", "behaviour change", false, ["new era: behaviour change"]]);
  assert.deepEqual([next.era.previous[0].until_ms, next.era.previous[0].behaviour_hash, next.era.previous[0].code_hash, next.era.previous[0].reason], [T + 600_000, "b1", "c2", "seed"]);
  // No deploy time, one in the future or one before the era it replaces: from now.
  assert.equal(nextEra(seed.era, { behaviour: "b3", switches: [], now: T, deployedMs: T + 1 }).era.since_ms, T);
  assert.equal(nextEra(seed.era, { behaviour: "b3", switches: [], now: T, deployedMs: ERA_SEED_MS - 1 }).era.since_ms, T);
  // A switch on: a new era from the settings' updated_ms, the behaviour unchanged.
  const on = nextEra(next.era, { behaviour: "b2", code: "c3", switches: ["entry_order=council"], switchesMs: T + 7200_000, now: T + 9000_000 });
  assert.deepEqual([on.era.since_ms, on.era.reason, on.era.switches, on.era.previous[0].until_ms, on.era.previous.length], [T + 7200_000, "switch on: entry_order=council", ["entry_order=council"], T + 7200_000, 2]);
  // Back to the default: a new era too.
  const off = nextEra(on.era, { behaviour: "b2", code: "c3", switches: [], switchesMs: T + 10_800_000, now: T + 11_000_000 });
  assert.deepEqual([off.era.since_ms, off.era.reason, off.era.switches], [T + 10_800_000, "switch off: entry_order=council", []]);
  // A change of value, two switches, unreadable settings (null keeps the signature), and both moves at once.
  assert.equal(nextEra(on.era, { behaviour: "b2", code: "c3", switches: ["entry_order=limit", "pm_loosen_enabled"], switchesMs: T + 10_800_000, now: T + 11_000_000 }).era.reason, "switch on: entry_order=limit; switch on: pm_loosen_enabled; switch off: entry_order=council");
  assert.equal(nextEra(on.era, { behaviour: "b2", code: "c3", switches: null, now: T + 11_000_000 }).changed, false);
  const both = nextEra(on.era, { behaviour: "b4", code: "c4", switches: [], switchesMs: T + 10_000_000, deployedMs: T + 10_500_000, now: T + 11_000_000 });
  assert.deepEqual([both.era.since_ms, both.era.reason], [T + 10_500_000, "behaviour change; switch off: entry_order=council"]);
  // An updated_ms in the future or before the era: from now.
  assert.equal(nextEra(next.era, { behaviour: "b2", code: "c3", switches: ["pm_loosen_enabled"], switchesMs: T, now: T + 9000_000 }).era.since_ms, T + 9000_000);
});

test("V16. the migration: the production era of the old shape is adopted with its since; currentEra reads the switches from D1", async () => {
  // Production's KV era since stage 3 (#502): { hash: 7497aa51…, since_ms } and no behaviour hash.
  const STAGE3 = "7497aa5177163fa88c581f1f8f90edc5094b99aa8c66a161eb24aaa8a26a9104", SINCE = Date.parse("2026-11-20T08:05:00Z");
  const old = { hash: STAGE3, since_ms: SINCE, commit: "389a33b", seeded: false, previous: [{ hash: "fc885c96c68c", since_ms: ERA_SEED_MS, until_ms: SINCE, commit: null }] };
  const now = Date.parse("2026-11-21T09:00:00Z");
  const m = nextEra(old, { switches: [], now, deployedMs: now - 3600_000, commit: "k5" });
  assert.equal(m.changed, true);
  // Adopted as the behaviour it was proven identical to (the first fingerprint); this code behaves otherwise since the
  // Positioning & Liquidity analyst (2026-11-20), so a new era starts at the deploy and the adopted one is kept before it.
  assert.deepEqual([m.era.since_ms, m.era.behaviour_hash, m.era.code_hash, m.era.switches, m.era.commit, m.era.reason], [now - 3600_000, ENGINE_BEHAVIOUR_HASH, ENGINE_CODE_HASH, [], "k5", "behaviour change"]);
  assert.deepEqual(m.events, ["era adopted (behaviour identical, since kept)", "new era: behaviour change"]);
  assert.deepEqual([m.era.previous[0].since_ms, m.era.previous[0].until_ms, m.era.previous[0].behaviour_hash, m.era.previous[0].code_hash], [SINCE, now - 3600_000, ERA_ADOPTABLE_BEHAVIOUR_HASH, STAGE3]);
  assert.deepEqual(m.era.previous.slice(1), old.previous, "the list before is kept");
  assert.equal(nextEra(m.era, { switches: [], now: now + 3600_000 }).changed, false, "adopted once");
  // The same old shape with the last adoptable code hash: adopted, then the new behaviour's era.
  assert.deepEqual(nextEra({ ...old, hash: ERA_ADOPTABLE_CODE_HASHES.at(-1) }, { switches: [], now }).events, ["era adopted (behaviour identical, since kept)", "new era: behaviour change"]);
  // A switch already on at the migration as well: the later of the two starts.
  const sw = nextEra(old, { switches: ["entry_order=council"], switchesMs: now - 600_000, now });
  assert.deepEqual([sw.era.since_ms, sw.era.reason, sw.era.previous[0].since_ms], [now, "behaviour change; switch on: entry_order=council", SINCE]);
  // An old-shape era whose code no fixture vouches for: a new era at the deploy.
  const unknown = nextEra({ ...old, hash: "f".repeat(64) }, { switches: [], now, deployedMs: now - 3600_000 });
  assert.deepEqual([unknown.era.since_ms, unknown.era.reason, unknown.events], [now - 3600_000, "behaviour change", ["era of unknown behaviour (not adopted)", "new era: behaviour change"]]);
  // In KV, with the switches and their time from omega_settings (id 1), and the deploy from DEPLOYED_AT and DEPLOY_COMMIT.
  const db = d1(), cache = kv();
  db.raw.exec("CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_ms INTEGER)");
  db.raw.prepare("INSERT INTO omega_settings VALUES (1, ?, 3, 'owner', ?)").run(JSON.stringify({ ...OMEGA_DEFAULTS, enabled: true }), SINCE - 86_400_000);
  cache.m.set(OMEGA4_ERA_KEY, JSON.stringify(old));
  const env = { DB: db, SIGNAL_CACHE: cache, DEPLOYED_AT: "2026-11-21T08:00:00Z", DEPLOY_COMMIT: "0123456789abcdef" };
  const step = await eraStep(env, { now });
  assert.deepEqual([step.era.since_ms, step.era.switches, step.era.reason, step.era.commit, step.era.previous[0].since_ms], [Date.parse("2026-11-21T08:00:00Z"), [], "behaviour change", "0123456789ab", SINCE]);
  assert.deepEqual(JSON.parse(cache.m.get(OMEGA4_ERA_KEY)), step.era);
  assert.deepEqual(await currentEra(env, { now: now + 1 }), step.era);
  // The owner turns the council's entries on: the next check starts a new era at the settings' updated_ms.
  db.raw.prepare("UPDATE omega_settings SET settings = ?, updated_ms = ? WHERE id = 1").run(JSON.stringify({ ...OMEGA_DEFAULTS, enabled: true, entry_order: "council" }), now + 1800_000);
  const flip = await currentEra(env, { now: now + 3600_000 });
  assert.deepEqual([flip.since_ms, flip.reason, flip.switches, flip.previous[0].since_ms], [now + 1800_000, "switch on: entry_order=council", ["entry_order=council"], Date.parse("2026-11-21T08:00:00Z")]);
  // The parity view shows the reason and the eras before.
  const view = eraView(flip);
  assert.deepEqual([view.reason, view.switches, view.behaviour_hash, view.previous[0].reason, view.previous[0].code_hash], ["switch on: entry_order=council", ["entry_order=council"], ENGINE_BEHAVIOUR_HASH.slice(0, 12), "behaviour change", ENGINE_CODE_HASH.slice(0, 12)]);
  assert.equal(eraView(old).code_hash, STAGE3.slice(0, 12), "an old-shape era shows its hash as the code hash");
  // No DB: the stored signature is kept.
  assert.deepEqual(await currentEra({ SIGNAL_CACHE: cache }, { now: now + 7200_000 }), flip);
});
