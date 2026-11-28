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
  ZONE_TF_WEIGHT, ZONE_TREND_LEAN, ZONE_NEED, ZONE_RULES, ZONE_SOURCE_WEIGHT,
  ZONE_SOURCES, ZONE_PROPHET_WEIGHT, zoneSourcesOffMode, zoneSourcesList, zoneSourcesModes, ZONE_GMI_OB_WEIGHT, ZONE_SAME_BLOCK_TOL, ZONE_SOURCE_LABELS_MAX, dsSourceLabels
} from "../src/zone-types.mjs";
import { readPlane, prophetZoneBoxes, aegisZoneBoxes } from "../src/level-readers.mjs";
import { projectionReading } from "../src/projection-agent.mjs";
import { zoneScenario, zoneInputs, PROPHET_ZONES, AEGIS_ZONES, CLOSE, NOW } from "./support/zone-types-fixture.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";
import { withoutAtrRangeRatio } from "./support/zone-aim-inert.mjs";

const M15 = 15 * 60_000;
// CDG (2026-11-25): the decision record's atr_range_ratio (a measurement) is stripped before hashing, so the pins taken before it hold.
const sha = (v) => createHash("sha256").update(JSON.stringify(withoutAtrRangeRatio(v))).digest("hex");
const mods = { se, de, ea, pp, pa, pl };
/**
 * Z3a (2026-11-25): typed, the management fields add key_level_types (one "type/strength/freshness" token per key level,
 * words only); every other key and its order is the untyped run's byte for byte, and the untyped run has none.
 */
function assertManagementTyped(on, off) {
  assert.equal("key_level_types" in off, false, "untyped: no key_level_types");
  const { key_level_types: types, ...rest } = on;
  assert.equal(JSON.stringify(rest), JSON.stringify(off), "management: every other key as untyped");
  assert.equal(types.split(",").length, on.key_levels.split(",").length, "one token per key level");
  assert.ok(types.split(",").every((t) => /^(demand|supply|mixed|none)\/(strong|medium|weak|-)\/(fresh|tested|worn|-)$/.test(t)), types);
}
const Z0_KEYS = new Set(["ds", "zone_types", "opposing_ahead", "zone_type", "zone_strength", "zone_freshness", "zone_rank", "ds_sources"]);
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
  assert.equal(sha(rest), "2e3da11a0889e96fbe617f274c5b0900d7f3fc60ac622404c96dcd8b4d842ffd");
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
  for (const k of ["evidence", "messages", "signal", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(on[k]), JSON.stringify(off[k]), k);
  // Z3a: the management fields add key_level_types (typed only; Omega reads it only with zone_mgmt not off); every other key is off's.
  assertManagementTyped(on.management, off.management);
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
  assert.equal(ENGINE_CODE_HASH, "0caa626023a8c7838f430273db672b5d28c9b45df8dee3d6bb4ef89eb0454541");
  assert.equal(ENGINE_BEHAVIOUR_HASH, "d0c07f020f44f9694b794aafa73684488aaf55848fdabdf0fa9a67804b916e65");
  // managementFields' key_levels reads only low/high; Z3a (2026-11-25) adds key_level_types beside it for typed levels.
  const m = ea.managementFields({ key_levels: [{ low: 3990, high: 3992, zone_type: "demand", zone_strength: "medium", zone_freshness: "fresh", zone_rank: "candidate" }] });
  const { key_level_types, ...rest } = m;
  assert.equal(key_level_types, "demand/medium/fresh");
  assert.deepEqual(rest, ea.managementFields({ key_levels: [{ low: 3990, high: 3992 }] }));
});

// ---------------------------------------------------------------- Z1a: every active Prophet order block as a source
// (docs/RFC_DEMAND_SUPPLY_ZONES.md §4). The producer adds chart_plane.zones.prophet (local-engines/producer/src/adopt/
// prophet-ob.mjs; its own tests in local-engines/producer/test/prophet-ob.test.mjs); the typing reads it here.
/** A chart with Prophet zone boxes in its plane (chart_plane.zones.prophet). */
const pchart = (tf, prophet, extra = {}) => { const c = chart(tf, extra); c.chart_plane.zones = { prophet }; return c; };
const pz = (side, bottom, top, { high_volume = false, touches = 0, age_bars = 5 } = {}) => ({ side, top, bottom, age_bars, high_volume, touches });

test("Z1a-1 the constants and ZONE_SOURCES_OFF: the tokens, their order, unknown tokens ignored; modes carry it only when a source is off", () => {
  assert.deepEqual([...ZONE_SOURCES], ["prophet_zone", "prophet_best", "whale", "gabfx", "gmi_flag", "gmi_ob"], "Z1b appends gmi_ob");
  assert.deepEqual({ ...ZONE_PROPHET_WEIGHT }, { active: 0.7, high_volume: 0.9 });
  assert.deepEqual(zoneSourcesOffMode({}), []);
  assert.deepEqual(zoneSourcesOffMode({ ZONE_SOURCES_OFF: " Whale, prophet_zone  x gmi_flag,whale" }), ["prophet_zone", "whale", "gmi_flag"]);
  assert.deepEqual(zoneSourcesList("gabfx prophet_best"), ["prophet_best", "gabfx"]);
  assert.deepEqual([zoneSourcesList(null), zoneSourcesList(7)], [[], []]);
  assert.deepEqual(zoneSourcesModes({}), {}, "every source on: the modes are unchanged");
  assert.deepEqual(zoneSourcesModes({ ZONE_SOURCES_OFF: "prophet_zone" }), { zoneSourcesOff: ["prophet_zone"] });
});

test("Z1a-2 typing: a Prophet zone box is demand or supply at 0.7 (0.9 high_volume) x TF_WEIGHT; one per (source, timeframe); prophet_best is dropped on its chart only", () => {
  const z = zone(3995, 3999);
  const one = typed(z, { "60": pchart("60", [pz("demand", 3996, 3998)]) });
  assert.deepEqual([one.type, one.strength, one.score, one.sources], ["demand", "medium", 1.05, ["prophet_zone@1H"]]);
  const hv = typed(zone(3995, 3999), { "60": pchart("60", [pz("demand", 3996, 3998), pz("demand", 3995.5, 3997, { high_volume: true })]) });
  assert.deepEqual([hv.type, hv.score], ["demand", 1.35], "the heaviest box of 1H counts once");
  const supply = typed(zone(4018, 4022, "resistance"), { "15": pchart("15", [pz("supply", 4019, 4021)]) });
  assert.deepEqual([supply.type, supply.strength, supply.score, supply.sources], ["supply", "weak", 0.7, ["prophet_zone@15m"]]);
  // The best block is one of the active blocks: on a chart with prophet_zone boxes it is not counted again ...
  const both = typed(zone(3995, 3999), { "60": pchart("60", [pz("demand", 3996, 3998)], { ob: { bull_top: 3998, bull_bottom: 3996 } }) });
  assert.deepEqual([both.score, both.sources], [1.05, ["prophet_zone@1H"]]);
  // ... a chart without them (or with an empty list) keeps it; the other charts are unaffected.
  const mixedCharts = typed(zone(3995, 3999), { "60": pchart("60", [pz("demand", 3996, 3998)]), "240": pchart("240", [], { ob: { bull_top: 3998, bull_bottom: 3996 } }) });
  assert.deepEqual([mixedCharts.score, mixedCharts.sources], [2.45, ["prophet_best@4H", "prophet_zone@1H"]]);
  // Strict overlap, as every box: an edge that only touches does not type the zone.
  assert.equal(typed(zone(3995, 3999), { "60": pchart("60", [pz("demand", 3993, 3995)]) }).type, "none");
  // A malformed box is no box (prophetZoneBoxes keeps the well-formed ones).
  assert.deepEqual(prophetZoneBoxes({ zones: { prophet: [pz("demand", 3998, 3996), { ...pz("demand", 1, 2), side: "bull" }, pz("supply", null, 4)] } }), []);
  assert.deepEqual(prophetZoneBoxes({ zones: { prophet: [pz("supply", 4019, 4021, { touches: 2, age_bars: 9 })] } }), [{ side: "supply", bottom: 4019, top: 4021, high_volume: false, touches: 2, age_bars: 9 }]);
  assert.deepEqual([prophetZoneBoxes(null), prophetZoneBoxes({}), prophetZoneBoxes({ zones: {} })], [[], [], []]);
});

test("Z1a-3 freshness: the most touches of the zone's own count and its Prophet boxes', so worn dominates; a zone with 3 touches whose box has 0 reads worn", () => {
  const z = (low = 3990, high = 3992) => zone(low, high);
  const box = (touches) => ({ "60": pchart("60", [pz("demand", 3990.5, 3991.5, { touches })]) });
  // Three spaced 15m touches, a box with 0: worn.
  const worn = typed(z(), box(0), { bars15: touchBars([5, 15, 25]) });
  assert.deepEqual([worn.freshness, worn.touches], ["worn", 3]);
  // No 15m touch, a box tested twice on its own chart: tested; four times: worn, capped at 3.
  assert.deepEqual([typed(z(), box(2), { bars15: touchBars([]) }).freshness, typed(z(), box(2), { bars15: touchBars([]) }).touches], ["tested", 2]);
  assert.deepEqual([typed(z(), box(5), { bars15: touchBars([]) }).freshness, typed(z(), box(5), { bars15: touchBars([]) }).touches], ["worn", 3]);
  // No 15m bars: the box's own count.
  assert.equal(typed(z(), box(1), { bars15: [] }).freshness, "tested");
  // A box that does not type the zone does not age it; neither does a box without a count.
  const apart = { "60": pchart("60", [pz("demand", 3995, 3996, { touches: 3 })]) };
  assert.equal(typed(z(), apart, { bars15: touchBars([]) }).freshness, "fresh");
  assert.equal(typed(z(), { "60": pchart("60", [{ ...pz("demand", 3990.5, 3991.5), touches: null }]) }, { bars15: touchBars([]) }).freshness, "fresh");
  // ZONE_SOURCES_OFF=prophet_zone: the zone's own count only.
  const ev = dsEvidence({ snapshots: box(3), bars15: touchBars([]), atrH1: 10, sourcesOff: ["prophet_zone"] });
  assert.equal(zoneTypes([z()], ev)[0].ds.freshness, "fresh");
});

test("Z1a-4 ZONE_SOURCES_OFF=prophet_zone deep-equals Z0's typing; zones and candidates never change; every token switches its source off", () => {
  const plain = zoneInputs(), rich = zoneInputs(undefined, { prophet: true });
  const z0 = se.buildStrategy(plain);
  const off = se.buildStrategy({ ...rich, modes: { zoneSourcesOff: ["prophet_zone"] } });
  assert.equal(JSON.stringify(off), JSON.stringify(z0), "modes: Z0's strategy byte for byte");
  assert.equal(JSON.stringify(se.buildStrategy({ ...rich, env: { ZONE_SOURCES_OFF: "prophet_zone" } })), JSON.stringify(z0), "env too");
  const on = se.buildStrategy(rich);
  assert.notDeepEqual(on.key_levels.zones.map((z) => z.ds), z0.key_levels.zones.map((z) => z.ds), "on: the typing uses the new source");
  assert.ok(on.key_levels.zones.some((z) => z.ds.sources.includes("prophet_zone@1H")));
  // The overlay only: zones, candidates, scores, labels, members, roles and every price are those of Z0.
  assert.equal(JSON.stringify(strip(on)), JSON.stringify(strip(z0)));
  // On the fixture: a new typed zone, worn from its 1H box, and prophet_best gone where the boxes are.
  const at = (low) => on.key_levels.zones.find((z) => z.low === low).ds;
  assert.deepEqual([at(3985).type, at(3985).strength, at(3985).sources], ["demand", "medium", ["prophet_zone@1H"]]);
  assert.equal(z0.key_levels.zones.find((z) => z.low === 3985).ds.type, "none");
  assert.deepEqual([z0.key_levels.zones.find((z) => z.low === 4016.92).ds.freshness, at(4016.92).freshness], ["fresh", "worn"]);
  assert.ok(!on.key_levels.zones.some((z) => z.ds.sources.some((l) => /^prophet_best@(1H|4H|daily)$/.test(l))), "dropped on the charts with boxes");
  // Each token takes its source out.
  for (const token of ZONE_SOURCES) {
    const s = se.buildStrategy({ ...rich, modes: { zoneSourcesOff: [token] } });
    assert.ok(!s.key_levels.zones.some((z) => z.ds.sources.some((l) => l.startsWith(`${token}@`))), token);
    assert.equal(JSON.stringify(strip(s)), JSON.stringify(strip(z0)), `${token}: zones unchanged`);
  }
  // prophet_best off with prophet_zone off: neither Prophet source.
  const neither = se.buildStrategy({ ...rich, modes: { zoneSourcesOff: ["prophet_zone", "prophet_best"] } });
  assert.ok(!neither.key_levels.zones.some((z) => z.ds.sources.some((l) => l.startsWith("prophet"))));
});

test("Z1a-5 the switches travel: loadStrategyInputs and loadOwnTimeframePlanInputs carry zoneSourcesOff only when set; the capture keeps it; ownTimeframePlan honours it", async () => {
  const modes = (await se.loadStrategyInputs({ ZONE_SOURCES_OFF: "prophet_zone" }, { now: NOW })).modes;
  assert.deepEqual(modes, { chartPatterns: "on", tp1KeyZone: "on", entryZone: "edge", zoneTypes: "on", zoneSourcesOff: ["prophet_zone"] });
  assert.equal("zoneSourcesOff" in (await se.loadStrategyInputs({}, { now: NOW })).modes, false, "the default modes are Z0's");
  const rich = zoneInputs(undefined, { prophet: true });
  const slim = slimInputs({ ...rich, modes });
  assert.deepEqual(slim.modes, { zoneSourcesOff: ["prophet_zone"] });
  assert.equal(JSON.stringify(se.buildStrategy(slim)), JSON.stringify(se.buildStrategy(slimInputs(zoneInputs()))), "the replay builds Z0's typing, as live");
  assert.equal("modes" in slimInputs({ ...rich, modes: { zoneTypes: "on" } }), false, "stored inputs unchanged while every source is on");
  assert.deepEqual(slimInputs({ ...rich, modes: { zoneTypes: "off", zoneSourcesOff: ["whale", "nope"] } }).modes, { zoneTypes: "off", zoneSourcesOff: ["whale"] });
  // The capture keeps the planes' Prophet zones, so a replay sees the live source set.
  assert.deepEqual(slim.h1Snapshot.chart_plane.zones, { prophet: PROPHET_ZONES["60"] });
  assert.deepEqual((await se.loadOwnTimeframePlanInputs({ ZONE_SOURCES_OFF: "prophet_zone" })).modes, { chartPatterns: "on", zoneTypes: "on", zoneSourcesOff: ["prophet_zone"] });
  assert.deepEqual((await se.loadOwnTimeframePlanInputs({})).modes, { chartPatterns: "on", zoneTypes: "on" });
  for (const dir of [1, -1]) {
    const z0 = se.ownTimeframePlan({ snapshot: zoneInputs().h1Snapshot, bars: rich.h1Bars }, dir);
    const off = se.ownTimeframePlan({ snapshot: rich.h1Snapshot, bars: rich.h1Bars, modes: { zoneSourcesOff: ["prophet_zone"] } }, dir);
    const on = se.ownTimeframePlan({ snapshot: rich.h1Snapshot, bars: rich.h1Bars }, dir);
    assert.deepEqual(off, z0, `off: Z0's plan (${dir})`);
    assert.deepEqual(strip(on), strip(z0), `prices unchanged (${dir})`);
  }
});

test("Z1a-6 KEY_LEVEL_ZONE_TYPES off with Prophet zones in the planes: main's output byte for byte (Z0-9's pin), no typed field", async () => {
  const off = await zoneScenario(mods, { db: d1, kv, modes: { zoneTypes: "off" }, prophet: true });
  const { run, ...rest } = off;
  // The strategy inputs differ only by the planes' zones, which nothing but the typing reads.
  assert.equal(sha(rest), "2e3da11a0889e96fbe617f274c5b0900d7f3fc60ac622404c96dcd8b4d842ffd");
  assert.deepEqual(z0Keys(rest), []);
});

test("Z1a-7 on: guardrails, council, EA signal, management fields, public output and plan_setups are byte-identical to off; ZONE_SOURCES_OFF=prophet_zone is Z0's record", async () => {
  const on = await zoneScenario(mods, { db: d1, kv, prophet: true });
  const off = await zoneScenario(mods, { db: d1, kv, modes: { zoneTypes: "off" }, prophet: true });
  const z0 = await zoneScenario(mods, { db: d1, kv });
  const z0Again = await zoneScenario(mods, { db: d1, kv, prophet: true, modes: { zoneSourcesOff: ["prophet_zone"] } });
  assert.deepEqual(strip(on.strategy), off.strategy);
  assert.deepEqual(strip(on.record), off.record);
  for (const side of ["long", "short"]) assert.equal(JSON.stringify(on.guards[side].checks), JSON.stringify(off.guards[side].checks), `${side} checks`);
  for (const k of ["evidence", "messages", "signal", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(on[k]), JSON.stringify(off[k]), k);
  assertManagementTyped(on.management, off.management);
  for (const k of ["strategy", "record", "stored", "evidence", "messages", "signal", "management", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(z0Again[k]), JSON.stringify(z0[k]), `prophet_zone off: ${k}`);
  // The recorded words move with the new source (the trade's TP1 zone now reads worn from its 1H box).
  assert.deepEqual(on.record.key_levels.map(({ low, high }) => ({ low, high })), z0.record.key_levels.map(({ low, high }) => ({ low, high })));
  assert.equal(on.record.trade.opposing_ahead.o_freshness, "worn");
  assert.equal(z0.record.trade.opposing_ahead.o_freshness, "fresh");
  // Z1a adds no recorded key: the typed fields sit where Z0's do, except on the two levels Z0 types from its 1H best
  // block's own edge (ZF1: [3992.5, 3995] and [4023, 4025]), which Z1a's 1H boxes (other edges) leave untyped.
  const zf1Own = new Set([".key_levels[2].ds_sources", ".key_levels[7].ds_sources"]);
  assert.deepEqual(z0Keys(on.record), z0Keys(z0.record).filter((k) => !zf1Own.has(k)));
  assert.deepEqual([2, 7].map((i) => z0.record.key_levels[i].ds_sources), [["prophet_best@1H"], ["prophet_best@1H"]]);
  // zoneAhead still replays from the record alone.
  const t = on.record.trade;
  assert.deepEqual(zoneAhead({ entry: t.entry, stop: t.stop }, on.record.key_levels, { dir: 1, atrH1: on.record.strategy.atr_h1, trend: t.opposing_ahead.trend_lean }), t.opposing_ahead);
});

test("Z1a-8 the readers and the rooms: readPlane and the Projection Agent read the plane as before; no new label reads like a price", async () => {
  const rich = zoneInputs(undefined, { prophet: true }), plain = zoneInputs();
  for (const k of ["m15Snapshot", "h1Snapshot", "h4Snapshot", "d1Snapshot"]) {
    const tf = rich[k].timeframe;
    assert.deepEqual(readPlane(rich[k].chart_plane, tf), readPlane(plain[k].chart_plane, tf), `${k}: no level from the zones`);
    assert.equal(JSON.stringify(projectionReading({ bars: rich.m15Bars, plane: rich[k].chart_plane, timeframe: "15 minutes" })), JSON.stringify(projectionReading({ bars: plain.m15Bars, plane: plain[k].chart_plane, timeframe: "15 minutes" })), `${k}: the room's projection evidence`);
  }
  const { record, strategy } = await zoneScenario(mods, { db: d1, kv, prophet: true });
  const leaves = [...z0Leaves(record), ...z0Leaves(strategy)];
  for (const s of leaves) assert.doesNotMatch(s, pp.PRICE_LIKE, s);
  const labels = strategy.key_levels.zones.flatMap((z) => z.ds.sources);
  assert.ok(labels.includes("prophet_zone@1H") && labels.includes("prophet_zone@4H"));
  for (const l of labels) assert.match(l, /^(prophet_zone|whale|prophet_best|gabfx|gmi_flag)@(15m|1H|4H|daily)$/);
  for (const tf of ["15m", "1H", "4H", "daily"]) assert.doesNotMatch(`prophet_zone@${tf}`, pp.PRICE_LIKE);
});

test("Z1a-9 no hashed engine function changes: ENGINE_CODE_HASH and the behaviour hash are Z0's", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(ENGINE_CODE_HASH, "0caa626023a8c7838f430273db672b5d28c9b45df8dee3d6bb4ef89eb0454541");
  assert.equal(ENGINE_BEHAVIOUR_HASH, "d0c07f020f44f9694b794aafa73684488aaf55848fdabdf0fa9a67804b916e65");
});

// ---------------------------------------------------------------- Z1b: GMI's Aegis validated order blocks (gmi_ob)
// (docs/RFC_DEMAND_SUPPLY_ZONES.md §4b). The producer adds chart_plane.zones.aegis (local-engines/producer/src/adopt/
// gmi-zone.mjs); the typing reads it as gmi_ob, 0.8 x TF_WEIGHT, and drops gmi_flag on a chart that has the boxes.
const achart = (tf, aegisBoxes, extra = {}) => { const c = chart(tf, extra); c.chart_plane.zones = { aegis: aegisBoxes }; return c; };
const az = (side, bottom, top, { touches = 0, age_bars = 5 } = {}) => ({ side, top, bottom, age_bars, touches });
const r2 = (v) => Math.round(v * 100) / 100;
const FLAG_BULL = { in_bull_order_block: true, in_bear_order_block: false, in_bull_mitigation: false, in_bear_mitigation: false };

test("Z1b-1 the constants and the token: gmi_ob at 0.8, last in ZONE_SOURCES; aegisZoneBoxes keeps the well-formed boxes only", () => {
  assert.equal(ZONE_GMI_OB_WEIGHT, 0.8);
  assert.equal(ZONE_SOURCES.at(-1), "gmi_ob");
  assert.deepEqual(zoneSourcesOffMode({ ZONE_SOURCES_OFF: "gmi_ob" }), ["gmi_ob"]);
  assert.deepEqual(zoneSourcesOffMode({ ZONE_SOURCES_OFF: "GMI_OB, prophet_zone" }), ["prophet_zone", "gmi_ob"]);
  assert.deepEqual(zoneSourcesModes({ ZONE_SOURCES_OFF: "gmi_ob" }), { zoneSourcesOff: ["gmi_ob"] });
  assert.deepEqual(aegisZoneBoxes({ zones: { aegis: [az("demand", 3998, 3996), { ...az("demand", 1, 2), side: "bull" }, az("supply", null, 4)] } }), []);
  assert.deepEqual(aegisZoneBoxes({ zones: { aegis: [az("supply", 4019, 4021, { touches: 2, age_bars: 9 })] } }), [{ side: "supply", bottom: 4019, top: 4021, touches: 2, age_bars: 9 }]);
  assert.deepEqual([aegisZoneBoxes(null), aegisZoneBoxes({}), aegisZoneBoxes({ zones: { prophet: [az("demand", 1, 2)] } })], [[], [], []]);
});

test("Z1b-2 typing: a gmi_ob box is 0.8 x TF_WEIGHT, labelled gmi_ob@<timeframe>; one per (source, timeframe); a strict overlap", () => {
  const z = zone(3995, 3999);
  for (const [tf, word, score, strength] of [["15", "15m", 0.8, "weak"], ["60", "1H", 1.2, "medium"], ["240", "4H", 1.6, "medium"], ["1D", "daily", 2, "strong"]]) {
    const ds = typed(z, { [tf]: achart(tf, [az("demand", 3996, 3998)]) });
    assert.deepEqual([ds.type, ds.strength, ds.score, ds.sources], ["demand", strength, score, [`gmi_ob@${word}`]], tf);
    assert.equal(r2(ZONE_GMI_OB_WEIGHT * ZONE_TF_WEIGHT[tf]), score);
  }
  const two = typed(z, { "60": achart("60", [az("demand", 3996, 3998), az("demand", 3995.5, 3997)]) });
  assert.deepEqual([two.score, two.sources], [1.2, ["gmi_ob@1H"]], "two overlapping 1H boxes count once");
  const supply = typed(zone(4018, 4022, "resistance"), { "240": achart("240", [az("supply", 4019, 4021)]) });
  assert.deepEqual([supply.type, supply.strength, supply.score], ["supply", "medium", 1.6]);
  assert.equal(typed(z, { "60": achart("60", [az("demand", 3993, 3995)]) }).type, "none", "an edge that only touches does not type");
  // One block counts once (RFC §4b): a gmi_ob box with both edges within ZONE_SAME_BLOCK_TOL (0.001, absolute price)
  // of a prophet_zone box on the same chart and side adds no weight, only provenance (ds.also).
  const withProphet = (gmi, prophet, side = "demand") => { const c = achart("60", [az(side, ...gmi)]); c.chart_plane.zones.prophet = [pz(side, ...prophet)]; return { "60": c }; };
  assert.equal(ZONE_SAME_BLOCK_TOL, 0.001);
  const prophetOnly = typed(z, { "60": (() => { const c = achart("60", []); c.chart_plane.zones.prophet = [pz("demand", 3996, 3998)]; return c; })() });
  for (const [gmi, label] of [[[3996, 3998], "exact"], [[3996.001, 3997.999], "at the tolerance"]]) {
    const same = typed(z, withProphet(gmi, [3996, 3998]));
    assert.deepEqual([same.type, same.strength, same.score, same.sources, same.also], ["demand", "medium", 1.05, ["prophet_zone@1H"], ["gmi_ob@1H"]], label);
    assert.deepEqual({ ...same, also: undefined }, { ...prophetOnly, also: undefined }, `${label}: Z1a's typing`);
  }
  assert.equal(prophetOnly.also, undefined, "no also without a matching gmi_ob box");
  // Just over the tolerance on one edge: two blocks, both count.
  for (const gmi of [[3996.0011, 3998], [3996, 3998.0011]]) {
    const two = typed(z, withProphet(gmi, [3996, 3998]));
    assert.deepEqual([two.strength, two.score, two.sources, two.also], ["strong", 2.25, ["gmi_ob@1H", "prophet_zone@1H"], undefined], String(gmi));
  }
  // Another chart or the other side is not the same block.
  const other = achart("240", [az("demand", 3996, 3998)]);
  const c60 = achart("60", []); c60.chart_plane.zones.prophet = [pz("demand", 3996, 3998)];
  assert.deepEqual(typed(z, { "60": c60, "240": other }).sources, ["gmi_ob@4H", "prophet_zone@1H"]);
  const sides = typed(zone(3995, 3999, "resistance"), withProphet([3996, 3998], [3996, 3998], "supply"));
  assert.deepEqual([sides.sources, sides.also], [["prophet_zone@1H"], ["gmi_ob@1H"]]);
  const mixed = achart("60", [az("supply", 3996, 3998)]); mixed.chart_plane.zones.prophet = [pz("demand", 3996, 3998)];
  assert.deepEqual(typed(z, { "60": mixed }).sources, ["gmi_ob@1H", "prophet_zone@1H"], "opposite sides: two boxes");
  // ZONE_SOURCES_OFF=prophet_zone: every gmi_ob box counts in full.
  const pOff = zoneTypes([zone(3995, 3999)], dsEvidence({ snapshots: withProphet([3996, 3998], [3996, 3998]), atrH1: 10, sourcesOff: ["prophet_zone"] }))[0].ds;
  assert.deepEqual([pOff.type, pOff.strength, pOff.score, pOff.sources, pOff.also], ["demand", "medium", 1.2, ["gmi_ob@1H"], undefined]);
});

test("Z1b-3 gmi_ob replaces gmi_flag on a chart with boxes; gmi_flag stays on a chart without them (no list, an empty list) and with gmi_ob off", () => {
  const at = zone(3998, 4001, "at price");
  // 15m boxes away from price: the flag is gone, and the boxes type nothing at price.
  const replaced = typed(at, { "15": achart("15", [az("demand", 3980, 3982)], { aegis: FLAG_BULL }) });
  assert.deepEqual([replaced.type, replaced.sources], ["none", []]);
  // A box at price types it as gmi_ob, not gmi_flag.
  const atBox = typed(at, { "15": achart("15", [az("demand", 3998.5, 3999.5)], { aegis: FLAG_BULL }) });
  assert.deepEqual([atBox.type, atBox.score, atBox.sources], ["demand", 0.8, ["gmi_ob@15m"]]);
  // No boxes on the chart: gmi_flag as before.
  for (const snaps of [{ "15": chart("15", { aegis: FLAG_BULL }) }, { "15": achart("15", [], { aegis: FLAG_BULL }) }]) {
    assert.deepEqual(typed(at, snaps).sources, ["gmi_flag@15m"]);
  }
  // Boxes on the 1H only: the 15m flag stays (the replacement is per chart).
  const other = typed(at, { "15": chart("15", { aegis: FLAG_BULL }), "60": achart("60", [az("supply", 4030, 4032)]) });
  assert.deepEqual(other.sources, ["gmi_flag@15m"]);
  // gmi_ob off: the boxes are not read, so the flag stays.
  const off = zoneTypes([zone(3998, 4001, "at price")], dsEvidence({ snapshots: { "15": achart("15", [az("demand", 3998.5, 3999.5)], { aegis: FLAG_BULL }) }, atrH1: 10, sourcesOff: ["gmi_ob"] }))[0].ds;
  assert.deepEqual([off.type, off.score, off.sources], ["demand", 0.7, ["gmi_flag@15m"]]);
  // Before/after on a 15m whose only block both cores report: Z1a counted it with the flag (prophet_zone + gmi_flag,
  // 1.4 medium); Z1b counts the block once (prophet_zone, 0.7 weak) and gmi_ob is provenance.
  const dup = () => { const c = achart("15", [az("demand", 3998.5, 3999.5)], { aegis: FLAG_BULL }); c.chart_plane.zones.prophet = [pz("demand", 3998.5, 3999.5)]; return { "15": c }; };
  const z1aDup = zoneTypes([zone(3998, 4001, "at price")], dsEvidence({ snapshots: dup(), atrH1: 10, sourcesOff: ["gmi_ob"] }))[0].ds;
  const z1bDup = typed(zone(3998, 4001, "at price"), dup());
  assert.deepEqual([z1aDup.strength, z1aDup.score, z1aDup.sources, z1aDup.also], ["medium", 1.4, ["gmi_flag@15m", "prophet_zone@15m"], undefined]);
  assert.deepEqual([z1bDup.strength, z1bDup.score, z1bDup.sources, z1bDup.also], ["weak", 0.7, ["prophet_zone@15m"], ["gmi_ob@15m"]]);
});

test("Z1b-4 freshness: max(the zone's own touches, its gmi_ob and prophet_zone boxes'), capped at 3; gmi_ob off: without the gmi_ob boxes", () => {
  const z = () => zone(3990, 3992);
  const box = (touches, extra = {}) => ({ "60": achart("60", [az("demand", 3990.5, 3991.5, { touches })], extra) });
  assert.deepEqual([typed(z(), box(2), { bars15: touchBars([]) }).freshness, typed(z(), box(2), { bars15: touchBars([]) }).touches], ["tested", 2]);
  assert.deepEqual([typed(z(), box(7), { bars15: touchBars([]) }).freshness, typed(z(), box(7), { bars15: touchBars([]) }).touches], ["worn", 3]);
  assert.deepEqual(typed(z(), box(0), { bars15: touchBars([5, 15, 25]) }).freshness, "worn", "the zone's own 3 touches dominate a fresh box");
  assert.equal(typed(z(), box(1), { bars15: [] }).freshness, "tested", "no 15m bars: the box's count");
  // Both box sources: the most of all.
  const both = achart("60", [az("demand", 3990.5, 3991.5, { touches: 1 })]);
  both.chart_plane.zones.prophet = [pz("demand", 3990.5, 3991.5, { touches: 2 })];
  assert.equal(typed(z(), { "60": both }, { bars15: touchBars([]) }).touches, 2);
  // A box that does not type the zone does not age it.
  assert.equal(typed(z(), { "60": achart("60", [az("demand", 3995, 3996, { touches: 3 })]) }, { bars15: touchBars([]) }).freshness, "fresh");
  const ev = dsEvidence({ snapshots: box(3), bars15: touchBars([]), atrH1: 10, sourcesOff: ["gmi_ob"] });
  assert.equal(zoneTypes([z()], ev)[0].ds.freshness, "fresh");
});

test("Z1b-5 ZONE_SOURCES_OFF=gmi_ob deep-equals Z1a's typing on planes that carry aegis boxes; zones and candidates never change; every token switches its source off", () => {
  const z1a = se.buildStrategy(zoneInputs(undefined, { prophet: true }));
  const rich = zoneInputs(undefined, { aegis: true });
  assert.deepEqual(rich.m15Snapshot.chart_plane.zones, { prophet: [], aegis: AEGIS_ZONES["15"] }, "the fixture's planes carry both");
  const off = se.buildStrategy({ ...rich, modes: { zoneSourcesOff: ["gmi_ob"] } });
  assert.equal(JSON.stringify(off), JSON.stringify(z1a), "modes: Z1a's strategy byte for byte");
  assert.equal(JSON.stringify(se.buildStrategy({ ...rich, env: { ZONE_SOURCES_OFF: "gmi_ob" } })), JSON.stringify(z1a), "env too");
  const on = se.buildStrategy(rich);
  assert.equal(JSON.stringify(strip(on)), JSON.stringify(strip(z1a)), "the overlay only: every zone, candidate and price is Z1a's");
  const at = (s, low) => s.key_levels.zones.find((z) => z.low === low).ds;
  // The 15m zone at price: gmi_ob@15m replaces gmi_flag@15m (0.8 for 0.7); ZF1: the 1H demand box whose top (3998.6) is
  // the zone's low types it too.
  assert.deepEqual([at(z1a, 3998.6).sources, at(on, 3998.6).sources], [["gmi_flag@15m", "prophet_zone@1H", "whale@15m"], ["gmi_ob@15m", "prophet_zone@1H", "whale@15m"]]);
  assert.deepEqual([at(z1a, 3998.6).score, at(on, 3998.6).score], [2.95, 3.05], "1.6 and 1.7 before ZF1, plus the 1H box (1.35)");
  // A zone Z1a left untyped: supply/medium, tested from its 1H box.
  assert.deepEqual([at(z1a, 4023).type, at(on, 4023).type, at(on, 4023).strength, at(on, 4023).freshness], ["none", "supply", "medium", "tested"]);
  // The block both cores found (same edges): it counts once, medium as in Z1a, with gmi_ob as provenance only.
  assert.deepEqual([at(z1a, 3985).strength, at(on, 3985).strength, at(on, 3985).sources, at(on, 3985).also], ["medium", "medium", ["prophet_zone@1H"], ["gmi_ob@1H"]]);
  assert.equal(at(on, 3985).score, at(z1a, 3985).score);
  assert.ok(!on.key_levels.zones.some((z) => z.ds.sources.includes("gmi_flag@15m")), "no gmi_flag on the 15m, which has boxes");
  for (const token of ZONE_SOURCES) {
    const s = se.buildStrategy({ ...rich, modes: { zoneSourcesOff: [token] } });
    assert.ok(!s.key_levels.zones.some((z) => z.ds.sources.some((l) => l.startsWith(`${token}@`))), token);
    assert.equal(JSON.stringify(strip(s)), JSON.stringify(strip(z1a)), `${token}: zones unchanged`);
  }
  // Both box sources off: Z0's typing.
  assert.equal(JSON.stringify(se.buildStrategy({ ...rich, modes: { zoneSourcesOff: ["prophet_zone", "gmi_ob"] } })), JSON.stringify(se.buildStrategy(zoneInputs())));
  // The capture keeps the planes' aegis boxes, so a replay sees the live source set.
  assert.deepEqual(slimInputs(rich).m15Snapshot.chart_plane.zones.aegis, AEGIS_ZONES["15"]);
});

test("Z1b-6 the scenario: gmi_ob off is Z1a's record and everything downstream; types off is Z0-9's pin; on, the guardrails (ZONE_PRIORITY off), council, EA signal, management and public output equal off", async () => {
  const z1a = await zoneScenario(mods, { db: d1, kv, prophet: true });
  const again = await zoneScenario(mods, { db: d1, kv, aegis: true, modes: { zoneSourcesOff: ["gmi_ob"] } });
  for (const k of ["strategy", "record", "stored", "evidence", "messages", "signal", "management", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(again[k]), JSON.stringify(z1a[k]), `gmi_ob off: ${k}`);
  for (const side of ["long", "short"]) assert.equal(JSON.stringify(again.guards[side]), JSON.stringify(z1a.guards[side]), `gmi_ob off: ${side} guards`);
  const typesOff = await zoneScenario(mods, { db: d1, kv, modes: { zoneTypes: "off" }, aegis: true });
  const { run, ...rest } = typesOff;
  assert.equal(sha(rest), "2e3da11a0889e96fbe617f274c5b0900d7f3fc60ac622404c96dcd8b4d842ffd", "KEY_LEVEL_ZONE_TYPES off: main's output");
  const on = await zoneScenario(mods, { db: d1, kv, aegis: true });
  assert.deepEqual(strip(on.record), typesOff.record);
  for (const side of ["long", "short"]) assert.equal(JSON.stringify(on.guards[side].checks), JSON.stringify(typesOff.guards[side].checks), `${side} checks`);
  for (const k of ["evidence", "messages", "signal", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(on[k]), JSON.stringify(typesOff[k]), k);
  assertManagementTyped(on.management, typesOff.management);
  // Z1b's only new recorded key is ds_sources (orchestrator ruling): on a level Z1a left untyped, now typed by gmi_ob.
  const noSrc = (keys) => keys.filter((k) => !k.endsWith(".ds_sources"));
  assert.deepEqual(noSrc(z0Keys(on.record)), noSrc(z0Keys(z1a.record)), "Z1b adds no other recorded key");
  assert.ok(on.record.key_levels.every((z) => !("ds_sources" in z) || (Array.isArray(z.ds_sources) && z.ds_sources.length >= 1 && z.ds_sources.length <= ZONE_SOURCE_LABELS_MAX)));
  assert.notEqual(JSON.stringify(on.record.key_levels), JSON.stringify(z1a.record.key_levels), "the recorded words move with the new source");
  const labels = on.strategy.key_levels.zones.flatMap((z) => z.ds.sources);
  assert.ok(labels.includes("gmi_ob@15m") && labels.includes("gmi_ob@1H"));
  for (const l of labels) assert.match(l, /^(prophet_zone|whale|prophet_best|gabfx|gmi_flag|gmi_ob)@(15m|1H|4H|daily)$/);
  for (const tf of ["15m", "1H", "4H", "daily"]) assert.doesNotMatch(`gmi_ob@${tf}`, pp.PRICE_LIKE);
  for (const s of [...z0Leaves(on.record), ...z0Leaves(on.strategy)]) assert.doesNotMatch(s, pp.PRICE_LIKE, s);
});

test("Z1b-7 the readers: readPlane and the Projection Agent read a plane with aegis boxes as before; the hashes are Z0's", async () => {
  const rich = zoneInputs(undefined, { aegis: true }), plain = zoneInputs();
  for (const k of ["m15Snapshot", "h1Snapshot", "h4Snapshot", "d1Snapshot"]) {
    const tf = rich[k].timeframe;
    assert.deepEqual(readPlane(rich[k].chart_plane, tf), readPlane(plain[k].chart_plane, tf), `${k}: no level from the zones`);
    assert.equal(JSON.stringify(projectionReading({ bars: rich.m15Bars, plane: rich[k].chart_plane, timeframe: "15 minutes" })), JSON.stringify(projectionReading({ bars: plain.m15Bars, plane: plain[k].chart_plane, timeframe: "15 minutes" })), k);
  }
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(ENGINE_CODE_HASH, "0caa626023a8c7838f430273db672b5d28c9b45df8dee3d6bb4ef89eb0454541");
  assert.equal(ENGINE_BEHAVIOUR_HASH, "d0c07f020f44f9694b794aafa73684488aaf55848fdabdf0fa9a67804b916e65");
});

test("Z1b-8 ds_sources: the recorded set's source labels (words only, weighted sources then '(dup)' provenance, bounded); absent from the public analysis, the EA signal and managementFields", async () => {
  assert.deepEqual(dsSourceLabels({ sources: ["whale@15m", "prophet_zone@1H"], also: ["gmi_ob@1H"] }), ["prophet_zone@1H", "whale@15m", "gmi_ob@1H(dup)"]);
  assert.equal(dsSourceLabels({ sources: [], also: [] }), null);
  assert.equal(dsSourceLabels(null), null);
  // Words only: anything not <source>@<15m|1H|4H|daily> is dropped; at most ZONE_SOURCE_LABELS_MAX.
  assert.deepEqual(dsSourceLabels({ sources: ["prophet_zone@1H", "x y@1H", "a@5m", 7, "<b>@1H", "z".repeat(40) + "@1H"] }), ["prophet_zone@1H"]);
  // Every timeframe word of ZONE_TF_NAME is kept, weekly included.
  assert.deepEqual(dsSourceLabels({ sources: ["whale@weekly", "prophet_zone@daily"], also: ["gmi_ob@weekly"] }), ["prophet_zone@daily", "whale@weekly", "gmi_ob@weekly(dup)"]);
  // A snapshot whose timeframe is "W" types as weekly, and the label reaches the recorded set.
  const wSnap = achart("1D", [az("demand", 3990.5, 3991.5)]); wSnap.timeframe = "W";
  const wZone = zoneTypes([{ low: 3990, high: 3992, candidate: true }], dsEvidence({ snapshots: { "1D": wSnap }, atrH1: 10 }));
  assert.deepEqual(aroundSet(wZone, 4000)[0].ds_sources, ["gmi_ob@weekly"]);
  const many = ZONE_SOURCES.flatMap((s) => ["15m", "1H", "4H", "daily", "weekly"].map((tf) => `${s}@${tf}`));
  assert.equal(dsSourceLabels({ sources: many, also: many }).length, ZONE_SOURCE_LABELS_MAX);
  // In the recorded set: present on a typed level with sources, absent on one without.
  const set = aroundSet([
    { low: 3990, high: 3992, candidate: true, ds: { type: "demand", strength: "medium", freshness: "fresh", sources: ["prophet_zone@1H"], also: ["gmi_ob@1H"] } },
    { low: 4010, high: 4012, candidate: true, ds: { type: "none", strength: null, freshness: "fresh", sources: [] } },
    { low: 4020, high: 4022, candidate: true }
  ], 4000);
  assert.deepEqual(set.map((z) => z.ds_sources), [["prophet_zone@1H", "gmi_ob@1H(dup)"], undefined, undefined]);
  // The scenario: the record carries labels; the public analysis, the EA signal and managementFields never do.
  const on = await zoneScenario(mods, { db: d1, kv, aegis: true });
  assert.ok(on.record.key_levels.some((z) => Array.isArray(z.ds_sources)), "the record carries ds_sources");
  for (const k of ["analysis", "signal", "management"]) {
    const text = JSON.stringify(on[k]);
    assert.ok(!/ds_sources|\(dup\)|prophet_zone@|gmi_ob@/.test(text), `${k}: no source label`);
  }
});
