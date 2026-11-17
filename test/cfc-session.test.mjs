// Call for Councils P2 (owner 2026-11-17: "pendapat masing-masing agent bukan detail evidences"; confirmed "Setuju +
// topik bebas"): sessions where each seat gives its own opinion, then rebuttals, the moderator's options, the owner's
// messages answered; a suggested topic or free text; limits; the pick goes to the platform (Cerebrum).
import test from "node:test";
import assert from "node:assert/strict";
import { seedEnv, seedTrades } from "./support/cfc-fixtures.mjs";
import { startSession, ownerMessage, runSessionStep, readSession, listSessions, setSessionsSwitch, sessionsEnabled, cleanSeat, cleanOptions, slugOf, resetSessionSchemaForTests, SESSION_LIMITS } from "../src/cfc-session.mjs";
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
  assert.equal(published[0].report.body.schema, "council_decision.v1");
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
