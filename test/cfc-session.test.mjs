// Call for Councils P2 (owner 2026-11-17: "pendapat masing-masing agent bukan detail evidences"; confirmed "Setuju +
// topik bebas"): sessions where each seat gives its own opinion, then rebuttals, the moderator's options, the owner's
// messages answered; a suggested topic or free text; limits; the pick goes to the platform (Cerebrum).
import test from "node:test";
import assert from "node:assert/strict";
import { seedEnv, seedTrades } from "./support/cfc-fixtures.mjs";
import { startSession, ownerMessage, closeSession, reopenSession, acceptOption, retryProposalHandoffs, listProposals, proposalReport, packForPrompt, runSessionStep, readSession, listSessions, setSessionsSwitch, sessionsEnabled, cleanSeat, cleanOptions, slugOf, resetSessionSchemaForTests, ensureSessionSchema, SESSION_LIMITS } from "../src/cfc-session.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";

async function setup(over = {}) {
  resetSessionSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const env = await seedEnv();
  Object.assign(env, { CFC_MODE: "on" }, over);
  await seedTrades(env, { agent: "zone_pullback", n: 6, exits: [["stop", "sl_plus"], ["target", "target"]], start: Date.now() - 3 * 86_400_000 });
  return env;
}
const queue = [];
const enqueue = async (t) => { queue.push(t); };
// A model that speaks each seat's opinion and the moderator's options; refs: one from the pack and one invented.
function model({ fail = [] } = {}) {
  const calls = [];
  const call = async (_env, o) => {
    calls.push(o.schemaName);
    if (o.schemaName === "cfc_synthesis") return { status: "answered", obj: { summary: "Most want a wider SL+ lock.", options: [{ option_id: "wider_lock", title: "Lock SL+ one level later", hypothesis: "fewer early exits", change: "SL+ after the second key level", risk: "bigger give-backs" }] } };
    const seat = /You are ([^,]+),/.exec(o.messages[0].content)?.[1] ?? "?";
    if (fail.includes(seat)) return { status: "failed" };
    const pack = JSON.parse(o.messages[1].content);
    return { status: "answered", obj: { stance: seat.includes("Risk") ? "oppose" : "support", opinion: `I think the stops are too tight, because the pack shows it (${seat}).`, proposal: "Try a later SL+ lock", refs: ["ev:xauusd/made/up#x"], reply_to: [] , _owner: pack.owner_message ?? null } };
  };
  return { call, calls };
}

test("CS1. off until CFC_MODE is on AND the owner's switch is on; free text opens a free:<slug> session", async () => {
  const env = await setup({ CFC_MODE: "suggest" });
  assert.equal(await sessionsEnabled(env), false);
  assert.match((await startSession(env, { text: "Key Level entry SL / SL+", enqueue })).error, /off/);
  env.CFC_MODE = "on";
  assert.equal(await sessionsEnabled(env), false, "the owner's switch is off by default");
  await setSessionsSwitch(env, { on: true, actor: "owner@example.com" });
  assert.equal(await sessionsEnabled(env), true);
  assert.equal(slugOf("Key Level entry SL / SL+"), "key-level-entry-sl-sl");
  queue.length = 0;
  const r = await startSession(env, { text: "Key Level entry SL / SL+", enqueue });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(queue, [{ kind: "council_step", session_id: r.session_id, step: "positions" }]);
  const s = await readSession(env, r.session_id);
  assert.deepEqual([s.topic_key, s.topic_text, s.question, s.state], ["free:key-level-entry-sl-sl", "Key Level entry SL / SL+", "Key Level entry SL / SL+", "positions"]);
  assert.equal(s.participants.length, 6);
});

test("CS2. a full session: opinions in each seat's voice, rebuttals by the dissent and the Risk Manager, options with no_change, the owner answered; 16 calls at most; options to the platform", async () => {
  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  queue.length = 0;
  const { session_id } = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue });
  const m = model(), published = [];
  const publish = async (_e, agent, report) => { published.push({ agent, report }); return { outcome: "success" }; };
  const step = async (name) => runSessionStep(env, { session_id, step: name }, { call: m.call, publish, enqueue });
  assert.equal((await step("positions")).spoke, 6);
  assert.equal((await step("rebuttals")).status, "rebuttals");
  const syn = await step("synthesis");
  assert.equal(syn.status, "awaiting_owner");
  const s = await readSession(env, session_id);
  const pos = s.messages.filter((x) => x.round === "position");
  assert.equal(pos.length, 6);
  assert.match(pos[0].opinion, /^I think/);
  assert.ok(pos.every((x) => x.refs.length === 0), "a ref the pack does not hold is dropped");
  const reb = s.messages.filter((x) => x.round === "rebuttal").map((x) => x.seat);
  assert.ok(reb.includes("risk") && reb.length <= 4, "the dissent (risk) and the majority's holder speak");
  assert.deepEqual(s.options.options.map((o) => o.option_id), ["wider_lock", "no_change"], "no_change is always an option");
  assert.equal(published[0].agent, "xauusd-moderator");
  assert.equal(published[0].report.body.schema, "council_options.v1");
  assert.equal(published[0].report.body.legacy_schema, "council_decision.v1", "the window: the platform reads both names");
  // The owner writes to two seats; they answer.
  queue.length = 0;
  assert.deepEqual((await ownerMessage(env, { session_id, text: "Why not lock at break-even?", to: ["risk", "technical", "m15"], enqueue })).answered_by, ["risk", "technical"]);
  assert.deepEqual(queue, [{ kind: "council_step", session_id, step: "answer" }]);
  assert.equal((await step("answer")).answers, 2);
  const after = await readSession(env, session_id);
  assert.ok(after.calls <= SESSION_LIMITS.calls);
  assert.deepEqual(after.messages.filter((x) => x.round === "answer").map((x) => x.seat), ["risk", "technical"]);
  assert.equal(after.messages.find((x) => x.round === "owner").name, "Owner");
});

test("CS3. fewer than 3 valid opinions abort; the switch off aborts; limits on open and daily sessions; cleaners", async () => {
  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  const { session_id } = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue });
  const m = model({ fail: ["Risk Manager", "Technical Analyst", "Projection Agent", "15m Desk"] });
  const r = await runSessionStep(env, { session_id, step: "positions" }, { call: m.call, enqueue });
  assert.equal(r.status, "aborted");
  const b = await startSession(env, { topic_key: "strategy:zone_pullback", enqueue });
  await setSessionsSwitch(env, { on: false });
  assert.equal((await runSessionStep(env, { session_id: b.session_id, step: "positions" }, { call: model().call, enqueue })).reason, "council sessions were switched off");
  await setSessionsSwitch(env, { on: true });
  await startSession(env, { topic_key: "strategy:zone_pullback", enqueue });
  await startSession(env, { topic_key: "strategy:zone_pullback", enqueue });
  assert.match((await startSession(env, { topic_key: "strategy:zone_pullback", enqueue })).error, /at most (2 sessions open|4 sessions a day)/);
  assert.equal((await listSessions(env)).sessions.length, 4);
  assert.equal(cleanSeat({ stance: "maybe", opinion: "x" }, []), null);
  assert.deepEqual(cleanSeat({ stance: "amend", opinion: " I think so ", proposal: "", refs: ["ev:a", "ev:b"] }, ["ev:b"]).refs, ["ev:b"]);
  assert.equal(cleanOptions({ summary: "s", options: [] }).options[0].option_id, "no_change");
});

test("CS6. a topic whose pack holds no evidence is refused before any call; it does not count toward the day's sessions", async () => {
  resetSessionSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const env = Object.assign(await seedEnv(), { CFC_MODE: "on" });
  await setSessionsSwitch(env, { on: true, actor: "owner@example.com" });
  queue.length = 0;
  const r = await startSession(env, { text: "Evaluasi Strategy", enqueue });
  assert.equal(r.ok, false);
  assert.match(r.error, /no evidence for this topic/);
  assert.deepEqual(queue, [], "no step is queued, so no seat is called");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM council_sessions").first()).n, 0, "no session is stored");
  // With evidence, the same free topic opens and reads the default packs.
  await seedTrades(env, { agent: "zone_pullback", n: 6, exits: [["stop", "sl_plus"], ["target", "target"]], start: Date.now() - 3 * 86_400_000 });
  const ok = await startSession(env, { text: "Evaluasi Strategy", enqueue });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const pack = JSON.parse((await env.DB.prepare("SELECT pack_json FROM council_sessions WHERE id = ?").bind(ok.session_id).first()).pack_json);
  assert.ok(pack.refs.length > 0);
  assert.ok(pack.sections.scope.reads.includes("strategy:sweep_reversal"), "a strategy topic reads every strategy agent");
  assert.ok(pack.sections.strategy_council, "and the strategy council's verdicts");
});

test("CS7. the owner's Close and Re-open; an answer that fails leaves a visible notice; a message needs a seat; closed sessions do not count toward the day", async () => {
  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  const { session_id } = await startSession(env, { text: "Evaluasi Strategy", enqueue });
  const step = (name, call) => runSessionStep(env, { session_id, step: name }, { call, publish: async () => ({ outcome: "success" }), enqueue });
  await step("positions", model().call); await step("rebuttals", model().call); await step("synthesis", model().call);
  // A message must address a seat.
  assert.match((await ownerMessage(env, { session_id, text: "which strategy earns the most?", to: [], enqueue })).error, /pick 1 or 2 agents/);
  // The addressed seat's reply is cut off (2026-11-17): a notice, never silence.
  assert.equal((await ownerMessage(env, { session_id, text: "which strategy earns the most?", to: ["projection"], enqueue })).ok, true);
  await step("answer", async () => ({ status: "failed" }));
  const s = await readSession(env, session_id);
  const notice = s.messages.find((x) => x.round === "notice");
  assert.ok(notice && notice.seat === "projection", "a visible notice for the seat that could not answer");
  assert.match(notice.opinion, /could not answer: its reply was cut off or the model call failed/);
  assert.equal(s.terminal, false); assert.equal(s.pack_stale, false);
  // Re-open: a new session on the same topic and seats, the old one closed.
  queue.length = 0;
  const re = await reopenSession(env, { session_id, actor: "owner@example.com", enqueue });
  assert.equal(re.ok, true, JSON.stringify(re));
  assert.equal(re.reopened_from, session_id);
  const old = await readSession(env, session_id), fresh = await readSession(env, re.session_id);
  assert.equal(old.state, "closed"); assert.match(old.reason, /^reopened as /);
  assert.deepEqual([fresh.topic_key, fresh.topic_text, fresh.participants.length], [old.topic_key, old.topic_text, old.participants.length]);
  assert.deepEqual(queue, [{ kind: "council_step", session_id: re.session_id, step: "positions" }]);
  // A closed session takes no message and no step.
  assert.match((await ownerMessage(env, { session_id, text: "x", to: ["risk"], enqueue })).error, /closed/);
  assert.equal((await step("answer", model().call)).status, "closed");
  // Close; closing twice is refused.
  assert.equal((await closeSession(env, { session_id: re.session_id, actor: "owner@example.com" })).ok, true);
  assert.match((await closeSession(env, { session_id: re.session_id })).error, /already closed/);
  // Closed sessions do not count toward the 4 a day: 4 more start.
  for (let i = 0; i < 4; i++) {
    const r = await startSession(env, { topic_key: "strategy:zone_pullback", enqueue });
    assert.equal(r.ok, true, `start ${i}: ${JSON.stringify(r)}`);
    await closeSession(env, { session_id: r.session_id });
  }
  const list = await listSessions(env);
  assert.ok(list.sessions.every((x) => typeof x.pack_refs === "number" && typeof x.pack_stale === "boolean"));
});

test("CS8. a message to a session that ran on no evidence is refused with the offer to re-open", async () => {
  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  const { session_id } = await startSession(env, { text: "Evaluasi Strategy", enqueue });
  await env.DB.prepare("UPDATE council_sessions SET pack_json = ? WHERE id = ?").bind(JSON.stringify({ refs: [], sections: {} }), session_id).run();
  const r = await ownerMessage(env, { session_id, text: "strategy apa yang paling menguntungkan ?", to: ["projection"], enqueue });
  assert.equal(r.ok, false); assert.equal(r.reopen, true); assert.match(r.error, /no evidence/);
  const s = await readSession(env, session_id);
  assert.equal(s.pack_stale, true); assert.equal(s.pack_refs, 0);
  assert.equal(s.messages.filter((x) => x.round === "owner").length, 0, "nothing stored, no call queued");
});

test("CS9. the pack as the seats read it: a fair share per section and citable refs from every source; a ref without its @as_of still counts", () => {
  const pack = { sections: { a: { big: "x".repeat(20000) }, b: { small: 1 }, c: { small: 2 } },
    refs: ["ev:xauusd/engine_decisions/1#stance", "ev:xauusd/engine_decisions/2#stance", "ev:xauusd/plan_setups/9#results_json", "ev:xauusd/signal_ledger/d:1@2026-11-17T15:08:07Z"] };
  const { text, citable } = packForPrompt(pack, { chars: 3000 });
  assert.ok(text.includes('"b": {"small":1}') && text.includes('"c": {"small":2}'), "a big section no longer crowds out the others");
  assert.ok(text.length < 3500);
  assert.deepEqual(citable.slice(0, 3), ["ev:xauusd/engine_decisions/1#stance", "ev:xauusd/plan_setups/9#results_json", "ev:xauusd/signal_ledger/d:1@2026-11-17T15:08:07Z"], "one from each source first");
  const m = cleanSeat({ stance: "amend", opinion: "I think so", refs: ["ev:xauusd/signal_ledger/d:1", "ev:xauusd/made/up", "ev:xauusd/engine_decisions/2#stance"] }, pack.refs);
  assert.deepEqual(m.refs, ["ev:xauusd/signal_ledger/d:1@2026-11-17T15:08:07Z", "ev:xauusd/engine_decisions/2#stance"]);
});

test("CS10. typed options: a knob change only within the registry's bounds, anything else is code for the platform; Accept stores the proposal, decides the session and hands it to the platform (retried)", async () => {
  const opts = cleanOptions({ summary: "s", options: [
    { option_id: "rrr", kind: "policy_parameter", title: "Ask more reward intraday", hypothesis: "h", change: "c", risk: "r", knob: "decision.min_rrr.intraday", value: 1.83 },
    { option_id: "atr", kind: "policy_parameter", title: "ATR filter", hypothesis: "h", change: "add a 15m ATR filter", risk: "r", knob: "atr.filter", value: 2 },
    { option_id: "far", kind: "policy_parameter", title: "Too far", hypothesis: "h", change: "c", risk: "r", knob: "decision.quorum_min.scalp", value: 0.9 },
    { option_id: "code", kind: "repository_task", title: "New agent", hypothesis: "h", change: "c", risk: "r", spec: "build a momentum agent" }] }).options;
  assert.deepEqual(opts.map((o) => [o.option_id, o.kind]), [["rrr", "policy_parameter"], ["atr", "repository_task"], ["far", "repository_task"], ["code", "repository_task"], ["no_change", "no_change"]]);
  assert.deepEqual([opts[0].knob, opts[0].from, opts[0].value], ["decision.min_rrr.intraday", 1.5, 1.8], "rounded to the knob's step");
  assert.match(opts[1].spec, /not a valid knob change: unknown knob/);
  assert.match(opts[2].spec, /must stay within 0.45 to 0.65/);

  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  const { session_id } = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue });
  await env.DB.prepare("UPDATE council_sessions SET state = 'awaiting_owner', options = ? WHERE id = ?").bind(JSON.stringify({ summary: "s", options: opts }), session_id).run();
  const sent = [];
  const fail = async () => ({ outcome: "denied", reason: "rate limited" });
  const ok = async (_e, agent, report) => { sent.push({ agent, report }); return { outcome: "success", report_id: "rpt_1" }; };
  assert.match((await acceptOption(env, { session_id, option_id: "nope", publish: ok })).error, /unknown option/);
  // A code option: the platform refuses for now (rate limit) → pending, then the hourly retry delivers it.
  const a = await acceptOption(env, { session_id, option_id: "code", actor: "owner@example.com", publish: fail, now: 1_000 });
  assert.deepEqual([a.ok, a.kind, a.state, a.delivered], [true, "repository_task", "handoff_pending", false]);
  assert.equal((await readSession(env, session_id)).state, "decided");
  assert.match((await acceptOption(env, { session_id, option_id: "rrr", publish: ok })).error, /waiting for your pick/, "one pick per session");
  const r = await retryProposalHandoffs(env, { publish: ok });
  assert.deepEqual([r.pending, r.sent], [1, 1]);
  const body = sent[0].report.body;
  assert.equal(sent[0].agent, "xauusd-moderator");
  assert.deepEqual([body.schema, body.kind, body.executor, body.spec, body.origin.council, body.chosen_by], ["typed_proposal.v1", "repository_task", "cryptophys", "build a momentum agent", session_id, "owner:owner"]);
  assert.ok(!JSON.stringify(body).includes("@"), "CF2a: no email in the hand-off (the shape owner:<actor> stays)");
  assert.equal(body.state, "handed_off", "the report carries the state the platform holds it in");
  assert.ok(!/\d{4}\.\d/.test(JSON.stringify(body)), "no price in the hand-off");
  const list = (await listProposals(env)).proposals;
  assert.deepEqual([list[0].state, list[0].report_id], ["handed_off", "rpt_1"]);
  // CF2a: the owner's Access email is stored as sent but never read out: proposals, the session and the list.
  assert.equal(list[0].accepted_by, "owner");
  const read = await readSession(env, session_id);
  assert.match(read.reason, /^accepted code by owner$/);
  assert.ok(!JSON.stringify(read).includes("@") && !JSON.stringify(list).includes("@"), "no email in the session or the proposals");
  assert.ok(!JSON.stringify(await listSessions(env)).includes("@"), "nor in the session list");
  // A knob option on another session: queued for its shadow test, and the platform is told.
  const b = await startSession(env, { topic_key: "strategy:zone_pullback", enqueue });
  await env.DB.prepare("UPDATE council_sessions SET state = 'awaiting_owner', options = ? WHERE id = ?").bind(JSON.stringify({ summary: "s", options: opts }), b.session_id).run();
  const k = await acceptOption(env, { session_id: b.session_id, option_id: "rrr", publish: ok });
  assert.deepEqual([k.kind, k.state], ["policy_parameter", "queued_shadow"]);
  assert.deepEqual([sent.at(-1).report.body.knob, sent.at(-1).report.body.from, sent.at(-1).report.body.value], ["decision.min_rrr.intraday", 1.5, 1.8]);
  assert.equal(proposalReport({ id: "x", session_id: "s", option_id: "no_change", kind: "no_change", option_json: "{}", accepted_ms: 0 }).body.executor, "xauusd");
});

// C1 (orchestrator 2026-11-28, the owner's "setuju semua" on platform Issue #327): the owner's Close while a step runs.
/** A model that closes the session on its first call (the owner clicks Close while the step waits for the model). */
function closingModel(env, session_id) {
  const inner = model();
  let closed = false;
  const call = async (e, o) => {
    if (!closed) { closed = true; await closeSession(env, { session_id, actor: "owner" }); }
    return inner.call(e, o);
  };
  return { call };
}

test("CS11. C1: a Close during positions, rebuttals or the synthesis stays closed: no awaiting_owner, no next step, no options report", async () => {
  for (const at of ["positions", "rebuttals", "synthesis"]) {
    const env = await setup();
    await setSessionsSwitch(env, { on: true });
    queue.length = 0;
    const { session_id } = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue });
    const published = [];
    const publish = async (_e, agent, report) => { published.push(report); return { outcome: "success" }; };
    const steps = ["positions", "rebuttals", "synthesis"];
    for (const name of steps.slice(0, steps.indexOf(at))) await runSessionStep(env, { session_id, step: name }, { call: model().call, publish, enqueue });
    queue.length = 0;
    const r = await runSessionStep(env, { session_id, step: at }, { call: closingModel(env, session_id).call, publish, enqueue });
    assert.equal(r.status, "ended", `${at}: ${JSON.stringify(r)}`);
    const s = await readSession(env, session_id);
    assert.equal(s.state, "closed", `${at}: the owner's Close wins`);
    assert.match(s.reason, /^owner_closed/);
    assert.deepEqual(queue, [], `${at}: no next step is queued`);
    assert.equal(published.filter((p) => p.body?.schema === "council_options.v1" || p.body?.schema === "council_decision.v1").length, 0, `${at}: nothing published for a closed session`);
    // A later step on the closed session does nothing.
    assert.equal((await runSessionStep(env, { session_id, step: "synthesis" }, { call: model().call, publish, enqueue })).status, "closed");
  }
});

test("CS12. C1's repair: a session left awaiting_owner after the owner's Close (or Re-open) is closed once; nothing else moves", async () => {
  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  const a = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue });
  // Two more rows like it (the open-session limit would refuse more starts).
  const cols = ((await env.DB.prepare("PRAGMA table_info(council_sessions)").all()).results ?? []).map((c) => c.name).filter((n) => n !== "id");
  for (const id of ["cfc_b", "cfc_c"]) await env.DB.prepare(`INSERT INTO council_sessions (id, ${cols.join(", ")}) SELECT ?, ${cols.join(", ")} FROM council_sessions WHERE id = ?`).bind(id, a.session_id).run();
  const b = { session_id: "cfc_b" }, c = { session_id: "cfc_c" };
  await env.DB.prepare("UPDATE council_sessions SET state = 'awaiting_owner', reason = ? WHERE id = ?").bind("owner_closed by owner", a.session_id).run();
  await env.DB.prepare("UPDATE council_sessions SET state = 'awaiting_owner', reason = NULL WHERE id = ?").bind(b.session_id).run();
  await env.DB.prepare("UPDATE council_sessions SET state = 'awaiting_owner', reason = ? WHERE id = ?").bind("reopened as cfc_x by owner", c.session_id).run();
  resetSessionSchemaForTests();
  await ensureSessionSchema(env.DB);
  const state = async (id) => (await env.DB.prepare("SELECT state FROM council_sessions WHERE id = ?").bind(id).first()).state;
  assert.deepEqual([await state(a.session_id), await state(b.session_id), await state(c.session_id)], ["closed", "awaiting_owner", "closed"]);
  resetSessionSchemaForTests();
  await ensureSessionSchema(env.DB);
  assert.equal(await state(b.session_id), "awaiting_owner", "idempotent: a real pick-waiting session is never touched");
});

test("CS13. C1: Accept after a Close is refused and stores no proposal; Close on an ended session says so", async () => {
  const env = await setup();
  await setSessionsSwitch(env, { on: true });
  const { session_id } = await startSession(env, { topic_key: "strategy:zone_pullback:exits", enqueue });
  const publish = async () => ({ outcome: "success" });
  for (const name of ["positions", "rebuttals", "synthesis"]) await runSessionStep(env, { session_id, step: name }, { call: model().call, publish, enqueue });
  assert.equal((await readSession(env, session_id)).state, "awaiting_owner");
  // The owner's Close lands between Accept's read and its write.
  const racing = { ...env, DB: { prepare(sql) { if (/^UPDATE council_sessions SET state = 'decided'/.test(sql)) env.DB.prepare("UPDATE council_sessions SET state = 'closed', reason = 'owner_closed by owner' WHERE id = ?").bind(session_id).run(); return env.DB.prepare(sql); } } };
  const r = await acceptOption(racing, { session_id, option_id: "no_change", publish });
  assert.deepEqual([r.ok, r.error], [false, "the session is no longer waiting for your pick"]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM council_proposals WHERE session_id = ?").bind(session_id).first()).n, 0);
  assert.equal((await closeSession(env, { session_id })).ok, false);
});
