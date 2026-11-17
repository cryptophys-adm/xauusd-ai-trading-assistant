// The strategy arm (owner 2026-11-17: live directly; 1-3 armed only, or AUTO = the one best strategy by confidence x
// confluence; auto-disarm on the kill switch and the daily loss limit; the Decision Engine's veto kept).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setStrategyArm, disarmAll, readArmState, readArmsFromDb, dailyLossHit, resetStrategyArmSchemaCacheForTests, ARM_MAX, STRATEGY_ARMS_KEY, ownerCheck, noteOwnerSub } from "../src/strategy-arm.mjs";
import { pickStrategy, decide, selectionLine, MIN_CONFIDENCE } from "../src/decision-engine.mjs";
import { applyArmGate } from "../src/ea-signal.mjs";
import { strategyExits } from "../src/omega-engine.mjs";

function env(over = {}) {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql) => { let a = []; const s = { bind: (...x) => { a = x; return s; }, run: async () => db.prepare(sql).run(...a), first: async () => db.prepare(sql).get(...a) ?? null, all: async () => ({ results: db.prepare(sql).all(...a) }) }; return s; };
  const kv = new Map();
  return { DB: { prepare: wrap, batch: async (stmts) => { db.exec("BEGIN"); try { for (const s of stmts) await s.run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } }, SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) }, STRATEGY_ARM_MODE: "live", kv, raw: db, ...over };
}
const allowed = ["zone_pullback", "sweep_reversal", "breakout_retest", "range_fade"];

test("SA1. arm up to 3, one click each, idempotent, conflict-safe; only live strategies; never while killed", async () => {
  resetStrategyArmSchemaCacheForTests();
  const e = env(), sent = [];
  const arm = (id, extra = {}) => setStrategyArm(e, { strategy_id: id, action: "arm", allowed, actor: "owner@example.com", send: async (t) => sent.push(t), ...extra });
  assert.equal((await arm("zone_pullback", { request_id: "r1" })).changed, true);
  assert.equal((await arm("zone_pullback", { request_id: "r1" })).repeated, true, "the same click twice changes nothing");
  assert.equal((await arm("sweep_reversal")).ok, true);
  assert.equal((await arm("breakout_retest")).ok, true);
  const fourth = await arm("range_fade");
  assert.deepEqual([fourth.ok, /at most 3/.test(fourth.error)], [false, true]);
  assert.match((await arm("pattern_peaks")).error, /only a live strategy/);
  assert.match((await setStrategyArm(e, { strategy_id: "range_fade", action: "arm", allowed, blocked: "the kill switch is on" })).error, /kill switch/);
  assert.equal((await setStrategyArm(e, { strategy_id: "sweep_reversal", action: "disarm", expected_version: 0 })).error, "conflict", "a stale page reloads");
  const dis = await setStrategyArm(e, { strategy_id: "sweep_reversal", action: "disarm", expected_version: 3 });
  assert.deepEqual([dis.ok, dis.state.ids, dis.state.armed_count], [true, ["zone_pullback", "breakout_retest"], 2]);
  assert.deepEqual(JSON.parse(e.kv.get(STRATEGY_ARMS_KEY)).ids, ["zone_pullback", "breakout_retest"], "the hot read follows");
  assert.equal((await readArmState(e)).ids.length, 2);
  assert.ok(sent.some((t) => /Strategy zone_pullback armed · 1\/3 armed/.test(t)));
  assert.equal((await setStrategyArm({ ...e, STRATEGY_ARM_MODE: "off" }, { strategy_id: "range_fade", action: "arm", allowed })).error, "arm_mode_off");
  assert.equal(ARM_MAX, 3);
});

test("SA2. auto-disarm (kill switch, daily loss) writes one event per strategy; the events are append-only", async () => {
  resetStrategyArmSchemaCacheForTests();
  const e = env(), sent = [];
  // Distinct arm times: with the same millisecond the order falls back to strategy_id (CI flake 2026-11-17).
  let t = Date.parse("2026-11-17T09:00:00Z");
  for (const id of ["zone_pullback", "range_fade"]) await setStrategyArm(e, { strategy_id: id, action: "arm", allowed, now: t += 1000 });
  const r = await disarmAll(e, { reason: "daily_loss_limit", send: async (t) => sent.push(t) });
  assert.deepEqual([r.status, r.ids], ["disarmed", ["zone_pullback", "range_fade"]]);
  assert.deepEqual((await readArmsFromDb(e.DB)).ids, []);
  assert.equal((await disarmAll(e, { reason: "kill_switch" })).status, "none_armed");
  const ev = e.raw.prepare("SELECT action, reason, actor FROM strategy_arm_events ORDER BY id").all().map((x) => `${x.action}:${x.reason}:${x.actor}`);
  assert.deepEqual(ev.slice(-2), ["disarm:daily_loss_limit:system", "disarm:daily_loss_limit:system"]);
  assert.match(sent[0], /disarmed \(daily_loss_limit\).*mode AUTO/);
  const src = readFileSync(new URL("../src/strategy-arm.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /(UPDATE|DELETE FROM)\s+strategy_arm_events/, "no code path updates or deletes the audit");
  assert.equal(dailyLossHit({ account: { equity: 940, day_start_balance: 1000 } }, 5), true);
  assert.equal(dailyLossHit({ account: { equity: 960, day_start_balance: 1000 } }, 5), false);
});

const plan = (rrr, at_level = true) => ({ entry: 3870, stop: 3880, tp1: 3870 - 10 * rrr, tp2: 3850, at_level, rrr: { tp1: rrr, tp2: 2 } });
const plans = { zone_pullback: { plan: plan(1.2, true) }, sweep_reversal: { plan: plan(1.6, false) }, breakout_retest: { plan: plan(1.6, true) } };
const speakers = [{ id: "zone_pullback", voice: 1 }, { id: "sweep_reversal", voice: 1.2 }, { id: "breakout_retest", voice: 1 }];
const conf = { zone_pullback: { short: 0.8 }, sweep_reversal: { short: 0.85 }, breakout_retest: { short: 0.8 } };
const quorum = { long_share: 0.05, short_share: 0.9 };
const strategy = { direction: "SHORT", alignment: 0.6 };
const opts = { entryType: "limit", target: "tp1", minRrr: 0 };

test("SA3. AUTO: one strategy, the best confidence x confluence; ties to the better R; the losers are kept", () => {
  const p = pickStrategy({ side: "short", speakers, plans, agentConfidence: conf, quorum, strategy, armed: [], stance: "SELL", opts });
  // confluence = (at_level + 0.9 + 0.6) / 3: at a level 0.83, not 0.5; scores 0.8*0.83=0.66, 0.85*0.5=0.43.
  assert.equal(p.mode, "auto");
  assert.equal(p.agent, "breakout_retest", "zone_pullback and breakout_retest tie at 0.66; the better R (1.6) wins");
  assert.deepEqual(p.candidates.map((c) => [c.id, c.score]), [["breakout_retest", 0.66], ["zone_pullback", 0.66], ["sweep_reversal", 0.43]]);
  assert.match(selectionLine(p), /\(AUTO\), score 0.66 = confidence × confluence, picked over .* 0.66, .* 0.43/);
  // Below MIN_CONFIDENCE: not eligible.
  const low = pickStrategy({ side: "short", speakers, plans, agentConfidence: { zone_pullback: { short: MIN_CONFIDENCE - 0.01 } }, quorum, strategy, armed: [], stance: "SELL", opts });
  assert.equal(low.agent, null);
});

test("SA4. ARMED: only the armed strategies; an armed strategy on the other side holds the entry; an unknown arm state holds it", () => {
  const armedPick = pickStrategy({ side: "short", speakers, plans, agentConfidence: conf, quorum, strategy, armed: ["sweep_reversal"], stance: "SELL", opts });
  assert.deepEqual([armedPick.mode, armedPick.agent, armedPick.candidates.length], ["armed", "sweep_reversal", 1]);
  assert.match(pickStrategy({ side: "short", speakers, plans, agentConfidence: conf, quorum, strategy, armed: ["range_fade"], stance: "SELL", opts }).reason, /no armed strategy sees its setup on the sell side/);
  const g = (arms, longSpeakers = []) => ({
    long: { allowed: false, checks: [], plans: {} },
    short: { allowed: true, checks: [], plans, min_rrr: 0, target_rule: "nearest" },
    strategy_execution: true, consensus: { lean: -0.6, long: longSpeakers, short: speakers }, agent_confidence: conf, arms
  });
  const answer = { stance: "SELL", bias: "BEARISH", confidence: 0.8, entry_type: "limit", target: "tp1" };
  const auto = decide({ answer, guards: g({ mode: "live", known: true, ids: [] }), strategy, quorum: { ...quorum, bias: "BEARISH" } });
  assert.deepEqual([auto.stance, auto.trade?.agent, auto.selection.mode], ["SELL", "breakout_retest", "auto"]);
  const conflict = decide({ answer, guards: g({ mode: "live", known: true, ids: ["range_fade"] }, [{ id: "range_fade", voice: 1 }]), strategy, quorum: { ...quorum, bias: "BEARISH" } });
  assert.deepEqual([conflict.stance, conflict.overruled.by], ["WAIT", "strategy_arm"]);
  const unknown = decide({ answer, guards: g({ mode: "live", known: false, ids: [] }), strategy, quorum: { ...quorum, bias: "BEARISH" } });
  assert.deepEqual([unknown.stance, unknown.overruled.failed[0].detail], ["WAIT", "the arm state could not be read"]);
  // Arm mode off: today's choice (the council's, else the strongest voice), no selection.
  const off = decide({ answer, guards: g(undefined), strategy, quorum: { ...quorum, bias: "BEARISH" } });
  assert.equal(off.selection, null);
});

test("SA5. at signal time: a strategy disarmed since the decision has no side; the signal says the mode; Omega's confidence-drop close is the armed strategy's", () => {
  const sig = { side: "SELL", signal_id: "k", trade_agent: "zone_pullback", entry: 1, stop: 2, tp1: 0.5, action: "ENTER_LIMIT" };
  assert.deepEqual([applyArmGate(sig, { known: true, ids: [] }).side, applyArmGate(sig, { known: true, ids: [] }).arm_mode], ["SELL", "auto"]);
  const gated = applyArmGate(sig, { known: true, ids: ["sweep_reversal"] });
  assert.deepEqual([gated.side, gated.awaiting_reason, gated.armed], ["NONE", "strategy_disarmed", "sweep_reversal"]);
  assert.equal(applyArmGate(sig, { known: false, ids: [] }).awaiting_reason, "strategy_arm_unknown");
  const now = Date.parse("2026-11-17T10:00:00Z");
  const positions = [{ ticket: 1, side: "SELL", open_price: 3880, intent_id: "open:1:S", magic: 20251109, comment: "omega" }];
  const signal = (armed) => ({ strategy_execution: true, power: -0.5, power_ms: now - 60_000, agent_conf: "zone_pullback:0.3:0.6", agent_conf_prev: "zone_pullback:0.3:0.8", armed });
  const sym = { bid: 3870, ask: 3870.2 };
  assert.equal(strategyExits({ positions, signal: signal(""), sym, agents: { "open:1:S": "zone_pullback" }, now }).intents.length, 1, "AUTO: its own confidence drop closes it");
  assert.equal(strategyExits({ positions, signal: signal("sweep_reversal"), sym, agents: { "open:1:S": "zone_pullback" }, now }).intents.length, 0, "not armed: it does not close by its own rule");
});

test("SA6. owner only (RFC §11.3): OWNER_ACCESS_SUB set → only that Access sub arms or disarms; unset → bootstrap records each sub once", async () => {
  resetStrategyArmSchemaCacheForTests();
  const OWNER = "7c1d2e3f-aaaa-bbbb-cccc-0123456789ab";
  assert.equal(ownerCheck({}, OWNER), "unset");
  assert.equal(ownerCheck({ OWNER_ACCESS_SUB: OWNER }, OWNER), "owner");
  assert.equal(ownerCheck({ OWNER_ACCESS_SUB: OWNER }, "someone-else-1234"), "not_owner");
  assert.equal(ownerCheck({ OWNER_ACCESS_SUB: OWNER }, null), "not_owner", "no sub (an old route) is refused once the var is set");
  const e = env({ OWNER_ACCESS_SUB: OWNER });
  assert.equal((await setStrategyArm(e, { strategy_id: "zone_pullback", action: "arm", allowed, actor_sub: "someone-else-1234" })).error, "owner_only");
  assert.equal((await setStrategyArm(e, { strategy_id: "zone_pullback", action: "arm", allowed, actor_sub: null })).error, "owner_only");
  assert.equal((await setStrategyArm(e, { strategy_id: "zone_pullback", action: "arm", allowed, actor_sub: OWNER })).ok, true);
  assert.equal((await disarmAll(e, { reason: "kill_switch" })).status, "disarmed", "the system's auto-disarm needs no owner sub");
  // Bootstrap: unset var → the arm works as before, and the visitor's sub is noted once.
  const b = env();
  b.raw.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT)");
  assert.equal(await noteOwnerSub(b, { sub: OWNER, actor: "owner@example.com" }), true);
  assert.equal(await noteOwnerSub(b, { sub: OWNER, actor: "owner@example.com" }), false, "once per sub");
  assert.equal(await noteOwnerSub(b, { sub: "bad sub!", actor: "x" }), false);
  assert.equal(await noteOwnerSub({ ...b, OWNER_ACCESS_SUB: OWNER }, { sub: "another-sub-5678", actor: "x" }), false, "nothing is recorded once the var is set");
  const rows = b.raw.prepare("SELECT actor, action, detail FROM omega_events").all();
  assert.deepEqual(rows.map((r) => [r.actor, r.action, JSON.parse(r.detail).sub]), [["owner@example.com", "owner_sub_seen", OWNER]]);
  assert.equal((await setStrategyArm(b, { strategy_id: "zone_pullback", action: "arm", allowed, actor_sub: OWNER })).ok, true);
});
