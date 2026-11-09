import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// The Ops Dispatch workflow (backlog item 17, 2026-11-09) starts allow-listed workflows on main from
// a request commit on the operator branch. These checks keep its allow-list honest: only deploy and
// inspection workflows that exist and take workflow_dispatch, never the secret-writing one.
const text = readFileSync(new URL("../.github/workflows/ops-dispatch.yml", import.meta.url), "utf8");
const caseBlock = text.slice(text.indexOf('case "$workflow" in'), text.indexOf("esac"));
const allowed = [...caseBlock.matchAll(/^\s*([a-z0-9.|-]+)\)\s+ref=main/gm)].flatMap((m) => m[1].split("|"));
const workflows = readdirSync(new URL("../.github/workflows", import.meta.url));

test("the allow-list holds only existing deploy and inspection workflows that accept workflow_dispatch", () => {
  assert.deepEqual(allowed.sort(), ["deploy-fundamental-news-ingestion.yml", "deploy-market-data-ingestion.yml", "deploy-nexus-dashboard.yml", "deploy-worker.yml", "inspect-ai-worker.yml"]);
  for (const w of allowed) {
    assert.ok(workflows.includes(w), `${w} exists`);
    assert.match(readFileSync(new URL(`../.github/workflows/${w}`, import.meta.url), "utf8"), /workflow_dispatch/, `${w} takes workflow_dispatch`);
  }
});

test("never the secret-writing or decommission workflows, always main, no inputs, only the operator branch", () => {
  assert.ok(!caseBlock.includes("set-webhook-secret.yml"), "set-webhook-secret.yml is never dispatched");
  assert.ok(!caseBlock.includes("decommission-legacy-workers.yml"));
  assert.ok(!/ref=(?!main)/.test(caseBlock), "every dispatch runs on main");
  assert.match(text, /\(\.inputs \/\/ \{\}\) == \{\}/, "a request carries no inputs");
  assert.match(text, /gh workflow run "\$workflow" --repo "\$GITHUB_REPOSITORY" --ref "\$ref"\n/, "no -f inputs are passed");
  assert.match(text, /branches: \[claude\/vibrant-mccarthy-dq5xs7\]/);
  assert.match(text, /paths: \["ops\/requests\/\*\*\.json"\]/);
  assert.match(text, /compare\/main\.\.\.\$\{GITHUB_SHA\}/, "a branch reset onto main never replays a request");
  assert.match(text, /permissions:\n  contents: read\n  actions: write/);
});
