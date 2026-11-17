// The strategy arm's platform record (docs/RFC_STRATEGY_RECOMMENDATION.md §10; owner 2026-11-17 "Ya, semua, live";
// platform ADR-0020 Amendment 1, relayed 2026-11-17: the digest carries the mode, and each pick names the chosen
// strategy with its measured confidence and confluence).
//
// Reads, since its cursor (KV strategy-arm:relay), the arm and disarm events (D1 strategy_arm_events, the authority)
// and the Decision Engine's strategy picks (engine_decisions, `selection`), and publishes them as ONE kernel report
// from xauusd-risk-manager (reports.publish, kind xauusd_digest, body.schema "strategy_arm.v1"), at most one per
// RELAY_MIN_GAP_MS: the agent's 4 reports an hour are shared with the health alerts and the EA heartbeat relay, so the
// events of a burst travel together (RFC §10: batched beyond the budget). The cursor advances only on success; a rate
// limit or a transport failure is retried after RELAY_RETRY_MS; any other kernel denial is final (the cursor advances,
// logged), never a loop. Best effort: an arm or disarm never waits for it. Never throws.
import { publishToPlatform, platformEnabled } from "./platform-reports.mjs";
import { HEALTH_AGENT_ID } from "./health-alerts.mjs";
import { strategyArmMode, ensureStrategyArmSchema, ARM_MAX } from "./strategy-arm.mjs";
import { readCouncilState } from "./strategy-council.mjs";

export const STRATEGY_ARM_SCHEMA = "strategy_arm.v1";
export const STRATEGY_ARM_AGENT = HEALTH_AGENT_ID;
export const ARM_RELAY_CURSOR_KEY = "strategy-arm:relay";
export const ARM_RELAY_MIN_GAP_MS = 30 * 60_000;
export const ARM_RELAY_RETRY_MS = 15 * 60_000;
export const ARM_RELAY_MAX_ITEMS = 20;

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const r2 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const AUTO_REASONS = new Set(["kill_switch", "daily_loss_limit", "breaker", "unavailable", "executor_lost"]);

/** Pure: one arm or disarm event row as a report item. */
export function eventItem(row) {
  return {
    event: row.action === "arm" ? "armed" : "disarmed",
    strategy_id: String(row.strategy_id),
    reason: String(row.reason),
    armed_count: Number(row.armed_count_after),
    at: new Date(Number(row.at)).toISOString(),
    audit_ref: Number(row.id)
  };
}

/** Pure: one Decision Engine pick (the record's `selection`) as a report item, or null without a chosen strategy. */
export function pickItem(row) {
  const sel = typeof row.selection === "string" ? parse(row.selection) : row.selection;
  if (!sel || typeof sel.agent !== "string" || !sel.agent) return null;
  const chosen = (Array.isArray(sel.candidates) ? sel.candidates : []).find((c) => c?.id === sel.agent) ?? {};
  return {
    event: "picked",
    mode: sel.mode === "armed" ? "armed" : "auto",
    strategy_id: sel.agent,
    confidence: r2(chosen.confidence),
    confluence: r2(chosen.confluence),
    score: r2(sel.score ?? chosen.score),
    decision_key: String(row.decision_key),
    at: String(row.decided_at)
  };
}

/** Pure: the report for these items (oldest first) and the arm state now. */
export function armReport(items, { mode, armedIds = [] } = {}) {
  const autoDisarm = items.some((x) => x.event === "disarmed" && AUTO_REASONS.has(x.reason));
  const counts = { armed: 0, disarmed: 0, picked: 0 };
  for (const x of items) counts[x.event] = (counts[x.event] ?? 0) + 1;
  const parts = [counts.armed && `${counts.armed} armed`, counts.disarmed && `${counts.disarmed} disarmed`, counts.picked && `${counts.picked} pick${counts.picked === 1 ? "" : "s"}`].filter(Boolean);
  return {
    kind: "xauusd_digest",
    severity: autoDisarm ? "warning" : "info",
    subject: `Strategy arm (${mode}): ${parts.join(", ") || "no change"}`.slice(0, 200),
    ai_status: "deterministic",
    body: {
      schema: STRATEGY_ARM_SCHEMA,
      mode,
      armed: armedIds,
      armed_count: armedIds.length,
      max: ARM_MAX,
      items,
      observation: "Strategy arm audit: the owner's arm/disarm clicks, the system's auto-disarms and the Decision Engine's strategy picks",
      source: "xauusd-ai-trading-assistant"
    }
  };
}

async function readCursor(env) {
  try { return parse(await env.SIGNAL_CACHE?.get?.(ARM_RELAY_CURSOR_KEY)) || null; } catch { return null; }
}
async function writeCursor(env, cursor) {
  try { await env.SIGNAL_CACHE?.put?.(ARM_RELAY_CURSOR_KEY, JSON.stringify(cursor)); } catch { /* the next run sends again */ }
}

/**
 * Publishes the arm events and picks since the cursor as one strategy_arm.v1 report.
 * Returns { status: disabled | unavailable | waiting | idle | sent | denied | failed, ... }.
 */
export async function relayStrategyArm(env, { now = Date.now(), publish = publishToPlatform } = {}) {
  if (!platformEnabled(env) || strategyArmMode(env) === "off") return { status: "disabled" };
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    await ensureStrategyArmSchema(db);
    // First run: every arm event so far (the audit is short), picks from now on (no backfill of old decisions).
    const stored = await readCursor(env);
    const cursor = stored ?? { last_event_id: 0, last_decided_at: new Date(now).toISOString() };
    if (now - (Number(cursor.sent_ms) || 0) < ARM_RELAY_MIN_GAP_MS) return { status: "waiting" };
    if (now - (Number(cursor.refused_ms) || 0) < ARM_RELAY_RETRY_MS) return { status: "waiting" };
    const lastId = Number(cursor.last_event_id) || 0;
    const since = typeof cursor.last_decided_at === "string" ? cursor.last_decided_at : new Date(now).toISOString();
    const events = (await db.prepare("SELECT id, strategy_id, action, reason, armed_count_after, at FROM strategy_arm_events WHERE id > ? ORDER BY id LIMIT ?").bind(lastId, ARM_RELAY_MAX_ITEMS).all()).results ?? [];
    const picks = (await db.prepare("SELECT decision_key, decided_at, json_extract(decision_json, '$.selection') AS selection FROM engine_decisions WHERE decided_at > ? AND json_extract(decision_json, '$.selection.agent') IS NOT NULL ORDER BY decided_at LIMIT ?").bind(since, ARM_RELAY_MAX_ITEMS).all()).results ?? [];
    const pickItems = picks.map(pickItem).filter(Boolean);
    const items = [...events.map(eventItem), ...pickItems].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const next = {
      last_event_id: events.length ? Number(events.at(-1).id) : lastId,
      last_decided_at: picks.length ? String(picks.at(-1).decided_at) : since
    };
    if (!items.length) {
      if (!stored || next.last_decided_at !== cursor.last_decided_at) await writeCursor(env, { ...cursor, ...next });
      return { status: "idle" };
    }
    const arms = (await db.prepare("SELECT strategy_id FROM strategy_arms WHERE armed = 1 ORDER BY armed_at, strategy_id").all()).results ?? [];
    const armedIds = arms.map((r) => r.strategy_id);
    let councilAuto = false;
    try { councilAuto = (await readCouncilState(env)).acting === true; } catch { councilAuto = false; }
    const report = armReport(items, { mode: armedIds.length ? "armed" : "auto", armedIds });
    report.body.council_auto = councilAuto;
    const r = await publish(env, STRATEGY_ARM_AGENT, report);
    if (r.outcome === "success") {
      await writeCursor(env, { ...next, sent_ms: now, report_id: r.report_id ?? null });
      return { status: "sent", count: items.length, report_id: r.report_id ?? null };
    }
    const retry = r.outcome === "failed" || r.outcome === "disabled" || /rate/i.test(String(r.reason ?? ""));
    if (retry) {
      await writeCursor(env, { ...cursor, refused_ms: now, reason: r.reason ?? null });
      return { status: r.outcome === "failed" ? "failed" : "denied", reason: r.reason ?? null, retry: true };
    }
    // A final kernel denial (policy): marked and not retried in a loop; the D1 audit keeps every event.
    console.error(JSON.stringify({ event: "strategy_arm_relay_denied", outcome: r.outcome, reason: r.reason ?? null, items: items.length }));
    await writeCursor(env, { ...next, sent_ms: now, denied: r.reason ?? r.outcome });
    return { status: "denied", reason: r.reason ?? null, retry: false };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
