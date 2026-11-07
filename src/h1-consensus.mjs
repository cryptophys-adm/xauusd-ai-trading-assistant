// The H1 decision by Consensus Discussion (owner decision 2026-11-07): the H1 chain is no longer
// Analyst -> Counselor -> Reasoner at the close of the bar. Every input comes from the 1H War
// Room's communication bus, and the Reasoner decides LAST, after the room's Consensus Discussion:
//
//   1. at the close, runAnalysis fuses the evidence of the bar and parks it (KV, H1_PENDING_PREFIX);
//      the run stays "analyzing" at the stage "awaiting_consensus"; no model is called;
//   2. the 1H War Room meets (src/timeframe-threads.mjs): communication bus, Consensus Discussion,
//      the moderator's conclusion (decision and bias);
//   3. when the room concludes, or H1_CONSENSUS_FALLBACK_MS after the close at the latest (owner
//      choice: 45 minutes), the Reasoner reads the room and the parked evidence and writes the
//      H1 decision. An empty bus gives a fail-closed WAIT without a model call.
//
// The Analyst and the Counselor are retired: they ran only in the background (no screen showed
// their output), and deciding before the discussion made the chain ambiguous and always WAIT.
// The old H1 multi-agent bus is retired too: the 1H War Room is the bus.
//
// Advisory only: no broker, no orders. Prices come only from the evidence, never from the room.
import { majorityBias } from "./war-room.mjs";

export const H1_CHAIN = "consensus_reasoner";
export const H1_CONSENSUS_FALLBACK_MS = 45 * 60 * 1000;
export const H1_PENDING_PREFIX = "h1:pending:";
export const H1_PENDING_TTL_S = 6 * 3600;
/**
 * The stages of a parked bar. analysis_runs.status has a CHECK constraint (analyzing, complete,
 * degraded, failed), so a parked bar stays "analyzing" and its stage is the run's error_code.
 * A stale "analyzing" run may be claimed again by new evidence of the bar: runAnalysis then parks
 * the fresher evidence, which is harmless (no model call happens at the close).
 */
export const AWAITING_CONSENSUS = "awaiting_consensus";
export const FINALIZING = "finalizing";
/** A Reasoner that keeps failing this long after the close gives a fail-closed WAIT. */
export const H1_REASONER_GIVE_UP_MS = 2 * 60 * 60 * 1000;
/** How far back the sweep looks for bars awaiting their decision. */
export const H1_PENDING_LOOKBACK_MS = 4 * 60 * 60 * 1000;

/**
 * The 1H room right after the close (owner request 2026-11-07: a faster H1 decision). When the
 * evidence is parked, an `h1_room` queue task runs the 1H War Room at once instead of waiting for
 * the next sweep (cron :10, :25, :40, :55) and its 20-minute HUD wait. The task waits for the bar's
 * HUD snapshot until H1_ROOM_HUD_WAIT_MS after the close (retried every minute), then runs with
 * whatever is there; a snapshot that arrives later re-convenes the room (#hud), but the decision
 * already written stays. The sweep remains the fallback, and skips a bar whose room the task holds.
 */
export const H1_ROOM_HUD_WAIT_MS = 5 * 60 * 1000;
export const H1_ROOM_RETRY_S = 60;
export const H1_ROOM_LOCK_PREFIX = "h1room:lock:";
export const H1_ROOM_LOCK_TTL_S = 7 * 60;

export function buildH1RoomTask({ candleKey, enqueuedAt = new Date().toISOString() } = {}) {
  if (!h1BarTimes(candleKey)) throw new TypeError("h1 room task requires an H1 candle key");
  return { kind: "h1_room", event_id: `h1_room:${candleKey}`, candle_key: candleKey, enqueued_at: enqueuedAt };
}

/** "run" when the HUD snapshot is there or its wait is over, else "wait_for_hud". */
export function h1RoomGate({ candleKey, now, hudReady }) {
  const t = h1BarTimes(candleKey);
  if (!t || hudReady) return "run";
  return now - t.close >= H1_ROOM_HUD_WAIT_MS ? "run" : "wait_for_hud";
}

const H1_MS = 3600_000;
const DIRECTION = { BUY: 1, SELL: -1 };
const BIAS_SIGN = { BULLISH: 1, BEARISH: -1, NEUTRAL: 0 };

/** Bar open and close (ms) of a "<symbol>:60:<open ms>" candle key; null when unreadable. */
export function h1BarTimes(candleKey) {
  const open = Number(String(candleKey).split(":").at(-1));
  return Number.isFinite(open) && open > 0 ? { open, close: open + H1_MS } : null;
}

/** Whether the Reasoner may decide now: the room concluded, or the fallback time has passed. */
export function finalizeDue({ candleKey, now, roomConcluded }) {
  if (roomConcluded) return true;
  const t = h1BarTimes(candleKey);
  return Boolean(t) && now - t.close >= H1_CONSENSUS_FALLBACK_MS;
}

const ok = (m) => m && m.status === "ok";

/**
 * What the Reasoner reads from the 1H War Room of the bar (readTimeframeThread's shape): the
 * communication bus, the Consensus Discussion and the moderator's conclusion.
 *   concluded: the moderator concluded;
 *   partial:   some agents spoke, no conclusion (the 45-minute fallback);
 *   empty:     no room, or no agent spoke.
 */
export function consensusInput(room) {
  const bus = (room?.openings || []).filter(ok).map((m) => ({ agent: m.name, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, evidence: m.calibration ?? null, claim: m.claim }));
  const discussion = (room?.debate || []).filter(ok).map((m) => ({ agent: m.name, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, answers: m.rebuts_names ?? [], argument: m.argument }));
  const c = room?.conclusion?.status === "ok" ? room.conclusion : null;
  const conclusion = c ? { stance: c.stance, bias: c.bias ?? null, confidence: c.confidence, summary: c.summary, reasons: c.reasons ?? [], dissent: (c.dissent || []).map((d) => d.name ?? d) } : null;
  const roomBias = conclusion?.bias || (bus.length ? majorityBias(bus) : "NEUTRAL");
  return {
    status: conclusion ? "concluded" : bus.length ? "partial" : "empty",
    bar_open: room?.bar_open ?? null,
    roster_size: (room?.roster || []).length,
    agents_spoke: bus.length,
    room_bias: roomBias,
    communication_bus: bus,
    consensus_discussion: discussion,
    conclusion
  };
}

/** The Reasoner's prompt lines: it decides last, from the room's consensus and the evidence. */
export function reasonerLines({ evidence, consensus, laneRule, decisionTextRule, tradePlanRule }) {
  return [
    "You are the Reasoner, the final stage of the XAUUSD H1 decision. You decide LAST, after the Consensus Discussion of the 1H War Room: CONSENSUS holds its communication bus (every agent's opening), the Consensus Discussion (the agents answering each other) and the moderator's conclusion with its decision and bias.",
    "Use only CONSENSUS and EVIDENCE. Do not invent market prices or claim the agents verified facts they did not receive.",
    "Decode every numeric field with EVIDENCE.policy.field_dictionary (derived from the Pine sources) before reasoning, and quote the decoded meaning. Apply EVIDENCE.policy.decision_policy. Never infer a field meaning that is not in the dictionary.",
    "The decision follows the consensus of the room: the conclusion's decision and bias, weighed by the arguments and by how much of each agent's evidence is verified. A room stance of HOLD or CLOSE is about an open position: your decision is then WAIT. If the room concluded WAIT with a BULLISH or BEARISH bias, you may decide BUY or SELL in that direction only when EVIDENCE holds the matching confirmed 1-hour Prophet R38 signal and exact prices for the plan; otherwise WAIT, and say which way the room leans.",
    "Never decide against the room's bias. Depart from the room's decision only for a veto in EVIDENCE: Prophet R38 trade management t_enc 4 (ruthless cut loss), a GMI verdict of -3 against a BUY or +3 against a SELL, or missing exact price evidence; then decide WAIT and name the veto. A GMI conflict or a GMI gate of -1 lowers your confidence; it never vetoes on its own.",
    consensus?.status === "partial"
      ? `The room did not conclude within 45 minutes of the close: ${consensus.agents_spoke} of ${consensus.roster_size} agents spoke. Decide from the bus and the discussion that exist, and keep your confidence lower for it.`
      : "The room concluded: name its decision and bias once in the reasoning, and if your decision differs, say why.",
    laneRule,
    "If news_evidence.available is false, state completed fundamental news analysis was unavailable. Do NOT claim news supported or contradicted the setup.",
    "If news_evidence.available is true, incorporate the completed news analysis and its underlying article evidence into final reasoning.",
    "If informational_5m_context is present, it is 5m execution context only, labelled VERIFIED 5m (parity-approved) or UNVERIFIED 5m by its verification field; either way it must not change the decision or prices.",
    "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning, confirmation, invalidation, trade_plan.", decisionTextRule, tradePlanRule,
    "Set decision to WAIT or NO_TRADE and prices to null if exact price evidence is absent. Never imply automatic execution.",
    "CONSENSUS:",
    JSON.stringify(consensus),
    "EVIDENCE:",
    JSON.stringify(evidence)
  ];
}

const PRICE_KEYS = ["entry_price", "stop_loss", "take_profit", "risk_reward", "position_size_pct"];

/**
 * Never against the room: a BUY or SELL whose direction contradicts the room's bias (or its
 * concluded BUY / SELL) becomes WAIT with prices cleared. Everything else passes unchanged.
 */
export function consensusGuard(decision, consensus) {
  const d = String(decision?.decision || "").toUpperCase();
  const dir = DIRECTION[d];
  if (!dir || !consensus) return { decision, overridden: false };
  const roomDir = BIAS_SIGN[consensus.room_bias] || 0;
  const concludedDir = DIRECTION[consensus.conclusion?.stance] || 0;
  if (roomDir !== -dir && concludedDir !== -dir) return { decision, overridden: false };
  const lean = roomDir === -dir ? String(consensus.room_bias).toLowerCase() : consensus.conclusion.stance === "SELL" ? "bearish" : "bullish";
  const out = { ...decision, decision: "WAIT", ...Object.fromEntries(PRICE_KEYS.map((k) => [k, null])), trade_plan: null,
    reasoning: `The 1H War Room's consensus is ${lean}, so a ${d} against it is not taken: the decision stays WAIT. ${String(decision.reasoning || "").trim()}`.trim() };
  return { decision: out, overridden: true };
}

/** The fail-closed WAIT when the room produced nothing by the fallback time. */
export function emptyConsensusDecision() {
  return {
    decision: "WAIT", confidence: null, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null,
    reasoning: "No agent of the 1H War Room spoke within 45 minutes of the close, so there is no consensus to decide from. The decision stays WAIT until the next bar.",
    confirmation: null, invalidation: null
  };
}

/** The fail-closed WAIT when the Reasoner kept failing for H1_REASONER_GIVE_UP_MS. */
export function reasonerUnavailableDecision() {
  return {
    decision: "WAIT", confidence: null, entry_price: null, stop_loss: null, take_profit: null, risk_reward: null, position_size_pct: null,
    reasoning: "The Reasoner did not answer within two hours of the close, so no decision was written from the room's consensus. The decision stays WAIT until the next bar.",
    confirmation: null, invalidation: null
  };
}

/** A compact record of the consensus the decision came from, kept in the synthesis. */
export function consensusSummary(consensus, { overridden = false, decidedAfterCloseS = null } = {}) {
  return {
    decided_after_close_s: decidedAfterCloseS,
    status: consensus.status, bar_open: consensus.bar_open, agents_spoke: consensus.agents_spoke, roster_size: consensus.roster_size,
    room_bias: consensus.room_bias, conclusion: consensus.conclusion ? { stance: consensus.conclusion.stance, bias: consensus.conclusion.bias, confidence: consensus.conclusion.confidence, summary: consensus.conclusion.summary } : null,
    guard_overridden: overridden
  };
}
