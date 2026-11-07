// Aether phase A7 (RFC_AETHER_KNOWLEDGE_GUARDIAN §0.6 "pull", §9.4 engine-params arm): the AI Worker
// pulls Aether's learned pack (KnowledgeIngress.learnedPack, over the existing AETHER binding) once an
// hour. The pack holds only items a person approved for shadow testing on the platform Console.
//
// What the pack may do here:
//   - An approved `param_candidate` whose family, parameter and value lie in TUNING_GRID (reviewed code
//     below) becomes a shadow version (src/shadow-versions.mjs): computed and scored beside the active
//     engine, never shown in a room, a prompt or a decision. At most 3 candidates per family run at once,
//     the hand-written ones included (RFC O6).
//   - Text items (caution, role_reminder) are stored and listed only. They reach no prompt: the shadow
//     knowledge arm and any promotion are later phases, and promotion is always an owner PR.
// Non-fatal: without the binding, or when Aether is down, the last stored pack (or none) is used.

import { CANDIDATES, RETIRED_CANDIDATES, latchCandidate } from "./shadow-versions.mjs";

export const PACK_VERSION = "cryptophys.learned-pack.v1";
/** The reviewed tuning grid (RFC §9.1): the only parameter values an approved item may start in shadow. */
export const TUNING_GRID = Object.freeze({
  prophet_r37: Object.freeze({ stateMaxAge: Object.freeze([8, 12, 16, 24]) }),
  gmi_v12_70: Object.freeze({ stateMaxAge: Object.freeze([8, 12, 16, 24]) })
});
export const MAX_CANDIDATES_PER_FAMILY = 3;
const MAX_ITEMS = 50;
/** An approved candidate is reviewed after its 200-bar sample or 30 decisive pairs, at the latest 30 days after the pull. */
const REVIEW_DAYS = 30;

export const AETHER_PACK_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS aether_learned_pack (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    pack_json TEXT NOT NULL,
    first_seen_json TEXT NOT NULL,
    pulled_at TEXT NOT NULL,
    changed_at TEXT NOT NULL
  )`
];
let schemaReady = false;
export function resetAetherPackSchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of AETHER_PACK_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/** Pure: the pack's problems (empty when it may be stored). */
export function packProblems(pack) {
  if (!pack || typeof pack !== "object") return ["not_an_object"];
  const out = [];
  if (pack.version !== PACK_VERSION) out.push("unsupported_version");
  if (typeof pack.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pack.sha256)) out.push("sha_invalid");
  if (!Array.isArray(pack.items) || pack.items.length > MAX_ITEMS) out.push("items_invalid");
  else if (pack.items.some((it) => !it || typeof it.item_id !== "string" || it.label !== "learned")) out.push("item_not_learned");
  return out;
}

/**
 * Pure: the shadow candidates of the approved param items. Returns { candidates, ignored }.
 * `firstSeen` maps "item_id@version" to the ISO time it was first pulled (the review clock).
 */
export function packCandidates(pack, { existing = CANDIDATES, retired = RETIRED_CANDIDATES, firstSeen = {}, now = Date.now() } = {}) {
  const candidates = [], ignored = [];
  const ids = new Set([...existing.map((c) => c.id), ...retired.map((c) => c.id)]);
  const perFamily = new Map();
  for (const c of existing) perFamily.set(c.family, (perFamily.get(c.family) || 0) + 1);
  for (const it of Array.isArray(pack?.items) ? pack.items : []) {
    if (it?.kind !== "param_candidate") continue;
    const key = `${it.item_id}@${it.version}`;
    const p = it.params || {};
    const entries = Object.entries(p.values || {});
    const [param, value] = entries[0] || [];
    const grid = TUNING_GRID[p.family]?.[param];
    if (entries.length !== 1 || !grid) { ignored.push({ item: key, reason: "not in TUNING_GRID" }); continue; }
    if (!grid.includes(value)) { ignored.push({ item: key, reason: `value ${value} not in the reviewed grid` }); continue; }
    const id = `${p.family}@latch${value}`;
    if (ids.has(id)) { ignored.push({ item: key, reason: `${id} already runs or was stopped` }); continue; }
    if ((perFamily.get(p.family) || 0) >= MAX_CANDIDATES_PER_FAMILY) { ignored.push({ item: key, reason: `${p.family} already runs ${MAX_CANDIDATES_PER_FAMILY} candidates` }); continue; }
    const seen = Date.parse(firstSeen[key] || "") || now;
    candidates.push(latchCandidate(p.family, value, param, {
      by: new Date(seen + REVIEW_DAYS * 86_400_000).toISOString().slice(0, 10),
      rule: "approved in Aether for shadow testing; review once the 200-bar sample or 30 decisive pairs are reached"
    }, { source: "aether", item_id: it.item_id, version: it.version, proposal_id: it.proposal_id ?? null, content_sha256: it.content_sha256 ?? null, hypothesis: p.hypothesis ?? null, metric: p.metric ?? null }));
    ids.add(id);
    perFamily.set(p.family, (perFamily.get(p.family) || 0) + 1);
  }
  return { candidates, ignored };
}

/** Sweep step, hourly: pulls the pack and stores it when it changed. Never throws for an Aether failure. */
export async function pullLearnedPack(env, { now = Date.now() } = {}) {
  if (typeof env?.AETHER?.learnedPack !== "function") return { status: "disabled" };
  if (!env.DB) return { status: "unavailable" };
  await ensureSchema(env.DB);
  let pack;
  try { pack = await env.AETHER.learnedPack(); }
  catch (e) { return { status: "transport_failed", error: String(e?.message ?? e).slice(0, 200) }; }
  const problems = packProblems(pack);
  if (problems.length) return { status: "refused", problems };
  const at = new Date(now).toISOString();
  const prev = await env.DB.prepare("SELECT sha256, first_seen_json FROM aether_learned_pack WHERE id = 1").first();
  let firstSeen = {};
  try { firstSeen = JSON.parse(prev?.first_seen_json || "{}"); } catch { firstSeen = {}; }
  for (const it of pack.items) firstSeen[`${it.item_id}@${it.version}`] ??= at;
  const changed = prev?.sha256 !== pack.sha256;
  await env.DB.prepare(
    "INSERT INTO aether_learned_pack (id, version, sha256, pack_json, first_seen_json, pulled_at, changed_at) VALUES (1, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET version = excluded.version, sha256 = excluded.sha256, pack_json = excluded.pack_json, first_seen_json = excluded.first_seen_json, pulled_at = excluded.pulled_at, changed_at = CASE WHEN aether_learned_pack.sha256 = excluded.sha256 THEN aether_learned_pack.changed_at ELSE excluded.changed_at END"
  ).bind(pack.version, pack.sha256, JSON.stringify(pack), JSON.stringify(firstSeen), at, at).run();
  return { status: "ok", sha256: pack.sha256, items: pack.items.length, changed };
}

/** The stored pack, or null. */
export async function storedPack(env) {
  if (!env?.DB) return null;
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT version, sha256, pack_json, first_seen_json, pulled_at, changed_at FROM aether_learned_pack WHERE id = 1").first();
  if (!row) return null;
  try { return { pack: JSON.parse(row.pack_json), firstSeen: JSON.parse(row.first_seen_json || "{}"), pulled_at: row.pulled_at, changed_at: row.changed_at }; }
  catch { return null; }
}

/** Every shadow candidate to compute and show: the hand-written ones and the approved Aether ones. */
export async function shadowCandidates(env, { now = Date.now() } = {}) {
  let stored = null;
  try { stored = await storedPack(env); } catch { stored = null; }
  if (!stored) return CANDIDATES;
  return [...CANDIDATES, ...packCandidates(stored.pack, { firstSeen: stored.firstSeen, now }).candidates];
}

/** Summary for GET /api/aether/status: the pack hash, its items (text included: reviewed, no levels) and what runs in shadow. */
export async function packStatus(env, { now = Date.now() } = {}) {
  const stored = await storedPack(env);
  if (!stored) return { pulled: false };
  const { candidates, ignored } = packCandidates(stored.pack, { firstSeen: stored.firstSeen, now });
  return {
    pulled: true, version: stored.pack.version, sha256: stored.pack.sha256, pulled_at: stored.pulled_at, changed_at: stored.changed_at,
    use: "shadow testing only; never a live prompt",
    items: (stored.pack.items || []).map((it) => ({ item_id: it.item_id, version: it.version, kind: it.kind, audience: it.audience, text: it.text, params: it.params ?? null })),
    shadow_candidates: candidates.map((c) => ({ id: c.id, item_id: c.origin.item_id, review_by: c.review.by })),
    ignored
  };
}
