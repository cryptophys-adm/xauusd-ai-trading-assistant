// CF2, the Nexus Call for Councils page (the owner approved the mockup on 2026-11-28, "approved"; the API is CFC-A PR1,
// #677, and PR2, #680): its fixtures (test/fixtures/nexus-cf2/*.json, the seeded answers of the real routes:
// test/support/nexus-cf2-seed.mjs), its one adapter (ui/src/lib/councilArchive.ts: tones, the countdowns, the decide
// request and its answers, the archive by #680's scope with its exact counts, the council's own decision, the veto
// window), the confirms (Approve, Reject, Accept, Veto), the owner gate (a viewer sees no control), the idempotency key,
// the mode-aware option pick (the owner's Accept while a session waits for it; read-only once decided), and no price and
// no email in any render.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { seedCf2, FILES, NOW } from "./support/nexus-cf2-seed.mjs";
import { cleanKey } from "../src/cfc-lifecycle.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-cf2/${f}`));
const SUG = fixture("suggestions.json"), SES = fixture("sessions.json"), ARC = fixture("archive.json"), ACT = fixture("archive-active.json"), END = fixture("archive-ended.json");
const P1 = fixture("archive-ended-page1.json"), P2 = fixture("archive-ended-page2.json"), PICK = fixture("session-pick.json"), VETO = fixture("session-veto.json"), NOQ = fixture("session-noquorum.json");
const RUN = fixture("session-running.json"), DEC = fixture("session-decided.json"), REOPEN = fixture("session-reopened.json"), REPLIES = fixture("decide-replies.json");
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
/** An email, or a gold price (the seeded trades' 4001.25, 3995.5, 4012.75: never in a pack, a session or a page). */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/, PRICE = /\b[1-5]\d{3}\.\d{1,2}\b/;

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/councilArchive"; export { SuggestionsView, SuggestionCard, SessionsView, SessionDetailView, ArchiveView, CouncilHeader, OneLine } from "./src/pages/Councils"; export { GateOverride } from "./src/components/Correction"; export { render, VIEWS, CF2_VIEWS, CF2_NOW } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
async function html(View) { const u = await ui(); const h = u.render(View, null); clean(h); return h; }

test("CF2-1 the fixtures are the seed's answers over #677's real code, byte for byte", async () => {
  const seed = await seedCf2();
  for (const [name, key] of Object.entries(FILES)) assert.deepEqual(fixture(name), seed[key], `${name}: regenerate with \`node test/support/nexus-cf2-seed.mjs --write\` after a contract change`);
  // What the brief asked the seed to cover.
  const st = (s) => SUG.suggestions.filter((x) => x.status === s).length;
  assert.deepEqual([st("open"), st("approved") > 0, st("rejected"), st("expired") > 0], [3, true, 1, true]);
  assert.ok(SUG.suggestions.some((x) => x.status === "open" && Date.parse(x.expires_at) - NOW < 3_600_000), "one expires under 1 h");
  assert.deepEqual(new Set(SES.sessions.map((s) => s.state)), new Set(["rebuttals", "awaiting_owner", "decided", "aborted", "closed"]));
  assert.deepEqual([SUG.mode, fixture("suggestions-auto.json").mode, fixture("sessions-auto.json").mode], ["on", "auto", "auto"], "production's on, and auto");
  assert.deepEqual([PICK.session.state, PICK.session.reason], ["awaiting_owner", null], "CFC_MODE on: a quorum, the owner picks");
  assert.deepEqual([NOQ.session.state, NOQ.session.reason], ["awaiting_owner", "no quorum (3 of 6 spoke)"], "auto without a quorum: the owner picks");
  const veto = ARC.items.find((c) => c.status === "veto_window");
  assert.deepEqual([veto.next_actor, veto.proposal.decided_by, veto.proposal.council_decision.option_id, veto.session.id], ["owner", "council", "task", VETO.session.id]);
  assert.ok(ARC.items.some((c) => c.status === "vetoed" && c.next_actor === "none"), "a vetoed one");
  assert.deepEqual([ARC.counts.total, ARC.counts.active, ARC.counts.archive, ACT.scope, END.scope, ACT.total, END.total], [20, 9, 11, "active", "archive", 9, 11], "#680's scopes and counts");
  assert.deepEqual([fixture("archive-ended-expired.json").status_filter, fixture("archive-ended-expired.json").total], ["expired", 5]);
  assert.ok(ARC.items.some((c) => c.session?.reopened_as), "a re-opened session");
  assert.ok(ARC.items.some((c) => c.proposal?.platform?.close_code === "out_of_scope"), "a proposal with its close code");
  assert.ok(ARC.items.some((c) => c.status === "shadow_test" && c.next_actor === "shadow"), "a shadow one");
  assert.ok(ARC.items.some((c) => c.topic.origin === "owner" && c.chain_id.startsWith("session:")), "an owner free-text chain");
  assert.deepEqual(Object.fromEntries(Object.entries(REPLIES).map(([k, r]) => [k, r.status])),
    { approved: 200, rejected: 200, replay: 200, already_decided: 409, expired: 409, session_refused: 409, not_found: 404, bad_request: 400, owner_only: 403, same_origin_only: 403,
      veto: 200, accept: 200, accept_again: 400, close_decided: 400 });
  assert.equal(REPLIES.veto.body.proposal_state, "vetoed");
  assert.equal(REPLIES.replay.body.replay, true);
  assert.deepEqual([fixture("archive-empty.json").total, fixture("archive-empty.json").items], [0, []]);
  // CFC_MODE off: the archive answers the same chains (it reads D1 whatever the mode); the suggestions say mode off, sessions are off.
  assert.deepEqual(fixture("archive-off.json"), ACT);
  assert.deepEqual([fixture("suggestions-off.json").mode, fixture("sessions-off.json").enabled], ["off", false]);
});

test("CF2-2 the owner gate is the feature-switch read's viewer.can_control; whoami agrees since CF2a (#682), and the page still does not read it", async () => {
  // CF2a (#682): GET /omega/api/whoami answers can_control and is_owner as the owner check (OWNER_ACCESS_SUB); before, any person.
  assert.deepEqual([fixture("whoami-owner.json").can_control, fixture("whoami-viewer.json").can_control], [true, false]);
  assert.deepEqual([fixture("whoami-owner.json").is_owner, fixture("whoami-viewer.json").is_owner], [true, false]);
  const page = src("pages/Councils.tsx");
  assert.doesNotMatch(page + src("lib/councilArchive.ts"), /whoami/, "the page never reads whoami for its gate");
  assert.match(page, /const canControl = useOwnerGate\(\);/);
  assert.match(src("components/Correction.tsx"), /export function useOwnerGate\(\): boolean \{\n  const override = useContext\(GateOverride\);\n  const shared = useSharedGate\(\);\n  return \(override \?\? shared\)\.canControl;/);
  // The H3f fixtures' feature-switch reads: the owner true, another signed-in person false.
  const fs = (f) => JSON.parse(read(`test/fixtures/nexus-h3f/${f}`)).viewer.can_control;
  assert.deepEqual([fs("feature-switches-on.json"), fs("feature-switches-viewer.json")], [true, false]);
});

test("CF2-3 tones: approved/decided/live/merged/deployed cyan, open/running/in progress amber, refused/rolled back/aborted red, expired/closed/rejected/handed off grey, shadow violet; no green", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const want = { ok: ["approved", "decided", "live", "merged", "deployed"], late: ["open", "expiring", "running", "in_progress", "queued_external", "proposed", "awaiting_approval", "in_session", "awaiting_pick", "veto_window"],
    fault: ["refused", "rolled_back", "aborted"], off: ["expired", "closed", "rejected", "handed_off", "none", "no_change", "vetoed"], shadow: ["shadow", "shadow_test", "queued_shadow"] };
  for (const [tone, list] of Object.entries(want)) for (const s of list) assert.equal(u.toneOf(s), tone, s);
  assert.equal(u.toneOf("something_new"), "plain");
  for (const s of [...ARC.vocab.chain_status, ...SUG.lifecycle.statuses]) assert.ok(!["bull", "bear", "neutral"].includes(u.toneOf(s)), s);
  assert.doesNotMatch(src("lib/councilArchive.ts") + src("pages/Councils.tsx"), /\b(?:emerald|rose|green|bull)-|text-bull|bg-bull/, "no green for a status");
});

test("CF2-4 the adapter: suggestions soonest expiry first, the countdown late under 1 h in UTC · GMT+7, sessions, the session detail, null-safe", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const s = u.suggestionsOf(SUG, NOW);
  assert.deepEqual(s.open.map((x) => [x.topicKey, x.countdown.left, x.countdown.soon]), [["execution:recoveries", "42m", true], ["strategy:zone_pullback:exits", "3h 12m", false], ["engine:model", "11h 05m", false]]);
  assert.equal(s.open[0].countdown.at, "15:30 UTC · 22:30 GMT+7");
  assert.equal(s.open[0].countdown.tone, "late");
  assert.ok(s.open[1].countdown.remaining > 0 && s.open[1].countdown.remaining < 1, "the bar runs from created_at to expires_at");
  assert.equal(u.whenText("2026-11-27T06:40:00.000Z", NOW), "27 Nov 06:40 UTC · 13:40 GMT+7");
  assert.ok(s.recent.every((x) => x.status !== "open"));
  const ses = u.sessionsOf(SES, NOW);
  assert.deepEqual([ses.running.length, ses.waiting.length, ses.ended.length, ses.today, ses.perDay, ses.enabled], [1, 2, 8, 3, 4, true]);
  assert.ok(ses.ended.every((r) => !r.reason || !EMAIL.test(r.reason)), "the reason's email is masked");
  const d = u.detailOf(DEC.session, u.chainFor(u.archiveOf(ARC), { sessionId: DEC.session.id }));
  assert.deepEqual([d.options.map((o) => [o.id, o.picked]), d.pickedBy, d.awaitingPick], [[["raise_rrr", true], ["hold_exits", false], ["no_change", false]], "council", false]);
  assert.deepEqual([d.council.optionId, d.council.quorum, d.council.spoke, d.council.need, d.council.tally.support], ["raise_rrr", true, 6, 4, 4], "#680's council_decision, read-only");
  assert.equal(d.council.rationale, "raise_rrr: 4 of 6 seats support (needs 4); the knob is inside its bounds");
  const pk = u.detailOf(PICK.session, u.chainFor(u.archiveOf(ARC), { sessionId: PICK.session.id }));
  assert.deepEqual([pk.awaitingPick, pk.council, pk.options.some((o) => o.picked)], [true, null, false], "the owner's pick is still to come");
  assert.equal(d.options[0].knob, "decision.min_rrr.intraday: 1.5 → 1.7 R");
  assert.deepEqual(d.seats.map((x) => [x.id, x.stance]).slice(0, 2), [["risk", "oppose"], ["technical", "support"]]);
  const run = u.detailOf(RUN.session);
  assert.deepEqual([run.step, run.seats.filter((x) => x.opinion).length, run.seats.filter((x) => x.response).length], ["responses", 5, 2]);
  assert.equal(u.detailOf(REOPEN.session).reason, `reopened as ${REOPEN.session.reason.split(" ")[2]} by owner`);
  assert.equal(u.tallyText(u.tallyOf({ support: 4, oppose: 1, amend: 1, abstain: 0 })), "4 agree · 1 change · 1 disagree · 0 abstain");
  assert.equal(u.tallyOf({}), null, "no tally: no line (there is no per-option tally yet, PR2)");
  for (const bad of [null, undefined, {}, [], "x", 7, { suggestions: "x", sessions: [null, 1], items: [null, "x"], vocab: null }]) {
    assert.deepEqual(u.suggestionsOf(bad, NOW).open, []);
    assert.ok(Array.isArray(u.sessionsOf(bad, NOW).running));
    assert.ok(Array.isArray(u.archiveOf(bad).chains));
    assert.equal(u.detailOf(bad), null);
    assert.equal(typeof u.summaryText(u.splitArchive(u.archiveOf(bad))), "string");
  }
});

test("CF2-5 the idempotency key: decide:<id>:<decision>:<random>, 1-64 of [A-Za-z0-9_.:-] as #677's cleanKey keeps it, one per click intent", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const keys = Array.from({ length: 50 }, () => u.decideKey(12, "approve"));
  for (const k of keys) {
    assert.match(k, /^decide:12:approve:[a-z0-9]{1,16}$/);
    assert.ok(k.length <= 64);
    assert.equal(cleanKey(k), k, "the server keeps it as sent");
  }
  assert.equal(new Set(keys).size, keys.length, "a new key per intent");
  assert.equal(u.decideKey(987654321, "reject", "x!y z"), "decide:987654321:reject:xyz");
  assert.equal(cleanKey(u.decideKey(1, "approve", "z".repeat(200))), u.decideKey(1, "approve", "z".repeat(200)), "capped at 64");
  assert.deepEqual(u.decideRequest(12, "reject", "decide:12:reject:abc"), { action: "decide", suggestion_id: 12, decision: "reject", idempotency_key: "decide:12:reject:abc" });
  // The write: same origin, JSON, POST /omega/api/council; an unanswered request is { status: null }, never a throw.
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify(REPLIES.approved.body), { status: 200, headers: { "content-type": "application/json" } }); };
  const r = await u.postCouncil(u.decideRequest(12, "approve", "decide:12:approve:k1"), fetchImpl);
  assert.equal(r.status, 200);
  assert.deepEqual([calls[0][0], calls[0][1].method, calls[0][1].credentials, calls[0][1].headers["content-type"], JSON.parse(calls[0][1].body).idempotency_key], ["/omega/api/council", "POST", "same-origin", "application/json", "decide:12:approve:k1"]);
  assert.deepEqual(await u.postCouncil({}, async () => { throw new TypeError("Failed to fetch"); }), { status: null, body: null });
  // The page keeps a refused or unanswered intent's key for its retry, and makes a new one otherwise.
  assert.match(src("pages/Councils.tsx"), /const key = prev\?\.key && prev\.decision === decision && prev\.result\?\.retry \? prev\.key : decideKey\(id, decision\);/);
});

test("CF2-6 the decide answers: 200 and a replay succeed; 409 already_decided and expired refresh; session_refused retries; 404, 400, 403 and no answer inline", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const k = (name, d = "approve") => { const r = u.decideResult(REPLIES[name].status, REPLIES[name].body, d, NOW); return [r.kind, r.code, r.refresh, r.retry, r.tone]; };
  assert.deepEqual(k("approved"), ["ok", "200", true, false, "ok"]);
  assert.deepEqual(k("rejected", "reject"), ["ok", "200", true, false, "ok"]);
  assert.deepEqual(k("replay"), ["ok", "200 replay", true, false, "ok"], "a replay is a success");
  assert.equal(u.decideResult(200, REPLIES.approved.body, "approve", NOW).sessionId, REPLIES.approved.body.session_id);
  assert.deepEqual(k("already_decided"), ["already_decided", "409 already_decided", true, false, "late"]);
  assert.deepEqual(k("expired"), ["expired", "409 expired", true, false, "late"]);
  assert.equal(u.decideResult(409, REPLIES.expired.body, "approve", NOW).suggestion.status, "expired", "shown as expired");
  assert.deepEqual(k("session_refused"), ["session_refused", "409 session_refused", true, true, "fault"]);
  assert.equal(u.decideResult(409, REPLIES.session_refused.body, "approve", NOW).suggestion.status, "open", "open again");
  assert.deepEqual(k("not_found"), ["error", "404 not_found", true, false, "fault"]);
  assert.deepEqual(k("bad_request"), ["error", "400 bad_request", false, false, "fault"]);
  assert.deepEqual(k("owner_only"), ["error", "403 owner_only", false, false, "fault"]);
  assert.deepEqual(k("same_origin_only"), ["error", "403 same_origin_only", false, false, "fault"]);
  assert.deepEqual(u.decideResult(502, { error: "council_failed" }, "approve", NOW).retry, true);
  assert.deepEqual([u.decideResult(null, null, "approve", NOW).code, u.decideResult(null, null, "approve", NOW).retry], ["network", true]);
  // The session controls (#680): the veto answers proposal_state vetoed; a Close on a decided session outside a window is refused.
  const c = (k, action) => { const r = u.controlResult(action, REPLIES[k].status, REPLIES[k].body); return [r.ok, r.vetoed, r.words]; };
  assert.deepEqual(c("veto", "close"), [true, true, "Vetoed. The council's task is not handed off."]);
  assert.deepEqual(c("accept", "accept"), [true, false, "Accepted. The task goes to the platform."]);
  assert.deepEqual(c("accept_again", "accept"), [false, false, "Not done: only a session waiting for your pick can be accepted (this one is decided)."]);
  assert.deepEqual(c("close_decided", "close"), [false, false, "Not done: the session is already decided."]);
  assert.deepEqual(u.controlResult("close", null, null).words, "No answer from Nexus. Nothing changed.");
  // Shown inline, in role="alert" for a fault (the render check's Cf2Decide_* views show each one).
  const card = await html(() => u.SuggestionCard({ s: u.suggestionsOf(SUG, NOW).open[1], now: NOW, canControl: true, state: { result: u.decideResult(403, REPLIES.owner_only.body, "approve", NOW), decision: "approve" } }));
  assert.match(card, /role="alert"[^>]*><span class="mono whitespace-nowrap font-semibold">403 owner_only<\/span>/);
});

test("CF2-7 Approve and Reject both ask first (owner \"Pakai konfirmasi\"): ConfirmDialog, Approve ok cyan, Reject late amber, no reason field; nothing is sent before the answer; Accept and Veto confirm too", () => {
  const page = src("pages/Councils.tsx");
  const decide = page.slice(page.indexOf("const decide = async"), page.indexOf("const onSwitch"));
  assert.match(decide, /approve \? \{ confirmLabel: "Approve", tone: "ok" \} : \{ confirmLabel: "Reject", tone: "late" \}/);
  assert.match(decide, /title: approve \? "Approve this topic\?" : "Reject this topic\?"/);
  assert.ok(decide.indexOf("await confirm(") < decide.indexOf("if (!ok) return;") && decide.indexOf("if (!ok) return;") < decide.indexOf("postCouncil("), "the POST only after a yes");
  assert.doesNotMatch(decide, /reason:/, "no reason field: the page had none");
  assert.match(page, /import \{ useConfirm \} from "\.\.\/components\/ConfirmDialog";/);
  // The owner's pick (CFC_MODE on, or auto without a quorum) and the veto, each behind its confirm.
  const detail = page.slice(page.indexOf("function SessionDetail("), page.indexOf("export default function Councils()"));
  assert.match(detail, /confirmLabel: "Accept", tone: "ok" \}\)\)\) return;\n\s*await act\(\{ action: "accept", session_id: id, option_id: o\.id \}\);/);
  assert.match(detail, /onVeto: async \(\) => \{ if \(await confirm\(\{ title: "Veto the council's task\?"[\s\S]*?confirmLabel: "Veto", tone: "fault" \}\)\) await act\(\{ action: "close", session_id: id \}\); \}/);
  // The other confirms the page keeps.
  assert.match(page, /confirmLabel: "Close session", tone: "late" \}/);
  assert.match(page, /confirmLabel: "Turn off", tone: "fault" \}/);
});

test("CF2-8 a non-owner sees no Approve, no Reject, no switch, no session controls; everything else shows", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const sug = u.suggestionsOf(SUG, NOW), a = u.archiveOf(ARC);
  const viewer = await html(() => u.SuggestionsView({ sug, archive: a, now: NOW, canControl: false }));
  const owner = await html(() => u.SuggestionsView({ sug, archive: a, now: NOW, canControl: true }));
  assert.doesNotMatch(viewer, />Approve<|>Reject<|Approving|Rejecting/);
  assert.equal((owner.match(/>Approve</g) ?? []).length, 3, "one per open card for the owner");
  assert.equal((owner.match(/>Reject</g) ?? []).length, 3);
  for (const t of ["expires in 42m", "execution:recoveries", "Evidence", "Recent"]) assert.ok(viewer.includes(t), t);
  const head = (c) => html(() => u.CouncilHeader({ mode: "on", sessions: u.sessionsOf(SES, NOW), canControl: c }));
  assert.doesNotMatch(await head(false), /Turn off|Turn on/);
  assert.match(await head(true), />Turn off</);
  const chain = u.chainFor(a, { sessionId: RUN.session.id });
  const det = (c) => html(() => u.SessionDetailView({ d: u.detailOf(RUN.session, chain), chain, now: NOW, canControl: c, enabled: true }));
  assert.doesNotMatch(await det(false), /Re-open|>Close<|Write to the agents/);
  assert.match(await det(true), /Re-open with fresh evidence[\s\S]*>Close<[\s\S]*Write to the agents/);
  const view = (name) => { const e = u.CF2_VIEWS.find((v) => v.name === name); return u.render(e.View, e.fixture); };
  assert.doesNotMatch(view("Cf2DetailPickViewer"), />Accept<|>Close</, "no pick for a viewer");
  assert.match(view("Cf2DetailPick"), />Accept</);
  assert.doesNotMatch(view("Cf2DetailVetoViewer"), />Veto</, "no veto for a viewer");
  assert.match(view("Cf2DetailVeto"), />Veto</);
});

test("CF2-9 the option pick is mode-aware: a decided session's pick is read-only (the council's decision, the stance tally); a session waiting for the owner offers Accept; no start, no free topic, no picker", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The owner's view of the decided session, with the correction gate on (the render check's Cf2DetailDecided).
  const e = u.CF2_VIEWS.find((v) => v.name === "Cf2DetailDecided");
  const h = u.render(e.View, DEC);
  clean(h);
  for (const t of ["Options the council weighed", "council&#x27;s pick", "decided by <span class=\"font-semibold text-fg\">council</span>", "Decided by council", "quorum · 6 spoke · needs 4", "raise_rrr: 4 of 6 seats support (needs 4)", "Seat votes", "Risk Manager", "disagree", "4 agree · 1 change · 1 disagree · 0 abstain"]) assert.ok(h.includes(t), t);
  assert.doesNotMatch(h, />Accept</);
  const options = h.slice(h.indexOf("Options the council weighed"), h.indexOf("Seat votes"));
  assert.deepEqual([...options.matchAll(/<button[^>]*>([^<]*)/g)].map((m) => m[1]).filter((t) => !/^$/.test(t)), [], "no button among a decided session's options but the correction control's icon");
  // Waiting for the owner (CFC_MODE on with a quorum, or auto without one): one Accept per option, for the owner only.
  for (const name of ["Cf2DetailPick", "Cf2DetailNoQuorum"]) {
    const e = u.CF2_VIEWS.find((v) => v.name === name);
    const w = u.render(e.View, e.fixture);
    const n = (e.fixture.session.options.options ?? []).length;
    assert.equal((w.match(/>Accept</g) ?? []).length, n, `${name}: an Accept per option`);
    assert.doesNotMatch(w, /Decided by council|&#x27;s pick</);
  }
  const page = src("pages/Councils.tsx") + src("lib/councilArchive.ts");
  for (const gone of [/action: "start"/, /Build the evidence pack/, /Or a topic key/, /write your own topic/, /\/api\/strategy-agents/]) assert.doesNotMatch(page, gone, String(gone));
  for (const kept of [/action: "accept", session_id: id, option_id: o\.id/, /action: "close", session_id: id/, /action: "reopen", session_id: id/, /action: "message", session_id: id, text, to/, /action: "switch", on/]) assert.match(page, kept, String(kept));
  assert.match(page, /\{d\.awaitingPick && canControl && actions\.onAccept \? <button/, "Accept only while the session waits for the owner, and only for the owner");
  // H3f stays on its council hosts: each opinion card, each seat's vote and under the moderator's options.
  assert.match(page, /<CorrectionControl target=\{councilOptionsTarget\(s\)\} className=\{`mt-\[12px\] \$\{ROW\}`\} \/><\/div>/);
  assert.match(page, /<td>\{p\.message \? <CorrectionControl target=\{councilOpinionTarget\(p\.message\)\} \/> : null\}<\/td>/);
});

test("CF2-10 the archive by #680's scope: the default view reads scope=active, the Archive view scope=archive (status= its filter); the summary line is the server's exact counts; expired rows one line; Load more on the cursor", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(u.archivePath(null, 50, "active"), "/api/council/archive?limit=50&scope=active");
  assert.equal(u.archivePath(null, 50, "archive", "expired"), "/api/council/archive?limit=50&scope=archive&status=expired");
  assert.equal(u.archivePath("4", 50, "archive", "all"), "/api/council/archive?limit=50&scope=archive&cursor=4");
  const page = src("pages/Councils.tsx");
  assert.match(page, /get\(archivePath\(null, ARCHIVE_PAGE, "active"\)\)/);
  assert.match(page, /get\(archivePath\(null, ARCHIVE_PAGE, "archive", aui\.filter \?\? "all"\)\)/);
  assert.match(page, /get\(archivePath\(ended\.nextCursor, ARCHIVE_PAGE, "archive", f\)\)/);
  const a = u.archiveOf(ACT), e = u.archiveOf(END);
  const sp = u.splitArchive(a, e);
  assert.deepEqual(sp.active.map((c) => c.id), ACT.items.map((c) => c.chain_id));
  assert.deepEqual(sp.archived.map((c) => c.id), END.items.map((c) => c.chain_id));
  assert.ok(ACT.items.every((c) => c.next_actor !== "none") && END.items.every((c) => c.next_actor === "none"));
  // The counts, by status, from the server's counts.by_status restricted to the ended chains: exact.
  const want = {};
  for (const c of ARC.items.filter((x) => x.next_actor === "none")) want[c.status] = (want[c.status] ?? 0) + 1;
  assert.deepEqual(want, { expired: 5, rejected: 1, refused: 1, aborted: 1, closed: 2, vetoed: 1 });
  assert.equal(u.summaryText(sp), "Archive: 5 expired · 2 closed · 1 aborted · 1 refused · 1 rejected · 1 vetoed");
  assert.deepEqual([sp.exact, sp.archivedTotal, sp.activeTotal], [true, 11, 9]);
  // Exact from the counts alone, even before the ended scope is read or with only its first page.
  assert.equal(u.summaryText(u.splitArchive(a, null)), "Archive: 5 expired · 2 closed · 1 aborted · 1 refused · 1 rejected · 1 vetoed");
  assert.equal(u.splitArchive(a, u.archiveOf(P1)).exact, true);
  const closed = await html(() => u.ArchiveView({ active: a, ended: e, now: NOW }));
  for (const c of END.items) assert.ok(!closed.includes(`title="${c.topic.key}"`), `${c.chain_id} is not listed by default`);
  for (const c of ACT.items) assert.ok(closed.includes(c.topic.key), `${c.chain_id} is listed`);
  assert.match(closed, /aria-expanded="false"[^>]*>.*Archive: 5 expired · 2 closed · 1 aborted · 1 refused · 1 rejected · 1 vetoed<\/button>/);
  assert.doesNotMatch(closed, /in the last/);
  const open = await html(() => u.ArchiveView({ active: a, ended: e, now: NOW, ui: { open: true } }));
  const lines = [...open.matchAll(/<div data-line="one"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(lines.length, 6, "the 5 expired and the 1 rejected topic, one line each");
  for (const l of lines) assert.match(l, /^<span class="mono[^"]*" title="[^"]+">[^<]+<\/span><span[^>]*class="chip[^"]*">(expired|rejected)<\/span><span class="mono[^"]*">(expired|rejected) at [^<]+ UTC · [^<]+ GMT\+7<\/span>$/);
  assert.ok(!/<article/.test(open.slice(open.indexOf('data-line="one"'))), "no card after the one-line rows");
  assert.match(open, /out_of_scope/, "a refused chain keeps its close code, in mono");
  const ex = await html(() => u.ArchiveView({ active: a, ended: u.archiveOf(fixture("archive-ended-expired.json")), now: NOW, ui: { open: true, filter: "expired" } }));
  assert.equal((ex.match(/data-line="one"/g) ?? []).length, 5);
  assert.match(ex, /5 of 5 expired/);
  assert.doesNotMatch(ex, /out_of_scope/);
  // The status filter offers every ended status of the window (the server's counts), not only the loaded ones.
  assert.deepEqual(u.archiveStatuses(u.splitArchive(a, u.archiveOf(P1)), a.statuses, a.counts), ["all", "rejected", "expired", "closed", "aborted", "vetoed", "refused"]);
  // Load more: the next page of the same scope by its cursor.
  const p1 = u.archiveOf(P1), both = u.mergeArchive(p1, u.archiveOf(P2));
  assert.deepEqual([p1.nextCursor, both.nextCursor, both.chains.map((c) => c.id)], ["4", "8", END.items.slice(0, 8).map((c) => c.chain_id)]);
  assert.equal(u.mergeArchive(both, u.archiveOf(P2)).chains.length, 8, "a page loaded twice is kept once");
  assert.match(await html(() => u.ArchiveView({ active: a, ended: p1, now: NOW, ui: { open: true } })), />Load more<\/button><span class="mono text-\[11px\] text-muted">4 of 11 loaded<\/span>/);
  // An older server without counts: the split falls back to the loaded chains and says so.
  const legacy = u.archiveOf({ ...ARC, counts: undefined, next_cursor: "50" });
  assert.match(u.summaryText(u.splitArchive(legacy)), / in the last 20 loaded of 20$/);
});

test("CF2-11 the Suggestions tab's Recent list: only topics whose chain still needs someone; the ended ones are one line that opens the Archive", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const h = await html(() => u.SuggestionsView({ sug: u.suggestionsOf(SUG, NOW), archive: u.archiveOf(ARC), now: NOW, canControl: true, onOpenArchive: () => {} }));
  const recent = h.slice(h.indexOf('id="cfc-recent"'));
  for (const t of ["strategy:zone_pullback@intraday|normal-trending", "execution:rejected_intents", "strategy:zone_pullback<"]) assert.ok(recent.includes(t), t);
  for (const t of ["data:market_feed", "cost:council", "risk:london", "engine:15", "risk:normal-trending"]) assert.ok(!recent.includes(t), `${t} is ended: counted, not listed`);
  assert.match(recent, /<button[^>]*>Recent: 5 expired · 1 aborted · 1 refused · 1 rejected · 1 vetoed<\/button>/);
});

test("CF2-12 no price and no email in any render of the page's views, and in no fixture but the session reads the page masks", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.ok(u.CF2_VIEWS.length >= 30);
  for (const e of u.CF2_VIEWS) {
    const h = u.render(e.View, e.fixture);
    clean(h);
    assert.doesNotMatch(h, EMAIL, `${e.name}: no email`);
    assert.doesNotMatch(h, PRICE, `${e.name}: no price`);
  }
  for (const [name] of Object.entries(FILES)) assert.doesNotMatch(read(`test/fixtures/nexus-cf2/${name}`), PRICE, `${name}: no price`);
  // CF2a (#682): the session reads are masked server-side (maskActor); the page's own mask stays as a second guard.
  assert.doesNotMatch(JSON.stringify(REOPEN), EMAIL);
  assert.equal(u.maskEmail("owner_closed by owner@example.com"), "owner_closed by owner");
});

test("CF2-13 the page: three tabs, the header's mode and switch, the render-check views for every state", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const page = src("pages/Councils.tsx");
  assert.match(page, /\["suggestions", "Suggestions", open\], \["sessions", "Sessions", running\], \["archive", "Archive", null\]/);
  const names = u.CF2_VIEWS.map((v) => v.name);
  for (const n of ["Cf2SuggestionsOwner", "Cf2SuggestionsViewer", "Cf2SuggestionsEmpty", "Cf2SuggestionsOff", "Cf2CardSending", "Cf2CardApproved", "Cf2CardRejected", "Cf2CardExpired",
    "Cf2Decide_already_decided", "Cf2Decide_expired", "Cf2Decide_session_refused", "Cf2Decide_not_found", "Cf2Decide_bad_request", "Cf2Decide_owner_only", "Cf2Decide_same_origin_only",
    "Cf2SuggestionsAuto", "Cf2SessionsOwner", "Cf2SessionsAuto", "Cf2DetailDecided", "Cf2DetailPick", "Cf2DetailPickViewer", "Cf2DetailNoQuorum", "Cf2DetailVeto", "Cf2DetailVetoViewer", "Cf2DetailVetoed", "Cf2HeaderAuto", "Cf2ConfirmAccept", "Cf2ConfirmVeto", "Cf2DetailViewer", "Cf2DetailRunning", "Cf2DetailReopened", "Cf2ArchiveActive", "Cf2ArchiveOpen", "Cf2ArchivePage1", "Cf2ArchiveEmpty",
    "Cf2ArchiveOff", "Cf2Archive404", "Cf2Archive503", "Cf2HeaderOwner", "Cf2HeaderViewer", "Cf2HeaderOff", "Cf2ConfirmApprove", "Cf2ConfirmReject"]) assert.ok(names.includes(n), n);
  for (const e of u.CF2_VIEWS) {
    const h = u.render(e.View, e.fixture);
    for (const t of e.shows ?? []) assert.ok(h.includes(t), `${e.name} shows ${t}`);
    for (const t of e.hides ?? []) assert.ok(!h.includes(t), `${e.name} hides ${t}`);
  }
  assert.ok(u.VIEWS.some((v) => v.name === "Cf2ArchiveOpen"), "in the render check's registry");
});

test("CF2-14 the veto window (#680): late amber, next actor owner, a countdown to the pick plus 2 h in UTC · GMT+7; vetoed is grey and ended", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const c = u.chainFor(u.archiveOf(ARC), { sessionId: VETO.session.id });
  assert.deepEqual([c.status, c.tone, c.nextActor, c.terminal, c.proposal.decidedBy], ["veto_window", "late", "owner", false, "council"]);
  assert.equal(u.VETO_WINDOW_MS, 2 * 3_600_000);
  assert.equal(c.proposal.vetoUntil, new Date(Date.parse(c.proposal.decidedAt) + 2 * 3_600_000).toISOString(), "the reads carry no veto_until: the pick's time plus the window");
  const cd = u.vetoCountdown(c, NOW);
  assert.deepEqual([cd.left, cd.at, cd.tone], ["22m", "15:10 UTC · 22:10 GMT+7", "late"]);
  assert.equal(u.vetoCountdown(c, Date.parse(c.proposal.vetoUntil) + 60_000).left, "0m");
  const vetoed = u.archiveOf(ARC).chains.find((x) => x.status === "vetoed");
  assert.deepEqual([vetoed.tone, vetoed.terminal, u.vetoCountdown(vetoed, NOW)], ["off", true, null]);
  // CF2a (#682): the archive masks the vetoed note server-side ("vetoed by owner"); the adapter's mask is a second guard.
  assert.doesNotMatch(JSON.stringify(ARC), /vetoed by [^"]*@/);
  assert.equal(vetoed.proposal.note, "vetoed by owner");
});

test("CF2-15 the deploy smoke step: the Councils archive in both scopes, no email, no price", () => {
  const wf = read(".github/workflows/deploy-nexus-dashboard.yml");
  const at = wf.indexOf("- name: Smoke test the Call for Councils archive");
  assert.ok(at > wf.indexOf("- name: Smoke test the Position Manager lines"), "after the other smoke steps");
  const step = wf.slice(at, wf.indexOf("NODE\n", wf.indexOf("node --input-type=module", at)) + 5);
  assert.match(step, /https:\/\/nexus\.cryptophys\.work\/api\/council\/archive/);
  assert.match(step, /for \(const scope of \["active", "archive"\]\)/, "both scopes");
  assert.match(step, /isAccessLogin\(bare\)/, "the Access redirect without the token");
  assert.match(step, /headers: token\.headers/, "under the CI token");
  assert.match(step, /r\.status !== 200/);
  assert.match(step, /\\bjson\\b/);
  assert.match(step, /no-store/);
  assert.match(step, /Array\.isArray\(body\?\.items\)/);
  assert.match(step, /body\?\.counts\?\.by_status/);
  assert.match(step, /const EMAIL = /, "no email address");
  assert.doesNotMatch(step, /text\.includes\("@"\)/, "a bare @ is not an email: topic keys carry it");
  assert.match(step, /const PRICE = /, "no price-like number");
});

