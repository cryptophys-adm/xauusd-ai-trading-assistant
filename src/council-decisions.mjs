// The platform's return path for accepted council proposals (docs/RFC_COUNCIL_PROPOSALS.md, "Return path").
//
// A proposal xauusd hands to the platform (typed_proposal.v1, src/cfc-session.mjs) is worked there: a repository task
// goes to the evolution loop, which can queue it, refuse it, build it, merge it, deploy it and revert it. The platform
// reports each step back through `council.decisions.read`, a tier-0 observe capability of xauusd-moderator
// (platform V3, relayed 2026-11-17):
//   AGENTS.observe("xauusd-moderator", "council.decisions.read", { cursor })
//   → { available, origin, updates: [{ schema: "typed_proposal.v1", proposal_id, state, reason, refs, at }], next_cursor }
// At most 20 updates a call, oldest first, only this origin's, never a price.
//
// This module reads those updates once an hour and stores them next to the proposals; Nexus shows the latest state.
// It runs only with COUNCIL_DECISIONS_POLL "on". The capability is granted through organism.json only once the
// platform says V3 is live on both the Forge and the AI Kernel (before that, the running DNA schema refuses the
// capability id and the census would refuse the whole organ). Until then the flag stays off.
//
// It changes nothing xauusd does: a knob proposal is still run by xauusd's own shadow test, live and rollback
// (src/council-knob-tuning.mjs); the platform's state is shown beside it.
import { ensureSessionSchema } from "./cfc-session.mjs";

export const DECISIONS_AGENT = "xauusd-moderator";
export const DECISIONS_CAPABILITY = "council.decisions.read";
export const PLATFORM_STATES = Object.freeze(["received", "queued", "waiting_external", "rejected", "in_progress", "proposed", "merged", "deployed",
  "deployed_unmeasured", "closed", "refused", "unfit", "reverted"]);
const MAX_PAGES = 5;
const CURSOR_ID = "platform";
const TIMEOUT_MS = 10_000;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS council_proposal_updates (proposal_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, refs TEXT, at TEXT NOT NULL,
    received_ms INTEGER NOT NULL, PRIMARY KEY (proposal_id, at, state))`,
  "CREATE TABLE IF NOT EXISTS council_decision_cursor (id TEXT PRIMARY KEY, cursor TEXT, polled_ms INTEGER, last_status TEXT)"
];
let schemaReady = null;
async function ensureSchema(db) {
  if (schemaReady === db) return;
  await ensureSessionSchema(db);
  for (const q of SCHEMA_SQL) await db.prepare(q).run();
  schemaReady = db;
}
export function resetDecisionsSchemaForTests() { schemaReady = null; }

export const decisionsPollOn = (env) => String(env?.COUNCIL_DECISIONS_POLL ?? "off").toLowerCase() === "on";

const clip = (s, n) => String(s ?? "").slice(0, n);
const REF_KEYS = ["intent_id", "evolution_id", "cr_id", "merge_sha", "deploy_ref"];

/** One update as the platform sends it → a stored row, or null when it is not one of ours or not well formed. */
export function cleanUpdate(u) {
  if (!u || typeof u !== "object") return null;
  if (u.schema != null && u.schema !== "typed_proposal.v1") return null;
  const proposal_id = typeof u.proposal_id === "string" ? u.proposal_id.trim() : "";
  const state = typeof u.state === "string" ? u.state.trim() : "";
  const at = typeof u.at === "string" && Number.isFinite(Date.parse(u.at)) ? new Date(Date.parse(u.at)).toISOString() : null;
  if (!/^[A-Za-z0-9_:.-]{1,80}$/.test(proposal_id) || !PLATFORM_STATES.includes(state) || !at) return null;
  const refs = {};
  for (const k of REF_KEYS) if (typeof u.refs?.[k] === "string" && u.refs[k]) refs[k] = clip(u.refs[k], 120);
  return { proposal_id, state, reason: typeof u.reason === "string" && u.reason.trim() ? clip(u.reason.trim(), 300) : null, refs, at };
}

async function observe(env, cursor, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      env.AGENTS.observe(DECISIONS_AGENT, DECISIONS_CAPABILITY, cursor ? { cursor } : {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Hourly: reads the platform's updates since the stored cursor (up to MAX_PAGES calls) and stores those about this
 * repo's proposals. Never throws. Returns { status, read, stored, unknown, pages }.
 */
export async function pollCouncilDecisions(env, { now = Date.now(), timeoutMs = TIMEOUT_MS, maxPages = MAX_PAGES } = {}) {
  if (!decisionsPollOn(env)) return { status: "off" };
  if (typeof env?.AGENTS?.observe !== "function" || !env?.DB) return { status: "unavailable" };
  const db = env.DB;
  try {
    await ensureSchema(db);
    const row = await db.prepare("SELECT cursor FROM council_decision_cursor WHERE id = ?").bind(CURSOR_ID).first();
    let cursor = row?.cursor ?? null;
    let read = 0, stored = 0, unknown = 0, pages = 0, status = "ok";
    for (; pages < maxPages; pages++) {
      let res;
      try { res = await observe(env, cursor, timeoutMs); }
      catch (e) { status = e instanceof Error && e.message === "timeout" ? "timeout" : "rpc_failed"; break; }
      // The kernel answers { outcome: "succeeded", result: {...} } or { outcome: "denied", reason }.
      if (res?.outcome && res.outcome !== "succeeded" && res.outcome !== "success") { status = `denied: ${clip(res.reason ?? res.outcome, 120)}`; break; }
      const body = res?.result && typeof res.result === "object" ? res.result : res;
      if (body?.available === false) { status = "not_available"; break; }
      const updates = Array.isArray(body?.updates) ? body.updates : [];
      read += updates.length;
      for (const u of updates) {
        const c = cleanUpdate(u);
        if (!c) continue;
        const ours = await db.prepare("SELECT 1 AS ok FROM council_proposals WHERE id = ?").bind(c.proposal_id).first();
        if (!ours) { unknown += 1; continue; }
        const r = await db.prepare("INSERT OR IGNORE INTO council_proposal_updates (proposal_id, state, reason, refs, at, received_ms) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(c.proposal_id, c.state, c.reason, JSON.stringify(c.refs), c.at, now).run();
        if (r?.meta?.changes) stored += 1;
      }
      const next = typeof body?.next_cursor === "string" && body.next_cursor ? body.next_cursor : null;
      if (next) cursor = next;
      if (!next || updates.length === 0) { pages += 1; break; }
    }
    await db.prepare("INSERT INTO council_decision_cursor (id, cursor, polled_ms, last_status) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, polled_ms = excluded.polled_ms, last_status = excluded.last_status")
      .bind(CURSOR_ID, cursor, now, status).run();
    return { status, read, stored, unknown, pages };
  } catch (e) {
    return { status: "failed", error: clip(e instanceof Error ? e.message : String(e), 200) };
  }
}

/** The latest platform state of each listed proposal: { [proposal_id]: { state, reason, refs, at, history } }. */
export async function platformStates(env, ids) {
  const list = (ids ?? []).filter((x) => typeof x === "string" && x);
  if (!list.length || !env?.DB) return {};
  try {
    await ensureSchema(env.DB);
    const q = `SELECT proposal_id, state, reason, refs, at FROM council_proposal_updates WHERE proposal_id IN (${list.map(() => "?").join(",")}) ORDER BY at ASC, received_ms ASC`;
    const rows = (await env.DB.prepare(q).bind(...list).all()).results ?? [];
    const out = {};
    for (const r of rows) {
      const refs = (() => { try { return JSON.parse(r.refs || "{}"); } catch { return {}; } })();
      const e = (out[r.proposal_id] ??= { history: [] });
      e.history.push({ state: r.state, at: r.at });
      Object.assign(e, { state: r.state, reason: r.reason ?? null, refs, at: r.at });
    }
    for (const e of Object.values(out)) e.history = e.history.slice(-10);
    return out;
  } catch { return {}; }
}

/** The poller's own state for the page: { on, last_polled_at, last_status }. */
export async function decisionsPollStatus(env) {
  const on = decisionsPollOn(env);
  if (!env?.DB) return { on, last_polled_at: null, last_status: null };
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT polled_ms, last_status FROM council_decision_cursor WHERE id = ?").bind(CURSOR_ID).first();
    return { on, last_polled_at: row?.polled_ms ? new Date(Number(row.polled_ms)).toISOString() : null, last_status: row?.last_status ?? null };
  } catch { return { on, last_polled_at: null, last_status: null }; }
}
