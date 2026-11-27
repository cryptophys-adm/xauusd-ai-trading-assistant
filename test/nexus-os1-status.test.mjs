// OS1, three new backend fields shown in the Nexus UI (orchestrator OK 2026-11-27; UI only): the Omega page's server
// check (#650, broker.server_check) and its Save's near-match warning, the watchdog's recovery hold (#647,
// broker.autonomous_watchdog.last_recovery status "held"), and the Data feeds card's bar age and bars-stopped warning
// (#649, broker.feeds[].last_bar_age_ms and content_stale). Fixtures: test/fixtures/nexus-os1/*.json, the seeded answers
// of the real Omega routes and a bundled AI Worker (test/support/nexus-os1-seed.mjs). The null-safe reads are
// ui/src/lib/omegaStatus.ts and ui/src/lib/feeds.ts; the lines are ui/src/components/OmegaStatus.tsx and pages/Feeds.tsx.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { seedOs1, FILES, KNOWN_SERVER, TYPED } from "./support/nexus-os1-seed.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-os1/${f}`));
const FX = Object.fromEntries(Object.entries(FILES).map(([name, key]) => [key, fixture(name)]));
const F4_FRESH = JSON.parse(read("test/fixtures/nexus-f4/overview-fresh.json"));
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/omegaStatus"; export { feedOf, feedsOf, lastBarOf, barsStoppedOf } from "./src/lib/feeds"; export * from "./src/components/OmegaStatus"; export { FeedsView } from "./src/pages/Feeds"; export { render, VIEWS, OS1_VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
const html = async (View, d) => { const u = await ui(); const h = u.render(View, d); clean(h); return h; };

test("OS1-1 the fixtures are the seed's answers, byte for byte; each state is the one its name says; no secret", async () => {
  const seed = await seedOs1();
  const hint = "regenerate with `node test/support/nexus-os1-seed.mjs --write` after a contract change";
  for (const [name, key] of Object.entries(FILES)) assert.deepEqual(FX[key], seed[key], `${name}: ${hint}`);
  const sc = (k) => FX[k].broker.server_check;
  assert.deepEqual(sc("pending"), { status: "pending" });
  assert.deepEqual(sc("ok"), { status: "ok" });
  assert.deepEqual(sc("disconnected"), { status: "disconnected" });
  assert.equal(F4_FRESH.broker.server_check, null, "no stored connection: null (the F4 fixtures)");
  for (const k of ["notSeen", "notSeenViewer", "notSeenSpace", "notSeenPlain"]) assert.equal(sc(k).status, "not_seen");
  assert.equal(sc("notSeen").did_you_mean, KNOWN_SERVER);
  assert.equal(sc("notSeenSpace").did_you_mean, KNOWN_SERVER);
  assert.equal(TYPED.space.length + 1, KNOWN_SERVER.length, "the second hint differs by one space only");
  assert.equal("did_you_mean" in sc("notSeenPlain"), false);
  const lr = (k) => FX[k].broker.autonomous_watchdog.last_recovery;
  assert.deepEqual([lr("notSeen").status, lr("notSeen").cause, lr("notSeen").dispatches, lr("notSeen").conn_version], ["held", "server_not_seen", 3, 1]);
  assert.deepEqual([lr("disconnected").status, "cause" in lr("disconnected")], ["held", false], "a hold without a cause");
  assert.equal(lr("notSeenSpace").status, "dispatched");
  const feeds = Object.fromEntries(FX.feeds.broker.feeds.map((f) => [f.bridge_id, f]));
  assert.deepEqual([feeds.oanda.content_stale, feeds.oanda.last_bar_age_ms], [true, 21 * 60_000]);
  assert.deepEqual([feeds.backup.content_stale, feeds.backup.last_bar_age_ms], [false, null]);
  assert.deepEqual([feeds.live.content_stale, feeds.live.last_bar_age_ms], [false, 2 * 60_000]);
  assert.deepEqual([FX.feeds.viewer.can_control, FX.feedsViewer.viewer.can_control, FX.notSeenViewer.viewer.can_control], [true, false, false]);
  assert.equal(FX.replies.saved.body.warning, undefined);
  assert.deepEqual(FX.replies.near_match.body.warning.did_you_mean, KNOWN_SERVER);
  assert.equal(FX.replies.near_match.body.ok, true, "saved all the same");
  const all = JSON.stringify(FX);
  for (const s of ["placeholder-pw", "demo-login", "envelope", "ciphertext"]) assert.equal(all.includes(s), false, `no ${s} in any fixture`);
});

test("OS1-2 the server check read is null-safe; did_you_mean exactly as sent, only beside not_seen", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const at = (server_check) => ({ broker: { server_check } });
  for (const b of [null, undefined, {}, { broker: null }, at(null), at("ok"), at({}), at({ status: "later" }), at({ status: 1 })]) assert.equal(u.serverCheckOf(b), null);
  assert.deepEqual(u.serverCheckOf(FX.ok), { status: "ok", message: null, didYouMean: null });
  assert.deepEqual(u.serverCheckOf(FX.pending), { status: "pending", message: null, didYouMean: null });
  assert.deepEqual(u.serverCheckOf(FX.disconnected), { status: "disconnected", message: null, didYouMean: null });
  assert.deepEqual(u.serverCheckOf(FX.notSeen), { status: "not_seen", message: FX.notSeen.broker.server_check.message, didYouMean: "Placeholder-Live 2" });
  assert.equal(u.serverCheckOf(FX.notSeenPlain).didYouMean, null);
  // No trim and no case change; anything that is not a server name is dropped.
  for (const name of [" placeholder_LIVE 2", "Placeholder-Live 2 ", "A  B"]) assert.equal(u.serverCheckOf(at({ status: "not_seen", did_you_mean: name })).didYouMean, name);
  for (const bad of [7, {}, ["x"], "", "   ", "<script>", "x".repeat(65), "a\nb"]) assert.equal(u.serverCheckOf(at({ status: "not_seen", did_you_mean: bad })).didYouMean, null, JSON.stringify(bad));
  assert.equal(u.serverCheckOf(at({ status: "ok", did_you_mean: "X", message: "m" })).didYouMean, null, "a hint only beside not_seen");
  assert.equal(u.serverCheckOf(at({ status: "not_seen", message: 5 })).message, null);
});

test("OS1-3 the server check's tones and words: ok cyan, pending amber, not_seen red, disconnected grey without 'check the name'", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const r = (k) => u.serverCheckReading(u.serverCheckOf(FX[k]));
  assert.deepEqual([r("ok").tone, r("pending").tone, r("notSeen").tone, r("disconnected").tone], ["ok", "late", "fault", "off"]);
  assert.equal(r("notSeen").text, FX.notSeen.broker.server_check.message, "the backend's message");
  assert.doesNotMatch(r("disconnected").text, /check|exact|spaces|hyphen/i);
  assert.equal(await html(({ d }) => u.ServerCheckLine({ sc: u.serverCheckOf(d) }), F4_FRESH), "", "no stored connection: nothing");
  const dis = await html(({ d }) => u.ServerCheckLine({ sc: u.serverCheckOf(d) }), FX.disconnected);
  assert.doesNotMatch(dis.replace(/title="[^"]*"|aria-label="[^"]*"/g, ""), /check the|did you mean|exactly/i, "no name advice for a disconnect (the tooltip aside)");
  const ns = await html(({ d }) => u.ServerCheckLine({ sc: u.serverCheckOf(d) }), FX.notSeen);
  assert.match(ns, /did you mean <code class="mono whitespace-pre[^"]*">Placeholder-Live 2<\/code>\?/);
  // A message is text: markup in it is escaped, never rendered.
  const evil = await html(({ d }) => u.ServerCheckLine({ sc: u.serverCheckOf(d) }), { broker: { server_check: { status: "not_seen", message: "<b>bold</b>" } } });
  assert.ok(evil.includes("&lt;b&gt;bold&lt;/b&gt;") && !evil.includes("<b>"));
});

test("OS1-4 the Save's near-match warning shows inline under the success line; it is saved all the same", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(u.saveWarningOf(FX.replies.near_match.body), { message: FX.replies.near_match.body.warning.message, didYouMean: "Placeholder-Live 2" });
  for (const b of [null, {}, FX.replies.saved.body, { warning: { code: "other", did_you_mean: "X" } }, { warning: "server_name_near_match" }]) assert.equal(u.saveWarningOf(b), null);
  // The success line's words are the page's own, unchanged.
  assert.equal(u.savedText(FX.replies.saved.body), "Saved v1 for Placeholder-Live 2; applied at next bridge sync.");
  assert.equal(u.savedText({ version: 4, server: "S", trade_symbol: "GoldOne" }), "Saved v4 for S (gold symbol GoldOne); applied at next bridge sync.");
  const m = u.savedMsg(FX.replies.near_match_space.body);
  assert.equal(m.tone, "text-ok");
  assert.equal(m.warning.didYouMean, "Placeholder-Live 2");
  const h = await html(({ d }) => u.ConnectionMessage({ msg: u.savedMsg(d) }), FX.replies.near_match.body);
  assert.ok(h.indexOf("Saved v1 for Placeholder-Live-2") < h.indexOf("Saved as entered."), "the success line, then the warning");
  assert.match(h, /text-late/);
  assert.equal(await html(({ d }) => u.ConnectionMessage({ msg: d }), null), "");
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /const out = await omegaJson\("\/omega\/api\/connection", "POST", \{ server, envelope, trade_symbol: tradeSymbol, units_per_usd: units \}\);\n\s*\/\/ OS1:[^\n]*\n\s*setBrokerMsg\(savedMsg\(out\)\);/, "the form's POST answer feeds the message");
  assert.match(omega, /<ConnectionMessage msg=\{brokerMsg\} \/>/);
});

test("OS1-5 the recovery hold: a late chip, the message as text, dispatches, the connection version and the cause; nothing for a dispatch", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const held = u.recoveryHeldOf(FX.notSeen);
  assert.deepEqual(held, { ms: FX.notSeen.broker.autonomous_watchdog.last_recovery.ms, message: FX.notSeen.broker.autonomous_watchdog.last_recovery.message, dispatches: 3, connVersion: 1, serverNotSeen: true });
  assert.deepEqual(u.recoveryHeldFacts(held), ["3 dispatches", "connection v1", "server not seen"]);
  assert.deepEqual(u.recoveryHeldFacts(u.recoveryHeldOf(FX.disconnected)), ["3 dispatches", "connection v1"]);
  for (const k of ["notSeenSpace", "ok", "pending"]) assert.equal(u.recoveryHeldOf(FX[k]), null, k);
  for (const b of [null, {}, { broker: { autonomous_watchdog: null } }, { broker: { autonomous_watchdog: { last_recovery: "held" } } }]) assert.equal(u.recoveryHeldOf(b), null);
  assert.deepEqual(u.recoveryHeldOf({ broker: { autonomous_watchdog: { last_recovery: { status: "held", dispatches: "3", conn_version: -1, ms: "x", message: 4, cause: "other" } } } }),
    { ms: null, message: null, dispatches: null, connVersion: null, serverNotSeen: false });
  assert.match(u.RECOVERY_HELD_HINT, /resumes on a new connection or once the terminal is healthy again/);
  const chip = await html(({ d }) => u.RecoveryHeldChip({ held: u.recoveryHeldOf(d) }), FX.notSeen);
  assert.match(chip, /chip border-late-fill\/30 bg-late-fill\/10 text-late">recovery held</);
  const line = await html(({ d }) => u.RecoveryHeldLine({ held: u.recoveryHeldOf(d) }), { broker: { autonomous_watchdog: { last_recovery: { status: "held", message: "<img src=x>" } } } });
  assert.ok(line.includes("&lt;img src=x&gt;") && !line.includes("<img"), "the message is text");
  const omega = src("pages/Omega.tsx");
  const card = omega.slice(omega.indexOf("Last recovery"), omega.indexOf("Collapsible Raw State JSON Inspector"));
  assert.match(card, /<RecoveryHeldChip held=\{recoveryHeld\} \/>/);
  assert.match(card, /<RecoveryHeldLine held=\{recoveryHeld\} \/>/);
  assert.match(card, /recoveryHeld \? "Held"/, "the card's status says held, not done");
});

test("OS1-6 the Data feeds card: Last bar with its age ('—' when none, never 0 s), bars stopped late with the remedy; a viewer's remedy has no 'below'", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const feeds = Object.fromEntries(u.feedsOf(FX.feeds).map((f) => [f.bridge_id, f]));
  assert.deepEqual(u.lastBarOf(feeds.oanda), { tone: "late", text: "21 min ago" });
  assert.deepEqual(u.lastBarOf(feeds.backup), { tone: null, text: "—" });
  assert.deepEqual(u.lastBarOf(feeds.live), { tone: null, text: "2 min ago" });
  assert.equal(u.lastBarOf({ ...feeds.live, last_bar_age_ms: 0 }).text, "1s ago", "never 0 s");
  for (const bad of [null, -5, "60000", NaN, {}]) assert.equal(u.feedOf({ ...FX.feeds.broker.feeds[0], last_bar_age_ms: bad }).last_bar_age_ms, null, String(bad));
  assert.equal(u.feedOf({ ...FX.feeds.broker.feeds[0], content_stale: "true" }).content_stale, false, "only true is stale");
  assert.deepEqual(u.barsStoppedOf(feeds.oanda, true), { age: "Last bar 21 min ago", remedy: "Re-enter the feed login below." });
  assert.deepEqual(u.barsStoppedOf(feeds.oanda, false), { age: "Last bar 21 min ago", remedy: "Re-enter the feed login." });
  assert.equal(u.barsStoppedOf(feeds.live, true), null);
  const owner = await html(u.FeedsView, FX.feeds), viewer = await html(u.FeedsView, FX.feedsViewer);
  assert.equal((owner.match(/Bars stopped/g) ?? []).length, 1, "only the stale feed");
  assert.ok(owner.includes("Re-enter the feed login below.") && owner.includes("<form"));
  assert.ok(viewer.includes("Bars stopped") && viewer.includes("Re-enter the feed login.") && !viewer.includes("login below"));
  assert.doesNotMatch(viewer, /<form|<button|<input/);
  assert.match(owner, /<dt class="text-slate-500">Last bar<\/dt><dd class="mono min-w-0 wrap-break-word text-late">21 min ago<\/dd>/);
  assert.match(owner, /<dt class="text-slate-500">Last bar<\/dt><dd class="mono min-w-0 wrap-break-word text-slate-200">—<\/dd>/);
  assert.doesNotMatch(src("lib/feeds.ts"), /goldPaused|marketHours|getUTCDay/, "the flag is the server's; no market hours here");
});

test("OS1-7 placement, tones and the Omega-only hint: the lines sit inside the existing cards; no green, no markup injection, no price", () => {
  const omega = src("pages/Omega.tsx");
  const card = omega.slice(omega.indexOf('title="Broker connection"'), omega.indexOf('<form id="broker-form"'));
  assert.match(card, /<\/dl>\n\s*<ServerCheckLine sc=\{serverCheck\} \/>/, "under the Broker connection card's list, above its form");
  assert.match(omega, /const serverCheck = serverCheckOf\(data\);/);
  assert.match(omega, /\["engine", "Engine"\], \["profile", "Risk profile"\], \["connection", "Connection & EA"\]/, "the Setup tabs are as before");
  const added = src("lib/omegaStatus.ts") + src("components/OmegaStatus.tsx");
  assert.doesNotMatch(added, /\b(text|bg|border)-(bull|bear|green|emerald)\b|emerald|rose-|\bstyle=|dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(added, /\bbid\b|\bask\b|price/i, "no price");
  assert.doesNotMatch(src("pages/Feeds.tsx") + src("lib/feeds.ts"), /did_you_mean|didYouMean|DidYouMean/, "the hint is the Omega page's only");
  assert.doesNotMatch(src("pages/Feeds.tsx"), /dangerouslySetInnerHTML/);
});

test("OS1-8 the render check covers every new state", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const names = u.OS1_VIEWS.map((v) => v.name);
  for (const n of ["OS1ServerCheckNone", "OS1ServerCheckPending", "OS1ServerCheckOk", "OS1ServerCheckDisconnected", "OS1ServerCheckNotSeen", "OS1ServerCheckNotSeenSpace", "OS1ServerCheckNotSeenPlain",
    "OS1ServerCheckNotSeenViewer", "OS1SaveNearMatch", "OS1SaveNearMatchSpace", "OS1SaveNoWarning", "OS1RecoveryHeldCause", "OS1RecoveryHeldNoCause", "OS1RecoveryDispatched", "OS1FeedsStale", "OS1FeedsStaleViewer"]) assert.ok(names.includes(n), n);
  for (const v of u.OS1_VIEWS) assert.ok(u.VIEWS.includes(v), `${v.name} is in VIEWS`);
});
