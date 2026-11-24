// Z0 (owner 2026-11-23: "Langsung prioritaskan"; docs/RFC_DEMAND_SUPPLY_ZONES.md): demand/supply zone types, strength
// and freshness on the Key Level Agent's zones, each plan's zone words and its nearest decisive opposing zone ahead,
// recorded only. KEY_LEVEL_ZONE_TYPES "off" is main's output byte for byte; "on" only adds keys.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as pp from "../src/public-projection.mjs";
import * as pa from "../src/public-analysis.mjs";
import * as pl from "../src/plan-learning.mjs";
import { buildKeyLevels, TF_WEIGHT } from "../src/key-level-agent.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import { agentContext, finishPlan, slimPlan } from "../src/strategy-agents.mjs";
import { ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import {
  dsEvidence, zoneTypes, zoneTouches, freshnessOf, decisive, aroundSet, zoneAhead, withZoneAhead, zoneNeed, keyLevelZoneTypesMode,
  ZONE_TF_WEIGHT, ZONE_TREND_LEAN, ZONE_NEED, ZONE_RULES, ZONE_SOURCE_WEIGHT
} from "../src/zone-types.mjs";
import { zoneScenario, zoneInputs, CLOSE, NOW } from "./support/zone-types-fixture.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const M15 = 15 * 60_000;
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const mods = { se, de, ea, pp, pa, pl };
const Z0_KEYS = new Set(["ds", "zone_types", "opposing_ahead", "zone_type", "zone_strength", "zone_freshness", "zone_rank"]);
/** A value without Z0's keys, at any depth. */
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !Z0_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);
/** Every Z0 key path in a value. */
const z0Keys = (v, path = "") => (Array.isArray(v) ? v.flatMap((x, i) => z0Keys(x, `${path}[${i}]`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [...(Z0_KEYS.has(k) ? [`${path}.${k}`] : []), ...z0Keys(x, `${path}.${k}`)]) : []);
/** Every leaf under Z0's keys (values and source labels), as text. */
const z0Leaves = (v, inside = false) => (Array.isArray(v) ? v.flatMap((x) => z0Leaves(x, inside)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => z0Leaves(x, inside || Z0_KEYS.has(k))) : inside && v !== null ? [String(v)] : []);

// A zone as the Key Level Agent emits it, and a chart's snapshot with only the boxes given.
const zone = (low, high, role = "support", extra = {}) => ({ low, high, price: (low + high) / 2, role, candidate: true, ...extra });
const chart = (tf, { whales = [], gabfx = null, ob = null, aegis = null } = {}) => ({
  timeframe: tf, huds: { ...(ob ? { order_blocks: { fields: ob } } : {}), ...(aegis ? { aegis_footprint: { fields: aegis } } : {}) },
  chart_plane: { liquidity: { whale_zones: whales, ...(gabfx ? { gabfx } : {}) } }
});
const typed = (z, snapshots, { bars15 = [], atrH1 = 10 } = {}) => zoneTypes([z], dsEvidence({ snapshots, bars15, atrH1 }))[0].ds;
/** 41 closed 15m bars (the decision bar last) far from the zone, with a bar inside it at each `back` given. */
const touchBars = (backs, { low = 3990, high = 3992, end = Date.parse(CLOSE) } = {}) => Array.from({ length: 41 }, (_, i) => {
  const back = 40 - i, inside = backs.includes(back);
  return { open_time: new Date(end - (41 - i) * M15).toISOString(), open: inside ? low + 0.5 : 4010, high: inside ? high - 0.5 : 4011, low: inside ? low + 0.5 : 4009, close: inside ? low + 0.5 : 4010 };
});

test("Z0-1 the constants: the Key Level Agent's timeframe weights, the strategy's trend lean, ZONE_NEED and the switch", () => {
  assert.deepEqual(ZONE_TF_WEIGHT, TF_WEIGHT);
  assert.equal(ZONE_TREND_LEAN, se.STRATEGY_PARAMS.lean);
  assert.deepEqual(ZONE_NEED, { risk: 1, atr: 0.75 });
  assert.equal(zoneNeed(4, 10), 7.5, "0.75 ATR when the risk is smaller");
  assert.equal(zoneNeed(12, 10), 12, "1R when the risk is larger");
  assert.deepEqual({ ...ZONE_RULES }, { dominance: 2, medium: 1, strong: 2, touch_band_atr: 0.15, touch_bars: 40, touch_gap: 3, touch_cap: 3, around: 12 });
  assert.deepEqual({ ...ZONE_SOURCE_WEIGHT }, { whale_active: 0.9, whale_mitigation: 0.7, prophet_best: 0.7, rbs: 1, sbr: 1, qm_buy: 0.9, qm_sell: 0.9, gmi_flag: 0.7 });
  assert.deepEqual([keyLevelZoneTypesMode({}), keyLevelZoneTypesMode(null), keyLevelZoneTypesMode({ KEY_LEVEL_ZONE_TYPES: " OFF " }), keyLevelZoneTypesMode({ KEY_LEVEL_ZONE_TYPES: "x" })], ["on", "on", "off", "on"]);
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /"KEY_LEVEL_ZONE_TYPES": "on"/);
});

test("Z0-2 typing: a 1H support whale is demand/medium; a mitigated support whale (the producer flips it to resistance) is supply", () => {
  const z = zone(3995, 3999);
  const demand = typed(z, { "60": chart("60", { whales: [{ role: "support", state: "active", top: 3998, bottom: 3996 }] }) });
  assert.deepEqual([demand.type, demand.strength, demand.score, demand.sources], ["demand", "medium", 1.35, ["whale@1H"]]);
  // chart-plane.mjs whaleZones: a broken support becomes a mitigation block with role "resistance".
  const supply = typed(zone(3995, 3999), { "60": chart("60", { whales: [{ role: "resistance", state: "mitigation", top: 3998, bottom: 3996 }] }) });
  assert.deepEqual([supply.type, supply.strength, supply.score], ["supply", "medium", 1.05]);
});

test("Z0-3 typing: a bear best order block is supply; equal weights are mixed; no box is none", () => {
  const ob = typed(zone(4018, 4022, "resistance"), { "60": chart("60", { ob: { bear_top: 4023, bear_bottom: 4019 } }) });
  assert.deepEqual([ob.type, ob.strength, ob.sources], ["supply", "medium", ["prophet_best@1H"]]);
  const mixed = typed(zone(4018, 4022), { "60": chart("60", { ob: { bear_top: 4023, bear_bottom: 4019, bull_top: 4021, bull_bottom: 4017 } }) });
  assert.deepEqual([mixed.type, mixed.strength, mixed.score], ["mixed", "medium", 1.05]);
  assert.equal(decisive({ ds: mixed }), false, "mixed is never decisive");
  const none = typed(zone(4018, 4022), {});
  assert.deepEqual([none.type, none.strength, none.score, none.sources], ["none", null, 0, []]);
  // Dominance: demand at least twice the supply wins.
  const dom = typed(zone(3995, 3999), { "240": chart("240", { whales: [{ role: "support", state: "active", top: 3998, bottom: 3996 }] }), "15": chart("15", { ob: { bear_top: 3999, bear_bottom: 3997 } }) });
  assert.deepEqual([dom.type, dom.score], ["demand", 1.8], "1.8 against 0.7");
});

test("Z0-4 typing: two overlapping 15m whales count once; a strict overlap; a point must lie inside the zone", () => {
  const two = typed(zone(3995, 3999), { "15": chart("15", { whales: [{ role: "support", state: "active", top: 3998, bottom: 3996 }, { role: "support", state: "active", top: 3999.5, bottom: 3997 }] }) });
  assert.deepEqual([two.type, two.strength, two.score], ["demand", "weak", 0.9], "max per (source, timeframe): 0.9, not 1.8");
  // A box that only touches the zone's edge does not type it (strict overlap).
  assert.equal(typed(zone(3995, 3999), { "60": chart("60", { whales: [{ role: "support", state: "active", top: 3995, bottom: 3993 }] }) }).type, "none");
  // A GABFX point outside the zone does not type it.
  assert.equal(typed(zone(3995, 3999), { "15": chart("15", { gabfx: { rbs: 3999.5 } }) }).type, "none");
  assert.equal(typed(zone(3995, 3999), { "15": chart("15", { gabfx: { rbs: 3999 } }) }).type, "demand", "on the edge is inside");
});

test("Z0-5 typing: the 15m GMI flag attaches only to the zone holding price", () => {
  const aegis = { in_bull_order_block: true, in_bear_order_block: false, in_bull_mitigation: false, in_bear_mitigation: false };
  const snaps = { "15": chart("15", { aegis }) };
  const [at, below] = zoneTypes([zone(3998, 4001, "at price"), zone(3980, 3983, "support")], dsEvidence({ snapshots: snaps, atrH1: 10 }));
  assert.deepEqual([at.ds.type, at.ds.strength, at.ds.sources], ["demand", "weak", ["gmi_flag@15m"]]);
  assert.equal(below.ds.type, "none");
  // Only the 15m chart's flags count.
  assert.equal(typed(zone(3998, 4001, "at price"), { "60": chart("60", { aegis }) }).type, "none");
  assert.equal(typed(zone(3998, 4001, "at price"), { "15": chart("15", { aegis: { in_bear_mitigation: true } }) }).type, "supply");
});

test("Z0-6 typing: a lone 15m RBS point is demand/medium (decisive); a lone 15m whale is weak; a lone 1H-or-higher box is medium", () => {
  const rbs = typed(zone(3995, 3999), { "15": chart("15", { gabfx: { rbs: 3997 } }) });
  assert.deepEqual([rbs.type, rbs.strength, rbs.score, rbs.sources], ["demand", "medium", 1, ["gabfx@15m"]]);
  assert.equal(decisive({ ds: rbs }), true);
  const sbr = typed(zone(4019, 4022, "resistance"), { "15": chart("15", { gabfx: { sbr: 4020 } }) });
  assert.deepEqual([sbr.type, sbr.strength], ["supply", "medium"]);
  const whale = typed(zone(3995, 3999), { "15": chart("15", { whales: [{ role: "support", state: "active", top: 3998, bottom: 3996 }] }) });
  assert.deepEqual([whale.type, whale.strength], ["demand", "weak"]);
  assert.equal(decisive({ ds: whale }), false);
  for (const [tf, label] of [["60", "1H"], ["240", "4H"], ["1D", "daily"]]) {
    const ds = typed(zone(3995, 3999), { [tf]: chart(tf, { ob: { bull_top: 3998, bull_bottom: 3996 } }) });
    assert.deepEqual([ds.type, ds.strength, ds.sources], ["demand", "medium", [`prophet_best@${label}`]], tf);
  }
  // Strong at 2.0: a 4H whale and a 1H best block (1.8 + 1.05).
  assert.equal(typed(zone(3995, 3999), { "240": chart("240", { whales: [{ role: "support", state: "active", top: 3998, bottom: 3996 }] }), "60": chart("60", { ob: { bull_top: 3998, bull_bottom: 3996 } }) }).strength, "strong");
});

test("Z0-7 freshness: 0, 2 and 4 spaced touches are fresh, tested and worn; touches 2 bars apart count once; a 4H zone touched 2 days ago is fresh", () => {
  const band = 0.15 * 10;
  assert.equal(zoneTouches(3990, 3992, touchBars([]), band), 0);
  assert.equal(zoneTouches(3990, 3992, touchBars([5, 15]), band), 2);
  assert.equal(zoneTouches(3990, 3992, touchBars([5, 15, 25, 35]), band), 3, "saturates at 3");
  assert.deepEqual([0, 2, 3].map(freshnessOf), ["fresh", "tested", "worn"]);
  assert.equal(zoneTouches(3990, 3992, touchBars([5, 7]), band), 1, "two bars apart: one touch");
  assert.equal(zoneTouches(3990, 3992, touchBars([5, 8]), band), 2, "three bars apart: two");
  // Within the 0.15 ATR band counts; the decision bar itself does not.
  const near = touchBars([]).map((b, i) => (i === 30 ? { ...b, low: 3993.4, high: 3994 } : b));
  assert.equal(zoneTouches(3990, 3992, near, band), 1);
  const last = touchBars([]).map((b, i, a) => (i === a.length - 1 ? { ...b, low: 3990.5, high: 3991 } : b));
  assert.equal(zoneTouches(3990, 3992, last, band), 0);
  // A 4H zone price last touched 2 days ago: outside the 40-bar (10-hour) window, so fresh whatever the zone's timeframe.
  const ds = typed(zone(3990, 3992), { "240": chart("240", { whales: [{ role: "support", state: "active", top: 3991.5, bottom: 3990.5 }] }) }, { bars15: touchBars([]) });
  assert.deepEqual([ds.type, ds.freshness, ds.touches], ["demand", "fresh", 0]);
  // No bars or no ATR: no freshness.
  assert.deepEqual([typed(zone(3990, 3992), {}, { bars15: [] }).freshness, typed(zone(3990, 3992), {}, { bars15: touchBars([]), atrH1: null }).freshness], [null, null]);
});

test("Z0-8 buildKeyLevels: an overlay; zones, candidates, scores, labels, members and roles are byte-identical with and without types", () => {
  const input = zoneInputs();
  const args = { snapshots: { "15": input.m15Snapshot, "60": input.h1Snapshot, "240": input.h4Snapshot, "1D": input.d1Snapshot }, bars: { M15: input.m15Bars, H1: input.h1Bars, H4: input.h4Bars, D1: input.d1Bars }, price: 4000, atrH1: 9.53 };
  const on = buildKeyLevels(args), off = buildKeyLevels({ ...args, zoneTypes: "off" });
  assert.ok(on.zones.every((z) => z.ds && typeof z.ds.type === "string"), "every zone typed");
  assert.deepEqual(z0Keys(off), [], "off: no typed field");
  assert.equal(JSON.stringify(strip(on)), JSON.stringify(off));
  assert.ok(on.zones.some((z) => z.ds.type === "demand") && on.zones.some((z) => z.ds.type === "supply"), "the fixture has both types");
});

test("Z0-9 KEY_LEVEL_ZONE_TYPES off: the strategy, guardrails, decision record, council, EA signal, public output and plan_setups equal main's (hash taken on main 74be83c)", async () => {
  const off = await zoneScenario(mods, { db: d1, kv, modes: { zoneTypes: "off" } });
  const { run, ...rest } = off;
  assert.equal(sha(rest), "a830079cae93d842555b61cbb3a799bfce47fd94266a48308d6d468189d630d5");
  assert.deepEqual(z0Keys(rest), [], "off removes every typed field");
  const cols = run.DB.raw.prepare("SELECT entry_zone_type, stop_zone_type, tp1_zone_type, opposing_room_atr FROM plan_setups").all();
  assert.ok(cols.length >= 1 && cols.every((c) => Object.values(c).every((v) => v === null)), "the zone columns stay NULL");
  // The mode reaches the strategy through modes from env (loadStrategyInputs) and the capture's slim inputs.
  const modes = (await se.loadStrategyInputs({ KEY_LEVEL_ZONE_TYPES: "off" }, { now: NOW })).modes;
  assert.equal(modes.zoneTypes, "off");
  assert.deepEqual(z0Keys(se.buildStrategy({ ...zoneInputs(), modes })), []);
  const slim = slimInputs({ ...zoneInputs(), modes });
  assert.deepEqual(slim.modes, { zoneTypes: "off" });
  assert.deepEqual(z0Keys(se.buildStrategy(slim)), [], "the replay builds what was live");
  assert.equal("modes" in slimInputs({ ...zoneInputs(), modes: { zoneTypes: "on" } }), false, "stored inputs are unchanged while on");
});

test("Z0-10 the switch is honoured by loadDecisionInputs, readGlobalConclusion, readStrategy, captureStrategyInputs and ownTimeframePlan", async () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  // Each builds from loadStrategyInputs' output (its modes) or the capture's slim copy (test/chart-patterns-mode.test.mjs PM5).
  assert.match(read("../src/decision-engine.mjs"), /const inputs = await loadStrategyInputs\(env, \{ now \}\);\s*const strategy = await safe\(async \(\) => buildStrategy\(inputs\)\);/);
  assert.match(read("../src/global-conclusion.mjs"), /const inputs = await loadStrategyInputs\(env, \{ now \}\);[\s\S]{0,200}buildStrategy\(inputs\)/);
  assert.match(read("../src/strategy-engine.mjs"), /return buildStrategy\(await loadStrategyInputs\(env, \{ now, m5Context \}\), \{ mode \}\);/);
  assert.match(read("../src/strategy-inputs.mjs"), /const slim = slimInputs\(\{ \.\.\.inputs, now \}\);[\s\S]{0,120}build\(slim\)/);
  // ownTimeframePlan: its own inputs carry the switch, and "off" builds untyped zones (no zone_types on the plan).
  assert.deepEqual((await se.loadOwnTimeframePlanInputs({ KEY_LEVEL_ZONE_TYPES: "off" })).modes, { chartPatterns: "on", zoneTypes: "off" });
  const input = zoneInputs();
  for (const dir of [1, -1]) {
    const on = se.ownTimeframePlan({ snapshot: input.h1Snapshot, bars: input.h1Bars }, dir);
    const off = se.ownTimeframePlan({ snapshot: input.h1Snapshot, bars: input.h1Bars, modes: { zoneTypes: "off" } }, dir);
    assert.ok(on.zone_types, `on: zone_types (${dir})`);
    assert.deepEqual(z0Keys(off), []);
    assert.deepEqual(strip(on), off, "the prices never change");
  }
});

test("Z0-11 on: every pre-existing key deep-equals off; guardrails, council, EA signal, management fields and public output are byte-identical", async () => {
  const on = await zoneScenario(mods, { db: d1, kv });
  const off = await zoneScenario(mods, { db: d1, kv, modes: { zoneTypes: "off" } });
  assert.deepEqual(strip(on.strategy), off.strategy);
  assert.deepEqual(strip(on.record), off.record);
  assert.deepEqual(strip(JSON.parse(on.stored)), JSON.parse(off.stored));
  for (const side of ["long", "short"]) assert.equal(JSON.stringify(on.guards[side].checks), JSON.stringify(off.guards[side].checks), `${side} checks`);
  assert.deepEqual(on.record.guardrails, off.record.guardrails);
  for (const k of ["evidence", "messages", "signal", "management", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(on[k]), JSON.stringify(off[k]), k);
  // keyLevelsAround's { low, high } array is deep-equal; the words sit beside them.
  assert.deepEqual(on.record.key_levels.map(({ low, high }) => ({ low, high })), off.record.key_levels);
  assert.ok(on.record.key_levels.length > 0 && on.record.key_levels.every((z) => typeof z.zone_type === "string" && ["candidate", "qualified"].includes(z.zone_rank)));
  assert.deepEqual(de.keyLevelsAround(on.strategy), aroundSet(on.strategy.key_levels.zones, on.strategy.price));
  // The trade carries the plan's words; the decision is the same BUY.
  assert.equal(on.record.stance, "BUY");
  assert.deepEqual(Object.keys(on.record.trade.zone_types), ["entry", "stop", "tp1", "tp2"]);
  assert.deepEqual(on.record.trade.zone_types.entry, { type: "demand", strength: "strong", freshness: "worn" });
  assert.equal(on.record.trade.zone_types.tp1.type, "supply");
  // decision_json grows by the words only (the 1.3 KB estimate covers key_levels; the plans add their own).
  assert.ok(on.stored.length > off.stored.length);
});

test("Z0-12 zoneAhead: recomputed from decision.key_levels with its words and opposing_ahead.trend_lean alone, it equals the live value", async () => {
  const { record } = await zoneScenario(mods, { db: d1, kv });
  const t = record.trade, dir = t.side === "BUY" ? 1 : -1;
  const again = zoneAhead({ entry: t.entry, stop: t.stop }, record.key_levels, { dir, atrH1: record.strategy.atr_h1, trend: t.opposing_ahead.trend_lean });
  assert.deepEqual(again, t.opposing_ahead);
  assert.deepEqual(t.opposing_ahead, { o_type: "supply", o_strength: "strong", o_freshness: "fresh", o_rank: "candidate", room_atr: 1.78, room_r: 1.8, need_r: 1, trend_lean: 0.75, with_trend: true, would_block: false });
  // Every agent plan on both sides replays the same way.
  for (const [side, plans] of Object.entries(record.strategy_plans)) {
    for (const [id, p] of Object.entries(plans)) {
      const d = side === "long" ? 1 : -1;
      assert.deepEqual(zoneAhead(p, record.key_levels, { dir: d, atrH1: record.strategy.atr_h1, trend: p.opposing_ahead.trend_lean }), p.opposing_ahead, `${side} ${id}`);
    }
  }
  // The short sits inside the demand zone it opposes: no room, against the trend, so it would block (recorded only).
  assert.deepEqual([record.strategy_plans.short.zone_pullback.opposing_ahead.room_r, record.strategy_plans.short.zone_pullback.opposing_ahead.would_block], [0, true]);
});

test("Z0-13 zoneAhead: decisive opposing zones only, the nearest ahead, need and the trend exemption; a zone outside aroundSet is never chosen", () => {
  const w = (low, high, zone_type, zone_strength = "medium") => ({ low, high, zone_type, zone_strength, zone_freshness: "fresh", zone_rank: "candidate" });
  const plan = { entry: 4000, stop: 3995 };
  const set = [w(4004, 4006, "supply", "weak"), w(4008, 4010, "demand"), w(4012, 4014, "mixed"), w(4016, 4018, "supply"), w(4020, 4022, "supply", "strong"), w(3990, 3992, "supply")];
  const a = zoneAhead(plan, set, { dir: 1, atrH1: 10, trend: 0 });
  assert.deepEqual([a.room_atr, a.room_r, a.need_r, a.with_trend, a.would_block], [1.6, 3.2, 1.5, false, false], "16 ahead; need 7.5 (0.75 ATR)");
  const close = zoneAhead(plan, [w(4005, 4008, "supply")], { dir: 1, atrH1: 10, trend: -0.2 });
  assert.deepEqual([close.room_r, close.need_r, close.would_block], [1, 1.5, true]);
  assert.equal(zoneAhead(plan, [w(4005, 4008, "supply")], { dir: 1, atrH1: 10, trend: 0.15 }).would_block, false, "with the trend at 0.15: exempt");
  assert.equal(zoneAhead(plan, [w(4005, 4008, "supply")], { dir: 1, atrH1: 10, trend: null }).trend_lean, null);
  const none = zoneAhead(plan, [w(4005, 4008, "demand"), w(4005, 4008, "supply", "weak")], { dir: 1, atrH1: 10, trend: 0 });
  assert.deepEqual(none, { o_type: null, o_strength: null, o_freshness: null, o_rank: null, room_atr: null, room_r: null, need_r: 1.5, trend_lean: 0, with_trend: false, would_block: false });
  // A short mirrors it: demand below.
  assert.equal(zoneAhead({ entry: 4000, stop: 4005 }, [w(3994, 3996, "demand")], { dir: -1, atrH1: 10, trend: 0 }).room_r, 0.8);
  assert.equal(zoneAhead(plan, set, { dir: 1, atrH1: 0 }), null);
  // aroundSet keeps the 12 zones nearest to price; a decisive supply zone beyond them is never chosen, though it is the
  // only opposing zone ahead of this pullback entry.
  const zones = [...Array.from({ length: 12 }, (_, i) => ({ low: 3990 + i, high: 3990.5 + i, candidate: false, qualified: true, ds: { type: "none", strength: null, freshness: "fresh" } })),
    { low: 4040, high: 4042, candidate: true, ds: { type: "supply", strength: "strong", freshness: "fresh" } }];
  const strategy = { price: 3996, atr_h1: 10, trend: 0, key_levels: { zones } };
  assert.equal(aroundSet(zones, 3996).length, 12);
  assert.ok(!aroundSet(zones, 3996).some((z) => z.low === 4040));
  const p = withZoneAhead({ entry: 3990.5, stop: 3985 }, strategy, 1);
  assert.equal(p.opposing_ahead.o_type, null);
  const all = zones.map((z) => ({ low: z.low, high: z.high, zone_type: z.ds.type, zone_strength: z.ds.strength, zone_freshness: z.ds.freshness, zone_rank: z.candidate ? "candidate" : "qualified" }));
  assert.equal(zoneAhead({ entry: 3990.5, stop: 3985 }, all, { dir: 1, atrH1: 10, trend: 0 }).o_type, "supply", "the full set would choose it");
  // Untyped zones: the plan as it is.
  const untyped = { ...strategy, key_levels: { zones: zones.map(({ ds, ...z }) => z) } };
  assert.deepEqual(withZoneAhead({ entry: 3990.5, stop: 3985 }, untyped, 1), { entry: 3990.5, stop: 3985 });
});

test("Z0-14 the plans' zone words: tradeLevels, finishPlan and slimPlan; only with typed zones", () => {
  const ds = (type, strength = "medium") => ({ type, strength, score: 1, freshness: "fresh", touches: 0, sources: [] });
  const zones = [
    { low: 3980, high: 3982, price: 3981, candidate: true, label: "s2", ds: ds("demand") },
    { low: 3995, high: 3999, price: 3997, candidate: true, label: "s1", ds: ds("demand", "strong") },
    { low: 4015, high: 4017, price: 4016, candidate: true, label: "r1", ds: ds("supply") },
    { low: 4030, high: 4032, price: 4031, candidate: true, label: "r2", ds: ds("none") }
  ];
  const strategy = { price: 4000, atr_h1: 10, trend: 0.3, direction: "LONG", plan: { at_level: true }, setup: { type: "none" }, key_levels: { zones } };
  // At 3995-3999 (within 0.35 ATR): the entry is price, the stop beyond the same zone (its far edge 5 below), TP1 at r1.
  const plan = se.planForDirection(strategy, 1);
  assert.deepEqual(plan.zone_types, { entry: { type: "demand", strength: "strong", freshness: "fresh" }, stop: { type: "demand", strength: "strong", freshness: "fresh" }, tp1: { type: "supply", strength: "medium", freshness: "fresh" }, tp2: { type: "none", strength: "medium", freshness: "fresh" } });
  assert.equal(plan.opposing_ahead.o_type, "supply");
  const untyped = { ...strategy, key_levels: { zones: zones.map(({ ds: _, ...z }) => z) } };
  const before = se.planForDirection(untyped, 1);
  assert.equal("zone_types" in before || "opposing_ahead" in before, false);
  assert.deepEqual(strip(plan), before, "prices and notes unchanged");
  // finishPlan: an agent's structural entry and stop, its targets from targetsAhead.
  const ctx = agentContext({ strategy });
  const agentPlan = finishPlan("sweep_reversal", 1, { entry: 4000, stop: 3990, atLevel: true, entryNote: "e", stopNote: "s", setup: "x" }, ctx);
  assert.deepEqual(Object.keys(agentPlan.zone_types), ["entry", "stop", "tp1", "tp2"]);
  assert.equal(agentPlan.zone_types.entry, null, "4000 lies in no zone");
  assert.equal(agentPlan.zone_types.stop.type, "demand", "the stop hides behind 3995-3999");
  assert.equal(agentPlan.zone_types.tp1.type, "supply");
  const agentBefore = finishPlan("sweep_reversal", 1, { entry: 4000, stop: 3990, atLevel: true, entryNote: "e", stopNote: "s", setup: "x" }, agentContext({ strategy: untyped }));
  assert.deepEqual(strip(agentPlan), agentBefore);
  // Own targets: the zone holding each target.
  const own = finishPlan("range_fade", 1, { entry: 4000, stop: 3990, atLevel: true, entryNote: "e", stopNote: "s", setup: "x", targets: { tp1: 4016, tp1_note: "a", tp2: 4025, tp2_note: "b" } }, ctx);
  assert.deepEqual([own.zone_types.tp1?.type, own.zone_types.tp2], ["supply", null]);
  // slimPlan and tradeFor copy both fields only when present.
  assert.deepEqual(Object.keys(slimPlan(plan)).filter((k) => Z0_KEYS.has(k)), ["zone_types", "opposing_ahead"]);
  assert.deepEqual(Object.keys(slimPlan(before)).filter((k) => Z0_KEYS.has(k)), []);
  assert.deepEqual(strip(de.tradeFor("BUY", plan)), de.tradeFor("BUY", before));
  assert.deepEqual(de.tradeFor("BUY", plan).opposing_ahead, plan.opposing_ahead);
});

test("Z0-15 no new value or source label reads like a price", async () => {
  const { record, strategy } = await zoneScenario(mods, { db: d1, kv });
  const leaves = [...z0Leaves(record), ...z0Leaves(strategy)];
  assert.ok(leaves.length > 50);
  for (const s of leaves) assert.doesNotMatch(s, pp.PRICE_LIKE, s);
  const labels = strategy.key_levels.zones.flatMap((z) => z.ds.sources);
  assert.ok(labels.includes("whale@4H") && labels.includes("gmi_flag@15m"));
  for (const l of labels) assert.match(l, /^(whale|prophet_best|gabfx|gmi_flag)@(15m|1H|4H|daily)$/);
});

test("Z0-16 plan_setups: the ALTERs run twice are a no-op; live and shadow setups carry the zone columns of their own plans", async () => {
  const db = d1();
  pl.resetPlanLearningSchemaCacheForTests();
  await pl.ensurePlanLearningSchema(db);
  pl.resetPlanLearningSchemaCacheForTests();
  await pl.ensurePlanLearningSchema(db);
  const cols = db.raw.prepare("PRAGMA table_info(plan_setups)").all().map((c) => c.name);
  for (const c of pl.ZONE_SETUP_COLUMNS) assert.equal(cols.filter((x) => x === c).length, 1, c);
  const { run, record } = await zoneScenario(mods, { db: d1, kv, extraColumns: `, ${pl.ZONE_SETUP_COLUMNS.join(", ")}` });
  const rows = run.DB.raw.prepare(`SELECT setup_key, source, agent, decision_key, mode, ${pl.ZONE_SETUP_COLUMNS.join(", ")} FROM plan_setups ORDER BY setup_key`).all();
  assert.ok(rows.some((r) => r.source === "live") && rows.some((r) => r.source === "shadow"));
  const live = record.strategy_plans.long.zone_pullback;
  const shadow = Object.fromEntries(run.DB.raw.prepare("SELECT mode, plans_json FROM mode_shadow_plans").all().map((r) => [r.mode, JSON.parse(r.plans_json)]));
  for (const r of rows) {
    const p = r.source === "live" ? live : shadow[r.mode].long[r.agent];
    assert.deepEqual({ entry_zone_type: r.entry_zone_type, stop_zone_type: r.stop_zone_type, tp1_zone_type: r.tp1_zone_type, opposing_room_atr: r.opposing_room_atr },
      { entry_zone_type: p.zone_types.entry?.type ?? null, stop_zone_type: p.zone_types.stop?.type ?? null, tp1_zone_type: p.zone_types.tp1?.type ?? null, opposing_room_atr: p.opposing_ahead.room_atr }, r.setup_key);
  }
  assert.equal(rows.find((r) => r.source === "live").entry_zone_type, "demand");
  // A shadow row's trade carries the words of its own mode's plan (scalp's targets differ), as the live trade does.
  for (const r of run.DB.raw.prepare("SELECT mode, agent, plans_json FROM mode_shadow_plans").all()) {
    const s = JSON.parse(r.plans_json), p = s.long[r.agent ?? "zone_pullback"];
    assert.deepEqual([s.trade.zone_types, s.trade.opposing_ahead], [p.zone_types, p.opposing_ahead], r.mode);
  }
  assert.deepEqual([record.trade.zone_types, record.trade.opposing_ahead], [live.zone_types, live.opposing_ahead]);
  // decisionPlans and setupsFrom carry them; an untyped plan adds no key (setupsFrom deep-equals main's).
  const base = { decision_key: record.decision_key, decided_at: record.decided_at, side: "BUY", atr_h1: 9.53, mode: "intraday", regime: "r" };
  const typedPlans = pl.decisionPlans({ ...base, plans: record.strategy_plans });
  assert.equal(typedPlans[0].entry_zone_type, "demand");
  assert.equal(pl.setupsFrom(typedPlans)[0].tp1_zone_type, "supply");
  const untyped = pl.decisionPlans({ ...base, plans: strip(record.strategy_plans) });
  assert.deepEqual(Object.keys(pl.setupsFrom(untyped)[0]).filter((k) => pl.ZONE_SETUP_COLUMNS.includes(k)), []);
  // The fallback of a decision before the agents reads the trade's words.
  const fallback = pl.decisionPlans({ ...base, plans: null, entry: 4000, stop: 3990, tp: 4016, action: "ENTER_LIMIT", at_level: 1, zone_types: JSON.stringify(record.trade.zone_types), opposing_ahead: JSON.stringify(record.trade.opposing_ahead) });
  assert.deepEqual([fallback[0].entry_zone_type, fallback[0].opposing_room_atr], ["demand", 1.78]);
});

test("Z0-17 no hashed engine function changes: ENGINE_CODE_HASH recomputes to its value; the behaviour hash is MS2's", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(ENGINE_CODE_HASH, "c4aa5772b5ee81fecdde470f5070ebecffc94b0ecfcfef0062edba41dbf8e620");
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
  // managementFields reads only low/high: untouched by the words beside them.
  const m = ea.managementFields({ key_levels: [{ low: 3990, high: 3992, zone_type: "demand", zone_strength: "medium", zone_freshness: "fresh", zone_rank: "candidate" }] });
  assert.deepEqual(m, ea.managementFields({ key_levels: [{ low: 3990, high: 3992 }] }));
});
