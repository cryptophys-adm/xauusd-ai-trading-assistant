// FS1 (owner 2026-11-25, relayed: "supaya bisa dikontrol perlu panel khusus pengaturan on off untuk semua fitur ini"): one
// owner control surface for every feature switch. The registry (src/feature-switches.mjs), the override store and its env
// copy, the GET payload and the owner's POST (src/feature-switch-store.mjs), SV1b's single store (src/agent-veto.mjs), the
// Omega settings rows through the settings page's own write path, the Omega Worker's routes and the AI Worker's wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import {
  FEATURE_SWITCHES, FEATURE_SWITCH_GROUPS, FEATURE_SWITCHES_VERSION, FEATURE_SWITCH_OVERRIDE_KEY, FEATURE_SWITCH_VETO_MIGRATION_KEY, FEATURE_SWITCH_MEMO_MS,
  switchByKey, readSwitch, envForm, normalizeValue, overridePatch, resolveEnvSwitch, isTokens, roleWord
} from "../src/feature-switches.mjs";
import { withFeatureSwitches, featureSwitchesPayload, setFeatureSwitch, resetFeatureSwitchMemoForTests } from "../src/feature-switch-store.mjs";
import { resolveAgentVetoRule, migrateAgentVetoOwner, runAgentVetoRevert, AGENT_VETO_OWNER_KEY, AGENT_VETO_AUTO_KEY, AGENT_VETO_RULES, agentVetoRuleOf } from "../src/agent-veto.mjs";
import { zonePriorityMode, zoneAheadMode, keyLevelZoneTypesMode, zoneAimOffMode, zoneAimTpMode, zoneSourcesOffMode, ZONE_AIM_TOKENS, ZONE_SOURCES, ZONE_AHEAD_MODES } from "../src/zone-types.mjs";
import { entryZoneMode, tp1KeyZoneMode } from "../src/strategy-engine.mjs";
import { zoneReadingsMode } from "../src/zone-readings.mjs";
import { chartPatternsMode } from "../src/projection-agent.mjs";
import { gridAdaptMode } from "../src/grid-adapt.mjs";
import { roomBreakoutWaiveOf } from "../src/room-waive.mjs";
import { cfcMode, CFC_MODES } from "../src/cfc-triggers.mjs";
import { modeShadowEvidence, modeProbationMode } from "../src/mode-shadow.mjs";
import { liquidityWitnessEnabled } from "../src/decision-engine.mjs";
import { lensRoomLine, LENS_ROOM_LINES } from "../src/lens-steps.mjs";
import { calendarContrarianMode } from "../src/econ-releases.mjs";
import { shadowKnowledgeEnabled } from "../src/shadow-knowledge.mjs";
import { knowledgeVerdictPostsEnabled } from "../src/knowledge-verdicts.mjs";
import { metricRebuttalEnabled } from "../src/metric-shadow.mjs";
import { correctionsEnabled } from "../src/owner-corrections.mjs";
import { OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { writeSettings, readSettings, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { ERA_SWITCHES, eraStep, ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH } from "../src/ledger-omega4.mjs";
import { changeTokens, CHANGE_TOKENS, CHANGE_THRESHOLDS_ALL } from "../src/change-thresholds.mjs";
import { PROFIT_LOCK_GATE_MODES } from "../src/profit-lock-gate.mjs";
import { PM_FAST_MODES } from "../src/pm-fast.mjs";
import { REENTRY_MODES } from "../src/reentry-1m.mjs";
import { LIMIT_SUPERSEDE_MODES } from "../src/limit-supersede.mjs";
import { runAuditNotify, TOLD_ELSEWHERE } from "../src/change-notify.mjs";
import { handle as omegaHandle, resetKeyCacheForTests } from "../workers/xauusd-omega/src/omega.mjs";
import * as se from "../src/strategy-engine.mjs";
import * as de from "../src/decision-engine.mjs";
import * as ea from "../src/ea-signal.mjs";
import * as pp from "../src/public-projection.mjs";
import * as pa from "../src/public-analysis.mjs";
import * as pl from "../src/plan-learning.mjs";
import { zoneScenario } from "./support/zone-types-fixture.mjs";
import { d1, kv } from "./fixtures/mode-shadow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const T0 = Date.parse("2026-11-25T09:00:00Z");
const OWNER = "owner-sub-0001";
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const AI_ROWS = FEATURE_SWITCHES.filter((e) => e.worker === "ai");
const OMEGA_ROWS = FEATURE_SWITCHES.filter((e) => e.write === "omega-settings");

/** wrangler.jsonc's vars, read from the file (string values only, comments ignored). */
function wranglerVars() {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const block = text.slice(text.indexOf('"vars": {'), text.indexOf('"routes": ['));
  const out = {};
  for (const line of block.split("\n")) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(/^\s*"([A-Z0-9_]+)":\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const VARS = wranglerVars();
/** The AI rows' wrangler values, as the production env carries them. */
const CONFIG_ENV = Object.fromEntries(AI_ROWS.filter((e) => e.key in VARS).map((e) => [e.key, VARS[e.key]]));

function capture() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => Object.assign(console, original) };
}
function failingKv() { return { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } }; }
function omegaDb() {
  resetOmegaBrokerSchemaForTests();
  return d1();
}

// ------------------------------------------------------------------ the registry

test("FS-1 the registry: every switch's config_value is wrangler.jsonc's, read from the file; the flags and groups", () => {
  const groups = new Set(FEATURE_SWITCH_GROUPS.map((g) => g.id));
  assert.equal(new Set(FEATURE_SWITCHES.map((e) => e.key)).size, FEATURE_SWITCHES.length, "one entry per key");
  for (const e of FEATURE_SWITCHES) {
    assert.ok(groups.has(e.group), `${e.key}: a known group`);
    assert.ok(e.label && e.description && !e.description.includes("\n"), `${e.key}: a label and one plain line`);
    assert.ok(["ai", "omega"].includes(e.worker) && ["feature-switch", "omega-settings"].includes(e.write));
    if (e.write === "omega-settings") {
      assert.equal(e.config_value, null, `${e.key}: an Omega setting has no wrangler value`);
      assert.ok(e.key in OMEGA_DEFAULTS, `${e.key} is an Omega setting`);
      assert.deepEqual(e.default_value, readSwitch(e, OMEGA_DEFAULTS[e.key]), `${e.key}: the code default is OMEGA_DEFAULTS'`);
      continue;
    }
    if (e.key in VARS) assert.deepEqual(e.config_value, readSwitch(e, VARS[e.key]), `${e.key}: config_value is wrangler.jsonc's ${JSON.stringify(VARS[e.key])}`);
    else assert.equal(e.config_value, null, `${e.key}: not in wrangler.jsonc, so no config value`);
    assert.deepEqual(readSwitch(e, VARS[e.key]), e.config_value ?? e.default_value);
  }
  // The keys the orchestrator listed, all present; ZONE_SOURCES_OFF, three lens/calendar switches and H3f's OWNER_CORRECTIONS added.
  for (const k of ["ZONE_PRIORITY", "ZONE_AHEAD_MODE", "KEY_LEVEL_ZONE_TYPES", "ZONE_AIM_OFF", "ZONE_AIM_TP", "AGENT_VETO_RULE", "SHADOW_KNOWLEDGE_ENABLED", "KNOWLEDGE_VERDICT_POSTS",
    "MODE_SHADOW_EVIDENCE", "MODE_PROBATION", "GRID_ADAPT_MODE", "ENTRY_ZONE_MODE", "TP1_KEY_ZONE_MODE", "CHART_PATTERNS_MODE", "METRIC_REBUTTAL", "CFC_MODE",
    "profit_lock_gate", "change_thresholds", "pm_fast_1m", "reentry_1m", "limit_supersede", "ZONE_SOURCES_OFF", "LIQUIDITY_WITNESS", "LENS_ROOM_LINE", "CALENDAR_CONTRARIAN", "OWNER_CORRECTIONS"]) assert.ok(switchByKey(k), k);
  // Excluded: secrets, bindings, the engine switch, the kill switch, arms, LIVE and profile.
  for (const k of ["OMEGA_ENGINE_ENABLED", "EA_SIGNALS_ENABLED", "STRATEGY_ARM_MODE", "STRATEGY_COUNCIL_ARM", "live_armed", "enabled", "OWNER_ACCESS_SUB", "TELEGRAM_BOT_TOKEN", "WEBHOOK_SECRET", "DB", "SIGNAL_CACHE", "AGENTS", "AETHER", "risk_pct", "max_positions"]) assert.equal(switchByKey(k), null, `${k} is not a panel switch`);
  // era_switch: exactly ERA_SWITCHES' members (a parity era starts on change).
  for (const e of FEATURE_SWITCHES) assert.equal(e.era_switch, ERA_SWITCHES.includes(e.key), e.key);
  // restarts_mode_evidence: TP1_KEY_ZONE_MODE and every ZONE_* switch, KEY_LEVEL_ZONE_TYPES included, but Z5's
  // ZONE_READINGS (measurement and the decision-side brake, no rule of its own); nothing else.
  for (const e of FEATURE_SWITCHES) assert.equal(e.restarts_mode_evidence, e.key === "TP1_KEY_ZONE_MODE" || e.key === "KEY_LEVEL_ZONE_TYPES" || (e.key.startsWith("ZONE_") && e.key !== "ZONE_READINGS"), e.key);
  assert.deepEqual(FEATURE_SWITCHES.filter((e) => e.emergency_stop).map((e) => e.key), ["ZONE_PRIORITY", "KEY_LEVEL_ZONE_TYPES", "SHADOW_KNOWLEDGE_ENABLED"]);
  assert.deepEqual(FEATURE_SWITCHES.filter((e) => e.read_only).map((e) => e.key), ["METRIC_REBUTTAL"]);
  // The values the code knows: the panel's ⊆ the code's; ZONE_AHEAD_MODE's record and off are config-only.
  assert.deepEqual([...switchByKey("ZONE_AHEAD_MODE").values, ...switchByKey("ZONE_AHEAD_MODE").config_only].sort(), [...ZONE_AHEAD_MODES].sort());
  assert.deepEqual([...switchByKey("AGENT_VETO_RULE").values], [...AGENT_VETO_RULES]);
  assert.deepEqual([...switchByKey("CFC_MODE").values].sort(), [...CFC_MODES].sort());
  assert.deepEqual([...switchByKey("LENS_ROOM_LINE").values], [...LENS_ROOM_LINES]);
  assert.deepEqual([...switchByKey("ZONE_AIM_OFF").values.tokens], [...ZONE_AIM_TOKENS]);
  assert.deepEqual([...switchByKey("ZONE_SOURCES_OFF").values.tokens], [...ZONE_SOURCES]);
  assert.deepEqual([...switchByKey("change_thresholds").values.tokens], [...CHANGE_TOKENS]);
  assert.deepEqual([...switchByKey("profit_lock_gate").values], [...PROFIT_LOCK_GATE_MODES]);
  for (const [k, modes] of [["pm_fast_1m", PM_FAST_MODES], ["reentry_1m", REENTRY_MODES], ["limit_supersede", LIMIT_SUPERSEDE_MODES]]) assert.deepEqual([...switchByKey(k).values], [...modes], k);
  // No model identifier, email or account number in the registry's text.
  const text = JSON.stringify(FEATURE_SWITCHES);
  assert.doesNotMatch(text, EMAIL);
  assert.doesNotMatch(text, /@cf\/|gpt-|gemma|account_number|login/i);
});

/** Each AI row's accessor in the code, as the panel value. */
const ACCESSOR = {
  ZONE_PRIORITY: (env) => zonePriorityMode(env),
  ZONE_AHEAD_MODE: (env) => zoneAheadMode({ ZONE_PRIORITY: "on", ...env }),
  KEY_LEVEL_ZONE_TYPES: (env) => keyLevelZoneTypesMode(env),
  ZONE_AIM_OFF: (env) => ZONE_AIM_TOKENS.filter((t) => !zoneAimOffMode(env).includes(t)),
  ZONE_SOURCES_OFF: (env) => ZONE_SOURCES.filter((t) => !zoneSourcesOffMode(env).includes(t)),
  ZONE_AIM_TP: (env) => zoneAimTpMode(env),
  ZONE_READINGS: (env) => zoneReadingsMode(env),
  ENTRY_ZONE_MODE: (env) => entryZoneMode(env),
  TP1_KEY_ZONE_MODE: (env) => tp1KeyZoneMode(env),
  CHART_PATTERNS_MODE: (env) => chartPatternsMode(env),
  GRID_ADAPT_MODE: (env) => gridAdaptMode(env),
  ROOM_BREAKOUT_WAIVE: (env) => roomBreakoutWaiveOf(env),
  AGENT_VETO_RULE: (env) => agentVetoRuleOf(env),
  CFC_MODE: (env) => cfcMode(env),
  MODE_SHADOW_EVIDENCE: (env) => modeShadowEvidence(env),
  MODE_PROBATION: (env) => modeProbationMode(env),
  LIQUIDITY_WITNESS: (env) => (liquidityWitnessEnabled(env) ? "on" : "off"),
  LENS_ROOM_LINE: (env) => lensRoomLine(env),
  CALENDAR_CONTRARIAN: (env) => calendarContrarianMode(env),
  SHADOW_KNOWLEDGE_ENABLED: (env) => (shadowKnowledgeEnabled(env) ? "on" : "off"),
  KNOWLEDGE_VERDICT_POSTS: (env) => (knowledgeVerdictPostsEnabled({ SHADOW_KNOWLEDGE_ENABLED: "true", ...env }) ? "on" : "off"),
  METRIC_REBUTTAL: (env) => (metricRebuttalEnabled(env) ? "on" : "off"),
  OWNER_CORRECTIONS: (env) => (correctionsEnabled(env) ? "on" : "off")
};

test("FS-2 each reader is its accessor's rule: every raw value reads as the code reads it, and every panel value's env form reads back", () => {
  assert.deepEqual(Object.keys(ACCESSOR).sort(), AI_ROWS.map((e) => e.key).sort(), "an accessor per AI row");
  const raws = [undefined, null, "", " ", "on", "off", " ON ", "Off", "true", "false", "TRUE", "trend", "all", "record", "bogus", "live", "edge", "qualified", "label",
    "two_sided", " Two_Sided ", "classic", "suggest", "brief", "conditions", "tp", "tp,stop", "stop factor", "tp,stop,factor", "TP, bogus", "prophet_zone", "whale,gabfx gmi_flag"];
  for (const e of AI_ROWS) {
    for (const raw of raws) {
      const env = raw === undefined ? {} : { [e.key]: raw };
      assert.deepEqual(readSwitch(e, raw), ACCESSOR[e.key](env), `${e.key} reads ${JSON.stringify(raw)} as the code does`);
    }
    assert.deepEqual(e.default_value, ACCESSOR[e.key]({}), `${e.key}: the code default`);
    const values = isTokens(e) ? [[], [...e.values.tokens], [e.values.tokens[0]], e.values.tokens.slice(1)] : [...e.values];
    for (const v of values) assert.deepEqual(ACCESSOR[e.key]({ [e.key]: envForm(e, v) }), v, `${e.key}: the override ${JSON.stringify(v)} reaches the code`);
  }
});

test("FS-3 token lists: the panel takes the on-list, the store keeps the off-list (ZONE_AIM_OFF, ZONE_SOURCES_OFF) or the on-list (change_thresholds)", () => {
  const aim = switchByKey("ZONE_AIM_OFF");
  assert.deepEqual(normalizeValue(aim, ["stop"]), { value: ["stop"] });
  assert.deepEqual(normalizeValue(aim, ["factor", "TP"]), { value: ["tp", "factor"] }, "token order, case folded");
  assert.deepEqual(normalizeValue(aim, "stop, tp"), { value: ["tp", "stop"] }, "a comma text works too");
  assert.deepEqual(normalizeValue(aim, ["tp", "bogus"]), { error: "invalid_value" });
  assert.deepEqual(normalizeValue(aim, 3), { error: "invalid_value" });
  assert.equal(envForm(aim, ["stop"]), "tp,factor");
  assert.equal(envForm(aim, []), "tp,stop,factor", "none on: the config of today");
  assert.equal(envForm(aim, ["tp", "stop", "factor"]), "", "all on: an empty off-list");
  assert.deepEqual(zoneAimOffMode({ ZONE_AIM_OFF: envForm(aim, ["stop"]) }), ["tp", "factor"]);
  assert.deepEqual(readSwitch(aim, VARS.ZONE_AIM_OFF), [], "the config: every rule off");
  const src = switchByKey("ZONE_SOURCES_OFF");
  assert.equal(envForm(src, ZONE_SOURCES.filter((t) => t !== "prophet_zone")), "prophet_zone");
  const ch = switchByKey("change_thresholds");
  assert.equal(envForm(ch, []), "off");
  assert.equal(envForm(ch, [...CHANGE_TOKENS]), CHANGE_THRESHOLDS_ALL);
  assert.deepEqual([...changeTokens({ change_thresholds: envForm(ch, ["skip", "conf"]) })], ["conf", "skip"]);
  assert.deepEqual(readSwitch(ch, "off"), []);
});

// ------------------------------------------------------------------ resolution and the env copy

test("FS-4 resolution: override > config > default; the copy never writes env; invalid overrides ignored with one log line; unreadable falls back to env", async () => {
  resetFeatureSwitchMemoForTests();
  const zp = switchByKey("ZONE_PRIORITY");
  assert.deepEqual(resolveEnvSwitch(zp, { env: {} }), { value: "off", source: "default", set_by: null, set_at: null });
  assert.deepEqual(resolveEnvSwitch(zp, { env: { ZONE_PRIORITY: "on" } }).source, "config");
  assert.deepEqual(resolveEnvSwitch(zp, { env: { ZONE_PRIORITY: "on" }, override: { value: "off", actor: "owner", at: "2026-11-25T09:00:00.000Z" } }), { value: "off", source: "override", set_by: "owner", set_at: "2026-11-25T09:00:00.000Z" });

  // No override at all: env itself (the very same object), so every reader sees exactly what it saw before FS1.
  const store = kv();
  const env = { ...CONFIG_ENV, SIGNAL_CACHE: store };
  const snapshot = JSON.stringify(env);
  assert.equal(await withFeatureSwitches(env, { now: T0 }), env);
  // A valid override: a copy with the override, env untouched; the copy is stable while the store does not change.
  resetFeatureSwitchMemoForTests();
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ ZONE_PRIORITY: { value: "off", actor: "owner", at: "2026-11-25T09:00:00.000Z" }, AGENT_VETO_RULE: { value: "classic", actor: "owner", at: "2026-11-25T09:00:00.000Z" } }));
  const copy = await withFeatureSwitches(env, { now: T0 });
  assert.notEqual(copy, env);
  assert.equal(copy.ZONE_PRIORITY, "off");
  assert.equal(copy.AGENT_VETO_RULE, "two_sided", "the veto force is SV1b's resolution, never copied onto env");
  assert.equal(JSON.stringify(env), snapshot, "env itself never written");
  assert.equal(await withFeatureSwitches(env, { now: T0 + 1 }), copy, "the same copy while nothing changed");
  assert.equal(await withFeatureSwitches(copy, { now: T0 + 2 }), copy, "a resolved copy is not resolved again");
  assert.equal(zonePriorityMode(copy), "off");
  // Another isolate's write is seen after the memo (KV's own spread aside).
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({}));
  assert.equal((await withFeatureSwitches(env, { now: T0 + 3 })).ZONE_PRIORITY, "off", "inside the memo: the copy");
  assert.equal(await withFeatureSwitches(env, { now: T0 + FEATURE_SWITCH_MEMO_MS + 3 }), env, "after it: env again");

  // Invalid overrides: ignored, one log line for the same stored document.
  resetFeatureSwitchMemoForTests();
  const bad = { ZONE_AHEAD_MODE: { value: "record" }, METRIC_REBUTTAL: { value: "on" }, NOPE: { value: "on" }, pm_fast_1m: { value: "off" }, ZONE_AIM_TP: { value: "Qualified" }, CFC_MODE: { value: 1 }, MODE_PROBATION: { value: "off", actor: "owner" } };
  assert.deepEqual(overridePatch(JSON.stringify(bad)), { patch: { MODE_PROBATION: "off" }, ignored: ["ZONE_AHEAD_MODE", "METRIC_REBUTTAL", "NOPE", "pm_fast_1m", "ZONE_AIM_TP", "CFC_MODE"] });
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify(bad));
  const c = capture();
  let out;
  try { out = await withFeatureSwitches(env, { now: T0 }); } finally { c.restore(); }
  assert.deepEqual([out.MODE_PROBATION, out.ZONE_AHEAD_MODE, out.METRIC_REBUTTAL], ["off", "trend", "off"]);
  assert.equal(c.lines.filter((l) => l.includes("feature_switch_override_ignored")).length, 1);
  const c2 = capture();
  try { await withFeatureSwitches(env, { now: T0 }); await withFeatureSwitches(env, { now: T0 + FEATURE_SWITCH_MEMO_MS + 1 }); } finally { c2.restore(); }
  assert.equal(c2.lines.filter((l) => l.includes("feature_switch_override_ignored")).length, 0, "the same document: one line per isolate, already written");
  // A document that is not JSON: nothing applies.
  resetFeatureSwitchMemoForTests();
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, "{not json");
  assert.equal(await withFeatureSwitches(env, { now: T0 }), env);

  // An unreadable store: env, one log line per memo period.
  resetFeatureSwitchMemoForTests();
  const broken = { ...CONFIG_ENV, SIGNAL_CACHE: failingKv() };
  const c3 = capture();
  try { assert.equal(await withFeatureSwitches(broken, { now: T0 }), broken); assert.equal(await withFeatureSwitches(broken, { now: T0 + 1 }), broken); } finally { c3.restore(); }
  assert.equal(c3.lines.filter((l) => l.includes("feature_switch_store_unreadable")).length, 1);
  // No KV, no env object: as given.
  assert.equal(await withFeatureSwitches(CONFIG_ENV), CONFIG_ENV);
  assert.equal(await withFeatureSwitches(null), null);
});

test("FS-5 no override: decisions, council messages, the EA signal and plans byte-identical; an override equal to the config too; an override reaches the code as its env value would", async () => {
  resetFeatureSwitchMemoForTests();
  const mods = { se, de, ea, pp, pa, pl };
  const hashOf = async (extra) => { const { run, ...rest } = await zoneScenario(mods, { db: d1, kv, env: extra }); return sha(rest); };
  const strip = (e) => { const { SIGNAL_CACHE, ...rest } = e; return rest; };
  const baseline = await hashOf(CONFIG_ENV);
  // No override: withFeatureSwitches gives env itself.
  const store = kv();
  const env = { ...CONFIG_ENV, SIGNAL_CACHE: store };
  assert.equal(await withFeatureSwitches(env), env);
  assert.equal(await hashOf(strip(await withFeatureSwitches(env))), baseline);
  // Every writable AI row overridden to its config value: a copy, the same outputs.
  const same = {};
  for (const e of AI_ROWS) if (!e.read_only && e.resolve === "env" && e.key in VARS) same[e.key] = { value: VARS[e.key], actor: "owner", at: "2026-11-25T09:00:00.000Z" };
  resetFeatureSwitchMemoForTests();
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify(same));
  const copy = await withFeatureSwitches(env);
  assert.notEqual(copy, env);
  assert.equal(await hashOf(strip(copy)), baseline);
  // ZONE_PRIORITY "off" by override equals ZONE_PRIORITY "off" in the config.
  resetFeatureSwitchMemoForTests();
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ ZONE_PRIORITY: { value: "off", actor: "owner", at: "2026-11-25T09:00:00.000Z" } }));
  assert.equal(await hashOf(strip(await withFeatureSwitches(env))), await hashOf({ ...CONFIG_ENV, ZONE_PRIORITY: "off" }));
  // The engine's hashes do not move (V13/V14 recompute them).
  assert.equal(ENGINE_CODE_HASH.slice(0, 8), "c4aa5772");
  assert.equal(ENGINE_BEHAVIOUR_HASH.slice(0, 8), "ecfe3f90");
});

// ------------------------------------------------------------------ the GET payload

const ROW_KEYS = ["key", "label", "description", "group", "worker", "values", "value", "source", "config_value", "default_value", "set_by", "set_at", "era_switch", "restarts_mode_evidence", "emergency_stop", "read_only", "write"];

test("FS-6 GET payload: the promised shape; no email, account or identity key; set_by a role word", async () => {
  resetFeatureSwitchMemoForTests();
  const store = kv(), db = omegaDb();
  const env = { ...CONFIG_ENV, OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: db };
  await readSettings(env);
  assert.equal((await setFeatureSwitch(env, { key: "ZONE_AIM_OFF", value: ["tp"], actor: "owner@example.com", actor_sub: OWNER, now: T0 })).ok, true);
  assert.equal((await setFeatureSwitch(env, { key: "pm_fast_1m", value: "off", actor: "owner@example.com", actor_sub: OWNER, now: T0 })).ok, true);
  const p = await featureSwitchesPayload(env, { now: T0 + 1000, canControl: true });
  assert.deepEqual(Object.keys(p), ["version", "at", "viewer", "groups", "switches"]);
  assert.equal(p.version, FEATURE_SWITCHES_VERSION);
  assert.equal(p.version, "cryptophys.feature-switches.v1");
  assert.deepEqual(p.viewer, { can_control: true });
  assert.deepEqual(p.groups, FEATURE_SWITCH_GROUPS.map((g) => ({ id: g.id, label: g.label })));
  assert.equal(p.switches.length, FEATURE_SWITCHES.length);
  for (const r of p.switches) {
    const keys = Object.keys(r);
    assert.deepEqual(keys.filter((k) => !ROW_KEYS.includes(k)), r.key === "AGENT_VETO_RULE" || r.key === "ROOM_BREAKOUT_WAIVE" ? ["auto_revert"] : r.key === "ZONE_AHEAD_MODE" || r.key === "ZONE_AIM_OFF" ? ["zone_hold"] : [], `${r.key}: no extra key`);
    assert.deepEqual(ROW_KEYS.filter((k) => !keys.includes(k)), [], `${r.key}: every key`);
    assert.ok(["override", "config", "default"].includes(r.source));
    assert.ok(r.set_by === null || ["owner", "aether", "agent", "system"].includes(r.set_by), `${r.key}: set_by a role word`);
    assert.ok(r.set_at === null || !Number.isNaN(Date.parse(r.set_at)));
    if (Array.isArray(r.values)) assert.ok(!Array.isArray(r.value)); else assert.deepEqual(r.values.on, r.value, `${r.key}: a token list's on-list`);
  }
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, EMAIL, "no email");
  assert.doesNotMatch(text, /"(email|sub|actor|actor_sub|account|account_ref|login|server|password)"/, "no identity or account key");
  const row = (k) => p.switches.find((r) => r.key === k);
  assert.deepEqual([row("ZONE_AIM_OFF").value, row("ZONE_AIM_OFF").values, row("ZONE_AIM_OFF").source, row("ZONE_AIM_OFF").set_by, row("ZONE_AIM_OFF").set_at], [["tp"], { type: "tokens", tokens: ["tp", "stop", "factor"], on: ["tp"] }, "override", "owner", new Date(T0).toISOString()]);
  assert.deepEqual([row("ZONE_PRIORITY").value, row("ZONE_PRIORITY").source, row("ZONE_PRIORITY").config_value, row("ZONE_PRIORITY").default_value], ["on", "config", "on", "off"]);
  assert.deepEqual([row("ZONE_SOURCES_OFF").source, row("ZONE_SOURCES_OFF").config_value, row("ZONE_SOURCES_OFF").value], ["default", null, [...ZONE_SOURCES]]);
  assert.deepEqual([row("SHADOW_KNOWLEDGE_ENABLED").value, row("SHADOW_KNOWLEDGE_ENABLED").config_value], ["on", "on"], "true shows as on");
  assert.deepEqual([row("pm_fast_1m").value, row("pm_fast_1m").source, row("pm_fast_1m").set_by, row("pm_fast_1m").config_value, row("pm_fast_1m").write, row("pm_fast_1m").era_switch], ["off", "override", "owner", null, "omega-settings", true]);
  assert.deepEqual([row("reentry_1m").value, row("reentry_1m").source, row("reentry_1m").set_by], ["on", "default", null]);
  assert.deepEqual(row("AGENT_VETO_RULE").auto_revert, null);
  assert.deepEqual([row("ROOM_BREAKOUT_WAIVE").value, row("ROOM_BREAKOUT_WAIVE").source, row("ROOM_BREAKOUT_WAIVE").auto_revert], ["on", "config", null]);
  // The KV and D1 rows carry role words, never the email.
  assert.doesNotMatch(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY), EMAIL);
  assert.doesNotMatch(String(db.raw.prepare("SELECT key_meta FROM omega_settings WHERE id = 1").get().key_meta), EMAIL);
  // A resolved copy reads the config from its base env (config_value never shows the override).
  resetFeatureSwitchMemoForTests();
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ ZONE_PRIORITY: { value: "off", actor: "owner", at: new Date(T0).toISOString() } }));
  const viaCopy = (await featureSwitchesPayload(await withFeatureSwitches(env, { now: T0 }), { now: T0 })).switches.find((r) => r.key === "ZONE_PRIORITY");
  assert.deepEqual([viaCopy.value, viaCopy.source, viaCopy.config_value], ["off", "override", "on"]);
  // An unreadable store: the config, as the runs fall back to it.
  const broken = await featureSwitchesPayload({ ...env, SIGNAL_CACHE: failingKv() }, { now: T0 });
  assert.equal(broken.switches.find((r) => r.key === "ZONE_PRIORITY").source, "config");
});

// ------------------------------------------------------------------ the POST

test("FS-7 POST: owner only; unknown_key, invalid_value, read_only; a change writes one audit row, one Omega event and one Telegram line", async () => {
  resetFeatureSwitchMemoForTests();
  const store = kv(), db = omegaDb();
  const env = { ...CONFIG_ENV, OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: db };
  await readSettings(env); // the Omega tables (omega_events) exist as in production
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const post = (input) => setFeatureSwitch(env, { actor: "owner@example.com", actor_sub: OWNER, now: T0, send, ...input });
  assert.deepEqual(await post({ key: "ZONE_PRIORITY", value: "off", actor_sub: "guest-sub-0002" }), { ok: false, error: "owner_only" });
  assert.deepEqual(await setFeatureSwitch({ ...env, OWNER_ACCESS_SUB: "" }, { key: "ZONE_PRIORITY", value: "off", actor_sub: OWNER }), { ok: false, error: "owner_only" }, "no owner configured: nobody");
  assert.deepEqual(await post({ key: "NOPE", value: "on" }), { ok: false, error: "unknown_key" });
  assert.deepEqual(await post({ key: "METRIC_REBUTTAL", value: "on" }), { ok: false, error: "read_only" });
  assert.deepEqual(await post({ key: "ZONE_AHEAD_MODE", value: "record" }), { ok: false, error: "invalid_value" }, "config-only values are not POSTable");
  assert.deepEqual(await post({ key: "ZONE_PRIORITY", value: true }), { ok: false, error: "invalid_value" });
  assert.deepEqual(await post({ key: "ZONE_AIM_OFF", value: ["tp", "nope"] }), { ok: false, error: "invalid_value" });
  assert.deepEqual(await post({ key: "change_thresholds", value: ["bogus"] }), { ok: false, error: "invalid_value" });
  assert.equal(sent.length, 0);
  assert.equal(store.m.has(FEATURE_SWITCH_OVERRIDE_KEY), false, "nothing written by a refused POST");

  const events = () => db.raw.prepare("SELECT actor, action, detail FROM omega_events ORDER BY id").all();
  const r = await post({ key: "ZONE_AHEAD_MODE", value: "all" });
  assert.deepEqual([r.ok, r.changed, r.switch.value, r.switch.source, r.switch.set_by, r.switch.set_at], [true, true, "all", "override", "owner", new Date(T0).toISOString()]);
  assert.deepEqual(JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)), { ZONE_AHEAD_MODE: { value: "all", actor: "owner", at: new Date(T0).toISOString() } });
  assert.deepEqual(events().map((e) => [e.actor, e.action]), [["owner", "feature_switch"]], "one audit row, the Omega event");
  assert.deepEqual(JSON.parse(events()[0].detail), { key: "ZONE_AHEAD_MODE", from: "trend", to: "all", source_from: "config", source_to: "override", reset: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "XAUUSD SYSTEM · Feature switch Zone-ahead check (ZONE_AHEAD_MODE) set by the owner: trend (config) → all (override). The mode evidence restarts with the new rule version.");
  assert.doesNotMatch(sent.join("\n"), EMAIL);
  assert.doesNotMatch(sent.join("\n"), /\d{4}\.\d/, "no price");
  // This isolate's runs see it at once.
  assert.equal((await withFeatureSwitches(env, { now: T0 })).ZONE_AHEAD_MODE, "all");
  // The same value again: nothing changes, nothing is told.
  const again = await post({ key: "ZONE_AHEAD_MODE", value: "all" });
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.deepEqual([events().length, sent.length], [1, 1]);
  // Reset: back to the config, one more row and line.
  const back = await post({ key: "ZONE_AHEAD_MODE", reset: true });
  assert.deepEqual([back.switch.value, back.switch.source, back.switch.set_by], ["trend", "config", null]);
  assert.deepEqual(JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)), {});
  assert.deepEqual([events().length, sent.length], [2, 2]);
  assert.match(sent[1], /reset by the owner: all \(override\) → trend \(config\)/);
  assert.deepEqual((await post({ key: "ZONE_AHEAD_MODE", reset: true })).changed, false, "a reset with no override: nothing");
  // Token list: the on-list in, the off-list stored.
  const t = await post({ key: "ZONE_AIM_OFF", value: ["stop"] });
  assert.deepEqual([t.switch.value, JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).ZONE_AIM_OFF.value], [["stop"], "tp,factor"]);
  assert.match(sent.at(-1), /Zone aims \(ZONE_AIM_OFF\) set by the owner: none \(config\) → stop \(override\)/);
  // SHADOW_KNOWLEDGE_ENABLED: on/off in, true/false stored.
  await post({ key: "SHADOW_KNOWLEDGE_ENABLED", value: "off" });
  assert.equal(JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).SHADOW_KNOWLEDGE_ENABLED.value, "false");
  assert.equal(shadowKnowledgeEnabled(await withFeatureSwitches(env, { now: T0 })), false);
  assert.ok(TOLD_ELSEWHERE.includes("feature_switch"), "the change audit's sweep does not tell it again");
  // An unreadable store refuses the change (nothing half-written).
  assert.deepEqual((await setFeatureSwitch({ ...env, SIGNAL_CACHE: failingKv() }, { key: "ZONE_PRIORITY", value: "off", actor_sub: OWNER })).error, "unavailable");
});

test("FS-8 an Omega setting goes through the settings page's write path: settingsFrom, the settings audit told once by the sweep, per-key set_by/set_at; reset to OMEGA_DEFAULTS", async () => {
  resetFeatureSwitchMemoForTests();
  const store = kv(), db = omegaDb();
  const env = { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: db };
  await readSettings(env);
  const lines = [];
  await runAuditNotify(env, { now: T0 - 60_000, send: async (t) => { lines.push(t); return true; } }); // the sweep's start (no line)
  const direct = [];
  const r = await setFeatureSwitch(env, { key: "pm_fast_1m", value: "off", actor: "owner@example.com", actor_sub: OWNER, now: T0, send: async (t) => { direct.push(t); } });
  assert.deepEqual([r.ok, r.changed, r.audit, r.switch.value, r.switch.source, r.switch.set_by, r.switch.set_at], [true, true, "settings", "off", "override", "owner", new Date(T0).toISOString()]);
  const s = await readSettings(env);
  assert.deepEqual([s.settings.pm_fast_1m, s.version, s.updated_ms], ["off", 1, T0], "the same row and updated_ms as the page's save");
  assert.equal(store.m.has(FEATURE_SWITCH_OVERRIDE_KEY), false, "one store: Omega settings are never in the override store");
  const ev = db.raw.prepare("SELECT action FROM omega_events ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(ev, ["settings"], "the page's audit row");
  assert.equal(direct.length, 0, "no line of its own: the sweep tells a settings save");
  await runAuditNotify(env, { now: T0 + 120_000, send: async (t) => { lines.push(t); return true; } });
  await runAuditNotify(env, { now: T0 + 240_000, send: async (t) => { lines.push(t); return true; } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^XAUUSD SYSTEM · Omega settings changed by owner · \d\d:\d\d UTC\n• 1m fast-protect layer: on → off$/);
  // The same value: no write.
  assert.equal((await setFeatureSwitch(env, { key: "pm_fast_1m", value: "off", actor: "owner@example.com", actor_sub: OWNER, now: T0 + 1 })).changed, false);
  assert.equal((await readSettings(env)).version, 1);
  // Token list: the on-list stored as the on-list ("off" when none).
  const c = await setFeatureSwitch(env, { key: "change_thresholds", value: [], actor: "owner@example.com", actor_sub: OWNER, now: T0 + 2 });
  assert.deepEqual([c.switch.value, (await readSettings(env)).settings.change_thresholds], [[], "off"]);
  // Ruling 4: reset goes to OMEGA_DEFAULTS, source "default".
  const back = await setFeatureSwitch(env, { key: "pm_fast_1m", reset: true, actor: "owner@example.com", actor_sub: OWNER, now: T0 + 3 });
  assert.deepEqual([back.switch.value, back.switch.source, back.switch.set_by, (await readSettings(env)).settings.pm_fast_1m], ["on", "default", null, OMEGA_DEFAULTS.pm_fast_1m]);
  // settingsFrom's refusals come back as invalid_value (an Omega row validates twice: the registry, then settingsFrom).
  assert.deepEqual((await setFeatureSwitch(env, { key: "profit_lock_gate", value: "off", actor_sub: OWNER })).error, "invalid_value");
  // The settings page's own save records its keys' set_by too (ruling 3), whoever saves.
  await writeSettings(env, { body: { reentry_1m: "off" }, actor: "aether" }, { now: T0 + 4 });
  const row = (await featureSwitchesPayload(env, { now: T0 + 5 })).switches.find((x) => x.key === "reentry_1m");
  assert.deepEqual([row.value, row.source, row.set_by, row.set_at], ["off", "override", "aether", new Date(T0 + 4).toISOString()]);
});

test("FS-9 an ERA_SWITCH change starts the era exactly as the Omega settings page's save does", async () => {
  const run = async (save) => {
    resetFeatureSwitchMemoForTests();
    const env = { OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: kv(), DB: omegaDb() };
    await readSettings(env);
    await eraStep(env, { now: T0 - 3_600_000 }); // the era before (seeded)
    await save(env);
    const { era } = await eraStep(env, { now: T0 + 600_000 });
    return { since_ms: era.since_ms, switches: era.switches, reason: era.reason, behaviour_hash: era.behaviour_hash };
  };
  const page = await run((env) => writeSettings(env, { body: { limit_supersede: "off" }, actor: "owner@example.com" }, { now: T0 }));
  const panel = await run((env) => setFeatureSwitch(env, { key: "limit_supersede", value: "off", actor: "owner@example.com", actor_sub: OWNER, now: T0 }));
  assert.deepEqual(panel, page);
  assert.deepEqual([panel.since_ms, panel.switches, panel.reason], [T0, ["limit_supersede=off"], "switch on: limit_supersede=off"]);
  // A feature-switch row is no ERA_SWITCH: the era stays.
  resetFeatureSwitchMemoForTests();
  const env = { ...CONFIG_ENV, OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: kv(), DB: omegaDb() };
  await readSettings(env);
  const before = (await eraStep(env, { now: T0 - 3_600_000 })).era;
  await setFeatureSwitch(env, { key: "MODE_PROBATION", value: "off", actor_sub: OWNER, now: T0 });
  assert.equal((await eraStep(env, { now: T0 + 600_000 })).era.since_ms, before.since_ms);
});

// ------------------------------------------------------------------ AGENT_VETO_RULE: one store

test("FS-10 AGENT_VETO_RULE: SV1b's owner force moves into FS1 once (idempotent, one log line); the order owner force > auto-revert > env is pinned", async () => {
  resetFeatureSwitchMemoForTests();
  const store = kv(), db = omegaDb();
  const env = { AGENT_VETO_RULE: "two_sided", OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: db };
  await readSettings(env);
  const at = "2026-11-24T10:00:00.000Z";
  await store.put(AGENT_VETO_OWNER_KEY, JSON.stringify({ rule: "classic", actor: "owner@example.com", at }));
  // Before the move: the old key still forces the rule (nothing changes in force with the move).
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 })), ["classic", "owner", "two_sided"]);
  const c = capture();
  let m1, m2;
  try { m1 = await migrateAgentVetoOwner(env, { now: T0 }); m2 = await migrateAgentVetoOwner(env, { now: T0 + 1 }); } finally { c.restore(); }
  assert.deepEqual([m1.status, m1.moved, m2.status], ["migrated", "classic", "done"]);
  assert.equal(c.lines.filter((l) => l.includes("feature_switch_migrated")).length, 1);
  assert.deepEqual(JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).AGENT_VETO_RULE, { value: "classic", actor: "owner", at });
  assert.ok(store.m.get(FEATURE_SWITCH_VETO_MIGRATION_KEY));
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 })), ["classic", "owner", "two_sided"], "the same rule after the move");
  // The old key is never read again: changing it changes nothing.
  await store.put(AGENT_VETO_OWNER_KEY, JSON.stringify({ rule: "two_sided", actor: "x", at }));
  assert.equal((await resolveAgentVetoRule(env, { now: T0 })).rule, "classic");
  // A move never replaces an override already there.
  const other = kv();
  await other.put(AGENT_VETO_OWNER_KEY, JSON.stringify({ rule: "classic", actor: "owner", at }));
  await other.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ AGENT_VETO_RULE: { value: "two_sided", actor: "owner", at } }));
  const c2 = capture();
  try { assert.deepEqual((await migrateAgentVetoOwner({ SIGNAL_CACHE: other }, { now: T0 })).moved, null); } finally { c2.restore(); }
  assert.equal(JSON.parse(other.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).AGENT_VETO_RULE.value, "two_sided");
  // A reset through FS1 does not bring the old key back.
  const sent = [];
  const reset = await setFeatureSwitch(env, { key: "AGENT_VETO_RULE", value: "auto", actor: "owner@example.com", actor_sub: OWNER, now: T0, send: async (t) => { sent.push(t); } });
  assert.deepEqual([reset.ok, reset.switch.value, reset.switch.source, reset.veto.rule, reset.veto.source], [true, "two_sided", "config", "two_sided", "env"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Strategy-agent veto rule \(AGENT_VETO_RULE\) reset by the owner: classic \(override\) → two_sided \(config\)\. The automatic revert and the config decide again\./);

  // The order, pinned: owner force > auto-revert > env.
  const until = new Date(T0 + 3 * 86_400_000).toISOString();
  await store.put(AGENT_VETO_AUTO_KEY, JSON.stringify({ rule: "classic", since: new Date(T0 - 86_400_000).toISOString(), until }));
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 })), ["classic", "auto_revert", "two_sided"], "the revert over env");
  const p1 = (await featureSwitchesPayload(env, { now: T0 })).switches.find((r) => r.key === "AGENT_VETO_RULE");
  assert.deepEqual([p1.value, p1.source, p1.auto_revert.until], ["classic", "config", until]);
  await setFeatureSwitch(env, { key: "AGENT_VETO_RULE", value: "two_sided", actor_sub: OWNER, now: T0 });
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 })), ["two_sided", "owner", "two_sided"], "the owner's force over the revert");
  assert.equal((await runAgentVetoRevert(env, { now: T0 + 86_400_000 })).status, "held", "the daily check keeps the hold; the force decides the rule");
  assert.equal((await resolveAgentVetoRule(env, { now: T0 + 86_400_000 })).rule, "two_sided");
  await setFeatureSwitch(env, { key: "AGENT_VETO_RULE", reset: true, actor_sub: OWNER, now: T0 });
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 })), ["classic", "auto_revert", "two_sided"]);
  assert.deepEqual(Object.values(await resolveAgentVetoRule(env, { now: T0 + 4 * 86_400_000 })), ["two_sided", "env", "two_sided"], "after the hold: env");
  // A force of "classic" while env is "classic" and the force of "two_sided" with env classic (the force turns it on).
  assert.deepEqual(Object.values(await resolveAgentVetoRule({ ...env, AGENT_VETO_RULE: "classic" }, { now: T0 + 4 * 86_400_000 })), ["classic", "env", "classic"]);
  await setFeatureSwitch(env, { key: "AGENT_VETO_RULE", value: "two_sided", actor_sub: OWNER, now: T0 });
  assert.deepEqual(Object.values(await resolveAgentVetoRule({ ...env, AGENT_VETO_RULE: "classic" }, { now: T0 })), ["two_sided", "owner", "classic"]);
  // Every change wrote one feature_switch audit row; the env copy never carries the force.
  assert.ok(db.raw.prepare("SELECT action FROM omega_events").all().every((x) => x.action === "feature_switch"));
  assert.equal((await withFeatureSwitches(env)).AGENT_VETO_RULE, "two_sided");
  assert.equal(roleWord("owner@example.com"), "owner");
});

// ------------------------------------------------------------------ the Omega Worker's routes

const TEAM = "cryptophys.cloudflareaccess.com", AUD = "a".repeat(64), NOW_S = 1_794_220_000;
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const certsFetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
async function jwt(claims) {
  const head = enc({ alg: "RS256", kid: "k1" }), body = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW_S + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const req = (path, { token, method = "GET", body } = {}) => new Request(`https://omega.cryptophys.work${path}`, {
  method, body: body == null ? undefined : JSON.stringify(body),
  headers: { "cf-access-jwt-assertion": token, origin: "https://omega.cryptophys.work", ...(body != null ? { "content-type": "application/json" } : {}) }
});

test("FS-11 the Omega Worker: GET open to the signed-in (can_control only for the owner); POST owner only, a person, JSON; the RPC gets key, value, reset and the sub", async () => {
  resetKeyCacheForTests();
  const calls = [];
  const O = {
    overview: async () => ({}),
    featureSwitches: async (i) => { calls.push(["get", i]); return { version: FEATURE_SWITCHES_VERSION, viewer: { can_control: i.viewer_sub === OWNER }, groups: [], switches: [] }; },
    setFeatureSwitch: async (i) => { calls.push(["set", i]); return { ok: true, switch: { key: i.key } }; }
  };
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OMEGA: O, OWNER_ACCESS_SUB: OWNER };
  const opts = { fetchImpl: certsFetch, now: NOW_S };
  const owner = await jwt({ email: "owner@example.com", sub: OWNER }), guest = await jwt({ email: "guest@example.com", sub: "guest-sub-0002" }), svc = await jwt({ common_name: "ci.access" });
  const get = async (token, e = env) => { const r = await omegaHandle(req("/api/feature-switches", { token }), e, opts); return { status: r.status, body: await r.json() }; };
  assert.deepEqual([(await get(owner)).status, (await get(owner)).body.viewer], [200, { can_control: true }]);
  assert.deepEqual((await get(guest)).body.viewer, { can_control: false });
  assert.deepEqual((await get(svc)).body.viewer, { can_control: false });
  assert.deepEqual((await get(owner, { ...env, OWNER_ACCESS_SUB: "" })).body.viewer, { can_control: false }, "no owner configured: nobody controls");
  const post = async (token, body, e = env) => { const r = await omegaHandle(req("/api/feature-switches", { token, method: "POST", body }), e, opts); return { status: r.status, body: await r.json() }; };
  assert.deepEqual(await post(guest, { key: "ZONE_PRIORITY", value: "off" }), { status: 403, body: { error: "owner_only" } });
  assert.equal((await post(owner, { key: "ZONE_PRIORITY", value: "off" }, { ...env, OWNER_ACCESS_SUB: "" })).status, 403);
  assert.equal((await post(svc, { key: "ZONE_PRIORITY", value: "off" })).status, 403, "a service token never changes a switch");
  assert.deepEqual(await post(owner, { value: "off" }), { status: 400, body: { ok: false, error: "unknown_key" } });
  assert.deepEqual(await post(owner, { key: "ZONE_PRIORITY", value: 1 }), { status: 400, body: { ok: false, error: "invalid_value" } });
  assert.equal((await post(owner, { key: "ZONE_PRIORITY", value: "off" })).status, 200);
  assert.equal((await post(owner, { key: "ZONE_AIM_OFF", value: ["tp", "stop"] })).status, 200);
  assert.equal((await post(owner, { key: "ZONE_PRIORITY", reset: true })).status, 200);
  const sets = calls.filter(([k]) => k === "set").map(([, i]) => i);
  assert.deepEqual(sets, [
    { key: "ZONE_PRIORITY", value: "off", reset: false, actor: "owner@example.com", actor_sub: OWNER },
    { key: "ZONE_AIM_OFF", value: ["tp", "stop"], reset: false, actor: "owner@example.com", actor_sub: OWNER },
    { key: "ZONE_PRIORITY", value: null, reset: true, actor: "owner@example.com", actor_sub: OWNER }
  ]);
  const del = await omegaHandle(req("/api/feature-switches", { token: owner, method: "DELETE" }), env, opts);
  assert.equal(del.status, 405);
});

// ------------------------------------------------------------------ the AI Worker's wiring (ruling 2)

async function loadWorkerModule() {
  const out = await build({
    entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
    alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") }
  });
  const dir = await mkdtemp(join(tmpdir(), "ai-worker-fs1-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod;
}
async function migratedD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(join(root, "schema.sql"), "utf8"));
  const dir = join(root, "migrations");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, name), "utf8"));
  const st = (sql, p = []) => ({ bind: (...a) => st(sql, a.map((v) => (v === undefined ? null : v))), run: async () => { const r = db.prepare(sql).run(...p); return { success: true, meta: { changes: Number(r.changes) } }; }, first: async (c) => { const row = db.prepare(sql).get(...p) ?? null; return c && row ? row[c] : row; }, all: async () => ({ success: true, results: db.prepare(sql).all(...p) }) });
  return { raw: db, prepare: (sql) => st(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (sql) => { db.exec(sql); return { count: 1 }; } };
}

test("FS-12 the bundled Worker: an override reaches a fetch route's reader; the GET route; OmegaGateway's GET, POST and the strategy-council veto_rule write through FS1", async () => {
  const mod = await loadWorkerModule();
  const store = kv(), db = await migratedD1();
  const env = { ...CONFIG_ENV, OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, WEBHOOK_BUFFER: kv(), DB: db };
  const fetchJson = async (path) => (await mod.default.fetch(new Request(`https://ai.cryptophys.work${path}`), env)).json();
  assert.equal((await fetchJson("/api/council/suggestions")).mode, "on", "the config");
  await store.put(FEATURE_SWITCH_OVERRIDE_KEY, JSON.stringify({ CFC_MODE: { value: "off", actor: "owner", at: new Date(T0).toISOString() } }));
  // A new isolate's memo would re-read; the bundled module has its own memo, so move past it.
  const later = Date.now() + FEATURE_SWITCH_MEMO_MS + 1000;
  const RealNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => later;
  globalThis.fetch = async () => { throw new Error("no network in tests"); };
  try {
    assert.equal((await fetchJson("/api/council/suggestions")).mode, "off", "the override reaches cfcMode through the request's env copy");
    const p = await fetchJson("/api/feature-switches");
    assert.deepEqual([p.version, p.viewer.can_control, p.switches.find((r) => r.key === "CFC_MODE").source], [FEATURE_SWITCHES_VERSION, false, "override"]);
    assert.equal(env.CFC_MODE, "on", "env itself untouched");
    const ctx = { waitUntil: () => {}, passThroughOnException() {} };
    const gw = new mod.OmegaGateway(ctx, { ...env, TELEGRAM_BOT_TOKEN: undefined });
    assert.equal((await gw.featureSwitches({ viewer_sub: OWNER })).viewer.can_control, true);
    assert.equal((await gw.featureSwitches({ viewer_sub: "guest" })).viewer.can_control, false);
    assert.deepEqual(await gw.setFeatureSwitch({ key: "CFC_MODE", reset: true, actor: "owner@example.com", actor_sub: "guest" }), { ok: false, error: "owner_only" });
    const r = await gw.setFeatureSwitch({ key: "CFC_MODE", reset: true, actor: "owner@example.com", actor_sub: OWNER });
    assert.deepEqual([r.ok, r.switch.value, r.switch.source], [true, "on", "config"]);
    // The strategy-council route's veto_rule: the legacy reply, through FS1's store.
    const v = await gw.setAgentVetoRule({ rule: "classic", actor: "owner@example.com", actor_sub: OWNER });
    assert.deepEqual(v, { ok: true, changed: true, force: "classic", rule: "classic", source: "owner" });
    assert.equal(JSON.parse(store.m.get(FEATURE_SWITCH_OVERRIDE_KEY)).AGENT_VETO_RULE.value, "classic");
    assert.equal(store.m.has(AGENT_VETO_OWNER_KEY), false);
    assert.deepEqual(await gw.setAgentVetoRule({ rule: "classic", actor: "x", actor_sub: "guest" }), { ok: false, error: "owner_only" });
    const back = await gw.setAgentVetoRule({ rule: "auto", actor: "owner@example.com", actor_sub: OWNER });
    assert.deepEqual([back.force, back.rule, back.source], ["auto", "two_sided", "env"]);
  } finally { Date.now = RealNow; globalThis.fetch = realFetch; }
});

test("FS-13 ruling 2: every entry point of the AI Worker resolves the overrides once onto a copy; no reader of these keys bypasses it", () => {
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(idx, /async fetch\(request: Request, env: Env\): Promise<Response> \{[\s\S]{0,600}env = await withFeatureSwitches\(env\);/);
  assert.match(idx, /return consumeQueue\(batch, await withFeatureSwitches\(env\)\);/);
  assert.match(idx, /if \(event\.cron === LEDGER_CRON && idle\) return;\n(?:\s*\/\/[^\n]*\n)+\s*env = await withFeatureSwitches\(env\);/);
  // The RPC entrypoints that reach a switch's reader: every method resolves first (the FS1 methods read the store fresh).
  const exempt = new Set(["reserveTvCalls", "releaseTvCalls", "setAgentVetoRule", "featureSwitches", "setFeatureSwitch", "fs"]);
  for (const cls of ["LocalComputationIngress", "PublicProjection", "OmegaGateway"]) {
    const start = idx.indexOf(`export class ${cls} extends WorkerEntrypoint<Env> {`);
    const body = idx.slice(start, idx.indexOf("\n}\n", start));
    assert.match(body, /private async fs\(\): Promise<void> \{ this\.env = await withFeatureSwitches\(this\.env\); \}/, cls);
    for (const m of body.matchAll(/^ {2}async (\w+)\([^\n]*\{\n([^\n]*)/gm)) if (!exempt.has(m[1])) assert.match(m[2], /^\s*await this\.fs\(\);$/, `${cls}.${m[1]} resolves first`);
  }
  // The classes that reach none of these readers are listed here so a new reader there fails this test.
  for (const cls of ["OwnerNotifier", "OrganismDna", "OmegaHealth"]) {
    const start = idx.indexOf(`export class ${cls} extends WorkerEntrypoint<Env> {`);
    const body = idx.slice(start, idx.indexOf("\n}\n", start));
    assert.doesNotMatch(body, /readStrategy|runDecisionEngine|eaSignal|bridgeSync|cfc|ingest/i, cls);
  }
  // No other Worker reads a panel key (the Omega and Nexus Workers, the pull adapter, the news ingestion).
  const others = ["../workers/xauusd-omega/src/omega.mjs", "../workers/xauusd-omega/src/index.mjs", "../workers/xauusd-nexus-dashboard/src/index.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  for (const e of AI_ROWS) assert.doesNotMatch(others, new RegExp(`env\\??\\.${e.key}\\b`), `${e.key} read outside the AI Worker`);
  // The AI Worker's own modules read each key only in its accessor (one reader per key, the one FS-2 pins).
  const srcDir = new URL("../src/", import.meta.url);
  const text = readdirSync(srcDir).filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith(".d.mts")).map((f) => readFileSync(new URL(f, srcDir), "utf8")).join("\n");
  for (const e of AI_ROWS) assert.ok(text.match(new RegExp(`env\\??\\.${e.key}\\b`, "g"))?.length <= 1, `${e.key}: one reader`);
});
