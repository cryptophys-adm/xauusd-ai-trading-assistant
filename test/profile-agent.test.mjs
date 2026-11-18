// Account Profiles phase 3: the profile agent (docs/RFC_ACCOUNT_PROFILES.md §5, §6, §10; ADR-0020 Amendment 3).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  decideProfile, runProfileAgent, ownerSetProfile, profileReport, relayProfileChanges, profileLine, nextUtcDay, resetProfileAgentSchemaForTests,
  LADDER, DRAWDOWN_STEP_PCT, LOSS_STREAK, EXTREME_ATR_POINTS, UPGRADE_MIN_TRADES, UPGRADE_GAP_MS, RISK_PROFILE_SCHEMA
} from "../src/profile-agent.mjs";
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
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

const NOW = Date.parse("2026-11-18T10:00:00Z");
const DAY = 86_400_000;
const row = (over = {}) => ({ account_ref: "acct_0123456789abcdef", profile: "conservative", ceiling: "custom", agent_mode: "autonomous", balance_peak: 1000, dd_ref: 1000, profile_ms: NOW - 30 * DAY, created_ms: NOW - 60 * DAY, ...over });
const ctx = (over = {}) => ({ equity: 1000, balance: 1000, positions: 0, orders: 0, atr_points: 200, killed: false, daily_loss: false, deals: null, now: NOW, ...over });
const wins = (n, net = 5) => Array.from({ length: n }, () => ({ net }));

test("PA1 the ladder and the constants as decided", () => {
  assert.deepEqual([...LADDER], ["safe", "conservative", "aggressive", "custom"]);
  assert.deepEqual([DRAWDOWN_STEP_PCT, LOSS_STREAK, EXTREME_ATR_POINTS, UPGRADE_MIN_TRADES, UPGRADE_GAP_MS], [20, 4, 1000, 20, 7 * DAY]);
  assert.equal(nextUtcDay(Date.parse("2026-11-18T23:59:00Z")), Date.parse("2026-11-19T00:00:00Z"));
});

test("PA2 the kill switch or the daily loss sends any profile to Safe, forced, and blocks upgrades to the next UTC day", () => {
  for (const [k, reason] of [[{ killed: true }, "kill_switch"], [{ daily_loss: true }, "daily_loss_limit"]]) {
    const d = decideProfile(row({ profile: "custom" }), ctx(k));
    assert.deepEqual([d.change.to, d.change.reason, d.change.forced], ["safe", reason, true]);
    assert.equal(d.state.upgrade_block_until_ms, Date.parse("2026-11-19T00:00:00Z"));
  }
  const safe = decideProfile(row({ profile: "safe" }), ctx({ killed: true }));
  assert.equal(safe.change, null, "already Safe: no switch, the block is still set");
  assert.equal(safe.state.upgrade_block_until_ms, Date.parse("2026-11-19T00:00:00Z"));
});

test("PA3 a 20% drawdown steps down once, then the reference resets (no cascade)", () => {
  const d = decideProfile(row({ profile: "custom" }), ctx({ equity: 790 }));
  assert.deepEqual([d.change.to, d.change.reason, d.change.forced, d.state.dd_ref], ["aggressive", "drawdown", false, 790]);
  const again = decideProfile(row({ profile: "aggressive", dd_ref: 790 }), ctx({ equity: 780 }));
  assert.equal(again.change, null, "780 is not 20% below the new reference 790");
  assert.equal(decideProfile(row({ profile: "safe" }), ctx({ equity: 500 })).change, null, "Safe is the floor");
  assert.equal(decideProfile(row(), ctx({ equity: 810 })).change, null, "19% is no step");
});

test("PA4 extreme volatility steps down once and stays latched until the regime is below HIGH", () => {
  const d = decideProfile(row({ profile: "custom" }), ctx({ atr_points: 1200 }));
  assert.deepEqual([d.change.to, d.change.reason, d.state.vol_latched], ["aggressive", "extreme_volatility", 1]);
  assert.equal(decideProfile(row({ profile: "aggressive", vol_latched: 1 }), ctx({ atr_points: 1500 })).change, null, "latched");
  const calm = decideProfile(row({ profile: "aggressive", vol_latched: 1 }), ctx({ atr_points: 400 }));
  assert.deepEqual([calm.change, calm.state.vol_latched], [null, 0], "re-armed below 500");
});

test("PA5 four losing deals in a row since the switch step down; the streak needs the deals (cron only)", () => {
  const d = decideProfile(row(), ctx({ deals: [...wins(3), { net: -2 }, { net: -1 }, { net: -3 }, { net: -0.5 }] }));
  assert.deepEqual([d.change.to, d.change.reason], ["safe", "loss_streak"]);
  assert.equal(decideProfile(row(), ctx({ deals: [{ net: -2 }, { net: -1 }, { net: 4 }, { net: -3 }] })).change, null);
  assert.equal(decideProfile(row(), ctx({ deals: null })).change, null, "no deals read: no streak and no upgrade");
});

test("PA6 an upgrade: one step on evidence below the ceiling; every gate holds it back", () => {
  const ok = ctx({ deals: wins(UPGRADE_MIN_TRADES), equity: 1010, balance: 1010 });
  const up = decideProfile(row(), ok);
  assert.deepEqual([up.change.to, up.change.reason, up.change.evidence.trades], ["aggressive", "evidence", 20]);
  const held = [
    ["at the ceiling", row({ ceiling: "conservative" }), ok],
    ["a position open", row(), { ...ok, positions: 1 }],
    ["an order pending", row(), { ...ok, orders: 1 }],
    ["blocked after a kill", row({ upgrade_block_until_ms: NOW + 1000 }), ok],
    ["an upgrade 6 days ago", row({ last_upgrade_ms: NOW - 6 * DAY }), ok],
    ["equity below the prior peak", row({ balance_peak: 1100 }), { ...ok, equity: 1050, balance: 1050 }],
    ["19 trades", row(), { ...ok, deals: wins(19) }],
    ["a negative mean", row(), { ...ok, deals: [...wins(19, 1), { net: -30 }] }],
    ["no deals read", row(), { ...ok, deals: null }]
  ];
  for (const [label, r, c] of held) assert.equal(decideProfile(r, c).change, null, label);
  assert.equal(decideProfile(row({ profile: "custom" }), ok).change, null, "the live account (Custom, ceiling Custom) has no upgrade");
});

test("PA7 approval mode: the agent proposes, once; downgrades still run at once", () => {
  const ok = ctx({ deals: wins(UPGRADE_MIN_TRADES), equity: 1010, balance: 1010 });
  const p = decideProfile(row({ agent_mode: "approval" }), ok);
  assert.deepEqual([p.change, p.propose.to], [null, "aggressive"]);
  assert.equal(decideProfile(row({ agent_mode: "approval", pending_upgrade: JSON.stringify(p.propose) }), ok).propose, null, "not proposed twice");
  assert.equal(decideProfile(row({ agent_mode: "approval", profile: "custom" }), ctx({ killed: true })).change.to, "safe");
});

async function seeded(profile = "custom", ceiling = "custom") {
  resetAccountSpecSchemaForTests(); resetProfileAgentSchemaForTests();
  const db = d1();
  const executor = { connected: true, server: "S", executor: { version: "1.16" }, account: { currency: "USD", equity: 1000, balance: 1000, leverage: 500, margin_mode: "hedging", login_hash: "b".repeat(64) },
    symbol: { name: "GOLD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, trade_mode: "full", margin_per_lot: 0.38, atr_points: 200 }, positions: [], orders: [] };
  const a = await syncAccount(db, executor, { settings: { risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 }, now: NOW - 30 * DAY });
  if (profile !== "custom" || ceiling !== "custom") await db.prepare("UPDATE omega_accounts SET profile = ?, ceiling = ? WHERE account_ref = ?").bind(profile, ceiling, a.account_ref).run();
  const get = () => db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(a.account_ref).first();
  return { db, executor, ref: a.account_ref, get };
}

test("PA8 runProfileAgent: a forced switch writes the row, one audit row, one event and one Telegram line; the line has no account number", async () => {
  const { db, executor, ref, get } = await seeded();
  const events = [], lines = [];
  const r = await runProfileAgent(db, await get(), { executor, killed: true, now: NOW, log: async (a, d) => events.push([a, d]), notify: async (t) => lines.push(t) });
  assert.equal(r.status, "changed");
  assert.deepEqual([r.change.from, r.change.to, r.change.actor, r.change.reason, r.change.severity], ["custom", "safe", "agent", "kill_switch", "warning"]);
  assert.match(r.change.evidence_ref, /^omega_profile_changes:\d+$/);
  const after = await get();
  assert.deepEqual([after.profile, after.profile_by, after.upgrade_block_until_ms], ["safe", "agent", Date.parse("2026-11-19T00:00:00Z")]);
  assert.equal(events[0][0], "profile_changed");
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`account ${ref}: profile Custom → Safe \\(agent, the kill switch\\); no autonomous upgrade before the next UTC day`));
  const rows = db.raw.prepare("SELECT * FROM omega_profile_changes").all();
  assert.equal(rows.length, 1);
  const again = await runProfileAgent(db, after, { executor, killed: true, now: NOW + 5000 });
  assert.equal(again.status, "unchanged", "already Safe: nothing more");
});

test("PA9 runProfileAgent with evidence: the cron's upgrade needs the council and sets last_upgrade_ms; an agent failure raises nothing", async () => {
  const { db, executor, get } = await seeded("conservative", "custom");
  await db.raw.exec("CREATE TABLE IF NOT EXISTS ea_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, profit REAL, commission REAL, swap REAL, closed_ms INTEGER, source TEXT, currency TEXT)");
  for (let i = 0; i < 20; i++) db.raw.prepare("INSERT INTO ea_deals (profit, commission, swap, closed_ms, source) VALUES (6, -0.5, 0, ?, 'omega')").run(NOW - 10 * DAY + i);
  const up = { ...executor, account: { ...executor.account, equity: 1010, balance: 1010 } };
  // No council (the bridge sync): an upgrade is never raised without one.
  assert.equal((await runProfileAgent(db, await get(), { executor: up, withEvidence: true, now: NOW })).status, "unchanged");
  assert.equal((await get()).profile, "conservative");
  const review = async () => ({ id: "pc_1", kind: "upgrade", verdict: "approve", reason: "approved by 3 of 3 seats, risk included", seats: { risk: { verdict: "approve", reason: "r" }, strategy: { verdict: "approve", reason: "s" }, trade_management: { verdict: "approve", reason: "t" } } });
  const r = await runProfileAgent(db, await get(), { executor: up, withEvidence: true, now: NOW, review });
  assert.deepEqual([r.status, r.change?.to], ["changed", "aggressive"]);
  assert.equal(JSON.parse(db.raw.prepare("SELECT evidence FROM omega_profile_changes ORDER BY id DESC LIMIT 1").get().evidence).council.id, "pc_1");
  assert.equal((await get()).last_upgrade_ms, NOW);
  const broken = { prepare() { throw new Error("d1 down"); } };
  assert.equal((await runProfileAgent(broken, await get(), { executor, killed: true, now: NOW })).status, "failed");
});

test("PA10 the owner: a lower ceiling lowers the profile at once; a profile above the ceiling is refused; accept and decline", async () => {
  const { db, ref, get } = await seeded();
  const lower = await ownerSetProfile(db, { account_ref: ref, action: "ceiling", value: "conservative", now: NOW });
  assert.deepEqual([lower.ok, lower.change.to, lower.change.reason], [true, "conservative", "ceiling_lowered"]);
  assert.deepEqual([(await get()).profile, (await get()).ceiling], ["conservative", "conservative"]);
  assert.match((await ownerSetProfile(db, { account_ref: ref, action: "profile", value: "custom", now: NOW })).error, /above the ceiling/);
  assert.equal((await ownerSetProfile(db, { account_ref: ref, action: "profile", value: "safe", now: NOW })).change.to, "safe");
  assert.equal((await ownerSetProfile(db, { account_ref: ref, action: "agent_mode", value: "approval", now: NOW })).agent_mode, "approval");
  assert.equal((await ownerSetProfile(db, { account_ref: ref, action: "agent_mode", value: "yolo", now: NOW })).ok, false);
  await db.prepare("UPDATE omega_accounts SET pending_upgrade = ? WHERE account_ref = ?").bind(JSON.stringify({ to: "conservative", evidence: { trades: 20 } }), ref).run();
  const acc = await ownerSetProfile(db, { account_ref: ref, action: "accept", now: NOW });
  assert.deepEqual([acc.ok, acc.change.to, acc.change.reason, (await get()).pending_upgrade], [true, "conservative", "proposal_accepted", null]);
  assert.equal((await ownerSetProfile(db, { account_ref: ref, action: "decline", now: NOW })).error, "no proposal");
  assert.equal((await ownerSetProfile(db, { account_ref: "acct_ffffffffffffffff", action: "profile", value: "safe" })).error, "unknown account");
});

test("PA11 the risk_profile.v1 digest: the agreed fields only, info or warning, never critical, never an account number", () => {
  const rows = [
    { id: 1, account_ref: "acct_0123456789abcdef", from_profile: "custom", to_profile: "safe", actor: "agent", reason: "daily_loss_limit", severity: "warning", at_ms: NOW },
    { id: 2, account_ref: "acct_0123456789abcdef", from_profile: "safe", to_profile: "conservative", actor: "owner@example.com", reason: "owner", severity: "info", at_ms: NOW + 1000 }
  ];
  const r = profileReport(rows);
  assert.equal(r.kind, "xauusd_digest");
  assert.equal(r.body.schema, RISK_PROFILE_SCHEMA);
  assert.equal(r.severity, "warning");
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ["account_ref", "actor", "at", "evidence_ref", "from", "reason", "to"]);
  assert.equal(r.body.items[0].evidence_ref, "omega_profile_changes:1");
  assert.equal(profileReport(rows.slice(1)).severity, "info");
  const reviewed = profileReport([{ ...rows[1], actor: "agent", reason: "evidence", evidence: JSON.stringify({ trades: 20, council: { id: "pc_1", verdict: "approve", reason: "x", seats: {} } }) }]);
  assert.deepEqual(reviewed.body.items[0].council, { id: "pc_1", verdict: "approve" }, "the council's id and verdict, not its seats");
  assert.notEqual(profileReport(rows).severity, "critical");
  assert.match(profileLine("acct_0123456789abcdef", "custom", "aggressive", { actor: "agent", reason: "drawdown" }), /Custom → Aggressive \(agent, a 20% drawdown\)/);
});

test("PA12 relayProfileChanges: one report since the cursor, spaced 30 minutes; a rate limit retries", async () => {
  const { db, ref } = await seeded();
  await ownerSetProfile(db, { account_ref: ref, action: "profile", value: "safe", now: NOW });
  const env = { DB: db, SIGNAL_CACHE: kv(), AGENTS: { syscall: async () => ({}) } };
  const sent = [];
  const ok = async (_env, agent, report) => { sent.push([agent, report]); return { outcome: "success", report_id: "rpt_1" }; };
  assert.equal((await relayProfileChanges(env, { now: NOW, publish: ok })).status, "sent");
  assert.deepEqual([sent[0][0], sent[0][1].body.schema, sent[0][1].body.items.length], ["xauusd-risk-manager", "risk_profile.v1", 1]);
  assert.equal((await relayProfileChanges(env, { now: NOW + 60_000, publish: ok })).status, "waiting");
  await ownerSetProfile(db, { account_ref: ref, action: "profile", value: "conservative", now: NOW + 1000 });
  const limited = async () => ({ outcome: "denied", reason: "rate_limited" });
  assert.equal((await relayProfileChanges(env, { now: NOW + 31 * 60_000, publish: limited })).retry, true);
  assert.equal((await relayProfileChanges(env, { now: NOW + 47 * 60_000, publish: ok })).status, "sent");
  assert.equal(sent.at(-1)[1].body.items[0].to, "conservative", "the cursor kept the unsent change");
  assert.equal((await relayProfileChanges({ DB: db, SIGNAL_CACHE: kv() }, { now: NOW })).status, "disabled", "no kernel binding");
});

test("PA13 the route is owner only and same origin; the gateway checks the owner again", () => {
  const worker = readFileSync(new URL("../workers/xauusd-omega/src/omega.mjs", import.meta.url), "utf8");
  const route = worker.slice(worker.indexOf('route === "POST /api/account-profile"'), worker.indexOf('route === "POST /api/connection"'));
  assert.match(route, /same_origin_only/);
  assert.match(route, /if \(!ownerSub \|\| identity\.sub !== ownerSub\) return json\(\{ error: "owner_only" \}, 403\)/);
  assert.match(route, /\^acct_\[0-9a-f\]\{16\}\$/, "an opaque reference only");
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /async setAccountProfile[\s\S]{0,200}ownerCheck\(this\.env, input\?\.actor_sub \?\? null\) !== "owner"/);
});
