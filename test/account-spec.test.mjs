// Account Profiles phase 1 (docs/RFC_ACCOUNT_PROFILES.md §1, §2, §4, §9; owner 2026-11-18): the broker spec with its
// hash and the entry gate on a change, the EA version gate (off by default), the stored profile (the live account
// as Custom), OmegaExecutor 1.15's spec report and last-gate checks, and no login anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  specFrom, specHash, specProblem, accountRef, specDiff, syncAccount, readAccounts, resetAccountSpecSchemaForTests,
  eaVersionGateOn, versionAtLeast, SPEC_SETTLE_MS, EXECUTOR_ENTRY_MIN_VERSION, PROFILES, customFrom
} from "../src/account-spec.mjs";
import { planIntents, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { bridgeSync, brokerOverview, writeSettings, resetOmegaBrokerSchemaForTests, executorFrom } from "../src/omega-broker.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        // D1 binds at most 100 parameters a statement: the test database refuses more, as D1 does.
        bind(...args) { if (args.length > 100) throw new Error("D1: too many SQL variables"); params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-18T10:00:00Z");
const LOGIN_HASH = createHash("sha256").update("omega|Broker-Live|5550123").digest("hex");

/** An executor state as executorFrom gives it, for OmegaExecutor 1.14 or 1.15. */
function executor({ version = "1.15", server = "Broker-Live", over = {}, sym = {}, acct = {} } = {}) {
  const full = versionAtLeast(version, "1.15");
  return {
    connected: true, server, received_ms: NOW - 1000,
    executor: { name: "OmegaExecutor", version, auto_break_even: false, trailing_stop: false, dynamic_atr_stop: true, local_management: false, up_to_date: true },
    account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0, ...(full ? { leverage: 500, margin_mode: "hedging", margin_free: 9_000, login_hash: LOGIN_HASH } : {}), ...acct },
    symbol: { name: "XAUUSD", currency_profit: "USD", currency_base: "XAU", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20, ...(full ? { freeze_level_points: 0, trade_mode: "full", margin_per_lot: 820.24 } : {}), ...sym },
    symbol_error: null, positions: [], orders: [], deals: [],
    ...over
  };
}

test("AS1 the hash covers the stable spec only: a quote, equity, free margin, margin per lot, tick value or stops level is no change", async () => {
  const a = executor(), b = executor({ sym: { bid: 4200, ask: 4200.3, margin_per_lot: 840, tick_value: 1.01, stops_level_points: 40, freeze_level_points: 10, spread_points: 60 }, acct: { equity: 9_000, margin_free: 1 } });
  assert.equal(await specHash(specFrom(a)), await specHash(specFrom(b)));
  for (const [label, changed] of [
    ["contract", executor({ sym: { contract_size: 10 } })], ["lot step", executor({ sym: { volume_step: 0.1 } })], ["server", executor({ server: "Other-Live" })],
    ["leverage", executor({ acct: { leverage: 100 } })], ["margin mode", executor({ acct: { margin_mode: "netting" } })], ["trade mode", executor({ sym: { trade_mode: "close_only" } })]
  ]) assert.notEqual(await specHash(specFrom(a)), await specHash(specFrom(changed)), label);
  assert.match(await specHash(specFrom(a)), /^[0-9a-f]{16}$/);
  assert.deepEqual(specDiff(specFrom(a), specFrom(executor({ sym: { contract_size: 10, volume_step: 0.1 } }))), ["contract_size", "volume_step"]);
});

test("AS2 specProblem: 1.14 needs the fields it reports; 1.15 also leverage, margin mode, trade mode and margin per lot", () => {
  assert.equal(specProblem(executor()), null);
  assert.equal(specProblem(executor({ version: "1.14" })), null, "1.14 has no leverage and still validates");
  assert.equal(specProblem(executor({ sym: { tick_value: 0 } })), "tick_value");
  assert.equal(specProblem(executor({ sym: { volume_max: 0.001 } })), "volume_max");
  assert.equal(specProblem(executor({ sym: { digits: 2.5 } })), "digits");
  assert.equal(specProblem(executor({ server: "" })), "no_server");
  assert.equal(specProblem(executor({ acct: { leverage: 0 } })), "leverage");
  assert.equal(specProblem(executor({ acct: { margin_mode: "unknown" } })), "margin_mode");
  assert.equal(specProblem(executor({ sym: { trade_mode: "close_only" } })), "trade_mode_close_only");
  assert.equal(specProblem(executor({ sym: { margin_per_lot: -0.5 } })), "margin_per_lot", "negative; 0 is valid under unlimited leverage (AS18)");
  assert.equal(specProblem(null), "no_state");
});

test("AS3 the account reference is opaque: from the EA's login hash (1.15) or the server (before), never the login", async () => {
  const full = await accountRef(executor()), old = await accountRef(executor({ version: "1.14" }));
  assert.match(full.ref, /^acct_[0-9a-f]{16}$/);
  assert.equal(full.legacy, false);
  assert.equal(old.legacy, true);
  assert.equal(full.legacy_ref, old.ref, "the same server's legacy reference, for the adoption");
  assert.ok(!full.ref.includes("5550123") && !LOGIN_HASH.startsWith(full.ref.slice(5)), "neither the login nor the EA's hash itself");
  assert.equal((await accountRef(executor({ acct: { login_hash: "not-hex" } }))).legacy, true, "a malformed hash is ignored");
});

test("AS4 the first account is the live one: Custom with today's settings, ceiling Custom, autonomous; a later one starts Safe in approval", async () => {
  resetAccountSpecSchemaForTests();
  const db = d1(), events = [], lines = [];
  const settings = { ...OMEGA_DEFAULTS, risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 };
  const opts = (now) => ({ settings, now, log: async (a, d) => events.push([a, d]), notify: async (t) => lines.push(t) });
  const first = await syncAccount(db, executor(), opts(NOW));
  assert.deepEqual([first.spec_status, first.profile, first.ceiling, first.agent_mode], ["validated", "custom", "custom", "autonomous"], "a first usable spec is no change");
  const [row] = await readAccounts(db);
  assert.deepEqual(row.custom, { risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 });
  assert.equal(events[0][0], "account_seen");
  assert.equal(lines.length, 1);
  const other = await syncAccount(db, executor({ server: "Other-Demo", acct: { login_hash: "a".repeat(64) } }), opts(NOW));
  assert.deepEqual([other.profile, other.ceiling, other.agent_mode], ["safe", "safe", "approval"]);
  assert.deepEqual(customFrom({}), { risk_pct: null, max_positions: null, max_daily_loss_pct: null });
  assert.deepEqual(Object.keys(PROFILES), ["safe", "conservative", "aggressive", "custom"]);
  assert.equal(PROFILES.aggressive.hard_cap_pct, 10, "the owner's 10% maximum");
});

test("AS5 a changed spec blocks new entries until it has held SPEC_SETTLE_MS; one event and one Telegram line each way, no write in between", async () => {
  resetAccountSpecSchemaForTests();
  const db = d1(), events = [], lines = [];
  let writes = 0;
  const counted = { prepare(sql) { const s = db.prepare(sql); if (/^\s*(INSERT|UPDATE)/i.test(sql)) { const run = s.run; return { ...s, bind(...a) { s.bind(...a); return this; }, first: s.first, all: s.all, async run() { writes++; return run(); } }; } return s; } };
  const opts = (now) => ({ now, log: async (a, d) => events.push([a, d]), notify: async (t) => lines.push(t) });
  await syncAccount(counted, executor(), opts(NOW));
  const w0 = writes;
  assert.equal((await syncAccount(counted, executor({ sym: { bid: 4200 } }), opts(NOW + 5_000))).spec_status, "validated");
  assert.equal(writes, w0, "the same spec writes nothing");
  const changed = executor({ sym: { contract_size: 10 } });
  const c1 = await syncAccount(counted, changed, opts(NOW + 10_000));
  assert.equal(c1.spec_status, "pending");
  assert.equal(events.at(-1)[0], "spec_changed");
  assert.deepEqual(events.at(-1)[1].changed, ["contract_size"]);
  const w1 = writes;
  assert.equal((await syncAccount(counted, changed, opts(NOW + 10_000 + SPEC_SETTLE_MS - 1))).spec_status, "pending");
  assert.equal(writes, w1, "waiting writes nothing");
  assert.equal((await syncAccount(counted, changed, opts(NOW + 10_000 + SPEC_SETTLE_MS))).spec_status, "validated");
  assert.equal(events.at(-1)[0], "spec_validated");
  assert.equal(lines.length, 3, "seen, changed, validated");
  assert.ok(lines.every((l) => !l.includes("5550123") && !l.includes(LOGIN_HASH)), "no login in a Telegram line");
});

test("AS6 an unusable spec blocks; a same-spec flap is an event only and validates again without a Telegram line", async () => {
  resetAccountSpecSchemaForTests();
  const db = d1(), events = [], lines = [];
  const opts = (now) => ({ now, log: async (a) => events.push(a), notify: async (t) => lines.push(t) });
  await syncAccount(db, executor(), opts(NOW));
  const flap = await syncAccount(db, executor({ sym: { tick_value: 0 } }), opts(NOW + 5_000));
  assert.deepEqual([flap.spec_status, flap.spec_problem], ["invalid", "tick_value"]);
  assert.equal((await syncAccount(db, executor(), opts(NOW + 10_000))).spec_status, "pending");
  assert.equal((await syncAccount(db, executor(), opts(NOW + 10_000 + SPEC_SETTLE_MS))).spec_status, "validated");
  assert.deepEqual(events, ["account_seen", "spec_invalid", "spec_validated"]);
  assert.equal(lines.length, 1, "only the first sighting went to Telegram");
  resetAccountSpecSchemaForTests();
  const bad = await syncAccount(d1(), executor({ sym: { trade_mode: "disabled" } }), opts(NOW));
  assert.deepEqual([bad.spec_status, bad.spec_problem], ["invalid", "trade_mode_disabled"], "a first unusable spec never validates");
});

test("AS7 a login is its own account: the row an older EA left under the server's name is never adopted (owner 2026-11-18)", async () => {
  resetAccountSpecSchemaForTests();
  const db = d1(), events = [];
  const opts = (now) => ({ settings: { ...OMEGA_DEFAULTS, risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 }, now, log: async (a) => events.push(a) });
  const old = await syncAccount(db, executor({ version: "1.14" }), opts(NOW));
  const up = await syncAccount(db, executor(), opts(NOW + 5_000));
  assert.notEqual(up.account_ref, old.account_ref);
  assert.deepEqual([up.profile, up.ceiling, up.agent_mode, up.spec_status], ["safe", "safe", "approval", "validated"], "a new account with its own baseline");
  assert.deepEqual(events, ["account_seen", "account_seen"]);
  assert.equal((await readAccounts(db)).length, 2, "the old row stays as history");
  // The same login again: its own row and history, no new row.
  const again = await syncAccount(db, executor(), opts(NOW + 60_000));
  assert.equal(again.account_ref, up.account_ref);
  assert.equal((await readAccounts(db)).length, 2);
});

test("AS8 planIntents: spec_unvalidated and ea_outdated stop new entries only; management and closes still run; no account, no gate", () => {
  const signal = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: NOW - 60_000, expires_ms: NOW + 600_000, blackout: false, kill: false, paused: false };
  const base = { signal, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true }, now: NOW, engineEnabled: true };
  const kinds = (p) => p.intents.map((i) => i.kind);
  assert.deepEqual(kinds(planIntents({ ...base, executor: executor() })), ["open"]);
  assert.deepEqual(kinds(planIntents({ ...base, executor: executor(), account: { spec_status: "validated" } })), ["open"]);
  for (const status of ["pending", "invalid", "unknown"]) {
    const p = planIntents({ ...base, executor: executor(), account: { spec_status: status } });
    assert.deepEqual([kinds(p), p.notes.at(-1).code], [[], "spec_unvalidated"], status);
  }
  const review = planIntents({ ...base, executor: executor(), account: { spec_status: "validated", review_pending: true } });
  assert.deepEqual([kinds(review), review.notes.at(-1).code], [[], "profile_review_pending"], "a downgrade waiting for the council opens nothing");
  const short = { ticket: 7, side: "SELL", volume: 0.1, open_price: 4110, sl: 4120, tp: 4090, magic: 920200, intent_id: "open:x:SELL", source: "omega" };
  const closing = planIntents({ ...base, executor: executor({ over: { positions: [short] } }), account: { spec_status: "pending" } });
  assert.deepEqual(kinds(closing), ["close"], "the opposite position is still closed");
  const outdated = planIntents({ ...base, executor: executor({ version: "1.14" }), eaGate: true });
  assert.deepEqual([kinds(outdated), outdated.notes.at(-1).code], [[], "ea_outdated"]);
  assert.deepEqual(kinds(planIntents({ ...base, executor: executor({ version: "1.16" }), eaGate: true })), ["open"]);
  assert.equal(planIntents({ ...base, executor: executor({ version: "1.15" }), eaGate: true }).notes.at(-1).code, "ea_outdated", "1.15 refuses every open under unlimited leverage");
  assert.deepEqual(kinds(planIntents({ ...base, executor: executor({ version: "1.14" }), eaGate: false })), ["open"], "the gate is off by default");
});

test("AS9 the EA version gate is off unless OMEGA_EA_VERSION_GATE is \"on\"; wrangler has it on since 1.15 runs on the VPS", () => {
  assert.equal(eaVersionGateOn({}), false);
  assert.equal(eaVersionGateOn({ OMEGA_EA_VERSION_GATE: "off" }), false);
  assert.equal(eaVersionGateOn({ OMEGA_EA_VERSION_GATE: "on" }), true);
  assert.equal(EXECUTOR_ENTRY_MIN_VERSION, "1.16");
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /"OMEGA_EA_VERSION_GATE": "on"/);
  assert.deepEqual([versionAtLeast("1.15", "1.15"), versionAtLeast("1.9", "1.15"), versionAtLeast("2.0", "1.15"), versionAtLeast(null, "1.15")], [true, false, true, false]);
});

test("AS10 bridgeSync: the live account is stored, a spec change holds the next open, the login hash is never stored or served", async () => {
  resetOmegaBrokerSchemaForTests(); resetAccountSpecSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true }, actor: "owner@example.com" }, { now: NOW });
  const signal = { side: "BUY", entry: 4100, stop: 4095, tp1: 4110, issued_ms: NOW - 60_000, expires_ms: NOW + 3_600_000, blackout: false, kill: false, paused: false };
  const state = (sym = {}) => ({ ...executor({ sym }), account: { ...executor().account, login: 5550123 } });
  const sync = (st, now) => bridgeSync(env, { state: { ...st, received_ms: now - 1000 }, results: [], publicKey: "QUJD", kid: "0123456789abcdef", bridgeVersion: "1.3.0" }, { now, signal: { ...signal, issued_ms: now - 60_000 } });
  const first = await sync(state(), NOW);
  assert.equal(first.intents.filter((i) => i.kind === "open").length, 1, "a first usable spec trades as today");
  const held = await sync(state({ contract_size: 10, tick_value: 0.1 }), NOW + 120_000);
  assert.equal(held.intents.filter((i) => i.kind === "open").length, 1, "only the first open is outstanding: the changed spec opened nothing new");
  const stored = env.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state;
  assert.ok(!stored.includes("login_hash") && !stored.includes(LOGIN_HASH) && !stored.includes("5550123"), "neither the login nor its hash is stored with the state");
  const overview = JSON.stringify(await brokerOverview(env, { now: NOW + 120_000 }));
  assert.ok(!overview.includes(LOGIN_HASH) && !overview.includes("5550123"), "nor served");
  const o = await brokerOverview(env, { now: NOW + 120_000 });
  assert.equal(o.accounts.length, 1);
  assert.deepEqual([o.accounts[0].profile, o.accounts[0].spec_status], ["custom", "pending"]);
  assert.match(o.accounts[0].spec_text, /no new entries until it validates/);
  assert.deepEqual(o.bridge.ea_version_gate, { on: false, min_version: "1.16", met: false });
  assert.equal(o.bridge.margin_mode, "hedging");
  const events = env.DB.raw.prepare("SELECT action, detail FROM omega_events WHERE action IN ('account_seen', 'spec_changed')").all();
  assert.deepEqual(events.map((e) => e.action), ["account_seen", "spec_changed"]);
  assert.ok(events.every((e) => !String(e.detail).includes(LOGIN_HASH)));
  const plan = env.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'plan' ORDER BY id DESC LIMIT 1").get();
  assert.match(plan.detail, /spec_unvalidated/);
});

test("AS11 executorFrom keeps the 1.15 fields, checked, and drops anything malformed", () => {
  const st = executorFrom({ connected: true, account: { leverage: 500, margin_mode: "hedging", margin_free: 10, login_hash: LOGIN_HASH, login: 5550123 }, symbol: { freeze_level_points: 5, trade_mode: "full", margin_per_lot: 800 } });
  assert.deepEqual([st.account.leverage, st.account.margin_mode, st.account.margin_free, st.account.login_hash], [500, "hedging", 10, LOGIN_HASH]);
  assert.equal(st.account.login, undefined, "never the login");
  assert.deepEqual([st.symbol.freeze_level_points, st.symbol.trade_mode, st.symbol.margin_per_lot], [5, "full", 800]);
  const bad = executorFrom({ connected: true, account: { margin_mode: "x; drop", login_hash: "abc" }, symbol: { trade_mode: "yes" } });
  assert.deepEqual([bad.account.margin_mode, bad.account.login_hash, bad.symbol.trade_mode], [null, null, null]);
});

test("AS12 OmegaExecutor 1.15 reports the spec and is the last gate: it refuses with a reason, never resizes, never moves a stop", () => {
  assert.match(ea, /#property version\s+"1\.21"/);
  assert.ok(ea.includes('const string OMEGA_EXECUTOR_VERSION = "1.21";'));
  // The spec in state.json.
  for (const field of ["leverage", "margin_mode", "margin_free", "login_hash", "freeze_level_points", "trade_mode", "margin_per_lot"]) {
    assert.ok(ea.includes(`\\"${field}\\":`), field);
  }
  assert.match(ea, /CryptEncode\(CRYPT_HASH_SHA256/);
  assert.match(ea, /"omega\|" \+ AccountInfoString\(ACCOUNT_SERVER\) \+ "\|" \+ IntegerToString\(AccountInfoInteger\(ACCOUNT_LOGIN\)\)/);
  // The checks before an open, before the order is sent.
  const open = ea.slice(ea.indexOf("void ExecuteOpenIntent"), ea.indexOf("void ExecuteCloseIntent"));
  assert.ok(open.indexOf("OpenRefusal(") > 0 && open.indexOf("OpenRefusal(") < open.indexOf("trade.Buy("), "checked before the send");
  const refusal = ea.slice(ea.indexOf("string OpenRefusal("), ea.indexOf("string ModifyRefusal("));
  for (const k of ["OrderCalcMargin(", "OrderCheck(", "SYMBOL_TRADE_STOPS_LEVEL", "\"refused: margin\"", "\"refused: stops_level\"", "trade_mode_"]) assert.ok(refusal.includes(k), k);
  assert.ok(!/NormalizeDouble|volume\s*=|sl\s*=[^=]/.test(refusal.replace(/req\.(volume|sl|tp)\s*=/g, "")), "nothing is resized or moved");
  // The freeze level before a stop or target change.
  for (const fn of ["void ExecuteModifySlIntent", "void ExecuteModifyTpIntent"]) {
    const body = ea.slice(ea.indexOf(fn), ea.indexOf("\n  }\n", ea.indexOf(fn)));
    assert.ok(body.indexOf("ModifyRefusal(") > 0 && body.indexOf("ModifyRefusal(") < body.indexOf("trade.PositionModify("), fn);
  }
  assert.match(ea.slice(ea.indexOf("string ModifyRefusal(")), /SYMBOL_TRADE_FREEZE_LEVEL[\s\S]*"refused: freeze_level"/);
  // The gold allowlist stays.
  assert.ok(!/string GOLD_USD_SYMBOLS\[\]/.test(ea), "1.19: no list of gold names; gold is found by its contract and price");
});

// ------------------------------------------------------------------ phase 2: sizing within the profile's caps

import { effectiveLimits } from "../src/account-spec.mjs";
import { openRiskAtStops } from "../src/omega-engine.mjs";

const SIGNAL2 = { side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: NOW - 60_000, expires_ms: NOW + 600_000, blackout: false, kill: false, paused: false };
const plan2 = ({ profile, equity = 10_000, settings = {}, positions = [], stop = 4095, adaptive = false } = {}) => planIntents({
  signal: { ...SIGNAL2, stop },
  control: { mode: "active" },
  settings: { ...OMEGA_DEFAULTS, enabled: true, adaptive_volatility: adaptive, max_daily_loss_pct: 10, ...settings },
  executor: executor({ acct: { equity, balance: equity, day_start_balance: equity }, over: { positions } }),
  now: NOW, engineEnabled: true,
  account: profile === undefined ? null : { spec_status: "validated", profile }
});
const openOf = (p) => p.intents.find((i) => i.kind === "open") ?? null;

test("AS13 effectiveLimits: the smaller of the profile's cap and the setting; Custom is the settings unchanged", () => {
  const live = { risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 };
  assert.deepEqual(effectiveLimits("custom", live), { profile: "custom", risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10, hard_cap_pct: null, open_risk_pct: null });
  assert.deepEqual(effectiveLimits("safe", live), { profile: "safe", risk_pct: 1, max_positions: 1, max_daily_loss_pct: 3, hard_cap_pct: 2, open_risk_pct: 2 });
  assert.deepEqual(effectiveLimits("conservative", { risk_pct: 0.5, max_positions: 1, max_daily_loss_pct: 2 }), { profile: "conservative", risk_pct: 0.5, max_positions: 1, max_daily_loss_pct: 2, hard_cap_pct: 5, open_risk_pct: 5 }, "a tighter setting wins");
  assert.equal(effectiveLimits("aggressive", { risk_pct: 2 }).risk_pct, 2, "the setting (max 2) stays below Aggressive's 5");
  assert.equal(effectiveLimits("nonsense", live).profile, "safe", "an unknown profile is Safe");
});

test("AS14 the live account's sizing is unchanged under Custom: the same lot as with no profile at all", () => {
  for (const equity of [10_000, 2_500, 400]) {
    const none = openOf(plan2({ equity, settings: { risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 } }));
    const custom = openOf(plan2({ equity, profile: "custom", settings: { risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 } }));
    assert.deepEqual(custom, none, `equity ${equity}`);
  }
});

test("AS15 Safe sizes at 1% and one position; Conservative caps the risk per trade at the setting", () => {
  // 500 pts stop, tick 0.01 = 1 USD a lot: 500 USD a lot. 1% of 10,000 = 100 USD -> 0.2 lot.
  assert.equal(openOf(plan2({ profile: "safe", settings: { risk_pct: 2 } })).volume, 0.2);
  assert.equal(openOf(plan2({ profile: "custom", settings: { risk_pct: 2 } })).volume, 0.4);
  const busy = plan2({ profile: "safe", settings: { risk_pct: 2, max_positions: 5 }, positions: [{ ticket: 9, side: "BUY", volume: 0.1, open_price: 4090, sl: 4091, tp: 4120, magic: 920200, intent_id: "open:x:BUY", source: "omega" }] });
  assert.equal(busy.notes.at(-1).code, "max_positions", "Safe allows one position");
});

test("AS16 the minimum lot: used within the profile's hard cap, skipped over it with the numbers; Custom skips as before", () => {
  // USD 100 account, 500 pts stop: the minimum lot 0.01 loses 5 USD = 5%.
  const safe = plan2({ profile: "safe", equity: 100 });
  assert.equal(openOf(safe), null);
  assert.equal(safe.notes.at(-1).code, "volume_below_min");
  assert.match(safe.notes.at(-1).detail, /stop 500 pts: the minimum lot 0\.01 risks 5% of 100, over the Safe cap of 2%/);
  const conservative = plan2({ profile: "conservative", equity: 100 });
  assert.equal(openOf(conservative).volume, 0.01, "5% is within Conservative's 5% cap");
  assert.ok(conservative.notes.some((n) => n.code === "min_lot_within_cap" && /within the Conservative cap of 5%/.test(n.detail)));
  const custom = plan2({ profile: "custom", equity: 100, settings: { risk_pct: 2 } });
  assert.equal(openOf(custom), null);
  assert.match(custom.notes.at(-1).detail, /over the risk per trade of 2%/);
});

test("AS17 the profile's total open risk caps or stops a new entry; the lot is never raised by it", () => {
  // A manual SELL (not Omega's, so never closed by the plan) with its stop above the price: its risk counts.
  const sell = (volume) => ({ ticket: 9, side: "SELL", volume, open_price: 4090, sl: 4110, tp: 4060, magic: 0, intent_id: null, source: "manual" });
  const S = { risk_pct: 2, max_positions: 5 };
  const riskPct = (v) => (openRiskAtStops([sell(v)], executor().symbol) / 10_000) * 100;
  // Conservative: 2% a trade = 0.4 lot at 500 USD a lot; the total open risk cap is 5% = 500 USD.
  const full = plan2({ profile: "conservative", settings: S, positions: [sell(0.6)] });
  assert.ok(riskPct(0.6) > 5, "the open SELL alone uses the cap");
  assert.deepEqual([openOf(full), full.notes.at(-1).code], [null, "open_risk_cap"]);
  assert.match(full.notes.at(-1).detail, /the Conservative total open risk is 5%/);
  const part = plan2({ profile: "conservative", settings: S, positions: [sell(0.4)] });
  const room = 500 - openRiskAtStops([sell(0.4)], executor().symbol);
  assert.equal(openOf(part).volume, Math.floor(room / 500 * 100) / 100);
  assert.ok(openOf(part).volume < 0.4 && part.notes.some((n) => n.code === "lot_capped_open_risk"));
  const free = plan2({ profile: "conservative", settings: S });
  assert.equal(openOf(free).volume, 0.4, "nothing open: the risk per trade decides");
});

test("AS18 unlimited leverage (a demo with 1:2,000,000,000): a margin rounded to 0 is valid; only a failing OrderCalcMargin refuses", () => {
  const unlimited = executor({ version: "1.16", acct: { leverage: 2_000_000_000 }, sym: { margin_per_lot: 0 } });
  assert.equal(specProblem(unlimited), null, "margin per lot 0 is a valid spec");
  assert.equal(specProblem(executor({ version: "1.16", sym: { margin_per_lot: -1 } })), "margin_per_lot");
  const refusal = ea.slice(ea.indexOf("string OpenRefusal("), ea.indexOf("string ModifyRefusal("));
  assert.ok(!/margin\s*<=\s*0\.0/.test(refusal), "1.15's margin <= 0 refusal is gone");
  assert.match(refusal, /if\(!OrderCalcMargin\([^)]*\)\) return StringFormat\("refused: margin_unknown_%d", GetLastError\(\)\);/);
  assert.ok(refusal.indexOf("OrderCalcMargin(") < refusal.indexOf("OrderCheck("), "OrderCheck still decides after it");
});

test("AS19 the risk setting goes to 10% (owner 2026-11-18) and each profile still caps it; the Nexus copy of the caps matches", async () => {
  const { RISK_PCT_MAX, settingsFrom } = await import("../src/omega-engine.mjs");
  assert.equal(RISK_PCT_MAX, 10);
  assert.equal(settingsFrom({ risk_pct: 10 }).settings.risk_pct, 10);
  assert.match(settingsFrom({ risk_pct: 10.5 }).error, /risk_pct must be a number from 0\.01 to 10/);
  assert.deepEqual([effectiveLimits("safe", { risk_pct: 10 }).risk_pct, effectiveLimits("conservative", { risk_pct: 10 }).risk_pct, effectiveLimits("aggressive", { risk_pct: 10 }).risk_pct, effectiveLimits("custom", { risk_pct: 10 }).risk_pct], [1, 2, 5, 10]);
  const ui = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx", import.meta.url), "utf8");
  for (const id of ["safe", "conservative", "aggressive"]) {
    const P = PROFILES[id];
    assert.ok(ui.includes(`${id}: { risk: ${P.target_risk_pct}, positions: ${P.max_positions}, daily: ${P.daily_loss_pct} }`), `${id} caps in Omega.tsx`);
  }
  assert.match(ui, /noValidate/, "the server's reason shows instead of a silent browser block");
  assert.match(ui, /id="e-risk" type="number" min="0\.01" max="10"/);
});

test("AS20 two accounts on one server (2026-11-19): the connected one is found by its own reference, never by the server", async () => {
  const { connectedAccount, setAccountProfile } = await import("../src/omega-broker.mjs");
  resetOmegaBrokerSchemaForTests(); resetAccountSpecSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true }, actor: "owner@example.com" }, { now: NOW });
  const OTHER = createHash("sha256").update("omega|Broker-Live|7770001").digest("hex");
  const sync = (st, now) => bridgeSync(env, { state: { ...st, received_ms: now - 1000 }, results: [], publicKey: "QUJD", kid: "0123456789abcdef", bridgeVersion: "1.3.0" }, { now });
  const usd = executor(), cent = executor({ acct: { login_hash: OTHER, currency: "USX" }, sym: { name: "GoldOne", contract_size: 1 } });
  // The USD account first, then a cent account on the same server (a newer row), then the USD account again.
  await sync(usd, NOW);
  await sync(cent, NOW + 60_000);
  await sync(usd, NOW + 120_000);
  const refUsd = (await accountRef(usd)).ref, refCent = (await accountRef(cent)).ref;
  assert.notEqual(refUsd, refCent);
  const stored = JSON.parse(env.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state);
  assert.equal(stored.account_ref, refUsd, "the state carries the opaque reference of the account it came from");
  assert.ok(!JSON.stringify(stored).includes(LOGIN_HASH), "never the login hash");
  const accounts = await readAccounts(env.DB);
  assert.equal(accounts.filter((a) => a.server === "Broker-Live").length, 2);
  assert.equal((await connectedAccount(accounts, stored))?.account_ref, refUsd);
  // The pages mark only the connected account; the owner's reset reaches it and refuses the other one.
  const o = await brokerOverview(env, { now: NOW + 120_000 });
  assert.deepEqual(o.accounts.filter((a) => a.connected).map((a) => a.account_ref), [refUsd]);
  // Each account says which it is (owner 2026-11-19: "harus bisa membedakan mana akun sen dan usd").
  // Only the connected account is served (owner 2026-11-19: "akun sen udah disconnect kok masih dibaca"): the cent
  // account's stored row stays in D1 but appears on no page.
  assert.deepEqual(o.accounts.map((a) => [a.account_ref === refUsd ? "usd" : "cent", a.identity.label, a.identity.cent, a.connected]),
    [["usd", "USD account · XAUUSD", false, true]]);
  assert.ok(!JSON.stringify(o).includes(refCent), "the account that is not connected is nowhere in the overview");
  // Every owner control refuses the account that is not connected, naming it; the connected one is changed.
  for (const [action, value] of [["reset", null], ["profile", "safe"], ["ceiling", "safe"], ["agent_mode", "approval"]]) {
    const wrong = await setAccountProfile(env, { account_ref: refCent, action, value }, { now: NOW + 130_000 });
    assert.equal(wrong.ok, false, action);
    assert.equal(wrong.error, "USX account · GoldOne is not the connected account: the controls act on the connected account only");
    assert.ok(!wrong.error.includes(refCent), "no internal id in what the owner reads");
  }
  // Each refusal is recorded, so the owner's attempt can be traced (action, account, reason; never a login).
  const refused = env.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'profile_control_refused' ORDER BY id").all().map((r) => JSON.parse(r.detail));
  assert.deepEqual(refused.map((r) => [r.action, r.account_ref, r.connected_ref, r.terminal_live]), [["reset", refCent, refUsd, true], ["profile", refCent, refUsd, true], ["ceiling", refCent, refUsd, true], ["agent_mode", refCent, refUsd, true]]);
  assert.match(refused[3].error, /not the connected account/);
  assert.ok(!JSON.stringify(refused).includes(LOGIN_HASH));
  const before = env.DB.raw.prepare("SELECT profile, ceiling, agent_mode FROM omega_accounts WHERE account_ref = ?").get(refCent);
  const ok = await setAccountProfile(env, { account_ref: refUsd, action: "agent_mode", value: "approval" }, { now: NOW + 130_000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(env.DB.raw.prepare("SELECT profile, ceiling, agent_mode FROM omega_accounts WHERE account_ref = ?").get(refCent), before, "the cent account is untouched");
  // With no live terminal nothing is the connected account: every control refuses.
  const off = await setAccountProfile(env, { account_ref: refUsd, action: "agent_mode", value: "autonomous" }, { now: NOW + 3_600_000 });
  assert.equal(off.ok, false);
});

test("AS21 the deals an account reports are its own: one stored before the account was recorded takes it (pages show its deals only)", async () => {
  const { storeDeal, listDeals } = await import("../src/ea-execution.mjs");
  resetOmegaBrokerSchemaForTests(); resetAccountSpecSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true }, actor: "owner@example.com" }, { now: NOW });
  const deal = { deal_ticket: 9001, position_ticket: 1, side: "BUY", volume: 0.01, entry_price: 4000, exit_price: 4010, profit: 10, commission: 0, swap: 0, reason: "tp", opened_ms: NOW - 7_200_000, closed_ms: NOW - 3_600_000, source: "omega" };
  await storeDeal(env, { ...deal, mode: "demo" });   // stored before the account was recorded
  await storeDeal(env, { ...deal, deal_ticket: 9002, mode: "demo" });   // another account's, never reported by this one
  // The terminal reports up to 100 deals; D1 binds at most 100 parameters a statement (the first version bound 101
  // and tagged nothing live): the test database refuses more than 100 too.
  const many = Array.from({ length: 99 }, (_, i) => ({ ...deal, deal_ticket: 10_000 + i }));
  const st = executor({ over: { deals: [deal, ...many] } });
  await bridgeSync(env, { state: { ...st, received_ms: NOW - 1000 }, results: [], publicKey: "QUJD", kid: "0123456789abcdef", bridgeVersion: "1.5.0" }, { now: NOW });
  const ref = (await accountRef(st)).ref;
  const rows = env.DB.raw.prepare("SELECT deal_ticket, account_ref FROM ea_deals ORDER BY deal_ticket").all();
  assert.deepEqual(rows.filter((r) => r.deal_ticket < 10_000).map((r) => [r.deal_ticket, r.account_ref]), [[9001, ref], [9002, null]]);
  assert.ok(rows.filter((r) => r.deal_ticket >= 10_000).every((r) => r.account_ref === ref), "all 100 reported deals are tagged, in parts");
  const listed = (await listDeals(env, { account: "last", limit: 500 })).map((d) => d.deal_ticket);
  assert.deepEqual([listed.length, listed.includes(9001), listed.includes(9002)], [100, true, false]);
});

test("AS22 the Engine form's Default button follows the active profile (owner 2026-11-20): the overview serves the profile's values and OMEGA_DEFAULTS", async () => {
  const { engineDefaultsFor, appliedNotes } = await import("../workers/xauusd-nexus-dashboard/ui/src/lib/engineDefaults.ts");
  resetOmegaBrokerSchemaForTests(); resetAccountSpecSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
  await writeSettings(env, { body: { enabled: true, risk_pct: 5, max_positions: 3, max_daily_loss_pct: 8 }, actor: "owner@example.com" }, { now: NOW });
  const st = executor();
  await bridgeSync(env, { state: { ...st, received_ms: NOW - 1000 }, results: [], publicKey: "QUJD", kid: "0123456789abcdef", bridgeVersion: "1.5.0" }, { now: NOW });
  const view = async () => brokerOverview(env, { now: NOW });
  // The first account is Custom: the profile sets nothing, so Default fills OMEGA_DEFAULTS.
  let o = await view();
  assert.deepEqual(o.engine_defaults, { risk_pct: OMEGA_DEFAULTS.risk_pct, max_positions: OMEGA_DEFAULTS.max_positions, max_daily_loss_pct: OMEGA_DEFAULTS.max_daily_loss_pct, max_spread_points: 60, max_signal_age_min: 10 });
  assert.deepEqual(o.accounts[0].profile_limits, { target_risk_pct: null, max_positions: null, daily_loss_pct: null });
  assert.deepEqual(engineDefaultsFor(o.accounts[0].profile_limits, o.engine_defaults), { risk_pct: 0.5, max_positions: 1, max_daily_loss_pct: 2, max_spread_points: 60, max_signal_age_min: 10 });
  assert.deepEqual(appliedNotes({ risk_pct: "5", max_positions: "3", max_daily_loss_pct: "8" }, o.accounts[0].profile_limits, o.accounts[0].profile_label), { risk_pct: null, max_positions: null, max_daily_loss_pct: null }, "Custom applies the settings as they are");
  // Conservative: 2 / 2 / 6 / 60 / 10, and every field above its cap says what applies.
  env.DB.raw.prepare("UPDATE omega_accounts SET profile = 'conservative'").run();
  o = await view();
  const a = o.accounts[0];
  assert.deepEqual(a.profile_limits, { target_risk_pct: PROFILES.conservative.target_risk_pct, max_positions: PROFILES.conservative.max_positions, daily_loss_pct: PROFILES.conservative.daily_loss_pct });
  assert.deepEqual(engineDefaultsFor(a.profile_limits, o.engine_defaults), { risk_pct: 2, max_positions: 2, max_daily_loss_pct: 6, max_spread_points: 60, max_signal_age_min: 10 });
  assert.deepEqual(appliedNotes({ risk_pct: String(o.engine.risk_pct), max_positions: String(o.engine.max_positions), max_daily_loss_pct: String(o.engine.max_daily_loss_pct) }, a.profile_limits, a.profile_label),
    { risk_pct: "5% set, 2% applied (Conservative cap)", max_positions: "3 set, 2 applied (Conservative cap)", max_daily_loss_pct: "8% set, 6% applied (Conservative cap)" });
  // The same applied values the engine uses (effectiveLimits).
  const lim = effectiveLimits("conservative", o.engine);
  assert.deepEqual([lim.risk_pct, lim.max_positions, lim.max_daily_loss_pct], [2, 2, 6]);
  // The page: a Default button that fills the form only (never enabled, Arm or the profile); Save writes it.
  const ui = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx", import.meta.url), "utf8");
  assert.match(ui, /id="e-default"[\s\S]{0,80}onClick=\{fillEngineDefaults\}/);
  const fill = ui.slice(ui.indexOf("const fillEngineDefaults"), ui.indexOf("};", ui.indexOf("const fillEngineDefaults")));
  assert.ok(fill.length > 0 && !/setEEnabled|live_armed|saveEngine|omegaJson|profile\/set/.test(fill), "Default only fills the form");
});
