// The strategy council (owner 2026-11-17: "council boleh langsung arm/disarm otomatis jika owner mengaktifkan mode
// auto"; confirmed "Setuju, kunci manual permanen"): verdicts every day; arm/disarm only with the owner's toggle under
// the code ceiling; the owner's manual click pins a strategy until the owner unpins it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { walkForward, allowedProposals, runStrategyCouncil, readCouncilState, setCouncilAuto, pinStrategy, unpinStrategy, readCouncilVerdicts, resetCouncilSchemaForTests, councilArmCeiling } from "../src/strategy-council.mjs";
import { setStrategyArm, readArmsFromDb, disarmAll, resetStrategyArmSchemaCacheForTests } from "../src/strategy-arm.mjs";
import { CONTROL_ARM } from "../src/plan-learning.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";

function env(over = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE plan_setups (agent TEXT, results_json TEXT, opened_at TEXT, status TEXT);
    CREATE TABLE signal_ledger (candle_key TEXT, omega_status TEXT, r_omega REAL, closed_at TEXT);
    CREATE TABLE engine_decisions (decision_key TEXT, decision_json TEXT);`);
  const wrap = (sql) => { let a = []; const s = { bind: (...x) => { a = x; return s; }, run: async () => { const r = db.prepare(sql).run(...a); return { ...r, meta: { changes: Number(r.changes) } }; }, first: async () => db.prepare(sql).get(...a) ?? null, all: async () => ({ results: db.prepare(sql).all(...a) }) }; return s; };
  const kv = new Map();
  return { DB: { prepare: wrap, batch: async (st) => { db.exec("BEGIN"); try { for (const s of st) await s.run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } },
    SIGNAL_CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) }, STRATEGY_ARM_MODE: "live", raw: db, kv, ...over };
}
const seed = (e, agent, rs, t0) => rs.forEach((r, i) => e.raw.prepare("INSERT INTO plan_setups VALUES (?, ?, ?, 'resolved')").run(agent, JSON.stringify({ [CONTROL_ARM]: { r, f: 1 } }), new Date(t0 - (rs.length - i) * 3_600_000).toISOString()));
const good = [...Array(40)].map((_, i) => 0.3 + (i % 4) * 0.1), bad = [...Array(40)].map((_, i) => -0.3 - (i % 3) * 0.1);
const allowed = ["zone_pullback", "sweep_reversal", "range_fade", "breakout_retest"];

test("SC1. walk-forward: pass, fail, collecting; the proposals the facts allow (never arm a failing strategy)", () => {
  assert.equal(walkForward(good).status, "pass");
  assert.equal(walkForward(bad).status, "fail");
  assert.equal(walkForward(good.slice(0, 20)).status, "collecting");
  assert.equal(walkForward([...good.slice(0, 28), ...bad.slice(0, 12)]).status, "fail", "the latest 30% below 0");
  assert.deepEqual(allowedProposals({ armed: false, walk: { status: "pass" }, liveBad: false }), ["keep", "arm"]);
  assert.deepEqual(allowedProposals({ armed: false, walk: { status: "fail" }, liveBad: false }), ["keep"]);
  assert.deepEqual(allowedProposals({ armed: true, walk: { status: "pass" }, liveBad: true }), ["keep", "disarm"]);
  assert.deepEqual(allowedProposals({ armed: true, walk: { status: "pass" }, liveBad: false }), ["keep"]);
});

test("SC2. ceiling off: verdicts and proposals only, the owner's toggle cannot be turned on; the model's answer is clamped", async () => {
  resetCouncilSchemaForTests(); resetStrategyArmSchemaCacheForTests(); resetAiUsageSchemaCacheForTests();
  const e = env(), t0 = Date.parse("2026-11-17T12:00:00Z");
  seed(e, "sweep_reversal", good, t0); seed(e, "range_fade", bad, t0);
  assert.equal(councilArmCeiling(e), "off");
  assert.match((await setCouncilAuto(e, { on: true, actor: "owner" })).error, /not allowed/);
  const calls = [];
  const call = async (_env, o) => { calls.push(JSON.parse(o.messages[1].content)); return { status: "answered", obj: { proposal: "arm", reason: "strong walk-forward" } }; };
  const r = await runStrategyCouncil(e, { now: t0, call, allowed });
  assert.deepEqual(r.proposals, ["sweep_reversal:arm"]);
  assert.equal(calls.length, 1, "a model call only where a change is possible");
  assert.deepEqual((await readArmsFromDb(e.DB)).ids, [], "proposals only: nothing armed");
  const v = (await readCouncilVerdicts(e)).verdicts;
  assert.deepEqual([v.sweep_reversal.walk_forward.status, v.range_fade.walk_forward.status, v.range_fade.proposal], ["pass", "fail", "keep"]);
  assert.equal((await runStrategyCouncil(e, { now: t0 + 3_600_000, call })).status, "fresh", "once a UTC day");
  // A model that answers outside the allowed options: keep.
  const e2 = env(); seed(e2, "range_fade", bad, t0); resetCouncilSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const r2 = await runStrategyCouncil(e2, { now: t0, call: async () => ({ status: "answered", obj: { proposal: "arm", reason: "x" } }), allowed });
  assert.deepEqual(r2.proposals, []);
});

test("SC3. ceiling allowed + toggle on: the council arms and disarms within its guards; pins, one change a day, system disarm, max 3", async () => {
  resetCouncilSchemaForTests(); resetStrategyArmSchemaCacheForTests(); resetAiUsageSchemaCacheForTests();
  const e = env({ STRATEGY_COUNCIL_ARM: "allowed" }), t0 = Date.parse("2026-11-17T12:00:00Z"), sent = [];
  seed(e, "sweep_reversal", good, t0); seed(e, "breakout_retest", good, t0); seed(e, "range_fade", bad, t0);
  assert.equal((await setCouncilAuto(e, { on: true, actor: "owner@example.com", actor_sub: "sub-1", now: t0 - 7_200_000 })).ok, true);
  assert.equal((await readCouncilState(e)).acting, true);
  const audit = (await e.DB.prepare("SELECT auto, actor, actor_sub FROM strategy_council_toggle_events ORDER BY id").all()).results;
  assert.deepEqual(audit.map((x) => ({ ...x })), [{ auto: 1, actor: "owner@example.com", actor_sub: "sub-1" }], "every click of the toggle is audited");
  // The owner armed range_fade by hand today → pinned; breakout_retest pinned (disarmed by hand) yesterday.
  await setStrategyArm(e, { strategy_id: "range_fade", action: "arm", allowed, actor: "owner@example.com", now: t0 - 3_600_000 });
  await pinStrategy(e, { strategy_id: "range_fade", actor: "owner@example.com", action: "arm" });
  await pinStrategy(e, { strategy_id: "breakout_retest", actor: "owner@example.com", action: "disarm" });
  const call = async (_env, o) => { const m = JSON.parse(o.messages[1].content); return { status: "answered", obj: { proposal: m.allowed_proposals.includes("arm") ? "arm" : "disarm", reason: "per its record" } }; };
  const r = await runStrategyCouncil(e, { now: t0, call, allowed, send: async (t) => sent.push(t) });
  const v = (await readCouncilVerdicts(e)).verdicts;
  assert.deepEqual(r.applied, [{ id: "sweep_reversal", action: "arm" }]);
  assert.equal(v.breakout_retest.applied, "skipped: pinned by the owner");
  assert.equal(v.range_fade.applied, "skipped: pinned by the owner", "a failing pinned strategy stays armed: the owner's click wins");
  assert.deepEqual((await readArmsFromDb(e.DB)).ids.sort(), ["range_fade", "sweep_reversal"]);
  const ev = e.raw.prepare("SELECT strategy_id, action, actor, reason FROM strategy_arm_events WHERE actor = 'council'").all();
  assert.deepEqual(ev.map((x) => [x.strategy_id, x.action, x.reason]), [["sweep_reversal", "arm", "council"]]);
  assert.match(sent[0], /Strategy sweep_reversal armed .*\nCouncil: per its record/);
  // Unpin → the next day the council may disarm the failing range_fade.
  await unpinStrategy(e, { strategy_id: "range_fade" });
  const r2 = await runStrategyCouncil(e, { now: t0 + 86_400_000, call, allowed });
  assert.ok(r2.applied.some((x) => x.id === "range_fade" && x.action === "disarm"));
  // A system auto-disarm today: no council arm today.
  await disarmAll(e, { reason: "kill_switch", now: t0 + 2 * 86_400_000 });
  const r3 = await runStrategyCouncil(e, { now: t0 + 2 * 86_400_000 + 60_000, call, allowed });
  assert.deepEqual(r3.applied, []);
  assert.match((await readCouncilVerdicts(e)).verdicts.sweep_reversal.applied, /skipped: (the system disarmed today|changed today already)/);
  // A council failure changes nothing.
  const r4 = await runStrategyCouncil(e, { now: t0 + 3 * 86_400_000, call: async () => { throw new Error("down"); }, allowed });
  assert.deepEqual(r4.applied, []);
});
