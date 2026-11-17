// Council proposals, phase 2: the knob replay, the gate, going live by itself and rolling back by itself.
import test from "node:test";
import assert from "node:assert/strict";
import { seedEnv } from "./support/cfc-fixtures.mjs";
import { sideUnder, knobEvidence, decisionRow, runKnobProposals, KNOB_GATE } from "../src/council-knob-tuning.mjs";
import { readKnobOverrides, resetKnobCache, checkKnobValue, knobMenu, KNOBS_KEY } from "../src/council-knobs.mjs";
import { modeThresholds, minConfidenceOf, decide } from "../src/decision-engine.mjs";
import { ensureSessionSchema, resetSessionSchemaForTests } from "../src/cfc-session.mjs";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const MIN = 60_000;
// A recorded decision: stance, bias, confidence, quorum, per-side checks, and its plans' outcomes (e0@s1).
function decision(i, { stance = "SELL", bias = "BEARISH", confidence = 0.6, mode = "scalp", short = 0.7, long = 0.2, score = -0.3, quorumFailsShort = false, rrr = null, rShort = 1, rLong = -1, at = null } = {}) {
  const key = `OANDA:XAUUSD:15:${T0 + i * 15 * MIN}`;
  const checks = (q) => [{ id: "market_open", pass: true }, { id: "fresh", pass: true }, { id: "quorum", pass: q }, { id: "no_veto", pass: true }];
  return {
    decision_key: key, decided_at: at ?? new Date(T0 + i * 15 * MIN).toISOString(),
    decision_json: JSON.stringify({ stance, bias, confidence, trading_mode: mode, quorum: { long_share: long, short_share: short, score }, rules: { lean: 0.1 },
      guardrails: { long: { checks: checks(false) }, short: { checks: checks(!quorumFailsShort) } }, trade: rrr == null ? null : { rrr } }),
    setups: { SELL: JSON.stringify({ "e0@s1": { s: rShort > 0 ? "target" : "stop", r: rShort, f: 1 } }), BUY: JSON.stringify({ "e0@s1": { s: "stop", r: rLong, f: 1 } }) }
  };
}
const row = (d) => decisionRow(d, d.setups);

test("KT1. the replay: a stricter value drops a trade exactly; a looser one adds the bias's side only where its own check failed", () => {
  // min_confidence 0.5: a SELL taken at 0.45 confidence drops out; one at 0.6 stays.
  assert.equal(sideUnder(row(decision(1, { confidence: 0.45 })), "decision.min_confidence", 0.5), null);
  assert.equal(sideUnder(row(decision(2, { confidence: 0.6 })), "decision.min_confidence", 0.5), "SELL");
  // quorum_min.scalp 0.75: a SELL on 70% of the weight drops out (and the lean path: score -0.3 vs lean 0.1 with 70% > 20% still passes).
  assert.equal(sideUnder(row(decision(3, { short: 0.7, score: -0.05 })), "decision.quorum_min.scalp", 0.75), null);
  assert.equal(sideUnder(row(decision(3, { short: 0.7, score: -0.3 })), "decision.quorum_min.scalp", 0.75), "SELL", "the lean path still passes");
  // Looser: a WAIT whose short side failed only the quorum (42% vs 45%) trades at 0.4 when the bias is bearish.
  const wait = decision(4, { stance: "WAIT", short: 0.42, long: 0.5, score: -0.05, quorumFailsShort: true });
  assert.equal(sideUnder(row(wait), "decision.quorum_min.scalp", 0.4), "SELL");
  assert.equal(sideUnder(row(decision(4, { stance: "WAIT", bias: "NEUTRAL", short: 0.42, long: 0.5, score: -0.05, quorumFailsShort: true })), "decision.quorum_min.scalp", 0.4), null, "no bias, no estimate");
  // Looser confidence (exact): a council SELL overruled only by its confidence trades again at the lower floor.
  const over = decision(7, { stance: "WAIT", confidence: 0.42 }); const oj = JSON.parse(over.decision_json); oj.overruled = { wanted: "SELL", failed: [{ check: "confidence" }] };
  assert.equal(sideUnder(row({ ...over, decision_json: JSON.stringify(oj) }), "decision.min_confidence", 0.4), "SELL");
  // Another mode's knob leaves the decision as it was.
  assert.equal(sideUnder(row(decision(5, { confidence: 0.3 })), "decision.quorum_min.swing", 0.75), "SELL");
  // min_rrr (intraday): a trade below the new floor drops out.
  assert.equal(sideUnder(row(decision(6, { mode: "intraday", rrr: 1.6 })), "decision.min_rrr.intraday", 1.8), null);
});

test("KT2. the gate: enough changed decisions, a mean gain, the newest quarter not worse, a bootstrap bound above 0", () => {
  // 40 low-confidence SELLs that lost (drop them: +1R each) and 40 that are kept.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row(decision(i, { confidence: 0.42, rShort: -1 })));
  for (let i = 40; i < 80; i++) rows.push(row(decision(i, { confidence: 0.7, rShort: 1 })));
  const good = knobEvidence(rows, "decision.min_confidence", 0.5);
  assert.deepEqual([good.changed, good.removed, good.mean_gain_r, good.pass], [40, 40, 1, true]);
  // The same but the dropped trades won: worse.
  const bad = knobEvidence(rows.map((r, i) => i < 40 ? { ...r, r: { ...r.r, SELL: 1 } } : r), "decision.min_confidence", 0.5);
  assert.equal(bad.pass, false); assert.match(bad.reason, /mean gain -1R/);
  // Too few changed decisions.
  const few = knobEvidence(rows.slice(30), "decision.min_confidence", 0.5);
  assert.equal(few.pass, false); assert.match(few.reason, /10 of 30 changed decisions/);
});

test("KT3. the engine reads the live knobs, clamped to their bounds; the moderator sees the value in force", async () => {
  assert.equal(modeThresholds("scalp", { "decision.quorum_min.scalp": 0.55 }).quorum_min, 0.55);
  assert.equal(modeThresholds("scalp", { "decision.min_rrr.intraday": 2 }).min_rrr, 0, "another mode's knob does nothing");
  assert.equal(modeThresholds("intraday", { "decision.min_rrr.intraday": 1.8 }).min_rrr, 1.8);
  assert.equal(modeThresholds("intraday").quorum_min, 0.5, "no knobs: the code's values");
  assert.equal(minConfidenceOf({ COUNCIL_KNOBS: { "decision.min_confidence": 0.5 } }), 0.5);
  assert.equal(minConfidenceOf({}), 0.4);
  const guards = { long: { allowed: false, checks: [] }, short: { allowed: true, checks: [], plans: {} } };
  const d = decide({ answer: { stance: "SELL", bias: "BEARISH", confidence: 0.45, reasons: ["r"], risks: [], summary: "s", weighed: [] }, guards, quorum: { score: -0.5 }, minConfidence: 0.5 });
  assert.equal(d.overruled?.failed?.[0]?.check, "confidence", "0.45 is below the live floor of 0.5");
  const env = await seedEnv();
  resetKnobCache();
  await env.SIGNAL_CACHE.put(KNOBS_KEY, JSON.stringify({ live: { "decision.quorum_min.scalp": { value: 0.99 }, "unknown.knob": { value: 3 } } }));
  assert.deepEqual(await readKnobOverrides(env), { "decision.quorum_min.scalp": 0.65 }, "clamped to the registry's max; an unlisted knob is ignored");
  assert.equal(checkKnobValue("decision.quorum_min.scalp", 0.65, { "decision.quorum_min.scalp": 0.65 }).ok, false, "already in force");
  assert.equal(knobMenu({ "decision.quorum_min.scalp": 0.65 }).find((k) => k.id === "decision.quorum_min.scalp").current, 0.65);
  resetKnobCache();
});

async function seedDecisions(env, list) {
  for (const d of list) {
    const j = JSON.parse(d.decision_json);
    await env.DB.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, 'council', ?)").bind(d.decision_key, d.decided_at, d.decided_at, j.stance, j.confidence, d.decision_json).run();
    for (const [side, res] of Object.entries(d.setups)) await env.DB.prepare("INSERT INTO plan_setups (setup_key, decision_key, agent, opened_at, decided_at, last_seen_at, side, entry, stop, tp1, atr_h1, context, status, results_json, version, updated_at) VALUES (?, ?, 'zone_pullback', ?, ?, ?, ?, 1, 1, 1, 1, '{}', 'resolved', ?, 'v', ?)")
      .bind(`${d.decision_key}:${side}`, d.decision_key, d.decided_at, d.decided_at, d.decided_at, side, res, d.decided_at).run();
  }
}

test("KT4. a queued knob change goes live by itself when it proves better, and rolls back by itself when it then does worse", async () => {
  resetSessionSchemaForTests(); resetKnobCache();
  const env = await seedEnv();
  await ensureSessionSchema(env.DB);
  const { DECISION_SCHEMA_SQL } = await import("../src/decision-engine.mjs");
  const { PLAN_LEARNING_SCHEMA_SQL } = await import("../src/plan-learning.mjs");
  for (const q of [...DECISION_SCHEMA_SQL, ...PLAN_LEARNING_SCHEMA_SQL]) await env.DB.prepare(q).run();
  const now = T0 + 30 * 86_400_000;
  const list = [];
  for (let i = 0; i < 40; i++) list.push(decision(i, { confidence: 0.42, rShort: -1 }));
  for (let i = 40; i < 60; i++) list.push(decision(i, { confidence: 0.7, rShort: 1 }));
  await seedDecisions(env, list);
  const add = async (id, knob, from, value, state = "queued_shadow", ms = now - 86_400_000) => env.DB.prepare("INSERT INTO council_proposals (id, session_id, option_id, kind, title, knob, from_value, value, spec, option_json, state, note, report_id, accepted_by, accepted_ms, updated_ms) VALUES (?, 's', 'o', 'policy_parameter', 't', ?, ?, ?, NULL, '{}', ?, NULL, NULL, 'owner', ?, ?)").bind(id, knob, from, value, state, ms, ms).run();
  await add("cp_old", "decision.min_confidence", 0.4, 0.45, "queued_shadow", now - 2 * 86_400_000);
  await add("cp_new", "decision.min_confidence", 0.4, 0.5);
  await add("cp_code", "agents.max_risk_atr", 2.5, 2);
  const sent = [], published = [];
  const publish = async (_e, agent, report) => { published.push(report.body); return { outcome: "success" }; };
  const r = await runKnobProposals(env, { now, send: async (t) => sent.push(t), publish });
  assert.equal(r.status, "ok", JSON.stringify(r));
  const state = async (id) => (await env.DB.prepare("SELECT state, note FROM council_proposals WHERE id = ?").bind(id).first());
  assert.equal((await state("cp_new")).state, "live");
  assert.equal((await state("cp_old")).state, "superseded");
  assert.equal((await state("cp_code")).state, "rejected");
  assert.match(sent[0], /Council knob live: decision.min_confidence 0.4 → 0.5/);
  assert.deepEqual([published[0].schema, published[0].state, published[0].knob, published[0].value], ["typed_proposal.v1", "live", "decision.min_confidence", 0.5]);
  resetKnobCache();
  assert.deepEqual(await readKnobOverrides(env, { now }), { "decision.min_confidence": 0.5 });
  assert.equal((await runKnobProposals(env, { now, publish })).status, "fresh", "once a UTC day");

  // After it went live: 25 council SELLs at 0.42 confidence that the live floor (0.5) overruled to WAIT, and that would
  // have won. The old value (0.4) would have done better: roll back, and never try 0.5 again.
  const later = [];
  for (let i = 0; i < 25; i++) {
    const d = decision(3000 + i, { stance: "WAIT", confidence: 0.42, rShort: 1, at: new Date(now + (i + 1) * 15 * MIN).toISOString() });
    const j = JSON.parse(d.decision_json); j.overruled = { by: "guardrail", wanted: "SELL", failed: [{ check: "confidence", detail: "below 50%" }] };
    later.push({ ...d, decision_json: JSON.stringify(j) });
  }
  await seedDecisions(env, later);
  const r2 = await runKnobProposals(env, { now: now + 2 * 86_400_000, send: async (t) => sent.push(t), publish });
  assert.equal(r2.status, "ok", JSON.stringify(r2));
  assert.equal((await state("cp_new")).state, "rolled_back", JSON.stringify(r2.actions));
  resetKnobCache();
  assert.deepEqual(await readKnobOverrides(env, { now: now + 2 * 86_400_000 }), {}, "back to the code's value");
  assert.match(sent.at(-1), /rolled back/);
  // The same value is never tried again.
  await add("cp_again", "decision.min_confidence", 0.4, 0.5, "queued_shadow", now + 2 * 86_400_000);
  await runKnobProposals(env, { now: now + 3 * 86_400_000, publish });
  assert.match((await state("cp_again")).note, /rolled back before/);
  resetKnobCache();
});
