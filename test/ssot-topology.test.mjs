// Guards the canonical topology in docs/SSOT.md and AGENTS.md: no Wrangler
// config may declare a Worker outside the five production Workers, the removed
// legacy Workers may never come back, and the live docs agree with each other.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION = ["xauusd-ai-trading-assistant", "xauusd-fundamental-news-ingestion", "xauusd-tradingview-pull-adapter", "xauusd-nexus-dashboard", "xauusd-omega"];
const PREVIEW_ONLY = ["xauusd-ai-trading-assistant-preview"];
const REMOVED = ["xauusd-mizan-engine", "xauusd-prophet-engine", "xauusd-gmi-engine", "xauusd-market-data-normalizer", "xauusd-pull-orchestrator", "xauusd-confluence-controller"];
const SKIP = new Set(["node_modules", ".git", "recovered"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const read = (p) => readFileSync(p, "utf8");

test("every Wrangler config declares only an SSOT Worker", () => {
  const configs = files.filter((p) => /wrangler[^/]*\.jsonc?$/.test(p));
  assert.ok(configs.length >= 4);
  const declared = configs.map((p) => [path.relative(ROOT, p), read(p).match(/"name"\s*:\s*"([^"]+)"/)?.[1]]);
  for (const [file, name] of declared) assert.ok([...PRODUCTION, ...PREVIEW_ONLY].includes(name), `${file} declares non-SSOT Worker "${name}"`);
  for (const worker of PRODUCTION) assert.ok(declared.some(([, n]) => n === worker), `no Wrangler config for SSOT Worker ${worker}`);
});

test("removed legacy Workers are not referenced by any config, workflow or source", () => {
  const allowed = new Set(["docs/SSOT.md", "AGENTS.md", "docs/LOCAL_COMPUTATION_OWNERSHIP.md", ".github/workflows/decommission-legacy-workers.yml", "test/ssot-topology.test.mjs"]);
  for (const p of files) {
    const rel = path.relative(ROOT, p);
    if (allowed.has(rel) || !/\.(jsonc?|ya?ml|mjs|ts|js)$/.test(rel)) continue;
    const text = read(p);
    for (const name of REMOVED) assert.ok(!text.includes(name), `${rel} references removed Worker ${name}`);
  }
});

test("live docs agree with the SSOT; docs naming removed Workers are marked historical", () => {
  for (const doc of ["docs/SSOT.md", "AGENTS.md", "README.md"]) {
    const text = read(path.join(ROOT, doc));
    for (const worker of PRODUCTION) assert.ok(text.includes(worker), `${doc} must list ${worker}`);
  }
  assert.ok(!REMOVED.some((n) => read(path.join(ROOT, "README.md")).includes(n)), "README must not describe removed Workers");
  const live = new Set(["docs/SSOT.md", "docs/LOCAL_COMPUTATION_OWNERSHIP.md"]);
  for (const p of files.filter((f) => f.startsWith(path.join(ROOT, "docs")) && f.endsWith(".md"))) {
    const rel = path.relative(ROOT, p);
    if (live.has(rel)) continue;
    const text = read(p);
    if (REMOVED.some((n) => text.includes(n))) assert.match(text.slice(0, 600), /HISTORICAL \/ SUPERSEDED/, `${rel} names removed Workers but is not marked historical`);
  }
});

test("only the production AI Worker binds the Cryptophys Platform kernel, with its own pinned host_worker", () => {
  const configs = files.filter((p) => /wrangler[^/]*\.jsonc?$/.test(p));
  for (const p of configs) {
    const rel = path.relative(ROOT, p);
    const text = read(p);
    if (!text.includes("cryptophys-ai-kernel")) continue;
    assert.equal(rel, "wrangler.jsonc", `${rel} must not bind the platform kernel (only the production AI Worker hosts the agents)`);
    assert.match(text, /"binding":\s*"AGENTS",\s*"service":\s*"cryptophys-ai-kernel",\s*"entrypoint":\s*"AgentRpc",\s*"props":\s*\{\s*"host_worker":\s*"xauusd-ai-trading-assistant"\s*\}/);
  }
  assert.ok(read(path.join(ROOT, "wrangler.jsonc")).includes("cryptophys-ai-kernel"));
  for (const doc of ["docs/SSOT.md", "AGENTS.md"]) assert.ok(read(path.join(ROOT, doc)).includes("cryptophys-ai-kernel"), `${doc} must document the platform kernel binding`);
});

test("only the production AI Worker binds Aether's KnowledgeIngress; Nexus binds only the read-only AetherReader; no props, no secret", () => {
  const configs = files.filter((p) => /wrangler[^/]*\.jsonc?$/.test(p));
  const READ_ONLY = "workers/xauusd-nexus-dashboard/wrangler.jsonc";
  for (const p of configs) {
    const rel = path.relative(ROOT, p);
    const text = read(p);
    if (!text.includes("cryptophys-aether")) continue;
    if (rel === READ_ONLY) {
      // The Aether page (owner 2026-11-09): a read-only entrypoint, never KnowledgeIngress.
      assert.match(text, /\{\s*"binding":\s*"AETHER",\s*"service":\s*"cryptophys-aether",\s*"entrypoint":\s*"AetherReader"\s*\}/);
      assert.doesNotMatch(text, /KnowledgeIngress/, "Nexus never pushes decision cards");
      continue;
    }
    assert.equal(rel, "wrangler.jsonc", `${rel} must not bind Aether (only the production AI Worker pushes decision cards)`);
    assert.match(text, /\{\s*"binding":\s*"AETHER",\s*"service":\s*"cryptophys-aether",\s*"entrypoint":\s*"KnowledgeIngress"\s*\}/);
  }
  assert.ok(read(path.join(ROOT, "wrangler.jsonc")).includes("cryptophys-aether"));
  for (const doc of ["docs/SSOT.md", "AGENTS.md"]) assert.ok(read(path.join(ROOT, doc)).includes("cryptophys-aether"), `${doc} must document the Aether binding`);
});

test("Nexus reaches the AI Worker only through its AI_WORKER Service Binding, never the public URL", () => {
  const text = read(path.join(ROOT, "workers/xauusd-nexus-dashboard/wrangler.jsonc"));
  assert.match(text, /\{\s*"binding":\s*"AI_WORKER",\s*"service":\s*"xauusd-ai-trading-assistant"\s*\}/);
  const src = read(path.join(ROOT, "workers/xauusd-nexus-dashboard/src/index.ts"));
  assert.match(src, /env\.AI_WORKER\.fetch\(/);
  assert.doesNotMatch(src, /await fetch\(AI_WORKER_BASE/, "no public fetch of the AI Worker");
  for (const doc of ["docs/SSOT.md", "AGENTS.md"]) assert.ok(read(path.join(ROOT, doc)).includes("AI_WORKER"), `${doc} must document the Nexus -> AI Worker binding`);
});

test("the AI Worker and Nexus have no public workers.dev or preview URL (owner, 2026-11-07)", () => {
  for (const rel of ["wrangler.jsonc", "workers/xauusd-nexus-dashboard/wrangler.jsonc"]) {
    const text = read(path.join(ROOT, rel));
    assert.match(text, /"workers_dev":\s*false/, `${rel} must disable workers.dev`);
    assert.match(text, /"preview_urls":\s*false/, `${rel} must disable preview URLs`);
  }
});
