// Z3a (docs/RFC_DEMAND_SUPPLY_ZONES.md §8): typed zones in Omega's SL+ and trailing TP behind the owner's Omega setting
// zone_mgmt ("off" default | "omega"). Off is today's engine byte for byte; "omega" reads the signal's key_level_types.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  OMEGA_DEFAULTS, settingsFrom, brokerKeyLevels, typedLevels, typedDecisive, keyLevelPlan, manageIntents, planIntents, zoneGiveback, zoneMgmtOn,
  ZONE_MGMT_MODES, ZONE_GIVEBACK_R, ZONE_MGMT_RATE_MS
} from "../src/omega-engine.mjs";
import { managementFields, eaSignalFromDecision } from "../src/ea-signal.mjs";
import { fastProtect, PM_FAST_1M } from "../src/pm-fast.mjs";
import {
  ERA_SWITCHES, eraSwitches, nextEra, eraStep, replayOmega4, ENGINE_CODE, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex
} from "../src/ledger-omega4.mjs";
import { switchByKey, FEATURE_SWITCHES } from "../src/feature-switches.mjs";
import { featureSwitchesPayload, setFeatureSwitch, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import { writeSettings, readSettings, applyOmegaPolicy, bridgeSync, resetOmegaBrokerSchemaForTests, OMEGA_POLICY_KEY, OMEGA_POLICY_APPLIED_KEY } from "../src/omega-broker.mjs";
import { runAuditNotify } from "../src/change-notify.mjs";
import { storeDeal, resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";
import { resetPositionSchemaCacheForTests } from "../src/position-actions.mjs";
import { resetLiquiditySchemaForTests } from "../src/liquidity-lens.mjs";
import { corpusSource } from "../src/corpus-oracle.mjs";
import { runZoneBreaker, typingFlagLine, typingSignature, ensureZoneReadingsSchema, resetZoneReadingsSchemaForTests, ZONE_BREAKER_KEY } from "../src/zone-readings.mjs";
import { formatIntentsText } from "../bridge/omega-bridge/src/files.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { decision, dec, levels as lvPairs, sellTrade, path, lerp, base, C, M1, WARM } from "./fixtures/omega-v4-replay.mjs";
import { fastCases, T0, tpBuyBars } from "./fixtures/pm-fast.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const NOW = Date.parse("2026-11-25T10:20:00Z");
const POWER_MS = Date.parse("2026-11-25T10:15:00Z");
const SYM = Object.freeze({ name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 3920, ask: 3920.2, spread_points: 20 });
// Seven key levels (feed = broker, basis 0): L1 3905-3907, L2 3911.5-3912.5, L3 3913-3914, L4 3915-3916.5 below price
// (passed by a long from 3900), L5 3926-3928, L6 3930-3932, L7 3936-3938 above. The buffer is max(2 spreads 0.40,
// 0.1 x 5m ATR 0.30) = 0.40, so today's SL+ is behind L4 (3914.6; strong: behind L3, 3912.6).
const LV = "3905:3907,3911.5:3912.5,3913:3914,3915:3916.5,3926:3928,3930:3932,3936:3938";
const NONE = "none/-/-";
/** key_level_types with `at` { index: token } and every other level none. */
const types = (at = {}) => Array.from({ length: 7 }, (_, i) => at[i] ?? NONE).join(",");
const SIGNAL = Object.freeze({ side: "NONE", key_levels: LV, feed_basis: 0, feed_basis_known: true, power: 0.3, power_ms: POWER_MS, m5_atr: 3 });
const LONG = Object.freeze({ ticket: 7, side: "BUY", volume: 0.01, open_price: 3900, sl: 3890, tp: 3945, source: "omega", magic: 920200, intent_id: "open:1:B" });
const META = Object.freeze({ mode: "intraday", r_dist: 10 });
const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

/** keyLevelPlan typed (zone_mgmt on) for the long, with the giveback cap of `meta`. */
const typedPlan = (at, { power = 0.3, meta = META, position = LONG, extra = {}, lockPx = null } = {}) => {
  const signal = { ...SIGNAL, power, key_level_types: types(at), ...extra };
  return keyLevelPlan({ position, sym: SYM, signal, levels: brokerKeyLevels(signal, { typed: true }), now: NOW, ...(lockPx != null ? { lockPx } : {}), zone: { cap: zoneGiveback(meta) } });
};
const todayPlan = ({ power = 0.3, position = LONG, extra = {}, lockPx = null } = {}) => {
  const signal = { ...SIGNAL, power, ...extra };
  return keyLevelPlan({ position, sym: SYM, signal, levels: brokerKeyLevels(signal), now: NOW, ...(lockPx != null ? { lockPx } : {}) });
};

// ------------------------------------------------------------------ the signal (managementFields)

/** A decision whose key_levels carry Z0's words (as aroundSet records them), or none. */
const decisionWith = (typed = true, over = {}) => ({
  decision_key: `OANDA:XAUUSD:15:${NOW - 30 * 60_000}`, bar_close: new Date(NOW - 15 * 60_000).toISOString(), decided_at: new Date(NOW - 14 * 60_000).toISOString(), stance: "BUY", confidence: 0.7,
  trade: { side: "BUY", action: "ENTER_LIMIT", entry: 3920, stop: 3910, tp: 3940, tp1: 3940, target: "tp1", trigger_required: false },
  guardrails: { long: { entry_trigger: { fired: false } }, short: { entry_trigger: { fired: false } } },
  quorum: { score: 0.31, long_share: 0.7, short_share: 0.2 }, trading_mode: "intraday",
  key_levels: [
    { low: 3905, high: 3907, ...(typed ? { zone_type: "demand", zone_strength: "medium", zone_freshness: "tested", zone_rank: "candidate", ds_sources: ["whale@1H"] } : {}) },
    { low: 3913, high: 3914, ...(typed ? { zone_type: "none", zone_strength: null, zone_freshness: "worn", zone_rank: "qualified" } : {}) },
    { low: 3930, high: 3932, ...(typed ? { zone_type: "supply", zone_strength: "strong", zone_freshness: null, zone_rank: "candidate" } : {}) }
  ],
  ...over
});
// main fd22f97's managementFields over the untyped decision (and over the typed one: the same text), taken on a git-archive of it.
const MAIN_MANAGEMENT = '{"trading_mode":"intraday","power":0.31,"power_ms":1795601100000,"key_levels":"3905:3907,3913:3914,3930:3932","feed_basis":2,"feed_basis_known":true,"strategy_execution":false,"trade_agent":"","agent_conf":"","agent_conf_prev":"","quorum_long_share":0.7,"quorum_short_share":0.2,"veto_long":false,"veto_short":false}';

/** The EA's own lookup (ea/mt5/CryptophysXAUUSD.mq5 JsonValueStart): the first `"<key>":`, then its value. */
function eaValue(json, k) {
  const needle = `"${k}":`;
  let p = json.indexOf(needle);
  if (p < 0) return undefined;
  p += needle.length;
  const m = json.slice(p).match(/^\s*("([^"]*)"|[^,}\s]+)/);
  return m ? (m[2] ?? m[1]) : undefined;
}

test("Z3a-1 managementFields: key_level_types only when every kept level is typed, aligned 1:1; untyped is main's byte for byte; the EA's keys read the same; no tp2/extended_tp", () => {
  const typed = managementFields(decisionWith(true), { basis: 2 });
  const untyped = managementFields(decisionWith(false), { basis: 2 });
  assert.equal(typed.key_level_types, "demand/medium/tested,none/-/worn,supply/strong/-");
  assert.equal(typed.key_level_types.split(",").length, typed.key_levels.split(",").length, "one token per kept level");
  assert.equal(JSON.stringify(untyped), MAIN_MANAGEMENT, "an untyped decision: main's fields byte for byte");
  const { key_level_types, ...rest } = typed;
  assert.equal(JSON.stringify(rest), MAIN_MANAGEMENT, "typed: every other key (and its order) as before; key_levels unchanged");
  assert.deepEqual(Object.keys(typed).slice(3, 5), ["key_levels", "key_level_types"]);
  // One untyped level among typed ones: no types at all. A dropped level (low above high) does not count.
  const mixed = decisionWith(true);
  mixed.key_levels = [...mixed.key_levels, { low: 3950, high: 3952 }];
  assert.equal("key_level_types" in managementFields(mixed), false);
  const dropped = decisionWith(true);
  dropped.key_levels = [...dropped.key_levels, { low: 3960, high: 3950 }];
  assert.equal(managementFields(dropped).key_level_types, typed.key_level_types, "aligned with the kept levels");
  assert.equal("key_level_types" in managementFields({ ...decisionWith(true), key_levels: [] }), false, "no level, no types");
  // The EA: every key it reads finds the same value with the types in the signal as without them.
  const src = readFileSync(new URL("../ea/mt5/CryptophysXAUUSD.mq5", import.meta.url), "utf8");
  const eaKeys = [...new Set([...src.matchAll(/Json(?:String|Number|Bool)\(json, "([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
  assert.ok(eaKeys.length >= 14, `the EA reads ${eaKeys.length} keys`);
  const full = (d) => JSON.stringify({ ...eaSignalFromDecision({ decision: d, now: NOW }), ...managementFields(d, { basis: 2 }), server_ms: 0 });
  const a = full(decisionWith(true)), b = full(decisionWith(false));
  assert.deepEqual(Object.fromEntries(eaKeys.map((k) => [k, eaValue(a, k)])), Object.fromEntries(eaKeys.map((k) => [k, eaValue(b, k)])));
  assert.ok(!eaKeys.includes("key_level_types") && !eaKeys.includes("key_levels"), "the EA reads neither");
  assert.ok(!Object.keys(JSON.parse(a)).some((k) => /tp2|extended_tp/.test(k)), "no tp2 or extended_tp key");
  // OmegaExecutor does not read the signal at all.
  assert.doesNotMatch(readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8"), /key_level/);
});

test("Z3a-2 brokerKeyLevels: words attached on a count match (lens B levels typed none), ignored on a mismatch, byte-identical without opts", () => {
  const signal = { ...SIGNAL, feed_basis: 2, key_levels: "3903:3905,3913:3915", key_level_types: "demand/strong/fresh,supply/-/worn", liquidity_on: true, liquidity_levels: "3950:3951:pool" };
  const today = brokerKeyLevels(signal);
  assert.deepEqual(today, [{ low: 3905, high: 3907 }, { low: 3915, high: 3917 }, { low: 3950, high: 3951, source: "liquidity", kind: "pool" }]);
  assert.equal(JSON.stringify(brokerKeyLevels({ ...signal, key_level_types: undefined })), JSON.stringify(today), "the types change nothing without opts");
  assert.deepEqual(brokerKeyLevels(signal, { typed: true }), [
    { low: 3905, high: 3907, type: "demand", strength: "strong", freshness: "fresh" },
    { low: 3915, high: 3917, type: "supply", strength: null, freshness: "worn" },
    { low: 3950, high: 3951, source: "liquidity", kind: "pool", type: "none", strength: null, freshness: null }
  ]);
  assert.deepEqual(brokerKeyLevels({ ...signal, key_level_types: "demand/strong/fresh" }, { typed: true }), today, "a count mismatch attaches nothing");
  assert.deepEqual(brokerKeyLevels({ ...signal, key_level_types: undefined }, { typed: true }), today);
  assert.equal(typedLevels({ key_levels: "1:2", key_level_types: "bogus/x/y" })[0].type, "none", "unknown words read as none");
  assert.deepEqual([typedDecisive({ type: "demand", strength: "medium" }), typedDecisive({ type: "demand", strength: "weak" }), typedDecisive({ type: "mixed", strength: "strong" })], [true, false, false]);
});

// ------------------------------------------------------------------ the switch

test("Z3a-3 the switch: zone_mgmt off by default, validated, carried; in ERA_SWITCHES; zone_mgmt=omega is its era signature", () => {
  assert.equal(OMEGA_DEFAULTS.zone_mgmt, "off");
  assert.deepEqual([...ZONE_MGMT_MODES], ["off", "omega"]);
  assert.equal(settingsFrom({ zone_mgmt: "omega" }).settings.zone_mgmt, "omega");
  assert.equal(settingsFrom({ risk_pct: 1 }, { ...OMEGA_DEFAULTS, zone_mgmt: "omega" }).settings.zone_mgmt, "omega", "carried through another change");
  for (const bad of ["full", "omega_pm", "on", true, 1, ""]) assert.match(settingsFrom({ zone_mgmt: bad }).error, /zone_mgmt must be 'off' or 'omega'/, String(bad));
  assert.deepEqual([zoneMgmtOn({}), zoneMgmtOn(OMEGA_DEFAULTS), zoneMgmtOn({ zone_mgmt: "omega" }), zoneMgmtOn({ zone_mgmt: "garbage" })], [false, false, true, false]);
  assert.ok(ERA_SWITCHES.includes("zone_mgmt"));
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), [], "off by default: no era move at the merge");
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, zone_mgmt: "omega" }), ["zone_mgmt=omega"]);
  assert.deepEqual({ ...ZONE_GIVEBACK_R }, { scalp: 0.15, intraday: 0.25, range: 0.25, swing: 0.3 });
  assert.deepEqual([zoneGiveback({ mode: "scalp", r_dist: 10 }), zoneGiveback({ mode: "swing", r_dist: 10 }), zoneGiveback({ mode: null, r_dist: 10 }), zoneGiveback({ mode: "scalp" })], [1.5, 3, 2.5, null]);
  assert.equal(ZONE_MGMT_RATE_MS, PM_FAST_1M.intraday.rate_ms, "the fast layer's own 3 minutes");
});

// ------------------------------------------------------------------ keyLevelPlan under "omega"

test("Z3a-4 SL+ goes behind own demand within the cap and falls back beyond it; unknown R allows tighter only", () => {
  assert.deepEqual(todayPlan(), { sl: 3914.6, tp: null, band: "normal" }, "today: behind the last passed level (L4)");
  // L3 demand medium: behind it 3912.6, 2.00 looser than today's; intraday cap 0.25 x 10 = 2.50.
  assert.deepEqual(typedPlan({ 2: "demand/medium/tested" }), { sl: 3912.6, tp: null, band: "normal", sl_zone: true });
  assert.deepEqual(typedPlan({ 2: "demand/medium/tested" }, { meta: { mode: "swing", r_dist: 10 } }).sl, 3912.6, "swing cap 3.00");
  assert.deepEqual(typedPlan({ 2: "demand/medium/tested" }, { meta: { mode: "scalp", r_dist: 10 } }), { sl: 3914.6, tp: null, band: "normal" }, "scalp cap 1.50: beyond it, today's");
  assert.deepEqual(typedPlan({ 2: "demand/medium/tested" }, { meta: { mode: "intraday" } }), { sl: 3914.6, tp: null, band: "normal" }, "unknown R: looser never");
  // Equal (own demand is the last passed level): taken, but the price is today's, so no zone mark, R known or not.
  assert.deepEqual(typedPlan({ 3: "demand/strong/fresh" }), todayPlan());
  assert.deepEqual(typedPlan({ 3: "demand/strong/fresh" }, { meta: { mode: "intraday" } }), todayPlan());
  // Not own or not decisive: today's.
  for (const t of ["demand/weak/fresh", "supply/strong/fresh", "mixed/strong/fresh", NONE]) assert.deepEqual(typedPlan({ 2: t }), todayPlan(), t);
  // A short mirrors it: supply above, R 20 (cap 5.00).
  const SHORT = { ...LONG, side: "SELL", open_price: 3940, sl: 3960, tp: 3895 };
  const sig = { power: -0.3, position: SHORT, meta: { mode: "intraday", r_dist: 20 } };
  assert.equal(todayPlan({ power: -0.3, position: SHORT }).sl, 3928.4, "today: behind L5");
  assert.deepEqual(typedPlan({ 5: "supply/medium/fresh" }, sig), { sl: 3932.4, tp: null, band: "normal", sl_zone: true });
  assert.deepEqual(typedPlan({ 5: "demand/medium/fresh" }, sig), todayPlan({ power: -0.3, position: SHORT }), "demand is not a short's own");
});

test("Z3a-5 never below the lock; bands strong, normal and weak", () => {
  // L1 demand far behind, swing R 100 (cap 30): behind it would be 3904.6, under the gate's lock 3906: the lock.
  const locked = typedPlan({ 0: "demand/strong/fresh" }, { meta: { mode: "swing", r_dist: 100 }, lockPx: 3906 });
  assert.deepEqual(locked, { sl: 3906, tp: null, band: "normal", sl_zone: true });
  assert.ok(locked.sl >= 3906, "at or past the lock");
  // Without the gate the lock is break-even plus the buffer (3900.40): behind L1 (3904.6) stands.
  assert.equal(typedPlan({ 0: "demand/strong/fresh" }, { meta: { mode: "swing", r_dist: 100 } }).sl, 3904.6);
  // Strong: behind the own zone before the last (two needed). Own L4 and L2: behind L2 3911.1, 1.50 looser than today's 3912.6.
  assert.equal(todayPlan({ power: 0.6 }).sl, 3912.6);
  assert.deepEqual(typedPlan({ 1: "demand/medium/fresh", 3: "demand/strong/fresh" }, { power: 0.6 }), { sl: 3911.1, tp: null, band: "strong", sl_zone: true });
  assert.deepEqual(typedPlan({ 3: "demand/strong/fresh" }, { power: 0.6 }), todayPlan({ power: 0.6 }), "one own zone only: today's strong");
  // Weak: the tighter of the own zone and the 5m swing. No swing: behind L3; a swing at 3918: the swing both ways.
  assert.deepEqual(typedPlan({ 2: "demand/medium/fresh" }, { power: 0.1 }), { sl: 3912.6, tp: null, band: "weak", sl_zone: true });
  const swing = { m5_swing_low: 3918 };
  assert.deepEqual(typedPlan({ 2: "demand/medium/fresh" }, { power: 0.1, extra: swing }), todayPlan({ power: 0.1, extra: swing }));
  assert.equal(todayPlan({ power: 0.1, extra: swing }).sl, 3917.6);
  // Forward only: a typed stop not past the current stop is no move (and today's would have been).
  assert.equal(typedPlan({ 2: "demand/medium/fresh" }, { position: { ...LONG, sl: 3913 } }).sl, null);
  assert.equal(todayPlan({ position: { ...LONG, sl: 3913 } }).sl, 3914.6);
  // The reversed power still closes a winner whatever the types.
  assert.deepEqual(typedPlan({ 2: "demand/medium/fresh" }, { power: -0.7 }), { close: true, band: "reversed" });
});

test("Z3a-6 the trailing TP goes one zone further to a decisive opposing zone, never two; level_source is absent when unchanged", () => {
  const near = { ...LONG, tp: 3925 }; // 5.00 from the bid, within max(1.5, 0.6, 0.2 x 25 = 5)
  assert.deepEqual(todayPlan({ power: 0.6, position: near }), { sl: 3912.6, tp: 3926, band: "strong" }, "today: L5's near edge");
  assert.deepEqual(typedPlan({ 5: "supply/medium/fresh" }, { power: 0.6, position: near }), { sl: 3912.6, tp: 3930, band: "strong", tp_zone: true }, "L6 supply: one zone further");
  assert.deepEqual(typedPlan({ 6: "supply/strong/fresh" }, { power: 0.6, position: near }), todayPlan({ power: 0.6, position: near }), "L7 is two zones further: never");
  assert.deepEqual(typedPlan({ 4: "supply/strong/fresh", 5: "supply/strong/fresh" }, { power: 0.6, position: near }), todayPlan({ power: 0.6, position: near }), "L5 itself opposing: today's");
  assert.deepEqual(typedPlan({ 5: "demand/strong/fresh" }, { power: 0.6, position: near }), todayPlan({ power: 0.6, position: near }), "a demand zone is not opposing for a long");
  assert.deepEqual(typedPlan({ 5: "supply/weak/fresh" }, { power: 0.6, position: near }), todayPlan({ power: 0.6, position: near }), "weak is not decisive");
  // Every level typed none: the result deep-equals today's (no sl_zone, no tp_zone).
  assert.deepEqual(typedPlan({}, { power: 0.6, position: near }), todayPlan({ power: 0.6, position: near }));
  assert.deepEqual(typedPlan({}), todayPlan());
});

// ------------------------------------------------------------------ manageIntents and planIntents

const SETTINGS = Object.freeze({ ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false, profit_lock_gate: "legacy" });
const typedSignal = (at = { 2: "demand/medium/tested" }) => ({ ...SIGNAL, key_level_types: types(at) });
const manage = (settings, signal, over = {}) => manageIntents({ positions: [LONG], sym: SYM, settings, signal, now: NOW, positionMeta: { "open:1:B": META }, ...over });
// main fd22f97's manageIntents and planIntents over the untyped inputs below, taken on a git-archive of it.
const MAIN_MANAGE = '[{"id":"ms:7:k:391460","kind":"modify_sl","ticket":7,"sl":3914.6,"tp":3945,"reason":"sl_key_level_normal"}]';
const MAIN_PLAN = '{"intents":[{"id":"ms:7:k:391460","kind":"modify_sl","ticket":7,"sl":3914.6,"tp":3945,"reason":"sl_key_level_normal"}],"notes":[{"code":"no_side"}],"pm_dropped":[]}';
const EXECUTOR = Object.freeze({ connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", equity: 10_000, balance: 10_000, day_start_balance: 10_000 }, symbol: SYM, positions: [LONG] });
const plan = (settings, signal, over = {}) => planIntents({ signal, control: { mode: "active" }, settings, executor: EXECUTOR, now: NOW, engineEnabled: true, positionMeta: { "open:1:B": META }, ...over });

test("Z3a-7 zone_mgmt off with a typed signal: manageIntents and planIntents deep-equal the untyped run (main's byte for byte); 'omega' marks level_source 'zone'", () => {
  assert.equal(JSON.stringify(manage(SETTINGS, SIGNAL)), MAIN_MANAGE);
  assert.equal(JSON.stringify(manage(SETTINGS, typedSignal())), MAIN_MANAGE, "off: the types change nothing");
  assert.equal(JSON.stringify(plan(SETTINGS, SIGNAL)), MAIN_PLAN);
  assert.equal(JSON.stringify(plan(SETTINGS, typedSignal())), MAIN_PLAN);
  // With the TP ladder and the profit-lock gate at their defaults too.
  const defaults = { ...OMEGA_DEFAULTS, enabled: true };
  assert.deepEqual(plan(defaults, typedSignal(), { gates: { 7: { open: true } } }), plan(defaults, SIGNAL, { gates: { 7: { open: true } } }));
  const on = { ...SETTINGS, zone_mgmt: "omega" };
  assert.deepEqual(manage(on, typedSignal()), [{ id: "ms:7:k:391260", kind: "modify_sl", ticket: 7, sl: 3912.6, tp: 3945, reason: "sl_key_level_normal", level_source: "zone" }]);
  assert.deepEqual(plan(on, typedSignal()).intents, manage(on, typedSignal()));
  // 'omega' with an untyped signal, or types that change no price: today's intents, no level_source.
  assert.equal(JSON.stringify(manage(on, SIGNAL)), MAIN_MANAGE);
  assert.equal(JSON.stringify(manage(on, typedSignal({ 3: "demand/strong/fresh" }))), MAIN_MANAGE);
  // The trailing TP's intent carries it too (the ladder's outward hold aside).
  const tpOut = manageIntents({ positions: [{ ...LONG, tp: 3925 }], sym: SYM, settings: on, signal: { ...typedSignal({ 5: "supply/medium/fresh" }), power: 0.6 }, now: NOW, positionMeta: { "open:1:B": META } });
  assert.deepEqual(tpOut.find((i) => i.kind === "modify_tp"), { id: "mt:7:393000", kind: "modify_tp", ticket: 7, tp: 3930, reason: "trail_tp_key_level", level_source: "zone" });
  assert.equal("level_source" in tpOut.find((i) => i.kind === "modify_sl"), false, "the stop the typing did not move has none");
  // Under the TP ladder (default) the outward move still waits for the TP1 lock (unchanged): with no closed candle for a
  // ladder lock and the stop below TP1 (3905), the typed target move is dropped as today's is.
  const lad = (signal, settings) => manageIntents({ positions: [{ ...LONG, tp: 3925 }], sym: SYM, settings: { ...settings, tp_ladder: true }, signal, now: NOW, positionMeta: { "open:1:B": META }, candles: {} });
  const ladTyped = lad({ ...typedSignal({ 5: "supply/medium/fresh" }), power: 0.6 }, on);
  assert.equal(ladTyped.some((i) => i.kind === "modify_tp"), false);
  assert.deepEqual(ladTyped, lad({ ...SIGNAL, power: 0.6 }, SETTINGS), "the stop the typing did not move: today's plan");
  // The bridge's intents file is the same text with or without the field.
  const it = manage(on, typedSignal())[0];
  const { level_source, ...bare } = it;
  assert.equal(formatIntentsText([it], 1), formatIntentsText([bare], 1));
});

test("Z3a-8 one modify per position per 3 minutes: a fast action in the window leaves the typing out (today's management)", () => {
  const on = { ...SETTINGS, zone_mgmt: "omega" };
  const minute = Math.floor(NOW / M1);
  // A fast action decided at its bar's close (minute + 1): 1 minute ago holds; 3 minutes ago does not.
  for (const id of [`pm1:7:${minute - 2}`, `d:pm1:7:${minute - 2}`, `pm1:7:${minute - 3}:2`]) {
    assert.equal(JSON.stringify(manage(on, typedSignal(), { recentIntentIds: [id] })), MAIN_MANAGE, id);
  }
  assert.equal(manage(on, typedSignal(), { recentIntentIds: [`pm1:7:${minute - 4}`] })[0].level_source, "zone", "3 minutes past: typed again");
  assert.equal(manage(on, typedSignal(), { recentIntentIds: [`pm1:8:${minute - 1}`] })[0].level_source, "zone", "another position's fast action");
  // In the same plan a fast intent of the position already skips Omega's routine management (planIntents' skipTickets).
  const fast = { id: `pm1:7:${minute - 1}`, ticket: 7, action: "sl", rule: "pm_fast_cut", sl: 3905 };
  const p = plan(on, typedSignal(), { pmActions: [fast] });
  assert.deepEqual(p.intents.map((i) => [i.id, i.reason, i.level_source ?? null]), [[`pm1:7:${minute - 1}`, "pm_fast_cut", null]]);
});

test("Z3a-9 the fast layer: a zone-driven move holds a fast action for 3 minutes (rate only, never the hysteresis); none given is today's", () => {
  const input = fastCases().find(([n]) => n === "tp/gate_open_lock")[1];
  const lastT = input.bars.at(-1).t;
  const plain = fastProtect(input);
  assert.equal(plain.status, "act");
  const held = fastProtect({ ...input, history: [{ bar_ms: lastT - 2 * M1, branch: "zone" }] });
  assert.equal(held.status, "held");
  assert.match(held.why, /held: a zone-driven stop or target move went out at \d\d:\d\d UTC: at most one modify per 3 minutes across the fast layer and zone management$/);
  assert.deepEqual(fastProtect({ ...input, history: [{ bar_ms: lastT - 3 * M1, branch: "zone" }] }), plain, "3 minutes later: acts");
  assert.deepEqual(fastProtect({ ...input, history: [{ bar_ms: lastT - 6 * M1, branch: "zone" }] }), plain, "no hysteresis from a zone move");
  assert.equal(fastProtect({ ...input, history: [{ bar_ms: lastT - 6 * M1, branch: "cut" }] }).status, "held", "the other fast trigger's hysteresis is unchanged");
  assert.deepEqual(fastProtect({ ...input, history: [] }), plain);
});

// The Omega sync end to end over a sqlite D1 (as test/pm-fast.test.mjs F8).
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const SYNC_NOW = T0 + 40 * M1 + 2000;
const BUY_POS = { ticket: 101, symbol: "XAUUSD", side: "BUY", volume: 0.01, open_price: 2000, sl: 1990, tp: 2016, intent_id: "open:1:B", magic: 920200, source: "omega", opened_ms: T0 };
const STATE = () => ({
  connected: true, server: "AnyBroker-Demo", received_ms: SYNC_NOW - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 2013.2, ask: 2013.4, spread_points: 20 },
  positions: [BUY_POS]
});
function syncEnv() {
  resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests(); resetLiquiditySchemaForTests();
  return { DB: sqliteD1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true" };
}
const sync = (e, now = SYNC_NOW) => bridgeSync(e, { state: STATE(), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0" }, { now, signal: null });
async function readyWith(e, zoneMgmt, zoneAgoMs = null) {
  await sync(e, SYNC_NOW - 30_000);
  await writeSettings(e, { body: { enabled: true, zone_mgmt: zoneMgmt }, actor: "owner" }, { now: SYNC_NOW - 20_000 });
  e.DB.raw.prepare("INSERT OR IGNORE INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES ('open:1:B', 'open', ?, 'done', ?, ?)")
    .run(JSON.stringify({ kind: "open", side: "BUY", volume: 0.01, entry: 2000, sl: 1990, tp: 2016, r_dist: 10, mode: "intraday", strategy: "zone_pullback" }), T0, T0);
  if (zoneAgoMs != null) {
    const it = { id: "ms:101:k:200500", kind: "modify_sl", ticket: 101, sl: 2005, tp: 2016, reason: "sl_key_level_normal", level_source: "zone" };
    e.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES (?, 'modify_sl', ?, 'done', ?, ?)").run(it.id, JSON.stringify(it), SYNC_NOW - zoneAgoMs, SYNC_NOW - zoneAgoMs);
  }
  const ref = JSON.parse(e.DB.raw.prepare("SELECT state FROM omega_bridge WHERE id = 1").get().state).account_ref;
  e.DB.raw.exec("CREATE TABLE IF NOT EXISTS broker_bars_1m (account_ref TEXT NOT NULL, source TEXT NOT NULL, minute_ms INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, tick_volume INTEGER, spread_points INTEGER, digits INTEGER, connection_version INTEGER, received_ms INTEGER NOT NULL, legacy_ref INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_ref, source, minute_ms))");
  const ins = e.DB.raw.prepare("INSERT OR REPLACE INTO broker_bars_1m VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, 0)");
  tpBuyBars().forEach((b, i) => ins.run(ref, corpusSource("AnyBroker-Demo", "XAUUSD"), b.t, b.o, b.h, b.l, b.c, b.s ?? 20, 2, 90 + (i % 3), b.t + M1 + 1500));
}
const fastRow = (e) => e.DB.raw.prepare("SELECT action, rule, status, why FROM position_actions WHERE id LIKE 'pm1:%'").get();

test("Z3a-10 the live sync: a zone-driven move of the last 3 minutes holds the 1m fast action (one modify per 3 minutes covers both); off, or older, the fast layer acts as today", async () => {
  const on = syncEnv();
  await readyWith(on, "omega", 60_000);
  await sync(on);
  const held = fastRow(on);
  assert.deepEqual([held.action, held.rule, held.status], ["hold", "pm_fast_tp", "noted"]);
  assert.match(held.why, /a zone-driven stop or target move went out at 09:39 UTC: at most one modify per 3 minutes/);
  assert.equal(on.DB.raw.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE id LIKE 'pm1:%'").get().n, 0);
  // zone_mgmt off: the zone row is never read; the fast layer acts (today's sync).
  const off = syncEnv();
  await readyWith(off, "off", 60_000);
  await sync(off);
  assert.deepEqual([fastRow(off).action, fastRow(off).status], ["tp", "applied"]);
  // A zone move more than 3 minutes before: acts.
  const old = syncEnv();
  await readyWith(old, "omega", 4 * 60_000);
  await sync(old);
  assert.deepEqual([fastRow(old).action, fastRow(old).status], ["tp", "applied"]);
});

// ------------------------------------------------------------------ v4

/**
 * A SELL from 2000 (stop 2020, intraday) that drops through two levels in one minute (12:06-12:07): L_c 1989-1990
 * (none) and L_b 1992.5-1993.5, typed supply in the typed decisions. Today's SL+ goes behind L_c; typed, behind L_b.
 */
function v4Case(typed) {
  const words = (t) => (typed ? { zone_type: t, zone_strength: t === "none" ? null : "medium", zone_freshness: "tested", zone_rank: "candidate" } : {});
  const lv = [{ low: 1989, high: 1990, ...words("none") }, { low: 1992.5, high: 1993.5, ...words("supply") }];
  const d = (close, over) => dec(decision({ close, mode: "intraday", lv, score: -0.3, ...over }));
  const price = lerp([[C + 3 * M1, 2000], [C + 6 * M1, 1996], [C + 7 * M1, 1986], [C + 50 * M1, 1984]]);
  return {
    bars: path(C - WARM, C + 50 * M1, price, 0.05), to: C + 50 * M1,
    decisions: [d(C, { trade: sellTrade(2000, 2020, 1960) }), d(C + 15 * M1, { stance: "WAIT", decidedAfter: M1 }), d(C + 30 * M1, { stance: "WAIT", decidedAfter: M1 })]
  };
}
const replay = (typed, zoneMgmt) => {
  const trace = [];
  const run = replayOmega4({ ...base(), ...v4Case(typed), settings: { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false, profit_lock_gate: "legacy", pm_fast_1m: "off", zone_mgmt: zoneMgmt }, trace });
  return { run, trace };
};

test("Z3a-11 v4: a typed decision's replay at 'omega' reproduces the live planIntents (zone intents included); at 'off' its outputs are the untyped replay's", () => {
  const on = replay(true, "omega");
  const zoned = on.trace.filter((t) => t.output.intents.some((i) => i.level_source === "zone"));
  assert.ok(zoned.length >= 1, "the typing moved a stop in the replay");
  assert.equal(zoned[0].input.signal.key_level_types, "none/-/tested,supply/medium/tested", "v4 rebuilds key_level_types from the stored key_levels");
  // The live engine on the same input gives the same plan (v4 is planIntents on the stored decision's signal).
  for (const t of on.trace) assert.deepEqual(planIntents(t.input), t.output);
  // The typed SL+ sits behind the supply zone (1993.5 plus the buffer), not behind the last level (1990 plus it).
  const z = zoned[0].output.intents.find((i) => i.level_source === "zone");
  assert.deepEqual([z.kind, z.sl, z.reason, new Date(zoned[0].now).toISOString().slice(11, 16)], ["modify_sl", 1993.9, "sl_key_level_normal", "12:07"]);
  const offMove = replay(true, "off").trace.find((t) => t.now === zoned[0].now).output.intents.find((i) => i.kind === "modify_sl");
  assert.deepEqual([offMove.sl, "level_source" in offMove], [1990.4, false], "off: behind L_c, today's");
  // Off: the outputs and records of the typed decisions are the untyped decisions' (only the input signal carries the words).
  const offTyped = replay(true, "off"), offPlain = replay(false, "off");
  assert.deepEqual(offTyped.trace.map((t) => [t.now, t.output]), offPlain.trace.map((t) => [t.now, t.output]));
  assert.deepEqual(offTyped.run.records, offPlain.run.records);
  assert.equal(JSON.stringify(offTyped.trace.map((t) => t.output)).includes("level_source"), false);
  assert.notDeepEqual(on.trace.map((t) => t.output), offTyped.trace.map((t) => t.output), "not vacuous: the typing changed the plan");
});

// ------------------------------------------------------------------ era, FS1 row, audit line, Aether

test("Z3a-12 the era: carried at the merge (off, a new code hash); the owner's flip to 'omega' starts a new era at the settings' updated_ms", async () => {
  const T = Date.parse("2026-11-26T08:00:00Z");
  const stored = { behaviour_hash: ENGINE_BEHAVIOUR_HASH, code_hash: "6c0f8142fca57b7ae1f7f671b1e0c540df01a0139ed92917fa6af95a65c70162", switches: [], since_ms: T - 86_400_000, reason: "behaviour change", previous: [], carried: [] };
  const merged = nextEra(stored, { switches: eraSwitches(OMEGA_DEFAULTS), now: T });
  assert.deepEqual([merged.era.since_ms, merged.events], [stored.since_ms, ["era carried (behaviour identical)"]]);
  const flipped = nextEra(merged.era, { switches: eraSwitches({ ...OMEGA_DEFAULTS, zone_mgmt: "omega" }), switchesMs: T + 3_600_000, now: T + 3_900_000 });
  assert.deepEqual([flipped.era.since_ms, flipped.era.switches, flipped.era.reason], [T + 3_600_000, ["zone_mgmt=omega"], "switch on: zone_mgmt=omega"]);
  // Through FS1's Omega row (the settings page's own write path): the era starts at that save's updated_ms.
  resetFeatureSwitchMemoForTests(); resetOmegaBrokerSchemaForTests();
  const env = { OWNER_ACCESS_SUB: "owner-sub", SIGNAL_CACHE: kv(), DB: d1() };
  await readSettings(env);
  await eraStep(env, { now: T - 3_600_000 });
  assert.equal((await setFeatureSwitch(env, { key: "zone_mgmt", value: "omega", actor: "owner@example.com", actor_sub: "owner-sub", now: T })).ok, true);
  const { era } = await eraStep(env, { now: T + 600_000 });
  assert.deepEqual([era.since_ms, era.switches], [T, ["zone_mgmt=omega"]]);
});

test("Z3a-13 the FS1 row: an Omega owner setting read through omega_settings, written by the page's path, told by the change audit", async () => {
  const e = switchByKey("zone_mgmt");
  assert.deepEqual([e.group, e.worker, e.write, e.resolve, e.era_switch, e.default_value, e.config_value, [...e.values], e.restarts_mode_evidence, e.emergency_stop, e.read_only],
    ["omega", "omega", "omega-settings", "omega-settings", true, "off", null, ["off", "omega"], false, false, false]);
  // Z6's zone_sd follows it, the last Omega row.
  assert.deepEqual(FEATURE_SWITCHES.slice(-2).map((x) => x.key), ["zone_mgmt", "zone_sd"]);
  resetFeatureSwitchMemoForTests(); resetOmegaBrokerSchemaForTests();
  const T = Date.parse("2026-11-26T08:00:00Z"), OWNER = "owner-sub";
  const env = { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: kv(), DB: d1() };
  await readSettings(env);
  const row0 = (await featureSwitchesPayload(env, { now: T })).switches.find((x) => x.key === "zone_mgmt");
  assert.deepEqual([row0.value, row0.source, row0.set_by, row0.values], ["off", "default", null, ["off", "omega"]]);
  // The audit sweep's first run starts at the newest row; then the owner's flip is one line.
  const sent = [];
  await runAuditNotify(env, { now: T, send: async (t) => sent.push(t) });
  assert.equal((await setFeatureSwitch(env, { key: "zone_mgmt", value: "full", actor_sub: OWNER, now: T + 1 })).error, "invalid_value");
  assert.equal((await setFeatureSwitch(env, { key: "zone_mgmt", value: "omega", actor_sub: "someone-else", now: T + 1 })).error, "owner_only");
  const saved = await setFeatureSwitch(env, { key: "zone_mgmt", value: "omega", actor: "owner@example.com", actor_sub: OWNER, now: T + 1000 });
  assert.deepEqual([saved.ok, saved.changed, saved.audit, saved.switch.value, saved.switch.source, saved.switch.set_by], [true, true, "settings", "omega", "override", "owner"]);
  const stored = await readSettings(env);
  assert.deepEqual([stored.settings.zone_mgmt, stored.updated_ms], ["omega", T + 1000]);
  assert.equal((await setFeatureSwitch(env, { key: "zone_mgmt", value: "omega", actor_sub: OWNER, now: T + 2000 })).changed, false);
  await runAuditNotify(env, { now: T + 5 * 60_000, send: async (t) => sent.push(t) });
  assert.equal(sent.length, 1, sent.join("\n"));
  assert.match(sent[0], /zone-typed management: off → omega/);
  assert.doesNotMatch(sent[0], /@|owner-sub/);
  // Reset goes to OMEGA_DEFAULTS ("off").
  const back = await setFeatureSwitch(env, { key: "zone_mgmt", reset: true, actor_sub: OWNER, now: T + 10 * 60_000 });
  assert.deepEqual([back.switch.value, back.switch.source, (await readSettings(env)).settings.zone_mgmt], ["off", "default", "off"]);
});

const deal = (i, profit, at) => ({ deal_ticket: 1000 + i, position_ticket: 2000 + i, mode: "demo", side: "BUY", volume: 0.01, entry_price: 1, exit_price: 1, profit, commission: 0, swap: 0, reason: profit > 0 ? "tp" : "sl", opened_ms: at - 60_000, closed_ms: at, source: "omega" });

test("Z3a-14 owner-only: Aether's policy write and its rollback carry the stored zone_mgmt and never write it", async () => {
  const T = Date.parse("2026-11-12T10:00:00Z");
  resetOmegaBrokerSchemaForTests(); resetEaExecutionSchemaForTests();
  const env = { DB: sqliteD1(), SIGNAL_CACHE: kv(), OMEGA_POLICY_AUTO: "true" };
  for (let i = 0; i < 50; i++) await storeDeal(env, deal(i, i % 3 === 0 ? -1 : 1, T - (100 - i) * 60_000), { now: T });
  assert.equal((await writeSettings(env, { body: { zone_mgmt: "omega" }, actor: "owner" }, { now: T - 30_000 })).ok, true);
  // A pack that names zone_mgmt is ignored for it: the policy writes the risk fields only.
  await env.SIGNAL_CACHE.put(OMEGA_POLICY_KEY, JSON.stringify({ doctrine_sha: "z".repeat(64), risk_pct: 0.4, max_positions: 2, zone_mgmt: "off" }));
  assert.equal((await applyOmegaPolicy(env, { now: T })).status, "applied");
  let s = (await readSettings(env)).settings;
  assert.deepEqual([s.zone_mgmt, s.risk_pct], ["omega", 0.4]);
  // The owner sets it off after the policy; 50 losing trades roll the policy back: zone_mgmt stays the owner's "off".
  await writeSettings(env, { body: { zone_mgmt: "off" }, actor: "owner" }, { now: T + 60_000 });
  const applied = JSON.parse(env.SIGNAL_CACHE.m.get(OMEGA_POLICY_APPLIED_KEY));
  await env.SIGNAL_CACHE.put(OMEGA_POLICY_APPLIED_KEY, JSON.stringify({ ...applied, from: { ...applied.from, zone_mgmt: "omega" } }));
  for (let i = 0; i < 50; i++) await storeDeal(env, deal(100 + i, i % 2 === 0 ? -1 : 0.5, T + (i + 2) * 60_000), { now: T });
  const r = await applyOmegaPolicy(env, { now: T + 7_200_000 });
  assert.equal(r.status, "rolled_back");
  s = (await readSettings(env)).settings;
  assert.deepEqual([s.zone_mgmt, s.risk_pct, (await readSettings(env)).updated_by], ["off", 0.5, "aether-rollback"]);
  // And the other way round: the owner's "omega" survives the rollback too.
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/delete (back|body)\.zone_mgmt;/g) ?? []).length, 2, "both paths strip it");
});

// ------------------------------------------------------------------ Z5's flag line

test("Z3a-15 the typing flag line: once per KEY_LEVEL_ZONE_TYPES or ZONE_SOURCES_OFF toggle while zone_mgmt is not off; never while off", async () => {
  assert.equal(typingFlagLine({ types: "on", sources_off: [] }, { types: "on", sources_off: [] }, "omega"), null);
  assert.equal(typingFlagLine({ types: "on", sources_off: [] }, { types: "off", sources_off: [] }, "off"), null);
  assert.match(typingFlagLine({ types: "on", sources_off: [] }, { types: "off", sources_off: ["gmi_ob"] }, "omega"), /^XAUUSD ZONES: the decision-side zone typing changed \(KEY_LEVEL_ZONE_TYPES on → off; ZONE_SOURCES_OFF none → gmi_ob\) while zone_mgmt is omega: .* No action taken\.$/);
  assert.deepEqual(typingSignature({ ZONE_SOURCES_OFF: "whale, gmi_ob" }), { types: "on", sources_off: ["whale", "gmi_ob"] });
  resetZoneReadingsSchemaForTests(); resetOmegaBrokerSchemaForTests();
  const T = Date.parse("2026-11-26T08:00:00Z");
  const db = d1(), cache = kv();
  const base0 = { DB: db, SIGNAL_CACHE: cache, ZONE_READINGS: "on" };
  await ensureZoneReadingsSchema(db);
  await readSettings(base0);
  await writeSettings(base0, { body: { zone_mgmt: "omega" }, actor: "owner" }, { now: T - 1000 });
  const sent = [];
  const tick = async (env, now, send = async (t) => sent.push(t)) => runZoneBreaker({ ...base0, ...env }, { now, send, force: true });
  await tick({}, T);
  assert.deepEqual(JSON.parse(cache.m.get(ZONE_BREAKER_KEY)).typing, { types: "on", sources_off: [] }, "the first tick only records the signature");
  assert.deepEqual(sent.filter((t) => /zone typing/.test(t)), []);
  await tick({ KEY_LEVEL_ZONE_TYPES: "off" }, T + 3_600_000);
  await tick({ KEY_LEVEL_ZONE_TYPES: "off" }, T + 7_200_000);
  assert.equal(sent.filter((t) => /zone typing changed \(KEY_LEVEL_ZONE_TYPES on → off\)/.test(t)).length, 1, "once per toggle");
  // A failed send is told again at the next tick.
  await tick({ KEY_LEVEL_ZONE_TYPES: "off", ZONE_SOURCES_OFF: "gmi_ob" }, T + 3 * 3_600_000, async () => { throw new Error("telegram down"); });
  await tick({ KEY_LEVEL_ZONE_TYPES: "off", ZONE_SOURCES_OFF: "gmi_ob" }, T + 4 * 3_600_000);
  assert.equal(sent.filter((t) => /ZONE_SOURCES_OFF none → gmi_ob/.test(t)).length, 1);
  // zone_mgmt off: a toggle says nothing (and is recorded, so it is not told later either).
  await writeSettings(base0, { body: { zone_mgmt: "off" }, actor: "owner" }, { now: T + 5 * 3_600_000 });
  await tick({}, T + 6 * 3_600_000);
  await writeSettings(base0, { body: { zone_mgmt: "omega" }, actor: "owner" }, { now: T + 7 * 3_600_000 });
  await tick({}, T + 8 * 3_600_000);
  assert.equal(sent.filter((t) => /zone typing/.test(t)).length, 2);
  // The breaker never writes zone_mgmt.
  assert.equal((await readSettings(base0)).settings.zone_mgmt, "omega");
});

// ------------------------------------------------------------------ hashes

test("Z3a-16 the hashes: V14 holds unedited (untyped fixtures at defaults); ENGINE_CODE gains typedLevels and the code hash moves", async () => {
  assert.equal(await sha256Hex(engineBehaviourSource()), ENGINE_BEHAVIOUR_HASH);
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.notEqual(ENGINE_CODE_HASH, "6c0f8142fca57b7ae1f7f671b1e0c540df01a0139ed92917fa6af95a65c70162");
  for (const n of ["typedLevels", "typedDecisive", "zoneGiveback", "zoneMgmtOn", "ZONE_MGMT_MODES", "ZONE_GIVEBACK_R", "ZONE_MGMT_RATE_MS", "keyLevelPlan", "brokerKeyLevels", "manageIntents", "settingsFrom", "OMEGA_DEFAULTS"]) assert.ok(ENGINE_CODE["omega-engine"][1].includes(n), n);
  assert.ok(ENGINE_CODE["ea-signal"][1].includes("managementFields"));
  assert.ok(ENGINE_CODE["pm-fast"][1].includes("zoneBarMs"));
  assert.match(engineCodeSource(), /omega-engine\.typedLevels=function typedLevels/);
  assert.ok(sha(engineCodeSource()).length === 64);
});
