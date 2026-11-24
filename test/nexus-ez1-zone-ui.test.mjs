// The EZ1 entry zone in Nexus (owner-approved mockup df67c5f1, 2026-11-23): the decision's entry zone on the War Room
// (the Decision card's item, the plan ladder's Entry row, the chart's Entry band; feed scale) and where Omega rests the
// limit on the Omega page (the Signal card, the Entry status, the chart's zone, limit, bid and ask converted from the
// broker to the feed, the intents' Entry cell; broker scale). Display only: no new read, no new API field. The pure
// helpers (lib/entryZone.ts: the detail formatters, the broker-to-feed conversion, the band's source), the OmegaWhy
// wording of the five codes, and the render-check variants (zone with the engine on, the engine off, no zone fields,
// each code) over test/fixtures/nexus-ez1/*.json.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as ez from "../workers/xauusd-nexus-dashboard/ui/src/lib/entryZone.ts";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-ez1/${f}`));
const GLOBAL = fixture("conclusion-global.json"), OVERVIEW = fixture("omega-overview.json");

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
/** The views from an esbuild bundle of the UI, as the render check bundles them (CommonJS, lightweight-charts on its stub). */
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export { default as OmegaWhy, omegaReason } from "./src/components/OmegaWhy"; export * from "./src/components/PlanLadder"; export * from "./src/components/OmegaZone"; export { render, VIEWS, BROKEN, EZ1_ENGINE_OFF, EZ1_NO_ZONE, EZ1_DETAILS, EZ1_CODE_SHOWS, ez1Code, withoutZone } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
const textOf = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((t) => t.trim()).filter(Boolean).join(" ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

test("EZ1-1 the detail formatters: limit_in_zone's \"a -> b\" and limit_zone_edge's JSON, both labelled broker; refusals keep the code's text", () => {
  assert.equal(ez.inZoneDetail("2685.32 -> 2684.64"), "from 2685.32 to 2684.64 · broker");
  assert.equal(ez.inZoneDetail("2685.3 -> 2684.6"), "from 2685.30 to 2684.60 · broker", "two decimals");
  assert.equal(ez.inZoneDetail("from here"), null);
  assert.equal(ez.inZoneDetail(null), null);
  const edge = JSON.stringify({ plan_entry: 2685.32, edge: 2686.02, away_r_plan: 0.462, away_r_edge: 0.307 });
  assert.equal(ez.zoneEdgeDetail(edge), "plan 2685.32 · 0.462R away → edge 2686.02 · 0.307R away · broker");
  assert.equal(ez.zoneEdgeDetail(JSON.stringify({ plan_entry: 2685.32, edge: 2686.02 })), "plan 2685.32 → edge 2686.02 · broker", "without the R distances");
  assert.equal(ez.zoneEdgeDetail("{not json"), null);
  assert.equal(ez.zoneEdgeDetail(JSON.stringify({ edge: 2686.02 })), null);
  // plannerDetail: the two placements through their formatters (raw if the shape is unknown), the three refusals in the
  // code's own words with the scale, every other code unchanged.
  assert.equal(ez.plannerDetail("limit_in_zone", "2685.32 -> 2684.64"), "from 2685.32 to 2684.64 · broker");
  assert.equal(ez.plannerDetail("limit_in_zone", "odd"), "odd");
  assert.equal(ez.plannerDetail("limit_zone_edge", edge), "plan 2685.32 · 0.462R away → edge 2686.02 · 0.307R away · broker");
  assert.equal(ez.plannerDetail("zone_passed", "the entry zone 2684.62-2686.02 is passed"), "the entry zone 2684.62-2686.02 is passed · broker");
  assert.equal(ez.plannerDetail("zone_tight", "a limit at 2684.68 leaves 0.56 of risk"), "a limit at 2684.68 leaves 0.56 of risk · broker");
  assert.equal(ez.plannerDetail("zone_rr", "a limit at 2686.02 pays 0.869 R to the target, under 1"), "a limit at 2686.02 pays 0.869 R to the target, under 1 · broker");
  assert.equal(ez.plannerDetail("spread", "34 pts"), "34 pts", "other codes unchanged");
  assert.equal(ez.plannerDetail("spread", null), null);
  assert.equal(ez.plannerDetail("spread", ""), null);
  // The intents' placement words (zone_from, entry_basis).
  assert.equal(ez.intentPlacement({ zone_from: 2685.32 }), "in zone · from 2685.32");
  assert.equal(ez.intentPlacement({ zone_from: 2685.32, entry_basis: "zone_edge" }), "near edge · from 2685.32");
  assert.equal(ez.intentPlacement({ entry: 2685.32 }), null, "a plain limit says nothing new");
});

test("EZ1-2 broker to feed: broker − feed_basis, only with a known basis; the chart's caption says the scale once", () => {
  assert.equal(ez.knownFeedBasis({ feed_basis: 0.42, feed_basis_known: true }), 0.42);
  assert.equal(ez.knownFeedBasis({ feed_basis: 0, feed_basis_known: false }), null, "the signal's 0 while unknown is not a basis");
  assert.equal(ez.knownFeedBasis({ feed_basis: 0.42 }), null, "feed_basis_known must say so");
  assert.equal(ez.knownFeedBasis(null), null);
  assert.equal(ez.brokerToFeed(2684.64, 0.42), 2684.22);
  assert.equal(ez.brokerToFeed(2684.86, 0.42), 2684.44);
  assert.equal(ez.brokerToFeed(2684.64, -0.35), 2684.99);
  assert.equal(ez.brokerToFeed(2684.64, null), null);
  assert.equal(ez.brokerToFeed(null, 0.42), null);
  assert.equal(ez.brokerToFeed(0, 0.42), null, "no price");
  assert.equal(ez.brokerToFeed(2686.021, 0.42, 3), 2685.601, "to the symbol's digits");
  assert.deepEqual(ez.zoneToFeed({ low: 2684.62, high: 2686.02 }, 0.42), { low: 2684.2, high: 2685.6 });
  assert.deepEqual(ez.zoneToBroker({ low: 2684.2, high: 2685.6 }, 0.42), { low: 2684.62, high: 2686.02 });
  assert.equal(ez.zoneToFeed({ low: 1, high: 2 }, null), null);
  // The Omega chart's labels carry no price and no scale (OM-TEXT, test/nexus-omega-chart-text.test.mjs): the caption does.
  assert.equal(ez.chartScaleCaption(0.42), "prices: feed · MT5 +0.42");
  assert.equal(ez.chartScaleCaption(null), "prices: feed · MT5 lines not converted");
  assert.equal(ez.basisText(0.42), "+0.420");
  assert.equal(ez.basisText(-0.35, 2), "−0.35");
  // Omega's resting limit: its own broker order first (a manual one never), else the newest pending place_limit intent.
  const intents = OVERVIEW.broker.intents;
  assert.deepEqual(ez.restingLimit([], intents), { price: 2684.64, side: "BUY", zone: { low: 2684.62, high: 2686.02 }, intent: intents[0] });
  const order = { ticket: 50128, type: "BUY_LIMIT", price_open: 2686.02, comment: "e:1345:BUY", magic: 920200 };
  assert.equal(ez.restingLimit([order], intents).price, 2686.02);
  assert.equal(ez.restingLimit([order], intents).intent.id, "e:1345:BUY", "the order's own intent and zone");
  assert.equal(ez.restingLimit([{ ...order, source: "manual", magic: 0 }], []), null, "a manual order is not Omega's");
  assert.equal(ez.restingLimit([], intents.map((i) => ({ ...i, status: "done" }))), null, "a done intent without its order rests nowhere");
  // The page converts with the signal's own field, which it already receives; no new API field and no new read.
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /const feedBasis = knownFeedBasis\(s\);/);
  assert.match(omega, /const feedBid = brokerToFeed\(bid, feedBasis, digits\);\n\s+if \(!series \|\| feedBid == null \|\| candles\.length === 0\) return;/, "the bid painted into the last candle is converted, and not painted without a basis");
  assert.match(omega, /close: feedBid,/);
  assert.doesNotMatch(omega, /close: bid,/);
  for (const f of ["lib/entryZone.ts", "components/PlanLadder.tsx", "components/OmegaZone.tsx"]) assert.doesNotMatch(src(f), /\bfetch\(|usePoll|\bget\(|["'`]\/(omega\/)?api\//, `${f}: no read of its own`);
});

test("EZ1-3 the band's source: the engine's trade when the engine is on, else the strategy plan; low < high or nothing", () => {
  const engineOn = { engine: GLOBAL.engine, strategy: GLOBAL.global.strategy };
  const on = ez.bandSource(engineOn);
  assert.equal(on.source, "engine");
  assert.deepEqual(on.zone, { low: 2684.2, high: 2685.6 });
  assert.equal(on.side, "BUY");
  assert.equal(on.edge, true, "entry_zone_mode edge");
  // The engine on with no trade (WAIT): no band, even though the strategy plan has a zone.
  const wait = ez.bandSource({ engine: { ...GLOBAL.engine, trade: null }, strategy: GLOBAL.global.strategy });
  assert.equal(wait.source, "engine");
  assert.equal(wait.zone, null);
  // The engine off: the strategy plan's zone.
  const off = ez.bandSource({ engine: null, strategy: { ...GLOBAL.global.strategy, plan: { ...GLOBAL.global.strategy.plan, entry_low: 2684.3, entry_high: 2685.5 } } });
  assert.equal(off.source, "plan");
  assert.deepEqual(off.zone, { low: 2684.3, high: 2685.5 });
  assert.equal(off.side, "BUY");
  assert.equal(off.edge, false);
  // low < high is required (entryZoneOf, entryZoneFields, signalEntryZone): anything else is no zone.
  for (const p of [{ entry_low: 2684.9, entry_high: 2684.9 }, { entry_low: 2685.6, entry_high: 2684.2 }, { entry_low: 2684.2 }, { entry_low: "2684.2", entry_high: 2685.6 }, {}]) assert.equal(ez.zoneOf(p), null, JSON.stringify(p));
  assert.equal(ez.signalZoneOf({ entry_zone_low: 2684.2, entry_zone_high: 2684.2 }), null);
  assert.deepEqual(ez.signalZoneOf(OVERVIEW.signal), { low: 2684.2, high: 2685.6 });
  assert.equal(ez.nearEdge("BUY", { low: 2684.2, high: 2685.6 }), 2685.6);
  assert.equal(ez.nearEdge("SELL", { low: 2684.2, high: 2685.6 }), 2684.2);
  // The chart and the card read the same source.
  assert.match(src("components/PriceChart.tsx"), /const ez = showPlan && clear && mark\.show \? bandSource\(\{ engine, strategy \}\)\.zone : null;/);
  assert.match(src("components/GlobalDecision.tsx"), /const band = bandSource\(\{ engine: e, strategy: s \}\);/);
});

test("EZ1-4 times: UTC and GMT+7, the chart axes in GMT+7", () => {
  const ms = Date.parse("2026-11-19T14:00:00Z");
  assert.equal(ez.utcAndGmt7(ms), "14:00:00 UTC · 21:00 GMT+7");
  assert.equal(ez.gmt7ClockOf(ms + 7 * 60_000), "21:07");
  assert.equal(ez.utcAndGmt7(null), "—");
  assert.equal(ez.gmt7Tick(Date.parse("2026-11-18T17:00:00Z") / 1000, 2), "Thu 19", "midnight GMT+7");
  assert.equal(ez.gmt7Tick(Date.parse("2026-11-19T01:00:00Z") / 1000, 3), "08:00");
  for (const f of ["components/PriceChart.tsx", "pages/Omega.tsx"]) {
    assert.match(src(f), /tickMarkFormatter: \(t: Time, type: TickMarkType\) => gmt7Tick\(t, type\)/, f);
    assert.match(src(f), />GMT\+7<\/span>/, `${f}: the time axis' zone`);
  }
  // The price axis' scale: the War Room's tag; on Omega the chart's one caption (OM-TEXT: said once).
  assert.match(src("components/PriceChart.tsx"), />feed<\/span>/, "PriceChart: the price axis' scale");
  assert.match(src("pages/Omega.tsx"), /<span>\{chartScaleCaption\(feedBasis\)\}<\/span>/, "Omega: the scale in the caption");
});

test("EZ1-5 OmegaWhy: the five codes' wording, limit_in_zone and limit_zone_edge an amber adjust, the refusals a red why with NOT ENTERING", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const kinds = { limit_in_zone: "adjust", limit_zone_edge: "adjust", zone_passed: "block", zone_tight: "block", zone_rr: "block" };
  for (const [code, kind] of Object.entries(kinds)) {
    const r = u.omegaReason(code);
    assert.equal(r.kind, kind, code);
    assert.notEqual(r.text, code.replace(/_/g, " "), `${code} has its own text (before EZ1 it fell through to cyan info)`);
    const html = u.render(({ d }) => u.OmegaWhy({ codes: [code], sinceMs: Date.parse("2026-11-19T14:07:00Z"), details: d }), { [code]: u.EZ1_DETAILS[code] });
    clean(html);
    const t = textOf(html);
    if (kind === "adjust") {
      assert.ok(t.includes("READY / MANAGING") && !t.includes("NOT ENTERING"), code);
      assert.match(html, /class="chip [^"]*text-late[^"]*">adjust</, `${code}: an amber adjust chip`);
    } else {
      assert.match(html, /class="chip [^"]*text-late[^"]*">NOT ENTERING</, `${code}: the amber NOT ENTERING badge`);
      assert.match(html, /class="chip [^"]*text-fault[^"]*">why</, `${code}: a red why chip`);
    }
    assert.ok(t.includes("since 14:07 UTC · 21:07 GMT+7"), "UTC and GMT+7");
    for (const s of u.EZ1_CODE_SHOWS[code]) assert.ok(html.includes(s), `${code}: ${s}`);
  }
});

test("EZ1-6 render-check variants: zone with the engine on, the engine off (the plan's band), no zone fields, stale, each code", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["EZ1DecisionEngineOn", "EZ1DecisionStale", "EZ1DecisionEngineOff", "EZ1DecisionNoZone", "EZ1OmegaSignal", "EZ1OmegaSignalNoZone", ...Object.keys(u.EZ1_DETAILS).map((c) => `EZ1OmegaWhy_${c}`)]) assert.ok(names.includes(n), n);
  for (const v of u.VIEWS.filter((x) => x.name.startsWith("EZ1"))) {
    const html = u.render(v.View, v.fixture);
    clean(html);
    for (const s of v.shows ?? []) assert.ok(html.includes(s), `${v.name} shows ${s}`);
    for (const s of v.hides ?? []) assert.ok(!html.includes(s), `${v.name} hides ${s}`);
  }
  const view = (name) => u.VIEWS.find((v) => v.name === name);
  // Engine on: the zone (feed scale) as the card's item and the ladder's Entry row, the plan's level under it, EZ1 and
  // EZ1b at the near edge (the BUY's high, feed), and what the War Room does not read.
  const on = textOf(u.render(view("EZ1DecisionEngineOn").View, GLOBAL));
  assert.ok(on.includes("Entry zone 2684.20–2685.60 · feed scale"), on);
  assert.ok(on.includes("Entry 2684.20–2685.60 zone · feed scale plan 2684.90 · key zone 2683.60–2686.60 · pullback"), on);
  assert.ok(on.includes("rule EZ1 in the zone · EZ1b near edge 2685.60 feed · allowed"), on);
  assert.ok(on.includes("needs planner.codes · intents[].entry_zone, zone_from, entry_basis from GET /omega/api/overview Omega page"), on);
  // Engine off: the strategy plan's zone, and no EZ1b (the strategy plan carries no entry_zone_mode).
  const off = textOf(u.render(view("EZ1DecisionEngineOff").View, u.EZ1_ENGINE_OFF));
  assert.ok(off.includes("Entry zone 2684.30–2685.50 · feed scale") && !off.includes("EZ1b"), off);
  // No zone fields: nothing new (the reviewer's ruling 6): no Entry zone item, no Omega limit note, today's Entry row.
  const none = u.render(view("EZ1DecisionNoZone").View, u.EZ1_NO_ZONE);
  assert.ok(!/Entry zone|Omega limit|zone · feed scale/.test(none), "nothing new");
  assert.match(textOf(none), /Entry 2684\.90 zone 2683\.60–2686\.60 · pullback/, "today's Entry row");
  // A one-price zone renders as none.
  const one = u.render(view("EZ1DecisionNoZone").View, { ...GLOBAL, engine: { ...GLOBAL.engine, trade: { ...GLOBAL.engine.trade, entry_low: 2684.9, entry_high: 2684.9 } } });
  assert.ok(!/Entry zone|Omega limit/.test(one), "low = high is no zone");
  // Stale: the zone says so.
  assert.ok(textOf(u.render(view("EZ1DecisionStale").View, GLOBAL)).includes("2684.20–2685.60 · feed scale · stale 12m"));
});

test("EZ1-7 the Omega Signal card and intents: every price with its scale, entry_zone_edge a boolean, the basis on the page", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const rows = (s) => textOf(u.render(({ d }) => u.SignalRows({ s: d }), s));
  const t = rows(OVERVIEW.signal);
  for (const s of ["Entry 2684.900 · feed", "Entry zone 2684.200–2685.600 · feed", "Near edge on · EZ1b · entry_zone_edge", "Stop 2680.400 · feed", "Target 2691.600 · feed", "Basis +0.420 · broker − feed", "Issued 14:00:00 UTC · 21:00 GMT+7", "Expires 14:15:00 UTC · 21:15 GMT+7", "Feed price 2684.350 · 14:07 UTC · feed", "Blackout no", "Signal id OANDA:XAUUSD:15:"]) assert.ok(t.includes(s), `${s} in ${t}`);
  // entry_zone_edge is a boolean: only true is "on".
  for (const v of [false, "true", 1, null]) assert.ok(rows({ ...OVERVIEW.signal, entry_zone_edge: v }).includes("Near edge off"), String(v));
  // No zone fields: no zone row; the basis unknown: no basis row.
  const plain = rows(u.withoutZone(OVERVIEW).signal);
  assert.ok(!plain.includes("Entry zone") && !plain.includes("Near edge"));
  assert.ok(!rows({ ...OVERVIEW.signal, feed_basis: 0, feed_basis_known: false }).includes("Basis"));
  // The intents: the Entry, SL and TP columns say broker; the Entry cell how the limit came to rest and its zone.
  const omega = src("pages/Omega.tsx");
  for (const h of ["Entry · broker", "SL · broker", "TP · broker"]) assert.ok(omega.includes(`<th>${h}</th>`), h);
  const cell = (i) => textOf(u.render(({ d }) => u.IntentEntry({ i: d }), i));
  assert.equal(cell(OVERVIEW.broker.intents[0]), "2684.64 in zone · from 2685.32 zone 2684.62–2686.02");
  assert.equal(cell(OVERVIEW.broker.intents[1]), "2686.02 near edge · from 2685.32 zone 2684.62–2686.02");
  assert.equal(cell({ side: "BUY" }), "Market (Ask)");
  const cards = textOf(u.render(({ d }) => u.IntentCards({ intents: d }), OVERVIEW.broker.intents));
  assert.ok(cards.includes("place_limit BUY 0.10") && cards.includes("2684.64 broker · in zone · from 2685.32") && cards.includes("zone 2684.62–2686.02 · SL 2680.82 · TP 2692.02 · broker"), cards);
  // The chart: the zone, the limit and the bid and ask converted, each with its short label (OM-TEXT).
  assert.match(omega, /addLine\(feedBid, "", T\.bullFill, LineStyle\.Solid, 1, false\);/);
  assert.doesNotMatch(omega, /CHART_LABEL\.(bid|ask)/, "the bid and ask lines carry no text (the side panel shows them)");
  assert.match(omega, /addLine\(limitFeed, CHART_LABEL\.limit,/);
  assert.match(omega, /label: CHART_LABEL\.zone \}/);
  assert.match(omega, /<span>\{chartScaleCaption\(feedBasis\)\}<\/span>/);
});

test("EZ1-8 the War Room: the card, the ladder and the chart wired as the mockup; the meta line and the chart footer carry the scale", () => {
  const gd = src("components/GlobalDecision.tsx");
  assert.equal((gd.match(/<EntryZoneCell zone=\{band\.zone\} suffix=\{zoneSuffix\} \/>/g) ?? []).length, 2, "engine on and off");
  assert.match(gd, /zone=\{band\.zone\} suffix=\{zoneSuffix\} \/> : <p/, "the engine's ladder");
  assert.match(gd, /<OmegaLimitNote zone=\{band\.zone\} side=\{band\.side\} edge=\{band\.edge\} \/>/);
  assert.match(gd, /price \$\{e\.strategy\.price\.toFixed\(2\)\} feed/);
  assert.match(gd, / GMT\+7` : ""\} · decided in/);
  assert.doesNotMatch(gd, /function PlanLadder|function tradePlan/, "moved to components/PlanLadder.tsx");
  const pc = src("components/PriceChart.tsx");
  assert.match(pc, /TradingView closed bars · \$\{head\.basis \?\? "…"\} · feed scale/);
  assert.match(pc, /UTC · \{gmt7ClockOf\(Date\.parse\(head\.closed\)\)\} GMT\+7/);
  assert.match(pc, /label: narrow \? "Entry zone · feed" : `Entry zone \$\{zoneText\(ez\)\} · feed scale`/);
  // The render check knows the new views and the hides list.
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of ["conclusion-global.json", "omega-overview.json"]) assert.match(entry, new RegExp(`test/fixtures/nexus-ez1/${f.replace(".", "\\.")}`), f);
  assert.match(read("workers/xauusd-nexus-dashboard/ui/scripts/render-check.mjs"), /for \(const t of entry\.hides \?\? \[\]\) if \(html\.includes\(t\)\)/);
});

test("EZ1-9 the open positions on the Omega chart: entry, SL and TP converted as the bid and ask; broker prices without a basis", () => {
  const pos = { ticket: 50128, side: "BUY", volume: 0.1, open_price: 2686.02, sl: 2680.82, tp: 2692.02 };
  assert.deepEqual(ez.positionLines(pos, 0.42), [
    { kind: "entry", price: 2685.6, title: "BUY 0.10" },
    { kind: "sl", price: 2680.4, title: "SL" },
    { kind: "tp", price: 2691.6, title: "TP" }
  ]);
  assert.deepEqual(ez.positionLines({ ...pos, side: "SELL" }, -0.35).map((l) => [l.price, l.title]), [
    [2686.37, "SELL 0.10"], [2681.17, "SL"], [2692.37, "TP"]
  ], "a negative basis");
  // Without a basis (knownFeedBasis null): the broker's prices (the caption says so: chartScaleCaption(null)).
  const basis = ez.knownFeedBasis({ feed_basis: 0, feed_basis_known: false });
  assert.equal(basis, null);
  assert.deepEqual(ez.positionLines(pos, basis), [
    { kind: "entry", price: 2686.02, title: "BUY 0.10" },
    { kind: "sl", price: 2680.82, title: "SL" },
    { kind: "tp", price: 2692.02, title: "TP" }
  ]);
  // The entry from `entry` when open_price is missing; no SL or TP (0 or missing) draws no line; nothing for no position.
  assert.deepEqual(ez.positionLines({ ticket: 7, side: "SELL", volume: 0.25, entry: 2690.5, sl: 0 }, 0.42).map((l) => [l.price, l.title]), [[2690.08, "SELL 0.25"]]);
  assert.deepEqual(ez.positionLines(null, 0.42), []);
  assert.deepEqual(ez.positionLines({ ticket: 7, side: "BUY" }, 0.42), []);
  assert.equal(ez.positionLines({ ticket: 7, side: "BUY", volume: 0.1, open_price: 2686.021, sl: 2680 }, 0.42, 3)[0].price, 2685.601, "the symbol's digits");
  // No title carries a price or a scale, with or without a basis.
  for (const b of [0.42, null]) for (const l of ez.positionLines(pos, b)) assert.doesNotMatch(l.title, /\d{4}|broker|feed|#/);
  // The chart draws the positions only through positionLines, with the same basis as the bid and ask.
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /for \(const l of positionLines\(p, feedBasis, digits\)\)/);
  assert.doesNotMatch(omega, /addLine\(p\.(sl|tp)|addLine\(entryPrice/, "no raw broker position line left");
  assert.match(omega, /<span>\{chartScaleCaption\(feedBasis\)\}<\/span>/);
  // Every other line on that chart is the feed's (candles, PLAN lines, key zones, the last price) or converted and labelled.
  const lines = [...omega.matchAll(/addLine\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(lines.sort(), ["bid", "ask", "feedBid", "feedAsk", "l.price", "l.price", "limitFeed", "signal.entry", "signal.stop", "signal.tp1"].sort());
  assert.match(omega, /addLine\(bid, "", T\.bullFill, LineStyle\.Solid, 1\);/);
  assert.match(omega, /addLine\(ask, "", T\.bearFill, LineStyle\.Solid, 1\);/);
});
