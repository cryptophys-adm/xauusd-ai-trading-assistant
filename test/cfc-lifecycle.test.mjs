// CFC-A PR1 (A1 + A4; orchestrator brief 2026-11-28): the suggestion lifecycle (open -> approved | rejected | expired),
// the owner's decide route (idempotent, 409 already_decided / expired), the v1 -> v2 table rebuild, the decided
// proposals' 7-day follow-up expiry in CFC_MODE "auto", and the archive of chains with one status and the next actor.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedEnv, seedTrades, d1, NOW } from "./support/cfc-fixtures.mjs";
import {
  ensureCfcSchema, resetCfcSchemaCacheForTests, suggestionExpiry, effectiveStatus, readSuggestions, runCfcTriggers, cfcMode, cfcSessionsMode, cfcAutoMode,
  EXPIRE_SQL, SUGGESTION_TTL_MS, SUGGESTION_MAX_MS
} from "../src/cfc-triggers.mjs";
import { decideSuggestion, expireStaleProposals, chainState, sessionProgress, readCouncilArchive, cleanKey, PROPOSAL_FOLLOWUP_MS } from "../src/cfc-lifecycle.mjs";
import { setSessionsSwitch, resetSessionSchemaForTests, ensureSessionSchema, retryProposalHandoffs } from "../src/cfc-session.mjs";
import { resetDecisionsSchemaForTests } from "../src/council-decisions.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import { AGENT_IDS } from "../src/strategy-agents.mjs";

const H = 3_600_000, DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

async function setup(over = {}) {
  resetCfcSchemaCacheForTests(); resetSessionSchemaForTests(); resetDecisionsSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const env = Object.assign(await seedEnv(), { CFC_MODE: "on" }, over);
  await ensureCfcSchema(env.DB);
  return env;
}
function addSuggestion(env, { topic = "strategy:zone_pullback:exits", created = NOW, seen = created, status = "open", expires = undefined } = {}) {
  const exp = expires === undefined ? suggestionExpiry(iso(created), iso(seen)) : expires;
  const r = env.DB.db.prepare("INSERT INTO cfc_suggestions (topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at, expires_at) VALUES (?, ?, 'stop_share', ?, ?, ?, ?, ?, ?)")
    .run(topic, topic.split(":")[0], `fp-${topic}-${created}`, JSON.stringify({ summary: "x" }), status, iso(created), iso(seen), exp);
  return Number(r.lastInsertRowid);
}
const row = (env, id) => env.DB.db.prepare("SELECT * FROM cfc_suggestions WHERE id = ?").get(id);

test("L1 the v1 table (open | dismissed) is rebuilt once into v2: dismissed reads rejected, each open row gets its expiry; idempotent", async () => {
  resetCfcSchemaCacheForTests();
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE cfc_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_key TEXT NOT NULL, type TEXT NOT NULL, rule TEXT NOT NULL, fingerprint TEXT NOT NULL,
    signal_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')), created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
  raw.exec("CREATE UNIQUE INDEX idx_cfc_suggestions_open ON cfc_suggestions(topic_key) WHERE status = 'open'");
  const ins = raw.prepare("INSERT INTO cfc_suggestions (topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at) VALUES (?, 'risk', 'r', ?, '{}', ?, ?, ?)");
  ins.run("risk:london", "f1", "open", iso(NOW - 2 * DAY), iso(NOW - H));             // recent: expires at last seen + 48 h
  ins.run("risk:asia", "f2", "open", iso(NOW - 6.5 * DAY), iso(NOW - H));            // old: the 7-day cap wins
  ins.run("risk:scalp", "f3", "dismissed", iso(NOW - 3 * DAY), iso(NOW - 3 * DAY));
  const db = d1(raw);
  await ensureCfcSchema(db);
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'cfc_suggestions'").get().sql;
  assert.match(sql, /'approved'/);
  const rows = raw.prepare("SELECT id, topic_key, status, expires_at, decided_at, decided_by FROM cfc_suggestions ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [[1, "open"], [2, "open"], [3, "rejected"]], "ids kept, dismissed read as rejected");
  assert.equal(rows[0].expires_at, iso(NOW - H + SUGGESTION_TTL_MS));
  assert.equal(rows[1].expires_at, iso(NOW - 6.5 * DAY + SUGGESTION_MAX_MS));
  assert.deepEqual([rows[2].decided_at, rows[2].decided_by], [iso(NOW - 3 * DAY), "legacy"]);
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_cfc_suggestions_open'").get(), "the indexes are back");
  assert.throws(() => ins.run("risk:london", "f9", "open", iso(NOW), iso(NOW)), /UNIQUE/, "one open suggestion per topic still holds");
  assert.throws(() => ins.run("risk:intraday", "f9", "dismissed", iso(NOW), iso(NOW)), /CHECK/, "dismissed is no longer a status");
  resetCfcSchemaCacheForTests();
  await ensureCfcSchema(db);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cfc_suggestions").get().n, 3, "a second run changes nothing");
});

test("L2 expiry: 48 h after last seen, never past 7 days after made; an open row past it reads expired; the hourly run marks it", async () => {
  assert.equal(suggestionExpiry(iso(NOW), iso(NOW)), iso(NOW + 48 * H));
  assert.equal(suggestionExpiry(iso(NOW), iso(NOW + 6 * DAY)), iso(NOW + 7 * DAY));
  assert.equal(suggestionExpiry("x", iso(NOW)), null);
  assert.equal(effectiveStatus({ status: "open", expires_at: iso(NOW + 1) }, NOW), "open");
  assert.equal(effectiveStatus({ status: "open", expires_at: iso(NOW) }, NOW), "expired");
  assert.equal(effectiveStatus({ status: "open", created_at: iso(NOW - 3 * DAY), last_seen_at: iso(NOW - 3 * DAY) }, NOW), "expired", "no stored expiry: computed");
  assert.equal(effectiveStatus({ status: "dismissed" }, NOW), "rejected");
  const env = await setup();
  const old = addSuggestion(env, { topic: "risk:asia", created: NOW - 3 * DAY });
  const fresh = addSuggestion(env, { topic: "risk:london", created: NOW - H });
  const view = await readSuggestions(env, { now: NOW });
  assert.deepEqual(Object.fromEntries(view.suggestions.map((s) => [s.id, s.status])), { [old]: "expired", [fresh]: "open" });
  assert.equal(view.lifecycle.ttl_hours, 48);
  await env.DB.prepare(EXPIRE_SQL).bind(iso(NOW), iso(NOW)).run();
  assert.deepEqual([row(env, old).status, row(env, old).decided_by, row(env, fresh).status], ["expired", "system", "open"]);
});

test("L3 a re-seen trigger extends the expiry, capped at 7 days after the suggestion was made", async () => {
  const env = await setup({ CFC_MODE: "suggest", STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") });
  await seedTrades(env, { agent: "zone_pullback", n: 20, exits: [["stop", "sl_plus"], ["stop", "stop"]], start: NOW - 8 * DAY });
  const first = await runCfcTriggers(env, { now: NOW });
  assert.ok(first.created.length >= 1, JSON.stringify(first));
  const key = first.created[0];
  const exp = () => env.DB.db.prepare("SELECT expires_at FROM cfc_suggestions WHERE topic_key = ? AND status = 'open'").get(key)?.expires_at;
  assert.equal(exp(), iso(NOW + 48 * H));
  await runCfcTriggers(env, { now: NOW + 40 * H });
  assert.equal(exp(), iso(NOW + 88 * H), "extended to 48 h after it was seen again");
  for (const d of [3, 4, 5, 6]) await runCfcTriggers(env, { now: NOW + d * DAY });
  assert.equal(exp(), iso(NOW + 7 * DAY), "never past created + 7 days");
  const last = await runCfcTriggers(env, { now: NOW + 7 * DAY + H });
  assert.ok(last.expired >= 1);
  assert.equal(env.DB.db.prepare("SELECT status FROM cfc_suggestions WHERE topic_key = ? ORDER BY id LIMIT 1").get(key).status, "expired");
});

test("L4 reject: owner, at once; the same key again replays; any other decision is a 409 already_decided", async () => {
  const env = await setup();
  const id = addSuggestion(env, { created: NOW - H });
  const r = await decideSuggestion(env, { suggestion_id: id, decision: "reject", idempotency_key: "rej-1", now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([row(env, id).status, row(env, id).decided_by, row(env, id).decided_at, row(env, id).decision_key], ["rejected", "owner", iso(NOW), "rej-1"]);
  const replay = await decideSuggestion(env, { suggestion_id: id, decision: "reject", idempotency_key: "rej-1", now: NOW + 1000 });
  assert.deepEqual([replay.ok, replay.replay, replay.suggestion.status], [true, true, "rejected"]);
  for (const [decision, key] of [["reject", "rej-2"], ["approve", "rej-1"], ["approve", null]]) {
    const x = await decideSuggestion(env, { suggestion_id: id, decision, idempotency_key: key, now: NOW + 2000 });
    assert.deepEqual([x.ok, x.code, x.http_status, x.suggestion.status], [false, "already_decided", 409, "rejected"], `${decision} ${key}`);
  }
  assert.equal(row(env, id).decided_at, iso(NOW), "the first decision stands");
});

test("L5 approve starts the session at once and stores it; a double click starts one session; a refused start leaves it open", async () => {
  const env = await setup();
  const id = addSuggestion(env, { created: NOW - H });
  const starts = [];
  const start = async (_e, a) => { starts.push(a); return { ok: true, session_id: "cfc_s1_abc", participants: ["risk", "technical", "m15"] }; };
  const [a, b] = await Promise.all([
    decideSuggestion(env, { suggestion_id: id, decision: "approve", idempotency_key: "ap-1", now: NOW, start }),
    decideSuggestion(env, { suggestion_id: id, decision: "approve", idempotency_key: "ap-2", now: NOW, start })
  ]);
  assert.equal(starts.length, 1, "one session");
  assert.deepEqual([starts[0].topic_key, starts[0].actor], ["strategy:zone_pullback:exits", "owner"]);
  const winner = a.ok ? a : b, loser = a.ok ? b : a;
  assert.deepEqual([winner.session_id, loser.code, loser.http_status], ["cfc_s1_abc", "already_decided", 409]);
  assert.deepEqual([row(env, id).status, row(env, id).session_id], ["approved", "cfc_s1_abc"]);
  const replay = await decideSuggestion(env, { suggestion_id: id, decision: "approve", idempotency_key: row(env, id).decision_key, now: NOW + 5, start });
  assert.deepEqual([replay.ok, replay.replay, replay.session_id, starts.length], [true, true, "cfc_s1_abc", 1]);
  // Refused: the switch is off (or a limit, or no evidence) -> 409 session_refused, the suggestion is open again.
  const id2 = addSuggestion(env, { topic: "risk:london", created: NOW - H });
  const refused = await decideSuggestion(env, { suggestion_id: id2, decision: "approve", now: NOW, start: async () => ({ ok: false, error: "council sessions are off" }) });
  assert.deepEqual([refused.ok, refused.code, refused.http_status, refused.error], [false, "session_refused", 409, "council sessions are off"]);
  assert.deepEqual([row(env, id2).status, row(env, id2).decided_at, row(env, id2).decision_key], ["open", null, null]);
  const threw = await decideSuggestion(env, { suggestion_id: id2, decision: "approve", now: NOW, start: async () => { throw new Error("boom"); } });
  assert.equal(threw.code, "session_refused");
  assert.equal(row(env, id2).status, "open");
});

test("L6 an expired suggestion refuses both decisions with 409 expired; unknown 404; bad input 400", async () => {
  const env = await setup();
  const id = addSuggestion(env, { created: NOW - 3 * DAY });
  const x = await decideSuggestion(env, { suggestion_id: id, decision: "approve", now: NOW, start: async () => assert.fail("no session for an expired topic") });
  assert.deepEqual([x.ok, x.code, x.http_status, row(env, id).status], [false, "expired", 409, "expired"]);
  assert.equal((await decideSuggestion(env, { suggestion_id: id, decision: "reject", now: NOW })).code, "expired");
  assert.deepEqual(Object.values(await decideSuggestion(env, { suggestion_id: 9999, decision: "reject", now: NOW })).slice(0, 3), [false, "not_found", 404]);
  assert.equal((await decideSuggestion(env, { suggestion_id: id, decision: "maybe", now: NOW })).http_status, 400);
  assert.equal((await decideSuggestion(env, { suggestion_id: "1; DROP", decision: "reject", now: NOW })).http_status, 400);
  assert.equal(cleanKey("ok_key-1"), "ok_key-1");
  assert.equal(cleanKey("has space"), null);
  assert.equal(cleanKey("x".repeat(65)), null);
});

test("L7 approve through the real startSession: the switch gates it; the session reads the topic's fresh evidence", async () => {
  const env = await setup();
  await seedTrades(env, { agent: "zone_pullback", n: 6, exits: [["stop", "sl_plus"], ["target", "target"]], start: Date.now() - 3 * DAY });
  const now = Date.now();
  const id = addSuggestion(env, { created: now - H });
  const queue = [];
  const enqueue = async (t) => { queue.push(t); };
  const off = await decideSuggestion(env, { suggestion_id: id, decision: "approve", now, enqueue });
  assert.equal(off.code, "session_refused", "the owner's switch is off by default");
  await setSessionsSwitch(env, { on: true });
  const r = await decideSuggestion(env, { suggestion_id: id, decision: "approve", idempotency_key: "real-1", now, enqueue });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = env.DB.db.prepare("SELECT topic_key, state FROM council_sessions WHERE id = ?").get(r.session_id);
  assert.deepEqual([s.topic_key, s.state], ["strategy:zone_pullback:exits", "positions"]);
  assert.deepEqual(queue, [{ kind: "council_step", session_id: r.session_id, step: "positions" }]);
  // "auto" runs sessions too; "suggest" does not.
  assert.deepEqual([cfcSessionsMode({ CFC_MODE: "auto" }), cfcSessionsMode({ CFC_MODE: "suggest" }), cfcAutoMode({ CFC_MODE: "on" }), cfcMode({ CFC_MODE: "auto" })], [true, false, false, "auto"]);
});

test("L8 A4: in auto only, a repository task never handed off within 7 days expires and is not re-sent; a knob in shadow has started", async () => {
  const env = await setup({ CFC_MODE: "on" });
  await ensureSessionSchema(env.DB);
  const add = (id, state, accepted) => env.DB.db.prepare("INSERT INTO council_proposals (id, session_id, option_id, kind, title, option_json, state, accepted_by, accepted_ms, updated_ms) VALUES (?, 's', 'o', ?, 't', '{}', ?, 'owner', ?, ?)")
    .run(id, state === "queued_shadow" ? "policy_parameter" : "repository_task", state, accepted, accepted);
  add("cp_old", "handoff_pending", NOW - PROPOSAL_FOLLOWUP_MS - 1);
  add("cp_new", "handoff_pending", NOW - DAY);
  add("cp_knob", "queued_shadow", NOW - 9 * DAY);
  add("cp_done", "handed_off", NOW - 9 * DAY);
  assert.deepEqual(await expireStaleProposals(env, { now: NOW }), { status: "off" }, "CFC_MODE on: nothing");
  env.CFC_MODE = "auto";
  assert.deepEqual(await expireStaleProposals(env, { now: NOW }), { status: "ok", expired: 1 });
  const st = Object.fromEntries(env.DB.db.prepare("SELECT id, state FROM council_proposals").all().map((r) => [r.id, r.state]));
  assert.deepEqual(st, { cp_old: "expired", cp_new: "handoff_pending", cp_knob: "queued_shadow", cp_done: "handed_off" });
  const sent = [];
  await retryProposalHandoffs(env, { now: NOW, publish: async (_e, _a, rep) => { sent.push(rep.body.proposal_id); return { outcome: "success" }; } });
  assert.deepEqual(sent, ["cp_new"], "the expired one is not re-sent");
});

test("L9 chainState: one status per chain and the next actor, from the most advanced link", () => {
  const cases = [
    [{ suggestion: { status: "open", expires_at: iso(NOW + H) } }, ["awaiting_approval", "suggestion", "owner"]],
    [{ suggestion: { status: "open", expires_at: iso(NOW - 1) } }, ["expired", "suggestion", "none"]],
    [{ suggestion: { status: "rejected" } }, ["rejected", "suggestion", "none"]],
    [{ suggestion: { status: "approved" } }, ["approved", "suggestion", "council"]],
    [{ session: { state: "rebuttals" } }, ["in_session", "session", "council"]],
    [{ session: { state: "awaiting_owner" } }, ["awaiting_pick", "session", "owner"]],
    [{ session: { state: "closed" } }, ["closed", "session", "none"]],
    [{ session: { state: "decided" }, proposal: { state: "closed" } }, ["no_change", "proposal", "none"]],
    [{ proposal: { state: "queued_shadow" } }, ["shadow_test", "proposal", "shadow"]],
    [{ proposal: { state: "live" } }, ["live", "proposal", "shadow"]],
    [{ proposal: { state: "rolled_back" } }, ["rolled_back", "proposal", "none"]],
    [{ proposal: { state: "handoff_pending" } }, ["handoff_pending", "proposal", "platform"]],
    [{ proposal: { state: "expired" } }, ["expired", "proposal", "none"]],
    [{ proposal: { state: "handed_off" } }, ["handed_off", "proposal", "platform"]],
    [{ proposal: { state: "handed_off" }, platform: { state: "in_progress" } }, ["in_progress", "platform", "platform"]],
    [{ proposal: { state: "handed_off" }, platform: { state: "refused" } }, ["refused", "platform", "none"]],
    [{ proposal: { state: "handed_off" }, platform: { state: "deployed" } }, ["deployed", "platform", "none"]]
  ];
  for (const [input, want] of cases) { const s = chainState({ ...input, now: NOW }); assert.deepEqual([s.status, s.source, s.next_actor], want, JSON.stringify(input)); }
  const p = sessionProgress({ state: "rebuttals", participants: JSON.stringify(["a", "b", "c"]) }, [{ round: "position", stance: "support", n: 2 }, { round: "position", stance: "oppose", n: 1 }, { round: "rebuttal", stance: "oppose", n: 1 }]);
  assert.deepEqual([p.positions, p.rebuttals, p.tally], [{ done: 3, expected: 3 }, 1, { support: 2, oppose: 1, amend: 0, abstain: 0 }]);
});

test("L10 GET /api/council/archive: chains topic -> session -> proposal, newest change first, paged; no email, no price", async () => {
  const env = await setup();
  await ensureSessionSchema(env.DB);
  const db = env.DB.db;
  const s1 = addSuggestion(env, { topic: "risk:london", created: NOW - 5 * H });                               // open
  addSuggestion(env, { topic: "risk:asia", created: NOW - 6 * H, status: "rejected" });                      // rejected
  const s3 = addSuggestion(env, { topic: "strategy:zone_pullback:exits", created: NOW - 4 * H });
  db.prepare("UPDATE cfc_suggestions SET status = 'approved', decided_at = ?, decided_by = 'owner', session_id = 'cfc_a_111111' WHERE id = ?").run(iso(NOW - 3 * H), s3);
  const sess = db.prepare("INSERT INTO council_sessions (id, topic_key, topic_text, type, question, state, participants, calls, options, reason, created_by, created_ms, updated_ms) VALUES (?, ?, ?, ?, 'q', ?, ?, 0, ?, ?, ?, ?, ?)");
  sess.run("cfc_a_111111", "strategy:zone_pullback:exits", null, "strategy", "awaiting_owner", JSON.stringify(["risk", "technical", "m15"]), JSON.stringify({ options: [{ option_id: "a" }, { option_id: "no_change" }] }), null, "owner", NOW - 3 * H, NOW - 2 * H);
  sess.run("cfc_b_222222", "free:sl-review", "SL review", "free", "decided", JSON.stringify(["risk"]), null, "accepted x by someone@example.com", "owner@example.com", NOW - 10 * H, NOW - H);
  db.prepare("INSERT INTO council_proposals (id, session_id, option_id, kind, title, option_json, state, accepted_by, accepted_ms, updated_ms) VALUES ('cp_b', 'cfc_b_222222', 'x', 'repository_task', 'Do x', '{}', 'handed_off', 'someone@example.com', ?, ?)").run(NOW - H, NOW - H);
  db.prepare("CREATE TABLE IF NOT EXISTS council_proposal_updates (proposal_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, refs TEXT, at TEXT NOT NULL, received_ms INTEGER NOT NULL, PRIMARY KEY (proposal_id, at, state))").run();
  db.prepare("INSERT INTO council_proposal_updates VALUES ('cp_b', 'refused', 'not now', ?, ?, ?)").run(JSON.stringify({ close_code: "out_of_scope" }), iso(NOW - 30 * 60_000), NOW);
  const msg = db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, ms) VALUES ('cfc_a_111111', ?, ?, ?, 'op', ?)");
  msg.run("position", "risk", "support", NOW); msg.run("position", "technical", "oppose", NOW); msg.run("position", "m15", "support", NOW); msg.run("rebuttal", "risk", "support", NOW);
  const a = await readCouncilArchive(env, { limit: 50, now: NOW });
  assert.equal(a.total, 4);
  assert.deepEqual(a.items.map((c) => [c.chain_id, c.status, c.next_actor]), [
    ["session:cfc_b_222222", "refused", "none"],
    ["suggestion:" + s3, "awaiting_pick", "owner"],
    ["suggestion:" + s1, "awaiting_approval", "owner"],
    [a.items[3].chain_id, "rejected", "none"]
  ]);
  const b = a.items[0];
  assert.deepEqual([b.topic.origin, b.topic.key, b.proposal.decided_by, b.proposal.platform.close_code, b.status_source], ["owner", "free:sl-review", "owner", "out_of_scope", "platform"]);
  const pick = a.items[1];
  assert.deepEqual([pick.topic.suggestion_id, pick.topic.decided_by, pick.session.progress.positions, pick.session.progress.rebuttals, pick.session.progress.synthesis, pick.session.progress.tally.support],
    [s3, "owner", { done: 3, expected: 3 }, 1, 2, 2]);
  assert.ok(!JSON.stringify(a).includes("@"), "no email in the archive");
  assert.ok(a.vocab.next_actor.includes("platform") && a.vocab.chain_status.includes("awaiting_pick"));
  const p1 = await readCouncilArchive(env, { limit: 2, now: NOW });
  assert.deepEqual([p1.items.length, p1.next_cursor], [2, "2"]);
  const p2 = await readCouncilArchive(env, { cursor: p1.next_cursor, limit: 2, now: NOW });
  assert.deepEqual([p2.items.length, p2.next_cursor, p2.items[0].chain_id], [2, null, a.items[2].chain_id]);
});
