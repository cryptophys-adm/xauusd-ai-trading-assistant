// SS1, a newer same-side signal supersedes a resting, unfilled Omega limit (owner 2026-11-23, relayed by the
// orchestrator: "Ya, sinyal baru menggantikan (Rekomendasi)"; src/limit-supersede.mjs). Today's 14:00 and 14:15 BUYs
// replayed (the old limit deleted, the new one placed in its zone once the delete is done), the new signal refused
// (the old limit still cancelled), the open position and the other side as today, a refused and an unanswered delete,
// the sync's read of the deletes, the limit counterfactual beside v4 and v4 itself, the v3 ledger, the switch, the
// hashes, and off byte for byte (against main's code).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { planIntents, settingsFrom, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { limitSupersedeOn, orderSignalMs, supersededOrders, supersedeDeletes, LIMIT_SUPERSEDE_MODES, SUPERSEDE_REASON, SUPERSEDE_READ_MS } from "../src/limit-supersede.mjs";
import { replayOmegaLimit, LIMIT_MISSED_REASONS } from "../src/ledger-omega-limit.mjs";
import { replayOmega4, eraSwitches, ERA_SWITCHES, ENGINE_BEHAVIOUR_HASH, ENGINE_CODE_HASH, ENGINE_CODE, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { limitInputs, writeSettings, readSettings, applyOmegaPolicy, resetOmegaBrokerSchemaForTests, OMEGA_POLICY_KEY } from "../src/omega-broker.mjs";
import { blocksNewDecision } from "../src/signal-ledger.mjs";
import { auditSweep } from "../src/change-notify.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import {
  planCases, input, replayCase, replayBase, replayLimit, replayV4, LIMIT, OFF, NOW, TICKET, OLD_ID, NEW_ID, OLD_ISSUED, NEW_ISSUED, OLD_ORDER, OLD_META, NEW_SIGNAL, EXECUTOR, R_C0
} from "./fixtures/limit-supersede.mjs";

const M1 = 60_000, M15 = 15 * M1;
/** RE1's ENGINE_BEHAVIOUR_HASH: the engine before SS1 (every fixture with limit_supersede "off"). */
const BEFORE_SS1_HASH = "39c10287e884bba0469ee4557bada444601c5a7d6a209e3231471336a841c4f1";
/** RE1's ENGINE_CODE_HASH (the code before SS1). */
const BEFORE_SS1_CODE_HASH = "38aa8e6fd3abd23a5ab220a06be4df7d33cdcf303276182fbb8a7c9b2c6eb2c6";
/**
 * main's code (9eac0b5, before SS1) over SS1's cases: planIntents over every plan case, the limit counterfactual and
 * v4 over the replay case, each with limit_supersede "off" (main ignores the key). Taken once from main's src tree with
 * the same text as offSample below; with "off" the code here must give it byte for byte.
 */
const MAIN_OFF_SAMPLE = "07dc37cd7dd78f258c7408ea2b0d7b3d0d60c71cc3148beb4650a96ef04efc52";
const off = (s) => ({ ...s, limit_supersede: "off" });
const plan = (name) => planIntents(planCases().find(([n]) => n === name)[1]);
const codes = (r) => r.notes.map((n) => n.code);
const kinds = (r) => r.intents.map((it) => it.kind);
const entries = (r) => r.intents.filter((it) => it.kind === "place_limit" || it.kind === "open");
const ssDeletes = (r) => r.intents.filter((it) => it.kind === "delete_order" && it.reason === SUPERSEDE_REASON);
const ssNote = (r) => r.notes.find((n) => n.code === SUPERSEDE_REASON);
const delId = (now) => `del:${TICKET}:${Math.floor(now / M1)}`;

test("SS1-1 the switch: limit_supersede on by default, validated, in ERA_SWITCHES, labelled; the helpers", () => {
  assert.equal(OMEGA_DEFAULTS.limit_supersede, "on");
  assert.deepEqual(LIMIT_SUPERSEDE_MODES, ["on", "off"]);
  assert.equal(SUPERSEDE_REASON, "superseded_by_signal");
  assert.equal(settingsFrom({ limit_supersede: "off" }).settings.limit_supersede, "off");
  assert.equal(settingsFrom({ limit_supersede: "on" }, { ...OMEGA_DEFAULTS, limit_supersede: "off" }).settings.limit_supersede, "on");
  assert.match(settingsFrom({ limit_supersede: "legacy" }).error, /limit_supersede must be 'on' or 'off'/);
  assert.match(settingsFrom({ limit_supersede: false }).error, /limit_supersede must be 'on' or 'off'/);
  // A stored "off" is carried through any other change.
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, limit_supersede: "off" }).settings.limit_supersede, "off");
  assert.equal(limitSupersedeOn(OMEGA_DEFAULTS), true);
  assert.equal(limitSupersedeOn({}), true);
  assert.equal(limitSupersedeOn({ limit_supersede: "off" }), false);
  assert.ok(ERA_SWITCHES.includes("limit_supersede"));
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, limit_supersede: "off" }), ["limit_supersede=off"]);
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  // The change audit's line names it.
  const at = Date.parse("2026-11-23T15:00:00Z");
  const { lines } = auditSweep({ baseline: { limit_supersede: "on" } }, [{ id: 1, action: "settings", actor: "owner", ms: at, detail: JSON.stringify({ limit_supersede: "off" }) }], { now: at + 2 * M1 });
  assert.match(lines.join("\n"), /newer signal supersedes a resting limit: on → off/);
  // The order's placing signal: its intent's payload, else its comment, else unknown (never superseded).
  assert.equal(orderSignalMs(OLD_ORDER, OLD_META), OLD_ISSUED);
  assert.equal(orderSignalMs(OLD_ORDER, {}), OLD_ISSUED);
  assert.equal(orderSignalMs({ ...OLD_ORDER, comment: "manual" }, {}), null);
  assert.deepEqual(supersededOrders({ orders: [{ ...OLD_ORDER, comment: "manual" }], pendingMeta: {}, signal: NEW_SIGNAL }), []);
  assert.deepEqual(supersededOrders({ orders: [OLD_ORDER], pendingMeta: { [TICKET]: OLD_META }, signal: { ...NEW_SIGNAL, side: "NONE" } }), []);
  assert.deepEqual(supersededOrders({ orders: [OLD_ORDER], pendingMeta: { [TICKET]: OLD_META }, signal: NEW_SIGNAL }), [OLD_ORDER]);
  assert.equal(SUPERSEDE_READ_MS, 10 * M1);
});

test("SS1-2 today: off is the incident (same_side_unprotected); on deletes the 14:00 limit, then places the 14:15 one in its zone once the delete is done", () => {
  // Off: the 14:15 BUY held back by the 14:00 BUY's resting limit, nothing deleted (14:17:23Z).
  const o = plan("today_off");
  assert.deepEqual([codes(o), o.intents], [["same_side_unprotected"], []]);
  // On, the first sync: the old ticket's delete, the new signal through every gate (the council's answer, the zone),
  // and no place in this sync (delete first).
  const first = plan("today_on_first");
  assert.deepEqual(ssDeletes(first).map((d) => [d.id, d.ticket, d.side, d.signal_issued_ms, d.superseded_by]), [[delId(NOW), TICKET, "BUY", OLD_ISSUED, NEW_ISSUED]]);
  assert.deepEqual(entries(first), []);
  assert.deepEqual(codes(first), [SUPERSEDE_REASON, "limit_in_zone", "superseded_delete_waiting"]);
  assert.equal(ssNote(first).detail, `#${TICKET} (signal ${OLD_ISSUED}) by signal ${NEW_ISSUED}; the new signal: superseded_delete_waiting`);
  assert.equal(OLD_ID, "open:1795442400000:B");
  // The council not asked yet: its request goes in the same plan as the delete.
  const ask = plan("today_on_request");
  assert.deepEqual([kinds(ask), codes(ask).at(-1), ask.entry_request?.id, ask.entry_request?.limit?.price], [["delete_order"], "entry_council_waiting", NEW_ID, 2006.3]);
  // The next sync: the order gone, its delete done: the 14:15 limit inside its zone (EZ1), the plan's stop and target.
  const after = plan("today_on_after");
  const it = entries(after)[0];
  assert.deepEqual([it.id, it.kind, it.side, it.entry, it.sl, it.tp, it.zone_from, it.entry_zone], [NEW_ID, "place_limit", "BUY", 2006.3, 2000.7, 2018.7, 2006.7, { low: 2004.2, high: 2007.2 }]);
  assert.deepEqual(ssDeletes(after), [], "nothing left to delete");
  assert.deepEqual(codes(after), ["limit_in_zone"]);
  // The same sync with the old order still reported: no place yet.
  assert.deepEqual(entries(planIntents({ ...planCases().find(([n]) => n === "today_on_after")[1], executor: { ...EXECUTOR, orders: [OLD_ORDER], received_ms: NOW + M1 }, pendingMeta: { [TICKET]: OLD_META } })), []);
});

test("SS1-3 the new signal refused (council skip, out of band, expired, a silent council): the old limit is cancelled all the same", () => {
  for (const [name, code] of [["refused_skip", "council_skip"], ["refused_band", "limit_out_of_band"], ["refused_expired", "expired"], ["refused_silent", "council_unavailable"]]) {
    const r = plan(name);
    assert.equal(ssDeletes(r).length, 1, name);
    assert.deepEqual(entries(r), [], name);
    assert.equal(codes(r).at(-1), code, name);
    assert.match(ssNote(r).detail, new RegExp(`; the new signal: ${code}$`), name);
  }
});

test("SS1-4 open positions keep same_side_unprotected; the other side and the same signal keep today's rule; on and off alike", () => {
  const pos = plan("position_on");
  assert.deepEqual([codes(pos), pos.intents], [["same_side_unprotected"], []]);
  assert.deepEqual(pos, plan("position_off"));
  const opp = plan("opposite_on");
  assert.deepEqual([codes(opp), opp.intents], [["pending_order_exists"], []]);
  assert.deepEqual(opp, plan("opposite_off"));
  const same = plan("same_signal");
  assert.deepEqual([codes(same), same.intents], [["already_opened"], []]);
  // Market entries: no Omega limit rests (deleted as entry_order_market, today's rule), nothing superseded.
  const mkt = planIntents({ ...input({ settings: { ...LIMIT, entry_order: "market" } }) });
  assert.deepEqual([ssDeletes(mkt), mkt.intents[0].reason], [[], "entry_order_market"]);
  assert.deepEqual(mkt, planIntents({ ...input({ settings: { ...OFF, entry_order: "market" } }) }));
  // A newer signal with no side (WAIT) supersedes nothing.
  const wait = planIntents(input({ signal: { ...NEW_SIGNAL, side: "NONE" } }));
  assert.deepEqual(ssDeletes(wait), []);
});

test("SS1-5 delete first: a refused delete is sent again a minute later and nothing is placed; an unanswered one holds too; then the place", () => {
  const rejected = plan("delete_rejected");
  assert.deepEqual(ssDeletes(rejected).map((d) => d.id), [delId(NOW + M1 + 5_000)]);
  assert.deepEqual([entries(rejected), codes(rejected).at(-1)], [[], "superseded_delete_waiting"]);
  // The same minute again: the delete is not sent twice.
  assert.deepEqual(ssDeletes(planIntents(input({ recent: [delId(NOW)] }))), []);
  const waiting = plan("delete_unanswered");
  assert.deepEqual([waiting.intents, codes(waiting).at(-1), waiting.notes.at(-1).detail], [[], "superseded_delete_waiting", `#${TICKET}`]);
  // Done: placed (SS1-2's today_on_after). The terminal's answers as the sync reads them back.
  assert.deepEqual(supersedeDeletes([
    { payload: JSON.stringify({ ticket: 2, reason: SUPERSEDE_REASON }), status: "sent", result: null },
    { payload: JSON.stringify({ ticket: 1, reason: SUPERSEDE_REASON }), status: "failed", result: JSON.stringify({ ok: false, error: "x" }) },
    { payload: JSON.stringify({ ticket: 1, reason: SUPERSEDE_REASON }), status: "done", result: JSON.stringify({ ok: true }) },
    { payload: JSON.stringify({ ticket: 3, reason: SUPERSEDE_REASON }), status: "done", result: JSON.stringify({ ok: true }) },
    { payload: JSON.stringify({ ticket: 4, reason: SUPERSEDE_REASON }), status: "expired", result: null },
    { payload: JSON.stringify({ ticket: 5, reason: "pending_expired" }), status: "sent", result: null }
  ]), [{ ticket: 2, deleted: null }, { ticket: 1, deleted: false }, { ticket: 3, deleted: true }, { ticket: 4, deleted: false }]);
  // "council": the council's market entry waits for the delete, then enters.
  const cm = plan("council_market_first");
  assert.deepEqual([ssDeletes(cm).length, entries(cm), codes(cm).at(-1)], [1, [], "superseded_delete_waiting"]);
  const cma = plan("council_market_after");
  assert.deepEqual(entries(cma).map((x) => [x.id, x.kind, x.entry_order]), [[NEW_ID, "open", "council"]]);
  // A council action on the superseded order is dropped with the reason, never applied.
  const moved = planIntents({ ...input(), limitActions: [{ id: `lc:${TICKET}:1`, ticket: TICKET, action: "move", rule: "closer", price: 2002, max_move: 2 }] });
  assert.deepEqual([moved.intents.filter((x) => x.kind === "modify_order"), moved.limit_dropped], [[], [{ id: `lc:${TICKET}:1`, reason: "the order is superseded by a newer signal (superseded_by_signal)" }]]);
  // The comment alone tells the placing signal.
  assert.equal(ssDeletes(plan("comment_only")).length, 1);
});

// A sqlite D1 for the sync's read (as the other Omega tests).
function d1(log = null) {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { log?.push(sql); const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { log?.push(sql); return db.prepare(sql).get(...params) ?? null; },
        async all() { log?.push(sql); return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

test("SS1-6 the sync reads the superseded_by_signal deletes (only with the switch on) and the plan waits on them; Aether never writes the switch", async () => {
  const log = [];
  const db = d1(log);
  db.raw.exec("CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created_ms INTEGER, updated_ms INTEGER)");
  const ins = db.raw.prepare("INSERT INTO omega_intents VALUES (?, ?, ?, ?, ?, ?, ?)");
  const del = { id: delId(NOW), kind: "delete_order", ticket: TICKET, reason: SUPERSEDE_REASON, side: "BUY" };
  ins.run(del.id, "delete_order", JSON.stringify(del), "sent", null, NOW, NOW);
  ins.run("del:1:1", "delete_order", JSON.stringify({ id: "del:1:1", kind: "delete_order", ticket: 1, reason: SUPERSEDE_REASON }), "done", JSON.stringify({ ok: true }), NOW - SUPERSEDE_READ_MS - 1, NOW);
  ins.run("del:2:1", "delete_order", JSON.stringify({ id: "del:2:1", kind: "delete_order", ticket: 2, reason: "pending_expired" }), "sent", null, NOW, NOW);
  const executor = { ...EXECUTOR, orders: [] };
  const on = await limitInputs(db, executor, NEW_SIGNAL, NOW + 3_000, { supersede: true });
  assert.deepEqual(on.supersede, [{ ticket: TICKET, deleted: null }]);
  // The plan with that read: the order is gone but its delete unanswered, so nothing is placed yet.
  const held = planIntents({ ...input({ orders: [], meta: {}, now: NOW + 3_000, recent: [del.id] }), supersede: on.supersede });
  assert.deepEqual([held.intents, codes(held).at(-1)], [[], "superseded_delete_waiting"]);
  // Answered done: placed.
  db.raw.prepare("UPDATE omega_intents SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify({ ok: true, ticket: TICKET }), del.id);
  const done = await limitInputs(db, executor, NEW_SIGNAL, NOW + 6_000, { supersede: true });
  assert.deepEqual(done.supersede, [{ ticket: TICKET, deleted: true }]);
  const placed = planIntents({ ...input({ orders: [], meta: {}, now: NOW + 6_000, recent: [del.id] }), supersede: done.supersede });
  assert.deepEqual(entries(placed).map((x) => x.id), [NEW_ID]);
  // Off: no read of the deletes and no such input.
  log.length = 0;
  const offIn = await limitInputs(db, executor, NEW_SIGNAL, NOW, {});
  assert.equal("supersede" in offIn, false);
  assert.equal(log.some((q) => /superseded|\$\.reason/.test(q)), false);
  // A read that fails holds the entry (fail closed).
  const broken = { prepare(sql) { if (/\$\.reason/.test(sql)) throw new Error("d1 down"); return db.prepare(sql); } };
  const failed = await limitInputs(broken, executor, NEW_SIGNAL, NOW, { supersede: true });
  assert.deepEqual(entries(planIntents({ ...input({ orders: [], meta: {}, now: NOW + 6_000, recent: [del.id] }), supersede: failed.supersede })), []);
  // Aether's policy never writes the switch: the owner's "off" survives a policy application.
  resetOmegaBrokerSchemaForTests();
  const e = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_POLICY_AUTO: "true" };
  assert.equal((await writeSettings(e, { body: { enabled: true, limit_supersede: "off" }, actor: "owner" }, { now: NOW - 20_000 })).ok, true);
  await e.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ doctrine_sha: "d1", risk_pct: 0.4, limit_supersede: "on" }));
  const r = await applyOmegaPolicy(e, { now: NOW });
  assert.equal(r.status, "applied", JSON.stringify(r));
  const s = (await readSettings(e)).settings;
  assert.deepEqual([s.limit_supersede, s.risk_pct], ["off", 0.4]);
});

test("SS1-7 the limit counterfactual beside v4: the 14:00 limit ends superseded_by_signal and the 14:15 one is placed and filled; off as before; v4 itself unchanged", () => {
  assert.ok(LIMIT_MISSED_REASONS.includes(SUPERSEDE_REASON));
  const k0 = `OANDA:XAUUSD:15:${R_C0 - M15}`, k1 = `OANDA:XAUUSD:15:${R_C0}`;
  const on = replayLimit();
  assert.deepEqual([on.records[k0].limit_status, on.records[k0].limit_gate], ["missed", SUPERSEDE_REASON]);
  const j0 = JSON.parse(on.records[k0].limit_json);
  // Ended at the first minute the 14:15 decision is current (decided 14:17:23, the minute of 14:18).
  assert.equal(j0.ended_at, new Date(R_C0 + 18 * M1).toISOString());
  assert.deepEqual([on.records[k1].limit_status, on.records[k1].limit_filled_at, on.records[k1].limit_exit], ["closed", new Date(R_C0 + 21 * M1).toISOString(), "target"]);
  assert.equal(JSON.parse(on.records[k1].limit_json).entry_policy.placed_at, new Date(R_C0 + 18 * M1).toISOString(), "placed in the minute the old one ended");
  assert.deepEqual(on.limit, { probes: 2, placed: 2, filled: 1, missed: 1 });
  const offRun = replayLimit(off({ ...OMEGA_DEFAULTS, enabled: true }));
  assert.deepEqual([offRun.records[k0].limit_status, offRun.records[k0].limit_gate], ["missed", "pending_expired"]);
  assert.deepEqual([offRun.records[k1].limit_status, offRun.records[k1].limit_gate], ["skipped", "pending_order_exists"]);
  // A resting order of the same signal, or with the other side's newer signal, is never superseded (decision_against is the other side's).
  const sameSide = replayOmegaLimit({ ...replayBase(), ...replayCase(), decisions: replayCase().decisions.slice(0, 1) });
  assert.notEqual(sameSide.records[k0].limit_gate, SUPERSEDE_REASON);
  // v4 is the market replay: no resting order, the same records on and off (the parity's side is unchanged).
  assert.deepEqual(replayV4(), replayV4(off({ ...OMEGA_DEFAULTS, enabled: true })));
  // The checkpoint carries no resting order after the supersede and the fill.
  assert.equal(on.checkpoint.entry.pending, null);
});

test("SS1-8 the v3 Signal Ledger: an older row's Omega side never rests at a newer decision; LH1's blocksNewDecision is unchanged", () => {
  // The 14:00 ENTER_LIMIT row (scalp) read at the 14:15 decision (14:17:23). v3's Omega entry (omegaEntry) ends by the
  // next 15m close, so by then the row is skipped (no hold) or filled (an open position: held while unprotected).
  const at = Date.parse("2026-11-23T14:17:23Z");
  const row = { id: "decision:a", status: "pending", opened_at: "2026-11-23T14:02:00Z", candle_key: `OANDA:XAUUSD:15:${OLD_ISSUED - M15}`, trading_mode: "scalp", entry_action: "ENTER_LIMIT", tp1_closed_at: null, sl_plus_triggered: 0 };
  assert.equal(blocksNewDecision({ ...row, omega_status: "skipped" }, at), null);
  assert.equal(blocksNewDecision({ ...row, omega_status: "open", omega_filled_at: "2026-11-23T14:05:00Z", omega_json: JSON.stringify({ protected_at: null }) }, at), "open");
  assert.equal(blocksNewDecision({ ...row, omega_status: "open", omega_filled_at: "2026-11-23T14:05:00Z", omega_json: JSON.stringify({ protected_at: "2026-11-23T14:12:00Z" }) }, at), null);
  // A row Omega's simulation has not read yet keeps LH1's hold inside its window (it may have filled).
  assert.equal(blocksNewDecision({ ...row, omega_status: "pending" }, at), "pending");
});

/** The off sample: planIntents over every plan case, the limit counterfactual and v4 over the replay case, all "off". */
function offSample({ plan: p = planIntents, limit = replayOmegaLimit, v4 = replayOmega4 } = {}) {
  return [
    JSON.stringify(planCases().map(([n, i]) => [n, p({ ...i, settings: off(i.settings) })])),
    JSON.stringify(limit({ ...replayBase(off({ ...OMEGA_DEFAULTS, enabled: true })), ...replayCase() }).records),
    JSON.stringify(v4({ ...replayBase(off({ ...OMEGA_DEFAULTS, enabled: true })), ...replayCase() }).records)
  ].join("\n");
}

test("SS1-9 off byte for byte: planIntents, the limit counterfactual and v4 as main's code; the fixtures' fingerprint before SS1", async () => {
  assert.equal(createHash("sha256").update(offSample()).digest("hex"), MAIN_OFF_SAMPLE);
  // Off ignores a delete read too.
  for (const [name, i] of planCases()) assert.deepEqual(planIntents({ ...i, settings: off(i.settings) }), planIntents({ ...i, settings: off(i.settings), supersede: [] }), name);
  // Every fixture with limit_supersede "off" gives the behaviour text before SS1 (RE1's hash), byte for byte.
  assert.equal(await sha256Hex(engineBehaviourSource({ limitSupersede: "off" })), BEFORE_SS1_HASH);
  assert.equal(engineBehaviourSource({ limitSupersede: "off" }).includes("\nss/"), false);
});

test("SS1-10 the hashes: a new behaviour (a recorded exception, a new parity era at the deploy) and the code with limit-supersede", async () => {
  assert.notEqual(ENGINE_BEHAVIOUR_HASH, BEFORE_SS1_HASH, "the supersede on is a new era");
  const text = engineBehaviourSource();
  assert.equal(await sha256Hex(text), ENGINE_BEHAVIOUR_HASH);
  const names = text.split("\n").map((l) => l.slice(0, l.indexOf("=")));
  assert.deepEqual(names.filter((x) => x.startsWith("ss/")), ["ss/plan", "ss/limit/today/records", "ss/limit/today/work"]);
  assert.notEqual(ENGINE_CODE_HASH, BEFORE_SS1_CODE_HASH);
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.ok(ENGINE_CODE["limit-supersede"][1].includes("supersededOrders"));
});
