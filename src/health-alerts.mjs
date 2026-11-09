// Health alerts (gap 2, owner decision 2026-11-06): the system watches itself.
//
// Every parity sweep (15 minutes) the detectors below look for operational problems that so far
// were found only by a manual check: a revoked parity identity, a local input bar that differs
// from TradingView's final bar, a missing local H1 record, a timeframe room that did not
// conclude, model calls lost to the Workers AI rate limit, a stale News Daily or a stale War
// Room. Each problem is an alert row (D1 `health_alerts`): it opens once, stays open while the
// problem holds, and resolves when it is gone.
//
// Opening an alert sends one `warning` report to the Cryptophys Platform kernel from
// `xauusd-risk-manager` (operational risk); resolving a lasting alert sends one `info` report.
// At most HEALTH_REPORTS_PER_HOUR reports an hour (the kernel allows 4 per agent); the rest wait
// for the next sweep. `critical` is never used here: it opens a GitHub issue on the platform.
// Nexus shows the open alerts as its Priority Queue (GET /api/health/alerts). Read-only towards
// the trading chain: an alert never changes a decision, a room or a parity status.
import { publishToPlatform, platformEnabled } from "./platform-reports.mjs";
import { engineLabel } from "./engine-names.mjs";
import { rejectionSummary, REJECTION_TEXT } from "./webhook-rejections.mjs";

export const HEALTH_AGENT_ID = "xauusd-risk-manager";
export const HEALTH_REPORTS_PER_HOUR = 3;
const HOUR = 3600_000;

export const HEALTH_SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS health_alerts (alert_key TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT, one_shot INTEGER NOT NULL DEFAULT 0, opened_at TEXT NOT NULL, resolved_at TEXT, reported_open_at TEXT, reported_resolved_at TEXT, report_outcome TEXT, updated_at TEXT NOT NULL)";

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(HEALTH_SCHEMA_SQL).run();
  schemaReady = true;
}
export function resetHealthSchemaCacheForTests() { schemaReady = false; }

const iso = (ms) => new Date(ms).toISOString();
const hhmm = (ms) => iso(ms).slice(11, 16) + " UTC";
/** "23:00 UTC" within the last 12 hours, "2026-11-06 22:00 UTC" before that. */
const whenUtc = (ms, now) => (now - ms < 12 * HOUR ? hhmm(ms) : iso(ms).slice(0, 16).replace("T", " ") + " UTC");
/** The open of the first bar after the last pause longer than 2 hours (a weekend or a holiday), or -Infinity. */
function sessionStartMs(bars) {
  for (let i = bars.length - 1; i > 0; i--) {
    const open = Date.parse(bars[i].open_time ?? ""), prevClose = Date.parse(bars[i - 1].close_time ?? "");
    if (Number.isFinite(open) && Number.isFinite(prevClose) && open - prevClose > 2 * HOUR) return open;
  }
  return -Infinity;
}
/** The open time of a candle key ("OANDA:XAUUSD:15:<open ms>") as "2026-11-09 01:15 UTC". */
function barOf(candleKey) {
  const ms = Number(String(candleKey).split(":").at(-1));
  return Number.isFinite(ms) && ms > 0 ? `bar opened ${iso(ms).slice(0, 16).replace("T", " ")} UTC` : String(candleKey);
}
/** The timeframe room names of SSOT ("the 1H War Room"). */
const ROOM_NAMES = Object.freeze({ H1: "1H", H4: "4H", D1: "D1" });

async function rows(db, sql, ...params) {
  try { return (await db.prepare(sql).bind(...params).all()).results || []; } catch { return []; }
}
async function seriesCandles(env, key) {
  try { const r = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:" + key)) || "null"); return Array.isArray(r?.candles) ? r.candles : []; } catch { return []; }
}

/** The problems that hold now: [{ key, kind, subject, detail, one_shot? }]. Never throws. */
export async function detectHealthIssues(env, now = Date.now()) {
  const db = env.DB;
  const out = [];

  // 1. Parity identities revoked (latest identity per engine, changed in the last 7 days).
  const registry = await rows(db, "SELECT engine, status, consecutive_matches, revoked_at, updated_at FROM engine_parity_registry WHERE updated_at >= ? ORDER BY updated_at DESC", iso(now - 7 * 24 * HOUR));
  const latest = new Map();
  for (const r of registry) if (!latest.has(r.engine)) latest.set(r.engine, r);
  for (const r of latest.values()) {
    if (r.status !== "revoked") continue;
    out.push({ key: `parity_revoked:${r.engine}`, kind: "parity_revoked", subject: `Parity revoked: ${engineLabel(r.engine)}, ${r.consecutive_matches} of 24 matches toward re-approval`, detail: { engine: r.engine, revoked_at: r.revoked_at, consecutive_matches: r.consecutive_matches } });
  }

  // 2. Local input bars that differ from TradingView's final bar (one alert per candle).
  for (const r of await rows(db, "SELECT engine, candle_key, detail, compared_at FROM engine_parity_comparisons WHERE result = 'input_mismatch' AND compared_at >= ?", iso(now - 3 * HOUR))) {
    let fields = [];
    try { fields = [...new Set((JSON.parse(r.detail)?.mismatches || []).map((m) => m.field))]; } catch { fields = []; }
    out.push({ key: `input_mismatch:${r.engine}:${r.candle_key}`, kind: "input_mismatch", one_shot: true, subject: `Local input bar differs from TradingView: ${engineLabel(r.engine)}, ${barOf(r.candle_key)} (${fields.join(", ") || "bar"}); waiting for the republish`, detail: { engine: r.engine, candle_key: r.candle_key, fields } });
  }

  // 3. The latest closed H1 bar is cached but has no local record (pipeline stalled).
  const h1 = (await seriesCandles(env, "OANDA:XAUUSD|1h")).filter((c) => Date.parse(c.close_time) <= now - 25 * 60_000).at(-1);
  if (h1 && now - Date.parse(h1.close_time) < 3 * HOUR) {
    const key = "OANDA:XAUUSD:60:" + Date.parse(h1.open_time);
    let observed = null;
    try { observed = await env.WEBHOOK_BUFFER?.get?.("localcalc-observed:" + key + ":prophet"); } catch { observed = "unknown"; }
    if (!observed) out.push({ key: `h1_local_missing:${key}`, kind: "h1_local_missing", subject: `No local 1H record for the bar closed ${hhmm(Date.parse(h1.close_time))}: the H1 chain waits for the backup path`, detail: { candle_key: key } });
  }

  // 4. Timeframe rooms that did not conclude 45 minutes after their bar closed.
  if (String(env.TF_THREADS_ENABLED || "").toLowerCase() === "true") {
    for (const [chart, series] of [["H1", "1h"], ["H4", "4h"], ["D1", "1D"]]) {
      const bar = (await seriesCandles(env, "OANDA:XAUUSD|" + series)).filter((c) => Date.parse(c.close_time) <= now - 45 * 60_000).at(-1);
      if (!bar || now - Date.parse(bar.close_time) > 6 * HOUR) continue;
      const done = await rows(db, "SELECT 1 FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? AND step = 'conclusion' AND status = 'ok' LIMIT 1", `tf:${chart}`, bar.open_time);
      if (!done.length) out.push({ key: `room_unconcluded:${chart}:${bar.open_time}`, kind: "room_unconcluded", subject: `The ${ROOM_NAMES[chart]} War Room has no conclusion for the bar closed ${hhmm(Date.parse(bar.close_time))}`, detail: { chart, bar_open: bar.open_time } });
    }
  }

  // 5. Model calls lost to the Workers AI per-minute limit in the last hour.
  const limited = await rows(db, "SELECT COUNT(*) AS n FROM agent_thread_messages WHERE ts >= ? AND status = 'agent_failed' AND body_json LIKE '%rate limit%'", iso(now - HOUR));
  const n = Number(limited[0]?.n) || 0;
  if (n >= 10) out.push({ key: "model_rate_limited", kind: "model_rate_limited", subject: `${n} agent calls lost to the Workers AI rate limit in the last hour`, detail: { failed_calls: n } });

  // 6. News Daily stale while hourly news analyses keep arriving.
  if (String(env.NEWS_DAILY_ENABLED || "").toLowerCase() === "true") {
    const [lastDaily] = await rows(db, "SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id LIKE 'newsdaily:%' AND step = 'brief'");
    const [lastNews] = await rows(db, "SELECT MAX(analyzed_at) AS a FROM news_analyses");
    const dailyMs = Date.parse(lastDaily?.r ?? ""), newsMs = Date.parse(lastNews?.a ?? "");
    if (Number.isFinite(newsMs) && now - newsMs < 3 * HOUR && (!Number.isFinite(dailyMs) || now - dailyMs > 3 * HOUR)) {
      out.push({ key: "news_daily_stale", kind: "news_daily_stale", subject: `News Daily has not run since ${Number.isFinite(dailyMs) ? hhmm(dailyMs) : "it was enabled"} while hourly news keeps arriving`, detail: { last_run: lastDaily?.r ?? null, last_news: lastNews?.a ?? null } });
    }
  }

  // 7. The Live War Room 15m stopped while 5m bars keep closing.
  if (String(env.WAR_ROOM_ENABLED || "").toLowerCase() === "true") {
    const m5Bars = await seriesCandles(env, "OANDA:XAUUSD|5m");
    const m5 = m5Bars.at(-1);
    const [room] = await rows(db, "SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id LIKE 'warroom:%'");
    const roomMs = Date.parse(room?.r ?? "");
    // After a market gap the room cannot have met before the first bars of the new session: the
    // 45 minutes count from the session's first 5m bar (production 2026-11-08 23:12, twelve minutes
    // after the reopen, read "has not met since 22:00 UTC", which was Friday).
    const since = Math.max(Number.isFinite(roomMs) ? roomMs : -Infinity, sessionStartMs(m5Bars));
    if (m5 && now - Date.parse(m5.close_time) < 20 * 60_000 && (!Number.isFinite(since) || now - since > 45 * 60_000)) {
      out.push({ key: "war_room_stale", kind: "war_room_stale", subject: `The Live War Room 15m has not met since ${Number.isFinite(roomMs) ? whenUtc(roomMs, now) : "it was enabled"} while 5m bars keep closing`, detail: { last_room: room?.r ?? null, last_m5_close: m5.close_time } });
    }
  }

  // 8. TradingView alerts rejected by POST /webhook (401) in the last hour: the reason, never the secret.
  const rej = await rejectionSummary(db, now - HOUR);
  if (rej.count > 0) {
    const top = [rej.top_reason];
    const lengths = top[0] === "secret_missing" ? "" : `; secret length received ${rej.received_lengths.join("/")}, the Worker's ${rej.expected_len}`;
    out.push({
      key: "webhook_rejected", kind: "webhook_rejected",
      subject: `TradingView webhook rejected (401): ${rej.count} alert${rej.count === 1 ? "" : "s"} since ${hhmm(Date.parse(rej.first_at))} (${rej.sources.join(", ") || "unknown source"}): ${REJECTION_TEXT[top[0]] || top[0]}${lengths}`,
      detail: rej
    });
  }
  return out;
}

function report(alert, state) {
  const opening = state === "open";
  return {
    kind: "xauusd_digest",
    severity: opening ? "warning" : "info",
    subject: (opening ? "" : "Resolved: ") + alert.subject.slice(0, opening ? 200 : 190),
    ai_status: "deterministic",
    body: { observation: "XAUUSD system health check (advisory platform, no trading action)", alert_key: alert.alert_key ?? alert.key, alert_kind: alert.kind, state, detail: alert.detail ?? null, source: "xauusd-ai-trading-assistant" }
  };
}

/**
 * Opens new alerts, resolves those that no longer hold, and reports state changes to the
 * platform within the hourly report budget. Returns a summary; never throws for a platform-side
 * problem.
 */
export async function runHealthAlerts(env, { now = Date.now(), detect = detectHealthIssues } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureSchema(db);
  const nowIso = iso(now);
  const active = await detect(env, now);
  const activeKeys = new Set(active.map((a) => a.key));
  const open = await rows(db, "SELECT * FROM health_alerts WHERE status = 'open'");
  const openKeys = new Set(open.map((r) => r.alert_key));
  let opened = 0, resolved = 0;

  for (const a of active) {
    if (openKeys.has(a.key)) {
      await db.prepare("UPDATE health_alerts SET subject = ?, detail = ?, updated_at = ? WHERE alert_key = ?").bind(a.subject, JSON.stringify(a.detail ?? null), nowIso, a.key).run();
      continue;
    }
    // A one-shot alert (one candle) opens once; it never reopens after it resolved.
    const prior = await rows(db, "SELECT status FROM health_alerts WHERE alert_key = ?", a.key);
    if (prior.length && a.one_shot) continue;
    await db.prepare(
      "INSERT INTO health_alerts (alert_key, kind, status, subject, detail, one_shot, opened_at, updated_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?) " +
      "ON CONFLICT(alert_key) DO UPDATE SET status = 'open', subject = excluded.subject, detail = excluded.detail, opened_at = excluded.opened_at, resolved_at = NULL, reported_open_at = NULL, reported_resolved_at = NULL, report_outcome = NULL, updated_at = excluded.updated_at"
    ).bind(a.key, a.kind, a.subject, JSON.stringify(a.detail ?? null), a.one_shot ? 1 : 0, nowIso, nowIso).run();
    opened += 1;
  }
  for (const r of open) {
    if (activeKeys.has(r.alert_key)) continue;
    await db.prepare("UPDATE health_alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE alert_key = ?").bind(nowIso, nowIso, r.alert_key).run();
    resolved += 1;
  }

  // Reports: openings first (oldest first), then resolutions of lasting alerts.
  const sentLastHour = await rows(db, "SELECT COUNT(*) AS n FROM health_alerts WHERE reported_open_at >= ? OR reported_resolved_at >= ?", iso(now - HOUR), iso(now - HOUR));
  let budget = HEALTH_REPORTS_PER_HOUR - (Number(sentLastHour[0]?.n) || 0);
  const published = [];
  if (platformEnabled(env)) {
    const pendingOpen = await rows(db, "SELECT * FROM health_alerts WHERE status = 'open' AND reported_open_at IS NULL ORDER BY opened_at");
    const pendingResolved = await rows(db, "SELECT * FROM health_alerts WHERE status = 'resolved' AND reported_open_at IS NOT NULL AND reported_resolved_at IS NULL AND one_shot = 0 ORDER BY resolved_at");
    for (const [r, state] of [...pendingOpen.map((r) => [r, "open"]), ...pendingResolved.map((r) => [r, "resolved"])]) {
      if (budget <= 0) break;
      const alert = { ...r, detail: (() => { try { return JSON.parse(r.detail); } catch { return null; } })() };
      const res = await publishToPlatform(env, HEALTH_AGENT_ID, report(alert, state));
      if (res.outcome === "failed") break; // transport error or timeout: the next sweep tries again
      // A denial or rejection is final (no retry loop): the alert is marked as reported.
      const col = state === "open" ? "reported_open_at" : "reported_resolved_at";
      await db.prepare(`UPDATE health_alerts SET ${col} = ?, report_outcome = ?, updated_at = ? WHERE alert_key = ?`).bind(nowIso, res.outcome + (res.reason ? ": " + res.reason : ""), nowIso, r.alert_key).run();
      published.push({ alert_key: r.alert_key, state, outcome: res.outcome });
      budget -= 1;
    }
  }
  return { status: "ok", active: active.length, opened, resolved, published };
}

/** Open alerts and those resolved in the last 24 hours, for the Nexus Priority Queue. */
export async function readHealthAlerts(db, { now = Date.now() } = {}) {
  await ensureSchema(db);
  const parse = (r) => ({ alert_key: r.alert_key, kind: r.kind, status: r.status, subject: r.subject, opened_at: r.opened_at, resolved_at: r.resolved_at, reported: r.reported_open_at ? (r.report_outcome || "reported") : null });
  const open = (await rows(db, "SELECT * FROM health_alerts WHERE status = 'open' ORDER BY opened_at DESC")).map(parse);
  const resolved = (await rows(db, "SELECT * FROM health_alerts WHERE status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 20", iso(now - 24 * HOUR))).map(parse);
  return { open, resolved_24h: resolved };
}
