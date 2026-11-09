import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runHealthAlerts, readHealthAlerts, detectHealthIssues, resetHealthSchemaCacheForTests, HEALTH_AGENT_ID, HEALTH_REPORTS_PER_HOUR } from "../src/health-alerts.mjs";

const NOW = Date.parse("2026-11-06T09:30:00.000Z");
const H = 3600_000;

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE engine_parity_registry (engine TEXT, source_hash TEXT, implementation_hash TEXT, status TEXT, consecutive_matches INTEGER, revoked_at TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE engine_parity_comparisons (engine TEXT, source_hash TEXT, implementation_hash TEXT, candle_key TEXT, result TEXT, detail TEXT, compared_at TEXT)`);
  db.exec(`CREATE TABLE agent_thread_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, run_id TEXT, step TEXT, status TEXT, ts TEXT, body_json TEXT)`);
  db.exec(`CREATE TABLE news_analyses (analysis_key TEXT, analyzed_at TEXT)`);
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };
const iso = (ms) => new Date(ms).toISOString();
function series(lastOpen, stepMs, n = 5) {
  return JSON.stringify({ candles: Array.from({ length: n }, (_, i) => { const o = lastOpen - (n - 1 - i) * stepMs; return { open_time: iso(o), close_time: iso(o + stepMs), close: 4000 }; }) });
}
function agents(outcome = "succeeded") {
  const calls = [];
  return { calls, whoami: async () => ({}), syscall: async (agentId, capability, report) => { calls.push({ agentId, capability, report }); return { outcome, result: { report: { report_id: "r" + calls.length } } }; } };
}
function env(overrides = {}) {
  return {
    DB: d1(), WEBHOOK_BUFFER: kv(),
    SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|1h": series(NOW - 2 * H, H) }),
    TF_THREADS_ENABLED: "false", NEWS_DAILY_ENABLED: "false", WAR_ROOM_ENABLED: "false",
    ...overrides
  };
}

test.beforeEach(() => resetHealthSchemaCacheForTests());

test("detectors: a revoked identity, an input mismatch and a missing local H1 record are reported; healthy state is quiet", async () => {
  const e = env();
  e.DB.raw.prepare("INSERT INTO engine_parity_registry VALUES ('prophet','a','b','revoked',4,?,?)").run(iso(NOW - 5 * H), iso(NOW - H));
  e.DB.raw.prepare("INSERT INTO engine_parity_registry VALUES ('prophet_m15','a','b','approved',34,NULL,?)").run(iso(NOW - H));
  e.DB.raw.prepare("INSERT INTO engine_parity_comparisons VALUES ('gmi','a','b','OANDA:XAUUSD:60:1','input_mismatch',?,?)").run(JSON.stringify({ mismatches: [{ field: "input:c" }, { field: "input:volume" }] }), iso(NOW - H));
  const issues = await detectHealthIssues(e, NOW);
  assert.deepEqual(issues.map((i) => i.kind).sort(), ["h1_local_missing", "input_mismatch", "parity_revoked"]);
  // Canonical names (owner request 2026-11-08): the indicator name, its timeframe and the registry id.
  assert.match(issues.find((i) => i.kind === "parity_revoked").subject, /^Parity revoked: Prophet R38 \+ R37 1H \(prophet\), 4 of 24/);
  assert.match(issues.find((i) => i.kind === "input_mismatch").subject, /GMI v12\.70 1H \(gmi\), bar opened 1970-01-01 00:00 UTC \(input:c, input:volume\)/);

  const healthy = env();
  const lastClosed = JSON.parse(await healthy.SIGNAL_CACHE.get("market-data:v2:series:OANDA:XAUUSD|1h")).candles.at(-1);
  await healthy.WEBHOOK_BUFFER.put("localcalc-observed:OANDA:XAUUSD:60:" + Date.parse(lastClosed.open_time) + ":prophet", "{}");
  assert.deepEqual(await detectHealthIssues(healthy, NOW), []);
});

test("rooms without a conclusion, rate-limited calls, a stale News Daily and a stale War Room are detected when enabled", async () => {
  const e = env({ TF_THREADS_ENABLED: "true", NEWS_DAILY_ENABLED: "true", WAR_ROOM_ENABLED: "true" });
  await e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|5m", series(NOW - 10 * 60_000, 5 * 60_000));
  await e.WEBHOOK_BUFFER.put("localcalc-observed:OANDA:XAUUSD:60:" + (NOW - 2 * H) + ":prophet", "{}");
  for (let i = 0; i < 12; i++) e.DB.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, status, ts, body_json) VALUES ('tf:H1','x','open:a','agent_failed',?,?)").run(iso(NOW - 10 * 60_000), JSON.stringify({ insight: "agent failed: 3021: rate limiting: inference request per min rate reached" }));
  e.DB.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, status, ts, body_json) VALUES ('warroom:2026-11-06','2026-11-06T07:00:00.000Z','conclusion','ok',?, '{}')").run(iso(NOW - 2 * H));
  e.DB.raw.prepare("INSERT INTO news_analyses VALUES ('k', ?)").run(iso(NOW - H));
  const issues = await detectHealthIssues(e, NOW);
  const kinds = issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["model_rate_limited", "news_daily_stale", "room_unconcluded", "war_room_stale"]);
  assert.match(issues.find((i) => i.kind === "room_unconcluded").subject, /^The 1H War Room has no conclusion/, "rooms carry their SSOT name");
});

test("an alert opens once with one warning, stays quiet while it holds, and resolves with one info report", async () => {
  const ag = agents();
  const e = env({ AGENTS: ag });
  const issue = { key: "parity_revoked:prophet", kind: "parity_revoked", subject: "Parity revoked: prophet, 4 of 24 matches toward re-approval", detail: { engine: "prophet" } };
  const first = await runHealthAlerts(e, { now: NOW, detect: async () => [issue] });
  assert.equal(first.opened, 1);
  assert.equal(ag.calls.length, 1);
  assert.equal(ag.calls[0].agentId, HEALTH_AGENT_ID);
  assert.equal(ag.calls[0].capability, "reports.publish");
  assert.equal(ag.calls[0].report.severity, "warning");
  assert.equal(ag.calls[0].report.kind, "xauusd_digest");

  await runHealthAlerts(e, { now: NOW + 15 * 60_000, detect: async () => [issue] });
  assert.equal(ag.calls.length, 1, "no repeat while it holds");
  assert.equal((await readHealthAlerts(e.DB, { now: NOW })).open.length, 1);

  const gone = await runHealthAlerts(e, { now: NOW + 2 * H, detect: async () => [] });
  assert.equal(gone.resolved, 1);
  assert.equal(ag.calls.length, 2);
  assert.equal(ag.calls[1].report.severity, "info");
  assert.match(ag.calls[1].report.subject, /^Resolved: /);
  const read = await readHealthAlerts(e.DB, { now: NOW + 2 * H });
  assert.equal(read.open.length, 0);
  assert.equal(read.resolved_24h.length, 1);
  for (const c of ag.calls) assert.notEqual(c.report.severity, "critical");
});

test("one-shot alerts never reopen or send a resolution; the hourly report budget holds the rest for later", async () => {
  const ag = agents();
  const e = env({ AGENTS: ag });
  const many = Array.from({ length: 5 }, (_, i) => ({ key: `input_mismatch:gmi:k${i}`, kind: "input_mismatch", one_shot: true, subject: `bar ${i} differs`, detail: {} }));
  await runHealthAlerts(e, { now: NOW, detect: async () => many });
  assert.equal(ag.calls.length, HEALTH_REPORTS_PER_HOUR, "at most the hourly budget");
  await runHealthAlerts(e, { now: NOW + 2 * H, detect: async () => [] });
  assert.equal(ag.calls.length, HEALTH_REPORTS_PER_HOUR, "resolved one-shot alerts that were never reported stay unreported; reported ones send no resolution");
  await runHealthAlerts(e, { now: NOW + 3 * H, detect: async () => many });
  assert.equal((await readHealthAlerts(e.DB, { now: NOW + 3 * H })).open.length, 0, "a resolved one-shot alert does not reopen");
});

test("a denial is final and never retried; without the binding alerts are still kept for Nexus", async () => {
  const denied = agents("denied");
  const e = env({ AGENTS: denied });
  const issue = { key: "war_room_stale", kind: "war_room_stale", subject: "stale", detail: {} };
  await runHealthAlerts(e, { now: NOW, detect: async () => [issue] });
  await runHealthAlerts(e, { now: NOW + 15 * 60_000, detect: async () => [issue] });
  assert.equal(denied.calls.length, 1);

  resetHealthSchemaCacheForTests();
  const local = env();
  const r = await runHealthAlerts(local, { now: NOW, detect: async () => [issue] });
  assert.deepEqual(r.published, []);
  assert.equal((await readHealthAlerts(local.DB, { now: NOW })).open[0].kind, "war_room_stale");
});

test("the stale War Room check counts from the first bar after a market gap and dates an old meeting (production 2026-11-08 23:12)", async () => {
  // Friday's last 5m bar closed 22:00 UTC; the market reopened Sunday 23:00; it is 23:12.
  const now = Date.parse("2026-11-08T23:12:00Z");
  const friday = Array.from({ length: 6 }, (_, i) => { const o = Date.parse("2026-11-06T21:30:00Z") + i * 300_000; return { open_time: iso(o), close_time: iso(o + 300_000), close: 4000 }; });
  const sunday = Array.from({ length: 2 }, (_, i) => { const o = Date.parse("2026-11-08T23:00:00Z") + i * 300_000; return { open_time: iso(o), close_time: iso(o + 300_000), close: 4000 }; });
  const e = env({ WAR_ROOM_ENABLED: "true", SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|5m": JSON.stringify({ candles: [...friday, ...sunday] }) }) });
  e.DB.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, status, ts, body_json) VALUES ('warroom:x', '2026-11-06T22:00:00.000Z', 'conclusion', 'ok', '1', '{}')").run();
  assert.ok(!(await detectHealthIssues(e, now)).some((i) => i.kind === "war_room_stale"), "12 minutes into the new session: not stale");
  const later = Date.parse("2026-11-09T00:00:00Z");
  const more = [...friday, ...sunday, ...Array.from({ length: 10 }, (_, i) => { const o = Date.parse("2026-11-08T23:10:00Z") + i * 300_000; return { open_time: iso(o), close_time: iso(o + 300_000), close: 4000 }; })];
  const e2 = env({ WAR_ROOM_ENABLED: "true", SIGNAL_CACHE: kv({ "market-data:v2:series:OANDA:XAUUSD|5m": JSON.stringify({ candles: more }) }) });
  e2.DB.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, status, ts, body_json) VALUES ('warroom:x', '2026-11-06T22:00:00.000Z', 'conclusion', 'ok', '1', '{}')").run();
  const stale = (await detectHealthIssues(e2, later)).find((i) => i.kind === "war_room_stale");
  assert.match(stale.subject, /has not met since 2026-11-06 22:00 UTC/);
});
