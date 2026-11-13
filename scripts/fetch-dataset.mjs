// The decision model's training data (docs/RFC_CUSTOM_MODEL.md step 3, .github/workflows/train-model.yml):
// every labeled row of the custom model's dataset, paged from the AI Worker's read API with the CI
// Cloudflare Access service token, written to the file given as the first argument. The repository is
// public (RFC section 2): this script prints counts only, never a row or a feature value.
import { writeFileSync } from "node:fs";
import { accessToken, isAccessLogin } from "./access-token.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/fetch-dataset.mjs <output.json>");
const token = accessToken();
if (!token.headers) throw new Error(`CF_ACCESS_CLIENT_ID/SECRET: ${token.problems.join("; ") || "not set"} (${token.shape})`);
const base = process.env.AI_WORKER_URL || "https://ai.cryptophys.work";
const rows = [];
let since = "";
for (let page = 0; page < 50; page++) {
  const res = await fetch(`${base}/api/model/dataset?limit=2000&since=${encodeURIComponent(since)}`, { redirect: "manual", headers: token.headers, signal: AbortSignal.timeout(60_000) });
  if (isAccessLogin(res)) throw new Error(`Cloudflare Access refused the CI service token (${token.shape})`);
  if (!res.ok) throw new Error(`GET /api/model/dataset: HTTP ${res.status}`);
  const body = await res.json();
  const batch = body?.dataset?.rows;
  if (!Array.isArray(batch)) throw new Error("GET /api/model/dataset: no rows array");
  rows.push(...batch);
  since = body.dataset.next;
  if (!since) break;
}
writeFileSync(out, JSON.stringify(rows));
console.log(JSON.stringify({ rows: rows.length, first: rows[0]?.bar_close ?? null, last: rows.at(-1)?.bar_close ?? null }));
