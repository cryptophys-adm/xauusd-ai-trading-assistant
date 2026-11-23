// The Nexus Liquidity page (Track C2, "feat(nexus): Liquidity", as the owner-approved mockup): its route, its reads (GET
// only, one poll each, one /api/lens read in the whole UI), its render over backend B8's contract
// (test/fixtures/nexus-intel/liquidity.json and liquidity-unavailable.json), the not-yet states of the fields backends
// B15-B19 fill, no order text or line, the bands only from *_feed values and none without a known basis, a scale on
// every price, the LIQUIDITY card's weight rule and the states the mockup draws.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "../workers/xauusd-nexus-dashboard/ui/src/lib/api.ts";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-intel/${f}`));
const LIQ = fixture("liquidity.json"), UNAV = fixture("liquidity-unavailable.json");

// The page's views run from an esbuild bundle of the UI (as the render check: CommonJS, lightweight-charts on its stub).
const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/intel"; export * from "./src/pages/Liquidity"; export { render, merged, LATER, LIVE_EFFECTS, LIQUIDITY_NOW, LENS_AETHER, LENS_OFF, VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
const lensBody = () => fixture("lens.json"), decisionBody = () => fixture("engine-decision.json");
/** The page's static markup with the bundle's own React (render-entry's render). */
async function page(d, extra = {}) {
  const u = await ui();
  const props = { lens: lensBody(), decision: decisionBody(), now: u.LIQUIDITY_NOW, ...extra };
  return u.render(({ d: body }) => u.LiquidityView({ d: body, ...props }), d);
}
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
/** The page's text, one text node per line (the tags removed). */
const textOf = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((t) => t.trim()).filter(Boolean);

test("LQ1 NAV and PAGES: Liquidity at /#/liquidity, key liquidity, icon Droplets, directly after Strategy agents", () => {
  const shell = src("components/AppShell.tsx");
  const intel = shell.slice(shell.indexOf('{ title: "Intelligence"'), shell.indexOf("] }\n];"));
  const labels = [...intel.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Aether", "Model & Learning", "Strategy agents", "Liquidity", "Neuron allocation", "Decision audit", "Alerts"]);
  assert.match(intel, /\{ label: "Liquidity", href: "\/#\/liquidity", key: "liquidity", icon: Droplets \}/);
  assert.match(shell, /import \{[^}]*\bDroplets\b[^}]*\} from "lucide-react";/);
  for (const t of ["Opening range", "Chart patterns"]) assert.ok(!shell.includes(t), `${t} comes with its own track`);
  const app = src("App.tsx");
  assert.match(app, /import Liquidity from "\.\/pages\/Liquidity";/);
  assert.match(app, /strategy: Strategy, liquidity: Liquidity,/);
});

/** Every file under ui/src. */
const files = (dir = `${UI}src`) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

test("LQ2 one /api/lens read in the whole UI (the Liquidity page's), and no <LensPanel mount left", () => {
  const all = files().map((f) => [f.slice(UI.length), readFileSync(f, "utf8")]);
  const lensPaths = all.flatMap(([f, s]) => (s.match(/["'`]\/api\/lens["'`?]/g) ?? []).map(() => f));
  assert.deepEqual(lensPaths, ["src/lib/intel.ts"], "the path once, in the allow-list");
  const page = src("pages/Liquidity.tsx");
  assert.equal((page.match(/intelGet\(R, "lens"\)/g) ?? []).length, 1, "polled once");
  assert.equal(all.filter(([, s]) => /<LensPanel\b/.test(s)).length, 0, "no <LensPanel mount");
  assert.doesNotMatch(src("components/LensPanel.tsx"), /export function LensPanel/, "the wrapper is deleted");
  assert.match(page, /<LensView d=\{lens\}/, "LensView on the Liquidity page");
  assert.match(page, /<ScorePanel d=\{d\} lens=\{lens\}/, "the same body feeds the score panel");
});

test("LQ3 GET only, from the page's allow-list: five reads, one poll each, at their cadences", async () => {
  const intel = src("lib/intel.ts");
  assert.match(intel, /liquidity: \{ path: "\/api\/liquidity", everyMs: 120_000, chart: false \}/);
  assert.match(intel, /lens: \{ path: "\/api\/lens", everyMs: 120_000, chart: false \}/);
  assert.match(intel, /candles: \{ path: "\/api\/ohlcv\?timeframe=M15&limit=200", everyMs: 60_000, chart: true \}/);
  assert.match(intel, /plane: \{ path: "\/api\/hud\/levels\?tf=15", everyMs: 300_000, chart: true \}/);
  assert.match(intel, /decision: \{ path: "\/api\/engine\/decision", everyMs: 120_000, chart: false \}/);
  assert.match(intel, /const opts: GetOptions = r\.chart \? CHART_READ : \{\};\n  return get<T>\(r\.path, opts\);/, "chart reads keep the browser cache (CHART_READ)");
  const page = src("pages/Liquidity.tsx");
  const polls = [...page.matchAll(/usePoll\(\(\) => intelGet\(R, "(\w+)"\), R\.(\w+)\.everyMs\)/g)];
  assert.deepEqual(polls.map((m) => m[1]), ["liquidity", "lens", "candles", "plane", "decision"]);
  for (const m of polls) assert.equal(m[1], m[2], "each poll at its own read's cadence");
  assert.equal((page.match(/usePoll\(/g) ?? []).length, 5, "no other poll");
  for (const f of ["pages/Liquidity.tsx", "components/IntelChart.tsx", "lib/intel.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /\bfetch\(|ownerPost|omegaJson|method:|"POST"|"PUT"|"DELETE"|"PATCH"/, `${f}: GET only`);
  }
  assert.doesNotMatch(page, /(?<![.\w])get\(/, "the page reads only through intelGet");
  if (NO_UI_DEPS) return;
  const u = await ui();
  assert.deepEqual(u.allowedPaths(u.LIQUIDITY_READS), ["/api/liquidity", "/api/lens", "/api/ohlcv?timeframe=M15&limit=200", "/api/hud/levels?tf=15", "/api/engine/decision"]);
  await assert.rejects(u.intelGet(u.LIQUIDITY_READS, "omega"), /not allowed: omega/, "a read outside the list never leaves the page");
});

test("LQ4 the page renders over B8's contract and its unavailable case, each top-level key nulled and each array emptied", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  for (const [name, d] of [["liquidity.json", LIQ], ["liquidity-unavailable.json", UNAV]]) {
    const html = await page(d);
    clean(html);
    for (const t of ["Positioning &amp; Liquidity analyst", "Score against the floor", "Levels on the chart", "Facts, last 24 hours", "Sweeps and outcomes", "Baseline per New York hour of the week", "What it changed in Omega", "In the latest decision", "Liquidity never opens, sizes or prices an entry."]) assert.ok(html.includes(t), `${name}: ${t}`);
    for (const k of Object.keys(d)) {
      clean(await page({ ...d, [k]: null }));
      if (Array.isArray(d[k])) clean(await page({ ...d, [k]: [] }));
    }
    for (const k of Object.keys(d.effects)) clean(await page(u.merged(d, { effects: { [k]: null } })));
    for (const k of Object.keys(d.state)) clean(await page(u.merged(d, { state: { [k]: null } })));
  }
  const html = await page(LIQ);
  assert.ok(html.includes("lens B on") && html.includes("baseline insufficient · 2 of 4 weeks") && html.includes("backfill done · 2,419 bars"));
  assert.ok(html.includes("basis +0.35 (broker − feed)") && html.includes("ATR (15m) 3.00 · feed scale"));
  for (const t of ["▲ sell-side", "▼ buy-side", "pending", "not yet", "counted", "not counted", "replay"]) assert.ok(html.includes(t), t);
  assert.ok(html.includes("target moved") && html.includes("1 applied"), "the Position Manager's action, in words");
  // A registry entry for each fixture in the render check.
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["LiquidityView", "LiquidityViewUnavailable", "LiquidityViewLater", "LiquidityViewPendingMaker", "LiquidityViewLensOff", "LiquidityViewLens", "LiquidityViewDecision"]) assert.ok(names.includes(n), n);
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of ["liquidity.json", "liquidity-unavailable.json", "lens.json", "engine-decision.json"]) assert.match(entry, new RegExp(`test/fixtures/nexus-intel/${f.replace(".", "\\.")}`), f);
});

test("LQ5 the B15-B19 fields null: the not-yet Empties; filled: the card, the quorum with liquidity and the level moves", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(LIQ.conditions, null, "conditions null until B16");
  assert.equal(LIQ.effects.level_moves, null);
  // B15 filled the card and the quorum with liquidity in the contract (the latest decision's decision.liquidity); the
  // launch Empties are read with both null, as /api/liquidity answers for a decision without decision.liquidity.
  assert.ok(LIQ.card && LIQ.quorum_with_liquidity, "card and quorum_with_liquidity filled since B15");
  assert.deepEqual([UNAV.card, UNAV.quorum_with_liquidity], [null, null]);
  const filled = await page(LIQ);
  clean(filled);
  for (const t of ["LIQUIDITY", "council only", "never counted", "Quorum with liquidity", "sell side", "▲ +0.60"]) assert.ok(filled.includes(t), `B15's card: ${t}`);
  const launch = await page({ ...LIQ, card: null, quorum_with_liquidity: null });
  for (const t of ["No LIQUIDITY card yet", "Fills after backend B15 is deployed.", "Level moves", "Fills after backend B19 is deployed.", "Not scored yet", "Scored after backend B19 is deployed."]) assert.ok(launch.includes(t), t);
  assert.ok(!launch.includes("Quorum with liquidity"), "the quorum with liquidity waits for B15");
  assert.ok(launch.includes("Quorum") && launch.includes("WAIT"), "the quorum beside it is unchanged");
  const later = await page(u.merged(LIQ, u.LATER), { lens: u.LENS_AETHER });
  clean(later);
  for (const t of ["No LIQUIDITY card yet", "Fills after backend B15 is deployed.", "Fills after backend B19 is deployed."]) assert.ok(!later.includes(t), `filled: no "${t}"`);
  for (const t of ["LIQUIDITY", "council only", "never counted", "Quorum with liquidity", "with ▲ long", "▲ +0.60"]) assert.ok(later.includes(t), t);
});

test("LQ5b a pending maker or block is pending (plain, not yet scored), never a miss; empty kinds read \"none in 7 days\"", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The live mix (2026-11-23): every effects list empty but one maker whose outcome is pending.
  const live = await page(u.merged(LIQ, u.LIVE_EFFECTS));
  clean(live);
  const panel = live.slice(live.indexOf("What it changed in Omega"), live.indexOf("In the latest decision"));
  assert.match(panel, /<td[^>]*>maker<\/td>(?:(?!<\/tr>).)*<td[^>]*>1<\/td>(?:(?!<\/tr>).)*class="chip [^"]*text-fg-2">1 pending</s, "the maker row: 1, one plain pending chip");
  assert.doesNotMatch(panel, /\bmiss\b|none scored yet|text-fault/, "pending is not a miss and not an error");
  for (const a of ["block", "deferral", "skip"]) assert.match(panel, new RegExp(`<td[^>]*>${a}</td>(?:(?!</tr>).)*none in 7 days`, "s"), `${a}: none in 7 days`);
  assert.ok(panel.includes("No Position Manager action on a sweep in the last 7 days.") && panel.includes("Fills after backend B19 is deployed."));
  assert.ok(!panel.includes("Scored after backend B19 is deployed."), "no skip, no scoring note");
  // B8's outcomeOf: NULL and anything unknown read as pending; a pending block too.
  const counts = u.outcomeCounts([{ outcome: "hit" }, { outcome: "pending" }, { outcome: null }, { outcome: "odd" }, {}]);
  assert.deepEqual(counts, { hit: 1, miss: 0, neutral: 0, pending: 4 });
  const blocks = await page(u.merged(LIQ, { effects: { blocks: [{ at_ms: LIQ.state.at_ms - 60_000, side: "SELL", mode: "scalp", outcome: "pending" }, { at_ms: LIQ.state.at_ms - 120_000, side: "BUY", mode: "scalp", outcome: "hit" }] } }));
  const bp = blocks.slice(blocks.indexOf("What it changed in Omega"));
  assert.match(bp, /<td[^>]*>block<\/td>(?:(?!<\/tr>).)*1 hit(?:(?!<\/tr>).)*1 pending/s, "a block: 1 hit and 1 pending");
});

test("LQ6 no order text or line: no Entry, Stop or TP but the hint and \"management only, never an entry\"", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const allowed = ["Liquidity never opens, sizes or prices an entry.", "management only, never an entry"];
  const order = /\b(entry|entries|stop|stops|sl|tp\d?|take[ -]profit|stop[ -]loss|limit order)\b/i;
  const bodies = [LIQ, UNAV, u.merged(LIQ, u.LATER), u.merged(LIQ, { state: { on: false } })];
  for (const d of bodies) {
    let html = await page(d, { lens: u.LENS_AETHER });
    for (const a of allowed) html = html.split(a).join("");
    for (const t of textOf(html)) assert.doesNotMatch(t, order, t);
  }
  // The chart: the only price line is the last close (no title); the bands' labels carry no order word.
  const chart = src("components/IntelChart.tsx");
  assert.equal((chart.match(/createPriceLine\(/g) ?? []).length, 1);
  assert.match(chart, /createPriceLine\(\{ price: last\.close, title: "",/);
  const levels = u.feedLevels(LIQ.levels, LIQ.scale, LIQ.price.feed);
  const zones = u.chartZones({ levels, management: u.managementOf(LIQ, levels, LIQ.price.feed), plane: null, zonesOn: false, dim: false, suffix: "", show: true, candleTimes: [] });
  for (const z of zones) assert.doesNotMatch(z.label.replace("management only, never an entry", ""), order, z.label);
  assert.ok(zones.some((z) => z.label === u.MANAGEMENT_LABEL), "the key zones carry \"management only, never an entry\"");
  for (const f of ["pages/Liquidity.tsx", "components/IntelChart.tsx", "lib/intel.ts"]) {
    const strings = [...src(f).matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).filter((x) => !allowed.includes(x));
    for (const x of strings) assert.doesNotMatch(x, /\b(Entry|Stop|TP\d?|Take profit|Stop loss)\b/, `${f}: "${x}"`);
  }
});

test("LQ7 bands only from the *_feed values, and none without a known basis", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const last = LIQ.price.feed;
  const levels = u.feedLevels(LIQ.levels, LIQ.scale, last);
  assert.deepEqual(levels.map((l) => [l.low, l.high]), LIQ.levels.map((l) => [l.low_feed, l.high_feed]), "the feed values, never low/high (broker)");
  for (const l of levels) assert.equal(l.brokerMid, Math.round(((l.low + l.high) / 2 + LIQ.scale.feed_basis) * 100) / 100, "the label's broker middle");
  const feedValues = new Set([...LIQ.levels, ...LIQ.management].flatMap((l) => [l.low_feed, l.high_feed]));
  const management = u.managementOf(LIQ, levels, last);
  const zones = u.chartZones({ levels, management, plane: null, zonesOn: false, dim: false, suffix: "", show: true, candleTimes: [] });
  assert.ok(zones.length >= LIQ.levels.length);
  for (const z of zones) assert.ok(feedValues.has(z.low) && feedValues.has(z.high), `${z.label}: ${z.low}-${z.high} from *_feed`);
  // The basis unknown: no lens B band, no management band, the levels hidden.
  const unknown = u.merged(LIQ, { scale: { feed_basis: null, feed_basis_known: false, basis_at: null } });
  assert.deepEqual(u.feedLevels(unknown.levels, unknown.scale, last), []);
  assert.deepEqual(u.managementOf(unknown, [], last), []);
  const noBasis = u.merged(LIQ, { scale: { feed_basis: 0.35, feed_basis_known: false } });
  assert.deepEqual(u.feedLevels(noBasis.levels, noBasis.scale, last), [], "feed_basis_known false wins over a number");
  assert.deepEqual(u.feedLevels(LIQ.levels.map((l) => ({ ...l, low_feed: null })), LIQ.scale, last), [], "a level without its feed values is left out");
  const html = await page(unknown);
  assert.ok(html.includes("Levels hidden") && html.includes("the broker-to-feed basis is unknown") && html.includes("basis unknown"));
  assert.ok(!html.includes("Broker scale"), "no table without the basis");
  // The plane's zones (the toggle) are the feed's own.
  const plane = { levels: { chart_plane: { liquidity: { whale_zones: [{ role: "support", state: "active", top: 4095.77, bottom: 4094.57, age_bars: 3 }], fvg: { bull: [], bear: [{ price: 4108.02 }] } } } } };
  const on = u.chartZones({ levels: [], management: [], plane, zonesOn: true, dim: false, suffix: "", show: true, candleTimes: [1, 2, 3, 4, 5] });
  assert.deepEqual(on.map((z) => z.label), ["whale zone · feed 4,094.57–4,095.77", "FVG · feed 4,108.02"]);
  assert.equal(u.chartZones({ levels: [], management: [], plane, zonesOn: false, dim: false, suffix: "", show: true, candleTimes: [] }).length, 0, "off by default");
});

test("LQ8 every price carries its scale (feed or broker)", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const levels = u.feedLevels(LIQ.levels, LIQ.scale, LIQ.price.feed);
  for (const l of levels) assert.match(u.bandLabel(l), / · broker \d/, "band labels on the broker scale");
  assert.match(u.planeLabel("FVG", 1, 2), / · feed \d/);
  const PRICE = /\d,\d{3}\.\d{2}/;
  for (const d of [LIQ, u.merged(LIQ, u.LATER), UNAV]) {
    const html = await page(d);
    // A table of prices names its scales in its head; any other price names its scale in its own text.
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
    for (const t of tables.filter((x) => PRICE.test(x))) assert.match(t.slice(0, t.indexOf("</thead>")), /Feed scale[\s\S]*broker scale|Feed scale[\s\S]*Broker scale/, "both scales in the head");
    let rest = html;
    for (const t of tables) rest = rest.replace(t, "");
    for (const t of textOf(rest).filter((x) => PRICE.test(x))) assert.match(t, /feed|broker/i, t);
  }
});

test("LQ9 the LIQUIDITY card's weight: min(0.06, 0.1 x lens B's council weight), shown \"0.04 (0.036)\" at 0.36; stale: no weight", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  close(u.liquidityCardWeight(0.36), 0.036);
  close(u.liquidityCardWeight(0.3), 0.03);
  close(u.liquidityCardWeight(0.6), 0.06);
  close(u.liquidityCardWeight(0.8), 0.06);
  assert.equal(u.LIQUIDITY_CARD_MAX, 0.06);
  for (const x of [null, undefined, -0.1, Number.NaN, "0.36"]) assert.equal(u.liquidityCardWeight(x), null);
  assert.equal(u.cardWeightText(u.liquidityCardWeight(0.36)), "0.04 (0.036)");
  const card = await page(u.merged(LIQ, u.LATER), { lens: u.LENS_AETHER });
  assert.match(card, /0\.04 <span[^>]*>\(0\.036\)<\/span>/);
  // A card above the rule is held to it; a stale one shows no weight and no lean colour.
  const high = await page(u.merged(LIQ, u.merged(u.LATER, { card: { weight: 0.1 } })), { lens: u.LENS_AETHER });
  assert.match(high, /0\.04 <span[^>]*>\(0\.036\)<\/span>/);
  const old = u.merged(LIQ, u.merged(u.LATER, { state: { at_ms: u.LIQUIDITY_NOW - 22 * 60_000, fresh: false, on: false } }));
  const stale = await page(old, { lens: u.LENS_AETHER });
  assert.ok(stale.includes("stale 22m · Omega ignores it after 15m"));
  assert.ok(!stale.includes("(0.036)") && !stale.includes("▲ +0.60"));
});

test("LQ10 the states: intel views off, lens B off and at its floor, an old state, facts unavailable, market closed, no sweep, the error line", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const off = await page({ status: "not_found", reason: "intel_views_off" });
  assert.ok(off.includes("intel_views_off") && off.includes("The Intelligence views are off on the AI Worker."));
  // lens B off: grey (off) chips from state.on and the owner's switch; the facts still show.
  const lensOff = await page(u.merged(LIQ, { state: { on: false } }), { lens: u.LENS_OFF });
  assert.match(lensOff, /class="chip [^"]*text-off">lens B off</);
  assert.ok(lensOff.includes("Omega ignores these levels (lens B off)") && lensOff.includes("tick volume 62nd"), "facts shown while off");
  const floor = await page(u.merged(LIQ, { state: { on: false }, score: { floored: true } }));
  assert.ok(floor.includes("Omega ignores these levels (lens B at its floor)"));
  const old = await page(u.merged(LIQ, { state: { at_ms: u.LIQUIDITY_NOW - 22 * 60_000, fresh: false, on: false } }));
  assert.ok(old.includes("Omega ignores it after 15m") && old.includes("Omega ignores these levels (state 22m old)"));
  assert.match(old, /class="chip [^"]*text-late">Omega ignores it after 15m</, "the late chip");
  const unav = await page(UNAV);
  assert.ok(unav.includes("No recent broker bars") && unav.includes("No levels yet") && unav.includes("No sweep yet"));
  assert.match(unav, /text-off">lens B off</, "state.on false reads grey");
  const sat = Date.parse("2026-11-21T15:00:00Z");
  const closed = await page(u.merged(UNAV, { state: { at_ms: sat } }), { now: sat + 60_000 });
  assert.ok(closed.includes("Market closed") && closed.includes("Facts resume Sun 18:00 New York · Sun 23:00 UTC"), "the next open, from the date");
  const noSweep = await page(u.merged(LIQ, { sweeps: [] }));
  assert.ok(noSweep.includes("No sweep yet") && noSweep.includes("within the mode&#x27;s lookback"));
  const noLevels = await page(u.merged(LIQ, { levels: [] }));
  assert.ok(noLevels.includes("Lens B finds no pool, HVN or sweep near the price this minute."));
  assert.equal(new ApiError("/api/liquidity", 500, "liquidity_unavailable").message, "/api/liquidity 500 liquidity_unavailable", "the shared error line's text");
  const pg = src("pages/Liquidity.tsx");
  assert.match(pg, /<PollBody poll=\{liquidity\} skeleton=\{4\}/, "the error box (PollError) through PollBody");
  // Stale: planMark dims the bands and keeps their labels readable with " · stale 7m".
  const levels = u.feedLevels(LIQ.levels, LIQ.scale, LIQ.price.feed);
  const live = u.chartZones({ levels, management: [], plane: null, zonesOn: false, dim: false, suffix: "", show: true, candleTimes: [] });
  const dim = u.chartZones({ levels, management: [], plane: null, zonesOn: false, dim: true, suffix: " · stale 7m", show: true, candleTimes: [] });
  for (let i = 0; i < live.length; i++) {
    assert.ok(dim[i].alpha < live[i].alpha, "dimmed");
    assert.equal(dim[i].text, live[i].text, "the label colour kept");
    assert.ok(dim[i].label.endsWith(" · stale 7m"));
  }
  assert.equal(u.chartZones({ levels, management: [], plane: null, zonesOn: false, dim: true, suffix: "", show: false, candleTimes: [] }).length, 0, "hidden past 2 hours");
  assert.match(pg, /const mark = planMark\(facts, localNow\(\)\);/);
});

test("LQ11 colours from tokens.ts only: no hex, no emerald or rose, green only for a bullish direction", () => {
  for (const f of ["pages/Liquidity.tsx", "components/IntelChart.tsx", "lib/intel.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i, `${f}: no hex colour`);
    assert.doesNotMatch(s, /\b(?:emerald|rose|green|red)-\d/, `${f}: no Tailwind palette colour`);
  }
  const s = src("pages/Liquidity.tsx");
  const bull = s.split("\n").filter((l) => /text-bull|T\.bull\b|T\.bullFill|bg-bull/.test(l));
  assert.ok(bull.length >= 4, `bull lines: ${bull.length}`);
  for (const l of bull) assert.match(l, /▲|support|long|sell_side|lean > 0|bull/, `green only for bullish: ${l.trim().slice(0, 120)}`);
  assert.match(src("lib/intel.ts"), /export const ZONE_COLOR: Record<string, string> = \{ support: T\.bullFill, resistance: T\.bearFill, "at price": T\.okFill \};/, "PriceChart's ZONE_COLOR");
  assert.match(src("components/PriceChart.tsx"), /const ZONE_COLOR: Record<string, string> = \{ support: T\.bullFill, resistance: T\.bearFill, "at price": T\.okFill \};/, "the same as the War Room chart");
  // Outcomes and states in the status tones.
  assert.match(s, /const OUTCOME_TONE: Record<string, Tone> = \{ hit: "ok", miss: "fault", neutral: "off", pending: "plain" \};/);
});

test("LQ12 the chart is built only in useEffect; the deploy smoke step; SSOT and the CHANGELOG", () => {
  const chart = src("components/IntelChart.tsx");
  const effects = [...chart.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)].map((m) => m[1]).join("\n");
  assert.ok(effects.includes("createChart(el.current"), "createChart inside an effect");
  assert.equal((chart.match(/createChart\(/g) ?? []).length, 1);
  assert.match(chart, /<PollBody poll=\{poll\} skeleton="chart"/, "the candles' loading and error states");
  assert.match(chart, /new ZonesPrimitive\("anchored"\)/, "bands through lib/zones-primitive.ts, labels anchored to their band");
  assert.match(src("lib/zones-primitive.ts"), /export function placeLabel\(/);
  const wf = read(".github/workflows/deploy-nexus-dashboard.yml");
  const step = wf.slice(wf.indexOf("- name: Smoke test the Liquidity view"));
  assert.ok(step.length > 100, "the step");
  assert.match(step, /https:\/\/nexus\.cryptophys\.work\/api\/liquidity/);
  assert.match(step, /isAccessLogin\(bare\)/, "the Access redirect without the token");
  assert.match(step, /r\.status !== 200/);
  assert.match(step, /no-store/);
  assert.match(step, /\\bjson\\b/);
  assert.match(step, /headers: token\.headers/, "under the CI token");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /Liquidity \(`#\/liquidity`, Track C2, directly after Strategy agents/);
  assert.match(ssot, /Nexus Liquidity page \(`#\/liquidity`, Track C2\) panel "Positioning & Liquidity analyst"/);
  const log = read("docs/CHANGELOG.md");
  assert.ok(log.indexOf("feat(nexus): the Liquidity page in Intelligence (Track C2)") > log.indexOf("## 2026-11-23") && log.indexOf("feat(nexus): the Liquidity page in Intelligence (Track C2)") < log.indexOf("## 2026-11-22"));
});
