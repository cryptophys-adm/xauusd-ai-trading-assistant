// The account baseline (owner 2026-11-18, relayed and confirmed: "setuju semua"): a new account starts its own
// baseline, the same account keeps its history, the loss streak counts Omega's deals only, deposits and withdrawals
// move the baseline, and the owner's reset (refused under the kill switch or after the day's stop) says whether Omega
// saw the account before.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runProfileAgent, ownerSetProfile, accountHistory, balanceOperation, dealsSince, resetProfileAgentSchemaForTests } from "../src/profile-agent.mjs";
import { resetAccountSpecSchemaForTests, syncAccount } from "../src/account-spec.mjs";

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
  db.raw.exec("CREATE TABLE ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, profit REAL, commission REAL, swap REAL, closed_ms INTEGER, source TEXT)");
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
