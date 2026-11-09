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
import { QUORUM_SHARE } from "./reputation.mjs";

export { QUORUM_SHARE };

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
    conclusion,
    // P7 (RFC §7): the deterministic crowd line, weighted by each agent's 30-day track record.
    // weighted_biases (each bias's share of the weight) carries the quorum of the H1 decision.
    crowd: room?.crowd ? { weighted_bias: room.crowd.weighted_bias, weighted_lean: room.crowd.weighted_lean, weighted_biases: room.crowd.weighted_biases ?? null, disagreement: room.crowd.disagreement, scored_agents: room.crowd.scored_agents, agents: room.crowd.agents, disagreeing_families: room.crowd.disagreeing_families } : null
  };
}

/**
 * The H1 decision is the quorum of the 1H War Room (owner decision 2026-11-09: "H1 Decision adalah
 * kuorum"; independent of the TradingView webhooks and of any single indicator signal). BUY or SELL
 * only when the moderator concluded BUY or SELL AND more than QUORUM_SHARE of the weight of the
 * agents who spoke (each weighted by its track record, the P7 crowd line; Aether tunes the weights
 * later) holds the matching bias (BULLISH for a BUY, BEARISH for a SELL). Anything else is WAIT. The
 * Prophet confirmation, its trade management and the GMI verdict are arguments the agents weigh in
 * the discussion, never a gate or a veto here.
 */
const SIDE_BIAS = { BUY: "BULLISH", SELL: "BEARISH" };

/** Pure: the quorum result of a consensus input. */
export function quorumOf(consensus) {
  const c = consensus?.conclusion ?? null;
  const roomStance = c ? String(c.stance || "").toUpperCase() : null;
  const bias = SIDE_BIAS[roomStance] ?? null;
  const shares = consensus?.crowd?.weighted_biases ?? null;
  const share = bias && shares && Number.isFinite(shares[bias]) ? shares[bias] : null;
  const base = { room_stance: roomStance, side_bias: bias, share, needed: QUORUM_SHARE, agents: consensus?.crowd?.agents ?? consensus?.agents_spoke ?? 0 };
  if (!c) return { ...base, stance: "WAIT", met: false, reason: "the 1H War Room did not conclude, so there is no quorum to decide from" };
  if (!bias) return { ...base, stance: "WAIT", met: false, reason: `the 1H War Room concluded ${roomStance}, which is not an entry` };
  if (share == null) return { ...base, stance: "WAIT", met: false, reason: "the room has no crowd line, so its quorum cannot be counted" };
  const pct = Math.round(share * 100);
  if (share <= QUORUM_SHARE) return { ...base, stance: "WAIT", met: false, reason: `the 1H War Room concluded ${roomStance}, but only ${pct}% of the agents' weight leans ${bias.toLowerCase()}, not the majority it needs` };
  return { ...base, stance: roomStance, met: true, reason: `the 1H War Room concluded ${roomStance} and ${pct}% of the agents' weight leans ${bias.toLowerCase()}` };
}

const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
/** A plan whose entry, stop and first target exist and sit on the right sides of the entry. */
export function planIsValid(stance, plan) {
  if (!plan || !isPrice(plan.entry) || !isPrice(plan.stop) || !isPrice(plan.tp1)) return false;
  return stance === "BUY" ? plan.stop < plan.entry && plan.entry < plan.tp1 : stance === "SELL" ? plan.tp1 < plan.entry && plan.entry < plan.stop : false;
}

const PRICE_KEYS = ["entry_price", "stop_loss", "take_profit", "risk_reward", "position_size_pct"];
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Deterministic: the H1 decision is the quorum's, with the plan's prices (the Key Level Agent's zones
 * through the strategy engine). The Reasoner explains it; it never chooses the direction or the
 * prices. Without a valid plan a quorum BUY or SELL stays WAIT (the only price rule, owner decision
 * 2026-11-09). No position size is ever given (advisory only).
 */
export function applyQuorum(decision, { quorum, plan = null } = {}) {
  const model = String(decision?.decision || "").toUpperCase();
  const text = String(decision?.reasoning || "").trim();
  const cleared = { ...Object.fromEntries(PRICE_KEYS.map((k) => [k, null])), trade_plan: null };
  const stance = quorum?.stance === "BUY" || quorum?.stance === "SELL" ? quorum.stance : "WAIT";
  if (stance === "WAIT") {
    const reasoning = model === "BUY" || model === "SELL" ? `No quorum: ${quorum?.reason ?? "the room did not reach its quorum"}, so the decision stays WAIT. ${text}`.trim() : text || `No quorum: ${quorum?.reason ?? "the room did not reach its quorum"}, so the decision stays WAIT.`;
    return { decision: { ...decision, ...cleared, decision: "WAIT", reasoning }, overridden: model === "BUY" || model === "SELL" };
  }
  if (!planIsValid(stance, plan)) {
    return { decision: { ...decision, ...cleared, decision: "WAIT", reasoning: `The quorum is reached (${quorum.reason}), but the key levels give no valid entry, stop and target, so the decision stays WAIT. ${model === "WAIT" || model === "NO_TRADE" ? text : ""}`.trim() }, overridden: model !== "WAIT" };
  }
  const confidence = model === stance && Number.isFinite(decision?.confidence) ? decision.confidence : r2(Math.min(0.95, quorum.share));
  const out = {
    ...decision,
    decision: stance, confidence,
    entry_price: plan.entry, stop_loss: plan.stop, take_profit: plan.tp1,
    risk_reward: Number.isFinite(plan.rrr?.tp1) ? plan.rrr.tp1 : null, position_size_pct: null,
    trade_plan: {
      action: plan.at_level ? "ENTER_MARKET" : "ENTER_LIMIT", entry: plan.entry, invalidation: plan.stop, take_profit: plan.tp1,
      exit_reason: "NONE", progressive_stop: null, zone: null
    },
    reasoning: model === stance ? text : `The 1H War Room reached its quorum: ${quorum.reason}, so the decision is ${stance}. ${text}`.trim()
  };
  return { decision: out, overridden: model !== stance };
}

/**
 * The Reasoner's prompt lines (owner decision 2026-11-09): the decision is already fixed by the
 * room's QUORUM and its prices by the PLAN; the Reasoner writes it and explains it from the
 * consensus and the evidence. applyQuorum enforces both whatever the model returns.
 */
export function reasonerLines({ evidence, consensus, quorum = null, plan = null, laneRule, decisionTextRule, tradePlanRule }) {
  const q = quorum ?? quorumOf(consensus);
  return [
    "You are the Reasoner, the final stage of the XAUUSD H1 decision. You write the decision LAST, after the Consensus Discussion of the 1H War Room: CONSENSUS holds its communication bus (every agent's opening), the Consensus Discussion (the agents answering each other), the moderator's conclusion with its decision and bias, and the crowd line.",
    `The H1 decision is the QUORUM of the room, not yours to choose: BUY or SELL only when the moderator concluded BUY or SELL and more than ${Math.round(QUORUM_SHARE * 100)}% of the weight of the agents who spoke (each weighted by its track record, CONSENSUS.crowd.weighted_biases) holds the matching bias; otherwise WAIT. QUORUM gives the result. For a BUY or SELL, PLAN gives the entry, stop and targets from the Key Level Agent's zones: use exactly those prices (entry_price = PLAN.entry, stop_loss = PLAN.stop, take_profit = PLAN.tp1, risk_reward = PLAN.rrr.tp1). If QUORUM is BUY or SELL and PLAN is null, the decision is WAIT. Never set position_size_pct: it is always null.`,
    "Use only CONSENSUS, QUORUM, PLAN and EVIDENCE. Do not invent market prices or claim the agents verified facts they did not receive.",
    "Decode every numeric field with EVIDENCE.policy.field_dictionary (derived from the Pine sources) before quoting it, and quote the decoded meaning. Never infer a field meaning that is not in the dictionary.",
    "Indicator signals (the Prophet R38 confirmation and setup state, its trade management t_enc, the GMI verdict, gate and conflict) are arguments the agents weighed in the discussion, not gates and not vetoes: mention them only as the agents used them. Every field describes the closed candle being decided (EVIDENCE.candle_time, the bar that just closed), never the running candle. Local engine values that are not parity-approved are still evidence, read with less weight.",
    consensus?.status === "partial"
      ? `The room did not conclude within 45 minutes of the close: ${consensus.agents_spoke} of ${consensus.roster_size} agents spoke, so there is no quorum and the decision is WAIT; say which way the bus leans.`
      : "Name the room's conclusion, its bias and the quorum once in the reasoning; say what the main arguments were and what the dissenting agents said.",
    laneRule,
    "If news_evidence.available is false, state completed fundamental news analysis was unavailable. Do NOT claim news supported or contradicted the setup.",
    "If news_evidence.available is true, incorporate the completed news analysis and its underlying article evidence into final reasoning.",
    "If informational_5m_context is present, it is 5m execution context only, labelled VERIFIED 5m or UNVERIFIED 5m by its verification field; it never changes the decision or the prices.",
    "Return ONLY a JSON object with keys: decision (BUY, SELL, WAIT, or NO_TRADE), confidence (number 0-1 or null), entry_price, stop_loss, take_profit, risk_reward, position_size_pct, reasoning, confirmation, invalidation, trade_plan.", decisionTextRule, tradePlanRule,
    "For WAIT set every price to null. Never imply automatic execution.",
    "CONSENSUS:",
    JSON.stringify(consensus),
    "QUORUM:",
    JSON.stringify(q),
    "PLAN:",
    JSON.stringify(plan),
    "EVIDENCE:",
    JSON.stringify(evidence)
  ];
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
export function consensusSummary(consensus, { overridden = false, decidedAfterCloseS = null, quorum = null, plan = undefined } = {}) {
  return {
    decided_after_close_s: decidedAfterCloseS,
    status: consensus.status, bar_open: consensus.bar_open, agents_spoke: consensus.agents_spoke, roster_size: consensus.roster_size,
    room_bias: consensus.room_bias, conclusion: consensus.conclusion ? { stance: consensus.conclusion.stance, bias: consensus.conclusion.bias, confidence: consensus.conclusion.confidence, summary: consensus.conclusion.summary } : null,
    // Owner decision 2026-11-09: the decision is the room's quorum (quorumOf).
    quorum: quorum ? { stance: quorum.stance, room_stance: quorum.room_stance, side_bias: quorum.side_bias, share: quorum.share, needed: quorum.needed, met: quorum.met, reason: quorum.reason } : null,
    ...(plan !== undefined ? { plan_available: Boolean(plan) } : {}),
    guard_overridden: overridden
  };
}
