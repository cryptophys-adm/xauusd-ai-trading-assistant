// Call for Councils P1 (docs/RFC_CALL_FOR_COUNCILS.md §12): the read-only routes of the AI Worker, run through
// its real fetch handler (src/index.ts bundled with esbuild, as wrangler does), the Nexus Worker's proxy of
// them, and the Nexus page with its own navigator item (owner 2026-11-16: "jangan ditampilkan di omega, buat
// menu navigator sendiri Call for Councils").
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NOW, seedEnv, seedTrades } from "./support/cfc-fixtures.mjs";
import { priceKeysIn, REF_RE } from "../src/cfc-pack.mjs";
import { resetCfcSchemaCacheForTests, runCfcTriggers } from "../src/cfc-triggers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function bundle(entry) {
  const out = await build({ entryPoints: [join(root, entry)], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") } });
  const dir = await mkdtemp(join(tmpdir(), "cfc-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}
const worker = await bundle("src/index.ts");
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = async (env, path, init) => { const r = await worker.fetch(new Request("https://worker.test" + path, init), env, ctx); return { status: r.status, body: await r.json().catch(() => null) }; };

test("GET /api/council/evidence: a pack for a valid topic, a 400 for anything else", async () => {
  const env = await seedEnv();
  await seedTrades(env, { agent: "zone_pullback", n: 6, exits: [["stop", "sl_plus"], ["target", "target"]], start: Date.now() - 3 * 86_400_000 });
  const ok = await get(env, "/api/council/evidence?topic=" + encodeURIComponent("strategy:zone_pullback:exits"));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "ok");
  assert.equal(ok.body.pack.schema, "council_pack.v1");
  assert.equal(ok.body.pack.sections.trades.n, 6);
  assert.deepEqual(priceKeysIn(ok.body.pack), []);
  for (const r of ok.body.pack.refs) assert.match(r, REF_RE);
  assert.match(ok.body.pack.sha256, /^[0-9a-f]{64}$/);
  const ctxTopic = await get(env, "/api/council/evidence?topic=" + encodeURIComponent("strategy:zone_pullback@intraday|normal-trending"));
  assert.equal(ctxTopic.status, 200);
  for (const bad of ["", "?topic=", "?topic=strategy:nobody", "?topic=seat:system", "?topic=" + encodeURIComponent("free:x y"), "?topic=" + encodeURIComponent("strategy:zone_pullback' OR 1=1")]) {
    const r = await get(env, "/api/council/evidence" + bad);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error, "invalid_topic");
  }
});

test("GET /api/council/suggestions: the stored suggestions, the mode and a catalogue of valid keys; nothing else is writable", async () => {
  resetCfcSchemaCacheForTests();
  const env = await seedEnv();
  await seedTrades(env, { agent: "zone_pullback", n: 20, exits: [["stop", "stop"]], start: NOW - 5 * 86_400_000 });
  await runCfcTriggers(env, { now: NOW });
  const r = await get(env, "/api/council/suggestions");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, "suggest");
  assert.ok(r.body.suggestions.some((s) => s.topic_key === "strategy:zone_pullback:exits"), JSON.stringify(r.body.suggestions.map((s) => s.topic_key)));
  assert.ok(r.body.catalog.strategy.keys.includes("strategy:pattern_inside:exits"));
  assert.ok(!JSON.stringify(r.body).includes("@cf/"), "no model identifier");
  const off = await get({ ...env, CFC_MODE: "off" }, "/api/council/suggestions");
  assert.equal(off.body.mode, "off");
  const post = await worker.fetch(new Request("https://worker.test/api/council/suggestions", { method: "POST", body: "{}" }), env, ctx);
  assert.notEqual(post.status, 200, "no write route in P1");
});

test("Nexus proxies the council routes to the AI Worker over its binding, GET only", async () => {
  const nexus = await bundle("workers/xauusd-nexus-dashboard/src/index.ts");
  const seen = [];
  const AI_WORKER = { async fetch(req) { seen.push([req.method, new URL(req.url).pathname + new URL(req.url).search]); return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } }); } };
  const path = "/api/council/evidence?topic=" + encodeURIComponent("strategy:zone_pullback:exits");
  assert.equal((await nexus.fetch(new Request("https://nexus.test" + path), { AI_WORKER })).status, 200);
  assert.equal((await nexus.fetch(new Request("https://nexus.test/api/council/suggestions"), { AI_WORKER })).status, 200);
  assert.deepEqual(seen, [["GET", path], ["GET", "/api/council/suggestions"]]);
  assert.equal((await nexus.fetch(new Request("https://nexus.test/api/council/suggestions", { method: "POST", body: "{}" }), { AI_WORKER })).status, 405);
});

test("the Call for Councils page has its own navigator item and nothing of it is on the Omega page", () => {
  const ui = (p) => readFileSync(join(root, "workers/xauusd-nexus-dashboard/ui/src", p), "utf8");
  const shell = ui("components/AppShell.tsx");
  assert.match(shell, /title: "Councils", items: \[\{ label: "Call for Councils", href: "\/#\/councils", key: "councils"/);
  assert.match(ui("App.tsx"), /councils: Councils/);
  const page = ui("pages/Councils.tsx");
  for (const route of ["/api/council/suggestions", "/api/council/evidence?topic=", "/api/strategy-agents"]) assert.ok(page.includes(route), route);
  assert.match(page, /later phase/, "the page says sessions start later");
  assert.doesNotMatch(page, /method: "POST"|\/omega\/api/, "read-only");
  assert.doesNotMatch(ui("pages/Omega.tsx"), /council\/|Call for Councils|cfc/i, "nothing of councils on the Omega page");
});
