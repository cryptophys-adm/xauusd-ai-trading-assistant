// The Nexus Opening range page (Track C4, "feat(nexus): Opening range", as the owner-approved mockup): its route and the
// final NAV order, its reads (GET only, one poll each, no arm control), its fixtures (the real routes' answers on the
// seeded environments of test/support/nexus-orb-seed.mjs, beside backend B14's contract orb.json), its render over each
// state, the ranges as boxes on the fixture candles, no plan line without a plan, the rules from code, the colours, a
// scale on every price, and the deploy smoke step, SSOT and the CHANGELOG.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ApiError } from "../workers/xauusd-nexus-dashboard/ui/src/lib/api.ts";
import { AGENT_RULES, PATTERN_BREAKER } from "../src/strategy-agents.mjs";
import { ORB_READING_BANDS } from "../src/opening-range.mjs";
import { MIN_CONFIDENCE } from "../src/decision-engine.mjs";
import { seedOrbPage } from "./support/nexus-orb-seed.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-intel/${f}`));
const ORB = fixture("orb.json"), OV = fixture("orb-overlap.json"), MM = fixture("orb-mismatch.json");
const OV_CANDLES = fixture("orb-overlap-candles.json"), OV_DECISION = fixture("orb-overlap-decision.json"), OV_AGENTS = fixture("orb-overlap-agents.json");
const CANDLES = fixture("orb-candles.json"), DECISION = fixture("orb-decision.json"), AGENTS = fixture("orb-agents.json");

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/intel"; export * from "./src/pages/Orb"; export { barsOf } from "./src/components/IntelChart"; export { boxLabelSpots } from "./src/lib/boxes-primitive"; export { render, merged, VIEWS, ORB_FORMING, ORB_CLOSED, ORB_OFF, ORB_BOTH_INVALIDATED, ORB_NO_BREAKOUT, ORB_RANGE_EVENT, ORB_TOO_NARROW, ORB_SHORT } from "./scripts/render-entry"; export { T } from "./src/lib/tokens";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
/** The page's static markup over the overlap scenario's reads unless given (render-entry's render). */
async function page(d, extra = {}) {
  const u = await ui();
  const props = { agents: OV_AGENTS, decision: OV_DECISION, candles: OV_CANDLES, ...extra };
  return u.render(({ d: body }) => u.OrbView({ d: body, ...props }), d);
}
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
/** The page's text, one text node per line (the tags removed). */
const textOf = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((t) => t.trim()).filter(Boolean);
const LIVE = { show: true, dim: false, suffix: "", note: null };
const sec = (iso) => Date.parse(iso) / 1000;

test("OR1 NAV and PAGES: Opening range at /#/orb, key orb, icon Sunrise; the final Intelligence order", () => {
  const shell = src("components/AppShell.tsx");
  const intel = shell.slice(shell.indexOf('{ title: "Intelligence"'), shell.indexOf('{ title: "Settings"'));
  assert.deepEqual([...intel.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]),
    ["Aether", "Model & Learning", "Strategy agents", "Opening range", "Chart patterns", "Liquidity", "Zones", "Neuron allocation", "Decision audit", "Alerts"]);
  assert.match(intel, /\{ label: "Opening range", href: "\/#\/orb", key: "orb", icon: Sunrise \}/);
  assert.match(shell, /import \{[^}]*\bSunrise\b[^}]*\} from "lucide-react";/);
  const app = src("App.tsx");
  assert.match(app, /import Orb from "\.\/pages\/Orb";/);
  assert.match(app, /strategy: Strategy, orb: Orb, patterns: Patterns, liquidity: Liquidity,/);
});

test("OR2 GET only, from the page's allow-list: four reads, one poll each; no arm control", async () => {
  const intel = src("lib/intel.ts");
  assert.match(intel, /orb: \{ path: "\/api\/orb", everyMs: 60_000, chart: false \}/);
  assert.match(intel, /agents: \{ path: "\/api\/strategy-agents", everyMs: 120_000, chart: false \}/);
  assert.match(intel, /decision: \{ path: "\/api\/engine\/decision", everyMs: 60_000, chart: false \}/);
  assert.match(intel, /candles: \{ path: "\/api\/ohlcv\?timeframe=M15&limit=200", everyMs: 60_000, chart: true \}/);
  const pg = src("pages/Orb.tsx");
  const polls = [...pg.matchAll(/usePoll\(\(\) => intelGet\(R, "(\w+)"\), R\.(\w+)\.everyMs\)/g)];
  assert.deepEqual(polls.map((m) => m[1]), ["orb", "agents", "decision", "candles"]);
  for (const m of polls) assert.equal(m[1], m[2], "each poll at its own read's cadence");
  assert.equal((pg.match(/usePoll\(/g) ?? []).length, 4, "no other poll");
  for (const f of ["pages/Orb.tsx", "lib/boxes-primitive.ts"]) assert.doesNotMatch(src(f), /\bfetch\(|ownerPost|omegaJson|method:|"POST"|"PUT"|"DELETE"|"PATCH"/, `${f}: GET only`);
  assert.doesNotMatch(pg, /(?<![.\w])get\(/, "the page reads only through intelGet");
  assert.doesNotMatch(pg, /<button|Disarm|"Arm"|onClick/, "no arm control: arming stays on Strategy agents");
  if (NO_UI_DEPS) return;
  const u = await ui();
  assert.deepEqual(u.allowedPaths(u.ORB_READS), ["/api/orb", "/api/strategy-agents", "/api/engine/decision", "/api/ohlcv?timeframe=M15&limit=200"]);
  await assert.rejects(u.intelGet(u.ORB_READS, "lens"), /not allowed: lens/);
});

test("OR3 the fixtures are the real routes' answers on the seed, byte for byte; orb.json is B14's contract scenario", async () => {
  const { contractView, files } = await seedOrbPage();
  assert.deepEqual(contractView, ORB, "orb.json: the contract scenario's GET /api/orb");
  for (const [name, body] of Object.entries(files)) assert.deepEqual(fixture(name), body, `${name}: regenerate with \`node test/support/nexus-orb-seed.mjs --write\``);
  assert.equal(OV.schema, "cryptophys.orb-view.v1");
  assert.equal(OV.scale.prices, "feed");
  // The mockup's hour: both windows live, New York holds the long side, its plan a limit at its high, picked and armed.
  assert.deepEqual([OV.sessions.london.phase, OV.sessions.new_york.phase, OV.overlap.long], ["live", "live", "new_york"]);
  assert.deepEqual([OV.sessions.london.breakout.state, OV.sessions.london.invalidated.long, OV.sessions.new_york.breakout.state], ["invalidated", true, "held"]);
  assert.deepEqual([OV.sessions.new_york.plans.long.entry_type, OV.sessions.new_york.plans.long.entry, OV.sessions.new_york.plans.long.picked], ["limit", OV.sessions.new_york.high, true]);
  assert.deepEqual(OV_DECISION.decision.armed.ids, ["orb_breakout"]);
  assert.equal(OV_DECISION.decision.selection.agent, "orb_breakout");
  // Every exit the control arm records, once at least, in the recent setups.
  assert.deepEqual([...new Set(OV.recent.map((x) => x.exit ?? x.status))].sort(), ["invalidated", "lapse", "open", "stop", "target", "target_before_entry", "time", "unfilled"]);
  assert.deepEqual([MM.sessions.london.status, MM.sessions.london.date_ny], ["session_clock_mismatch", "2026-03-16"]);
  // The candles are the market-data Worker's answer on the same bars (readChartCandles).
  assert.equal(OV_CANDLES.timeframe, "M15");
  assert.equal(CANDLES.latest_close_time, ORB.bar_close);
  assert.equal(OV_CANDLES.latest_close_time, OV.bar_close);
});

test("OR4 the page renders over each fixture, each top-level key nulled and each array emptied; every state is in the render check", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const panels = ["Sessions", "Ranges on the chart", "Records per session", "Recent sessions", "Where it counted"];
  for (const [d, extra] of [[OV, {}], [ORB, { agents: AGENTS, decision: DECISION, candles: CANDLES }], [MM, { decision: null, candles: null }]]) {
    const html = await page(d, extra);
    clean(html);
    for (const t of panels) assert.ok(html.includes(t), t);
    for (const k of Object.keys(d)) {
      clean(await page({ ...d, [k]: null }, extra));
      if (Array.isArray(d[k])) clean(await page({ ...d, [k]: [] }, extra));
    }
    for (const k of ["london", "new_york"]) for (const f of Object.keys(d.sessions[k])) clean(await page(u.merged(d, { sessions: { [k]: { [f]: null } } }), extra));
  }
  clean(await page(OV, { agents: null, decision: null, candles: null }));
  clean(await page(OV, { agents: { status: "error" }, decision: { error: "Not found" }, candles: { error: "no_data_yet" } }));
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["OrbView", "OrbViewOverlap", "OrbViewMismatch", "OrbViewForming", "OrbViewMarketClosed", "OrbViewModeOff", "OrbViewBothInvalidated", "OrbViewNoBreakout", "OrbViewRangeEvent", "OrbViewTooNarrow", "OrbViewShort",
    "OrbViewNotArmed", "OrbViewAuto", "OrbViewAgents", "OrbViewCandles", "OrbViewStale", "OrbViewIntelOff", "OrbUnread500", "OrbUnread404"]) assert.ok(names.includes(n), n);
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of ["orb.json", "orb-candles.json", "orb-decision.json", "orb-agents.json", "orb-overlap.json", "orb-overlap-candles.json", "orb-overlap-decision.json", "orb-overlap-agents.json", "orb-mismatch.json"]) {
    assert.match(entry, new RegExp(`test/fixtures/nexus-intel/${f.replace(/\./g, "\\.")}`), f);
  }
  // The mockup's "sample data" chip and its "provisional" notes labelled invented values: the page shows none.
  const html = await page(OV);
  assert.ok(!html.includes("sample data") && !html.includes("provisional") && !html.includes("not built"));
});

test("OR5 the sessions in words: the 2026-03-16 London clock mismatch, the range event's release time, the phases, the breakouts", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(u.statusWord(MM.sessions.london), "clock mismatch (New York on summer time, London not)");
  const mm = await page(MM, { decision: null, candles: null });
  assert.ok(mm.includes("clock mismatch (New York on summer time, London not)") && mm.includes("not traded: clock mismatch"));
  assert.ok(mm.includes(`title="${MM.sessions.london.status_detail}"`), "the code's own words in the ⓘ");
  assert.ok(mm.includes("07:00–07:45 UTC · 14:00–14:45 GMT+7"), "London at 03:00 New York is 07:00 UTC that week");
  assert.equal(u.statusWord(ORB.sessions.new_york), "range event (high-impact USD 08:30 NY)", "Retail sales at 13:30 UTC");
  const range = await page(ORB, { agents: AGENTS, decision: DECISION, candles: CANDLES });
  assert.ok(range.includes("range event (high-impact USD 08:30 NY)") && range.includes("not traded: an event inside the range"));
  assert.deepEqual([u.phaseText(ORB, u.ORB_FORMING.sessions.london), u.phaseText(ORB, OV.sessions.london), u.phaseText(ORB, MM.sessions.london)], ["building 2 of 3 bars", "window · 7 bars left", "ended"]);
  const ov = await page(OV);
  for (const t of ["03:00–03:45 NY", "08:00–08:45 UTC · 15:00–15:45 GMT+7", "13:00–13:45 UTC · 20:00–20:45 GMT+7", "21 bars ago", "1 bar ago", "Overlap 08:00–11:45 NY", "New York holds the long side", "holds the side", "no ▼ breakout", "limit at the edge", "16:45 NY"]) assert.ok(ov.includes(t), t);
  assert.ok(ov.includes('<span class="text-off">▲ long</span> invalidated · no plan'), "an invalidated side is off grey");
  assert.ok((await page(u.ORB_BOTH_INVALIDATED)).includes('<span class="text-off">▼ short</span> invalidated · no plan'));
  const nb = await page(u.ORB_NO_BREAKOUT);
  assert.ok(nb.includes("none by 11:45 NY") && nb.includes("no plan: no breakout"));
  const forming = await page(u.ORB_FORMING, { agents: AGENTS, decision: DECISION, candles: CANDLES });
  assert.ok(forming.includes("No ORB setup yet") && forming.includes("London&#x27;s range is building; New York&#x27;s sets at 08:45 NY (13:45 UTC).") && forming.includes("no plan until the range sets at 03:45 NY"));
  const narrow = await page(u.ORB_TOO_NARROW);
  assert.ok(narrow.includes("too narrow") && narrow.includes("not traded: the range is too narrow"));
  const short = await page(u.ORB_SHORT);
  assert.ok(short.includes('<span class="text-bear">▼ down</span>') && short.includes("New York holds the short side") && short.includes("at price"));
});

test("OR6 the ranges as boxes on the fixture candles: 2026-11-23 London 08:00-08:45 UTC and New York 13:00-13:45 UTC", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const bars = u.barsOf(OV_CANDLES);
  assert.equal(bars.length, OV_CANDLES.candles.length);
  const boxes = u.orbBoxes(OV, bars, LIVE);
  assert.deepEqual(boxes.map((b) => [b.from, b.to, b.high, b.low, b.mid]), [
    [sec("2026-11-23T08:00:00Z"), sec("2026-11-23T08:30:00Z"), OV.sessions.london.high, OV.sessions.london.low, OV.sessions.london.mid],
    [sec("2026-11-23T13:00:00Z"), sec("2026-11-23T13:30:00Z"), OV.sessions.new_york.high, OV.sessions.new_york.low, OV.sessions.new_york.mid]
  ]);
  for (const b of boxes) assert.ok(bars.some((x) => x.time === b.from) && bars.some((x) => x.time === b.to), "each box on the candles");
  // Both windows end after the last candle: the edges run to it, the label carries the window's end.
  assert.deepEqual(boxes.map((b) => [b.until, b.label]), [[bars.at(-1).time, "London · to 11:45 NY"], [bars.at(-1).time, "New York · to 16:45 NY"]]);
  // The broken edge in its breakout colour: New York's high green; London's invalidated, grey.
  assert.deepEqual(boxes.map((b) => [b.broken, b.brokenColor]), [["high", u.T.offFill], ["high", u.T.bullFill]]);
  const markers = u.orbMarkers(OV, bars, LIVE);
  assert.deepEqual(markers.map((m) => [m.time, m.color, m.shape]), [[OV.sessions.london.breakout.bar_ms / 1000, u.T.offFill, "circle"], [OV.sessions.new_york.breakout.bar_ms / 1000, u.T.bullFill, "circle"]]);
  // B14's contract: London's box on Tuesday 24 Nov, its window ending after the last candle; New York's range event has none.
  const cb = u.orbBoxes(ORB, u.barsOf(CANDLES), LIVE);
  assert.deepEqual(cb.map((b) => [b.from, b.high, b.low, b.label]), [[sec("2026-11-24T08:00:00Z"), 2605, 2595, "London · to 11:45 NY"]]);
  // A window over before the last candle: its edges stop at its own last bar.
  const over = u.merged(OV, { sessions: { london: { end_ms: Date.parse("2026-11-23T12:00:00Z") } } });
  assert.equal(u.orbBoxes(over, bars, LIVE)[0].until, sec("2026-11-23T11:45:00Z"));
  // Off the candles: no box. Stale: dimmed and suffixed; past 2 hours: none.
  assert.deepEqual(u.orbBoxes(OV, bars.filter((b) => b.time > sec("2026-11-23T12:00:00Z")), LIVE).map((b) => b.label), ["New York · to 16:45 NY"]);
  assert.ok(u.orbBoxes(OV, bars, { show: true, dim: true, suffix: " · stale 7m", note: null }).every((b) => b.alpha < 0.5 && b.label.endsWith(" · stale 7m")));
  assert.deepEqual(u.orbBoxes(OV, bars, { show: false, dim: true, suffix: "", note: null }), []);
  assert.deepEqual(u.orbBoxes(MM, bars, LIVE), [], "no box without a formed range on the candles");
  // The label's spots: beside the box first, then above it, then below.
  assert.deepEqual(u.boxLabelSpots(100, 140, 50, 80, 30, 10)[0], { x: 64, y: 59 });
  // IntelChart: boxes only by opt-in (the other pages pass none), drawn behind the candles, their labels above.
  const chart = src("components/IntelChart.tsx");
  assert.match(chart, /boxes = NO_BOXES,/);
  assert.match(chart, /boxesPrim\.current\?\.setBoxes\(boxes\)/);
  for (const f of ["pages/Liquidity.tsx", "pages/Patterns.tsx"]) assert.doesNotMatch(src(f), /\bboxes=\{/, `${f}: no boxes`);
  assert.match(src("pages/Orb.tsx"), /<IntelChart poll=\{poll\} bars=\{bars\} zones=\{NO_ZONES\} boxes=\{boxes\} markers=\{markers\} plan=\{plan\}/);
  const prim = src("lib/boxes-primitive.ts");
  assert.match(prim, /zOrder\(\) \{ return this\.labels \? \("top" as const\) : \("bottom" as const\); \}/);
  assert.match(prim, /const OUTLINE = T\.fg2;\nconst FILL = T\.track;/, "the fg-2 outline on the track fill");
});

test("OR7 no plan line without a plan; the plan's lines are the picked plan's, each with its tag", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(u.orbPlanLines(MM, LIVE), [], "the mismatch day: no plan, no line");
  assert.deepEqual(u.orbPlanLines(u.ORB_BOTH_INVALIDATED, LIVE), []);
  assert.deepEqual(u.orbPlanLines(u.ORB_FORMING, LIVE), []);
  const p = OV.sessions.new_york.plans.long;
  const lines = u.orbPlanLines(OV, LIVE);
  assert.deepEqual(lines.map((l) => [l.label, l.p0]), [["Entry", p.entry], ["Stop", p.stop], ["TP1", p.tp1], ["TP2", p.tp2]]);
  assert.deepEqual(lines.map((l) => l.color), [u.T.okFill, u.T.bearFill, u.T.bullFill, u.T.bullFill]);
  assert.deepEqual(u.chartPlan(ORB).k, "london", "the contract's picked plan");
  assert.ok(u.orbPlanLines(OV, { show: true, dim: true, suffix: " · stale 7m", note: null }).every((l) => l.alpha < 0.5 && l.label.endsWith(" · stale 7m")));
  assert.deepEqual(u.orbPlanLines(OV, { show: false, dim: true, suffix: "", note: null }), []);
  // The legend lists the plan's lines only with a plan.
  const none = await page(MM, { candles: OV_CANDLES });
  assert.ok(none.includes("Ranges on the chart") && !/>Entry<|>TP1<|>TP2</.test(none));
  assert.ok(/>Entry<\/span>.*>Stop<\/span>.*>TP1<\/span>.*>TP2<\/span>/s.test(await page(OV)));
});

test("OR8 the states: mode off, market closed, intel_views_off, 500 and 404 with the code, armed, not armed, auto", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const off = await page(u.ORB_OFF, { agents: AGENTS, decision: DECISION, candles: CANDLES });
  assert.ok(off.includes("Opening range off") && off.includes("Switched off by the owner: no range is read and the ORB agent makes no plan.") && off.includes("ORB off") && off.includes("ORB levels off"));
  assert.ok(!off.includes("Ranges on the chart") && !off.includes(">Sessions<"), "no sessions or chart while off");
  const closed = await page(u.ORB_CLOSED, { agents: AGENTS, decision: DECISION, candles: CANDLES });
  assert.ok(closed.includes("Market closed") && closed.includes("The London range sets Monday 03:45 New York (08:45 UTC, 15:45 GMT+7).") && closed.includes(">market closed<"));
  assert.equal(u.nextRangeText(u.merged(ORB, { market: { next_range: null } })), "The next range sets when gold reopens.");
  const views = await page({ status: "not_found", reason: "intel_views_off" });
  assert.ok(views.includes("intel_views_off") && views.includes("The Intelligence views are off on the AI Worker."));
  assert.equal(new ApiError("/api/orb", 500, "orb_unavailable").message, "/api/orb 500 orb_unavailable");
  for (const name of ["OrbUnread500", "OrbUnread404"]) {
    const e = u.VIEWS.find((v) => v.name === name);
    const html = u.render(e.View, e.fixture);
    assert.ok(html.includes(e.shows[0]) && html.includes("Retry now"), name);
  }
  assert.match(src("pages/Orb.tsx"), /if \(orb\.data == null\) return <OrbUnread poll=\{orb\} \/>;/);
  // The arm from armed.ids: armed (ok), not armed (another armed), auto (none armed), nothing without a decision.
  assert.equal(u.armOf(OV_DECISION), "armed");
  assert.equal(u.armOf(u.merged(OV_DECISION, { decision: { armed: { ids: ["zone_pullback"] } } })), "not armed");
  assert.equal(u.armOf(u.merged(OV_DECISION, { decision: { armed: { ids: [] } } })), "auto");
  assert.equal(u.armOf(DECISION), null, "B14's decision record carries no arm");
  const ov = await page(OV);
  assert.match(ov, /class="chip [^"]*text-ok">armed</);
  assert.match(ov, /class="chip [^"]*text-ok">live</, "the agent's status from /api/strategy-agents");
  const notArmed = await page(OV, { decision: u.merged(OV_DECISION, { decision: { armed: { ids: ["zone_pullback"] } } }) });
  assert.ok(notArmed.includes("not armed: plans are recorded, not traded") && !/>armed</.test(notArmed));
});

test("OR9 the rules from code: the width band and the breakout bands, the confidence floor, the breaker; the candidates and the edges", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual({ ...u.ORB_RULES }, { range_bars: AGENT_RULES.orb.range_bars, min_width_atr: AGENT_RULES.orb.min_width_atr, max_width_atr: AGENT_RULES.orb.max_width_atr, beyond_atr: ORB_READING_BANDS.beyond_atr, retest_atr: ORB_READING_BANDS.retest_atr });
  assert.deepEqual(u.ORB_RULES.min_width_atr <= u.ORB_RULES.max_width_atr && u.ORB_RULES.max_width_atr < u.GAUGE_MAX_ATR, true, "the band inside the gauge");
  assert.equal(u.MIN_CONFIDENCE, MIN_CONFIDENCE);
  assert.equal(u.PATTERN_BREAKER_MIN, PATTERN_BREAKER.min_setups);
  const ov = await page(OV);
  // The selection: the opening range named with its session, chosen; the agent under the floor says so.
  const sel = ov.slice(ov.indexOf(">Selection<"), ov.indexOf(">Edges in key zones<"));
  for (const t of ["Opening range · New York", "Zone pullback", "Triangles, wedges and rectangles", "62%", "58%", "38%", "0.47", "0.29", "2.8", "1.6", ">chosen<", "under 40%"]) assert.ok(sel.includes(t), t);
  assert.equal((sel.match(/>chosen</g) ?? []).length, 2, "once per layout (desktop and phone tables)");
  // The edges in key zones: London's high and New York's low on the feed scale, each with its zone.
  assert.deepEqual(u.edgeRows(OV).map((x) => [x.k, x.edge, x.price, x.z.low, x.z.high, x.z.candidate]), [["london", "high", 4097.52, 4097.2, 4097.9, false], ["new_york", "low", 4095.28, 4095, 4095.6, true]]);
  for (const t of ["London high", "New York low", "4,097.52", "4,097.20–4,097.90", "4,095.00–4,095.60", "candidate", "▲ support"]) assert.ok(ov.includes(t), t);
  // session_range from /api/orb's own decision (Track A PR 9): no price in it.
  assert.ok(ov.includes(">session_range<") && ov.includes("3 bars") && ov.includes("1.48 ATR") && ov.includes("27 bars left"));
  assert.ok(!JSON.stringify(OV.decision.session_range).match(/\d{4}\.\d/), "the reading carries no price");
  assert.ok((await page(MM, { decision: null })).includes("No session range in the latest decision"));
  // The records: per session from /api/orb, the breaker's hold from held_by_breaker.
  const rec = await page(ORB, { agents: AGENTS, decision: DECISION, candles: CANDLES });
  assert.ok(rec.includes(">held back<") && rec.includes("−0.20R") && rec.includes("+0.30R") && rec.includes("50%") && rec.includes("100%"));
});

test("OR10 colours from tokens.ts only: no hex, no emerald or rose; direction only on a side; rates, outcomes and R neutral", async () => {
  for (const f of ["pages/Orb.tsx", "lib/boxes-primitive.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i, `${f}: no hex colour`);
    assert.doesNotMatch(s, /\b(?:emerald|rose|green|red)-\d/, `${f}: no Tailwind palette colour`);
  }
  const s = src("pages/Orb.tsx");
  for (const l of s.split("\n").filter((x) => /text-bull|T\.bull\b|T\.bullFill|bg-bull/.test(x))) assert.match(l, /long|▲|tp1|tp2|TP1|TP2|support|SIDE_|bull/, `green only for a long side, its targets or support: ${l.trim().slice(0, 120)}`);
  for (const f of ["function RecordsPanel", "function RecentPanel", "function SelectionBlock"]) {
    const body = s.slice(s.indexOf(f), s.indexOf("\n}\n", s.indexOf(f)));
    assert.doesNotMatch(body.replace(/SIDE_TEXT\[s\]/g, ""), /text-bull|text-bear|T\.bull|T\.bear/, `${f}: no direction colour on a rate, an outcome or R`);
  }
  assert.match(s, /export const STATUS_TONE: Record<string, Tone> = \{\n  ok: "ok", not_formed: "plain", range_event: "late", session_clock_mismatch: "late", range_incomplete: "late",\n  too_narrow: "off", too_wide: "off", window_over: "off", market_paused: "off"\n\};/);
  if (NO_UI_DEPS) return;
  const html = await page(OV);
  const recent = html.slice(html.indexOf(">Recent sessions<"), html.indexOf(">Where it counted<"));
  for (const r of ["+1.1R", "−1.0R", "+0.6R"]) assert.ok(recent.includes(`>${r}<`), r);
  assert.doesNotMatch(recent, /text-(bull|bear)">[+−]/, "R is plain text");
  assert.doesNotMatch(html, /\bstyle="[^"]*color/, "no colour in a style attribute");
});

test("OR11 every price carries its scale (the feed's); every time is New York's with UTC and GMT+7", { skip: NO_UI_DEPS }, async () => {
  const PRICE = /\d,\d{3}\.\d{2}/;
  for (const [d, extra] of [[OV, {}], [ORB, { agents: AGENTS, decision: DECISION, candles: CANDLES }]]) {
    const html = await page(d, extra);
    // Each panel that shows a price names the feed scale in its header (a chip) or its chart's axis caption.
    for (const panel of html.split("<section").slice(1).filter((p) => PRICE.test(p.replace(/aria-label="[^"]*"/g, "")))) {
      const head = panel.slice(0, panel.indexOf("</h2>") + 600);
      assert.ok(/feed scale/.test(head) || panel.includes(">feed</span><span class=\"block\">scale<"), `a price panel without its scale: ${textOf(panel)[0]}`);
    }
  }
  assert.match(src("components/IntelChart.tsx"), /caption = "feed scale"/, "the chart's axis caption");
  const html = await page(OV);
  assert.ok(html.includes("feed scale · ATR (1H) 2.19"));
  assert.ok(html.includes("decision 15:00 UTC · 22:00 GMT+7"));
  assert.ok(html.includes("last closed bar Mon 23 Nov 15:00 UTC · 22:00 GMT+7"));
  // Each session time: New York first, then UTC and GMT+7 (the window's end too).
  for (const t of ["11:45 NY", "16:45 UTC · 23:45 GMT+7", "16:45 NY", "21:45 UTC · 04:45 GMT+7"]) assert.ok(html.includes(t), t);
});

test("OR12 the deploy smoke step; SSOT and the CHANGELOG", () => {
  const wf = read(".github/workflows/deploy-nexus-dashboard.yml");
  const at = wf.indexOf("- name: Smoke test the Opening range view");
  assert.ok(at > wf.indexOf("- name: Smoke test the Zones view"), "after the other Intelligence views");
  const step = wf.slice(at, wf.indexOf("NODE\n", wf.indexOf("node --input-type=module", at)) + 5);
  assert.match(step, /https:\/\/nexus\.cryptophys\.work\/api\/orb/);
  assert.match(step, /isAccessLogin\(bare\)/, "the Access redirect without the token");
  assert.match(step, /headers: token\.headers/, "under the CI token");
  assert.match(step, /r\.status !== 200/);
  assert.match(step, /\\bjson\\b/);
  assert.match(step, /no-store/);
  assert.ok(step.includes(`body?.schema !== "${ORB.schema}"`), "the fixture's schema");
  assert.match(step, /body\?\.scale\?\.prices !== "feed"/);
  assert.match(step, /r\?\.status === 404 && body\?\.status === "not_found" && body\?\.reason === "intel_views_off"/, "INTEL_VIEWS off is the page's off state, a pass");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /Opening range \(`#\/orb`, Track C4, directly after Strategy agents/);
  assert.match(ssot, /The Nexus Opening range page \(`#\/orb`, Track C4\) reads it\./);
  const log = read("docs/CHANGELOG.md");
  const i = log.indexOf("feat(nexus): the Opening range page in Intelligence (Track C4)");
  assert.ok(i > log.indexOf("## 2026-11-26") && i < log.indexOf("## 2026-11-25"));
});
