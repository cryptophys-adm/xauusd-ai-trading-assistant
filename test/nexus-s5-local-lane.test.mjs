// S5b (parity removal, UI side; orchestrator 2026-11-28): after S5, GET /api/status keeps only
// ai_worker.local_lane { rpc_entrypoint, indicator_source, fresh } (the shape the xauusd backend sent; fixture
// test/fixtures/nexus-s5/status-post-s5.json). System status's "Local lane" row reads only `fresh`; the Calibration
// row and the parity re-earning text are gone, also when an older payload still carries registry or calibration.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const POST_S5 = JSON.parse(read("test/fixtures/nexus-s5/status-post-s5.json"));
const NO_UI_DEPS = ["esbuild", "react"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";

let bundled = null;
async function lib() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], write: false, logLevel: "silent",
    stdin: { contents: 'export { healthItems } from "./src/lib/health";', resolveDir: UI, loader: "ts" }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
// A Wednesday 10:00 UTC (market open) and a Saturday 10:00 UTC (closed).
const OPEN = Date.parse("2026-11-25T10:00:00Z"), CLOSED = Date.parse("2026-11-28T10:00:00Z");
const laneRow = (items) => items.find((i) => i.key === "lane");
const withLane = (local_lane) => ({ ...POST_S5, ai_worker: { ...POST_S5.ai_worker, local_lane } });

test("S5b-1 the post-S5 /api/status: Local lane from fresh only, no Calibration row", { skip: NO_UI_DEPS }, async () => {
  const { healthItems } = await lib();
  const items = healthItems(POST_S5, null, OPEN);
  assert.deepEqual(items.map((i) => i.key), ["ai", "news", "oauth", "lane"]);
  assert.deepEqual(laneRow(items), { key: "lane", label: "Local lane", worker: laneRow(items).worker, tone: "ok", detail: "local 1H records for the latest bars" });
  const stale = withLane({ ...POST_S5.ai_worker.local_lane, fresh: false });
  assert.deepEqual([laneRow(healthItems(stale, null, OPEN)).tone, laneRow(healthItems(stale, null, OPEN)).detail], ["fault", "no local 1H record for the last two bars"]);
  assert.deepEqual([laneRow(healthItems(stale, null, CLOSED)).tone, laneRow(healthItems(stale, null, CLOSED)).detail], ["off", "market closed: no new 1H bar"]);
  assert.equal(laneRow(healthItems(withLane(undefined), null, OPEN)).tone, "fault", "no local_lane at all: not fresh");
});

test("S5b-2 a pre-S5 payload (registry, calibration.due) shows no parity wording and no Calibration row", { skip: NO_UI_DEPS }, async () => {
  const { healthItems } = await lib();
  const old = withLane({ fresh: false, registry: [{ engine: "prophet", status: "candidate", consecutive_matches: 3, promote_after: 24 }], calibration: { due: true } });
  const items = healthItems(old, null, OPEN);
  assert.ok(!items.some((i) => i.key === "calibration"));
  for (const i of items) assert.doesNotMatch(`${i.label} ${i.detail}`, /parity|re-earning|calibrat/i);
  assert.equal(laneRow(items).tone, "fault");
});

test("S5b-3 no Nexus UI source reads the dropped local_lane keys or lists a calibration row", () => {
  const health = read("workers/xauusd-nexus-dashboard/ui/src/lib/health.ts");
  for (const k of ["registry", "calibration", "consecutive_matches", "promote_after", "last_parity_comparison_at", "recent_comparisons", "parity_sweep_cron"]) assert.ok(!health.includes(k), k);
  assert.match(read("workers/xauusd-nexus-dashboard/ui/src/pages/Status.tsx"), /const STATUS_ROWS = new Set\(\["ai", "news", "oauth", "lane"\]\);/);
});
