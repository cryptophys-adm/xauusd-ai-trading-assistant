// PM-1M, the 1m fast-protect layer on the MT5 broker stream (owner 2026-11-23: "deploy semuanya live. Tf 1m diperlukan
// position manager untuk antisipasi TP lebih cepat dan mengurangi kerugian. Meski concern dengan noise perlu
// penanganan."; src/pm-fast.mjs). Each trigger, each non-trigger in noise, never a looser stop, the rate limit and the
// hysteresis, the SLG1 gate, the fallback, the live step on Omega's sync, v4's replay, the switch and the hashes.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fastProtect, fastNoise, fastBars, atr1m, fastId, isFastId, fastMeta, pmFastOn, spikeHolds, runFastProtect, PM_FAST_1M, PM_FAST_RULES, PM_FAST_MODES } from "../src/pm-fast.mjs";
import { OMEGA_DEFAULTS, settingsFrom, positionManagerIntents, planIntents, fastIntent } from "../src/omega-engine.mjs";
import { replayOmega4, eraSwitches, ERA_SWITCHES, ENGINE_BEHAVIOUR_HASH, sha256Hex } from "../src/ledger-omega4.mjs";
import { actionIdOfIntent, actionMessage, resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { bridgeSync, writeSettings, readSettings, resetOmegaBrokerSchemaForTests, applyOmegaPolicy, OMEGA_POLICY_KEY } from "../src/omega-broker.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { resetLiquiditySchemaForTests } from "../src/liquidity-lens.mjs";
import { corpusSource } from "../src/corpus-oracle.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { key, C, M1 } from "./fixtures/omega-v4-replay.mjs";
import {
  T0, SYM, bars, nowAfter, tpBuyBars, tpBuy, tpBuyMeta, tpSell, tpSellMeta, tpSellBars, cutBuyBars, cutBuy, cutBuyMeta, GATE_OPEN, GATE_SHUT,
  fastCases, fastIntentCases, fastReplayScenarios, reopenBars, reopenLong, reopenLongMeta
} from "./fixtures/pm-fast.mjs";

const BEFORE_PM1M_HASH = "169243f2ba3780a7aa6d404d1227090fcbd5617a4b6f2a09dbb44883e5eafe28";
const caseOf = (name) => fastCases().find(([n]) => n === name)[1];
const run = (name, over = {}) => fastProtect({ ...caseOf(name), ...over });
const brief = (f) => [f.status, f.action ?? f.code ?? null, f.rule ?? null, f.sl ?? null, f.tp ?? null];

test("F1. one table of per-mode constants; the switch is the Omega setting pm_fast_1m, on by default, in ERA_SWITCHES", () => {
  assert.deepEqual(Object.keys(PM_FAST_1M), ["scalp", "intraday", "range", "swing"]);
  const keys = Object.keys(PM_FAST_1M.intraday).sort();
  for (const [mode, k] of Object.entries(PM_FAST_1M)) {
    assert.deepEqual(Object.keys(k).sort(), keys, mode);
    // The brief's numbers: 2 of the last 3 bars, a body of 0.5 x ATR1m, an impulse of 2.0 x ATR1m (the start), the stop
    // at the 1m swing plus max(2 x spread, 0.25 x ATR1m), an early exit at -0.5R, a bar at most 90 s old, a warm-up of
    // 20 bars, 3 minutes after a reconnect batch, one action per 3 minutes, no reversal within 10.
    assert.deepEqual([k.against_min, k.against_of, k.body_atr, k.impulse_k, k.stop_spread_k, k.stop_atr_k, k.exit_r, k.fresh_ms, k.warmup_bars, k.reconnect_ms, k.rate_ms, k.hysteresis_ms, k.atr_period],
      [2, 3, 0.5, 2.0, 2, 0.25, -0.5, 90_000, 20, 180_000, 180_000, 600_000, 14], mode);
    assert.ok(k.near_zone_r > 0 && k.lock_r > 0 && k.lock_r < 1, mode);
  }
  assert.deepEqual([...PM_FAST_MODES], ["on", "off"]);
  assert.deepEqual(PM_FAST_RULES, { tp: "pm_fast_tp", cut: "pm_fast_cut" });
  assert.equal(OMEGA_DEFAULTS.pm_fast_1m, "on");
  assert.equal(pmFastOn(OMEGA_DEFAULTS), true);
  assert.equal(pmFastOn({}), true, "absent reads as the default");
  assert.equal(pmFastOn({ pm_fast_1m: "off" }), false);
  assert.equal(pmFastOn.length, 1, "no environment override (orchestrator ruling)");
  assert.ok(ERA_SWITCHES.includes("pm_fast_1m"));
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, pm_fast_1m: "off" }), ["pm_fast_1m=off"]);
  assert.equal(settingsFrom({ pm_fast_1m: "off" }).settings.pm_fast_1m, "off");
  assert.equal(settingsFrom({ pm_fast_1m: "on" }, { ...OMEGA_DEFAULTS, pm_fast_1m: "off" }).settings.pm_fast_1m, "on");
  for (const bad of ["legacy", true, 1, ""]) assert.match(settingsFrom({ pm_fast_1m: bad }).error, /pm_fast_1m must be 'on' or 'off'/, String(bad));
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, pm_fast_1m: "off" }).settings.pm_fast_1m, "off", "carried through another change");
  // Ids: the action's and the intent's, pm1:<ticket>:<bar minute>.
  assert.equal(fastId(101, T0), `pm1:101:${T0 / M1}`);
  for (const id of ["pm1:101:29900000", "d:pm1:101:29900000", "pm1:101:29900000:2"]) assert.equal(isFastId(id), true, id);
  for (const id of ["pm:101:7000", "pm:101:c:7000", "pm1:x:1", "open:1:S", null]) assert.equal(isFastId(id), false, String(id));
  assert.equal(actionIdOfIntent("pm1:101:29900000"), "pm1:101:29900000");
  assert.equal(actionIdOfIntent("d:pm1:101:29900000:1"), "pm1:101:29900000");
  assert.equal(actionIdOfIntent("pm1:101"), null);
  assert.equal(actionIdOfIntent("pm:101:c:7000"), "pm:101:7000", "the 5-minute ids as before");
});

test("F2. TP anticipation: near the target, in profit, 2 of 3 bars against: a lock with the gate open, the target nearer with it closed", () => {
  // No gate (profit_lock_gate "legacy"): the lock, 0.5 of the open profit (+13.2 at the last close).
  assert.deepEqual(brief(run("tp/legacy_lock")), ["act", "sl", "pm_fast_tp", 2006.6, null]);
  const open = run("tp/gate_open_lock");
  assert.deepEqual(brief(open), ["act", "sl", "pm_fast_tp", 2006.6, null]);
  assert.match(open.why, /^1m TP anticipation: 0\.28R from the target \(zone 0\.3R\), 2 of the last 3 closed 1m bars against the long with a body of at least 0\.5 x ATR1m\(14\) 1\.41 \(broker_m1\); bar 09:39 UTC, intraday, \+1\.32R: stop to 2006\.6/);
  assert.match(open.why, /at the profit-lock gate \(MFE 15/);
  assert.deepEqual([open.bar_ms, open.atr, open.atr_source, open.branch], [T0 + 39 * M1, 1.41, "broker_m1", "tp"]);
  // SLG1: the gate closed, no stop into profit: the target comes nearer instead (the recent high 2015.3 less the spread).
  const shut = run("tp/gate_shut_nearer");
  assert.deepEqual(brief(shut), ["act", "tp", "pm_fast_tp", null, 2015.1]);
  assert.match(shut.why, /target nearer 2016 → 2015\.1 \(the recent extreme less the spread\); the lock waits for the profit-lock gate \(MFE 8/);
  // A short: its bars are the bid, so the ask is the bid plus the bar's spread (0.2): the lock and the target in ask terms.
  const sOpen = run("tp/sell_gate_open_lock"), sShut = run("tp/sell_gate_shut_nearer");
  assert.deepEqual(brief(sOpen), ["act", "sl", "pm_fast_tp", 1993.5, null]);
  assert.deepEqual(brief(sShut), ["act", "tp", "pm_fast_tp", null, 1985.1]);
  const sb = tpSellBars(), xs = fastBars(sb, { side: "SELL", point: 0.01, spreadPoints: 20 });
  assert.deepEqual([xs.at(-1).c, sb.at(-1).c], [Math.round((sb.at(-1).c + 0.2) * 100) / 100, sb.at(-1).c]);
  assert.deepEqual(fastBars(sb, { side: "BUY" }).at(-1).c, sb.at(-1).c, "a long's bars as they are");
  // The stop already locks more: the target nearer is the one left.
  assert.deepEqual(brief(run("tp/already_locked_nearer")), ["act", "tp", "pm_fast_tp", null, 2015.1]);
  // Out of the zone, or not in profit: no trigger, no record.
  assert.deepEqual(brief(run("tp/out_of_zone")), ["none", null, null, null, null]);
  assert.deepEqual(brief(run("tp/in_loss")), ["none", null, null, null, null]);
  // One bar against is not two.
  const one = bars({ n: 37, step: 0.4, tail: [-0.9, 0.2, 0.3] });
  assert.equal(fastProtect({ position: tpBuy, meta: tpBuyMeta, bars: one, now: nowAfter(one), sym: SYM }).status, "none");
  // Bodies under 0.5 x ATR1m are not against it.
  const small = bars({ n: 37, step: 0.4, tail: [-0.5, 0.2, -0.5] });
  assert.equal(fastProtect({ position: tpBuy, meta: tpBuyMeta, bars: small, now: nowAfter(small), sym: SYM }).status, "none");
});

test("F3. loss reduction: an impulse beyond the 5m swing, not reclaimed: the stop to the 1m swing, an early close at -0.5R, the gate for a stop in profit", () => {
  const t = run("cut/tighten");
  assert.deepEqual(brief(t), ["act", "sl", "pm_fast_cut", 1993.5, null]);
  assert.match(t.why, /^1m impulse against the long: true range [\d.]+ at least 2 x ATR1m\(14\) [\d.]+ \(broker_m1\), closed beyond the 5m swing [\d.]+ and the next bar did not reclaim it; bar 09:41 UTC, intraday, -0\.28R: stop tightened 1987 → 1993\.5/);
  assert.ok(1993.5 > cutBuy().sl && 1993.5 > cutBuyMeta().orig_sl, "tighter than the stop and the original stop");
  const c = run("cut/close_below_exit_r");
  assert.deepEqual(brief(c), ["act", "close", "pm_fast_cut", null, null]);
  assert.match(c.why, /closed early at -0\.58R \(at or below -0\.5R\)/);
  // A tightened stop above the entry is a stop into profit: it waits for the profit-lock gate (SLG1), and goes in at it.
  const held = run("cut/in_profit_gate_shut");
  assert.deepEqual(brief(held), ["held", "hold", "pm_fast_cut", null, null]);
  assert.match(held.why, /a stop at 1993\.5 is in profit and waits for the profit-lock gate/);
  assert.deepEqual(brief(run("cut/in_profit_gate_open")), ["act", "sl", "pm_fast_cut", 1993.5, null]);
  assert.match(run("cut/already_tighter").why, /held: the stop 1993\.9 is already at or tighter than the 1m swing's 1993\.5/);
  // The next bar reclaims the swing: no trigger.
  const reclaimed = bars({ n: 40, step: 0.3, zigzag: true, tail: [{ d: -5.5, hi: 0.1, lo: 0.4 }, { d: 5, hi: 0.4, lo: 0.3 }] });
  assert.equal(fastProtect({ position: cutBuy(), meta: cutBuyMeta(), bars: reclaimed, now: nowAfter(reclaimed), sym: SYM }).status, "none");
  // A true range under 2 x ATR1m: no impulse.
  const mild = bars({ n: 40, step: 0.3, zigzag: true, tail: [{ d: -2, hi: 0.1, lo: 0.4 }, { d: -0.3, hi: 0.4, lo: 0.3 }] });
  assert.equal(fastProtect({ position: cutBuy(), meta: cutBuyMeta(), bars: mild, now: nowAfter(mild), sym: SYM }).status, "none");
  // ATR1m before the impulse: the impulse and its confirmation never inflate it.
  const cb = cutBuyBars(), xb = fastBars(cb, { side: "BUY" });
  assert.equal(Math.round(atr1m(xb, xb.length - 3) * 100) / 100, t.atr);
  assert.ok(atr1m(xb, xb.length - 1) > t.atr);
});

test("F4. noise: the rollover, the reopen, the market paused, a reconnect batch, a stale bar, the warm-up and a spread spike take no fast action", () => {
  for (const [name, code] of [["noise/no_stream", "no_stream"], ["noise/stale", "stale"], ["noise/rollover", "rollover"], ["noise/reopen", "reopen"], ["noise/market_paused", "market_paused"],
    ["noise/reconnect", "reconnect"], ["noise/warmup", "warmup"], ["noise/no_atr", "no_atr"]]) {
    const f = run(name);
    assert.deepEqual([f.status, f.code], ["inert", code], name);
    assert.equal(f.action, undefined, `${name}: nothing to record`);
  }
  assert.equal(run("noise/reconnect_passed").status, "act", "3 minutes after the batch: the layer acts again");
  // The freshness bound: 90 s after the close still acts, 91 s does not.
  const b = tpBuyBars(), close = b.at(-1).t + M1;
  assert.equal(fastProtect({ ...caseOf("tp/legacy_lock"), now: close + 90_000 }).status, "act");
  assert.equal(fastProtect({ ...caseOf("tp/legacy_lock"), now: close + 91_000 }).code, "stale");
  // A bar still forming (its close after now) is never read.
  assert.equal(fastProtect({ ...caseOf("tp/legacy_lock"), now: close - 1 }).status, "none", "the bar before it is the last closed one");
  // The quarantine windows, minute by minute (a Tuesday): 21:55-22:15 rollover, 23:00-23:05 reopen.
  const minute = (iso) => fastNoise([{ t: Date.parse(iso) - M1, o: 1, h: 1, l: 1, c: 1 }], { now: Date.parse(iso) + 1000 });
  assert.equal(minute("2026-11-24T21:55:00Z").code, "rollover");
  assert.equal(minute("2026-11-24T21:54:00Z").code, "warmup", "21:53 is outside the rollover");
  assert.equal(minute("2026-11-24T23:05:00Z").code, "reopen", "the 23:04 bar");
  assert.equal(minute("2026-11-24T23:06:00Z").code, "warmup");
  // The spread-spike deferral: a trigger in a spike is held (and recorded), the close of the loss branch too.
  assert.match(run("tp/held_spike").why, /held: the spread-spike deferral holds modifications/);
  assert.equal(run("cut/held_spike").status, "held");
  const sig = { liquidity_on: true, liquidity_spread_median: 10, liquidity_spread_widen: 2 }, now = T0 + 60 * M1;
  assert.equal(spikeHolds({ signal: sig, sym: { spread_points: 30 }, settings: OMEGA_DEFAULTS, spikeSinceMs: now - 60_000, now }), true);
  assert.equal(spikeHolds({ signal: sig, sym: { spread_points: 30 }, settings: OMEGA_DEFAULTS, spikeSinceMs: now - 10 * M1, now }), false, "the deferral ends after 10 minutes, as the planner's");
  assert.equal(spikeHolds({ signal: sig, sym: { spread_points: 15 }, settings: OMEGA_DEFAULTS, spikeSinceMs: now, now }), false, "no spike");
  assert.equal(spikeHolds({ signal: sig, sym: { spread_points: 30 }, settings: { ...OMEGA_DEFAULTS, liquidity_enabled: false }, spikeSinceMs: now, now }), false, "the lens off");
  assert.equal(spikeHolds({ signal: { ...sig, liquidity_on: false }, sym: { spread_points: 30 }, settings: OMEGA_DEFAULTS, now }), false);
});

test("F5. never loosens: over many generated cases a stop only tightens (never beyond the original), a target only comes nearer; Omega checks it again", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let acts = 0;
  for (let i = 0; i < 1500; i++) {
    const side = rnd() < 0.5 ? "BUY" : "SELL", dir = side === "BUY" ? 1 : -1;
    const tail = Array.from({ length: 3 }, () => ({ d: (rnd() - 0.5) * 12, hi: rnd() * 2, lo: rnd() * 2 }));
    const list = bars({ n: 30 + Math.floor(rnd() * 20), from: 2000, step: (rnd() - 0.5) * 1.2, wick: 0.2 + rnd(), zigzag: rnd() < 0.4, tail, spread: Math.floor(rnd() * 40) });
    const open = 2000 + (rnd() - 0.5) * 20, rd = 5 + rnd() * 15, orig = open - dir * rd;
    const sl = rnd() < 0.3 ? orig + dir * rnd() * rd * 1.5 : orig;
    const tp = open + dir * (rd * (0.5 + rnd() * 2));
    const p = { ticket: 9, side, open_price: Math.round(open * 100) / 100, sl: Math.round(sl * 100) / 100, tp: Math.round(tp * 100) / 100, opened_ms: T0 };
    const gate = [undefined, GATE_OPEN, GATE_SHUT][Math.floor(rnd() * 3)];
    const f = fastProtect({ position: p, meta: { mode: ["scalp", "intraday", "range", "swing"][i % 4], r_dist: rd, tp1: p.tp, orig_sl: Math.round(orig * 100) / 100 }, bars: list, now: nowAfter(list), sym: SYM, gate });
    if (f.status !== "act") continue;
    acts += 1;
    if (f.action === "sl") {
      assert.ok(dir * (f.sl - p.sl) > 0, `tighter: ${JSON.stringify([p, f.sl])}`);
      assert.ok(dir * (f.sl - orig) >= -0.005, "never beyond the original stop");
      if (gate === GATE_SHUT) assert.ok(dir * (f.sl - p.open_price) < 0, "with the gate closed, never a stop into profit");
    } else if (f.action === "tp") {
      assert.ok(dir * (p.tp - f.tp) > 0, "nearer");
      assert.ok(dir * (f.tp - p.open_price) > 0, "still in profit");
      assert.equal(f.sl, undefined);
    } else assert.equal(f.action, "close");
    assert.ok(["pm_fast_tp", "pm_fast_cut"].includes(f.rule));
    // Omega's check: whatever the layer stored, an intent is never a looser stop or a further target.
    const sym = { bid: list.at(-1).c, ask: Math.round((list.at(-1).c + 0.2) * 100) / 100, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0 };
    for (const a of [{ action: "sl", sl: p.sl - dir * 1 }, { action: "tp", tp: p.tp + dir * 1 }, { action: f.action, sl: f.sl, tp: f.tp }]) {
      const r = fastIntent({ a: { ...a, id: "pm1:9:1", ticket: 9, rule: f.rule }, p, sym, bar: "1", point: 0.01, digits: 2, floorPx: 0.2 });
      if (r.intent?.kind === "modify_sl") assert.ok(dir * (r.intent.sl - p.sl) > 0);
      if (r.intent?.kind === "modify_tp") assert.ok(dir * (p.tp - r.intent.tp) > 0);
    }
  }
  assert.ok(acts > 30, `${acts} actions`);
  // Each intent kind Omega makes of a fast action, and each drop with its reason.
  const out = Object.fromEntries(fastIntentCases().map(([n, input]) => { const r = positionManagerIntents(input); return [n, [r.intents.map((it) => [it.id, it.kind, it.sl ?? null, it.tp ?? null, it.reason]), r.dropped.map((d) => d.reason)]]; }));
  assert.deepEqual(out.lock[0], [["pm1:101:29900000", "modify_sl", 2006.6, 2016, "pm_fast_tp"]]);
  assert.deepEqual(out.lock_gate_shut, [[], ["the lock waits for the profit-lock gate: MFE 8 (0.8R, 1.1 ATR) on closed M15 bars against 10 (1R)"]]);
  assert.deepEqual(out.lock_gate_open[0], [["pm1:101:29900000", "modify_sl", 2006.6, 2016, "pm_fast_tp"]]);
  assert.deepEqual(out.nearer_tp[0], [["pm1:101:29900003", "modify_tp", null, 2015.1, "pm_fast_tp"]], "a nearer target is not a stop into profit: not gated");
  assert.deepEqual(out.looser_stop[1], ["the stop is already at or beyond 2006.6"]);
  assert.deepEqual(out.no_room[1], ["the live price leaves no room for a stop at 2006.6"]);
  assert.deepEqual(out.further_tp[1], ["a target at 2017 is not nearer than the broker's (2016)"]);
  assert.match(out.tp_wrong_side[1][0], /wrong side of price/);
  assert.deepEqual(out.tp_with_stop[1], ["a fast target move never carries a stop"]);
  assert.deepEqual(out.close[0], [["pm1:101:29900007", "close", null, null, "pm_fast_cut"]]);
  assert.match(out.loosened_before[1][0], /the council loosened this stop/);
});

test("F6. the rate limit (one fast action per 3 minutes) and the hysteresis (no other-trigger action within 10 minutes), held and recorded", () => {
  const rate = run("tp/held_rate");
  assert.deepEqual(brief(rate), ["held", "hold", "pm_fast_tp", null, null]);
  assert.match(rate.why, /held: a fast action went out at 09:37 UTC: at most one per 3 minutes/);
  assert.equal(run("tp/rate_passed").status, "act");
  const flip = run("tp/held_hysteresis");
  assert.match(flip.why, /held: hysteresis: the other fast trigger acted at 09:33 UTC, within 10 minutes/);
  assert.equal(run("tp/hysteresis_passed").status, "act");
  // The same trigger within 10 minutes (past the 3-minute limit) is not a reversal.
  assert.equal(run("tp/legacy_lock", { history: [{ bar_ms: T0 + 33 * M1, branch: "tp" }] }).status, "act");
  // The 5-minute Position Manager acted on this position in this 5m bar: the fast layer holds it.
  assert.match(run("tp/held_pm_bar").why, /held: the 5-minute Position Manager acted on this position in this 5m bar/);
  // In v4, minute by minute, over the reopen shape moved to a Tuesday: never two fast actions on a position within 3 minutes.
  const list = reopenBars({ contiguous: true });
  const history = [];
  for (let k = 61; k <= list.length; k++) {
    const sub = list.slice(0, k), now = sub.at(-1).t + M1 + 2000;
    const f = fastProtect({ position: reopenLong, meta: reopenLongMeta, bars: sub, now, sym: SYM, history });
    if (f.status === "act") history.push({ bar_ms: f.bar_ms, branch: f.branch });
  }
  assert.ok(history.length >= 2, JSON.stringify(history));
  for (let i = 1; i < history.length; i++) assert.ok(history[i].bar_ms - history[i - 1].bar_ms >= 3 * M1, JSON.stringify(history));
});

test("F7. the 2026-11-22 reopen replayed minute by minute: no fast action or record in the quarantine or the warm-up, live and in v4; the same bars on a Tuesday act", () => {
  for (const shape of ["live", "v4"]) {
    const all = reopenBars();
    const reopen = Date.parse("2026-11-22T23:00:00Z");
    const seen = {};
    for (let k = 61; k <= all.length; k++) {
      const sub = all.slice(0, k), now = sub.at(-1).t + M1 + 2000;
      // Live, the stream delivers what has arrived by now (Friday's 21:59 bar only at the reopen); v4 has the feed's bars.
      const input = shape === "live" ? sub.filter((b) => b.r <= now) : sub.map(({ r, ...b }) => b);
      const f = fastProtect({ position: reopenLong, meta: reopenLongMeta, bars: input, now, sym: SYM });
      const minute = sub.at(-1).t;
      if (minute < reopen + 5 * M1) assert.deepEqual([f.status, f.code], ["inert", "reopen"], `${shape} ${new Date(minute).toISOString()}`);
      if (minute < reopen + 19 * M1) assert.equal(f.status, "inert", `${shape} ${new Date(minute).toISOString()}: ${f.code}`);
      seen[f.code ?? f.status] = (seen[f.code ?? f.status] ?? 0) + 1;
    }
    assert.deepEqual([seen.reopen, seen.warmup], [5, 14], `${shape}: ${JSON.stringify(seen)}`);
  }
  // The weekend's catch-up bar (Friday 21:59, received at 23:00:40): the reconnect quarantine would hold too.
  const all = reopenBars(), at = Date.parse("2026-11-22T23:02:00Z");
  assert.equal(fastNoise(all.filter((b) => b.t < at), { now: at + 1000, knobs: { ...PM_FAST_1M.intraday, reopen_min: 0 } }).code, "reconnect");
  // The teeth: the same bars without the weekend act within the first minutes.
  const tue = reopenBars({ contiguous: true });
  const acted = [];
  for (let k = 61; k <= 71; k++) { const sub = tue.slice(0, k); const f = fastProtect({ position: reopenLong, meta: reopenLongMeta, bars: sub, now: sub.at(-1).t + M1 + 2000, sym: SYM }); if (f.status === "act") acted.push(f.rule); }
  assert.ok(acted.length >= 2 && acted.every((r) => r === "pm_fast_cut"), JSON.stringify(acted));
});

// The Omega sync end to end over a sqlite D1, with Telegram captured (as test/position-manager-broker.test.mjs).
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
const NOW = T0 + 40 * M1 + 2000; // the bar of T0 + 39 minutes closed 2 s ago
const BUY_POS = { ticket: 101, symbol: "XAUUSD", side: "BUY", volume: 0.01, open_price: 2000, sl: 1990, tp: 2016, intent_id: "open:1:B", magic: 920200, source: "omega", opened_ms: T0 };
const STATE = (over = {}) => ({
  connected: true, server: "AnyBroker-Demo", received_ms: NOW - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 2013.2, ask: 2013.4, spread_points: 20 },
  positions: [BUY_POS], ...over
});
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
const sync = (e, over = {}, now = NOW) => bridgeSync(e, { state: STATE(), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0", ...over }, { now, signal: null });
/** The stream's rows for the account the sync filed, under a source and digits (by default the connected terminal's). */
async function seed(e, list, { source = corpusSource("AnyBroker-Demo", "XAUUSD"), digits = 2, version = 90 } = {}) {
  const ref = JSON.parse(e.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state).account_ref;
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS broker_bars_1m (account_ref TEXT NOT NULL, source TEXT NOT NULL, minute_ms INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, tick_volume INTEGER, spread_points INTEGER, digits INTEGER, connection_version INTEGER, received_ms INTEGER NOT NULL, legacy_ref INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_ref, source, minute_ms))");
  const ins = e.DB.raw.prepare("INSERT OR REPLACE INTO broker_bars_1m VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, 0)");
  list.forEach((b, i) => ins.run(ref, source, b.t, b.o, b.h, b.l, b.c, b.s ?? 20, digits, version + (i % 3), b.t + M1 + 1500));
  return ref;
}
async function ready(e) {
  await sync(e, {}, NOW - 30_000);
  await writeSettings(e, { body: { enabled: true }, actor: "owner" }, { now: NOW - 20_000 });
  e.DB.raw.prepare("INSERT OR IGNORE INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES ('open:1:B', 'open', ?, 'done', ?, ?)")
    .run(JSON.stringify({ kind: "open", side: "BUY", volume: 0.01, entry: 2000, sl: 1990, tp: 2016, r_dist: 10, mode: "intraday", strategy: "zone_pullback" }), T0, T0);
}

test("F8. the live step on Omega's sync: once per closed broker minute, the record (pm1 id, rule, bar, ATR source) and the intent under the same id; the line when the broker answers", async () => {
  const e = env();
  await ready(e);
  await seed(e, tpBuyBars());
  const sent = await withTelegram(async () => { await sync(e); });
  const id = `pm1:101:${(T0 + 39 * M1) / M1}`;
  const row = e.DB.raw.prepare("SELECT * FROM position_actions WHERE id = ?").get(id);
  // SLG1 on by default, with no corpus here the gate reads closed: no stop into profit, the target nearer instead.
  assert.deepEqual([row.ticket, row.bar, row.action, row.rule, row.tp, row.sl, row.council, row.status, row.side], [101, (T0 + 39 * M1) / M1, "tp", "pm_fast_tp", 2015.1, null, null, "applied", "BUY"]);
  assert.match(row.why, /ATR1m\(14\) 1\.41 \(broker_m1\); bar 09:39 UTC/);
  assert.match(row.why, /the lock waits for the profit-lock gate/);
  const intent = e.DB.raw.prepare("SELECT id, kind, payload, status FROM omega_intents WHERE id = ?").get(id);
  assert.deepEqual([intent.kind, JSON.parse(intent.payload).tp, JSON.parse(intent.payload).reason, intent.status], ["modify_tp", 2015.1, "pm_fast_tp", "sent"]);
  assert.equal(sent.filter((t) => /POSITION MANAGER/.test(t)).length, 0, "no line at planning");
  // The same minute again (the bridge syncs about twice a second): evaluated once, nothing new.
  await sync(e, {}, NOW + 500);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions WHERE id LIKE 'pm1:%'").get().n, 1);
  // The broker's answer: one line, the Position Manager's, with the 1m head; no account number.
  const answered = await withTelegram(async () => { await sync(e, { results: [{ id, ok: true, ticket: 101, executed_ms: NOW + 900 }], state: STATE({ positions: [{ ...BUY_POS, tp: 2015.1 }] }) }, NOW + 1_000); });
  const lines = answered.filter((t) => /POSITION MANAGER/.test(t));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^XAUUSD POSITION MANAGER · #101 BUY · \+132 pips · 1m TP nearer to 2015\.1 · applied at the broker\n1m TP anticipation/);
  assert.doesNotMatch(lines[0], /login|account/i);
  assert.equal(actionMessage({ ticket: 1, side: "SELL", pips: -20, action: "close", rule: "pm_fast_cut", why: "w" }).split("\n")[0], "XAUUSD POSITION MANAGER · #1 SELL · -20 pips · 1m early close · applied at the broker");
  assert.match(actionMessage({ ticket: 1, side: "BUY", pips: 5, action: "sl", sl: 2001, rule: "pm_fast_cut", why: "w" }), /1m stop tightened to 2001/);
  assert.match(actionMessage({ ticket: 1, side: "BUY", pips: 5, action: "sl", sl: 2001, rule: "pm_fast_tp", why: "w" }), /1m lock: stop to 2001/);
  // A held trigger is recorded as noted (never pending), with its reason.
  const e2 = env();
  await ready(e2);
  await seed(e2, tpBuyBars());
  e2.DB.raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, action, rule, why, status) VALUES (?, 101, ?, ?, 'BUY', 'tp', 'pm_fast_tp', 'w', 'applied')").run(`pm1:101:${(T0 + 37 * M1) / M1}`, (T0 + 37 * M1) / M1, T0 + 38 * M1);
  await sync(e2);
  const held = e2.DB.raw.prepare("SELECT action, rule, status, why FROM position_actions WHERE id = ?").get(id);
  assert.deepEqual([held.action, held.rule, held.status], ["hold", "pm_fast_tp", "noted"]);
  assert.match(held.why, /at most one per 3 minutes/);
  assert.equal(e2.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 'pm1:%'").get().n, 0);
});

test("F9. identity and fallback: pinned by account, source and digits (any connection version); no bar, a stale bar or another stream: inert, today's sync", async () => {
  // Connection versions 90 to 92 are one source: the rows above carry three versions and were read (F8).
  // Another server's or symbol's source, or other digits: not this terminal's stream.
  for (const opt of [{ source: corpusSource("Other-Server", "XAUUSD") }, { source: corpusSource("AnyBroker-Demo", "GOLD") }, { digits: 3 }]) {
    const e = env();
    await ready(e);
    await seed(e, tpBuyBars(), opt);
    await sync(e);
    assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions WHERE id LIKE 'pm1:%'").get().n, 0, JSON.stringify(opt));
  }
  // The minute's bar not in yet: waiting (looked for again in 5 s), nothing written; when it arrives, the layer acts.
  const e = env();
  await ready(e);
  await seed(e, tpBuyBars().slice(0, -1));
  const r1 = await runFastProtect(e, { executor: { ...JSON.parse(e.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state), positions: [BUY_POS] }, now: NOW });
  assert.equal(r1.status, "waiting");
  assert.equal((await runFastProtect(e, { executor: { ...JSON.parse(e.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state), positions: [BUY_POS] }, now: NOW + 1000 })).status, "done", "not read again within 5 s");
  // A stale stream (the last bar minutes old) leaves the layer inert: no record, today's 5-minute behaviour.
  const s = env();
  await ready(s);
  await seed(s, tpBuyBars().map((b) => ({ ...b, t: b.t - 5 * M1 })));
  await sync(s);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions WHERE id LIKE 'pm1:%'").get().n, 0);
  // No stream at all.
  const n = env();
  await ready(n);
  await sync(n);
  assert.equal(n.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions WHERE id LIKE 'pm1:%'").get().n, 0);
  // A delegated manual position is not the layer's (Omega's own positions only).
  assert.equal((await runFastProtect(e, { executor: { positions: [{ ...BUY_POS, intent_id: "deleg:101" }] }, now: NOW })).status, "no_positions");
  // The meta of an open intent.
  assert.deepEqual(fastMeta({ entry: 2000, sl: 1990, tp: 2016, mode: "scalp" }), { mode: "scalp", r_dist: 10, tp1: 2016, orig_sl: 1990 });
});

test("F10. off is byte for byte today: the sync reads no stream and writes no fast record; the fingerprint is the engine's before PM-1M", async () => {
  const log = [];
  const e = env(log);
  await ready(e);
  await seed(e, tpBuyBars());
  await writeSettings(e, { body: { enabled: true, pm_fast_1m: "off" }, actor: "owner" }, { now: NOW - 10_000 });
  log.length = 0;
  await sync(e);
  assert.equal(log.some((q) => /broker_bars_1m|pm1:/.test(q) && !/LIKE 'pm1:%' OR id LIKE 'd:pm1:%'/.test(q)), false, log.filter((q) => /broker_bars_1m|pm1/.test(q)).join("\n"));
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions").get().n, 0);
  // The engine is off (or killed): the layer does not run either.
  const k = env();
  await ready(k);
  await seed(k, tpBuyBars());
  await writeSettings(k, { body: { enabled: false }, actor: "owner" }, { now: NOW - 10_000 });
  await sync(k);
  assert.equal(k.DB.raw.prepare("SELECT COUNT(*) AS n FROM position_actions").get().n, 0);
  // Every fixture with pm_fast_1m "off" gives the behaviour text before PM-1M: CH1's hash, byte for byte (RE1, 2026-11-23:
  // with the 1m re-entry off too, the engine before it).
  assert.equal(await sha256Hex(engineBehaviourSource({ pmFast: "off", reentry: "off" })), BEFORE_PM1M_HASH);
  assert.notEqual(ENGINE_BEHAVIOUR_HASH, BEFORE_PM1M_HASH, "the layer on is a new era (a recorded exception)");
  const text = engineBehaviourSource();
  assert.equal(await sha256Hex(text), ENGINE_BEHAVIOUR_HASH);
  const names = text.split("\n").map((l) => l.slice(0, l.indexOf("=")));
  assert.deepEqual(names.filter((x) => x.startsWith("fast/")), ["fast/protect", "fast/intents", "fast/v4/cut_loss/trace", "fast/v4/cut_loss/records", "fast/v4/tp_anticipation/trace", "fast/v4/tp_anticipation/records"]);
  assert.equal(engineBehaviourSource({ pmFast: "off" }).includes("fast/"), false);
  // Aether's policy never writes the switch: the owner's "off" survives a policy application.
  const p = env();
  await sync(p, {}, NOW - 30_000);
  await writeSettings(p, { body: { enabled: true, pm_fast_1m: "off" }, actor: "owner" }, { now: NOW - 20_000 });
  await p.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ doctrine_sha: "d1", risk_pct: 0.4, pm_fast_1m: "on" }));
  await applyOmegaPolicy(p, { now: NOW });
  assert.equal((await readSettings(p)).settings.pm_fast_1m, "off");
});

test("F11. v4 replays the layer as live, from its 1m bars: the impulse tightens a stop, the anticipation locks profit; off is today's replay", () => {
  const [cut, tp] = fastReplayScenarios();
  const trace = [];
  const on = replayOmega4({ ...cut.opts, trace });
  const fast = trace.flatMap((s) => s.output.intents.filter((it) => String(it.id).startsWith("pm1:")).map((it) => ({ ...it, at: s.now })));
  assert.equal(fast.length, 1);
  assert.deepEqual([fast[0].kind, fast[0].reason, fast[0].at], ["modify_sl", "pm_fast_cut", C + 5 * M1]);
  const rec = on.records[key(C)];
  assert.deepEqual([rec.omega4_exit, rec.r_omega4], ["stop", -0.102]);
  assert.deepEqual(JSON.parse(rec.omega4_json).pm, [{ at: new Date(C + 5 * M1).toISOString(), rule: "pm_fast_cut", council: "none_1m" }]);
  const off = replayOmega4({ ...cut.opts, settings: { ...cut.opts.settings, pm_fast_1m: "off" } }).records[key(C)];
  assert.deepEqual([off.omega4_exit, off.r_omega4], ["pm_cut_loss", -0.46], "without the layer: the council's cut, later and deeper");
  // The anticipation near TP: the gate open (MFE past 1R), a lock into profit, the exit at it.
  const t2 = [];
  const on2 = replayOmega4({ ...tp.opts, trace: t2 }).records[key(C)];
  const lock = t2.flatMap((s) => s.output.intents.filter((it) => String(it.id).startsWith("pm1:")))[0];
  assert.deepEqual([lock.kind, lock.reason, lock.sl], ["modify_sl", "pm_fast_tp", 1993.75]);
  assert.ok(lock.mfe_r >= 1, "a lock into profit only past the profit-lock gate");
  assert.deepEqual([on2.omega4_exit, on2.r_omega4], ["sl_plus", 0.625]);
  const off2 = replayOmega4({ ...tp.opts, settings: { ...tp.opts.settings, pm_fast_1m: "off" } }).records[key(C)];
  assert.deepEqual([off2.omega4_exit, off2.r_omega4], ["sl_plus", 0.5]);
  // Off: no fast id anywhere in the replay.
  const t3 = [];
  replayOmega4({ ...cut.opts, settings: { ...cut.opts.settings, pm_fast_1m: "off" }, trace: t3 });
  assert.equal(JSON.stringify(t3.map((s) => s.output)).includes("pm1:"), false);
});

test("F12. Omega's plan: a fast nearer target passes the TP ladder; the spread-spike deferral defers a fast modification, never a fast close", () => {
  const executor = { connected: true, received_ms: NOW - 1000, positions: [BUY_POS], account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000 }, symbol: STATE().symbol };
  const id = `pm1:101:${(T0 + 39 * M1) / M1}`;
  const base = { executor, now: NOW, engineEnabled: true, settings: { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: true }, gates: { 101: GATE_SHUT } };
  const nearer = planIntents({ ...base, pmActions: [{ id, ticket: 101, action: "tp", rule: "pm_fast_tp", tp: 2015.1 }] });
  assert.ok(nearer.intents.some((it) => it.id === id && it.kind === "modify_tp" && it.tp === 2015.1), JSON.stringify(nearer));
  const sig = { liquidity_on: true, liquidity_spread_median: 5, liquidity_spread_widen: 2, liquidity_levels: "" };
  const spike = planIntents({ ...base, signal: sig, liquiditySpikeSince: NOW - 60_000, pmActions: [{ id, ticket: 101, action: "tp", rule: "pm_fast_tp", tp: 2015.1 }] });
  assert.ok(!spike.intents.some((it) => it.id === id), "deferred");
  assert.ok(spike.notes.some((n) => n.code === "liquidity_modify_deferred"));
  const close = planIntents({ ...base, signal: sig, liquiditySpikeSince: NOW - 60_000, pmActions: [{ id, ticket: 101, action: "close", rule: "pm_fast_cut" }] });
  assert.ok(close.intents.some((it) => it.id === id && it.kind === "close"));
});
