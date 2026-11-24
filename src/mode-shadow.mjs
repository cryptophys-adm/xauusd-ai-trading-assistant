// MS2 (2026-11-23): shadow per-mode evidence and the probation switch (docs/RFC_ACCOUNT_PROFILES.md §7).
//
// The daily mode selector (src/mode-selector.mjs) only had evidence for the mode that traded, so the other modes rarely
// collected enough setups. At every 15m decision the Decision Engine (src/decision-engine.mjs shadowModeDecisions) now
// re-runs only the deterministic part of its decision for each mode that is not in force, with the same witnesses and the
// same council answer; a mode that would trade writes its plans here (D1 mode_shadow_plans, one row per decision and
// mode). The plan learner (src/plan-learning.mjs) derives setups from those rows with the live setup rules, tagged
// plan_setups.source = 'shadow', and replays them on the control arm only. The mode selector is the ONLY reader of
// shadow setups; every other plan_setups reader reads source = 'live'.
//
// Switches (read like the repository's other env switches):
//   MODE_SHADOW_EVIDENCE  "on" (default) | "off": no shadow row written or derived; the selector reads live only, as before.
//   MODE_PROBATION        "on" (default) | "off": no probation and no risk scale.
// Nothing here reaches a room, a council, a price in a room, the EA or a model.
import { tp1KeyZoneMode } from "./strategy-engine.mjs";
import { zoneRuleToken } from "./zone-types.mjs";

export function modeShadowEvidence(env) {
  return String(env?.MODE_SHADOW_EVIDENCE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}
export function modeProbationMode(env) {
  return String(env?.MODE_PROBATION ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * The target rule a setup was planned under (plan_setups.rule_version, mode_shadow_plans.rule_version): TP1-KZ on or off
 * (src/strategy-engine.mjs tp1KeyZoneMode). TP1-KZ changes the geometry in every mode, so the selector counts only the
 * setups of the rule in force: its evidence restarts at TP1-KZ's deploy and the shadow refills it on every bar. TP1-KZ
 * itself did not write it; MS2 prepares the column. Z2 (2026-11-24): while the zone_ahead check is in the guardrails
 * (ZONE_PRIORITY on, ZONE_AHEAD_MODE 'trend' or 'all') the version adds "+zone_ahead@1" ("+zone_ahead@1:all"): the check
 * changes which decisions trade in every mode, so the evidence restarts at its deploy as it did at TP1-KZ's. Off or
 * 'record': the version as before.
 */
export const ruleVersionOf = (env) => `tp1_kz:${tp1KeyZoneMode(env)}${zoneRuleToken(env) ? `+${zoneRuleToken(env)}` : ""}`;

/** The probation (owner via the orchestrator, MS2): a switch to a mode with fewer live setups is one. */
export const MODE_PROBATION_RULES = Object.freeze({ min_live_setups: 31, fail_setups: 15, risk_scale: 0.5 });

export const MODE_SHADOW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS mode_shadow_plans (
    decision_key TEXT NOT NULL, bar_close TEXT NOT NULL, decided_at TEXT NOT NULL, mode TEXT NOT NULL, side TEXT NOT NULL,
    agent TEXT, plans_json TEXT NOT NULL, atr_h1 REAL, regime TEXT, rule_version TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (decision_key, mode)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_mode_shadow_plans_close ON mode_shadow_plans(bar_close)"
];
const ready = new WeakSet();
export async function ensureModeShadowSchema(db) {
  if (!db || ready.has(db)) return;
  for (const sql of MODE_SHADOW_SCHEMA_SQL) await db.prepare(sql).run();
  ready.add(db);
}

/**
 * Writes the shadow modes that would trade (`rows` from shadowModeDecisions: { mode, stance, agent, plans, trade }) for
 * one decision. One INSERT OR IGNORE per row (a batch when D1 has one). Never throws; returns the rows written.
 */
export async function writeShadowPlans(env, { record, rows, now = Date.now() }) {
  const db = env?.DB;
  if (!db || modeShadowEvidence(env) === "off") return 0;
  const trading = (rows || []).filter((r) => r && (r.stance === "BUY" || r.stance === "SELL"));
  if (!trading.length) return 0;
  try {
    await ensureModeShadowSchema(db);
    const rv = ruleVersionOf(env), at = new Date(now).toISOString();
    const st = trading.map((r) => db.prepare("INSERT OR IGNORE INTO mode_shadow_plans (decision_key, bar_close, decided_at, mode, side, agent, plans_json, atr_h1, regime, rule_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(record.decision_key, record.bar_close, record.decided_at, r.mode, r.stance, r.agent ?? null, JSON.stringify({ [r.stance === "BUY" ? "long" : "short"]: r.plans ?? {}, trade: r.trade ?? null }), Number.isFinite(record?.strategy?.atr_h1) ? record.strategy.atr_h1 : null, record?.context?.regime_1h ?? null, rv, at));
    if (typeof db.batch === "function") await db.batch(st); else for (const s of st) await s.run();
    return trading.length;
  } catch { return 0; }
}

/**
 * The retention (orchestrator ruling 4, MS2): shadow rows older than MODE_SHADOW_KEEP_DAYS (90) by their bar close are
 * dropped, at most MODE_SHADOW_PRUNE_MAX a run (about 300 rows a day are written, so one run keeps up). A sweep step of
 * the cron's retention line (src/index.ts, beside pruneShadowKnowledge and pruneModelArena). The plan learner reads only
 * the rows of its window (plan-learning.mjs loadShadowDecisions: 2 days, 30 at its first run), so a pruned row was
 * derived long before. The shadow setups in plan_setups stay: no sweep prunes plan_setups by age (a follow-up, not a
 * new policy here). Never throws.
 */
export const MODE_SHADOW_KEEP_DAYS = 90;
export const MODE_SHADOW_PRUNE_MAX = 5000;
export async function pruneModeShadowPlans(env, { now = Date.now(), days = MODE_SHADOW_KEEP_DAYS, max = MODE_SHADOW_PRUNE_MAX } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensureModeShadowSchema(db);
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const r = await db.prepare("DELETE FROM mode_shadow_plans WHERE rowid IN (SELECT rowid FROM mode_shadow_plans WHERE bar_close < ? ORDER BY bar_close LIMIT ?)").bind(cutoff, max).run();
    return { status: "ok", pruned: Number(r?.meta?.changes ?? 0) };
  } catch (e) { return { status: "failed", error: e instanceof Error ? e.message : String(e) }; }
}
