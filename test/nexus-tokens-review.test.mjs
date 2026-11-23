// The review of #518 (Nexus colours and text): the short edge in red, dark text on the green, amber and red axis tags,
// the zone labels in the text tokens, acronyms in capitals, status in the status tones on the War Room cards, and one
// red and one green (the bull and bear tokens) for SELL/BUY and SL/TP.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { T, TEXT, contrast, directionTone, edgeTone, tagText } from "../workers/xauusd-nexus-dashboard/ui/src/lib/tokens.ts";
import { humanKey } from "../workers/xauusd-nexus-dashboard/ui/src/lib/format.ts";

const src = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/src/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The files the review edits. */
const REVIEW_FILES = [
  "components/GlobalDecision.tsx", "components/PriceChart.tsx", "components/charts.tsx", "components/AssistantPanel.tsx",
  "components/FeedFallbackCard.tsx", "components/ShadowSwitchCard.tsx", "components/Roster.tsx", "components/OrganismCard.tsx",
  "components/KeyLevels.tsx", "pages/Omega.tsx", "pages/Performance.tsx", "pages/Councils.tsx", "lib/tokens.ts", "lib/format.ts",
  // Track C1: LensView, split from the polled LensPanel.
  "components/LensPanel.tsx"
];

test("NR1 the model's edge: a favoured short is red, a favoured long green (both rows by their own side)", () => {
  assert.equal(edgeTone("short", 0.62 - 0.48), "bear", "short_target_first 0.62 vs base 0.48 (+14 pts) favours the short");
  assert.equal(edgeTone("short", -0.1), "bull", "a short below its base rate leans long");
  assert.equal(edgeTone("long", 0.14), "bull");
  assert.equal(edgeTone("long", -0.14), "bear");
  for (const d of [null, undefined, 0, Number.NaN]) assert.equal(edgeTone("short", d), "plain");
  const gd = src("components/GlobalDecision.tsx");
  const advice = gd.slice(gd.indexOf("function ModelAdvice"), gd.indexOf("function MarketContext"));
  assert.match(advice, /TEXT\[edgeTone\(x\.k === "Short" \? "short" : "long", d\)\]/, "each row by its own side");
  assert.doesNotMatch(advice, /T\.bull|T\.bear/, "no sign-only colour");
  assert.equal(TEXT.bear, "text-bear");
});

test("NR2 axis tags: dark text on the green, amber, red and cyan fills (4.5:1 or more)", () => {
  for (const fill of [T.bullFill, T.bearFill, T.neutralFill, T.okFill]) {
    assert.equal(tagText(fill), T.ground, fill);
    assert.ok(contrast(tagText(fill), fill) >= 4.5, `${fill}: ${contrast(tagText(fill), fill).toFixed(2)}:1`);
  }
  assert.ok(contrast("#ffffff", T.bullFill) < 4.5 && contrast("#ffffff", T.bearFill) < 4.5, "white failed on both");
  assert.ok(contrast(tagText("#2962ff"), "#2962ff") >= 4.5, "white stays where it reads better (Fib 1.618 blue)");
  for (const f of ["components/PriceChart.tsx", "pages/Omega.tsx"]) {
    const s = src(f);
    const lines = s.match(/createPriceLine\(\{[^}]*\}/g) ?? [];
    assert.ok(lines.length >= 2, `${f}: price lines found`);
    for (const l of lines) assert.match(l, /axisLabelTextColor: tagText\(color\)|\.\.\.opts/, `${f}: ${l.slice(0, 80)}`);
    assert.match(s, /lastValueVisible: false/, `${f}: the candle's last price is our own line with dark text`);
  }
  assert.match(src("pages/Omega.tsx"), /const opts = \{ price: close, color, axisLabelTextColor: tagText\(color\) \}/);
});

test("NR3 Omega's key-level labels are in the text tokens, not the fill at 85%", () => {
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /const KEY_ROLE_TEXT: Record<string, string> = \{ support: T\.bull, resistance: T\.bear, "at price": T\.ok \};/);
  assert.match(omega, /text: KEY_ROLE_TEXT\[z\.role \?\? ""\] \?\? T\.fg2/);
  assert.doesNotMatch(omega, /withAlpha\(base, 0\.85\)/);
  for (const c of [T.bull, T.bear, T.ok]) assert.ok(contrast(c, T.ground) >= 4.5 && contrast(c, T.panel) >= 4.5, c);
});

test("NR4 labels from keys keep acronyms in capitals (Councils evidence tables)", () => {
  assert.deepEqual(
    ["mfe_r", "mae_r", "entry_shift_atr", "range_atr", "sl_moves", "tp_moves", "tv_budget", "ev_r", "pf", "max_dd_r", "ema114_gap", "vwap_dist", "poc", "vah", "val", "kww_z", "utc_hour", "ea_version", "id", "h1_regime", "tp1_hit"].map(humanKey),
    ["MFE R", "MAE R", "Entry shift ATR", "Range ATR", "SL moves", "TP moves", "TV budget", "EV R", "PF", "Max DD R", "EMA114 gap", "VWAP dist", "POC", "VAH", "VAL", "KWW z", "UTC hour", "EA version", "ID", "H1 regime", "TP1 hit"]
  );
  assert.equal(humanKey("trades"), "Trades", "other words in sentence case");
  assert.equal(humanKey("win_rate"), "Win rate");
  const councils = src("pages/Councils.tsx");
  assert.match(councils, /import \{ ago, humanKey, utc \} from "\.\.\/lib\/format";/);
  assert.match(councils, /const human = humanKey;/);
});

test("NR5 status on the War Room cards is ok / late / fault / off, not the bull green", () => {
  // Re-review of #518: legacy tone names inside a Record ("green" draws bull) are caught too.
  const councils = src("pages/Councils.tsx");
  for (const name of ["KIND", "PLATFORM_STATE"]) {
    const block = councils.slice(councils.indexOf(`const ${name}:`), councils.indexOf("};", councils.indexOf(`const ${name}:`)));
    assert.doesNotMatch(block, /tone: "(green|red|amber|cyan)"/, `${name} uses state tones, not legacy direction names`);
  }
  assert.match(councils, /merged: \{ text: "merged", tone: "ok" \}/);
  assert.match(src("pages/Omega.tsx"), /pending: "late",\n  sent: "late",/, "an intent in flight is late, not done");
  assert.match(src("components/GlobalDecision.tsx"), /r\.rr >= minRrr \? "text-ok" : "text-late"/, "the R check is pass/fail");
  assert.match(src("components/OrganismCard.tsx"), /market === "open" \? "text-ok" : "text-off"/, "CLOSED is grey, like its dot");
  assert.match(src("components/AssistantPanel.tsx"), /<Badge tone=\{open \? "ok" : "off"\}>\{open \? "market open" : "market closed"\}<\/Badge>/);
  assert.match(src("components/FeedFallbackCard.tsx"), /<Dot tone=\{state\.active \? "late" : "ok"\}/);
  // Follow-up of #518: OFF by the owner is off (grey, still); only the cost breaker's stop is a fault.
  assert.match(src("components/ShadowSwitchCard.tsx"), /const tone = !known \? "off" : !state\?\.allowed \? \(breaker \? "fault" : "off"\) : share >= 0\.8 \? "late" : "ok";/);
  assert.match(src("components/Roster.tsx"), /verified \? "text-ok"/);
  assert.match(src("components/OrganismCard.tsx"), /<Dot tone=\{market === "open" \? "ok" : "off"\}/);
  assert.match(src("components/KeyLevels.tsx"), /verified \? "text-ok" : "text-muted"/);
  const perf = src("pages/Performance.tsx");
  assert.match(perf, /Math\.abs\(itSlip\) <= 3 \? T\.ok :/, "intent slippage as the Disparity panel");
  assert.match(perf, /t\.same_exit \? T\.ok : undefined/, "same exit cyan, as the yes beside it");
  // Track C1, the lens badges: on ok / switched off off, at floor late, the CFTC report fresh ok / stale late, lens B's
  // baseline sufficient ok / insufficient late (anything else off), the mode in sentence case. Never the bull green.
  const lens = src("components/LensPanel.tsx");
  assert.match(lens, /<Badge tone=\{on \? "ok" : "off"\}>\{on \? "on" : "switched off"\}<\/Badge>/);
  assert.match(lens, /<Badge tone="late">at floor<\/Badge>/);
  assert.match(lens, /cot\?\.stale === true \? <Badge tone="late">stale<\/Badge> : cot\?\.stale === false \? <Badge tone="ok">fresh<\/Badge> : null/);
  assert.match(lens, /export const BASELINE_TONE: Record<string, Tone> = \{ sufficient: "ok", insufficient: "late" \};/);
  assert.match(lens, /export const baselineTone = \(x: unknown\): Tone => BASELINE_TONE\[str\(x\) \?\? ""\] \?\? "off";/);
  assert.match(lens, /Baseline: <Badge tone=\{baselineTone\(b\)\}>/);
  assert.match(lens, /\{mode \? `\$\{mode\} mode` : "Mode unknown"\}/, "\"Intraday mode\", not \"mode intraday\"");
  assert.match(lens, /const SOURCE: Record<string, string> = \{ anchor: "Anchor", aether: "Aether", floor_rollback: "Floor", switch_off: "Off", anchor_baseline_insufficient: "Anchor \(baseline\)" \};/);
  const tones = [...lens.matchAll(/tone=\{?"([a-z]+)"|tone=\{[^}]*\? "([a-z]+)" : "([a-z]+)"\}|: "(ok|late|off|fault)"/g)].flatMap((m) => m.slice(1).filter(Boolean));
  assert.ok(tones.length >= 6, `lens tones found: ${tones.length}`);
  for (const t of tones) assert.ok(["ok", "late", "off", "plain"].includes(t), `LensPanel: ${t}`);
  assert.doesNotMatch(lens, /"(green|bull)"|text-(bull|green|emerald)|text-ok"|text-late"/, "the states are chips in ok / late / off, never the bull green");
  for (const f of REVIEW_FILES.filter((x) => x.endsWith(".tsx"))) {
    assert.doesNotMatch(src(f), /tone=\{?[^}\n]*"green"/, `${f}: no legacy green tone (it is the bull green)`);
  }
});

test("NR7 one red and one green: SELL/BUY and SL/TP in the bear and bull text tokens", () => {
  const omega = src("pages/Omega.tsx"), perf = src("pages/Performance.tsx");
  assert.match(omega, /<td className=\{`mono font-bold \$\{isBuy \? "text-bull" : "text-bear"\}`\}>\{p\.side\}<\/td>/);
  // Follow-up of #518: the "—" of a missing SL or TP is muted, not red or green.
  assert.match(omega, /<td className=\{`mono \$\{p\.sl \? "text-bear" : "text-muted"\}`\}>\{p\.sl \? num\(p\.sl, digits\) : "—"\}<\/td>/);
  assert.match(omega, /<td className=\{`mono \$\{p\.tp \? "text-bull" : "text-muted"\}`\}>\{p\.tp \? num\(p\.tp, digits\) : "—"\}<\/td>/);
  assert.match(perf, /\$\{t\.side === "BUY" \? "text-bull" : "text-bear"\}/, "the parity table");
  assert.match(perf, /\$\{h\.side === "BUY" \? "text-bull" : "text-bear"\}/, "the history table");
  assert.match(perf, /<td className="mono text-bear">\{px\(x\.stop\)\}<\/td>/);
  assert.match(perf, /<td className="mono text-bull">\{px\(x\.tp1\)\}<\/td>/);
  for (const s of [omega, perf]) assert.doesNotMatch(s, /#fda4af|#6ee7b7|emerald-300|rose-300/i);
});

test("NR8 the 15m setup's name is coloured by its side", () => {
  assert.equal(directionTone("SHORT"), "bear");
  assert.equal(directionTone("LONG"), "bull");
  const kl = src("components/KeyLevels.tsx");
  assert.match(kl, /`font-semibold \$\{TEXT\[directionTone\(g\.strategy\.direction\)\]\}`/);
  assert.doesNotMatch(kl, /font-semibold text-emerald/);
});

test("NR9 no emerald- or rose- classes in the files the review edits", () => {
  for (const f of REVIEW_FILES) assert.doesNotMatch(src(f), /\b(?:emerald|rose)-\d/, f);
});

test("NR10 the nits: the bar's colour from the scaled value, SL+ its own hue, the legend dot follows the curve, no wrap", () => {
  const charts = src("components/charts.tsx");
  assert.match(charts, /background: leanFill\(v\)/, "DivergingBar: the same scaled value as its width");
  const pc = src("components/PriceChart.tsx");
  assert.match(pc, /const SL_PLUS = "#38bdf8";/);
  assert.match(pc, /line\(p\.progressive_stop, "SL\+", SL_PLUS, LineStyle\.Dashed\)/);
  assert.doesNotMatch(pc, /"SL\+", T\.neutralFill/, "not the KWW yellow");
  const perf = src("pages/Performance.tsx");
  // Part B of "Nexus data states" moved the legend under the title; its swatch takes the curve's colour.
  assert.match(perf, /const lineColor = \(last\?\.r \?\? 0\) >= 0 \? T\.bullFill : T\.bearFill;/);
  assert.match(perf, /<Swatch color=\{lineColor\} \/>Equity/);
  // Review of #526: the drawdown's line, area and marker in the bear fill, the card's Peak in the off grey.
  const charts526 = perf.slice(perf.indexOf("function EquityDrawdownCharts"), perf.indexOf("type Policy ="));
  assert.match(charts526, /<path d=\{m\.ddArea\} fill=\{T\.bearFill\} fillOpacity=\{0\.12\} \/>/, "the drawdown area");
  assert.match(charts526, /<path d=\{m\.ddLine\} fill="none" stroke=\{T\.bearFill\} strokeWidth=\{2\} strokeLinejoin="round" className="chart-series" \/>/, "the drawdown line");
  assert.match(charts526, /<circle cx=\{m\.ddMark\.x\} cy=\{m\.ddMark\.y\} r=\{4\} fill=\{T\.bearFill\}/, "the deepest point's marker");
  assert.match(charts526, /<circle cx=\{ax\} cy=\{Yd\(row\.dd\)\} r=\{3\.5\} fill=\{T\.bearFill\}/, "the crosshair's drawdown point");
  assert.match(charts526, /\["Peak", f\.peak, T\.off, 1, 0\.8\], \["Drawdown", f\.dd, T\.bearFill, 2, 1\]/, "the card: Peak grey, Drawdown red");
  assert.match(charts526, /\["Equity", f\.equity, lineColor, 2, 1\]/);
  assert.doesNotMatch(charts526, /emerald|rose|#fb7185|#34d399/i, "never emerald or rose");
  for (const t of ["Last sync", "Risk / trade", "Profit factor"]) assert.ok(perf.includes(t), t);
  for (const t of ["Last Sync", "Risk / Trade", "Profit Factor"]) assert.ok(!perf.includes(t), t);
  assert.match(src("components/AssistantPanel.tsx"), /<SectionToggle title="Decision & plan"/);
  // Follow-up of #518: w-36 hid the lean bar beside a status tag; w-32, cut with its full text in the title.
  assert.match(src("components/GlobalDecision.tsx"), /<span className="w-32 shrink-0 truncate text-right text-\[11px\]" style=\{\{ color: leanColor\(r\.lean\) \}\} title=\{leanText\(r\.lean\)\}>\{leanText\(r\.lean\)\}<\/span>/);
});
