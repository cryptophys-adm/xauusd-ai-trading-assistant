// SV1b (owner 2026-11-24, relayed: "Build A6+A7, switch on, auto-revert"): the strategy agents' vetoes no longer count a
// two-sided agent against the side it also speaks for (A6: the lean veto, A7: the arm veto), behind AGENT_VETO_RULE,
// tagged per trade, and back to classic by itself when the softened trades lose (src/agent-veto.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { decide, buildDecisionRecord } from "../src/decision-engine.mjs";
import { ingestDecision, ensureLedgerSchema, resetLedgerSchemaCacheForTests } from "../src/signal-ledger.mjs";
import {
  agentVetoRuleOf, resolveAgentVetoRule, resolveRule, revertVerdict, runAgentVetoRevert, setAgentVetoForce, agentVetoStatus, vetoSoftenedTag,
  resetVetoTagMemoForTests, softenedTrades, AGENT_VETO_AUTO_KEY, AGENT_VETO_OWNER_KEY, AGENT_VETO_REVERT, A6_MIN_ONE_SIDED
} from "../src/agent-veto.mjs";
import { SV1A_BLOCKS, guardsFrom, quorumFrom, ANSWER_SELL } from "./fixtures/sv1a-veto-blocks.mjs";
import { FEATURE_SWITCH_OVERRIDE_KEY } from "../src/feature-switches.mjs";

const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const decideRow = (row, rule = null) => decide({ answer: ANSWER_SELL, guards: guardsFrom(row, { rule }), quorum: quorumFrom(row) });
const kindOf = (o) => (o ? `${o.by}:${String(o.failed?.[0]?.detail ?? "").replace(/\(.*\)/, "")}` : null);
const NOW = Date.parse("2026-11-20T10:01:10Z");
const COUNCIL = { answer: { ...ANSWER_SELL, summary: "Decision SELL, bias bearish: the rooms lean down.", reasons: ["The rooms lean down."], risks: [], weighed: [] } };
const recordOf = (row, rule = null) => buildDecisionRecord({ key: `OANDA:XAUUSD:15:${Date.parse(row.at + ":00Z") - 900_000}`, barClose: row.at + ":00.000Z", loaded: { inputs: {}, strategy: null }, assessment: { cards: [], quorum: quorumFrom(row), guards: guardsFrom(row, { rule }), market: null }, council: COUNCIL, now: NOW, decidedAt: new Date(NOW).toISOString() });

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...a) => wrap(sql, a.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}

test("AV1 the switch: only \"two_sided\" turns it on; unset or unknown is classic; the owner's force, then the revert, then env", () => {
  assert.equal(agentVetoRuleOf({}), "classic");
  assert.equal(agentVetoRuleOf({ AGENT_VETO_RULE: "bogus" }), "classic");
  assert.equal(agentVetoRuleOf({ AGENT_VETO_RULE: " Two_Sided " }), "two_sided");
  assert.deepEqual(resolveRule({ envRule: "two_sided" }), { rule: "two_sided", source: "env" });
  assert.deepEqual(resolveRule({ envRule: "two_sided", auto: { rule: "classic", until: new Date(NOW + 1000).toISOString() }, now: NOW }), { rule: "classic", source: "auto_revert" });
  assert.deepEqual(resolveRule({ envRule: "two_sided", auto: { rule: "classic", until: new Date(NOW - 1000).toISOString() }, now: NOW }), { rule: "two_sided", source: "env" }, "a hold that ended");
  assert.deepEqual(resolveRule({ envRule: "classic", owner: { rule: "two_sided" }, auto: { rule: "classic", until: new Date(NOW + 1000).toISOString() }, now: NOW }), { rule: "two_sided", source: "owner" });
  assert.deepEqual(resolveRule({ envRule: "two_sided", owner: { rule: null } }), { rule: "two_sided", source: "env" }, "a cleared force");
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(w, /"AGENT_VETO_RULE": "two_sided"/);
  assert.match(w, /Build A6\+A7, switch on,\s*\n?\s*\/\/\s*auto-revert/);
  assert.doesNotMatch(readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"), /AGENT_VETO_RULE/);
});

test("AV2 classic is byte-identical to main: decide(), the decision records and the ledger row hash as at 34a8c00", async () => {
  // Hashes taken with the code of main 34a8c00 over the same fixtures (the 54 SV1a blocks with one synthetic plan shape).
  const decisions = SV1A_BLOCKS.map((row) => decideRow(row));
  assert.equal(sha(decisions), "09504554c623af9fd78de89f55b2850fa6cdf54d86d2d050d3a06277d54beedf");
  assert.equal(sha(SV1A_BLOCKS.map((row) => recordOf(row))), "cd72764b8b58fc2933d048da420b4dc8b23d779bc0b0db4b28f3ee02f5a658df");
  // "classic" said, or an unknown value (agentVetoRuleOf), sets no veto_rule on the guards: the same outputs.
  assert.equal(sha(SV1A_BLOCKS.map((row) => decideRow(row, "classic"))), sha(decisions));
  // Every recorded veto comes back under classic, word for word, and nothing is tagged.
  for (const [i, row] of SV1A_BLOCKS.entries()) {
    assert.deepEqual([decisions[i].stance, decisions[i].overruled?.by, decisions[i].overruled?.failed?.[0]?.detail], ["WAIT", row.by, row.detail], row.at);
    assert.ok(!("veto_softened" in decisions[i]));
  }
  // The ledger row of a SELL without a tag: every column as main's, the new column NULL.
  resetLedgerSchemaCacheForTests();
  const env = { DB: d1() };
  await ensureLedgerSchema(env.DB);
  const d = { decision_key: "OANDA:XAUUSD:15:1795165200000", decided_at: "2026-11-20T10:01:10.000Z", stance: "SELL", confidence: 0.7, summary: "Decision SELL.", trading_mode: "scalp", trade: { side: "SELL", action: "ENTER_LIMIT", entry: 100, stop: 102, target: "tp1", tp: 97, tp1: 97, tp2: 95, progressive_stop: 100 } };
  assert.equal(await ingestDecision(env, d, { now: NOW }), 1);
  const { veto_softened, ...rest } = env.DB.raw.prepare("SELECT * FROM signal_ledger").get();
  assert.equal(veto_softened, null);
  assert.equal(sha({ ...rest }), "69fed71050c5bb29753648d38fd0294d3c6d759420b109c1e8b83b272d4192a9");
});

test("AV3 A6 releases exactly SV1a's 19 lean blocks; A7 exactly its 11 arm blocks; each trade says which rule and the classic detail", () => {
  assert.equal(SV1A_BLOCKS.length, 54);
  const released = { A6: [], A7: [] }, tagged = { A6: 0, A7: 0 };
  for (const row of SV1A_BLOCKS) {
    const t = decideRow(row, "two_sided");
    if (kindOf(t.overruled) !== kindOf({ by: row.by, failed: [{ detail: row.detail }] })) released[row.by === "strategy_agents" ? "A6" : "A7"].push(row.at);
    if (t.veto_softened) {
      tagged[t.veto_softened.rule] += 1;
      assert.equal(t.veto_softened.old_detail, row.detail, "the classic rule's own words");
      assert.equal(t.veto_softened.rule, row.sv1a);
      assert.deepEqual([t.stance, t.overruled, t.trade?.side], ["SELL", null, "SELL"]);
      assert.doesNotMatch(JSON.stringify(t.veto_softened), /\d+\.\d/, "no price in the tag");
    } else assert.equal(t.stance, "WAIT", row.at);
  }
  assert.deepEqual(released.A6, SV1A_BLOCKS.filter((r) => r.sv1a === "A6").map((r) => r.at));
  assert.deepEqual(released.A7, SV1A_BLOCKS.filter((r) => r.sv1a === "A7").map((r) => r.at));
  assert.deepEqual([released.A6.length, released.A7.length], [19, 11]);
  // 17 of the 19 then trade; 2 had no agent at all on the sell side and stay held by that check (not a veto rule).
  assert.deepEqual(tagged, { A6: 17, A7: 11 });
  // The record keeps the tag beside the trade; the classic record has none.
  const row = SV1A_BLOCKS.find((r) => r.sv1a === "A7");
  assert.deepEqual(recordOf(row, "two_sided").veto_softened, { rule: "A7", old_detail: row.detail });
  assert.ok(!("veto_softened" in recordOf(row)));
});

test("AV4 A6 and A7 exactly: two one-sided opposing agents still veto; an armed agent that speaks only against still vetoes", () => {
  assert.equal(A6_MIN_ONE_SIDED, 2);
  const base = { at: "2026-11-20T10:00", mode: "scalp", by: "strategy_agents", detail: "", share: 0.8, conf: { zone_pullback: [0.7, 0.8] } };
  // The default agent on both sides plus one long-only agent: +0.22, classic vetoes, A6 lets it through.
  const one = { ...base, lean: 0.22, long: [["zone_pullback", 1.32], ["breakout_retest", 1]], short: [["zone_pullback", 1.32]], arm: null };
  assert.equal(decideRow(one).overruled.by, "strategy_agents");
  assert.deepEqual(decideRow(one, "two_sided").veto_softened, { rule: "A6", old_detail: "the strategy agents lean against the decision (+22)" });
  // Two long-only agents: the veto holds under both rules.
  const two = { ...one, lean: 0.34, long: [...one.long, ["range_fade", 1]] };
  assert.equal(decideRow(two, "two_sided").overruled.by, "strategy_agents");
  // A lean below the threshold is no veto under either rule, and nothing is tagged.
  const weak = { ...one, lean: 0.1 };
  assert.ok(!decideRow(weak, "two_sided").overruled && !("veto_softened" in decideRow(weak, "two_sided")));
  // The arm: zone_pullback armed and two-sided is ignored (A7); sweep_reversal armed and long-only still vetoes, named alone.
  const armed = { ...base, by: "strategy_arm", lean: 0, long: [["zone_pullback", 1.3], ["sweep_reversal", 1.3]], short: [["zone_pullback", 1.3]], arm: ["zone_pullback"] };
  assert.equal(decideRow(armed).overruled.failed[0].detail, "an armed strategy sees its setup on the other side (zone_pullback)");
  assert.deepEqual(decideRow(armed, "two_sided").veto_softened, { rule: "A7", old_detail: "an armed strategy sees its setup on the other side (zone_pullback)" });
  const both = { ...armed, arm: ["zone_pullback", "sweep_reversal"] };
  assert.equal(decideRow(both).overruled.failed[0].detail, "an armed strategy sees its setup on the other side (zone_pullback, sweep_reversal)");
  assert.equal(decideRow(both, "two_sided").overruled.failed[0].detail, "an armed strategy sees its setup on the other side (sweep_reversal)");
  // A softened lean whose trade a later check refuses (here: no armed agent on the sell side) is not tagged.
  const held = { ...one, arm: ["range_fade"] };
  const h = decideRow(held, "two_sided");
  assert.deepEqual([h.stance, h.overruled.by, "veto_softened" in h], ["WAIT", "strategy_arm", false]);
  // Every other guardrail still applies to a softened pass: a side the guardrails refuse stays WAIT, untagged.
  const g = guardsFrom(one, { rule: "two_sided" });
  g.short.allowed = false; g.short.checks = [{ id: "room", pass: false, detail: "price is squeezed" }];
  const r = decide({ answer: ANSWER_SELL, guards: g, quorum: quorumFrom(one) });
  assert.deepEqual([r.stance, r.overruled.by, "veto_softened" in r], ["WAIT", "guardrail", false]);
});

// The revert's tables: a tagged (or plain) Omega entry and its ledger row.
function revertEnv(over = {}) {
  const DB = d1();
  DB.raw.exec(`CREATE TABLE omega_intents (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, created_ms INTEGER, updated_ms INTEGER);
    CREATE TABLE signal_ledger (candle_key TEXT, omega_status TEXT, r_omega REAL, veto_softened TEXT);
    CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT);
    CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, decision_json TEXT);`);
  return { DB, SIGNAL_CACHE: kv(), AGENT_VETO_RULE: "two_sided", ...over };
}
let seq = 0;
function trade(env, { at, r, tagged = true, status = "closed", kind = "open", rule = "A6" }) {
  const issued = 1_790_000_000_000 + (seq += 1) * 900_000;
  const tag = tagged ? { rule, old_detail: "the strategy agents lean against the decision (+22)" } : null;
  env.DB.raw.prepare("INSERT INTO omega_intents VALUES (?, ?, ?, 'done', ?, ?)").run(`${kind}:${issued}:S`, kind, JSON.stringify({ signal_issued_ms: issued, ...(tag ? { veto_softened: tag } : {}) }), at, at);
  env.DB.raw.prepare("INSERT INTO signal_ledger VALUES (?, ?, ?, ?)").run(`OANDA:XAUUSD:15:${issued}`, status, r, tag ? JSON.stringify(tag) : null);
}
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-25T12:00:00Z");

test("AV5 the revert: fewer than 15 closed stays; 15 with a mean at or above 0R stays; plain and open trades never count", async () => {
  const env = revertEnv();
  for (let i = 0; i < 14; i += 1) trade(env, { at: T0 - i * 3_600_000, r: -1 });
  trade(env, { at: T0, r: -1, tagged: false });
  trade(env, { at: T0, r: -1, status: "open" });
  const r1 = await runAgentVetoRevert(env, { now: T0 });
  assert.deepEqual([r1.status, r1.n, r1.revert], ["kept", 14, false]);
  assert.equal((await resolveAgentVetoRule(env, { now: T0 })).rule, "two_sided");
  assert.equal((await runAgentVetoRevert(env, { now: T0 + 3_600_000 })).status, "fresh", "once a UTC day");
  // The 15th closed one: the latest 15 average exactly 0R (14 x -1 and one +14): kept.
  trade(env, { at: T0 + DAY - 60_000, r: 14, kind: "place_limit" });
  const r2 = await runAgentVetoRevert(env, { now: T0 + DAY });
  assert.deepEqual([r2.status, r2.n, r2.mean_r], ["kept", 15, 0]);
  assert.deepEqual(revertVerdict([-0.1, ...Array(14).fill(0)]), { n: 15, mean_r: -0.007, ready: true, revert: true });
  assert.equal(AGENT_VETO_REVERT.min_trades, 15);
});

test("AV6 15 closed with a mean below 0R: classic for 7 days (one Telegram line, one Omega event), then the env rule, counted afresh", async () => {
  const env = revertEnv();
  for (let i = 0; i < 16; i += 1) trade(env, { at: T0 - i * 3_600_000, r: i === 0 ? 3 : -0.4, rule: i % 2 ? "A6" : "A7" });
  const sent = [];
  const send = async (t) => { sent.push(t); };
  // Only the latest 15 count: +3 and 14 x -0.4 = -2.6 / 15.
  assert.deepEqual((await softenedTrades(env.DB)).length, 16);
  const r = await runAgentVetoRevert(env, { now: T0, send });
  assert.deepEqual([r.status, r.n, r.mean_r], ["reverted", 15, -0.173]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^XAUUSD SYSTEM · Strategy-agent veto back to classic for 7 days: the last 15 trades .* averaged -0\.173R/);
  assert.doesNotMatch(sent[0], /\d{4}\.\d/, "no price");
  const ev = env.DB.raw.prepare("SELECT actor, action, detail FROM omega_events").all();
  assert.deepEqual(ev.map((x) => [x.actor, x.action]), [["agent:veto", "agent_veto_reverted"]]);
  const held = await resolveAgentVetoRule(env, { now: T0 + 6 * DAY });
  assert.deepEqual([held.rule, held.source], ["classic", "auto_revert"]);
  // Held: re-evaluated daily, nothing changes, no new line.
  assert.equal((await runAgentVetoRevert(env, { now: T0 + DAY, send })).status, "held");
  assert.equal(sent.length, 1);
  // After 7 days: the env rule again; the old trades no longer count, so it stays even though they lost.
  const after = T0 + 7 * DAY + 60_000;
  assert.deepEqual([(await resolveAgentVetoRule(env, { now: after })).rule], ["two_sided"]);
  const r2 = await runAgentVetoRevert(env, { now: after, send });
  assert.deepEqual([r2.status, r2.n], ["kept", 0]);
  assert.deepEqual(env.DB.raw.prepare("SELECT action FROM omega_events ORDER BY id").all().map((x) => x.action), ["agent_veto_reverted", "agent_veto_released"]);
  // 15 new losing trades after the hold: reverted again on the next day's check.
  for (let i = 0; i < 15; i += 1) trade(env, { at: after + 3_600_000 + i * 60_000, r: -0.2 });
  const r3 = await runAgentVetoRevert(env, { now: after + DAY, send });
  assert.deepEqual([r3.status, r3.n, r3.mean_r], ["reverted", 15, -0.2]);
  assert.equal(sent.length, 2);
  // Read only: the status names the rule, its source and the counts.
  const st = await agentVetoStatus(env, { now: after + DAY });
  assert.deepEqual([st.rule, st.source, st.env_rule, st.closed, st.mean_r, st.softened.total], ["classic", "auto_revert", "two_sided", 15, -0.2, 31]);
  assert.ok(st.auto_revert.until);
  await setAgentVetoForce(env, { rule: "classic", actor: "owner@test", now: after + DAY });
  const forced = await agentVetoStatus(env, { now: after + DAY });
  assert.deepEqual([forced.source, Object.keys(forced.owner_force)], ["owner", ["rule", "at"]], "the status names no person");
});

test("AV7 the owner's force wins over the revert and the env value; \"auto\" hands it back; env classic without a force does nothing", async () => {
  const env = revertEnv();
  for (let i = 0; i < 15; i += 1) trade(env, { at: T0 - i * 3_600_000, r: -1 });
  const f = await setAgentVetoForce(env, { rule: "two_sided", actor: "owner@test", now: T0 });
  assert.deepEqual([f.ok, f.changed, f.rule, f.source], [true, true, "two_sided", "owner"]);
  const r = await runAgentVetoRevert(env, { now: T0, send: async () => assert.fail("no line under a force") });
  assert.deepEqual([r.status, r.n, r.mean_r], ["owner_force", 15, -1]);
  assert.equal((await resolveAgentVetoRule(env, { now: T0 })).rule, "two_sided");
  // The owner forces classic, then hands it back: the losing trades revert it on the next day's check.
  assert.equal((await setAgentVetoForce(env, { rule: "classic", now: T0 })).rule, "classic");
  const back = await setAgentVetoForce(env, { rule: "auto", now: T0 });
  assert.deepEqual([back.rule, back.source], ["two_sided", "env"]);
  assert.equal((await runAgentVetoRevert(env, { now: T0 + DAY })).status, "reverted");
  // FS1: the force is written to the feature-switch store; its audit row and Telegram line are FS1's POST's
  // (test/feature-switches.test.mjs FS-POST), so setAgentVetoForce itself writes no Omega event.
  assert.deepEqual(env.DB.raw.prepare("SELECT action FROM omega_events ORDER BY id").all().map((x) => x.action), ["agent_veto_reverted"]);
  // A force on top of the revert: the owner's rule is in force at once.
  await setAgentVetoForce(env, { rule: "two_sided", now: T0 + DAY });
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 + DAY + 1 })), ["two_sided", "owner", "two_sided"]);
  assert.equal((await setAgentVetoForce(env, { rule: "off" })).ok, false);
  // Env classic, no force, no revert stored: nothing is read beyond the keys, nothing written.
  const quiet = revertEnv({ AGENT_VETO_RULE: undefined });
  assert.equal((await runAgentVetoRevert(quiet, { now: T0 })).status, "inactive");
  assert.equal(quiet.SIGNAL_CACHE.m.has(AGENT_VETO_AUTO_KEY), false);
  assert.deepEqual(Object.values(await resolveAgentVetoRule(quiet, { now: T0 })), ["classic", "env", "classic"]);
  // An unreadable KV: classic, never the softened rule by accident.
  const broken = { ...env, SIGNAL_CACHE: { get: async () => { throw new Error("kv down"); } } };
  assert.deepEqual(Object.values(await resolveAgentVetoRule(broken, { now: T0 })), ["classic", "unreadable", "two_sided"]);
  // FS1: the single store of the owner's choice is the feature-switch override; SV1b's own key is no longer written.
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).AGENT_VETO_RULE.value, "two_sided");
  assert.equal(env.SIGNAL_CACHE.m.has(AGENT_VETO_OWNER_KEY), false);
});

test("AV8 the trade carries the tag: the entry intent from its decision, the Signal Ledger row from ingestDecision; others unchanged", async () => {
  const env = revertEnv();
  const tag = { rule: "A7", old_detail: "an armed strategy sees its setup on the other side (zone_pullback)" };
  const issued = 1795165200000;
  env.DB.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?)").run(`OANDA:XAUUSD:15:${issued}`, JSON.stringify({ stance: "SELL", veto_softened: tag }));
  env.DB.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?)").run(`OANDA:XAUUSD:15:${issued + 900_000}`, JSON.stringify({ stance: "SELL" }));
  resetVetoTagMemoForTests();
  assert.deepEqual(await vetoSoftenedTag(env.DB, { kind: "open", signal_issued_ms: issued }), tag);
  assert.deepEqual(await vetoSoftenedTag(env.DB, { kind: "place_limit", signal_issued_ms: issued }), tag);
  assert.equal(await vetoSoftenedTag(env.DB, { kind: "open", signal_issued_ms: issued + 900_000 }), null);
  assert.equal(await vetoSoftenedTag(env.DB, { kind: "modify_sl", signal_issued_ms: issued }), null, "only an entry");
  assert.equal(await vetoSoftenedTag({ prepare: () => { throw new Error("down"); } }, { kind: "open", signal_issued_ms: 1 }), null);
  // The bridge sync tags the entry it inserts and leaves every other intent as planned.
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  assert.match(src, /const softened = await vetoSoftenedTag\(db, attempt\);\n\s+const it = softened \? \{ \.\.\.attempt, veto_softened: softened \} : attempt;/);
  // The ledger row.
  resetLedgerSchemaCacheForTests();
  const L = { DB: d1() };
  await ensureLedgerSchema(L.DB);
  const d = (key, over = {}) => ({ decision_key: `OANDA:XAUUSD:15:${key}`, decided_at: new Date(key + 960_000).toISOString(), stance: "SELL", confidence: 0.7, summary: "Decision SELL.", trading_mode: "scalp", trade: { side: "SELL", action: "ENTER_LIMIT", entry: 100, stop: 102, target: "tp1", tp: 97, tp1: 97, tp2: 95 }, ...over });
  assert.equal(await ingestDecision(L, d(issued, { veto_softened: tag }), { now: issued + 960_000 }), 1);
  assert.equal(await ingestDecision(L, d(issued + 900_000, { stance: "BUY", trade: { side: "BUY", action: "ENTER_LIMIT", entry: 100, stop: 98, target: "tp1", tp: 103, tp1: 103, tp2: 105 } }), { now: issued + 1_860_000 }), 1);
  const rows = L.DB.raw.prepare("SELECT candle_key, veto_softened FROM signal_ledger ORDER BY opened_at").all();
  assert.deepEqual(rows.map((x) => x.veto_softened), [JSON.stringify(tag), null]);
});

test("AV9 the wiring: the rule is resolved onto the decision's env copy; the daily check sits beside the grid's; the status route reads it", () => {
  const de = readFileSync(new URL("../src/decision-engine.mjs", import.meta.url), "utf8");
  assert.match(de, /env = \{ \.\.\.env, TRADING_MODE: mode, COUNCIL_KNOBS: knobs, ROOM_CORRIDOR_ATR: room, AGENT_VETO_RULE: vetoRule \};/);
  assert.match(de, /if \(agentVetoRuleOf\(env\) === "two_sided"\) guards\.veto_rule = "two_sided";/);
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(idx, /const grid = await runGridAdapt\(env[^\n]*\n[^\n]*\n(?:\s*\/\/[^\n]*\n)+\s*const veto = await runAgentVetoRevert\(env, \{ send:/);
  assert.match(idx, /veto_rule: veto,/);
  assert.match(idx, /async setAgentVetoRule\(input[^\n]*\n\s*if \(ownerCheck\(this\.env, input\?\.actor_sub \?\? null\) !== "owner"\)/);
  const omega = readFileSync(new URL("../workers/xauusd-omega/src/omega.mjs", import.meta.url), "utf8");
  assert.match(omega, /if \(route === "POST \/api\/strategy-council"\) \{\n(?:\s*\/\/[^\n]*\n)+\s*if \(typeof r\.body\.veto_rule === "string"\)/);
  // The wrangler crons are unchanged by SV1b (no new cron).
  const w = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(w, /agent-veto[^\n]*cron/i);
});
