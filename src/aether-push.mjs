// Aether phase A5 (RFC_AETHER_KNOWLEDGE_GUARDIAN §0.6): the AI Worker pushes its decision cards to
// cryptophys-aether through the AETHER Service Binding (entrypoint KnowledgeIngress). No secret.
//
// Once an hour (the first sweep after the H1 close) the sweep loads the latest cards of each chart,
// drops any card that fails the local leak check, and pushes only the cards whose content changed
// since the last push (a card changes when its outcomes are scored). Aether checks every card again
// and may refuse one; a refusal is recorded and that same content is not sent again.
//
// Advisory only and non-fatal: the push never changes a room, a decision or a card, never waits on
// Aether, and a transport failure leaves the ledger untouched so the next hour retries it.

import { loadDecisionCards, cardLeaks } from "./decision-cards.mjs";
import { collectNexusAnalytics } from "./nexus-analytics.mjs";

export const AETHER_PUSH_VERSION = "cryptophys.aether-push.v1";
/** Cards per chart each hour. Wide enough to resend a card when its outcome lands (horizon 4 candles). */
export const AETHER_PUSH_LIMITS = Object.freeze({ "15": 12, "60": 12, "240": 8, "1D": 8 });
/** Aether's KnowledgeIngress takes at most 50 cards per call (cryptophys-aether src/store.mjs). */
export const AETHER_MAX_CARDS_PER_CALL = 50;
const CARD_ID = /^d:[0-9A-Za-z]+:\d+:\d+$/;

export const AETHER_PUSH_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS aether_card_pushes (
    card_id TEXT PRIMARY KEY,
    chart TEXT NOT NULL,
    content_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
    detail TEXT,
    pushed_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_aether_card_pushes_at ON aether_card_pushes(pushed_at)"
];
let schemaReady = false;
export function resetAetherPushSchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of AETHER_PUSH_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The AETHER binding when it is usable (production only; absent in preview and tests). */
function aetherOf(env) {
  return env?.AETHER && typeof env.AETHER.ingestCards === "function" ? env.AETHER : null;
}

/**
 * Sweep step, hourly. Returns a summary; never throws for an Aether failure.
 * `load` is loadDecisionCards (injected by tests).
 */
export async function pushDecisionCards(env, { now = Date.now(), load = loadDecisionCards } = {}) {
  const aether = aetherOf(env);
  if (!aether) return { status: "disabled" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureSchema(db);
  const at = new Date(now).toISOString();
  const skipped = { leak: 0, invalid: 0, unchanged: 0, load_failed: 0 };
  const pending = [];
  for (const [chart, limit] of Object.entries(AETHER_PUSH_LIMITS)) {
    let cards = [];
    try { cards = await load(env, { chart, limit }); } catch { skipped.load_failed += 1; continue; }
    for (const card of cards || []) {
      if (!card || typeof card.card_id !== "string" || !CARD_ID.test(card.card_id)) { skipped.invalid += 1; continue; }
      if (cardLeaks(card).length) { skipped.leak += 1; continue; }
      const sha = await sha256(JSON.stringify(card));
      const prev = await db.prepare("SELECT content_sha FROM aether_card_pushes WHERE card_id = ?").bind(card.card_id).first();
      if (prev?.content_sha === sha) { skipped.unchanged += 1; continue; }
      pending.push({ card, sha, chart });
    }
  }
  let accepted = 0, rejected = 0;
  for (let i = 0; i < pending.length; i += AETHER_MAX_CARDS_PER_CALL) {
    const batch = pending.slice(i, i + AETHER_MAX_CARDS_PER_CALL);
    let res;
    try { res = await aether.ingestCards(batch.map((p) => p.card)); }
    catch (e) { return { status: "transport_failed", error: String(e?.message ?? e).slice(0, 200), accepted, rejected, skipped }; }
    if (!res || typeof res.accepted !== "number" || !Array.isArray(res.rejected)) return { status: "bad_response", accepted, rejected, skipped };
    const refused = new Map(res.rejected.filter((r) => typeof r?.card_id === "string").map((r) => [r.card_id, r.errors]));
    for (const { card, sha, chart } of batch) {
      const errors = refused.get(card.card_id);
      const status = errors ? "rejected" : "accepted";
      if (errors) rejected += 1; else accepted += 1;
      await db.prepare("INSERT INTO aether_card_pushes (card_id, chart, content_sha, status, detail, pushed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET content_sha = excluded.content_sha, status = excluded.status, detail = excluded.detail, pushed_at = excluded.pushed_at")
        .bind(card.card_id, chart, sha, status, errors ? JSON.stringify(errors).slice(0, 500) : null, at).run();
    }
  }
  return { status: "ok", version: AETHER_PUSH_VERSION, pushed: pending.length, accepted, rejected, skipped };
}

/** GET /api/aether/status: the push ledger (no card content). */
export async function aetherPushStatus(env, { now = Date.now() } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const since = new Date(now - 86_400_000).toISOString();
  const rows = (await db.prepare("SELECT chart, status, COUNT(*) AS n, MAX(pushed_at) AS last FROM aether_card_pushes GROUP BY chart, status").all()).results || [];
  const day = (await db.prepare("SELECT status, COUNT(*) AS n FROM aether_card_pushes WHERE pushed_at >= ? GROUP BY status").bind(since).all()).results || [];
  const refused = (await db.prepare("SELECT card_id, detail, pushed_at FROM aether_card_pushes WHERE status = 'rejected' ORDER BY pushed_at DESC LIMIT 5").all()).results || [];
  const charts = {};
  for (const r of rows) charts[r.chart] = { ...(charts[r.chart] || {}), [r.status]: Number(r.n) || 0, last_pushed_at: [charts[r.chart]?.last_pushed_at, r.last].filter(Boolean).sort().at(-1) ?? null };
  return {
    version: AETHER_PUSH_VERSION,
    binding: aetherOf(env) ? "present" : "absent",
    limits: AETHER_PUSH_LIMITS,
    charts,
    last_24h: Object.fromEntries(day.map((r) => [r.status, Number(r.n) || 0])),
    recent_rejections: refused.map((r) => ({ card_id: r.card_id, errors: (() => { try { return JSON.parse(r.detail); } catch { return r.detail; } })(), pushed_at: r.pushed_at }))
  };
}

// ---------------------------------------------------------------- the weighting report (2026-11-09)

export const WEIGHTING_REPORT_VERSION = "cryptophys.weighting-report.v1";
const WEIGHTING_PUSH_SQL = `CREATE TABLE IF NOT EXISTS aether_weighting_report_pushes (
  timeframe TEXT PRIMARY KEY,
  content_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  pushed_at TEXT NOT NULL
)`;

/**
 * Pure: the weighting report for Aether's calibrator, from readWeightingReplay. Parameters, ids,
 * counts, accuracies and p-values only: no price, level or size.
 */
export function weightingReport(replay, { now = Date.now(), nexusAnalytics = null } = {}) {
  const stat = (t) => (t ? { bars: t.bars, candidate_better: t.candidate_better, control_better: t.control_better, p_value: t.p_value, ...(t.p_holm !== undefined ? { p_holm: t.p_holm } : {}), accuracy: t.accuracy, control_accuracy: t.control_accuracy, ...(t.complete !== undefined ? { complete: t.complete, required_bars: t.required_bars } : {}) } : null);
  return {
    version: WEIGHTING_REPORT_VERSION, equation: replay?.equation ?? null, generated_at: new Date(now).toISOString(),
    // Owner decisions 2026-11-09: the tuning activates by itself; Aether audits, it proposes nothing.
    mode: "auto", timeframe: replay?.timeframe ?? "60", regimes: replay?.regimes ?? null,
    window_days: replay?.window_days ?? null, rooms: replay?.rooms ?? 0,
    active: replay?.active ? { id: replay.active.id, params: replay.active.params, activated_at: replay.active.activated_at ?? null, change: replay.active.change } : null,
    control: replay?.control ? { scored_rooms: replay.control.scored_rooms, accuracy: replay.control.accuracy, entries_taken: replay.control.entries_taken, moderator_agreement: replay.control.moderator_agreement } : null,
    agents: (replay?.agents || []).slice(0, 40).map((a) => ({ agent: a.agent, family: a.family, weight: a.weight, accuracy: a.accuracy, calibration: a.calibration, decisive: a.decisive, n: a.n })),
    holm: replay?.holm ?? null,
    candidates: (replay?.candidates || []).map((c) => ({ id: c.id, changed: c.changed, change: c.change, params: c.params, verdict: c.verdict, same_rooms: c.same_rooms, differing_decisions: c.differing_decisions, discovery: stat(c.discovery), holdout: stat(c.holdout) })),
    reverse: replay?.reverse ?? null,
    history: (replay?.history || []).slice(-10),
    nexus_analytics: nexusAnalytics ?? replay?.nexus_analytics ?? null
  };
}

/**
 * Sweep step, hourly: sends the Decision Engine's witness-weighting report (src/witness-tuning.mjs,
 * timeframe "engine") when it changed. Never throws for an Aether failure.
 */
export async function pushWitnessTuningReport(env, report) {
  if (typeof env?.AETHER?.ingestWeightingReport !== "function") return { status: "disabled" };
  if (!env.DB || !report) return { status: "unavailable" };
  await env.DB.prepare(WEIGHTING_PUSH_SQL).run();
  const { generated_at: _g, ...content } = report;
  const sha = await sha256(JSON.stringify(content));
  const prev = await env.DB.prepare("SELECT content_sha, status FROM aether_weighting_report_pushes WHERE timeframe = ?").bind(report.timeframe).first();
  if (prev?.content_sha === sha && prev.status === "accepted") return { status: "unchanged" };
  let res;
  try { res = await env.AETHER.ingestWeightingReport(report); }
  catch (e) { return { status: "transport_failed", error: String(e?.message ?? e).slice(0, 200) }; }
  const status = res?.accepted ? "accepted" : "rejected";
  await env.DB.prepare("INSERT INTO aether_weighting_report_pushes (timeframe, content_sha, status, detail, pushed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(timeframe) DO UPDATE SET content_sha = excluded.content_sha, status = excluded.status, detail = excluded.detail, pushed_at = excluded.pushed_at")
    .bind(report.timeframe, sha, status, res?.reason ? String(res.reason).slice(0, 300) : null, report.generated_at ?? new Date().toISOString()).run();
  return { status, candidates: (report.candidates || []).length, ...(res?.reason ? { reason: String(res.reason).slice(0, 120) } : {}) };
}

/** Sweep step, hourly: sends the weighting report when it changed. Never throws for an Aether failure. */
export async function pushWeightingReport(env, replay, { now = Date.now(), nexusAnalytics = null } = {}) {
  if (typeof env?.AETHER?.ingestWeightingReport !== "function") return { status: "disabled" };
  if (!env.DB || !replay) return { status: "unavailable" };
  await env.DB.prepare(WEIGHTING_PUSH_SQL).run();

  let analytics = nexusAnalytics;
  if (!analytics && env?.DB) {
    try { analytics = await collectNexusAnalytics(env, { now }); } catch {}
  }
  if (analytics && typeof env?.AETHER?.ingestNexusAnalytics === "function") {
    try { await env.AETHER.ingestNexusAnalytics(analytics); } catch {}
  }

  const report = weightingReport(replay, { now, nexusAnalytics: analytics });
  const { generated_at: _g, ...content } = report;
  const sha = await sha256(JSON.stringify(content));
  const prev = await env.DB.prepare("SELECT content_sha, status FROM aether_weighting_report_pushes WHERE timeframe = ?").bind(report.timeframe).first();
  if (prev?.content_sha === sha && prev.status === "accepted") return { status: "unchanged" };
  let res;
  try { res = await env.AETHER.ingestWeightingReport(report); }
  catch (e) { return { status: "transport_failed", error: String(e?.message ?? e).slice(0, 200) }; }
  const status = res?.accepted ? "accepted" : "rejected";
  await env.DB.prepare("INSERT INTO aether_weighting_report_pushes (timeframe, content_sha, status, detail, pushed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(timeframe) DO UPDATE SET content_sha = excluded.content_sha, status = excluded.status, detail = excluded.detail, pushed_at = excluded.pushed_at")
    .bind(report.timeframe, sha, status, res?.reason ? String(res.reason).slice(0, 300) : null, new Date(now).toISOString()).run();
  return { status, candidates: report.candidates.length, ...(res?.reason ? { reason: String(res.reason).slice(0, 120) } : {}) };
}
