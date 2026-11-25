// C5, the Position Manager lines on the Omega page ("feat(nexus): Position Manager lines on the Omega page", as the
// owner-approved mockup "Nexus C5 Position Manager lines mockup", "setuju mockup C5"; B5 #594 live): its fixtures
// (test/fixtures/nexus-pm-lines/*.json, the seeded answers of the real readPositionManager, pmLineBreakerTick, setPmLine and
// the Omega Worker's route: test/support/nexus-pm-lines-seed.mjs), the pure model and view over them, the three ways a line
// is off (its breaker: Turn back on; the switch PM_LINES_OFF only: "off by the switch", no button; both: the button's
// refusal "also off by the switch"), every code the POST answers, R neutral, the block's one place on the page, the GET
// from its allow-list and the POST from the button only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PM_LINES } from "../src/pm-line-breaker.mjs";
import { seedPmLines, TRIP } from "./support/nexus-pm-lines-seed.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-pm-lines/${f}`));
const ON = fixture("lines-on.json"), OFF = fixture("lines-off.json"), HAND = fixture("lines-hand-off.json"), NEW = fixture("lines-new.json");
const AFTER = fixture("lines-after-on.json"), ERROR = fixture("lines-error.json"), REPLIES = fixture("post-replies.json");
const by = (d) => Object.fromEntries(d.lines.map((l) => [l.id, l]));
const count = (s, re) => (s.match(re) ?? []).length;
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
    stdin: { contents: 'export * from "./src/lib/pmLines"; export * from "./src/components/PmLines"; export { render, VIEWS, PM_VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
/** The block's static markup over one GET body (render-entry's render, the bundle's own React). */
async function view(d, props = {}) {
  const u = await ui();
  const html = u.render(({ d: body }) => u.PmLinesView({ d: body, ...props }), d);
  clean(html);
  return html;
}

test("PL1 the fixtures are the seed's answers, byte for byte: 17 lines in registry order, exactly B5's fields", async () => {
  const seed = await seedPmLines();
  const hint = "regenerate with `node test/support/nexus-pm-lines-seed.mjs --write` after a contract change";
  assert.deepEqual(ON, seed.on, `lines-on.json: ${hint}`);
  assert.deepEqual(OFF, seed.off);
  assert.deepEqual(HAND, seed.handOff);
  assert.deepEqual(NEW, seed.fresh);
  assert.deepEqual(AFTER, seed.afterOn);
  assert.deepEqual(ERROR, seed.error);
  assert.deepEqual(REPLIES, seed.replies);
  for (const d of [ON, OFF, HAND, NEW, AFTER]) {
    assert.equal(d.status, "ok");
    assert.deepEqual(d.lines.map((l) => [l.id, l.version]), PM_LINES.map((l) => [l.id, l.version]));
    for (const l of d.lines) assert.deepEqual(Object.keys(l), ["id", "version", "enabled", "off_since", "closes", "mean_r_last15", "r_vs_hold"]);
  }
  assert.deepEqual(Object.keys(ERROR), ["status", "version", "error", "rows"], "a failed read carries no lines");
});

test("PL2 the states the seed made: all on; off by the breaker; off by the switch only and by both; fresh; after the owner's turn-on", () => {
  assert.ok(ON.lines.every((l) => l.enabled && l.off_since === null));
  assert.deepEqual(by(ON).cut_loss, { id: "cut_loss", version: 1, enabled: true, off_since: null, closes: 12, mean_r_last15: -0.38, r_vs_hold: 0.21 }, "under 15 closes: a negative mean stays on");
  assert.deepEqual(by(OFF).pm_fast_cut, { id: "pm_fast_cut", version: 1, enabled: false, off_since: TRIP, closes: 16, mean_r_last15: -0.29, r_vs_hold: -0.11 });
  assert.deepEqual(OFF.lines.filter((l) => !l.enabled).map((l) => l.id), ["pm_fast_cut"]);
  assert.deepEqual(by(HAND).tp2_target, { id: "tp2_target", version: 1, enabled: false, off_since: null, closes: 0, mean_r_last15: null, r_vs_hold: null }, "the switch alone: no off_since");
  assert.equal(by(HAND).pm_fast_cut.off_since, TRIP, "both: the breaker's off_since stays");
  assert.ok(NEW.lines.every((l) => l.enabled && l.closes === 0 && l.mean_r_last15 === null && l.r_vs_hold === null));
  assert.deepEqual(by(AFTER).pm_fast_cut, { id: "pm_fast_cut", version: 1, enabled: true, off_since: null, closes: 0, mean_r_last15: null, r_vs_hold: null }, "the owner's turn-on opens a fresh window");
  assert.deepEqual(REPLIES.ok, { status: 200, body: { ok: true } });
  assert.deepEqual(REPLIES.off_by_PM_LINES_OFF, { status: 400, body: { ok: false, error: "off_by_PM_LINES_OFF" } });
});

test("PL3 the pure model: lines, why a line is off, R neutral and signed, times UTC · GMT+7", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(u.linesOf(ON).length, 17);
  for (const b of [null, {}, { status: "error" }, { error: "Not found" }, ERROR, { lines: "x" }]) assert.equal(u.linesOf(b), null);
  assert.deepEqual(u.linesOf({ lines: [{ id: "Bad id", version: 1, enabled: true }, { id: "x", version: 0, enabled: true }, { id: "y", version: 1 }, null] }), [], "an unknown shape is left out");
  assert.equal(u.readErrorOf(ERROR), "D1_ERROR: the database is unavailable");
  assert.equal(u.readErrorOf(ON), null);
  assert.equal(u.offBy(by(ON).cut_loss), null);
  assert.equal(u.offBy(by(OFF).pm_fast_cut), "breaker");
  assert.equal(u.offBy(by(HAND).tp2_target), "hand");
  assert.equal(u.offBy(by(HAND).pm_fast_cut), "breaker", "both: the button shows and its POST is refused");
  assert.deepEqual([u.canTurnOn(by(OFF).pm_fast_cut), u.canTurnOn(by(HAND).tp2_target), u.canTurnOn(by(ON).cut_loss)], [true, false, false]);
  assert.deepEqual([0.31, -0.38, 0, -0.004, 1.125, null].map(u.rText), ["+0.31R", "−0.38R", "0.00R", "0.00R", "+1.13R", "—"]);
  assert.equal(u.tagOf(by(OFF).pm_fast_cut), "pm_fast_cut@1");
  assert.equal(u.whenText(TRIP), "Mon 23 Nov 16:35 UTC · 23:35 GMT+7");
  assert.equal(u.whenText(Date.parse("2026-11-23T20:35:00Z")), "Mon 23 Nov 20:35 UTC · Tue 03:35 GMT+7", "GMT+7 names its own day");
  assert.equal(u.whenText(null), "—");
});

test("PL4 the POST: { line, enabled: true } to /omega/api/pm-lines, same origin, JSON; every answer of the seed read as its code, with words; never throws", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const sent = [];
  const reply = (status, body) => async (url, init) => { sent.push([url, init]); return new Response(JSON.stringify(body), { status }); };
  assert.deepEqual(await u.postPmLine("pm_fast_cut", reply(REPLIES.ok.status, REPLIES.ok.body)), { ok: true });
  const [url, init] = sent[0];
  assert.equal(url, "/omega/api/pm-lines");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { line: "pm_fast_cut", enabled: true });
  for (const [k, r] of Object.entries(REPLIES)) {
    if (k === "ok") continue;
    const got = await u.postPmLine("pm_fast_cut", reply(r.status, r.body));
    assert.equal(got.ok, false, k);
    assert.equal(got.error, r.body.error.slice(0, 64), k);
    assert.deepEqual(u.replyResult(r.status, r.body), got, `${k}: the render check's parser is the POST's`);
    assert.notEqual(u.errorWords(got.error), "nothing changed.", `${k}: words for ${got.error}`);
    assert.ok(u.POST_ERRORS.includes(got.error), `${k} in POST_ERRORS`);
  }
  assert.deepEqual(await u.postPmLine("x", async () => { throw new TypeError("offline"); }), { ok: false, error: "network" });
  assert.deepEqual(await u.postPmLine("x", async () => new Response("<html>", { status: 503 })), { ok: false, error: "HTTP 503" });
  assert.deepEqual(await u.postPmLine("x", async () => new Response("{}", { status: 200 })), { ok: true });
  assert.equal(u.ALSO_OFF, "off_by_PM_LINES_OFF", "setPmLine's code (src/pm-line-breaker.mjs)");
  assert.match(read("src/pm-line-breaker.mjs"), /return \{ ok: false, error: "off_by_PM_LINES_OFF" \}/);
});

test("PL5 rendered: on cyan, off red, R neutral; Turn back on only for the owner on a breaker-off line; off by the switch links Feature switches; both refuses inline", { skip: NO_UI_DEPS }, async () => {
  const on = await view(ON, { canControl: true });
  assert.equal(count(on, />on</g), 34, "17 lines, each in the desktop row and the phone row");
  assert.equal(count(on, /Turn back on/g), 0);
  assert.doesNotMatch(on, /text-(bull|bear)|emerald|rose-/, "R is neutral, never green or red");
  for (const t of ["+0.31R", "−0.38R", "+0.12R", "Last 15", "vs hold", "Closes"]) assert.ok(on.includes(t), t);
  const off = await view(OFF, { canControl: true });
  assert.equal(count(off, /Turn back on/g), 1);
  assert.ok(off.includes("off since Mon 23 Nov 16:35 UTC · 23:35 GMT+7"));
  assert.match(off, /<span class="mono text-fault">off<\/span>/);
  assert.match(on, /<span class="mono text-ok">on<\/span>/);
  assert.equal(count(await view(OFF, { canControl: false }), /<button/g), 0, "a viewer: no button");
  const hand = await view(HAND, { canControl: true });
  assert.equal(count(hand, /Turn back on/g), 1, "pm_fast_cut (both) keeps its button; tp2_target (the switch only) has none");
  assert.equal(count(hand, /off by the <a href="\/#\/switches"/g), 1);
  const refused = await view(HAND, { canControl: true, open: "pm_fast_cut", error: "off_by_PM_LINES_OFF" });
  assert.match(refused, /Refused: off_by_PM_LINES_OFF/);
  assert.match(refused, /also off by the <a href="\/#\/switches"/);
  const confirm = await view(OFF, { canControl: true, open: "pm_fast_cut" });
  assert.match(confirm, /Turn <span class="mono text-slate-100">pm_fast_cut@1<\/span> back on\?/);
  assert.equal(count(confirm, /Turn back on/g), 0, "the line's button gives way to its box");
  const sending = await view(OFF, { canControl: true, open: "pm_fast_cut", phase: "sending" });
  assert.equal(count(sending, /disabled=""/g), 2, "Sending… and Cancel");
  assert.ok((await view(AFTER, { canControl: true, done: "pm_fast_cut@1" })).includes("pm_fast_cut@1 back on."));
  assert.ok((await view(ERROR)).includes("/api/omega/position-manager read failed: D1_ERROR: the database is unavailable"));
  assert.ok((await view({ status: "ok", lines: [] })).includes("No lines yet"));
  const u = await ui();
  assert.ok(u.PM_VIEWS.length >= 30 && u.PM_VIEWS.every((v) => u.VIEWS.includes(v)), "every state is in the render check");
});

test("PL6 the block's one place: Setup › Engine, the Broker engine panel, right under Reversal probation, above the engine form; OmegaWhy has no entry", () => {
  const omega = src("pages/Omega.tsx");
  assert.equal(count(omega, /<PmLines /g), 1);
  assert.match(omega, /import PmLines from "\.\.\/components\/PmLines";/);
  const engine = omega.slice(omega.indexOf('title="Broker engine"'), omega.indexOf('id="engine-form"'));
  assert.match(engine, />Reversal probation<\/dt>[\s\S]*<\/dl>\n\s*\{\/\* C5: [^\n]*\*\/\}\n\s*<PmLines canControl=\{canControl\} \/>\n\s*<form\s*$/);
  assert.doesNotMatch(src("components/OmegaWhy.tsx"), /pm_line|pm-line|PmLine/, "pm_line_off is an event, not a planner note");
});

test("PL7 GET from its allow-list only, the POST from the button only; no turn-off control", () => {
  const lib = src("lib/pmLines.ts"), comp = src("components/PmLines.tsx");
  assert.match(lib, /lines: \{ path: "\/api\/omega\/position-manager\?limit=1", everyMs: 60_000, chart: false \}/);
  assert.match(lib, /intelGet\(PM_LINES_READS, "lines"\)/);
  assert.equal(count(lib, /fetchImpl\(/g), 1, "one request in the model: the POST");
  assert.equal(count(comp, /fetch\(|intelGet\(|\bget\(/g), 0, "the component reads through the model only");
  assert.equal(count(comp, /postPmLine\(/g), 1);
  assert.match(comp, /const confirm = async \(id: string\) => \{[\s\S]*const r = await postPmLine\(id\);/);
  assert.match(comp, /onClick=\{\(\) => onConfirm\?\.\(l\.id\)\}/, "the confirm box's Confirm");
  assert.match(comp, /usePoll\(readPmLines, PM_LINES_READS\.lines\.everyMs\)/);
  assert.match(lib, /export const postBody = \(line: string\) => \(\{ line, enabled: true as const \}\);/, "turning on is the only action");
  assert.doesNotMatch(comp + lib, /enabled: false|Turn off/);
  // No other UI file reaches the route.
  const root = new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
  const hits = files.filter((f) => /pm-lines|postPmLine|position-manager/.test(readFileSync(new URL(f, root), "utf8")));
  assert.deepEqual(hits.sort(), ["components/PmLines.tsx", "lib/pmLines.ts"]);
  // The block in the token, review and error-line lists; the deploy smoke reads the route's lines.
  assert.match(read("test/nexus-tokens.test.mjs"), /"components\/PmLines\.tsx"/);
  assert.match(read("test/nexus-tokens-review.test.mjs"), /"components\/PmLines\.tsx", "lib\/pmLines\.ts"/);
  assert.match(read("test/nexus-poll-states.test.mjs"), /"components\/PmLines\.tsx"/);
  const wf = read(".github/workflows/deploy-nexus-dashboard.yml");
  assert.match(wf, /- name: Smoke test the Position Manager lines/);
  assert.match(wf, /https:\/\/nexus\.cryptophys\.work\/api\/omega\/position-manager\?limit=1/);
});
