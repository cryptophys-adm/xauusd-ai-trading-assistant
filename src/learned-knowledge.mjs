// Aether phase A9 (RFC_AETHER_KNOWLEDGE_GUARDIAN §8.1, §10, K8): the BUNDLED learned pack and its
// deterministic retrieval into the rooms.
//
// The pack (knowledge/learned/pack.json, bundled as src/learned-knowledge.generated.mjs by
// scripts/build-learned-knowledge.mjs) changes only by an owner PR, like KB v4. It holds learned
// notes a person approved and the shadow arm found better (src/shadow-knowledge.mjs).
// Selection is deterministic: a note is shown to an agent when the agent is in its audience, the
// room's chart matches and its situation matches the bar (the session for a caution; a role reminder
// always applies). No vector query, no model choosing notes. Budgets per consumer (RFC §10).
// Off unless LEARNED_KNOWLEDGE_ENABLED = "true": turning it off restores today's prompts at once.
// Master knowledge (KB v4) always wins: a note never overrides the Pine-derived readings.

import { LEARNED_PACK } from "./learned-knowledge.generated.mjs";

export const LEARNED_PACK_VERSION = "cryptophys.learned-knowledge.v1";
export const TEXT_KINDS = Object.freeze(["caution", "role_reminder"]);
/** RFC §10: notes and characters per consumer. */
export const BUDGETS = Object.freeze({ agent: Object.freeze({ items: 2, chars: 400 }), moderator: Object.freeze({ items: 3, chars: 600 }) });
export const LEARNED_HEADER = "LEARNED NOTES (reviewed by the owner; measured from past outcomes, not from the Pine source; your own data and the Pine-derived readings above take precedence; do not quote these notes as facts about the indicator):";

export function learnedKnowledgeEnabled(env) { return String(env?.LEARNED_KNOWLEDGE_ENABLED ?? "").trim().toLowerCase() === "true"; }

const SESSIONS = new Set(["asia", "london", "new_york", "late"]);
const CHARTS = new Set(["15", "60", "240", "1D"]);
const PRICE = /\b\d{3,}(?:[.,]\d+)?\b/;
const ORDER = /\b(?:buy|sell|long|short|entry|stop[- ]?loss|take[- ]?profit|lot|leverage|position size)\b/i;
const numbersOf = (text) => [...String(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0])));
function evidenceNumbers(value, out = new Set()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.add(String(value));
    if (value > 0 && value < 1) { out.add(String(Math.round(value * 100))); out.add(String(Math.round(value * 1000) / 10)); }
  } else if (typeof value === "string") numbersOf(value).forEach((n) => out.add(n));
  else if (Array.isArray(value)) value.forEach((v) => evidenceNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => evidenceNumbers(v, out));
  return out;
}

/** Pure: why a bundled item is refused (empty when it may ship). The kernel validator's rules, plus the bundle's. */
export function learnedItemProblems(it) {
  if (!it || typeof it !== "object") return ["not_an_object"];
  const out = [];
  if (it.label !== "learned") out.push("label_not_learned");
  if (!TEXT_KINDS.includes(it.kind)) out.push("kind_not_text");
  if (typeof it.item_id !== "string" || !/^[a-z0-9][a-z0-9_.:-]{2,95}$/.test(it.item_id)) out.push("item_id_invalid");
  if (!Number.isInteger(it.version) || it.version < 1) out.push("version_invalid");
  const agents = it.audience?.agents;
  if (!Array.isArray(agents) || !agents.length || !agents.every((a) => typeof a === "string" && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(a))) out.push("audience_invalid");
  const charts = it.audience?.charts ?? [];
  if (!Array.isArray(charts) || !charts.every((c) => CHARTS.has(c))) out.push("audience_charts_invalid");
  const text = typeof it.text === "string" ? it.text.trim() : "";
  if (!text || text.length > 300) out.push("text_length");
  if (PRICE.test(text)) out.push("text_price_like_number");
  if (ORDER.test(text)) out.push("text_order_wording");
  if (!it.evidence || typeof it.evidence !== "object") out.push("evidence_missing");
  else {
    const known = evidenceNumbers(it.evidence);
    const missing = numbersOf(text).filter((n) => !known.has(n));
    if (missing.length) out.push(`text_number_not_in_evidence:${missing.slice(0, 3).join(",")}`);
  }
  if (typeof it.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(it.content_sha256)) out.push("content_sha_missing");
  if (!it.provenance || typeof it.provenance.canon_sha !== "string" || !Array.isArray(it.provenance.card_ids) || it.provenance.card_ids.length < 10) out.push("provenance_missing");
  if (!it.review || typeof it.review.shadow_verdict !== "string" || !String(it.review.shadow_verdict).startsWith("better_than_active")) out.push("shadow_verdict_missing");
  if (it.kind === "caution" && it.situation?.session != null && !SESSIONS.has(it.situation.session)) out.push("situation_session_invalid");
  return out;
}

/** Pure: whether a note applies to this agent, chart and bar. */
export function noteApplies(it, { agent, chart, session }) {
  if (!it?.audience?.agents?.includes(agent)) return false;
  const charts = it.audience.charts || [];
  if (charts.length && !charts.includes(chart)) return false;
  if (it.kind === "caution") {
    if (it.situation?.chart && it.situation.chart !== chart) return false;
    if (it.situation?.session && it.situation.session !== session) return false;
  }
  return true;
}

/** Pure: the notes for one consumer, within its budget (whole notes only, in pack order). */
export function selectNotes(pack, { agent, chart, session, role = agent === "moderator" ? "moderator" : "agent" }) {
  const budget = BUDGETS[role] ?? BUDGETS.agent;
  const out = [];
  let chars = 0;
  for (const it of pack?.items || []) {
    if (out.length >= budget.items || !noteApplies(it, { agent, chart, session })) continue;
    const t = it.text.trim();
    if (chars + t.length > budget.chars) continue;
    out.push(it); chars += t.length;
  }
  return out;
}

/** The prompt block (placed after the agent's own data), or null when there is nothing to show. */
export function learnedBlock(env, { agent, chart, session, pack = LEARNED_PACK }) {
  if (!learnedKnowledgeEnabled(env)) return null;
  const notes = selectNotes(pack, { agent, chart, session });
  return notes.length ? [LEARNED_HEADER, ...notes.map((n) => `- ${n.text.trim()}`)].join("\n") : null;
}

/** For the room brief and the fingerprint: which pack, and which notes each agent saw. */
export function learnedPackInfo(env, { roster = [], chart, session, pack = LEARNED_PACK } = {}) {
  const enabled = learnedKnowledgeEnabled(env);
  const byAgent = {};
  if (enabled) for (const agent of [...roster, "moderator"]) {
    const ids = selectNotes(pack, { agent, chart, session }).map((n) => `${n.item_id}@${n.version}`);
    if (ids.length) byAgent[agent] = ids;
  }
  return { enabled, version: pack?.version ?? null, sha: pack?.content_sha256 ?? null, items: pack?.items?.length ?? 0, items_by_agent: byAgent };
}

export { LEARNED_PACK };
