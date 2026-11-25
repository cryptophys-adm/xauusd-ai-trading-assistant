// The Nexus Zones page (ZN1, "feat(nexus): the Zones page (ZN1), as the owner-approved mockup"): its route (Intelligence ›
// Zones, after Liquidity), its reads (GET /api/zones and the read-only /api/feature-switches, from one allow-list), its
// fixtures (test/fixtures/nexus-zones/*.json, the seed's real zonesView answers: test/support/nexus-zones-seed.mjs), the
// null-safe model (lib/zones.ts: the breaker's cells and checks, a hold's since and until never invented, the readings'
// order and totals), the pure view over each state (held, clear, empty, 404 off, 500, stale, loading), no price, and
// neutral rates and R (a side's word alone carries a direction colour).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ZONE_BREAKER, ZONE_HOLDABLE, ZONE_VIEW_PRIOR } from "../src/zone-readings.mjs";
import { ERROR_BODY, FILES, OFF_BODY, seedZones } from "./support/nexus-zones-seed.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-zones/${f}`));
const HELD = fixture("zones.json"), LEGACY = fixture("zones-legacy.json"), CLEAR = fixture("zones-clear.json"), EMPTY = fixture("zones-empty.json"), SW = fixture("feature-switches-held.json");

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/zones"; export { ZONES_READS, allowedPaths } from "./src/lib/intel"; export * from "./src/pages/Zones"; export { render, VIEWS, ZONES_OWN_TIMES, ZONES_EFFECTIVE } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
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
  return u.render(({ d: body }) => u.ZonesView({ d: body, switches: SW, ...props }), d);
}
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
const poll = (over) => ({ data: null, error: null, loading: false, refresh: () => {}, lastOk: 1, lastFail: 2, failures: 1, stale: false, intervalMs: 120_000, ...over });

test("ZN1 NAV and PAGES: Zones at /#/zones, key zones, icon Layers, directly after Liquidity in Intelligence", () => {
  const shell = src("components/AppShell.tsx");
  const intel = shell.slice(shell.indexOf('{ title: "Intelligence"'), shell.indexOf('{ title: "Settings"'));
  assert.deepEqual([...intel.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]), ["Aether", "Model & Learning", "Strategy agents", "Chart patterns", "Liquidity", "Zones", "Neuron allocation", "Decision audit", "Alerts"]);
  assert.match(intel, /\{ label: "Zones", href: "\/#\/zones", key: "zones", icon: Layers \}/);
  assert.match(shell, /import \{[^}]*\bLayers\b[^}]*\} from "lucide-react";/);
  const app = src("App.tsx");
  assert.match(app, /import Zones from "\.\/pages\/Zones";/);
  assert.match(app, /liquidity: Liquidity, zones: Zones, neurons: Neurons,/);
});

test("ZN2 the fixtures are the seed's answers, byte for byte: the real zonesView, the real tick, the real feature-switch GET", async () => {
  const seed = await seedZones();
  for (const [name, key] of Object.entries(FILES)) assert.deepEqual(fixture(name), seed[key], `${name}: regenerate with \`node test/support/nexus-zones-seed.mjs --write\``);
  assert.equal(HELD.schema, "cryptophys.zones-view.v1");
  assert.deepEqual(Object.keys(HELD), ["status", "schema", "generated_at", "window_days", "prior", "readings", "zone_blocked", "rule_arms", "breaker", "stances", "omega_attribution", "omega_advisory"]);
  // ZN1 backend: each held entry carries since/until (FS1's values) and effective (does it change a decision now: the
  // seed runs on wrangler.jsonc's vars, whose ZONE_AIM_OFF already has tp and stop off, so only zone_ahead acts).
  const T = { since: "2026-11-24T07:22:00.000Z", until: "2026-12-01T07:22:00.000Z" };
  assert.deepEqual(HELD.breaker.held, [{ rule: "zone_ahead", by: ["block"], ...T, effective: true }, { rule: "tp", by: ["rule:tp_typed"], ...T, effective: false }, { rule: "stop", by: ["rule:stop_skip"], ...T, effective: false }], "the view's held: rule, by, since, until, effective");
  assert.deepEqual(CLEAR.breaker.held, []);
  assert.equal(EMPTY.breaker, null);
  assert.equal(SW.viewer.can_control, false, "the read-only GET /api/feature-switches");
  const hold = SW.switches.find((r) => r.key === "ZONE_AHEAD_MODE").zone_hold;
  assert.deepEqual(hold, { since: "2026-11-24T07:22:00.000Z", until: "2026-12-01T07:22:00.000Z", by: ["block"] });
  // The off and error bodies are src/index.ts' own.
  const idx = read("src/index.ts");
  assert.match(idx, /dashboardJson\(\{ status: "not_found", reason: "zone_readings_off" \}, 404\)/);
  assert.match(idx, /dashboardJson\(\{ status: "error", error: "zones_unavailable" \}, 500\)/);
  assert.deepEqual([fixture("zones-off.json"), fixture("zones-error.json")], [OFF_BODY, ERROR_BODY]);
  // No price anywhere: words, ATR and R only.
  assert.doesNotMatch(JSON.stringify([HELD, CLEAR, EMPTY]), /"(price|entry|stop_loss|tp1|low|high)"/);
});

test("ZN3 reads: GET only, from ZONES_READS (/api/zones, /api/feature-switches), both proxied by Nexus to the AI Worker", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(u.allowedPaths(u.ZONES_READS), ["/api/zones", "/api/feature-switches"]);
  assert.deepEqual([u.ZONES_READS.zones.everyMs, u.ZONES_READS.switches.everyMs], [120_000, 120_000]);
  const p = src("pages/Zones.tsx");
  assert.deepEqual([...p.matchAll(/usePoll\(\(\) => intelGet\(R, "(\w+)"\)/g)].map((m) => m[1]), ["zones", "switches"]);
  assert.doesNotMatch(p, /\bfetch\(|\bget\(|method: "POST"|\/omega\/api/, "no other request and no write");
  const nexus = read("workers/xauusd-nexus-dashboard/src/index.ts");
  assert.match(nexus, /if \(url\.pathname\.startsWith\("\/api\/"\)\) \{\n\s+\/\/ Read-only: only GET and HEAD reach the AI Worker from Nexus\./, "every GET /api/* goes to the AI Worker");
  const ai = read("src/index.ts");
  assert.match(ai, /if \(url\.pathname === "\/api\/zones"\) \{/);
  assert.match(ai, /if \(url\.pathname === "\/api\/feature-switches"\) \{[\s\S]{0,300}featureSwitchesPayload\(env, \{ canControl: false \}\)/);
});

test("ZN4 lib/zones.ts: the breaker's rules and order are the backend's; since and until from the view, else the switches, else none", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual([...u.HOLDABLE], [...ZONE_HOLDABLE]);
  assert.deepEqual([u.BREAKER_RULES.window, u.BREAKER_RULES.min_group, u.BREAKER_RULES.min_setups, u.BREAKER_RULES.block_mean_r, u.BREAKER_RULES.hold_days * 86_400_000],
    [ZONE_BREAKER.window, ZONE_BREAKER.min_group, ZONE_BREAKER.min_setups, ZONE_BREAKER.block_mean_r, ZONE_BREAKER.hold_ms]);
  assert.equal(HELD.prior, ZONE_VIEW_PRIOR);
  // ZN1 backend: the view carries since, until and effective itself (zones.json).
  const viewOwn = (sw) => u.breakerOf(HELD, sw).cells.map((c) => [c.rule, c.held, c.by.join(), c.since, c.until, c.effective]);
  const T = ["2026-11-24T07:22:00.000Z", "2026-12-01T07:22:00.000Z"];
  for (const sw of [SW, null]) {
    assert.deepEqual(viewOwn(sw), [["zone_ahead", true, "block", ...T, true], ["tp", true, "rule:tp_typed", ...T, false], ["stop", true, "rule:stop_skip", ...T, false], ["factor", false, "", null, null, null]], "the view's own times and effective, with or without the switches");
  }
  // The fallback (zones-legacy.json: held[] as { rule, by }, a backend before ZN1): times from the switches, effective unknown.
  const b = u.breakerOf(LEGACY, SW);
  assert.deepEqual(b.cells.map((c) => [c.rule, c.held, c.by.join(), c.since, c.until, c.effective]), [
    ["zone_ahead", true, "block", ...T, null],
    ["tp", true, "rule:tp_typed", ...T, null],
    ["stop", true, "rule:stop_skip", ...T, null],
    ["factor", false, "", null, null, null]
  ]);
  assert.equal(b.checkedAt, "2026-11-24T07:22:00.000Z");
  assert.equal(b.ruleVersion, HELD.breaker.rule_version);
  // No switches body (a failed read): held, no times. Never invented.
  for (const sw of [null, undefined, {}, { error: "proxy_failed" }, { switches: "x" }, { switches: [null, 1, { key: "ZONE_AHEAD_MODE", zone_hold: "x" }] }]) {
    assert.deepEqual(u.breakerOf(LEGACY, sw).cells.map((c) => [c.held, c.since, c.until]), [[true, null, null], [true, null, null], [true, null, null], [false, null, null]]);
  }
  // The view's own since and until win over the switches'.
  const own = u.breakerOf(u.ZONES_OWN_TIMES, SW).cells[0];
  assert.deepEqual([own.since, own.until], ["2026-11-24T08:00:00.000Z", "2026-12-01T08:00:00.000Z"]);
  // effective: read only when present; the note only on a held cell whose effective is false.
  const eff = u.breakerOf(u.ZONES_EFFECTIVE, SW).cells;
  // ZONES_EFFECTIVE (render-entry's heldWith over zones.json) overrides tp and stop; zone_ahead keeps the view's own true.
  assert.deepEqual(eff.map((c) => c.effective), [true, false, true, null]);
  assert.ok(u.cellTip(eff[1]).endsWith(u.NO_EFFECT_NOTE));
  assert.ok(!u.cellTip(eff[2]).includes(u.NO_EFFECT_NOTE) && !u.cellTip(eff[0]).includes(u.NO_EFFECT_NOTE));
  // An unknown held rule is kept, after the four; junk is dropped.
  const odd = u.breakerOf({ breaker: { held: [{ rule: "zone_x", by: ["typing", 3, null] }, { by: ["x"] }, null, "tp"], checks: "x", checked_at: "nope" } }, null);
  assert.deepEqual(odd.cells.map((c) => c.rule), ["zone_ahead", "tp", "stop", "factor", "zone_x"]);
  assert.deepEqual([odd.cells[4].by, odd.checks, odd.checkedAt], [["typing"], [], null]);
  assert.equal(u.breakerOf(EMPTY, SW), null, "no tick yet");
  for (const v of [null, undefined, {}, { breaker: [] }, { breaker: "x" }]) assert.equal(u.breakerOf(v, SW), null);
});

test("ZN5 lib/zones.ts: the checks' states, the readings' order and totals, the formats", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(u.checksOf(HELD.breaker.checks).map((k) => [k.code, k.main, k.sub, k.tone, k.word]), [
    ["typing", "edge +0.059", "own 43% n153 · untyped 37% n86", "ok", "clear"],
    ["block", "+0.15R", "n30", "late", "tripped"],
    ["rule:tp_typed", "+0.10R vs +0.30R", "n30", "late", "tripped"],
    ["rule:stop_skip", "+0.05R vs +0.20R", "n30", "late", "tripped"]
  ]);
  assert.deepEqual(u.checksOf(CLEAR.breaker.checks).map((k) => [k.main, k.tone, k.word]), [["edge +0.059", "ok", "clear"], ["—", "off", "n < 30"], ["— vs —", "off", "n < 30"], ["— vs —", "off", "n < 30"]]);
  assert.deepEqual(u.checkState({ tripped: false }, 60, 59), { tone: "off", word: "n < 60" });
  const rows = u.readingsOf(HELD);
  assert.equal(rows.length, 12);
  const zone = u.sortReadings(rows);
  assert.deepEqual(zone.map((g) => `${g.zone_type}/${g.approach}/${g.zone_strength}`).slice(0, 7), ["demand/from_above/strong", "demand/from_above/medium", "demand/from_above/weak", "demand/inside/medium", "demand/from_below/medium", "supply/inside/medium", "supply/from_below/strong"]);
  assert.deepEqual(zone.slice(-3).map((g) => g.zone_type), ["mixed", "untyped", "untyped"]);
  assert.deepEqual(u.sortReadings(rows, { key: "n", dir: "desc" }).map((g) => g.n).slice(0, 4), [41, 37, 34, 28]);
  assert.deepEqual(u.nextSort(u.DEFAULT_SORT, "n"), { key: "n", dir: "desc" });
  assert.deepEqual(u.nextSort({ key: "n", dir: "desc" }, "n"), { key: "n", dir: "asc" });
  const t = u.totals(rows);
  assert.deepEqual([t.n, t.held, t.broke, t.neither, Math.round(t.held_rate * 100)], [245, 99, 80, 66, 40]);
  assert.deepEqual([u.atr(t.mfe_atr), u.atr(t.mae_atr)], ["0.62", "0.51"]);
  assert.deepEqual(u.readingsOf({ readings: [null, { n: 0 }, { n: "3" }, { n: 2, zone_type: null }] }).map((g) => [g.zone_type, g.approach, g.zone_strength, g.held_rate]), [["untyped", "unknown", "none", null]]);
  assert.deepEqual([u.rText(0.15), u.rText(-0.15), u.rText(0), u.rText(null), u.rText(-0.009, 3)], ["+0.15R", "−0.15R", "0.00R", "—", "−0.009R"]);
  assert.deepEqual([u.shortWhen("2026-11-24T07:22:00.000Z"), u.shortWhen(null), u.clockOf("2026-11-25T03:40:00.000Z")], ["11-24 07:22 UTC · 14:22 GMT+7", "—", "03:40 UTC · 10:40 GMT+7"]);
  const arms = u.armsOf(HELD);
  assert.equal(u.armScaleText(u.armScale(arms)), "−0.1 · 0 · +0.4R");
  assert.equal(u.armScaleText(u.armScale([{ acted: -0.55, base: 0.62 }])), "−0.6 · 0 · +0.7R", "widened past the figures");
  assert.deepEqual(u.stancesOf(HELD).map((s) => [s.stance, s.n, s.zone_blocked]), [["BUY", 75, 0], ["SELL", 55, 0], ["WAIT", 542, 24]]);
  assert.deepEqual(u.omegaOf(HELD), { closes: 16, mean_r: -0.009, advisory: true, by: [{ source: "intent:level_source_zone", n: 8, mean_r: -0.001 }, { source: "pm:zone_trail", n: 8, mean_r: -0.017 }] });
  assert.deepEqual(u.omegaOf(null), { closes: 0, mean_r: null, advisory: false, by: [] });
  assert.equal(u.zonesReady(HELD), true);
  assert.deepEqual([u.zonesOff(OFF_BODY), u.zonesReady(OFF_BODY), u.zonesOff({ status: "not_found" })], [true, false, false]);
  assert.deepEqual([u.readingsOnByError("/api/zones 500 zones_unavailable"), u.readingsOnByError("/api/zones 502 proxy_failed"), u.readingsOnByError(null)], [true, false, false]);
});

test("ZN6 the held page as the mockup: the breaker, the readings, both counterfactual tables, stances and Omega", { skip: NO_UI_DEPS }, async () => {
  const html = await page(HELD);
  clean(html);
  for (const t of ["Zone breaker", "checked 11-24 07:22 UTC · 14:22 GMT+7", "since", "until", "12-01 07:22 UTC · 14:22 GMT+7", "rule:tp_typed", "edge +0.059", "Readings", "All readings", "30 days · prior 20",
    "Held back", "zone_blocked", "Rule arms", "zone_rule_arms", "−0.1 · 0 · +0.4R", "Stances", "7 days · 672 decisions", "Omega attribution", "−0.009R", "03:40 UTC · 10:40 GMT+7", "href=\"/#/switches\""]) {
    assert.ok(html.includes(t), t);
  }
  assert.equal((html.match(/>held</g) ?? []).length >= 3, true);
  // Explanations live in ⓘ tooltips (role note), not as paragraphs.
  assert.equal((html.match(/role="note"/g) ?? []).length, 6, "one ⓘ per panel");
  assert.doesNotMatch(html, /<p[ >]/, "no paragraph of notes");
  // Neutral figures: no direction colour on a cell carrying R or a rate; a side's word carries its own.
  for (const m of html.matchAll(/<td class="([^"]*)">([^<]*)<\/td>/g)) {
    if (/R$|%$/.test(m[2])) assert.doesNotMatch(m[1], /text-(bull|bear|neutral|ok|late|fault)/, `${m[2]} is neutral`);
  }
  assert.match(html, /<span class="text-bull">▲ <!-- -->BUY<\/span>|<span class="text-bull">▲ BUY<\/span>/);
  assert.match(html, /<span class="text-bear">▼ <!-- -->SELL<\/span>|<span class="text-bear">▼ SELL<\/span>/);
  assert.doesNotMatch(html, /\b(emerald|rose)-\d|feed scale|broker scale|\bprice\b/);
  assert.doesNotMatch(html, /\bsample\b/, "the mockup's sample chips are gone");
  // Holds without their own times (zones-legacy.json) and without the switches' times show none.
  const bare = await page(LEGACY, { switches: null });
  assert.doesNotMatch(bare, />since</);
  assert.match(bare, /rule:tp_typed/);
  // The view's own times show without the switches (ZN1 backend).
  assert.match(await page(HELD, { switches: null }), />since</);
});

test("ZN7 the states: clear, empty tables, 404 off, 500 with nothing on screen, stale with data, the first load", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const clear = await page(CLEAR);
  clean(clear);
  assert.doesNotMatch(clear, /bg-late-fill|>tripped</);
  assert.equal((clear.match(/>no hold</g) ?? []).length, 4);
  assert.match(clear, /n &lt; 30/);
  const empty = await page(EMPTY);
  clean(empty);
  for (const t of ["no breaker tick yet", "0 readings · 30 days", "0 resolved · 30 days", "0 decisions · 7 days", "0 zone-attributed closes · 30 days", "no advisory"]) assert.ok(empty.includes(t), t);
  const off = await page(OFF_BODY);
  for (const t of ["zone readings off", "ZONE_READINGS off · nothing recorded, no hold reaches a decision", "/api/zones 404 · zone_readings_off", "Feature switches"]) assert.ok(off.includes(t), t);
  assert.doesNotMatch(off, /zone readings on|Zone breaker/);
  for (const body of [null, {}, { error: "Not found" }, { status: "not_found" }, { status: "error" }]) {
    const h = await page(body);
    clean(h);
    assert.match(h, /No zones view yet/);
  }
  const unread = u.render(() => u.ZonesUnread({ poll: poll({ error: "/api/zones 500 zones_unavailable" }) }), null);
  assert.match(unread, /\/api\/zones 500 zones_unavailable/);
  assert.match(unread, /zone readings on/, "a 500 is past the ZONE_READINGS gate");
  const proxy = u.render(() => u.ZonesUnread({ poll: poll({ error: "/api/zones 502 proxy_failed" }) }), null);
  assert.doesNotMatch(proxy, /zone readings on/);
  const stale = await page(HELD, { poll: poll({ data: HELD, error: "/api/zones 500 zones_unavailable", failures: 4, stale: true }) });
  assert.match(stale, /stale/);
  assert.equal((stale.match(/aria-label="Retry now"/g) ?? []).length, 1, "the read's state shows once, on the breaker panel");
  assert.match(u.render(() => u.ZonesLoading(), null), /animate-pulse/);
  // The page component: an error with nothing on screen is the shared error box, never a raw HTTP text.
  const p = src("pages/Zones.tsx");
  assert.match(p, /if \(phaseOf\(zones\) === "error"\) return <ZonesUnread poll=\{zones\} \/>;/);
  assert.match(p, /<PollError poll=\{poll\} \/>/);
});

test("ZN8 the render check registers a view per state, and the page is in the token, review and poll-state lists", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const names = u.VIEWS.map((v) => v.name).filter((n) => n.startsWith("Zones"));
  assert.deepEqual(names, ["ZonesHeld", "ZonesHeldNoSwitches", "ZonesHeldOwnTimes", "ZonesEffective", "ZonesClear", "ZonesEmpty", "ZonesOff", "ZonesUnread500", "ZonesUnread502", "ZonesStale", "ZonesLoading", "ZonesSortedByN", "ZonesBreaker", "ZonesSwitches"]);
  assert.match(read("test/nexus-tokens.test.mjs"), /"pages\/Zones\.tsx"/);
  assert.match(read("test/nexus-tokens-review.test.mjs"), /"pages\/Zones\.tsx", "lib\/zones\.ts"/);
  assert.match(read("test/nexus-poll-states.test.mjs"), /"pages\/Zones\.tsx"/);
  const wf = read(".github/workflows/deploy-nexus-dashboard.yml");
  assert.match(wf, /- name: Smoke test the Zones view/);
  assert.match(wf, /https:\/\/nexus\.cryptophys\.work\/api\/zones/);
});
