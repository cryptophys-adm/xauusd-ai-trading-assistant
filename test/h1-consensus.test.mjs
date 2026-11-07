import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  H1_CONSENSUS_FALLBACK_MS, h1BarTimes, finalizeDue, consensusInput, reasonerLines, consensusGuard,
  emptyConsensusDecision, reasonerUnavailableDecision, consensusSummary
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

test("the Reasoner's prompt: it decides last, follows the consensus, and departs only for a veto", () => {
  const consensus = consensusInput(room({ status: "ok", stance: "WAIT", bias: "BULLISH", confidence: 0.6, summary: "s", reasons: ["r"], dissent: [] }));
  const lines = reasonerLines({ evidence: { candle_key: KEY }, consensus, laneRule: "LANES", decisionTextRule: "TEXT", tradePlanRule: "PLAN" });
  const text = lines.join("\n");
  assert.match(text, /You decide LAST, after the Consensus Discussion of the 1H War Room/);
  assert.match(text, /Never decide against the room's bias/);
  assert.match(text, /t_enc 4/);
  assert.match(text, /GMI conflict or a GMI gate of -1 lowers your confidence; it never vetoes on its own/);
  assert.ok(lines.includes("LANES") && lines.includes("TEXT") && lines.includes("PLAN"));
  assert.ok(lines.indexOf("CONSENSUS:") < lines.indexOf("EVIDENCE:"));
  assert.doesNotMatch(text, /ANALYST:|COUNSELOR:/, "the Analyst and the Counselor are retired");
  const partial = reasonerLines({ evidence: {}, consensus: consensusInput(room()), laneRule: "", decisionTextRule: "", tradePlanRule: "" }).join("\n");
  assert.match(partial, /did not conclude within 45 minutes of the close: 3 of 4 agents spoke/);
});

test("never against the room: a BUY against a bearish consensus becomes WAIT with prices cleared", () => {
  const bearish = consensusInput(room({ status: "ok", stance: "WAIT", bias: "BEARISH", confidence: 0.6, summary: "s", reasons: ["r"], dissent: [] }));
  const buy = { decision: "BUY", confidence: 0.7, entry_price: 4000, stop_loss: 3990, take_profit: 4030, risk_reward: 3, position_size_pct: null, reasoning: "Buy the dip.", trade_plan: { x: 1 } };
  const g = consensusGuard(buy, bearish);
  assert.equal(g.overridden, true);
  assert.equal(g.decision.decision, "WAIT");
  assert.equal(g.decision.entry_price, null);
  assert.equal(g.decision.trade_plan, null);
  assert.match(g.decision.reasoning, /^The 1H War Room's consensus is bearish, so a BUY against it is not taken/);
  const bullish = consensusInput(room({ status: "ok", stance: "WAIT", bias: "BULLISH", confidence: 0.6, summary: "s", reasons: ["r"], dissent: [] }));
  assert.equal(consensusGuard(buy, bullish).overridden, false, "with the room");
  assert.equal(consensusGuard({ ...buy, decision: "SELL" }, consensusInput(room({ status: "ok", stance: "BUY", bias: "NEUTRAL", confidence: 0.6, summary: "s", reasons: ["r"], dissent: [] }))).decision.decision, "WAIT", "against a concluded BUY");
  assert.equal(consensusGuard({ decision: "WAIT" }, bearish).overridden, false);
});

test("fail-closed decisions are plain WAITs without prices; the stored summary is compact", () => {
  for (const d of [emptyConsensusDecision(), reasonerUnavailableDecision()]) {
    assert.equal(d.decision, "WAIT");
    assert.equal(d.entry_price, null);
    assert.match(d.reasoning, /stays WAIT/);
  }
  const s = consensusSummary(consensusInput(room()), { overridden: true });
  assert.deepEqual(Object.keys(s), ["status", "bar_open", "agents_spoke", "roster_size", "room_bias", "conclusion", "guard_overridden"]);
  assert.equal(s.guard_overridden, true);
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
