// B17 (Track B PR 17, owner 2026-11-22: "tidak perlu shadow, langsung integrasikan ... position dan lainnya"): lens B in
// one management level set. brokerKeyLevels' management mode (`spread` given) adds lens B's levels only with a known feed
// basis and merges one within two spreads of a Key Level zone into it; manageIntents, the ladder's TP2 wait and the
// Position Manager read that set; the Position Council sees lens B only as liquidity_levels (kind, side, distance in 5m
// ATR), never a price. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as oe from "../src/omega-engine.mjs";
import * as pm from "../src/position-manager.mjs";
import { ENGINE_CODE, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { managementScenario, SIGNAL_PLAIN, SIGNAL_SD, SYM, LONG, META, NOW, PM_DECISION } from "./support/zone-sd-fixture.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";

const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
// Lens B on the fixture's broker scale (basis 0): a node 2 above L1, a node 0.2 above L4 (within two spreads: 2 x 0.20),
// a sweep extreme between L4 and L5 and a pool above every zone. The hour's spread median is 20 points (0.20).
const LENS_LEVELS = "3909:3909.5:hvn,3928.2:3928.3:hvn,3931:3931.4:sweep,3950:3950.5:pool";
const LENS = Object.freeze({ liquidity_on: true, liquidity_weight: 0.3, liquidity_spread_median: 20, liquidity_spread_widen: 2, liquidity_levels: LENS_LEVELS });
const SIG = Object.freeze({ ...SIGNAL_PLAIN, ...LENS });
const OI = Object.freeze({ tp: 3926, entry: 3900, sl: 3890, strategy: "trend_pullback", mode: "intraday", r_dist: 10 });
const HOLDING = Object.freeze({ momentum: "holding", thesis: "intact", reason: "r" });
const sync = (signal, bid, { position = LONG, settings = {}, power = 0.3 } = {}) => oe.manageIntents({
  positions: [position], sym: { ...SYM, bid, ask: bid + 0.2 }, settings: { ...oe.OMEGA_DEFAULTS, tp_ladder: false, ...settings }, signal: { ...signal, power }, now: NOW, positionMeta: META
});
const lensOf = (lv) => (lv ?? []).filter((z) => z.source === "liquidity").map((z) => `${z.low}:${z.high}:${z.kind}`);
/** The Position Manager's facts as runPositionManager builds them: the council's levels and the management set beside. */
const pmFacts = (signal, bid, { position = { ...LONG, tp: 3926, sl: 3912 }, ladder = false } = {}) => {
  const sym = { ...SYM, bid, ask: bid + 0.2 };
  const levels = pm.brokerLevels(signal);
  const managementLevels = oe.brokerKeyLevels(signal, { spread: oe.managementSpread(signal, sym) }) ?? [];
  return { levels, f: pm.positionFacts({ position, sym, openIntent: OI, levels, decision: PM_DECISION, ladder, signal, managementLevels }) };
};

test("ML-1 brokerKeyLevels: without `spread` today's set (lens B even without a known basis); the management mode gates lens B on feed_basis_known and merges within two spreads", () => {
  // Today's (no `spread`: the limit council, the views): every lens B level, and lens B alone without a known basis.
  assert.deepEqual(lensOf(oe.brokerKeyLevels(SIG)), LENS_LEVELS.split(","));
  assert.deepEqual(lensOf(oe.brokerKeyLevels({ ...SIG, feed_basis_known: false })), LENS_LEVELS.split(","));
  // The management mode: the node 0.2 above L4 (3926-3928) merges into it; the zone keeps its edges.
  const m = oe.brokerKeyLevels(SIG, { spread: 0.2 });
  assert.deepEqual(lensOf(m), ["3909:3909.5:hvn", "3931:3931.4:sweep", "3950:3950.5:pool"]);
  assert.deepEqual(m.filter((z) => z.source !== "liquidity"), oe.brokerKeyLevels(SIGNAL_PLAIN), "the Key Level zones as they are");
  // Exactly two spreads merges; a hair beyond does not.
  assert.deepEqual(lensOf(oe.brokerKeyLevels({ ...SIG, liquidity_levels: "3928.4:3928.5:pool" }, { spread: 0.2 })), []);
  assert.deepEqual(lensOf(oe.brokerKeyLevels({ ...SIG, liquidity_levels: "3928.41:3928.5:pool" }, { spread: 0.2 })), ["3928.41:3928.5:pool"]);
  // A level inside a zone merges too; an unknown spread (null) merges nothing.
  assert.deepEqual(lensOf(oe.brokerKeyLevels({ ...SIG, liquidity_levels: "3926.5:3927:hvn" }, { spread: 0.2 })), []);
  assert.deepEqual(lensOf(oe.brokerKeyLevels(SIG, { spread: null })), LENS_LEVELS.split(","));
  // Without a known basis: no lens B (and no Key Level zones either, so no set).
  assert.equal(oe.brokerKeyLevels({ ...SIG, feed_basis_known: false }, { spread: 0.2 }), null);
  assert.equal(oe.brokerKeyLevels({ ...SIG, feed_basis_known: false }, { spread: null }), null);
  // The lens off (liquidity_on false: the switch, the floor or a stale state): the Key Level zones only, either mode.
  assert.deepEqual(oe.brokerKeyLevels({ ...SIG, liquidity_on: false }, { spread: 0.2 }), oe.brokerKeyLevels(SIGNAL_PLAIN));
  // Typed and with the box levels: the same gate and merge; a kept lens level carries type "none".
  const typed = oe.brokerKeyLevels(SIG, { typed: true, spread: 0.2 });
  assert.deepEqual(typed.filter((z) => z.source === "liquidity").map((z) => [z.kind, z.type, z.strength, z.freshness]), [["hvn", "none", null, null], ["sweep", "none", null, null], ["pool", "none", null, null]]);
  // With the box levels (zone_sd on) they are zones too: a lens level merges into a box as into any zone.
  const sdSig = { ...SIGNAL_SD, ...LENS };
  assert.deepEqual(lensOf(oe.brokerKeyLevels(sdSig, { sd: true, spread: 0.2 })), ["3950:3950.5:pool"], "the boxes 3908-3917.4 and 3931-3933 take the node and the sweep");
  assert.deepEqual(lensOf(oe.brokerKeyLevels(sdSig, { spread: 0.2 })), ["3909:3909.5:hvn", "3931:3931.4:sweep", "3950:3950.5:pool"]);
});

test("ML-2 managementSpread: the lens's spread median (points) times the symbol's point; null when either is unknown", () => {
  assert.equal(oe.managementSpread(SIG, SYM), 0.2);
  assert.equal(oe.managementSpread({ ...SIG, liquidity_spread_median: 0 }, SYM), null);
  assert.equal(oe.managementSpread(SIGNAL_PLAIN, SYM), null);
  assert.equal(oe.managementSpread(SIG, { ...SYM, point: undefined }), null);
  assert.equal(oe.managementSpread(null, SYM), null);
});

test("ML-3 rule 3's gates off give the Key Level Agent's levels only: Omega's management and the Position Manager byte for byte as without lens B", () => {
  const MAIN = sha(managementScenario({ oe, pm }, { signal: SIGNAL_PLAIN }));
  // Lens off (liquidity_on false; its other fields as the signal carries them while off).
  const off = { ...SIGNAL_PLAIN, liquidity_on: false, liquidity_weight: 0, liquidity_levels: "", liquidity_spread_median: 20, liquidity_spread_widen: 0 };
  assert.equal(sha(managementScenario({ oe, pm }, { signal: off })), MAIN);
  // Lens on, every lens B level merged into a zone: the management set is the zones only.
  const merged = { ...SIG, liquidity_levels: "3928.2:3928.3:hvn,3906:3906.2:pool" };
  for (const bid of [3912, 3918, 3926, 3933, 3943]) for (const power of [0.3, 0.6]) {
    assert.deepEqual(sync(merged, bid, { power }), sync(SIGNAL_PLAIN, bid, { power }), `${bid}/${power}`);
  }
  // Lens on without a known basis: as the same signal without lens B (no level at all, so no key-level management).
  const unknown = { ...SIG, feed_basis_known: false };
  for (const bid of [3912, 3926, 3943]) assert.deepEqual(sync(unknown, bid, { power: 0.6 }), sync({ ...SIGNAL_PLAIN, feed_basis_known: false }, bid, { power: 0.6 }));
  // The Position Manager without a lens B level in its set: the facts carry no `management`, today's facts and action.
  const plain = pmFacts(SIGNAL_PLAIN, 3927).f;
  const today = pm.positionFacts({ position: { ...LONG, tp: 3926, sl: 3912 }, sym: { ...SYM, bid: 3927, ask: 3927.2 }, openIntent: OI, levels: pm.brokerLevels(SIGNAL_PLAIN), decision: PM_DECISION, ladder: false, signal: SIGNAL_PLAIN });
  assert.deepEqual(plain, today);
  assert.equal("management" in plain, false);
  assert.deepEqual(pmFacts(merged, 3927).f, pmFacts({ ...merged, liquidity_on: false }, 3927).f);
});

test("ML-4 manageIntents and the ladder's TP2 wait read the management set: a stop or target a lens B level set carries level_source \"liquidity\"", () => {
  // The trailing TP: a long near its target 3928 with a strong power; lens B's sweep 3931 is nearer than L5 (3936).
  const tp = (signal) => sync(signal, 3926, { position: { ...LONG, tp: 3928 }, power: 0.6 }).filter((i) => i.kind === "modify_tp");
  assert.deepEqual(tp(SIG), [{ id: "mt:7:393100", kind: "modify_tp", ticket: 7, tp: 3931, reason: "trail_tp_key_level", level_source: "liquidity" }]);
  assert.deepEqual(tp(SIGNAL_PLAIN), [{ id: "mt:7:393600", kind: "modify_tp", ticket: 7, tp: 3936, reason: "trail_tp_key_level" }]);
  // SL+: past lens B's node 3909 (the last passed level), the stop steps behind it.
  const sl = (signal) => sync(signal, 3912).find((i) => i.kind === "modify_sl");
  assert.deepEqual(sl(SIG), { id: "ms:7:k:390860", kind: "modify_sl", ticket: 7, sl: 3908.6, tp: 3945, reason: "sl_key_level_normal", level_source: "liquidity" });
  assert.deepEqual(sl(SIGNAL_PLAIN), { id: "ms:7:k:390460", kind: "modify_sl", ticket: 7, sl: 3904.6, tp: 3945, reason: "sl_key_level_normal" });
  // A move the zones alone would make the same carries no level_source (3926, strong power: SL+ behind L3 either way).
  assert.deepEqual(sync(SIG, 3926, { position: { ...LONG, tp: 3928 }, power: 0.6 }).find((i) => i.kind === "modify_sl"), sync(SIGNAL_PLAIN, 3926, { position: { ...LONG, tp: 3928 }, power: 0.6 }).find((i) => i.kind === "modify_sl"));
  // The merged node (3928.2) is not in the set: a stop never steps behind it alone.
  const noMerged = (signal) => sync(signal, 3929.5, { power: 0.3 }).find((i) => i.kind === "modify_sl");
  assert.deepEqual(noMerged({ ...SIG, liquidity_levels: "3928.2:3928.3:hvn" }), noMerged(SIGNAL_PLAIN));
  // The ladder's TP2 wait (planIntents, Amendment 4) reads the same set: a long from 3900 with its stop at 3902 and the
  // Position Manager's TP2 out to 3936. Lens B's pool 3901-3901.2 is the first rung, so the stop locks it and TP2 goes;
  // merged into L1 (3904.8, within two spreads) or without a known basis it is no rung, and TP2 waits as without lens B.
  const wait = (signal) => {
    const executor = { connected: true, received_ms: NOW - 1000, positions: [{ ...LONG, sl: 3902, tp: 3928 }], account: { trade_mode: "demo" }, symbol: { ...SYM, bid: 3920, ask: 3920.2 } };
    const plan = oe.planIntents({ executor, now: NOW, engineEnabled: true, signal, settings: { enabled: true, tp_ladder: true }, pmActions: [{ id: `pm:7:${Math.floor(NOW / 300_000)}`, ticket: 7, action: "tp", rule: "tp2_target", tp: 3936 }], gates: { 7: { open: true, mfe_r: 2, mfe_atr: 2 } } });
    return plan.pm_dropped.length ? "held" : plan.intents.some((i) => i.kind === "modify_tp" && String(i.id).startsWith("pm:")) ? "sent" : "none";
  };
  assert.equal(wait(SIGNAL_PLAIN), "held");
  assert.equal(wait({ ...SIG, liquidity_levels: "3901:3901.2:pool" }), "sent");
  assert.equal(wait({ ...SIG, liquidity_levels: "3904.8:3904.9:pool" }), "held", "merged into L1");
  assert.equal(wait({ ...SIG, liquidity_levels: "3901:3901.2:pool", feed_basis_known: false }), wait({ ...SIGNAL_PLAIN, feed_basis_known: false }), "no known basis: as without lens B");
  assert.ok(ENGINE_CODE["omega-engine"][1].includes("managementSpread"));
});

test("ML-5 the Position Manager: TP2, the ladder's hold and the loosening read the management set; PM_LINES_OFF=liquidity reads it absent; the cause is liquidity@1", () => {
  const { f } = pmFacts(SIG, 3927);
  assert.deepEqual(f.management, { tp2: 3931, tp2_source: "liquidity", ladder_hold: false, liquidity: [{ kind: "hvn", low: 3909, high: 3909.5 }, { kind: "sweep", low: 3931, high: 3931.4 }, { kind: "pool", low: 3950, high: 3950.5 }] });
  assert.equal(f.tp2, 3936, "the council-visible TP2 stays on the Key Level zones");
  const a = pm.positionAction(f, HOLDING);
  assert.deepEqual([a.action, a.rule, a.tp], ["tp", "tp2_target", 3931]);
  const off = pm.positionAction(f, HOLDING, { off: ["liquidity"] });
  assert.deepEqual([off.action, off.rule, off.tp], ["tp", "tp2_target", 3936]);
  assert.deepEqual(pm.positionAction(f, HOLDING, { off: ["liquidity"] }), pm.positionAction(pmFacts(SIGNAL_PLAIN, 3927).f, HOLDING));
  const lines = pm.pmLinesJson(f, HOLDING, a);
  assert.equal(lines.cause, "liquidity@1");
  assert.ok(lines.present.includes("liquidity@1"));
  assert.equal(pm.pmLinesJson(f, HOLDING, off, { off: ["liquidity"] }).cause, "tp2_target@1");
  // An action lens B does not change keeps its own rule as the cause.
  const lock = pmFacts(SIG, 3934).f;
  assert.equal(pm.pmLinesJson(lock, HOLDING, pm.positionAction(lock, HOLDING)).cause, "lock_tp1@1");
  // The ladder's hold: a lens B level between TP1 and the zones is a rung the TP1 lock reads.
  const lad = pmFacts(SIG, 3927, { ladder: true }).f, ladPlain = pmFacts(SIGNAL_PLAIN, 3927, { ladder: true }).f;
  assert.equal(lad.ladder_hold, ladPlain.ladder_hold, "the council-visible hold is today's");
  assert.equal(typeof lad.management.ladder_hold, "boolean");
  // The bounded loosening (A8) reads the management set's levels (without the box levels).
  const loosenIn = { loosened: false, from_sl: null, unreadable: false, delegated: false, release: null };
  const withLoosen = pm.positionFacts({ position: { ...LONG, tp: 3926, sl: 3912 }, sym: { ...SYM, bid: 3927, ask: 3927.2 }, openIntent: OI, levels: pm.brokerLevels(SIG), decision: PM_DECISION, signal: SIG, loosen: loosenIn, managementLevels: oe.brokerKeyLevels(SIG, { spread: 0.2 }) });
  assert.deepEqual(withLoosen.loosen.levels, pm.brokerLevels(SIG), "the facts' own loosening levels are today's");
  assert.deepEqual(lensOf(withLoosen.management.loosen_levels), ["3909:3909.5:hvn", "3931:3931.4:sweep", "3950:3950.5:pool"]);
});

test("ML-6 [E5] the Position Council: with the same signal and the lens on, the messages equal today's except liquidity_levels (kind, side, distance in 5m ATR, never a price); with rule 3's gates off byte for byte", () => {
  for (const bid of [3918, 3927, 3934]) {
    const { f, levels } = pmFacts(SIG, bid);
    const msgs = pm.positionCouncilMessages(f, { m5: SIG, levels });
    // Today's messages for the same signal (no management set): positionFacts without managementLevels.
    const today = pm.positionCouncilMessages(pm.positionFacts({ position: { ...LONG, tp: 3926, sl: 3912 }, sym: { ...SYM, bid, ask: bid + 0.2 }, openIntent: OI, levels, decision: PM_DECISION, ladder: false, signal: SIG }), { m5: SIG, levels });
    assert.equal(msgs[0].content, `${today[0].content}${pm.LIQUIDITY_LEVELS_SYSTEM}`);
    const ev = JSON.parse(msgs[1].content), was = JSON.parse(today[1].content);
    const { liquidity_levels: lv, ...rest } = ev;
    assert.deepEqual(rest, was, `${bid}: the position block, key_levels and every other field are today's`);
    assert.equal(JSON.stringify(rest), JSON.stringify(was));
    assert.ok(Array.isArray(lv) && lv.length === 3);
    for (const row of lv) {
      assert.deepEqual(Object.keys(row), ["kind", "side", "distance_atr"]);
      assert.ok(["sweep", "pool", "hvn"].includes(row.kind) && ["above", "below", "at"].includes(row.side));
      assert.ok(typeof row.distance_atr === "number" && row.distance_atr < 100, "a distance in ATR, never a price");
    }
    assert.doesNotMatch(JSON.stringify(lv), /39\d\d/, "no lens B price");
    // No lens B price anywhere in the evidence: the lens levels' edges are absent.
    for (const p of ["3909", "3931.4", "3950"]) assert.equal(msgs[1].content.includes(p), false, `${bid}: ${p}`);
  }
  // Nearest first, at most COUNCIL_LEVELS_MAX; without an ATR the distance is null.
  const { f } = pmFacts(SIG, 3927);
  assert.deepEqual(pm.councilLiquidityLevels(f, { m5_atr: 3 }), [{ kind: "sweep", side: "above", distance_atr: 1.33 }, { kind: "hvn", side: "below", distance_atr: 5.83 }, { kind: "pool", side: "above", distance_atr: 7.67 }]);
  assert.deepEqual(pm.councilLiquidityLevels(f, null).map((r) => r.distance_atr), [null, null, null]);
  assert.equal(pm.councilLiquidityLevels({ ...f, management: undefined }, { m5_atr: 3 }), null);
  // Rule 3's gates off (the lens off, or no known basis): byte for byte today's messages.
  for (const signal of [{ ...SIG, liquidity_on: false }, { ...SIG, liquidity_levels: "3928.2:3928.3:hvn" }]) {
    const { f: g, levels } = pmFacts(signal, 3927);
    const today = pm.positionFacts({ position: { ...LONG, tp: 3926, sl: 3912 }, sym: { ...SYM, bid: 3927, ask: 3927.2 }, openIntent: OI, levels, decision: PM_DECISION, ladder: false, signal });
    assert.equal(JSON.stringify(pm.positionCouncilMessages(g, { m5: signal, levels })), JSON.stringify(pm.positionCouncilMessages(today, { m5: signal, levels })));
  }
});

test("ML-7 the hashes: V14 (ENGINE_BEHAVIOUR_HASH) does not move; ENGINE_CODE gains managementSpread and the code hash moves", async () => {
  assert.equal(createHash("sha256").update(engineBehaviourSource()).digest("hex"), ENGINE_BEHAVIOUR_HASH);
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.notEqual(ENGINE_CODE_HASH, "12cdf5a54d2fdd389d29780a142b1f3e0eb3844d210259131bdee5bc0f33e81b", "B17 moved it (brokerKeyLevels, manageIntents, positionFacts, positionAction, runPositionManager, replayOmega4)");
});
