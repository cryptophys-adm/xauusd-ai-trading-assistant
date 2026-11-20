// The health alert when Aether refuses the execution report twice in a row (2026-11-18 to 11-20: every push of
// cryptophys.execution-report.v1 was refused and nothing said so). src/aether-push.mjs, src/health-alerts.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pushExecutionReport, nextRejectedStreak, rejectionCodes, executionReportAlert, executionReportIssue, resetExecutionPushSchemaForTests, EXECUTION_REJECTED_ALERT_STREAK } from "../src/aether-push.mjs";
import { runHealthAlerts, detectHealthIssues, readHealthAlerts, resetHealthSchemaCacheForTests } from "../src/health-alerts.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };
function agents() {
  const calls = [];
  return { calls, whoami: async () => ({}), syscall: async (agentId, capability, report) => { calls.push({ agentId, capability, report }); return { outcome: "succeeded", result: { report: { report_id: "r" + calls.length } } }; } };
}
const T0 = Date.parse("2026-11-18T06:00:00.000Z");
const M5 = 5 * 60_000;
const report = (i, extra = {}) => ({ schema: "cryptophys.execution-report.v1", generated_at: new Date(T0 + i * M5).toISOString(), window_days: 30, modes: { scalp: {}, range: {} }, trades: [{ n: i }], ...extra });
/** An env whose Aether answers with the queued answers in turn. */
function envWith(answers, overrides = {}) {
  const queue = [...answers];
  return {
    DB: d1(), SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv(), TF_THREADS_ENABLED: "false", NEWS_DAILY_ENABLED: "false", WAR_ROOM_ENABLED: "false",
    AETHER: { ingestExecutionReport: async () => queue.shift() ?? { accepted: true } },
    ...overrides
  };
}
const row = (env) => env.DB.raw.prepare("SELECT status, detail, rejected_streak, rejected_since FROM aether_execution_report_pushes WHERE id = 1").get();
const REJ = (reason) => ({ accepted: false, reason });

test.beforeEach(() => { resetExecutionPushSchemaForTests(); resetHealthSchemaCacheForTests(); });

test("EX1 the push row counts the refusals in a row and since when; an accepted push ends the run", async () => {
  const env = envWith([REJ("modes_invalid"), REJ("modes_invalid"), { accepted: true }, REJ("modes_invalid")]);
  assert.equal((await pushExecutionReport(env, report(0))).status, "rejected");
  assert.deepEqual({ ...row(env) }, { status: "rejected", detail: "modes_invalid", rejected_streak: 1, rejected_since: report(0).generated_at });
  await pushExecutionReport(env, report(1));
  assert.deepEqual([row(env).rejected_streak, row(env).rejected_since], [2, report(0).generated_at]);
  await pushExecutionReport(env, report(2));
  assert.deepEqual([row(env).status, row(env).rejected_streak, row(env).rejected_since], ["accepted", 0, null]);
  assert.equal((await pushExecutionReport(env, report(2, { generated_at: report(9).generated_at }))).status, "unchanged", "the same content accepted is not sent again");
  await pushExecutionReport(env, report(3));
  assert.deepEqual([row(env).rejected_streak, row(env).rejected_since], [1, report(3).generated_at], "a new run");
  // A transport failure is no push: nothing recorded.
  const broken = { ...env, AETHER: { ingestExecutionReport: async () => { throw new Error("down"); } } };
  assert.equal((await pushExecutionReport(broken, report(4))).status, "transport_failed");
  assert.equal(row(env).rejected_streak, 1);
});

test("EX2 a table from before the counter gets its columns; a refused row there counts as one", async () => {
  const env = envWith([REJ("modes_invalid")]);
  env.DB.raw.exec("CREATE TABLE aether_execution_report_pushes (id INTEGER PRIMARY KEY CHECK (id = 1), content_sha TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, pushed_at TEXT NOT NULL)");
  env.DB.raw.prepare("INSERT INTO aether_execution_report_pushes VALUES (1, 'x', 'rejected', 'modes_invalid', ?)").run(report(0).generated_at);
  assert.equal(await executionReportIssue(env), null, "no counter yet: no alert, no error");
  await pushExecutionReport(env, report(1));
  assert.deepEqual([row(env).rejected_streak, row(env).rejected_since], [2, report(0).generated_at]);
  assert.equal((await executionReportIssue(env))?.kind, "aether_execution_rejected");
  assert.deepEqual(nextRejectedStreak(null, "rejected", "t"), { rejected_streak: 1, rejected_since: "t" });
  assert.deepEqual(nextRejectedStreak({ status: "rejected", rejected_streak: 4, rejected_since: "s" }, "accepted", "t"), { rejected_streak: 0, rejected_since: null });
});

test("EX3 the alert holds from the second refusal in a row and carries the validator codes only", () => {
  assert.equal(EXECUTION_REJECTED_ALERT_STREAK, 2);
  const base = { status: "rejected", detail: "modes_invalid, trade_invalid:77", rejected_since: "2026-11-18T06:00:00.000Z", pushed_at: "2026-11-20T08:00:00.000Z" };
  assert.equal(executionReportAlert({ ...base, rejected_streak: 1 }, Date.parse("2026-11-18T07:00:00.000Z")), null, "one refusal within 24 hours is no alert");
  assert.equal(executionReportAlert({ ...base, status: "accepted", rejected_streak: 0 }), null);
  const a = executionReportAlert({ ...base, rejected_streak: 2 });
  assert.equal(a.kind, "aether_execution_rejected");
  assert.equal(a.report_once, true);
  assert.equal(a.key, "aether_execution_rejected:2026-11-18T06:00:00.000Z:modes_invalid,trade_invalid:77");
  assert.equal(a.subject, "Aether rejected the execution report 2 times in a row since 2026-11-18 06:00 UTC: modes_invalid, trade_invalid:77. Omega's results reach no knowledge until a push is accepted.");
  assert.deepEqual(a.detail, { codes: ["modes_invalid", "trade_invalid:77"], rejected_in_a_row: 2, rejected_since: base.rejected_since, last_push_at: base.pushed_at });
  // Never a price, an account number or an email, whatever the detail says.
  assert.deepEqual(rejectionCodes("modes_invalid, price 4101.25, owner@example.com, 5550123, trade_invalid:5550123, forbidden_key:report.trades[3].entry, too_large"),
    ["modes_invalid", "forbidden_key:report.trades[3].entry", "too_large"]);
  const leaky = executionReportAlert({ ...base, rejected_streak: 3, detail: "4101.25, owner@example.com, 5550123" });
  const text = JSON.stringify(leaky);
  assert.ok(!/4101|5550123|@/.test(text), text);
  assert.match(leaky.subject, /no validator code given/);
});

test("EX4 health alerts: reported once per distinct rejection until a push is accepted; open while it holds", async () => {
  const ag = agents();
  const env = envWith([REJ("modes_invalid"), REJ("modes_invalid"), REJ("modes_invalid"), REJ("trade_invalid:77"), REJ("modes_invalid"), { accepted: true }, REJ("modes_invalid"), REJ("modes_invalid")], { AGENTS: ag });
  let now = T0;
  const sweep = async (i) => { await pushExecutionReport(env, report(i)); now += M5; return runHealthAlerts(env, { now }); };
  const sent = () => ag.calls.filter((c) => c.report.body.alert_kind === "aether_execution_rejected");

  await sweep(0);
  assert.equal(sent().length, 0, "one refusal: no alert");
  assert.deepEqual((await detectHealthIssues(env, now)).filter((a) => a.kind === "aether_execution_rejected"), []);
  await sweep(1);
  assert.equal(sent().length, 1, "the second refusal in a row opens and reports it");
  assert.equal(sent()[0].report.severity, "warning");
  assert.deepEqual(sent()[0].report.body.detail.codes, ["modes_invalid"]);
  await sweep(2);
  assert.equal(sent().length, 1, "the same rejection is not sent again");
  assert.match((await readHealthAlerts(env.DB, { now })).open.find((a) => a.kind === "aether_execution_rejected").subject, /3 times in a row/);
  await sweep(3);
  assert.equal(sent().length, 2, "a distinct rejection is sent once");
  assert.deepEqual(sent()[1].report.body.detail.codes, ["trade_invalid:77"]);
  await sweep(4);
  assert.equal(sent().length, 2, "back to a rejection already sent in this run: reopened, not sent again");
  assert.deepEqual((await readHealthAlerts(env.DB, { now })).open.filter((a) => a.kind === "aether_execution_rejected").map((a) => a.alert_key), [`aether_execution_rejected:${report(0).generated_at}:modes_invalid`]);
  await sweep(5);
  assert.equal(sent().length, 2, "accepted: resolved without a report");
  assert.deepEqual((await readHealthAlerts(env.DB, { now })).open.filter((a) => a.kind === "aether_execution_rejected"), []);
  await sweep(6);
  await sweep(7);
  assert.equal(sent().length, 3, "a new run after an accepted push reports again");
  for (const c of sent()) assert.ok(!/@|\d{5,}/.test(JSON.stringify(c.report.body.detail.codes)));
});

test("EX5 one refusal older than 24 hours with no accepted push since raises the alert too (orchestrator review of #503)", () => {
  const since = "2026-11-18T06:00:00.000Z";
  const row = { status: "rejected", detail: "modes_invalid, trade_invalid:77", pushed_at: since, rejected_streak: 1, rejected_since: since };
  assert.equal(executionReportAlert(row, Date.parse("2026-11-19T05:00:00.000Z")), null, "23 h: not yet");
  const a = executionReportAlert(row, Date.parse("2026-11-19T07:00:00.000Z"));
  assert.ok(a && a.report_once, "25 h: the alert");
  assert.match(a.subject, /nothing was accepted for over 24 hours since 2026-11-18 06:00 UTC: modes_invalid, trade_invalid:77/);
  assert.equal(a.key, executionReportAlert({ ...row, rejected_streak: 2 }, Date.parse("2026-11-19T07:00:00.000Z")).key, "the same run keeps one key, so the second refusal does not report again");
  assert.equal(executionReportAlert({ ...row, status: "accepted", rejected_streak: 0 }, Date.parse("2026-11-20T07:00:00.000Z")), null);
});
