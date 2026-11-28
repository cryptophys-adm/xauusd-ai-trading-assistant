// CFC-A PR2 (2026-11-28): the council decides by itself in CFC_MODE "auto" (A2), the hand-off says so (A3), the
// options report is council_options.v1 (legacy_schema council_decision.v1), and the archive filters by scope and status
// with counts over the window. No network: the in-memory D1 of the council fixtures and an injected model and publisher.
import test from "node:test";
import assert from "node:assert/strict";
import { seedEnv, seedTrades } from "./support/cfc-fixtures.mjs";
import { startSession, closeSession, runSessionStep, readSession, setSessionsSwitch, retryProposalHandoffs, councilPick, resetSessionSchemaForTests, VETO_WINDOW_MS, OPTIONS_SCHEMA, OPTIONS_SCHEMA_LEGACY, COUNCIL_QUORUM } from "../src/cfc-session.mjs";
import { chainState, readCouncilArchive, ARCHIVE_SCOPES } from "../src/cfc-lifecycle.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";

async function setup(over = {}) {
  resetSessionSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const env = await seedEnv();
  Object.assign(env, { CFC_MODE: "auto" }, over);
  await seedTrades(env, { agent: "zone_pullback", n: 6, exits: [["stop", "sl_plus"], ["target", "target"]], start: Date.now() - 3 * 86_400_000 });
  await setSessionsSwitch(env, { on: true });
  return env;
}
const enqueue = async () => {};
// Seats: the Risk Manager opposes, the rest support (5 of 6), unless `oppose` names more. The moderator's options come
// from `options`.
function model({ options, oppose = ["Risk"], silent = [] } = {}) {
  return async (_env, o) => {
    if (o.schemaName === "cfc_synthesis") return { status: "answered", obj: { summary: "s", options } };
    const seat = /You are ([^,]+),/.exec(o.messages[0].content)?.[1] ?? "?";
    if (silent.some((x) => seat.includes(x))) return { status: "failed" };
    return { status: "answered", obj: { stance: oppose.some((x) => seat.includes(x)) ? "oppose" : "support", opinion: `I think so (${seat}).`, proposal: "p", refs: [], reply_to: [] } };
  };
}
const TASK = [{ option_id: "wider_lock", kind: "repository_task", title: "Lock SL+ one level later", hypothesis: "fewer early exits", change: "SL+ after the second key level", risk: "give-backs", spec: "move the SL+ lock to the second key level; measure R per trade" }];
const KNOB = [{ option_id: "rrr", kind: "policy_parameter", title: "Ask more reward intraday", hypothesis: "h", change: "c", risk: "r", knob: "decision.min_rrr.intraday", value: 1.8 }];
async function runToSynthesis(env, { options, oppose, silent, now = Date.now() } = {}) {
  const { session_id } = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue, now });
  const published = [];
  const publish = async (_e, agent, report) => { published.push({ agent, report }); return { outcome: "success", report_id: `rpt_${published.length}` }; };
  const call = model({ options, oppose, silent });
  for (const step of ["positions", "rebuttals"]) await runSessionStep(env, { session_id, step }, { call, publish, enqueue, now });
  const syn = await runSessionStep(env, { session_id, step: "synthesis" }, { call, publish, enqueue, now });
  return { session_id, syn, published, publish };
}
const proposalOf = (env, session_id) => env.DB.prepare("SELECT * FROM council_proposals WHERE session_id = ?").bind(session_id).first();

test("AD-1 councilPick: a quorum of 4 seats; the top option when support >= max(4, 2/3 of those who spoke) and it is valid; otherwise no_change", () => {
  const seats = (support, other = 0) => [...Array(support).fill({ stance: "support" }), ...Array(other).fill({ stance: "oppose" })];
  const task = { option_id: "t", kind: "repository_task", spec: "build it" };
  const knob = { option_id: "k", kind: "policy_parameter", knob: "decision.min_rrr.intraday", value: 1.8 };
  const nc = { option_id: "no_change", kind: "no_change" };
  assert.equal(COUNCIL_QUORUM, 4);
  // Fewer than 4 seats spoke: no auto-decision, whatever they said (the owner picks).
  for (const n of [1, 3]) {
    const q = councilPick([task, nc], seats(n));
    assert.deepEqual([q.quorum, q.option_id, q.decided_by], [false, null, null], `${n} spoke, all support`);
    assert.match(q.rationale, new RegExp(`^no quorum \\(${n} spoke; needs 4\\)$`));
  }
  assert.deepEqual([councilPick([task, nc], seats(4)).option_id, councilPick([task, nc], seats(4)).need], ["t", 4], "4 spoke, all support: max(4, 3) = 4");
  assert.equal(councilPick([task, nc], seats(4, 2)).option_id, "t", "6 spoke, 4 support: exactly 4/6");
  const three = councilPick([task, nc], seats(3, 3));
  assert.deepEqual([three.quorum, three.option_id, three.need], [true, "no_change", 4], "6 spoke, 3 support: quorum, too little support");
  assert.equal(councilPick([task, nc], seats(4, 1)).need, 4, "5 spoke: max(4, ceil(10/3)) = 4");
  assert.equal(councilPick([knob, nc], seats(5, 1)).option_id, "k", "a knob inside its bounds");
  const bad = councilPick([{ ...knob, value: 9 }, nc], seats(6));
  assert.deepEqual([bad.option_id, bad.valid], ["no_change", false]);
  assert.match(bad.rationale, /^no_change: the knob change is not valid/);
  assert.equal(councilPick([{ ...task, spec: " " }, nc], seats(6)).option_id, "no_change", "a task needs a spec");
  assert.equal(councilPick([nc], seats(6)).option_id, "no_change");
  const p = councilPick([nc, task], seats(4, 2));
  assert.deepEqual([p.option_id, p.top, p.decided_by, p.tally.support, p.spoke], ["t", "t", "council", 4, 6], "the top option other than no_change, whatever its place");
  assert.match(p.rationale, /^t: 4 of 6 seats support \(needs 4\); the task has a spec$/);
});

test("AD-2 auto: the council picks a task; it waits 2 h for the owner's veto, then goes to the platform as chosen_by council", async () => {
  const env = await setup();
  const t0 = Date.now();
  const { session_id, syn, published, publish } = await runToSynthesis(env, { options: TASK, now: t0 });
  assert.deepEqual([syn.status, syn.pick, syn.decided_by, syn.proposal.state], ["decided", "wider_lock", "council", "veto_window"]);
  assert.equal((await readSession(env, session_id)).state, "decided");
  assert.equal(published.length, 1, "only the options report: no hand-off inside the veto window");
  assert.deepEqual([published[0].report.body.schema, published[0].report.body.legacy_schema], [OPTIONS_SCHEMA, OPTIONS_SCHEMA_LEGACY]);
  assert.deepEqual([OPTIONS_SCHEMA, OPTIONS_SCHEMA_LEGACY], ["council_options.v1", "council_decision.v1"]);
  const p = await proposalOf(env, session_id);
  assert.deepEqual([p.state, p.accepted_by], ["veto_window", "council"]);
  const d = JSON.parse(p.decision_json);
  assert.deepEqual([d.option_id, d.decided_by, d.tally.support, d.tally.oppose, d.spoke, d.need], ["wider_lock", "council", 5, 1, 6, 4]);
  // Before the window ends the hourly retry sends nothing; after it, the task is handed off.
  assert.equal((await retryProposalHandoffs(env, { publish, now: t0 + VETO_WINDOW_MS - 60_000 })).pending, 0);
  const r = await retryProposalHandoffs(env, { publish, now: t0 + VETO_WINDOW_MS + 1 });
  assert.deepEqual([r.pending, r.sent], [1, 1]);
  const body = published.at(-1).report.body;
  assert.deepEqual([body.schema, body.state, body.chosen_by, body.topic_approved_by, body.session_id], ["typed_proposal.v1", "handed_off", "council", "owner", session_id]);
  assert.deepEqual([body.council_decision.tally.support, body.council_decision.need], [5, 4]);
  assert.equal((await proposalOf(env, session_id)).state, "handed_off");
  assert.ok(!JSON.stringify(body).includes("@"), "no email in the hand-off");
});

test("AD-3 the owner's veto: Close inside the window stops the task; it is never handed off; the window cannot be closed twice", async () => {
  const env = await setup();
  const t0 = Date.now();
  const { session_id, published, publish } = await runToSynthesis(env, { options: TASK, now: t0 });
  // The actor is the Access email Omega passes; it is stored as sent, and every read shows "owner" (CF2a).
  const v = await closeSession(env, { session_id, actor: "owner@example.com", now: t0 + 60_000 });
  assert.deepEqual([v.ok, v.state, v.proposal_state], [true, "decided", "vetoed"]);
  assert.equal((await proposalOf(env, session_id)).state, "vetoed");
  assert.equal((await proposalOf(env, session_id)).note, "vetoed by owner@example.com", "the stored row is not rewritten");
  const chain = (await readCouncilArchive(env)).items.find((c) => c.session?.id === session_id);
  assert.equal(chain.proposal.note, "vetoed by owner", "CF2a: the archive masks the actor in the note");
  assert.ok(!JSON.stringify(chain).includes("@"), "no email anywhere in the chain");
  assert.equal((await retryProposalHandoffs(env, { publish, now: t0 + VETO_WINDOW_MS + 1 })).pending, 0);
  assert.equal(published.length, 1, "nothing handed off");
  assert.match((await closeSession(env, { session_id, actor: "owner" })).error, /already decided/);
  assert.deepEqual(chainState({ proposal: { state: "vetoed" } }), { status: "vetoed", source: "proposal", next_actor: "none" });
  assert.deepEqual(chainState({ proposal: { state: "veto_window" } }), { status: "veto_window", source: "proposal", next_actor: "owner" });
});

test("AD-4 auto: a knob goes to its shadow test at once; too little support is no_change; CFC_MODE on still waits for the owner", async () => {
  const env = await setup();
  const k = await runToSynthesis(env, { options: KNOB });
  assert.deepEqual([k.syn.pick, k.syn.proposal.state], ["rrr", "queued_shadow"], "a knob change is harmless in shadow: no veto window");
  const n = await runToSynthesis(env, { options: TASK, oppose: ["Risk", "Technical", "Projection"] });
  assert.deepEqual([n.syn.pick, n.syn.proposal.state], ["no_change", "closed"]);
  assert.match(JSON.parse((await proposalOf(env, n.session_id)).decision_json).rationale, /^no_change: 3 of 6 seats support \(needs 4\)/);
  // Only 3 of the 6 seats speak: no quorum, so no auto-decision; the session waits for the owner and says why.
  const q = await runToSynthesis(env, { options: TASK, silent: ["Projection", "Trade", "Interstellar"] });
  assert.deepEqual([q.syn.status, q.syn.pick, q.syn.quorum, q.syn.spoke], ["awaiting_owner", null, false, 3]);
  const qs = await readSession(env, q.session_id);
  assert.deepEqual([qs.state, qs.reason], ["awaiting_owner", "no quorum (3 of 6 spoke)"]);
  assert.equal(await proposalOf(env, q.session_id), null, "no proposal: the owner picks");
  const qa = await readCouncilArchive(env, { scope: "active" });
  assert.equal(qa.items.find((c) => c.chain_id === `session:${q.session_id}`).next_actor, "owner");
  const on = await setup({ CFC_MODE: "on" });
  const o = await runToSynthesis(on, { options: TASK });
  assert.equal(o.syn.status, "awaiting_owner", "only auto decides by itself");
  assert.equal(await proposalOf(on, o.session_id), null);
});

test("AD-5 the archive: scope active | archive, a status filter, counts over the window; the council's decision on its proposal", async () => {
  const env = await setup();
  const a = await runToSynthesis(env, { options: TASK });
  const b = await runToSynthesis(env, { options: TASK, oppose: ["Risk", "Technical", "Projection"] });
  const all = await readCouncilArchive(env);
  assert.deepEqual([all.total, all.counts.total, all.counts.active, all.counts.archive], [2, 2, 1, 1]);
  assert.deepEqual(all.counts.by_status, { veto_window: 1, no_change: 1 });
  assert.deepEqual(all.counts.by_next_actor, { owner: 1, none: 1 });
  const active = await readCouncilArchive(env, { scope: "active" });
  assert.deepEqual([active.scope, active.total, active.items[0].chain_id, active.items[0].status, active.counts.total], ["active", 1, `session:${a.session_id}`, "veto_window", 2], "the counts stay over the whole window");
  assert.equal(active.items[0].proposal.council_decision.option_id, "wider_lock");
  assert.equal(active.items[0].proposal.decided_by, "council");
  const arch = await readCouncilArchive(env, { scope: "archive" });
  assert.deepEqual([arch.total, arch.items[0].chain_id, arch.items[0].next_actor], [1, `session:${b.session_id}`, "none"]);
  const st = await readCouncilArchive(env, { status: "no_change" });
  assert.deepEqual([st.status_filter, st.total], ["no_change", 1]);
  assert.equal((await readCouncilArchive(env, { scope: "bogus", status: "Drop Table" })).total, 2, "an unknown scope or a bad status is ignored");
  assert.deepEqual(ARCHIVE_SCOPES, ["active", "archive"]);
  assert.ok(all.vocab.decided_by.includes("legacy"));
  assert.ok(all.vocab.chain_status.includes("veto_window") && all.vocab.chain_status.includes("vetoed"));
});
