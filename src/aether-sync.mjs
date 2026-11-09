// End-to-end sync between this AI Worker, Aether and Nexus (hardening, owner 2026-11-09).
//
// Aether's AetherReader.sync() reports whether the feeds it receives are fresh: the decision cards
// this Worker pushes, the canon index, the embedding backlog, each timeframe's weighting report and
// the AI budget (each ok, warn, or idle while the market was closed). This module adds what only this
// side knows: whether Aether's canon carries the same KB v4 hash as this repository (a KB change here
// needs a re-import in cryptophys-aether), and whether this Worker's own push of cards is current.
// The health alerts turn every warning into an alert; GET /api/aether/status shows the same status
// to Nexus's Aether page. Read-only: nothing here changes a decision, a card or Aether.

import { KNOWLEDGE_BASE_V4 } from "./knowledge-base.generated.mjs";

export const AETHER_SYNC_VERSION = "cryptophys.xauusd-aether-sync.v1";
export const LOCAL_KB_SHA = KNOWLEDGE_BASE_V4.provenance.content_sha256;
const HOUR = 3_600_000;

/** The AETHER_READER binding when it is usable (production only; absent in preview and tests). */
function readerOf(env) {
  return env?.AETHER_READER && typeof env.AETHER_READER.sync === "function" ? env.AETHER_READER : null;
}

/** Pure: the combined status from Aether's sync answer and this side's facts. */
export function combineSync({ aether, error = null, lastPushAt = null, now = Date.now(), localKb = LOCAL_KB_SHA }) {
  const checks = {};
  if (!aether) {
    checks.reachable = { status: "warn", error: error ? String(error).slice(0, 160) : "no answer" };
  } else {
    for (const [k, c] of Object.entries(aether.checks || {})) checks[`aether_${k}`] = c;
    const match = aether.kb_content_sha256 === localKb;
    checks.kb_match = { status: match ? "ok" : "warn", local: String(localKb).slice(0, 12), aether: aether.kb_content_sha256 ? String(aether.kb_content_sha256).slice(0, 12) : null };
    if (!match) checks.kb_match.hint = "re-import KB v4 into cryptophys-aether (canon/indicator/kb-v4.json, npm run canon:build)";
  }
  const pushAge = Date.parse(lastPushAt ?? "");
  checks.local_push = Number.isFinite(pushAge) && now - pushAge <= 2 * HOUR
    ? { status: "ok", last_at: lastPushAt }
    : { status: aether?.market_open === false ? "idle" : "warn", last_at: lastPushAt ?? null };
  const overall = Object.values(checks).some((c) => c.status === "warn") ? "warn" : "ok";
  return { version: AETHER_SYNC_VERSION, overall, checked_at: new Date(now).toISOString(), checks };
}

/** Reads Aether's sync checks and this side's push ledger. Never throws; null when no binding. */
export async function aetherSyncStatus(env, { now = Date.now() } = {}) {
  const reader = readerOf(env);
  if (!reader) return null;
  let aether = null, error = null;
  try { aether = await reader.sync(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  let lastPushAt = null;
  try { lastPushAt = (await env.DB.prepare("SELECT MAX(pushed_at) AS at FROM aether_card_pushes").first())?.at ?? null; } catch { lastPushAt = null; }
  return combineSync({ aether, error, lastPushAt, now });
}

/** Pure: the health alerts of a combined status (one per warning check). */
export function syncAlerts(status) {
  if (!status) return [];
  const TEXT = {
    reachable: "Aether is unreachable from the AI Worker (AetherReader.sync failed)",
    kb_match: "Aether's canon carries another KB v4 than xauusd: re-import KB v4 into cryptophys-aether",
    local_push: "The AI Worker has not pushed decision cards to Aether for over 2 hours",
    aether_ingest: "Aether has received no decision card for over 2 hours",
    aether_canon_index: "Aether's canon is not indexed 2 hours after a change",
    aether_embed_backlog: "Aether's embedding backlog is older than 2 hours",
    aether_ai_budget: "Aether's daily AI budget is used up"
  };
  return Object.entries(status.checks || {}).filter(([, c]) => c.status === "warn").map(([k, c]) => ({
    key: `aether_sync:${k}`, kind: "aether_sync",
    subject: TEXT[k] ?? (k.startsWith("aether_weighting_") ? `Aether's ${k.replace("aether_weighting_", "")} weighting report is older than ${c.limit_minutes} minutes` : `Aether sync check ${k} warns`),
    detail: { check: k, ...c }
  }));
}
