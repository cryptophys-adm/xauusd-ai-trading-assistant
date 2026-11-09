// P7 of RFC_INDICATOR_AGENT_PLATFORM §7 (owner go 2026-11-07): the crowd line, reputation
// weighting and the agents' track records. Deterministic: no model call; every number comes from
// the stored room messages and the outcome scores (src/outcome-scoring.mjs).
//
// Reputation of one agent on one timeframe, over 30 days:
//   decisive = BUY/SELL hits + misses + WAIT hits + WAIT missed opportunities (a neutral
//              BUY/SELL outcome is not decisive);
//   accuracy = hits / decisive, shrunk toward 50 % with REPUTATION_PRIOR pseudo-observations, so a
//              new agent starts at weight 1 and earns its weight with its sample;
//   weight   = 2 x shrunk accuracy, kept within WEIGHT_RANGE (0.25 to 2).
// The crowd line of one bar: the stances and biases of every agent that spoke (its final stance,
// after the Consensus Discussion), the same weighted by reputation, a disagreement index (the
// normalised entropy of the weighted biases: 0 unanimous, 1 an even three-way split), and the agent
// families whose weighted lean goes against the crowd.

import { MANIFEST_FAMILIES } from "./indicator-manifests.mjs";

export const REPUTATION_VERSION = "cryptophys.reputation.v1";
export const REPUTATION_DAYS = 30;
export const REPUTATION_PRIOR = 10;
export const WEIGHT_RANGE = Object.freeze([0.25, 2]);
export const NEUTRAL_BAND = 0.1;

/** Agent families (RFC §7), from the indicator manifests (P2, src/indicator-manifests.mjs). */
export const AGENT_FAMILIES = MANIFEST_FAMILIES;
export const familyOf = (id) => AGENT_FAMILIES[id] ?? "other";

/** The timeframe a room is scored on (outcome_scores.timeframe). */
export const ROOM_TIMEFRAME = Object.freeze({ M15: "15", H1: "60", H4: "240", D1: "1D" });

const SIGN = { BULLISH: 1, BEARISH: -1, NEUTRAL: 0 };
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function biasOf(entry) {
  const b = String(entry?.bias ?? "").toUpperCase();
  if (b in SIGN) return b;
  const s = String(entry?.stance ?? "").toUpperCase();
  return s === "BUY" ? "BULLISH" : s === "SELL" ? "BEARISH" : "NEUTRAL";
}

/** One scorecard (outcome-scoring.mjs scorecards) as a reputation. */
export function reputationOf(card) {
  const d = card?.directional || {}, w = card?.wait || {};
  const hits = (d.hit || 0) + (w.hit || 0);
  const decisive = (d.hit || 0) + (d.miss || 0) + (w.hit || 0) + (w.missed_opportunity || 0);
  const shrunk = (hits + REPUTATION_PRIOR / 2) / (decisive + REPUTATION_PRIOR);
  return {
    n: card?.n || 0, decisive, accuracy: decisive ? r3(hits / decisive) : null, shrunk: r3(shrunk),
    weight: r3(clamp(2 * shrunk, WEIGHT_RANGE[0], WEIGHT_RANGE[1])),
    hit_rate: d.hit_rate ?? null, wait_accuracy: w.accuracy ?? null, brier: card?.brier ?? null
  };
}

/** Reputation of every scored agent ("agent:<id>") on one timeframe, keyed by agent id. */
export function reputationFromScorecards(cards, timeframe) {
  const out = {};
  for (const c of cards || []) {
    if (c.timeframe !== timeframe || !String(c.subject).startsWith("agent:")) continue;
    out[c.subject.slice("agent:".length)] = reputationOf(c);
  }
  return out;
}

/**
 * The crowd line of one room. `entries` are the agents that spoke ({ id, stance, bias }), each with
 * its final stance; `reputation` is reputationFromScorecards for the room's timeframe (an agent
 * without a record weighs 1).
 */
export function buildCrowdLine(entries, reputation = {}, { quorumShare = QUORUM_SHARE, weighting = null } = {}) {
  const list = (entries || []).filter((e) => e && e.id && e.id !== "moderator");
  const stances = {}, biases = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 }, weighted = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  let sum = 0, wsum = 0, lean = 0;
  const families = new Map();
  for (const e of list) {
    const s = String(e.stance ?? "WAIT").toUpperCase(), b = biasOf(e);
    const w = Number.isFinite(reputation?.[e.id]?.weight) ? reputation[e.id].weight : 1;
    stances[s] = (stances[s] || 0) + 1;
    biases[b] += 1; weighted[b] += w;
    lean += SIGN[b]; sum += SIGN[b] * w; wsum += w;
    const f = familyOf(e.id);
    const fam = families.get(f) || { family: f, agents: [], sum: 0, w: 0 };
    fam.agents.push(e.id); fam.sum += SIGN[b] * w; fam.w += w;
    families.set(f, fam);
  }
  const n = list.length;
  const weightedLean = wsum ? sum / wsum : 0;
  const label = (x) => (Math.abs(x) < NEUTRAL_BAND ? "NEUTRAL" : x > 0 ? "BULLISH" : "BEARISH");
  const shares = Object.values(weighted).map((x) => (wsum ? x / wsum : 0)).filter((p) => p > 0);
  const disagreement = shares.length > 1 ? -shares.reduce((a, p) => a + p * Math.log(p), 0) / Math.log(3) : 0;
  const crowdBias = label(weightedLean);
  const fams = [...families.values()].map((f) => ({ family: f.family, agents: f.agents, weighted_lean: r3(f.w ? f.sum / f.w : 0), bias: label(f.w ? f.sum / f.w : 0) }));
  const against = crowdBias === "NEUTRAL"
    ? fams.filter((f) => f.bias !== "NEUTRAL").map((f) => f.family)
    : fams.filter((f) => f.bias !== "NEUTRAL" && f.bias !== crowdBias).map((f) => f.family);
  return {
    version: REPUTATION_VERSION, agents: n, stances, biases,
    lean: r3(n ? lean / n : 0), bias: label(n ? lean / n : 0),
    weighted_biases: Object.fromEntries(Object.entries(weighted).map(([k, v]) => [k, r3(wsum ? v / wsum : 0)])),
    weighted_lean: r3(weightedLean), weighted_bias: crowdBias,
    disagreement: r3(disagreement),
    scored_agents: list.filter((e) => reputation?.[e.id]?.decisive > 0).length,
    families: fams, disagreeing_families: against,
    // The quorum this crowd line is judged by, and the weighting it was built with (src/weighting.mjs).
    quorum_share: quorumShare,
    ...(weighting ? { weighting } : {})
  };
}

/**
 * The quorum of a room (owner decision 2026-11-09: "H1 Decision adalah kuorum"). A BUY or SELL
 * conclusion needs more than QUORUM_SHARE of the weight of the agents who spoke (each weighted by its
 * track record, the crowd line; Aether tunes the weights later) holding the matching bias: BULLISH for
 * a BUY, BEARISH for a SELL. HOLD, WAIT and CLOSE need none. Replaces "no confirmation, no entry": an
 * indicator confirmation is one agent's argument, not a gate.
 */
export const QUORUM_SHARE = 0.5;
export function quorumAllows(stance, crowd, share = Number.isFinite(crowd?.quorum_share) ? crowd.quorum_share : QUORUM_SHARE) {
  const bias = stance === "BUY" ? "BULLISH" : stance === "SELL" ? "BEARISH" : null;
  if (!bias) return true;
  const w = crowd?.weighted_biases?.[bias];
  return Number.isFinite(w) && w > share;
}
export function quorumRule(crowd, share = Number.isFinite(crowd?.quorum_share) ? crowd.quorum_share : QUORUM_SHARE) {
  const w = crowd?.weighted_biases ?? {};
  const pct = (b) => (Number.isFinite(w[b]) ? Math.round(w[b] * 100) + "%" : "unknown");
  return `QUORUM RULE (owner decision 2026-11-09): BUY needs more than ${Math.round(share * 100)}% of the agents' weight holding a BULLISH bias, SELL more than ${Math.round(share * 100)}% holding a BEARISH bias; otherwise the conclusion is WAIT, or HOLD / CLOSE for a position already open. Now: BULLISH ${pct("BULLISH")}, BEARISH ${pct("BEARISH")}, NEUTRAL ${pct("NEUTRAL")} of the weight. Indicator confirmations (Prophet, GMI) are arguments the agents weigh, never a gate.`;
}

/** The final stance of each agent of a room: its Consensus Discussion answer, else its opening. */
export function finalEntries(openings, debate) {
  // Stored messages carry the agent in `agent` (their `id` is the row id); reader output carries it in `id`.
  const idOf = (m) => String(m.agent ?? m.id);
  const byId = new Map();
  for (const m of openings || []) if (m?.status === "ok") byId.set(idOf(m), { id: idOf(m), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence ?? null });
  for (const m of debate || []) if (m?.status === "ok" && byId.has(idOf(m))) byId.set(idOf(m), { id: idOf(m), stance: m.stance, bias: m.bias ?? byId.get(idOf(m)).bias, confidence: m.confidence ?? null });
  return [...byId.values()];
}

const STUCK_LABEL = {
  "prophet_r37.structure_subtype": "the Prophet R37 structure", "prophet_r37.b_enc": "the Prophet R37 bias state", "prophet_r37.d_enc": "the Prophet R37 divergence state",
  "prophet_r38.d_enc": "the Prophet R38 divergence state", "prophet_r38.t_enc": "the Prophet R38 trade management", "gmi_v12_70.verdict": "the GMI verdict",
  "gmi_v12_70.gate": "the GMI gate", "gmi_v12_70.conflict": "the GMI conflict flag"
};
const STUCK_AGENTS = { prophet: ["h1", "prophet", "r37_funnel"], gmi: ["h1", "decision_matrix"] };

/** Caution flags per agent of the 1H room, from the open stuck states (RFC §5.3). */
export function stuckCautions(stuck) {
  const out = {};
  for (const s of stuck || []) {
    if (s?.status !== "open") continue;
    const agents = STUCK_AGENTS[String(s.field).startsWith("gmi") ? "gmi" : "prophet"];
    const text = `${STUCK_LABEL[s.field] ?? s.field} has not changed for ${s.candles} candles while price moved ${Number.isFinite(s.price_range / s.atr) ? Math.round((s.price_range / s.atr) * 10) / 10 : "several"} times the ATR`;
    for (const a of agents) (out[a] ||= []).push(text);
  }
  return out;
}

/** Reputation plus caution flags for the agents of one room, keyed by agent id. */
export function roomReputation(ids, reputation = {}, cautions = {}) {
  const out = {};
  for (const id of ids || []) {
    const r = reputation[id] ?? null;
    out[id] = { ...(r ?? { n: 0, decisive: 0, accuracy: null, shrunk: 0.5, weight: 1, hit_rate: null, wait_accuracy: null, brier: null }), family: familyOf(id), ...(cautions[id]?.length ? { caution: cautions[id] } : {}) };
  }
  return out;
}

/** The moderator's line about the crowd (prompt text). */
export function crowdRule(crowd) {
  return `CROWD LINE (deterministic: every agent's final stance and bias, and the same weighted by each agent's 30-day track record; ${crowd.scored_agents} of ${crowd.agents} agents have a record): the weighted crowd leans ${crowd.weighted_bias.toLowerCase()}, disagreement ${crowd.disagreement}. If your bias differs from the weighted crowd, say so in one clause of the summary. ` + JSON.stringify({ stances: crowd.stances, biases: crowd.biases, weighted_biases: crowd.weighted_biases, disagreeing_families: crowd.disagreeing_families });
}
