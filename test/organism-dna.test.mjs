// Owner 2026-11-12: "DNA untuk XAUUSD dan Omega dengan auto-register". organism.json declares the five Workers,
// the agents that report to the platform kernel and every AI task; this test keeps it equal to the code, so a
// new agent or AI task cannot ship without reaching the platform's census.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { organismDna, ORGANISM_SCHEMA } from "../src/organism.mjs";
import { HUD_PLATFORM_IDS, PLATFORM_HOST_WORKER } from "../src/platform-reports.mjs";
import { HEALTH_AGENT_ID } from "../src/health-alerts.mjs";
import { NEXUS_TEACHER_ID } from "../src/owner-corrections.mjs";
import { KNOWLEDGE_VERDICT_AGENT_ID, KNOWLEDGE_VERDICT_CAPABILITY } from "../src/knowledge-verdicts.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const dna = organismDna();
const ai = dna.organs.find((o) => o.service === PLATFORM_HOST_WORKER);
// The platform's external-organ ceiling (cryptophys-cloud-platform control-plane-shared/src/organism.ts).
const CEILING = new Set(["signals.observe", "reports.publish", "memory.recall", "memory.remember"]);
// XAUUSD_CEILING (platform V3, live 2026-11-17): the moderator alone may also read its handed-off proposals' state.
// Platform HAIC H3e: nexus-teacher alone may record the owner's corrections (src/owner-corrections.mjs).
// Platform PF3 (migration 0088, KA2): shadow-knowledge alone may post the shadow arm's verdicts (src/knowledge-verdicts.mjs).
const AGENT_EXTRA = Object.freeze({ "xauusd-moderator": ["council.decisions.read"], "nexus-teacher": ["corrections.record"], "shadow-knowledge": ["knowledge.verdict"] });
// DNA-1 (2026-11-22): genes the platform registered before this repository runs their code. Platform PF1 (migration
// 0087) registers hud-mizan-oracle; declaring it here keeps the census free of undeclared_agent until B27 wires it.
// Each is idle: not in HUD_PLATFORM_IDS and named nowhere in src/, so nothing reports as it. B27 moves
// hud-mizan-oracle into the code set, and this list must be empty after B27.
const DECLARED_IDLE = Object.freeze(["hud-mizan-oracle"]);

function sourceFiles(dir) {
  return readdirSync(new URL(dir, root), { recursive: true }).map(String).filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith(".d.mts")).map((f) => join(dir, f));
}

test("D1. one organ per Worker of this repository, named as its wrangler config names it", () => {
  assert.equal(dna.schema, ORGANISM_SCHEMA);
  const workers = ["wrangler.jsonc", "fundamental-news-ingestion/wrangler.jsonc", "market-data-ingestion/wrangler.jsonc", "workers/xauusd-nexus-dashboard/wrangler.jsonc", "workers/xauusd-omega/wrangler.jsonc"]
    .map((p) => /"name":\s*"([^"]+)"/.exec(read(p))[1]).sort();
  assert.deepEqual(dna.organs.map((o) => o.service).sort(), workers);
  for (const o of dna.organs) {
    assert.equal(o.$schema_version, 1, o.service);
    assert.equal(o.deploy_unit, null, `${o.service}: deployed by this repository, not by a platform unit`);
    assert.equal(o.access, false);
    assert.equal(o.rollback, false);
    assert.equal(o.drift?.via, "rpc");
  }
});

test("D2. the agents are exactly those that report to the platform kernel, within the external ceiling", () => {
  const code = [...Object.values(HUD_PLATFORM_IDS), "xauusd-reasoner", "xauusd-moderator", HEALTH_AGENT_ID, NEXUS_TEACHER_ID, KNOWLEDGE_VERDICT_AGENT_ID].sort();
  assert.deepEqual(ai.agents.map((a) => a.id).sort(), [...code, ...DECLARED_IDLE].sort());
  // A declared-idle gene has no code path: no kernel id in HUD_PLATFORM_IDS and no mention anywhere in src/.
  for (const id of DECLARED_IDLE) {
    assert.ok(!code.includes(id) && !Object.values(HUD_PLATFORM_IDS).includes(id), `${id}: idle, not in the code set`);
    for (const f of sourceFiles("src")) assert.ok(!read(f).includes(id), `${id} is named in ${f}: move it out of DECLARED_IDLE (B27)`);
  }
  for (const a of ai.agents) {
    assert.equal(a.voter, false, `${a.id}: no council seat for an external organ`);
    assert.ok(a.tier_max <= 1, a.id);
    assert.ok(a.capabilities.every((c) => CEILING.has(c) || (AGENT_EXTRA[a.id] ?? []).includes(c)), `${a.id}: ${a.capabilities}`);
  }
  // The platform's per-agent ceiling (XAUUSD_CEILING, H3e): nexus-teacher holds corrections.record and nothing else.
  assert.deepEqual(ai.agents.find((a) => a.id === NEXUS_TEACHER_ID).capabilities, ["corrections.record"]);
  // PF3: shadow-knowledge holds knowledge.verdict and nothing else, tier 1, no seat (KA2).
  assert.deepEqual(ai.agents.find((a) => a.id === KNOWLEDGE_VERDICT_AGENT_ID), { id: "shadow-knowledge", display_name: "Shadow Knowledge", capabilities: [KNOWLEDGE_VERDICT_CAPABILITY], tier_max: 1, voter: false });
  for (const o of dna.organs.filter((x) => x !== ai)) assert.deepEqual(o.agents, [], o.service);
  assert.ok(read("src/platform-reports.mjs").includes('"xauusd-reasoner"') && read("src/platform-reports.mjs").includes('"xauusd-moderator"'));
});

test("D3. the AI tasks are every schema name and aiRunAs label in the code", () => {
  const tasks = new Set();
  for (const f of sourceFiles("src")) {
    const text = read(f);
    for (const m of text.matchAll(/schemaName: "([a-z][a-z0-9_]+)"/g)) tasks.add(m[1]);
    for (const m of text.matchAll(/aiRunAs\("([a-z][a-z0-9_]+)"/g)) tasks.add(m[1]);
  }
  assert.ok(tasks.size >= 20, `found ${tasks.size}`);
  assert.deepEqual(ai.engines.map((e) => e.task).sort(), [...tasks].sort(), "a new AI task needs its line in organism.json");
});

test("D4. the OrganismDna entrypoint exposes dna() only and returns a copy", () => {
  const src = read("src/index.ts");
  const m = src.match(/export class OrganismDna extends WorkerEntrypoint<Env> \{([\s\S]*?)\n\}\n/);
  assert.ok(m);
  assert.deepEqual([...m[1].matchAll(/^\s+async (\w+)\(/gm)].map((x) => x[1]), ["dna"]);
  const a = organismDna();
  a.organs[0].agents.push({ id: "x" });
  assert.notEqual(organismDna().organs[0].agents.at(-1)?.id, "x");
});

test("D5. P5 version provenance: the AI Worker's organ carries its deploy, the others stay untracked, placeholders never", () => {
  const sha = "a".repeat(40);
  const dna = organismDna({ service: "xauusd-ai-trading-assistant", commit: sha, at: "2026-11-15T15:00:00Z" });
  const own = dna.organs.find((o) => o.service === "xauusd-ai-trading-assistant");
  assert.deepEqual([own.deployed_commit, own.deployed_at], [sha, "2026-11-15T15:00:00.000Z"]);
  for (const o of dna.organs.filter((x) => x !== own)) assert.equal(o.deployed_commit, undefined, `${o.service}: untracked here`);
  for (const bad of [{ commit: "abc", at: "2026-11-15T15:00:00Z" }, { commit: sha, at: "" }, null]) {
    const d = organismDna(bad && { service: "xauusd-ai-trading-assistant", ...bad });
    assert.ok(d.organs.every((o) => o.deployed_commit === undefined && o.deployed_at === undefined), JSON.stringify(bad));
  }
  assert.equal(organismDna().organs.some((o) => "deployed_commit" in o), false, "the stored organism.json carries no deploy");
  // Every production deploy tags its version with the commit's first 12 characters and injects both values.
  for (const wf of ["deploy-worker", "deploy-nexus-dashboard", "deploy-omega", "deploy-fundamental-news-ingestion", "deploy-market-data-ingestion"]) {
    const text = read(`.github/workflows/${wf}.yml`);
    const deploys = text.split("\n").filter((l) => /wrangler(@[\d.]+)? deploy --config/.test(l));
    assert.ok(deploys.length, wf);
    for (const l of deploys) {
      assert.match(l, /--tag "\$\{GITHUB_SHA:0:12\}"/, `${wf}: ${l.trim()}`);
      assert.match(l, /--var "DEPLOY_COMMIT:\$\{GITHUB_SHA\}"/, wf);
      assert.match(l, /--var "DEPLOYED_AT:/, wf);
      // wrangler@4.45.0 rejected --tag/--message (2026-11-15: four deploys failed). A pin must be at
      // least the version verified to accept them.
      const pin = l.match(/wrangler@(\d+)\.(\d+)\.(\d+)/);
      if (pin) {
        const [maj, min, pat] = pin.slice(1).map(Number);
        const ok = maj > 4 || (maj === 4 && (min > 156 || (min === 156 && pat >= 2)));
        assert.ok(ok, `${wf}: wrangler@${pin.slice(1).join(".")} does not accept --tag/--message`);
      }
    }
  }
});
