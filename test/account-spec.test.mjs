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
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
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
  assert.equal(specProblem(executor({ sym: { margin_per_lot: 0 } })), "margin_per_lot");
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

test("AS7 the first 1.15 sync adopts the 1.14 row of the same server (profile kept); its new fields are a change that settles", async () => {
  resetAccountSpecSchemaForTests();
  const db = d1(), events = [];
  const opts = (now) => ({ settings: { ...OMEGA_DEFAULTS, risk_pct: 2, max_positions: 5, max_daily_loss_pct: 10 }, now, log: async (a) => events.push(a) });
  const old = await syncAccount(db, executor({ version: "1.14" }), opts(NOW));
  const up = await syncAccount(db, executor(), opts(NOW + 5_000));
  assert.notEqual(up.account_ref, old.account_ref);
  assert.deepEqual([up.profile, up.ceiling, up.agent_mode, up.spec_status], ["custom", "custom", "autonomous", "pending"]);
  assert.deepEqual(events, ["account_seen", "account_ref_upgraded", "spec_changed"]);
  const rows = await readAccounts(db);
  assert.equal(rows.length, 1, "one account, not two");
  assert.equal(rows[0].legacy, false);
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
  const short = { ticket: 7, side: "SELL", volume: 0.1, open_price: 4110, sl: 4120, tp: 4090, magic: 920200, intent_id: "open:x:SELL", source: "omega" };
  const closing = planIntents({ ...base, executor: executor({ over: { positions: [short] } }), account: { spec_status: "pending" } });
  assert.deepEqual(kinds(closing), ["close"], "the opposite position is still closed");
  const outdated = planIntents({ ...base, executor: executor({ version: "1.14" }), eaGate: true });
  assert.deepEqual([kinds(outdated), outdated.notes.at(-1).code], [[], "ea_outdated"]);
  assert.deepEqual(kinds(planIntents({ ...base, executor: executor({ version: "1.15" }), eaGate: true })), ["open"]);
  assert.deepEqual(kinds(planIntents({ ...base, executor: executor({ version: "1.14" }), eaGate: false })), ["open"], "the gate is off by default");
});

test("AS9 the EA version gate is off unless OMEGA_EA_VERSION_GATE is \"on\"; wrangler ships it off", () => {
  assert.equal(eaVersionGateOn({}), false);
  assert.equal(eaVersionGateOn({ OMEGA_EA_VERSION_GATE: "off" }), false);
  assert.equal(eaVersionGateOn({ OMEGA_EA_VERSION_GATE: "on" }), true);
  assert.equal(EXECUTOR_ENTRY_MIN_VERSION, "1.15");
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /"OMEGA_EA_VERSION_GATE": "off"/);
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
  const held = await sync(state({ contract_size: 10 }), NOW + 120_000);
  assert.equal(held.intents.filter((i) => i.kind === "open").length, 1, "only the first open is outstanding: the changed spec opened nothing new");
  const stored = env.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state;
  assert.ok(!stored.includes("login_hash") && !stored.includes(LOGIN_HASH) && !stored.includes("5550123"), "neither the login nor its hash is stored with the state");
  const overview = JSON.stringify(await brokerOverview(env, { now: NOW + 120_000 }));
  assert.ok(!overview.includes(LOGIN_HASH) && !overview.includes("5550123"), "nor served");
  const o = await brokerOverview(env, { now: NOW + 120_000 });
  assert.equal(o.accounts.length, 1);
  assert.deepEqual([o.accounts[0].profile, o.accounts[0].spec_status], ["custom", "pending"]);
  assert.match(o.accounts[0].spec_text, /no new entries until it validates/);
  assert.deepEqual(o.bridge.ea_version_gate, { on: false, min_version: "1.15", met: true });
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
  assert.match(ea, /#property version\s+"1\.15"/);
  assert.ok(ea.includes('const string OMEGA_EXECUTOR_VERSION = "1.15";'));
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
  assert.match(ea, /string GOLD_USD_SYMBOLS\[\] = \{/);
});
