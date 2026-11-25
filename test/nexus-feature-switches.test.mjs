// The Nexus Feature switches page (FS1, "feat(nexus): the Feature switches page (FS1), as the owner-reviewed mockup"):
// its route (Settings › Feature switches, the last NAV group), its fixtures (test/fixtures/nexus-fs1/*.json, the seeded
// answers of the real registry and store: test/support/nexus-fs1-seed.mjs), the pure view over them, the owner's controls
// against the read-only page, each control type, the confirm texts (era, mode evidence, emergency stop), the reset, every
// POST error code, no green for "on", no email, and one write: POST /omega/api/feature-switches from the controls only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FEATURE_SWITCHES, FEATURE_SWITCH_GROUPS, FEATURE_SWITCH_KEYS } from "../src/feature-switches.mjs";
import { seedFs1 } from "./support/nexus-fs1-seed.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-fs1/${f}`));
const RECORD = fixture("feature-switches-record.json"), HOLD = fixture("feature-switches-hold.json");
const OWNER = fixture("feature-switches.json"), VIEWER = fixture("feature-switches-viewer.json"), REVERT = fixture("feature-switches-revert.json"), REPLIES = fixture("post-replies.json");
const EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const row = (key, d = OWNER) => d.switches.find((r) => r.key === key);

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/featureSwitches"; export * from "./src/pages/Switches"; export { render, VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
/** The page's static markup over one GET body (render-entry's render, the bundle's own React). */
async function page(d, props = {}) {
  const u = await ui();
  return u.render(({ d: body }) => u.SwitchesView({ d: body, ...props }), d);
}
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
const count = (s, re) => (s.match(re) ?? []).length;

test("FSU1 NAV: Settings › Feature switches is the last group, at /#/switches, key switches, icon ToggleRight; the route in PAGES", () => {
  const shell = src("components/AppShell.tsx");
  const nav = shell.slice(shell.indexOf("export const NAV_GROUPS"), shell.indexOf("export const NAV ="));
  assert.deepEqual([...nav.matchAll(/\{ title: "([^"]+)"/g)].map((m) => m[1]), ["Live", "Execution", "Councils", "Analytics", "Market", "Intelligence", "Settings"]);
  const settings = nav.slice(nav.indexOf('{ title: "Settings"'));
  assert.deepEqual([...settings.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]), ["Feature switches"], "one item in the group");
  assert.match(settings, /\{ title: "Settings", items: \[\{ label: "Feature switches", href: "\/#\/switches", key: "switches", icon: ToggleRight \}\] \}\n\];/);
  assert.match(shell, /import \{[^}]*\bToggleRight\b[^}]*\} from "lucide-react";/);
  // The Intelligence group still ends with Alerts (ZN1 added Zones after Liquidity).
  const intel = nav.slice(nav.indexOf('{ title: "Intelligence"'), nav.indexOf('{ title: "Settings"'));
  assert.deepEqual([...intel.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]), ["Aether", "Model & Learning", "Strategy agents", "Chart patterns", "Liquidity", "Zones", "Neuron allocation", "Decision audit", "Alerts"]);
  const app = src("App.tsx");
  assert.match(app, /import Switches from "\.\/pages\/Switches";/);
  assert.match(app, /neurons: Neurons, councils: Councils, switches: Switches \};/);
  // The Omega page is not touched by FS1's page: it neither imports it nor posts to the feature-switch route.
  assert.doesNotMatch(src("pages/Omega.tsx"), /feature-switches|featureSwitches|Switches/);
});

test("FSU2 the fixtures are the seed's answers, byte for byte, and carry the real registry: every switch, groups, flags", async () => {
  const seed = await seedFs1();
  assert.deepEqual(OWNER, seed.owner, "feature-switches.json: regenerate with `node test/support/nexus-fs1-seed.mjs --write` after a registry change");
  assert.deepEqual(VIEWER, seed.viewer);
  assert.deepEqual(REVERT, seed.revert);
  assert.deepEqual(REPLIES, seed.replies);
  assert.deepEqual(RECORD, seed.record);
  assert.deepEqual(HOLD, seed.hold);
  assert.equal(OWNER.version, "cryptophys.feature-switches.v1");
  assert.deepEqual(Object.keys(OWNER), ["version", "at", "viewer", "groups", "switches"]);
  assert.deepEqual([OWNER.viewer.can_control, VIEWER.viewer.can_control], [true, false]);
  assert.deepEqual(OWNER.groups, FEATURE_SWITCH_GROUPS.map((g) => ({ id: g.id, label: g.label })));
  assert.equal(OWNER.switches.length, FEATURE_SWITCHES.length);
  assert.deepEqual(OWNER.switches.map((r) => r.key), FEATURE_SWITCH_KEYS);
  for (const e of FEATURE_SWITCHES) {
    const r = row(e.key);
    for (const k of ["label", "description", "group", "worker", "era_switch", "restarts_mode_evidence", "emergency_stop", "read_only", "write"]) assert.deepEqual(r[k], e[k], `${e.key}.${k}`);
  }
  for (const k of ["ZONE_SOURCES_OFF", "LIQUIDITY_WITNESS", "LENS_ROOM_LINE", "CALENDAR_CONTRARIAN"]) assert.ok(row(k), `${k}: one of the four beyond the mockup`);
  assert.deepEqual(OWNER.switches.filter((r) => r.emergency_stop).map((r) => r.key), ["ZONE_PRIORITY", "KEY_LEVEL_ZONE_TYPES", "SHADOW_KNOWLEDGE_ENABLED"]);
  assert.deepEqual(OWNER.switches.filter((r) => r.read_only).map((r) => r.key), ["METRIC_REBUTTAL"]);
  assert.deepEqual(OWNER.switches.filter((r) => r.source === "override").map((r) => r.key), ["ENTRY_ZONE_MODE", "CFC_MODE", "change_thresholds"]);
  assert.deepEqual(OWNER.switches.filter((r) => r.write === "omega-settings").map((r) => r.key), ["profit_lock_gate", "change_thresholds", "pm_fast_1m", "reentry_1m", "limit_supersede"]);
  assert.ok(!row("zone_mgmt"), "the mockup's zone_mgmt row is not in the code");
  assert.deepEqual(row("AGENT_VETO_RULE").auto_revert, null);
  assert.deepEqual(row("AGENT_VETO_RULE", REVERT).auto_revert, { since: "2026-11-24T08:00:00.000Z", until: "2026-12-01T08:00:00.000Z" });
});

test("FSU3 the Omega route: one POST route for every row (an Omega setting is forwarded by the AI Worker), owner only", () => {
  const omega = read("workers/xauusd-omega/src/omega.mjs");
  const post = omega.slice(omega.indexOf('if (route === "POST /api/feature-switches")'), omega.indexOf("// Human-AI interaction on the Trade tab"));
  assert.match(post, /if \(!ownerSub \|\| identity\.sub !== ownerSub\) return json\(\{ error: "owner_only" \}, 403\);/);
  assert.match(post, /env\.OMEGA\.setFeatureSwitch\(\{ key, value, reset,/);
  const store = read("src/feature-switch-store.mjs");
  assert.match(store, /if \(e\.resolve === "omega-settings"\) \{[\s\S]*?const w = await writeSettings\(env,/, "the store forwards an Omega setting to the settings write path itself");
});

test("FSU4 the pure view over the fixture: groups in the payload's order, one control kind per row, two columns and the wide Omega card", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const sw = u.switchesOf(OWNER);
  assert.deepEqual(sw.groups.map((g) => g.id), ["zones", "plans", "agents", "modes", "lens", "knowledge", "omega"]);
  assert.deepEqual([sw.canControl, sw.overrides, sw.at], [true, 3, Date.parse("2026-11-25T03:40:00Z")]);
  const kinds = Object.fromEntries(sw.rows.map((r) => [r.key, u.controlKind(r)]));
  assert.deepEqual(Object.entries(kinds).filter(([, k]) => k === "tokens").map(([k]) => k), ["ZONE_AIM_OFF", "ZONE_SOURCES_OFF", "change_thresholds"]);
  assert.deepEqual(Object.entries(kinds).filter(([, k]) => k === "segmented").map(([k]) => k), ["ZONE_AHEAD_MODE", "ZONE_AIM_TP", "ENTRY_ZONE_MODE", "GRID_ADAPT_MODE", "AGENT_VETO_RULE", "CFC_MODE", "LENS_ROOM_LINE", "profit_lock_gate"]);
  for (const r of sw.rows) if (kinds[r.key] === "toggle") assert.deepEqual([...r.values].sort(), ["off", "on"], r.key);
  assert.deepEqual(sw.rows.filter(u.wideControl).map((r) => r.key), ["ZONE_SOURCES_OFF"], "only the five sources take their own line");
  const cols = u.columnsOf(sw.groups);
  assert.deepEqual([cols.left.map((g) => g.id), cols.right.map((g) => g.id), cols.wide.map((g) => g.id)], [["zones", "plans"], ["agents", "modes", "lens", "knowledge"], ["omega"]]);
  assert.deepEqual(u.halves(cols.wide[0].rows).map((h) => h.map((r) => r.key)), [["profit_lock_gate", "change_thresholds", "pm_fast_1m"], ["reentry_1m", "limit_supersede"]]);
  // The phone keeps the payload's order: the columns are contiguous runs.
  assert.deepEqual([...cols.left, ...cols.right, ...cols.wide].map((g) => g.id), sw.groups.map((g) => g.id));
  // Times in UTC and GMT+7.
  assert.equal(u.clockText(sw.at), "03:40 UTC · 10:40 GMT+7");
  assert.equal(u.whenText("2026-11-24T22:05:00.000Z"), "2026-11-24 22:05 UTC · 05:05 GMT+7");
  // Null-safe: no body, an empty one, broken rows.
  for (const d of [null, {}, { switches: null }, { switches: [null, 3, { key: 5 }], groups: "x" }]) {
    const s = u.switchesOf(d);
    assert.deepEqual([s.rows.length, s.canControl, s.groups.length], [0, false, 0]);
    clean(await page(d));
  }
  const html = await page(OWNER);
  clean(html);
  for (const g of OWNER.groups) assert.ok(html.includes(g.label.replace(/&/g, "&amp;")), g.label);
  for (const t of ["Feature switches", "Settings · owner", "3 overrides", "as of 03:40 UTC · 10:40 GMT+7"]) assert.ok(html.includes(t), t);
  for (const r of OWNER.switches) assert.ok(html.includes(r.key) && html.includes(r.label.replace(/'/g, "&#x27;")), r.key);
  assert.ok(!html.includes("sample") && !html.includes("provisional"), "the mockup's sample chip labelled invented data");
  assert.equal(count(html, /role="tooltip"/g), FEATURE_SWITCHES.length, "every row has its tooltip");
  assert.equal(count(html, /aria-describedby="fs-tip-/g), FEATURE_SWITCHES.length, "each ⓘ button describes the row");
  assert.equal(count(html, /aria-expanded="false"/g), FEATURE_SWITCHES.length, "closed by default");
  assert.equal(count(await page(OWNER, { open: "CFC_MODE" }), /aria-expanded="true"/g), 1, "one open tooltip");
});

test("FSU5 owner against read only: controls only when viewer.can_control, never on a read-only row, values as text otherwise", { skip: NO_UI_DEPS }, async () => {
  const owner = await page(OWNER), viewer = await page(VIEWER);
  const toggles = OWNER.switches.filter((r) => Array.isArray(r.values) && [...r.values].sort().join() === "off,on" && !r.read_only).length;
  assert.equal(count(owner, /role="switch"/g), toggles);
  assert.equal(count(owner, /role="group"/g), 11, "8 segmented and 3 token lists");
  assert.ok(!owner.includes('aria-label="Metric rebuttals (METRIC_REBUTTAL)"'), "a read-only row never shows a control, even for the owner");
  for (const t of ["role=\"switch\"", "aria-pressed", "Reset to", "role=\"group\""]) assert.ok(!viewer.includes(t), `viewer: ${t}`);
  for (const t of ["Settings · viewer", "read only", "none on", "conf,tpw,limit,skip", "two_sided", "suggest"]) assert.ok(viewer.includes(t), `viewer: ${t}`);
  assert.ok(!viewer.includes("overrides"), "the overrides chip is the owner's");
  assert.ok(!owner.includes(">read only<"));
  clean(viewer);
});

test("FSU6 each control type: toggle, segmented, token toggles; the POST body of each", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const r = (k) => u.rowOf(row(k));
  // Toggle: on/off flips.
  assert.equal(u.flipped(r("ZONE_PRIORITY")), "off");
  assert.deepEqual(u.postBody(r("ZONE_PRIORITY"), { value: "off" }), { key: "ZONE_PRIORITY", value: "off" });
  // Segmented: the value pressed.
  assert.deepEqual(u.optionsOf(r("CFC_MODE")), ["off", "suggest", "on"]);
  assert.deepEqual(u.postBody(r("CFC_MODE"), { value: "on" }), { key: "CFC_MODE", value: "on" });
  // Token toggles: the on-list, in the registry's order.
  assert.deepEqual(u.toggledTokens(r("ZONE_AIM_OFF"), "factor"), ["factor"]);
  assert.deepEqual(u.toggledTokens(r("change_thresholds"), "conf"), ["tpw", "limit", "skip"]);
  assert.deepEqual(u.toggledTokens(r("change_thresholds"), "stance"), ["conf", "tpw", "limit", "skip", "stance"]);
  assert.deepEqual(u.postBody(r("ZONE_AIM_OFF"), { value: ["tp"] }), { key: "ZONE_AIM_OFF", value: ["tp"] });
  // The markup: the toggles in the ok cyan, the pressed segment, the lit tokens.
  const html = await page(OWNER);
  assert.match(html, /role="switch" aria-checked="true" aria-label="Zone priority \(ZONE_PRIORITY\)"/);
  assert.match(html, /aria-pressed="true"[^>]*>suggest</);
  assert.equal(count(html, /aria-pressed="true"[^>]*>(conf|tpw|limit|skip)</g), 4);
  assert.match(html, /aria-pressed="false"[^>]*>stance</);
  // The page wires each control to onChange only (the confirm and the POST are the page's).
  const pg = src("pages/Switches.tsx");
  assert.match(pg, /onClick=\{\(\) => onChange\(\{ value: flipped\(r\) \}\)\}/);
  assert.match(pg, /onClick=\{\(\) => \{ if \(!pressed\) onChange\(\{ value: v \}\); \}\}/);
  assert.match(pg, /onClick=\{\(\) => onChange\(\{ value: toggledTokens\(r, t\) \}\)\}/);
});

test("FSU7 the confirms say what changes: ZONE_PRIORITY: off → on, the era line, the mode-evidence line, the emergency stop's typed key", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const r = (k, d = OWNER) => u.rowOf(row(k, d));
  const zp = u.confirmText({ ...r("ZONE_PRIORITY"), value: "off" }, { value: "on" });
  assert.deepEqual([zp.title, zp.change, zp.lines, zp.tone, zp.typed, zp.confirmLabel], ["Turn zone priority on?", "ZONE_PRIORITY: off → on", ["Restarts mode evidence."], "fault", "ZONE_PRIORITY", "Turn on"]);
  assert.equal(zp.caution, row("ZONE_PRIORITY").description, "an emergency stop says what it stops");
  const era = u.confirmText(r("reentry_1m"), { value: "off" });
  assert.deepEqual([era.title, era.change, era.lines, era.tone, era.typed], ["Turn 1m re-entry after a lock stop off?", "reentry_1m: on → off", ["Starts a new parity era."], "late", null]);
  const ev = u.confirmText(r("ZONE_AHEAD_MODE"), { value: "all" });
  assert.deepEqual([ev.title, ev.change, ev.lines, ev.tone, ev.confirmLabel], ["Set zone-ahead check to all?", "ZONE_AHEAD_MODE: trend → all", ["Restarts mode evidence."], "late", "Set"]);
  const estop = u.confirmText(r("KEY_LEVEL_ZONE_TYPES"), { value: "off" });
  assert.deepEqual([estop.tone, estop.typed, estop.title], ["fault", "KEY_LEVEL_ZONE_TYPES", "Turn typed key-level zones off?"]);
  const sk = u.confirmText(r("SHADOW_KNOWLEDGE_ENABLED"), { value: "off" });
  assert.deepEqual([sk.typed, sk.lines], ["SHADOW_KNOWLEDGE_ENABLED", []]);
  const normal = u.confirmText(r("CHART_PATTERNS_MODE"), { value: "off" });
  assert.deepEqual([normal.title, normal.change, normal.lines, normal.tone, normal.caution, normal.typed], ["Turn chart patterns off?", "CHART_PATTERNS_MODE: on → off", [], "ok", null, null]);
  const tok = u.confirmText(r("ZONE_AIM_OFF"), { value: ["tp"] });
  assert.deepEqual([tok.title, tok.change, tok.confirmLabel], ["Change zone aims?", "ZONE_AIM_OFF: none → tp", "Save"]);
  const ct = u.confirmText(r("change_thresholds"), { value: ["conf"] });
  assert.deepEqual([ct.change, ct.lines], ["change_thresholds: conf,tpw,limit,skip → conf", ["Starts a new parity era."]]);
  assert.equal(u.inSentence("TP1 at the nearest key zone"), "TP1 at the nearest key zone", "an acronym keeps its capitals");
  // The typed key: the confirm button stays disabled until the key is typed (ConfirmDialog's typed option).
  const cd = src("components/ConfirmDialog.tsx");
  assert.match(cd, /const ready = options\.typed == null \|\| text === options\.typed;/);
  assert.match(cd, /disabled=\{!ready\} onClick=\{\(\) => \{ if \(ready\) onDone\(true\); \}\}/);
  assert.match(cd, /Type the key to confirm/);
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["FS1ConfirmNormal", "FS1ConfirmEra", "FS1ConfirmEv", "FS1ConfirmEmergency", "FS1ConfirmReset", "FS1ConfirmTokens"]) assert.ok(names.includes(n), n);
  const em = u.VIEWS.find((v) => v.name === "FS1ConfirmEmergency");
  const html = u.render(em.View, em.fixture);
  assert.ok(html.includes("Type the key to confirm") && /disabled=""[^>]*>Turn off</.test(html), "disabled until typed");
  // Every change confirms: the page awaits the confirm before the POST.
  const pg = src("pages/Switches.tsx");
  const change = pg.slice(pg.indexOf("const change = async"), pg.indexOf("return (\n    <>"));
  assert.ok(change.indexOf("await confirm(") > 0 && change.indexOf("await confirm(") < change.indexOf("postSwitch("), "confirm first");
  assert.match(change, /if \(!ok\) return;/);
});

test("FSU8 the reset: on an override the owner may change, \"Reset to config\" (an Omega setting: \"Reset to default\"), posting { key, reset: true }", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const r = (k) => u.rowOf(row(k));
  assert.deepEqual(OWNER.switches.filter((x) => u.canReset(u.rowOf(x), true)).map((x) => x.key), ["ENTRY_ZONE_MODE", "CFC_MODE", "change_thresholds"]);
  assert.deepEqual(OWNER.switches.filter((x) => u.canReset(u.rowOf(x), false)).map((x) => x.key), [], "never for a viewer");
  assert.equal(u.canReset({ ...r("METRIC_REBUTTAL"), source: "override" }, true), false, "never on a read-only row");
  assert.deepEqual([u.resetLabel(r("ENTRY_ZONE_MODE")), u.resetTarget(r("ENTRY_ZONE_MODE"))], ["Reset to config", "edge"]);
  assert.deepEqual([u.resetLabel(r("change_thresholds")), u.resetTarget(r("change_thresholds"))], ["Reset to default", ["conf", "tpw", "limit", "skip", "stance"]]);
  assert.equal(u.resetTarget(r("AGENT_VETO_RULE")), "auto");
  assert.deepEqual(u.postBody(r("ENTRY_ZONE_MODE"), { reset: true }), { key: "ENTRY_ZONE_MODE", reset: true });
  const reset = u.confirmText(r("ENTRY_ZONE_MODE"), { reset: true });
  assert.deepEqual([reset.title, reset.change, reset.confirmLabel], ["Reset entry zone to config?", "ENTRY_ZONE_MODE: on → edge", "Reset"]);
  const veto = u.confirmText({ ...r("AGENT_VETO_RULE"), source: "override", value: "classic" }, { reset: true });
  assert.deepEqual([veto.change, veto.lines], ["AGENT_VETO_RULE: classic → auto", ["The automatic revert and the config decide again."]]);
  const html = await page(OWNER);
  assert.equal(count(html, /aria-label="Reset to (config|default): /g), 3);
  for (const t of ['aria-label="Reset to config: ENTRY_ZONE_MODE"', 'aria-label="Reset to config: CFC_MODE"', 'aria-label="Reset to default: change_thresholds"']) assert.ok(html.includes(t), t);
  // The reply of a reset (the real store): back to the config.
  assert.deepEqual([REPLIES.reset.ok, REPLIES.reset.switch.source, REPLIES.reset.switch.value, REPLIES.reset.changed], [true, "config", "on", true]);
  assert.match(src("pages/Switches.tsx"), /onClick=\{\(\) => onChange\(r, \{ reset: true \}\)\}/);
});

test("FSU9 every POST error code shows, with its words; the reply parser follows the Omega page's omegaJson rule", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The codes the store and the Omega route answer.
  const codes = new Set([REPLIES.unknown_key.error, REPLIES.invalid_value.error, REPLIES.read_only.error, REPLIES.owner_only.error]);
  assert.deepEqual([...codes], ["unknown_key", "invalid_value", "read_only", "owner_only"]);
  const store = read("src/feature-switch-store.mjs"), omega = read("workers/xauusd-omega/src/omega.mjs");
  const fromStore = [...store.matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]);
  const post = omega.slice(omega.indexOf('if (route === "POST /api/feature-switches")'), omega.indexOf("// Human-AI interaction on the Trade tab"));
  const fromRoute = [...post.matchAll(/error: "([a-z_]+)"/g), ...post.matchAll(/, "([a-z_]+)"\);\n/g)].map((m) => m[1]);
  for (const c of new Set([...fromStore, ...fromRoute])) assert.ok(u.POST_ERRORS.includes(c), `${c} has its words`);
  for (const c of u.POST_ERRORS) {
    assert.ok(u.errorWords(c, null).length > 5, c);
    const html = await page(OWNER, { status: { ENTRY_ZONE_MODE: { phase: "failed", error: c } } });
    assert.ok(html.includes(`>${c}</span>`) && html.includes('role="alert"'), `${c} shows`);
    clean(html);
  }
  assert.equal(u.errorWords("invalid_value", u.rowOf(row("ENTRY_ZONE_MODE"))), "allowed: edge, on, off.");
  assert.equal(u.errorWords("invalid_value", u.rowOf(row("ZONE_AIM_OFF"))), "allowed: any of tp, stop, factor.");
  // postSwitch: the same rule as omegaJson (non-2xx or ok:false fails with its error, else HTTP <status>); never throws.
  const calls = [];
  const fake = (status, body, json = true) => async (url, init) => { calls.push([url, init]); return { ok: status >= 200 && status < 300, status, json: async () => { if (!json) throw new Error("not json"); return body; } }; };
  assert.deepEqual(await u.postSwitch({ key: "X", value: "on" }, fake(400, REPLIES.unknown_key)), { ok: false, error: "unknown_key" });
  assert.deepEqual(await u.postSwitch({ key: "X", value: "on" }, fake(403, { error: "owner_only" })), { ok: false, error: "owner_only" });
  assert.deepEqual(await u.postSwitch({ key: "X", value: "on" }, fake(502, { error: "feature_switch_failed" })), { ok: false, error: "feature_switch_failed" });
  assert.deepEqual(await u.postSwitch({ key: "X", value: "on" }, fake(500, null, false)), { ok: false, error: "HTTP 500" });
  assert.deepEqual(await u.postSwitch({ key: "X", value: "on" }, async () => { throw new Error("offline"); }), { ok: false, error: "network" });
  const ok = await u.postSwitch({ key: "ZONE_PRIORITY", value: "off" }, fake(200, REPLIES.saved));
  assert.deepEqual([ok.ok, ok.changed, ok.row.key, ok.row.value, ok.row.source], [true, true, "ZONE_PRIORITY", "off", "override"]);
  assert.equal((await u.postSwitch({ key: "ZONE_PRIORITY", value: "off" }, fake(200, REPLIES.unchanged))).changed, false);
  const [url, init] = calls.at(-1);
  assert.deepEqual([url, init.method, init.credentials, init.headers["content-type"], init.body], ["/omega/api/feature-switches", "POST", "same-origin", "application/json", '{"key":"ZONE_PRIORITY","value":"off"}']);
  // Saved and saving.
  const saved = await page(OWNER, { status: { change_thresholds: { phase: "saved", at: Date.parse("2026-11-25T03:42:00Z"), changed: true, era: true } } });
  assert.ok(saved.includes(">saved</span>") && saved.includes("03:42 UTC · 10:42 GMT+7 · owner · new parity era"));
  assert.ok((await page(OWNER, { status: { ENTRY_ZONE_MODE: { phase: "saving" } } })).includes("saving…"));
});

test("FSU10 no green for on: on is the ok cyan, off the off grey; no bull, green or emerald anywhere in the page", { skip: NO_UI_DEPS }, async () => {
  for (const f of ["pages/Switches.tsx", "lib/featureSwitches.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /\b(bull|bear|green|emerald|rose)\b|-(bull|green|emerald)-?|#22c55e|#4ade80/, `${f}: no direction colour`);
  }
  const pg = src("pages/Switches.tsx");
  assert.match(pg, /on \? "border-ok-fill\/55 bg-ok-fill\/20" : "border-off-fill\/35 bg-off-fill\/12"/, "the toggle's track");
  assert.match(pg, /on \? "left-\[23px\] bg-ok sm:left-\[19px\]" : "left-\[3px\] bg-off"/, "the toggle's knob");
  assert.match(pg, /pressed \? "border-ok-fill\/50 bg-ok-fill\/12 text-ok"/, "a lit token");
  assert.match(pg, /const SOURCE_CHIP: Record<Source, string> = \{ override: CHIP\.late, config: CHIP\.plain, default: CHIP\.off \};/);
  for (const html of [await page(OWNER), await page(VIEWER)]) assert.doesNotMatch(html, /\b(bull|green|emerald)\b|-bull|text-green|bg-green/);
});

test("FSU11 no email anywhere: fixtures, markup and set_by (a role word only)", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  for (const [n, d] of [["owner", OWNER], ["viewer", VIEWER], ["revert", REVERT], ["replies", REPLIES]]) assert.doesNotMatch(JSON.stringify(d), EMAIL, n);
  for (const d of [OWNER, VIEWER, REVERT]) assert.doesNotMatch(await page(d, { open: "CFC_MODE" }), EMAIL);
  assert.equal(u.rowOf({ ...row("CFC_MODE"), set_by: "owner@example.com" }).set_by, null, "an identity is never shown");
  assert.equal(u.rowOf(row("CFC_MODE")).set_by, "owner");
  assert.ok((await page(OWNER, { open: "CFC_MODE" })).includes("<dd class=\"mono break-words text-fg\">owner</dd>"));
  for (const f of ["pages/Switches.tsx", "lib/featureSwitches.ts"]) assert.doesNotMatch(src(f), /\.email\b|\.subject\b|actor_sub|viewer_sub/, f);
});

test("FSU12 one write path: POST /omega/api/feature-switches from the controls only; the GET is polled every 60 s and read again after a POST", () => {
  const pg = src("pages/Switches.tsx"), lib = src("lib/featureSwitches.ts");
  assert.equal(count(pg, /postSwitch\(/g), 1, "one call site in the page");
  assert.doesNotMatch(pg, /\bfetch\(|method:|"POST"|omegaJson|ownerPost/, "the page never fetches by itself");
  assert.equal(count(lib, /fetchImpl\(/g), 1, "one request in the model");
  assert.match(lib, /res = await fetchImpl\(FS_PATH, \{ method: "POST", credentials: "same-origin",/);
  assert.match(lib, /export const FS_PATH = "\/omega\/api\/feature-switches";/);
  assert.match(lib, /export const FS_POLL_MS = 60_000;/);
  assert.match(pg, /const poll = usePoll\(\(\) => get\(FS_PATH\), FS_POLL_MS\);/);
  assert.equal(count(pg, /usePoll\(/g), 1);
  const change = pg.slice(pg.indexOf("const change = async"), pg.indexOf("return (\n    <>"));
  assert.match(change, /if \(!canChange\(r, switchesOf\(d\)\.canControl\)\) return;/, "the owner gate before any confirm");
  assert.match(change, /const res = await postSwitch\(postBody\(r, c\)\);/);
  assert.match(change, /await poll\.refresh\(\);/, "the GET again after a POST");
  // `change` reaches the view as onChange only, and only the controls and the reset call onChange.
  assert.match(pg, /onChange=\{change\}/);
  assert.equal(count(pg, /const change = async/g), 1, "defined once");
  assert.equal(count(pg, /[^.\w]change\(/g), 0, "never called by the page itself: only the view's controls reach it");
  const calls = [...pg.matchAll(/onChange\((?:r, )?\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.deepEqual(calls, ["onChange({ value: flipped(r) })", "onChange({ value: v })", "onChange({ value: toggledTokens(r, t) })", "onChange(r, { reset: true })"]);
  // No other source of the UI writes to this route.
  const root = new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.(tsx?)$/.test(f));
  const hits = files.filter((f) => /feature-switches/.test(readFileSync(new URL(f, root), "utf8")));
  const omegaRoute = hits.filter((f) => /\/omega\/api\/feature-switches/.test(readFileSync(new URL(f, root), "utf8")));
  assert.deepEqual(omegaRoute.sort(), ["lib/featureSwitches.ts", "pages/Switches.tsx"]);
  // ZN1: the Zones page reads the AI Worker's read-only GET /api/feature-switches (lib/intel.ts ZONES_READS), never this route.
  assert.deepEqual(hits.filter((f) => !omegaRoute.includes(f)).sort(), ["lib/intel.ts", "lib/zones.ts", "pages/Zones.tsx"]);
  assert.match(src("lib/intel.ts"), /switches: \{ path: "\/api\/feature-switches", everyMs: 120_000, chart: false \}/);
  assert.ok(pg.split("\n").filter((l) => l.includes("feature-switches")).every((l) => /^\s*\/\//.test(l)), "the page names the route in comments only");
});

test("FSU14 the coordinator's final details: config-only values, resolve, ZONE_AIM_OFF's two notes, the propagation note", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The registry has `resolve` and `config_only`, but the GET payload carries neither (switchRow; FS-6 pins its keys).
  for (const r of OWNER.switches) assert.ok(!("resolve" in r) && !("config_only" in r), r.key);
  const zam = FEATURE_SWITCHES.find((e) => e.key === "ZONE_AHEAD_MODE");
  assert.deepEqual([zam.config_only, zam.values], [["record", "off"], ["trend", "all"]]);
  // A config-only value in force (wrangler "record"): shown as text, the settable values as controls, none pressed; the tooltip says why.
  const rec = u.rowOf(row("ZONE_AHEAD_MODE", RECORD));
  assert.deepEqual([rec.value, u.configOnlyValue(rec), u.configOnlyValue(u.rowOf(row("ZONE_AHEAD_MODE")))], ["record", "record", null]);
  assert.equal(u.configOnlyValue({ ...u.rowOf(row("ZONE_AHEAD_MODE")), value: "off", config_only: ["record", "off"] }), "off", "the list is honoured when a payload carries it");
  const html = await page(RECORD, { open: "ZONE_AHEAD_MODE" });
  assert.ok(html.includes("record is set in the config (wrangler.jsonc) and cannot be set here; the panel sets trend or all."));
  assert.doesNotMatch(html, /aria-pressed="true"[^>]*>(trend|all)</);
  assert.equal(u.confirmText(rec, { value: "trend" }).change, "ZONE_AHEAD_MODE: record → trend");
  // ZONE_AIM_OFF: value [] (all off), config [], default every rule; both notes of its description in the tooltip.
  const aim = row("ZONE_AIM_OFF");
  assert.deepEqual([aim.value, aim.config_value, aim.default_value, aim.values], [[], [], ["tp", "stop", "factor"], { type: "tokens", tokens: ["tp", "stop", "factor"], on: [] }]);
  const tip = (await page(OWNER, { open: "ZONE_AIM_OFF" })).replace(/&#x27;/g, "'");
  assert.ok(tip.includes("stop on with tp off, the reward gate holds stop_skip back more often") && tip.includes("ZONE_AIM_TP only matters while tp is on"));
  // After a saved change of a feature-switch row: the note in its tooltip (and the saved word's title); none before.
  const saved = await page(OWNER, { status: { ENTRY_ZONE_MODE: { phase: "saved", at: Date.parse("2026-11-25T03:41:00Z"), changed: true, era: false } } });
  assert.equal(count(saved, /Takes effect within ~30 s\./g), 2, "the tooltip note and the saved word's title");
  assert.equal(count(await page(OWNER), /Takes effect within ~30 s/g), 0);
});

test("FSU15 Z5: the zone breaker's hold, a held mark on the row and one tooltip line per hold; the owner's value unchanged", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The fixture is the breaker's real tick (runZoneBreaker) read back by the real GET: zone_ahead by block, tp and stop by their rules.
  const zam = row("ZONE_AHEAD_MODE", HOLD), aim = row("ZONE_AIM_OFF", HOLD);
  assert.deepEqual(zam.zone_hold, { since: "2026-11-24T07:22:00.000Z", until: "2026-12-01T07:22:00.000Z", by: ["block"] });
  assert.deepEqual(Object.keys(aim.zone_hold), ["tp", "stop"], "only the tokens held");
  assert.deepEqual([aim.zone_hold.tp.by, aim.zone_hold.stop.by], [["rule:tp_typed"], ["rule:stop_skip"]]);
  // The owner's value is the row's value, held or not.
  for (const k of ["ZONE_AHEAD_MODE", "ZONE_AIM_OFF"]) {
    assert.deepEqual([row(k, HOLD).value, row(k, HOLD).source], [row(k).value, row(k).source], k);
    assert.equal(row(k).zone_hold, null, `${k}: nothing held in the main fixture`);
  }
  for (const r of OWNER.switches) if (!["ZONE_AHEAD_MODE", "ZONE_AIM_OFF"].includes(r.key)) assert.ok(!("zone_hold" in r), r.key);
  // Null: no mark, no line.
  const plain = await page(OWNER, { open: "ZONE_AHEAD_MODE" });
  assert.ok(!plain.includes(">held<") && !/[Hh]eld by the zone breaker/.test(plain));
  // A hold: one mark per held row (late amber), the lines in the tooltip only, the control on the owner's value.
  const html = await page(HOLD, { open: "ZONE_AHEAD_MODE" });
  clean(html);
  assert.equal(count(html, />held</g), 2);
  assert.match(html, /<span class="mono rounded-sm border border-late-fill\/40 bg-late-fill\/10 px-1 text-\[10\.5px\] leading-\[14px\] text-late" title="Held by the zone breaker on the decision side; your setting is unchanged\.">held<\/span>/);
  const line = "Held by the zone breaker since 2026-11-24 07:22 UTC · 14:22 GMT+7 until 2026-12-01 07:22 UTC · 14:22 GMT+7 (block): your setting is unchanged.";
  assert.equal(count(html, new RegExp(line.replace(/[()+.]/g, "\\$&"), "g")), 1);
  assert.ok(html.slice(html.indexOf('id="fs-tip-ZONE_AHEAD_MODE"')).includes(line), "inside the tooltip");
  assert.match(html, /aria-pressed="true"[^>]*>trend</, "the control keeps the owner's trend");
  assert.equal(count(html, /aria-pressed="true"[^>]*>(tp|stop|factor)</g), 0, "ZONE_AIM_OFF keeps the owner's none-on");
  // ZONE_AIM_OFF: one line per held token.
  assert.deepEqual(u.holdLines(u.rowOf(aim)), [
    "tp held by the zone breaker since 2026-11-24 07:22 UTC · 14:22 GMT+7 until 2026-12-01 07:22 UTC · 14:22 GMT+7 (rule:tp_typed): your setting is unchanged.",
    "stop held by the zone breaker since 2026-11-24 07:22 UTC · 14:22 GMT+7 until 2026-12-01 07:22 UTC · 14:22 GMT+7 (rule:stop_skip): your setting is unchanged."
  ]);
  // Null-safe: unknown by words kept, a missing since or until left out, junk ignored.
  assert.deepEqual(u.holdLines(u.rowOf({ ...zam, zone_hold: { by: ["typing", "block", "something_new", 5] } })), ["Held by the zone breaker (typing, block, something_new): your setting is unchanged."]);
  assert.deepEqual(u.holdLines(u.rowOf({ ...zam, zone_hold: { since: "nope", until: "2026-12-01T07:22:00.000Z" } })), ["Held by the zone breaker until 2026-12-01 07:22 UTC · 14:22 GMT+7: your setting is unchanged."]);
  assert.deepEqual(u.holdLines(u.rowOf({ ...aim, zone_hold: { factor: { by: ["typing"] }, tp: null, stop: "x" } })), ["factor held by the zone breaker (typing): your setting is unchanged."]);
  for (const z of [null, undefined, "held", [], 3, {}]) assert.deepEqual(u.holdLines(u.rowOf({ ...aim, zone_hold: z })), [], JSON.stringify(z));
  assert.equal(u.rowOf({ ...aim, zone_hold: {} }).zone_hold, null);
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["FS1ZoneHold", "FS1ZoneHoldTokens", "FS1RowZoneHold", "FS1RowZoneHoldSingle"]) assert.ok(names.includes(n), n);
});

test("FSU13 CSP and the owner rule: no inline style strings, no HTML strings, no price; the row is label, key, control, chip and marks", { skip: NO_UI_DEPS }, async () => {
  for (const f of ["pages/Switches.tsx", "lib/featureSwitches.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /style=|dangerouslySetInnerHTML|innerHTML/, `${f}: CSP`);
    assert.doesNotMatch(s, /toFixed|\bprice\b/i, `${f}: no price`);
  }
  const html = await page(OWNER);
  assert.doesNotMatch(html, /style="/, "no style attribute in the markup");
  // The marks: era on the five Omega settings, ev on the mode-evidence switches, the caution on the three emergency stops.
  assert.equal(count(html, />era</g), 5);
  assert.equal(count(html, />ev</g), OWNER.switches.filter((r) => r.restarts_mode_evidence).length);
  assert.equal(count(html, /aria-label="Emergency stop"/g), 3);
  // The description lives in the tooltip only (once per row, inside role="tooltip").
  assert.ok(row("ZONE_PRIORITY").description.includes("zone_ahead check and the zone aims"));
  assert.equal(count(html, /zone_ahead check and the zone aims/g), 1);
  const tip = html.slice(html.indexOf('id="fs-tip-ZONE_PRIORITY"'), html.indexOf("</div>", html.indexOf("fs-tip-ZONE_PRIORITY\" role")) + 2000);
  for (const t of ["config", "default", "set", "by", "deploy (wrangler.jsonc)", "Emergency stop: a change asks for the key to be typed.", "ev: a change restarts the mode evidence"]) assert.ok(tip.includes(t), t);
  // The registry views for the render check.
  const u = await ui();
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["FS1Owner", "FS1Viewer", "FS1Revert", "FS1TipOpen", "FS1Saving", "FS1Saved", "FS1SavedOmega", "FS1Loading", "FS1GetError", "FS1RowReadOnly", "FS1RowVeto", ...u.POST_ERRORS.map((c) => `FS1Failed_${c}`)]) assert.ok(names.includes(n), n);
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of ["feature-switches.json", "feature-switches-viewer.json", "feature-switches-revert.json", "feature-switches-record.json", "feature-switches-hold.json", "post-replies.json"]) assert.ok(entry.includes(`test/fixtures/nexus-fs1/${f}`), f);
});
