// FS1, the owner's Feature switches page (owner 2026-11-25, relayed: "supaya bisa dikontrol perlu panel khusus pengaturan
// on off untuk semua fitur ini"; owner-reviewed mockup "Nexus FS1 Feature switches"). Pure: the GET payload of
// /omega/api/feature-switches read null-safely (src/feature-switch-store.mjs featureSwitchesPayload is the contract), the
// control of each row, the confirm of each change, the text of each POST error, the two desktop columns, and the one
// write: POST /omega/api/feature-switches (the Omega Worker's owner-only route; an Omega setting row goes through the
// same route, and the AI Worker forwards it to the Omega settings write path itself). No React here.
import { gmt7ClockOf, utcClockOf } from "./entryZone";

export const FS_PATH = "/omega/api/feature-switches";
/** The GET's cadence, as the other Nexus pages poll theirs (a change by the owner refreshes it at once). */
export const FS_POLL_MS = 60_000;

export type Source = "override" | "config" | "default";
export type TokenValues = { type: "tokens"; tokens: string[]; on: string[] };
export type SwitchValue = string | string[];
export type SwitchRow = {
  key: string; label: string; description: string; group: string; worker: string;
  values: string[] | TokenValues; value: SwitchValue | null; source: Source | null;
  config_value: SwitchValue | null; default_value: SwitchValue | null;
  /** A role word (owner, aether, agent, system), never an identity. */
  set_by: string | null; set_at: string | null;
  era_switch: boolean; restarts_mode_evidence: boolean; emergency_stop: boolean; read_only: boolean;
  write: "feature-switch" | "omega-settings";
  /** AGENT_VETO_RULE only: SV1b's automatic revert while it holds. */
  auto_revert: { since: string | null; until: string | null } | null;
  /**
   * Values the code reads but the panel never sets (the registry's `config_only`, e.g. ZONE_AHEAD_MODE's record and off).
   * The GET payload does not carry the field today (src/feature-switches.mjs switchRow); read when it does, else [].
   */
  config_only: string[];
  /**
   * Z5: the zone breaker's decision-side hold (ZONE_AHEAD_MODE: one hold; ZONE_AIM_OFF: one per held token). The row's
   * value stays the owner's; null when nothing is held or the breaker's store cannot be read.
   */
  zone_hold: ZoneHold | null;
};
/** One hold of the zone breaker: since and until (ISO, null when missing) and why ("typing", "block", "rule:<name>", or any other word). */
export type ZoneHoldEntry = { since: string | null; until: string | null; by: string[] };
export type ZoneHold = { kind: "single"; hold: ZoneHoldEntry } | { kind: "tokens"; holds: [string, ZoneHoldEntry][] };
export type SwitchGroup = { id: string; label: string; rows: SwitchRow[] };
export type Switches = { at: number | null; canControl: boolean; groups: SwitchGroup[]; rows: SwitchRow[]; overrides: number };
export type ControlKind = "toggle" | "segmented" | "tokens";

const isStr = (v: unknown): v is string => typeof v === "string";
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const SOURCES: Source[] = ["override", "config", "default"];
/** The only words a "set by" may show (src/feature-switches.mjs roleWord): never an email or an identity. */
export const ROLE_WORDS = ["owner", "aether", "agent", "system"];
const iso = (v: unknown): string | null => (isStr(v) && Number.isFinite(Date.parse(v)) ? v : null);
const valueOf = (v: unknown): SwitchValue | null => (Array.isArray(v) ? strs(v) : isStr(v) ? v : null);

const holdEntry = (h: any): ZoneHoldEntry | null => (h && typeof h === "object" && !Array.isArray(h)
  ? { since: iso(h.since), until: iso(h.until), by: strs(h.by).map((b) => b.slice(0, 40)).filter(Boolean) } : null);
/**
 * Z5's zone_hold, null-safe: a token row's { tp?: hold, stop?: hold, factor?: hold } (in the row's token order, then any
 * other key), any other row's { since, until, by }. Unknown `by` words are kept; a missing since or until is null.
 */
export function zoneHoldOf(z: any, tokens: string[] | null): ZoneHold | null {
  if (!z || typeof z !== "object" || Array.isArray(z)) return null;
  if (!tokens) { const h = holdEntry(z); return h ? { kind: "single", hold: h } : null; }
  const keys = [...tokens.filter((t) => t in z), ...Object.keys(z).filter((k) => !tokens.includes(k))];
  const holds = keys.map((k) => [k.slice(0, 40), holdEntry(z[k])] as [string, ZoneHoldEntry | null]).filter((x): x is [string, ZoneHoldEntry] => x[1] != null);
  return holds.length ? { kind: "tokens", holds } : null;
}

/** One payload row, null-safe: null when it has no key. */
export function rowOf(x: any): SwitchRow | null {
  if (!x || typeof x !== "object" || !isStr(x.key) || !x.key) return null;
  const tokens = x.values && typeof x.values === "object" && !Array.isArray(x.values) && x.values.type === "tokens";
  const values: string[] | TokenValues = tokens ? { type: "tokens", tokens: strs(x.values.tokens), on: strs(x.values.on) } : strs(x.values);
  const value = tokens ? (Array.isArray(x.value) ? strs(x.value) : (values as TokenValues).on) : isStr(x.value) ? x.value : null;
  const ar = x.auto_revert && typeof x.auto_revert === "object" ? { since: iso(x.auto_revert.since), until: iso(x.auto_revert.until) } : null;
  return {
    key: x.key, label: isStr(x.label) && x.label ? x.label : x.key, description: isStr(x.description) ? x.description : "",
    group: isStr(x.group) ? x.group : "other", worker: isStr(x.worker) ? x.worker : "ai",
    values, value, source: SOURCES.includes(x.source) ? x.source : null,
    config_value: valueOf(x.config_value), default_value: valueOf(x.default_value),
    set_by: isStr(x.set_by) && ROLE_WORDS.includes(x.set_by) ? x.set_by : null, set_at: iso(x.set_at),
    era_switch: x.era_switch === true, restarts_mode_evidence: x.restarts_mode_evidence === true, emergency_stop: x.emergency_stop === true,
    read_only: x.read_only === true, write: x.write === "omega-settings" ? "omega-settings" : "feature-switch",
    auto_revert: ar && (ar.since || ar.until) ? ar : null,
    config_only: strs(x.config_only),
    zone_hold: zoneHoldOf(x.zone_hold, tokens ? (values as TokenValues).tokens : null)
  };
}

/** The GET payload as the page shows it: the groups in the payload's order (a row of an unlisted group gets its own). */
export function switchesOf(d: any): Switches {
  const rows = (Array.isArray(d?.switches) ? d.switches : []).map(rowOf).filter((r: SwitchRow | null): r is SwitchRow => r != null);
  const listed: { id: string; label: string }[] = (Array.isArray(d?.groups) ? d.groups : [])
    .filter((g: any) => g && isStr(g.id))
    .map((g: any) => ({ id: g.id, label: isStr(g.label) && g.label ? g.label : g.id }));
  for (const r of rows) if (!listed.some((g) => g.id === r.group)) listed.push({ id: r.group, label: r.group });
  const groups = listed.map((g) => ({ ...g, rows: rows.filter((r: SwitchRow) => r.group === g.id) })).filter((g) => g.rows.length > 0);
  const at = isStr(d?.at) && Number.isFinite(Date.parse(d.at)) ? Date.parse(d.at) : null;
  return { at, canControl: d?.viewer?.can_control === true, groups, rows, overrides: rows.filter((r: SwitchRow) => r.source === "override").length };
}

export const isTokens = (r: SwitchRow): boolean => !Array.isArray(r.values);
/** The values a segmented control or a toggle offers, or a token list's tokens. */
export const optionsOf = (r: SwitchRow): string[] => (Array.isArray(r.values) ? r.values : r.values.tokens);

/** A toggle for on/off, token toggles for a token list, a segmented control for any other value list. */
export function controlKind(r: SwitchRow): ControlKind {
  if (isTokens(r)) return "tokens";
  const v = [...(r.values as string[])].sort();
  return v.length === 2 && v[0] === "off" && v[1] === "on" ? "toggle" : "segmented";
}

/**
 * A token list too long for the row's line (ZONE_SOURCES_OFF's five sources): its toggles take their own line under the
 * label, so they never wrap into a column of one token each.
 */
export const wideControl = (r: SwitchRow): boolean => isTokens(r) && optionsOf(r).join("").length > 24;

/**
 * The value in force is one the panel cannot set: a value the row lists as config-only, or any value outside its
 * settable values (ZONE_AHEAD_MODE "record" from wrangler.jsonc). It shows as text beside the settable controls, none
 * pressed, and its tooltip says why.
 */
export function configOnlyValue(r: SwitchRow): string | null {
  if (isTokens(r) || typeof r.value !== "string" || !r.value) return null;
  return r.config_only.includes(r.value) || !(r.values as string[]).includes(r.value) ? r.value : null;
}

/** Controls only for the owner (viewer.can_control), never on a read-only row. */
export const canChange = (r: SwitchRow, canControl: boolean): boolean => canControl && !r.read_only;
/** The reset appears on an override the owner may change. */
export const canReset = (r: SwitchRow, canControl: boolean): boolean => canChange(r, canControl) && r.source === "override";

/** A value in words: a token list "tp,stop" or "none", a missing value "—". */
export function valueText(v: SwitchValue | null | undefined): string {
  if (Array.isArray(v)) return v.length ? v.join(",") : "none";
  return isStr(v) && v ? v : "—";
}
/** A token list's next on-list after one token is tapped, in the registry's token order. */
export function toggledTokens(r: SwitchRow, token: string): string[] {
  const on = new Set(Array.isArray(r.value) ? r.value : []);
  if (on.has(token)) on.delete(token); else on.add(token);
  return optionsOf(r).filter((t) => on.has(t));
}
/** A toggle's next value. */
export const flipped = (r: SwitchRow): string => (r.value === "on" ? "off" : "on");

/** Where a reset goes: an Omega setting to its default (OMEGA_DEFAULTS), the veto rule to "auto", any other to the config. */
export function resetTarget(r: SwitchRow): SwitchValue | null {
  if (r.write === "omega-settings") return r.default_value;
  if (r.key === "AGENT_VETO_RULE") return "auto";
  return r.config_value ?? r.default_value;
}
export const resetWord = (r: SwitchRow): "config" | "default" => (r.write === "omega-settings" ? "default" : "config");
/** The reset's label ("Reset to config"; an Omega setting has no config value, so "Reset to default"). */
export const resetLabel = (r: SwitchRow): string => `Reset to ${resetWord(r)}`;

/** A change the owner asked for: a value, or the reset. */
export type Change = { value: SwitchValue } | { reset: true };
export const isReset = (c: Change): c is { reset: true } => "reset" in c;
/** The POST body of a change: { key, value } (a token list sends its on-list) or { key, reset: true }. */
export function postBody(r: SwitchRow, c: Change): { key: string; value: SwitchValue } | { key: string; reset: true } {
  return isReset(c) ? { key: r.key, reset: true } : { key: r.key, value: c.value };
}

/** A label inside a sentence: the first letter lowered unless it starts an acronym ("Zone priority" → "zone priority", "TP1 at …" kept). */
export function inSentence(label: string): string {
  return label.length > 1 && /[A-Z]/.test(label[0]) && !/[A-Z0-9]/.test(label[1]) ? label[0].toLowerCase() + label.slice(1) : label;
}

export const ERA_LINE = "Starts a new era.";
export const EV_LINE = "Restarts mode evidence.";
export const VETO_RESET_LINE = "The automatic revert and the config decide again.";
export type ConfirmText = { title: string; change: string; lines: string[]; caution: string | null; tone: "ok" | "late" | "fault"; confirmLabel: string; typed: string | null };

/**
 * The confirm of one change: what changes ("ZONE_PRIORITY: off → on"), "Starts a new era." for an era switch,
 * "Restarts mode evidence." for a mode-evidence switch, and an emergency stop's description with its key to type.
 * Tone: an emergency stop fault red, an era or mode-evidence switch late amber, any other ok cyan.
 */
export function confirmText(r: SwitchRow, c: Change): ConfirmText {
  const to = isReset(c) ? resetTarget(r) : c.value;
  const name = inSentence(r.label);
  const kind = controlKind(r);
  const title = isReset(c) ? `Reset ${name} to ${resetWord(r)}?`
    : kind === "toggle" ? `Turn ${name} ${valueText(to)}?`
    : kind === "segmented" ? `Set ${name} to ${valueText(to)}?` : `Change ${name}?`;
  const lines = [
    r.era_switch ? ERA_LINE : null,
    r.restarts_mode_evidence ? EV_LINE : null,
    isReset(c) && r.key === "AGENT_VETO_RULE" ? VETO_RESET_LINE : null
  ].filter((x): x is string => x != null);
  return {
    title, change: `${r.key}: ${valueText(r.value)} → ${valueText(to)}`, lines,
    caution: r.emergency_stop ? r.description || null : null,
    tone: r.emergency_stop ? "fault" : r.era_switch || r.restarts_mode_evidence ? "late" : "ok",
    confirmLabel: isReset(c) ? "Reset" : kind === "toggle" ? `Turn ${valueText(to)}` : kind === "segmented" ? "Set" : "Save",
    typed: r.emergency_stop ? r.key : null
  };
}

/** Every error code the POST answers (src/feature-switch-store.mjs setFeatureSwitch and the Omega Worker's route). */
export const POST_ERRORS = ["unknown_key", "invalid_value", "read_only", "owner_only", "unavailable", "same_origin_only", "feature_switches_unavailable", "feature_switch_failed"] as const;
/** The words after a failed POST's code: what happened and what to do. */
export function errorWords(code: string, r: SwitchRow | null): string {
  switch (code) {
    case "unknown_key": return "the server has no such switch. Reload the page.";
    case "invalid_value": return r ? `allowed: ${isTokens(r) ? "any of " : ""}${optionsOf(r).join(", ")}.` : "the value was refused.";
    case "read_only": return "this switch cannot be changed here.";
    case "owner_only": return "viewer.can_control is false. Nothing changed.";
    case "unavailable": return "the switch store could not be read or written. Nothing changed.";
    case "same_origin_only": return "the request did not come from this page. Nothing changed.";
    case "feature_switches_unavailable":
    case "feature_switch_failed": return "Omega could not reach the AI Worker. Nothing changed.";
    case "network": return "no answer from Omega. Nothing changed.";
    default: return "nothing changed.";
  }
}

export type PostResult = { ok: true; row: SwitchRow | null; changed: boolean } | { ok: false; error: string };

/**
 * The page's one write: POST /omega/api/feature-switches, same origin, JSON, with the Omega page's omegaJson rule (a
 * non-2xx answer or `ok: false` is a failure, its `error` the code; else "HTTP <status>"). Never throws.
 */
export async function postSwitch(body: { key: string; value: SwitchValue } | { key: string; reset: true }, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetchImpl(FS_PATH, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: "network" };
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) return { ok: false, error: isStr(data?.error) && data.error ? data.error.slice(0, 40) : `HTTP ${res.status}` };
  return { ok: true, row: rowOf(data?.switch), changed: data?.changed === true };
}

/** "03:40 UTC · 10:40 GMT+7". */
export const clockText = (ms: number | null): string => (ms != null && ms > 0 ? `${utcClockOf(ms)} UTC · ${gmt7ClockOf(ms)} GMT+7` : "—");
/** "2026-11-24 22:05 UTC · 05:05 GMT+7". */
export function whenText(at: string | null): string {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && ms > 0 ? `${new Date(ms).toISOString().slice(0, 10)} ${clockText(ms)}` : "—";
}

/** The tooltip's "set" line: when the owner set it, else where the value comes from. */
export function setLine(r: SwitchRow): string {
  if (r.source === "override") return whenText(r.set_at);
  if (r.source === "config") return "deploy (wrangler.jsonc)";
  if (r.source === "default") return r.write === "omega-settings" ? "OMEGA_DEFAULTS" : "code default";
  return "—";
}
export const MARK_ERA = "era: a change starts a new era.";
export const MARK_EV = "ev: a change restarts the mode evidence (rule_version moves, so the mode selector counts setups again).";
export const MARK_STOP = "Emergency stop: a change asks for the key to be typed.";
export const READ_ONLY_LINE = "Read only: shown for information; it changes in the config only.";
export const HELD_TITLE = "Held by the zone breaker on the decision side; your setting is unchanged.";
const holdSpan = (h: ZoneHoldEntry): string => `${h.since ? ` since ${whenText(h.since)}` : ""}${h.until ? ` until ${whenText(h.until)}` : ""}${h.by.length ? ` (${h.by.join(", ")})` : ""}`;
/**
 * The tooltip's hold lines (Z5): "Held by the zone breaker since … until … (typing, block): your setting is unchanged.",
 * or for a token list one line per held token ("tp held by the zone breaker since … until … (rule:tp_typed): …").
 */
export function holdLines(r: SwitchRow): string[] {
  const z = r.zone_hold;
  if (!z) return [];
  if (z.kind === "single") return [`Held by the zone breaker${holdSpan(z.hold)}: your setting is unchanged.`];
  return z.holds.map(([t, h]) => `${t} held by the zone breaker${holdSpan(h)}: your setting is unchanged.`);
}

/** After a saved change: other isolates read the override store at most every 30 s, then KV spreads it. */
export const PROPAGATION_NOTE = "Takes effect within ~30 s.";
export const OMEGA_LINE = "An Omega setting: saved through the Omega settings write path (its validation, audit row and era start).";

/** The tooltip's fields: description, then config, default, set and by, then the automatic revert and each mark's meaning. */
export function tipOf(r: SwitchRow): { dl: [string, string][]; notes: string[] } {
  const dl: [string, string][] = [
    ...(r.write === "omega-settings" ? [] : [["config", r.config_value == null ? "not set" : valueText(r.config_value)] as [string, string]]),
    ["default", valueText(r.default_value)],
    ["set", setLine(r)],
    ["by", r.set_by ?? "—"]
  ];
  const ar = r.auto_revert;
  const fixed = configOnlyValue(r);
  const notes = [
    fixed ? `${fixed} is set in the config (wrangler.jsonc) and cannot be set here; the panel sets ${optionsOf(r).join(" or ")}.` : null,
    r.config_only.length && !fixed ? `Config only: ${r.config_only.join(", ")} (set in wrangler.jsonc, never here).` : null,
    ...holdLines(r),
    ar ? `Automatic revert to ${valueText(r.value)}: since ${whenText(ar.since)}, until ${whenText(ar.until)}.` : null,
    r.emergency_stop ? MARK_STOP : null,
    r.era_switch ? MARK_ERA : null,
    r.restarts_mode_evidence ? MARK_EV : null,
    r.read_only ? READ_ONLY_LINE : null,
    r.write === "omega-settings" ? OMEGA_LINE : null
  ].filter((x): x is string => x != null);
  return { dl, notes };
}

/** The Omega engine's card spans both desktop columns, its rows in two columns. */
export const WIDE_GROUP = "omega";
/** A card's height for the column split, as drawn at 1440: its heading and the gap (about 58 px), 45 px a row, a long token list's own line 34. */
const weight = (g: SwitchGroup) => 58 + 45 * g.rows.length + 34 * g.rows.filter(wideControl).length;
/**
 * The desktop layout: the cards in the payload's order, split into two columns at the point that best evens their
 * heights (so a phone, one column, keeps the same order), and the wide Omega card under both.
 */
export function columnsOf(groups: SwitchGroup[]): { left: SwitchGroup[]; right: SwitchGroup[]; wide: SwitchGroup[] } {
  const wide = groups.filter((g) => g.id === WIDE_GROUP);
  const rest = groups.filter((g) => g.id !== WIDE_GROUP);
  const total = rest.reduce((n, g) => n + weight(g), 0);
  let best = rest.length, diff = Infinity, run = 0;
  for (let k = 0; k <= rest.length; k++) {
    const d = Math.abs(total - 2 * run);
    if (d < diff) { diff = d; best = k; }
    if (k < rest.length) run += weight(rest[k]);
  }
  return { left: rest.slice(0, best), right: rest.slice(best), wide };
}
/** A wide card's rows in two columns: the first half (rounded up) on the left. */
export const halves = <T,>(rows: T[]): [T[], T[]] => [rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))];
