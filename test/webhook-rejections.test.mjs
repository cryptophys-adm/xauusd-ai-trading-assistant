import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { classifyRejection, recordRejection, rejectionSummary, MAX_PER_HOUR } from "../src/webhook-rejections.mjs";
import { detectHealthIssues } from "../src/health-alerts.mjs";

const EXPECTED = "a1b2c3d4e5f6";
const NOW = Date.parse("2026-11-09T00:30:00.000Z");

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { db.prepare(sql).run(...params); return {}; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}

test("a rejection says why, with lengths and never a character of either secret", () => {
  assert.equal(classifyRejection({ bodySecret: EXPECTED, expected: EXPECTED }), null);
  assert.equal(classifyRejection({ headerSecret: EXPECTED, bodySecret: "x", expected: EXPECTED }), null);
  assert.deepEqual(classifyRejection({ expected: EXPECTED }), { reason: "secret_missing", secret_field: "none", received_len: 0, expected_len: 12 });
  assert.equal(classifyRejection({ bodySecret: EXPECTED + "\n", expected: EXPECTED }).reason, "secret_whitespace");
  assert.equal(classifyRejection({ bodySecret: " " + EXPECTED, expected: EXPECTED }).reason, "secret_whitespace");
  assert.equal(classifyRejection({ bodySecret: EXPECTED.toUpperCase(), expected: EXPECTED }).reason, "secret_case");
  assert.deepEqual(classifyRejection({ bodySecret: "short", expected: EXPECTED }), { reason: "secret_length_differs", secret_field: "body", received_len: 5, expected_len: 12 });
  assert.equal(classifyRejection({ headerSecret: "zzzzzzzzzzzz", expected: EXPECTED }).reason, "secret_mismatch");
  assert.equal(classifyRejection({ headerSecret: "zzzzzzzzzzzz", expected: EXPECTED }).secret_field, "header");
  const all = JSON.stringify([classifyRejection({ bodySecret: "wrong-secret", expected: EXPECTED }), classifyRejection({ bodySecret: EXPECTED + " ", expected: EXPECTED })]);
  assert.ok(!all.includes(EXPECTED) && !all.includes("wrong-secret"), "no secret text in a rejection");
});

test("rejections are stored with their context, capped per hour, pruned after 14 days, and summarised", async () => {
  const db = d1();
  const meta = { source: "gmi_v12_70", timeframe: "5", candleTime: "1794178800000", contentType: "text/plain; charset=utf-8", userAgent: "Go-http-client/1.1" };
  assert.equal(await recordRejection(db, classifyRejection({ bodySecret: "short", expected: EXPECTED }), meta, NOW - 20 * 24 * 3600_000), true);
  assert.equal(await recordRejection(db, classifyRejection({ bodySecret: "short", expected: EXPECTED }), meta, NOW - 10 * 60_000), true);
  assert.equal(await recordRejection(db, classifyRejection({ expected: EXPECTED }), { ...meta, source: "prophet_r38" }, NOW), true);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM webhook_rejections").get().n, 2, "the 20-day-old row is pruned");
  const s = await rejectionSummary(db, NOW - 3600_000);
  assert.equal(s.count, 2);
  assert.deepEqual(s.reasons, { secret_length_differs: 1, secret_missing: 1 });
  assert.deepEqual(s.sources, ["gmi_v12_70", "prophet_r38"]);
  assert.deepEqual(s.received_lengths, [0, 5]);
  assert.equal(s.expected_len, 12);
  assert.ok(!JSON.stringify(db.raw.prepare("SELECT * FROM webhook_rejections").all()).includes("short"));
  for (let i = 0; i < MAX_PER_HOUR; i++) await recordRejection(db, classifyRejection({ expected: EXPECTED }), meta, NOW);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM webhook_rejections").get().n, MAX_PER_HOUR, "a flood stops at the hourly cap");
  assert.equal(await recordRejection(null, null), false);
  assert.deepEqual((await rejectionSummary(d1(), 0)).count, 0, "no table reads as none");
});

test("the health check opens a webhook_rejected alert while alerts are refused", async () => {
  const db = d1();
  for (const ms of [NOW - 40 * 60_000, NOW - 5 * 60_000]) await recordRejection(db, classifyRejection({ bodySecret: "short", expected: EXPECTED }), { source: "gmi_v12_70_hud" }, ms);
  const env = { DB: db, TF_THREADS_ENABLED: "false", NEWS_DAILY_ENABLED: "false", WAR_ROOM_ENABLED: "false" };
  const issues = await detectHealthIssues(env, NOW);
  const a = issues.find((i) => i.kind === "webhook_rejected");
  assert.ok(a);
  assert.match(a.subject, /^TradingView webhook rejected \(401\): 2 alerts since 23:50 UTC \(gmi_v12_70_hud\): a different secret \(its length differs from the Worker's\); secret length received 5, the Worker's 12$/);
  assert.equal((await detectHealthIssues(env, NOW + 2 * 3600_000)).some((i) => i.kind === "webhook_rejected"), false, "quiet an hour after the last rejection");
});
