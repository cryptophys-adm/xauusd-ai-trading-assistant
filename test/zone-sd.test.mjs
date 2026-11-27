// Z6 (owner 2026-11-26: "Langsung signal + zone_sd"; docs/RFC_DEMAND_SUPPLY_ZONES.md §10): the supply and demand boxes as
// key levels of their own (src/zone-types.mjs sdLevels), recorded in the decision and sent in the signal's key_levels with
// a "/sd" token (SD_LEVELS), and read by Omega's management and the Position Manager only while the Omega setting
// zone_sd is on. SD_LEVELS off is main's record, signal and management byte for byte; zone_sd off ignores "/sd" levels.
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
import * as oe from "../src/omega-engine.mjs";
import * as pm from "../src/position-manager.mjs";
import { buildKeyLevels } from "../src/key-level-agent.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import {
  sdLevels, sdLevelsMode, sdLevelsModes, sdModeOf, zoneAheadSd, zoneAhead, aroundSet, SD_LEVELS_MODES, SD_RULES, SD_RANK, ZONE_RULES
} from "../src/zone-types.mjs";
import {
  ERA_SWITCHES, eraSwitches, nextEra, replayOmega4, decisionFromRow, DECISION_SQL, ENGINE_CODE, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex
} from "../src/ledger-omega4.mjs";
import { switchByKey, readSwitch } from "../src/feature-switches.mjs";
import { featureSwitchesPayload, setFeatureSwitch, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import { readSettings, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { zoneScenario, zoneInputs, NOW as Z_NOW } from "./support/zone-types-fixture.mjs";
import { withoutAtrRangeRatio } from "./support/zone-aim-inert.mjs";
import { managementScenario, SIGNAL_PLAIN, SIGNAL_SD, SYM, LONG, SHORT, META, NOW, PM_DECISION } from "./support/zone-sd-fixture.mjs";
import { decision as v4Decision, dec, levels as v4Levels, sellTrade, path, lerp, base, C, M1, WARM } from "./fixtures/omega-v4-replay.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const mods = { se, de, ea, pp, pa, pl };
const sha = (v) => createHash("sha256").update(JSON.stringify(withoutAtrRangeRatio(v))).digest("hex");
const shaPlain = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const P = 4000, ATR = 10;
const box = (tf, side, bottom, top, weight = 1.5, extra = {}) => ({ source: "prophet_zone", tf, side, bottom, top, weight, ...extra });
const ev = (boxes, extra = {}) => ({ boxes, bars: [], atr_h1: ATR, ...extra });
const kept = (low, high) => ({ low, high, price: (low + high) / 2, role: "support", candidate: true });
const lows = (list) => list.map((z) => z.low);
const SD_KEYS = ["sd_levels", "sd_levels_mode", "opposing_ahead_sd"];

/** The EA's own lookup (ea/mt5/CryptophysXAUUSD.mq5 JsonValueStart): the first `"<key>":`, then its value. */
function eaValue(json, k) {
  const needle = `"${k}":`;
  let p = json.indexOf(needle);
  if (p < 0) return undefined;
  p += needle.length;
  const m = json.slice(p).match(/^\s*("([^"]*)"|[^,}\s]+)/);
  return m ? (m[2] ?? m[1]) : undefined;
}

// ------------------------------------------------------------------ the switch

test("ZS-1 SD_LEVELS: off (default) | record | signal; the modes carry it only when set; the capture keeps it; the FS1 row and wrangler's production value", async () => {
  assert.deepEqual([...SD_LEVELS_MODES], ["off", "record", "signal"]);
  for (const [raw, v] of [[undefined, "off"], ["", "off"], ["bogus", "off"], ["off", "off"], [" Record ", "record"], ["SIGNAL", "signal"]]) assert.equal(sdLevelsMode(raw === undefined ? {} : { SD_LEVELS: raw }), v, String(raw));
  assert.deepEqual(sdLevelsModes({}), {});
  assert.deepEqual(sdLevelsModes({ SD_LEVELS: "signal" }), { sdLevels: "signal" });
  assert.deepEqual([sdModeOf("record"), sdModeOf("signal"), sdModeOf("on"), sdModeOf(undefined)], ["record", "signal", "off", "off"]);
  assert.equal("sdLevels" in (await se.loadStrategyInputs({}, { now: Z_NOW })).modes, false, "unset: the modes as before");
  assert.equal((await se.loadStrategyInputs({ SD_LEVELS: "signal" }, { now: Z_NOW })).modes.sdLevels, "signal");
  assert.deepEqual(slimInputs({ ...zoneInputs(), modes: { zoneTypes: "on", sdLevels: "record" } }).modes, { sdLevels: "record" });
  assert.equal("modes" in slimInputs({ ...zoneInputs(), modes: { zoneTypes: "on" } }), false, "stored inputs unchanged while off");
  const e = switchByKey("SD_LEVELS");
  assert.deepEqual([e.group, e.worker, e.write, e.era_switch, e.restarts_mode_evidence, e.default_value, e.config_value, [...e.values]], ["zones", "ai", "feature-switch", false, false, "off", "signal", ["off", "record", "signal"]]);
  for (const raw of [undefined, "record", "signal", "on", "bogus"]) assert.equal(readSwitch(e, raw), sdLevelsMode(raw === undefined ? {} : { SD_LEVELS: raw }));
  // Production: "signal" (the owner's word), set in wrangler.jsonc vars; the code default stays "off".
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /\n    "SD_LEVELS": "signal",\n/);
});

// ------------------------------------------------------------------ sdLevels

test("ZS-2 the window per timeframe (ATR(1H)): 15m 3, 1H 4, 4H 6, daily 8, weekly 10; the near edge's distance, 0 inside a box", () => {
  assert.deepEqual({ ...SD_RULES.window_atr }, { "15m": 3, "1H": 4, "4H": 6, daily: 8, weekly: 10 });
  for (const [tf, word, w] of [["15", "15m", 3], ["60", "1H", 4], ["240", "4H", 6], ["1D", "daily", 8], ["1W", "weekly", 10]]) {
    const d = w * ATR;
    const inside = sdLevels(ev([box(tf, "demand", P - d - 2, P - d + 0.5), box(tf, "supply", P + d - 0.5, P + d + 2)]), [], P, ATR);
    assert.deepEqual(inside.map((z) => [z.tf, z.zone_type]), [[word, "demand"], [word, "supply"]], `${word}: just inside`);
    const outside = sdLevels(ev([box(tf, "demand", P - d - 2.5, P - d - 0.5), box(tf, "supply", P + d + 0.5, P + d + 2.5)]), [], P, ATR);
    assert.deepEqual(outside, [], `${word}: just outside`);
  }
  // Price inside a box: distance 0; no price or no ATR: none.
  assert.equal(sdLevels(ev([box("15", "demand", 3995, 4005)]), [], P, ATR).length, 1);
  assert.deepEqual(sdLevels(ev([box("60", "demand", 3990, 3995)]), [], null, ATR), []);
  assert.deepEqual(sdLevels(ev([box("60", "demand", 3990, 3995)]), [], P, null), []);
  // Points (GABFX) and the 15m GMI flags are not boxes.
  assert.deepEqual(sdLevels(ev([{ source: "gabfx", tf: "15", side: "demand", bottom: 3995, top: 3995, weight: 1, point: true }, { source: "gmi_flag", tf: "15", side: "demand", bottom: null, top: null, weight: 0.7, at_price: true }]), [], P, ATR), []);
});

test("ZS-3 the cap per side per timeframe: 15m 1, 1H 2, 4H 2, daily 2, weekly 1 (the nearest); demand and supply count apart", () => {
  assert.deepEqual({ ...SD_RULES.cap_per_side }, { "15m": 1, "1H": 2, "4H": 2, daily: 2, weekly: 1 });
  for (const [tf, word, cap] of [["15", "15m", 1], ["60", "1H", 2], ["240", "4H", 2], ["1D", "daily", 2], ["1W", "weekly", 1]]) {
    const boxes = [];
    for (let i = 0; i < 3; i++) {
      boxes.push(box(tf, "demand", P - 6 - 5 * i, P - 4 - 5 * i));
      boxes.push(box(tf, "supply", P + 4 + 5 * i, P + 6 + 5 * i));
    }
    const out = sdLevels(ev(boxes), [], P, ATR);
    assert.equal(out.filter((z) => z.zone_type === "demand").length, cap, `${word} demand`);
    assert.equal(out.filter((z) => z.zone_type === "supply").length, cap, `${word} supply`);
    assert.deepEqual(out.filter((z) => z.zone_type === "demand").map((z) => z.high).sort((a, b) => b - a), [3996, 3991].slice(0, cap), `${word}: the nearest demand`);
    assert.ok(out.every((z) => z.tf === word && z.zone_rank === SD_RANK));
  }
});

test("ZS-4 at most 8 overall, on top of the 12 clusters: decisive first, then the nearest; lowest first", () => {
  const boxes = [];
  // 15m: weak boxes nearest to price (0.7, below medium); every other timeframe its cap per side of medium boxes further away.
  boxes.push(box("15", "demand", 3997, 3998, 0.7), box("15", "supply", 4002, 4003, 0.7));
  let d = 4;
  for (const [tf, cap] of [["60", 2], ["240", 2], ["1D", 2], ["1W", 1]]) {
    for (let i = 0; i < cap; i++) {
      boxes.push(box(tf, "demand", P - d - 1, P - d), box(tf, "supply", P + d, P + d + 1));
      d += 3;
    }
  }
  assert.equal(boxes.length, 16);
  const out = sdLevels(ev(boxes), [], P, ATR);
  assert.equal(out.length, SD_RULES.max);
  assert.equal(SD_RULES.max, 8);
  assert.ok(out.every((z) => z.zone_strength === "medium"), "the weak 15m boxes lose their slots to decisive ones");
  assert.deepEqual(out.map((z) => Math.min(Math.abs(z.low - P), Math.abs(z.high - P))).sort((a, b) => a - b), [4, 4, 7, 7, 10, 10, 13, 13], "the 8 nearest decisive");
  assert.deepEqual(lows(out), [...lows(out)].sort((a, b) => a - b), "lowest first");
  // With fewer decisive ones, weak boxes fill the rest (recorded; the signal sends only the decisive ones).
  const few = sdLevels(ev([box("15", "demand", 3997, 3998, 0.7), box("60", "supply", 4010, 4012)]), [], P, ATR);
  assert.deepEqual(few.map((z) => z.zone_strength), ["weak", "medium"]);
});

test("ZS-5 merge: same-side boxes overlapping by half the narrower merge (the higher timeframe's edges and weight win, the rest is provenance); less, or the other side, stay apart", () => {
  const out = sdLevels(ev([
    box("60", "demand", 3984, 3992, 1.05),
    box("240", "demand", 3980, 3990, 1.4, { also: ["gmi_ob"] }),
    box("60", "demand", 3988.5, 3998.5, 1.05, { source: "whale" }),
    box("240", "supply", 3980, 3990, 1.4)
  ]), [], P, ATR);
  const merged = out.find((z) => z.low === 3980 && z.zone_type === "demand");
  assert.deepEqual(merged, { low: 3980, high: 3990, zone_type: "demand", zone_strength: "medium", zone_freshness: null, zone_rank: "sd", tf: "4H", ds_sources: ["prophet_zone@4H", "gmi_ob@4H(dup)", "prophet_zone@1H(dup)"] });
  // 3988.5-3998.5 overlaps the 4H lead by 1.5 of 10: its own level (the 1H's).
  assert.ok(out.some((z) => z.low === 3988.5 && z.tf === "1H" && z.ds_sources?.[0] === "whale@1H"));
  // The supply box with the same edges is not merged with demand.
  assert.ok(out.some((z) => z.low === 3980 && z.zone_type === "supply"));
  assert.equal(out.length, 3);
  // Strength from the lead's own weight (ZONE_RULES): 2.0 strong, 1.0 medium, below weak; provenance adds no weight.
  const w = (weight) => sdLevels(ev([box("60", "demand", 3990, 3992, weight), box("15", "demand", 3990, 3992, 0.9)]), [], P, ATR)[0].zone_strength;
  assert.deepEqual([w(ZONE_RULES.strong), w(1), w(0.95)], ["strong", "medium", "weak"]);
});

test("ZS-6 exclusion: a box the kept clusters cover for half its width, or whose near edge is within 0.3 ATR of a kept edge, is left out", () => {
  const zones = [kept(3970, 3972)];
  const one = (b) => sdLevels(ev([b]), zones, P, ATR);
  assert.deepEqual(one(box("60", "demand", 3969, 3973)), [], "covered 2 of 4: half");
  assert.equal(one(box("60", "demand", 3960, 3969.5)).length, 0, "near edge 3969.5 within 3 of 3970");
  assert.equal(one(box("60", "demand", 3950, 3966.9)).length, 1, "near edge 3966.9 is 3.1 from 3970");
  assert.equal(one(box("60", "demand", 3950, 3967)).length, 0, "exactly 0.3 ATR: left out");
  assert.equal(one(box("60", "demand", 3955, 3973.5)).length, 0, "near edge 3973.5 within 3 of 3972");
  assert.equal(one(box("60", "demand", 3955, 3980)).length, 1, "covered 2 of 25, near edge 3980 is 8 from 3972");
  // The kept clusters are the recorded set (aroundSet): a zone that is neither candidate nor qualified does not exclude.
  assert.equal(sdLevels(ev([box("60", "demand", 3969, 3973)]), [{ ...kept(3970, 3972), candidate: false }], P, ATR).length, 1);
  // Price inside a box: both edges are near edges.
  assert.equal(sdLevels(ev([box("60", "demand", 3995, 4004)]), [kept(4006, 4007)], P, ATR).length, 0, "the top 4004 within 3 of 4006");
  assert.ok(aroundSet(zones, P).length === 1);
});

test("ZS-7 medium or stronger only in the signal: weak boxes are recorded, never sent", () => {
  const d = {
    decision_key: "OANDA:XAUUSD:15:1795600200000", quorum: { score: 0.2 }, sd_levels_mode: "signal",
    key_levels: [{ low: 3990, high: 3992, zone_type: "demand", zone_strength: "medium", zone_freshness: "fresh", zone_rank: "candidate" }],
    sd_levels: [
      { low: 3970, high: 3975, zone_type: "demand", zone_strength: "weak", zone_freshness: "fresh", zone_rank: "sd", tf: "15m" },
      { low: 4010, high: 4014, zone_type: "supply", zone_strength: "medium", zone_freshness: "tested", zone_rank: "sd", tf: "1H" },
      { low: 4030, high: 4036, zone_type: "supply", zone_strength: "strong", zone_freshness: null, zone_rank: "sd", tf: "daily" }
    ]
  };
  const m = ea.managementFields(d, { basis: 0 });
  assert.equal(m.key_levels, "3990:3992,4010:4014,4030:4036");
  assert.equal(m.key_level_types, "demand/medium/fresh,supply/medium/tested/sd,supply/strong/-/sd");
  // A kept level without words: neither types nor box levels (Omega could not tell them apart).
  const untyped = ea.managementFields({ ...d, key_levels: [{ low: 3990, high: 3992 }] }, { basis: 0 });
  assert.deepEqual([untyped.key_levels, "key_level_types" in untyped], ["3990:3992", false]);
  // record: the same decision sends nothing of its box levels.
  assert.equal(JSON.stringify(ea.managementFields({ ...d, sd_levels_mode: "record" }, { basis: 0 })), JSON.stringify(ea.managementFields({ ...d, sd_levels: undefined, sd_levels_mode: undefined }, { basis: 0 })));
});

// ------------------------------------------------------------------ the scenario: off, record, signal

test("ZS-8 SD_LEVELS off (unset or 'off'): the strategy, record, council, EA signal, management, public output and plan_setups are main's byte for byte (hash on main e7c055b)", async () => {
  for (const [opts, pin] of [[{}, "157180d874cc5a1a52257beb64ac3501fff58769dda19b80c449ab3c6707bdea"], [{ prophet: true, aegis: true }, "7ac65b42b8ca5431dbb8ced3dc6f9c0907fa4a01ab833a106200a8a867a67d81"]]) {
    for (const modes of [undefined, { sdLevels: "off" }]) {
      const { run, ...rest } = await zoneScenario(mods, { db: d1, kv, ...opts, ...(modes ? { modes } : {}) });
      assert.equal(sha(rest), pin, `${JSON.stringify(opts)} ${JSON.stringify(modes)}`);
      assert.ok(SD_KEYS.every((k) => !(k in rest.record) && !(k in rest.strategy.key_levels)), "no box-level field");
    }
  }
});

test("ZS-9 record: decision.sd_levels recorded, the signal and management as off; signal: the decisive ones appended with '/sd', no new key, the EA's keys unchanged", async () => {
  const opts = { db: d1, kv, prophet: true, aegis: true };
  const off = await zoneScenario(mods, opts);
  const rec = await zoneScenario(mods, { ...opts, modes: { sdLevels: "record" } });
  const sig = await zoneScenario(mods, { ...opts, modes: { sdLevels: "signal" } });
  for (const r of [rec, sig]) {
    assert.ok(Array.isArray(r.record.sd_levels) && r.record.sd_levels.length >= 1 && r.record.sd_levels.length <= SD_RULES.max);
    assert.ok(r.record.sd_levels.every((z) => z.zone_rank === "sd" && ["demand", "supply"].includes(z.zone_type) && typeof z.tf === "string"));
    assert.deepEqual(JSON.parse(r.stored).sd_levels, r.record.sd_levels, "stored with the decision");
    // Clusters, the recorded 12, the squeeze, the plans and the guardrails do not change.
    for (const k of ["key_levels", "squeeze", "trade", "guardrails", "strategy_plans", "stance"]) assert.equal(JSON.stringify(r.record[k]), JSON.stringify(off.record[k]), k);
    assert.equal(JSON.stringify(r.strategy.key_levels.zones), JSON.stringify(off.strategy.key_levels.zones));
    for (const k of ["evidence", "messages", "signal", "recap", "analysis", "planRows"]) assert.equal(JSON.stringify(r[k]), JSON.stringify(off[k]), k);
  }
  assert.deepEqual([rec.record.sd_levels_mode, sig.record.sd_levels_mode], ["record", "signal"]);
  assert.equal(JSON.stringify(rec.management), JSON.stringify(off.management), "record: the signal's management fields are off's");
  // signal: key_levels and key_level_types grow by the decisive box levels only; every key and its order as off.
  const sd = sig.record.sd_levels.filter((z) => z.zone_strength === "medium" || z.zone_strength === "strong");
  assert.ok(sd.length >= 1);
  assert.deepEqual(Object.keys(sig.management), Object.keys(off.management), "no new key");
  assert.equal(sig.management.key_levels, `${off.management.key_levels},${sd.map((z) => `${z.low}:${z.high}`).join(",")}`);
  const tokens = sig.management.key_level_types.split(",");
  assert.equal(tokens.length, sig.management.key_levels.split(",").length);
  assert.equal(tokens.slice(0, -sd.length).join(","), off.management.key_level_types);
  assert.ok(tokens.slice(-sd.length).every((t) => /^(demand|supply)\/(medium|strong)\/(fresh|tested|worn|-)\/sd$/.test(t)), tokens.join(","));
  const { key_levels: a, key_level_types: b, ...restOn } = sig.management, { key_levels: c, key_level_types: d, ...restOff } = off.management;
  assert.equal(JSON.stringify(restOn), JSON.stringify(restOff));
  // The EA reads the same value for every key it reads; it reads neither key_levels nor key_level_types; no tp2/extended_tp.
  const src = readFileSync(new URL("../ea/mt5/CryptophysXAUUSD.mq5", import.meta.url), "utf8");
  const eaKeys = [...new Set([...src.matchAll(/Json(?:String|Number|Bool)\(json, "([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
  // E1 (2026-11-27): a pullback trade's signal adds the flat lf_* fields (test/limit-first.test.mjs pins them): left out.
  const full = (r) => JSON.stringify(Object.fromEntries(Object.entries({ ...ea.eaSignalFromDecision({ decision: r.record, now: Z_NOW }), ...r.management, server_ms: 0 }).filter(([k]) => !k.startsWith("lf_"))));
  assert.deepEqual(Object.fromEntries(eaKeys.map((k) => [k, eaValue(full(sig), k)])), Object.fromEntries(eaKeys.map((k) => [k, eaValue(full(off), k)])));
  assert.ok(!eaKeys.includes("key_levels") && !eaKeys.includes("key_level_types"));
  assert.ok(!Object.keys(JSON.parse(full(sig))).some((k) => /tp2|extended_tp/.test(k)));
  // The public recap and analysis carry no box level.
  assert.doesNotMatch(JSON.stringify([sig.recap, sig.analysis]), /sd_levels|"sd"/);
  // buildKeyLevels: the same reading plus sd_levels and its mode; untyped zones: none.
  const input = zoneInputs(undefined, { prophet: true });
  const args = { snapshots: { "15": input.m15Snapshot, "60": input.h1Snapshot, "240": input.h4Snapshot, "1D": input.d1Snapshot }, bars: { M15: input.m15Bars, H1: input.h1Bars, H4: input.h4Bars, D1: input.d1Bars }, price: 4000, atrH1: 9.5 };
  const kOff = buildKeyLevels(args), kOn = buildKeyLevels({ ...args, sdLevels: "signal" });
  const { sd_levels, sd_levels_mode, ...kRest } = kOn;
  assert.equal(JSON.stringify(kRest), JSON.stringify(kOff));
  assert.equal(sd_levels_mode, "signal");
  assert.equal("sd_levels" in buildKeyLevels({ ...args, sdLevels: "signal", zoneTypes: "off" }), false);
});

test("ZS-10 zoneAhead is unchanged (the recorded set only); opposing_ahead_sd is a counterfactual over the recorded set and the decisive box levels", async () => {
  const opts = { db: d1, kv, prophet: true, aegis: true };
  const off = await zoneScenario(mods, opts);
  const sig = await zoneScenario(mods, { ...opts, modes: { sdLevels: "signal" } });
  assert.deepEqual(sig.record.trade.opposing_ahead, off.record.trade.opposing_ahead);
  for (const side of ["long", "short"]) assert.equal(JSON.stringify(sig.guards[side].checks), JSON.stringify(off.guards[side].checks), side);
  assert.doesNotMatch(zoneAhead.toString(), /sd/, "zoneAhead reads no box level");
  const oa = sig.record.opposing_ahead_sd;
  assert.ok(oa && "long" in oa && "short" in oa);
  const plan = sig.guards.long.plan;
  assert.deepEqual(oa.long, zoneAheadSd(plan, sig.record.key_levels, sig.record.sd_levels, { dir: 1, atrH1: sig.strategy.atr_h1, trend: sig.strategy.trend }));
  // A decisive supply box nearer than the recorded set's: the counterfactual finds it, zoneAhead does not.
  const around = [{ low: 4030, high: 4032, zone_type: "supply", zone_strength: "strong", zone_rank: "candidate" }];
  const sd = [{ low: 4004, high: 4006, zone_type: "supply", zone_strength: "medium", zone_rank: "sd", tf: "1H" }, { low: 4001, high: 4002, zone_type: "supply", zone_strength: "weak", zone_rank: "sd", tf: "15m" }];
  const p = { entry: 4000, stop: 3995 }, ctx = { dir: 1, atrH1: 10, trend: 0 };
  assert.equal(zoneAhead(p, around, ctx).room_atr, 3);
  assert.equal(zoneAheadSd(p, around, sd, ctx).room_atr, 0.4, "the medium box; the weak one is not decisive");
  assert.equal(zoneAheadSd(p, around, [sd[1]], ctx), null, "no decisive box level: none");
});

// ------------------------------------------------------------------ Omega and the Position Manager

test("ZS-11 zone_sd off: Omega's management and the Position Manager ignore '/sd' levels, main's byte for byte (hash on main e7c055b)", () => {
  const MAIN = "cc86dd1f64c23405ea52b4907d2635d7ab6d94d776fa9ee7bd0e43b8941ba204";
  assert.equal(shaPlain(managementScenario({ oe, pm }, { signal: SIGNAL_SD, settings: { zone_sd: "off" } })), MAIN, "box levels, zone_sd off");
  assert.equal(shaPlain(managementScenario({ oe, pm }, { signal: SIGNAL_PLAIN })), MAIN, "no box level, zone_sd on (default)");
  assert.equal(shaPlain(managementScenario({ oe, pm }, { signal: SIGNAL_PLAIN, settings: { zone_sd: "off" } })), MAIN);
  // The readers: dropped unless sd; with sd they carry `sd: true`.
  assert.deepEqual(oe.brokerKeyLevels(SIGNAL_SD), oe.brokerKeyLevels(SIGNAL_PLAIN));
  assert.deepEqual(oe.brokerKeyLevels(SIGNAL_SD, { typed: true }), oe.brokerKeyLevels(SIGNAL_PLAIN, { typed: true }));
  assert.deepEqual(pm.brokerLevels(SIGNAL_SD), pm.brokerLevels(SIGNAL_PLAIN));
  assert.deepEqual(oe.brokerKeyLevels(SIGNAL_SD, { sd: true }).filter((z) => z.sd).map(({ low, high }) => [low, high]), [[3908, 3917.4], [3931, 3933]]);
  assert.deepEqual(pm.brokerLevels(SIGNAL_SD, { sd: true }).filter((z) => z.sd).map(({ low, high }) => [low, high]), [[3908, 3917.4], [3931, 3933]]);
  assert.deepEqual(oe.sdMarks(SIGNAL_SD), [false, false, false, false, false, true, true]);
  assert.equal(oe.sdMarks(SIGNAL_PLAIN), null);
  assert.equal(oe.sdMarks({ ...SIGNAL_SD, key_level_types: "demand/medium/fresh/sd" }), null, "a count mismatch marks none");
  // On, the box levels do change management (the fixture is built so).
  assert.notEqual(shaPlain(managementScenario({ oe, pm }, { signal: SIGNAL_SD, settings: { zone_sd: "on" } })), MAIN);
});

const sync = (signal, bid, { position = LONG, settings = {}, power = 0.3 } = {}) => oe.manageIntents({
  positions: [position], sym: { ...SYM, bid, ask: bid + 0.2 }, settings: { ...oe.OMEGA_DEFAULTS, tp_ladder: false, ...settings }, signal: { ...signal, power }, now: NOW, positionMeta: META
});
const slOf = (intents, ticket = 7) => intents.find((i) => i.kind === "modify_sl" && i.ticket === ticket)?.sl ?? null;

test("ZS-12 zone_sd on: a wide box counts as passed only once the whole box is passed (SL+ behind it)", () => {
  // One kept demand level 3905-3907 and a wide demand box 3908-3917.4 above it; a long from 3900, buffer 0.40.
  const signal = { ...SIGNAL_PLAIN, key_levels: "3905:3907,3908:3917.4", key_level_types: "demand/medium/tested,demand/strong/fresh/sd" };
  const plain = { ...SIGNAL_PLAIN, key_levels: "3905:3907", key_level_types: "demand/medium/tested" };
  for (const bid of [3910, 3914, 3917.6]) {
    assert.deepEqual(sync(signal, bid), sync(plain, bid), `${bid}: price inside the box (or within the buffer of its top): today's SL+`);
  }
  // 3918: price minus the buffer (3917.60) is past the box's top: the box is passed and SL+ steps behind it, tighter.
  assert.equal(slOf(sync(plain, 3918)), 3904.6);
  assert.equal(slOf(sync(signal, 3918)), 3907.6);
  assert.equal(slOf(sync(signal, 3918, { settings: { zone_sd: "off" } })), 3904.6);
  // keyLevelPlan's own rule: a level is passed only when wholly beyond the entry and behind price.
  const lv = oe.brokerKeyLevels(signal, { sd: true });
  assert.equal(oe.keyLevelPlan({ position: LONG, sym: { ...SYM, bid: 3917.6, ask: 3917.8 }, signal, levels: lv, now: NOW }).sl, 3904.6);
  // The ladder: a box's rung is its far edge in the profit direction (passed only once the whole box is).
  assert.deepEqual(oe.sdLadderLevels(lv, "BUY").map((z) => [z.low, z.high]), [[3905, 3907], [3917.4, 3917.4]]);
  assert.deepEqual(oe.sdLadderLevels(lv, "SELL").map((z) => [z.low, z.high]), [[3905, 3907], [3908, 3908]]);
  const plainLv = oe.brokerKeyLevels(plain);
  assert.equal(oe.sdLadderLevels(plainLv, "BUY"), plainLv, "no box level: the same list");
});

test("ZS-13 zone_sd on: box levels never loosen a stop, and no stop is looser than the giveback cap (zone_mgmt off and omega)", () => {
  // A wide demand box whose top (3917.4) is above the kept level 3915-3916.5: passed first, its far side (3908) is
  // further from price than today's SL+ behind 3915: rejected, today's 3914.6 stays.
  const signal = { ...SIGNAL_PLAIN, key_levels: "3905:3907,3915:3916.5,3908:3917.4", key_level_types: "demand/medium/tested,demand/strong/fresh,demand/strong/fresh/sd" };
  const plain = { ...SIGNAL_PLAIN, key_levels: "3905:3907,3915:3916.5", key_level_types: "demand/medium/tested,demand/strong/fresh" };
  const withSd = oe.keyLevelPlan({ position: LONG, sym: { ...SYM, bid: 3920 }, signal, levels: oe.brokerKeyLevels(signal, { sd: true }), now: NOW });
  assert.equal(withSd.sl, 3907.6, "keyLevelPlan alone over the box levels would loosen it");
  assert.equal(slOf(sync(signal, 3920)), 3914.6, "sdKeyPlan keeps today's");
  assert.deepEqual(sync(signal, 3920), sync(plain, 3920));
  // sdKeyPlan: tighter taken, looser refused, a target nearer taken, further refused; the close is today's.
  const buy = { buy: true, point: 0.01 };
  assert.deepEqual(oe.sdKeyPlan({ sl: 3914.6, tp: 3936, band: "strong" }, { sl: 3915.2, tp: 3931, band: "strong" }, buy), { sl: 3915.2, tp: 3931, band: "strong", sl_sd: true, tp_sd: true });
  assert.deepEqual(oe.sdKeyPlan({ sl: 3914.6, tp: 3931, band: "strong" }, { sl: 3907.6, tp: 3936, band: "strong" }, buy), { sl: 3914.6, tp: 3931, band: "strong" });
  assert.deepEqual(oe.sdKeyPlan({ sl: null, tp: null, band: "normal" }, { sl: 3911, tp: null, band: "normal" }, buy), { sl: 3911, tp: null, band: "normal", sl_sd: true });
  assert.deepEqual(oe.sdKeyPlan({ sl: 3925.4, tp: 3902, band: "strong" }, { sl: 3926, tp: 3905, band: "strong" }, { buy: false, point: 0.01 }), { sl: 3925.4, tp: 3905, band: "strong", tp_sd: true });
  assert.deepEqual(oe.sdKeyPlan({ close: true, band: "reversed" }, { sl: 1, tp: 2 }, buy), { close: true, band: "reversed" });
  // The ladder: a box rung replaces the thirds (3915, 3930) with a coarser one (3925): its lock (3925 at 3936) would sit
  // looser than today's (3930), so it is never taken; where it is tighter (3925 against 3915 at 3934) it is.
  const far = { ...SIGNAL_PLAIN, key_levels: "3860:3862,3920:3925", key_level_types: "demand/medium/fresh,supply/medium/fresh/sd" };
  const farPlain = { ...SIGNAL_PLAIN, key_levels: "3860:3862", key_level_types: "demand/medium/fresh" };
  const ladder = (sig, bid, zone_sd) => slOf(oe.manageIntents({ positions: [LONG], sym: { ...SYM, bid, ask: bid + 0.2 }, settings: { ...oe.OMEGA_DEFAULTS, zone_sd, profit_lock_gate: "legacy" }, signal: { ...sig, power: 0.3 }, now: NOW, positionMeta: META }));
  assert.deepEqual([ladder(farPlain, 3936, "on"), ladder(far, 3936, "off"), ladder(far, 3936, "on")], [3930, 3930, 3930]);
  assert.deepEqual([ladder(far, 3934, "off"), ladder(far, 3934, "on")], [3915, 3925]);
  const lp = oe.sdLadderPlan({ sl: 3930, sl_rung: 2, partial: { rung: 1 } }, { sl: 3925, sl_rung: 1, partial: { rung: 9 } }, buy);
  assert.deepEqual(lp, { sl: 3930, sl_rung: 2, partial: { rung: 1 } });
  assert.deepEqual(oe.sdLadderPlan({ sl: 3915, sl_rung: 1, partial: null }, { sl: 3925, sl_rung: 1, partial: { rung: 2 } }, buy), { sl: 3925, sl_rung: 1, partial: null, sl_sd: true }, "the partials stay today's; the box lock is marked");
  // Over a grid (both sides, every power band, the ladder on, zone_mgmt off and omega): each final stop with the box
  // levels is at least as tight as without them, and never looser than today's untyped stop by more than the cap.
  const cap = oe.zoneGiveback(META["open:1:B"]);
  let compared = 0, tighter = 0;
  for (const zone_mgmt of ["off", "omega"]) {
    for (const power of [0.1, 0.3, 0.6]) {
      for (const bid of [3905.5, 3912, 3918, 3919.2, 3921, 3925, 3929.5, 3932, 3934, 3940, 3944]) {
        const run = (sig, zone_sd, zm = zone_mgmt) => oe.manageIntents({ positions: [LONG, SHORT], sym: { ...SYM, bid, ask: bid + 0.2 }, settings: { ...oe.OMEGA_DEFAULTS, zone_mgmt: zm, zone_sd }, signal: { ...sig, power }, now: NOW, positionMeta: META });
        const on = run(SIGNAL_SD, "on"), off = run(SIGNAL_SD, "off"), today = run(SIGNAL_PLAIN, "on", "off");
        for (const p of [LONG, SHORT]) {
          const dir = p.side === "BUY" ? 1 : -1;
          const final = (list) => slOf(list, p.ticket) ?? p.sl;
          compared += 1;
          assert.ok(dir * (final(on) - final(off)) >= -1e-9, `${zone_mgmt} ${power} ${bid} ${p.side}: on ${final(on)} is not looser than off ${final(off)}`);
          assert.ok(dir * (final(today) - final(on)) <= cap + 1e-9, `${zone_mgmt} ${power} ${bid} ${p.side}: within the giveback cap of today's`);
          assert.ok(dir * (final(on) - p.sl) >= 0, "never looser than the current stop");
          if (dir * (final(on) - final(off)) > 1e-9) tighter += 1;
        }
      }
    }
  }
  assert.ok(compared === 132 && tighter >= 10, `the box levels tighten some stops (${tighter} of ${compared})`);
});

test("ZS-14 the Position Manager: the council's evidence keeps 12 levels with the box levels counted inside; TP2 may come nearer; the ladder hold and the loosening read today's levels", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ low: 3860 + 10 * i, high: 3862 + 10 * i }));
  const f = { side: "BUY", open: 3900, price: 3921, pips: 210, sl: 3890, tp: 3945, tp1: 3926, tp2: 3930, beyond_tp1_pips: -50, agent: "trend_pullback", stance: "BUY", point: 0.01, dir: 1 };
  const ev12 = (levels) => JSON.parse(pm.positionCouncilMessages(f, { levels })[1].content).key_levels;
  assert.deepEqual(ev12(twelve), twelve, "12 or fewer: as before");
  assert.deepEqual(ev12(twelve.slice(0, 5)), twelve.slice(0, 5));
  const boxes = [{ low: 3922, high: 3924, sd: true }, { low: 3917, high: 3919, sd: true }, { low: 3990, high: 3995, sd: true }];
  const all = [...twelve, ...boxes].sort((a, b) => a.low - b.low);
  const got = ev12(all);
  assert.equal(got.length, 12, "still 12");
  assert.equal(pm.COUNCIL_LEVELS_MAX, 12);
  assert.deepEqual(got.filter((z) => z.sd).map((z) => z.low), [3917, 3922], "the near box levels are counted inside the 12; the far one is not");
  assert.deepEqual(got.map((z) => z.low), [...got.map((z) => z.low)].sort((a, b) => a - b));
  assert.deepEqual(pm.councilLevels(all, 3921).map((z) => z.low), got.map((z) => z.low));
  // positionFacts: TP2 is the next level beyond TP1, a box level included; the ladder hold and the loosening do not see them.
  const sym = { ...SYM, bid: 3921, ask: 3921.2 };
  const intent = { tp: 3926, entry: 3900, sl: 3890, strategy: "trend_pullback", mode: "intraday", r_dist: 10 };
  const levelsOn = pm.brokerLevels(SIGNAL_SD, { sd: true }), levelsOff = pm.brokerLevels(SIGNAL_SD);
  const loosen = { orig_sl: 3890, atr_now: 5, atr_ref: 4 };
  const on = pm.positionFacts({ position: LONG, sym, openIntent: intent, levels: levelsOn, decision: PM_DECISION, ladder: true, signal: SIGNAL_SD, loosen });
  const off = pm.positionFacts({ position: LONG, sym, openIntent: intent, levels: levelsOff, decision: PM_DECISION, ladder: true, signal: SIGNAL_SD, loosen });
  assert.deepEqual([off.tp2, on.tp2], [3936, 3931], "TP2 nearer: the supply box 3931-3933 before L5");
  assert.equal(on.ladder_hold, off.ladder_hold);
  assert.deepEqual(on.loosen.levels, off.loosen.levels, "no box level gives a reason to loosen");
  // The live runner reads zone_sd from the stored settings; v4 passes zoneSdOn(S).
  const src = readFileSync(new URL("../src/position-manager.mjs", import.meta.url), "utf8");
  assert.match(src, /const levels = brokerLevels\(signal, \{ sd: sdOn \}\);/);
  assert.match(readFileSync(new URL("../src/ledger-omega4.mjs", import.meta.url), "utf8"), /const levels = brokerLevels\(signal, \{ sd: zoneSdOn\(S\) \}\);/);
});

test("ZS-15 v4 replays the box levels from each decision's record: zone_sd off is the replay without them; on, the stop locks behind a passed box", () => {
  // A SELL from 2000 (stop 2020, target 1970); a demand box 1993.5-1996 under the entry. Price runs to 1990, then back up.
  const typed = [{ low: 1940, high: 1942, zone_type: "demand", zone_strength: "medium", zone_freshness: "fresh", zone_rank: "candidate" }];
  const sdBox = [{ low: 1993.5, high: 1996, zone_type: "demand", zone_strength: "strong", zone_freshness: "fresh", zone_rank: "sd", tf: "4H" }];
  const d0 = v4Decision({ close: C, trade: sellTrade(2000, 2020, 1970), lv: typed });
  const withBoxes = { ...d0, sd_levels: sdBox, sd_levels_mode: "signal" };
  const price = lerp([[C + 3 * M1, 2000], [C + 12 * M1, 1985], [C + 20 * M1, 1985], [C + 40 * M1, 2003]]);
  const bars = path(C - WARM, C + 50 * M1, price, 0.05);
  // The profit-lock gate "legacy" (the scalp's MFE here stays under the gate's threshold: no lock either way with it on).
  const replay = (d, zone_sd, profit_lock_gate = "legacy") => replayOmega4(base({ bars, decisions: [dec(d)], to: C + 50 * M1, settings: { ...oe.OMEGA_DEFAULTS, enabled: true, zone_sd, profit_lock_gate } }));
  const plainOn = replay(d0, "on"), offBoxes = replay(withBoxes, "off"), onBoxes = replay(withBoxes, "on");
  assert.equal(JSON.stringify(offBoxes.records), JSON.stringify(plainOn.records), "off: as without box levels");
  assert.notEqual(JSON.stringify(onBoxes.records), JSON.stringify(offBoxes.records), "on: the box level moves the management");
  const r = (x) => Object.values(x.records)[0], j = (x) => JSON.parse(r(x).omega4_json);
  assert.deepEqual([r(offBoxes).omega4_exit, r(onBoxes).omega4_exit], ["sl_plus", "sl_plus"]);
  assert.ok(j(onBoxes).sl_moves > j(offBoxes).sl_moves, "the lock behind the passed box is one more modification");
  assert.ok(r(onBoxes).r_omega4 >= r(offBoxes).r_omega4, `on ${r(onBoxes).r_omega4}R is not worse than off ${r(offBoxes).r_omega4}R here`);
  // With the gate on (its default) the gate holds every lock, the box level's included: the same records.
  assert.equal(JSON.stringify(replay(withBoxes, "on", "on").records), JSON.stringify(replay(withBoxes, "off", "on").records));
  // decisionFromRow (D1's extracted fields): the box levels only when recorded.
  const row = { decision_key: d0.decision_key, stance: "SELL", bar_close: d0.bar_close, decided_at: d0.decided_at, key_levels: JSON.stringify(typed), quorum: JSON.stringify(d0.quorum) };
  assert.equal("sd_levels" in decisionFromRow(row), false);
  assert.deepEqual(decisionFromRow({ ...row, sd_levels: JSON.stringify(sdBox), sd_mode: "signal" }).sd_levels, sdBox);
  assert.match(DECISION_SQL, /json_extract\(decision_json, '\$\.sd_levels'\) AS sd_levels, json_extract\(decision_json, '\$\.sd_levels_mode'\) AS sd_mode FROM/);
});

// ------------------------------------------------------------------ the setting, the era, the hashes

test("ZS-16 zone_sd: off | on, default on (the owner's word); settingsFrom checks it; owner-only (Aether's policy and its rollback strip it); the FS1 row", async () => {
  assert.deepEqual([oe.OMEGA_DEFAULTS.zone_sd, [...oe.ZONE_SD_MODES]], ["on", ["off", "on"]]);
  assert.deepEqual([oe.zoneSdOn(oe.OMEGA_DEFAULTS), oe.zoneSdOn({}), oe.zoneSdOn({ zone_sd: "off" }), oe.zoneSdOn({ zone_sd: "bogus" })], [true, true, false, false]);
  assert.equal(oe.settingsFrom({ zone_sd: "off" }).settings.zone_sd, "off");
  assert.equal(oe.settingsFrom({}).settings.zone_sd, "on");
  for (const bad of ["maybe", true, 1, "ON"]) assert.equal(oe.settingsFrom({ zone_sd: bad }).error, "zone_sd must be 'off' or 'on'");
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/delete (back|body)\.zone_sd;/g) ?? []).length, 2, "both policy paths strip it");
  const e = switchByKey("zone_sd");
  assert.deepEqual([e.group, e.worker, e.write, e.resolve, e.era_switch, e.default_value, e.config_value, [...e.values], e.restarts_mode_evidence, e.emergency_stop, e.read_only],
    ["omega", "omega", "omega-settings", "omega-settings", true, "on", null, ["on", "off"], false, false, false]);
  // Through FS1's Omega row: the owner only; the page's own write path.
  resetFeatureSwitchMemoForTests(); resetOmegaBrokerSchemaForTests();
  const T = Date.parse("2026-11-26T08:00:00Z"), OWNER = "owner-sub";
  const env = { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: kv(), DB: d1() };
  await readSettings(env);
  const row0 = (await featureSwitchesPayload(env, { now: T })).switches.find((x) => x.key === "zone_sd");
  assert.deepEqual([row0.value, row0.source], ["on", "default"]);
  assert.equal((await setFeatureSwitch(env, { key: "zone_sd", value: "off", actor_sub: "someone-else", now: T + 1 })).error, "owner_only");
  assert.equal((await setFeatureSwitch(env, { key: "zone_sd", value: "maybe", actor_sub: OWNER, now: T + 1 })).error, "invalid_value");
  const saved = await setFeatureSwitch(env, { key: "zone_sd", value: "off", actor: "owner", actor_sub: OWNER, now: T + 1000 });
  assert.deepEqual([saved.ok, saved.switch.value], [true, "off"]);
  assert.equal((await readSettings(env)).settings.zone_sd, "off");
});

test("ZS-17 the era: ERA_SWITCHES has zone_sd; at its default it adds nothing (the merge carries the era); the owner's 'off' starts a new one", () => {
  assert.ok(ERA_SWITCHES.includes("zone_sd"));
  // E1's limit_first (2026-11-27) follows zone_sd in the list.
  assert.equal(ERA_SWITCHES[ERA_SWITCHES.indexOf("zone_sd") + 1], "limit_first");
  assert.deepEqual(eraSwitches(oe.OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ ...oe.OMEGA_DEFAULTS, zone_sd: "off" }), ["zone_sd=off"]);
  const T = Date.parse("2026-11-26T08:00:00Z");
  const stored = { behaviour_hash: ENGINE_BEHAVIOUR_HASH, code_hash: "709305176abd749b7310b8974142c1926473bdf0a6f6e4e41a057f549d849d91", switches: [], since_ms: T - 86_400_000, reason: "behaviour change", previous: [], carried: [] };
  const merged = nextEra(stored, { switches: eraSwitches(oe.OMEGA_DEFAULTS), now: T });
  assert.deepEqual([merged.era.since_ms, merged.era.code_hash, merged.events], [stored.since_ms, ENGINE_CODE_HASH, ["era carried (behaviour identical)"]]);
  const flipped = nextEra(merged.era, { switches: eraSwitches({ ...oe.OMEGA_DEFAULTS, zone_sd: "off" }), switchesMs: T + 3_600_000, now: T + 3_900_000 });
  assert.deepEqual([flipped.era.since_ms, flipped.era.reason], [T + 3_600_000, "switch on: zone_sd=off"]);
});

test("ZS-18 the hashes: ENGINE_BEHAVIOUR_HASH (V14) does not move; ENGINE_CODE gains Z6's functions and the code hash moves", async () => {
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
  assert.equal(await sha256Hex(engineBehaviourSource()), ENGINE_BEHAVIOUR_HASH, "the fixtures carry no '/sd' token: they replay as before");
  assert.doesNotMatch(engineBehaviourSource(), /\/sd[",]/);
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.notEqual(ENGINE_CODE_HASH, "709305176abd749b7310b8974142c1926473bdf0a6f6e4e41a057f549d849d91");
  for (const n of ["zoneSdOn", "sdMarks", "sdKeyPlan", "sdLadderLevels", "sdLadderPlan", "ZONE_SD_MODES", "brokerKeyLevels", "manageIntents", "settingsFrom", "OMEGA_DEFAULTS"]) assert.ok(ENGINE_CODE["omega-engine"][1].includes(n), n);
  for (const n of ["brokerLevels", "positionFacts", "positionCouncilMessages", "runPositionManager", "councilLevels", "COUNCIL_LEVELS_MAX"]) assert.ok(ENGINE_CODE["position-manager"][1].includes(n), n);
  assert.ok(ENGINE_CODE["ea-signal"][1].includes("managementFields"));
  assert.match(engineCodeSource(), /"zone_sd":"on"/);
});

test("ZS-19 the sd marker: `sd: true` on a stop or target move only where the box plan won; level_source, prices, reasons and ids unchanged; none with zone_sd off or without box levels", () => {
  const strip = (list) => list.map(({ sd, ...rest }) => rest);
  // SL+ (ZS-12's case): the box plan's stop 3907.6 wins over today's 3904.6.
  const signal = { ...SIGNAL_PLAIN, key_levels: "3905:3907,3908:3917.4", key_level_types: "demand/medium/tested,demand/strong/fresh/sd" };
  const slOn = sync(signal, 3918).find((i) => i.kind === "modify_sl");
  assert.deepEqual(slOn, { id: "ms:7:k:390760", kind: "modify_sl", ticket: 7, sl: 3907.6, tp: 3945, reason: slOn.reason, sd: true });
  assert.equal(sync(signal, 3918, { settings: { zone_sd: "off" } }).some((i) => "sd" in i), false);
  // The trailing TP: a long near its target 3928 with a strong power; the box 3931-3933 is nearer than today's 3936.
  const nearTp = { ...LONG, tp: 3928 };
  const tpOf = (zone_sd) => sync(SIGNAL_SD, 3926, { position: nearTp, power: 0.6, settings: { zone_sd } }).filter((i) => i.kind === "modify_tp");
  assert.deepEqual(tpOf("on"), [{ id: "mt:7:393100", kind: "modify_tp", ticket: 7, tp: 3931, reason: "trail_tp_key_level", sd: true }]);
  assert.deepEqual(tpOf("off"), [{ id: "mt:7:393600", kind: "modify_tp", ticket: 7, tp: 3936, reason: "trail_tp_key_level" }]);
  // Over ZS-13's grid with the ladder on and off: every marked intent is a stop or target move whose price differs
  // from the run without the box levels (the box plan won), it never carries a new level_source, and the ladder's
  // lock is marked too. zone_sd off and a signal without box levels mark nothing.
  const counts = {};
  for (const tp_ladder of [true, false]) {
    for (const zone_mgmt of ["off", "omega"]) {
      for (const power of [0.1, 0.3, 0.6]) {
        for (const bid of [3905.5, 3912, 3918, 3919.2, 3921, 3925, 3929.5, 3932, 3934, 3940, 3944]) {
          const run = (sig, zone_sd) => oe.manageIntents({ positions: [LONG, SHORT], sym: { ...SYM, bid, ask: bid + 0.2 }, settings: { ...oe.OMEGA_DEFAULTS, zone_mgmt, zone_sd, tp_ladder }, signal: { ...sig, power }, now: NOW, positionMeta: META });
          const on = run(SIGNAL_SD, "on"), off = run(SIGNAL_SD, "off");
          for (const i of on.filter((x) => "sd" in x)) {
            assert.equal(i.sd, true);
            assert.ok(i.kind === "modify_sl" || i.kind === "modify_tp", i.kind);
            const price = i.kind === "modify_sl" ? i.sl : i.tp;
            assert.equal(off.some((o) => o.kind === i.kind && o.ticket === i.ticket && (i.kind === "modify_sl" ? o.sl : o.tp) === price), false, `${i.id}: the box plan won`);
            assert.ok(!("level_source" in i) || i.level_source === "zone", i.id);
            const k = i.reason.startsWith("ladder_lock_") ? "ladder" : i.kind;
            counts[k] = (counts[k] ?? 0) + 1;
          }
          assert.equal(off.some((x) => "sd" in x), false);
          assert.equal(run(SIGNAL_PLAIN, "on").some((x) => "sd" in x), false);
          // Stripped of the marker, the intents are what the same plan wrote before it: only `sd` is new.
          assert.deepEqual(strip(on).map((x) => Object.keys(x).filter((key) => !["id", "kind", "ticket", "sl", "tp", "reason", "level_source", "volume"].includes(key))).flat(), []);
        }
      }
    }
  }
  assert.ok(counts.modify_sl > 0 && counts.ladder > 0, JSON.stringify(counts));
});
