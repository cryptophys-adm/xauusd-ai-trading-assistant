import test from "node:test";
import assert from "node:assert/strict";
import { combineSync, aetherSyncStatus, syncAlerts, LOCAL_KB_SHA } from "../src/aether-sync.mjs";
import { detectHealthIssues } from "../src/health-alerts.mjs";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const aetherOk = { version: "cryptophys.aether-sync.v1", overall: "ok", market_open: true, kb_content_sha256: LOCAL_KB_SHA, checks: { ingest: { status: "ok" }, canon_index: { status: "ok" }, weighting_60: { status: "ok", limit_minutes: 180 } } };

test("combined sync: Aether's checks, the KB hash match and this side's card push", () => {
  const ok = combineSync({ aether: aetherOk, lastPushAt: iso(NOW - 30 * 60_000), now: NOW });
  assert.equal(ok.overall, "ok");
  assert.deepEqual(Object.keys(ok.checks), ["aether_ingest", "aether_canon_index", "aether_weighting_60", "kb_match", "local_push"]);
  const drift = combineSync({ aether: { ...aetherOk, kb_content_sha256: "f".repeat(64) }, lastPushAt: iso(NOW), now: NOW });
  assert.equal(drift.checks.kb_match.status, "warn");
  assert.match(drift.checks.kb_match.hint, /re-import/);
  assert.equal(combineSync({ aether: null, error: "boom", now: NOW }).checks.reachable.status, "warn");
  assert.equal(combineSync({ aether: aetherOk, lastPushAt: iso(NOW - 3 * 3_600_000), now: NOW }).checks.local_push.status, "warn");
  assert.equal(combineSync({ aether: { ...aetherOk, market_open: false }, lastPushAt: iso(NOW - 30 * 3_600_000), now: NOW }).checks.local_push.status, "idle", "the weekend is no outage");
});

test("every warning check is one health alert; ok and idle are none", () => {
  const status = combineSync({ aether: { ...aetherOk, kb_content_sha256: "f".repeat(64), checks: { ...aetherOk.checks, weighting_60: { status: "warn", limit_minutes: 180 }, ingest: { status: "idle" } } }, lastPushAt: iso(NOW), now: NOW });
  const alerts = syncAlerts(status);
  assert.deepEqual(alerts.map((a) => a.key).sort(), ["aether_sync:aether_weighting_60", "aether_sync:kb_match"]);
  assert.match(alerts.find((a) => a.key.endsWith("weighting_60")).subject, /60 weighting report is older than 180 minutes/);
  assert.deepEqual(syncAlerts(null), []);
});

test("the status reads the AETHER_READER binding and the push ledger; no binding, no status, no alert", async () => {
  const env = {
    AETHER_READER: { sync: async () => aetherOk },
    DB: { prepare: () => ({ first: async () => ({ at: iso(NOW - 600_000) }), bind() { return this; }, all: async () => ({ results: [] }) }) }
  };
  const s = await aetherSyncStatus(env, { now: NOW });
  assert.equal(s.overall, "ok");
  assert.equal(await aetherSyncStatus({ DB: env.DB }, { now: NOW }), null);
  const failing = await aetherSyncStatus({ ...env, AETHER_READER: { sync: async () => { throw new Error("no such entrypoint"); } } }, { now: NOW });
  assert.equal(failing.checks.reachable.status, "warn");
  const issues = await detectHealthIssues({ ...env, AETHER_READER: { sync: async () => { throw new Error("down"); } } }, NOW);
  assert.ok(issues.some((i) => i.key === "aether_sync:reachable"), "the health sweep raises the alert");
});
