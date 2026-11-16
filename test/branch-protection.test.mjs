// The main ruleset (owner 2026-11-15): every required check is a job that reports on every pull request, and the
// live-rules comparison catches a removed protection or a dropped check.
import test from "node:test";
import assert from "node:assert/strict";
import { RULESET, requiredContexts, checkWorkflows, checkLive, parseWorkflow } from "../scripts/branch-protection.mjs";

test("the declared ruleset protects main: no deletion, no force push, linear history, PR with checks, no bypass", () => {
  assert.deepEqual(RULESET.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assert.deepEqual(RULESET.bypass_actors, []);
  assert.equal(RULESET.enforcement, "active");
  assert.deepEqual(RULESET.rules.map((r) => r.type).sort(), ["deletion", "non_fast_forward", "pull_request", "required_linear_history", "required_status_checks"]);
  assert.equal(RULESET.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count, 0);
  const sc = RULESET.rules.find((r) => r.type === "required_status_checks").parameters;
  assert.equal(sc.strict_required_status_checks_policy, true);
  assert.deepEqual(requiredContexts(), ["dependency-audit", "evidence-unit-tests", "preview-e2e", "protection-guard", "typecheck"]);
  assert.ok(!requiredContexts().some((c) => c.startsWith("Workers Builds")), "Workers Builds checks are dashboard-managed and never required");
});

test("every required check is exactly one job of a workflow that runs on every pull request", () => {
  assert.deepEqual(checkWorkflows(), []);
});

test("a renamed job, a path filter or a shared name is caught", () => {
  const renamed = { ...RULESET, rules: RULESET.rules.map((r) => r.type === "required_status_checks" ? { ...r, parameters: { ...r.parameters, required_status_checks: [{ context: "no-such-job" }] } } : r) };
  assert.match(checkWorkflows(undefined, renamed)[0], /no pull_request workflow has a job/);
  const w = parseWorkflow("name: x\non:\n  pull_request:\n    paths:\n      - \"src/**\"\njobs:\n  a:\n    name: alpha\n    runs-on: ubuntu-latest\n  b:\n    runs-on: ubuntu-latest\n");
  assert.deepEqual(w.jobs.map((j) => j.check), ["alpha", "b"]);
  assert.equal(w.pathFiltered, true);
  assert.equal(w.pullRequest, true);
});

test("the live comparison fails when protection is removed or a check is dropped", () => {
  const live = [
    { type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" },
    { type: "pull_request", parameters: { required_approving_review_count: 0 } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: requiredContexts().map((context) => ({ context })) } }
  ];
  assert.deepEqual(checkLive(live), []);
  assert.ok(checkLive([]).length >= 5, "no rules at all");
  const dropped = live.map((r) => r.type === "required_status_checks" ? { ...r, parameters: { ...r.parameters, required_status_checks: [{ context: requiredContexts()[0] }] } } : r);
  assert.deepEqual(checkLive(dropped), requiredContexts().slice(1).map((c) => `required check ${c} is not required on main`));
  assert.match(checkLive(live.filter((r) => r.type !== "non_fast_forward"))[0], /non_fast_forward/);
});
