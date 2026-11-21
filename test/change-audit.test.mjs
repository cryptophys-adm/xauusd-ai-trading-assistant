// The change audit on Telegram (owner 2026-11-20: "harus ada notif Telegram karena buat mengetahui dan audit"), the
// first council decision line, the fail-closed limit rule, the refused lens report alert and the deploy drift guard.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { auditSweep, runAuditNotify, actorLabel, auditNotifyIssue, AUDIT_NOTIFY_KEY, AUDIT_DEBOUNCE_MS, AUDIT_ACTIONS, TOLD_ELSEWHERE, NOT_A_CHANGE, AUDIT_FAILED_KEY, AUDIT_MAX_FAILS } from "../src/change-notify.mjs";
import { limitFault, recordLimitFault, clearNoAnswerFault, readSettings, writeSettings, resetOmegaBrokerSchemaForTests, LIMIT_FAULT_NO_ANSWER, LIMIT_FAULT_NO_TICKET } from "../src/omega-broker.mjs";
import { OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { firstCouncilLine, FIRST_COUNCIL_KEY } from "../src/limit-council.mjs";
import { lensHealthIssues, LENS_REPORT_LAST_KEY } from "../src/lens-steps.mjs";
import { detectHealthIssues } from "../src/health-alerts.mjs";
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
  const wrap = (sql, p = []) => ({ bind: (...a) => wrap(sql, a), run: async () => { const r = db.prepare(sql).run(...p); return { meta: { changes: Number(r.changes) } }; }, first: async () => db.prepare(sql).get(...p) ?? null, all: async () => ({ results: db.prepare(sql).all(...p) }) });
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
    row(7, T0, "agent:profile", "balance_operation", { account_ref: "acct_ab12", kind: "deposit", ratio: 1.2 }),
    row(8, T0 + S, "owner@example.com", "connection_set", { server: "Broker-Live", version: 4, trade_symbol: "GOLD" }),
    row(9, T0 + 2 * S, "aether", "settings", { ...base, risk_pct: 1.5 }),
    row(10, T0 + 3 * S, "engine", "plan", { notes: "x" })
  ], { now: T0 + 5 * S });
  assert.equal(r.lines[0], "XAUUSD SYSTEM · Balance operation (deposit or withdrawal) seen by agent profile · 11:45 UTC\nkind deposit · ratio 1.2");
  assert.equal(r.lines[1], "XAUUSD SYSTEM · Broker connection set by owner · 11:45 UTC\nversion 4 · trade_symbol GOLD");
  assert.match(r.lines[2], /changed by Aether .*risk per trade %: 2 → 1\.5/s);
  assert.equal(r.lines.length, 3, "a plan row is not a change");
  assert.ok(!/acct_|Broker-Live|@/.test(r.lines.join("\n")));
  assert.deepEqual([actorLabel("agent:mode"), actorLabel("aether-rollback"), actorLabel("6d015218-6ea2-5fc3-b4aa-cc98c5ced21a"), actorLabel("71282a0000000000000000000000000.access"), actorLabel("")], ["agent mode", "Aether (rollback)", "owner", "service token", "unknown"]);
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

test("CA4 fail closed: a limit intent the EA never answered, or answered without a ticket; once per episode; only the owner's save clears it", async () => {
  assert.equal(limitFault({ kind: "place_limit", status: "expired", result: null }), "the EA never answered");
  assert.equal(limitFault({ kind: "place_limit", status: "done", result: JSON.stringify({ ok: true, ticket: null }) }), "the EA answered without a ticket");
  assert.equal(limitFault({ kind: "place_limit", status: "done", result: JSON.stringify({ ok: true, ticket: 5 }) }), null);
  assert.equal(limitFault({ kind: "delete_order", status: "failed", result: JSON.stringify({ ok: false, error: "no order" }) }), null, "a refusal is an answer");
  assert.equal(limitFault({ kind: "open", status: "expired", result: null }), null, "market intents keep their own rules");
  resetOmegaBrokerSchemaForTests?.();
  const db = d1(), cache = kv();
  db.raw.exec("DROP TABLE omega_settings; DROP TABLE omega_events; DROP TABLE omega_bridge; DROP TABLE omega_intents");
  const env = { DB: db, SIGNAL_CACHE: cache };
  await readSettings(env);
  db.raw.prepare("UPDATE omega_settings SET settings = ?, version = 1, updated_by = 'owner', updated_ms = ?, owner_saved_ms = ? WHERE id = 1").run(JSON.stringify({ ...base, entry_order: "council" }), T0 - 60_000, T0 - 60_000);
  const fault = { intent_id: "open:1:B", kind: "place_limit", why: "the EA never answered", created_ms: T0 };
  assert.equal(await recordLimitFault(env, db, fault, { now: T0 + 600_000 }), true);
  assert.equal((await readSettings(env)).limit_fault.intent_id, "open:1:B");
  assert.equal(await recordLimitFault(env, db, { ...fault, intent_id: "del:9:x", kind: "delete_order" }, { now: T0 + 700_000 }), false, "one per episode: the stop's own deletions that expire add nothing");
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'limit_fail_closed'").get().n, 1);
  // An Aether policy write keeps the stop (orchestrator review of #511); the owner's save clears it.
  await writeSettings(env, { body: { risk_pct: 1.5 }, actor: "aether" }, { now: T0 + 800_000 });
  assert.ok((await readSettings(env)).limit_fault, "Aether does not clear it");
  await writeSettings(env, { body: { risk_pct: 1.5 }, actor: "owner@example.com" }, { now: T0 + 900_000 });
  assert.equal((await readSettings(env)).limit_fault, null, "the owner's save clears it");
  assert.equal(await recordLimitFault(env, db, { ...fault, created_ms: T0 + 850_000 }, { now: T0 + 950_000 }), false, "an intent from before the owner's save opens no new fault");
  // The split (owner 2026-11-21): a "never answered" fault clears itself when the EA answers again; "no ticket" does not.
  assert.equal(await recordLimitFault(env, db, { ...fault, created_ms: T0 + 1_000_000 }, { now: T0 + 1_100_000 }), true);
  assert.equal((await readSettings(env)).limit_fault.why, LIMIT_FAULT_NO_ANSWER);
  // While open it shows: the health alert limit_fail_closed, with its age and both ways out (orchestrator review).
  const issues = await detectHealthIssues(env, T0 + 1_160_000).catch(() => []);
  const fc = issues.find((x) => x.kind === "limit_fail_closed");
  assert.ok(fc, "the open fault raises a health alert");
  assert.match(fc.subject, /fail-closed for 1 minutes.*the EA never answered; no new entry until the EA answers again or the owner saves/);
  assert.equal(await clearNoAnswerFault(env, db, { now: T0 + 1_200_000 }), true);
  assert.equal((await readSettings(env)).limit_fault, null, "the EA answered: entries resume");
  assert.equal(await recordLimitFault(env, db, { ...fault, why: LIMIT_FAULT_NO_TICKET, created_ms: T0 + 1_300_000 }, { now: T0 + 1_400_000 }), true);
  assert.equal(await clearNoAnswerFault(env, db, { now: T0 + 1_500_000 }), false, "an answer does not lift a no-ticket fault: only the owner's save does");
  assert.equal((await readSettings(env)).limit_fault.why, LIMIT_FAULT_NO_TICKET);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'limit_fault_cleared'").get().n, 1);
  await writeSettings(env, { body: { risk_pct: 1.5 }, actor: "owner@example.com" }, { now: T0 + 1_600_000 });
  db.raw.prepare("UPDATE omega_settings SET settings = ? WHERE id = 1").run(JSON.stringify({ ...base, entry_order: "market" }));
  assert.equal(await recordLimitFault(env, db, { ...fault, created_ms: T0 + 1_700_000 }, { now: T0 + 1_800_000 }), false, "with entry_order market there is nothing to stop");
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
  assert.deepEqual(driftProblems({ health: { status: "degraded", commit: "7051492efcb0" }, liveCrons: crons, expectedCrons: crons }), [], "a degraded health of the right build is no drift (no restore)");
  const old = driftProblems({ health: { status: "ok" }, liveCrons: ["10-59/15 * * * *", "6 * * * *"], expectedCrons: crons });
  assert.deepEqual(old, ["the live Worker reports no commit: not a CI build (deploy-worker.yml sets DEPLOY_COMMIT)", "crons missing: 2-59/5 * * * *"]);
  assert.match(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons, containsLast: () => false })[0], /older than the last commit/);
  assert.match(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons, onMain: () => false })[0], /not on main/);
  assert.match(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons, deployMessage: null })[0], /not made by deploy-worker\.yml/, "the VPS uploads had no message");
  assert.deepEqual(driftProblems({ health: ok, liveCrons: crons, expectedCrons: crons, deployMessage: `commit ${"7051492e".padEnd(40, "0")}` }), []);
});

test("CA8 every Omega setting is told (no key hidden by a pattern: ladder_lock_pips was, review of #511)", () => {
  const changed = Object.fromEntries(Object.entries(OMEGA_DEFAULTS).map(([k, v]) => [k, typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : `${v}_x`]));
  const r = auditSweep({ cursor: 0, baseline: { ...OMEGA_DEFAULTS } }, [row(1, T0, "owner@example.com", "settings", changed)], { now: T0 + S });
  const text = r.lines.join("\n");
  for (const k of Object.keys(OMEGA_DEFAULTS)) assert.ok(text.includes("→"), k);
  assert.equal(r.lines[0].split("\n").length - 1, Object.keys(OMEGA_DEFAULTS).length, "one bullet per setting");
  assert.match(text, /ladder_lock_pips: 30 → 31/);
});

test("CA9 every audit action is classified: told by the sweep, told where it happens, or not a change", () => {
  const lists = [Object.keys(AUDIT_ACTIONS), TOLD_ELSEWHERE, NOT_A_CHANGE];
  const all = lists.flat();
  assert.equal(new Set(all).size, all.length, "each action in one list only");
  const src = readdirSync(new URL("../src/", import.meta.url)).filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith(".d.mts")).map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
  const found = new Set([
    ...[...src.matchAll(/event\(\s*[\w.]+,\s*\w+,\s*[^,()]+,\s*"([a-z_]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/[^.\w]log\("([a-z_]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/audit\(\s*(?:db,\s*now,\s*actor,\s*)?"([a-z_]+)"/g)].map((m) => m[1]),
    // Seen in production omega_events (2026-11-21, 30 days) through a variable action name.
    "account_seen", "spec_changed", "spec_validated", "account_ref_upgraded", "owner_sub_seen", "profile_ceiling_set", "profile_agent_mode_set",
    "profile_baseline_reset", "profile_baseline_reset_override", "mode_changed", "delegate_mode_on", "delegate_mode_off", "owner_modify_position",
    "profile_control_refused", "pm_stop_loosened", "pm_tp_moved", "mode_unchanged"
  ]);
  const unclassified = [...found].filter((a) => !all.includes(a));
  assert.deepEqual(unclassified, [], "a new audit action: put it in AUDIT_ACTIONS, TOLD_ELSEWHERE or NOT_A_CHANGE (src/change-notify.mjs)");
});

test("CA10 a line Telegram does not take keeps the cursor; after three sweeps it moves on and the health alert says so", async () => {
  const db = d1(), cache = kv();
  db.raw.prepare("INSERT INTO omega_settings VALUES (1, ?, 3, 'owner', ?)").run(JSON.stringify(base), T0);
  const env = { DB: db, SIGNAL_CACHE: cache };
  await runAuditNotify(env, { now: T0, send: async () => true });
  db.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'owner', 'settings', ?)").run(T0 + S, JSON.stringify({ ...base, enabled: false }));
  const refused = async () => false;
  for (let i = 1; i < AUDIT_MAX_FAILS; i++) {
    const r = await runAuditNotify(env, { now: T0 + i * 60_000, send: refused });
    assert.deepEqual([r.status, r.retry], ["send_failed", true]);
    assert.equal(JSON.parse(cache.m.get(AUDIT_NOTIFY_KEY)).cursor, 0, "the cursor waits");
  }
  assert.equal(await auditNotifyIssue(env), null);
  const last = await runAuditNotify(env, { now: T0 + 10 * 60_000, send: refused });
  assert.deepEqual([last.status, last.retry], ["send_failed", false]);
  assert.equal(JSON.parse(cache.m.get(AUDIT_NOTIFY_KEY)).cursor, 1, "given up: moved on");
  assert.ok(cache.m.has(AUDIT_FAILED_KEY));
  assert.equal((await auditNotifyIssue(env)).kind, "audit_telegram_failed");
  // A plain actor is named, not taken for the owner (review of #511).
  assert.deepEqual([actorLabel("validator"), actorLabel("council:entry"), actorLabel("owner")], ["validator", "councilentry", "owner"]);
});
