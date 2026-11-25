// The Nexus Chart patterns page (Track C3, "feat(nexus): Chart patterns", as the owner-approved mockup): its route, its
// reads (GET only, one poll each, no /api/ohlcv or /api/engine/decision: the candles are the view's own bars and
// "armed" its decision.trade_agent), its render over backend B9's contract (test/fixtures/nexus-intel/chart-patterns.json),
// the not-yet states of the fields a later backend PR fills, "TP2" only on a plan's own tp2, the plan's lines only on its
// own chart through IntelChart's opt-in, a plan's notes from its family's rule (src/strategy-agents.mjs), the close
// times snapped to their candles, a scale on every price and the states the mockup draws.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ApiError } from "../workers/xauusd-nexus-dashboard/ui/src/lib/api.ts";
import { AGENT_RULES, PATTERN_BREAKER, PATTERN_FAMILIES, agentCatalog, agentStatuses } from "../src/strategy-agents.mjs";
import { ALLOCATION_RULES } from "../src/agent-allocation.mjs";
import { CALIBRATION } from "../src/pattern-calibration.mjs";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const fixture = (f) => JSON.parse(read(`test/fixtures/nexus-intel/${f}`));
const CP = fixture("chart-patterns.json"), AGENTS = fixture("strategy-agents.json"), ALLOC = fixture("neuron-allocation.json");

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export * from "./src/lib/intel"; export * from "./src/lib/patternRules"; export * from "./src/pages/Patterns"; export { render, merged, PATTERNS_NOW, PATTERNS_LATER, PATTERNS_FULL, PATTERNS_NO_PLAN, PATTERNS_OFF, VIEWS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
/** The page's static markup with the bundle's own React (render-entry's render). */
async function page(d, extra = {}) {
  const u = await ui();
  const props = { agents: AGENTS, alloc: ALLOC, now: u.PATTERNS_NOW, ...extra };
  return u.render(({ d: body }) => u.PatternsView({ d: body, ...props }), d);
}
const clean = (html) => assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/);
/** The page's text, one text node per line (the tags removed). */
const textOf = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((t) => t.trim()).filter(Boolean);
const LIVE = { show: true, dim: false, suffix: "", note: null };

test("CP1 NAV and PAGES: Chart patterns at /#/patterns, key patterns, icon Shapes, between Strategy agents and Liquidity", () => {
  const shell = src("components/AppShell.tsx");
  const intel = shell.slice(shell.indexOf('{ title: "Intelligence"'), shell.indexOf('{ title: "Settings"'));
  const labels = [...intel.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels.slice(2, 5), ["Strategy agents", "Chart patterns", "Liquidity"]);
  assert.match(intel, /\{ label: "Chart patterns", href: "\/#\/patterns", key: "patterns", icon: Shapes \}/);
  assert.match(shell, /import \{[^}]*\bShapes\b[^}]*\} from "lucide-react";/);
  const app = src("App.tsx");
  assert.match(app, /import Patterns from "\.\/pages\/Patterns";/);
  assert.match(app, /strategy: Strategy, patterns: Patterns, liquidity: Liquidity,/);
});

test("CP2 GET only, from the page's allow-list: three reads, one poll each; no /api/ohlcv or /api/engine/decision read", async () => {
  const intel = src("lib/intel.ts");
  assert.match(intel, /patterns: \{ path: "\/api\/chart-patterns", everyMs: 120_000, chart: false \}/);
  assert.match(intel, /agents: \{ path: "\/api\/strategy-agents", everyMs: 120_000, chart: false \}/);
  assert.match(intel, /seat: \{ path: "\/api\/neuron-allocation", everyMs: 300_000, chart: false \}/);
  const pg = src("pages/Patterns.tsx");
  const polls = [...pg.matchAll(/usePoll\(\(\) => intelGet\(R, "(\w+)"\), R\.(\w+)\.everyMs\)/g)];
  assert.deepEqual(polls.map((m) => m[1]), ["patterns", "agents", "seat"]);
  for (const m of polls) assert.equal(m[1], m[2], "each poll at its own read's cadence");
  assert.equal((pg.match(/usePoll\(/g) ?? []).length, 3, "no other poll");
  assert.doesNotMatch(pg, /\/api\/ohlcv|\/api\/engine\/decision|barsOf\(/, "the candles and armed come from the view (owner ruling)");
  for (const f of ["pages/Patterns.tsx", "lib/lines-primitive.ts", "lib/patternRules.ts"]) {
    assert.doesNotMatch(src(f), /\bfetch\(|ownerPost|omegaJson|method:|"POST"|"PUT"|"DELETE"|"PATCH"/, `${f}: GET only`);
  }
  assert.doesNotMatch(pg, /(?<![.\w])get\(/, "the page reads only through intelGet");
  // The captions name the real routes.
  assert.ok(pg.includes("From /api/strategy-agents.") && pg.includes("seat from /api/neuron-allocation") && pg.includes("Hit rate from /api/chart-patterns"));
  if (NO_UI_DEPS) return;
  const u = await ui();
  assert.deepEqual(u.allowedPaths(u.CHART_PATTERNS_READS), ["/api/chart-patterns", "/api/strategy-agents", "/api/neuron-allocation"]);
  await assert.rejects(u.intelGet(u.CHART_PATTERNS_READS, "ohlcv"), /not allowed: ohlcv/);
});

test("CP3 the page renders over B9's contract on each tab, each top-level key nulled and each array emptied", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(CP.schema, "cryptophys.chart-patterns-view.v1");
  for (const tf of ["15", "60", "240", "D"]) {
    const html = await page(CP, { tf });
    clean(html);
    for (const t of ["Lines on the chart", "Patterns on this chart", "Measured targets, every chart", "Measured record per chart", "Projection seat", "Pattern agents"]) assert.ok(html.includes(t), `${tf}: ${t}`);
  }
  for (const k of Object.keys(CP)) {
    clean(await page({ ...CP, [k]: null }));
    if (Array.isArray(CP[k])) clean(await page({ ...CP, [k]: [] }));
  }
  for (const k of Object.keys(CP.decision)) clean(await page(u.merged(CP, { decision: { [k]: null } })));
  for (const k of Object.keys(CP.patterns[1].plan)) clean(await page(u.merged(CP, { patterns: CP.patterns.map((p) => (p.plan ? { ...p, plan: { ...p.plan, [k]: null } } : p)) })));
  clean(await page(CP, { agents: null, alloc: null }));
  clean(await page(CP, { agents: { status: "error" }, alloc: { error: "Not found" } }));
  // The heading: the view's own values on the feed scale; the decision's time in UTC and local.
  const html = await page(CP);
  for (const t of ["patterns on", "calibration auto", "calibrated 22m ago", "price 4,100.00 · feed scale", "ATR (1H) 2.19", "decision 15:00 UTC"]) assert.ok(html.includes(t), t);
  // OM-LEAN: one scale per row of chips (the price's), no heading chip repeating the market-closed panel, no "· hourly"
  // beside the record panel's "replayed hourly", no "no horizon yet" chip beside the horizon Empties, no "reach: later
  // PR" on each plan row beside the "No plan reach yet" Empty, and the chart's scale once (its axis caption).
  assert.ok(!html.includes("ATR (1H) 2.19 · feed scale") && !html.includes("ago · hourly") && !html.includes("no horizon yet") && !html.includes("reach: later PR"));
  assert.ok(html.includes("No plan reach yet") && html.includes("No horizon yet") && html.includes("replayed hourly"));
  assert.equal((html.match(/Prices on the feed scale/g) ?? []).length, 1, "the patterns' note only; no legend phrase");
  assert.match(src("components/IntelChart.tsx"), /caption = "feed scale"/, "the axis caption keeps the scale");
  // The mockup's "sample data" chip labelled invented values: the page shows none.
  assert.ok(!html.includes("sample data"));
  // A registry entry for each state in the render check.
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["PatternsView", "PatternsView1H", "PatternsView4H", "PatternsViewDaily", "PatternsViewLater", "PatternsViewModeOff", "PatternsViewNoPlan", "PatternsViewNoEntryZone", "PatternsViewCalibrationOff", "PatternsViewNoCalibration", "PatternsViewNoCandles", "PatternsViewMarketClosed", "PatternsViewIntelOff", "PatternsViewAgents", "PatternsViewSeat", "PatternsUnread500", "PatternsUnread404"]) assert.ok(names.includes(n), n);
  const entry = read("workers/xauusd-nexus-dashboard/ui/scripts/render-entry.tsx");
  for (const f of ["chart-patterns.json", "strategy-agents.json", "neuron-allocation.json"]) assert.match(entry, new RegExp(`test/fixtures/nexus-intel/${f.replace(".", "\\.")}`), f);
});

test("CP4 the later backend PR's fields null: the not-yet Empties; filled: the reach texts, the since-breakout column, held, the horizon", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  for (const p of CP.patterns) for (const k of ["held", "breakout_bars_ago", "bars_since_breakout", "horizon_bars", "bars_left"]) assert.equal(p[k], null, `${p.id}.${k} null at B9`);
  assert.equal(CP.seat.horizon_bars, null);
  const launch = await page(CP);
  for (const t of ["No held breakouts yet", "No horizon yet", "No plan reach yet", "No horizon for the seat yet", "Filled by a later backend PR.", "judged on 4 bars"]) assert.ok(launch.includes(t), t);
  assert.ok(!launch.includes("Since breakout") && !/\d bars left/.test(launch), "bars left only when present");
  const later = await page(u.PATTERNS_FULL);
  clean(later);
  for (const t of ["No held breakouts yet", "No horizon yet", "No plan reach yet", "No horizon for the seat yet"]) assert.ok(!later.includes(t), `filled: no "${t}"`);
  for (const t of ["Since breakout", "held", "at price (continuation)", "judged on its horizon (19 bars)"]) assert.ok(later.includes(t), t);
  assert.ok(!later.includes("horizon on") && !later.includes("no horizon yet"), "no horizon chip: the filled values show it (OM-LEAN)");
  // Filled mean R has no field in /api/strategy-agents: the Empty, whatever the record carries, and no column.
  const extra = await page(CP, { agents: { ...AGENTS, agents: AGENTS.agents.map((a) => (a.record ? { ...a, record: { ...a.record, filled_mean_r: 0.5 } } : a)) } });
  assert.ok(extra.includes("No filled mean R yet") && !extra.includes("Filled mean R<") && !extra.includes("+0.50R"));
  assert.doesNotMatch(src("pages/Patterns.tsx"), /filled_mean_r|pattern_htf/, "no assumed field or agent id");
  // The three reach texts, and the Empty without them.
  assert.deepEqual(u.REACH, { retest: "retest", continuation: "at price (continuation)", beyond: "not traded: out of reach" });
  for (const [reach, text] of Object.entries(u.REACH)) {
    const html = await page(u.merged(CP, { patterns: CP.patterns.map((p) => (p.plan ? { ...p, plan: { ...p.plan, reach } } : p)) }));
    assert.ok(html.includes(text) && !html.includes("No plan reach yet"), reach);
  }
  // Held lines say so on the chart, with their bars left; the breakout bar is a circle.
  const bars = u.chartBars(u.PATTERNS_FULL, "15");
  const drawing = u.patternDrawing(u.PATTERNS_FULL, "15", bars, null, LIVE);
  assert.ok(drawing.lines.some((l) => /held · 16 bars left/.test(l.label ?? "")));
  assert.ok(drawing.markers.length > 0 && drawing.markers.every((m) => m.shape === "circle" && m.time === bars[bars.length - 4].time));
  assert.equal(u.patternDrawing(CP, "15", u.chartBars(CP, "15"), null, LIVE).markers.length, 0, "no breakout marker at B9");
});

test("CP5 snapToCandle: 15m and 1H exact, a daily close to the day it closes, null outside the candles; the charts' keys", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const t15 = u.chartBars(CP, "15").map((b) => b.time), t60 = u.chartBars(CP, "60").map((b) => b.time), tD = u.chartBars(CP, "D").map((b) => b.time);
  const iso = (s) => new Date(s * 1000).toISOString();
  // A bar's close is the next bar's open: it snaps to its own bar.
  assert.equal(u.snapToCandle(iso(t15[50] + 900), t15, 900), t15[50]);
  assert.equal(u.snapToCandle(iso(t60[40] + 3600), t60, 3600), t60[40]);
  assert.equal(u.snapToCandle("2026-11-23T12:45:00.000Z", t15, 900), t15[CP.patterns[0].start_bar], "the 15m measured move's line_from is its start bar");
  // The daily bars open at 15:00 UTC: a close snaps to the day it closes, the latest open before it.
  assert.equal(u.snapToCandle("2026-11-23T15:00:00.000Z", tD, 86400), tD[tD.length - 1]);
  assert.equal(u.snapToCandle("2026-11-23T09:00:00.000Z", tD, 86400), tD[tD.length - 1], "mid-bar: the latest open before it");
  assert.equal(u.snapToCandle("2026-11-22T15:00:00.000Z", tD, 86400), tD[tD.length - 2], "the day before's close");
  // Outside: at or before the first open, after the last close, or no candle.
  assert.equal(u.snapToCandle(iso(t15[0]), t15, 900), null);
  assert.equal(u.snapToCandle(iso(t15[t15.length - 1] + 901), t15, 900), null);
  assert.equal(u.snapToCandle("2026-11-23T15:00:00.000Z", [], 900), null);
  assert.equal(u.snapToCandle("not a time", t15, 900), null);
  // Every pattern's line_from and line_to fall on its chart's candles.
  for (const p of CP.patterns) {
    const ts = u.chartBars(CP, p.tf).map((b) => b.time), iv = CP.charts[p.tf].interval_s;
    assert.notEqual(u.snapToCandle(p.line_from, ts, iv), null, `${p.tf} ${p.id} line_from`);
    assert.equal(u.snapToCandle(p.line_to, ts, iv), ts[ts.length - 1], `${p.tf} ${p.id} line_to`);
  }
  // The tf map: B9's keys, its "daily" shown as 1D, the seat's rooms.
  assert.deepEqual([...u.TF_KEYS], Object.keys(CP.charts));
  assert.deepEqual(u.TF_LABEL, { "15": "15m", "60": "1H", "240": "4H", D: "1D" });
  assert.equal(CP.charts.D.label, "daily");
  assert.deepEqual(Object.values(u.TF_ROOM), Object.keys(CP.seat.rooms));
  const daily = await page(CP, { tf: "D" });
  assert.ok(daily.includes("(daily) · last 60 closed bars") && !daily.includes("1D (daily)"), "the tab names the chart; B9's own label where it differs");
  assert.ok((await page(CP, { tf: "60" })).includes(">last 60 closed bars<"));
  assert.doesNotMatch(textOf(daily).filter((t) => !t.includes("(daily)")).join("\n"), /\bdaily\b/, "1D everywhere else");
});

test("CP6 TP2 only on a plan's own tp2; every other target is \"measured target · <name>\"; a target is never an entry", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const rows = u.plansOf(CP);
  assert.deepEqual(rows.map((r) => [r.tf, r.pattern.id, r.plan.agent, r.armed]), [["15", "triangle_ascending", "pattern_lines", true], ["60", "rectangle_top", "pattern_inside", false]]);
  for (const tf of ["15", "60", "240", "D"]) {
    const bars = u.chartBars(CP, tf), lead = u.leadPlan(rows, tf);
    const pats = u.patternDrawing(CP, tf, bars, lead, LIVE);
    for (const l of pats.lines) {
      assert.doesNotMatch(l.label ?? "", /\bTP\d|\bEntry\b|\bStop\b|\bentry\b/, `${tf}: ${l.label}`);
      assert.ok(!l.tag, "no pattern line carries a price tag");
    }
    for (const l of pats.lines.filter((x) => /measured target/.test(x.label ?? ""))) assert.match(l.label, /^measured target (· |if up|if down)/);
    const plan = u.planDrawing(lead, LIVE);
    const tp2 = plan.lines.filter((l) => /^TP2/.test(l.label));
    assert.equal(tp2.length, lead ? 1 : 0);
    if (lead) assert.equal(tp2[0].p0, lead.plan.tp2, "TP2 is the plan's tp2");
  }
  // The 15m plan's TP2 is its pattern's measured target: one line carries both, and no second measured target line.
  const lead15 = u.leadPlan(rows, "15");
  assert.equal(lead15.plan.tp2, lead15.pattern.far_target);
  const p15 = u.planDrawing(lead15, LIVE);
  assert.equal(p15.lines.find((l) => /^TP2/.test(l.label)).label, "TP2 1.4R · measured target · ascending triangle");
  assert.ok(!u.patternDrawing(CP, "15", u.chartBars(CP, "15"), lead15, LIVE).lines.some((l) => l.p0 === lead15.plan.tp2 && /measured target/.test(l.label ?? "")));
  // The 1H plan's TP2 is not its measured target: "TP2 2.1R" alone, and the plan box says so.
  const lead60 = u.leadPlan(rows, "60");
  assert.equal(u.planDrawing(lead60, LIVE).lines.find((l) => /^TP2/.test(l.label)).label, "TP2 2.1R");
  // In the markup, "TP2" is the plan box's and the "TP2 of the plan" chip on the plan's own target only.
  for (const tf of ["15", "60", "240", "D"]) {
    const html = await page(CP, { tf });
    const tp2Texts = textOf(html).filter((t) => /\bTP2\b/.test(t));
    for (const t of tp2Texts) assert.match(t, /^(TP2 · \d\.\dR|TP2 of the plan|TP2|A plan&#x27;s TP1 .*)$/, `${tf}: ${t}`);
  }
  const far = await page(CP, { tf: "240" });
  // Each list renders twice (the desktop table and the phone's, one hidden by width).
  assert.equal(textOf(far).filter((t) => t === "TP2 of the plan").length, 2, "the far targets mark the plan's own tp2 once");
  const own = await page(CP, { tf: "15" });
  assert.equal(textOf(own).filter((t) => t === "TP2 of the plan").length, 4, "and its own row on its chart");
});

test("CP7 the plan's lines only on its own chart, through IntelChart's opt-in; the other charts point to it", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const rows = u.plansOf(CP);
  assert.equal(u.defaultTab(CP), "15", "the page opens on the armed plan's chart");
  assert.equal(u.defaultTab(u.PATTERNS_NO_PLAN), "15");
  const p15 = u.planDrawing(u.leadPlan(rows, "15"), LIVE);
  assert.deepEqual(p15.lines.map((l) => l.label), ["Entry", "Stop", "TP1 1.1R", "TP2 1.4R · measured target · ascending triangle"]);
  assert.deepEqual(p15.lines.map((l) => l.p0), [4098.52, 4095.31, 4100.62, 4103.44]);
  assert.deepEqual(p15.band.map((z) => [z.low, z.high]), [[4098.12, 4098.92]], "the EZ1 entry zone from entry_low/entry_high");
  assert.deepEqual(u.planDrawing(u.leadPlan(rows, "60"), LIVE).band, [], "no zone without entry_low/entry_high");
  for (const tf of ["240", "D"]) {
    assert.equal(u.leadPlan(rows, tf), null);
    assert.deepEqual(u.planDrawing(u.leadPlan(rows, tf), LIVE).lines, []);
  }
  assert.equal(u.pointerText(rows), "The agent plans' lines show on the 15m and 1H charts, where their patterns are.");
  assert.equal(u.pointerText(rows.slice(1)), "The agent plan's lines show on the 1H chart, where its pattern is.");
  assert.ok((await page(CP, { tf: "240" })).includes("The agent plans&#x27; lines show on the 15m and 1H charts, where their patterns are."));
  // Stale: dimmed, " · stale 7m" on every label; past 2 hours none.
  const dim = u.planDrawing(u.leadPlan(rows, "15"), { show: true, dim: true, suffix: " · stale 7m", note: null });
  assert.ok(dim.lines.every((l) => l.label.endsWith(" · stale 7m") && l.alpha < 0.5));
  assert.deepEqual(u.planDrawing(u.leadPlan(rows, "15"), { show: false, dim: true, suffix: "", note: null }).lines, []);
  // IntelChart: the opt-in `plan` is empty by default, the only native price line is the last close, and the Liquidity
  // page passes no plan.
  const chart = src("components/IntelChart.tsx");
  assert.match(chart, /plan = NO_LINES,/);
  assert.equal((chart.match(/createPriceLine\(/g) ?? []).length, 1);
  assert.match(chart, /\.\.\.plan\.map\(\(l\) => \(\{ \.\.\.l, tag: true \}\)\), \.\.\.lines\.map\(\(l\) => \(\{ \.\.\.l, tag: false \}\)\)/, "only plan lines carry a price tag");
  assert.doesNotMatch(src("pages/Liquidity.tsx"), /\bplan=\{/, "the Liquidity page passes no plan");
  assert.match(src("pages/Patterns.tsx"), /plan=\{plan\.lines\}/);
});

test("CP8 a plan's notes come from its family's rule: the UI's rules equal src/strategy-agents.mjs, never typed per plan", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.deepEqual(Object.keys(u.PATTERN_FAMILY_RULES), Object.keys(PATTERN_FAMILIES));
  for (const [f, F] of Object.entries(PATTERN_FAMILIES)) {
    const r = u.PATTERN_FAMILY_RULES[f];
    assert.equal(r.label, F.label, f);
    assert.equal(r.entry, F.entry, f);
    assert.deepEqual(r.stop, { ...F.stop }, f);
  }
  assert.deepEqual([...u.PATTERN_AGENT_CHARTS], [...AGENT_RULES.pattern.charts]);
  assert.equal(u.PATTERN_BREAKER_MIN, PATTERN_BREAKER.min_setups);
  assert.deepEqual({ ...u.SEAT_RULES }, { demote_below: ALLOCATION_RULES.demote_below, promote_at: ALLOCATION_RULES.promote_at, min_scored: ALLOCATION_RULES.min_scored });
  assert.deepEqual({ ...u.RECORD_RULES }, { horizon: CALIBRATION.horizon, horizon_max: CALIBRATION.horizon_max, min_sample: CALIBRATION.min_sample });
  // Each family's notes from its rule.
  assert.deepEqual(u.planNotes("pattern_lines", false), { entry: "Entry (throwback)", entryNote: "return to the broken line", stopNote: "beyond the other line, at most 1 ATR (1H)" });
  assert.deepEqual(u.planNotes("pattern_lines", true), { entry: "Entry", entryNote: "price is at the broken line", stopNote: "beyond the other line, at most 1 ATR (1H)" });
  assert.equal(u.planNotes("pattern_peaks", false).stopNote, "half the pattern's height behind the broken line, at most 1.25 ATR (1H)");
  assert.equal(u.planNotes("pattern_curve", false).stopNote, "a third of the pattern's height behind the broken line, at most 1.25 ATR (1H)");
  assert.deepEqual(u.planNotes("pattern_pole", false).entry, "Entry", "a momentum family never waits for a throwback");
  assert.equal(u.planNotes("pattern_inside", false).stopNote, "just beyond the line it leans on");
  // The labels match the registry's (/api/strategy-agents).
  for (const a of agentCatalog(agentStatuses({}))) if (a.id.startsWith("pattern_")) assert.equal(u.agentLabel(a.id), a.label, a.id);
  // The page words no note itself.
  const pg = src("pages/Patterns.tsx");
  for (const t of ["return to the broken line", "beyond the other line", "Entry (throwback)", "just beyond the line"]) assert.ok(!pg.includes(t), `"${t}" comes from lib/patternRules.ts`);
  const html = await page(CP, { tf: "15" });
  assert.ok(html.includes("price is at the broken line") && html.includes("beyond the other line, at most 1 ATR (1H)"));
});

test("CP9 the states: mode off, intel_views_off, 500 and 404 with the code, no plan, no entry zone (pattern_inside), calibration, no candles, market closed", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const off = await page(u.PATTERNS_OFF);
  assert.ok(off.includes("Chart patterns off") && off.includes("Switched off by the owner: the Projection Agent reads no chart pattern. Its projection levels stay."));
  assert.equal((off.match(/class="chip [^"]*text-off">patterns off</g) ?? []).length, 1, "the heading's chip only (OM-LEAN)");
  assert.ok(!off.includes("Lines on the chart"), "no chart while off");
  const views = await page({ status: "not_found", reason: "intel_views_off" });
  assert.ok(views.includes("intel_views_off") && views.includes("The Intelligence views are off on the AI Worker."));
  // The errors: the shared error box with the route and the whole code.
  assert.equal(new ApiError("/api/chart-patterns", 500, "chart_patterns_unavailable").message, "/api/chart-patterns 500 chart_patterns_unavailable");
  assert.equal(new ApiError("/api/chart-patterns", 404, "Not found").message, "/api/chart-patterns 404 Not found");
  for (const name of ["PatternsUnread500", "PatternsUnread404"]) {
    const e = u.VIEWS.find((v) => v.name === name);
    const html = u.render(e.View, e.fixture);
    assert.ok(html.includes(e.shows[0]) && html.includes("Retry now"), name);
  }
  assert.match(src("pages/Patterns.tsx"), /if \(patterns\.data == null\) return <PatternsUnread poll=\{patterns\} \/>;/);
  const noPlan = await page(u.PATTERNS_NO_PLAN);
  assert.ok(noPlan.includes("No agent plan") && noPlan.includes("The latest decision has no trade agent: no Entry, Stop or TP line."));
  assert.ok(!noPlan.includes("Agent plan<") && !noPlan.includes(">armed<"));
  // The null entry zone: the fixture's 1H plan is pattern_inside's.
  const ez = CP.patterns.find((p) => p.plan && p.plan.entry_low == null);
  assert.equal(ez.plan.agent, "pattern_inside");
  const h1 = await page(CP, { tf: "60" });
  assert.ok(h1.includes("Inside the pattern") && h1.includes("No entry zone yet") && h1.includes("This plan carries no entry_low or entry_high, so the entry zone cannot be drawn."));
  const NOCAL = { version: null, computed_at: null, base_rate: null, resolved: null, pending: null, patterns: null, by_tf: null, open: null };
  const calOff = await page(u.merged(CP, { calibration_mode: "off", calibration: NOCAL }));
  assert.ok(calOff.includes("No measured record") && calOff.includes("Calibration is switched off by the owner: every pattern keeps its default weights.") && calOff.includes("calibration off"));
  assert.equal((calOff.match(/>calibration off</g) ?? []).length, 1, "the heading's chip only (OM-LEAN)");
  assert.ok((await page(u.merged(CP, { calibration: NOCAL }))).includes("No measured record yet"));
  const noBars = await page(u.merged(CP, { charts: { "60": { ohlcv: [] } } }), { tf: "60" });
  assert.ok(noBars.includes("No 1H candles yet") && noBars.includes("The chart&#x27;s closed bars come with /api/chart-patterns every 2 minutes."));
  assert.ok((await page(CP, { tf: "240" })).includes("pattern agents trade the 15m and 1H charts only"), "the 4H and 1D patterns' plan cell");
  assert.ok((await page(u.merged(CP, { patterns: CP.patterns.filter((p) => p.tf !== "240") }), { tf: "240" })).includes("No pattern on the 4H chart"));
  const sat = Date.parse("2026-11-21T15:00:00Z");
  const closed = await page(CP, { now: sat });
  assert.equal((closed.match(/>market closed</g) ?? []).length, 1, "one market-closed chip (the panel's)");
  assert.ok(closed.includes("Market closed") && closed.includes("Patterns read closed bars. The next 15m bar closes Sun 18:15 New York · Sun 23:15 UTC") && closed.includes("Friday&#x27;s last bars"));
});

test("CP10 colours from tokens.ts only: no hex, no emerald or rose, green only for a bullish direction, outcomes never green or red", () => {
  for (const f of ["pages/Patterns.tsx", "lib/lines-primitive.ts", "lib/patternRules.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i, `${f}: no hex colour`);
    assert.doesNotMatch(s, /\b(?:emerald|rose|green|red)-\d/, `${f}: no Tailwind palette colour`);
  }
  const s = src("pages/Patterns.tsx");
  const bull = s.split("\n").filter((l) => /text-bull|T\.bull\b|T\.bullFill|bg-bull/.test(l));
  assert.ok(bull.length >= 4, `bull lines: ${bull.length}`);
  for (const l of bull) assert.match(l, /▲|support|long|=== 1|1: |TP1|TP2|tp1|tp2|TP"|bull/, `green only for bullish (and the plan's targets): ${l.trim().slice(0, 120)}`);
  // Mean R and the rates are plain text; the record's outcomes are status tones (ok, fault, off).
  assert.doesNotMatch(s.slice(s.indexOf("function AgentsPanel"), s.indexOf("// ---------------------------------------------------------------- the view")), /text-bull|text-bear/, "no direction colour on an outcome");
  assert.match(s, /bg-ok-fill"\)\}\{seg\(f, "bg-fault-fill"\)\}\{seg\(e, "bg-off-fill\/60"\)/, "reached ok, failed fault, expired off");
  assert.match(s, /const AGENT_TONE: Record<string, Tone> = \{ live: "ok", shadow: "shadow", suspended: "late", off: "off" \};/);
});

test("CP11 the pattern agents: rates over filled setups from /api/strategy-agents, armed from the view's trade agent, held-back patterns", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  // The sample fixture is the route's own registry.
  const catalog = agentCatalog(agentStatuses({})).filter((a) => a.id.startsWith("pattern_")).map((a) => [a.id, a.label]);
  assert.deepEqual(AGENTS.agents.filter((a) => a.id.startsWith("pattern_")).map((a) => [a.id, a.label]), catalog);
  const list = u.patternAgents(AGENTS);
  assert.equal(list.length, 9);
  assert.deepEqual(list.slice(0, 4).map((a) => a.status), ["live", "live", "live", "live"], "live first");
  assert.equal(list[list.length - 1].id, "pattern_gaps", "suspended after shadow");
  const html = await page(CP);
  assert.ok(html.includes("4 live · 4 shadow · 1 suspended"));
  // pattern_lines: 58 setups, 71% filled (41), target 46% and stop 27% of the filled.
  const row = html.slice(html.indexOf("Triangles, wedges and rectangles</td>"), html.indexOf("</tr>", html.indexOf("Triangles, wedges and rectangles</td>")));
  for (const t of [">armed<", ">58<", ">41<", ">71%<", ">46%<", ">27%<", ">+0.21R<"]) assert.ok(row.includes(t), t);
  assert.ok(html.includes("1 held back") && html.includes("double top (Adam &amp; Adam)") && html.includes("pennant"));
  assert.ok(html.includes("From /api/strategy-agents. Target and stop rates are over filled setups. Armed: the latest decision&#x27;s trade agent, from /api/chart-patterns."));
  // Armed follows decision.trade_agent: none without one.
  assert.ok(!(await page(u.merged(CP, { decision: { trade_agent: null } }))).includes(">armed<"));
  // The seat: live or shadow per room from /api/neuron-allocation, the hit rate and n against 60 from the view.
  assert.equal(u.seatOf(ALLOC, "H4"), "shadow");
  assert.equal(u.seatOf(ALLOC, "M15"), "live");
  assert.equal(u.seatOf({ agents: [] }, "M15"), null);
  assert.ok(html.includes("n 4 / 60") && html.includes("75%"));
});

test("CP12 every price carries its scale (the feed's)", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(CP.scale.prices, "feed");
  const PRICE = /\d,\d{3}\.\d{2}/;
  for (const tf of ["15", "60", "240", "D"]) {
    const html = await page(CP, { tf });
    // A table of prices names the feed scale in its head; a panel of prices says "Feed scale." or "feed scale" in its note.
    for (const t of [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).filter((x) => PRICE.test(x))) assert.match(t.slice(0, t.indexOf("</thead>")), /[Ff]eed scale/, "the feed scale in the head");
    assert.ok(html.includes("Prices on the feed scale."), "the patterns' note");
    if (tf === "15" || tf === "60") assert.ok(html.includes("trade agent. Feed scale."), "the plan box");
    for (const t of textOf(html.replace(/<table[\s\S]*?<\/table>/g, "")).filter((x) => PRICE.test(x) && /price|ATR/.test(x))) assert.match(t, /feed scale/, t);
  }
  assert.ok(u.SCALE.feed === "feed scale");
});

test("CP14 times: the Intelligence chart's axis and crosshair in GMT+7 (EZ1's helpers), the last closed bar in UTC and GMT+7", { skip: NO_UI_DEPS }, async () => {
  const chart = src("components/IntelChart.tsx");
  assert.match(chart, /import \{ gmt7ClockOf, gmt7Crosshair, gmt7Tick \} from "\.\.\/lib\/entryZone";/);
  assert.match(chart, /tickMarkFormatter: \(t: Time, type: TickMarkType\) => gmt7Tick\(t, type\)/, "as PriceChart (EZ1-4)");
  assert.match(chart, /timeFormatter: \(t: Time\) => gmt7Crosshair\(t\)/);
  assert.match(chart, />GMT\+7<\/span>/, "the time axis' zone");
  assert.doesNotMatch(chart, />UTC<\/span>/);
  const u = await ui();
  const last15 = CP.charts["15"].ohlcv.at(-1).time, lastD = CP.charts.D.ohlcv.at(-1).time;
  const html15 = await page(CP, { tf: "15" }), htmlD = await page(CP, { tf: "D" });
  assert.ok(html15.includes("last closed bar Mon 23 Nov 15:00 UTC · 22:00 GMT+7"), `15m bar opened ${last15}`);
  assert.ok(htmlD.includes("last closed bar Mon 23 Nov 15:00 UTC · 22:00 GMT+7"), `the daily bar opened ${lastD} closes a day later`);
  const none = await page(u.merged(CP, { charts: { "15": { ohlcv: [] } } }), { tf: "15" });
  assert.ok(none.includes("No 15m candles yet") && !none.includes("last closed bar"), "no time without a bar");
});

test("CP13 the deploy smoke step; SSOT and the CHANGELOG", () => {
  const wf = read(".github/workflows/deploy-nexus-dashboard.yml");
  const at = wf.indexOf("- name: Smoke test the Chart patterns view");
  assert.ok(at > 0 && at > wf.indexOf("- name: Smoke test the Liquidity view"), "after the Liquidity step");
  const step = wf.slice(at, wf.indexOf("NODE\n", wf.indexOf("node --input-type=module", at)) + 5);
  assert.match(step, /https:\/\/nexus\.cryptophys\.work\/api\/chart-patterns/);
  assert.match(step, /isAccessLogin\(bare\)/, "the Access redirect without the token");
  assert.match(step, /headers: token\.headers/, "under the CI token");
  assert.match(step, /r\.status !== 200/);
  assert.match(step, /\\bjson\\b/);
  assert.match(step, /no-store/);
  assert.ok(step.includes(`body?.schema !== "${CP.schema}"`), "the fixture's schema");
  assert.match(step, /Track B9 and C3/);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /Chart patterns \(`#\/patterns`, Track C3, directly after Strategy agents/);
  assert.match(ssot, /The Nexus Chart patterns page \(`#\/patterns`, Track C3\) reads it\./);
  const log = read("docs/CHANGELOG.md");
  const i = log.indexOf("feat(nexus): the Chart patterns page in Intelligence (Track C3)");
  assert.ok(i > log.indexOf("## 2026-11-23") && i < log.indexOf("## 2026-11-22"));
});
