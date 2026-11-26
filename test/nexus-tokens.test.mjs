// The Nexus colour set (owner-approved mockup "Nexus colours and text", 2026-11-22: "lanjutkan semua dan tetap
// berkoordinasi dengan orkestrator"). One source (ui/src/lib/tokens.ts with the @theme block of ui/src/index.css):
// green bullish, red bearish, amber neutral; status as the header shows it (cyan ok, amber late, red fault, grey
// off); labels in sentence case without letter spacing; no glowing text. The header itself does not change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CANDLE, CHIP, KWW, T, directionGlyph, directionTone, rgba } from "../workers/xauusd-nexus-dashboard/ui/src/lib/tokens.ts";

const ui = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => ui(`src/${p}`);

/**
 * The files the mockup migrates, with direction colours (bear red, neutral amber). Performance.tsx since the review
 * of #526: its equity and drawdown charts carry P&L in bull green and bear red.
 */
const DIRECTION_FILES = [
  "components/Stance.tsx", "components/CrowdLine.tsx", "components/MetricChips.tsx", "components/Post.tsx", "pages/Audit.tsx",
  "components/GlobalDecision.tsx", "components/SetupLifecycle.tsx", "components/ThreadsPanel.tsx", "pages/Correlations.tsx",
  "components/charts.tsx", "components/PriceChart.tsx", "pages/Performance.tsx",
  // Track C1: the Positioning & Liquidity panel, the first view of the page render check.
  "components/LensPanel.tsx",
  // Track C2: the Liquidity page and the Intelligence pages' chart.
  "pages/Liquidity.tsx", "components/IntelChart.tsx",
  // Track C3: the Chart patterns page.
  "pages/Patterns.tsx",
  // FS1: the Feature switches page (no direction colour at all: on is the ok cyan).
  "pages/Switches.tsx",
  // ZN1: the Zones page (a side's word and a zone type's glyph only; rates, outcomes and R neutral).
  "pages/Zones.tsx",
  // H3f: the owner's correction control (no direction colour at all: up is the ok cyan, down the off grey).
  "components/Correction.tsx",
  // C5: the Position Manager lines on the Omega page (no direction colour at all: on is the ok cyan, off the fault red, R neutral).
  "components/PmLines.tsx",
  // C4: the Opening range page (a side's glyph and word, a breakout's direction, the plan's Stop red and targets green;
  // statuses in their tones; rates, outcomes and R neutral).
  "pages/Orb.tsx"
];

test("NT1 the owner-approved values: text and fill on the panel #0b0f18", () => {
  assert.deepEqual([T.bull, T.bullFill, T.bear, T.bearFill, T.neutral, T.neutralFill], ["#4ade80", "#22c55e", "#f87171", "#ef4444", "#fcd34d", "#fbbf24"]);
  assert.deepEqual([T.ok, T.okFill, T.off], ["#67e8f9", "#22d3ee", "#94a3b8"]);
  assert.deepEqual([T.late, T.lateFill], [T.neutral, T.neutralFill], "late is the neutral amber");
  assert.deepEqual([T.fault, T.faultFill], [T.bear, T.bearFill], "fault is the bear red");
  assert.deepEqual([T.fg, T.fg2, T.muted, T.dim], ["#e6edf3", "#8b949e", "#7d8590", "#484f58"]);
  assert.deepEqual([T.ground, T.panel, T.bar, T.border, T.borderSoft], ["#05070c", "#0b0f18", "#0f1522", "rgba(255,255,255,0.10)", "rgba(255,255,255,0.05)"]);
});

test("NT2 one source: the @theme block of index.css carries the same values as tokens.ts, and the obsidian surfaces agree", () => {
  const css = src("index.css");
  const theme = css.slice(css.indexOf("@theme {"), css.indexOf("}", css.indexOf("@theme {")));
  const vars = Object.fromEntries([...theme.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
  const camel = (k) => (k === "ghost" ? "shadow" : k === "ghost-fill" ? "shadowFill" : k === "fg-2" ? "fg2" : k.replace(/-fill$/, "Fill"));
  assert.ok(Object.keys(vars).length >= 22, "the @theme block was found");
  for (const [k, v] of Object.entries(vars)) assert.equal(v, T[camel(k)], `--color-${k} equals T.${camel(k)}`);
  for (const k of ["bull", "bear", "neutral", "ok", "late", "fault", "off", "shadow"]) {
    assert.ok(Object.values(vars).includes(T[k]) && Object.values(vars).includes(T[`${k}Fill`]), `${k} text and fill are in @theme`);
  }
  const config = ui("tailwind.config.js");
  assert.match(config, new RegExp(`obsidian: \\{ DEFAULT: "${T.ground}", deep: "#080b11", panel: "${T.panel}", bar: "${T.bar}"`));
  assert.doesNotMatch(config, /\btv:\s*\{/, "the unused tv.* colours are gone");
  assert.doesNotMatch(css, /--green:|--red:|--amber:/, "no second palette in :root");
});

test("NT3 chips: border at 30% of the fill, background at 10%, text in the text colour", () => {
  for (const k of ["bull", "bear", "neutral", "ok", "late", "fault"]) {
    assert.equal(CHIP[k], `border-${k}-fill/30 bg-${k}-fill/10 text-${k}`);
  }
  assert.equal(rgba("#22c55e", 0.3), "rgba(34, 197, 94, 0.3)");
});

test("NT4 direction carries ▲ ▼ · or its word; CLOSE is in the text colour, not cyan", () => {
  assert.deepEqual(["BUY", "BULLISH", "SELL", "BEARISH", "NEUTRAL", "WAIT", "CLOSE"].map(directionGlyph), ["▲", "▲", "▼", "▼", "·", "", ""]);
  assert.deepEqual(["BUY", "SELL", "WAIT", "HOLD", "NEUTRAL", "CLOSE"].map(directionTone), ["bull", "bear", "neutral", "neutral", "neutral", "plain"]);
  const stance = src("components/Stance.tsx");
  assert.match(stance, /if \(value === "CLOSE"\) return "text-fg";/);
  assert.match(stance, /directionGlyph\(value\)/);
  assert.doesNotMatch(stance, /cyan/);
});

test("NT5 no #fb7185 or rose- for bearish in the migrated components", () => {
  for (const f of DIRECTION_FILES) {
    const s = src(f);
    assert.doesNotMatch(s, /#fb7185/i, `${f}: the old bear rose`);
    assert.doesNotMatch(s, /\brose-\d/, `${f}: rose- classes`);
    assert.doesNotMatch(s, /#34d399|#3fb950|#f85149/i, `${f}: one green and one red, from the tokens`);
  }
});

test("NT6 NEUTRAL is amber in charts.tsx; grey (muted) is only for no data", () => {
  const charts = src("components/charts.tsx");
  assert.match(charts, /wait: T\.neutral, neutral: T\.neutral/);
  assert.match(charts, /NEUTRAL: C\.neutralFill/);
  assert.match(charts, /WAIT: C\.neutralFill, HOLD: C\.neutralFill, CLOSE: C\.text/);
  assert.match(charts, /leanColor = \(v: number \| null \| undefined\) => \(v == null \? C\.muted : Math\.abs\(v\) < 0\.15 \? C\.neutral :/, "neutral amber where leanLabel says neutral");
  assert.doesNotMatch(charts, /NEUTRAL: C\.muted/);
  assert.equal(T.neutral, "#fcd34d");
  assert.match(src("components/CrowdLine.tsx"), /NEUTRAL: T\.neutralFill/);
});

test("NT7 no `uppercase tracking-` on .chip, .label, .eyebrow, table heads or panel titles", () => {
  const css = src("index.css");
  for (const cls of [".eyebrow", ".panel-title", ".chip", ".label", ".tbl th"]) {
    const rule = css.split("\n").find((l) => l.trim().startsWith(`${cls} {`));
    assert.ok(rule, `${cls} is defined`);
    assert.doesNotMatch(rule, /uppercase|tracking-/, `${cls}: sentence case, no letter spacing`);
  }
  assert.match(css.split("\n").find((l) => l.trim().startsWith(".label {")), /text-muted/, "labels in muted #7d8590 (slate-500 fails 4.5:1)");
  const u = src("components/ui.tsx");
  assert.match(u, /<h2 className="panel-title flex items-center gap-2">/, "the Panel title");
  const kpi = u.slice(u.indexOf("export function Kpi"), u.indexOf("type LegacyTone"));
  assert.doesNotMatch(kpi, /uppercase|tracking-|textShadow/, "the Kpi label is sentence case and its value has no glow");
  for (const f of DIRECTION_FILES) {
    const hits = src(f).split("\n").filter((l) => /\buppercase\b[^"`]*\btracking-(?!normal)/.test(l) || /\bchip\b[^"`]*\btracking-\[/.test(l));
    assert.deepEqual(hits, [], `${f}: no tracked caps on labels or chips`);
  }
});

test("NT8 no glowing text; the mesh background and the logo glow stay", () => {
  for (const f of ["components/ui.tsx", "components/GlobalDecision.tsx", "components/ThreadsPanel.tsx", "pages/Correlations.tsx"]) {
    assert.doesNotMatch(src(f), /textShadow/, `${f}: no text glow`);
  }
  assert.doesNotMatch(src("components/charts.tsx"), /boxShadow/, "no glow on the diverging bars");
  assert.match(src("components/AppShell.tsx"), /animate=\{\{ boxShadow: \["0 0 0 rgba\(34,211,238,0\)", "0 0 22px rgba\(34,211,238,0\.35\)"/, "the logo glow");
  assert.match(src("main.tsx"), /<NeuralMeshBackground \/>/, "the mesh background");
});

test("NT9 the header components are unchanged (they set the status values the tokens follow)", () => {
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  // Pinned at the mockup's migration (2026-11-22). A deliberate header change updates these pins in the same PR.
  assert.equal(sha(src("components/HeaderStatus.tsx")), "7ffc434291771197b00c30c323778eb0fe75af9f6f247c988b1b5ad8069c9748", "components/HeaderStatus.tsx");
  assert.equal(sha(src("lib/headerStatus.ts")), "5f2c5a004f593558854797e8a8d5c30b20c9356b41c5a01b7a7a87f63a11ee83", "lib/headerStatus.ts");
  const shell = src("components/AppShell.tsx");
  assert.equal(sha(shell.slice(shell.indexOf("<header"), shell.indexOf("</header>") + 9)), "1cd49fa9079f72ead2594f9b7518cfe01684f8b860a0ae55c9a5959e48a97cd7", "the <header> of AppShell.tsx");
  // The header's text tones are Tailwind cyan-300, amber-300, red-400 and slate-400: the token values ok, late, fault, off.
  assert.match(src("components/HeaderStatus.tsx"), /ok: "text-cyan-300", late: "text-amber-300", fault: "text-red-400", off: "text-slate-400"/);
  assert.deepEqual([T.ok, T.late, T.fault, T.off], ["#67e8f9", "#fcd34d", "#f87171", "#94a3b8"]);
});

test("NT10 the owner's decisions on the open questions", () => {
  const u = src("components/ui.tsx");
  assert.match(u, /s === "info" \? "ok"/, "severityTone info is ok");
  const gd = src("components/GlobalDecision.tsx");
  assert.match(gd, /<Check className="h-3\.5 w-3\.5 shrink-0 text-ok" aria-label="passes" \/>/, "the guardrail ✓ is cyan");
  assert.match(gd, /<X className="h-3\.5 w-3\.5 shrink-0 text-fault" aria-label="fails" \/>/, "the ✕ is red");
  assert.match(gd, /<span className="bg-bull-fill"[^>]*\/>\s*<span className="bg-neutral-fill"[^>]*\/>\s*<span className="bg-bear-fill"/, "the quorum bar: green, amber, red");
  const strat = src("pages/Strategy.tsx");
  assert.match(strat, /\["Recommended", "ok"\]/);
  assert.match(strat, /\["Not recommended", "fault"\]/);
  const pc = src("components/PriceChart.tsx");
  assert.match(pc, /kwwUp1618: \{ color: KWW\.edge/);
  assert.match(pc, /kwwDn1618: \{ color: KWW\.edge/);
  assert.match(KWW.edge, /^rgba\(250,204,21,/, "the KWW hue");
  assert.match(pc, /"#e879f9"/, "the volume profile's violets stay");
  assert.match(pc, /ema114: \{ color: "rgba\(255,152,0,0\.95\)"/, "EMA 114 orange stays");
  assert.match(pc, /\.\.\.CANDLE,/);
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /\.\.\.CANDLE,/, "one candle palette on both charts");
  assert.deepEqual([CANDLE.upColor, CANDLE.downColor], [T.bullFill, T.bearFill]);
  assert.match(omega, /setupTab === key \? "border-white\/30 bg-white\/8 text-fg"/, "the active Setup tab is white 8%");
  assert.doesNotMatch(omega, /bg-\[#0[0-9a-f]{5}\]|from-\[#|to-\[#/, "no hard-coded panel colours");
  const perf = src("pages/Performance.tsx");
  assert.match(perf, /stroke=\{T\.off\} strokeOpacity=\{0\.7\}/, "the equity peak line is grey (mockup \"Nexus data states\", part B: off, thin)");
  assert.doesNotMatch(perf, /stroke=\{C\.wait\}/);
  assert.match(perf, /dynamicAvgSlippage <= 3 \? T\.ok :/, "good slippage is ok cyan");
  assert.match(perf, /<Badge tone=\{dynamicAvgLatency <= 1500 \? "ok" : "late"\}>/, "good latency is ok cyan");
  assert.match(perf, /<Hint className="ml-1\.5 align-middle" text="A change of the engine's behaviour \(at its deploy\) or of a behaviour switch \(at the settings change\) starts a new parity window; a code change with identical behaviour carries it over\." \/>/, "the era note in the (i) hint, its words kept");
  assert.doesNotMatch(perf, /<span className="text-slate-500">A change of the engine's behaviour/);
});
