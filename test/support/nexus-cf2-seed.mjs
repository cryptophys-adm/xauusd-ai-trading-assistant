// CF2 UI: the answers the Nexus Call for Councils page reads and gets, from the real code (#677, CFC-A PR1). The Omega
// Worker's route (workers/xauusd-omega/src/omega.mjs handle: POST /omega/api/council and GET /omega/api/whoami) in front of
// the bundled AI Worker's OmegaGateway (src/index.ts council: decide, start, reopen, close, switch) over a migrated D1 with
// seeded Decision Engine trades (test/support/cfc-fixtures.mjs), with an Access JWT per caller; the reads are the real
// readSuggestions (src/cfc-triggers.mjs), listSessions and readSession (src/cfc-session.mjs) and readCouncilArchive
// (src/cfc-lifecycle.mjs, with #680's scope, status and counts), wrapped as their routes in src/index.ts send them
// ({ status: "ok", ... }). CFC_MODE is "on" (production): the owner picks each option; the sessions the council decided ran
// their synthesis in "auto" (CFC-A PR2, #680: the council decides by itself). The seats' messages are
// written straight into D1 (as test/support/nexus-h3f-seed.mjs does) and one aborted step; the synthesis is the real
// runSessionStep with an injected moderator answer, so the real councilPick and acceptOption pick (a knob to its shadow
// test, a code task into its 2 h veto window, no quorum left to the owner); the real hourly retryProposalHandoffs hands a
// task off after its window, and the owner's Close inside one vetoes it (the real route).
// test/fixtures/nexus-cf2/*.json are this seed's answers:
//   suggestions.json      GET /api/council/suggestions (CFC_MODE on): 3 open (one under 1 h), approved, rejected, expired;
//   suggestions-auto.json, sessions-auto.json   the same reads in CFC_MODE auto;
//   sessions.json         GET /api/council/sessions: running, waiting for the owner's pick (quorum, and no quorum),
//                         decided by the council (in its veto window, vetoed, handed off), aborted, closed, reopened;
//   session-pick.json     GET /api/council/session of a session waiting for the owner's pick (CFC_MODE on, a quorum);
//   session-veto.json, session-noquorum.json   a council-picked task in its veto window; a session without a quorum;
//   session-running.json  GET /api/council/session of the running session (5 of 6 opinions, 2 responses);
//   session-decided.json  GET /api/council/session of the session the council decided (the knob change, in shadow);
//   session-reopened.json GET /api/council/session of the owner's free-text session that was re-opened (its reason
//                         names the owner's email: the page must mask it);
//   archive.json          GET /api/council/archive?limit=50: every chain (one page), with the counts;
//   archive-active.json   ?scope=active&limit=50: the chains someone still acts on;
//   archive-ended.json    ?scope=archive&limit=50: the ended ones; archive-ended-expired.json the same with status=expired;
//   archive-ended-page1.json, archive-ended-page2.json   ?scope=archive&limit=4 and &cursor=4: the Load more pages;
//   archive-empty.json    an empty D1 (scope active); archive-off.json the seeded D1 with CFC_MODE off (scope active);
//   suggestions-empty.json, suggestions-off.json, sessions-off.json   nothing yet; CFC_MODE off;
//   whoami-owner.json, whoami-viewer.json    GET /omega/api/whoami (can_control true, false);
//   decide-replies.json   { case: { status, body } }: approve and reject ok, a replay, 409 already_decided, expired and
//                         session_refused, 404 not_found, 400 bad_request, 403 owner_only and same_origin_only; and the
//                         session controls: accept (the owner's pick) and accept again, the veto (Close in the window,
//                         proposal_state vetoed), Close on a decided session (already decided).
// test/nexus-cf2-page.test.mjs checks each file against this seed, byte for byte. Regenerate them after a contract change:
// node test/support/nexus-cf2-seed.mjs --write
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handle as omegaHandle, resetKeyCacheForTests } from "../../workers/xauusd-omega/src/omega.mjs";
import { loadWorkerModule, ctx } from "./nexus-f4-seed.mjs";
import { seedEnv, seedTrades } from "./cfc-fixtures.mjs";
import { ensureCfcSchema, readSuggestions, resetCfcSchemaCacheForTests, suggestionExpiry } from "../../src/cfc-triggers.mjs";
import { cleanSeat, ensureSessionSchema, listSessions, readSession, resetSessionSchemaForTests, retryProposalHandoffs, runSessionStep, VETO_WINDOW_MS } from "../../src/cfc-session.mjs";
import { readCouncilArchive } from "../../src/cfc-lifecycle.mjs";
import { resetDecisionsSchemaForTests } from "../../src/council-decisions.mjs";
import { resetAiUsageSchemaCacheForTests } from "../../src/ai-usage.mjs";
import { resetFeatureSwitchMemoForTests } from "../../src/feature-switch-store.mjs";
import { resetKnobCache } from "../../src/council-knobs.mjs";

/** The fixture's clock: Sat 28 Nov 2026 14:48 UTC, 21:48 GMT+7 (the mockup's). */
export const NOW = Date.parse("2026-11-28T14:48:00Z");
export const OWNER = "owner-sub-cf2-fixture";
export const ORIGIN = "https://nexus.cryptophys.work";
const H = 3_600_000, M = 60_000, DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------------ the Access JWT (as test/support/nexus-h3f-seed.mjs)
const TEAM = "cryptophys.cloudflareaccess.com", AUD = "c".repeat(64), NOW_S = Math.floor(NOW / 1000);
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
async function access() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const jwt = async (claims) => {
    const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW_S + 600, ...claims });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return {
    opts: { fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: NOW_S },
    owner: await jwt({ email: "owner@example.com", sub: OWNER }),
    viewer: await jwt({ email: "viewer@example.com", sub: "viewer-sub-cf2" })
  };
}

/** Date.now at the seed's clock (set by `at`), Math.random from a counter (each session id the same on every run), no network. */
async function deterministic(fn) {
  const realNow = Date.now, realRandom = Math.random, realFetch = globalThis.fetch;
  let clock = NOW, n = 0;
  Date.now = () => clock;
  Math.random = () => { n += 1; return ((n * 7919) % 10007) / 10007; };
  globalThis.fetch = async () => { throw new Error("no network in the seed"); };
  try { return await fn((ms) => { clock = ms; }); } finally { Date.now = realNow; Math.random = realRandom; globalThis.fetch = realFetch; }
}

/** One request through the Omega Worker's handler: { status, body }. */
function caller(a, env) {
  return async (token, { method = "POST", path = "/omega/api/council", body = null, headers = {} } = {}) => {
    const req = new Request(`${ORIGIN}${path}`, {
      method, body: method === "GET" ? undefined : JSON.stringify(body),
      headers: { "cf-access-jwt-assertion": token, origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }
    });
    const r = await omegaHandle(req, env, a.opts);
    return { status: r.status, body: await r.json() };
  };
}

function resetAll() {
  resetCfcSchemaCacheForTests(); resetSessionSchemaForTests(); resetDecisionsSchemaForTests(); resetAiUsageSchemaCacheForTests();
  resetFeatureSwitchMemoForTests(); resetKeyCacheForTests(); resetKnobCache();
}

/** A suggestion row as the hourly flags store it (src/cfc-triggers.mjs), its expiry from the real suggestionExpiry. */
function addSuggestion(db, { topic, type = topic.split(":")[0], rule, summary, created, seen = created }) {
  const r = db.prepare("INSERT INTO cfc_suggestions (topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)")
    .run(topic, type, rule, `fp-${topic}-${created}`, JSON.stringify({ summary }), iso(created), iso(seen), suggestionExpiry(iso(created), iso(seen)));
  return Number(r.lastInsertRowid);
}
/** The queue consumer's work, as the session steps store it: seat messages (cleanSeat), then the state and the options. */
async function speak(env, id, msgs) {
  const s = env.DB.db.prepare("SELECT pack_json FROM council_sessions WHERE id = ?").get(id);
  const refs = JSON.parse(s.pack_json).refs ?? [];
  for (const [round, seat, o, ms] of msgs) {
    const m = cleanSeat({ ...o, refs: (o.refs ?? []).map((i) => refs[i]).filter(Boolean) }, refs);
    env.DB.db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, round, seat, m.stance, m.opinion, m.proposal, JSON.stringify(o.reply_to ?? []), JSON.stringify(m.refs ?? []), ms);
  }
}
const stepTo = (env, id, state, { options = null, reason = null, calls, ms }) => env.DB.db.prepare("UPDATE council_sessions SET state = ?, options = COALESCE(?, options), reason = COALESCE(?, reason), calls = ?, updated_ms = ? WHERE id = ?")
  .run(state, options ? JSON.stringify(options) : null, reason, calls, ms, id);

const OPEN = (n) => `The last ${n} closed setups say more than one seat expected.`;
const SEATS6 = ["risk", "technical", "projection", "m15", "trade_management", "interstellar_eyes"];

/** The seeded answers (see the header). Deterministic: a fresh D1 and caches on every call. */
export async function seedCf2() {
  const mod = await loadWorkerModule();
  const a = await access();
  return deterministic(async (at) => {
    resetAll();
    const env = Object.assign(await seedEnv(), { CFC_MODE: "on" });
    const db = env.DB.db;
    await ensureCfcSchema(env.DB);
    await ensureSessionSchema(env.DB);
    await seedTrades(env, { agent: "zone_pullback", n: 24, exits: [["stop", "sl_plus"], ["target", "target"], ["stop", "stop"]], start: NOW - 9 * DAY, mode: "intraday", regime: "normal-trending" });
    const queued = [];
    const gw = new mod.OmegaGateway(ctx, { ...env, OWNER_ACCESS_SUB: OWNER, XAUUSD_EVENTS: { send: async (t) => { queued.push(t); } } });
    const omegaEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_ACCESS_SUB: OWNER, OMEGA: gw };
    const call = caller(a, omegaEnv);
    const council = (body, token = a.owner, headers = {}) => call(token, { body, headers });
    const ok = (r, what) => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${JSON.stringify(r)}`); return r.body; };
    const decide = (id, decision, key) => council({ action: "decide", suggestion_id: id, decision, idempotency_key: key });
    const sent = [];
    const publish = async (_e, _agent, report) => { sent.push(report?.body?.schema ?? null); return { outcome: "success", report_id: `rep_${sent.length}` }; };
    // The queue consumer's synthesis step, for real: the moderator's answer injected, then councilPick in CFC_MODE auto.
    const extra = {};
    const synth = async (id, summary, options, ms, mode = "auto") => {
      stepTo(env, id, "rebuttals", { calls: 10, ms: ms - M });
      const call = async (_e, o) => (o.schemaName === "cfc_synthesis" ? { status: "answered", obj: { summary, options } } : { status: "failed" });
      const r = await runSessionStep({ ...env, CFC_MODE: mode }, { session_id: id, step: "synthesis" }, { now: ms, call, publish, enqueue: async () => {} });
      if (!["decided", "awaiting_owner"].includes(r?.status)) throw new Error(`synthesis ${id}: ${JSON.stringify(r)}`);
      return r;
    };

    // 25 Nov: the owner turns sessions on, opens a free-text session, re-opens it (the old one closes), then closes the new one.
    at(Date.parse("2026-11-25T07:58:00Z"));
    ok(await council({ action: "switch", on: true }), "switch on");
    at(Date.parse("2026-11-25T08:00:00Z"));
    const free1 = ok(await council({ action: "start", text: "Zone pullback exits review" }), "free start").session_id;
    await speak(env, free1, [["position", "risk", { stance: "amend", opinion: OPEN(20), proposal: "Look at the exits again on fresh evidence.", refs: [0] }, Date.parse("2026-11-25T08:02:00Z")]]);
    stepTo(env, free1, "rebuttals", { calls: 6, ms: Date.parse("2026-11-25T08:04:00Z") });
    at(Date.parse("2026-11-25T09:10:00Z"));
    const free2 = ok(await council({ action: "reopen", session_id: free1 }), "reopen").session_id;
    at(Date.parse("2026-11-25T09:40:00Z"));
    ok(await council({ action: "close", session_id: free2 }), "close");

    // 26 Nov: the council decides a knob change (in its shadow test); an engine session aborts.
    at(Date.parse("2026-11-26T08:00:00Z"));
    const sKnob = addSuggestion(db, { topic: "strategy:zone_pullback", rule: "stop_share", summary: "Ended at the stop or SL+: 14 of the last 20.", created: Date.parse("2026-11-26T02:00:00Z"), seen: Date.parse("2026-11-26T07:00:00Z") });
    at(Date.parse("2026-11-26T08:31:00Z"));
    const knob = ok(await decide(sKnob, "approve", "decide:seed:knob"), "approve knob").session_id;
    const t0 = Date.parse("2026-11-26T08:33:00Z");
    await speak(env, knob, [
      ["position", "risk", { stance: "oppose", opinion: "A higher reward floor removes the setups that pay for the stops.", proposal: "Keep the floor; tighten the stop instead.", refs: [0, 1, 2, 3] }, t0],
      ["position", "technical", { stance: "support", opinion: "The stopped setups had the shortest targets.", proposal: "Raise the intraday reward floor.", refs: [4, 5, 6] }, t0 + M],
      ["position", "projection", { stance: "amend", opinion: "The floor helps only in trending hours.", proposal: "Raise it a little, not to the swing floor.", refs: [7, 8, 9, 10, 11] }, t0 + 2 * M],
      ["position", "m15", { stance: "support", opinion: "Fewer, longer targets fit the 15m structure.", proposal: "Raise the intraday reward floor.", refs: [12, 13] }, t0 + 3 * M],
      ["position", "trade_management", { stance: "support", opinion: "The trades that reached TP1 had room to run.", proposal: "Raise the intraday reward floor.", refs: [14, 15, 16] }, t0 + 4 * M],
      ["position", "interstellar_eyes", { stance: "support", opinion: "The same setups lost in the same hours.", proposal: null, refs: [17] }, t0 + 5 * M],
      ["rebuttal", "risk", { stance: "oppose", opinion: "The trades a floor removes are the ones that pay.", proposal: null, refs: [0], reply_to: ["technical"] }, t0 + 8 * M],
      ["rebuttal", "technical", { stance: "support", opinion: "Only the shortest targets go; the rest stay.", proposal: null, refs: [4], reply_to: ["risk"] }, t0 + 9 * M],
      ["rebuttal", "projection", { stance: "amend", opinion: "A step of 0.2 R is enough to test.", proposal: null, refs: [7], reply_to: ["risk"] }, t0 + 10 * M],
      ["rebuttal", "m15", { stance: "support", opinion: "Agreed with the smaller step.", proposal: null, refs: [12], reply_to: ["projection"] }, t0 + 11 * M]
    ]);
    const knobPick = await synth(knob, "Four seats see the stops come from the shortest targets; the Risk Manager wants to keep the floor.", [
      { option_id: "raise_rrr", rank: 1, kind: "policy_parameter", title: "Raise the intraday reward floor", hypothesis: "The stopped setups had the shortest targets; a higher floor drops them first.", change: "small", risk: "low", dissent: "Risk Manager", knob: "decision.min_rrr.intraday", from: 1.5, value: 1.7, unit: "R" },
      { option_id: "hold_exits", rank: 2, kind: "repository_task", title: "Hold exits past the first key level", hypothesis: "Exits at the first key level cut the trades that would have paid.", change: "medium", risk: "medium", dissent: null, spec: "Hold the exit past the first key level when the 15m trend holds." },
      { option_id: "no_change", rank: 3, kind: "no_change", title: "No change", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null }
    ], Date.parse("2026-11-26T09:40:00Z"));
    if (knobPick.pick !== "raise_rrr" || knobPick.proposal?.state !== "queued_shadow") throw new Error(`knob pick: ${JSON.stringify(knobPick)}`);
    at(Date.parse("2026-11-26T15:00:00Z"));
    const sAbort = addSuggestion(db, { topic: "engine:15", rule: "hit_rate_drop", summary: "The 7-day directional hit rate is 9 points below the 30-day rate.", created: Date.parse("2026-11-26T11:00:00Z") });
    const aborted = ok(await decide(sAbort, "approve", "decide:seed:engine"), "approve engine").session_id;
    stepTo(env, aborted, "aborted", { calls: 3, reason: "the daily council budget is used up", ms: Date.parse("2026-11-26T15:05:00Z") });

    // 27 Nov: two code tasks the council picked, handed to the platform: one it refused (with its close code), one it is building.
    // A code task the council picks: four seats support (the quorum, and max(4, 2/3) of those who spoke), so it waits in its
    // 2 h veto window; `after` then runs it on: the hourly hand-off after the window, or the owner's Close inside it.
    const task = async (topic, rule, summary, created, title, after) => {
      at(created + H);
      const sid = addSuggestion(db, { topic, rule, summary, created });
      const session = ok(await decide(sid, "approve", `decide:seed:${sid}`), `approve ${topic}`).session_id;
      const t = created + H + 2 * M;
      const seats = JSON.parse(db.prepare("SELECT participants FROM council_sessions WHERE id = ?").get(session).participants);
      await speak(env, session, seats.slice(0, 5).map((seat, i) => ["position", seat, i < 4
        ? { stance: "support", opinion: ["The failures repeat on the same step.", "Only with a limit on how often.", "It would have kept the entries the chart wanted.", "The record backs it."][i], proposal: i === 1 ? `${title}, at most once.` : title, refs: [i] }
        : { stance: "abstain", opinion: "Not a question for this seat.", proposal: null, refs: [] }, t + i * M]));
      const pick = await synth(session, "Four seats want the change; one abstains.", [
        { option_id: "task", kind: "repository_task", title, hypothesis: "The failures repeat on the same step.", change: "small", risk: "low", dissent: null, spec: title },
        { option_id: "no_change", kind: "no_change", title: "No change", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null }
      ], t + 40 * M);
      if (pick.pick !== "task" || pick.proposal?.state !== "veto_window") throw new Error(`task pick: ${JSON.stringify(pick)}`);
      if (after) await after(session, pick.proposal.id, t + 40 * M);
      return session;
    };
    // Past the window the hourly hand-off sends it (the real retry); then the platform's state arrives with its close code.
    const handOff = (platform) => async (_session, proposalId, decidedMs) => {
      at(decidedMs + VETO_WINDOW_MS + 5 * M);
      const r = await retryProposalHandoffs(env, { now: decidedMs + VETO_WINDOW_MS + 5 * M, publish });
      if (!r.sent) throw new Error(`hand-off: ${JSON.stringify(r)}`);
      const pAt = decidedMs + 3 * H;
      db.prepare("CREATE TABLE IF NOT EXISTS council_proposal_updates (proposal_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, refs TEXT, at TEXT NOT NULL, received_ms INTEGER NOT NULL, PRIMARY KEY (proposal_id, at, state))").run();
      db.prepare("INSERT INTO council_proposal_updates (proposal_id, state, reason, refs, at, received_ms) VALUES (?, ?, ?, ?, ?, ?)").run(proposalId, platform.state, platform.reason, JSON.stringify(platform.refs ?? {}), iso(pAt), pAt);
      db.prepare("UPDATE council_proposals SET updated_ms = ? WHERE id = ?").run(pAt, proposalId);
    };
    // The owner's veto: Close on the decided session inside the window (the real route).
    const veto = async (session, _p, decidedMs) => { at(decidedMs + 25 * M); extra.veto = await council({ action: "close", session_id: session }); ok(extra.veto, "veto"); };
    await task("execution:rejected_intents", "failed_intents", "11 failed Omega intents in 24 hours.", Date.parse("2026-11-27T03:00:00Z"), "Retry a failed intent once, then hand to the EA", handOff({ state: "in_progress", reason: "building" }));
    await task("risk:london", "session_negative", "-0.31R per trade over 18 trades in the London session.", Date.parse("2026-11-27T06:00:00Z"), "Skip the first London hour after a range night", handOff({ state: "refused", reason: "outside the platform's scope", refs: { close_code: "out_of_scope" } }));
    await task("risk:normal-trending", "regime_negative", "-0.25R per trade over 20 trades in the normal-trending regime.", Date.parse("2026-11-27T12:00:00Z"), "Halve the size in a normal-trending regime after two losses", veto);

    // CFC_MODE on: a full quorum, and the session waits for the owner's pick (only auto decides by itself).
    at(Date.parse("2026-11-27T16:00:00Z"));
    const sPick = addSuggestion(db, { topic: "risk:new_york", rule: "session_negative", summary: "-0.27R per trade over 24 trades in the New York session.", created: Date.parse("2026-11-27T13:00:00Z") });
    const pick = ok(await decide(sPick, "approve", "decide:seed:pick"), "approve pick").session_id;
    const p0 = Date.parse("2026-11-27T16:02:00Z");
    await speak(env, pick, ["risk", "m15", "chronos_matrix", "technical", "trade_management", "projection"].map((seat, i) => ["position", seat,
      { stance: ["support", "support", "amend", "support", "oppose", "support"][i], opinion: ["New York's first hour stops most trades.", "The 15m opens wide there.", "Only on release days.", "The candles agree.", "The exits, not the hour, lose.", "The cone is wide at the open."][i], proposal: i === 0 ? "Skip the first New York hour." : null, refs: [i] }, p0 + i * M]));
    const onPick = await synth(pick, "Four seats would skip the first New York hour; Trade Management blames the exits.", [
      { option_id: "skip_ny_open", kind: "repository_task", title: "Skip the first New York hour", hypothesis: "Most stops come in the first hour.", change: "small", risk: "fewer trades", dissent: "Trade Management", spec: "Skip new entries 13:30-14:30 UTC; measure R per trade." },
      { option_id: "rrr", kind: "policy_parameter", title: "Ask more reward intraday", hypothesis: "Only the longer targets survive the open.", change: "small", risk: "low", dissent: null, knob: "decision.min_rrr.intraday", value: 1.8 },
      { option_id: "no_change", kind: "no_change", title: "No change", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null }
    ], Date.parse("2026-11-27T16:40:00Z"), "on");
    if (onPick.status !== "awaiting_owner") throw new Error(`on pick: ${JSON.stringify(onPick)}`);

    // Rejected and expired topics (the hourly run marks an expired one; a read shows it expired either way).
    at(Date.parse("2026-11-27T06:40:00Z"));
    const sCost = addSuggestion(db, { topic: "cost:council", rule: "neurons_week", summary: "The council meter's neurons rose 64% week on week.", created: Date.parse("2026-11-27T05:00:00Z") });
    const rejected = await decide(sCost, "reject", "decide:seed:reject");
    const expiredRows = [
      ["data:market_feed", "stuck_state", "A field of the market feed has not changed for 6 closed 1H candles.", "2026-11-24T22:00:00Z"],
      ["seat:risk@15", "weight_floor", "The 15m risk seat sat at the weight floor for 3 days.", "2026-11-23T17:00:00Z"],
      ["news:release_horizon", "losses_near_releases", "-0.4R per trade within an hour of high-impact releases.", "2026-11-24T03:00:00Z"],
      ["execution:sl_plus", "sl_plus_share", "SL+ closed 9 of the last 20 trades at break-even.", "2026-11-25T10:00:00Z"],
      ["risk:asia", "session_negative", "-0.22R per trade over 12 trades in the Asia session.", "2026-11-25T14:00:00Z"]
    ].map(([topic, rule, summary, c]) => addSuggestion(db, { topic, rule, summary, created: Date.parse(c) }));

    // 28 Nov, today: three open topics (one expires in 42 minutes), one approved and running now.
    addSuggestion(db, { topic: "execution:recoveries", rule: "recoveries_per_day", summary: "4 self-healing recoveries of the terminal in 24 hours.", created: NOW - 3 * DAY + 40 * M, seen: NOW + 42 * M - 48 * H });
    const sOpenB = addSuggestion(db, { topic: "strategy:zone_pullback:exits", rule: "stop_share", summary: "Ended at the stop or SL+: 13 of the last 20.", created: NOW - 20 * H, seen: NOW + 3 * H + 12 * M - 48 * H });
    const sOpenC = addSuggestion(db, { topic: "engine:model", rule: "gate_drift", summary: "The self-trained baseline's gate passed 30% fewer setups this week.", created: NOW - 13 * H, seen: NOW + 11 * H + 5 * M - 48 * H });
    // Today, in auto: a session where only 3 seats spoke (no quorum: it waits for the owner), and a code task the council
    // picked at 13:10, in its veto window until 15:10.
    at(Date.parse("2026-11-28T10:00:00Z"));
    const sNoQ = addSuggestion(db, { topic: "risk:intraday", rule: "mode_negative", summary: "-0.18R per trade over 22 intraday trades.", created: Date.parse("2026-11-28T06:00:00Z") });
    const noQ = ok(await decide(sNoQ, "approve", "decide:seed:noq"), "approve no quorum").session_id;
    await speak(env, noQ, [
      ["position", "risk", { stance: "support", opinion: "The intraday stops sit too close for this volatility.", proposal: "Widen the intraday stop.", refs: [0] }, Date.parse("2026-11-28T10:02:00Z")],
      ["position", "m15", { stance: "support", opinion: "The 15m swings are wider this week.", proposal: null, refs: [1] }, Date.parse("2026-11-28T10:03:00Z")],
      ["position", "technical", { stance: "amend", opinion: "Only after a range night.", proposal: null, refs: [2] }, Date.parse("2026-11-28T10:04:00Z")]
    ]);
    const noQuorum = await synth(noQ, "Three seats spoke; the rest did not answer.", [
      { option_id: "wider_stop", kind: "repository_task", title: "Widen the intraday stop after a range night", hypothesis: "Fewer stops inside the noise.", change: "small", risk: "medium", dissent: null, spec: "Widen the intraday stop by 0.2 ATR after a range night; measure R per trade." },
      { option_id: "no_change", kind: "no_change", title: "No change", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null }
    ], Date.parse("2026-11-28T10:40:00Z"));
    if (noQuorum.status !== "awaiting_owner" || noQuorum.quorum !== false) throw new Error(`no quorum: ${JSON.stringify(noQuorum)}`);
    const vetoOpen = await task("execution:fills", "fill_slippage", "Fills 0.4 ATR worse than the plan's entry on 6 of the last 20 trades.", Date.parse("2026-11-28T11:28:00Z"), "Place the entry limit 0.1 ATR inside the zone", null);
    at(Date.parse("2026-11-28T12:19:00Z"));
    const sRun = addSuggestion(db, { topic: "strategy:zone_pullback@intraday|normal-trending", rule: "context_negative", summary: "-0.28R per setup over 16 setups in intraday · normal-trending.", created: Date.parse("2026-11-28T09:14:00Z") });
    const approved = await decide(sRun, "approve", "decide:seed:run");
    const running = ok(approved, "approve running").session_id;
    const r0 = Date.parse("2026-11-28T12:22:00Z");
    await speak(env, running, [
      ["position", "risk", { stance: "oppose", opinion: "The losses come from the first hour of the trend, not the pullback.", proposal: "Wait for the second pullback.", refs: [0, 1] }, r0],
      ["position", "technical", { stance: "support", opinion: "The pullbacks that lost were shallow.", proposal: "Ask for a deeper pullback in a trend.", refs: [2] }, r0 + M],
      ["position", "projection", { stance: "amend", opinion: "Deeper, but only on the 1H trend's side.", proposal: null, refs: [3, 4] }, r0 + 2 * M],
      ["position", "m15", { stance: "support", opinion: "The 15m structure agrees.", proposal: null, refs: [5] }, r0 + 3 * M],
      ["position", "trade_management", { stance: "abstain", opinion: "The exits are not the question here.", proposal: null, refs: [] }, r0 + 4 * M],
      ["rebuttal", "risk", { stance: "oppose", opinion: "A deeper pullback is the second pullback by another name.", proposal: null, refs: [0], reply_to: ["technical"] }, r0 + 9 * M],
      ["rebuttal", "technical", { stance: "support", opinion: "Not quite: depth is measured, the count is not.", proposal: null, refs: [2], reply_to: ["risk"] }, r0 + 10 * M]
    ]);
    stepTo(env, running, "rebuttals", { calls: 9, ms: r0 + 10 * M });

    // The decide answers the page handles (each through the real Omega route and the real decideSuggestion).
    at(Date.parse("2026-11-28T12:30:00Z"));
    const replies = { approved, rejected };
    replies.replay = await decide(sRun, "approve", "decide:seed:run");
    replies.already_decided = await decide(sCost, "approve", "decide:seed:other");
    replies.expired = await decide(expiredRows[0], "approve", "decide:seed:late");
    // The owner's switch off: the start is refused and the suggestion is open again (then on again).
    ok(await council({ action: "switch", on: false }), "switch off");
    replies.session_refused = await decide(sOpenC, "approve", "decide:seed:refused");
    ok(await council({ action: "switch", on: true }), "switch on again");
    replies.not_found = await decide(9999, "reject", "decide:seed:missing");
    replies.bad_request = await decide(sOpenB, "maybe", "decide:seed:bad");
    replies.owner_only = await council({ action: "decide", suggestion_id: sOpenB, decision: "approve", idempotency_key: "decide:seed:viewer" }, a.viewer);
    replies.same_origin_only = await council({ action: "decide", suggestion_id: sOpenB, decision: "approve", idempotency_key: "decide:seed:xsite" }, a.owner, { "sec-fetch-site": "cross-site" });
    for (const [k, r] of Object.entries(replies)) if (!r || typeof r.status !== "number") throw new Error(`reply ${k}: ${JSON.stringify(r)}`);

    // The reads, as their routes send them, at the fixture's clock.
    at(NOW);
    const route = (body) => JSON.parse(JSON.stringify({ status: "ok", ...body }));
    const out = {
      suggestions: route({ ...(await readSuggestions(env, { now: NOW })) }),
      sessions: route(await listSessions(env)),
      sessionRunning: route({ session: await readSession(env, running) }),
      sessionDecided: route({ session: await readSession(env, knob) }),
      sessionReopened: route({ session: await readSession(env, free1) }),
      sessionPick: route({ session: await readSession(env, pick) }),
      sessionVeto: route({ session: await readSession(env, vetoOpen) }),
      sessionNoQuorum: route({ session: await readSession(env, noQ) }),
      archive: route(await readCouncilArchive(env, { limit: 50, now: NOW })),
      archiveActive: route(await readCouncilArchive(env, { scope: "active", limit: 50, now: NOW })),
      archiveEnded: route(await readCouncilArchive(env, { scope: "archive", limit: 50, now: NOW })),
      archiveEndedExpired: route(await readCouncilArchive(env, { scope: "archive", status: "expired", limit: 50, now: NOW })),
      archiveEndedPage1: route(await readCouncilArchive(env, { scope: "archive", limit: 4, now: NOW })),
      archiveEndedPage2: route(await readCouncilArchive(env, { scope: "archive", cursor: "4", limit: 4, now: NOW })),
      archiveOff: route(await readCouncilArchive({ ...env, CFC_MODE: "off" }, { scope: "active", limit: 50, now: NOW })),
      suggestionsOff: route(await readSuggestions({ ...env, CFC_MODE: "off" }, { now: NOW })),
      suggestionsAuto: route(await readSuggestions({ ...env, CFC_MODE: "auto" }, { now: NOW })),
      sessionsAuto: route(await listSessions({ ...env, CFC_MODE: "auto" })),
      sessionsOff: route(await listSessions({ ...env, CFC_MODE: "off" })),
      whoamiOwner: (await call(a.owner, { method: "GET", path: "/omega/api/whoami" })).body,
      whoamiViewer: (await call(a.viewer, { method: "GET", path: "/omega/api/whoami" })).body,
      replies: null
    };
    // The session controls, after the reads (they change the sessions): the owner's pick, the veto, a late Close.
    at(NOW + M);
    extra.accept = await council({ action: "accept", session_id: pick, option_id: "skip_ny_open" });
    extra.accept_again = await council({ action: "accept", session_id: pick, option_id: "skip_ny_open" });
    extra.close_decided = await council({ action: "close", session_id: knob });
    out.replies = JSON.parse(JSON.stringify({ ...replies, ...extra }));
    resetAll();
    const empty = Object.assign(await seedEnv(), { CFC_MODE: "auto" });
    out.archiveEmpty = route(await readCouncilArchive(empty, { scope: "active", limit: 50, now: NOW }));
    out.suggestionsEmpty = route(await readSuggestions(empty, { now: NOW }));
    resetAll();
    return out;
  });
}

export const FILES = Object.freeze({
  "suggestions.json": "suggestions", "sessions.json": "sessions", "session-running.json": "sessionRunning", "session-decided.json": "sessionDecided",
  "session-reopened.json": "sessionReopened", "session-pick.json": "sessionPick", "suggestions-auto.json": "suggestionsAuto", "sessions-auto.json": "sessionsAuto", "session-veto.json": "sessionVeto", "session-noquorum.json": "sessionNoQuorum", "archive.json": "archive", "archive-active.json": "archiveActive", "archive-ended.json": "archiveEnded",
  "archive-ended-expired.json": "archiveEndedExpired", "archive-ended-page1.json": "archiveEndedPage1", "archive-ended-page2.json": "archiveEndedPage2",
  "archive-empty.json": "archiveEmpty", "archive-off.json": "archiveOff", "suggestions-empty.json": "suggestionsEmpty", "suggestions-off.json": "suggestionsOff",
  "sessions-off.json": "sessionsOff", "whoami-owner.json": "whoamiOwner", "whoami-viewer.json": "whoamiViewer", "decide-replies.json": "replies"
});

// CLI: `node test/support/nexus-cf2-seed.mjs --write` rewrites the fixtures from the seed (after a contract change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedCf2();
  const dir = new URL("../fixtures/nexus-cf2/", import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const [name, key] of Object.entries(FILES)) await writeFile(new URL(name, dir), JSON.stringify(out[key], null, 2) + "\n");
  console.log(`wrote ${Object.keys(FILES).length} fixtures to test/fixtures/nexus-cf2/`);
}
