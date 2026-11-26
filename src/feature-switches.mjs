// FS1, one owner control surface for every feature switch (owner 2026-11-25, relayed by the orchestrator: "supaya bisa
// dikontrol perlu panel khusus pengaturan on off untuk semua fitur ini"). Pure: the registry of the switches the owner's
// panel shows, how each reads its raw value (the same rule as the switch's own accessor in the code), and how an owner
// override becomes the env value the code reads. No I/O here: the store, the env copy, the GET payload and the owner's
// POST are in src/feature-switch-store.mjs.
//
// Two kinds of row ("write"):
//   "feature-switch"   an AI Worker variable (wrangler.jsonc vars). The owner's override lives in KV
//                      FEATURE_SWITCH_OVERRIDE_KEY (SIGNAL_CACHE) as { KEY: { value, actor, at } }, `value` in the env form
//                      (exactly what wrangler.jsonc would hold, e.g. ZONE_AIM_OFF "tp,stop"). Resolution: the override,
//                      then the env (wrangler) value, then the code default; applied once per run onto a copy of env.
//   "omega-settings"   one of the owner's Omega settings (D1 omega_settings, src/omega-engine.mjs settingsFrom). FS1 does
//                      not store these: a POST goes through the Omega settings page's own write path (writeSettings).
//
// AGENT_VETO_RULE (SV1b) is a "feature-switch" row whose override is the owner's force (src/agent-veto.mjs): it is not
// copied onto env; resolveAgentVetoRule reads it before the automatic revert and the env value, as the force did.
// ROOM_BREAKOUT_WAIVE (RM1b, src/room-waive.mjs) is an ordinary env row with its own automatic revert (`hold`): the
// override is copied onto env as any other, and the copy names the keys it overrode (FEATURE_SWITCH_OVERRIDDEN), so the
// order owner override > auto-revert > env is decided from the resolved env alone.

import { PM_LINE_IDS } from "./pm-line-breaker.mjs";

export const FEATURE_SWITCHES_VERSION = "cryptophys.feature-switches.v1";
/** The owner's overrides: { KEY: { value, actor, at } } (actor a role word). Written only by the AI Worker's owner POST. */
export const FEATURE_SWITCH_OVERRIDE_KEY = "feature-switch:override:v1";
/** The one-time move of SV1b's agent-veto:owner:v1 into the override store: written once the move ran. */
export const FEATURE_SWITCH_VETO_MIGRATION_KEY = "feature-switch:migrated:agent-veto-owner:v1";
/** A run's env copy is re-read from KV at most this often per isolate (KV itself takes up to about a minute to spread). */
export const FEATURE_SWITCH_MEMO_MS = 30_000;
/**
 * RM1b: the keys whose value on a resolved env copy is the owner's override (an enumerable symbol, so it rides along when
 * a run spreads the copy into its own; never in JSON). A switch with an automatic revert (ROOM_BREAKOUT_WAIVE) reads it
 * for the order owner override > auto-revert > env without reading the store a second time.
 */
export const FEATURE_SWITCH_OVERRIDDEN = Symbol.for("cryptophys.feature-switches.overridden");
/** Pure: the keys the owner's override set on this env copy ([] for env itself or a copy without one). */
export function overriddenKeys(env) {
  const v = env && typeof env === "object" ? env[FEATURE_SWITCH_OVERRIDDEN] : null;
  return Array.isArray(v) ? v : [];
}

export const FEATURE_SWITCH_GROUPS = Object.freeze([
  Object.freeze({ id: "zones", label: "Demand and supply zones" }),
  Object.freeze({ id: "plans", label: "Plans, entries and targets" }),
  Object.freeze({ id: "agents", label: "Strategy agents and councils" }),
  Object.freeze({ id: "modes", label: "Trading-mode evidence" }),
  Object.freeze({ id: "lens", label: "Liquidity lens and calendar" }),
  Object.freeze({ id: "knowledge", label: "Knowledge and shadow arms" }),
  Object.freeze({ id: "omega", label: "Omega engine (owner settings)" })
]);

const s = (v) => String(v ?? "").trim().toLowerCase();
/** Pure: a raw value that is set (unset, null and undefined read as the code default). */
export const isSet = (raw) => raw !== undefined && raw !== null;

// Readers: each mirrors its switch's accessor in the code (test/feature-switches.test.mjs pins every one against it).
const onUnlessOff = (raw) => (s(raw) === "off" ? "off" : "on");
const offUnlessOn = (raw) => (s(raw) === "on" ? "on" : "off");
const ZONE_AIM_TOKENS = Object.freeze(["tp", "stop", "factor"]);
const ZONE_SOURCES = Object.freeze(["prophet_zone", "prophet_best", "whale", "gabfx", "gmi_flag", "gmi_ob"]);
const CHANGE_TOKENS = Object.freeze(["conf", "tpw", "limit", "skip", "stance"]);
const tokensGiven = (raw) => new Set(String(raw ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));

const entry = (e) => Object.freeze({
  era_switch: false, restarts_mode_evidence: false, emergency_stop: false, read_only: false, worker: "ai", write: "feature-switch", resolve: "env", config_only: [], hold: null, zone_hold: null,
  ...e,
  values: Array.isArray(e.values) ? Object.freeze([...e.values]) : Object.freeze({ type: "tokens", tokens: Object.freeze([...e.values.tokens]) })
});

/**
 * The registry, one entry per switch. Internal fields (not in the GET payload): `read` (raw value → panel value, the
 * accessor's rule), `toEnv` (panel value → the env form; the identity when absent), `config_only` (values the code reads
 * but the panel never sets), `resolve` ("env": copied onto the run's env; "agent-veto": the owner's force of SV1b;
 * "omega-settings": D1 omega_settings), `hold` ("room-waive": an env row with its own automatic revert, RM1b; null).
 */
export const FEATURE_SWITCHES = Object.freeze([
  // ---- Demand and supply zones (Z0, Z2, Z2b; src/zone-types.mjs)
  entry({
    key: "ZONE_PRIORITY", label: "Zone priority", group: "zones", emergency_stop: true, restarts_mode_evidence: true,
    description: "Z2: the guardrails' zone_ahead check and the zone aims, all under this switch; off behaves as before Z2 (no zone rule anywhere).",
    values: ["on", "off"], default_value: "off", config_value: "on", read: offUnlessOn
  }),
  entry({
    key: "ZONE_AHEAD_MODE", label: "Zone-ahead check", group: "zones", restarts_mode_evidence: true, zone_hold: "zone_ahead",
    description: "Z2: no trade into a decisive opposing zone inside max(1R, 0.75 ATR(1H)); trend exempts a with-trend plan, all exempts none (owner-set only, one warning line per decision). record and off are config-only.",
    values: ["trend", "all"], config_only: ["record", "off"], default_value: "trend", config_value: "trend",
    read: (raw) => { const v = s(isSet(raw) ? raw : "trend"); return ["trend", "all", "record", "off"].includes(v) ? v : "trend"; }
  }),
  entry({
    key: "KEY_LEVEL_ZONE_TYPES", label: "Typed key-level zones", group: "zones", emergency_stop: true, restarts_mode_evidence: true,
    description: "Z0: demand/supply type, strength and freshness on the Key Level Agent's zones; off removes every typed field, and every zone rule then behaves as before.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  entry({
    key: "ZONE_AIM_OFF", label: "Zone aims", group: "zones", restarts_mode_evidence: true, zone_hold: "aim",
    description: "Z2b: the execution plans aimed by zone type; the tokens listed are the rules ON (tp: TP2 at the next decisive opposing zone; stop: the stop past a decisive opposing zone; factor: pickStrategy's zone factor). Note: stop on with tp off, the reward gate holds stop_skip back more often (the stop widens, the target stays); ZONE_AIM_TP only matters while tp is on.",
    values: { tokens: ZONE_AIM_TOKENS }, default_value: [...ZONE_AIM_TOKENS], config_value: [],
    // The env holds the rules left OFF; the panel shows the rules ON.
    read: (raw) => { const off = tokensGiven(raw); return ZONE_AIM_TOKENS.filter((t) => !off.has(t)); },
    toEnv: (on) => ZONE_AIM_TOKENS.filter((t) => !on.includes(t)).join(",")
  }),
  entry({
    key: "ZONE_SOURCES_OFF", label: "Zone typing sources", group: "zones", restarts_mode_evidence: true,
    description: "Z1a/Z1b: the evidence sources the zone typing reads; the tokens listed are the sources ON (prophet_zone, prophet_best, whale, gabfx, gmi_flag, gmi_ob). Taking gmi_ob off restores Z1a's typing (gmi_flag back on the 15m); taking prophet_zone off too restores Z0's. Not set in the config: every source on.",
    values: { tokens: ZONE_SOURCES }, default_value: [...ZONE_SOURCES], config_value: null,
    // The env holds the sources left OFF (src/zone-types.mjs zoneSourcesOffMode); the panel shows the sources ON.
    read: (raw) => { const off = tokensGiven(raw); return ZONE_SOURCES.filter((t) => !off.has(t)); },
    toEnv: (on) => ZONE_SOURCES.filter((t) => !on.includes(t)).join(",")
  }),
  entry({
    key: "ZONE_AIM_TP", label: "Zone aim: TP1", group: "zones", restarts_mode_evidence: true,
    description: "Z2b: label keeps TP1's price (its words only); qualified moves TP1 to a nearer decisive opposing qualified zone at or beyond ZONE_NEED, owner-set only and only after the owner's TP1-KZ amendment (tp1_kz@2). Matters only while the tp aim is on.",
    values: ["label", "qualified"], default_value: "label", config_value: "label", read: (raw) => (s(raw) === "qualified" ? "qualified" : "label")
  }),
  entry({
    key: "ZONE_READINGS", label: "Zone readings and breaker", group: "zones",
    description: "Z5: the zone readings, the counterfactual tables (zone_blocked_setups, zone_rule_arms) and the decision-side zone breaker, which holds Z2/Z2b's rules back by itself when their own record turns against them; off writes nothing, the breaker is idle and GET /api/zones answers 404.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  // ---- Plans, entries and targets (src/strategy-engine.mjs, src/grid-adapt.mjs, src/projection-agent.mjs)
  entry({
    key: "ENTRY_ZONE_MODE", label: "Entry zone", group: "plans",
    description: "EZ1: the band beside the plan's entry where Omega may rest its limit; edge also uses the zone's near edge when the plan's level is out of the placement band, on is EZ1 alone, off sends no zone.",
    values: ["edge", "on", "off"], default_value: "edge", config_value: "edge", read: (raw) => { const v = s(isSet(raw) ? raw : "edge"); return v === "off" ? "off" : v === "on" ? "on" : "edge"; }
  }),
  entry({
    key: "TP1_KEY_ZONE_MODE", label: "TP1 at the nearest key zone", group: "plans", restarts_mode_evidence: true,
    description: "TP1-KZ: TP1 at the nearest key zone at least 1R away; off restores the earlier targets and gates.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  entry({
    key: "CHART_PATTERNS_MODE", label: "Chart patterns", group: "plans",
    description: "The Projection Agent's chart patterns in its reading and in the strategy; off leaves them out.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  entry({
    key: "GRID_ADAPT_MODE", label: "Grid adaptation", group: "plans",
    description: "The grid's automatic entry and stop per strategy and regime, chosen once a UTC day; off keeps every plan's own entry and stop.",
    values: ["live", "off"], default_value: "off", config_value: "live", read: (raw) => (s(raw) === "live" ? "live" : "off")
  }),
  entry({
    // RM1b (owner 2026-11-25, relayed: "Turn variant (d) on now"; src/room-waive.mjs). Its own automatic revert
    // (`hold`): the GET row carries auto_revert as AGENT_VETO_RULE's does; the owner's override wins over the hold.
    key: "ROOM_BREAKOUT_WAIVE", label: "Room waiver on a with-trend breakout", group: "plans", hold: "room-waive",
    description: "RM1b: the room check passes when it alone holds a side back, the 15m close is beyond the facing edge of a corridor recorded in the last hour, and the trend is with the side; it goes off by itself for 7 days when its waived trades lose. The owner's choice here wins over that revert; reset hands it back to the revert and the config.",
    values: ["on", "off"], default_value: "off", config_value: "on", read: offUnlessOn
  }),
  entry({
    // B5 (src/pm-line-breaker.mjs): the hand switch of the Position Manager lines; each line also has its own breaker.
    key: "PM_LINES_OFF", label: "Position Manager lines", group: "plans",
    description: "B5: the Position Manager's rules that send a close, a stop or a target, one line each; the tokens listed are the lines ON. A line also goes off by itself when its last 15 closes average below 0R, and comes back only with a new version or the owner's turn-on (POST /omega/api/pm-lines). An off line's rule acts as if it did not fire. Not set in the config: every line on.",
    values: { tokens: PM_LINE_IDS }, default_value: [...PM_LINE_IDS], config_value: null,
    // The env holds the lines left OFF (src/pm-line-breaker.mjs pmLinesOffEnv); the panel shows the lines ON.
    read: (raw) => { const off = tokensGiven(raw); return PM_LINE_IDS.filter((t) => !off.has(t)); },
    toEnv: (on) => PM_LINE_IDS.filter((t) => !on.includes(t)).join(",")
  }),
  // ---- Strategy agents and councils
  entry({
    key: "AGENT_VETO_RULE", label: "Strategy-agent veto rule", group: "agents", resolve: "agent-veto",
    description: "SV1b: two_sided lets an agent that speaks on both sides no longer count against the side it also speaks for (A6, A7); it goes back to classic by itself for 7 days when its softened trades lose. The owner's choice here wins over that revert; reset hands it back to the revert and the config.",
    values: ["two_sided", "classic"], default_value: "classic", config_value: "two_sided", read: (raw) => (s(raw) === "two_sided" ? "two_sided" : "classic")
  }),
  entry({
    key: "CFC_MODE", label: "Call for Councils", group: "agents",
    description: "suggest runs the hourly suggestion flags (no model call); on also lets the owner open council sessions (with the switch on the Councils page); off runs nothing.",
    values: ["off", "suggest", "on"], default_value: "suggest", config_value: "on",
    read: (raw) => { if (!isSet(raw) || String(raw).trim() === "") return "suggest"; const v = s(raw); return ["off", "suggest", "on"].includes(v) ? v : "off"; }
  }),
  // ---- Trading-mode evidence (MS2, src/mode-shadow.mjs)
  entry({
    key: "MODE_SHADOW_EVIDENCE", label: "Shadow per-mode evidence", group: "modes",
    description: "MS2: each mode not in force is decided deterministically at every 15m decision, for the mode selector's evidence only; off writes no shadow row and the selector reads live setups alone.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  entry({
    key: "MODE_PROBATION", label: "Mode probation", group: "modes",
    description: "MS2: a switch to a mode with fewer than 31 live setups trades at half the risk on Omega's new orders of that mode until it passes or fails; off: full risk.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  // ---- Liquidity lens and calendar
  entry({
    key: "LIQUIDITY_WITNESS", label: "Liquidity card for the council", group: "lens",
    description: "B15: lens B's LIQUIDITY card beside the witnesses, for the council only (never the quorum, the guardrails or the weights); off: no card and the council's prompt as before.",
    values: ["on", "off"], default_value: "on", config_value: "on", read: onUnlessOff
  }),
  entry({
    key: "LENS_ROOM_LINE", label: "Liquidity conditions in the rooms", group: "lens",
    description: "B16: conditions lets the risk desk and the moderator read lens B's liquidity conditions (plain words, no price); brief keeps the brief's line only. No model call is added either way.",
    values: ["conditions", "brief"], default_value: "conditions", config_value: "conditions", read: (raw) => (s(raw) === "brief" ? "brief" : "conditions")
  }),
  entry({
    key: "CALENDAR_CONTRARIAN", label: "Calendar contrarian drift", group: "lens",
    description: "The Calendar Agent: a release kind whose gold drifted against the consensus significantly leans the other way; off holds it at 0.",
    values: ["on", "off"], default_value: "off", config_value: "on", read: offUnlessOn
  }),
  // ---- Knowledge and shadow arms
  entry({
    key: "SHADOW_KNOWLEDGE_ENABLED", label: "Learned-note shadow arm", group: "knowledge", emergency_stop: true,
    description: "Aether's learned notes tested in shadow (an extra opening call per agent, capped per hour), never in a live prompt; off stops the arm at once. Shown as on/off; the variable holds true/false.",
    values: ["on", "off"], default_value: "off", config_value: "on", read: (raw) => (s(raw) === "true" ? "on" : "off"),
    toEnv: (v) => (v === "on" ? "true" : "false")
  }),
  entry({
    key: "KNOWLEDGE_VERDICT_POSTS", label: "Knowledge verdicts to the platform", group: "knowledge",
    description: "KA2: the arm's verdicts posted to the platform for Aether's curator; needs the learned-note shadow arm on.",
    values: ["on", "off"], default_value: "off", config_value: "on", read: (raw) => (s(isSet(raw) ? raw : "off") === "on" ? "on" : "off")
  }),
  entry({
    key: "METRIC_REBUTTAL", label: "Metric rebuttals", group: "knowledge", read_only: true,
    description: "The metric rebuttal shadow arm: anything but off counts as on, and it also needs METRIC_SHADOW. Retired by the owner on 2026-11-19 (every arm stopped), so shown here for information only.",
    values: ["on", "off"], default_value: "on", config_value: "off", read: onUnlessOff
  }),
  entry({
    key: "OWNER_CORRECTIONS", label: "Owner corrections to the platform (H3f)", group: "knowledge",
    description: "HAIC H3f: the owner's ratings and corrections of Nexus outputs (POST /omega/api/correction) stored here with prices masked and sent to the platform as nexus-teacher; off records and sends nothing. Never changes a parameter, a weight or a gate.",
    values: ["on", "off"], default_value: "off", config_value: null, read: offUnlessOn
  }),
  entry({
    key: "SHADOW_MODEL_ROUTER", label: "Shadow model router: news comparison on Beam (SB1)", group: "knowledge",
    description: "SB1: the news shadow comparison's two daily readings asked of Reflection's Beam (free Beta, its own caps: 100k input and 20k output tokens, 20 requests a day, 2 a minute) instead of the Workers AI agent model; no other call routes. Any limit, error, timeout, paid sign, missing retention terms, invalid answer or a platform router status other than on falls back to Workers AI for that call. off: as before.",
    values: ["on", "off"], default_value: "off", config_value: null, read: offUnlessOn
  }),
  // ---- Omega engine, the owner's settings (D1 omega_settings; the Omega settings page's write path)
  entry({
    key: "profit_lock_gate", label: "Profit-lock gate", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "SLG1: no stop moves into profit until the position's MFE on closed bars of its mode's timeframe reaches the mode's threshold; legacy: the earlier locks.",
    values: ["on", "legacy"], default_value: "on", config_value: null, read: (raw) => raw
  }),
  entry({
    key: "change_thresholds", label: "Change thresholds", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "CH1: a confluence or confidence change acts only past its threshold, per trigger (conf, tpw, limit, skip, stance); a trigger left off uses the earlier rule.",
    values: { tokens: CHANGE_TOKENS }, default_value: [...CHANGE_TOKENS], config_value: null,
    // Stored as the on-list ("conf,tpw,…") or "off" (src/change-thresholds.mjs changeTokens).
    read: (raw) => { if (!isSet(raw)) return [...CHANGE_TOKENS]; const v = s(raw); if (v === "" || v === "off" || v === "none") return []; if (v === "on" || v === "all") return [...CHANGE_TOKENS]; const parts = v.split(/[\s,]+/).filter(Boolean); if (!parts.length || parts.some((p) => !CHANGE_TOKENS.includes(p))) return [...CHANGE_TOKENS]; return CHANGE_TOKENS.filter((t) => parts.includes(t)); },
    toEnv: (on) => (on.length ? CHANGE_TOKENS.filter((t) => on.includes(t)).join(",") : "off")
  }),
  entry({
    key: "pm_fast_1m", label: "1m fast-protect layer", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "PM-1M: the fast TP anticipation and loss reduction on closed broker M1 bars; off: the engine as before.",
    values: ["on", "off"], default_value: "on", config_value: null, read: (raw) => raw
  }),
  entry({
    key: "reentry_1m", label: "1m re-entry after a lock stop", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "RE1: one re-entry of a setup a break-even or lock stop closed, when a closed broker 1m bar closes back beyond the lock; off: the engine as before.",
    values: ["on", "off"], default_value: "on", config_value: null, read: (raw) => raw
  }),
  entry({
    key: "limit_supersede", label: "Newer signal supersedes a resting limit", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "SS1: a newer same-side signal deletes Omega's older resting, unfilled limit, then goes through every gate; off: the engine as before.",
    values: ["on", "off"], default_value: "on", config_value: null, read: (raw) => raw
  }),
  entry({
    key: "cd_gate", label: "Confidence-drop gate (CDG)", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "CDG: a confidence drop closes a winner only where the learned gate passes for the agent, side and drop bucket (lift >= 0.10 over n >= 30); every other drop is held. Reverts itself to off once if its first 15 outcomes average worse than the earlier rule; off: the engine as before.",
    values: ["on", "off"], default_value: "on", config_value: null, read: (raw) => raw
  }),
  entry({
    // Z3a (owner-set only; Aether's policy, its rollback and Z5's breaker never write it): OMEGA_DEFAULTS.zone_mgmt,
    // settingsFrom's check and ERA_SWITCHES' entry. Z3b adds omega_pm and Z4 full.
    key: "zone_mgmt", label: "Zone-typed management (Z3a)", group: "omega", worker: "omega", write: "omega-settings", resolve: "omega-settings", era_switch: true,
    description: "Z3a: omega moves SL+ behind the position's own decisive demand or supply zone (at most 0.15-0.30R looser than today's, never below the lock) and the trailing TP to a decisive opposing zone at most one zone further; one modify per position per 3 minutes across this and the 1m fast layer. off: the engine as before (the documented rollback). The owner's switch only.",
    values: ["off", "omega"], default_value: "off", config_value: null, read: (raw) => raw
  })
]);

export const FEATURE_SWITCH_KEYS = Object.freeze(FEATURE_SWITCHES.map((e) => e.key));
/** Pure: the registry entry of a key, or null. */
export function switchByKey(key) {
  return typeof key === "string" ? FEATURE_SWITCHES.find((e) => e.key === key) ?? null : null;
}
export const isTokens = (e) => !Array.isArray(e?.values);
/** Pure: the panel value of a raw value (unset: the code default). */
export function readSwitch(e, raw) {
  if (!isSet(raw)) return isTokens(e) ? [...e.default_value] : e.default_value;
  return e.read(raw);
}
/** Pure: the env (or stored) form of a panel value. */
export const envForm = (e, value) => (typeof e.toEnv === "function" ? e.toEnv(value) : value);

/**
 * Pure: a value the owner may set, normalized ({ value } in the panel form, token lists in token order), or
 * { error: "invalid_value" }. Token lists take the on-list: an array of tokens or a comma-separated text ("" is none).
 */
export function normalizeValue(e, value) {
  if (isTokens(e)) {
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : null;
    if (!list || list.some((t) => typeof t !== "string" || !e.values.tokens.includes(t.trim().toLowerCase()))) return { error: "invalid_value" };
    const on = new Set(list.map((t) => t.trim().toLowerCase()));
    return { value: e.values.tokens.filter((t) => on.has(t)) };
  }
  if (typeof value !== "string") return { error: "invalid_value" };
  const v = value.trim().toLowerCase();
  return e.values.includes(v) ? { value: v } : { error: "invalid_value" };
}

/**
 * Pure: is a stored override of `e` valid? Its value must be the env form of a value the panel may set, exactly (an
 * override the panel could not have written, a config-only value, a read-only or an Omega-settings key, is not).
 */
export function validOverride(e, o) {
  if (!e || e.read_only || e.write !== "feature-switch" || !o || typeof o !== "object" || typeof o.value !== "string") return false;
  const v = e.read(o.value);
  const allowed = isTokens(e) ? true : e.values.includes(v);
  return allowed && envForm(e, v) === o.value;
}

/** Pure: the stored overrides document ({} when empty or unreadable as JSON). */
export function parseOverrides(raw) {
  try { const d = typeof raw === "string" ? JSON.parse(raw) : raw; return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch { return {}; }
}

/**
 * Pure: the env patch of the overrides ({ KEY: env form } for every valid override copied onto env) and the keys
 * ignored (unknown, invalid, read-only or not FS1's to store). AGENT_VETO_RULE's override is valid but not copied: its
 * resolution is SV1b's (the owner's force before the automatic revert).
 */
export function overridePatch(doc) {
  const patch = {}, ignored = [];
  for (const [key, o] of Object.entries(parseOverrides(doc))) {
    const e = switchByKey(key);
    if (!validOverride(e, o)) { ignored.push(key); continue; }
    if (e.resolve === "env") patch[key] = o.value;
  }
  return { patch, ignored };
}

/**
 * Pure: an env row's value in force: the owner's override, then the env (wrangler) value, then the code default.
 * { value, source: "override" | "config" | "default", set_by, set_at }.
 */
export function resolveEnvSwitch(e, { override = null, env = {} } = {}) {
  if (validOverride(e, override)) return { value: readSwitch(e, override.value), source: "override", set_by: roleWord(override.actor), set_at: isoOrNull(override.at) };
  const raw = env?.[e.key];
  if (isSet(raw)) return { value: readSwitch(e, raw), source: "config", set_by: null, set_at: null };
  return { value: readSwitch(e, undefined), source: "default", set_by: null, set_at: null };
}

/** Pure: who set a value, as a role word (never an email or an identity): owner, aether, agent or system. */
export function roleWord(actor) {
  const a = String(actor ?? "").trim();
  if (!a) return null;
  if (/^aether/i.test(a)) return "aether";
  if (a.startsWith("agent:") || a === "agent") return "agent";
  if (a === "system") return "system";
  return "owner";
}
export const isoOrNull = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : Number.isFinite(v) ? new Date(v).toISOString() : null);

/** Pure: the payload's values field: the allowed values, or for a token list { type, tokens, on } (the tokens ON). */
export function valuesField(e, value) {
  return isTokens(e) ? { type: "tokens", tokens: [...e.values.tokens], on: Array.isArray(value) ? [...value] : [] } : [...e.values];
}

/** Pure: one payload row (exactly the shape promised to the panel). */
export function switchRow(e, { value, source, config_value = null, set_by = null, set_at = null }) {
  return {
    key: e.key, label: e.label, description: e.description, group: e.group, worker: e.worker,
    values: valuesField(e, value), value: Array.isArray(value) ? [...value] : value, source,
    config_value: Array.isArray(config_value) ? [...config_value] : config_value, default_value: Array.isArray(e.default_value) ? [...e.default_value] : e.default_value,
    set_by: set_by == null ? null : roleWord(set_by), set_at: set_at ?? null,
    era_switch: e.era_switch, restarts_mode_evidence: e.restarts_mode_evidence, emergency_stop: e.emergency_stop, read_only: e.read_only, write: e.write
  };
}

/** Pure: a value in words for a Telegram line (token lists "tp, stop" or "none"). */
export const valueText = (v) => (Array.isArray(v) ? (v.length ? v.join(", ") : "none") : String(v ?? "unset"));
