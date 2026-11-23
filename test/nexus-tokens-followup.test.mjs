// The follow-ups of #518 (Nexus colours and text), by the rules the owner approved on 2026-11-22: green means bullish
// only (P&L and R stay green and red); every state is ok / late / fault / off; one red and one green, so no emerald-
// or rose- classes; sentence-case labels without letter spacing, in the label grey; acronyms stay in capitals.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CHIP, T, edgeTone } from "../workers/xauusd-nexus-dashboard/ui/src/lib/tokens.ts";
import { overviewBadge } from "../workers/xauusd-nexus-dashboard/ui/src/lib/healthBadge.ts";

const ROOT = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url));
const src = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
/** Every .ts, .tsx and .css file under ui/src, as [path relative to ui/src, text]. */
const ALL = (function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|css)$/.test(n) ? [[relative(ROOT, p).replace(/\\/g, "/"), readFileSync(p, "utf8").replace(/\r\n/g, "\n")]] : [];
  });
})(ROOT);
const STATES = new Set(["ok", "late", "fault", "off"]);

test("NF1 the model's edge: no colour when it rounds to 0 whole points, as its label shows", () => {
  for (const d of [0, 0.004, -0.004, 0.0049, -0.0049]) assert.equal(edgeTone("long", d), "plain", `long ${d}`);
  for (const d of [0.003, -0.003]) assert.equal(edgeTone("short", d), "plain", `short ${d}`);
  assert.equal(edgeTone("long", 0.006), "bull", "+1 pt");
  assert.equal(edgeTone("long", -0.006), "bear", "-1 pt");
  assert.equal(edgeTone("short", 0.006), "bear", "a favoured short");
  assert.equal(edgeTone("short", -0.006), "bull");
  const gd = src("components/GlobalDecision.tsx");
  const advice = gd.slice(gd.indexOf("function ModelAdvice"), gd.indexOf("function MarketContext"));
  assert.match(advice, /const pts = \(d: number\) => \{ const n = Math\.round\(d \* 100\); return n > 0 \? `\+\$\{n\}` : n < 0 \? `\$\{n\}` : "0"; \};/, "the label signed by the rounded value: never \"+0\"");
  assert.match(advice, /\(\$\{pts\(d\)\} pts\)/);
});

test("NF2 the shadow switch: OFF by the owner is off (grey, no pulse); only the cost breaker's stop is a fault", () => {
  const s = src("components/ShadowSwitchCard.tsx");
  assert.match(s, /const breaker = known && !state\?\.allowed && !state\?\.held_off_by_variable && state\?\.mode_source === "breaker";/);
  assert.match(s, /!state\?\.allowed \? \(breaker \? "fault" : "off"\)/);
  assert.match(s, /<Dot tone=\{tone\} pulse=\{breaker\} \/>/);
  assert.doesNotMatch(s, /pulse=\{known && !state\.allowed\}/);
});

test("NF3 the witness lean label: w-32, cut, its full text in the title (the lean bar stays beside a status tag)", () => {
  const gd = src("components/GlobalDecision.tsx");
  assert.match(gd, /<span className="w-32 shrink-0 truncate text-right text-\[11px\]" style=\{\{ color: leanColor\(r\.lean\) \}\} title=\{leanText\(r\.lean\)\}>\{leanText\(r\.lean\)\}<\/span>/);
  assert.doesNotMatch(gd, /w-36 shrink-0 whitespace-nowrap/);
});

test("NF4 Performance: the terminal \"not connected\" is off grey, \"connected\" ok", () => {
  const perf = src("pages/Performance.tsx");
  assert.match(perf, /<p className=\{`mono font-semibold \$\{br\.terminal_connected === true \? "text-ok" : "text-off"\}`\}>\{br\.terminal_connected === true \? "connected" : br\.terminal_connected === false \? "not connected" : "—"\}<\/p>/);
  assert.doesNotMatch(perf, /text-cyan-400">\{br\.terminal_connected/);
});

test("NF5 Omega: the engine switched off is off grey (as the header's READY / OFF), killed stays a fault", () => {
  const omega = src("pages/Omega.tsx");
  const toolbar = omega.slice(omega.indexOf("{/* Algo Trading Master Direct Toggle Button */}"), omega.indexOf("{/* MT5 Terminal VPS Execution Health Pill */}"));
  assert.match(toolbar, /: "border-off-fill\/35 bg-off-fill\/8 text-off hover:bg-off-fill\/15"/);
  assert.match(toolbar, /eEnabled \? "bg-ok-fill animate-pulse" : "bg-off-fill"/);
  assert.doesNotMatch(toolbar, /fault/, "engine disabled is the owner's switch, not a fault");
  assert.match(omega, /<Badge tone=\{c\.mode === "killed" \? "fault" : eEnabled \? "ok" : "off"\}>\n\s*\{c\.mode === "killed" \? "KILLED" : eEnabled \? "ARMED" : "IDLE"\}/);
  assert.match(src("lib/headerStatus.ts"), /code: "OFF", detail: null, tone: "off"/, "the header shows engine off grey too");
});

test("NF6 dialogs in the tokens: confirm or approve ok cyan, a step to think twice late, destructive fault red", () => {
  const cd = src("components/ConfirmDialog.tsx");
  assert.match(cd, /tone\?: "ok" \| "late" \| "fault";/);
  for (const k of ["ok", "late", "fault"]) assert.match(cd, new RegExp(`\\n  ${k}: \\{ border: "border-${k}-fill/40", glow: "[^"]+", icon: "border-${k}-fill/40 bg-${k}-fill/10 text-${k}", button: "bg-${k}-fill/20 text-${k} ring-${k}-fill/50 hover:bg-${k}-fill/30" \\}`), k);
  assert.match(cd, /const t = TONES\[options\.tone \?\? "ok"\];/);
  assert.doesNotMatch(cd, /emerald|rose|from-\[#/);
  const councils = src("pages/Councils.tsx");
  assert.match(councils, /confirmLabel: "Accept", tone: "ok" \}/, "accepting an option is an approve: cyan, not green");
  assert.match(councils, /confirmLabel: "Close session", tone: "late" \}/);
  assert.match(councils, /confirmLabel: "Turn off", tone: "fault" \}/, "turning sessions off stops running ones: destructive");
  const ex = src("components/ExitConfirmModal.tsx");
  assert.match(ex, /border border-fault-fill\/40 bg-linear-to-b from-panel to-ground/, "closing a position is destructive");
  assert.match(ex, /border border-fault-fill\/60 bg-fault-fill\/20 px-4 py-2 text-\[12px\] font-bold text-fault/, "Close at market in the fault red");
  assert.match(ex, /\$\{CHIP\[directionTone\(position\.side\)\]\}/, "the side chip is a direction: BUY bull, SELL bear");
  assert.match(ex, /position\.profit >= 0 \? "text-bull" : "text-bear"/, "P&L stays green and red");
  assert.match(ex, /border-late-fill\/30 bg-late-fill\/10 p-2\.5 text-\[11px\] text-late/, "the warning in late amber");
  assert.equal(CHIP.bull, "border-bull-fill/30 bg-bull-fill/10 text-bull");
  const css = src("index.css");
  assert.match(css, /\.btn-danger \{ @apply border-fault-fill\/30 bg-fault-fill\/10 text-fault hover:border-fault-fill\/60 hover:bg-fault-fill\/20; \}/);
  assert.match(css, /\.btn-approve \{ @apply border-ok-fill\/30 bg-ok-fill\/10 text-ok hover:border-ok-fill\/60 hover:bg-ok-fill\/20; \}/);
});

test("NF7 a dash for no data is muted, never in the bull or bear colour", () => {
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /const pnlColor = \(v\?: number \| null\) => \(typeof v !== "number" \|\| !Number\.isFinite\(v\) \? T\.muted : v < 0 \? T\.bear : v > 0 \? T\.bull : T\.fg\);/);
  assert.match(omega, /color=\{pnlColor\(x\?\.net\)\}/, "Today, 7 days, 30 days: \"—\" muted");
  assert.doesNotMatch(omega, /x\.net < 0 \? T\.bear : T\.bull/);
  // A fixed bull or bear class on a cell whose value can be "—".
  const fixed = /className="[^"]*\btext-(?:bull|bear)\b[^"]*">\{[^}]*"—"[^}]*\}/;
  for (const [f, s] of ALL) assert.doesNotMatch(s, fixed, `${f}: a "—" in bull or bear`);
  const sl = src("components/SetupLifecycle.tsx");
  for (const k of ["stop", "tp1", "tp2"]) assert.match(sl, new RegExp(`className=\\{s\\.locked\\?\\.${k} == null \\? "text-muted" : "text-(bull|bear)"\\}`), k);
  assert.match(src("pages/Performance.tsx"), /<td className=\{`mono \$\{o\?\.trades \? "text-bear" : "text-muted"\}`\}>/);
  assert.equal(T.muted, "#7d8590");
});

/** "green" as a tone or class anywhere under ui/src. Each allowed use is listed, with why. */
const GREEN = /["'`]green["'`]|\b(?:text|bg|border|ring|fill|stroke|from|to|via|shadow|accent)-green-\d|\bemerald\b|\bemerald-/;
const GREEN_ALLOWED = [
  // The legacy name still compiles for old callers and draws the bull green; no caller under ui/src passes it.
  ["components/ui.tsx", /^type LegacyTone = "green" \| "amber" \| "red" \| "cyan" \| "slate" \| "purple";$/]
];

test("NF8 green is bullish only: no \"green\" or emerald as a state tone anywhere under ui/src", () => {
  const hits = [];
  for (const [f, s] of ALL) {
    s.split("\n").forEach((line, i) => {
      if (!GREEN.test(line)) return;
      if (GREEN_ALLOWED.some(([af, re]) => af === f && re.test(line.trim()))) return;
      hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], "map each state to ok / late / fault / off; a direction or P&L uses bull / bear");
  // NR5's check for a legacy name inside a Record, now on every page and component.
  for (const [f, s] of ALL) assert.doesNotMatch(s, /tone: "green"|tone=\{?[^}\n]*"green"/, f);
  // The lanes of System status and the War Room's issue panel.
  const health = src("lib/health.ts");
  assert.match(health, /export type Tone = "ok" \| "late" \| "fault" \| "off";/);
  // The tone values: each literal a branch yields (at the start or after ? or :), not the ones it compares with (===).
  const tones = [...health.matchAll(/tone: ([^,]+),/g)].flatMap((m) => [...m[1].matchAll(/(?:^|[?:])\s*"([a-z]+)"/g)].map((x) => x[1]));
  assert.ok(tones.length >= 20, `tones found: ${tones.length}`);
  for (const t of tones) assert.ok(STATES.has(t), `lib/health.ts: ${t}`);
  for (const status of ["live", "stale", "error", "loading", "idle"]) for (const lane of ["live", "stale", "error"]) for (const [bad, warn] of [[0, 0], [1, 0], [0, 2]]) {
    assert.ok(STATES.has(overviewBadge({ bad, warn, status, lane }).tone), `${status}/${lane}/${bad}/${warn}`);
  }
  assert.equal(overviewBadge({ bad: 0, warn: 0, status: "live", lane: "live" }).tone, "ok", "all nominal is cyan, not green");
  const st = src("pages/Status.tsx");
  assert.match(st, /items\.filter\(\(i\) => i\.tone === "fault"\)\.length, warn = items\.filter\(\(i\) => i\.tone === "late"\)\.length/);
  assert.match(src("components/SystemIssues.tsx"), /items\.filter\(\(i\) => i\.tone === "fault" \|\| i\.tone === "late"\)/);
  // The states the follow-up names, each in the status tones.
  assert.match(src("components/OmegaWhy.tsx"), /<Badge tone=\{blocked \? "late" : "ok"\}>\{blocked \? "NOT ENTERING" : "READY \/ MANAGING"\}<\/Badge>/);
  assert.match(src("components/LensPanel.tsx"), /<Badge tone=\{on \? "ok" : "off"\}>\{on \? "on" : "switched off"\}<\/Badge>/);
  assert.match(src("pages/Alerts.tsx"), /v\.enabled \? \{ tone: "ok" as const, text: "active" \}/);
  assert.match(src("pages/Model.tsx"), /<Badge tone=\{on \? "ok" : "late"\}>\{on \? `CONNECTED/);
  assert.match(src("pages/Neurons.tsx"), /<Badge tone=\{a\.status === "live" \? "ok" : "shadow"\}>\{a\.status\}<\/Badge>/);
  assert.match(src("pages/Shadow.tsx"), /<Badge tone="ok">BETTER<\/Badge>/);
  assert.match(src("pages/Scorecards.tsx"), /const accuracyFill = \(v: number\) => \(v >= 0\.55 \? "bg-ok-fill" : v < 0\.45 \? "bg-fault-fill" : "bg-off-fill"\);/);
  assert.match(src("pages/Councils.tsx"), /support: \{ text: "agree", tone: "ok" \}, oppose: \{ text: "disagree", tone: "fault" \}/, "a vote is not a direction");
  // Where the value is a direction, it stays bull / bear with its glyph or word.
  const cal = src("pages/Calendar.tsx");
  assert.match(cal, /<span className="text-bull">gold ▲<\/span> : x < 0 \? <span className="text-bear">gold ▼<\/span>/);
  assert.match(cal, /surprise_lean > 0 \? "bull" : v\.outlook\.surprise_lean < 0 \? "bear" : "plain"/);
});

test("NF9 one red and one green: no emerald- or rose- anywhere under ui/src", () => {
  for (const [f, s] of ALL) assert.doesNotMatch(s, /\b(?:emerald|rose)-\d/, f);
  assert.ok(ALL.length > 50, `files scanned: ${ALL.length}`);
});

/** The files #518 left with tracked capitals on labels; codes in mono (LIVE, OPEN, the trade mode) stay as written. */
const LABEL_FILES = ["pages/Omega.tsx", "components/KeyLevels.tsx", "pages/Councils.tsx", "pages/Scorecards.tsx", "pages/Shadow.tsx", "components/OrganismCard.tsx", "components/LensPanel.tsx", "components/ExitConfirmModal.tsx", "components/ConfirmDialog.tsx"];

test("NF10 sentence-case labels without letter spacing, in the label grey; acronyms and codes keep their capitals", () => {
  for (const f of LABEL_FILES) {
    const hits = src(f).split("\n").filter((l) => /\buppercase\b/.test(l) && !/\bmono\b[^"`]*\buppercase\b/.test(l));
    assert.deepEqual(hits, [], `${f}: no CSS capitals on labels`);
    assert.doesNotMatch(src(f), /\btracking-(?!normal\b)[\w[\].-]+/, `${f}: no letter spacing`);
  }
  const shell = src("components/AppShell.tsx");
  const header = shell.slice(shell.indexOf("<header"), shell.indexOf("</header>") + 9);
  const outside = shell.replace(header, "");
  assert.doesNotMatch(outside, /\buppercase\b|\btracking-/, "the sidebar group headings, the soon tag and the footer");
  assert.match(shell, /<div className="mb-1\.5 px-3 text-\[11px\] font-medium text-muted">\{g\.title\}<\/div>/);
  for (const f of ["pages/Scorecards.tsx", "pages/Shadow.tsx"]) {
    assert.equal((src(f).match(/<div className="flex items-center gap-1\.5 text-\[11px\] font-medium text-muted">/g) ?? []).length, 4, `${f}: the four KPI labels`);
  }
  assert.match(src("components/KeyLevels.tsx"), /<div className="text-\[11px\] font-medium text-muted">\{name\}<\/div>/);
  assert.match(src("components/OrganismCard.tsx"), /<div className="text-\[11px\] font-medium text-muted">Omega control<\/div>/);
  const omega = src("pages/Omega.tsx");
  for (const t of ["BID (SELL)", "ASK (BUY)", "Type KILL to close every EA position and stop the EA", "Type LIVE to let Omega trade a real account"]) assert.ok(omega.includes(t), t);
});

test("NF11 Title Case labels and panel titles outside #518's lines are sentence case; names and acronyms kept", () => {
  const perf = src("pages/Performance.tsx").replace(/\{\/\*[\s\S]*?\*\/\}/g, ""); // shown text only, not comments
  for (const t of ["Omega Execution", "Avg Slippage", "Fill Quality", "Order Route", "Volatility & Sizing", "Signal vs Fill", "Closed Trades", "Win Rate", "Max Drawdown", "By Trading Mode", "Parity with Live", "Equity Curve", "Open Positions", "Recent Intents", "Held Back"]) assert.ok(!perf.includes(t), `Performance: ${t}`);
  for (const t of ["title=\"Omega execution\"", "label=\"Avg slippage\"", "label=\"Fill quality\"", "title=\"Order route\"", "title=\"Volatility & sizing\"", "title=\"Signal vs fill\"", "label=\"Closed trades\"", "label=\"Win rate\"", "label=\"Max drawdown\"", "title=\"By trading mode\"", "title=\"Omega v4 parity with live\"", "title=\"Equity curve\"", "title={`Open positions", "title={`Recent intents (", "title={`Held back ("]) assert.ok(perf.includes(t), `Performance: ${t}`);
  assert.ok(perf.includes("Signal Ledger"), "a proper name stays");
  const omega = src("pages/Omega.tsx");
  for (const t of ["Digits / point", "Tick size / val", "Volume min / max", "Volume step", "Stops level", "Profit ccy / contract", "Leverage / margin", "Freeze / trade mode", "Day start:", "Bid / ask"]) assert.ok(omega.includes(`>${t}<`), `Omega: ${t}`);
  for (const t of ["Market Watch", "Navigator", "Expert Advisors", "Decision Engine", "MT5 Terminal"]) assert.ok(omega.includes(t), `Omega keeps the MT5 and Nexus names: ${t}`);
  assert.ok(src("components/ExitConfirmModal.tsx").includes(">Open price<"));
});
