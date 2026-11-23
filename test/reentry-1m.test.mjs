// RE1, a 1m re-entry after a profit-lock stop (owner 2026-11-23: "Live: gerbang + re-entry (Rekomendasi)";
// src/reentry-1m.mjs). The eligibility of exits, every guard, the trigger, the stop and target, the per-setup caps, the
// opening checks of planIntents, no re-entry after a cut loss or in a quarantine, the live step on Omega's sync, v4's
// replay, the switch and off byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { reentryCheck, reentrySetup, reentryOn, reentryId, isReentryId, isEntryIntentId, isLockRule, reentryMessage, runReentry, REENTRY_1M, REENTRY_MODES, REENTRY_RULE } from "../src/reentry-1m.mjs";
import { OMEGA_DEFAULTS, settingsFrom, planIntents, isOmegaOwned, PLATFORM_MAX_OPEN } from "../src/omega-engine.mjs";
import { replayOmega4, eraSwitches, ERA_SWITCHES, ENGINE_BEHAVIOUR_HASH, sha256Hex, omegaParity, liveTradesFrom } from "../src/ledger-omega4.mjs";
import { TP1_MIN_R } from "../src/strategy-engine.mjs";
import { resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { bridgeSync, writeSettings, readSettings, resetOmegaBrokerSchemaForTests, applyOmegaPolicy, OMEGA_POLICY_KEY } from "../src/omega-broker.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { resetLiquiditySchemaForTests } from "../src/liquidity-lens.mjs";
import { corpusSource } from "../src/corpus-oracle.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { v4ReplayScenarios, key, C, M1 } from "./fixtures/omega-v4-replay.mjs";
import {
  T0, SYM, EXIT_I, sellBars, buyBars, sellSetup, buySetup, SELL_SIGNAL, BUY_SIGNAL, nowAfter, checkCases, setupCases, planCases, reentryReplayScenarios, P_TRIGGER, P_SIGNAL
} from "./fixtures/reentry-1m.mjs";

const BEFORE_RE1_HASH = "d0def5bb1a982e391d9491ff1e7a8e13289f700db5e8a0490c2f8ffccff55120";
const check = (name, over = {}) => reentryCheck({ ...checkCases().find(([n]) => n === name)[1], ...over });
const plan = (name) => planIntents(planCases().find(([n]) => n === name)[1]);
const opened = (out) => out.intents.filter((it) => it.kind === "open" && isReentryId(it.id));
const lastNote = (out) => out.notes.at(-1)?.code ?? null;

test("R1. one table; the switch is the Omega setting reentry_1m, on by default, in ERA_SWITCHES; the ids", () => {
  assert.deepEqual(
    [REENTRY_1M.min_bars, REENTRY_1M.window_min, REENTRY_1M.stop_spread_k, REENTRY_1M.stop_atr_k, REENTRY_1M.min_r, REENTRY_1M.max_spread_points, REENTRY_1M.spread_median_k, REENTRY_1M.median_min, REENTRY_1M.reopen_min, REENTRY_1M.per_setup, REENTRY_1M.loss_cap_r],
    [5, 240, 2, 0.1, 1, 60, 2, 60, 15, 1, 1.0], "the brief's numbers");
  assert.equal(REENTRY_1M.min_r, TP1_MIN_R, "TP1-KZ's floor");
  assert.equal(REENTRY_RULE, "pm_reentry");
  assert.deepEqual([...REENTRY_MODES], ["on", "off"]);
  assert.equal(OMEGA_DEFAULTS.reentry_1m, "on");
  assert.equal(reentryOn(OMEGA_DEFAULTS), true);
  assert.equal(reentryOn({}), true, "absent reads as the default");
  assert.equal(reentryOn({ reentry_1m: "off" }), false);
  assert.equal(reentryOn.length, 1, "no environment override");
  assert.ok(ERA_SWITCHES.includes("reentry_1m"));
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, reentry_1m: "off" }), ["reentry_1m=off"]);
  assert.equal(settingsFrom({ reentry_1m: "off" }).settings.reentry_1m, "off");
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, reentry_1m: "off" }).settings.reentry_1m, "off", "carried through another change");
  for (const bad of ["legacy", true, 1, ""]) assert.match(settingsFrom({ reentry_1m: bad }).error, /reentry_1m must be 'on' or 'off'/, String(bad));
  // Ids: re:<the original's ticket>:<the trigger bar's minute>, within the intent id's 31 characters with a 10-digit ticket.
  assert.equal(reentryId(202, T0), `re:202:${T0 / M1}`);
  assert.ok(reentryId(9_999_999_999, T0).length + 2 <= 31);
  for (const id of ["re:202:29900000", "re:202:29900000:2"]) assert.equal(isReentryId(id), true, id);
  for (const id of ["re:x:1", "pm1:202:1", "open:1:S", "d:re:1:1", null]) assert.equal(isReentryId(id), false, String(id));
  assert.equal(isEntryIntentId("open:1:S"), true);
  assert.equal(isEntryIntentId("re:202:29900000"), true);
  assert.equal(isEntryIntentId("deleg:202"), false);
  assert.equal(isOmegaOwned({ intent_id: "re:202:29900000", source: "external", magic: 1 }), true, "a re-entry is Omega's own position");
});

test("R2. eligible: only exits by a profit-lock stop (break-even or a lock); never the initial stop, a stop in loss, a cut loss or a weakening close", () => {
  const out = Object.fromEntries(setupCases().map(([n, i]) => [n, reentrySetup(i)]));
  for (const n of ["pm_breakeven", "break_even", "ladder_lock_tp0", "ladder_lock_tp1", "sl_key_level", "pm_fast_tp"]) assert.equal(out[n].eligible, true, n);
  for (const [n, code] of [["initial_stop", "not_lock"], ["trail_in_profit", "not_lock"], ["fast_cut", "not_lock"], ["lock_rule_in_loss", "not_lock"], ["cut_loss", "not_stop"], ["take_profit_weakening", "not_stop"], ["own_reentry", "not_original"], ["delegated", "not_original"], ["no_plan", "no_plan"]]) {
    assert.deepEqual([out[n].eligible, out[n].code], [false, code], n);
  }
  const s = out.pm_breakeven.setup;
  assert.deepEqual([s.lock, s.lock_rule, s.orig_sl, s.tp1, s.r_dist, s.risk_money, s.mode, s.strategy], [1999.5, "pm_breakeven", 2010, 1980, 10, 50, "intraday", "zone_pullback"]);
  for (const r of ["break_even", "ladder_lock_tp0", "ladder_lock_tp3", "sl_key_level_strong", "pm_breakeven", "pm_tp2_breakeven", "pm_lock_tp1", "pm_fast_tp"]) assert.equal(isLockRule(r), true, r);
  for (const r of ["trail_5m", "pm_fast_cut", "pm_loosen_atr", "pm_cut_loss", "pm_take_profit_weakening", "opposite", null]) assert.equal(isLockRule(r), false, String(r));
});

test("R3. valid while all hold: the latest decision on the same side, the original stop untouched, TP1 not reached, within 240 minutes of the plan, once per setup", () => {
  const codes = (n) => { const r = check(n); return [r.status, r.code]; };
  assert.deepEqual(codes("trigger"), ["trigger", "trigger"]);
  assert.deepEqual(codes("no_setup"), ["none", "no_setup"]);
  assert.deepEqual(codes("window"), ["invalid", "window"]);
  assert.deepEqual(codes("used"), ["invalid", "used"]);
  assert.deepEqual(codes("superseded"), ["invalid", "superseded"]);
  assert.deepEqual(codes("decision_wait"), ["invalid", "decision_side"]);
  assert.deepEqual(codes("decision_other_side"), ["invalid", "decision_side"]);
  assert.deepEqual(codes("stop_touched"), ["invalid", "stop_touched"]);
  assert.deepEqual(codes("tp1_reached"), ["invalid", "tp1_reached"]);
  // The window's edge: 240 minutes after the plan's issue still holds, a minute later it does not.
  const go = checkCases().find(([n]) => n === "trigger")[1];
  assert.equal(reentryCheck({ ...go, setup: sellSetup({ issued_ms: go.now - 240 * M1 }) }).status, "trigger");
  assert.equal(reentryCheck({ ...go, setup: sellSetup({ issued_ms: go.now - 240 * M1 - 1 }) }).code, "window");
});

test("R4. the trigger: a closed 1m bar closes back beyond the lock, at least 5 bars after the exit (both sides)", () => {
  assert.deepEqual([check("too_soon").status, check("too_soon").code], ["wait", "too_soon"]);
  assert.deepEqual([check("no_trigger").status, check("no_trigger").code], ["wait", "no_trigger"]);
  const t = check("trigger");
  assert.equal(t.bar_ms, T0 + (EXIT_I + 5) * M1, "the fifth bar after the exit's");
  assert.equal(t.id, reentryId(202, T0 + (EXIT_I + 5) * M1));
  assert.match(t.why, /closed at 1999\.2 \(its ask\), back beyond the pm_breakeven stop 1999\.5 5 bars after the exit/);
  const b = check("trigger_buy");
  assert.deepEqual([b.status, b.side, b.tp], ["trigger", "BUY", 2020]);
  assert.match(b.why, /\(its bid\)/);
  // A close at the lock itself is not beyond it.
  const at = sellBars([1999.0, 1999.3]);
  assert.equal(reentryCheck({ setup: sellSetup(), signal: SELL_SIGNAL, bars: at, now: nowAfter(at), sym: SYM }).code, "no_trigger");
});

test("R5. the stop at the pullback's extreme plus max(2 spreads, 0.1 x ATR1m), skipped when wider than the original; the target the original TP1 at >= 1R, else skipped", () => {
  const t = check("trigger");
  // The SELL's pullback high on its ask (2000.6 + the 0.3 wick + the 0.2 spread), plus max(0.4, 0.1 x ATR1m).
  assert.equal(t.extreme, 2001.1);
  assert.ok(0.1 * t.atr < 0.4);
  assert.deepEqual([t.sl, t.tp, t.entry], [2001.5, 1980, 1999]);
  // With a wide ATR the ATR term wins.
  const wide = sellBars().map((x, i) => (i >= 20 && i < EXIT_I ? { ...x, h: x.h + 3, l: x.l - 3 } : x));
  const tw = reentryCheck({ setup: sellSetup(), signal: SELL_SIGNAL, bars: wide, now: nowAfter(wide), sym: SYM });
  assert.equal(tw.status, "trigger");
  assert.equal(tw.sl, Math.round((2001.1 + 0.1 * tw.atr) * 100) / 100);
  assert.deepEqual([check("stop_wide").status, check("stop_wide").code], ["skip", "stop_wide"]);
  assert.deepEqual([check("reward").status, check("reward").code], ["skip", "reward"]);
  // planIntents checks both again at the live price.
  assert.equal(lastNote(plan("stop_wide_live")), "reentry_stop_wide");
  assert.equal(lastNote(plan("reward_live")), "reentry_reward");
  assert.equal(lastNote(plan("stops_level")), "reentry_stops_level");
});

test("R6. risk: at most min(the profile's cap, the original's money risk); the setup's total loss within 1.0R; the opening checks of every entry", () => {
  const o = plan("open");
  const [it] = opened(o);
  assert.deepEqual([it.id, it.kind, it.side, it.volume, it.entry, it.sl, it.tp, it.reason, it.stop_source, it.reentry_of, it.reentry_lock, it.reentry_rule, it.mode, it.strategy, it.signal_issued_ms],
    [P_TRIGGER.id, "open", "SELL", 0.2, 1999, 2001.5, 1980, "pm_reentry", "reentry_1m", 202, 1999.5, "pm_breakeven", "intraday", "zone_pullback", P_SIGNAL.issued_ms]);
  // 0.2 lot x 2.5 x 100 = 50: the original's money risk; with risk_pct 2 the setting would size 0.8, capped at 0.2.
  const orig = opened(plan("original_cap"))[0];
  assert.equal(orig.volume, 0.2);
  assert.ok(plan("original_cap").notes.some((n) => n.code === "lot_capped_reentry"));
  // The profile's cap binds below the original's: Safe at 1% of 10,000 is 100, 0.4 lot.
  assert.equal(opened(plan("profile_cap"))[0].volume, 0.4);
  assert.equal(opened(plan("risk_capped"))[0].volume, 0.12, "30 of money risk left on the setup");
  assert.equal(lastNote(plan("risk_cap_min_lot")), "reentry_risk_cap");
  assert.equal(lastNote(plan("profile_min_lot_cap")), "reentry_risk_cap", "the minimum lot within the profile's cap still may not exceed the setup's");
  // The setup's 1.0R: a part of the original's loss is taken off its money risk; all of it leaves nothing.
  assert.equal(check("setup_loss_part").max_risk, 30);
  assert.deepEqual([check("setup_loss_cap").status, check("setup_loss_cap").code], ["skip", "setup_loss_cap"]);
  // Every opening check stands (none is bypassed): the engine, kill and pause, the arm, the tick value, the spread, the
  // rollover, the news blackout, max_positions, the platform's cap, the daily loss limit and budget, the minimum lot,
  // the spec, the same-side cooldown.
  for (const [n, code] of [["kill", "kill"], ["paused", "paused"], ["engine_off", "engine_off"], ["engine_env_off", "engine_off"], ["live_not_armed", "live_not_armed"], ["tick_value_mismatch", "tick_value_mismatch"],
    ["spread", "spread"], ["rollover", "rollover_quarantine"], ["blackout", "blackout"], ["max_positions", "max_positions"], ["platform_cap", "platform_cap"], ["daily_loss_limit", "daily_loss_limit"],
    ["daily_risk_budget", "daily_risk_budget"], ["volume_below_min", "volume_below_min"], ["spec_unvalidated", "spec_unvalidated"], ["reentry_cooldown", "reentry_cooldown"], ["already_opened", "already_opened"]]) {
    const out = plan(n);
    assert.equal(opened(out).length, 0, n);
    assert.ok(out.notes.some((x) => x.code === code), `${n}: ${JSON.stringify(out.notes)}`);
  }
  assert.equal(PLATFORM_MAX_OPEN, 3);
  assert.equal(opened(plan("platform_room")).length, 1, "two other positions: room under the platform's cap");
  // A fresh entry of the latest decision goes first; the other side's trigger is not this signal's; a limit mode re-enters at market.
  assert.deepEqual(plan("fresh_signal_first").intents.map((x) => x.id), [`open:${planCases().find(([n]) => n === "fresh_signal_first")[1].signal.issued_ms}:S`]);
  assert.equal(opened(plan("other_side")).length, 0);
  assert.equal(opened(plan("limit_mode")).length, 1);
});

test("R7. blocked: the rollover, the reopen 23:00-23:15 and the weekly reopen, the spread above 60 or twice the hour's median, the release window; no re-entry in a quarantine", () => {
  for (const [n, status, code] of [["spread", "blocked", "spread"], ["spread_spike", "blocked", "spread_spike"], ["spread_unmeasured", "blocked", "spread_unmeasured"], ["release_window", "blocked", "release_window"],
    ["rollover", "inert", "rollover"], ["reopen_daily", "inert", "reopen"], ["reopen_weekly", "inert", "reopen"], ["market_paused", "inert", "market_paused"], ["reconnect", "inert", "reconnect"], ["stale", "inert", "stale"], ["warmup", "inert", "warmup"], ["no_stream", "inert", "no_stream"]]) {
    const r = check(n);
    assert.deepEqual([r.status, r.code], [status, code], n);
  }
  assert.match(check("reopen_daily").why, /23:00-23:15 UTC/);
  // RE1's reopen window is longer than PM-1M's 5 minutes: 23:12 is held here; 23:16 is free (the teeth).
  assert.equal(check("reopen_passed").status, "trigger");
  // Minute by minute through the reopen, no trigger before 23:15.
  const go = checkCases().find(([n]) => n === "trigger")[1];
  for (let m = 0; m < 15; m++) {
    const shift = Date.parse("2026-11-24T23:00:00Z") + m * M1 - go.bars.at(-1).t;
    const bars = go.bars.map((b) => ({ ...b, t: b.t + shift }));
    const r = reentryCheck({ ...go, bars, now: nowAfter(bars), setup: { ...go.setup, exit_ms: go.setup.exit_ms + shift, issued_ms: go.setup.issued_ms + shift } });
    assert.deepEqual([r.status, r.code], ["inert", "reopen"], `23:${String(m).padStart(2, "0")}`);
  }
});

test("R8. no re-entry after a cut loss or a weakening close (reentryGate keeps them), in v4 either", () => {
  for (const n of ["cut_loss", "take_profit_weakening"]) assert.equal(reentrySetup(setupCases().find(([x]) => x === n)[1]).eligible, false, n);
  // v4's cut loss (the council's thesis broken; PM-1M off, whose 1m impulse would tighten that stop first, as V5): no
  // re-entry intent, the cut is the same-side guard's exit as before.
  const cut = v4ReplayScenarios().find((s) => s.name === "cut_loss");
  for (const fast of ["off", "on"]) {
    const trace = [];
    const run = replayOmega4({ ...cut.opts, settings: { ...cut.opts.settings, pm_fast_1m: fast }, trace });
    assert.equal(trace.some((t) => t.output.intents.some((it) => isReentryId(it.id)) || t.input.reentry1m), false, fast);
    assert.equal(Object.keys(run.records).some((k) => k.startsWith("re:")), false, fast);
    if (fast === "off") {
      assert.equal(run.records[key(C)].omega4_exit, "pm_cut_loss");
      assert.equal(run.checkpoint.reentry.side, "SELL", "reentryGate's input, unchanged");
      assert.equal(run.checkpoint.re_setup, undefined, "no re-entry setup");
    }
  }
});

test("R9. per setup: at most one re-entry; its own exit is never a setup; the setup's money within 1.0R of the original", () => {
  const [s] = reentryReplayScenarios();
  const trace = [];
  const run = replayOmega4({ ...s.opts, trace });
  const res = trace.flatMap((t) => t.output.intents.filter((it) => isReentryId(it.id)).map((it) => ({ ...it, at: t.now })));
  assert.equal(res.length, 1, JSON.stringify(res));
  const rec = run.records[`re:${key(C)}`];
  assert.ok(rec, Object.keys(run.records).join(","));
  const json = JSON.parse(rec.omega4_json);
  assert.deepEqual([json.reentry.of, json.reentry.lock_rule], [key(C), "pm_breakeven"]);
  // The re-entry risked no more than the original (both in the replay's money: price x lot x 100).
  const orig = trace.flatMap((t) => t.output.intents).find((it) => it.kind === "open" && it.id.startsWith("open:"));
  assert.ok(Math.abs(res[0].entry - res[0].sl) * res[0].volume <= Math.abs(orig.entry - orig.sl) * orig.volume + 1e-9);
  // The re-entry's own exit (a "re:" intent) leaves no setup.
  assert.equal(reentrySetup({ ...setupCases()[0][1], intentId: res[0].id }).code, "not_original");
});

// The Omega sync end to end over a sqlite D1, with Telegram captured (as test/pm-fast.test.mjs).
function d1(log = null) {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { log?.push(sql); const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { log?.push(sql); return db.prepare(sql).get(...params) ?? null; },
        async all() { log?.push(sql); return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const BARS = sellBars();
const NOW = nowAfter(BARS); // the trigger bar closed 2 s ago
const EXIT_MS = sellSetup().exit_ms;
const DEAL = { deal_ticket: 7001, position_ticket: 202, symbol: "XAUUSD", side: "SELL", volume: 0.05, entry_price: 2000, exit_price: 1999.7, profit: 1.5, commission: 0, swap: 0, reason: "sl", signal_id: "open:1:S", magic: 920200, source: "omega", opened_ms: T0 - 8 * M1, closed_ms: EXIT_MS };
const STATE = (over = {}) => ({
  connected: true, server: "AnyBroker-Demo", received_ms: NOW - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 1999.0, ask: 1999.2, spread_points: 20 },
  positions: [], deals: [DEAL], ...over
});
const SIGNAL = (now) => ({ ...P_SIGNAL, issued_ms: T0 - 10 * M1, expires_ms: T0 + 5 * M1, decided_ms: T0 - 8 * M1, market_price: 1999, server_ms: now });
async function withTelegram(fn) {
  const sent = [], orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes("api.telegram.org")) sent.push(JSON.parse(init.body).text); return new Response("{}"); };
  try { await fn(sent); } finally { globalThis.fetch = orig; }
  return sent;
}
function env(log = null) {
  resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests(); resetLiquiditySchemaForTests();
  return { DB: d1(log), SIGNAL_CACHE: (() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; })(), OMEGA_ENGINE_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };
}
const sync = (e, over = {}, now = NOW) => bridgeSync(e, { state: STATE(), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0", ...over }, { now, signal: SIGNAL(now) });
async function seedBars(e, list) {
  const ref = JSON.parse(e.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state).account_ref;
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS broker_bars_1m (account_ref TEXT NOT NULL, source TEXT NOT NULL, minute_ms INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, tick_volume INTEGER, spread_points INTEGER, digits INTEGER, connection_version INTEGER, received_ms INTEGER NOT NULL, legacy_ref INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_ref, source, minute_ms))");
  const ins = e.DB.raw.prepare("INSERT OR REPLACE INTO broker_bars_1m VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?, 2, 90, ?, 0)");
  for (const b of list) ins.run(ref, corpusSource("AnyBroker-Demo", "XAUUSD"), b.t, b.o, b.h, b.l, b.c, b.s ?? 20, b.t + M1 + 1500);
  return ref;
}
const OPEN_PAYLOAD = { id: "open:1:S", kind: "open", side: "SELL", volume: 0.05, entry: 2000, sl: 2010, tp: 1980, r_dist: 10, mode: "intraday", strategy: "zone_pullback", signal_issued_ms: T0 - 10 * M1 };
/** The original SELL: its open (ticket 202), the break-even stop Omega applied, the exit deal at that stop; the bars. */
async function ready(e, { stop = { kind: "modify_sl", ticket: 202, sl: 1999.5, tp: 1980, reason: "pm_breakeven" }, close = null, deal = DEAL } = {}) {
  await sync(e, { state: STATE({ deals: [] }) }, NOW - 30_000);
  await writeSettings(e, { body: { enabled: true }, actor: "owner" }, { now: NOW - 20_000 });
  const ins = e.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, ?, ?, 'done', ?, ?, ?)");
  ins.run("open:1:S", "open", JSON.stringify(OPEN_PAYLOAD), JSON.stringify({ ok: true, ticket: 202 }), T0 - 8 * M1, T0 - 8 * M1);
  if (stop) ins.run("pm:202:s:5", stop.kind, JSON.stringify(stop), JSON.stringify({ ok: true }), T0 + 20 * M1, T0 + 20 * M1);
  if (close) ins.run("pm:202:c:6", "close", JSON.stringify(close), JSON.stringify({ ok: true }), EXIT_MS - 1000, EXIT_MS);
  await seedBars(e, BARS);
  return { deal };
}

test("R10. the live step on Omega's sync: once per closed minute, the open intent re:<ticket>:<minute> through the plan, the pm_reentry record, one Telegram line when the broker answers", async () => {
  const e = env();
  await ready(e);
  const planning = await withTelegram(async () => { await sync(e); });
  const id = reentryId(202, T0 + (EXIT_I + 5) * M1);
  const intent = e.DB.raw.prepare("SELECT kind, payload, status FROM omega_intents WHERE id = ?").get(id);
  assert.ok(intent, JSON.stringify(e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'plan' ORDER BY id DESC LIMIT 1").get()));
  const p = JSON.parse(intent.payload);
  assert.deepEqual([intent.kind, intent.status, p.side, p.sl, p.tp, p.reason, p.reentry_of, p.reentry_rule, p.volume], ["open", "sent", "SELL", 2001.5, 1980, "pm_reentry", 202, "pm_breakeven", 0.2]);
  const row = e.DB.raw.prepare("SELECT ticket, bar, action, rule, status, sl, tp, orig_sl, orig_tp, why FROM position_actions WHERE id = ?").get(id);
  assert.deepEqual([row.ticket, row.bar, row.action, row.rule, row.status, row.sl, row.tp, row.orig_sl, row.orig_tp], [202, (T0 + (EXIT_I + 5) * M1) / M1, "open", "pm_reentry", "applied", 2001.5, 1980, 2010, 1980]);
  assert.match(row.why, /1m re-entry: the bar 09:45 UTC closed at 1999\.2 \(its ask\)/);
  assert.equal(planning.filter((t) => /RE-ENTRY|Order Executed/.test(t)).length, 0, "no re-entry line at planning (the exit's own notice is the deal's)");
  // The same minute again: evaluated once, nothing new.
  await sync(e, {}, NOW + 600);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 're:%'").get().n, 1);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions WHERE rule = 'pm_reentry'").get().n, 1);
  // The broker's answer: one line, the re-entry's (not the generic executed line); no account number.
  const pos = { ticket: 303, symbol: "XAUUSD", side: "SELL", volume: 0.2, open_price: 1999.0, sl: 2001.5, tp: 1980, intent_id: id, magic: 920200, source: "omega", opened_ms: NOW + 800 };
  const answered = await withTelegram(async () => { await sync(e, { results: [{ id, ok: true, ticket: 303, fill_price: 1999.0, executed_ms: NOW + 800 }], state: STATE({ positions: [pos] }) }, NOW + 1_000); });
  assert.equal(answered.length, 1, answered.join("\n---\n"));
  assert.equal(answered[0], "XAUUSD RE-ENTRY · #202 SELL · re-entered 0.2 lot at 1999 (#303), stop 2001.5, target 1980 (TP1), after the pm breakeven stop at 1999.5 · applied at the broker");
  assert.doesNotMatch(answered[0], /login|account/i);
  // The next minute with the re-entry open: the setup is used, nothing more.
  await seedBars(e, sellBars([1999.0, 1999.0, 1998.8]));
  await sync(e, { state: STATE({ positions: [pos] }) }, NOW + M1);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 're:%'").get().n, 1);
  assert.equal(reentryMessage({ ticket: 1, side: "BUY", sl: 1, tp: 2 }, { applied: false, reason: "the broker refused it (no money)" }), "XAUUSD RE-ENTRY · #1 BUY · re-entered , stop 1, target 2 (TP1) · NOT applied: the broker refused it (no money)");
});

test("R11. live: no re-entry after a cut loss, a weakening close, the initial stop or a trailed stop; a blocked trigger is noted once; the plan's refusal is recorded", async () => {
  for (const [name, opt] of [
    ["cut_loss", { stop: null, close: { kind: "close", ticket: 202, reason: "pm_cut_loss" }, deal: { ...DEAL, reason: "expert" } }],
    ["take_profit_weakening", { stop: null, close: { kind: "close", ticket: 202, reason: "pm_take_profit_weakening" }, deal: { ...DEAL, reason: "expert" } }],
    ["initial_stop", { stop: null }],
    ["trail_5m", { stop: { kind: "modify_sl", ticket: 202, sl: 1999.5, tp: 1980, reason: "trail_5m" } }]
  ]) {
    const e = env();
    const { deal } = await ready(e, opt);
    await sync(e, { state: STATE({ deals: [deal] }) });
    assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 're:%'").get().n, 0, name);
    assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions WHERE rule = 'pm_reentry'").get().n, 0, name);
  }
  // A trigger blocked by the spread: noted once per setup and reason, no intent.
  const w = env();
  await ready(w);
  await sync(w, { state: STATE({ symbol: { ...STATE().symbol, spread_points: 61, ask: 1999.61 } }) });
  await sync(w, { state: STATE({ symbol: { ...STATE().symbol, spread_points: 61, ask: 1999.61 } }) }, NOW + M1);
  const noted = w.DB.raw.prepare("SELECT status, why FROM position_actions WHERE rule = 'pm_reentry'").all();
  assert.equal(noted.length, 1, JSON.stringify(noted));
  assert.equal(noted[0].status, "noted");
  assert.match(noted[0].why, /^\[spread\] .*blocked: the spread 61 points is above 60/);
  assert.equal(w.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 're:%'").get().n, 0);
  // A trigger the plan refuses (a position already open on the account: max_positions): skipped with the plan's reason.
  const m = env();
  await ready(m);
  const other = { ticket: 909, symbol: "XAUUSD", side: "BUY", volume: 0.01, open_price: 1990, sl: 1985, tp: 2010, intent_id: null, magic: 0, source: "manual", opened_ms: NOW - 3_600_000 };
  await sync(m, { state: STATE({ positions: [other] }) });
  const sk = m.DB.raw.prepare("SELECT status, why FROM position_actions WHERE rule = 'pm_reentry'").get();
  assert.equal(sk.status, "skipped");
  assert.match(sk.why, /not entered: max_positions/);
});

test("R12. v4 replays the re-entry as live, from its 1m bars; the parity pairs a live re-entry with v4's; off is today's replay", () => {
  const [s] = reentryReplayScenarios();
  const trace = [];
  const on = replayOmega4({ ...s.opts, trace });
  const re = trace.find((t) => t.output.intents.some((it) => isReentryId(it.id)));
  assert.ok(re && re.input.reentry1m?.status === "trigger");
  const it = re.output.intents.find((x) => isReentryId(x.id));
  assert.equal(it.reason, "pm_reentry");
  const orig = on.records[key(C)], again = on.records[`re:${key(C)}`];
  assert.deepEqual([orig.omega4_exit, again.omega4_status, again.omega4_exit], ["sl_plus", "closed", "target"]);
  assert.ok(Date.parse(again.omega4_filled_at) >= Date.parse(orig.omega4_closed_at) + 5 * M1, "at least 5 bars after the exit");
  // Off: the same replay without the re-entry, byte for byte the engine before RE1.
  const t2 = [];
  const off = replayOmega4({ ...s.opts, settings: { ...s.opts.settings, reentry_1m: "off" }, trace: t2 });
  assert.equal(off.records[`re:${key(C)}`], undefined);
  assert.equal(JSON.stringify(t2.map((x) => x.output)).includes('"re:'), false);
  assert.deepEqual(off.records[key(C)], orig, "the original trade is the same either way");
  // The parity: a live trade whose open re-entered pairs with v4's "re:" row, not with the original's.
  const live = liveTradesFrom({ deals: [{ position_ticket: 1, side: "SELL", volume: 0.01, profit: 0.5, reason: "sl", entry_price: 2000, stop_loss: 1999.74, opened_ms: C + 2 * M1, closed_ms: C + 42 * M1 }, { position_ticket: 2, side: "SELL", volume: 0.02, profit: 29, reason: "tp", entry_price: 1999.5, opened_ms: C + 49 * M1, closed_ms: C + 88 * M1 }],
    opens: { 1: { entry: 2000, sl: 2005, volume: 0.01, r_dist: 5, signal_issued_ms: C, side: "SELL" }, 2: { entry: 1999.5, sl: 2001.65, volume: 0.02, r_dist: 2.15, signal_issued_ms: C, side: "SELL", reentry: true } } });
  assert.deepEqual(live.map((x) => x.reentry ?? false), [false, true]);
  const rows = Object.values(on.records);
  const par = omegaParity({ ledgerRows: rows, liveTrades: live, sinceMs: C - M1, now: C + 200 * M1 });
  assert.deepEqual(par.trades.map((x) => [x.matched, x.reentry ?? false, x.live_exit, x.v4_exit]), [[true, false, "sl_plus", "sl_plus"], [true, true, "target", "target"]]);
});

test("R13. off is byte for byte today: the sync reads no exit or stream for RE1 and writes no re-entry; the fingerprint is the engine's before RE1; Aether never writes the switch", async () => {
  const log = [];
  const e = env(log);
  await ready(e);
  await writeSettings(e, { body: { enabled: true, reentry_1m: "off" }, actor: "owner" }, { now: NOW - 10_000 });
  log.length = 0;
  await sync(e);
  assert.equal(log.some((q) => /re:%|ea_deals WHERE source = 'omega' AND account_ref|broker_bars_1m/.test(q)), false, log.filter((q) => /re:|broker_bars_1m|ea_deals/.test(q)).join("\n"));
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions").get().n, 0);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 're:%'").get().n, 0);
  // The engine off: the step does not run either.
  const k = env();
  await ready(k);
  await writeSettings(k, { body: { enabled: false }, actor: "owner" }, { now: NOW - 10_000 });
  await sync(k);
  assert.equal(k.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions").get().n, 0);
  // Every fixture with reentry_1m "off" gives the behaviour text before RE1: PM-1M's hash, byte for byte.
  assert.equal(await sha256Hex(engineBehaviourSource({ reentry: "off" })), BEFORE_RE1_HASH);
  assert.notEqual(ENGINE_BEHAVIOUR_HASH, BEFORE_RE1_HASH, "the re-entry on is a new era (a recorded exception)");
  const text = engineBehaviourSource();
  assert.equal(await sha256Hex(text), ENGINE_BEHAVIOUR_HASH);
  const names = text.split("\n").map((l) => l.slice(0, l.indexOf("=")));
  assert.deepEqual(names.filter((x) => x.startsWith("re/")), ["re/setup", "re/check", "re/plan", "re/v4/breakeven_reentry/trace", "re/v4/breakeven_reentry/records"]);
  assert.equal(engineBehaviourSource({ reentry: "off" }).includes("\nre/"), false);
  // planIntents with reentry_1m "off" ignores a trigger: the plan of no trigger, byte for byte.
  const [, input] = planCases().find(([n]) => n === "off");
  assert.deepEqual(planIntents(input), planIntents({ ...input, reentry1m: null }));
  // Aether's policy never writes the switch: the owner's "off" survives a policy application.
  const p = env();
  await sync(p, { state: STATE({ deals: [] }) }, NOW - 30_000);
  await writeSettings(p, { body: { enabled: true, reentry_1m: "off" }, actor: "owner" }, { now: NOW - 20_000 });
  await p.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ doctrine_sha: "d1", risk_pct: 0.4, reentry_1m: "on" }));
  await applyOmegaPolicy(p, { now: NOW });
  assert.equal((await readSettings(p)).settings.reentry_1m, "off");
});
