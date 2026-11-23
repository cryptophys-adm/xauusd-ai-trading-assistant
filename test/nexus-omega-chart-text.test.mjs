// The Omega chart's text (OM-TEXT; owner 2026-11-23: "yang diminta adalah pengurangan kosmetik text di chart bukan
// mengubah layout sebelumnya", less cosmetic text on the chart, not a new layout). pages/Omega.tsx Mt5ChartCanvas: one
// short label per line (lib/entryZone.ts CHART_LABEL, positionLines), its price only on the axis tag, the scale said once
// in the caption (chartScaleCaption), the credit kept, every line still drawn in its colour and style. Display only.
// The owner's review of the before/after (2026-11-23): "Bid ask sudah ada di side panel, tidak perlu lagi text di chart.
// Tidak usah juga pakai kata kata broker karena sumber data omega memang dari broker": no bid or ask text on the chart
// (the lines stay), and no "broker" in its text.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as ez from "../workers/xauusd-nexus-dashboard/ui/src/lib/entryZone.ts";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const omega = read("workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx");
const canvas = omega.slice(omega.indexOf("export function Mt5ChartCanvas("), omega.indexOf("// The profiles' caps"));
const OVERVIEW = JSON.parse(read("test/fixtures/nexus-ez1/omega-overview.json"));

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
/** The render check's registry, bundled as the render check bundles them (CommonJS, lightweight-charts on its stub). */
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export { VIEWS, render, OmegaChartView, OMEGA_NO_BASIS } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  return (bundled = m.exports);
}

test("OT1 the short labels and the one scale caption", () => {
  assert.deepEqual({ ...ez.CHART_LABEL }, { limit: "Limit", zone: "Zone", plan: "Plan", planSl: "Plan SL", planTp: "Plan TP", sl: "SL", tp: "TP" }, "no bid or ask label");
  for (const l of Object.values(ez.CHART_LABEL)) assert.doesNotMatch(l, /\d|broker|feed|·/i, l);
  assert.equal(ez.chartScaleCaption(0.42), "prices: feed · MT5 +0.42");
  assert.equal(ez.chartScaleCaption(-0.35), "prices: feed · MT5 −0.35");
  assert.equal(ez.chartScaleCaption(0), "prices: feed · MT5 +0.00", "a known basis of zero is still a basis");
  for (const b of [null, undefined, Number.NaN]) assert.equal(ez.chartScaleCaption(b), "prices: feed · MT5 lines not converted");
  for (const b of [0.42, null]) assert.doesNotMatch(ez.chartScaleCaption(b), /broker/i);
  // The caption follows the signal's own fields (feed_basis when feed_basis_known), as the conversion does.
  assert.equal(ez.chartScaleCaption(ez.knownFeedBasis(OVERVIEW.signal)), "prices: feed · MT5 +0.42");
  assert.equal(ez.chartScaleCaption(ez.knownFeedBasis({ ...OVERVIEW.signal, feed_basis_known: false })), "prices: feed · MT5 lines not converted");
  // The old titles' helpers are gone (no other page used them).
  for (const f of ["quoteTitle", "limitTitle", "chartZoneLabel"]) assert.equal(ez[f], undefined, f);
  // A position: side and lot, then SL and TP; no ticket, no price, no scale.
  const pos = { ticket: 50128, side: "BUY", volume: 0.1, open_price: 2686.02, sl: 2680.82, tp: 2692.02 };
  assert.deepEqual(ez.positionLines(pos, 0.42).map((l) => l.title), ["BUY 0.10", "SL", "TP"]);
  assert.deepEqual(ez.positionLines({ open_price: 2686.02 }, 0.42).map((l) => l.title), ["Position"], "no side and no lot");
});

test("OT2 every line is drawn as before, in its colour and style; a short label and no price in it, none on the bid and ask", () => {
  // The calls, their colours and styles (the labels are the only change).
  for (const re of [
    /addLine\(feedBid, "", T\.bullFill, LineStyle\.Solid, 1, false\);/,
    /addLine\(feedAsk, "", T\.bearFill, LineStyle\.Solid, 1, false\);/,
    /addLine\(bid, "", T\.bullFill, LineStyle\.Solid, 1\);/,
    /addLine\(ask, "", T\.bearFill, LineStyle\.Solid, 1\);/,
    /addLine\(signal\.entry, CHART_LABEL\.plan, T\.okFill, LineStyle\.Dashed, 1\);/,
    /addLine\(signal\.stop, CHART_LABEL\.planSl, T\.bearFill, LineStyle\.Dashed, 1\);/,
    /addLine\(signal\.tp1, CHART_LABEL\.planTp, T\.bullFill, LineStyle\.Dashed, 1\);/,
    /addLine\(limitFeed, CHART_LABEL\.limit, limit\.side === "SELL" \? T\.bearFill : T\.bullFill, LineStyle\.Dashed, 1\);/,
    /if \(l\.kind === "entry"\) addLine\(l\.price, l\.title, isBuy \? T\.bullFill : T\.bearFill, LineStyle\.Solid, 2\);/,
    /else addLine\(l\.price, l\.title, l\.kind === "sl" \? T\.bearFill : T\.bullFill, LineStyle\.Dotted, 1\);/
  ]) assert.match(canvas, re);
  assert.equal((canvas.match(/\baddLine\(/g) ?? []).length, 10, "ten calls, as before");
  // The bid and ask: lines only, no label (the side panel shows them); the zone's label short.
  assert.doesNotMatch(canvas, /labels\.push|CHART_LABEL\.(bid|ask)/);
  assert.match(canvas, /labels\.unshift\(\{ low: zoneFeed\.low, high: zoneFeed\.high, color: T\.okFill, alpha: 0\.16, text: T\.ok, label: CHART_LABEL\.zone \}\)/);
  // No title or label is a template with a price or a scale any more.
  for (const old of ["BID broker", "ASK broker", ">Bid<", ">Ask<", "spreadPoints", "· broker", "PLAN ${", "PLAN SL", "PLAN TP1", "quoteTitle", "limitTitle", "chartZoneLabel", "Entry zone · feed", "const narrow"]) assert.ok(!canvas.includes(old), old);
  // The key levels keep their label (role, strength and the price range: owner 2026-11-12; a band has no axis tag).
  assert.match(canvas, /label: `KL \$\{KEY_ROLE_SHORT\[z\.role \?\? ""\] \?\? "zone"\} · \$\{z\.strength \?\? "—"\} · /);
});

test("OT3 around the chart: the scale once in the caption, no footer prose, no quote, no \"broker\"; the credit kept", () => {
  assert.match(canvas, /<span>\{chartScaleCaption\(feedBasis\)\}<\/span>\n\s+<span><ChartCredit \/><\/span>/, "one caption line, then the credit");
  for (const old of ["candles, PLAN lines", "(intents[].entry_zone", "not converted (the basis is unknown)", ">feed<", "(feed {", "V {Math.round"]) assert.ok(!canvas.includes(old), old);
  // The overlay keeps the symbol and the bars' OHLC (no quote: the side panel's), the time axis its GMT+7.
  assert.match(canvas, /<span className=\{last\.close >= last\.open \? "text-bull" : "text-bear"\}>C \{num\(last\.close, digits\)\}<\/span>\n\s+<\/div>/);
  // No "broker" in any text the chart shows (JSX text and string literals; identifiers and comments may keep it).
  const shown = canvas.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const m of shown.matchAll(/"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)) assert.doesNotMatch(m[1] ?? m[2] ?? m[3], /\bbroker\b/i, m[0]);
  assert.equal((canvas.match(/>GMT\+7<\/span>/g) ?? []).length, 1);
  // The layout: the same boxes as before.
  for (const c of ["relative flex h-full min-h-[430px] w-full flex-1 flex-col bg-ground", "relative min-h-[380px] flex-1", "pointer-events-none absolute left-2.5 top-2 z-10 flex max-w-[calc(100%-5.5rem)]"]) assert.ok(canvas.includes(c), c);
});

test("OT4 the rendered chart: the caption for a known and an unknown basis, once; the render check's views", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  const known = u.render(u.OmegaChartView, OVERVIEW);
  const unknown = u.render(u.OmegaChartView, u.OMEGA_NO_BASIS);
  for (const [html, caption] of [[known, "prices: feed · MT5 +0.42"], [unknown, "prices: feed · MT5 lines not converted"]]) {
    const t = text(html);
    assert.equal(t.split(caption).length - 1, 1, `${caption} once in ${t}`);
    assert.equal((html.match(/Charts by TradingView/g) ?? []).length, 1);
    assert.equal(t.split("prices:").length - 1, 1, "the scale said once");
    assert.ok(!/\(feed|candles, PLAN|basis \(intents/.test(t), t);
    assert.ok(!/\bbroker\b|Bid|Ask|22 pts|2684\.64|2684\.86/.test(t), `no quote and no "broker": ${t}`);
  }
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["OmegaChartCaption", "OmegaChartCaptionNoBasis"]) assert.ok(names.includes(n), n);
});
