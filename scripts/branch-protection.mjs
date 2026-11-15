// The main ruleset (owner 2026-11-15, "kerjakan hardening branch protection xauusd"): ops/branch-ruleset.json is
// the declared ruleset. checkWorkflows() proves every required check is a job of a workflow that reports on every
// pull request (a renamed job or a path filter would silently block or disable the gate). checkLive() compares the
// rules GitHub applies to main with the declaration. Run as a script it does both (CI job protection-guard).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
export const RULESET = JSON.parse(readFileSync(new URL("ops/branch-ruleset.json", ROOT), "utf8"));
export const REQUIRED_TYPES = ["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"];

export function requiredContexts(ruleset = RULESET) {
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks");
  return (rule?.parameters?.required_status_checks ?? []).map((c) => c.context);
}

/** Jobs of one workflow file: [{ id, name, check }] where check is the check-run name (name, else id). */
export function parseWorkflow(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = [];
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i++) {
      const m = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (m) jobs.push({ id: m[1], name: null });
      const n = lines[i].match(/^    name:\s*["']?([^"'#]+?)["']?\s*$/);
      if (n && jobs.length && jobs.at(-1).name === null) jobs.at(-1).name = n[1];
      if (/^\S/.test(lines[i])) break;
    }
  }
  const head = at >= 0 ? lines.slice(0, at).join("\n") : text;
  const onBlock = head.slice(head.search(/^on:/m));
  return {
    jobs: jobs.map((j) => ({ ...j, check: j.name ?? j.id })),
    pullRequest: /^\s{2}pull_request:/m.test(onBlock),
    pathFiltered: /^\s{4}paths(-ignore)?:/m.test(onBlock)
  };
}

export function checkWorkflows(dir = new URL(".github/workflows/", ROOT), ruleset = RULESET) {
  const problems = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const parsed = files.map((f) => ({ file: f, ...parseWorkflow(readFileSync(new URL(f, dir), "utf8")) }));
  for (const ctx of requiredContexts(ruleset)) {
    const hits = parsed.flatMap((w) => w.jobs.filter((j) => j.check === ctx).map((j) => ({ ...w, job: j })));
    const onPr = hits.filter((h) => h.pullRequest);
    if (onPr.length === 0) { problems.push(`${ctx}: no pull_request workflow has a job with this check name`); continue; }
    if (onPr.length > 1) problems.push(`${ctx}: ${onPr.length} pull_request jobs share this check name (${onPr.map((h) => h.file).join(", ")})`);
    for (const h of onPr) if (h.pathFiltered) problems.push(`${ctx}: ${h.file} has a path filter, so the check would not report on every PR`);
  }
  return problems;
}

/** rules: the response of GET /repos/{owner}/{repo}/rules/branches/main. */
export function checkLive(rules, ruleset = RULESET) {
  const problems = [];
  if (!Array.isArray(rules)) return ["the branch rules response is not a list"];
  for (const t of REQUIRED_TYPES) if (!rules.some((r) => r.type === t)) problems.push(`rule ${t} is not applied to main`);
  const pr = rules.find((r) => r.type === "pull_request");
  if (pr && Number(pr.parameters?.required_approving_review_count ?? 0) !== Number(ruleset.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count)) {
    problems.push("pull_request: required approvals differ from ops/branch-ruleset.json");
  }
  const checks = rules.filter((r) => r.type === "required_status_checks");
  const live = new Set(checks.flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context)));
  for (const ctx of requiredContexts(ruleset)) if (!live.has(ctx)) problems.push(`required check ${ctx} is not required on main`);
  for (const ctx of live) if (!requiredContexts(ruleset).includes(ctx)) problems.push(`main requires ${ctx}, which ops/branch-ruleset.json does not declare`);
  if (checks.length && !checks.some((r) => r.parameters?.strict_required_status_checks_policy === true)) problems.push("required checks do not require the branch to be up to date");
  return problems;
}

async function main() {
  const repo = process.env.REPO;
  const problems = checkWorkflows();
  if (!repo) problems.push("REPO is not set");
  else {
    const res = await fetch(`https://api.github.com/repos/${repo}/rules/branches/main`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) }
    });
    if (!res.ok) problems.push(`GET rules/branches/main answered ${res.status}`);
    else problems.push(...checkLive(await res.json()));
  }
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    process.exit(1);
  }
  console.log(`main is protected as declared: ${REQUIRED_TYPES.join(", ")}; required checks ${requiredContexts().join(", ")}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
