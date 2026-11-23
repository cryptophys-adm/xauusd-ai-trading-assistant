// The Nexus Liquidity page (Track C2, "feat(nexus): Liquidity", as the owner-approved mockup): its route, its reads (GET
// only, one poll each, one /api/lens read in the whole UI), its render over backend B8's contract
// (test/fixtures/nexus-intel/liquidity.json and liquidity-unavailable.json), the not-yet states of the fields backends
// B16-B19 fill, no order text or line, the bands only from *_feed values and none without a known basis, a scale on
// every price, the LIQUIDITY card and the quorum with liquidity from backend B15's contract, and the states the mockup
// draws.
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
    stdin: { contents: 'export * from "./src/lib/intel"; export * from "./src/pages/Liquidity"; export { render, merged, LATER, LIVE_EFFECTS, LIQUIDITY_NOW, LENS_AETHER, LENS_OFF, NO_CARD, CARD_REASONS, CARD_BEARISH, CARD_STALE, QUORUM_NOT_MET, COND_WARN, COND_UNMEASURED, COND_EXCLUDED, COND_OFF, COND_BRIEF, COND_STALE, COND_NO_THRESHOLDS, VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
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

test("LQ1 NAV and PAGES: Liquidity at /#/liquidity, key liquidity, icon Droplets, after Strategy agents and Chart patterns (C3)", () => {
  const shell = src("components/AppShell.tsx");
  const intel = shell.slice(shell.indexOf('{ title: "Intelligence"'), shell.indexOf("] }\n];"));
  const labels = [...intel.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Aether", "Model & Learning", "Strategy agents", "Chart patterns", "Liquidity", "Neuron allocation", "Decision audit", "Alerts"]);
  assert.match(intel, /\{ label: "Liquidity", href: "\/#\/liquidity", key: "liquidity", icon: Droplets \}/);
  assert.match(shell, /import \{[^}]*\bDroplets\b[^}]*\} from "lucide-react";/);
  assert.ok(!shell.includes("Opening range"), "Opening range comes with its own track (C4)");
  const app = src("App.tsx");
  assert.match(app, /import Liquidity from "\.\/pages\/Liquidity";/);
  assert.match(app, /strategy: Strategy, patterns: Patterns, liquidity: Liquidity,/);
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
  for (const n of ["LiquidityView", "LiquidityViewNoCard", "LiquidityViewCard", "LiquidityViewQuorumWithLiquidity", "LiquidityViewCardBearish", "LiquidityViewCardStale", "LiquidityViewQuorumNotMet",
    "LiquidityViewReason_no_agreeing_witness", "LiquidityViewReason_sweep_stale", "LiquidityViewReason_not_reclaimed", "LiquidityViewReason_no_sweep",
    "LiquidityViewUnavailable", "LiquidityViewLater", "LiquidityViewPendingMaker", "LiquidityViewLensOff", "LiquidityViewLens", "LiquidityViewDecision"]) assert.ok(names.includes(n), n);
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of ["liquidity.json", "liquidity-unavailable.json", "lens.json", "engine-decision.json"]) assert.match(entry, new RegExp(`test/fixtures/nexus-intel/${f.replace(".", "\\.")}`), f);
});

test("LQ5 the B16-B19 fields null: the not-yet Empties; filled: the level moves; B15's card and quorum with liquidity null: one Empty", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // B16 filled conditions (lens B's liquidity conditions, the rooms' line, no price); the unavailable case keeps it null.
  assert.ok(LIQ.conditions && typeof LIQ.conditions.line === "string", "conditions filled since B16");
  assert.equal(UNAV.conditions, null);
  assert.equal(LIQ.effects.level_moves, null);
  // B15 filled the card and the quorum with liquidity in the contract (the latest decision's decision.liquidity);
  // /api/liquidity answers both null for a decision without decision.liquidity.
  assert.ok(LIQ.card && LIQ.quorum_with_liquidity, "card and quorum_with_liquidity filled since B15");
  assert.deepEqual([UNAV.card, UNAV.quorum_with_liquidity], [null, null]);
  const launch = await page({ ...LIQ, ...u.NO_CARD });
  clean(launch);
  for (const t of ["No LIQUIDITY card in the latest decision", "None while the switch is off, lens B is off, floored or stale, or the decision came before the card (B15).", "Level moves", "Fills after backend B19 is deployed.", "Not scored yet", "Scored after backend B19 is deployed."]) assert.ok(launch.includes(t), t);
  assert.ok(!launch.includes("Quorum with liquidity"), "no quorum with liquidity without decision.liquidity");
  assert.ok(!launch.includes("Fills after backend B15"), "B15 is live: no not-yet wording for it");
  assert.ok(launch.includes("Quorum") && launch.includes("WAIT"), "the quorum beside it is unchanged");
  const later = await page(u.merged(LIQ, u.LATER), { lens: u.LENS_AETHER });
  clean(later);
  for (const t of ["No LIQUIDITY card in the latest decision", "Fills after backend B19 is deployed."]) assert.ok(!later.includes(t), `filled: no "${t}"`);
  for (const t of ["LIQUIDITY", "Quorum with liquidity", "Level moves"]) assert.ok(later.includes(t), t);
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

/** The text of the LIQUIDITY card (from its name to the quorum beside it). */
const cardOf = (html) => { const i = html.indexOf(">LIQUIDITY<"); return i < 0 ? "" : html.slice(i, html.indexOf(">Quorum<", i)); };
/** The quorum with liquidity block. */
const qwOf = (html) => { const i = html.indexOf("Quorum with liquidity"); return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i) < 0 ? undefined : html.indexOf("</section>", i)); };

test("LQ9 the LIQUIDITY card from B15's contract: its own weight, lean and side, sweep, reason in words with the code, counts in words, times in UTC and local", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const c = LIQ.card;
  // The contract's own numbers: the weight rule holds on the fixture (min(0.06, 0.1 x lens_weight)), lean +-0.6 or 0.
  assert.deepEqual([c.counts, c.weight, c.lens_weight, c.lean, c.side, c.sweep, c.lean_reason, c.stale], [false, 0.03, 0.3, 0.6, "BULLISH", "sell_side", "sweep_with_agreeing_witness", false]);
  assert.ok(Math.abs(u.liquidityCardWeight(c.lens_weight) - c.weight) < 1e-12, "the card's weight is the rule's");
  assert.ok(Math.abs(u.liquidityCardWeight(0.36) - 0.036) < 1e-12 && u.liquidityCardWeight(0.8) === u.LIQUIDITY_CARD_MAX && u.LIQUIDITY_CARD_MAX === 0.06);
  for (const x of [null, undefined, -0.1, Number.NaN, "0.36"]) assert.equal(u.liquidityCardWeight(x), null);
  assert.deepEqual([0.03, 0.036, 0.06, 0.02, null].map(u.cardWeightText), ["0.03", "0.036", "0.06", "0.02", "—"]);
  const html = await page(LIQ);
  clean(html);
  const card = cardOf(html);
  assert.ok(card.length > 100, "the card renders");
  const text = textOf(card);
  for (const t of ["Council only: it never counts toward the quorum.", "weight", "0.03", "a tenth of lens B&#x27;s 0.30, at most 0.06", "lean", "sweep", "reason", "fresh sweep, H1 and M15 agree", "sweep_with_agreeing_witness"]) assert.ok(text.includes(t), `the card: ${t}`);
  assert.match(card, /<span class="text-bull">▲ \+0\.60 bullish<\/span>/, "a bullish lean in green");
  assert.match(card, /<span class="text-bull">▲ sell-side<\/span><\/span><span class="text-balance text-\[11px\] text-muted">3 min ago<\/span>/, "a sell-side sweep reads bullish, its age below");
  assert.match(card, /class="chip [^"]*text-ok">fresh 13m</, "fresh: the ok tone, aged by its own at_ms");
  assert.match(card, /<span class="mono text-\[11px\] text-muted">sweep_with_agreeing_witness<\/span>/, "the code kept, small and mono");
  // counts false in words, never a chip; no extra chip but the state's.
  assert.doesNotMatch(card, /class="chip[^"]*">(?:council only|never counted)</);
  assert.equal((card.match(/class="chip /g) ?? []).length, 1, "one chip: the state");
  // The summary: words only, its closing council sentence left to the card's own line, kept out of the layout (a hint).
  assert.equal(u.cardSummary(c.summary), "A reclaimed sell-side sweep on a tick-volume spike 3 minutes ago on the broker's own bars, and 1H War Room and 15m War Room lean bullish too: it leans bullish.");
  assert.equal(u.cardSummary("No lean."), "No lean.");
  assert.equal(u.cardSummary(null), null);
  assert.ok(card.includes('role="note"') && card.includes("1H War Room and 15m War Room lean bullish too"), "the summary as the hint");
  assert.equal((card.match(/never counts/g) ?? []).length, 1, "said once");
  // Times: made (at_ms) and lens B state (state_at_ms) in UTC and local; the bar close only when it is not the panel's.
  assert.ok(text.includes("made") && card.includes("14:47 UTC · ") && text.includes("lens B state") && card.includes("14:46 UTC · "));
  assert.ok(!text.includes("decision"), "the card's bar close is the panel's decision: not repeated");
  const other = cardOf(await page(LIQ, { decision: u.merged(decisionBody(), { decision: { bar_close: "2026-11-23T14:30:00.000Z" } }) }));
  assert.ok(textOf(other).includes("decision") && other.includes("14:45 UTC · "), "a card from another decision names its bar");
  // Bearish: red; no field the contract lacks (no price, no "with/against" reading, no lens weight from /api/lens).
  const bear = cardOf(await page({ ...LIQ, card: u.CARD_BEARISH }));
  assert.match(bear, /<span class="text-bear">▼ −0\.60 bearish<\/span>/);
  assert.match(bear, /<span class="text-bear">▼ buy-side<\/span>/);
  assert.ok(textOf(bear).includes("6 min ago"));
  assert.ok(textOf(bear).includes("fresh sweep, M15 agrees"));
  assert.doesNotMatch(card, /\d,\d{3}\.\d{2}|sweep_with<|sweep_against|with ▲ long/);
  const noLens = cardOf(await page(LIQ, { lens: null }));
  assert.ok(textOf(noLens).includes("0.03") && textOf(noLens).includes("a tenth of lens B&#x27;s 0.30, at most 0.06"), "the card reads its own weight, not /api/lens");
});

test("LQ9b each lean_reason in short words with its code; a lean of 0 reads neutral amber", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const WORDS = { sweep_with_agreeing_witness: "fresh sweep, H1 and M15 agree", no_agreeing_witness: "fresh sweep, no witness agrees", sweep_stale: "sweep older than 15 min", not_reclaimed: "sweep not reclaimed", no_sweep: "no reclaimed sweep in 15 min" };
  assert.deepEqual(Object.keys(u.CARD_REASONS).sort(), Object.keys(WORDS).sort(), "every code liquidityCard writes");
  // The codes are src/decision-engine.mjs liquidityCard's own.
  const engine = read("src/decision-engine.mjs");
  for (const code of Object.keys(WORDS)) assert.ok(engine.includes(`"${code}"`), code);
  for (const [code, words] of Object.entries(WORDS)) {
    const card = cardOf(await page({ ...LIQ, card: u.CARD_REASONS[code] }));
    clean(card);
    const text = textOf(card);
    assert.ok(text.includes(words), `${code}: ${words}`);
    assert.ok(text.includes(code), `${code}: the code shown`);
    if (code !== "sweep_with_agreeing_witness") {
      assert.match(card, /<span class="text-neutral">· 0\.00 neutral<\/span>/, `${code}: neutral amber`);
      assert.ok(code === "no_agreeing_witness" ? text.includes("▲ sell-side") && text.includes("3 min ago") : text.includes("none") && !text.includes("min ago"), `${code}: the sweep`);
    }
  }
  assert.equal(u.leanReasonText("sweep_with_agreeing_witness", []), "fresh sweep, a witness agrees");
  assert.equal(u.leanReasonText("sweep_with_agreeing_witness", ["H1", "M15", "NEWS"]), "fresh sweep, H1, M15 and NEWS agree");
  assert.equal(u.leanReasonText("some_new_code"), "some new code", "an unknown code in its words");
  assert.equal(u.leanReasonText(null), "—");
});

test("LQ9c a stale card: the late tone, no direction colour; the quorum with liquidity met and not met, informational", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const stale = cardOf(await page({ ...LIQ, card: u.CARD_STALE }));
  clean(stale);
  assert.match(stale, /class="chip [^"]*text-late">stale 22m</, "stale: the late (amber) tone");
  assert.doesNotMatch(stale, /text-bull|text-bear|text-ok/, "no direction or ok colour while stale");
  assert.ok(textOf(stale).includes("▲ +0.60 bullish") && stale.includes("14:38 UTC · "), "its values and time kept");
  // Stale by this clock too: the contract's flag false but its time 16 minutes old.
  const aged = cardOf(await page(LIQ, { now: LIQ.card.at_ms + 16 * 60_000 }));
  assert.match(aged, /text-late">stale 16m</);
  // Met: long (green), not met (no), both sides.
  const met = qwOf(await page(LIQ));
  const said = "Informational: the quorum with the LIQUIDITY card added at its weight. No gate reads it.";
  assert.ok(met.includes(said), "informational, in plain text");
  assert.doesNotMatch(met, /class="chip/, "no chip");
  assert.match(met, /needs above<\/span><span[^>]*>0\.50</, "needs above: the mode's quorum_min, the check met reads");
  assert.match(met, /met<\/span><span[^>]*><span class="text-bull">▲ long<\/span><\/span><span[^>]*>score <span class="mono text-bull">\+0\.17</, "met, with the score below in its bias's tone");
  assert.ok(textOf(met).includes("▲ 0.67") && textOf(met).includes("▼ 0.33") && textOf(met).includes("· 0.14"));
  const html = await page({ ...LIQ, quorum_with_liquidity: u.QUORUM_NOT_MET });
  const not = qwOf(html);
  assert.match(not, /met<\/span><span[^>]*>no</);
  assert.match(not, /score <span class="mono text-neutral">\+0\.08</);
  assert.equal((html.match(/No gate reads it\./g) ?? []).length, 1, "said once on the page");
  const short = qwOf(await page({ ...LIQ, quorum_with_liquidity: { ...LIQ.quorum_with_liquidity, bias: "BEARISH", score: -0.2, long_met: false, short_met: true } }));
  assert.match(short, /met<\/span><span[^>]*><span class="text-bear">▼ short</);
  const both = qwOf(await page({ ...LIQ, quorum_with_liquidity: { ...LIQ.quorum_with_liquidity, long_met: true, short_met: true } }));
  assert.match(both, /met<\/span><span[^>]*>both sides</);
});

test("LQ10 the states: intel views off, lens B off and at its floor, an old state, facts unavailable, market closed, no sweep, the error line", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const off = await page({ status: "not_found", reason: "intel_views_off" });
  assert.ok(off.includes("intel_views_off") && off.includes("The Intelligence views are off on the AI Worker."));
  // lens B off: grey (off) chips from state.on and the owner's switch; the facts still show.
  const lensOff = await page(u.merged(LIQ, { state: { on: false } }), { lens: u.LENS_OFF });
  assert.match(lensOff, /class="chip [^"]*text-off">lens B off</);
  assert.ok(lensOff.includes("Omega ignores these levels (lens B off)") && lensOff.includes("Activity normal · p62"), "facts shown while off (as B16's conditions)");
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

/** The Facts panel's markup (its heading to the Sweeps panel). */
const factsOf = (html) => { const i = html.indexOf("Facts, last 24 hours"); return i < 0 ? "" : html.slice(i, html.indexOf("Sweeps and outcomes", i)); };

test("LQ10b lens B's conditions (B16) in the Facts panel: spread, depth and activity in words with their value, session, levels, the mode, baseline and time once, the rooms' line", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const c = LIQ.conditions;
  assert.deepEqual(Object.keys(c).sort(), ["activity", "at_ms", "baseline", "baseline_weeks", "depth", "in_rooms", "levels", "line", "mode", "room_line", "session", "spread", "stale"].sort(), "the binding key tree");
  const html = await page(LIQ);
  clean(html);
  const facts = factsOf(html);
  const text = textOf(facts);
  for (const t of ["Spread normal · 1.1× typical", "Depth normal · p41", "Activity normal · p62", "London + New York overlap · liquidity high", "outside a high-volume node · 0 nodes above, 1 below · pools 1 above, 0 below, 0 at price", "intraday mode · baseline insufficient, 2 of 4 weeks", "What the rooms read", c.line.replace(/'/g, "&#x27;")]) assert.ok(text.includes(t), t);
  assert.ok(facts.includes("14:58 UTC · "), "at_ms in UTC and local");
  // Normal states carry no tone; the conditions replace the facts' own chips (the same numbers, said once).
  assert.match(facts, /<span>Spread normal · 1\.1× typical<\/span>/);
  assert.doesNotMatch(facts, /tick volume 62nd|15m volume 41st|spread 1\.1x the hour/, "no repeated chips");
  assert.equal((facts.match(/intraday mode ·/g) ?? []).length, 1, "the mode, baseline and weeks once, quietly (the legend names the thresholds' mode; the line is the rooms' own words)");
  assert.ok(text.includes("percentile basis: same New York hour, rolling (baseline insufficient)"), "the basis chip kept (not in conditions)");
  assert.doesNotMatch(facts, /stale|The rooms are not reading/);
  // The line: no price (no price-shaped number) and no sweep.
  assert.doesNotMatch(c.line, /\d,\d{3}\.\d{2}|\d{4}\.\d/);
  assert.doesNotMatch(c.line, /sweep/i);
  // The helpers.
  assert.equal(u.sessionText({ names: [], overlap: false, liquidity: "thin", excluded: null }), "between sessions · liquidity thin");
  assert.equal(u.sessionText({ names: [], overlap: false, liquidity: "closed", excluded: null }), "market closed");
  assert.equal(u.sessionText({ names: [], overlap: false, liquidity: "paused", excluded: "market_paused" }), "the daily trading pause · minute excluded from the baseline (market paused)");
  assert.equal(u.sessionText(null), "—");
  assert.equal(u.levelsText({ inside_node: true, nodes_above: 1, nodes_below: 0, pools_above: 0, pools_below: 2, pools_at: 0 }), "inside a high-volume node · 1 node above, 0 below · pools 0 above, 2 below, 0 at price");
  assert.equal(u.levelsText(null), "—");
});

test("LQ10c each state word and its tone: widened fault (Omega's entry gate refuses at that ratio), thin and spike late, normal and unmeasured none", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const states = { spread: ["normal", "widened", "unmeasured"], depth: ["normal", "thin", "unmeasured"], activity: ["normal", "spike", "unmeasured"] };
  const lens = read("src/liquidity-lens.mjs");
  for (const [k, list] of Object.entries(states)) {
    assert.deepEqual(Object.keys(u.CONDITION_WORDS[k]).sort(), [...list].sort(), `${k}: every state liquidityConditions writes`);
    for (const st of list) assert.ok(lens.includes(`"${st}"`), `${k} ${st} in src`);
  }
  assert.deepEqual([["spread", "widened"], ["depth", "thin"], ["activity", "spike"], ["spread", "normal"], ["depth", "unmeasured"], ["activity", "normal"]].map(([k, s]) => u.conditionTone(k, s)), ["fault", "late", "late", null, null, null]);
  // The block the tone rests on: Omega refuses a new entry while the live spread is at or above the mode's spread_widen.
  assert.match(read("src/omega-engine.mjs"), /liveSpreadSpike\(signal, sym\), "liquidity_spread_spike"\]/);
  const warn = factsOf(await page({ ...LIQ, conditions: u.COND_WARN }));
  assert.match(warn, /<span class="text-fault">Spread widened · 2\.3× typical<\/span>/);
  assert.match(warn, /<span class="text-late">Depth thin · p12<\/span>/);
  assert.match(warn, /<span class="text-late">Activity spike · p97<\/span>/);
  const unm = factsOf(await page({ ...LIQ, conditions: u.COND_UNMEASURED }));
  for (const t of ["Spread unmeasured", "Depth unmeasured", "Activity unmeasured"]) assert.match(unm, new RegExp(`<span>${t}</span>`), t);
  assert.equal(u.conditionText("depth", { state: "new_state", vol_pctl_15m: 0.3 }), "Depth new state · p30", "an unknown state in its words");
});

test("LQ10d null, stale, session excluded, the levels line and the rooms not reading: one Empty, the late age, one note", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const none = factsOf(await page({ ...LIQ, conditions: null }));
  clean(none);
  assert.ok(none.includes("No conditions yet") && none.includes("The AI Worker gives none while lens B has no available facts."));
  assert.ok(none.includes("tick volume 62nd"), "the facts' own chips without conditions");
  assert.doesNotMatch(none, /What the rooms read|thresholds of the/);
  // Facts unavailable (conditions null in the contract too): the facts' own Empty is the reason, no second one.
  const unav = factsOf(await page(UNAV));
  assert.equal(UNAV.conditions, null);
  assert.ok(unav.includes("No recent broker bars") && !unav.includes("No conditions yet"));
  const stale = factsOf(await page({ ...LIQ, conditions: u.COND_STALE }));
  assert.match(stale, /<span class="text-late">stale 22m<\/span>/);
  assert.ok(stale.includes("14:38 UTC · "));
  const aged = factsOf(await page(LIQ, { now: LIQ.conditions.at_ms + 16 * 60_000 }));
  assert.match(aged, /text-late">stale 16m</, "stale by the page's clock too");
  const ex = textOf(factsOf(await page({ ...LIQ, conditions: u.COND_EXCLUDED })));
  assert.ok(ex.includes("London · liquidity normal · minute excluded from the baseline (session open)"));
  assert.ok(ex.includes("inside a high-volume node · 2 nodes above, 1 below · pools 1 above, 0 below, 1 at price"));
  // The rooms: one note only when they are not reading (in_rooms false; room_line brief), the label otherwise.
  const off = factsOf(await page({ ...LIQ, conditions: u.COND_OFF }));
  assert.ok(off.includes("The rooms are not reading these now: lens B is off or at its floor, or its state is older than 15 minutes.") && !off.includes("What the rooms read"));
  const brief = factsOf(await page({ ...LIQ, conditions: u.COND_BRIEF }));
  assert.ok(brief.includes("The rooms read only lens B&#x27;s brief line, not these conditions (LENS_ROOM_LINE brief).") && !brief.includes("The rooms are not reading"));
  assert.equal(u.roomsNote(LIQ.conditions), null);
  // in_rooms and room_line as the view writes them.
  assert.match(read("src/liquidity-view.mjs"), /in_rooms: roomLine === "conditions" && liquidityConditionsOn\(state, knobs, now\), room_line: roomLine/);
});

test("LQ10e thresholds only from the fields that carry them: the widen line and the legend's numbers; none invented", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const c = LIQ.conditions;
  assert.deepEqual([c.spread.widen, c.activity.spike_pctl, c.depth.thin_pctl], [2, 0.95, 0.2], "the mode's knobs in the contract");
  const facts = factsOf(await page(LIQ, { candles: null }));
  for (const t of ["Spread 2× (widened)", "Spread above 2×", "Spike, 95th or more", "Thin, 20th or less", "thresholds of the intraday mode"]) assert.ok(textOf(facts).includes(t), t);
  // The dashed amber line at 2x on the spread axis (the wide and the phone chart), its label amber.
  assert.equal((facts.match(/<line[^>]*stroke-dasharray="4 3"[^>]*>/g) ?? []).filter((l) => !l.includes('x1="0"')).length, 2, "one widen line per chart");
  const late = read("workers/xauusd-nexus-dashboard/ui/src/lib/tokens.ts").match(/\blate: "(#[0-9a-f]{6})"/)[1];
  assert.equal((facts.match(new RegExp(`fill="${late}">2x</text>`, "g")) ?? []).length, 2, "the 2x label amber on both charts");
  // Without the thresholds (knobs missing): no line, no number, the facts' own flags.
  // (The rooms' line is the AI Worker's own words, thresholds included: left out of these checks.)
  const noLine = (h) => h.replace(/<p class="text-\[12px\] leading-snug text-fg-2">[^<]*<\/p>/g, "");
  const bare = noLine(factsOf(await page({ ...LIQ, conditions: u.COND_NO_THRESHOLDS })));
  const bareText = textOf(bare);
  for (const t of ["Spread widened", "Volume spike", "Thin", "as lens B flags them in the intraday mode"]) assert.ok(bareText.includes(t), t);
  assert.doesNotMatch(bare, /thresholds of the|Spread 2×|Spread above|or more|or less|stroke-dasharray="4 3"/);
  const none = factsOf(await page({ ...LIQ, conditions: null }));
  assert.doesNotMatch(none, /thresholds of the|or more|or less|stroke-dasharray="4 3"/, "no threshold without conditions");
  // No threshold number typed in the page: the legend's numbers come from the fields only.
  const pg = src("pages/Liquidity.tsx");
  assert.doesNotMatch(pg, /95th|20th|"2x"|spread_widen\s*[:=]\s*\d|thin_pctl\s*[:=]\s*0\.\d|spike_pctl\s*[:=]\s*0\.\d/);
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
  assert.match(ssot, /Liquidity \(`#\/liquidity`, Track C2, after Chart patterns/);
  assert.match(ssot, /Nexus Liquidity page \(`#\/liquidity`, Track C2\) panel "Positioning & Liquidity analyst"/);
  const log = read("docs/CHANGELOG.md");
  assert.ok(log.indexOf("feat(nexus): the Liquidity page in Intelligence (Track C2)") > log.indexOf("## 2026-11-23") && log.indexOf("feat(nexus): the Liquidity page in Intelligence (Track C2)") < log.indexOf("## 2026-11-22"));
});
