// B18 (Track B PR 18, owner 2026-11-22: "tidak perlu shadow, langsung integrasikan ... key level, position dan lainnya"):
// lens B's members as management candidates. The Key Level Agent's family broker_liquidity names the zones a lens B member
// would promote (key_levels.management), under rule 3's gates only; they feed only the room_liquidity guard, Omega's
// management mode (the signal's management_levels) and the Nexus view; never the zones, the candidates, plans, entries,
// the squeeze guard's own inputs or public output. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as oe from "../src/omega-engine.mjs";
import * as pp from "../src/public-projection.mjs";
import { withBrokerLiquidity, buildKeyLevels, keyLevelFamiliesModes, keyLevelFamiliesOffMode, BROKER_LIQUIDITY_WEIGHT, CANDIDATE_MIN_SCORE } from "../src/key-level-agent.mjs";
import { LIQUIDITY_STATE_KEY, levelsOnFeed } from "../src/liquidity-lens.mjs";
import { resetLensStateMemoForTests } from "../src/lens-policy.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import { compareRooms, loadRoomDecisions } from "../src/room-tuning.mjs";
import { datasetFeatures } from "../src/model-dataset.mjs";
import { EXTENDED_WITNESS_WEIGHTS } from "../src/decision-engine.mjs";
import { ENGINE_CODE, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { zoneInputs, zoneGlobal, NOW, ZONE_ENV, CLOSE } from "./support/zone-types-fixture.mjs";

const M1 = 60_000, M15 = 15 * M1;
const INPUTS = Object.freeze({ ...zoneInputs(), modes: { orbLevels: "off" } });
// Lens B on the feed's scale: a node 0.5 inside the tolerance of the support zone 3985-3986.5 (2 families, score 7.4) and
// a pool over the resistance 4013.42-4013.47 (2 families, score 2.25); both promote with the family (3 families, >= 3).
const MEMBERS = Object.freeze([{ low: 3986, high: 3986.2, kind: "hvn" }, { low: 4013.6, high: 4014, kind: "pool" }]);
const withLens = (levels = MEMBERS, over = {}) => ({ ...INPUTS, brokerLiquidity: { levels, at_ms: NOW }, ...over });
const loadedOf = (inputs, strategy = se.buildStrategy(inputs)) => ({ inputs, strategy, global: zoneGlobal(), correlations: null, regime: "normal-trending" });
const KEY = `OANDA:XAUUSD:15:${Date.parse(CLOSE) - M15}`;
const run = (inputs, { strategy, env = ZONE_ENV } = {}) => {
  const loaded = loadedOf(inputs, strategy);
  const assessment = de.assess(loaded, { now: NOW, env });
  const record = de.buildDecisionRecord({ key: KEY, barClose: CLOSE, loaded, assessment, council: null, now: NOW, env });
  return { strategy: loaded.strategy, assessment, record, signal: ea.eaSignalFromDecision({ decision: record, now: NOW }), management: ea.managementFields(record) };
};
const withoutMgmt = (s) => { const { management: _m, ...kl } = s.key_levels; return { ...s, key_levels: kl }; };
const stripCheck = (guards) => Object.fromEntries(Object.entries(guards).map(([k, g]) => [k, g && typeof g === "object" ? { ...g, checks: (g.checks ?? []).filter((c) => c.id !== "room_liquidity") } : g]));
/** A strategy with an injected management candidate (the guard's unit cases). */
const injected = (mgmt, zonesExtra = []) => { const s = se.buildStrategy(INPUTS); return { ...s, key_levels: { ...s.key_levels, zones: [...s.key_levels.zones, ...zonesExtra], management: mgmt } }; };
const RES = (low, high) => ({ low, high, price: (low + high) / 2, role: "resistance", score: 3.25, families: ["a", "b", "broker_liquidity"], kinds: ["pool"], candidate_by: "broker_liquidity" });

test("KL18-1 withBrokerLiquidity: one zone per side a member would promote (the candidate rule with the family at weight 1); candidates, capped zones and far members never; the zones untouched", () => {
  const s = se.buildStrategy(INPUTS);
  const zones = s.key_levels.zones, tol = s.key_levels.tolerance;
  const before = JSON.stringify(zones);
  const m = withBrokerLiquidity(zones, { levels: MEMBERS }, { price: s.price, tolerance: tol });
  assert.deepEqual(m.map((z) => [z.role, z.low, z.high, z.candidate_by, z.kinds]), [["support", 3985, 3986.5, "broker_liquidity", ["hvn"]], ["resistance", 4013.42, 4013.47, "broker_liquidity", ["pool"]]]);
  assert.equal(m[0].score, 7.4 + BROKER_LIQUIDITY_WEIGHT);
  assert.ok(m.every((z) => z.families.includes("broker_liquidity") && z.score >= CANDIDATE_MIN_SCORE));
  assert.equal(JSON.stringify(zones), before, "the zones are not touched");
  // A candidate (3995.5-3998), a capped one (3992.5-3995, qualified) and a lone weak zone (4010.42, 2 families, 1.5) never.
  for (const lv of [[{ low: 3996, high: 3996.5, kind: "pool" }], [{ low: 3993, high: 3993.4, kind: "pool" }], [{ low: 4010.4, high: 4010.5, kind: "pool" }]]) {
    assert.deepEqual(withBrokerLiquidity(zones, { levels: lv }, { price: s.price, tolerance: tol }), [], JSON.stringify(lv));
  }
  // Beyond the tolerance (the zone and the member together wider than 2.86): no promotion.
  assert.deepEqual(withBrokerLiquidity(zones, { levels: [{ low: 4016.4, high: 4016.5, kind: "pool" }] }, { price: s.price, tolerance: tol }), []);
  // Two eligible supports (3985-3986.5 at 7.4, 3989 at 3): the strongest one only.
  assert.deepEqual(withBrokerLiquidity(zones, { levels: [{ low: 3986, high: 3986.2, kind: "hvn" }, { low: 3989.2, high: 3989.3, kind: "sweep" }] }, { price: s.price, tolerance: tol }).map((z) => z.low), [3985]);
  assert.deepEqual(withBrokerLiquidity(zones, null, { price: s.price, tolerance: tol }), []);
});

test("KL18-2 buildKeyLevels and buildStrategy: management only with lens B given and the family on; every other field deep-equal; KEY_LEVEL_FAMILIES_OFF reaches it via modes only", () => {
  const plain = se.buildStrategy(INPUTS), lens = se.buildStrategy(withLens());
  assert.equal("management" in plain.key_levels, false);
  assert.equal(lens.key_levels.management.length, 2);
  assert.deepEqual(withoutMgmt(lens), plain, "zones, candidates, summary, plans, squeeze inputs: today's");
  // The switch through modes (never env): off leaves no management; env alone changes nothing (rule 5).
  assert.deepEqual(keyLevelFamiliesModes({ KEY_LEVEL_FAMILIES_OFF: "broker_liquidity, bogus" }), { keyLevelFamiliesOff: ["broker_liquidity"] });
  assert.deepEqual(keyLevelFamiliesModes({}), {});
  assert.deepEqual(keyLevelFamiliesOffMode({ KEY_LEVEL_FAMILIES_OFF: "" }), []);
  const off = se.buildStrategy(withLens(MEMBERS, { modes: { orbLevels: "off", keyLevelFamiliesOff: ["broker_liquidity"] } }));
  assert.deepEqual(off, plain);
  assert.deepEqual(se.buildStrategy({ ...withLens(), env: { KEY_LEVEL_FAMILIES_OFF: "broker_liquidity" } }).key_levels.management.length, 2, "env does not reach the pure build");
  // The Key Level Agent alone: a member list without levels adds nothing.
  assert.equal("management" in buildKeyLevels({ price: 4000, atrH1: 10, brokerLiquidity: { levels: [] } }), false);
  // The capture keeps the switch (and never a lens B input).
  const slim = slimInputs({ ...withLens(), modes: { orbLevels: "off", keyLevelFamiliesOff: ["broker_liquidity"] } });
  assert.deepEqual(slim.modes.keyLevelFamiliesOff, ["broker_liquidity"]);
  assert.equal("brokerLiquidity" in slim, false);
});

test("KL18-3 rule 3's gates (brokerLiquidityInputs): on, above the floor, fresh and a known basis give the members; the switch off, a stale state or no basis give none; loadStrategyInputs with the family off reads none", async () => {
  const kvOf = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; };
  const dbOf = (settings = null) => ({ prepare: () => ({ first: async () => (settings ? { settings: JSON.stringify(settings) } : null), bind() { return this; }, all: async () => ({ results: [] }), run: async () => ({}) }) });
  const state = (over = {}) => ({ at_ms: NOW - 2 * M1, facts: { available: true }, baseline: "sufficient", levels: [{ low: 4013.9, high: 4014.3, kind: "pool" }], levels_feed: [{ low: 4013.6, high: 4014, kind: "pool" }], feed_basis: 0.3, feed_basis_known: true, ...over });
  const envOf = async (st, settings = null) => { resetLensStateMemoForTests(); const kv = kvOf(); await kv.put(LIQUIDITY_STATE_KEY, JSON.stringify(st)); return { SIGNAL_CACHE: kv, DB: dbOf(settings), TRADING_MODE: "intraday" }; };
  assert.deepEqual(await se.brokerLiquidityInputs(await envOf(state()), { now: NOW }), { levels: [{ low: 4013.6, high: 4014, kind: "pool" }], at_ms: NOW - 2 * M1 });
  assert.equal(await se.brokerLiquidityInputs(await envOf(state({ feed_basis_known: false, feed_basis: null, levels_feed: [] })), { now: NOW }), null, "no known basis");
  assert.equal(await se.brokerLiquidityInputs(await envOf(state({ at_ms: NOW - 60 * M1 })), { now: NOW }), null, "a stale state");
  assert.equal(await se.brokerLiquidityInputs(await envOf(state({ facts: { available: false } })), { now: NOW }), null, "no facts");
  assert.equal(await se.brokerLiquidityInputs(await envOf(state(), { liquidity_enabled: false }), { now: NOW }), null, "the owner's switch off");
  // levelsOnFeed: broker − basis, in cents; none without a basis.
  assert.deepEqual(levelsOnFeed([{ low: 4013.9, high: 4014.3, kind: "pool" }], 0.3), [{ low: 4013.6, high: 4014, kind: "pool" }]);
  assert.deepEqual(levelsOnFeed([{ low: 1, high: 2, kind: "pool" }], null), []);
  // loadStrategyInputs: KEY_LEVEL_FAMILIES_OFF names the family: no lens B input, the switch in modes.
  const env = await envOf(state());
  const loaded = await se.loadStrategyInputs({ ...env, KEY_LEVEL_FAMILIES_OFF: "broker_liquidity" }, { now: NOW });
  assert.equal("brokerLiquidity" in loaded, false);
  assert.deepEqual(loaded.modes.keyLevelFamiliesOff, ["broker_liquidity"]);
  const on = await se.loadStrategyInputs(await envOf(state()), { now: NOW });
  assert.deepEqual(on.brokerLiquidity?.levels, [{ low: 4013.6, high: 4014, kind: "pool" }]);
  assert.equal("keyLevelFamiliesOff" in on.modes, false);
});

test("KL18-4 room_liquidity: fails only when lens B makes the squeeze; never repeats room; the RM1b waiver never lifts it; only ever adds a WAIT; ATR-only detail", () => {
  const guard = (strategy, env = ZONE_ENV) => de.assess(loadedOf(INPUTS, strategy), { now: NOW, env }).guards.long;
  const ids = (g) => g.checks.map((c) => c.id);
  const base = guard(se.buildStrategy(INPUTS));
  assert.equal(ids(base).includes("room_liquidity"), false, "no management, no check");
  // Lens B's resistance 4006-4007 narrows the corridor 3998..4016.92 to 0.84 x the 1H range: lens B squeezes.
  const lensSq = guard(injected([RES(4006, 4007)]));
  const rl = lensSq.checks.find((c) => c.id === "room_liquidity");
  assert.equal(rl.pass, false);
  assert.equal(lensSq.checks.find((c) => c.id === "room").pass, true, "the room check is today's");
  assert.equal(lensSq.allowed, false);
  assert.equal(base.allowed, true);
  assert.doesNotMatch(rl.detail, /\d{3,5}/, "ATR only, no price");
  // Already squeezed without lens B (a candidate at 4005-4006): room fails, room_liquidity passes (never double-counted).
  const extra = { low: 4005, high: 4006, price: 4005.5, score: 6, sources: 3, families: ["x", "y", "z"], candidate: true, strength: "strong", role: "resistance", label: "x", members: [] };
  const both = guard(injected([RES(4004.5, 4004.6)], [extra]));
  assert.deepEqual([both.checks.find((c) => c.id === "room").pass, both.checks.find((c) => c.id === "room_liquidity").pass], [false, true]);
  // Far management: passes. SQUEEZE_GUARD off: no check at all.
  assert.equal(guard(injected([RES(4030, 4031)])).checks.find((c) => c.id === "room_liquidity").pass, true);
  assert.equal(ids(guard(injected([RES(4006, 4007)]), { ...ZONE_ENV, SQUEEZE_GUARD: "off" })).includes("room_liquidity"), false);
  // The waiver's switch on changes nothing for it (it is computed without the waiver).
  assert.equal(guard(injected([RES(4006, 4007)]), { ...ZONE_ENV, ROOM_BREAKOUT_WAIVE: "on" }).checks.find((c) => c.id === "room_liquidity").pass, false);
  // Both ways: over a grid of management candidates and corridors, lens B never turns a blocked side allowed.
  for (const lo of [4001.5, 4004, 4006, 4009, 4012, 4015, 4020]) for (const atr of ["0.5", "1", "1.5"]) {
    const env = { ...ZONE_ENV, ROOM_CORRIDOR_ATR: atr };
    const w = guard(se.buildStrategy(INPUTS), env), l = guard(injected([RES(lo, lo + 0.5)]), env);
    if (!w.allowed) assert.equal(l.allowed, false, `${lo}/${atr}: a WAIT stays a WAIT`);
    assert.deepEqual(l.checks.filter((c) => c.id !== "room_liquidity"), w.checks, `${lo}/${atr}: every other check is today's`);
    assert.deepEqual(l.plan, w.plan, `${lo}/${atr}: the plan is today's`);
  }
});

test("KL18-5 the record and the signal: management_levels only with management; gates off byte for byte (managementFields has no management_levels key)", () => {
  const plain = run(INPUTS), lens = run(withLens());
  assert.equal("management_levels" in plain.record, false);
  assert.equal("management_levels" in plain.management, false);
  assert.deepEqual(lens.record.management_levels, [{ low: 3985, high: 3986.5 }, { low: 4013.42, high: 4013.47 }]);
  assert.equal(lens.management.management_levels, "3985:3986.5,4013.42:4013.47");
  const { management_levels: _ml, ...rest } = lens.management;
  assert.equal(JSON.stringify(rest), JSON.stringify(plain.management), "every other signal field is today's");
  // The record apart from management_levels and the passing room_liquidity check: today's.
  const { management_levels: _r, ...recRest } = lens.record;
  assert.deepEqual({ ...recRest, guardrails: stripCheck(recRest.guardrails) }, { ...plain.record, guardrails: plain.record.guardrails });
  assert.deepEqual(lens.signal, { ...plain.signal, ...(lens.signal.management_levels ? { management_levels: lens.signal.management_levels } : {}) });
  // Gates off (no lens B input, or the family off): byte for byte.
  const off = run({ ...withLens(), modes: { orbLevels: "off", keyLevelFamiliesOff: ["broker_liquidity"] } });
  assert.equal(JSON.stringify(off.record), JSON.stringify(plain.record));
  assert.equal(JSON.stringify(off.management), JSON.stringify(plain.management));
});

test("KL18-6 200 fixtures (seeded): zones, candidates, plans, the squeeze, the room check and every other check are today's with lens B; only management, management_levels and room_liquidity differ", () => {
  let seed = 18;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const kinds = ["sweep", "pool", "hvn"];
  let withMgmt = 0, blocked = 0;
  const base = run(INPUTS);
  for (let i = 0; i < 200; i += 1) {
    const levels = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => { const lo = Math.round((3975 + rnd() * 50) * 100) / 100; return { low: lo, high: Math.round((lo + rnd() * 0.8) * 100) / 100, kind: kinds[Math.floor(rnd() * 3)] }; });
    const l = run(withLens(levels));
    assert.deepEqual(withoutMgmt(l.strategy), base.strategy, `${i}: the strategy`);
    assert.deepEqual(l.record.squeeze, base.record.squeeze, `${i}: decision.squeeze`);
    for (const side of ["long", "short"]) {
      const g = l.assessment.guards[side], b = base.assessment.guards[side];
      assert.deepEqual(g.checks.filter((c) => c.id !== "room_liquidity"), b.checks, `${i} ${side}: the other checks`);
      assert.deepEqual(g.plan, b.plan, `${i} ${side}: the plan`);
      if (g.checks.some((c) => c.id === "room_liquidity" && !c.pass)) blocked += 1;
      if (!b.allowed) assert.equal(g.allowed, false, `${i} ${side}: never removes a WAIT`);
    }
    if (l.strategy.key_levels.management) withMgmt += 1;
    if (l.record.stance === base.record.stance) {
      const { management_levels: _m, ...sig } = l.signal;
      assert.deepEqual(sig, base.signal, `${i}: the signal apart from management_levels`);
    } else assert.equal(l.record.stance, "WAIT", `${i}: only room_liquidity can change the stance, to WAIT`);
  }
  assert.ok(withMgmt > 0, "some fixtures promote a zone");
  assert.ok(blocked >= 0);
});

test("KL18-7 room-tuning: a lens-B-blocked decision keeps fidelity 1.0 and withRoom leaves room_liquidity as recorded (failed)", async () => {
  const blocked = run(INPUTS, { strategy: injected([RES(4006, 4007)]) });
  assert.equal(blocked.record.stance, "WAIT");
  assert.equal(blocked.record.guardrails.long.checks.find((c) => c.id === "room_liquidity").pass, false);
  const raw = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({ bind: (...a) => wrap(sql, a), run: async () => { raw.prepare(sql).run(...params); return { meta: {} }; }, first: async () => raw.prepare(sql).get(...params) ?? null, all: async () => ({ results: raw.prepare(sql).all(...params) }) });
  const db = { prepare: (sql) => wrap(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), exec: async (sql) => raw.exec(sql) };
  de.resetDecisionSchemaCacheForTests?.();
  await de.ensureDecisionSchema(db);
  raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(KEY, CLOSE, new Date(NOW).toISOString(), blocked.record.stance, 0, "engine", JSON.stringify(blocked.record));
  const decisions = await loadRoomDecisions(db, "2026-11-01T00:00:00Z");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].checks.long.find((c) => c.id === "room_liquidity")?.pass, false);
  const replay = compareRooms({ decisions, outcome: () => "hit", weights: EXTENDED_WITNESS_WEIGHTS, now: NOW + 3_600_000 });
  const mode = Object.values(replay.modes).find((m) => m.decisions === 1);
  assert.deepEqual(mode.fidelity, { checks: 1, matched: 1, share: 1 });
  assert.equal(mode.entries_taken, 0, "room_liquidity stays failed under every room arm: the WAIT stands");
});

test("KL18-8 [E4] public output: a lens-B-only block is a WAIT; the recap equals the same record without the check, with no reason or level leak", () => {
  const blocked = run(INPUTS, { strategy: injected([RES(4006, 4007)]) });
  const row = (rec) => ({ decision_key: KEY, bar_close: CLOSE, stance: rec.stance, bias: rec.bias, decision_json: JSON.stringify(rec) });
  const recap = pp.publicRecap(row(blocked.record));
  const stripped = pp.publicRecap(row({ ...blocked.record, guardrails: stripCheck(blocked.record.guardrails) }));
  assert.deepEqual(recap, stripped);
  assert.equal(recap.stance, "WAIT");
  assert.equal(recap.held_back.long.includes("room_liquidity"), false);
  assert.deepEqual(pp.recapLeaks(recap), []);
  assert.doesNotMatch(JSON.stringify(recap), /lens B|liquidity/i);
});

test("KL18-9 Omega's management mode reads management_levels (feed + basis, source liquidity, kind zone); without spread, the lens off or no basis: B17's set", () => {
  const signal = { feed_basis: 0.3, feed_basis_known: true, key_levels: "3995.5:3998", liquidity_on: true, liquidity_levels: "4013.7:4013.8:pool", liquidity_spread_median: 20, management_levels: "4013.42:4013.47" };
  const m = oe.brokerKeyLevels(signal, { spread: 0.2 });
  const c2 = (v) => Math.round(v * 100) / 100;
  assert.deepEqual(m.map((z) => [c2(z.low), c2(z.high), z.source ?? "key_level", z.kind ?? null]), [[3995.8, 3998.3, "key_level", null], [4013.72, 4013.77, "liquidity", "zone"]], "lens B's own pool merges into the management zone (within two spreads)");
  assert.deepEqual(oe.brokerKeyLevels(signal), oe.brokerKeyLevels({ ...signal, management_levels: undefined }), "without spread (the limit council, the views): unchanged");
  assert.deepEqual(oe.brokerKeyLevels({ ...signal, liquidity_on: false }, { spread: 0.2 }).map((z) => [c2(z.low), c2(z.high), z.source ?? null]), [[3995.8, 3998.3, null]]);
  assert.equal(oe.brokerKeyLevels({ ...signal, feed_basis_known: false }, { spread: 0.2 }), null);
  // Typed: the management zone carries type "none".
  const typed = oe.brokerKeyLevels({ ...signal, key_level_types: "demand/strong/fresh" }, { typed: true, spread: 0.2 });
  const tz = typed.find((z) => z.kind === "zone");
  assert.deepEqual({ ...tz, low: c2(tz.low), high: c2(tz.high) }, { low: 4013.72, high: 4013.77, source: "liquidity", kind: "zone", type: "none", strength: null, freshness: null });
});

test("KL18-10 the model's features leave room_liquidity out; the council sees its ATR-only words; the hashes (V14 holds, the code hash moves with brokerKeyLevels and managementFields)", async () => {
  const blocked = run(INPUTS, { strategy: injected([RES(4006, 4007)]) });
  const f = datasetFeatures({ bar_close: CLOSE, witnesses: blocked.record.witnesses, quorum: blocked.record.quorum, guardrails: blocked.record.guardrails, structure: null, context: null, trading_mode: "intraday" }, { atr: 9.53, bars: {} });
  assert.equal(Object.keys(f).some((k) => /room_liquidity/.test(k)), false);
  const plainF = datasetFeatures({ bar_close: CLOSE, witnesses: blocked.record.witnesses, quorum: blocked.record.quorum, guardrails: stripCheck(blocked.record.guardrails), structure: null, context: null, trading_mode: "intraday" }, { atr: 9.53, bars: {} });
  assert.deepEqual(f, plainF);
  const evidence = de.councilEvidence({ barClose: CLOSE, cards: blocked.assessment.cards, quorum: blocked.assessment.quorum, guards: blocked.assessment.guards });
  const text = JSON.stringify(evidence);
  assert.match(text, /room_liquidity/);
  assert.doesNotMatch(text.match(/lens B's liquidity[^"]*/)?.[0] ?? "", /\d{3,5}/);
  assert.equal(createHash("sha256").update(engineBehaviourSource()).digest("hex"), ENGINE_BEHAVIOUR_HASH);
  assert.equal(ENGINE_BEHAVIOUR_HASH, "d0c07f020f44f9694b794aafa73684488aaf55848fdabdf0fa9a67804b916e65");
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.notEqual(ENGINE_CODE_HASH, "9766e73248bbda79d81d45cb3770e9048181462ffffa32109b5ed02d720649e0", "B18 moved it (brokerKeyLevels, managementFields)");
  assert.ok(ENGINE_CODE["ea-signal"][1].includes("managementFields"));
});
