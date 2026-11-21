// The change audit on Telegram (owner 2026-11-20: "harus ada notif Telegram karena buat mengetahui dan audit"), the
// first council decision line, the fail-closed limit rule, the refused lens report alert and the deploy drift guard.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { auditSweep, runAuditNotify, actorLabel, AUDIT_NOTIFY_KEY, AUDIT_DEBOUNCE_MS } from "../src/change-notify.mjs";
import { limitFault, limitFailClosed } from "../src/omega-broker.mjs";
import { firstCouncilLine, FIRST_COUNCIL_KEY } from "../src/limit-council.mjs";
import { lensHealthIssues, LENS_REPORT_LAST_KEY } from "../src/lens-steps.mjs";
import { resetLensStateMemoForTests } from "../src/lens-policy.mjs";
import { driftProblems, declaredCrons } from "../scripts/deploy-drift-check.mjs";

const T0 = Date.parse("2026-11-20T11:45:47Z"), S = 1000;
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)");
  db.exec("CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_ms INTEGER)");
  db.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT)");
  db.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)");
  const wrap = (sql, p = []) => ({ bind: (...a) => wrap(sql, a), run: async () => db.prepare(sql).run(...p), first: async () => db.prepare(sql).get(...p) ?? null, all: async () => ({ results: db.prepare(sql).all(...p) }) });
  return { raw: db, prepare: (sql) => wrap(sql) };
}
const base = { enabled: true, live_armed: true, risk_pct: 2, max_positions: 2, max_daily_loss_pct: 6, entry_order: "market", pm_loosen_enabled: false, positioning_enabled: true };
const row = (id, ms, actor, action, detail) => ({ id, ms, actor, action, detail: JSON.stringify(detail) });

test("CA1 eight saves in about 70 s: one line per switch, the value it ended on, who; a held change goes with the next sweep", () => {
  const owner = "owner@example.com";
  const saves = [
    row(1, T0, owner, "settings", { ...base }),
    row(2, T0 + 6 * S, owner, "settings", { ...base, entry_order: "limit" }),
    row(3, T0 + 16 * S, owner, "settings", { ...base, entry_order: "council" }),
    row(4, T0 + 22 * S, owner, "settings", { ...base, entry_order: "council", pm_loosen_enabled: true })
  ];
  const first = auditSweep({ cursor: 0, baseline: base }, saves, { now: T0 + 25 * S, context: { ea_version: "1.21", ea_ok: true } });
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0], "XAUUSD SYSTEM · Omega settings changed by owner · 11:46 UTC\n• entry order: market → council (EA 1.21, ok)\n• stop/target loosening (A8): off → on");
  assert.ok(!first.lines.join(" ").includes("@"), "never an email");
  // Two more saves inside the minute: held, then said once with where they ended.
  const more = [row(5, T0 + 40 * S, owner, "settings", { ...base, entry_order: "limit", pm_loosen_enabled: true }), row(6, T0 + 50 * S, owner, "settings", { ...base, entry_order: "council", pm_loosen_enabled: true, risk_pct: 1 })];
  const second = auditSweep(first.state, more, { now: T0 + 55 * S });
  assert.deepEqual(second.lines, ["XAUUSD SYSTEM · Omega settings changed by owner · 11:46 UTC\n• risk per trade %: 2 → 1"], "risk_pct was never told: at once; entry_order went limit and back to council inside its minute");
  assert.equal(second.state.pending.entry_order?.to, "council", "entry_order waits for its minute");
  const third = auditSweep(second.state, [], { now: T0 + 25 * S + AUDIT_DEBOUNCE_MS + 1 });
  assert.deepEqual(third.lines, [], "changed and changed back inside the minute: nothing to say");
  assert.deepEqual(third.state.pending, {});
  assert.equal(third.state.cursor, 6);
});

test("CA2 other audit actions are one line each with who; identity keys never shown; agents and Aether named", () => {
  const r = auditSweep({ cursor: 0, baseline: base }, [
    row(7, T0, "agent:profile", "profile_changed", { account_ref: "acct_ab12", from: "aggressive", to: "conservative", reason: "drawdown" }),
    row(8, T0 + S, "owner@example.com", "connection_set", { server: "Broker-Live", version: 4, trade_symbol: "GOLD" }),
    row(9, T0 + 2 * S, "aether", "settings", { ...base, risk_pct: 1.5 }),
    row(10, T0 + 3 * S, "engine", "plan", { notes: "x" })
  ], { now: T0 + 5 * S });
  assert.equal(r.lines[0], "XAUUSD SYSTEM · Account profile changed by agent profile · 11:45 UTC\nfrom aggressive · to conservative · reason drawdown");
  assert.equal(r.lines[1], "XAUUSD SYSTEM · Broker connection set by owner · 11:45 UTC\nversion 4 · trade_symbol GOLD");
  assert.match(r.lines[2], /changed by Aether .*risk per trade %: 2 → 1\.5/s);
  assert.equal(r.lines.length, 3, "a plan row is not a change");
  assert.ok(!/acct_|Broker-Live|@/.test(r.lines.join("\n")));
  assert.deepEqual([actorLabel("agent:mode"), actorLabel("aether-rollback"), actorLabel("6d015218-6ea2"), actorLabel("")], ["agent mode", "Aether (rollback)", "owner", "unknown"]);
});

test("CA3 the sweep: the first run starts at the newest row and says nothing; then it sends and moves its cursor", async () => {
  const db = d1(), cache = kv(), sent = [];
  db.raw.prepare("INSERT INTO omega_settings VALUES (1, ?, 3, 'owner', ?)").run(JSON.stringify(base), T0);
  db.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'owner', 'settings', ?)").run(T0 - 3600_000, JSON.stringify({ ...base, risk_pct: 0.5 }));
  const env = { DB: db, SIGNAL_CACHE: cache };
  assert.equal((await runAuditNotify(env, { now: T0, send: async (t) => sent.push(t) })).status, "started");
  assert.deepEqual(sent, [], "no flood of old changes");
  db.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'owner', 'settings', ?)").run(T0 + S, JSON.stringify({ ...base, live_armed: false }));
  db.raw.prepare("INSERT INTO omega_bridge VALUES (1, ?)").run(JSON.stringify({ executor: { version: "1.21" } }));
  const r = await runAuditNotify(env, { now: T0 + 2 * S, send: async (t) => sent.push(t) });
  assert.equal(r.lines, 1);
  assert.match(sent[0], /live arm: on → off/);
  assert.equal(JSON.parse(cache.m.get(AUDIT_NOTIFY_KEY)).cursor, 2);
  assert.equal((await runAuditNotify(env, { now: T0 + 3 * S, send: async (t) => sent.push(t) })).status, "quiet");
});

test("CA4 fail closed: a limit intent the EA never answered, or answered without a ticket, until the owner saves again", async () => {
  assert.equal(limitFault({ kind: "place_limit", status: "expired", result: null }), "the EA never answered");
  assert.equal(limitFault({ kind: "place_limit", status: "done", result: JSON.stringify({ ok: true, ticket: null }) }), "the EA answered without a ticket");
  assert.equal(limitFault({ kind: "place_limit", status: "done", result: JSON.stringify({ ok: true, ticket: 5 }) }), null);
  assert.equal(limitFault({ kind: "delete_order", status: "failed", result: JSON.stringify({ ok: false, error: "no order" }) }), null, "a refusal is an answer");
  assert.equal(limitFault({ kind: "open", status: "expired", result: null }), null, "market intents keep their own rules");
  const db = d1(), cache = kv(), env = { DB: db, SIGNAL_CACHE: cache, TELEGRAM_BOT_TOKEN: null };
  db.raw.prepare("INSERT INTO omega_intents VALUES ('open:1:B', 'place_limit', '{}', 'expired', NULL, ?, ?)").run(T0, T0);
  const f = await limitFailClosed(env, db, { since: T0 - 60_000, now: T0 + 600_000 });
  assert.deepEqual([f.intent_id, f.kind], ["open:1:B", "place_limit"]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'limit_fail_closed'").get().n, 1);
  await limitFailClosed(env, db, { since: T0 - 60_000, now: T0 + 900_000 });
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'limit_fail_closed'").get().n, 1, "told once");
  assert.equal(await limitFailClosed(env, db, { since: T0 + 700_000, now: T0 + 900_000 }), null, "the owner saved the settings after it: limits resume");
});

test("CA5 the first decision in council mode is told once", async () => {
  const cache = kv(), sent = [];
  const env = { SIGNAL_CACHE: cache };
  assert.equal(await firstCouncilLine(env, { choice: "place_limit", rule: "council_place", reason: "price is stretched from the zone", side: "BUY", mode: "intraday", now: T0, send: async (t) => sent.push(t) }), true);
  assert.equal(await firstCouncilLine(env, { choice: "skip", now: T0 + S, send: async (t) => sent.push(t) }), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /first decision in council mode .*\nBUY \(intraday\): place_limit · rule council_place\nprice is stretched/s);
  assert.ok(cache.m.has(FIRST_COUNCIL_KEY));
});

test("CA6 a refused lens report raises lens_report_refused with the key paths only", async () => {
  resetLensStateMemoForTests();
  const cache = kv();
  await cache.put(LENS_REPORT_LAST_KEY, JSON.stringify({ status: "refused_locally", keys: [".lenses.liquidity.slippage_r"], at: "2026-11-21T10:00:00.000Z" }));
  const env = { SIGNAL_CACHE: cache, DB: { prepare: () => ({ first: async () => null, bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }), all: async () => ({ results: [] }) }) } };
  const issues = await lensHealthIssues(env, T0);
  const a = issues.find((x) => x.kind === "lens_report_refused");
  assert.ok(a, JSON.stringify(issues));
  assert.match(a.subject, /price filter refused the key \.lenses\.liquidity\.slippage_r/);
  await cache.put(LENS_REPORT_LAST_KEY, JSON.stringify({ status: "accepted" }));
  resetLensStateMemoForTests();
  assert.equal((await lensHealthIssues(env, T0)).some((x) => x.kind === "lens_report_refused"), false);
});

test("CA7 the deploy drift guard: no commit, an old commit, a missing cron", () => {
  const crons = declaredCrons(`{ "triggers": { // the crons\n "crons": [ "6 * * * *", "10-59/15 * * * *", "2-59/5 * * * *" ] } }`);
  assert.deepEqual(crons, ["10-59/15 * * * *", "2-59/5 * * * *", "6 * * * *"]);
  const ok = { status: "ok", commit: "7051492efcb0" };
  assert.deepEqual(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons }), []);
  // 2026-11-21 00:26: the old build.
  const old = driftProblems({ health: { status: "ok" }, liveCrons: ["10-59/15 * * * *", "6 * * * *"], expectedCrons: crons });
  assert.deepEqual(old, ["the live Worker reports no commit: not a CI build (deploy-worker.yml sets DEPLOY_COMMIT)", "crons missing: 2-59/5 * * * *"]);
  assert.match(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons, containsLast: () => false })[0], /older than the last commit/);
  assert.match(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons, onMain: () => false })[0], /not on main/);
});
