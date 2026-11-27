// EA health to the Cryptophys-Cerebrum Telegram, through the platform kernel (owner 2026-11-16: "info terkait
// HeartBeat EA di Telegram jangan masuk ke Cryptophys-Nexus, tapi ke Cryptophys-Cerebrum"; "pakai cara 2 lewat
// kernel"; "pindahkan yang nomor 1 saja": only the Cerebrum Self-Healing Action moves).
//
// The self-healing step (src/omega-broker.mjs) records each recovery it dispatches in omega_events
// (actor "agent:cerebrum", action "autonomous_recovery") and no longer sends it to the Nexus chat. This relay
// reads the recoveries since its cursor and publishes them as one kernel report (reports.publish, kind
// xauusd_digest, body.telegram_topic "ea_heartbeat"); the kernel forwards it to every alert channel subscribed to
// that topic ("Cerebrum alerts"), at its next tick. Platform contract: docs/XAUUSD-INTEGRATION.md §6 there.
//
// The kernel allows 4 reports an hour per agent and the relay shares xauusd-risk-manager's budget with the health
// alerts (up to 3 an hour), so it sends at most one report per RELAY_MIN_GAP_MS, with every recovery since the last
// one; after a refusal it waits RELAY_RETRY_MS. Recoveries older than RELAY_MAX_AGE_MS are not sent (the kernel drops
// a report older than 2 hours as stale). Nothing is lost: omega_events keeps every recovery. Never throws.
import { publishToPlatform, platformEnabled } from "./platform-reports.mjs";
import { HEALTH_AGENT_ID } from "./health-alerts.mjs";

export const EA_HEARTBEAT_TOPIC = "ea_heartbeat";
export const EA_HEARTBEAT_AGENT = HEALTH_AGENT_ID;
export const RELAY_CURSOR_KEY = "ea_heartbeat:relay";
export const RELAY_MIN_GAP_MS = 30 * 60_000;
export const RELAY_RETRY_MS = 15 * 60_000;
export const RELAY_MAX_AGE_MS = 100 * 60_000;
export const RELAY_MAX_ITEMS = 12;
export const RELAY_TEXT_MAX = 1800;

const DIRECTIVE = { restart_terminal: "Restart the MT5 terminal", remediate_algo_trading: "Turn Algo Trading back on" };
const REASON = {
  terminal_disconnected: "the terminal lost its broker connection",
  chart_frozen_stale_quote: "the chart froze (stale quote)",
  trade_allowed_false: "trading is not allowed in the terminal",
  recent_intent_algo_disabled: "a recent order was refused: Algo Trading is off"
};
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const hhmm = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Pure: one recovery as plain text (no HTML; the kernel sends plain text). */
export function recoveryLine(row) {
  const d = (typeof row.detail === "string" ? parse(row.detail) : row.detail) || {};
  const directive = String(d.directive || "unknown");
  const reason = String(d.reason || "unknown");
  // Feed content staleness (src/feed-stale.mjs): said once per episode (the bridge id and the bar age only).
  if (row.action === "feed_stale") {
    return [`⚠️ Omega data feed · ${hhmm(Number(row.ms))}`, String(d.message || "A feed is syncing but its bars stopped.").slice(0, 300)].join("\n");
  }
  // Wrong server name (src/server-check.mjs): said once per connection version, with the name the owner typed only.
  if (row.action === "server_not_seen") {
    return [
      `⚠️ Omega connection · ${hhmm(Number(row.ms))}`,
      String(d.message || "The terminal has not logged into the server entered.").slice(0, 300)
    ].join("\n");
  }
  // Recovery backoff (src/recovery-hold.mjs): the watchdog stopped restarting; said once, with what to check.
  if (d.status === "held") {
    return [
      `🛑 Cerebrum self-healing held · ${hhmm(Number(row.ms))}`,
      `Action: no more terminal restarts (${Number(d.dispatches) || 0} restarts did not reconnect)`,
      `Reason: ${REASON[reason] || reason}`,
      d.cause === "server_not_seen" && d.message ? String(d.message).slice(0, 300) : "Next: check the server name exactly (spaces, hyphens, case) and enter the connection again on the Omega page; restarts resume on a new connection or once the terminal is healthy again"
    ].join("\n");
  }
  return [
    `🤖 Cerebrum self-healing · ${hhmm(Number(row.ms))}`,
    `Action: ${DIRECTIVE[directive] || directive} (${directive})`,
    `Reason: ${REASON[reason] || reason}`,
    "Status: dispatched to the VPS host bridge"
  ].join("\n");
}

/** Pure: the report for these recoveries (oldest first), the text bounded to RELAY_TEXT_MAX with the newest kept. */
export function relayReport(rows) {
  const blocks = rows.map(recoveryLine);
  let kept = blocks.slice();
  let text = kept.join("\n\n");
  while (kept.length > 1 && text.length > RELAY_TEXT_MAX) { kept = kept.slice(1); text = kept.join("\n\n"); }
  if (kept.length < blocks.length) text = `(${blocks.length - kept.length} earlier action${blocks.length - kept.length === 1 ? "" : "s"} not shown)\n\n` + text;
  text = text.slice(0, RELAY_TEXT_MAX);
  const n = rows.length;
  const held = rows.some((r) => ((typeof r.detail === "string" ? parse(r.detail) : r.detail) || {}).status === "held");
  const notSeen = rows.some((r) => r.action === "server_not_seen");
  const feedStale = rows.some((r) => r.action === "feed_stale");
  return {
    kind: "xauusd_digest",
    severity: "warning",
    subject: held ? "EA self-healing held: terminal restarts stopped" : notSeen ? "Omega connection: the terminal has not logged into the server entered" : feedStale ? "Omega data feed: syncing but its bars stopped" : `EA self-healing: ${n} recovery action${n === 1 ? "" : "s"} dispatched`,
    ai_status: "deterministic",
    body: {
      telegram_topic: EA_HEARTBEAT_TOPIC,
      text,
      observation: "Omega EA terminal health: recovery actions dispatched by the self-healing step (no trading action)",
      actions: rows.map((r) => { const d = (typeof r.detail === "string" ? parse(r.detail) : r.detail) || {}; return { id: Number(r.id), at: new Date(Number(r.ms)).toISOString(), action: r.action ?? "autonomous_recovery", directive: d.directive ?? null, reason: d.reason ?? null, status: d.status ?? null }; }),
      source: "xauusd-ai-trading-assistant"
    }
  };
}

async function readCursor(env) {
  try { return parse(await env.SIGNAL_CACHE?.get?.(RELAY_CURSOR_KEY)) || {}; } catch { return {}; }
}
async function writeCursor(env, cursor) {
  try { await env.SIGNAL_CACHE?.put?.(RELAY_CURSOR_KEY, JSON.stringify(cursor)); } catch { /* the next run sends again; the kernel dedupes nothing, so keep the gap */ }
}

/**
 * Publishes the recoveries since the cursor as one ea_heartbeat report, at most once per RELAY_MIN_GAP_MS.
 * Returns a summary: disabled | unavailable | waiting | idle | sent | denied | rejected | failed.
 */
export async function relayEaHeartbeat(env, { now = Date.now(), publish = publishToPlatform } = {}) {
  if (!platformEnabled(env)) return { status: "disabled" };
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    const cursor = await readCursor(env);
    const lastId = Number(cursor.last_id) || 0;
    if (now - (Number(cursor.sent_ms) || 0) < RELAY_MIN_GAP_MS) return { status: "waiting" };
    if (now - (Number(cursor.refused_ms) || 0) < RELAY_RETRY_MS) return { status: "waiting" };
    const rows = (await db.prepare(
      "SELECT id, ms, action, detail FROM omega_events WHERE action IN ('autonomous_recovery', 'server_not_seen', 'feed_stale') AND actor = 'agent:cerebrum' AND id > ? ORDER BY id DESC LIMIT ?"
    ).bind(lastId, RELAY_MAX_ITEMS + 1).all()).results || [];
    const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), lastId);
    const fresh = rows.filter((r) => now - Number(r.ms) <= RELAY_MAX_AGE_MS).slice(0, RELAY_MAX_ITEMS).reverse();
    if (!fresh.length) {
      if (maxId > lastId) await writeCursor(env, { ...cursor, last_id: maxId });
      return { status: "idle", skipped_stale: rows.length };
    }
    const r = await publish(env, EA_HEARTBEAT_AGENT, relayReport(fresh));
    if (r.outcome === "success") {
      await writeCursor(env, { last_id: maxId, sent_ms: now, report_id: r.report_id ?? null });
      return { status: "sent", count: fresh.length, report_id: r.report_id ?? null };
    }
    if (r.outcome === "failed") return { status: "failed", reason: r.reason };
    await writeCursor(env, { ...cursor, refused_ms: now, reason: r.reason ?? null });
    return { status: r.outcome, reason: r.reason ?? null };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
