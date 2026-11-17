// The platform's return path for council proposals (src/council-decisions.mjs, council.decisions.read).
import test from "node:test";
import assert from "node:assert/strict";
import { seedEnv } from "./support/cfc-fixtures.mjs";
import { ensureSessionSchema, resetSessionSchemaForTests } from "../src/cfc-session.mjs";
import { pollCouncilDecisions, platformStates, decisionsPollStatus, cleanUpdate, resetDecisionsSchemaForTests, DECISIONS_AGENT, DECISIONS_CAPABILITY } from "../src/council-decisions.mjs";

const NOW = Date.parse("2026-11-18T10:00:00Z");

async function setup(vars = {}) {
  resetSessionSchemaForTests(); resetDecisionsSchemaForTests();
  const env = await seedEnv();
  Object.assign(env, vars);
  await ensureSessionSchema(env.DB);
  await env.DB.prepare("INSERT INTO council_proposals (id, session_id, option_id, kind, title, knob, from_value, value, spec, option_json, state, note, report_id, accepted_by, accepted_ms, updated_ms) VALUES ('cp_one', 's', 'o', 'repository_task', 'ATR filter', NULL, NULL, NULL, 'spec', '{}', 'handed_off', NULL, 'rpt_1', 'owner', ?, ?)").bind(NOW - 86_400_000, NOW - 86_400_000).run();
  return env;
}

/** A fake kernel binding: pages of updates by cursor; records each call. */
function kernel(pages, { outcome = "succeeded" } = {}) {
  const calls = [];
  return {
    calls,
    AGENTS: {
      syscall: async () => { throw new Error("no syscall here"); },
      observe: async (agentId, capability, input) => {
        calls.push({ agentId, capability, input });
        if (outcome !== "succeeded") return { outcome, reason: "capability_not_granted" };
        const page = pages[input?.cursor ?? "start"] ?? { updates: [], next_cursor: null };
        return { outcome: "succeeded", result: { available: true, origin: "xauusd", ...page } };
      }
    }
  };
}

test("CD1 off by default: no call to the kernel; on without an observe binding: unavailable", async () => {
  const k = kernel({});
  const env = await setup({ AGENTS: k.AGENTS });
  assert.deepEqual(await pollCouncilDecisions(env, { now: NOW }), { status: "off" });
  assert.equal(k.calls.length, 0);
  const bare = await setup({ COUNCIL_DECISIONS_POLL: "on", AGENTS: { syscall: async () => ({}) } });
  assert.deepEqual(await pollCouncilDecisions(bare, { now: NOW }), { status: "unavailable" });
});

test("CD2 pages through the cursor, stores this repo's updates once, skips unknown and malformed ones; Nexus gets the latest", async () => {
  const k = kernel({
    start: { updates: [
      { schema: "typed_proposal.v1", proposal_id: "cp_one", state: "received", at: "2026-11-17T18:00:00Z", refs: { intent_id: "int_1" } },
      { schema: "typed_proposal.v1", proposal_id: "cp_other_repo", state: "queued", at: "2026-11-17T18:01:00Z" },
      { schema: "typed_proposal.v1", proposal_id: "cp_one", state: "not_a_state", at: "2026-11-17T18:02:00Z" }
    ], next_cursor: "c1" },
    c1: { updates: [{ schema: "typed_proposal.v1", proposal_id: "cp_one", state: "waiting_external", reason: "the xauusd repo is not built by the platform yet", at: "2026-11-17T18:05:00Z", refs: { intent_id: "int_1", price: "4000" } }], next_cursor: "c2" },
    c2: { updates: [], next_cursor: null }
  });
  const env = await setup({ COUNCIL_DECISIONS_POLL: "on", AGENTS: k.AGENTS });
  const r = await pollCouncilDecisions(env, { now: NOW });
  assert.deepEqual(r, { status: "ok", read: 4, stored: 2, unknown: 1, pages: 3 });
  assert.deepEqual(k.calls.map((c) => [c.agentId, c.capability, c.input?.cursor ?? null]), [[DECISIONS_AGENT, DECISIONS_CAPABILITY, null], [DECISIONS_AGENT, DECISIONS_CAPABILITY, "c1"], [DECISIONS_AGENT, DECISIONS_CAPABILITY, "c2"]]);
  // The next hour starts from the stored cursor; a replayed update is not stored twice.
  const again = await pollCouncilDecisions(env, { now: NOW + 3_600_000 });
  assert.equal(again.stored, 0);
  assert.equal(k.calls.at(-1).input.cursor, "c2");
  const states = await platformStates(env, ["cp_one"]);
  assert.equal(states.cp_one.state, "waiting_external");
  assert.equal(states.cp_one.reason, "the xauusd repo is not built by the platform yet");
  assert.deepEqual(states.cp_one.refs, { intent_id: "int_1" }, "only the known ref keys, never anything else");
  assert.deepEqual(states.cp_one.history.map((h) => h.state), ["received", "waiting_external"]);
  const st = await decisionsPollStatus(env);
  assert.deepEqual([st.on, st.last_status], [true, "ok"]);
});

test("CD3 a denied capability or a broken kernel is reported, never thrown; the cursor stays", async () => {
  const k = kernel({}, { outcome: "denied" });
  const env = await setup({ COUNCIL_DECISIONS_POLL: "on", AGENTS: k.AGENTS });
  const r = await pollCouncilDecisions(env, { now: NOW });
  assert.match(r.status, /^denied: capability_not_granted/);
  const broken = await setup({ COUNCIL_DECISIONS_POLL: "on", AGENTS: { syscall: async () => ({}), observe: async () => { throw new Error("boom"); } } });
  assert.equal((await pollCouncilDecisions(broken, { now: NOW })).status, "rpc_failed");
  const slow = await setup({ COUNCIL_DECISIONS_POLL: "on", AGENTS: { syscall: async () => ({}), observe: () => new Promise(() => {}) } });
  assert.equal((await pollCouncilDecisions(slow, { now: NOW, timeoutMs: 20 })).status, "timeout");
});

test("CD4 cleanUpdate keeps only a well-formed typed_proposal.v1 update", () => {
  assert.equal(cleanUpdate({ schema: "other.v1", proposal_id: "cp_one", state: "merged", at: "2026-11-17T18:00:00Z" }), null);
  assert.equal(cleanUpdate({ proposal_id: "bad id with spaces", state: "merged", at: "2026-11-17T18:00:00Z" }), null);
  assert.equal(cleanUpdate({ proposal_id: "cp_one", state: "merged", at: "not a time" }), null);
  assert.deepEqual(cleanUpdate({ proposal_id: "cp_one", state: "merged", at: "2026-11-17T18:00:00Z", refs: { merge_sha: "abc1234" } }),
    { proposal_id: "cp_one", state: "merged", reason: null, refs: { merge_sha: "abc1234" }, at: "2026-11-17T18:00:00.000Z" });
});
