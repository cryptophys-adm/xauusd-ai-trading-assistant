// The lightweight-charts licence's attribution on every Nexus chart (a reviewer ruling after OM-LEAN #553): the library's
// logo injects a <style> that the CSP blocks, so every createChart sets layout.attributionLogo false, and each page with
// a chart shows a quiet "Charts by TradingView" caption link (components/ui.tsx ChartCredit).
// The charts: components/IntelChart.tsx (Liquidity, Chart patterns), components/PriceChart.tsx (War Room) and the Omega
// page's chart (pages/Omega.tsx Mt5ChartCanvas, its caption under the chart since the OM-LEAN revert).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fixture = (f) => JSON.parse(read(`test/fixtures/${f}`));
const files = (dir = `${UI}src`) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
/** The link, as ChartCredit renders it: the TradingView site in a new tab, no opener, no referrer. */
const LINK = /<a href="https:\/\/www\.tradingview\.com\/" target="_blank" rel="noopener noreferrer"[^>]*>Charts by TradingView<\/a>/;

/** Each createChart(...) call's own text, its parentheses matched. */
function calls(src) {
  const out = [];
  for (let i = src.indexOf("createChart("); i >= 0; i = src.indexOf("createChart(", i + 1)) {
    let depth = 0, j = i + "createChart".length;
    for (; j < src.length; j++) { if (src[j] === "(") depth++; else if (src[j] === ")" && --depth === 0) break; }
    out.push(src.slice(i, j + 1));
  }
  return out;
}

test("CA1 every createChart in the UI sets attributionLogo false, and each chart's file shows the caption link", () => {
  const withChart = files().filter((f) => /\.(tsx?|mjs)$/.test(f)).map((f) => [f.slice(UI.length), readFileSync(f, "utf8")]).filter(([, s]) => s.includes("createChart("));
  assert.deepEqual(withChart.map(([f]) => f).sort(), ["src/components/IntelChart.tsx", "src/components/PriceChart.tsx", "src/pages/Omega.tsx"], "the three charts");
  for (const [f, s] of withChart) {
    const cs = calls(s);
    assert.ok(cs.length >= 1, f);
    for (const c of cs) assert.match(c, /layout: \{(?:[^{}]|\{[^{}]*\})*\battributionLogo: false\b/, `${f}: the library's logo off (layout.attributionLogo)`);
    assert.ok(/<ChartCredit \/>/.test(s) || /href="https:\/\/www\.tradingview\.com\/" target="_blank" rel="noopener noreferrer"[^>]*>Charts by TradingView</.test(s), `${f}: the caption link`);
  }
  const ui = read("workers/xauusd-nexus-dashboard/ui/src/components/ui.tsx");
  assert.match(ui, /export const TRADINGVIEW_URL = "https:\/\/www\.tradingview\.com\/";/);
  assert.match(ui, /<a href=\{TRADINGVIEW_URL\} target="_blank" rel="noopener noreferrer" className="text-fg-2 underline decoration-white\/20 hover:text-fg">Charts by TradingView<\/a>/, "the quiet style");
  // No other chart library draws in the UI (a second one would need its own attribution).
  const pkg = JSON.parse(read("workers/xauusd-nexus-dashboard/ui/package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies).filter((d) => /chart|plot|d3|echarts|highcharts/i.test(d)), ["lightweight-charts"]);
});

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";

test("CA2 each page with a chart renders the caption link: Liquidity, Chart patterns, War Room, Omega", { skip: NO_UI_DEPS }, async () => {
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export { LiquidityView } from "./src/pages/Liquidity"; export { default as PriceChart } from "./src/components/PriceChart"; export { Mt5ChartCanvas } from "./src/pages/Omega"; export { render, VIEWS, LIQUIDITY_NOW } from "./scripts/render-entry"; export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  const u = m.exports;
  const view = (name) => u.VIEWS.find((v) => v.name === name);
  // Liquidity: its 15m chart with candles (the render check's entry has none, so the chart is the Empty there).
  const liq = fixture("nexus-intel/liquidity.json");
  const t0 = Math.floor(liq.state.at_ms / 1000 / 900) * 900 - 3 * 900;
  const candles = { candles: [0, 1, 2].map((i) => ({ time: t0 + i * 900, open: 4100, high: 4102, low: 4098, close: 4101 })) };
  const liquidity = u.render(({ d }) => u.LiquidityView({ d, lens: fixture("nexus-intel/lens.json"), decision: fixture("nexus-intel/engine-decision.json"), candles, now: u.LIQUIDITY_NOW }), liq);
  assert.match(liquidity, LINK, "Liquidity");
  assert.equal((liquidity.match(/Charts by TradingView/g) ?? []).length, 1, "once, under its one chart");
  const noCandles = u.render(({ d }) => u.LiquidityView({ d, now: u.LIQUIDITY_NOW }), liq);
  assert.doesNotMatch(noCandles, /Charts by TradingView/, "no chart drawn, no credit");
  // Chart patterns: the registry's own entry, its chart drawn from the fixture's candles.
  const patterns = view("PatternsView");
  assert.match(u.render(patterns.View, patterns.fixture), LINK, "Chart patterns");
  // War Room: the PriceChart panel's footer.
  assert.match(u.renderToStaticMarkup(u.createElement(u.PriceChart)), LINK, "War Room");
  // Omega: the chart's caption, under the terminal's chart (the page as before OM-LEAN), once.
  const omega = u.renderToStaticMarkup(u.createElement(u.Mt5ChartCanvas, { tf: "M15", symbol: "XAUUSD", server: "", digits: 2, signal: null, positions: [], showBidAsk: true, showPlan: true, showPositions: true, keyZones: [], showKeyLevels: true, feedBasis: null, limit: null }));
  assert.match(omega, LINK, "Omega");
  assert.equal((omega.match(/Charts by TradingView/g) ?? []).length, 1, "once, in the chart's caption");
  assert.match(omega, /candles, PLAN lines: TradingView feed · times GMT\+7<\/span>.*<a href="https:\/\/www\.tradingview\.com\/"/s, "in the caption, after its scale lines");
});
