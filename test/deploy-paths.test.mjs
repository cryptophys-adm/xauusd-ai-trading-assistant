// Cut-over option (D), owner 2026-11-15, item 3: production reaches Cloudflare only through the tagged deploy
// workflows. Every non-dry-run `wrangler deploy` in a workflow tags the version with the commit and injects
// DEPLOY_COMMIT / DEPLOYED_AT; the one exception is the isolated preview Worker of deploy-preview-worker.yml
// (its own --name, wrangler.preview.jsonc). Workers Builds production (versions upload only) is owner-managed in
// the Cloudflare dashboard and documented in docs/SSOT.md; no repository file can check it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const WORKFLOWS = readdirSync(new URL(".github/workflows/", ROOT)).filter((f) => /\.ya?ml$/.test(f));
const DEPLOY = /\bwrangler(@[\d.]+)?\s+deploy\b/;

/** Production Worker configs and the one workflow that deploys each. */
const PRODUCTION = {
  "wrangler.jsonc": "deploy-worker.yml",
  "workers/xauusd-nexus-dashboard/wrangler.jsonc": "deploy-nexus-dashboard.yml",
  "workers/xauusd-omega/wrangler.jsonc": "deploy-omega.yml",
  "fundamental-news-ingestion/wrangler.jsonc": "deploy-fundamental-news-ingestion.yml",
  "market-data-ingestion/wrangler.jsonc": "deploy-market-data-ingestion.yml"
};

function deployLines() {
  return WORKFLOWS.flatMap((file) => read(`.github/workflows/${file}`).split("\n")
    .map((line, i) => ({ file, n: i + 1, line }))
    .filter(({ line }) => DEPLOY.test(line) && !/--dry-run/.test(line) && !/^\s*(#|echo\b)/.test(line.trim())));
}

test("every non-dry-run wrangler deploy in a workflow is tagged, except the isolated preview Worker", () => {
  const lines = deployLines();
  assert.ok(lines.length >= 6, "the five production deploys (Omega has two) and the preview");
  for (const { file, n, line } of lines) {
    const where = `${file}:${n}`;
    if (file === "deploy-preview-worker.yml") {
      assert.match(line, /--config wrangler\.preview\.jsonc/, where);
      assert.match(line, /--name "\$PREVIEW_WORKER_NAME"/, `${where}: the preview deploys under its own name`);
      continue;
    }
    assert.match(line, /--tag "\$\{GITHUB_SHA:0:12\}"/, where);
    assert.match(line, /--message "commit \$\{GITHUB_SHA\}"/, where);
    assert.match(line, /--var "DEPLOY_COMMIT:\$\{GITHUB_SHA\}"/, where);
    assert.match(line, /--var "DEPLOYED_AT:/, where);
  }
});

test("each production Worker config is deployed by exactly one workflow, on main", () => {
  const lines = deployLines().filter((l) => l.file !== "deploy-preview-worker.yml");
  for (const [config, workflow] of Object.entries(PRODUCTION)) {
    const owners = new Set(lines.filter(({ line }) => config === "wrangler.jsonc"
      ? /--config wrangler\.jsonc\b/.test(line)
      : line.includes(`--config ${config}`)).map((l) => l.file));
    assert.deepEqual([...owners], [workflow], config);
    const text = read(`.github/workflows/${workflow}`);
    assert.match(text, /push:\s*\n\s*branches:\s*(\[\s*main\s*\]|\n\s*-\s*main\b)/, `${workflow} deploys on push to main`);
    assert.doesNotMatch(text, /^\s{2}pull_request:/m, `${workflow} never deploys from a pull request`);
  }
});

test("no other deploy path: no versions deploy or rollback in a workflow, no deploy script in package.json", () => {
  for (const file of WORKFLOWS) {
    const runs = read(`.github/workflows/${file}`).split("\n").filter((l) => !/^\s*(#|echo\b)/.test(l.trim()));
    assert.ok(!runs.some((l) => /\bwrangler(@[\d.]+)?\s+(versions\s+deploy|rollback)\b/.test(l)), file);
  }
  for (const pkg of ["package.json", "workers/xauusd-nexus-dashboard/ui/package.json", "bridge/omega-bridge/package.json"]) {
    const scripts = JSON.parse(read(pkg)).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) assert.doesNotMatch(String(cmd), DEPLOY, `${pkg} script ${name}`);
  }
});
