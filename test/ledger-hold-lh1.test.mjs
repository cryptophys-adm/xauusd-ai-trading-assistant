// LH1 (2026-11-23, orchestrator; owner: "Ya, masukkan 6"): the Signal Ledger's no-stacking hold-back follows Omega, as
// its rule says. A same-side row holds a new decision back only while Omega would: inside Omega's own entry window
// (an ENTER_LIMIT's max_pending_life, a market entry's next close or max_signal_age), or while Omega's position on it is
// open and unprotected. The TP-policy row keeps its own fill window for its own result. On 2026-11-23 the 04:15 BUY row
// waited 8 hours for its TP-policy fill after Omega's side had closed at 05:55, and held back six BUYs (06:15-12:00).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { blocksNewDecision, omegaEntryWindowEnd, ingestDecision, reingestHeldOnce, ensureLedgerSchema, resetLedgerSchemaCacheForTests, HOLD_REASONS, LH1_REINGEST } from "../src/signal-ledger.mjs";
import { DECISION_SCHEMA_SQL } from "../src/decision-engine.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of DECISION_SCHEMA_SQL) db.exec(sql);
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };
const MIN = 60_000, M15 = 15 * MIN;
const at = (s) => Date.parse(`2026-11-23T${s}Z`);
const iso = (ms) => new Date(ms).toISOString();
const key = (barOpenMs) => `OANDA:XAUUSD:15:${barOpenMs}`;
/** A decision on the bar opening at `barOpen` (HH:MM), decided two minutes after its close. */
const decision = (barOpen, { side = "BUY", action = "ENTER_LIMIT", mode = "scalp" } = {}) => {
  const open = at(`${barOpen}:00.000`);
  return { decision_key: key(open), decided_at: iso(open + M15 + 2 * MIN), stance: side, confidence: 0.6, trading_mode: mode, summary: "x",
    trade: { side, action, entry: 3600, stop: side === "BUY" ? 3594 : 3606, tp: side === "BUY" ? 3612 : 3588, tp1: side === "BUY" ? 3612 : 3588, tp2: side === "BUY" ? 3618 : 3582, target: "tp1" } };
};
/** The 04:15 BUY row as it stood today: TP-policy pending for 8 hours, Omega filled 04:18 and closed 05:55. */
const ROW_0415 = { id: `decision:${key(at("04:15:00.000"))}`, status: "pending", opened_at: "2026-11-23T04:17:03.242Z", filled_at: null, closed_at: null, candle_key: key(at("04:15:00.000")), trading_mode: "scalp", entry_action: "ENTER_LIMIT", tp1_closed_at: null, sl_plus_triggered: 0, sl_plus_at: null, omega_status: "closed", omega_filled_at: "2026-11-23T04:18:00.000Z", omega_closed_at: "2026-11-23T05:55:00.000Z", omega_json: null };

test("LH1-1 today's case: the 04:15 row (TP-policy pending 8 h, Omega closed 05:55) no longer holds the 06:15 BUY; inside Omega's 30 minutes it did", () => {
  assert.equal(blocksNewDecision(ROW_0415, at("06:17:18.222")), null, "06:15: Omega's side closed at 05:55");
  for (const t of ["07:04:00", "08:17:17", "08:47:03", "09:32:42", "12:02:54"]) assert.equal(blocksNewDecision(ROW_0415, at(`${t}.000`)), null, t);
  // Before Omega's side closed: Omega's position was open from 04:18 and unprotected (no protected_at): held.
  assert.equal(blocksNewDecision(ROW_0415, at("04:30:00.000")), "open");
  assert.equal(blocksNewDecision({ ...ROW_0415, omega_json: JSON.stringify({ protected_at: "2026-11-23T04:40:00.000Z" }) }, at("04:45:00.000")), null, "Omega protected (SL+) by then");
});

test("LH1-2 a pending row Omega has not filled holds only inside Omega's entry window (scalp limit: 30 min; intraday 60)", () => {
  const row = { ...ROW_0415, omega_status: "pending", omega_filled_at: null, omega_closed_at: null };
  assert.equal(omegaEntryWindowEnd(row), Date.parse(row.opened_at) + 30 * MIN);
  assert.equal(blocksNewDecision(row, Date.parse(row.opened_at) + 29 * MIN), "pending", "inside 30 min: held");
  assert.equal(omegaEntryWindowEnd({ ...row, trading_mode: "intraday" }), Date.parse(row.opened_at) + 60 * MIN);
  // Past the window, Omega's simulation has read it: skipped (never filled) holds nothing.
  assert.equal(blocksNewDecision({ ...row, omega_status: "skipped" }, Date.parse(row.opened_at) + 31 * MIN), null);
  // Past the window but not simulated yet (omega_status still "pending"): today's rule until the ledger reads it.
  assert.equal(blocksNewDecision(row, Date.parse(row.opened_at) + 31 * MIN), "pending");
});

test("LH1-3 a market entry: Omega's window is the next close or max_signal_age (10 min) after the decision", () => {
  const open = at("06:15:00.000");
  const row = { ...ROW_0415, id: "decision:m", candle_key: key(open), opened_at: iso(open + M15 + 2 * MIN), entry_action: "ENTER_MARKET", omega_status: "pending", omega_filled_at: null, omega_closed_at: null };
  assert.equal(omegaEntryWindowEnd(row), open + M15 + 2 * MIN + 10 * MIN, "decided 06:32, so until 06:42 (before the 06:45 close)");
  assert.equal(blocksNewDecision(row, open + M15 + 5 * MIN), "pending");
  assert.equal(blocksNewDecision({ ...row, omega_status: "skipped" }, open + M15 + 30 * MIN), null);
});

test("LH1-4 an open row still holds while unprotected; an open row whose Omega side closed no longer does", () => {
  const open = { ...ROW_0415, status: "open", filled_at: "2026-11-23T04:20:00.000Z", omega_status: "open", omega_filled_at: "2026-11-23T04:18:00.000Z", omega_closed_at: null };
  assert.equal(blocksNewDecision(open, at("05:00:00.000")), "open", "Omega's position open, unprotected");
  assert.equal(blocksNewDecision({ ...open, omega_status: "closed", omega_closed_at: "2026-11-23T04:50:00.000Z" }, at("05:00:00.000")), null);
  // A row from before the Omega policy (no omega_status): today's rule exactly.
  const legacy = { ...open, omega_status: null, omega_filled_at: null };
  assert.equal(blocksNewDecision(legacy, at("05:00:00.000")), "open");
  assert.equal(blocksNewDecision({ ...legacy, tp1_closed_at: "2026-11-23T04:40:00.000Z" }, at("05:00:00.000")), null);
  assert.equal(blocksNewDecision({ ...legacy, sl_plus_triggered: 1 }, at("05:00:00.000")), null);
  assert.equal(blocksNewDecision({ ...legacy, status: "pending" }, at("05:00:00.000")), "pending");
  assert.deepEqual(Object.keys(HOLD_REASONS), ["pending", "open"]);
});

test("LH1-5 ingestDecision: today's sequence records the 06:15 BUY behind the 04:15 row; a decision inside 30 min of a fresh row is still held", async () => {
  resetLedgerSchemaCacheForTests();
  const env = { DB: d1() };
  await ensureLedgerSchema(env.DB);
  assert.equal(await ingestDecision(env, decision("04:15"), { now: at("04:17:03.242") }), 1);
  // The ledger's 5-minute run simulated Omega's side: filled 04:18, closed 05:55; the TP-policy row still pending.
  env.DB.raw.prepare("UPDATE signal_ledger SET omega_status = 'closed', omega_filled_at = ?, omega_closed_at = ? WHERE id = ?").run("2026-11-23T04:18:00.000Z", "2026-11-23T05:55:00.000Z", ROW_0415.id);
  assert.equal(await ingestDecision(env, decision("06:15"), { now: at("06:32:00.000") }), 1, "recorded (was held for 8 h)");
  // A fresh row, not simulated yet: the next BUY 15 minutes later is inside Omega's 30-minute window: held.
  assert.equal(await ingestDecision(env, decision("06:30"), { now: at("06:47:00.000") }), 0);
  const held = env.DB.raw.prepare("SELECT decision_key, blocking_id, reason FROM signal_ledger_held").all();
  assert.equal(held.length, 1);
  assert.equal(held[0].blocking_id, `decision:${key(at("06:15:00.000"))}`);
  assert.equal(held[0].reason, HOLD_REASONS.pending);
  // A SELL is never held by a BUY row.
  assert.equal(await ingestDecision(env, decision("06:30", { side: "SELL" }), { now: at("06:47:00.000") }), 1);
});

test("LH1-6 the one-shot re-ingest: the held decisions in the window, each from its own record, once; a still-held one stays held", async () => {
  resetLedgerSchemaCacheForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  await ensureLedgerSchema(env.DB);
  // Today's state: the 04:15 row (Omega closed 05:55) and the old hold-back's rows for 06:15, 07:00 and 08:45.
  await ingestDecision(env, decision("04:15"), { now: at("04:17:03.242") });
  env.DB.raw.prepare("UPDATE signal_ledger SET omega_status = 'closed', omega_filled_at = ?, omega_closed_at = ? WHERE id = ?").run("2026-11-23T04:18:00.000Z", "2026-11-23T05:55:00.000Z", ROW_0415.id);
  const stored = [decision("06:15"), decision("07:00"), decision("08:45"), decision("12:45")];
  for (const d of stored) {
    env.DB.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, source, decision_json) VALUES (?, ?, ?, ?, ?, ?)").run(d.decision_key, iso(Number(d.decision_key.split(":").pop()) + M15), d.decided_at, d.stance, "council", JSON.stringify(d));
    env.DB.raw.prepare("INSERT INTO signal_ledger_held (decision_key, side, held_at, blocking_id, reason) VALUES (?, ?, ?, ?, ?)").run(d.decision_key, d.stance, d.decided_at, ROW_0415.id, "an earlier signal of the same side still waits for its fill");
  }
  // Each re-ingested row is simulated before the next: here the 06:15 one fills at 06:33 and stays open, unprotected,
  // so the 07:00 BUY is held behind it as live would have held it; it closes at 08:00, so 08:45 is recorded.
  let calls = 0;
  const evaluate = async () => {
    calls++;
    env.DB.raw.prepare("UPDATE signal_ledger SET status = 'open', filled_at = ?, omega_status = 'closed', omega_filled_at = ?, omega_closed_at = ? WHERE id = ? AND omega_status = 'pending'").run("2026-11-23T06:33:00.000Z", "2026-11-23T06:33:00.000Z", "2026-11-23T08:00:00.000Z", `decision:${key(at("06:15:00.000"))}`);
  };
  const r = await reingestHeldOnce(env, { now: at("14:30:00.000"), evaluate });
  assert.equal(r.status, "ran");
  assert.deepEqual(r.items.map((x) => [x.decision_key, x.reingested]), [[key(at("06:15:00.000")), true], [key(at("07:00:00.000")), false], [key(at("08:45:00.000")), true]], "12:45 is outside the window");
  assert.match(r.items[1].reason, /still held by decision:.*1795414500000/);
  assert.ok(calls >= 2);
  // decided_at kept: the rows open at their own decision time.
  const rows = env.DB.raw.prepare("SELECT id, opened_at FROM signal_ledger ORDER BY opened_at").all();
  assert.deepEqual(rows.map((x) => x.opened_at), [decision("04:15").decided_at, decision("06:15").decided_at, decision("08:45").decided_at]);
  // The re-ingested decisions leave signal_ledger_held; the still-held one and the out-of-window one stay.
  const held = env.DB.raw.prepare("SELECT decision_key FROM signal_ledger_held ORDER BY held_at").all().map((x) => x.decision_key);
  assert.deepEqual(held, [key(at("07:00:00.000")), key(at("12:45:00.000"))]);
  // Once: the marker keeps the report; a second run does nothing.
  assert.ok(env.SIGNAL_CACHE.m.has(LH1_REINGEST.key));
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(LH1_REINGEST.key)).items.length, 3);
  assert.deepEqual(await reingestHeldOnce(env, { now: at("14:35:00.000"), evaluate }), { status: "done" });
});
