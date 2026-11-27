// Range shadow (owner via the orchestrator 2026-11-27: "setuju c1 + c2 sekalian b"). Range mode's evidence was thin: the
// range strategies' cells (src/htf-cells.mjs) fill from their live setups (the decided side only) and from the range-mode
// shadow (mode_shadow_plans), and every change of the full rule version restarted them. Three parts, behind
// RANGE_SHADOW_MODE (default "off"; production "on"):
//
// c1  The range key: the rule version's tokens that change a range plan (TP1-KZ, the zone_ahead check, the zone aim),
//     and no other. The mode selector's range evidence compares setups by it (rangeShadowEvidence), so a later token
//     that does not touch range plans does not restart the range cells.
// c2  Both sides: while the 1H regime ranges, the range strategies' plans on BOTH sides of every engine decision (any
//     stance) are recorded as plan_setups with source 'range_both' (key "rangeboth:" + the live rule's key), at most
//     RANGE_BOTH_DAILY_CAP a UTC day (one `range_both_capped` log line per day at the cap, and the count in the run's
//     result), replayed on the control arm only with the live setups' own rules (src/plan-learning.mjs replaySetup:
//     a limit entry counts as filled only when a bar after the decision traded through it within the plan's fill
//     window, fillWindowOf; an at-level plan enters at market only when the first bar opens within MARKET_BAND of it;
//     an unfilled setup is a 0R non-entry, f 0). They count ONLY in the mode selector's range evidence (n_both), never
//     in the cell gate that lets a range trade go live (buildState reads source 'live'), the strategy council, the
//     probation's live count or the knob tuning: those read source = 'live'.
// b   Intraday episodes: a run of ranging 1H closes (the decisions at minute :00), opened at the RANGE_EPISODE_MIN_HOURS-th
//     consecutive ranging close (adjacent hours), ended at the first non-ranging close (or a missing hour). Stored in
//     range_episodes (one row per episode, keyed by its first ranging close), for /api/range-shadow.
//
// Pure, except the schema helper and the capped log.
import { RANGE_GATED_AGENTS, HTF_CONTEXTS, isRanging, cellRecords, cellStatus, cellKey } from "./htf-cells.mjs";
import { ruleVersionOf } from "./mode-shadow.mjs";

export const RANGE_BOTH_SOURCE = "range_both";
export const RANGE_BOTH_PREFIX = "rangeboth:";
export const RANGE_BOTH_DAILY_CAP = 150;
export const RANGE_EPISODE_MIN_HOURS = 4;
export const RANGE_EPISODE_BACKFILL_DAYS = 30;
const HOUR = 3_600_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => Math.round(x * 1000) / 1000;

/** The switch: "on" records range_both setups and episodes; anything else (the default) is "off". */
export function rangeShadowMode(env) {
  return String(env?.RANGE_SHADOW_MODE ?? "off").trim().toLowerCase() === "on" ? "on" : "off";
}

/** c1: the rule-version tokens that change a range plan (prefixes of the '+'-separated tokens of ruleVersionOf). */
export const RANGE_KEY_TOKENS = Object.freeze(["tp1_kz:", "zone_ahead@", "zone_aim@"]);

/**
 * Pure (c1): a rule version's range key: its range tokens only, in their order; null for no rule version. A version
 * with no range token at all (not one ruleVersionOf writes: it always starts with tp1_kz) is its own key, unchanged.
 */
export function rangeKeyOf(ruleVersion) {
  if (typeof ruleVersion !== "string" || !ruleVersion) return null;
  const kept = ruleVersion.split("+").filter((t) => RANGE_KEY_TOKENS.some((p) => t.startsWith(p)));
  return kept.length ? kept.join("+") : ruleVersion;
}

/** c1: the range key of the rule in force (what a range_both setup is stamped with). */
export const rangeRuleVersionOf = (env) => rangeKeyOf(ruleVersionOf(env));

/**
 * Pure (c2): the setups to write under the daily cap. `setups`: the new range_both setups (opened_ms), oldest first;
 * `countsByDay`: { "YYYY-MM-DD": rows already stored that day }. Returns { kept, capped: [{ day, count, dropped }] }:
 * count = the day's rows at the cap.
 */
export function capRangeBoth(setups, countsByDay = {}, cap = RANGE_BOTH_DAILY_CAP) {
  const used = { ...countsByDay };
  const kept = [], dropped = {};
  for (const s of setups || []) {
    const day = new Date(s.opened_ms).toISOString().slice(0, 10);
    const n = Number(used[day]) || 0;
    if (n >= cap) { dropped[day] = (dropped[day] || 0) + 1; continue; }
    used[day] = n + 1;
    kept.push(s);
  }
  return { kept, capped: Object.keys(dropped).sort().map((day) => ({ day, count: Number(used[day]) || 0, dropped: dropped[day] })) };
}

// One `range_both_capped` line per UTC day per isolate (the run's result carries it every time).
let cappedLogged = new Set();
export function resetRangeShadowLogForTests() { cappedLogged = new Set(); }
/** Logs each capped day once (console, as the Worker's other run lines); returns the days it logged. */
export function logRangeBothCapped(capped, { log = (line) => console.log(line) } = {}) {
  const out = [];
  for (const c of capped || []) {
    if (cappedLogged.has(c.day)) continue;
    cappedLogged.add(c.day);
    try { log(JSON.stringify({ event: "range_both_capped", day: c.day, count: c.count, cap: RANGE_BOTH_DAILY_CAP })); } catch { /* a log line never fails the run */ }
    out.push(c.day);
  }
  return out;
}

/**
 * Pure (b): the intraday range episodes of hourly closes (`closes`: [{ close_ms, regime }], any order; only closes at
 * minute :00 count). An episode starts at the first ranging close of a run of adjacent ranging closes and opens at its
 * RANGE_EPISODE_MIN_HOURS-th; a shorter run is no episode. It ends at the first non-ranging close (status "ended",
 * end_ms that close) or at a missing hour (status "gap", end_ms its last ranging close); one still ranging at the
 * newest close is "open" (end_ms null). `hours`: its ranging closes. Oldest first.
 */
export function rangeEpisodesFrom(closes, { minHours = RANGE_EPISODE_MIN_HOURS } = {}) {
  const list = (closes || []).filter((c) => finite(Number(c?.close_ms)) && Number(c.close_ms) % HOUR === 0)
    .map((c) => ({ ms: Number(c.close_ms), ranging: isRanging(c.regime) }))
    .sort((a, b) => a.ms - b.ms)
    .filter((c, i, a) => i === 0 || c.ms !== a[i - 1].ms);
  const out = [];
  let run = null;
  const close = (status, endMs) => {
    if (run && run.hours >= minHours) out.push({ start_ms: run.start, opened_ms: run.start + (minHours - 1) * HOUR, end_ms: endMs, hours: run.hours, status });
    run = null;
  };
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i], prev = list[i - 1];
    if (run && prev && c.ms - prev.ms > HOUR) close("gap", prev.ms);
    if (c.ranging) { if (run) run.hours += 1; else run = { start: c.ms, hours: 1 }; }
    else close("ended", c.ms);
  }
  if (run) close("open", null);
  return out;
}

export const RANGE_EPISODES_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS range_episodes (
    start_ms INTEGER PRIMARY KEY, opened_ms INTEGER NOT NULL, end_ms INTEGER, hours INTEGER NOT NULL,
    status TEXT NOT NULL, updated_at TEXT NOT NULL
  )`
];
let episodesReady = new WeakSet();
export function resetRangeEpisodesSchemaForTests() { episodesReady = new WeakSet(); }
export async function ensureRangeEpisodesSchema(db) {
  if (!db || episodesReady.has(db)) return;
  for (const sql of RANGE_EPISODES_SCHEMA_SQL) await db.prepare(sql).run();
  episodesReady.add(db);
}

/**
 * Pure (b): the episodes of one run's closes that it may write. `firstMs`: the run's first loaded close; an episode
 * that starts there may have started earlier, so it is not written (the run that saw its start wrote it).
 */
export function writableEpisodes(episodes, { firstMs }) {
  return (episodes || []).filter((e) => e.start_ms !== firstMs);
}

const SOURCE_RANK = { live: 0, shadow: 1, [RANGE_BOTH_SOURCE]: 2 };
/**
 * Pure: the range strategies' setups as the range evidence counts them: the range key in force only (c1; `rangeKey`),
 * live setups in any mode, shadow setups of range mode, range_both setups; one per opening bar, agent and side, live
 * before shadow before range_both. `withBoth` false leaves range_both out.
 */
export function rangeSetupsForEvidence(setups, { rangeKey, withBoth = true }) {
  const list = (setups || []).filter((s) => rangeKeyOf(s.rule_version) === rangeKey && rangeKey != null && RANGE_GATED_AGENTS.includes(s.agent)
    && (s.source === "live" || (s.source === "shadow" && s.mode === "range") || (withBoth && s.source === RANGE_BOTH_SOURCE)));
  const best = new Map();
  for (const s of list) {
    const k = `${s.decision_key}|${s.agent}|${s.side}`;
    const b = best.get(k);
    if (!b || SOURCE_RANK[s.source] < SOURCE_RANK[b.source]) best.set(k, s);
  }
  return list.filter((s) => best.get(`${s.decision_key}|${s.agent}|${s.side}`) === s);
}

/** Pure: cellRecords on setups shaped as the selector reads them ({ agent, side, htf, r }). */
export const cellsOf = (setups, arm) => cellRecords((setups || []).map((s) => ({ agent: s.agent, side: s.side, htf: s.htf, results: { [arm]: { r: s.r } } })), { arm });

/**
 * Pure: each cell twice: with range_both and without it (`withBoth`, `without`: cellRecords of each), and the source
 * counts and fill rate of the setups with range_both (`used`). One row per agent × side × context of either.
 */
export function cellsTwice({ withBoth, without, used }) {
  const keys = new Set([...(withBoth || []), ...(without || [])].map((c) => cellKey(c.agent, c.side, c.context)));
  const find = (list, k) => (list || []).find((c) => cellKey(c.agent, c.side, c.context) === k) ?? null;
  return [...keys].sort().map((k) => {
    const a = find(withBoth, k), b = find(without, k);
    const [agent, side, context] = k.split("|");
    const mine = (used || []).filter((s) => s.agent === agent && s.side === side && (HTF_CONTEXTS.includes(s.htf) ? s.htf : "unknown") === context);
    const n = (src) => mine.filter((s) => s.source === src).length;
    const filled = mine.filter((s) => s.f === 1).length;
    return {
      agent, side, context,
      n_live: n("live"), n_shadow: n("shadow"), n_both: n(RANGE_BOTH_SOURCE),
      fill_rate: mine.length && mine.some((s) => s.f === 0 || s.f === 1) ? r3(filled / mine.length) : null,
      setups: a?.setups ?? 0, mean_r: a?.mean_r ?? null, status: a?.status ?? cellStatus(0, null),
      without_both: { setups: b?.setups ?? 0, mean_r: b?.mean_r ?? null, status: b?.status ?? cellStatus(0, null) }
    };
  });
}

/**
 * Pure (b): per episode, the range setups opened in it (start_ms to end_ms, or `now` while open), as the evidence
 * counts them (`setups`: rangeSetupsForEvidence with range_both): per agent and side, n, resolved (an R), mean R and
 * the source counts. `setups` may hold open ones (r not finite).
 */
export function episodeSetups(episode, setups, { now }) {
  const end = finite(episode?.end_ms) ? episode.end_ms : now;
  const mine = (setups || []).filter((s) => finite(s.opened_ms) && s.opened_ms >= episode.start_ms && s.opened_ms <= end);
  const by = new Map();
  for (const s of mine) {
    const k = `${s.agent}|${s.side}`;
    const c = by.get(k) ?? { agent: s.agent, side: s.side, n: 0, resolved: 0, r: 0, n_live: 0, n_shadow: 0, n_both: 0 };
    c.n += 1;
    if (finite(s.r)) { c.resolved += 1; c.r += s.r; }
    if (s.source === "live") c.n_live += 1; else if (s.source === "shadow") c.n_shadow += 1; else c.n_both += 1;
    by.set(k, c);
  }
  return [...by.values()].sort((a, b) => (`${a.agent}|${a.side}` < `${b.agent}|${b.side}` ? -1 : 1))
    .map(({ r, ...c }) => ({ ...c, mean_r: c.resolved ? r3(r / c.resolved) : null }));
}
