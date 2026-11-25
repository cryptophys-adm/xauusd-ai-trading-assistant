// B5, the Position Manager lines, each behind a breaker (src/pm-line-breaker.mjs; Track B v2 B5 with erratum E7). Track B
// is live, no shadow (owner 2026-11-22: "tidak perlu shadow, langsung integrasikan …"). The registry, the verdict, the
// tick (closes, R, the trip once), the skip of an off line in the Position Manager and PM-1M (as if the rule did not
// fire; none off: byte for byte), lines_json, the lines on GET /api/omega/position-manager, the owner's turn-on route,
// the version bump, PM_LINES_OFF and v4's history.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  PM_LINES, PM_LINE_IDS, PM_FAST_LINE_IDS, PM_LINE_BREAKER_KEY, PM_LINE_RULE, lineBreakerVerdict, pmLinesOffEnv, readPmLinesLive, clearPmLineMemo,
  pmLineBreakerTick, setPmLine, normalizeDoc, linesOffAt, readPmLineHistory, closeCause, riskUsdOf, holdR, lineTag, pmLinesView, offLinesOf, unackedCloseBefore, PM_LINE_DEFER_MS, PM_LINE_SKIP_EVENT, PM_LINE_EVENTS
} from "../src/pm-line-breaker.mjs";
import { positionFacts, positionAction, pmLinesJson, runPositionManager, readPositionManager, heldExitPrice, positionReport } from "../src/position-manager.mjs";
import { ensurePositionSchema, resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { fastProtect, runFastProtect, PM_FAST_RULES } from "../src/pm-fast.mjs";
import { resetLiquiditySchemaForTests } from "../src/liquidity-lens.mjs";
import { corpusSource } from "../src/corpus-oracle.mjs";
import { replayOmega4, ENGINE_BEHAVIOUR_HASH, ENGINE_CODE } from "../src/ledger-omega4.mjs";
import { PM_LINE_IDS as OMEGA_PM_LINE_IDS, handle, resetKeyCacheForTests } from "../workers/xauusd-omega/src/omega.mjs";
import { factCases } from "./fixtures/pm-a8-off.mjs";
import { fastCases, tpBuyBars, tpBuy, tpBuyMeta, nowAfter, SYM } from "./fixtures/pm-fast.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { replayScenarios } from "./fixtures/omega-market-path.mjs";
import { v4ReplayScenarios } from "./fixtures/omega-v4-replay.mjs";
import { fastReplayScenarios } from "./fixtures/pm-fast.mjs";

const M1 = 60_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function kv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}
function world() {
  resetPositionSchemaCacheForTests();
  clearPmLineMemo();
  const db = d1();
  db.raw.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER)");
  db.raw.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_ticket INTEGER, position_ticket INTEGER, side TEXT, volume REAL, entry_price REAL, exit_price REAL, profit REAL, commission REAL DEFAULT 0, swap REAL DEFAULT 0, currency TEXT, reason TEXT, closed_ms INTEGER)");
  db.raw.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT)");
  db.raw.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  db.raw.exec("CREATE TABLE ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, PRIMARY KEY (day, source, model))");
  return { DB: db, SIGNAL_CACHE: kv(), POSITION_MANAGER_MODE: "live" };
}
/** One closed position a line acted on: its open, the line's applied action and intent, and its exit deal (net in USD). */
async function closedBy(env, { ticket, rule = "cut_loss", net = -1, at = NOW - 3600_000, via = "close", cause = lineTag(rule) }) {
  await ensurePositionSchema(env.DB);
  const raw = env.DB.raw, bar = Math.floor(at / 300_000);
  raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, 'open', ?, 'done', ?, ?)").run(`open:${ticket}:B`, JSON.stringify({ side: "BUY", volume: 0.01, entry: 2000, sl: 1990, tp: 2020, r_dist: 10 }), JSON.stringify({ ok: true, ticket }), at - 600_000);
  const action = via === "close" ? "close" : "sl";
  raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, why, status, lines_json) VALUES (?, ?, ?, ?, 'BUY', ?, ?, 'w', 'applied', ?)").run(`pm:${ticket}:${bar}`, ticket, bar, at, action, rule, JSON.stringify({ present: [], cause }));
  raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, ?, ?, 'done', ?, ?)").run(`pm:${ticket}:${via === "close" ? "c" : "s"}:${bar}`, via === "close" ? "close" : "modify_sl", JSON.stringify({ ticket, reason: `pm_${rule}` }), JSON.stringify({ ok: true }), at + 1000);
  raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, side, volume, entry_price, exit_price, profit, currency, reason, closed_ms) VALUES (?, ?, 'BUY', 0.01, 2000, 1999, ?, 'USD', ?, ?)").run(ticket * 10, ticket, net, via === "close" ? "expert" : "sl", at + 60_000);
}
const events = (env, action) => env.DB.raw.prepare("SELECT actor, action, detail FROM omega_events WHERE action = ? ORDER BY id").all(action).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
const state = (env) => JSON.parse(env.SIGNAL_CACHE.m.get(PM_LINE_BREAKER_KEY));

test("B5-1 the registry: ids are position_actions rule ids (and liquidity@1), versions are ints; the fast lines are PM_FAST_RULES; the Omega route's list is the same", () => {
  assert.deepEqual(PM_LINE_IDS, ["take_profit_weakening", "lock_tp1", "breakeven", "tp2_target", "tp2_breakeven", "cut_loss",
    "loosen_atr_expansion", "loosen_key_level_outside", "loosen_high_impact_release", "tp_nearer_momentum_fading", "tp_nearer_key_level_before",
    "tp_nearer_confidence_drop", "tp_further_atr_expansion_trend", "tp_further_key_level_beyond", "liquidity", "pm_fast_tp", "pm_fast_cut"]);
  for (const l of PM_LINES) assert.ok(Number.isInteger(l.version) && l.version >= 1, l.id);
  assert.deepEqual([...PM_FAST_LINE_IDS], [PM_FAST_RULES.tp, PM_FAST_RULES.cut]);
  assert.deepEqual([...OMEGA_PM_LINE_IDS], [...PM_LINE_IDS], "workers/xauusd-omega/src/omega.mjs PM_LINE_IDS");
  // Not lines: the re-entry (it opens a position, never manages one) and the hold, wait and diagnostic outcomes.
  for (const id of ["pm_reentry", "hold_to_stop", "hold_thesis_intact", "tp2_waits_council", "lock_waits_gate", "inputs_missing", "council_unavailable", "protected", "inside_band", "tp_nearer_liquidity_sweep_against"]) assert.ok(!PM_LINE_IDS.includes(id), id);
  assert.deepEqual(PM_LINE_RULE, { n: 15, floor: 0 });
  assert.ok(ENGINE_CODE["pm-line-breaker"], "the breaker's off set decides the engine's actions: in ENGINE_CODE");
});

test("B5-2 the verdict: 15 closes at -0.1R trip, 14 do not; only the last 15 count; at 0R it holds", () => {
  const at = (r, n) => Array.from({ length: n }, () => r);
  assert.deepEqual(lineBreakerVerdict(at(-0.1, 15)), { n: 15, mean_r: -0.1, trip: true });
  assert.deepEqual(lineBreakerVerdict(at(-0.1, 14)), { n: 14, mean_r: -0.1, trip: false });
  assert.equal(lineBreakerVerdict([...at(-5, 3), ...at(0.1, 15)]).trip, false, "only the last 15");
  assert.equal(lineBreakerVerdict(at(0, 15)).trip, false, "0R is not below 0R");
  assert.equal(lineBreakerVerdict(at({ r: -0.2 }, 15), { n: 15, floor: 0 }).trip, true, "objects with r");
  assert.equal(lineBreakerVerdict([]).mean_r, null);
});

test("B5-3 the tick: 14 closes at -0.1R do not trip; the 15th trips once (KV, one pm_line_off event, one Telegram line); a re-run does not trip again", async () => {
  const env = world(), sent = [];
  const send = async (t) => sent.push(t);
  for (let i = 1; i <= 14; i++) await closedBy(env, { ticket: 1000 + i, at: NOW - (20 - i) * 3600_000 });
  let r = await pmLineBreakerTick(env, { now: NOW, send });
  assert.equal(r.counted.length, 14);
  assert.deepEqual(r.counted[0], { line: "cut_loss", ticket: 1001, r: -0.1 }, "R = net / risk_usd: -1 USD over 10 USD at the stop (r_dist 10 x 0.01 lot)");
  assert.deepEqual(r.tripped, []);
  assert.equal(state(env).lines.cut_loss.off_since, null);
  assert.equal(events(env, "pm_line_off").length, 0);
  assert.equal(sent.length, 0);
  await closedBy(env, { ticket: 1015, at: NOW - 3600_000 });
  r = await pmLineBreakerTick(env, { now: NOW + 300_000, send });
  assert.deepEqual([r.status, r.tripped], ["changed", ["cut_loss"]]);
  const s = state(env).lines.cut_loss;
  assert.deepEqual([s.off_since, s.trip_mean_r, s.closes, s.last.length], [NOW + 300_000, -0.1, 15, 15]);
  const off = events(env, "pm_line_off");
  assert.equal(off.length, 1);
  assert.deepEqual([off[0].actor, off[0].detail], ["agent:pm-line-breaker", { line: "cut_loss", version: 1, closes: 15, mean_r: -0.1, off: ["cut_loss"] }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^XAUUSD SYSTEM · Position Manager line cut_loss@1 off: its last 15 closes averaged -0\.1R/);
  assert.doesNotMatch(sent[0], /\d{4}\.\d|acct_|@example/);
  // Once per trip: later runs (and more closes) never log it again.
  await closedBy(env, { ticket: 1016, at: NOW - 1800_000 });
  r = await pmLineBreakerTick(env, { now: NOW + 600_000, send });
  assert.deepEqual(r.tripped, []);
  await pmLineBreakerTick(env, { now: NOW + 900_000, send });
  assert.equal(events(env, "pm_line_off").length, 1);
  assert.equal(sent.length, 1);
  // The live read: the line is off for the Position Manager.
  clearPmLineMemo();
  assert.deepEqual((await readPmLinesLive(env, { now: NOW + 900_000 })).off, ["cut_loss"]);
});

test("B5-4 what counts as a close: one the line sent, else the last applied stop/target change before the close; other versions and rows without lines_json never count", async () => {
  assert.deepEqual(closeCause([{ id: "pm:1:s:10", kind: "modify_sl", created_ms: 1 }, { id: "x:close", kind: "close", created_ms: 5 }], 10), { intent_id: "x:close", at_ms: 5, via: "close" });
  assert.deepEqual(closeCause([{ id: "pm:1:s:10", kind: "modify_sl", created_ms: 1 }, { id: "sl_key:1", kind: "modify_sl", created_ms: 3 }], 10).intent_id, "sl_key:1", "the last change wins, whoever made it");
  assert.deepEqual(closeCause([{ id: "pm:1:s:10", kind: "modify_sl", created_ms: 1 }, { id: "late", kind: "modify_sl", created_ms: 20 }], 10).intent_id, "pm:1:s:10", "a change after the close is not before it");
  assert.equal(closeCause([], 10), null);
  const env = world();
  await closedBy(env, { ticket: 2001, rule: "breakeven", via: "change", net: 0.5 });
  await closedBy(env, { ticket: 2002, rule: "breakeven", via: "change", cause: "breakeven@0" });
  await closedBy(env, { ticket: 2003, rule: "breakeven", via: "change" });
  env.DB.raw.prepare("UPDATE position_actions SET lines_json = NULL WHERE ticket = 2003").run();
  const r = await pmLineBreakerTick(env, { now: NOW });
  assert.deepEqual(r.counted, [{ line: "breakeven", ticket: 2001, r: 0.05 }], "a stop the line set, hit by the broker: the line's close");
  // A ticket still open on the terminal is not counted yet.
  const e2 = world();
  await closedBy(e2, { ticket: 2004 });
  e2.DB.raw.prepare("INSERT INTO omega_bridge VALUES (1, ?)").run(JSON.stringify({ positions: [{ ticket: 2004 }] }));
  assert.deepEqual((await pmLineBreakerTick(e2, { now: NOW })).counted ?? [], []);
  // R's risk: the open's own risk_usd (probation), else the stop's money as the live parity counts it.
  assert.equal(riskUsdOf({ risk_usd: 7.5, r_dist: 10, volume: 0.01 }), 7.5);
  assert.equal(riskUsdOf({ r_dist: 10, volume: 0.02 }), 20);
  assert.equal(riskUsdOf({ entry: 2000, sl: 1995, volume: 0.01 }), 5);
  assert.equal(riskUsdOf({}), null);
});

test("B5-15 a lost-ack close (expired or pending, not failed) right before the deal: no credit to the last stop/target change and the ticket stays unseen; once the intent reads done (CA1), the close's own line is credited; still unacked 30 min after the close: seen, no line credited, one pm_line_skip", async () => {
  assert.equal(unackedCloseBefore([{ kind: "close", status: "expired", created_ms: 9_000 }], 10_000), true);
  assert.equal(unackedCloseBefore([{ kind: "close", status: "pending", created_ms: 9_000 }], 10_000), true);
  assert.equal(unackedCloseBefore([{ kind: "close", status: "failed", created_ms: 9_000 }], 10_000), false, "a failed close closed nothing");
  assert.equal(unackedCloseBefore([{ kind: "close", status: "done", created_ms: 9_000 }], 10_000), false);
  assert.equal(unackedCloseBefore([{ kind: "close", status: "expired", created_ms: 4_000 }], 10_000), false, "more than 5 s before");
  assert.equal(unackedCloseBefore([{ kind: "close", status: "expired", created_ms: 10_200 }], 10_000), false, "after the deal (a :1 retry)");
  const build = async () => {
    const env = world(), raw = env.DB.raw, ticket = 3001;
    const beAt = NOW - 3600_000, beBar = Math.floor(beAt / 300_000);
    const closeMs = NOW - 10 * M1, clAt = closeMs - 1000, clBar = Math.floor(clAt / 300_000);
    await ensurePositionSchema(env.DB);
    raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, 'open', ?, 'done', ?, ?)").run(`open:${ticket}:B`, JSON.stringify({ side: "BUY", volume: 0.01, entry: 2000, sl: 1990, tp: 2020, r_dist: 10 }), JSON.stringify({ ok: true, ticket }), beAt - 600_000);
    // breakeven: an applied stop change (its line's cause), acked done.
    raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, why, status, lines_json) VALUES (?, ?, ?, ?, 'BUY', 'sl', 'breakeven', 'w', 'applied', ?)").run(`pm:${ticket}:${beBar}`, ticket, beBar, beAt, JSON.stringify({ present: [], cause: lineTag("breakeven") }));
    raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, 'modify_sl', ?, 'done', ?, ?)").run(`pm:${ticket}:s:${beBar}`, JSON.stringify({ ticket, reason: "pm_breakeven" }), JSON.stringify({ ok: true }), beAt + 1000);
    // cut_loss: its close went out 1 s before the deal, but the ack was lost (expired, no result).
    raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, why, status, lines_json) VALUES (?, ?, ?, ?, 'BUY', 'close', 'cut_loss', 'w', 'expired', ?)").run(`pm:${ticket}:${clBar}`, ticket, clBar, clAt - 500, JSON.stringify({ present: [], cause: lineTag("cut_loss") }));
    raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, 'close', ?, 'expired', NULL, ?)").run(`pm:${ticket}:c:${clBar}`, JSON.stringify({ ticket, reason: "pm_cut_loss" }), clAt);
    raw.prepare("INSERT INTO ea_deals (deal_ticket, position_ticket, side, volume, entry_price, exit_price, profit, currency, reason, closed_ms) VALUES (?, ?, 'BUY', 0.01, 2000, 1992, -0.8, 'USD', 'expert', ?)").run(ticket * 10, ticket, closeMs);
    return { env, ticket, closeMs, clBar };
  };
  const { env, ticket, closeMs, clBar } = await build();
  let r = await pmLineBreakerTick(env, { now: NOW });
  assert.deepEqual(r.counted ?? [], [], "not credited to breakeven");
  assert.equal(state(env).seen?.[String(ticket)], undefined, "the ticket is not marked seen");
  // CA1 reconciles the close from ea_deals: the intent reads done, and the next tick credits cut_loss.
  env.DB.raw.prepare("UPDATE omega_intents SET status = 'done' WHERE id = ?").run(`pm:${ticket}:c:${clBar}`);
  r = await pmLineBreakerTick(env, { now: NOW + 300_000 });
  assert.deepEqual(r.counted.map((c) => [c.line, c.ticket]), [["cut_loss", ticket]]);
  // Never reconciled: 30 minutes after the close the ticket is seen and credited to no line (breakeven unchanged), one
  // pm_line_skip event; a later tick neither credits nor logs it again.
  const late = await build();
  r = await pmLineBreakerTick(late.env, { now: late.closeMs + PM_LINE_DEFER_MS + M1 });
  assert.deepEqual(r.counted ?? [], [], "no line credited");
  assert.ok(Number(state(late.env).seen[String(late.ticket)]) > 0, "seen");
  assert.equal(state(late.env).lines.breakeven?.closes ?? 0, 0, "breakeven's count unchanged");
  assert.deepEqual(events(late.env, PM_LINE_SKIP_EVENT).map((e) => e.detail), [{ ticket: late.ticket, why: "unacked_close" }]);
  r = await pmLineBreakerTick(late.env, { now: late.closeMs + PM_LINE_DEFER_MS + 6 * M1 });
  assert.deepEqual(r.counted ?? [], []);
  assert.equal(events(late.env, PM_LINE_SKIP_EVENT).length, 1, "logged once per ticket");
  assert.ok(!PM_LINE_EVENTS.includes(PM_LINE_SKIP_EVENT), "not an off-set event for v4");
});

test("B5-5 r_vs_hold: R minus holding to the plan's SL/TP on the broker's 1m bars (the report's first-touch rule), settled once touched or after 24 h", () => {
  const bars = [{ t: 0, h: 2005, l: 1998, c: 2004 }, { t: M1, h: 2021, l: 2003, c: 2019 }];
  assert.deepEqual(holdR({ side: "BUY", entry: 2000, sl: 1990, tp: 2020, r_dist: 10, fromMs: 0, bars, now: 2 * M1, heldExit: heldExitPrice }), { r: 2, final: true });
  assert.deepEqual(holdR({ side: "BUY", entry: 2000, sl: 1990, tp: 2030, r_dist: 10, fromMs: 0, bars, now: 2 * M1, heldExit: heldExitPrice }), { r: null, final: false }, "neither touched yet: open");
  assert.deepEqual(holdR({ side: "BUY", entry: 2000, sl: 1990, tp: 2030, r_dist: 10, fromMs: 0, bars, now: 25 * 3600_000, heldExit: heldExitPrice }), { r: 1.9, final: true }, "past the horizon: the last close");
  // heldExitPrice is the daily report's rule unchanged (positionReport reads it).
  const rep = positionReport([{ ticket: 1, side: "SELL", action: "close", rule: "take_profit_weakening", status: "applied", at_ms: 1000, pips: 35, price: 3876.5, orig_sl: 3890, orig_tp: 3870, basis: 0 }], [{ open_time: 2000, high: 3885, low: 3875, close: 3884 }, { open_time: 3000, high: 3891, low: 3884, close: 3890 }], { now: 10_000 });
  assert.deepEqual([rep.items[0].held_pips, rep.items[0].saved_pips], [-100, 135]);
  // In the lines view: the mean of R minus the hold R over settled holds.
  const doc = normalizeDoc({ lines: { breakeven: { version: 1, since_ms: 0, off_since: null, closes: 2, last: [{ r: 0.5, r_hold: 2, hold_final: true }, { r: -0.1, r_hold: null, hold_final: false }] } } }).doc;
  const be = pmLinesView(doc).find((l) => l.id === "breakeven");
  assert.deepEqual([be.closes, be.mean_r_last15, be.r_vs_hold], [2, 0.2, -1.5]);
});

// ---- the skip, in the Position Manager and PM-1M

const sym = (bid) => ({ bid, ask: Math.round((bid + 0.2) * 100) / 100, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0 });
const decision = (over = {}) => ({ stance: "SELL", quorum: { long_share: 0.05, short_share: 0.9 }, quorum_prev: { long_share: 0.05, short_share: 0.9 },
  agent_confidence: { zone_pullback: { long: 0.3, short: 0.8 } }, agent_confidence_prev: { zone_pullback: { long: 0.3, short: 0.8 } }, ...over });
const SELL = { ticket: 101, side: "SELL", open_price: 3880, sl: 3890, tp: 3870, volume: 0.01, intent_id: "open:1:S", magic: 920200, source: "omega" };
const intent = { tp: 3870, sl: 3890, entry: 3880, strategy: "zone_pullback", mode: "intraday", r_dist: 10 };
const levels = [{ low: 3850, high: 3852 }, { low: 3860, high: 3862 }];
const facts = (bid, dec = decision(), over = {}) => positionFacts({ position: { ...SELL, ...over }, sym: sym(bid), openIntent: intent, levels, decision: dec, ...over.extra });
const WEAK = { momentum: "weakening", thesis: "broken", reason: "r" }, HOLDING = { momentum: "holding", thesis: "intact", reason: "r" };

test("B5-6 an off line is skipped exactly as if its rule did not fire", () => {
  // cut_loss off: the cut does not fire, the position holds to its stop.
  const loss = facts(3886, decision({ stance: "BUY" }));
  assert.deepEqual([positionAction(loss, WEAK).action, positionAction(loss, WEAK).rule], ["close", "cut_loss"]);
  const held = positionAction(loss, WEAK, { off: ["cut_loss"] });
  assert.deepEqual([held.action, held.rule], ["hold", "hold_to_stop"]);
  assert.match(held.why, /the cut_loss line is off/);
  // take_profit_weakening off beyond TP1: the TP1 lock (the rule below it) runs instead.
  const beyond = facts(3866.8);
  assert.equal(positionAction(beyond, WEAK).rule, "take_profit_weakening");
  const lock = positionAction(beyond, WEAK, { off: ["take_profit_weakening"] });
  assert.deepEqual([lock.action, lock.rule, lock.sl], ["sl", "lock_tp1", 3870]);
  // lock_tp1 off too: the band's rules below run (the break-even).
  assert.equal(positionAction(beyond, HOLDING, { off: ["lock_tp1"] }).rule, "breakeven");
  // breakeven off at the band: no lock; with tp2_target off too, the stop and target stay.
  const band = facts(3874);
  assert.equal(positionAction(band, HOLDING).rule, "breakeven");
  assert.equal(positionAction(band, HOLDING, { off: ["breakeven"] }).rule, "tp2_target");
  assert.equal(positionAction(band, HOLDING, { off: ["breakeven", "tp2_target"] }).action, "hold");
  // liquidity off: lens B's reading reads as absent (a cut on the sweep alone does not fire).
  const sweep = { liquidity_on: true, liquidity_sweep: "sell_side", liquidity_sweep_age_min: 5, liquidity_weight: 0.5 };
  const lf = positionFacts({ position: SELL, sym: sym(3886), openIntent: intent, levels, decision: decision(), signal: sweep });
  assert.equal(lf.liquidity.sweep, "against");
  assert.equal(positionAction(lf, WEAK).rule, "cut_loss");
  assert.deepEqual(pmLinesJson(lf, WEAK, positionAction(lf, WEAK)).cause, "liquidity@1", "the sweep alone set the cut: the cause is lens B's line");
  assert.equal(positionAction(lf, WEAK, { off: ["liquidity"] }).rule, "hold_to_stop");
  assert.deepEqual(pmLinesJson(loss, WEAK, positionAction(loss, WEAK)), { present: PM_LINE_IDS.filter((id) => !PM_FAST_LINE_IDS.includes(id) && id !== "liquidity" && !/^(loosen_|tp_nearer_|tp_further_)/.test(id)).map(lineTag).sort(), cause: "cut_loss@1" });
  assert.equal(pmLinesJson(loss, WEAK, positionAction(loss, WEAK), { off: ["cut_loss"] }).present.includes("cut_loss@1"), false, "off lines are never present");
  // PM-1M: pm_fast_tp off falls to the cut check (none here); pm_fast_cut off: none.
  const cases = Object.fromEntries(fastCases());
  assert.equal(fastProtect(cases["tp/legacy_lock"]).rule, "pm_fast_tp");
  assert.deepEqual(fastProtect({ ...cases["tp/legacy_lock"], off: ["pm_fast_tp"] }), { status: "none" });
  assert.equal(fastProtect(cases["cut/tighten"]).rule, "pm_fast_cut");
  assert.deepEqual(fastProtect({ ...cases["cut/tighten"], off: ["pm_fast_cut"] }), { status: "none" });
  assert.equal(fastProtect({ ...cases["cut/tighten"], off: ["pm_fast_tp", "cut_loss"] }).rule, "pm_fast_cut", "the fast layer skips only its own rules");
});

test("B5-7 no line off: every Position Manager and PM-1M output is byte for byte main's (the V14 fingerprint holds; off [] is the call without it)", () => {
  const h = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  const COUNCILS = [null, HOLDING, { momentum: "strengthening", thesis: "intact", reason: "r" }, { momentum: "holding", thesis: "weakening", reason: "r" }, { momentum: "weakening", thesis: "weakening", reason: "r" }, WEAK];
  const fc = factCases();
  const a = fc.flatMap(([, f]) => COUNCILS.map((c) => positionAction(f, c)));
  const b = fc.flatMap(([, f]) => COUNCILS.map((c) => positionAction(f, c, { off: [] })));
  assert.equal(h(b), h(a));
  const fa = fastCases().map(([, i]) => fastProtect(i)), fb = fastCases().map(([, i]) => fastProtect({ ...i, off: [] }));
  assert.equal(h(fb), h(fa));
  assert.equal(createHash("sha256").update(engineBehaviourSource()).digest("hex"), ENGINE_BEHAVIOUR_HASH, "V14: ecfe3f90… unmoved");
});

test("B5-8 the runner: lines_json on each record, PM_LINES_OFF skips the lines it names, and the breaker's off line too", async () => {
  const run = async (envOver = {}, lines = undefined) => {
    const env = { ...world(), ...envOver };
    // CH1's stance token off (one decision against is a reason), as test/position-manager.test.mjs PM5 does.
    env.DB.raw.exec("CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT)");
    env.DB.raw.prepare("INSERT INTO omega_settings VALUES (1, ?)").run(JSON.stringify({ change_thresholds: "off" }));
    const call = async () => ({ status: "answered", obj: WEAK });
    const r = await runPositionManager(env, { now: NOW, call, executor: { positions: [SELL], symbol: sym(3886) }, openIntents: { "open:1:S": intent }, signal: null, decision: decision({ stance: "BUY" }), gates: { 101: { open: true } }, ...(lines !== undefined ? { lines } : {}) });
    return { r, row: env.DB.raw.prepare("SELECT rule, action, status, lines_json FROM position_actions").get(), env };
  };
  const base = await run({ PM_LINES_OFF: undefined });
  assert.deepEqual([base.row.action, base.row.rule, base.row.status], ["close", "cut_loss", "pending"]);
  assert.equal(JSON.parse(base.row.lines_json).cause, "cut_loss@1");
  const off = await run({ PM_LINES_OFF: "cut_loss, pm_fast_tp" });
  assert.deepEqual([off.row.action, off.row.rule, off.row.status], ["hold", "hold_to_stop", "noted"]);
  assert.equal(JSON.parse(off.row.lines_json).cause, null);
  assert.ok(!JSON.parse(off.row.lines_json).present.includes("cut_loss@1"));
  assert.deepEqual(pmLinesOffEnv({ PM_LINES_OFF: "CUT_LOSS pm_fast_tp,bogus" }), ["cut_loss", "pm_fast_tp"]);
  // The breaker's state in KV holds a line off the same way.
  const env = world();
  await env.SIGNAL_CACHE.put(PM_LINE_BREAKER_KEY, JSON.stringify({ lines: { cut_loss: { version: 1, since_ms: 0, off_since: NOW - 1000, closes: 15, last: [] } } }));
  assert.deepEqual((await readPmLinesLive(env, { now: NOW })).off, ["cut_loss"]);
  await env.SIGNAL_CACHE.put(PM_LINE_BREAKER_KEY, JSON.stringify({ lines: {} }));
  assert.deepEqual((await readPmLinesLive({ ...env, PM_LINES_OFF: "pm_fast_cut" }, { now: NOW + 1 })).off, ["cut_loss", "pm_fast_cut"], "the KV part is read at most once a minute; the env part every call");
  assert.deepEqual((await readPmLinesLive(env, { now: NOW + 61_000 })).off, [], "a minute later the KV again");
});

test("B5-9 PM-1M's records carry lines_json; an off fast line writes no record", async () => {
  const go = async (lines) => {
    resetPositionSchemaCacheForTests(); resetLiquiditySchemaForTests();
    const env = world();
    const b = tpBuyBars(), now = nowAfter(b);
    const exec = { account_ref: "acct_00000000000000aa", server: "AnyBroker-Demo", symbol: { ...SYM, name: "XAUUSD", bid: 2013.2, ask: 2013.4 }, positions: [tpBuy] };
    const { ensureLiquiditySchema } = await import("../src/liquidity-lens.mjs");
    await ensureLiquiditySchema(env.DB);
    const ins = env.DB.raw.prepare("INSERT INTO broker_bars_1m (account_ref, source, minute_ms, o, h, l, c, tick_volume, spread_points, digits, connection_version, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?, 2, 90, ?)");
    for (const x of b) ins.run(exec.account_ref, corpusSource(exec.server, "XAUUSD"), x.t, x.o, x.h, x.l, x.c, x.s, x.t + M1 + 1500);
    await runFastProtect(env, { executor: exec, openIntents: { [tpBuy.intent_id]: { entry: 2000, sl: 1990, tp: tpBuyMeta.tp1, r_dist: 10, mode: "intraday" } }, now, lines });
    return env.DB.raw.prepare("SELECT rule, status, lines_json FROM position_actions").all();
  };
  const on = await go({ off: [] });
  assert.deepEqual(on.map((r) => [r.rule, r.status, JSON.parse(r.lines_json)]), [["pm_fast_tp", "pending", { present: ["pm_fast_cut@1", "pm_fast_tp@1"], cause: "pm_fast_tp@1" }]]);
  assert.deepEqual(await go({ off: ["pm_fast_tp"] }), []);
});

test("B5-10 the lines on GET /api/omega/position-manager: exactly { id, version, enabled, off_since, closes, mean_r_last15, r_vs_hold }", async () => {
  const env = { ...world(), PM_LINES_OFF: "pm_fast_cut" };
  for (let i = 1; i <= 15; i++) await closedBy(env, { ticket: 3000 + i, at: NOW - (20 - i) * 3600_000 });
  await pmLineBreakerTick(env, { now: NOW });
  const body = await readPositionManager(env, { now: NOW });
  assert.equal(body.lines.length, PM_LINES.length);
  for (const l of body.lines) {
    assert.deepEqual(Object.keys(l), ["id", "version", "enabled", "off_since", "closes", "mean_r_last15", "r_vs_hold"]);
    assert.equal(typeof l.id, "string"); assert.ok(Number.isInteger(l.version)); assert.equal(typeof l.enabled, "boolean"); assert.ok(Number.isInteger(l.closes));
    assert.ok(l.off_since === null || Number.isFinite(l.off_since)); assert.ok(l.mean_r_last15 === null || Number.isFinite(l.mean_r_last15)); assert.ok(l.r_vs_hold === null || Number.isFinite(l.r_vs_hold));
  }
  const by = Object.fromEntries(body.lines.map((l) => [l.id, l]));
  assert.deepEqual(by.cut_loss, { id: "cut_loss", version: 1, enabled: false, off_since: NOW, closes: 15, mean_r_last15: -0.1, r_vs_hold: null });
  assert.deepEqual(by.pm_fast_cut, { id: "pm_fast_cut", version: 1, enabled: false, off_since: null, closes: 0, mean_r_last15: null, r_vs_hold: null }, "off by PM_LINES_OFF");
  assert.deepEqual(by.breakeven, { id: "breakeven", version: 1, enabled: true, off_since: null, closes: 0, mean_r_last15: null, r_vs_hold: null });
  assert.equal(body.version, "cryptophys.position-manager.v1");
  assert.ok(Array.isArray(body.rows));
});

test("B5-11 the schema step run twice is a no-op (ALTER TABLE ... ADD COLUMN lines_json in try/catch)", async () => {
  resetPositionSchemaCacheForTests();
  const db = d1();
  await ensurePositionSchema(db);
  db.raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, status, lines_json) VALUES ('pm:1:1', 1, 1, 1, 'BUY', 'close', 'cut_loss', 'applied', '{}')").run();
  const cols = () => db.raw.prepare("SELECT name FROM pragma_table_info('position_actions')").all().map((r) => r.name);
  const before = cols();
  resetPositionSchemaCacheForTests();
  await ensurePositionSchema(db);
  resetPositionSchemaCacheForTests();
  await ensurePositionSchema(db);
  assert.deepEqual(cols(), before);
  assert.equal(before.filter((c) => c === "lines_json").length, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM position_actions").get().n, 1, "the rows stay");
});

test("B5-12 a version bump turns a line back on and resets its window; so does the owner (setPmLine), and only to on", async () => {
  const env = world();
  await env.SIGNAL_CACHE.put(PM_LINE_BREAKER_KEY, JSON.stringify({ lines: { cut_loss: { version: 0, since_ms: 0, off_since: NOW - 86_400_000, closes: 15, last: Array.from({ length: 15 }, () => ({ r: -0.2 })) } } }));
  const n = normalizeDoc(JSON.parse(env.SIGNAL_CACHE.m.get(PM_LINE_BREAKER_KEY)), { now: NOW });
  assert.deepEqual(n.bumped, ["cut_loss"]);
  assert.deepEqual(n.doc.lines.cut_loss, { version: 1, since_ms: NOW, off_since: null, trip_mean_r: null, closes: 0, last: [] });
  const r = await pmLineBreakerTick(env, { now: NOW });
  assert.deepEqual(r.bumped, ["cut_loss"]);
  assert.deepEqual(events(env, "pm_line_on").map((e) => e.detail), [{ line: "cut_loss", version: 1, by: "version", off: [] }]);
  // An action of the old window (before the bump) never counts in the new one.
  await closedBy(env, { ticket: 4001, at: NOW - 3600_000 });
  assert.deepEqual((await pmLineBreakerTick(env, { now: NOW + 300_000 })).counted, []);
  // The owner: on is the only action; an unknown line and a line PM_LINES_OFF names are refused.
  const e2 = world(), sent = [];
  await e2.SIGNAL_CACHE.put(PM_LINE_BREAKER_KEY, JSON.stringify({ lines: { breakeven: { version: 1, since_ms: 0, off_since: NOW - 1000, trip_mean_r: -0.3, closes: 22, last: [{ r: -0.3 }] } } }));
  assert.deepEqual(await setPmLine(e2, { line: "breakeven", enabled: false }), { ok: false, error: "enabled must be true (turning a line on is the only action)" });
  assert.deepEqual(await setPmLine(e2, { line: "nope", enabled: true }), { ok: false, error: "unknown_line" });
  assert.deepEqual(await setPmLine({ ...e2, PM_LINES_OFF: "breakeven" }, { line: "breakeven", enabled: true }), { ok: false, error: "off_by_PM_LINES_OFF" });
  assert.deepEqual(await setPmLine(e2, { line: "breakeven", enabled: true, actor: "owner", send: async (t) => sent.push(t) }, { now: NOW }), { ok: true });
  assert.deepEqual(state(e2).lines.breakeven, { version: 1, since_ms: NOW, off_since: null, trip_mean_r: null, closes: 0, last: [] });
  assert.deepEqual(events(e2, "pm_line_on").map((e) => [e.actor, e.detail]), [["owner", { line: "breakeven", version: 1, by: "owner", was_off: true, off: [] }]]);
  assert.match(sent[0], /line breakeven@1 on \(owner\)/);
  clearPmLineMemo();
  assert.deepEqual((await readPmLinesLive(e2, { now: NOW })).off, []);
});

test("B5-13 POST /api/pm-lines on the Omega Worker: owner only, same origin, JSON; { line, enabled: true }; unknown line and enabled:false refused; in the 405 list", async () => {
  resetKeyCacheForTests();
  const TEAM = "cryptophys.cloudflareaccess.com", AUD = "a".repeat(64), T = 1_794_220_000;
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const enc = (o) => b64(new TextEncoder().encode(JSON.stringify(o)));
  const jwt = async (claims) => { const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: T + 600, ...claims }); const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)); return `${head}.${body}.${b64(new Uint8Array(sig))}`; };
  const opts = { fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] })), now: T };
  const calls = [];
  const O = { overview: async () => ({}), setPmLine: async (i) => { calls.push(i); return { ok: true }; } };
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O, OWNER_ACCESS_SUB: "owner-sub-0001" };
  const owner = await jwt({ email: "owner@example.com", sub: "owner-sub-0001" }), guest = await jwt({ email: "guest@example.com", sub: "guest-sub" });
  const req = (token, body, { method = "POST", origin = "https://omega.cryptophys.work" } = {}) => new Request("https://omega.cryptophys.work/api/pm-lines", { method, body: body == null ? undefined : JSON.stringify(body), headers: { "cf-access-jwt-assertion": token, ...(origin ? { origin } : {}), ...(body != null ? { "content-type": "application/json" } : {}) } });
  const res = await handle(req(owner, { line: "cut_loss", enabled: true }), env, opts);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(calls, [{ line: "cut_loss", enabled: true, actor: "owner@example.com" }]);
  assert.equal((await handle(req(guest, { line: "cut_loss", enabled: true }), env, opts)).status, 403, "a non-owner");
  assert.equal((await handle(req(owner, { line: "cut_loss", enabled: true }), { ...env, OWNER_ACCESS_SUB: "" }, opts)).status, 403, "no owner configured: nobody");
  assert.equal((await handle(req(owner, { line: "cut_loss", enabled: true }, { origin: "https://evil.example" }), env, opts)).status, 403, "cross origin");
  const unknown = await handle(req(owner, { line: "nope", enabled: true }), env, opts);
  assert.deepEqual([unknown.status, await unknown.json()], [400, { ok: false, error: "unknown_line" }]);
  const offReq = await handle(req(owner, { line: "cut_loss", enabled: false }), env, opts);
  assert.deepEqual([offReq.status, (await offReq.json()).ok], [400, false], "turning a line off is not an action");
  assert.equal((await handle(req(owner, { line: "cut_loss" }), env, opts)).status, 400);
  assert.equal(calls.length, 1, "nothing refused reached the AI Worker");
  assert.equal((await handle(req(owner, null, { method: "GET" }), env, opts)).status, 405);
  assert.equal((await handle(req(owner, null, { method: "DELETE" }), env, opts)).status, 405);
});

test("B5-14 v4: the off set in force at each minute from the omega_events history; none: the replay as before", async () => {
  const hist = [{ at_ms: 100, off: ["cut_loss"] }, { at_ms: 200, off: ["cut_loss", "pm_fast_tp"] }, { at_ms: 300, off: [] }];
  assert.deepEqual([linesOffAt(hist, 50), linesOffAt(hist, 100), linesOffAt(hist, 250), linesOffAt(hist, 400), linesOffAt(null, 5)], [[], ["cut_loss"], ["cut_loss", "pm_fast_tp"], [], []]);
  // Every change of the set is an event with the whole set: the trip, the owner's turn-on, the bump, PM_LINES_OFF.
  const env = { ...world(), PM_LINES_OFF: "pm_fast_cut" };
  for (let i = 1; i <= 15; i++) await closedBy(env, { ticket: 5000 + i, at: NOW - (20 - i) * 3600_000 });
  await pmLineBreakerTick(env, { now: NOW });
  await setPmLine(env, { line: "cut_loss", enabled: true, actor: "owner" }, { now: NOW + 60_000 });
  const h = await readPmLineHistory(env.DB);
  assert.deepEqual(h, [{ at_ms: NOW, off: ["pm_fast_cut"] }, { at_ms: NOW, off: ["cut_loss", "pm_fast_cut"] }, { at_ms: NOW + 60_000, off: ["pm_fast_cut"] }]);
  assert.deepEqual(offLinesOf(state(env), ["pm_fast_cut"]), ["pm_fast_cut"]);
  // The replay with no history is today's byte for byte, and an empty history is no history.
  const sc = replayScenarios()[0].opts;
  const plain = replayOmega4(sc);
  assert.equal(JSON.stringify(replayOmega4({ ...sc, pmLines: { history: [] } }).records), JSON.stringify(plain.records));
  assert.equal(JSON.stringify(replayOmega4({ ...sc, pmLines: { history: [{ at_ms: 0, off: [] }] } }).records), JSON.stringify(plain.records), "nothing off: as before");
  // A line off from the start: v4 replays none of its actions (the Position Manager's cut_loss, the 1m layer's own).
  const pmRules = (run) => Object.values(run.records).flatMap((r) => JSON.parse(r.omega4_json).pm ?? []).map((x) => x.rule);
  const cut = v4ReplayScenarios().find((x) => x.name === "cut_loss").opts;
  const r0 = Object.values(replayOmega4(cut).records)[0];
  assert.deepEqual([r0.omega4_exit, JSON.parse(r0.omega4_json).pm.map((x) => x.rule)], ["stop", ["pm_fast_cut"]], "the 1m layer tightens the stop first");
  // pm_fast_cut off: as if it did not fire, so the 5-minute cut_loss closes it (as with the layer off, test V5).
  const r1 = Object.values(replayOmega4({ ...cut, pmLines: { history: [{ at_ms: 0, off: ["pm_fast_cut"] }] } }).records)[0];
  assert.deepEqual([r1.omega4_exit, JSON.parse(r1.omega4_json).pm.map((x) => x.rule)], ["pm_cut_loss", ["cut_loss"]]);
  // Both off: neither acts; the position holds to its stop.
  const r2 = Object.values(replayOmega4({ ...cut, pmLines: { history: [{ at_ms: 0, off: ["pm_fast_cut", "cut_loss"] }] } }).records)[0];
  assert.deepEqual(JSON.parse(r2.omega4_json).pm, []);
  assert.equal(JSON.stringify(replayOmega4({ ...cut, pmLines: { history: [{ at_ms: 0, off: ["tp2_target"] }] } }).records), JSON.stringify(replayOmega4(cut).records), "another line off: the same replay");
  for (const { opts } of fastReplayScenarios()) {
    const before = pmRules(replayOmega4(opts)).filter((r) => PM_FAST_LINE_IDS.includes(r));
    assert.ok(before.length > 0);
    assert.deepEqual(pmRules(replayOmega4({ ...opts, pmLines: { history: [{ at_ms: 0, off: [...PM_FAST_LINE_IDS] }] } })).filter((r) => PM_FAST_LINE_IDS.includes(r)), []);
  }
});
