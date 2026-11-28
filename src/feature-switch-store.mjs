// FS1, the owner's feature-switch panel at run time (src/feature-switches.mjs holds the registry). Three things:
//   1. withFeatureSwitches(env): the run's env with the owner's overrides (KV FEATURE_SWITCH_OVERRIDE_KEY in SIGNAL_CACHE),
//      resolved once at each entry point of the AI Worker (fetch, queue, scheduled and the RPC entrypoints), on a copy:
//      env itself is never written. No valid override: env itself, unchanged. An unreadable store: env (one log line).
//      An invalid override: ignored, one log line. The overrides are re-read at most every FEATURE_SWITCH_MEMO_MS per
//      isolate; the copy is kept while they do not change, so the per-binding memos of the code keep working.
//   2. featureSwitchesPayload(env): GET /api/feature-switches (the Nexus read API) and the Omega Worker's GET of the same
//      path (OmegaGateway.featureSwitches, with the viewer's owner check).
//   3. setFeatureSwitch(env, ...): the owner's POST (Omega Worker → OmegaGateway.setFeatureSwitch; OWNER_ACCESS_SUB checked
//      again here). A "feature-switch" row writes the override store, one audit row in omega_events (`feature_switch`,
//      which is the Omega event; told where it happens) and one Telegram line. An "omega-settings" row goes through the
//      Omega settings page's own write path (writeSettings: settingsFrom's validation, the `settings` audit row told by the
//      change audit's sweep, and updated_ms, which starts the parity era exactly as the page's save does). AGENT_VETO_RULE
//      is SV1b's owner force (src/agent-veto.mjs setAgentVetoForce writes it to the same override store).
//   ROOM_BREAKOUT_WAIVE (RM1b) is a plain "feature-switch" row whose GET row also carries its automatic revert's hold
//      (auto_revert, src/room-waive.mjs), as AGENT_VETO_RULE's does.
//   ZONE_AHEAD_MODE and ZONE_AIM_OFF (Z5) carry the zone breaker's decision-side holds as `zone_hold` (one KV read of
//      zone-priority:breaker:v1, src/zone-readings.mjs zoneHoldRows): { since, until, by } on ZONE_AHEAD_MODE, a map of
//      the tokens held on ZONE_AIM_OFF, null when nothing is held or the state is unreadable. The row's value stays the
//      owner's: a hold never changes the owner's switch.

import {
  FEATURE_SWITCHES, FEATURE_SWITCH_GROUPS, FEATURE_SWITCHES_VERSION, FEATURE_SWITCH_OVERRIDE_KEY, FEATURE_SWITCH_MEMO_MS,
  switchByKey, readSwitch, envForm, normalizeValue, parseOverrides, overridePatch, resolveEnvSwitch, switchRow, roleWord, isoOrNull, isSet, valueText,
  FEATURE_SWITCH_OVERRIDDEN
} from "./feature-switches.mjs";
import { resolveAgentVetoRule, readOwnerForceDoc, setAgentVetoForce, AGENT_VETO_AUTO_KEY, autoRevertAt } from "./agent-veto.mjs";
import { readRoomHold } from "./room-waive.mjs";
import { readFreshPatternHold } from "./fresh-pattern.mjs";
import { zoneHoldRows } from "./zone-readings.mjs";
import { readSettings, writeSettings, readSettingsKeyMeta } from "./omega-broker.mjs";
import { OMEGA_DEFAULTS } from "./omega-engine.mjs";
import { ownerCheck } from "./strategy-arm.mjs";

const RESOLVED = Symbol.for("cryptophys.feature-switches.resolved");
/** The env a resolved copy was made from (its config values): the payload and the POST read the config there. */
const baseEnv = (env) => (env && typeof env === "object" && env[RESOLVED] && typeof env[RESOLVED] === "object" ? env[RESOLVED] : env);
const parse = (t, d = null) => { try { return t == null ? d : JSON.parse(t); } catch { return d; } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

let readMemo = { kv: null, at: 0, ok: true, raw: null };
let copyMemo = { base: null, raw: undefined, copy: null };
let logged = { ignored: undefined, unreadable_at: 0 };
export function resetFeatureSwitchMemoForTests() {
  readMemo = { kv: null, at: 0, ok: true, raw: null };
  copyMemo = { base: null, raw: undefined, copy: null };
  logged = { ignored: undefined, unreadable_at: 0 };
}

/** The stored overrides' raw text ({ ok: false } when the KV cannot be read). `fresh` skips the isolate's memo. */
export async function readOverridesRaw(kv, { now = Date.now(), fresh = false } = {}) {
  if (!kv?.get) return { ok: true, raw: null };
  if (!fresh && readMemo.kv === kv && now - readMemo.at < FEATURE_SWITCH_MEMO_MS && now >= readMemo.at) return { ok: readMemo.ok, raw: readMemo.raw };
  let ok = true, raw = null;
  try { raw = await kv.get(FEATURE_SWITCH_OVERRIDE_KEY); } catch { ok = false; raw = null; }
  readMemo = { kv, at: now, ok, raw: raw ?? null };
  return { ok, raw: raw ?? null };
}

/**
 * The run's env with the owner's overrides of the "feature-switch" rows copied on (never AGENT_VETO_RULE: its force is
 * read by resolveAgentVetoRule). Never throws; never writes env.
 */
export async function withFeatureSwitches(env, { now = Date.now() } = {}) {
  if (!env || typeof env !== "object" || env[RESOLVED]) return env;
  const kv = env.SIGNAL_CACHE;
  if (!kv?.get) return env;
  try {
    const r = await readOverridesRaw(kv, { now });
    if (!r.ok) {
      if (now - logged.unreadable_at >= FEATURE_SWITCH_MEMO_MS) { logged.unreadable_at = now; console.warn(JSON.stringify({ event: "feature_switch_store_unreadable", fallback: "env" })); }
      return env;
    }
    if (r.raw == null) return env;
    const { patch, ignored } = overridePatch(r.raw);
    if (ignored.length && logged.ignored !== r.raw) { logged.ignored = r.raw; console.warn(JSON.stringify({ event: "feature_switch_override_ignored", keys: ignored })); }
    if (!Object.keys(patch).length) return env;
    if (copyMemo.base === env && copyMemo.raw === r.raw) return copyMemo.copy;
    // RM1b: the keys set by an override ride on the copy (FEATURE_SWITCH_OVERRIDDEN, an enumerable symbol: never in JSON),
    // so a switch with an automatic revert knows an owner's override from the config without reading the store again.
    const copy = { ...env, ...patch, [FEATURE_SWITCH_OVERRIDDEN]: Object.freeze(Object.keys(patch)) };
    Object.defineProperty(copy, RESOLVED, { value: env, enumerable: false });
    copyMemo = { base: env, raw: r.raw, copy };
    return copy;
  } catch {
    return env;
  }
}

/** The AGENT_VETO_RULE row's state: the owner's force (FS1, or SV1b's key before the move), the revert, the rule in force. */
async function vetoState(env, now) {
  const kv = env?.SIGNAL_CACHE;
  let force = null, auto = null;
  try { force = await readOwnerForceDoc(kv); } catch { force = null; }
  try { auto = autoRevertAt(parse(await kv?.get?.(AGENT_VETO_AUTO_KEY)), now); } catch { auto = null; }
  const resolved = await resolveAgentVetoRule(env, { now });
  return { force, auto, resolved };
}

/** The "omega-settings" rows' state: the stored settings and each key's { by, at }. Null when unreadable. */
async function omegaState(env) {
  if (!env?.DB) return null;
  try { return { settings: (await readSettings(env)).settings, meta: await readSettingsKeyMeta(env) }; } catch { return null; }
}

/** RM1b: the automatic revert's hold of a "hold" row ({ since, until } while it holds), or null (also when unreadable). */
async function holdState(env, e, now) {
  try {
    if (e.hold === "room-waive") return await readRoomHold(env?.SIGNAL_CACHE, now);
    if (e.hold === "fresh-pattern") return await readFreshPatternHold(env?.SIGNAL_CACHE);
    return null;
  } catch { return null; }
}

/** Pure: one row from the states read. */
/** Z5: the zone breaker's holds for the zone_hold rows, on the env the overrides resolve to; null rows when unreadable. */
async function zoneHoldState(env, doc) {
  try { return await zoneHoldRows({ ...env, ...overridePatch(doc).patch }); } catch { return { zone_ahead: null, aim: null }; }
}

function rowFrom(e, { env, doc, veto, omega, holds = {}, zoneHolds = null }) {
  if (e.resolve === "omega-settings") {
    const stored = omega?.settings?.[e.key];
    const value = readSwitch(e, isSet(stored) ? stored : OMEGA_DEFAULTS[e.key]);
    // Ruling 4: a setting at its default reads "default" (a reset goes to OMEGA_DEFAULTS); otherwise the owner's value.
    const source = same(value, readSwitch(e, OMEGA_DEFAULTS[e.key])) ? "default" : "override";
    const m = source === "override" ? omega?.meta?.[e.key] : null;
    return switchRow(e, { value, source, config_value: null, set_by: m?.by ?? null, set_at: isoOrNull(m?.at) });
  }
  const config_value = isSet(env?.[e.key]) ? readSwitch(e, env[e.key]) : null;
  if (e.resolve === "agent-veto") {
    const f = veto?.force;
    if (f) return { ...switchRow(e, { value: f.rule, source: "override", config_value, set_by: f.actor ?? "owner", set_at: isoOrNull(f.at) }), auto_revert: null };
    const base = resolveEnvSwitch(e, { env });
    const value = veto?.resolved?.rule ?? base.value;
    return { ...switchRow(e, { value, source: base.source, config_value }), auto_revert: veto?.auto ? { since: isoOrNull(veto.auto.since), until: isoOrNull(veto.auto.until) } : null };
  }
  const r = resolveEnvSwitch(e, { override: doc[e.key] ?? null, env });
  if (e.hold) {
    // RM1b (ROOM_BREAKOUT_WAIVE), FP1 (FRESH_PATTERN_MODE): the owner's override wins over the hold; else the row's
    // hold_value ("off"; FP1 "record") while the automatic revert holds (FP1: only over "on").
    if (r.source === "override") return { ...switchRow(e, { ...r, config_value }), auto_revert: null };
    const h = e.hold === "fresh-pattern" && r.value !== "on" ? null : holds[e.key] ?? null;
    return { ...switchRow(e, { ...r, value: h ? e.hold_value : r.value, config_value }), auto_revert: h ? { since: isoOrNull(h.since), until: isoOrNull(h.until) } : null };
  }
  // Z5: the breaker's decision-side hold beside the owner's value (never instead of it).
  if (e.zone_hold) return { ...switchRow(e, { ...r, config_value }), zone_hold: zoneHolds?.[e.zone_hold] ?? null };
  return switchRow(e, { ...r, config_value });
}

/** GET /api/feature-switches: every switch with its value in force, its source and its flags. Never throws. */
export async function featureSwitchesPayload(env, { now = Date.now(), canControl = false } = {}) {
  env = baseEnv(env);
  const r = await readOverridesRaw(env?.SIGNAL_CACHE, { now, fresh: true });
  const doc = r.ok ? parseOverrides(r.raw) : {};
  let veto = null;
  try { veto = await vetoState(env, now); } catch { veto = null; }
  const omega = await omegaState(env);
  const holds = {};
  for (const e of FEATURE_SWITCHES) if (e.hold) holds[e.key] = await holdState(env, e, now);
  const zoneHolds = await zoneHoldState(env, doc);
  return {
    version: FEATURE_SWITCHES_VERSION, at: new Date(now).toISOString(),
    viewer: { can_control: canControl === true },
    groups: FEATURE_SWITCH_GROUPS.map((g) => ({ id: g.id, label: g.label })),
    switches: FEATURE_SWITCHES.map((e) => rowFrom(e, { env, doc, veto, omega, holds, zoneHolds }))
  };
}

async function currentRow(env, e, now) {
  const r = await readOverridesRaw(env?.SIGNAL_CACHE, { now, fresh: true });
  if (!r.ok) return null;
  const veto = e.resolve === "agent-veto" ? await vetoState(env, now) : null;
  const omega = e.resolve === "omega-settings" ? await omegaState(env) : null;
  const holds = e.hold ? { [e.key]: await holdState(env, e, now) } : {};
  const doc = parseOverrides(r.raw);
  const zoneHolds = e.zone_hold ? await zoneHoldState(env, doc) : null;
  return rowFrom(e, { env, doc, veto, omega, holds, zoneHolds });
}

/** The Telegram line of a feature-switch change (no price, no person: "the owner"). */
export function featureSwitchLine(e, before, after, { reset = false } = {}) {
  const was = `${valueText(before?.value)} (${before?.source ?? "unknown"})`, now = `${valueText(after.value)} (${after.source})`;
  const extra = [
    e.restarts_mode_evidence ? "The mode evidence restarts with the new rule version." : null,
    (e.key === "AGENT_VETO_RULE" || e.hold) && reset ? "The automatic revert and the config decide again." : null
  ].filter(Boolean).join(" ");
  return `XAUUSD SYSTEM · Feature switch ${e.label} (${e.key}) ${reset ? "reset" : "set"} by the owner: ${was} → ${now}.${extra ? ` ${extra}` : ""}`;
}

/**
 * The owner's POST: { key, value } sets, { key, reset: true } returns to the config (an Omega setting: to OMEGA_DEFAULTS;
 * AGENT_VETO_RULE: "auto" also resets). Token lists take the on-list. Returns { ok: true, switch, changed } or
 * { ok: false, error } with error unknown_key, invalid_value, read_only, owner_only or unavailable. Owner only: the
 * Access user id must equal OWNER_ACCESS_SUB (set). Never throws.
 */
export async function setFeatureSwitch(env, { key, value, reset = false, actor = "owner", actor_sub = null, now = Date.now(), send = null } = {}) {
  env = baseEnv(env);
  if (ownerCheck(env, actor_sub) !== "owner") return { ok: false, error: "owner_only" };
  const e = switchByKey(key);
  if (!e) return { ok: false, error: "unknown_key" };
  if (e.read_only) return { ok: false, error: "read_only" };
  let doReset = reset === true;
  if (e.key === "AGENT_VETO_RULE" && typeof value === "string" && value.trim().toLowerCase() === "auto") doReset = true;
  let want = null;
  if (!doReset) {
    const n = normalizeValue(e, value);
    if (n.error) return { ok: false, error: "invalid_value" };
    want = n.value;
  }
  const kv = env?.SIGNAL_CACHE;
  try {
    const before = await currentRow(env, e, now);
    if (e.resolve === "omega-settings") {
      if (!env?.DB) return { ok: false, error: "unavailable" };
      const stored = doReset ? OMEGA_DEFAULTS[e.key] : envForm(e, want);
      if (before && same(readSwitch(e, stored), before.value)) return { ok: true, switch: before, changed: false };
      // The Omega settings page's own write path: the same validation, audit row and era start.
      const w = await writeSettings(env, { body: { [e.key]: stored }, actor: String(actor || "owner") }, { now });
      if (w?.ok === false) return { ok: false, error: "invalid_value", detail: String(w.error ?? "").slice(0, 200) };
      const after = await currentRow(env, e, now);
      return { ok: true, switch: after, changed: true, audit: "settings" };
    }
    if (!kv?.get || !kv?.put || !before) return { ok: false, error: "unavailable" };
    // Nothing to change: the same override again, or a reset with no override.
    if (doReset ? before.source !== "override" : before.source === "override" && same(before.value, want)) return { ok: true, switch: before, changed: false };
    if (e.resolve === "agent-veto") {
      const r = await setAgentVetoForce(env, { rule: doReset ? "auto" : want, actor: "owner", now });
      if (r?.ok === false) return { ok: false, error: "invalid_value" };
    } else {
      const raw = await kv.get(FEATURE_SWITCH_OVERRIDE_KEY);
      const doc = parseOverrides(raw);
      if (doReset) delete doc[e.key];
      else doc[e.key] = { value: envForm(e, want), actor: roleWord(actor) ?? "owner", at: new Date(now).toISOString() };
      const text = JSON.stringify(doc);
      await kv.put(FEATURE_SWITCH_OVERRIDE_KEY, text);
      // This isolate sees the change at once; others within FEATURE_SWITCH_MEMO_MS (and KV's own spread).
      readMemo = { kv, at: now, ok: true, raw: text };
    }
    const after = await currentRow(env, e, now);
    const changed = !same(before.value, after.value) || before.source !== after.source;
    if (changed) {
      const detail = { key: e.key, from: valueText(before.value), to: valueText(after.value), source_from: before.source, source_to: after.source, reset: doReset };
      try { await env?.DB?.prepare?.("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "owner", "feature_switch", JSON.stringify(detail)).run(); } catch (err) { console.error("feature_switch_audit_failed", String(err?.message ?? err)); }
      if (typeof send === "function") { try { await send(featureSwitchLine(e, before, after, { reset: doReset })); } catch (err) { console.error("feature_switch_telegram_failed", String(err?.message ?? err)); } }
    }
    const out = { ok: true, switch: after, changed };
    if (e.resolve === "agent-veto") {
      const v = await resolveAgentVetoRule(env, { now });
      Object.defineProperty(out, "veto", { value: { force: doReset ? "auto" : want, rule: v.rule, source: v.source }, enumerable: false });
    }
    return out;
  } catch (err) {
    return { ok: false, error: "unavailable", detail: String(err?.message ?? err).slice(0, 200) };
  }
}
