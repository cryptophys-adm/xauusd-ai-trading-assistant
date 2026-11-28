// CR1 (src/council-conf-retry.mjs): the decision council's missing-confidence WAIT. No network: the model is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONF_RETRY_DAILY_CAP, CONF_DOCTRINE_NOTE, CONF_RETRY_NOTE, councilConfRetryMode, citesMissingConfidence, confRetryNeeded, takeConfRetry, confRetryCount, confRetryKey, confRetryRecord
} from "../src/council-conf-retry.mjs";
import { askCouncil, councilEvidence, buildDecisionRecord, decisionKeyFor } from "../src/decision-engine.mjs";
import { formatDoctrineDirectives, CANON_DOCTRINE_RULES } from "../src/doctrine-consumer.mjs";
import { switchByKey, readSwitch } from "../src/feature-switches.mjs";

const CLOSE = "2026-11-27T19:30:00.000Z", NOW = Date.parse(CLOSE) + 70_000;
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
// The 27 Nov 19:30Z answer's shape (words as the council wrote them, no price).
const MISSING = { stance: "WAIT", bias: "BULLISH", confidence: 0, entry_type: "limit", target: "tp1", summary: "Decision WAIT, bias bullish: the long side passes the quorum and guardrails, but the required confidence metric is missing, and the entry trigger has not fired yet.", reasons: ["Long guardrails pass, but no confidence value is supplied, so the engine cannot meet the minimum 0.4 confidence requirement."], risks: [], weighed: ["H1", "M15"] };
const BUY = { stance: "BUY", bias: "BULLISH", confidence: 0.62, entry_type: "limit", target: "tp1", summary: "Decision BUY, bias bullish: the long side passes every guardrail and the rooms lean up.", reasons: ["The 15m and 1H rooms lean bullish."], risks: [], weighed: ["H1", "M15"] };
const WAIT_OWN = { ...MISSING, confidence: 0.55, summary: "Decision WAIT, bias bullish: the entry trigger has not fired yet.", reasons: ["The verified 5-minute confirmation has not fired."] };
const evidenceOf = (longAllowed = true) => councilEvidence({ barClose: CLOSE, cards: [], quorum: { lean: 0.3, weight: 1 }, guards: { long: { allowed: longAllowed, checks: [] }, short: { allowed: false, checks: [] } }, context: {} });
const model = (answers) => { const calls = []; return { calls, run: async (_m, request) => { calls.push(request.messages); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return { choices: [{ message: { content: JSON.stringify(a) }, finish_reason: "stop" }] }; } }; };

test("CR-1 the diagnosis: the missing-confidence wordings of the 27 Nov WAITs are recognised; a WAIT with its own reason is not", () => {
  for (const t of [
    "Long guardrails pass, but no confidence value is supplied, so the engine cannot meet the minimum 0.4 confidence requirement.",
    "The confidence guardrail is not satisfied – no confidence value is supplied.",
    "The overall confidence required by the engine (≥ 0.4) is missing from the evidence, so the confidence check fails.",
    "Long guardrails pass, yet the Decision Engine requires an explicit confidence ≥ 0.4 and none is provided.",
    "The confidence metric required by the engine is not provided, so the confidence guardrail fails.",
    "The system lacks an explicit confidence value, which is required to pass the confidence guardrail.",
    "The confidence check is absent, which the engine requires (minimum 0.4) before issuing a BUY."
  ]) assert.equal(citesMissingConfidence({ reasons: [t] }), true, t);
  for (const t of ["The verified 5-minute confirmation has not fired.", "Cautions lower my confidence: the regime is chaotic.", "Confidence is moderate because the rooms disagree."]) assert.equal(citesMissingConfidence({ reasons: [t] }), false, t);
  assert.equal(confRetryNeeded(MISSING, evidenceOf(true)), true);
  assert.equal(confRetryNeeded({ ...MISSING, reasons: ["The trigger has not fired."], summary: "Decision WAIT, bias bullish: wait." }, evidenceOf(true)), true, "confidence 0 alone");
  assert.equal(confRetryNeeded(MISSING, evidenceOf(false)), false, "no side passes: the guardrails decide, never a retry");
  assert.equal(confRetryNeeded(WAIT_OWN, evidenceOf(true)), false, "a WAIT with its own confidence and reason");
  assert.equal(confRetryNeeded(BUY, evidenceOf(true)), false);
  assert.deepEqual(confRetryRecord(MISSING, BUY), { first: { stance: "WAIT", confidence: 0 }, second: { stance: "BUY", confidence: 0.62 } });
  assert.deepEqual(confRetryRecord(MISSING, null).second, null);
});

test("CR-2 the doctrine line: only for the council, only after engine_thresholds, only while on", () => {
  const on = formatDoctrineDirectives(CANON_DOCTRINE_RULES, { role: "council", confNote: true });
  const off = formatDoctrineDirectives(CANON_DOCTRINE_RULES, { role: "council" });
  const lines = on.split("\n");
  assert.equal(lines[lines.findIndex((l) => l.startsWith("- engine_thresholds:")) + 1], CONF_DOCTRINE_NOTE);
  assert.equal(on.replace(`\n${CONF_DOCTRINE_NOTE}`, ""), off, "nothing else changes; the canon text is as it is");
  assert.equal(formatDoctrineDirectives(CANON_DOCTRINE_RULES, { role: "room", confNote: true }).includes(CONF_DOCTRINE_NOTE), false);
  assert.match(CONF_RETRY_NOTE, /no confidence value is given to you and none is missing/);
  assert.doesNotMatch(CONF_RETRY_NOTE + CONF_DOCTRINE_NOTE, /\d{3,}/, "no price");
});

test("CR-3 on: a missing-confidence WAIT is asked once more with the correction; the second answer is the answer and the record carries conf_retry", async () => {
  const ai = model([MISSING, BUY]);
  const env = { AI: ai, MODEL_RATE_LIMIT_RETRY_MS: "0", COUNCIL_CONF_RETRY: "on", SIGNAL_CACHE: kv() };
  let t = NOW;
  const r = await askCouncil(env, evidenceOf(true), { clock: () => t });
  assert.equal(ai.calls.length, 2);
  assert.deepEqual(ai.calls[1].at(-1), { role: "user", content: CONF_RETRY_NOTE });
  assert.equal(ai.calls[1].at(-2).role, "assistant");
  assert.deepEqual([r.answer.stance, r.answer.confidence], ["BUY", 0.62]);
  assert.deepEqual(r.conf_retry, { first: { stance: "WAIT", confidence: 0 }, second: { stance: "BUY", confidence: 0.62 } });
  assert.equal(await confRetryCount(env, { now: t }), 1);
  // The record keeps the trace; a decision without a retry has none.
  const loaded = { inputs: {}, strategy: null, global: { timeframes: [] } };
  const rec = buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, council: r, now: NOW });
  assert.deepEqual(rec.conf_retry, r.conf_retry);
  assert.equal("conf_retry" in buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, council: { answer: WAIT_OWN }, now: NOW }), false);
  // A second answer that is still a missing-confidence WAIT stands as the answer; it is never asked a third time.
  const twice = model([MISSING, MISSING, BUY]);
  const r2 = await askCouncil({ ...env, AI: twice }, evidenceOf(true), { clock: () => t });
  assert.deepEqual([twice.calls.length, r2.answer.stance, r2.conf_retry.second.stance], [2, "WAIT", "WAIT"]);
  // An invalid second answer: the first stands, recorded with second null.
  const broken = model([MISSING, { stance: "MAYBE" }]);
  const r3 = await askCouncil({ ...env, AI: broken }, evidenceOf(true), { clock: () => t });
  assert.deepEqual([broken.calls.length, r3.answer.stance, r3.answer.confidence, r3.conf_retry.second], [2, "WAIT", 0, null]);
});

test("CR-4 no retry: off, no side passing, a WAIT with its own reason, the daily cap, an unreadable counter", async () => {
  const run = async (env, first, ev = evidenceOf(true)) => { const ai = model([first, BUY]); const r = await askCouncil({ MODEL_RATE_LIMIT_RETRY_MS: "0", SIGNAL_CACHE: kv(), ...env, AI: ai }, ev, { clock: () => NOW }); return [ai.calls.length, r.answer.stance, "conf_retry" in r]; };
  assert.deepEqual(await run({}, MISSING), [1, "WAIT", false], "off (the code default)");
  assert.deepEqual(await run({ COUNCIL_CONF_RETRY: "on" }, MISSING, evidenceOf(false)), [1, "WAIT", false]);
  assert.deepEqual(await run({ COUNCIL_CONF_RETRY: "on" }, WAIT_OWN), [1, "WAIT", false]);
  assert.deepEqual(await run({ COUNCIL_CONF_RETRY: "on" }, BUY), [1, "BUY", false]);
  const full = kv(); full.m.set(confRetryKey(NOW), String(CONF_RETRY_DAILY_CAP));
  assert.deepEqual(await run({ COUNCIL_CONF_RETRY: "on", SIGNAL_CACHE: full }, MISSING), [1, "WAIT", false], "20 a day");
  assert.deepEqual(await run({ COUNCIL_CONF_RETRY: "on", SIGNAL_CACHE: { get: async () => { throw new Error("kv"); }, put: async () => {} } }, MISSING), [1, "WAIT", false], "an unreadable counter: no retry");
  // The cap counts per UTC day.
  const c = kv();
  for (let i = 0; i < CONF_RETRY_DAILY_CAP; i++) assert.equal(await takeConfRetry({ SIGNAL_CACHE: c }, { now: NOW }), true);
  assert.equal(await takeConfRetry({ SIGNAL_CACHE: c }, { now: NOW }), false);
  assert.equal(await takeConfRetry({ SIGNAL_CACHE: c }, { now: NOW + 86_400_000 }), true, "the next UTC day");
  assert.equal(CONF_RETRY_DAILY_CAP, 20);
});

test("CR-5 the FS1 row and the accessor", () => {
  const e = switchByKey("COUNCIL_CONF_RETRY");
  assert.deepEqual([e.group, e.default_value, e.config_value, [...e.values]], ["agents", "off", "on", ["on", "off"]]);
  assert.deepEqual(["on", " ON ", "off", "x", undefined].map((v) => readSwitch(e, v)), ["on", "on", "off", "off", "off"]);
  assert.deepEqual(["on", " ON ", "off", "x", undefined].map((v) => councilConfRetryMode(v === undefined ? {} : { COUNCIL_CONF_RETRY: v })), ["on", "on", "off", "off", "off"]);
});

test("CR-6 a retried answer goes through every guardrail: a SELL on a side that fails stays WAIT (fail closed); the record keeps conf_retry", async () => {
  const { assess } = await import("../src/decision-engine.mjs");
  const C = "2026-11-27T12:15:00.000Z", N = Date.parse(C) + 60_000;
  const room = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: C, stale: false });
  const bars = Array.from({ length: 41 }, (_, i) => ({ open_time: new Date(Date.parse(C) - (41 - i) * 900_000).toISOString(), open: 4000, low: 3995, high: 4003, close: 4000 }));
  const loaded = {
    inputs: { calendar: { events: [] }, m15Bars: bars },
    strategy: { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones: [{ low: 3985, high: 3988, price: 3986.5, candidate: true }, { low: 4030, high: 4032, price: 4031, candidate: true }] }, plan: { at_level: true } },
    global: { timeframes: [room("D1", 0.5), room("H4", 0.4), room("H1", 0.3), room("M15", 0.35, "BUY"), room("NEWS", 0.2), room("MACRO", 0.1)] }, correlations: null, regime: "normal-trending"
  };
  const a = assess(loaded, { now: N, env: {} });
  assert.equal(a.guards.short.allowed, false, "the short side fails its guardrails here");
  const ev = councilEvidence({ barClose: C, cards: [], quorum: a.quorum, guards: a.guards, context: {} });
  assert.equal(confRetryNeeded(MISSING, ev), a.guards.long.allowed === true, "a retry needs a side that passes");
  // Whatever the second answer says, the guardrails decide: a SELL on the failing side is overruled to WAIT.
  const SELL = { ...BUY, stance: "SELL", bias: "BEARISH", summary: "Decision SELL, bias bearish: test." };
  const council = { answer: SELL, conf_retry: confRetryRecord(MISSING, SELL) };
  const rec = buildDecisionRecord({ key: decisionKeyFor(C), barClose: C, loaded, assessment: a, council, now: N, env: {} });
  assert.equal(rec.stance, "WAIT");
  assert.equal(rec.overruled?.by, "guardrail");
  assert.equal(rec.trade, null);
  assert.deepEqual(rec.conf_retry, { first: { stance: "WAIT", confidence: 0 }, second: { stance: "SELL", confidence: 0.62 } });
});
