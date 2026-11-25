// Z5 (docs/RFC_DEMAND_SUPPLY_ZONES.md §7): the measurement and the brake behind Z2/Z2b. The owner prioritised demand and
// supply zones before they were measured (owner 2026-11-23, "Langsung prioritaskan"), so this module measures them on
// gold's own 15m bars and holds the decision-side zone rules back by itself when their own record turns against them.
//
//   readings        zoneReadings: each recorded key-level zone (decision.key_levels, the recorded set) the decision
//                   bar's 15m range touched, read on the next 8 closed 15m bars: held (a close at least 0.5 ATR(1H)
//                   from the near edge in the zone's direction before a close 0.1 ATR beyond the far edge), broke
//                   (that close beyond the far edge) or neither, with the MFE and MAE in ATR. One reading per
//                   (0.1 ATR bucket, approach) per 2 hours. D1 zone_readings, words and ATR only.
//   counterfactual  their own tables, never plan_setups (whose 14 readers stay as they are):
//                     zone_blocked_setups  the WAIT decisions Z2's check alone held back ($.zone_blocked), their
//                                          would-be plan scored with plan learning's outcome step (setupOutcome);
//                     zone_rule_arms       the Z2b plans a rule moved, the acted plan against the base rebuilt from
//                                          the entry and the recorded distances (zoneAimBase), both on that step.
//   breaker         runZoneBreaker, hourly beside the strategy agents' breaker: (a) typing, (b) block, (c) per rule;
//                   its state in KV ZONE_BREAKER_KEY. The Decision Engine reads it into the run's env copy
//                   (applyZoneHolds): a held rule acts as its own switch off for that run only, recorded as
//                   zone_rules_held. Decision side only: it never writes omega_settings, an FS1 override, an Omega or
//                   Position Manager state, the EA signal or managementFields; it only holds, never turns a rule on.
//   alarms          one line a day each, no action.
//   attribution     Omega's zone-attributed trades (omega_intents, position_actions) joined to ea_deals R; SELECT only.
//
// Switch: ZONE_READINGS = "on" (default) | "off" (FS1 registry, group zones): off writes nothing, the breaker is idle
// (no hold reaches a decision) and GET /api/zones answers 404. ZONE_PRIORITY = "off" still overrides every Z rule.

import { setupsFrom, setupOutcome, setupFromRow, zoneColumns, PLAN_RULES, PLAN_LEARNING_VERSION, ZONE_SETUP_COLUMNS, CONTROL_ARM } from "./plan-learning.mjs";
import { zoneAimBase, zoneAheadMode, zoneAheadChecks, zoneAimMode, zoneAimOffMode, ZONE_AIM_TOKENS } from "./zone-types.mjs";
import { ruleVersionOf } from "./mode-shadow.mjs";
import { ledgerSeries, decisionCloseMs, toMs } from "./signal-ledger.mjs";

export const ZONE_READINGS_VERSION = "cryptophys.zone-readings.v1";
export const ZONE_READINGS_CURSOR_KEY = "zone-readings:cursor:v1";
export const ZONE_BREAKER_KEY = "zone-priority:breaker:v1";
export const ZONE_READINGS_SERIES_KEY = "market-data:v2:series:OANDA:XAUUSD|15m";
const M15 = 15 * 60_000, HOUR = 3600_000, DAY = 24 * HOUR;

/** The readings' rules (B19's held/broke definition). */
export const ZONE_READING_RULES = Object.freeze({ horizon_bars: 8, held_atr: 0.5, broke_atr: 0.1, bucket_atr: 0.1, dedupe_ms: 2 * HOUR, max_decisions: 200, backfill_ms: 2 * DAY });
/** The breaker's rules (min_setups as AGENT_BREAKER, src/strategy-agents.mjs). */
/**
 * The breaker's rules (min_setups as AGENT_BREAKER, src/strategy-agents.mjs). hold_ms: a hold stands at least 7 days
 * whatever the evidence says (SV1b's revert period, src/agent-veto.mjs), so the brake never flickers hour to hour.
 */
export const ZONE_BREAKER = Object.freeze({ window: 300, min_group: 60, min_setups: 30, block_mean_r: 0.10, every_ms: HOUR, hold_ms: 7 * DAY });
/** The alarms' rules: zone_ahead alone in more than 40% of the last 96 decisions where the council wanted that side. */
export const ZONE_ALARMS = Object.freeze({ share: 0.4, window: 96, omega_min_closes: 15, omega_days: 30 });
/** The view's shrinkage of a held rate toward the overall rate, in readings. */
export const ZONE_VIEW_PRIOR = 20;
/** The decision-side rules the breaker may hold (ZONE_AHEAD_MODE to "record"; the ZONE_AIM_OFF tokens). */
export const ZONE_HOLDABLE = Object.freeze(["zone_ahead", ...ZONE_AIM_TOKENS]);
/** zone_rules' rule names (Z2b) and the ZONE_AIM_OFF token each one is switched by. */
export const ZONE_RULE_TOKEN = Object.freeze({ tp_typed: "tp", stop_skip: "stop" });

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
const parse = (v, d = null) => { if (v == null) return d; if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return d; } };
const noTable = (e) => /no such table/i.test(String(e?.message ?? e));

/** ZONE_READINGS: "on" (default) | "off". */
export function zoneReadingsMode(env) {
  return String(env?.ZONE_READINGS ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

// ---------------------------------------------------------------- readings (pure)

const TYPED = new Set(["demand", "supply"]);
/** Pure: the side a zone is met from: the bar before the decision bar closed above it, below it, or inside. */
const approachOf = (ref, z) => (ref > z.high ? "from_above" : ref < z.low ? "from_below" : "inside");
/**
 * Pure: the zone's direction (+1 holds price up, -1 holds it down). A demand or supply zone reads its type; an untyped
 * one (none, mixed, or no words) the side it is met from (support from above, resistance from below); an untyped zone
 * price opened inside has no direction and is not read.
 */
function directionOf(z, approach) {
  if (z.zone_type === "demand") return 1;
  if (z.zone_type === "supply") return -1;
  return approach === "from_above" ? 1 : approach === "from_below" ? -1 : 0;
}

/**
 * Pure: the readings of `decisions` ([{ decision_key, bar_close, key_levels, atr_h1, mode, regime }], oldest first) on
 * `bars15` (closed 15m bars, oldest first). `recent` is the dedupe memory ([{ k, at }], from the cursor). Returns
 * { readings, recent, done, pending }: `done` the decisions read (or unreadable: no decision bar in the series),
 * `pending` the first decision whose 8 bars have not all closed without an outcome (it and everything after it wait).
 */
export function zoneReadings(decisions, bars15, { recent = [] } = {}) {
  const R = ZONE_READING_RULES;
  const bars = (bars15 || []).filter((b) => [b?.high, b?.low, b?.close].every(isNum) && isNum(toMs(b?.close_time)));
  const byClose = new Map(bars.map((b, i) => [toMs(b.close_time), i]));
  const lastClose = bars.length ? toMs(bars.at(-1).close_time) : -Infinity;
  let memory = (Array.isArray(recent) ? recent : []).filter((x) => typeof x?.k === "string" && isNum(x?.at));
  const readings = [], done = [];
  for (const d of decisions || []) {
    const closeMs = toMs(d?.bar_close);
    const i = byClose.get(closeMs);
    const atr = Number(d?.atr_h1);
    const zones = Array.isArray(d?.key_levels) ? d.key_levels : parse(d?.key_levels, []);
    // The series has not reached the decision bar yet: it and everything after it wait.
    if (i === undefined && isNum(closeMs) && closeMs > lastClose) return { readings, recent: memory, done, pending: d.decision_key };
    if (i === undefined || !(atr > 0) || !Array.isArray(zones)) { done.push(d?.decision_key); continue; }
    const bar = bars[i], ref = i > 0 ? bars[i - 1].close : (isNum(bar.open) ? bar.open : bar.close);
    const window = bars.slice(i + 1, i + 1 + R.horizon_bars);
    const out = [];
    let wait = false;
    zones.forEach((z, index) => {
      if (!z || !isNum(z.low) || !isNum(z.high) || z.low > z.high) return;
      if (!(bar.low <= z.high && bar.high >= z.low)) return;
      const approach = approachOf(ref, z), dir = directionOf(z, approach);
      if (!dir) return;
      const near = dir > 0 ? z.high : z.low, far = dir > 0 ? z.low : z.high;
      let outcome = null, n = 0, fav = 0, adv = 0;
      for (const b of window) {
        n += 1;
        fav = Math.max(fav, dir > 0 ? b.high - near : near - b.low);
        adv = Math.max(adv, dir > 0 ? near - b.low : b.high - near);
        if (dir * (b.close - near) >= R.held_atr * atr) { outcome = "held"; break; }
        if (dir * (far - b.close) >= R.broke_atr * atr) { outcome = "broke"; break; }
      }
      if (!outcome && window.length < R.horizon_bars) { wait = true; return; }
      out.push({ z, index, approach, outcome: outcome ?? "neither", bars: n, mfe_atr: r2(Math.max(0, fav) / atr), mae_atr: r2(Math.max(0, adv) / atr) });
    });
    if (wait) return { readings, recent: memory, done, pending: d.decision_key };
    memory = memory.filter((x) => closeMs - x.at < R.dedupe_ms);
    for (const x of out) {
      const k = `${Math.round((x.z.low + x.z.high) / 2 / (R.bucket_atr * atr))}|${x.approach}`;
      if (memory.some((m) => m.k === k)) continue;
      memory.push({ k, at: closeMs });
      const words = (v) => (typeof v === "string" && v ? v : null);
      readings.push({
        reading_key: `${d.decision_key}#${x.index}`, decision_key: d.decision_key, bar_close: iso(closeMs),
        zone_type: words(x.z.zone_type), zone_strength: words(x.z.zone_strength), zone_freshness: words(x.z.zone_freshness), zone_rank: words(x.z.zone_rank),
        // The sources' timeframe words when the recorded set carries them (B19/Z1b may add them); null today.
        ds_sources: Array.isArray(x.z.ds_sources) ? x.z.ds_sources.filter((s) => typeof s === "string").join(",") || null : null,
        approach: x.approach, outcome: x.outcome, mfe_atr: x.mfe_atr, mae_atr: x.mae_atr, bars: x.bars,
        mode: words(d.mode), regime: words(d.regime)
      });
    }
    done.push(d.decision_key);
  }
  return { readings, recent: memory, done, pending: null };
}

// ---------------------------------------------------------------- storage

export const ZONE_READINGS_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS zone_readings (
    reading_key TEXT PRIMARY KEY, decision_key TEXT NOT NULL, bar_close TEXT NOT NULL,
    zone_type TEXT, zone_strength TEXT, zone_freshness TEXT, zone_rank TEXT, ds_sources TEXT,
    approach TEXT NOT NULL, outcome TEXT NOT NULL, mfe_atr REAL, mae_atr REAL, bars INTEGER NOT NULL,
    mode TEXT, regime TEXT, version TEXT NOT NULL, rule_version TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_zone_readings_close ON zone_readings(bar_close)",
  // plan_setups' columns (src/plan-learning.mjs PLAN_LEARNING_SCHEMA_SQL and its added columns), in a table of its own.
  `CREATE TABLE IF NOT EXISTS zone_blocked_setups (
    setup_key TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'zone_pullback',
    opened_at TEXT NOT NULL, decided_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, decisions INTEGER NOT NULL DEFAULT 1,
    side TEXT NOT NULL, entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, atr_h1 REAL NOT NULL,
    mode TEXT, action TEXT, at_level INTEGER NOT NULL DEFAULT 0, regime TEXT, context TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT, results_json TEXT,
    version TEXT NOT NULL, updated_at TEXT NOT NULL,
    pattern TEXT, htf TEXT, source TEXT NOT NULL DEFAULT 'zone_blocked', rule_version TEXT,
    entry_zone_type TEXT, stop_zone_type TEXT, tp1_zone_type TEXT, opposing_room_atr REAL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_zone_blocked_setups_status ON zone_blocked_setups(status, opened_at)",
  `CREATE TABLE IF NOT EXISTS zone_rule_arms (
    arm_key TEXT PRIMARY KEY, setup_key TEXT NOT NULL, decision_key TEXT NOT NULL, agent TEXT NOT NULL, rule TEXT NOT NULL,
    side TEXT NOT NULL, opened_at TEXT NOT NULL, decided_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, decisions INTEGER NOT NULL DEFAULT 1,
    entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, base_stop REAL NOT NULL, base_tp1 REAL NOT NULL, atr_h1 REAL NOT NULL,
    action TEXT, at_level INTEGER NOT NULL DEFAULT 0, mode TEXT, regime TEXT,
    status TEXT NOT NULL DEFAULT 'open', acted_r REAL, base_r REAL, resolved_at TEXT, rule_version TEXT, version TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_zone_rule_arms_status ON zone_rule_arms(status, opened_at)",
  // The owner's rule version at each decision's own time (ruleVersionOf on the FS1-resolved env, before any hold): the
  // readings and counterfactuals, written hours later, take it from here, never from the env of their write.
  `CREATE TABLE IF NOT EXISTS zone_decision_rules (
    decision_key TEXT PRIMARY KEY, bar_close TEXT NOT NULL, rule_version TEXT NOT NULL, created_at TEXT NOT NULL
  )`
]);
let schemaReady = new WeakSet();
export function resetZoneReadingsSchemaForTests() { schemaReady = new WeakSet(); }
/** Creates the three tables (CREATE IF NOT EXISTS: running it twice is a no-op). */
export async function ensureZoneReadingsSchema(db) {
  if (!db || schemaReady.has(db)) return;
  for (const sql of ZONE_READINGS_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady.add(db);
}

/**
 * The Decision Engine's one write per decision (ZONE_READINGS on): the owner's rule version at the decision's time
 * (`ownerEnv`: the run's FS1-resolved env before any hold), INSERT OR IGNORE. Never in the decision record. Never throws.
 */
export async function recordDecisionRule(ownerEnv, { decisionKey, barClose, now = Date.now() } = {}) {
  if (zoneReadingsMode(ownerEnv) === "off" || !ownerEnv?.DB || !decisionKey) return { status: "disabled" };
  try {
    await ensureZoneReadingsSchema(ownerEnv.DB);
    const r = await ownerEnv.DB.prepare("INSERT OR IGNORE INTO zone_decision_rules (decision_key, bar_close, rule_version, created_at) VALUES (?, ?, ?, ?)").bind(decisionKey, barClose, ruleVersionOf(ownerEnv), iso(now)).run();
    return { status: "ok", written: Number(r?.meta?.changes) || 0 };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 160) }; }
}

/** The decision-time rule versions of `keys` (Map decision_key → rule_version); a decision of before Z5's table: absent. */
export async function decisionRules(db, keys) {
  const out = new Map(), list = [...new Set((keys || []).filter((k) => typeof k === "string"))];
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    try {
      for (const r of (await db.prepare(`SELECT decision_key, rule_version FROM zone_decision_rules WHERE decision_key IN (${part.map(() => "?").join(", ")})`).bind(...part).all()).results || []) out.set(r.decision_key, r.rule_version);
    } catch (e) { if (!noTable(e)) throw e; return out; }
  }
  return out;
}

async function runAll(db, statements) {
  let changes = 0;
  if (!statements.length) return 0;
  for (const st of statements) changes += Number((await st.run())?.meta?.changes) || 0;
  return changes;
}

/** The closed 15m bars the readings read (the same series the Signal Ledger stitches), oldest first. */
async function bars15Of(env) {
  try {
    const r = parse(await env?.SIGNAL_CACHE?.get?.(ZONE_READINGS_SERIES_KEY), null);
    return (Array.isArray(r?.candles) ? r.candles : []).filter((c) => [c.high, c.low, c.close].every(isNum) && c.open_time && c.close_time).sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  } catch { return []; }
}

const READINGS_SQL = `SELECT decision_key, bar_close,
    json_extract(decision_json, '$.key_levels') AS key_levels, json_extract(decision_json, '$.strategy.atr_h1') AS atr_h1,
    json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.context.regime_1h') AS regime
  FROM engine_decisions WHERE bar_close > ? AND bar_close <= ? ORDER BY bar_close LIMIT ?`;

/**
 * The readings behind the cursor (KV ZONE_READINGS_CURSOR_KEY: { bar_close, recent }): at most 200 decisions a run, each
 * once its 8 bars have closed (or an outcome came first). INSERT OR IGNORE on the reading's key, so a rerun writes
 * nothing. Never throws.
 */
export async function runZoneReadings(env, { now = Date.now(), bars15 = null } = {}) {
  if (zoneReadingsMode(env) === "off") return { status: "disabled" };
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    const cursor = parse(await env.SIGNAL_CACHE.get(ZONE_READINGS_CURSOR_KEY), null);
    const since = typeof cursor?.bar_close === "string" ? cursor.bar_close : iso(now - ZONE_READING_RULES.backfill_ms);
    let rows;
    try { rows = (await db.prepare(READINGS_SQL).bind(since, iso(now), ZONE_READING_RULES.max_decisions).all()).results || []; } catch (e) { if (noTable(e)) return { status: "idle" }; throw e; }
    if (!rows.length) return { status: "idle" };
    const bars = bars15 ?? await bars15Of(env);
    const out = zoneReadings(rows, bars, { recent: cursor?.recent ?? [] });
    let written = 0;
    if (out.readings.length) {
      await ensureZoneReadingsSchema(db);
      const rules = await decisionRules(db, out.readings.map((x) => x.decision_key));
      written = await runAll(db, out.readings.map((x) => db.prepare("INSERT OR IGNORE INTO zone_readings (reading_key, decision_key, bar_close, zone_type, zone_strength, zone_freshness, zone_rank, ds_sources, approach, outcome, mfe_atr, mae_atr, bars, mode, regime, version, rule_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(x.reading_key, x.decision_key, x.bar_close, x.zone_type, x.zone_strength, x.zone_freshness, x.zone_rank, x.ds_sources, x.approach, x.outcome, x.mfe_atr, x.mae_atr, x.bars, x.mode, x.regime, ZONE_READINGS_VERSION, rules.get(x.decision_key) ?? null)));
    }
    const last = [...rows].reverse().find((r) => out.done.includes(r.decision_key));
    if (last) await env.SIGNAL_CACHE.put(ZONE_READINGS_CURSOR_KEY, JSON.stringify({ bar_close: last.bar_close, recent: out.recent }));
    return { status: "ok", decisions: out.done.length, written, pending: out.pending };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- counterfactuals (their own tables)

const sideOf = (s) => (s === "long" ? "BUY" : s === "short" ? "SELL" : null);

/** Pure: the zone_blocked WAIT decisions as the would-be plans setupsFrom reads (the guardrails' plan, the default agent's). */
export function blockedPlans(rows) {
  return (rows || []).flatMap((r) => {
    const zb = parse(r.zone_blocked, null), p = zb?.plan;
    const side = sideOf(zb?.side);
    if (!side || !p) return [];
    return [{ key: r.decision_key, close_ms: decisionCloseMs(r.decision_key), decided_at: r.decided_at, side, entry: Number(p.entry), stop: Number(p.stop), tp1: Number(p.tp1), atr_h1: Number(r.atr_h1), mode: r.mode, regime: r.regime,
      agent: typeof zb.agent === "string" ? zb.agent : undefined, action: p.at_level ? "ENTER_MARKET" : "ENTER_LIMIT", at_level: p.at_level === true, ...zoneColumns(p.zone_types ?? null, zb.opposing_ahead ?? p.opposing_ahead ?? null) }];
  }).filter((d) => isNum(d.close_ms)).sort((a, b) => a.close_ms - b.close_ms);
}

/**
 * Pure: the Z2b plans a rule moved, per decision and agent on the decided side ({ ...plan, base, rules }): the acted plan
 * (as recorded) and its base rebuilt from the entry and zone_rules' distances (zoneAimBase). A held copy (held: "rrr")
 * traded its base, so it has no arm.
 */
export function ruleArmPlans(rows) {
  return (rows || []).flatMap((r) => {
    const side = r.stance === "BUY" || r.stance === "SELL" ? r.stance : null, dir = side === "BUY" ? 1 : -1;
    const plans = parse(r.plans, null)?.[side === "BUY" ? "long" : "short"];
    if (!side || !plans || typeof plans !== "object") return [];
    const atr = Number(r.atr_h1);
    return Object.entries(plans).flatMap(([agent, p]) => {
      const rules = (Array.isArray(p?.zone_rules) ? p.zone_rules : []).filter((x) => x?.rule in ZONE_RULE_TOKEN && isNum(x.base_stop_atr) && isNum(x.base_tp1_r)).map((x) => x.rule);
      const base = rules.length ? zoneAimBase(p, atr, dir) : null;
      if (!base) return [];
      return [{ key: r.decision_key, close_ms: decisionCloseMs(r.decision_key), decided_at: r.decided_at, side, entry: Number(p.entry), stop: Number(p.stop), tp1: Number(p.tp1), atr_h1: atr, mode: r.mode, regime: r.regime,
        agent, action: p.at_level ? "ENTER_MARKET" : "ENTER_LIMIT", at_level: p.at_level === true, base, rules: [...new Set(rules)].sort() }];
    });
  }).filter((d) => isNum(d.close_ms)).sort((a, b) => a.close_ms - b.close_ms);
}

const BLOCKED_SQL = `SELECT decision_key, decided_at, json_extract(decision_json, '$.zone_blocked') AS zone_blocked,
    json_extract(decision_json, '$.strategy.atr_h1') AS atr_h1, json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.context.regime_1h') AS regime
  FROM engine_decisions WHERE stance = 'WAIT' AND bar_close >= ? AND json_extract(decision_json, '$.zone_blocked') IS NOT NULL ORDER BY bar_close DESC LIMIT ?`;
const ARMS_SQL = `SELECT decision_key, decided_at, stance, json_extract(decision_json, '$.strategy_plans') AS plans,
    json_extract(decision_json, '$.strategy.atr_h1') AS atr_h1, json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.context.regime_1h') AS regime
  FROM engine_decisions WHERE stance IN ('BUY', 'SELL') AND bar_close >= ? AND instr(decision_json, '"base_stop_atr"') > 0 ORDER BY bar_close DESC LIMIT ?`;
const ZB_COLUMNS = ["setup_key", "decision_key", "agent", "pattern", "opened_at", "decided_at", "last_seen_at", "decisions", "side", "entry", "stop", "tp1", "atr_h1", "mode", "action", "at_level", "regime", "context", "status", "version", "updated_at", "source", "rule_version", ...ZONE_SETUP_COLUMNS];

/**
 * The counterfactual tables: the setups of the last 2 days' zone_blocked WAITs and Z2b arms (at most 200 decisions
 * each a run; a setup repeated by later decisions is extended, as plan learning does), then the replay of those that
 * ended, on the control arm only. Nothing here reads or writes plan_setups. Never throws.
 */
export async function runZoneCounterfactuals(env, { now = Date.now(), bars = null } = {}) {
  if (zoneReadingsMode(env) === "off") return { status: "disabled" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    const since = iso(now - PLAN_RULES.window_days * DAY), lim = ZONE_READING_RULES.max_decisions;
    const read = async (sql) => { try { return ((await db.prepare(sql).bind(since, lim).all()).results || []).reverse(); } catch (e) { if (noTable(e)) return []; throw e; } };
    const blocked = setupsFrom(blockedPlans(await read(BLOCKED_SQL)));
    const armPlans = ruleArmPlans(await read(ARMS_SQL));
    const arms = setupsFrom(armPlans);
    // A setup's base and rules are its first decision's.
    const firstOf = new Map(armPlans.map((p) => [`${p.key}:${p.side}:${p.agent}`, p]));
    let haveOpen = false;
    try { haveOpen = Boolean(await db.prepare("SELECT 1 AS x FROM zone_blocked_setups WHERE status = 'open' UNION ALL SELECT 1 AS x FROM zone_rule_arms WHERE status = 'open' LIMIT 1").first()); } catch (e) { if (!noTable(e)) throw e; }
    if (!blocked.length && !arms.length && !haveOpen) return { status: "idle" };
    await ensureZoneReadingsSchema(db);
    // Each row's rule version is its first decision's own (zone_decision_rules); none recorded: NULL (left out of the evidence).
    const stamp = iso(now);
    const rules = await decisionRules(db, [...blocked, ...arms].map((s) => s.decision_key));
    const rvOf = (s) => rules.get(s.decision_key) ?? null;
    const writes = [];
    let added = 0, extended = 0;
    const known = async (table, keyCol) => new Map(((await db.prepare(`SELECT ${keyCol} AS k, last_seen_at, status FROM ${table} WHERE opened_at >= ?`).bind(since).all()).results || []).map((r) => [r.k, r]));
    const empty = async (table) => !(await db.prepare(`SELECT 1 AS x FROM ${table} LIMIT 1`).first());
    // zone_blocked_setups
    const kb = await known("zone_blocked_setups", "setup_key"), eb = await empty("zone_blocked_setups");
    for (const s of blocked) {
      const k = kb.get(s.setup_key);
      if (!k) {
        if (!eb && s.opened_ms - Date.parse(since) < HOUR) continue;
        const v = [s.setup_key, s.decision_key, s.agent, s.pattern ?? null, iso(s.opened_ms), iso(s.decided_ms), iso(s.last_seen_ms), s.decisions, s.side, s.entry, s.stop, s.tp1, s.atr_h1, s.mode, s.action, s.at_level ? 1 : 0, s.regime, s.context, "open", PLAN_LEARNING_VERSION, stamp, "zone_blocked", rvOf(s), ...ZONE_SETUP_COLUMNS.map((c) => s[c] ?? null)];
        writes.push(db.prepare(`INSERT OR IGNORE INTO zone_blocked_setups (${ZB_COLUMNS.join(", ")}) VALUES (${ZB_COLUMNS.map(() => "?").join(", ")})`).bind(...v));
        added += 1;
      } else if (k.status === "open" && toMs(k.last_seen_at) < s.last_seen_ms) {
        writes.push(db.prepare("UPDATE zone_blocked_setups SET last_seen_at = ?, decisions = ?, updated_at = ? WHERE setup_key = ? AND status = 'open'").bind(iso(s.last_seen_ms), s.decisions, stamp, s.setup_key));
        extended += 1;
      }
    }
    // zone_rule_arms: one row per (setup, rule).
    const ka = await known("zone_rule_arms", "arm_key"), ea = await empty("zone_rule_arms");
    for (const s of arms) {
      const first = firstOf.get(`${s.decision_key}:${s.side}:${s.agent}`);
      if (!first) continue;
      for (const rule of first.rules) {
        const armKey = `${s.setup_key}|${rule}`, k = ka.get(armKey);
        if (!k) {
          if (!ea && s.opened_ms - Date.parse(since) < HOUR) continue;
          writes.push(db.prepare("INSERT OR IGNORE INTO zone_rule_arms (arm_key, setup_key, decision_key, agent, rule, side, opened_at, decided_at, last_seen_at, decisions, entry, stop, tp1, base_stop, base_tp1, atr_h1, action, at_level, mode, regime, status, rule_version, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)")
            .bind(armKey, s.setup_key, s.decision_key, s.agent, rule, s.side, iso(s.opened_ms), iso(s.decided_ms), iso(s.last_seen_ms), s.decisions, s.entry, s.stop, s.tp1, first.base.stop, first.base.tp1, s.atr_h1, s.action, s.at_level ? 1 : 0, s.mode, s.regime, rvOf(s), PLAN_LEARNING_VERSION, stamp));
          added += 1;
        } else if (k.status === "open" && toMs(k.last_seen_at) < s.last_seen_ms) {
          writes.push(db.prepare("UPDATE zone_rule_arms SET last_seen_at = ?, decisions = ?, updated_at = ? WHERE arm_key = ? AND status = 'open'").bind(iso(s.last_seen_ms), s.decisions, stamp, armKey));
          extended += 1;
        }
      }
    }
    await runAll(db, writes);
    // The replay of the setups that ended (the plan no longer repeated), the control arm only.
    const cut = iso(now - PLAN_RULES.setup_gap_ms);
    const openB = (await db.prepare("SELECT * FROM zone_blocked_setups WHERE status = 'open' AND last_seen_at <= ? ORDER BY opened_at LIMIT 200").bind(cut).all()).results || [];
    const openA = (await db.prepare("SELECT * FROM zone_rule_arms WHERE status = 'open' AND last_seen_at <= ? ORDER BY opened_at LIMIT 200").bind(cut).all()).results || [];
    let resolved = 0, unavailable = 0;
    if (openB.length || openA.length) {
      const series = bars ?? (await ledgerSeries(env)).bars;
      const updates = [];
      for (const r of openB) {
        const out = setupOutcome(setupFromRow(r), series, { now });
        if (out.status === "open") continue;
        updates.push(db.prepare("UPDATE zone_blocked_setups SET status = ?, resolved_at = ?, results_json = ?, updated_at = ? WHERE setup_key = ?").bind(out.status, iso(out.resolved_ms ?? now), out.status === "resolved" ? JSON.stringify(out.results) : null, stamp, r.setup_key));
        if (out.status === "resolved") resolved += 1; else unavailable += 1;
      }
      for (const r of openA) {
        const acted = setupFromRow({ ...r, context: "arm", results_json: null });
        const a = setupOutcome(acted, series, { now }), b = setupOutcome({ ...acted, stop: r.base_stop, tp1: r.base_tp1 }, series, { now });
        if (a.status === "open" || b.status === "open") continue;
        const ok = a.status === "resolved" && b.status === "resolved";
        const ar = a.results?.[CONTROL_ARM]?.r, br = b.results?.[CONTROL_ARM]?.r;
        updates.push(db.prepare("UPDATE zone_rule_arms SET status = ?, acted_r = ?, base_r = ?, resolved_at = ?, updated_at = ? WHERE arm_key = ?").bind(ok && isNum(ar) && isNum(br) ? "resolved" : "unavailable", ok && isNum(ar) ? ar : null, ok && isNum(br) ? br : null, iso(Math.max(a.resolved_ms ?? now, b.resolved_ms ?? now)), stamp, r.arm_key));
        if (ok && isNum(ar) && isNum(br)) resolved += 1; else unavailable += 1;
      }
      await runAll(db, updates);
    }
    return { status: "ok", added, extended, resolved, unavailable };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The ledger step's zone work (after the plan learner): the readings, then the counterfactual tables. Never throws. */
export async function runZoneReadingsStep(env, { now = Date.now(), bars15 = null, bars = null } = {}) {
  if (zoneReadingsMode(env) === "off") return { status: "disabled" };
  return { status: "ran", readings: await runZoneReadings(env, { now, bars15 }), counterfactuals: await runZoneCounterfactuals(env, { now, bars }) };
}

// ---------------------------------------------------------------- the breaker (pure)

const ownType = (x) => (x.zone_type === "demand" && x.approach !== "from_below") || (x.zone_type === "supply" && x.approach !== "from_above");
const untyped = (x) => !TYPED.has(x.zone_type);
const rate = (list) => (list.length ? list.filter((x) => x.outcome === "held").length / list.length : null);
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

/**
 * Pure: the holds the evidence calls for, { held: { rule: { by: [...] } }, checks }:
 *   (a) typing  over the last 300 readings with at least 60 in each group, the own-type held rate (a demand zone met
 *               from above or inside, a supply zone from below or inside) minus the untyped held rate below 0: hold
 *               zone_ahead, tp, stop and factor;
 *   (b) block   at least 30 resolved zone_blocked setups with a mean R above +0.10: hold zone_ahead (to 'record');
 *   (c) rule    per Z2b rule, at least 30 resolved arms whose mean acted R is below the mean base R: hold that rule.
 * `readings` newest first ([{ zone_type, approach, outcome }]); `blocked` [{ r }]; `arms` [{ rule, acted_r, base_r }].
 */
export function zoneBreakerHolds({ readings = [], blocked = [], arms = [] } = {}) {
  const B = ZONE_BREAKER, held = {};
  const hold = (rule, by) => { (held[rule] ??= { by: [] }).by.push(by); };
  const win = (readings || []).slice(0, B.window);
  const own = win.filter(ownType), none = win.filter(untyped);
  const typing = { own_n: own.length, untyped_n: none.length, own_held_rate: r3(rate(own)), untyped_held_rate: r3(rate(none)), edge: own.length && none.length ? r3(rate(own) - rate(none)) : null, tripped: false };
  // Thresholds on the rounded figures the line and the view show (3 dp), so a mean of exactly +0.10R is not "above".
  if (own.length >= B.min_group && none.length >= B.min_group && typing.edge < 0) { typing.tripped = true; for (const rule of ZONE_HOLDABLE) hold(rule, "typing"); }
  const br = (blocked || []).slice(0, B.window).map((x) => Number(x.r)).filter(isNum);
  const block = { n: br.length, mean_r: r3(mean(br)), tripped: br.length >= B.min_setups && r3(mean(br)) > B.block_mean_r };
  if (block.tripped) hold("zone_ahead", "block");
  const rules = {};
  for (const [rule, token] of Object.entries(ZONE_RULE_TOKEN)) {
    const list = (arms || []).filter((x) => x?.rule === rule && isNum(Number(x.acted_r)) && isNum(Number(x.base_r))).slice(0, B.window);
    const acted = mean(list.map((x) => Number(x.acted_r))), base = mean(list.map((x) => Number(x.base_r)));
    rules[rule] = { n: list.length, acted_mean_r: r3(acted), base_mean_r: r3(base), tripped: list.length >= B.min_setups && r3(acted) < r3(base) };
    if (rules[rule].tripped) hold(token, `rule:${rule}`);
  }
  return { held: Object.fromEntries(ZONE_HOLDABLE.filter((r) => held[r]).map((r) => [r, held[r]])), checks: { typing, block, rules } };
}

const RULE_WORDS = Object.freeze({ zone_ahead: "the zone_ahead check (to record)", tp: "the tp zone aim", stop: "the stop zone aim", factor: "the zone factor" });
const BY_WORDS = (by, checks) => by.map((b) => b === "typing" ? `typed zones held ${checks.typing.own_held_rate} against ${checks.typing.untyped_held_rate} untyped over ${checks.typing.own_n} and ${checks.typing.untyped_n} readings`
  : b === "block" ? `the trades the check held back made ${checks.block.mean_r}R per setup over ${checks.block.n}`
  : `its plans made ${checks.rules[b.slice(5)]?.acted_mean_r}R against ${checks.rules[b.slice(5)]?.base_mean_r}R for the base over ${checks.rules[b.slice(5)]?.n}`).join("; ");

/**
 * Pure: one 'XAUUSD ZONES' line per change: `changes` = [{ rule, kind, hold }], kind "held" (a new hold, with its
 * evidence), "recovered" (released after its hold period on its own rule version) or "rules_changed" (released at once:
 * the owner's rule version is no longer the hold's).
 */
export function breakerLines(changes = [], checks = null) {
  const days = Math.round(ZONE_BREAKER.hold_ms / DAY);
  return (changes || []).map(({ rule, kind, hold }) => kind === "held"
    ? `XAUUSD ZONES: the breaker holds ${RULE_WORDS[rule]} on the decision side for at least ${days} days: ${checks ? BY_WORDS(hold.by, checks) : hold.by.join(", ")}. The owner's switch is unchanged; after that it returns when its record recovers, and at once when the owner changes a zone switch.`
    : kind === "rules_changed"
      ? `XAUUSD ZONES: the breaker releases ${RULE_WORDS[rule]}: the rules changed (the owner changed a zone switch), and the owner's change wins.`
      : `XAUUSD ZONES: the breaker releases ${RULE_WORDS[rule]}: its record recovered after the ${days}-day hold.`);
}

/**
 * Pure: the next holds from the stored ones and the evidence's (`fresh`, zoneBreakerHolds' held on the owner's current
 * rule version `ruleVersion`). A stored hold { by, since, until, rule_version }:
 *   - its rule_version is not the owner's current one (the owner changed a zone switch): released at once, "rules_changed";
 *   - now < until: kept, whatever the evidence says;
 *   - after until: re-evaluated on its stored rule version (the current one, by the first rule): kept while it still
 *     trips, else released, "recovered".
 * A rule not held that the evidence trips: held { by, since: now, until: now + hold_ms, rule_version }.
 * Returns { held, changes: [{ rule, kind, hold }] }.
 */
export function zoneHoldStep(before = {}, fresh = {}, { now = Date.now(), ruleVersion = null } = {}) {
  const held = {}, changes = [];
  for (const rule of ZONE_HOLDABLE) {
    const h = before?.[rule] && typeof before[rule] === "object" ? before[rule] : null;
    if (h) {
      if (h.rule_version !== ruleVersion) { changes.push({ rule, kind: "rules_changed", hold: h }); continue; }
      if (now < Date.parse(h.until) || fresh?.[rule]) { held[rule] = h; continue; }
      changes.push({ rule, kind: "recovered", hold: h });
      continue;
    }
    if (fresh?.[rule]) {
      const n = { by: [...fresh[rule].by], since: iso(now), until: iso(now + ZONE_BREAKER.hold_ms), rule_version: ruleVersion };
      held[rule] = n; changes.push({ rule, kind: "held", hold: n });
    }
  }
  return { held, changes };
}

// ---------------------------------------------------------------- the breaker on the decision side

/** The breaker's held rules for a decision ({ rule: { by } }), or null: none while ZONE_READINGS is off. Never throws. */
export async function readZoneHolds(env) {
  if (zoneReadingsMode(env) === "off") return null;
  try {
    const st = parse(await env?.SIGNAL_CACHE?.get?.(ZONE_BREAKER_KEY), null);
    return st?.held && typeof st.held === "object" && Object.keys(st.held).length ? st.held : null;
  } catch { return null; }
}

/**
 * Pure: the run's env with the held rules as their own switches off, for this run only, and the record's
 * zone_rules_held ([{ rule, by }], only the rules a hold changed). zone_ahead held: ZONE_AHEAD_MODE "record" while the
 * check is in the guardrails ('trend' or 'all'); tp, stop, factor held: added to ZONE_AIM_OFF while Z2b has that rule
 * on. Nothing is turned on; with nothing to hold, env itself and [].
 */
export function applyZoneHolds(env, held) {
  if (!held || typeof held !== "object" || zoneReadingsMode(env) === "off") return { env, held: [] };
  const patch = {}, out = [];
  // The owner's change wins at once: a hold made on another rule version is not applied (the next tick releases it).
  const rv = ruleVersionOf(env);
  held = Object.fromEntries(Object.entries(held).filter(([, h]) => h && (typeof h.rule_version !== "string" || h.rule_version === rv)));
  const by = (rule) => (Array.isArray(held[rule]?.by) ? held[rule].by.filter((b) => typeof b === "string") : []);
  if (held.zone_ahead && zoneAheadChecks(zoneAheadMode(env))) { patch.ZONE_AHEAD_MODE = "record"; out.push({ rule: "zone_ahead", by: by("zone_ahead") }); }
  const aim = zoneAimMode(env);
  if (aim) {
    const on = (t) => (t === "tp" ? aim.tp !== null : aim[t] === true);
    const off = [...zoneAimOffMode(env)];
    for (const t of ZONE_AIM_TOKENS) if (held[t] && on(t)) { off.push(t); out.push({ rule: t, by: by(t) }); }
    if (off.length !== zoneAimOffMode(env).length) patch.ZONE_AIM_OFF = ZONE_AIM_TOKENS.filter((t) => off.includes(t)).join(",");
  }
  return out.length ? { env: { ...env, ...patch }, held: out } : { env, held: [] };
}

/**
 * ZN1, pure: does the stored hold `hold` of `rule` change a decision right now under `env` (the run's env with the FS1
 * overrides applied)? Exactly when applyZoneHolds would apply it, so the two cannot disagree: ZONE_READINGS on, the
 * hold made on `env`'s rule version (or carrying none), and the rule on under the owner's switches. zone_ahead: the
 * check in the guardrails (ZONE_PRIORITY on, KEY_LEVEL_ZONE_TYPES not off, ZONE_AHEAD_MODE 'trend' or 'all'); tp,
 * stop, factor: Z2b in force (ZONE_PRIORITY on, KEY_LEVEL_ZONE_TYPES not off) with that token not in ZONE_AIM_OFF.
 * Any other rule: false. One rule's hold never changes whether another acts, so each is decided on its own.
 */
export function zoneHoldEffective(env, rule, hold) {
  if (!ZONE_HOLDABLE.includes(rule)) return false;
  return applyZoneHolds(env, { [rule]: hold }).held.some((x) => x.rule === rule);
}

/**
 * ZN1, pure: a stored breaker hold's { since, until } (ISO strings as zoneHoldStep wrote them, else null). The one
 * reader of both FS1's zone_hold (zoneHoldRows) and GET /api/zones' breaker.held, so the two always show the same.
 */
/**
 * ZN1, pure: is a stored breaker hold one of the current rule version (`rv`, ruleVersionOf of the env in force), or one
 * carrying none? The one filter of both FS1's zone_hold (zoneHoldRows) and GET /api/zones' breaker.held: a hold made
 * on an older rule version is released by the version change and shows in neither.
 */
export const zoneHoldCurrent = (hold, rv) => Boolean(hold && typeof hold === "object" && (typeof hold.rule_version !== "string" || hold.rule_version === rv));

export function zoneHoldTimes(hold) {
  const h = hold && typeof hold === "object" ? hold : {};
  return { since: typeof h.since === "string" ? h.since : null, until: typeof h.until === "string" ? h.until : null };
}

/**
 * FS1 (src/feature-switch-store.mjs): the breaker's holds for the panel rows, from one KV read of ZONE_BREAKER_KEY, as
 * { zone_ahead: { since, until, by } | null, aim: { tp, stop, factor } | null } (aim lists only the tokens held). A
 * hold made on another rule version than `env`'s (the owner changed a zone switch; the next tick releases it) is left
 * out, as applyZoneHolds leaves it out. Unreadable, or ZONE_READINGS off: { zone_ahead: null, aim: null }.
 */
export async function zoneHoldRows(env) {
  const none = { zone_ahead: null, aim: null };
  if (zoneReadingsMode(env) === "off") return none;
  try {
    const st = parse(await env?.SIGNAL_CACHE?.get?.(ZONE_BREAKER_KEY), null);
    const rv = ruleVersionOf(env);
    const row = (h) => (zoneHoldCurrent(h, rv)
      ? { ...zoneHoldTimes(h), by: Array.isArray(h.by) ? h.by.filter((b) => typeof b === "string") : [] } : null);
    const aim = Object.fromEntries(ZONE_AIM_TOKENS.map((t) => [t, row(st?.held?.[t])]).filter(([, v]) => v));
    return { zone_ahead: row(st?.held?.zone_ahead), aim: Object.keys(aim).length ? aim : null };
  } catch { return none; }
}

// ---------------------------------------------------------------- the breaker tick, the alarms, Omega attribution

async function safeAll(db, sql, args = []) {
  try { return (await db.prepare(sql).bind(...args).all()).results || []; } catch (e) { if (noTable(e)) return []; throw e; }
}

/** The breaker's evidence for the rule version in force: readings, zone_blocked R and arms, newest first (SELECT only). */
export async function breakerEvidence(db, ruleVersion) {
  const W = ZONE_BREAKER.window;
  const readings = await safeAll(db, "SELECT zone_type, approach, outcome FROM zone_readings WHERE rule_version = ? ORDER BY bar_close DESC LIMIT ?", [ruleVersion, W]);
  const blocked = (await safeAll(db, "SELECT results_json FROM zone_blocked_setups WHERE status = 'resolved' AND rule_version = ? ORDER BY opened_at DESC LIMIT ?", [ruleVersion, W]))
    .map((r) => ({ r: parse(r.results_json, {})?.[CONTROL_ARM]?.r })).filter((x) => isNum(x.r));
  const arms = await safeAll(db, "SELECT rule, acted_r, base_r FROM zone_rule_arms WHERE status = 'resolved' AND rule_version = ? ORDER BY opened_at DESC LIMIT ?", [ruleVersion, 2 * W]);
  return { readings, blocked, arms };
}

/**
 * Pure: the share of the decisions where the council wanted a side ([{ wanted: "BUY" | "SELL", blocked_side }], newest
 * first, at most 96) that zone_ahead alone held back on that side.
 */
export function blockShare(rows) {
  const list = (rows || []).filter((r) => r?.wanted === "BUY" || r?.wanted === "SELL").slice(0, ZONE_ALARMS.window);
  const blocked = list.filter((r) => r.blocked_side === (r.wanted === "BUY" ? "long" : "short")).length;
  return { n: list.length, blocked, share: list.length ? r3(blocked / list.length) : null };
}

const WANTED_SQL = `SELECT stance, json_extract(decision_json, '$.overruled.wanted') AS wanted, json_extract(decision_json, '$.zone_blocked.side') AS blocked_side
  FROM engine_decisions WHERE stance IN ('BUY', 'SELL') OR json_extract(decision_json, '$.overruled.wanted') IN ('BUY', 'SELL') ORDER BY bar_close DESC LIMIT ?`;
async function wantedRows(db) {
  return (await safeAll(db, WANTED_SQL, [ZONE_ALARMS.window])).map((r) => ({ wanted: r.stance === "BUY" || r.stance === "SELL" ? r.stance : r.wanted, blocked_side: r.blocked_side ?? null }));
}

/**
 * Omega attribution (read-only, SELECT only): Omega's trades a zone touched, by the intent's reason or its
 * level_source 'zone' (omega_intents) and by the Position Manager's zone rules (position_actions, pm_zone_*), each
 * joined to its closed ea_deals in R (src/ledger-omega4.mjs liveTradesFrom). Words and R only: no ticket, price, money
 * or account leaves. { closes, mean_r, by: [{ source, n, mean_r }], advisory }.
 * TODO(Z3a): while zone_mgmt is not off, add the flag for the decision-side typing toggles here (zone_mgmt is an Omega
 * setting Z3a adds; this attribution never reads or writes it).
 */
export async function omegaZoneAttribution(db, { now = Date.now() } = {}) {
  const since = now - ZONE_ALARMS.omega_days * DAY;
  const intents = await safeAll(db, `SELECT kind, json_extract(payload, '$.reason') AS reason, json_extract(payload, '$.level_source') AS level_source,
      COALESCE(json_extract(payload, '$.ticket'), json_extract(result, '$.ticket')) AS ticket
    FROM omega_intents WHERE created_ms >= ? AND (json_extract(payload, '$.level_source') = 'zone' OR json_extract(payload, '$.reason') LIKE 'pm_zone_%' OR json_extract(payload, '$.reason') LIKE 'zone_%') LIMIT 2000`, [since]);
  const actions = await safeAll(db, "SELECT ticket, rule FROM position_actions WHERE at_ms >= ? AND (rule LIKE 'zone_%' OR rule LIKE 'pm_zone_%') LIMIT 2000", [since]);
  const tags = new Map();
  const tag = (t, source) => { const k = Number(t); if (!(k > 0)) return; if (!tags.has(k)) tags.set(k, new Set()); tags.get(k).add(source); };
  for (const r of intents) tag(r.ticket, r.level_source === "zone" ? `intent:level_source_zone` : `intent:${String(r.reason ?? r.kind).slice(0, 40)}`);
  for (const r of actions) tag(r.ticket, `pm:${String(r.rule).startsWith("pm_") ? String(r.rule).slice(3, 43) : String(r.rule).slice(0, 40)}`);
  if (!tags.size) return { closes: 0, mean_r: null, by: [], advisory: false };
  const { liveTradesFrom } = await import("./ledger-omega4.mjs");
  const tickets = [...tags.keys()].slice(0, 500), rs = new Map();
  for (let i = 0; i < tickets.length; i += 50) {
    const part = tickets.slice(i, i + 50), marks = part.map(() => "?").join(", ");
    const deals = await safeAll(db, `SELECT position_ticket, side, volume, profit, reason, opened_ms, closed_ms FROM ea_deals WHERE source = 'omega' AND currency = 'USD' AND mode <> 'demo' AND position_ticket IN (${marks})`, part);
    const opens = {};
    for (const r of await safeAll(db, `SELECT payload, json_extract(result, '$.ticket') AS ticket FROM omega_intents WHERE kind = 'open' AND json_extract(result, '$.ticket') IN (${marks})`, part)) {
      const p = parse(r.payload, {});
      opens[Number(r.ticket)] = { entry: p.entry, sl: p.sl, volume: p.volume, r_dist: p.r_dist, signal_issued_ms: p.signal_issued_ms, side: p.side, mode: p.mode ?? null };
    }
    for (const t of part) {
      const tr = liveTradesFrom({ deals: deals.filter((d) => Number(d.position_ticket) === t), opens: opens[t] ? { [t]: opens[t] } : {} })[0];
      if (tr && isNum(tr.r)) rs.set(t, tr.r);
    }
  }
  const by = new Map();
  for (const [t, r] of rs) for (const s of tags.get(t)) { const g = by.get(s) ?? []; g.push(r); by.set(s, g); }
  const all = [...rs.values()], m = mean(all);
  return { closes: all.length, mean_r: r3(m), by: [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([source, list]) => ({ source, n: list.length, mean_r: r3(mean(list)) })), advisory: all.length >= ZONE_ALARMS.omega_min_closes && m < 0 };
}

/** Pure: the day's alarm lines ({ kind: text }) from the block share, the zone_ahead mode in force and the attribution. */
export function alarmLines({ share = null, mode = "trend", omega = null } = {}) {
  const out = {};
  const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
  if (share && share.n >= ZONE_ALARMS.window && share.share > ZONE_ALARMS.share) out.zone_ahead_share = `XAUUSD ZONES alarm: zone_ahead alone held back ${share.blocked} of the last ${share.n} decisions where the council wanted a side (${pct(share.share)}, above ${pct(ZONE_ALARMS.share)}). No action taken.`;
  if (mode === "all") out.all_mode_share = `XAUUSD ZONES: ZONE_AHEAD_MODE is 'all' (no trend exemption): zone_ahead alone held back ${share?.blocked ?? 0} of the last ${share?.n ?? 0} decisions where the council wanted a side (${pct(share?.share)}). No action taken.`;
  if (omega?.advisory) out.omega_attribution = `XAUUSD ZONES: Omega's zone-attributed trades closed ${omega.closes} times at ${omega.mean_r}R on average over ${ZONE_ALARMS.omega_days} days: the owner may set zone_mgmt lower. No action taken.`;
  return out;
}

/**
 * The hourly tick, beside the strategy agents' breaker: the holds from the evidence of the rule version in force, one
 * 'XAUUSD ZONES' line per change (sent first, then kept: a failed send is told again at the next tick), and the alarms,
 * one line a day each. The state goes to KV ZONE_BREAKER_KEY only; nothing else is written. Never throws.
 */
export async function runZoneBreaker(env, { now = Date.now(), send = null, force = false } = {}) {
  if (zoneReadingsMode(env) === "off") return { status: "disabled" };
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const stored = parse(await kv.get(ZONE_BREAKER_KEY), null);
    if (!force && stored?.checked_at && now - Date.parse(stored.checked_at) < ZONE_BREAKER.every_ms) return { status: "fresh" };
    const ruleVersion = ruleVersionOf(env);
    // Fresh holds on the owner's current rule version; a stored hold keeps its own (zoneHoldStep).
    const { held: fresh, checks } = zoneBreakerHolds(await breakerEvidence(db, ruleVersion));
    const before = stored?.held && typeof stored.held === "object" ? stored.held : {};
    const step = zoneHoldStep(before, fresh, { now, ruleVersion });
    let error = null;
    const tell = async (text) => {
      if (typeof send !== "function") return true;
      try { await send(text); return true; } catch (e) { error = String(e?.message ?? e).slice(0, 160); return false; }
    };
    // Sent first, then kept: a change whose line fails stays as it was, and is told again at the next tick.
    const keep = { ...step.held };
    let told = 0;
    for (const c of step.changes) {
      if (await tell(breakerLines([c], checks)[0])) { told += 1; continue; }
      if (c.kind === "held") delete keep[c.rule]; else keep[c.rule] = c.hold;
    }
    // The alarms, one line a UTC day each, no action.
    const day = iso(now).slice(0, 10), alarms = { ...(stored?.alarms ?? {}) };
    const lines = alarmLines({ share: blockShare(await wantedRows(db)), mode: zoneAheadMode(env), omega: await omegaZoneAttribution(db, { now }) });
    let alarmed = 0;
    for (const [kind, text] of Object.entries(lines)) {
      if (alarms[kind] === day) continue;
      if (await tell(text)) { alarms[kind] = day; alarmed += 1; }
    }
    const ordered = Object.fromEntries(ZONE_HOLDABLE.filter((r) => keep[r]).map((r) => [r, keep[r]]));
    const state = { version: ZONE_READINGS_VERSION, rule_version: ruleVersion, checked_at: iso(now), held: ordered, checks, alarms };
    await kv.put(ZONE_BREAKER_KEY, JSON.stringify(state));
    const changed = JSON.stringify(Object.keys(ordered)) !== JSON.stringify(ZONE_HOLDABLE.filter((r) => before[r]));
    if (error) return { status: "failed", error, held: Object.keys(ordered), told, alarmed };
    return { status: changed ? "changed" : "unchanged", held: Object.keys(ordered), told, alarmed };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 160) };
  }
}

// ---------------------------------------------------------------- GET /api/zones (SELECT only)

/**
 * The Nexus zones view: readings by type x approach x strength (n, held rate shrunk toward the overall rate with a
 * prior of 20), the zone_blocked cohort per side (n, mean R, fill rate), the rule arms, the breaker's state, the
 * stance shares of the last 7 days and Omega's attribution. breaker.held[]: { rule, by, since, until, effective } (ZN1:
 * since/until as FS1's zone_hold shows them; effective, whether the hold changes a decision now). Words, ATR, R and
 * booleans only; no account or identity key, no
 * price. SELECT only: a table that does not exist yet reads as []. Throws on any other read failure.
 */
export async function zonesView(env, { now = Date.now() } = {}) {
  const db = env.DB;
  const since = iso(now - 30 * DAY);
  const groups = await safeAll(db, `SELECT COALESCE(zone_type, 'untyped') AS zone_type, approach, COALESCE(zone_strength, 'none') AS zone_strength, COUNT(*) AS n,
      SUM(CASE WHEN outcome = 'held' THEN 1 ELSE 0 END) AS held, SUM(CASE WHEN outcome = 'broke' THEN 1 ELSE 0 END) AS broke, SUM(CASE WHEN outcome = 'neither' THEN 1 ELSE 0 END) AS neither,
      AVG(mfe_atr) AS mfe_atr, AVG(mae_atr) AS mae_atr
    FROM zone_readings WHERE bar_close >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [since]);
  const total = groups.reduce((a, g) => a + Number(g.n), 0), heldAll = groups.reduce((a, g) => a + Number(g.held), 0);
  const p0 = total ? heldAll / total : 0;
  const readings = groups.map((g) => ({ zone_type: g.zone_type, approach: g.approach, zone_strength: g.zone_strength, n: Number(g.n), held: Number(g.held), broke: Number(g.broke), neither: Number(g.neither),
    held_rate: r3(Number(g.held) / Number(g.n)), held_rate_shrunk: r3((Number(g.held) + ZONE_VIEW_PRIOR * p0) / (Number(g.n) + ZONE_VIEW_PRIOR)), mfe_atr: r2(Number(g.mfe_atr)), mae_atr: r2(Number(g.mae_atr)) }));
  const blockedRows = await safeAll(db, "SELECT side, results_json FROM zone_blocked_setups WHERE status = 'resolved' AND opened_at >= ?", [since]);
  const bySide = new Map();
  for (const r of blockedRows) { const x = parse(r.results_json, {})?.[CONTROL_ARM]; if (!isNum(x?.r)) continue; const g = bySide.get(r.side) ?? []; g.push(x); bySide.set(r.side, g); }
  const zone_blocked = [...bySide.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([side, list]) => ({ side, n: list.length, mean_r: r3(mean(list.map((x) => x.r))), fill_rate: r3(list.filter((x) => x.f).length / list.length) }));
  const rule_arms = (await safeAll(db, "SELECT rule, COUNT(*) AS n, AVG(acted_r) AS acted, AVG(base_r) AS base FROM zone_rule_arms WHERE status = 'resolved' AND opened_at >= ? GROUP BY rule ORDER BY rule", [since]))
    .map((r) => ({ rule: r.rule, n: Number(r.n), acted_mean_r: r3(Number(r.acted)), base_mean_r: r3(Number(r.base)), delta_r: r3(Number(r.acted) - Number(r.base)) }));
  const st = parse(await env.SIGNAL_CACHE?.get?.(ZONE_BREAKER_KEY), null);
  // ZN1: only the holds of the current rule version (zoneHoldCurrent, FS1's filter); each hold's since/until
  // (zoneHoldTimes, FS1's reader) and whether it acts now (zoneHoldEffective) under the
  // env the Decision Engine runs on: the FS1 overrides applied (already, behind the fetch entry; a no-op then).
  let runEnv = env;
  if (st) { try { runEnv = await (await import("./feature-switch-store.mjs")).withFeatureSwitches(env); } catch { runEnv = env; } }
  const breaker = st ? { checked_at: st.checked_at ?? null, rule_version: st.rule_version ?? null, held: Object.entries(st.held ?? {}).filter(([, x]) => zoneHoldCurrent(x, ruleVersionOf(runEnv))).map(([rule, x]) => ({ rule, by: Array.isArray(x?.by) ? x.by : [], ...zoneHoldTimes(x), effective: zoneHoldEffective(runEnv, rule, x) })), checks: st.checks ?? null } : null;
  const stanceRows = await safeAll(db, `SELECT stance, COUNT(*) AS n, SUM(CASE WHEN json_extract(decision_json, '$.zone_blocked') IS NOT NULL THEN 1 ELSE 0 END) AS zone_blocked
    FROM engine_decisions WHERE bar_close >= ? GROUP BY stance ORDER BY stance`, [iso(now - 7 * DAY)]);
  const nStances = stanceRows.reduce((a, r) => a + Number(r.n), 0);
  const stances = stanceRows.map((r) => ({ stance: r.stance, n: Number(r.n), share: nStances ? r3(Number(r.n) / nStances) : null, zone_blocked: Number(r.zone_blocked) || 0 }));
  const omega = await omegaZoneAttribution(db, { now });
  return {
    status: "ok", schema: "cryptophys.zones-view.v1", generated_at: iso(now), window_days: 30, prior: ZONE_VIEW_PRIOR,
    readings, zone_blocked, rule_arms, breaker, stances,
    omega_attribution: omega.by, omega_advisory: { closes: omega.closes, mean_r: omega.mean_r, advisory: omega.advisory }
  };
}
