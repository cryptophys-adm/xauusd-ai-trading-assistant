// The deploy drift guard (2026-11-21 incident: an old checkout on the owner's trading VPS uploaded an old build of the
// AI Worker twice with `wrangler deploy`, outside CI; the 5-minute ledger cron, the owner-only arm gate and 30 bindings
// were gone for 14 hours). Run by .github/workflows/deploy-drift-guard.yml every 15 minutes: the live Worker must be a
// build of main (its /health commit is on main and not older than the last commit that touched the Worker), with the
// crons of wrangler.jsonc. A drift fails the run, which GitHub reports; with the repository variable
// DRIFT_AUTO_RESTORE=on the workflow then re-runs deploy-worker.yml on main.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Pure: the crons wrangler.jsonc declares (comments stripped). */
export function declaredCrons(wranglerText) {
  const text = String(wranglerText).replace(/^\s*\/\/.*$/gm, "");
  const m = text.match(/"crons"\s*:\s*\[([^\]]*)\]/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : [];
}

/**
 * Pure: the drift problems, empty when the live Worker is a build of main with its crons. `health` is the /health JSON,
 * `liveCrons` the Worker's schedules, `expectedCrons` wrangler.jsonc's, `onMain(sha)` whether a commit is on main and
 * `containsLast(sha)` whether it contains the last commit that touched the Worker's deploy paths.
 */
export function driftProblems({ health, liveCrons = [], expectedCrons = [], onMain = () => true, containsLast = () => true }) {
  const out = [];
  const commit = typeof health?.commit === "string" && /^[0-9a-f]{7,40}$/.test(health.commit) ? health.commit : null;
  if (health?.status !== "ok") out.push(`health status ${JSON.stringify(health?.status ?? null)}`);
  if (!commit) out.push("the live Worker reports no commit: not a CI build (deploy-worker.yml sets DEPLOY_COMMIT)");
  else {
    if (!onMain(commit)) out.push(`the live commit ${commit} is not on main`);
    else if (!containsLast(commit)) out.push(`the live commit ${commit} is older than the last commit that changed the Worker`);
  }
  const live = [...liveCrons].sort(), want = [...expectedCrons].sort();
  const missing = want.filter((c) => !live.includes(c)), extra = live.filter((c) => !want.includes(c));
  if (missing.length) out.push(`crons missing: ${missing.join(", ")}`);
  if (extra.length) out.push(`crons not in wrangler.jsonc: ${extra.join(", ")}`);
  return out;
}

const git = (...args) => { try { execFileSync("git", args, { stdio: "ignore" }); return true; } catch { return false; } };

async function main() {
  const DEPLOY_PATHS = ["src", "wrangler.jsonc", "package.json", "tsconfig.json", "migrations", "schema.sql"];
  const last = execFileSync("git", ["log", "-1", "--format=%H", "origin/main", "--", ...DEPLOY_PATHS]).toString().trim();
  const health = await (await fetch("https://ai.cryptophys.work/health", { signal: AbortSignal.timeout(20_000) })).json();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured");
  const cf = async (path) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const body = await r.json();
    if (!r.ok || body.success === false) throw new Error(`Cloudflare API ${path}: HTTP ${r.status}`);
    return body.result;
  };
  const accounts = await cf("/accounts");
  const account = (accounts ?? [])[0]?.id;
  if (!account) throw new Error("no Cloudflare account visible to the token");
  const sched = await cf(`/accounts/${account}/workers/scripts/xauusd-ai-trading-assistant/schedules`);
  const liveCrons = (sched?.schedules ?? []).map((s) => s.cron);
  const expectedCrons = declaredCrons(readFileSync("wrangler.jsonc", "utf8"));
  const onMain = (sha) => git("merge-base", "--is-ancestor", sha, "origin/main");
  const containsLast = (sha) => git("merge-base", "--is-ancestor", last, sha);
  const problems = driftProblems({ health, liveCrons, expectedCrons, onMain, containsLast });
  console.log(JSON.stringify({ live_commit: health?.commit ?? null, last_worker_commit: last.slice(0, 12), live_crons: liveCrons, expected_crons: expectedCrons, problems }, null, 2));
  if (problems.length) {
    console.log(`::error title=Deploy drift::${problems.join("; ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
