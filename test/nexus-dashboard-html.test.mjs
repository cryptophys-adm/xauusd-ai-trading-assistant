import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// The Nexus Worker serves the React SPA in workers/xauusd-nexus-dashboard/ui (the Cerebrum
// Console obsidian design) as Workers Static Assets and keeps read-only data routes. This test
// bundles the Worker as wrangler does and calls its fetch handler with a fake ASSETS binding.
const root = new URL("..", import.meta.url).pathname;
async function loadWorker() {
  const out = await build({ entryPoints: [join(root, "workers/xauusd-nexus-dashboard/src/index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent" });
  const dir = mkdtempSync(join(tmpdir(), "nexus-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod.default;
}
const worker = await loadWorker();
const assets = { requests: [], async fetch(req) { this.requests.push(new URL(req.url).pathname); return new Response("<!doctype html><div id=\"root\"></div>", { headers: { "content-type": "text/html" } }); } };

test("the SPA is served from the assets binding; the HTML shell is never cached, hashed bundles are immutable", async () => {
  const page = await worker.fetch(new Request("https://nexus.test/"), { ASSETS: assets });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="root"/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const bundle = await worker.fetch(new Request("https://nexus.test/assets/index-abc.js"), { ASSETS: assets });
  assert.match(bundle.headers.get("cache-control"), /immutable/);
  assert.deepEqual(assets.requests, ["/", "/assets/index-abc.js"]);
});

test("earlier page paths redirect into the SPA", async () => {
  const shadow = await worker.fetch(new Request("https://nexus.test/shadow"), { ASSETS: assets });
  assert.equal(shadow.status, 302);
  assert.equal(shadow.headers.get("location"), "https://nexus.test/#/shadow");
  assert.equal((await worker.fetch(new Request("https://nexus.test/dashboard"), {})).headers.get("location"), "https://nexus.test/");
});

test("Nexus is read-only: no write method reaches the AI Worker, and missing bindings fail closed", async () => {
  const post = await worker.fetch(new Request("https://nexus.test/api/war-room/latest", { method: "POST", body: "{}" }), {});
  assert.equal(post.status, 405);
  assert.equal((await worker.fetch(new Request("https://nexus.test/api/status"), {})).status, 503, "no public fallback: the AI Worker is reached only through its binding");
  const seen = [];
  const aiWorker = { async fetch(req) { seen.push([req.method, new URL(req.url).pathname + new URL(req.url).search]); return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } }); } };
  const proxied = await worker.fetch(new Request("https://nexus.test/api/aether/status?x=1"), { AI_WORKER: aiWorker });
  assert.equal(proxied.status, 200);
  assert.deepEqual(seen, [["GET", "/api/aether/status?x=1"]], "proxied through the AI_WORKER binding");
  assert.equal((await worker.fetch(new Request("https://nexus.test/api/status", { method: "DELETE" }), { AI_WORKER: aiWorker })).status, 405);
  assert.equal((await worker.fetch(new Request("https://nexus.test/api/ohlcv"), {})).status, 503);
  assert.equal((await worker.fetch(new Request("https://nexus.test/api/local-lane"), {})).status, 503);
});

test("the UI keeps the Console's obsidian palette and calls only same-origin read routes", () => {
  const ui = (p) => readFileSync(join(root, "workers/xauusd-nexus-dashboard/ui", p), "utf8");
  assert.match(ui("tailwind.config.js"), /obsidian: \{ DEFAULT: "#05070c"/);
  // Owner decisions 2026-11-06: the War Rooms of every timeframe sit under the chart in one card,
  // tabs News | 15m | 1H | 4H | D1, every page load opens on News, each tab starts with its
  // conclusion, and the active tab drives the agents panel and the timeframe charts.
  const tabs = ui("src/lib/tab.tsx");
  assert.match(tabs, /\[\["NEWS", "News"\], \["M15", "15m"\], \["H1", "1H"\], \["H4", "4H"\], \["D1", "D1"\]\]/);
  assert.match(tabs, /useState<Tab>\("NEWS"\)/);
  assert.doesNotMatch(tabs, /localStorage/, "the tab is not remembered: each load opens on News");
  const panel = ui("src/components/ThreadsPanel.tsx");
  assert.match(panel, /useTab\(\)/);
  assert.ok(panel.indexOf("<ConclusionHero") < panel.indexOf("<Discussion"), "each room tab starts with its conclusion");
  // Owner decision 2026-11-06: the conclusion shows the decision and the room's bias separately.
  assert.match(panel, />Decision</);
  assert.match(panel, />Bias</);
  assert.match(ui("src/components/Roster.tsx"), /useTab\(\)/, "the agents panel follows the active tab");
  const market = ui("src/lib/market.tsx");
  for (const route of ["/api/threads/timeframe?chart=", "/api/news/daily", "/api/m5-context", "/api/conclusion/global"]) assert.ok(market.includes(route), route);
  const page = ui("src/pages/WarRoom.tsx");
  assert.ok(page.indexOf("<PriceChart />") < page.indexOf("<ThreadsPanel"), "the rooms sit under the chart");
  assert.doesNotMatch(page, /LiveWarRoom|WarRoomConclusion/, "no separate 15m cards: they repeated the 15m tab");
  // The right panel is the trading assistant, as charts, with the Global Conclusion first.
  const assistant = ui("src/components/AssistantPanel.tsx");
  assert.match(assistant, /\/api\/hud\/levels\?tf=/);
  // Owner decision 2026-11-06: the Global Conclusion and the strategy engine are one card, the
  // Global decision, which leads the panel: decision, bias, per-timeframe lean, plan, RRR.
  const decision = ui("src/components/GlobalDecision.tsx");
  for (const word of ["Global decision", "Decision", "Bias", "Direction", "Lean:", "TP1", "TP2", "Stop", "Entry", "R</span>", "H1 chain (reference)"]) assert.ok(decision.includes(word), word);
  assert.ok(assistant.indexOf("<GlobalDecision") >= 0 && assistant.indexOf("<GlobalDecision") < assistant.indexOf("<SentimentCard"), "the global decision leads the right panel");
  assert.doesNotMatch(assistant, /GlobalConclusion|StrategyPanel/, "the two former cards are merged");
  // Key Level Agent (owner decision 2026-11-06): the candidate zones of every chart's key levels.
  // Backlog item 18 (owner approval 2026-11-09): one Key levels panel with the active tab's
  // Camarilla set and the agent's zones on one price axis, replacing the Levels card.
  const keyLevels = ui("src/components/KeyLevels.tsx");
  for (const word of ["Key levels", "Key Level Agent", "candidate zones", "key_levels", "sources", "camarilla", "Camarilla · pivots", "Zones · every chart", "KeyLevelMap"]) assert.ok(keyLevels.includes(word), word);
  assert.match(keyLevels, /gradientUnits="userSpaceOnUse"/, "the price line paints on a zero-height line");
  assert.match(keyLevels, /useId\(\)\.replace\(\/:\/g, ""\)/, "no colon in a url(#…) reference");
  assert.ok(assistant.indexOf("<KeyLevels") > assistant.indexOf("<GlobalDecision"), "the zones follow the decision");
  assert.doesNotMatch(assistant, /LevelsCard|<KeyLevelAgent|LevelLadder/, "the Levels card and the Key Level Agent panel are one panel");
  // Owner request 2026-11-06: the zones are drawn on the chart, with the plan's price lines.
  const chartSrc = ui("src/components/PriceChart.tsx");
  assert.match(chartSrc, /attachPrimitive\(zonesRef\.current\)/);
  for (const word of ["key_levels?.candidates", "createPriceLine", "\"Stop\"", "TP1", "TP2", ">Zones<"]) assert.ok(chartSrc.includes(word), word);
  assert.match(ui("src/lib/zones-primitive.ts"), /drawBackground/, "the bands sit behind the candles");
  for (const card of ["Market sentiment", "Trend by timeframe", "Macro trend", "Intraday trend", "Swing trend", "Structure", "Confirmation", "Levels", "Regime", "Agent consensus", "Macro drivers", "Session clock"]) assert.ok(assistant.includes(card), card);
  assert.ok(assistant.indexOf("<GlobalConclusion />") < assistant.indexOf("<SentimentCard />"), "the Global Conclusion comes first");
  const api = ui("src/lib/api.ts");
  assert.doesNotMatch(api, /method:\s*"(POST|PUT|DELETE)"/);
  const wrangler = readFileSync(join(root, "workers/xauusd-nexus-dashboard/wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"directory": "\.\/ui\/dist"/);
});

test("a grouped left sidebar routes the analytic layers; the Performance page reads the Signal Ledger in R", () => {
  const ui = (p) => readFileSync(join(root, "workers/xauusd-nexus-dashboard/ui", p), "utf8");
  const shell = ui("src/components/AppShell.tsx");
  for (const group of ['title: "Live"', 'title: "Analytics"', 'title: "Market"', 'title: "Intelligence"']) assert.ok(shell.includes(group), group);
  assert.match(shell, /<aside[^>]*aria-label="Nexus"/);
  assert.match(shell, /key: "performance"/);
  assert.match(ui("src/App.tsx"), /performance: Performance/);
  const perf = ui("src/pages/Performance.tsx");
  assert.ok(perf.includes("/api/ledger?days=30"));
  assert.match(perf, /never money/);
  assert.doesNotMatch(perf, /lot size|balance|equity \$|position size/i, "advisory only: R multiples, never money or size");
});

test("Omega: /omega and /omega/* are forwarded unchanged to the xauusd-omega Worker (OMEGA_PAGE), nothing else is", async () => {
  const forwarded = [];
  const OMEGA_PAGE = { async fetch(req) { forwarded.push([req.method, new URL(req.url).pathname, req.headers.get("cf-access-jwt-assertion"), await req.text()]); return new Response("omega", { status: 200 }); } };
  const env = { ASSETS: assets, OMEGA_PAGE };
  const post = new Request("https://nexus.test/omega/api/settings", { method: "POST", body: "{\"enabled\":true}", headers: { "cf-access-jwt-assertion": "jwt", "content-type": "application/json" } });
  assert.equal(await (await worker.fetch(post, env)).text(), "omega");
  assert.equal((await worker.fetch(new Request("https://nexus.test/omega"), env)).status, 200);
  assert.deepEqual(forwarded, [["POST", "/omega/api/settings", "jwt", "{\"enabled\":true}"], ["GET", "/omega", null, ""]]);
  for (const path of ["/omegax", "/api/omega", "/omega.js"]) {
    await worker.fetch(new Request(`https://nexus.test${path}`), env);
  }
  assert.equal(forwarded.length, 2, "only the /omega prefix goes to Omega");
  assert.equal((await worker.fetch(new Request("https://nexus.test/omega/"), { ASSETS: assets })).status, 503, "no binding");
  const wrangler = readFileSync(join(root, "workers/xauusd-nexus-dashboard/wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"binding": "OMEGA_PAGE",\s*"service": "xauusd-omega"/);
  assert.match(readFileSync(join(root, "workers/xauusd-nexus-dashboard/ui/src/components/AppShell.tsx"), "utf8"), /href: "\/omega\/"/);
});
