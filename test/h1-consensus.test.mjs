import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  H1_CONSENSUS_FALLBACK_MS, h1BarTimes, finalizeDue, consensusInput, reasonerLines, quorumOf, planIsValid, applyQuorum,
  QUORUM_SHARE, emptyConsensusDecision, reasonerUnavailableDecision, consensusSummary
} from "../src/h1-consensus.mjs";

const OPEN = Date.parse("2026-11-07T09:00:00.000Z");
const KEY = "OANDA:XAUUSD:60:" + OPEN;
const op = (id, name, stance, bias, confidence, extra = {}) => ({ id, name, status: "ok", stance, bias, confidence, calibration: "parity-approved 1H chain", claim: name + " claim.", ...extra });
const room = (conclusion = null) => ({
  bar_open: new Date(OPEN).toISOString(),
  roster: [{ id: "h1" }, { id: "technical" }, { id: "risk" }, { id: "kinetic_engine" }],
  openings: [op("h1", "1H Desk", "WAIT", "BULLISH", 0.7), op("technical", "Technical Analyst", "WAIT", "BULLISH", 0.6), op("risk", "Risk Manager", "WAIT", "NEUTRAL", 0.5), { id: "kinetic_engine", name: "Kinetic Engine", status: "agent_failed" }],
  debate: [{ ...op("risk", "Risk Manager", "WAIT", "NEUTRAL", 0.5), argument: "No confirmation yet.", rebuts_names: ["1H Desk"] }],
  conclusion
});

test("the Reasoner decides when the room concluded, or 45 minutes after the close at the latest (owner choice 2026-11-07)", () => {
  assert.equal(H1_CONSENSUS_FALLBACK_MS, 45 * 60 * 1000);
  assert.deepEqual(h1BarTimes(KEY), { open: OPEN, close: OPEN + 3600_000 });
  assert.equal(h1BarTimes("OANDA:XAUUSD:60:x"), null);
  const close = OPEN + 3600_000;
  assert.equal(finalizeDue({ candleKey: KEY, now: close + 10 * 60_000, roomConcluded: true }), true);
  assert.equal(finalizeDue({ candleKey: KEY, now: close + 44 * 60_000, roomConcluded: false }), false, "the room still has time");
  assert.equal(finalizeDue({ candleKey: KEY, now: close + 45 * 60_000, roomConcluded: false }), true, "the fallback");
});

test("the consensus input: the communication bus, the Consensus Discussion and the conclusion, by name", () => {
  const concluded = consensusInput(room({ status: "ok", stance: "WAIT", bias: "BULLISH", confidence: 0.6, summary: "The room leans up and waits for a confirmed buy.", reasons: ["r"], dissent: [{ id: "risk", name: "Risk Manager" }] }));
  assert.equal(concluded.status, "concluded");
  assert.equal(concluded.agents_spoke, 3, "a failed opening is not on the bus");
  assert.equal(concluded.roster_size, 4);
  assert.deepEqual(concluded.communication_bus.map((b) => b.agent), ["1H Desk", "Technical Analyst", "Risk Manager"]);
  assert.equal(concluded.communication_bus[0].evidence, "parity-approved 1H chain");
  assert.deepEqual(concluded.consensus_discussion[0].answers, ["1H Desk"]);
  assert.deepEqual(concluded.conclusion.dissent, ["Risk Manager"]);
  assert.equal(concluded.room_bias, "BULLISH");

  const partial = consensusInput(room());
  assert.equal(partial.status, "partial");
  assert.equal(partial.conclusion, null);
  assert.equal(partial.room_bias, "BULLISH", "without a conclusion the bus's confidence-weighted bias");
  assert.equal(consensusInput(null).status, "empty");
  assert.equal(consensusInput({ openings: [{ status: "agent_failed" }] }).status, "empty");
});

const crowd = (BULLISH, BEARISH, NEUTRAL = Math.round((1 - BULLISH - BEARISH) * 1000) / 1000) => ({ weighted_bias: "BULLISH", weighted_lean: 0.3, weighted_biases: { BULLISH, BEARISH, NEUTRAL }, disagreement: 0.5, scored_agents: 2, agents: 3, disagreeing_families: [] });
const concluded = (stance, bias, shares) => consensusInput({ ...room({ status: "ok", stance, bias, confidence: 0.6, summary: "s", reasons: ["r"], dissent: [] }), crowd: shares });
const PLAN_BUY = { entry: 4000, stop: 3990, tp1: 4030, tp2: 4050, rrr: { tp1: 3, tp2: 5 }, at_level: true };

test("the H1 decision is the room's quorum (owner decision 2026-11-09): the conclusion and more than half of the weight", () => {
  assert.equal(QUORUM_SHARE, 0.5);
  const q = quorumOf(concluded("BUY", "BULLISH", crowd(0.62, 0.1)));
  assert.equal(q.stance, "BUY");
  assert.equal(q.met, true);
  assert.equal(q.share, 0.62);
  assert.match(q.reason, /concluded BUY and 62% of the agents' weight leans bullish/);
  assert.equal(quorumOf(concluded("BUY", "BULLISH", crowd(0.5, 0.2))).stance, "WAIT", "exactly half is not a majority");
  assert.equal(quorumOf(concluded("SELL", "BEARISH", crowd(0.2, 0.7))).stance, "SELL");
  assert.equal(quorumOf(concluded("SELL", "BEARISH", crowd(0.7, 0.2))).stance, "WAIT", "a SELL needs the bearish weight");
  assert.equal(quorumOf(concluded("WAIT", "BULLISH", crowd(0.9, 0))).stance, "WAIT", "the room did not conclude an entry");
  assert.match(quorumOf(concluded("BUY", "BULLISH", null)).reason, /no crowd line/);
  assert.match(quorumOf(consensusInput(room())).reason, /did not conclude/);
  // No indicator field is read: the same room with or without a Prophet confirmation gives the same quorum.
  assert.deepEqual(quorumOf({ ...concluded("BUY", "BULLISH", crowd(0.62, 0.1)), prophet_r38: { buy_confirmed: false } }), q);
});

test("applyQuorum: direction from the quorum, prices from the plan, never a position size; no valid plan is WAIT", () => {
  const q = quorumOf(concluded("BUY", "BULLISH", crowd(0.62, 0.1)));
  assert.equal(planIsValid("BUY", PLAN_BUY), true);
  assert.equal(planIsValid("SELL", PLAN_BUY), false, "the prices sit on the wrong sides for a SELL");
  assert.equal(planIsValid("BUY", { ...PLAN_BUY, stop: null }), false);
  const model = { decision: "WAIT", confidence: 0.4, entry_price: 1, stop_loss: 2, take_profit: 3, risk_reward: 9, position_size_pct: 5, reasoning: "No confirmed buy yet.", trade_plan: null };
  const a = applyQuorum(model, { quorum: q, plan: PLAN_BUY });
  assert.equal(a.overridden, true, "the model's WAIT does not overrule the quorum");
  assert.equal(a.decision.decision, "BUY");
  assert.equal(a.decision.confidence, 0.62);
  assert.deepEqual([a.decision.entry_price, a.decision.stop_loss, a.decision.take_profit, a.decision.risk_reward, a.decision.position_size_pct], [4000, 3990, 4030, 3, null]);
  assert.equal(a.decision.trade_plan.action, "ENTER_MARKET");
  assert.match(a.decision.reasoning, /^The 1H War Room reached its quorum/);
  const agree = applyQuorum({ ...model, decision: "BUY", confidence: 0.7, reasoning: "The room buys." }, { quorum: q, plan: { ...PLAN_BUY, at_level: false } });
  assert.equal(agree.overridden, false);
  assert.equal(agree.decision.confidence, 0.7);
  assert.equal(agree.decision.trade_plan.action, "ENTER_LIMIT");
  assert.equal(agree.decision.reasoning, "The room buys.");
  const noPlan = applyQuorum({ ...model, decision: "BUY" }, { quorum: q, plan: null });
  assert.equal(noPlan.decision.decision, "WAIT");
  assert.equal(noPlan.decision.entry_price, null);
  assert.match(noPlan.decision.reasoning, /key levels give no valid entry, stop and target/);
  const noQuorum = applyQuorum({ ...model, decision: "SELL", entry_price: 4000 }, { quorum: quorumOf(concluded("SELL", "BEARISH", crowd(0.6, 0.3))), plan: null });
  assert.equal(noQuorum.overridden, true);
  assert.equal(noQuorum.decision.decision, "WAIT");
  assert.equal(noQuorum.decision.entry_price, null);
  assert.equal(noQuorum.decision.trade_plan, null);
  assert.match(noQuorum.decision.reasoning, /^No quorum: /);
  assert.equal(applyQuorum({ decision: "WAIT", reasoning: "w" }, { quorum: quorumOf(consensusInput(room())) }).overridden, false);
});

test("the Reasoner's prompt: it writes the quorum's decision with the plan's prices; indicators are arguments, not gates", () => {
  const consensus = concluded("BUY", "BULLISH", crowd(0.62, 0.1));
  const lines = reasonerLines({ evidence: { candle_key: KEY }, consensus, plan: PLAN_BUY, laneRule: "LANES", decisionTextRule: "TEXT", tradePlanRule: "PLANRULE" });
  const text = lines.join("\n");
  assert.match(text, /You write the decision LAST, after the Consensus Discussion of the 1H War Room/);
  assert.match(text, /The H1 decision is the QUORUM of the room, not yours to choose/);
  assert.match(text, /more than 50% of the weight of the agents who spoke/);
  assert.match(text, /use exactly those prices/);
  assert.match(text, /Never set position_size_pct/);
  assert.match(text, /are arguments the agents weighed in the discussion, not gates and not vetoes/);
  assert.match(text, /closed candle being decided \(EVIDENCE\.candle_time, the bar that just closed\), never the running candle/);
  assert.doesNotMatch(text, /t_enc 4|Never decide against the room's bias|gate 1 or 2/, "the old indicator gates are gone");
  assert.ok(lines.includes("LANES") && lines.includes("TEXT") && lines.includes("PLANRULE"));
  assert.ok(lines.indexOf("CONSENSUS:") < lines.indexOf("QUORUM:") && lines.indexOf("QUORUM:") < lines.indexOf("PLAN:") && lines.indexOf("PLAN:") < lines.indexOf("EVIDENCE:"));
  assert.equal(JSON.parse(lines[lines.indexOf("QUORUM:") + 1]).stance, "BUY");
  assert.equal(JSON.parse(lines[lines.indexOf("PLAN:") + 1]).entry, 4000);
  assert.doesNotMatch(text, /ANALYST:|COUNSELOR:/, "the Analyst and the Counselor are retired");
  const partial = reasonerLines({ evidence: {}, consensus: consensusInput(room()), laneRule: "", decisionTextRule: "", tradePlanRule: "" }).join("\n");
  assert.match(partial, /did not conclude within 45 minutes of the close: 3 of 4 agents spoke, so there is no quorum/);
});

test("fail-closed decisions are plain WAITs without prices; the stored summary is compact and carries the quorum", () => {
  for (const d of [emptyConsensusDecision(), reasonerUnavailableDecision()]) {
    assert.equal(d.decision, "WAIT");
    assert.equal(d.entry_price, null);
    assert.match(d.reasoning, /stays WAIT/);
  }
  const s = consensusSummary(consensusInput(room()), { overridden: true });
  assert.deepEqual(Object.keys(s), ["decided_after_close_s", "status", "bar_open", "agents_spoke", "roster_size", "room_bias", "conclusion", "quorum", "guard_overridden"]);
  assert.equal(s.guard_overridden, true);
  const c = concluded("BUY", "BULLISH", crowd(0.62, 0.1));
  const withQ = consensusSummary(c, { quorum: quorumOf(c), plan: PLAN_BUY });
  assert.equal(withQ.quorum.met, true);
  assert.equal(withQ.plan_available, true);
});

test("runAnalysis no longer calls the Analyst or the Counselor and no longer enqueues the old H1 bus", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runAnalysis(");
  const body = source.slice(start, source.indexOf("\n/** Evidence-fusion fields", start));
  assert.doesNotMatch(body, /AI_MODEL_ANALYST as keyof|AI_MODEL_COUNSELOR as keyof|env\.AI\.run/, "no model call at the close");
  assert.match(body, /H1_PENDING_PREFIX/);
  assert.match(body, /AWAITING_CONSENSUS/);
  assert.doesNotMatch(source, /enqueueMultiAgentBus|buildMultiAgentBusTask/, "the old H1 bus is retired");
  assert.match(source, /error_code = 'finalizing'.*WHERE candle_key = \? AND status = 'analyzing' AND \(error_code = 'awaiting_consensus'/, "one caller claims the decision");
  assert.match(source, /runPendingTimeframeThreads\(env, \{ onRoom \}\)/);
  assert.match(source, /finalizePendingH1Decisions\(env\)/);
});

test("the 1H room right after the close: the task waits for the HUD snapshot five minutes at most (owner request 2026-11-07)", async () => {
  const { buildH1RoomTask, h1RoomGate, H1_ROOM_HUD_WAIT_MS } = await import("../src/h1-consensus.mjs");
  assert.equal(H1_ROOM_HUD_WAIT_MS, 5 * 60 * 1000);
  assert.deepEqual(buildH1RoomTask({ candleKey: KEY, enqueuedAt: "t" }), { kind: "h1_room", event_id: `h1_room:${KEY}`, candle_key: KEY, enqueued_at: "t" });
  assert.throws(() => buildH1RoomTask({ candleKey: "OANDA:XAUUSD:60:x" }), TypeError);
  const close = OPEN + 3600_000;
  assert.equal(h1RoomGate({ candleKey: KEY, now: close + 60_000, hudReady: true }), "run");
  assert.equal(h1RoomGate({ candleKey: KEY, now: close + 60_000, hudReady: false }), "wait_for_hud");
  assert.equal(h1RoomGate({ candleKey: KEY, now: close + H1_ROOM_HUD_WAIT_MS, hudReady: false }), "run", "then the room runs without it");
});

test("runAnalysis enqueues the 1H room as soon as it parks the evidence; the queue consumer runs it", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runAnalysis(");
  const body = source.slice(start, source.indexOf("\n/** Enqueues the 1H room", start));
  assert.ok(body.indexOf("H1_PENDING_PREFIX") < body.indexOf("enqueueH1Room(env, candleKey)"), "parked first, then the room");
  assert.match(source, /task\.kind === "h1_room"\) return processH1RoomTask\(env, task\)/);
});
