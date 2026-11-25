// H3f UI, the owner's correction control ("feat(nexus): the owner's Rate / correct control (H3f)", the owner-approved
// mockup "H3f Correction control mockup"; the Orchestrator's rulings of 2026-11-25 11:37Z and 11:38Z): its fixtures
// (test/fixtures/nexus-h3f/*.json, the seeded answers of the real Omega route and AI Worker: test/support/nexus-h3f-seed.mjs),
// the gate (viewer.can_control and OWNER_CORRECTIONS "on", one shared read), the targets of the v1 hosts (the engine
// decision's ev:xauusd/engine_decisions/<decision_key>; the rooms', councils' and strategy council's own ev_ref, #588; the
// decision audit cards and rows hidden: they carry no ev: ref), the body the real route accepts, every reply code with its words, no green for up, no email, no price, and
// one write: POST /omega/api/correction from the control only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { seedH3f, ENGINE_TARGET } from "./support/nexus-h3f-seed.mjs";
import { correctionRequest, CORRECTION_ROUTE_CATEGORIES, CORRECTION_ROUTE_SOURCES } from "../workers/xauusd-omega/src/omega.mjs";
import { REF_RE as PACK_REF_RE } from "../src/cfc-pack.mjs";
import { parseRef, refCarriesPrice } from "../src/owner-corrections.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-h3f/${f}`));
const OFF = fixture("feature-switches-off.json"), ON = fixture("feature-switches-on.json"), VIEWER = fixture("feature-switches-viewer.json");
const REPLIES = fixture("correction-replies.json"), SESSION = fixture("council-session.json");
const WAR = fixture("war-room.json"), H1 = fixture("thread-h1.json"), VERDICTS = fixture("strategy-verdicts.json");
const ENGINE = JSON.parse(read("test/fixtures/nexus-ez1/conclusion-global.json")).engine;
const FIXTURES = ["feature-switches-off.json", "feature-switches-on.json", "feature-switches-viewer.json", "correction-replies.json", "council-session.json", "war-room.json", "thread-h1.json", "strategy-verdicts.json"];
const EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/corrections"; export * from "./src/components/Correction"; export { OpinionCard } from "./src/pages/Councils"; export { render, VIEWS, H3F_VIEWS, H3F_ENGINE } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
const count = (s, re) => (s.match(re) ?? []).length;
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);

test("HC1 the fixtures are the seed's answers, byte for byte: the FS1 reads off, on and a viewer's, and every reply of the route", async () => {
  const seed = await seedH3f();
  assert.deepEqual(OFF, seed.off, "feature-switches-off.json: regenerate with `node test/support/nexus-h3f-seed.mjs --write`");
  assert.deepEqual(ON, seed.owner);
  assert.deepEqual(VIEWER, seed.viewer);
  assert.deepEqual(REPLIES, seed.replies);
  assert.deepEqual(SESSION, seed.session);
  assert.deepEqual(WAR, seed.war);
  assert.deepEqual(H1, seed.h1);
  assert.deepEqual(VERDICTS, seed.verdicts);
  const row = (d) => d.switches.find((r) => r.key === "OWNER_CORRECTIONS");
  assert.deepEqual([OFF.viewer.can_control, row(OFF).value, row(OFF).source], [true, "off", "default"]);
  assert.deepEqual([ON.viewer.can_control, row(ON).value, row(ON).source, row(ON).set_by], [true, "on", "override", "owner"]);
  assert.deepEqual([VIEWER.viewer.can_control, row(VIEWER).value], [false, "on"]);
  // A 200, a deduplicated 200 (the same id), and the redactions [price], [secret], [secret, price].
  const ok = (k) => REPLIES[k].body;
  assert.deepEqual([REPLIES.rated.status, ok("rated").deduplicated, ok("rated").redactions], [200, false, []]);
  assert.deepEqual([ok("deduplicated").deduplicated, ok("deduplicated").correction_id], [true, ok("rated").correction_id]);
  assert.deepEqual([ok("price").redactions, ok("secret").redactions, ok("secret_price").redactions], [["price"], ["secret"], ["secret", "price"]]);
  for (const k of ["rated", "corrected", "price", "secret", "secret_price"]) assert.match(ok(k).correction_id, /^cor_[0-9a-f]{16}$/, k);
  assert.doesNotMatch(JSON.stringify(REPLIES), /4095|abcdefghijklmnopqrstuvwxyz0123|noise|sweep/, "a reply never echoes the text");
  // Each 4xx and 5xx code, with its status.
  const codes = Object.fromEntries(Object.entries(REPLIES).filter(([, r]) => r.status !== 200).map(([k, r]) => [k, `${r.status} ${r.body.error}`]));
  assert.deepEqual(codes, {
    disabled: "409 disabled", unknown_field: "400 unknown_field", invalid_source: "400 invalid_source", invalid_label: "400 invalid_label",
    rating_required: "400 rating_required", invalid_rating: "400 invalid_rating", invalid_category: "400 invalid_category", invalid_target: "400 invalid_target",
    invalid_subject: "400 invalid_subject", invalid_as_of: "400 invalid_as_of", invalid_text: "400 invalid_text", text_too_long: "400 text_too_long",
    invalid_evidence_refs: "400 invalid_evidence_refs", too_many_refs: "400 too_many_refs", category_or_text_required: "400 category_or_text_required",
    empty: "400 empty", invalid_json: "400 invalid_json", not_an_object: "400 body must be a JSON object", owner_only: "403 owner_only", forbidden: "403 forbidden",
    cross_origin_refused: "403 cross_origin_refused", same_origin_only: "403 same_origin_only", body_too_large: "413 body_too_large",
    content_type_must_be_json: "415 content_type_must_be_json", rate_limited: "429 rate_limited", correction_failed: "502 correction_failed", correction_unavailable: "503 correction_unavailable"
  });
  // A 403 answers { error } without ok: false (the orchestrator's ruling): the parser reads the status, not ok.
  assert.equal(REPLIES.owner_only.body.ok, undefined);
  // Every refusal code of the route's correctionRequest is among the fixtures.
  const omega = read("workers/xauusd-omega/src/omega.mjs");
  const fn = omega.slice(omega.indexOf("export function correctionRequest"), omega.indexOf("const CORRECTION_STATUS"));
  const route = [...new Set([...fn.matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]))].filter((c) => c !== "invalid_request");
  for (const c of route) assert.ok(Object.values(REPLIES).some((r) => r.body.error === c), `${c} has a fixture`);
});

test("HC2 the gate: the owner (viewer.can_control) and OWNER_CORRECTIONS on; hidden otherwise, and before any read", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(u.gateOf(ON), { canControl: true, on: true, show: true });
  assert.deepEqual(u.gateOf(OFF), { canControl: true, on: false, show: false });
  assert.deepEqual(u.gateOf(VIEWER), { canControl: false, on: true, show: false });
  assert.deepEqual(u.HIDDEN, { canControl: false, on: false, show: false });
  for (const bad of [null, {}, { viewer: { can_control: "true" }, switches: ON.switches }, { viewer: { can_control: true } }, { error: "feature_switches_failed" }]) assert.equal(u.gateOf(bad).show, false, JSON.stringify(bad).slice(0, 60));
  // One shared read for every control: GET /omega/api/feature-switches (FS_PATH), every FS_POLL_MS, through one store.
  const c = src("components/Correction.tsx");
  assert.equal(count(c, /get\(FS_PATH\)/g), 1, "one read");
  assert.match(c, /timer = window\.setInterval\(read, FS_POLL_MS\);/);
  assert.match(c, /useSyncExternalStore\(subscribe, \(\) => gate, \(\) => HIDDEN\)/, "hidden on the server and before the first answer");
  assert.match(src("lib/featureSwitches.ts"), /export const FS_PATH = "\/omega\/api\/feature-switches";/, "the Omega route, where viewer.can_control is the owner check");
});

test("HC3 the refs: REF_RE and the contract's form copied from their sources; no price after #; subject agent: or seat:; as_of in Z", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(u.REF_RE.source, PACK_REF_RE.source, "REF_RE is src/cfc-pack.mjs's");
  const lib = src("lib/corrections.ts");
  const contract = read("src/owner-corrections.mjs").split("\n")[73];
  assert.match(contract, /^const REF = /, "src/owner-corrections.mjs:74 is the contract's REF (the line the lib cites)");
  assert.ok(lib.includes(contract.replace(/^const REF = /, "const CONTRACT_REF = ")), "CONTRACT_REF is the contract's REF, verbatim");
  assert.match(read("src/cfc-pack.mjs").split("\n")[200], /^export const REF_RE = /, "src/cfc-pack.mjs:201 is REF_RE (the line the lib cites)");
  // isRef: REF_RE, the contract's parse and no price field, exactly.
  const refs = [...SESSION.messages.flatMap((m) => m.refs), ENGINE_TARGET.ref, `${ENGINE_TARGET.ref}#stance`, `${ENGINE_TARGET.ref}#entry`, `${ENGINE_TARGET.ref}#tp1`,
    "ev:xauusd/engine_decisions/a b", "ev:xauusd/Engine/x", "ev:aether/x/y", "ev:xauusd/plan_setups/k#agent:technical", "ev:xauusd/plan_setups/" + "k".repeat(300)];
  for (const r of refs) {
    const p = parseRef(r);
    assert.equal(u.isRef(r), PACK_REF_RE.test(r) && p != null && !refCarriesPrice(p) && r.length <= 300, r.slice(0, 80));
  }
  assert.equal(u.isRef(`${ENGINE_TARGET.ref}#entry`), false, "never a price after #");
  // The engine decision: ev:xauusd/engine_decisions/<decision_key>, the council, its 15m close (toISOString).
  assert.equal(ENGINE.decision_key, "OANDA:XAUUSD:15:1795096800000");
  assert.deepEqual(u.engineTarget(ENGINE), { source: "nexus_engine", ...ENGINE_TARGET, evidence_refs: [] });
  assert.deepEqual(u.engineTarget({ ...ENGINE, bar_close: "2026-11-19T14:00:00Z" }).as_of, "2026-11-19T14:00:00.000Z");
  assert.equal(u.engineTarget({ ...ENGINE, bar_close: "yesterday" }).as_of, null);
  for (const key of [undefined, null, "", "a b", "k#x", "k@x y", 42]) assert.equal(u.engineTarget({ ...ENGINE, decision_key: key }), null, `decision_key ${key}`);
  assert.equal(u.engineTarget(null), null);
  // A council seat (#588): its message's own ev_ref, the refs it cites as evidence (only those the contract parses).
  const [risk, technical, projection, owner] = SESSION.messages;
  assert.deepEqual(u.councilOpinionTarget(risk), { source: "nexus_council", ref: "ev:xauusd/council_messages/1", subject: "agent:risk", as_of: "2026-11-25T08:46:00.000Z", evidence_refs: risk.refs });
  assert.ok(PACK_REF_RE.test(technical.refs[0]) && parseRef(technical.refs[0]) == null, "REF_RE passes, the contract does not");
  assert.deepEqual(u.councilOpinionTarget(technical), { source: "nexus_council", ref: "ev:xauusd/council_messages/2", subject: "agent:technical", as_of: "2026-11-25T08:47:00.000Z", evidence_refs: [] });
  assert.deepEqual(u.councilOpinionTarget(projection).evidence_refs, []);
  assert.equal(u.councilOpinionTarget(owner), null, "never the owner's own message");
  for (const bad of [undefined, null, "", "council_messages/1", "ev:xauusd/council_messages/1 x", "ev:xauusd/council_messages/1#stop"]) assert.equal(u.councilOpinionTarget({ ...risk, ev_ref: bad }), null, `ev_ref ${bad}`);
  assert.equal(u.councilOpinionTarget({ ...risk, seat: "bad seat" }), null, "a subject outside ^(agent|seat):…$");
  // The moderator's options: the session, seat:cfc:moderator, each option's ref as evidence (null ones dropped).
  assert.deepEqual(u.councilOptionsTarget(SESSION), { source: "nexus_council", ref: "ev:xauusd/council_sessions/cfc_h3f_fixture", subject: "seat:cfc:moderator", as_of: null,
    evidence_refs: ["ev:xauusd/council_sessions/cfc_h3f_fixture#options.widen_to_sweep", "ev:xauusd/council_sessions/cfc_h3f_fixture#options.no_change"] });
  assert.equal(SESSION.options.options[1].ev_ref, null, "tighten_stop ends in a price word: the backend gives no ref");
  assert.equal(u.councilOptionsTarget({ ...SESSION, options: null }), null, "no options, no control");
  // The rooms (#588): the conclusion card is the moderator's seat (nexus_card), an opening or a rebuttal its agent (nexus_room).
  const room = WAR.room;
  assert.deepEqual(u.roomConclusionTarget(room, "M15"), { source: "nexus_card", ref: room.conclusion.ev_ref, subject: "seat:M15:moderator", as_of: "2026-11-25T08:45:00.000Z", evidence_refs: [] });
  assert.deepEqual(u.roomConclusionTarget(H1.thread, "H1"), { source: "nexus_card", ref: H1.thread.conclusion.ev_ref, subject: "seat:H1:moderator", as_of: H1.thread.bar_close, evidence_refs: [] });
  assert.deepEqual([...room.openings, ...room.debate].map((m) => u.roomMessageTarget(m, room)).map((t) => [t.source, t.ref, t.subject]),
    [["nexus_room", "ev:xauusd/agent_thread_messages/2", "agent:technical"], ["nexus_room", "ev:xauusd/agent_thread_messages/3", "agent:risk"], ["nexus_room", "ev:xauusd/agent_thread_messages/4", "agent:risk"]]);
  assert.equal(u.roomConclusionTarget({ ...room, conclusion: { ...room.conclusion, ev_ref: null } }, "M15"), null, "a step without a row id has no ref, so no control");
  assert.equal(u.roomConclusionTarget({ ...room, conclusion: { ...room.conclusion, status: "failed" } }, "M15"), null);
  assert.equal(u.roomMessageTarget({ ...room.openings[0], ev_ref: "ev:xauusd/agent_thread_messages/2 3" }, room), null, "REF_RE fails: hidden");
  assert.equal(u.roomMessageTarget({ ...room.openings[0], status: "error" }, room), null, "no response, no control");
  // The strategy council's verdict (#588).
  assert.deepEqual(u.strategyVerdictTarget(VERDICTS.verdicts.zone_pullback, "zone_pullback"), { source: "nexus_council", ref: "ev:xauusd/strategy_council_runs/2026-11-25/zone_pullback#proposal", subject: "agent:zone_pullback", as_of: null, evidence_refs: [] });
  assert.equal(u.strategyVerdictTarget({ ...VERDICTS.verdicts.zone_pullback, ev_ref: null }, "zone_pullback"), null);
  // No model: subject (the ruling), and the route's own subject rule otherwise.
  assert.equal(u.targetOf({ source: "nexus_engine", ref: ENGINE_TARGET.ref, subject: "model:gbm" }), null);
  assert.ok(u.targetOf({ source: "nexus_room", ref: ENGINE_TARGET.ref, subject: "seat:M15:moderator" }));
  assert.equal(u.targetOf({ source: "chat_rating", ref: ENGINE_TARGET.ref, subject: "agent:council" }), null);
  assert.deepEqual([...u.SOURCES], [...CORRECTION_ROUTE_SOURCES]);
  assert.deepEqual(u.CATEGORIES.map(([k]) => k), [...CORRECTION_ROUTE_CATEGORIES]);
});

test("HC4 the body: only the route's keys, accepted by the real correctionRequest; the text only on Correct; Send's rules", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const t = u.engineTarget(ENGINE);
  const rate = { ...u.emptyDraft("rate"), rating: "up", category: "good_call", text: "kept from the other tab" };
  assert.deepEqual(u.bodyOf(t, rate), { source: "nexus_engine", label: "owner_rating", rating: "up", category: "good_call", text: null, target: ENGINE_TARGET });
  assert.deepEqual(correctionRequest(u.bodyOf(t, rate)).input, { ...u.bodyOf(t, rate), evidence_refs: [] });
  const correct = { tab: "correct", rating: null, category: "", text: "The stop sat inside the noise." };
  assert.deepEqual(correctionRequest(u.bodyOf(t, correct)).input.text, "The stop sat inside the noise.");
  const c = u.councilOpinionTarget(SESSION.messages[0]);
  const body = u.bodyOf(c, { ...correct, category: "evidence_missing", rating: "down" });
  assert.deepEqual(Object.keys(body), ["source", "label", "rating", "category", "text", "target", "evidence_refs"]);
  assert.ok(correctionRequest(body).input, "the council body passes the route");
  // canSend: Rate needs up or down; Correct a category or text, at most 500 characters (the counter counts characters).
  assert.equal(u.canSend(u.emptyDraft("rate")), false);
  assert.equal(u.canSend({ ...u.emptyDraft("rate"), rating: "down" }), true);
  assert.equal(u.canSend({ ...u.emptyDraft("correct") }), false);
  assert.equal(u.canSend({ ...u.emptyDraft("correct"), text: "   " }), false);
  assert.equal(u.canSend({ ...u.emptyDraft("correct"), category: "other" }), true);
  assert.equal(u.canSend({ ...u.emptyDraft("correct"), text: "x".repeat(500) }), true);
  assert.equal(u.canSend({ ...u.emptyDraft("correct"), text: "x".repeat(501) }), false, "over 500: blocked before sending");
  assert.ok(correctionRequest(u.bodyOf(t, { ...correct, text: "x".repeat(500) })).input, "500 characters pass the route");
  assert.equal(u.TEXT_MAX, 500);
  // postCorrection: same origin, JSON, POST; never throws (a network failure, a body that is not JSON).
  const calls = [];
  const r = await u.postCorrection(u.bodyOf(t, rate), async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify(REPLIES.rated.body), { status: 200 }); });
  assert.deepEqual(r, { kind: "sent", sent: { id: REPLIES.rated.body.correction_id, redactions: [], deduplicated: false } });
  const [[url, init]] = calls;
  assert.deepEqual([url, init.method, init.credentials, init.headers["content-type"], init.body], ["/omega/api/correction", "POST", "same-origin", "application/json", JSON.stringify(u.bodyOf(t, rate))]);
  assert.deepEqual(await u.postCorrection(u.bodyOf(t, rate), async () => { throw new Error("offline"); }), { kind: "error", status: null, code: "network" });
  assert.deepEqual(await u.postCorrection(u.bodyOf(t, rate), async () => new Response("<html>", { status: 502 })), { kind: "error", status: 502, code: "HTTP 502" });
});

test("HC5 every reply: the chips after a 200, Already recorded, the 409 off state, and each code's words, field and tone", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const reply = (k) => u.replyOf(REPLIES[k].status, REPLIES[k].body);
  assert.deepEqual(u.sentChips(reply("rated").sent), [{ text: "Sent to the platform's teaching record", tone: "ok" }]);
  assert.deepEqual(u.sentChips(reply("deduplicated").sent), [{ text: "Already recorded", tone: "plain" }], "a duplicate is not an error");
  assert.deepEqual(u.sentChips(reply("price").sent).map((c) => c.text), ["Sent to the platform's teaching record", "prices masked"]);
  assert.deepEqual(u.sentChips(reply("secret").sent).map((c) => c.text), ["Sent to the platform's teaching record", "secret removed"]);
  assert.deepEqual(u.sentChips(reply("secret_price").sent).map((c) => c.text), ["Sent to the platform's teaching record", "prices masked", "secret removed"]);
  assert.deepEqual(u.replyOf(200, { ok: true, correction_id: "cor_x", redactions: ["truncated", "price"], deduplicated: false }).sent, { id: null, redactions: ["price"], deduplicated: false });
  assert.deepEqual(reply("disabled"), { kind: "off" });
  const words = {};
  for (const [k, r] of Object.entries(REPLIES)) {
    if (r.status === 200 || r.status === 409) continue;
    const x = u.replyOf(r.status, r.body);
    assert.deepEqual([x.kind, x.status, x.code], ["error", r.status, r.body.error], k);
    const e = u.errorOf(x.status, x.code);
    assert.equal(e.code, `${r.status} ${r.body.error}`);
    assert.notEqual(e.words, "Not recorded. Try again.", `${k} has its own words`);
    words[r.body.error] = [e.words, e.field, e.tone];
  }
  assert.deepEqual(words.category_or_text_required, ["Pick a category or write what was wrong.", "both", "fault"]);
  assert.deepEqual(words.rating_required, ["Pick up or down.", "rating", "fault"]);
  assert.deepEqual(words.invalid_category, ["Pick a category from the list.", "category", "fault"]);
  assert.deepEqual(words.text_too_long, ["Over 500 characters: shorten to send.", "text", "fault"]);
  assert.deepEqual(words.invalid_subject, ["Not recorded: this output has no valid subject. A Nexus bug, not yours.", "target", "fault"]);
  for (const c of ["invalid_target", "invalid_as_of", "invalid_evidence_refs", "too_many_refs", "invalid_source", "invalid_label", "unknown_field", "invalid_json", "empty", "body must be a JSON object"]) assert.deepEqual(words[c], ["Not recorded: a Nexus bug, not yours.", "target", "fault"], c);
  assert.deepEqual(words.owner_only, ["Owner only", null, "fault"]);
  for (const c of ["forbidden", "cross_origin_refused", "same_origin_only"]) assert.deepEqual(words[c], ["Refused: send it from Nexus, signed in.", null, "fault"], c);
  assert.deepEqual(words.body_too_large, ["Too large to send (4 KB). Shorten the text or the evidence.", "text", "fault"]);
  assert.deepEqual(words.content_type_must_be_json, ["Not recorded: a Nexus bug, not yours.", null, "fault"]);
  assert.deepEqual(words.rate_limited, ["30 an hour reached; try later", null, "late"]);
  assert.deepEqual(words.correction_failed, ["Not recorded: the AI Worker did not answer. Try again.", null, "fault"]);
  assert.deepEqual(words.correction_unavailable, ["Not recorded: corrections are not deployed yet.", null, "fault"]);
  // Codes no route here can answer, from the AI Worker's own refusals (src/owner-corrections.mjs buildCorrection, recordOwnerCorrection).
  assert.equal(u.errorOf(400, "forbidden_key: input.target.price").words, "Not recorded: a Nexus bug, not yours.");
  assert.equal(u.errorOf(400, "invalid_actor").words, "Not recorded: a Nexus bug, not yours.");
  assert.deepEqual([u.errorOf(null, "network").code, u.errorOf(null, "network").words], ["network", "No answer from Nexus. Try again."]);
});

test("HC6 the v1 hosts: the Decision Engine card, the rooms, the councils and the strategy verdicts; the decision audit has no control (no ev: ref)", () => {
  const gd = src("components/GlobalDecision.tsx");
  const footer = gd.slice(gd.lastIndexOf('<div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">'), gd.lastIndexOf("</Panel>"));
  assert.match(footer, /<CorrectionControl target=\{engineTarget\(e\)\} \/>\n {10}<\/div>/, "the end of the last footer row");
  const cfc = src("pages/Councils.tsx");
  const card = cfc.slice(cfc.indexOf("export function OpinionCard"), cfc.indexOf("/** One session:"));
  assert.match(card, /<CorrectionControl target=\{councilOpinionTarget\(m\)\} \/>/, "beside the evidence line");
  assert.ok(card.indexOf('m.round === "owner"') < card.indexOf("CorrectionControl"), "never on the owner's own message or a notice");
  assert.match(cfc, /<CorrectionControl target=\{councilOptionsTarget\(s\)\} className=\{`mt-\[12px\] \$\{ROW\}`\} \/><\/div>/, "under the moderator's options");
  const tp = src("components/ThreadsPanel.tsx");
  assert.equal(count(tp, /correction=\{<CorrectionControl target=\{roomMessageTarget\(m, room\)\} \/>\}/g), 2, "each opening and each rebuttal");
  assert.match(tp, /correction=\{<CorrectionControl target=\{roomConclusionTarget\(room, tab\)\} className=\{`mt-\[12px\] \$\{ROW\}`\} \/>\}/, "the conclusion card's footer row");
  assert.match(tp, /<ConclusionHero c=\{d\.tldr\} title="News"(?![^>]*correction)/, "the News TLDR has no ev_ref: no control");
  assert.match(src("components/Post.tsx"), /<p className="min-w-0 flex-1 text-\[12\.5px\] leading-relaxed text-slate-300">\{text\}<\/p>\n\s*\{correction\}/, "the text and the control in one row");
  assert.match(src("pages/Strategy.tsx"), /<CorrectionControl target=\{strategyVerdictTarget\(v, id\)\} className=\{`mt-\[6px\] \$\{ROW\}`\} \/>/, "the end of the verdict line");
  // Only these two hosts render the control.
  const root = new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
  const hosts = files.filter((f) => /<CorrectionControl\b/.test(readFileSync(new URL(f, root), "utf8"))).sort();
  assert.deepEqual(hosts, ["components/GlobalDecision.tsx", "components/ThreadsPanel.tsx", "pages/Councils.tsx", "pages/Strategy.tsx"]);
  // Hidden in v1, for lack of an ev: ref the output carries: the decision audit's cards and agent rows (#588 leaves them without one).
  assert.doesNotMatch(src("pages/Audit.tsx"), /Correction|corrections/);
  assert.doesNotMatch(read("src/decision-cards.mjs"), /decision_key|ev_ref|ev:xauusd/, "a decision card carries no engine key and no ev: ref");
});

test("HC7 one write: POST /omega/api/correction from the control's Send only; the rest of Nexus stays read-only", () => {
  const lib = src("lib/corrections.ts"), c = src("components/Correction.tsx");
  assert.match(lib, /export const CORRECTION_PATH = "\/omega\/api\/correction";/);
  assert.equal(count(lib, /fetchImpl\(/g), 1, "one request in the model");
  assert.match(lib, /res = await fetchImpl\(CORRECTION_PATH, \{ method: "POST", credentials: "same-origin",/);
  assert.doesNotMatch(c, /\bfetch\(|method:|"POST"/, "the component never fetches by itself");
  assert.equal(count(c, /postCorrection\(/g), 1, "one call site");
  const send = c.slice(c.indexOf("const send = async"), c.indexOf("const panel = ("));
  assert.match(send, /if \(phase === "sending" \|\| !canSend\(draft\)\) return;/, "never while sending, never a draft Send refuses");
  const root = new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
  assert.deepEqual(files.filter((f) => /omega\/api\/correction/.test(readFileSync(new URL(f, root), "utf8"))), ["lib/corrections.ts"]);
  assert.deepEqual(files.filter((f) => /postCorrection/.test(readFileSync(new URL(f, root), "utf8"))).sort(), ["components/Correction.tsx", "lib/corrections.ts"]);
  // A 409 hides the control for every host (the shared gate), and the chips stay until the page reloads (a module map).
  assert.match(c, /function switchedOff\(\) \{ gate = \{ \.\.\.gate, on: false, show: false \}; emit\(\); \}/);
  assert.match(c, /const sentByTarget = new Map<string, Sent>\(\);/);
});

test("HC8 the views: every state renders, no green for up, no inline style, no email, no price, the CSP-safe placement", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const names = u.H3F_VIEWS.map((v) => v.name);
  for (const n of ["H3fFooterOwner", "H3fFooterOff", "H3fFooterViewer", "H3fPanelRate", "H3fPanelCorrect", "H3fPanelSending", "H3fPanelOver500", "H3fPanelSheet", "H3fPanelOff", "H3fCouncilOwnerCited", "H3fCouncilViewer",
    "H3fCouncilOptions", "H3fRoomConclusionOn", "H3fRoomConclusionViewer", "H3fRoomPostsOn", "H3fRoomPostsOff", "H3fVerdictOn", "H3fVerdictViewer", "H3fRoomH1Conclusion"]) assert.ok(names.includes(n), n);
  for (const k of ["rated", "deduplicated", "price", "secret", "secret_price"]) assert.ok(names.includes(`H3fChips_${k}`), k);
  for (const [k, r] of Object.entries(REPLIES)) if (r.status !== 200 && r.status !== 409) assert.ok(names.includes(`H3fError_${k}`), k);
  assert.ok(u.VIEWS.some((v) => v.name === "H3fFooterOwner"), "in the render check's registry");
  for (const v of u.H3F_VIEWS) {
    const html = u.render(v.View, v.fixture);
    clean(html);
    for (const t of v.shows ?? []) assert.ok(html.includes(t), `${v.name} shows ${t}`);
    for (const t of v.hides ?? []) assert.ok(!html.includes(t), `${v.name} hides ${t}`);
    assert.doesNotMatch(html, /style="/, `${v.name}: no inline style attribute`);
    assert.doesNotMatch(html, EMAIL, `${v.name}: no email`);
    assert.doesNotMatch(html, /\b4\d{3}\.\d\b/, `${v.name}: no price`);
    // The control's own views (a host's views carry the host's direction colours, as before).
    if (/^H3f(?:Panel|Footer|Chips|Error|Control)/.test(v.name)) assert.doesNotMatch(html, /\b(?:text|bg|border)-(?:bull|bear|green|emerald|rose|red)\b|-(?:bull|bear)-fill/, `${v.name}: up is ok cyan and down off grey, never a direction colour`);
  }
  // Up is the ok cyan, down the off grey (FS1's rule), in the source too.
  const c = src("components/Correction.tsx");
  assert.match(c, /const TONE_ON: Record<Rating, string> = \{ up: "border-ok-fill\/50 bg-ok-fill\/14 text-ok", down: "border-off-fill\/55 bg-off-fill\/16 text-slate-200" \};/);
  assert.doesNotMatch(c + src("lib/corrections.ts"), /\b(?:bull|bear|green|emerald|rose)\b/);
  assert.doesNotMatch(c, /style=\{/, "no style prop: the desktop popover's place is set on the element (CSSOM)");
  assert.match(c, /panel\.style\.left = `\$\{Math\.round\(left\)\}px`;/);
  for (const f of FIXTURES) assert.doesNotMatch(read(`test/fixtures/nexus-h3f/${f}`), EMAIL, f);
  // The hint in an ⓘ, the text's counter, the tooltip of the icon-only control (owner's taste: minimal cosmetic text).
  assert.match(c, /What was wrong <Hint text=\{HINT\} \/>/);
  assert.equal(u.HINT, "Prices are masked as [level] before anything leaves Nexus. Describe the level ('the stop under the sweep low') rather than typing it.");
  assert.match(c, /aria-label="Rate \/ correct" title="Rate \/ correct" aria-haspopup="dialog" aria-expanded=\{open\}/);
  // Esc and a click outside close it; a phone gets the bottom sheet.
  assert.match(c, /if \(e\.key === "Escape"\) closeRef\.current\(\);/);
  assert.match(c, /const PHONE = "\(max-width: 639px\)";/);
});

test("HC9 the render check registers the H3f views and their fixtures", () => {
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of FIXTURES) assert.match(entry, new RegExp(`test/fixtures/nexus-h3f/${f.replace(".", "\\.")}`), f);
  assert.match(entry, /\.\.\.H3F_VIEWS\n\];/);
});
