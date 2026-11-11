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
//   - hud-*: a HUD agent's War Room stance when it moves into or out of BUY/SELL.
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

export const PLATFORM_HOST_WORKER = "xauusd-ai-trading-assistant";
export const PLATFORM_CALL_TIMEOUT_MS = 5000;
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

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(PUBLICATIONS_SCHEMA_SQL).run();
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
export async function publishToPlatform(env, agentId, report, { timeoutMs = PLATFORM_CALL_TIMEOUT_MS } = {}) {
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

/** Records a baseline without publishing (a HUD agent's first observed stance). */
async function baseline(db, agentId, key, stance, nowIso) {
  await db.prepare(
    "INSERT INTO platform_publications (agent_id, last_key, last_stance, outcome, attempts, updated_at) VALUES (?, ?, ?, 'baseline', 0, ?) ON CONFLICT(agent_id) DO NOTHING"
  ).bind(agentId, key, stance, nowIso).run();
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

export function hudReport(room, opening, previousStance, calibration) {
  const stance = String(opening.stance || "").toUpperCase();
  return {
    kind: "hud_digest",
    severity: "info",
    subject: clip(`${opening.name} moved ${previousStance} to ${stance}, confidence ${conf(opening.confidence) ?? "n/a"} (${SYMBOL} 15m bar ${hhmm(room.bar_time)})`, 200),
    ai_status: "deterministic",
    body: {
      observation: "HUD agent stance change in the Live War Room 15m",
      symbol: SYMBOL,
      timeframe: "15",
      bar_close: room.bar_time,
      hud_agent: opening.id,
      previous_stance: previousStance,
      stance,
      confidence: conf(opening.confidence),
      claim: clip(opening.claim, 600),
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
export async function publishPlatformReports(env, { now = Date.now(), readRoom = readWarRoom } = {}) {
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

  // 2. War Room conclusion → xauusd-moderator; HUD stance changes → hud-*.
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
    const calibration = new Map((room.roster || []).map((r) => [r.id, r.calibration]));
    for (const opening of room.openings || []) {
      const agentId = HUD_PLATFORM_IDS[opening.id];
      if (!agentId || opening.status !== "ok" || !opening.stance) continue;
      const next = String(opening.stance).toUpperCase();
      const prevHud = state.get(agentId);
      if (!prevHud?.last_stance) { await baseline(env.DB, agentId, room.bar_time, next, nowIso); continue; }
      if (prevHud.last_key === room.bar_time) continue;
      if (hudChangeMatters(prevHud.last_stance, next)) {
        await send(env, env.DB, agentId, room.bar_time, next, hudReport(room, opening, prevHud.last_stance, calibration.get(opening.id)), nowIso, summary);
      } else if (prevHud.last_stance !== next) {
        // A non-directional move (e.g. WAIT -> HOLD) updates the baseline silently.
        await env.DB.prepare("UPDATE platform_publications SET last_key = ?, last_stance = ?, updated_at = ? WHERE agent_id = ?").bind(room.bar_time, next, nowIso, agentId).run();
      }
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
