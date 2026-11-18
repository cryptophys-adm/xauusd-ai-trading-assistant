// The account baseline (owner 2026-11-18, relayed and confirmed: "setuju semua"): a new account starts its own
// baseline, the same account keeps its history, the loss streak counts Omega's deals only, deposits and withdrawals
// move the baseline, and the owner's reset (refused under the kill switch or after the day's stop) says whether Omega
// saw the account before.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runProfileAgent, ownerSetProfile, accountHistory, balanceOperation, dealsSince, resetProfileAgentSchemaForTests } from "../src/profile-agent.mjs";
import { resetAccountSpecSchemaForTests, syncAccount, dailyLossExecutor } from "../src/account-spec.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const NOW = Date.parse("2026-11-18T10:00:00Z");
const DAY = 86_400_000;
const exec = (equity = 1000, balance = 1000, hash = "d") => ({ connected: true, server: "FxPro-MT5 Demo", executor: { version: "1.16" }, account: { currency: "USD", equity, balance, leverage: 500, margin_mode: "hedging", login_hash: hash.repeat(64), trade_mode: "demo" },
  symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, trade_mode: "full", margin_per_lot: 0.38, atr_points: 200 }, positions: [], orders: [] });

async function seeded() {
  resetAccountSpecSchemaForTests(); resetProfileAgentSchemaForTests();
  const db = d1();
  db.raw.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, profit REAL, commission REAL, swap REAL, closed_ms INTEGER, source TEXT, currency TEXT)");
  const a = await syncAccount(db, exec(), { settings: { risk_pct: 2, max_positions: 3, max_daily_loss_pct: 10 }, now: NOW - DAY });
  const get = () => db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(a.account_ref).first();
  return { db, ref: a.account_ref, get };
}
const deal = (db, profit, source, at) => db.raw.prepare("INSERT INTO ea_deals (profit, commission, swap, closed_ms, source) VALUES (?, 0, 0, ?, ?)").run(profit, at, source);

test("AB1 the loss streak and the evidence read Omega's deals only, never manual ones", async () => {
  const { db } = await seeded();
  for (let i = 0; i < 5; i++) deal(db, -40, "manual", NOW - 1000 + i);
  deal(db, -3, "omega", NOW - 500);
  const d = await dealsSince(db, NOW - 10_000);
  assert.deepEqual(d.map((x) => x.net), [-3]);
});

test("AB2 deposits and withdrawals move the drawdown reference and the peak, never trigger a drawdown", async () => {
  assert.equal(balanceOperation({ lastBalance: 1000, balance: 1010, dealsNet: 10 }), 0, "a deal explains it");
  assert.equal(balanceOperation({ lastBalance: 1000, balance: 1500, dealsNet: 0 }), 500);
  assert.equal(balanceOperation({ lastBalance: 1000, balance: 1000.5, dealsNet: 0 }), 0, "within the tolerance");
  const { db, get } = await seeded();
  const events = [];
  const log = async (a, d) => events.push([a, d]);
  // First check: the baseline (peak 1000, reference 1000).
  await runProfileAgent(db, await get(), { executor: exec(1000, 1000), now: NOW, log });
  assert.deepEqual([(await get()).balance_peak, (await get()).dd_ref], [1000, 1000]);
  // A 300 withdrawal: equity 700 is no 30% drawdown, the reference follows.
  const r = await runProfileAgent(db, await get(), { executor: exec(700, 700), now: NOW + 60_000, log });
  assert.equal(r.status, "unchanged");
  const after = await get();
  assert.deepEqual([after.dd_ref, after.balance_peak, after.profile], [700, 700, "custom"]);
  assert.deepEqual(events.find((e) => e[0] === "balance_operation")[1].amount, -300);
  // A losing Omega deal is P&L, not a withdrawal.
  deal(db, -50, "omega", NOW + 90_000);
  await runProfileAgent(db, await get(), { executor: exec(650, 650), now: NOW + 120_000, log });
  assert.equal((await get()).dd_ref, 700);
  assert.equal(events.filter((e) => e[0] === "balance_operation").length, 1);
});

test("AB3 the owner's reset: the connected account only, never under the kill switch or after the day's stop; history kept, audited", async () => {
  const { db, ref, get } = await seeded();
  await db.prepare("UPDATE omega_accounts SET profile = 'aggressive', ceiling = 'aggressive', balance_peak = 1200, dd_ref = 1100, vol_latched = 1 WHERE account_ref = ?").bind(ref).run();
  for (let i = 0; i < 3; i++) deal(db, -10, "omega", NOW - 1000 + i);
  const lines = [], events = [];
  const base = { account_ref: ref, action: "reset", actor: "owner@example.com", now: NOW, executor: exec(950, 960), connectedRef: ref, log: async (a, d) => events.push([a, d]), notify: async (t) => lines.push(t) };
  assert.match((await ownerSetProfile(db, { ...base, killed: true })).error, /kill switch is on/);
  assert.match((await ownerSetProfile(db, { ...base, connectedRef: "acct_ffffffffffffffff" })).error, /only the connected account/);
  await db.prepare("UPDATE omega_accounts SET upgrade_block_until_ms = ? WHERE account_ref = ?").bind(NOW + 3_600_000, ref).run();
  assert.match((await ownerSetProfile(db, base)).error, /fired today: no reset before 11:00 UTC/);
  await db.prepare("UPDATE omega_accounts SET upgrade_block_until_ms = ? WHERE account_ref = ?").bind(NOW - 1, ref).run();
  const r = await ownerSetProfile(db, base);
  assert.equal(r.ok, true);
  const row = await get();
  assert.deepEqual([row.dd_ref, row.balance_peak, row.baseline_ms, row.vol_latched, row.profile, row.ceiling], [950, 960, NOW, 0, "aggressive", "aggressive"]);
  const audit = db.raw.prepare("SELECT * FROM omega_profile_changes WHERE reason = 'owner_reset'").get();
  const ev = JSON.parse(audit.evidence);
  assert.deepEqual([ev.previous.balance_peak, ev.previous.dd_ref, ev.previous.losses_in_a_row], [1200, 1100, 3]);
  assert.equal(events[0][0], "profile_baseline_reset");
  assert.match(lines[0], /baseline reset by the owner. Peak 1200.00 → 960.00, drawdown reference 1100.00 → 950.00, loss streak 3 → 0/);
  // The streak counts from the reset.
  assert.equal((await accountHistory(db, row, { now: NOW + 1000 })).losses_in_a_row, 0);
});

test("AB4 seen before: a new login is first time on Omega with its own row; the same login again keeps its row and history", async () => {
  const { db, ref, get } = await seeded();
  const h = await accountHistory(db, await get(), { now: NOW });
  assert.equal(h.first_time, false, "seen a day ago");
  assert.equal(h.first_seen_ms, NOW - DAY);
  const other = await syncAccount(db, exec(500, 500, "e"), { now: NOW });
  assert.notEqual(other.account_ref, ref);
  assert.deepEqual([other.profile, other.ceiling], ["safe", "safe"]);
  const oh = await accountHistory(db, other.row, { now: NOW + 60_000 });
  assert.equal(oh.first_time, true);
  const back = await syncAccount(db, exec(), { now: NOW + 2 * 3_600_000 });
  assert.equal(back.account_ref, ref, "the same login: its own row");
  assert.equal((await get()).last_seen_ms, NOW + 2 * 3_600_000);
});

test("AB5 the onboarding day: the daily loss counts from the balance at onboarding, so losses before Omega never trip it", async () => {
  const { dailyLossExecutor, onboardingDayRef } = await import("../src/account-spec.mjs");
  const { dailyLossHit } = await import("../src/strategy-arm.mjs");
  const created = Date.parse("2026-11-18T08:29:57Z");
  const row = { created_ms: created, onboard_balance: 54.5, balance_peak: 54.5 };
  const ex = { account: { equity: 54.5, balance: 54.5, day_start_balance: 3370.69, day_realized_pl: -3316.19 } };
  assert.equal(dailyLossHit(ex, 20), true, "the broker's day start: tripped by the manual losses");
  const day = dailyLossExecutor(ex, row, created + 3_600_000);
  assert.deepEqual([day.account.day_start_balance, day.account.day_realized_pl, day.account.broker_day_start_balance, day.account.day_reference], [54.5, 0, 3370.69, "onboarding"]);
  assert.equal(dailyLossHit(day, 20), false);
  assert.equal(dailyLossHit(dailyLossExecutor({ account: { ...ex.account, equity: 40 } }, row, created + 3_600_000), 20), true, "a loss after onboarding still counts");
  assert.equal(onboardingDayRef(row, Date.parse("2026-11-19T00:00:01Z")), null, "the next day: the broker's day start");
  assert.equal(dailyLossExecutor(ex, row, Date.parse("2026-11-19T01:00:00Z")), ex);
  assert.equal(onboardingDayRef({ created_ms: created, balance_peak: 54.5 }, created + 1000), 54.5, "a row from before the column: its first peak");
});

test("AB6 a block from before onboarding counted is lifted once; a recorded daily-loss block stands; the owner may still raise the profile, audited", async () => {
  const { db, ref, get } = await seeded();
  await db.prepare("UPDATE omega_accounts SET profile = 'safe', ceiling = 'aggressive', upgrade_block_until_ms = ? WHERE account_ref = ?").bind(NOW + 3_600_000, ref).run();
  const events = [];
  await runProfileAgent(db, await get(), { executor: exec(), now: NOW, onboardingDay: true, log: async (a, d) => events.push([a, d]) });
  assert.equal((await get()).upgrade_block_until_ms, null);
  assert.ok(events.some((e) => e[0] === "upgrade_block_cleared"));
  // A real daily loss now: the block has its reason and is not lifted when equity recovers.
  await runProfileAgent(db, await get(), { executor: exec(), now: NOW + 1000, onboardingDay: true, dailyLoss: true });
  const blocked = await get();
  assert.deepEqual([blocked.upgrade_block_reason, blocked.upgrade_block_until_ms > NOW], ["daily_loss_limit", true]);
  await runProfileAgent(db, await get(), { executor: exec(), now: NOW + 2000, onboardingDay: true });
  assert.ok((await get()).upgrade_block_until_ms > NOW, "a recorded block stands to the next UTC day");
  // The owner overrides it: recorded as owner_override_daily_lock.
  const lines = [];
  const r = await ownerSetProfile(db, { account_ref: ref, action: "profile", value: "conservative", actor: "owner@example.com", now: NOW + 3000, notify: async (t) => lines.push(t) });
  assert.equal(r.ok, true);
  assert.equal(r.change.reason, "owner_override_daily_lock");
  assert.match(lines[0], /overriding today's daily loss block/);
});

test("AB7 approval mode: the proposal carries the council's advice and an expiry, the Telegram line a deep link; an expired proposal cannot be accepted", async () => {
  const { db, ref, get } = await seeded();
  await db.prepare("UPDATE omega_accounts SET profile = 'safe', ceiling = 'aggressive', agent_mode = 'approval', balance_peak = 1000, profile_ms = ? WHERE account_ref = ?").bind(NOW - 10 * DAY, ref).run();
  for (let i = 0; i < 20; i++) deal(db, 6, "omega", NOW - 5 * DAY + i);
  const lines = [];
  const review = async () => ({ id: "pc_9", kind: "upgrade", verdict: "approve", reason: "approved by 3 of 3 seats, risk included", seats: {} });
  const r = await runProfileAgent(db, await get(), { executor: exec(1010, 1010), withEvidence: true, now: NOW, review, notify: async (t) => lines.push(t) });
  assert.equal(r.status, "proposed");
  const p = JSON.parse((await get()).pending_upgrade);
  assert.deepEqual([p.to, p.council.verdict, p.expires_ms], ["conservative", "approve", NOW + DAY]);
  assert.match(lines[0], /Council: approve .* https:\/\/nexus\.cryptophys\.work\/omega#setup\/profile/);
  assert.match((await ownerSetProfile(db, { account_ref: ref, action: "accept", now: NOW + DAY + 1 })).error, /expired/);
});

test("AB8 the owner's override (owner 2026-11-18): reset and lift today's daily loss stop; never over the kill switch; audited", async () => {
  const { db, ref, get } = await seeded();
  await db.prepare("UPDATE omega_accounts SET profile = 'safe', balance_peak = 1295.96, dd_ref = 1295.96, upgrade_block_until_ms = ?, upgrade_block_reason = 'daily_loss_limit' WHERE account_ref = ?").bind(NOW + 3_600_000, ref).run();
  const lines = [], events = [];
  const base = { account_ref: ref, actor: "owner@example.com", now: NOW, executor: exec(41.96, 41.96), connectedRef: ref, log: async (a, d) => events.push([a, d]), notify: async (t) => lines.push(t) };
  assert.match((await ownerSetProfile(db, { ...base, action: "reset" })).error, /or reset with the owner's override/);
  assert.match((await ownerSetProfile(db, { ...base, action: "reset_override", killed: true })).error, /kill switch is on/);
  await db.prepare("UPDATE omega_accounts SET upgrade_block_reason = 'kill_switch' WHERE account_ref = ?").bind(ref).run();
  assert.match((await ownerSetProfile(db, { ...base, action: "reset_override" })).error, /kill switch fired today: no override/);
  await db.prepare("UPDATE omega_accounts SET upgrade_block_reason = 'daily_loss_limit' WHERE account_ref = ?").bind(ref).run();
  const r = await ownerSetProfile(db, { ...base, action: "reset_override" });
  assert.equal(r.ok, true);
  const row = await get();
  assert.deepEqual([row.dd_ref, row.balance_peak, row.upgrade_block_until_ms, row.upgrade_block_reason, row.profile], [41.96, 41.96, null, null, "safe"]);
  assert.deepEqual(JSON.parse(row.day_ref_override), { day: "2026-11-18", ref: 41.96, at_ms: NOW, actor: "owner@example.com" });
  const audit = db.raw.prepare("SELECT * FROM omega_profile_changes WHERE reason = 'owner_reset_override_daily_lock'").get();
  assert.equal(audit.severity, "warning");
  assert.equal(JSON.parse(audit.evidence).previous.upgrade_block_reason, "daily_loss_limit");
  assert.equal(events[0][0], "profile_baseline_reset_override");
  assert.match(lines[0], /daily loss stop LIFTED by the owner's override: the day's loss now counts from 41\.96/);
  // The daily loss counts from the equity at the override, today only (the broker's day start was $54.50).
  const ex = { ...exec(41.96, 41.96), account: { ...exec(41.96, 41.96).account, day_start_balance: 54.5 } };
  assert.equal(dailyLossExecutor(ex, row, NOW + 60_000).account.day_start_balance, 41.96);
  assert.equal(dailyLossExecutor(ex, row, NOW + 60_000).account.day_reference, "owner_override");
  assert.equal(dailyLossExecutor(ex, row, NOW + DAY).account.day_start_balance, 54.5, "the next UTC day ignores it");
});

test("AB9 deposits and withdrawals never count as the day's loss (owner 2026-11-18: \"Setuju keduanya\"); a zero-balance reading is no withdrawal", async () => {
  const { dailyLossExecutor, dayOpsSince, withDayOp } = await import("../src/account-spec.mjs");
  const { dailyLossHit } = await import("../src/strategy-arm.mjs");
  const now = Date.parse("2026-11-20T12:00:00Z");
  // The broker's day start 1000; the owner withdrew 300 at 10:00: equity 690 is a 1.4% day, not 31%.
  let row = { created_ms: Date.parse("2026-11-01T00:00:00Z") };
  row = { ...row, day_ops: withDayOp(row, { amount: -300, at_ms: Date.parse("2026-11-20T10:00:00Z") }) };
  const ex = { account: { equity: 690, balance: 690, day_start_balance: 1000, day_realized_pl: -310 } };
  assert.equal(dailyLossHit(ex, 20), true, "without the rule the withdrawal trips a 20% stop");
  const day = dailyLossExecutor(ex, row, now);
  assert.deepEqual([day.account.day_start_balance, day.account.day_realized_pl, day.account.day_reference, day.account.day_balance_ops, day.account.broker_day_start_balance], [700, -10, "broker", -300, 1000]);
  assert.equal(dailyLossHit(day, 20), false);
  // A deposit never hides a loss: +500 then equity 1200 is a 300 loss on a 1500 start (20%).
  const dep = { ...row, day_ops: withDayOp({}, { amount: 500, at_ms: Date.parse("2026-11-20T09:00:00Z") }) };
  assert.equal(dailyLossHit(dailyLossExecutor({ account: { equity: 1200, balance: 1200, day_start_balance: 1000 } }, dep, now), 20), true);
  // Yesterday's operations are not today's; none today leaves the executor as it is.
  assert.equal(dailyLossExecutor(ex, row, Date.parse("2026-11-21T01:00:00Z")), ex);
  assert.equal(dayOpsSince(row, now, Date.parse("2026-11-20T11:00:00Z")), 0, "only after the reference");
  // The owner's reset at 11:00 (ref 700): an op after it moves it, one before it is already in it.
  const over = { ...row, day_ref_override: JSON.stringify({ day: "2026-11-20", ref: 700, at_ms: Date.parse("2026-11-20T11:00:00Z") }) };
  assert.equal(dailyLossExecutor(ex, over, now).account.day_start_balance, 700);
  const over2 = { ...over, day_ops: withDayOp(over, { amount: -100, at_ms: Date.parse("2026-11-20T11:30:00Z") }) };
  assert.equal(dailyLossExecutor(ex, over2, now).account.day_start_balance, 600);
  // The onboarding reference already moves with the operation (accountForBalanceOps): no second count.
  const onb = { created_ms: Date.parse("2026-11-20T08:00:00Z"), onboard_balance: 700, day_ops: withDayOp({}, { amount: -300, at_ms: Date.parse("2026-11-20T10:00:00Z") }) };
  assert.equal(dailyLossExecutor({ account: { equity: 690, balance: 690, day_start_balance: 3000 } }, onb, now).account.day_start_balance, 700);
  // The list is per UTC day.
  assert.deepEqual(JSON.parse(withDayOp(row, { amount: 5, at_ms: Date.parse("2026-11-21T00:01:00Z") })).ops.length, 1);

  // The check: a 0 balance while the terminal loads an account is skipped; the next real reading compares with the last.
  const { db, get } = await seeded();
  const events = [];
  const log = async (a, d) => events.push([a, d]);
  await runProfileAgent(db, await get(), { executor: exec(1000, 1000), now: NOW, log });
  await runProfileAgent(db, await get(), { executor: exec(0, 0), now: NOW + 60_000, log });
  await runProfileAgent(db, await get(), { executor: exec(1000, 1000), now: NOW + 120_000, log });
  assert.equal(events.filter((e) => e[0] === "balance_operation").length, 0, "no -1000 then +1000");
  await runProfileAgent(db, await get(), { executor: exec(800, 800), now: NOW + 180_000, log });
  assert.equal(events.filter((e) => e[0] === "balance_operation").length, 1);
  const ops = JSON.parse((await get()).day_ops);
  assert.deepEqual(ops.ops.map((o) => o.amount), [-200]);
});
