// RM1b (owner 2026-11-25, relayed by the orchestrator: "Turn variant (d) on now"; study RM1a, variant d6): the room
// guardrail waived when it alone holds a side back, the 15m close is beyond the facing edge of a corridor recorded in the
// last hour, and TREND_TF is with the side; behind ROOM_BREAKOUT_WAIVE (FS1), tagged per trade (room_waived), and off by
// itself for 7 days when the waived trades lose (src/room-waive.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as oe from "../src/omega-engine.mjs";
import { ingestDecision, ensureLedgerSchema, resetLedgerSchemaCacheForTests, ROOM_WAIVED_COLUMN } from "../src/signal-ledger.mjs";
import {
  roomBreakoutWaiveOf, roomWaiverFor, earlierCorridors, loadRoomCorridors, resolveRoomWaive, resolveRoomBreakoutWaive, runRoomWaiveRevert,
  roomWaivedTrades, roomWaiveStatus, roomWaivedTag, roomWaivedTagOf, resetRoomWaivedTagMemoForTests, ROOM_WAIVE_AUTO_KEY, ROOM_WAIVE_RULE, ROOM_WAIVE_REVERT
} from "../src/room-waive.mjs";
import { FEATURE_SWITCH_OVERRIDE_KEY, FEATURE_SWITCH_OVERRIDDEN, switchByKey, readSwitch, overriddenKeys } from "../src/feature-switches.mjs";
import { withFeatureSwitches, featureSwitchesPayload, setFeatureSwitch, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import { ERA_SWITCHES, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH } from "../src/ledger-omega4.mjs";
import { ruleVersionOf } from "../src/mode-shadow.mjs";
import { roomScenario, earlierRecord, loadedOf, seed, CLOSE, NOW } from "./support/room-waive-fixture.mjs";
import { RM1A_ROWS } from "./fixtures/rm1a-room-blocks.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const mods = { de, ea, oe };
const quiet = async (fn) => { const o = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = o; } };
const scenario = (opts = {}) => quiet(() => roomScenario(mods, { db: d1, kv, ...opts }));
const roomCheck = (g) => g.checks.find((c) => c.id === "room");
const DAY = 86_400_000;
const OWNER = "owner-sub-0001";
/** The hash of roomScenario's outputs taken with main 738960c's modules (a git-archive of main, the same scenario code). */
const MAIN_HASH = "eb803ff02702dd04d560d56596a7e935e29ca527a6ebfa7de63134804eabb674";

test("RW-1 the switch: only \"on\" turns it on; wrangler.jsonc sets it with the owner's words; the FS1 row", () => {
  assert.deepEqual([roomBreakoutWaiveOf({}), roomBreakoutWaiveOf({ ROOM_BREAKOUT_WAIVE: "bogus" }), roomBreakoutWaiveOf({ ROOM_BREAKOUT_WAIVE: " On " }), roomBreakoutWaiveOf({ ROOM_BREAKOUT_WAIVE: "off" })], ["off", "off", "on", "off"]);
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(w, /\n\s*"ROOM_BREAKOUT_WAIVE": "on",\n/);
  assert.match(w, /"Turn variant \(d\) on now"/);
  assert.doesNotMatch(readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"), /ROOM_BREAKOUT_WAIVE/);
  const e = switchByKey("ROOM_BREAKOUT_WAIVE");
  assert.deepEqual([e.group, e.worker, e.write, e.resolve, e.hold, e.emergency_stop, e.read_only, e.era_switch, e.restarts_mode_evidence, e.default_value, e.config_value, [...e.values]],
    ["plans", "ai", "feature-switch", "env", "room-waive", false, false, false, false, "off", "on", ["on", "off"]]);
  assert.equal(readSwitch(e, "on"), "on");
  assert.equal(ERA_SWITCHES.includes("ROOM_BREAKOUT_WAIVE"), false, "not an era switch: v4 replays each recorded signal");
  // restarts_mode_evidence false: the rule version (the mode evidence's key) does not read the switch.
  assert.equal(ruleVersionOf({ ROOM_BREAKOUT_WAIVE: "on" }), ruleVersionOf({ ROOM_BREAKOUT_WAIVE: "off" }));
  assert.equal(ROOM_WAIVE_RULE.trend_lean, de.LEAN, "LEAN, 0.15, whatever the mode's lean");
});

test("RW-2 off, unset and held: decisions, council messages, the EA signal and Omega's intents equal main's (hash taken on main 738960c)", async () => {
  for (const env of [{}, { ROOM_BREAKOUT_WAIVE: "off" }, { ROOM_BREAKOUT_WAIVE: "bogus" }]) assert.equal(sha(await scenario({ env })), MAIN_HASH, JSON.stringify(env));
  // "on" while the automatic revert holds: exactly "off" (the pure path has no hold, so only the engine's part is compared).
  const engineOf = (s) => ({ engine: s.engine, stored: s.stored, council_seen: s.council_seen, storedSignal: s.storedSignal, storedIntents: s.storedIntents });
  const main = engineOf(await scenario());
  const hold = (run) => run.SIGNAL_CACHE.put(ROOM_WAIVE_AUTO_KEY, JSON.stringify({ value: "off", since: new Date(NOW - DAY).toISOString(), until: new Date(NOW + DAY).toISOString() }));
  const held = engineOf(await scenario({ env: { ROOM_BREAKOUT_WAIVE: "on" }, prepare: async (run) => { await hold(run); } }));
  assert.equal(sha(held), sha(main));
  // An unreadable hold: "off" too, never a waiver by accident.
  const broken = engineOf(await scenario({ env: { ROOM_BREAKOUT_WAIVE: "on" }, prepare: (run) => ({ ...run, SIGNAL_CACHE: { get: async (k) => { if (k === ROOM_WAIVE_AUTO_KEY) throw new Error("kv down"); return k === de.TRADING_MODE_KEY ? "scalp" : null; }, put: async () => {} } }) }));
  assert.equal(sha(broken), sha(main));
  assert.deepEqual(await resolveRoomBreakoutWaive({ ROOM_BREAKOUT_WAIVE: "on", SIGNAL_CACHE: { get: async () => { throw new Error("down"); } } }), { value: "off", source: "unreadable", env_value: "on" });
  // Sanity: "on" changes the outcome of this very scenario.
  const on = await scenario({ env: { ROOM_BREAKOUT_WAIVE: "on" } });
  assert.notEqual(sha(on), MAIN_HASH);
  assert.deepEqual([main.engine.stance, on.engine.stance], ["WAIT", "SELL"]);
  // The engines' hashes do not move (V13/V14 recompute them).
  assert.equal(ENGINE_CODE_HASH.slice(0, 8), "a6990366");
  assert.equal(ENGINE_BEHAVIOUR_HASH.slice(0, 8), "ecfe3f90");
});

test("RW-3 on: a with-trend breakout of the corridor 1 bar or 4 bars before waives the room; the detail, the tag, the record, the signal and the intent", async () => {
  for (const k of [1, 4]) {
    const s = await scenario({ env: { ROOM_BREAKOUT_WAIVE: "on" }, earlier: [earlierRecord(15 * k)] });
    const short = s.guards.short, room = roomCheck(short);
    assert.equal(room.pass, true, `k=${k}`);
    assert.match(room.detail, new RegExp(`^price is squeezed: .*; waived \\(RM1b\\): the 15m close is below the corridor recorded ${k} bars? \\(${15 * k} minutes\\) before, 0\\.8 times the 1H average range wide, with the trend \\(TREND_TF -1\\)$`));
    const tag = { corridor: { k, width_atr: 0.8, words: `the corridor recorded ${k} bar${k === 1 ? "" : "s"} (${15 * k} minutes) before, 0.8 times the 1H average range wide` }, broke_at: earlierRecord(15 * k).bar_close, trend: -1 };
    assert.deepEqual(short.room_waived, tag);
    assert.equal(short.allowed, true);
    assert.deepEqual([s.record.stance, s.record.room_waived, s.record.trade.side], ["SELL", tag, "SELL"]);
    assert.doesNotMatch(JSON.stringify(tag), /\d{3,}\.\d/, "no price in the tag");
    // The engine reads the earlier corridor itself (D1) and stores the same.
    const stored = JSON.parse(s.stored);
    assert.deepEqual([stored.stance, stored.room_waived], ["SELL", tag]);
    assert.equal(stored.guardrails.short.checks.find((c) => c.id === "room").pass, true);
    // The long side is counter-trend: its room check still fails, untouched.
    assert.equal(roomCheck(s.guards.long).pass, false);
    assert.ok(!("room_waived" in s.guards.long));
    // The EA signal and Omega's plan are those of any SELL: no key of the waiver in either.
    assert.equal(s.signal.side, "SELL");
    assert.doesNotMatch(JSON.stringify(s.signal) + JSON.stringify(s.intents), /room_waived|RM1b/);
    assert.ok(s.storedIntents.intents.some((it) => it.kind === "open"));
  }
});

test("RW-4 no waiver: closes inside every earlier corridor, a corridor 5 bars back or off the 15-minute grid, a trend against, neutral or missing, another failing check, room passing", async () => {
  const on = { ROOM_BREAKOUT_WAIVE: "on" };
  const blocked = async (opts, why) => {
    const s = await scenario({ env: on, ...opts });
    assert.equal(roomCheck(s.guards.short).pass, false, why);
    assert.ok(!("room_waived" in s.guards.short) && !("room_waived" in s.record), why);
    assert.equal(s.record.stance, "WAIT", why);
    assert.equal(JSON.parse(s.stored).stance, "WAIT", why);
    return s;
  };
  // The close inside: every earlier corridor's lower edge below the 10:00 close.
  const inside = (m) => earlierRecord(m, { squeezed: true, corridor: 8, corridor_atr: 0.8, needed: 10, below: { low: 3996, high: 3999 }, above: { low: 4007, high: 4010 } });
  await blocked({ earlier: [inside(15), inside(30), inside(45), inside(60)] }, "inside every corridor");
  // Exactly at the edge is not beyond it.
  await blocked({ earlier: [earlierRecord(15, { squeezed: true, corridor_atr: 0.8, below: { low: 3997, high: 4000 }, above: { low: 4008, high: 4011 } })] }, "at the edge");
  // More than 4 bars back, or not on the 15-minute grid.
  await blocked({ earlier: [earlierRecord(75)] }, "5 bars back");
  await blocked({ earlier: [earlierRecord(20)] }, "not aligned to 15 minutes");
  // A missing or unreadable earlier record does not count.
  await blocked({ earlier: [{ ...earlierRecord(15), squeeze: null }] }, "no corridor recorded");
  await blocked({ earlier: [] }, "no earlier decision");
  // Trend: against, neutral; missing (no extended witnesses: no TREND_TF card).
  const trendOf = (x) => x.record.witnesses.find((c) => c.key === "TREND_TF")?.lean;
  assert.ok(trendOf(await blocked({ loaded: loadedOf({ trend: "up" }) }, "counter-trend")) >= 0.15);
  const neutral = trendOf(await blocked({ loaded: loadedOf({ trend: "flat" }) }, "neutral trend"));
  assert.ok(Number.isFinite(neutral) && Math.abs(neutral) < 0.15, "a neutral lean, not a missing one");
  assert.equal(trendOf(await blocked({ env: { ...on, GLOBAL_DECISION_WEIGHTED: "false" } }, "no TREND_TF")), undefined);
  // Another failing check: the 15m room stale. Room stays failed beside it.
  const stale = loadedOf();
  stale.global.timeframes = stale.global.timeframes.map((t) => (t.key === "M15" ? { ...t, stale: true } : t));
  const s = await blocked({ loaded: stale }, "fresh fails too");
  assert.deepEqual(s.guards.short.checks.filter((c) => !c.pass).map((c) => c.id), ["fresh", "room"]);
  assert.doesNotMatch(roomCheck(s.guards.short).detail, /waived/);
  // Room passing anyway (a wide corridor): no waiver, no tag, whatever broke.
  const wide = loadedOf();
  wide.strategy.key_levels.zones = [{ low: 3980, high: 3985, price: 3982.5, candidate: true }, { low: 4030, high: 4035, price: 4032.5, candidate: true }];
  const w = await scenario({ env: on, loaded: wide });
  assert.deepEqual([roomCheck(w.guards.short).pass, "room_waived" in w.record, /waived/.test(roomCheck(w.guards.short).detail)], [true, false, false]);
  // The pure rule: room among the checks or any other check failing, no price, a wrong direction: null.
  const cards = [{ key: "TREND_TF", lean: -0.4, available: true }];
  const corridors = { bar_close: CLOSE, earlier: [{ bar_close: earlierRecord(15).bar_close, squeeze: earlierRecord(15).squeeze }] };
  assert.ok(roomWaiverFor(-1, { checks: [{ id: "quorum", pass: true }], price: 4000, cards, corridors }));
  assert.equal(roomWaiverFor(-1, { checks: [{ id: "quorum", pass: false }], price: 4000, cards, corridors }), null);
  assert.equal(roomWaiverFor(-1, { checks: [{ id: "room", pass: false }], price: 4000, cards, corridors }), null);
  assert.equal(roomWaiverFor(-1, { checks: [], price: null, cards, corridors }), null);
  assert.equal(roomWaiverFor(0, { checks: [], price: 4000, cards, corridors }), null);
  assert.equal(roomWaiverFor(-1, { checks: [], price: 4000, cards: [], corridors }), null, "TREND_TF missing");
  assert.equal(roomWaiverFor(-1, { checks: [], price: 4000, cards: [{ key: "TREND_TF", lean: -0.14 }], corridors }), null, "under LEAN");
  assert.ok(roomWaiverFor(-1, { checks: [], price: 4000, cards: [{ key: "TREND_TF", lean: -0.15 }], corridors }), "LEAN itself is with");
  // decide(): the tag only on a trade of the waived side; a held stance carries none.
  const a = (await scenario({ env: on })).guards;
  const quorum = { long_share: 0, short_share: 1, score: -0.6, bias: "BEARISH" };
  const sell = { stance: "SELL", bias: "BEARISH", confidence: 0.7, entry_type: "limit", target: "tp1" };
  assert.ok(de.decide({ answer: sell, guards: a, quorum }).room_waived);
  assert.equal("room_waived" in de.decide({ answer: { ...sell, confidence: 0.2 }, guards: a, quorum }), false, "held by the confidence: no tag");
  assert.equal("room_waived" in de.decide({ answer: { ...sell, stance: "WAIT" }, guards: a, quorum }), false);
});

test("RW-5 the earlier corridors: one bounded D1 read of the 4 bars of the last hour; an unreadable record does not count; the grid", async () => {
  de.resetDecisionSchemaCacheForTests();
  const db = d1();
  const bad = { ...earlierRecord(30) };
  await seed(de, db, [earlierRecord(15), earlierRecord(45), earlierRecord(60), earlierRecord(75), earlierRecord(5), { ...earlierRecord(-15) }]);
  db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(bad.decision_key, bad.bar_close, bad.decided_at, "WAIT", 0.5, "fallback", "{not json");
  const c = await loadRoomCorridors(db, CLOSE);
  assert.equal(c.bar_close, CLOSE);
  assert.deepEqual(c.earlier.map((e) => [e.bar_close, Boolean(e.squeeze)]), [["2026-11-24T09:45:00.000Z", true], ["2026-11-24T09:30:00.000Z", false], ["2026-11-24T09:15:00.000Z", true], ["2026-11-24T09:00:00.000Z", true]]);
  assert.deepEqual(earlierCorridors(c).map((e) => e.k), [1, 3, 4], "the unreadable one does not count");
  assert.deepEqual(earlierCorridors({ bar_close: CLOSE, earlier: [{ bar_close: "2026-11-24T09:50:00.000Z", squeeze: {} }, { bar_close: "2026-11-24T08:45:00.000Z", squeeze: {} }, { bar_close: CLOSE, squeeze: {} }, { bar_close: "x", squeeze: {} }] }), []);
  assert.deepEqual((await loadRoomCorridors({ prepare: () => { throw new Error("down"); } }, CLOSE)).earlier, []);
  // The read is bound: an IN over the 4 closes on the bar_close index, at most 8 rows, the squeeze only.
  const src = readFileSync(new URL("../src/room-waive.mjs", import.meta.url), "utf8");
  assert.match(src, /json_extract\(decision_json, '\$\.squeeze'\) END AS squeeze FROM engine_decisions WHERE bar_close IN \(\$\{closes\.map\(\(\) => "\?"\)\.join\(", "\)\}\) ORDER BY bar_close DESC LIMIT \$\{ROOM_CORRIDOR_ROWS\}/);
  // runDecisionEngine reads it only while the waiver is in force.
  const deSrc = readFileSync(new URL("../src/decision-engine.mjs", import.meta.url), "utf8");
  assert.match(deSrc, /if \(roomWaive === "on" && data\.room_corridors === undefined\) data\.room_corridors = await loadRoomCorridors\(env\.DB, closeIso\);/);
});

test("RW-6 RM1a's data: the waiver releases exactly the room-only WAITs RM1a's d6 released and holds the rest", () => {
  const targets = RM1A_ROWS.filter((r) => r.rm1a);
  assert.ok(targets.length >= 8);
  assert.deepEqual([targets.filter((r) => r.rm1a.d6).length, targets.filter((r) => !r.rm1a.d6).length], [4, 5]);
  assert.ok(targets.some((r) => r.rm1a.b4 && r.rm1a.trend === "against"), "a breakout against the trend is in the set");
  assert.ok(targets.some((r) => !r.rm1a.b4 && r.rm1a.trend === "with"), "a with-trend close inside is in the set");
  const earlier = RM1A_ROWS.map((r) => ({ bar_close: r.bar_close, squeeze: r.squeeze }));
  const ks = new Set();
  for (const r of RM1A_ROWS) {
    for (const side of ["long", "short"]) {
      const dir = side === "long" ? 1 : -1;
      const checks = r.checks[side].map(([id, pass]) => ({ id, pass }));
      const room = checks.find((c) => c.id === "room");
      // The engine asks only where room failed; it passes the side's other checks as guardrailsFor made them.
      const w = room && !room.pass ? roomWaiverFor(dir, { checks: checks.filter((c) => c.id !== "room"), price: r.price, cards: [{ key: "TREND_TF", lean: r.trend_tf, available: r.trend_tf != null }], corridors: { bar_close: r.bar_close, earlier } }) : null;
      const expected = Boolean(r.rm1a && r.rm1a.side === side && r.rm1a.d6);
      assert.equal(Boolean(w), expected, `${r.bar_close} ${side}`);
      if (w) { ks.add(w.tag.corridor.k); assert.equal(w.tag.trend * dir > 0, true); }
    }
  }
  assert.ok(ks.has(1) && [...ks].some((k) => k > 1), "releases by the corridor 1 bar before and by an older one");
  assert.doesNotMatch(readFileSync(new URL("./fixtures/rm1a-room-blocks.mjs", import.meta.url), "utf8"), /\b[1-9]\d{3}\.\d/, "rebased: no gold price in the fixture");
});

// ------------------------------------------------------------------ the automatic revert

function revertEnv(over = {}) {
  const DB = d1();
  DB.raw.exec(`CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, created_ms INTEGER, updated_ms INTEGER);
    CREATE TABLE signal_ledger (candle_key TEXT, omega_status TEXT, r_omega REAL, room_waived TEXT);
    CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT);`);
  return { DB, SIGNAL_CACHE: kv(), ROOM_BREAKOUT_WAIVE: "on", ...over };
}
let seq = 0;
const TAG = { corridor: { k: 2, width_atr: 0.6, words: "the corridor recorded 2 bars (30 minutes) before, 0.6 times the 1H average range wide" }, broke_at: "2026-11-24T09:30:00.000Z", trend: -0.4 };
function trade(env, { at, r, tagged = true, status = "closed", kind = "open" }) {
  const issued = 1_790_000_000_000 + (seq += 1) * 900_000;
  env.DB.raw.prepare("INSERT INTO omega_intents VALUES (?, ?, ?, 'done', ?, ?)").run(`${kind}:${issued}:S`, kind, JSON.stringify({ signal_issued_ms: issued, ...(tagged ? { room_waived: TAG } : {}) }), at, at);
  env.DB.raw.prepare("INSERT INTO signal_ledger VALUES (?, ?, ?, ?)").run(`OANDA:XAUUSD:15:${issued}`, status, r, tagged ? JSON.stringify(TAG) : null);
}
const T0 = Date.parse("2026-11-26T12:00:00Z");

test("RW-7 the revert: 14 closed stay; 15 below 0R: off for 7 days (one Telegram line, one Omega event, the FS1 row's auto_revert), then the env value, counted afresh", async () => {
  const env = revertEnv();
  for (let i = 0; i < 14; i += 1) trade(env, { at: T0 - i * 3_600_000, r: -1 });
  trade(env, { at: T0, r: -1, tagged: false });
  trade(env, { at: T0, r: -1, status: "open" });
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const r1 = await runRoomWaiveRevert(env, { now: T0, send });
  assert.deepEqual([r1.status, r1.n, r1.revert], ["kept", 14, false]);
  assert.equal((await resolveRoomBreakoutWaive(env, { now: T0 })).value, "on");
  assert.equal((await runRoomWaiveRevert(env, { now: T0 + 3_600_000, send })).status, "fresh", "once a UTC day");
  // The 15th: the latest 15 average below 0R.
  trade(env, { at: T0 + DAY - 60_000, r: 2, kind: "place_limit" });
  assert.equal((await roomWaivedTrades(env.DB)).length, 15);
  const r2 = await runRoomWaiveRevert(env, { now: T0 + DAY, send });
  assert.deepEqual([r2.status, r2.n, r2.mean_r], ["reverted", 15, -0.8]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "XAUUSD SYSTEM · Room breakout waiver (ROOM_BREAKOUT_WAIVE) off for 7 days: the last 15 trades it let through averaged -0.8R in Omega R, below 0R. The room check is as before meanwhile; checked again daily after the hold.");
  assert.deepEqual(env.DB.raw.prepare("SELECT actor, action FROM omega_events").all().map((x) => [x.actor, x.action]), [["agent:room", "room_waive_reverted"]]);
  assert.deepEqual(Object.values(await resolveRoomBreakoutWaive(env, { now: T0 + 6 * DAY })), ["off", "auto_revert", "on"]);
  // The FS1 row carries the hold, as AGENT_VETO_RULE's does; its value is the one in force.
  resetFeatureSwitchMemoForTests();
  const row = (await featureSwitchesPayload(env, { now: T0 + DAY + 1 })).switches.find((x) => x.key === "ROOM_BREAKOUT_WAIVE");
  assert.deepEqual([row.value, row.source, row.config_value, row.auto_revert], ["off", "config", "on", { since: new Date(T0 + DAY).toISOString(), until: new Date(T0 + 8 * DAY).toISOString() }]);
  // Held: checked daily, nothing more told.
  assert.equal((await runRoomWaiveRevert(env, { now: T0 + 2 * DAY, send })).status, "held");
  assert.equal(sent.length, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_events").get().n, 1);
  // After 7 days: the env value again; the old trades no longer count.
  const after = T0 + 8 * DAY + 60_000;
  assert.equal((await resolveRoomBreakoutWaive(env, { now: after })).value, "on");
  const r3 = await runRoomWaiveRevert(env, { now: after, send });
  assert.deepEqual([r3.status, r3.n], ["kept", 0]);
  assert.deepEqual(env.DB.raw.prepare("SELECT action FROM omega_events ORDER BY id").all().map((x) => x.action), ["room_waive_reverted", "room_waive_released"]);
  resetFeatureSwitchMemoForTests();
  assert.equal((await featureSwitchesPayload(env, { now: after })).switches.find((x) => x.key === "ROOM_BREAKOUT_WAIVE").auto_revert, null);
  // The read (GET /api/weighting/room breakout_waive).
  const st = await roomWaiveStatus(env, { now: after });
  assert.deepEqual([st.value, st.source, st.env_value, st.auto_revert, st.closed, st.waived, st.counted_since], ["on", "env", "on", null, 0, 16, new Date(T0 + 8 * DAY).toISOString()]);
  assert.deepEqual(st.revert_rule, { min_trades: 15, below_r: 0, hold_days: 7 });
  assert.equal(ROOM_WAIVE_REVERT.min_trades, 15);
  // Env "off" and no hold stored: nothing read beyond the key, nothing written.
  const off = revertEnv({ ROOM_BREAKOUT_WAIVE: undefined });
  assert.equal((await runRoomWaiveRevert(off, { now: T0 })).status, "inactive");
  assert.equal(off.SIGNAL_CACHE.m.has(ROOM_WAIVE_AUTO_KEY), false);
});

test("RW-8 the order owner override > auto-revert > env is pinned; the owner forces it back on through FS1 and nothing reverts under the force", async () => {
  // Pure.
  const hold = { value: "off", since: new Date(T0 - DAY).toISOString(), until: new Date(T0 + DAY).toISOString() };
  assert.deepEqual(resolveRoomWaive({ env: { ROOM_BREAKOUT_WAIVE: "on" }, auto: hold, now: T0 }), { value: "off", source: "auto_revert", env_value: "on" });
  assert.deepEqual(resolveRoomWaive({ env: { ROOM_BREAKOUT_WAIVE: "on" }, auto: hold, now: T0 + 2 * DAY }), { value: "on", source: "env", env_value: "on" });
  assert.deepEqual(resolveRoomWaive({ env: { ROOM_BREAKOUT_WAIVE: "on", [FEATURE_SWITCH_OVERRIDDEN]: ["ROOM_BREAKOUT_WAIVE"] }, auto: hold, now: T0 }), { value: "on", source: "owner", env_value: "on" });
  assert.deepEqual(resolveRoomWaive({ env: {}, auto: hold, now: T0 }), { value: "off", source: "env", env_value: "off" });
  // Through FS1: the owner's POST writes the override; the run's env copy carries it and knows it is one.
  resetFeatureSwitchMemoForTests();
  const env = { ...revertEnv(), OWNER_ACCESS_SUB: OWNER };
  env.DB.raw.exec("CREATE TABLE IF NOT EXISTS engine_decisions (decision_key TEXT PRIMARY KEY, decision_json TEXT)");
  // 15 losing waived trades opened after the hold's end (the ones counted once it is over).
  for (let i = 0; i < 15; i += 1) trade(env, { at: T0 + DAY + (i + 1) * 60_000, r: -1 });
  await env.SIGNAL_CACHE.put(ROOM_WAIVE_AUTO_KEY, JSON.stringify(hold));
  assert.deepEqual(Object.values(await resolveRoomBreakoutWaive(await withFeatureSwitches(env, { now: T0 }), { now: T0 })), ["off", "auto_revert", "on"]);
  const sent = [];
  const set = await setFeatureSwitch(env, { key: "ROOM_BREAKOUT_WAIVE", value: "on", actor: "owner@example.com", actor_sub: OWNER, now: T0, send: async (t) => { sent.push(t); } });
  assert.deepEqual([set.ok, set.changed, set.switch.value, set.switch.source, set.switch.auto_revert], [true, true, "on", "override", null]);
  assert.equal(sent[0], "XAUUSD SYSTEM · Feature switch Room waiver on a with-trend breakout (ROOM_BREAKOUT_WAIVE) set by the owner: off (config) → on (override).");
  const run = await withFeatureSwitches(env, { now: T0 });
  assert.deepEqual([run.ROOM_BREAKOUT_WAIVE, overriddenKeys(run)], ["on", ["ROOM_BREAKOUT_WAIVE"]]);
  assert.deepEqual(overriddenKeys({ ...run, X: 1 }), ["ROOM_BREAKOUT_WAIVE"], "the marker survives a run's own spread");
  assert.equal(JSON.stringify(run).includes("overridden"), false, "never in JSON");
  assert.deepEqual(Object.values(await resolveRoomBreakoutWaive(run, { now: T0 })), ["on", "owner", "on"], "the owner's override over the hold");
  const r = await runRoomWaiveRevert(run, { now: T0 + 2 * DAY, send: async () => assert.fail("no line under a force") });
  assert.deepEqual([r.status, r.n, r.mean_r], ["owner_force", 15, -1], "the hold ended; the force decides, nothing reverts");
  // Reset: back to the revert and the config; the losing trades revert it on the next day's check.
  const back = await setFeatureSwitch(env, { key: "ROOM_BREAKOUT_WAIVE", reset: true, actor_sub: OWNER, now: T0 + 2 * DAY, send: async (t) => { sent.push(t); } });
  assert.deepEqual([back.switch.value, back.switch.source], ["on", "config"]);
  assert.match(sent.at(-1), /reset by the owner: on \(override\) → on \(config\)\. The automatic revert and the config decide again\.$/);
  const plain = await withFeatureSwitches(env, { now: T0 + 2 * DAY });
  assert.deepEqual(overriddenKeys(plain), []);
  assert.equal((await runRoomWaiveRevert(plain, { now: T0 + 3 * DAY })).status, "reverted");
  // The owner's "off" while env is "on": off, source owner.
  await setFeatureSwitch(env, { key: "ROOM_BREAKOUT_WAIVE", value: "off", actor_sub: OWNER, now: T0 + 3 * DAY });
  assert.deepEqual(Object.values(await resolveRoomBreakoutWaive(await withFeatureSwitches(env, { now: T0 + 3 * DAY }), { now: T0 + 3 * DAY })), ["off", "owner", "off"]);
  // The engine with the owner's "on" over a hold waives exactly as "on".
  resetFeatureSwitchMemoForTests();
  const forced = await scenario({ env: { ROOM_BREAKOUT_WAIVE: "on" }, prepare: async (x) => {
    await x.SIGNAL_CACHE.put(ROOM_WAIVE_AUTO_KEY, JSON.stringify({ value: "off", since: new Date(NOW - DAY).toISOString(), until: new Date(NOW + DAY).toISOString() }));
    await x.SIGNAL_CACHE.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ ROOM_BREAKOUT_WAIVE: { value: "on", actor: "owner", at: new Date(NOW).toISOString() } }));
    resetFeatureSwitchMemoForTests();
    return withFeatureSwitches(x, { now: NOW });
  } });
  assert.deepEqual([forced.engine.stance, JSON.parse(forced.stored).room_waived?.corridor?.k], ["SELL", 1]);
  resetFeatureSwitchMemoForTests();
});

test("RW-9 the trade carries the tag: the entry intent from its decision, the Signal Ledger row from ingestDecision (NULL elsewhere); the wiring", async () => {
  const db = d1();
  db.raw.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, decision_json TEXT)");
  const issued = 1795165200000;
  db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?)").run(`OANDA:XAUUSD:15:${issued}`, JSON.stringify({ stance: "SELL", room_waived: TAG }));
  db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?)").run(`OANDA:XAUUSD:15:${issued + 900_000}`, JSON.stringify({ stance: "SELL", veto_softened: { rule: "A6", old_detail: "x" } }));
  resetRoomWaivedTagMemoForTests();
  assert.deepEqual(await roomWaivedTag(db, { kind: "open", signal_issued_ms: issued }), TAG);
  assert.deepEqual(await roomWaivedTag(db, { kind: "place_limit", signal_issued_ms: issued }), TAG);
  assert.equal(await roomWaivedTag(db, { kind: "open", signal_issued_ms: issued + 900_000 }), null);
  assert.equal(await roomWaivedTag(db, { kind: "modify_sl", signal_issued_ms: issued }), null, "only an entry");
  assert.equal(await roomWaivedTag({ prepare: () => { throw new Error("down"); } }, { kind: "open", signal_issued_ms: 1 }), null);
  assert.equal(roomWaivedTagOf({ corridor: { k: 5 }, broke_at: "x" }), null);
  // bridgeSync: the tag joins the intent it inserts, after SV1b's, and every other intent stays as planned.
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  assert.match(src, /const it = softened \? \{ \.\.\.attempt, veto_softened: softened \} : attempt;\n(?:\s*\/\/[^\n]*\n)+\s*const waived = await roomWaivedTag\(db, it\);\n\s*const row = waived \? \{ \.\.\.it, room_waived: waived \} : it;\n\s*await db\.prepare\("INSERT OR IGNORE INTO omega_intents[^\n]*\.bind\(row\.id, row\.kind, JSON\.stringify\(row\), now, now\)/);
  // The ledger row.
  resetLedgerSchemaCacheForTests();
  const L = { DB: d1() };
  await ensureLedgerSchema(L.DB);
  assert.equal(ROOM_WAIVED_COLUMN, "room_waived TEXT");
  const d = (key, over = {}) => ({ decision_key: `OANDA:XAUUSD:15:${key}`, decided_at: new Date(key + 960_000).toISOString(), stance: "SELL", confidence: 0.7, summary: "Decision SELL.", trading_mode: "scalp", trade: { side: "SELL", action: "ENTER_LIMIT", entry: 100, stop: 102, target: "tp1", tp: 97, tp1: 97, tp2: 95 }, ...over });
  assert.equal(await ingestDecision(L, d(issued, { room_waived: TAG }), { now: issued + 960_000 }), 1);
  assert.equal(await ingestDecision(L, d(issued + 900_000, { stance: "BUY", trade: { side: "BUY", action: "ENTER_LIMIT", entry: 100, stop: 98, target: "tp1", tp: 103, tp1: 103, tp2: 105 } }), { now: issued + 1_860_000 }), 1);
  assert.deepEqual(L.DB.raw.prepare("SELECT room_waived, veto_softened FROM signal_ledger ORDER BY opened_at").all().map((x) => [x.room_waived, x.veto_softened]), [[JSON.stringify(TAG), null], [null, null]]);
  // The wiring: the value resolved onto the decision's env copy; the daily check beside SV1b's; the read on the room route.
  const deSrc = readFileSync(new URL("../src/decision-engine.mjs", import.meta.url), "utf8");
  assert.match(deSrc, /try \{ roomWaive = \(await resolveRoomBreakoutWaive\(env, \{ now \}\)\)\.value; \} catch \{ roomWaive = "off"; \}\n\s*env = \{ \.\.\.env, ROOM_BREAKOUT_WAIVE: roomWaive \};/);
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(idx, /const veto = await runAgentVetoRevert\(env, \{ send:[^\n]*\n[^\n]*\n(?:\s*\/\/[^\n]*\n)+\s*const roomWaive = await runRoomWaiveRevert\(env, \{ send:/);
  assert.match(idx, /\.\.\.\(await readRoomTuning\(env\)\), breakout_waive: await roomWaiveStatus\(env\)\.catch\(\(\) => null\)/);
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(w, /room-waive[^\n]*cron/i, "no cron of its own");
});
