// Decision cards (RFC_AETHER_KNOWLEDGE_GUARDIAN phase A1, §6.1): one deterministic record per room
// conclusion, with each agent's final stance, the crowd line, the open stuck states, the compliance
// findings and the outcomes once scored. Aether embeds and audits them. They carry no level of any
// kind: never an entry, stop, target, trade plan, zone, key level, close or ATR in dollars, and any
// price-like number in agent text is replaced. A test walks every key and string of a card.

import { readTimeframeThread } from "./timeframe-threads.mjs";
import { readWarRoom } from "./war-room.mjs";
import { finalEntries } from "./reputation.mjs";
import { SCORING_VERSION } from "./outcome-scoring.mjs";
import { KNOWLEDGE_BASE_V4 } from "./knowledge-base.generated.mjs";

export const DECISION_CARD_VERSION = "cryptophys.decision-card.v1";
export const FORBIDDEN_KEYS = Object.freeze(["entry", "entry_price", "stop", "stop_loss", "take_profit", "tp1", "tp2", "trade_plan", "plan", "key_levels", "zones", "levels", "close", "price", "atr", "position_size_pct", "lots", "size"]);
const TF_CHART = Object.freeze({ "15": null, "60": "H1", "240": "H4", "1D": "D1" });

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
/** Agent text without price-like numbers (3 to 5 digits, optional decimals): they become "[level]". */
export function sanitizeText(text, max = 300) {
  if (typeof text !== "string" || !text) return null;
  return text.replace(/\$?\b(?:\d{1,2},\d{3}|\d{3,5})(?:\.\d+)?\b/g, "[level]").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Trading session of a bar open (UTC hours): asia, london, new_york, or late. */
export function sessionOf(iso) {
  const h = new Date(iso).getUTCHours();
  return h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "new_york" : "late";
}

/**
 * Pure: the card of one room. `thread` is readTimeframeThread or readWarRoom output; `outcomes`
 * rows { subject, result, direction }; `stuck` open stuck states; `compliance` rows { agent,
 * check_id, detail }; `parity` { engine: status }.
 */
export function buildDecisionCard({ chart, thread, outcomes = [], stuck = [], compliance = [], parity = {}, run = 0 }) {
  const barOpen = chart === "15" ? new Date(Date.parse(thread.bar_time) - 15 * 60_000).toISOString() : thread.bar_open ?? null;
  const barClose = chart === "15" ? thread.bar_time : thread.bar_close ?? null;
  const final = finalEntries(thread.openings || [], thread.debate || []);
  const claims = new Map((thread.openings || []).map((o) => [o.id, o.claim]));
  const c = thread.conclusion || null;
  const crowd = thread.crowd || null;
  const confirmations = {};
  for (const [k, v] of Object.entries(thread.confirmations || {})) {
    if (v && typeof v === "object") for (const [f, b] of Object.entries(v)) if (typeof b === "boolean") confirmations[`${k}.${f}`] = b;
  }
  const h1 = chart === "60" ? thread.reasoner_decision : thread.h1;
  return {
    card_id: `d:${chart}:${Date.parse(barOpen)}:${run}`,
    version: DECISION_CARD_VERSION,
    kind: "room_conclusion",
    chart, bar_open: barOpen, bar_close: barClose, session: barOpen ? sessionOf(barOpen) : null,
    conclusion: c ? { stance: c.stance ?? null, bias: c.bias ?? null, confidence: r2(c.confidence), reconvened: thread.reconvened === true, summary: sanitizeText(c.summary, 600) } : null,
    crowd: crowd ? { weighted_bias: crowd.weighted_bias ?? null, disagreement: r2(crowd.disagreement), disagreeing_families: crowd.disagreeing_families ?? [] } : null,
    agents: final.map((a) => ({ id: a.id, stance: a.stance ?? null, bias: a.bias ?? null, confidence: r2(a.confidence), claim: sanitizeText(claims.get(a.id)) })),
    h1: h1 ? { decision: h1.decision ?? null, confidence: r2(h1.confidence) } : null,
    confirmations,
    stuck_open: stuck.map((s) => ({ field: s.field, candles: s.candles })),
    compliance: compliance.map((x) => ({ agent: x.agent, check: x.check_id, detail: sanitizeText(x.detail, 200) })),
    outcomes: Object.fromEntries(outcomes.map((o) => [o.subject, { result: o.result, direction: o.direction ?? null }])),
    provenance: { scoring_version: SCORING_VERSION, kb_sha: KNOWLEDGE_BASE_V4.provenance.content_sha256, learned_pack_sha: null, parity }
  };
}

/** Pure: every forbidden key or price-like number left in a card (empty for a clean card). */
export function cardLeaks(card) {
  const leaks = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEYS.includes(k)) leaks.push(`${path}.${k}`); walk(x, `${path}.${k}`); }
    else if (typeof v === "string" && !/^(?:card_id|chart|bar_open|bar_close|kb_sha|scoring_version)$/.test(path.split(".").at(-1)) && /\b\d{3,5}(?:[.,]\d+)?\b/.test(v)) leaks.push(`${path}: number`);
  };
  walk(card, "card");
  return leaks;
}

/** The latest `limit` room cards of a chart ("15", "60", "240" or "1D"), newest first. */
export async function loadDecisionCards(env, { chart = "60", limit = 6 } = {}) {
  const db = env.DB;
  if (!(chart in TF_CHART)) return [];
  const n = Math.max(1, Math.min(24, limit));
  const threads = [];
  if (chart === "15") {
    const runs = (await db.prepare("SELECT run_id FROM agent_thread_messages WHERE thread_id >= 'warroom:' AND thread_id < 'warroom;' AND step = 'conclusion' ORDER BY thread_id DESC, run_id DESC LIMIT ?").bind(n).all()).results || [];
    for (const r of runs) { const t = await readWarRoom(db, { barTime: r.run_id }); if (t) threads.push({ t, key: t.bar_time, threadId: `warroom:${String(t.bar_time).slice(0, 10)}`, barTime: t.bar_time }); }
  } else {
    const tf = TF_CHART[chart];
    const keys = (await db.prepare("SELECT DISTINCT json_extract(body_json, '$.candle_key') AS k FROM agent_thread_messages WHERE thread_id = ? AND step = 'brief' ORDER BY run_id DESC LIMIT ?").bind(`tf:${tf}`, n).all()).results || [];
    for (const r of keys) { if (!r.k) continue; const t = await readTimeframeThread(db, tf, { candleKey: r.k }); if (t) threads.push({ t, key: t.candle_key, threadId: `tf:${tf}`, barTime: t.bar_close }); }
  }
  let parity = {};
  try { for (const row of (await db.prepare("SELECT engine, status FROM engine_parity_registry").all()).results || []) if (row.status === "approved" || !(row.engine in parity)) parity[row.engine] = row.status; } catch { parity = {}; }
  let stuck = [];
  try { stuck = (await db.prepare("SELECT field, candles FROM stuck_states WHERE status = 'open'").all()).results || []; } catch { stuck = []; }
  const cards = [];
  for (const { t, key, threadId, barTime } of threads) {
    let outcomes = [], compliance = [];
    try { outcomes = (await db.prepare("SELECT subject, result, direction FROM outcome_scores WHERE timeframe = ? AND candle_key = ? AND (subject LIKE 'agent:%' OR subject = 'chain:h1')").bind(chart, key).all()).results || []; } catch { outcomes = []; }
    try { compliance = (await db.prepare("SELECT agent, check_id, detail FROM compliance_checks WHERE thread_id = ? AND bar_time = ?").bind(threadId, barTime).all()).results || []; } catch { compliance = []; }
    cards.push(buildDecisionCard({ chart, thread: t, outcomes, stuck: chart === "60" ? stuck : [], compliance, parity, run: t.reconvened ? 1 : 0 }));
  }
  return cards;
}
