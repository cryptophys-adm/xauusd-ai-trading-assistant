// The profile council (owner 2026-11-18): upgrades need its approval; a soft downgrade may be vetoed only with
// OMEGA_PROFILE_COUNCIL_DOWNGRADE "on" (platform ADR-0020 still says a downgrade is never blocked).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runProfileAgent, resetProfileAgentSchemaForTests } from "../src/profile-agent.mjs";
import { resetAccountSpecSchemaForTests, syncAccount } from "../src/account-spec.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import {
  moderate, reviewProfileChange, seatMessages, vetoLapsed, trailingLosses, downgradeCouncilOn, councilLine, resetProfileCouncilSchemaForTests,
  SEATS, PENDING_DOWNGRADE_MAX_MS, VETO_HOLD_MS, PROFILE_COUNCIL_METER
} from "../src/profile-council.mjs";

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
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const NOW = Date.parse("2026-11-18T10:00:00Z");
const DAY = 86_400_000;
const A = (v, reason = "r") => ({ verdict: v, reason });

async function seeded(profile = "conservative", ceiling = "custom") {
  resetAccountSpecSchemaForTests(); resetProfileAgentSchemaForTests(); resetProfileCouncilSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const db = d1();
  const executor = { connected: true, server: "S", executor: { version: "1.16" }, account: { currency: "USD", equity: 1000, balance: 1000, leverage: 500, margin_mode: "hedging", login_hash: "c".repeat(64) },
    symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, trade_mode: "full", margin_per_lot: 0.38, atr_points: 200, bid: 4100, ask: 4100.2 }, positions: [], orders: [] };
  const a = await syncAccount(db, executor, { settings: { risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 }, now: NOW - 30 * DAY });
  await db.prepare("UPDATE omega_accounts SET profile = ?, ceiling = ?, balance_peak = 1000, dd_ref = 1000 WHERE account_ref = ?").bind(profile, ceiling, a.account_ref).run();
  await db.raw.exec("CREATE TABLE IF NOT EXISTS ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, profit REAL, commission REAL, swap REAL, closed_ms INTEGER)");
  await db.raw.exec("CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created_ms INTEGER, updated_ms INTEGER)");
  const get = () => db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(a.account_ref).first();
  return { db, env: { DB: db, SIGNAL_CACHE: kv() }, executor, ref: a.account_ref, get };
}
const winsFor = (db, n = 20) => { for (let i = 0; i < n; i++) db.raw.prepare("INSERT INTO ea_deals (profit, commission, swap, closed_ms) VALUES (6, -0.5, 0, ?)").run(NOW - 10 * DAY + i); };
const lossesFor = (db, n) => { for (let i = 0; i < n; i++) db.raw.prepare("INSERT INTO ea_deals (profit, commission, swap, closed_ms) VALUES (-5, -0.5, 0, ?)").run(NOW - DAY + i); };
// A fake model: each seat's answer by seat name (read from the system prompt).
const callWith = (bySeat, calls = []) => async (_env, req) => {
  calls.push(req);
  const seat = SEATS.find((s) => req.messages[0].content.includes(`as the ${s.replace("_", " ")} seat`));
  const v = bySeat[seat];
  if (v === "throw") throw new Error("model down");
  return v ? { status: "answered", obj: { verdict: v, reason: `${seat} says ${v}` } } : { status: "failed" };
};

test("PC1 the moderator: an upgrade needs the risk seat and two of three; a veto needs all three answers, the risk seat and two rejects", () => {
  assert.equal(moderate("upgrade", { risk: A("approve"), strategy: A("approve"), trade_management: A("reject") }).verdict, "approve");
  assert.equal(moderate("upgrade", { risk: A("reject"), strategy: A("approve"), trade_management: A("approve") }).verdict, "reject", "risk must approve");
  assert.equal(moderate("upgrade", { risk: A("approve"), strategy: null, trade_management: A("reject") }).verdict, "reject", "a failed seat counts as reject");
  assert.equal(moderate("downgrade", { risk: A("reject"), strategy: A("reject"), trade_management: A("approve") }).verdict, "reject", "vetoed");
  assert.equal(moderate("downgrade", { risk: A("reject"), strategy: A("reject"), trade_management: null }).verdict, "approve", "a missing seat: the downgrade applies");
  assert.equal(moderate("downgrade", { risk: A("approve"), strategy: A("reject"), trade_management: A("reject") }).verdict, "approve", "the risk seat wants it: applies");
});

test("PC2 helpers: the trailing loss run, a veto lapses after 24 h or when the trigger worsens, the switch reads only \"on\"", () => {
  assert.equal(trailingLosses([{ net: 1 }, { net: -1 }, { net: -2 }]), 2);
  const veto = { reason: "drawdown", until_ms: NOW + VETO_HOLD_MS };
  assert.equal(vetoLapsed(veto, { now: NOW, reason: "drawdown", drawdownPct: 21 }), false);
  assert.equal(vetoLapsed(veto, { now: NOW, reason: "drawdown", drawdownPct: 25 }), true);
  assert.equal(vetoLapsed(veto, { now: NOW + VETO_HOLD_MS, reason: "drawdown", drawdownPct: 21 }), true);
  assert.equal(vetoLapsed(veto, { now: NOW, reason: "loss_streak" }), true, "another trigger is a new episode");
  assert.equal(vetoLapsed({ reason: "loss_streak", until_ms: NOW + 1 }, { now: NOW, reason: "loss_streak", losses: 6 }), true);
  assert.equal(downgradeCouncilOn({}), false);
  assert.equal(downgradeCouncilOn({ OMEGA_PROFILE_COUNCIL_DOWNGRADE: "on" }), true);
  assert.equal(downgradeCouncilOn({ OMEGA_PROFILE_COUNCIL_DOWNGRADE: "true" }), false);
});

test("PC3 a review: three seats on one pack with no price; recorded with its id; one upgrade review a UTC day; the cap fails it", async () => {
  const { env, db, executor, get } = await seeded();
  winsFor(db);
  const calls = [];
  const row = await get();
  const r = await reviewProfileChange(env, row, { to: "aggressive", reason: "evidence", evidence: { trades: 20 } }, { executor, deals: Array.from({ length: 20 }, () => ({ net: 5.5 })), now: NOW, call: callWith({ risk: "approve", strategy: "approve", trade_management: "reject" }, calls) });
  assert.deepEqual([r.kind, r.verdict], ["upgrade", "approve"]);
  assert.match(r.id, /^pc_\d+_/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.meterSource === PROFILE_COUNCIL_METER && c.schemaName === "profile_council"));
  const pack = JSON.parse(calls[0].messages[1].content);
  assert.deepEqual([pack.from, pack.to, pack.record_since_switch.trades, pack.vol_regime], ["conservative", "aggressive", 20, "normal"]);
  assert.doesNotMatch(calls[0].messages[1].content, /"(bid|ask|price|open_price)"/, "no price in the pack");
  assert.equal(db.raw.prepare("SELECT verdict FROM omega_profile_councils WHERE id = ?").get(r.id).verdict, "approve");
  const again = await reviewProfileChange(env, row, { to: "aggressive", reason: "evidence" }, { executor, deals: [], now: NOW + 3600_000, call: callWith({ risk: "approve", strategy: "approve", trade_management: "approve" }) });
  assert.equal(again.verdict, "skipped");
  const capped = await reviewProfileChange({ ...env, PROFILE_COUNCIL_DAILY_USD: "0" }, row, { to: "aggressive", reason: "evidence" }, { executor, deals: [], now: NOW + DAY, call: callWith({}) });
  assert.deepEqual([capped.verdict, capped.reason], ["failed", "the council's daily cap is reached"]);
  assert.match(seatMessages("risk", "downgrade", { ...pack, trigger: "drawdown" })[0].content, /prefer approve/);
});

test("PC4 an upgrade the council rejects (or cannot review) leaves the profile, with an event and one Telegram line", async () => {
  const { env, db, executor, get, ref } = await seeded();
  winsFor(db);
  const up = { ...executor, account: { ...executor.account, equity: 1010, balance: 1010 } };
  const events = [], lines = [];
  const review = (r, change, { deals }) => reviewProfileChange(env, r, change, { executor: up, deals, now: NOW, call: callWith({ risk: "reject", strategy: "approve", trade_management: "approve" }) });
  const res = await runProfileAgent(db, await get(), { executor: up, withEvidence: true, now: NOW, review, log: async (a, d) => events.push([a, d]), notify: async (t) => lines.push(t) });
  assert.equal(res.status, "refused");
  assert.equal((await get()).profile, "conservative");
  assert.equal(events[0][0], "profile_upgrade_refused");
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`account ${ref}: the profile council rejects Conservative → Aggressive; the profile stays Conservative`));
  assert.match(lines[0], /risk: reject, risk says reject/);
  const failing = await runProfileAgent(db, await get(), { executor: up, withEvidence: true, now: NOW + 60_000, review: async () => ({ id: null, kind: "upgrade", verdict: "skipped", reason: "one upgrade review a UTC day", seats: null }), notify: async (t) => lines.push(t) });
  assert.equal(failing.status, "refused");
  assert.equal(lines.length, 1, "a skipped review says nothing");
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM omega_profile_changes").get().n, 0);
});

test("PC5 downgrade review off (the default): a 20% drawdown applies at once, no review", async () => {
  const { db, executor, get } = await seeded("aggressive");
  const low = { ...executor, account: { ...executor.account, equity: 790 } };
  let asked = 0;
  const r = await runProfileAgent(db, await get(), { executor: low, now: NOW, review: async () => { asked += 1; return { verdict: "reject" }; } });
  assert.deepEqual([r.status, r.change.to, asked], ["changed", "conservative", 0]);
});

test("PC6 downgrade review on: the sync holds entries, the cron's council vetoes once, the veto holds, a worse drawdown reviews again, the kill switch still goes to Safe", async () => {
  const { env, db, executor, get } = await seeded("aggressive");
  const low = { ...executor, account: { ...executor.account, equity: 790 } };
  const lines = [];
  // The bridge sync (no council): pending, entries held.
  const s1 = await runProfileAgent(db, await get(), { executor: low, now: NOW, downgradeCouncil: true, notify: async (t) => lines.push(t) });
  assert.deepEqual([s1.status, s1.review_pending], ["review_pending", true]);
  const pending = JSON.parse((await get()).pending_downgrade);
  assert.deepEqual([pending.to, pending.reason], ["conservative", "drawdown"]);
  assert.equal((await get()).dd_ref, 1000, "the reference is kept while the review waits");
  // The cron's council: three answers, risk and strategy reject: vetoed.
  const review = (r, change, { deals }) => reviewProfileChange(env, r, change, { executor: low, deals, now: NOW + 60_000, call: callWith({ risk: "reject", strategy: "reject", trade_management: "approve" }) });
  const c1 = await runProfileAgent(db, await get(), { executor: low, now: NOW + 60_000, withEvidence: true, downgradeCouncil: true, review, notify: async (t) => lines.push(t) });
  assert.equal(c1.status, "vetoed");
  const after = await get();
  assert.deepEqual([after.profile, after.pending_downgrade], ["aggressive", null]);
  assert.equal(JSON.parse(after.council_veto).reason, "drawdown");
  const audit = db.raw.prepare("SELECT * FROM omega_profile_changes").all();
  assert.deepEqual(audit.map((x) => [x.from_profile, x.to_profile, x.actor, x.reason, x.severity]), [["aggressive", "aggressive", "council", "council_veto", "warning"]]);
  assert.match(lines.at(-1), /vetoes the downgrade Aggressive → Conservative/);
  // The veto holds on the same drawdown.
  const s2 = await runProfileAgent(db, await get(), { executor: low, now: NOW + 120_000, downgradeCouncil: true });
  assert.deepEqual([s2.status, (await get()).profile], ["vetoed", "aggressive"]);
  // A worse drawdown (25%): the veto lapses, a new review is pending.
  const worse = { ...executor, account: { ...executor.account, equity: 740 } };
  const s3 = await runProfileAgent(db, await get(), { executor: worse, now: NOW + 180_000, downgradeCouncil: true });
  assert.equal(s3.status, "review_pending");
  // The kill switch never waits.
  const k = await runProfileAgent(db, await get(), { executor: worse, now: NOW + 190_000, downgradeCouncil: true, killed: true });
  assert.deepEqual([k.status, k.change.to], ["changed", "safe"]);
  const fin = await get();
  assert.deepEqual([fin.pending_downgrade, fin.council_veto], [null, null]);
});

test("PC7 downgrade review on: a review that does not run in time, a failed council or the switch turned off applies the downgrade", async () => {
  for (const variant of ["late", "failed", "off"]) {
    const { env, db, executor, get } = await seeded("aggressive");
    const low = { ...executor, account: { ...executor.account, equity: 790 } };
    await runProfileAgent(db, await get(), { executor: low, now: NOW, downgradeCouncil: true });
    const at = variant === "late" ? NOW + PENDING_DOWNGRADE_MAX_MS : NOW + 60_000;
    const review = (r, change, { deals }) => reviewProfileChange(env, r, change, { executor: low, deals, now: at, call: callWith({ risk: "throw", strategy: "throw", trade_management: "throw" }) });
    const r = await runProfileAgent(db, await get(), { executor: low, now: at, withEvidence: true, downgradeCouncil: variant !== "off", review: variant === "late" ? null : review });
    assert.deepEqual([r.status, r.change?.to], ["changed", "conservative"], variant);
    const row = await get();
    assert.deepEqual([row.pending_downgrade, row.dd_ref], [null, 790], variant);
    const ev = JSON.parse(db.raw.prepare("SELECT evidence FROM omega_profile_changes ORDER BY id DESC LIMIT 1").get().evidence);
    assert.ok(ev.council, variant);
  }
});

test("PC8 the Telegram line names the verdict and every seat, never an account number", () => {
  const line = councilLine("acct_0123456789abcdef", { kind: "upgrade", verdict: "approve", reason: "approved by 2 of 3 seats, risk included", seats: { risk: A("approve", "dd small"), strategy: A("approve", "edge"), trade_management: null } }, { from: "conservative", to: "aggressive" });
  assert.match(line, /the profile council approves Conservative → Aggressive/);
  assert.match(line, /trade management: no answer/);
  assert.doesNotMatch(line, /login|\b\d{6,}\b/);
});
