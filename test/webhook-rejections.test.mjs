import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { classifyRejection, recordRejection, rejectionSummary, webhookLaneStatus, fingerprint, resetRejectionSchemaCacheForTests, MAX_PER_HOUR } from "../src/webhook-rejections.mjs";
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
  assert.deepEqual(s.received_lengths, [5], "the lengths of the most frequent reason (a tie keeps the first)");
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

test("System status lane: the last accepted alert and the last hour's rejections; a stray probe does not blur the lengths", async () => {
  const db = d1();
  db.raw.exec("CREATE TABLE webhook_sources (candle_key TEXT, source TEXT, payload TEXT, received_at TEXT)");
  db.raw.prepare("INSERT INTO webhook_sources VALUES ('OANDA:XAUUSD:15:1', 'gmi_v12_70', '{}', '2026-11-07 13:04:00')").run();
  await recordRejection(db, classifyRejection({ bodySecret: "x", expected: EXPECTED }), { source: "probe" }, NOW - 30 * 60_000);
  for (let i = 0; i < 3; i++) await recordRejection(db, classifyRejection({ bodySecret: "zzzzzzzzzzzz", expected: EXPECTED }), { source: "gmi_v12_70" }, NOW - i * 60_000);
  const lane = await webhookLaneStatus(db, NOW);
  assert.equal(lane.last_accepted_at, "2026-11-07T13:04:00.000Z");
  assert.equal(lane.last_accepted_source, "gmi_v12_70");
  assert.equal(lane.rejected_last_hour, 4);
  assert.equal(lane.top_reason, "secret_mismatch");
  assert.match(lane.top_reason_text, /different secret of the same length/);
  assert.deepEqual((await rejectionSummary(db, NOW - 3600_000)).received_lengths, [12], "the probe's length 1 is not the alerts'");
  const quiet = await webhookLaneStatus(d1(), NOW);
  assert.deepEqual([quiet.last_accepted_at, quiet.rejected_last_hour, quiet.top_reason], [null, 0, null]);
});

test("fingerprints: the first 8 hex of each secret's SHA-256, added to a table of the first release, never the secret", async () => {
  const { createHash } = await import("node:crypto");
  const fp = (v) => createHash("sha256").update(v).digest("hex").slice(0, 8);
  assert.equal(await fingerprint("abc"), "ba7816bf", "the same as sha256sum");
  assert.equal(await fingerprint(""), null);
  resetRejectionSchemaCacheForTests();
  const db = d1();
  // The production table of #181 has no fingerprint columns.
  db.raw.exec("CREATE TABLE webhook_rejections (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, reason TEXT NOT NULL, secret_field TEXT NOT NULL, received_len INTEGER NOT NULL, expected_len INTEGER NOT NULL, source TEXT, timeframe TEXT, candle_time TEXT, content_type TEXT, user_agent TEXT)");
  const sent = "0123456789abcdef0123456789abcdef", held = "fedcba9876543210fedcba9876543210";
  assert.equal(await recordRejection(db, classifyRejection({ bodySecret: sent, expected: held }), { source: "gmi_v12_70", receivedSecret: sent, expectedSecret: held }, NOW), true);
  const row = db.raw.prepare("SELECT * FROM webhook_rejections").get();
  assert.deepEqual([row.received_fp, row.expected_fp], [fp(sent), fp(held)]);
  assert.ok(!JSON.stringify(row).includes(sent) && !JSON.stringify(row).includes(held));
});
