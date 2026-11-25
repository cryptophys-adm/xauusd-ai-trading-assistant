// ZN1 (the Nexus page Intelligence > Zones): GET /api/zones' breaker.held[] entries carry since/until (the same values
// FS1's zone_hold shows, one reader: zoneHoldTimes) and effective (zoneHoldEffective: whether the hold changes a
// decision right now under the env in force, FS1 overrides applied, exactly as applyZoneHolds decides).
import test from "node:test";
import assert from "node:assert/strict";
import { zonesView, zoneHoldEffective, zoneHoldTimes, zoneHoldCurrent, applyZoneHolds, ZONE_BREAKER_KEY, ZONE_HOLDABLE } from "../src/zone-readings.mjs";
import { featureSwitchesPayload, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import { FEATURE_SWITCH_OVERRIDE_KEY } from "../src/feature-switches.mjs";
import { ruleVersionOf } from "../src/mode-shadow.mjs";
import { d1, kv, NOW } from "./fixtures/mode-shadow.mjs";

const HOUR = 3600_000, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const BASE = Object.freeze({ ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "stop,factor" });
const hold = (by, rv, at = NOW - HOUR) => ({ by, since: iso(at), until: iso(at + 7 * DAY), rule_version: rv });

test("ZN1-1 zonesView and featureSwitchesPayload show the same since/until for the same hold, from one KV fixture; the entry's keys are additive", async () => {
  const rv = ruleVersionOf(BASE);
  const store = kv();
  await store.put(ZONE_BREAKER_KEY, JSON.stringify({ checked_at: iso(NOW - HOUR), rule_version: rv, held: { zone_ahead: hold(["typing"], rv), tp: hold(["rule:tp_typed"], rv, NOW - 2 * HOUR) }, checks: null }));
  resetFeatureSwitchMemoForTests();
  const env = { ...BASE, DB: d1(), SIGNAL_CACHE: store };
  const v = await zonesView(env, { now: NOW });
  resetFeatureSwitchMemoForTests();
  const p = await featureSwitchesPayload(env, { now: NOW });
  const row = (k) => p.switches.find((r) => r.key === k).zone_hold;
  const fs = { zone_ahead: row("ZONE_AHEAD_MODE"), tp: row("ZONE_AIM_OFF").tp };
  assert.deepEqual(v.breaker.held.map((h) => h.rule), ["zone_ahead", "tp"]);
  for (const h of v.breaker.held) {
    assert.deepEqual(Object.keys(h), ["rule", "by", "since", "until", "effective"], h.rule);
    assert.deepEqual([h.since, h.until], [fs[h.rule].since, fs[h.rule].until], `${h.rule}: the same since/until as FS1`);
    assert.deepEqual(zoneHoldTimes(JSON.parse(await store.get(ZONE_BREAKER_KEY)).held[h.rule]), { since: h.since, until: h.until });
    assert.equal(h.effective, true, `${h.rule}: its switch is on`);
    assert.equal(typeof h.effective, "boolean");
  }
  assert.deepEqual([v.breaker.held[1].since, v.breaker.held[1].until], [iso(NOW - 2 * HOUR), iso(NOW - 2 * HOUR + 7 * DAY)]);
  // The reader on odd stored holds: null where a time is missing or not a string.
  for (const x of [null, undefined, true, "x", {}, { since: 5, until: null }]) assert.deepEqual(zoneHoldTimes(x), { since: null, until: null }, JSON.stringify(x));
});

test("ZN1-2 effective under the env with FS1's overrides applied: an owner's ZONE_AIM_OFF override containing tp makes a tp hold not effective", async () => {
  const store = kv();
  // A hold stored without a rule version (applyZoneHolds applies those on any), so only the switch decides.
  await store.put(ZONE_BREAKER_KEY, JSON.stringify({ held: { zone_ahead: { by: ["block"] }, tp: { by: ["rule:tp_typed"] } } }));
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ ZONE_AIM_OFF: { value: "tp", actor: "owner", at: iso(NOW) }, ZONE_PRIORITY: { value: "on", actor: "owner", at: iso(NOW) } }));
  resetFeatureSwitchMemoForTests();
  const v = await zonesView({ ZONE_PRIORITY: "off", ZONE_AIM_OFF: "", DB: d1(), SIGNAL_CACHE: store }, { now: NOW });
  assert.deepEqual(v.breaker.held.map((h) => [h.rule, h.effective, h.since, h.until]), [["zone_ahead", true, null, null], ["tp", false, null, null]]);
  resetFeatureSwitchMemoForTests();
});

test("ZN1-3 zoneHoldEffective: each holdable rule under its switch on and off, the rule version, ZONE_READINGS, and exactly applyZoneHolds' decision", () => {
  const h = { by: ["typing"] };
  const on = { ZONE_PRIORITY: "on", ZONE_AHEAD_MODE: "trend", ZONE_AIM_OFF: "" };
  for (const rule of ZONE_HOLDABLE) assert.equal(zoneHoldEffective(on, rule, h), true, `${rule}: on`);
  // zone_ahead: 'trend' and 'all' check; 'record', 'off', ZONE_PRIORITY off or KEY_LEVEL_ZONE_TYPES off do not.
  assert.equal(zoneHoldEffective({ ...on, ZONE_AHEAD_MODE: "all" }, "zone_ahead", h), true);
  for (const e of [{ ZONE_AHEAD_MODE: "record" }, { ZONE_AHEAD_MODE: "off" }, { ZONE_PRIORITY: "off" }, { KEY_LEVEL_ZONE_TYPES: "off" }]) assert.equal(zoneHoldEffective({ ...on, ...e }, "zone_ahead", h), false, JSON.stringify(e));
  // tp, stop, factor: off when their token is in ZONE_AIM_OFF, and all off under ZONE_PRIORITY off or untyped zones.
  for (const t of ["tp", "stop", "factor"]) {
    assert.equal(zoneHoldEffective({ ...on, ZONE_AIM_OFF: t }, t, h), false, `${t} in ZONE_AIM_OFF`);
    assert.equal(zoneHoldEffective({ ...on, ZONE_AIM_OFF: ["tp", "stop", "factor"].filter((x) => x !== t).join(",") }, t, h), true, `${t} the only rule on`);
    assert.equal(zoneHoldEffective({ ...on, ZONE_PRIORITY: "off" }, t, h), false, `${t}: ZONE_PRIORITY off`);
    assert.equal(zoneHoldEffective({ ...on, KEY_LEVEL_ZONE_TYPES: "off" }, t, h), false, `${t}: untyped zones`);
    assert.equal(zoneHoldEffective({ ...on, ZONE_AIM_OFF: "tp,stop,factor" }, t, h), false, `${t}: Z2b inert`);
  }
  // The brief's example: a tp hold while ZONE_AIM_OFF already has tp off.
  assert.equal(zoneHoldEffective({ ...on, ZONE_AIM_OFF: "tp,stop" }, "tp", h), false);
  // The rule version: a hold made on another one is not applied (the owner's change wins); none, or the same, is.
  const rv = ruleVersionOf(on);
  assert.equal(zoneHoldEffective(on, "zone_ahead", { ...h, rule_version: rv }), true);
  assert.equal(zoneHoldEffective(on, "zone_ahead", { ...h, rule_version: "tp1_kz:on" }), false);
  // ZONE_READINGS off: no hold reaches a decision. Unknown rules and empty holds: false.
  for (const rule of ZONE_HOLDABLE) assert.equal(zoneHoldEffective({ ...on, ZONE_READINGS: "off" }, rule, h), false, rule);
  assert.equal(zoneHoldEffective(on, "something_else", h), false);
  assert.equal(zoneHoldEffective(on, "tp", null), false);
  // Exactly applyZoneHolds' decision, rule by rule, over a grid of switches.
  const grid = [];
  for (const ZONE_PRIORITY of ["on", "off"]) for (const ZONE_AHEAD_MODE of ["trend", "all", "record", "off"]) for (const ZONE_AIM_OFF of ["", "tp", "stop", "factor", "tp,stop", "stop,factor", "tp,stop,factor"]) for (const KEY_LEVEL_ZONE_TYPES of ["on", "off"]) grid.push({ ZONE_PRIORITY, ZONE_AHEAD_MODE, ZONE_AIM_OFF, KEY_LEVEL_ZONE_TYPES });
  const all = Object.fromEntries(ZONE_HOLDABLE.map((r) => [r, h]));
  for (const e of grid) {
    const applied = applyZoneHolds(e, all).held.map((x) => x.rule);
    assert.deepEqual(ZONE_HOLDABLE.filter((r) => zoneHoldEffective(e, r, h)), applied, JSON.stringify(e));
  }
  // Pure: the env is never written.
  const frozen = Object.freeze({ ...on });
  zoneHoldEffective(frozen, "tp", h);
  assert.deepEqual(frozen, on);
});

test("ZN1-4 a hold made on an older rule version shows in neither zonesView.held[] nor FS1's zone_hold (one filter: zoneHoldCurrent); a hold with no rule_version shows in both", async () => {
  const rv = ruleVersionOf(BASE), old = "tp1_kz:on";
  assert.notEqual(rv, old);
  const store = kv();
  await store.put(ZONE_BREAKER_KEY, JSON.stringify({ checked_at: iso(NOW - HOUR), rule_version: rv, held: { zone_ahead: hold(["typing"], old), tp: hold(["rule:tp_typed"], rv), stop: { by: ["rule:stop_typed"], since: iso(NOW - HOUR), until: iso(NOW - HOUR + 7 * DAY) } }, checks: null }));
  resetFeatureSwitchMemoForTests();
  const env = { ...BASE, DB: d1(), SIGNAL_CACHE: store };
  const v = await zonesView(env, { now: NOW });
  resetFeatureSwitchMemoForTests();
  const p = await featureSwitchesPayload(env, { now: NOW });
  const row = (k) => p.switches.find((r) => r.key === k).zone_hold;
  // zonesView: the old-version zone_ahead hold is gone; tp (current) and stop (no version) remain.
  assert.deepEqual(v.breaker.held.map((h) => h.rule), ["tp", "stop"]);
  // FS1: the same set.
  assert.equal(row("ZONE_AHEAD_MODE"), null, "FS1 hides the old-version hold");
  assert.deepEqual(Object.keys(row("ZONE_AIM_OFF")).sort(), ["stop", "tp"]);
  for (const h of v.breaker.held) assert.deepEqual([h.since, h.until], [row("ZONE_AIM_OFF")[h.rule].since, row("ZONE_AIM_OFF")[h.rule].until], h.rule);
  // The filter itself.
  assert.equal(zoneHoldCurrent({ rule_version: rv }, rv), true);
  assert.equal(zoneHoldCurrent({ rule_version: old }, rv), false);
  assert.equal(zoneHoldCurrent({}, rv), true);
  for (const x of [null, undefined, "x", 3]) assert.equal(zoneHoldCurrent(x, rv), false);
});
