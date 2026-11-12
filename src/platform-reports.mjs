// Cryptophys Platform reports (RFC_INDICATOR_AGENT_PLATFORM P4).
//
// The AI Worker hosts 21 agents that are registered in the platform AI Kernel
// (`host_worker = "xauusd-ai-trading-assistant"`). It reaches the kernel over one
// RPC Service Binding (`AGENTS` → cryptophys-ai-kernel `AgentRpc`, no secret: the
// caller identity is pinned in the binding props). This module publishes one
// advisory report per meaningful event:
//   - xauusd-reasoner: every new H1 chain decision (warning on a BUY<->SELL flip);
//   - xauusd-moderator: the War Room conclusion when its stance changes, otherwise at
//     most once an hour;
//   - hud-*: one report per HUD agent per 15-minute sweep at most (the kernel allows 4 an hour), over
//     the 15m War Room and the 1H, 4H and 1D rooms: when a stance moves into or out of BUY/SELL or the
//     directional bias flips (BULLISH<->BEARISH) on any timeframe, otherwise a heartbeat with the
//     agent's reading on every timeframe when it has published nothing for 6 hours.
//
// Rules (platform contract, docs/SSOT.md §2):
//   - Advisory observations only: no order wording, no size, no lots, no levels.
//   - A denial (`{ outcome: "denied", reason }`: rate_limited, agents_disabled,
//     agent_suspended, capability_not_granted, …) or a kernel-side rejection
//     (`outcome: "failed"`) is data, never retried: the cursor advances and the
//     outcome is recorded. A transport failure or a
//     timeout leaves the cursor, so the next sweep (15 minutes later) tries once more.
//   - Never fatal: the XAUUSD chain runs whether the kernel is up or not.
//   - `critical` is never used here; it opens a GitHub issue on the platform.

import { readWarRoom } from "./war-room.mjs";
import { HUD_NAMES } from "./hud-reading.mjs";

export const PLATFORM_HOST_WORKER = "xauusd-ai-trading-assistant";
export const PLATFORM_CALL_TIMEOUT_MS = 5000;
export const PLATFORM_REPORT_TIMEOUT_MS = 15000;
export const HUD_HEARTBEAT_MS = 6 * 3_600_000;
export const MODERATOR_HEARTBEAT_MS = 55 * 60_000;
const SYMBOL = "OANDA:XAUUSD";
const DIRECTIONAL = new Set(["BUY", "SELL"]);

/** War Room HUD agent id → platform agent id (migration 0016 on the platform; the four dismantled HUD agents were deleted by 0047 on 2026-11-11). */
export const HUD_PLATFORM_IDS = Object.freeze({
  prophet: "hud-prophet",
  trade_management: "hud-trade-management",
  interstellar_eyes: "hud-interstellar-eyes",
  kinetic_engine: "hud-kinetic-engine-tva",
  fabio_amt: "hud-fabio-amt-sensors",
  chronos_matrix: "hud-chronos-matrix",
  aegis_footprint: "hud-aegis-footprint-matrix",
  tactical_muscles: "hud-tactical-muscles",
  macro_aether: "hud-macro-aether-sensors",
  decision_matrix: "hud-decision-matrix"
});

export const PUBLICATIONS_SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS platform_publications (agent_id TEXT PRIMARY KEY, last_key TEXT, last_stance TEXT, published_at TEXT, outcome TEXT, reason TEXT, report_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)";

export const HUD_CURSORS_SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS platform_hud_cursors (agent_id TEXT NOT NULL, timeframe TEXT NOT NULL, last_key TEXT, last_stance TEXT, last_bias TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, timeframe))";

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(PUBLICATIONS_SCHEMA_SQL).run();
  await db.prepare(HUD_CURSORS_SCHEMA_SQL).run();
  schemaReady = true;
}
export function resetPlatformSchemaCacheForTests() { schemaReady = false; }

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const clip = (s, n) => (typeof s === "string" ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : null);
const conf = (x) => (finite(x) ? Math.round(x * 100) / 100 : null);
const hhmm = (iso) => (typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso)).toISOString().slice(11, 16) + " UTC" : "");

export function platformEnabled(env) {
  return typeof env?.AGENTS?.syscall === "function";
}

/** H1 candle key "OANDA:XAUUSD:60:<openMs>" → ISO open time, or null. */
function candleOpenIso(candleKey) {
  const ms = Number(String(candleKey || "").split(":").at(-1));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Sends one report and resolves to `{ outcome, reason?, report_id? }`. Never throws.
 * `success`; `denied` and `rejected` are final (the cursor advances); `failed` means a
 * transport error or a timeout, retried once by the next sweep.
 */
export async function publishToPlatform(env, agentId, report, { timeoutMs = PLATFORM_REPORT_TIMEOUT_MS } = {}) {
  if (!platformEnabled(env)) return { outcome: "disabled" };
  let timer;
  try {
    const result = await Promise.race([
      env.AGENTS.syscall(agentId, "reports.publish", report),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })
    ]);
    // The kernel answers `succeeded`, `denied` (policy, rate limit, kill switch, suspension)
    // or `failed` (the kernel rejected the report itself, e.g. an invalid body).
    if (result?.outcome === "succeeded" || result?.outcome === "success") {
      // Kernel shape: { outcome: "succeeded", result: { report: { report_id, … } } }.
      const reportId = result?.result?.report?.report_id ?? result?.result?.report_id ?? null;
      return { outcome: "success", report_id: typeof reportId === "string" ? reportId : null };
    }
    const reason = typeof result?.reason === "string" ? result.reason.slice(0, 200) : typeof result?.error === "string" ? result.error : "unknown";
    const outcome = result?.outcome === "failed" ? "rejected" : "denied";
    console.warn(JSON.stringify({ event: "platform_report_" + outcome, agent_id: agentId, reason }));
    return { outcome, reason };
  } catch (error) {
    const reason = error instanceof Error && error.message === "timeout" ? "timeout" : "rpc_failed";
    console.warn(JSON.stringify({ event: "platform_report_failed", agent_id: agentId, reason }));
    return { outcome: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}

async function cursors(db) {
  const rows = (await db.prepare("SELECT agent_id, last_key, last_stance, published_at, outcome, reason, report_id, attempts, updated_at FROM platform_publications").all()).results || [];
  return new Map(rows.map((r) => [r.agent_id, r]));
}

async function record(db, agentId, { key, stance, outcome, reason = null, reportId = null, advance, nowIso }) {
  if (advance) {
    await db.prepare(
      "INSERT INTO platform_publications (agent_id, last_key, last_stance, published_at, outcome, reason, report_id, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) " +
      "ON CONFLICT(agent_id) DO UPDATE SET last_key = excluded.last_key, last_stance = excluded.last_stance, published_at = excluded.published_at, outcome = excluded.outcome, reason = excluded.reason, report_id = excluded.report_id, attempts = platform_publications.attempts + 1, updated_at = excluded.updated_at"
    ).bind(agentId, key, stance, nowIso, outcome, reason, reportId, nowIso).run();
  } else {
    await db.prepare(
      "INSERT INTO platform_publications (agent_id, outcome, reason, attempts, updated_at) VALUES (?, ?, ?, 1, ?) " +
      "ON CONFLICT(agent_id) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason, attempts = platform_publications.attempts + 1, updated_at = excluded.updated_at"
    ).bind(agentId, outcome, reason, nowIso).run();
  }
}


// ------------------------------------------------------------------ report builders (pure)

export function reasonerReport(decision, previous) {
  const stance = String(decision.decision || "").toUpperCase();
  const prev = previous?.last_stance ? String(previous.last_stance).toUpperCase() : null;
  const flip = DIRECTIONAL.has(stance) && DIRECTIONAL.has(prev ?? "") && stance !== prev;
  const open = candleOpenIso(decision.candle_key);
  return {
    kind: "xauusd_digest",
    severity: flip ? "warning" : "info",
    subject: clip(`H1 decision ${stance}, confidence ${conf(decision.confidence) ?? "n/a"} (${SYMBOL} H1 candle ${hhmm(open)})${flip ? `, flipped from ${prev}` : ""}`, 200),
    ai_status: "deterministic",
    body: {
      observation: "H1 chain decision (Analyst, Counselor, Reasoner) on a closed candle",
      symbol: SYMBOL,
      timeframe: "60",
      candle_key: decision.candle_key,
      candle_open: open,
      decision: stance,
      confidence: conf(decision.confidence),
      previous_decision: prev,
      flip,
      decided_at: decision.created_at ?? null,
      source: PLATFORM_HOST_WORKER
    }
  };
}

export function moderatorReport(room, previous) {
  const c = room.conclusion;
  const stance = String(c.stance || "").toUpperCase();
  const prev = previous?.last_stance ? String(previous.last_stance).toUpperCase() : null;
  const flip = DIRECTIONAL.has(stance) && DIRECTIONAL.has(prev ?? "") && stance !== prev;
  return {
    kind: "xauusd_digest",
    severity: flip ? "warning" : "info",
    subject: clip(`War Room 15m conclusion ${stance}, confidence ${conf(c.confidence) ?? "n/a"} (${SYMBOL} 15m bar ${hhmm(room.bar_time)}), H1 decision ${room.h1?.decision ?? "n/a"}`, 200),
    ai_status: "deterministic",
    body: {
      observation: "Live War Room 15m moderator conclusion",
      symbol: SYMBOL,
      timeframe: "15",
      bar_close: room.bar_time,
      conclusion: stance,
      confidence: conf(c.confidence),
      previous_conclusion: prev,
      flip,
      h1_decision: room.h1?.decision ?? null,
      majority: c.majority ?? null,
      dissent: (c.dissent || []).map((d) => d?.id ?? d).slice(0, 20),
      summary: clip(c.summary, 1200),
      reasons: (c.reasons || []).slice(0, 4).map((r) => clip(r, 400)),
      confirmations: room.confirmations ?? null,
      participants: (room.openings || []).length,
      source: PLATFORM_HOST_WORKER
    }
  };
}

export function hudTimeframeChange(cursor, opening) {
  if (!cursor || !opening || opening.status !== "ok" || !opening.stance) return null;
  const stance = String(opening.stance).toUpperCase();
  const lastStance = cursor.last_stance ? String(cursor.last_stance).toUpperCase() : null;
  if (hudChangeMatters(lastStance, stance)) return { kind: "stance" };
  const bias = String(opening.bias || "").toUpperCase();
  const lastBias = cursor.last_bias ? String(cursor.last_bias).toUpperCase() : null;
  if ((bias === "BULLISH" || bias === "BEARISH") && (lastBias === "BULLISH" || lastBias === "BEARISH") && bias !== lastBias) return { kind: "bias" };
  return null;
}

const HUD_TF_ORDER = ["15", "60", "240", "1D"];
const HUD_TF_LABEL = { "15": "15m", "60": "1H", "240": "4H", "1D": "1D" };

export function hudDigestReport(agentName, event, timeframes, calibration) {
  const ev = String(event || "");
  const ordered = [...(Array.isArray(timeframes) ? timeframes : [])].sort((a, b) => HUD_TF_ORDER.indexOf(String(a?.timeframe)) - HUD_TF_ORDER.indexOf(String(b?.timeframe)));
  const bodyTfs = ordered.map((t) => ({
    timeframe: t?.timeframe,
    bar_close: t?.bar_close ?? t?.bar_key ?? null,
    stance: t?.stance != null ? String(t.stance).toUpperCase() : null,
    previous_stance: t?.previous_stance != null ? String(t.previous_stance).toUpperCase() : null,
    bias: t?.bias != null ? String(t.bias).toUpperCase() : null,
    previous_bias: t?.previous_bias != null ? String(t.previous_bias).toUpperCase() : null,
    confidence: conf(t?.confidence),
    changed: !!t?.changed,
    change_kind: t?.change_kind ?? null,
    claim: clip(t?.claim, 300)
  }));
  let subject;
  if (ev === "change") {
    const parts = ordered
      .filter((t) => t?.changed)
      .map((t) => {
        const label = HUD_TF_LABEL[String(t?.timeframe)] || String(t?.timeframe);
        if (t?.change_kind === "bias") return `${label} bias ${String(t.previous_bias).toUpperCase()} to ${String(t.bias).toUpperCase()}`;
        return `${label} stance ${String(t.previous_stance).toUpperCase()} to ${String(t.stance).toUpperCase()}`;
      });
    subject = clip(`${agentName}: ${parts.join("; ")} (${SYMBOL})`, 200);
  } else {
    const parts = ordered.map((t) => {
      const label = HUD_TF_LABEL[String(t?.timeframe)] || String(t?.timeframe);
      return `${label} ${String(t?.stance).toUpperCase()}/${String(t?.bias || "").toLowerCase()}`;
    });
    subject = clip(`${agentName} reading: ${parts.join(", ")} (${SYMBOL})`, 200);
  }
  return {
    kind: "hud_digest",
    severity: "info",
    subject,
    ai_status: "deterministic",
    body: {
      observation: ev === "change" ? "HUD agent change across timeframes" : "HUD agent reading across timeframes",
      symbol: SYMBOL,
      event: ev,
      hud_agent: agentName,
      timeframes: bodyTfs,
      calibration: calibration ?? null,
      source: PLATFORM_HOST_WORKER
    }
  };
}

/** True when a HUD stance change matters: it moves into or out of BUY/SELL. */
export function hudChangeMatters(previous, next) {
  if (!previous || !next || previous === next) return false;
  return DIRECTIONAL.has(previous) || DIRECTIONAL.has(next);
}

// ------------------------------------------------------------------ sweep


export async function readTimeframeOpenings(db) {
  const out = { "60": null, "240": null, "1D": null };
  const threads = { "60": "tf:H1", "240": "tf:H4", "1D": "tf:D1" };
  for (const [tf, threadId] of Object.entries(threads)) {
    try {
      const maxRow = await db.prepare("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id = ?").bind(threadId).first();
      const runId = maxRow?.r;
      if (runId == null) { out[tf] = null; continue; }
      const rows = (await db.prepare("SELECT agent, status, stance, confidence, json_extract(body_json, '$.bias') AS bias, json_extract(body_json, '$.claim') AS claim FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? AND step LIKE 'open:%'").bind(threadId, runId).all()).results || [];
      out[tf] = { bar_key: runId, openings: rows.map((r) => ({ id: r.agent, status: r.status, stance: r.stance, bias: r.bias, confidence: r.confidence, claim: r.claim })) };
    } catch {
      out[tf] = null;
    }
  }
  return out;
}

async function send(env, db, agentId, key, stance, report, nowIso, summary) {
  const res = await publishToPlatform(env, agentId, report);
  const advance = res.outcome !== "failed"; // only a transport failure or timeout is retried
  await record(db, agentId, { key, stance, outcome: res.outcome, reason: res.reason ?? null, reportId: res.report_id ?? null, advance, nowIso });
  summary.published.push({ agent_id: agentId, outcome: res.outcome, ...(res.reason ? { reason: res.reason } : {}) });
}

/**
 * Publishes every pending event once. Called from the parity sweep cron (every 15
 * minutes). Returns a summary; never throws for a platform-side problem.
 */
export async function publishPlatformReports(env, { now = Date.now(), readRoom = readWarRoom, readTimeframes = readTimeframeOpenings } = {}) {
  if (!platformEnabled(env)) return { status: "disabled" };
  if (!env?.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  const nowIso = new Date(now).toISOString();
  const state = await cursors(env.DB);
  const summary = { status: "ok", published: [] };

  // 1. H1 chain decision → xauusd-reasoner.
  const decision = await env.DB.prepare("SELECT candle_key, decision, confidence, created_at FROM trade_decisions ORDER BY id DESC LIMIT 1").first().catch(() => null);
  if (decision?.candle_key && decision.decision) {
    const prev = state.get("xauusd-reasoner");
    if (prev?.last_key !== decision.candle_key) {
      await send(env, env.DB, "xauusd-reasoner", decision.candle_key, String(decision.decision).toUpperCase(), reasonerReport(decision, prev), nowIso, summary);
    }
  }

  // 2. War Room conclusion → xauusd-moderator.
  let room = null;
  try { room = await readRoom(env.DB); } catch { room = null; }
  if (room?.conclusion?.status === "ok" && room.conclusion.stance) {
    const stance = String(room.conclusion.stance).toUpperCase();
    const prev = state.get("xauusd-moderator");
    const lastMs = Date.parse(prev?.published_at || "");
    const changed = prev?.last_stance !== stance;
    const due = !Number.isFinite(lastMs) || now - lastMs >= MODERATOR_HEARTBEAT_MS;
    if (prev?.last_key !== room.bar_time && (changed || due)) {
      await send(env, env.DB, "xauusd-moderator", room.bar_time, stance, moderatorReport(room, prev), nowIso, summary);
    }
  }

  // 3. HUD agents (owner 2026-11-12: "seharusnya tidak idle dan berkontribusi ke semua TimeFrame"): one
  //    report per agent per sweep at most, over the 15m War Room and the 1H, 4H and 1D rooms.
  let rooms = {};
  try { rooms = (await readTimeframes(env.DB)) || {}; } catch { rooms = {}; }
  if (room?.bar_time) rooms = { ...rooms, "15": { bar_key: room.bar_time, openings: room.openings || [] } };
  const cursorRows = (await env.DB.prepare("SELECT agent_id, timeframe, last_key, last_stance, last_bias, created_at FROM platform_hud_cursors").all()).results || [];
  const cursorsOf = new Map();
  for (const r of cursorRows) { if (!cursorsOf.has(r.agent_id)) cursorsOf.set(r.agent_id, new Map()); cursorsOf.get(r.agent_id).set(r.timeframe, r); }
  const calibration = new Map((room?.roster || []).map((r) => [r.id, r.calibration]));

  for (const [hudId, agentId] of Object.entries(HUD_PLATFORM_IDS)) {
    const cursors = cursorsOf.get(agentId) ?? new Map();
    const observed = [];
    for (const tf of HUD_TF_ORDER) {
      const rm = rooms[tf];
      const opening = rm?.bar_key && Array.isArray(rm.openings) ? rm.openings.find((o) => o?.id === hudId) : null;
      if (!opening || opening.status !== "ok" || !opening.stance) continue;
      const cursor = cursors.get(tf) ?? null;
      const fresh = cursor?.last_key !== rm.bar_key;
      const change = fresh ? hudTimeframeChange(cursor, opening) : null;
      observed.push({ tf, key: rm.bar_key, opening, cursor, fresh, change });
    }
    if (!observed.length) continue;

    // Heartbeat reference: the last publication, else when the agent was first observed (this sweep included).
    const created = [...cursors.values()].map((c) => c.created_at).filter(Boolean).sort()[0] ?? "";
    const refMs = Date.parse(state.get(agentId)?.published_at || created);
    const changed = observed.filter((o) => o.change);
    const heartbeatDue = cursors.size > 0 && Number.isFinite(refMs) && now - refMs >= HUD_HEARTBEAT_MS;
    const event = changed.length ? "change" : heartbeatDue ? "heartbeat" : null;

    let advance = true;
    if (event) {
      const timeframes = observed.map((o) => ({
        timeframe: o.tf, bar_close: o.key, stance: o.opening.stance, previous_stance: o.cursor?.last_stance ?? null,
        bias: o.opening.bias ?? null, previous_bias: o.cursor?.last_bias ?? null, confidence: o.opening.confidence,
        changed: Boolean(o.change), change_kind: o.change?.kind ?? null, claim: o.opening.claim ?? null
      }));
      const report = hudDigestReport(HUD_NAMES[hudId] ?? hudId, event, timeframes, calibration.get(hudId) ?? null);
      const o15 = observed.find((o) => o.tf === "15");
      const newest = observed.map((o) => o.key).sort().at(-1);
      const before = summary.published.length;
      await send(env, env.DB, agentId, newest, o15 ? String(o15.opening.stance).toUpperCase() : null, report, nowIso, summary);
      advance = summary.published[before]?.outcome !== "failed"; // a transport failure or timeout is retried next sweep
    }
    if (!advance) continue;
    for (const o of observed) {
      if (!o.fresh) continue;
      const bias = String(o.opening.bias || "").toUpperCase();
      const lastBias = bias === "BULLISH" || bias === "BEARISH" ? bias : (o.cursor?.last_bias ?? null);
      await env.DB.prepare(
        "INSERT INTO platform_hud_cursors (agent_id, timeframe, last_key, last_stance, last_bias, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(agent_id, timeframe) DO UPDATE SET last_key = excluded.last_key, last_stance = excluded.last_stance, last_bias = excluded.last_bias, updated_at = excluded.updated_at"
      ).bind(agentId, o.tf, o.key, String(o.opening.stance).toUpperCase(), lastBias, nowIso, nowIso).run();
    }
  }
  return summary;
}

/** Read model for GET /api/platform/status. `whoami` is one read on the kernel. */
const WHOAMI_CACHE_MS = 5 * 60_000;
let whoamiCache = null; // { at, value }: one kernel read per isolate per 5 minutes
export function resetWhoamiCacheForTests() { whoamiCache = null; }

export async function platformStatus(env, { now = Date.now() } = {}) {
  if (!platformEnabled(env)) return { enabled: false };
  let whoami = whoamiCache && now - whoamiCache.at < WHOAMI_CACHE_MS ? whoamiCache.value : null;
  if (!whoami) try {
    let timer;
    whoami = await Promise.race([
      env.AGENTS.whoami("xauusd-moderator"),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), PLATFORM_CALL_TIMEOUT_MS); })
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    whoami = { error: error instanceof Error && error.message === "timeout" ? "timeout" : "rpc_failed" };
  }
  if (whoami && !whoami.error) whoamiCache = { at: now, value: whoami };
  let publications = [];
  if (env?.DB) {
    try {
      await ensureSchema(env.DB);
      publications = (await env.DB.prepare("SELECT agent_id, last_key, last_stance, published_at, outcome, reason, report_id, attempts, updated_at FROM platform_publications ORDER BY updated_at DESC").all()).results || [];
    } catch { publications = []; }
  }
  const pick = whoami && typeof whoami === "object" && !whoami.error
    ? { agent_id: whoami.agent_id, status: whoami.status, tier_max: whoami.tier_max, host_worker: whoami.host_worker, capabilities: Array.isArray(whoami.capabilities) ? whoami.capabilities.map((c) => c?.capability ?? c) : [] }
    : whoami;
  return { enabled: true, whoami: pick, publications };
}
