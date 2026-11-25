// ZN1, the Nexus Zones page (Intelligence › Zones, #/zones; the owner-approved mockup "ZN1 Zones page", 2026-11-25). Pure:
// GET /api/zones (src/zone-readings.mjs zonesView, cryptophys.zones-view.v1) read null-safely, the breaker's cells and
// checks, a hold's since and until (the view's own when it carries them, else the read-only GET /api/feature-switches'
// zone_hold on ZONE_AHEAD_MODE and ZONE_AIM_OFF, else none: never invented), the readings' order and totals, and the
// formats (rates and R neutral, times UTC · GMT+7). No price: the view carries words, ATR and R only. No React here.
import { arr, num, obj, pc, signed, str } from "./intel";
import { clockText, switchesOf } from "./featureSwitches";

export const ZONES_SCHEMA = "cryptophys.zones-view.v1";
/** The decision-side rules the breaker may hold, in its order (src/zone-readings.mjs ZONE_HOLDABLE). */
export const HOLDABLE = ["zone_ahead", "tp", "stop", "factor"] as const;
/** The breaker's thresholds (src/zone-readings.mjs ZONE_BREAKER; test/nexus-zones-page.test.mjs pins them to it). */
export const BREAKER_RULES = { window: 300, min_group: 60, min_setups: 30, block_mean_r: 0.1, hold_days: 7 } as const;

/** A view the page can draw: status ok or the schema, never a not_found body. */
export const zonesReady = (d: any): boolean => obj(d) != null && (d.status === "ok" || d.schema === ZONES_SCHEMA) && d.status !== "not_found";
/** The AI Worker's 404 while ZONE_READINGS is off (src/index.ts). */
export const zonesOff = (d: any): boolean => d?.status === "not_found" && d?.reason === "zone_readings_off";
/** A failed read the route itself answered (500 zones_unavailable): it got past the ZONE_READINGS gate, so readings are on. */
export const readingsOnByError = (error: unknown): boolean => typeof error === "string" && /\b500 zones_unavailable\b/.test(error);

// ---------------------------------------------------------------- formats

const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && Date.parse(v) > 0;
/** R with its sign and a true minus: "+0.15R", "−0.15R", "0.00R"; "—" when missing. */
export const rText = (x: unknown, digits = 2): string => (num(x) ? `${signed(x, digits)}R` : "—");
/** A signed number without unit (the typing edge, 3 decimals): "+0.059". */
export const edgeText = (x: unknown): string => signed(x, 3);
/** A share as a whole percentage ("43%"), "—" when missing. */
export const rate = (x: unknown): string => pc(x);
/** ATR to two decimals ("0.62"), "—" when missing. */
export const atr = (x: unknown): string => (num(x) ? x.toFixed(2) : "—");
/** "11-24 07:22 UTC · 14:22 GMT+7" (the month and day in UTC), "—" when missing. */
export function shortWhen(at: unknown): string {
  if (!isIso(at)) return "—";
  const ms = Date.parse(at);
  return `${new Date(ms).toISOString().slice(5, 10)} ${clockText(ms)}`;
}
/** "03:40 UTC · 10:40 GMT+7", "—" when missing. */
export const clockOf = (at: unknown): string => (isIso(at) ? clockText(Date.parse(at)) : "—");

// ---------------------------------------------------------------- the breaker

export type HoldTimes = { since: string | null; until: string | null };
export type HoldCell = {
  rule: string; held: boolean; by: string[];
  /** The hold's span: the view's own fields, else the feature switches' zone_hold, else null (never invented). */
  since: string | null; until: string | null;
  /** Whether the hold changes a decision now, only when the view carries `effective`; never derived here. */
  effective: boolean | null;
};
export type CheckTone = "ok" | "late" | "off";
export type Check = { code: string; main: string; sub: string; tone: CheckTone; word: string; tip: string };
export type Breaker = { checkedAt: string | null; ruleVersion: string | null; cells: HoldCell[]; checks: Check[] };

const words = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string" && x !== "").map((x) => x.slice(0, 40));

/**
 * The holds' since and until from GET /api/feature-switches (src/feature-switch-store.mjs, FS1's zone_hold, parsed by
 * lib/featureSwitches.ts zoneHoldOf): ZONE_AHEAD_MODE's one hold is zone_ahead's, ZONE_AIM_OFF's per token tp, stop and
 * factor. Any body, a failed read (null) included: {} when there is nothing to read.
 */
export function holdTimesOf(switches: unknown): Record<string, HoldTimes> {
  const out: Record<string, HoldTimes> = {};
  for (const r of switchesOf(switches).rows) {
    const z = r.zone_hold;
    if (!z) continue;
    if (r.key === "ZONE_AHEAD_MODE" && z.kind === "single") out.zone_ahead = { since: z.hold.since, until: z.hold.until };
    if (r.key === "ZONE_AIM_OFF" && z.kind === "tokens") for (const [t, h] of z.holds) out[t] = { since: h.since, until: h.until };
  }
  return out;
}

/** A check's state: tripped late amber, too few for the rule off grey ("n < 30"), else clear ok cyan. */
export function checkState(c: any, min: number, n: number): { tone: CheckTone; word: string } {
  if (c?.tripped === true) return { tone: "late", word: "tripped" };
  if (n < min) return { tone: "off", word: `n < ${min}` };
  return { tone: "ok", word: "clear" };
}
const count = (x: unknown): number => (num(x) && x >= 0 ? Math.floor(x) : 0);
const RULE_TOKEN: Record<string, string> = { tp_typed: "tp", stop_skip: "stop" };

/** The breaker's three checks as the strip shows them: code, main figure, the figures under it, state and its rule. */
export function checksOf(checks: unknown): Check[] {
  const k = obj(checks);
  if (!k) return [];
  const B = BREAKER_RULES, out: Check[] = [];
  const ty = obj(k.typing);
  if (ty) {
    const own = count(ty.own_n), none = count(ty.untyped_n);
    out.push({
      code: "typing", main: `edge ${edgeText(ty.edge)}`, sub: `own ${rate(ty.own_held_rate)} n${own} · untyped ${rate(ty.untyped_held_rate)} n${none}`,
      ...checkState(ty, B.min_group, Math.min(own, none)),
      tip: `typing: over the last ${B.window} readings, at least ${B.min_group} per group, the own-type held rate minus the untyped held rate. Below 0 holds zone_ahead, tp, stop and factor.`
    });
  }
  const bl = obj(k.block);
  if (bl) {
    const n = count(bl.n);
    out.push({ code: "block", main: rText(bl.mean_r), sub: `n${n}`, ...checkState(bl, B.min_setups, n),
      tip: `block: at least ${B.min_setups} resolved zone_blocked setups with a mean above +${B.block_mean_r.toFixed(2)}R hold zone_ahead (to record).` });
  }
  for (const [rule, x] of Object.entries(obj(k.rules) ?? {})) {
    const r = obj(x);
    if (!r) continue;
    const n = count(r.n), name = rule.slice(0, 40);
    out.push({ code: `rule:${name}`, main: `${rText(r.acted_mean_r)} vs ${rText(r.base_mean_r)}`, sub: `n${n}`, ...checkState(r, B.min_setups, n),
      tip: `rule:${name}: at least ${B.min_setups} resolved arms whose mean acted R is below the mean base R hold ${RULE_TOKEN[rule] ?? "that rule"}.` });
  }
  return out;
}

/**
 * The breaker panel's model, null before the first tick (no KV state: breaker null). One cell per holdable rule, in the
 * breaker's order, then any other held rule the view names. A held cell's since and until: breaker.held[i].since and
 * .until when the view carries them, else the feature switches' zone_hold (`switches`, the GET's body or null).
 */
export function breakerOf(v: any, switches: unknown = null): Breaker | null {
  const b = obj(v?.breaker);
  if (!b) return null;
  const held = new Map<string, any>();
  for (const h of arr(b.held)) { const rule = str(h?.rule); if (rule && !held.has(rule)) held.set(rule.slice(0, 40), h); }
  const times = holdTimesOf(switches);
  const rules = [...HOLDABLE, ...[...held.keys()].filter((r) => !(HOLDABLE as readonly string[]).includes(r))];
  const cells = rules.map((rule): HoldCell => {
    const h = held.get(rule);
    if (!h) return { rule, held: false, by: [], since: null, until: null, effective: null };
    const t = times[rule];
    return {
      rule, held: true, by: words(h.by),
      since: isIso(h.since) ? h.since : t?.since ?? null, until: isIso(h.until) ? h.until : t?.until ?? null,
      effective: typeof h.effective === "boolean" ? h.effective : null
    };
  });
  return { checkedAt: isIso(b.checked_at) ? b.checked_at : null, ruleVersion: str(b.rule_version), cells, checks: checksOf(b.checks) };
}

/** What a hold does for the run (src/zone-readings.mjs applyZoneHolds), a cell's tooltip. */
export const HOLD_EFFECT: Record<string, string> = {
  zone_ahead: "Held: ZONE_AHEAD_MODE reads record for the run (while the check is in the guardrails: trend or all).",
  tp: "Held: tp joins ZONE_AIM_OFF for the run while Z2b has it on.",
  stop: "Held: stop joins ZONE_AIM_OFF for the run while Z2b has it on.",
  factor: "Held: factor joins ZONE_AIM_OFF for the run while Z2b has it on. Only the typing check holds it."
};
export const NO_EFFECT_NOTE = "No effect now: this hold changes no decision (effective false).";
/** A cell's tooltip: what a hold does, and the "no effect" note only when the view says effective false. */
export const cellTip = (c: HoldCell): string => `${HOLD_EFFECT[c.rule] ?? "Held by the zone breaker for the run."}${c.held && c.effective === false ? ` ${NO_EFFECT_NOTE}` : ""}`;

// ---------------------------------------------------------------- readings

export type Reading = {
  zone_type: string; approach: string; zone_strength: string; n: number; held: number; broke: number; neither: number;
  held_rate: number | null; held_rate_shrunk: number | null; mfe_atr: number | null; mae_atr: number | null;
};
const n0 = (x: unknown): number => (num(x) && x >= 0 ? x : 0);
const nn = (x: unknown): number | null => (num(x) ? x : null);

/** The readings' groups, null-safe; a group without readings (n 0) is left out. */
export function readingsOf(v: any): Reading[] {
  return arr(v?.readings).map((g): Reading | null => {
    if (!obj(g) || !(num(g.n) && g.n > 0)) return null;
    return {
      zone_type: str(g.zone_type)?.slice(0, 40) ?? "untyped", approach: str(g.approach)?.slice(0, 40) ?? "unknown", zone_strength: str(g.zone_strength)?.slice(0, 40) ?? "none",
      n: g.n, held: n0(g.held), broke: n0(g.broke), neither: n0(g.neither),
      held_rate: nn(g.held_rate), held_rate_shrunk: nn(g.held_rate_shrunk), mfe_atr: nn(g.mfe_atr), mae_atr: nn(g.mae_atr)
    };
  }).filter((g): g is Reading => g != null);
}

const TYPE_ORDER = ["demand", "supply", "mixed", "untyped"], AP_ORDER = ["from_above", "inside", "from_below"], ST_ORDER = ["strong", "medium", "weak", "none"];
const rank = (list: string[], v: string) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const zoneCmp = (a: Reading, b: Reading) => rank(TYPE_ORDER, a.zone_type) - rank(TYPE_ORDER, b.zone_type) || a.zone_type.localeCompare(b.zone_type)
  || rank(AP_ORDER, a.approach) - rank(AP_ORDER, b.approach) || rank(ST_ORDER, a.zone_strength) - rank(ST_ORDER, b.zone_strength);

export type SortKey = "zone" | "approach" | "strength" | "n" | "held" | "broke" | "neither" | "held_rate" | "held_rate_shrunk" | "mfe_atr" | "mae_atr";
export type Sort = { key: SortKey; dir: "asc" | "desc" };
/** The table's first order: by zone (type, then approach, then strength), so each type's rows sit together. */
export const DEFAULT_SORT: Sort = { key: "zone", dir: "asc" };
/** A header's first click: the words ascending, the figures descending. */
export const firstDir = (key: SortKey): "asc" | "desc" => (key === "zone" || key === "approach" || key === "strength" ? "asc" : "desc");
/** The next sort after a header's click: the same column flips, another starts at its first direction. */
export const nextSort = (s: Sort, key: SortKey): Sort => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir(key) });

/** The rows in a sort's order; a missing figure always last, ties in zone order. */
export function sortReadings(rows: Reading[], s: Sort = DEFAULT_SORT): Reading[] {
  const sign = s.dir === "asc" ? 1 : -1;
  const by = (a: Reading, b: Reading): number => {
    if (s.key === "zone") return sign * zoneCmp(a, b);
    if (s.key === "approach") return sign * (rank(AP_ORDER, a.approach) - rank(AP_ORDER, b.approach)) || zoneCmp(a, b);
    if (s.key === "strength") return sign * (rank(ST_ORDER, a.zone_strength) - rank(ST_ORDER, b.zone_strength)) || zoneCmp(a, b);
    const x = a[s.key], y = b[s.key];
    if (x == null || y == null) return x == null && y == null ? zoneCmp(a, b) : x == null ? 1 : -1;
    return sign * (x - y) || zoneCmp(a, b);
  };
  return [...rows].sort(by);
}

/** The summed row: counts, the overall held rate (the rate the shrunk rates pull toward) and MFE / MAE weighted by n. */
export function totals(rows: Reading[]): { n: number; held: number; broke: number; neither: number; held_rate: number | null; mfe_atr: number | null; mae_atr: number | null } {
  const sum = (k: "n" | "held" | "broke" | "neither") => rows.reduce((a, g) => a + g[k], 0);
  const n = sum("n"), held = sum("held");
  const w = (k: "mfe_atr" | "mae_atr") => { const has = rows.filter((g) => g[k] != null); const m = has.reduce((a, g) => a + g.n, 0); return m ? has.reduce((a, g) => a + (g[k] as number) * g.n, 0) / m : null; };
  return { n, held, broke: sum("broke"), neither: sum("neither"), held_rate: n ? held / n : null, mfe_atr: w("mfe_atr"), mae_atr: w("mae_atr") };
}

// ---------------------------------------------------------------- counterfactuals, stances, Omega

export type BlockedSide = { side: string; n: number; mean_r: number | null; fill_rate: number | null };
export const blockedOf = (v: any): BlockedSide[] => arr(v?.zone_blocked).filter((g) => obj(g) && str(g.side))
  .map((g) => ({ side: String(g.side).slice(0, 20), n: n0(g.n), mean_r: nn(g.mean_r), fill_rate: nn(g.fill_rate) }));

export type RuleArm = { rule: string; n: number; acted: number | null; base: number | null; delta: number | null };
export const armsOf = (v: any): RuleArm[] => arr(v?.rule_arms).filter((g) => obj(g) && str(g.rule))
  .map((g) => ({ rule: String(g.rule).slice(0, 40), n: n0(g.n), acted: nn(g.acted_mean_r), base: nn(g.base_mean_r), delta: nn(g.delta_r) }));

/** The arms' scale: −0.1R to +0.4R (the mockup's), widened to whole tenths past any arm's figure. */
export function armScale(arms: RuleArm[]): { lo: number; hi: number } {
  const xs = arms.flatMap((a) => [a.acted, a.base]).filter((x): x is number => x != null);
  const lo = Math.min(-0.1, ...xs), hi = Math.max(0.4, ...xs);
  return { lo: Math.floor(lo * 10 + 1e-9) / 10, hi: Math.ceil(hi * 10 - 1e-9) / 10 };
}
/** The scale's header: "−0.1 · 0 · +0.4R". */
export const armScaleText = (s: { lo: number; hi: number }): string => `${signed(s.lo, 1)} · 0 · ${signed(s.hi, 1)}R`;

export type Stance = { stance: string; n: number; share: number | null; zone_blocked: number };
export const stancesOf = (v: any): Stance[] => arr(v?.stances).filter((s) => obj(s) && str(s.stance) && num(s.n) && s.n > 0)
  .map((s) => ({ stance: String(s.stance).slice(0, 20), n: s.n, share: nn(s.share), zone_blocked: n0(s.zone_blocked) }));

export type Omega = { closes: number; mean_r: number | null; advisory: boolean; by: { source: string; n: number; mean_r: number | null }[] };
export function omegaOf(v: any): Omega {
  const a = obj(v?.omega_advisory) ?? {};
  return {
    closes: n0(a.closes), mean_r: nn(a.mean_r), advisory: a.advisory === true,
    by: arr(v?.omega_attribution).filter((x) => obj(x) && str(x.source)).map((x) => ({ source: String(x.source).slice(0, 60), n: n0(x.n), mean_r: nn(x.mean_r) }))
  };
}
