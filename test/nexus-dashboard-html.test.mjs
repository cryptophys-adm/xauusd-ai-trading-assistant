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
  assert.equal((await worker.fetch(new Request("https://nexus.test/api/ohlcv"), {})).status, 503);
  assert.equal((await worker.fetch(new Request("https://nexus.test/api/local-lane"), {})).status, 503);
});

test("the UI keeps the Console's obsidian palette and calls only same-origin read routes", () => {
  const ui = (p) => readFileSync(join(root, "workers/xauusd-nexus-dashboard/ui", p), "utf8");
  assert.match(ui("tailwind.config.js"), /obsidian: \{ DEFAULT: "#05070c"/);
  // Owner decision 2026-11-06: the War Rooms of every timeframe sit under the chart in one card,
  // tabs News | 15m | 1H | 4H | D1, and every page load opens on News.
  const panel = ui("src/components/ThreadsPanel.tsx");
  assert.match(panel, /\[\["NEWS", "News"\], \["M15", "15m"\], \["H1", "1H"\], \["H4", "4H"\], \["D1", "D1"\]\]/);
  assert.match(panel, /useState<Tab>\("NEWS"\)/);
  assert.doesNotMatch(panel, /localStorage/, "the tab is not remembered: each load opens on News");
  const market = ui("src/lib/market.tsx");
  assert.match(market, /\/api\/threads\/timeframe\?chart=/);
  assert.match(market, /\/api\/news\/daily/);
  assert.match(market, /\/api\/m5-context/);
  const page = ui("src/pages/WarRoom.tsx");
  assert.ok(page.indexOf("<PriceChart />") < page.indexOf("<ThreadsPanel"), "the rooms sit under the chart");
  assert.doesNotMatch(page, /LiveWarRoom|WarRoomConclusion/, "no separate 15m cards: they repeated the 15m tab");
  // The right panel is the trading assistant, as charts.
  const assistant = ui("src/components/AssistantPanel.tsx");
  for (const card of ["Market sentiment", "Trend by timeframe", "Macro trend", "Intraday trend", "Swing trend", "Structure", "Confirmation", "Agent consensus", "Macro drivers", "Session clock"]) assert.ok(assistant.includes(card), card);
  const api = ui("src/lib/api.ts");
  assert.doesNotMatch(api, /method:\s*"(POST|PUT|DELETE)"/);
  const wrangler = readFileSync(join(root, "workers/xauusd-nexus-dashboard/wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"directory": "\.\/ui\/dist"/);
});
