import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { signalEvents, formatAlert, sendLedgerAlerts, ledgerAlertsEnabled, resetLedgerAlertsSchemaCacheForTests } from "../src/ledger-alerts.mjs";
import { ensureLedgerSchema, resetLedgerSchemaCacheForTests } from "../src/signal-ledger.mjs";

const base = { id: "strategy:2026-11-09T10:00:00.000Z", source: "strategy", side: "BUY", entry: 4040, stop: 4028, tp1: 4064, tp2: 4076, confidence: 0.62, opened_at: "2026-11-09T10:05:00.000Z", status: "pending" };

test("the events a ledger row has reached, in order", () => {
  assert.deepEqual(signalEvents(base), ["setup"]);
  assert.deepEqual(signalEvents({ ...base, source: "h1_decision" }), [], "the H1 decision has its own Telegram message");
  assert.deepEqual(signalEvents({ ...base, status: "open", filled_at: "2026-11-09T10:30:00.000Z" }), ["setup", "entry"]);
  assert.deepEqual(signalEvents({ ...base, status: "open", filled_at: "x", exit_reason: "target", r_tp1: 2 }), ["setup", "entry", "exit"], "TP1 reached, TP2 still open");
  assert.deepEqual(signalEvents({ ...base, status: "closed", filled_at: "x", exit_reason: "target", r_tp2: 3 }), ["setup", "entry", "exit", "closed"]);
  assert.deepEqual(signalEvents({ ...base, status: "closed", tp2: null, filled_at: "x", exit_reason: "stop" }), ["setup", "entry", "exit"]);
  assert.deepEqual(signalEvents({ ...base, status: "cancelled", exit_reason: "unfilled" }), ["setup", "cancelled"]);
});

test("the messages: plain words, the levels, the R result, and the advisory line", () => {
  assert.equal(formatAlert(base, "setup"), "XAUUSD ALERT · Strategy engine\nSetup active: BUY (entry 4040.00, stop 4028.00, TP1 4064.00, TP2 4076.00). Confidence 62%.\nAdvisory only: no order is placed and no position size is given.");
  assert.match(formatAlert({ ...base, status: "open", filled_at: "2026-11-09T10:30:00.000Z" }, "entry"), /Entry reached: the BUY from 2026-11-09 10:05 UTC filled at 4040.00 \(2026-11-09 10:30 UTC\)\./);
  assert.match(formatAlert({ ...base, status: "open", exit_reason: "target", r_tp1: 2, exit_price: 4064 }, "exit"), /TP1 reached: the BUY from .*, \+2R at 4064.00\. The TP2 part stays open\./);
  assert.match(formatAlert({ ...base, source: "h1_decision", status: "closed", exit_reason: "stop", r_tp1: -1, exit_price: 4028, tp2: null }, "exit"), /^XAUUSD ALERT · H1 decision\nStop reached: .*-1R at 4028.00\.\n/);
  assert.match(formatAlert({ ...base, status: "cancelled", exit_reason: "invalidated" }, "cancelled"), /Setup cancelled: .*the stop level traded before the entry\./);
});

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}
const NOW = Date.parse("2026-11-09T12:00:00Z");
const bot = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };

test("each event is sent once; the first run seeds what already exists; a failed send is retried; off without the bot", async () => {
  resetLedgerAlertsSchemaCacheForTests(); resetLedgerSchemaCacheForTests();
  const env = { DB: d1(), ...bot };
  await ensureLedgerSchema(env.DB);
  const insert = (id, status, extra = {}) => env.DB.raw.prepare("INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, tp2, confidence, note, status, updated_at, filled_at, exit_reason) VALUES (?, 'strategy', NULL, ?, 'BUY', 4040, 4028, 4064, 4076, 0.6, NULL, ?, ?, ?, ?)")
    .run(id, extra.opened_at ?? "2026-11-09T10:05:00.000Z", status, "2026-11-09T10:05:00.000Z", extra.filled_at ?? null, extra.exit_reason ?? null);
  insert("old", "open", { filled_at: "2026-11-09T10:30:00.000Z" });
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const first = await sendLedgerAlerts(env, { send, now: NOW });
  assert.deepEqual(first, { status: "ok", sent: 0, seeded: 2, failed: 0 }, "the deploy never floods the chat");
  insert("new", "pending", { opened_at: "2026-11-09T11:05:00.000Z" });
  env.DB.raw.prepare("UPDATE signal_ledger SET exit_reason = 'target', r_tp1 = 2, exit_price = 4064 WHERE id = 'old'").run();
  const second = await sendLedgerAlerts(env, { send, now: NOW });
  assert.equal(second.sent, 2);
  assert.ok(sent.some((t) => t.includes("TP1 reached")) && sent.some((t) => t.includes("Setup active")));
  assert.equal((await sendLedgerAlerts(env, { send, now: NOW })).sent, 0, "never twice");
  env.DB.raw.prepare("UPDATE signal_ledger SET status = 'open', filled_at = '2026-11-09T11:20:00.000Z' WHERE id = 'new'").run();
  const failing = async () => { throw new Error("telegram down"); };
  assert.equal((await sendLedgerAlerts(env, { send: failing, now: NOW })).failed, 1);
  assert.equal((await sendLedgerAlerts(env, { send, now: NOW })).sent, 1, "retried by the next run");
  assert.equal(ledgerAlertsEnabled({}), false, "no bot, no alerts");
  assert.equal(ledgerAlertsEnabled({ ...bot, LEDGER_ALERTS_ENABLED: "false" }), false);
  assert.equal((await sendLedgerAlerts({ DB: env.DB }, { send, now: NOW })).status, "disabled");
});

test("an empty ledger on the first run marks the start, so the first real event is sent", async () => {
  resetLedgerAlertsSchemaCacheForTests(); resetLedgerSchemaCacheForTests();
  const env = { DB: d1(), ...bot };
  await ensureLedgerSchema(env.DB);
  const sent = [];
  assert.deepEqual(await sendLedgerAlerts(env, { send: async (t) => sent.push(t), now: NOW }), { status: "ok", sent: 0, seeded: 0, failed: 0 });
  env.DB.raw.prepare("INSERT INTO signal_ledger (id, source, opened_at, side, entry, stop, tp1, tp2, status, updated_at) VALUES ('s1', 'strategy', '2026-11-09T11:00:00.000Z', 'SELL', 4040, 4052, 4016, NULL, 'pending', 'x')").run();
  assert.equal((await sendLedgerAlerts(env, { send: async (t) => sent.push(t), now: NOW })).sent, 1);
  assert.match(sent[0], /Setup active: SELL \(entry 4040.00, stop 4052.00, TP1 4016.00\)/);
});
