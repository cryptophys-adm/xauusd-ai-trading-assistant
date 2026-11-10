import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  witnessCards, quorumOf, guardrailsFor, tradeFor, validateCouncil, decide, assess, buildDecisionRecord, councilEvidence, councilMessages,
  runDecisionEngine, runPendingDecision, readLatestDecision, readDecisions, decisionKeyFor, keyCloseMs, notifyDecision, decisionMessage,
  resetDecisionSchemaCacheForTests, decisionEngineEnabled, WITNESS_WEIGHTS, DECISION_LATEST_KEY
} from "../src/decision-engine.mjs";
import { sessionAt, regimeOf, macroDriversOf, sentimentOf, contextCautions, marketContextOf } from "../src/decision-engine.mjs";
import { eaSignalFromDecision } from "../src/ea-signal.mjs";
import { ingestDecision, ensureLedgerSchema, resetLedgerSchemaCacheForTests, SOURCES } from "../src/signal-ledger.mjs";

const CLOSE = "2026-11-09T13:15:00.000Z";
const NOW = Date.parse(CLOSE) + 70_000;

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
const row = (key, lean, action = "WAIT", over = {}) => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false, ...over });
function globalOf(over = {}) {
  return {
    timeframes: [
      row("D1", 0.5), row("H4", 0.4), row("H1", 0.3), row("M15", 0.35, "BUY"), row("NEWS", 0.2), row("MACRO", 0.1),
      ...[]
    ].map((r) => ({ ...r, ...(over[r.key] || {}) }))
  };
}
// Price 4000, 1H ATR 10: support 3995–3998 (at the level for a long), resistance 4030–4032 and 4050.
const ZONES = [
  { low: 3995, high: 3998, price: 3996.5, candidate: true, label: "S1" },
  { low: 3980, high: 3980, price: 3980, candidate: true, label: "S2" },
  { low: 4030, high: 4032, price: 4031, candidate: true, label: "R1" },
  { low: 4050, high: 4050, price: 4050, candidate: true, label: "R2" }
];
const STRATEGY = { decision: "WAIT", state: "SETUP_READY", direction: "LONG", confidence: 0.6, alignment: 0.5, headline: "The long setup is ready.", price: 4000, atr_h1: 10, key_levels: { zones: ZONES }, plan: { at_level: true } };
const loadedOf = (over = {}) => ({ inputs: { calendar: { events: [] } }, strategy: STRATEGY, global: globalOf(over.global), correlations: null, regime: "normal-trending", ...over.loaded });

test("witnesses: every room, the news, the macro room and the strategy, weighted; stale ones drop out", () => {
  const cards = witnessCards({ global: globalOf(), strategy: STRATEGY });
  assert.deepEqual(cards.map((c) => c.key), ["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY"]);
  assert.equal(Object.values(WITNESS_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), "1.000000");
  assert.equal(cards.at(-1).lean, 0.6, "the strategy leans its direction by its confidence");
  const q = quorumOf(cards, { now: NOW });
  assert.equal(q.long_share, 1, "all directional witnesses lean bullish (G-06: neutral excluded from denominator)");
  assert.equal(q.short_share, 0);
  const stale = quorumOf(witnessCards({ global: globalOf({ D1: { stale: true }, H4: { available: false, lean: null } }), strategy: STRATEGY }), { now: NOW });
  assert.equal(stale.weight, 0.6, "a stale or missing witness drops out and the rest renormalise");
  assert.equal(quorumOf([]).score, null);
});

test("guardrails: the long passes; the short fails quorum and confirmation; stale rooms and vetoes block", () => {
  const { guards } = assess(loadedOf(), { now: NOW });
  assert.equal(guards.long.allowed, true, JSON.stringify(guards.long.checks));
  assert.deepEqual(guards.long.checks.map((c) => c.id), ["market_open", "fresh", "quorum", "confirmation", "no_veto", "levels", "reward"]);
  assert.equal(guards.long.plan.entry, 4000);
  assert.equal(guards.short.allowed, false);
  assert.deepEqual(guards.short.checks.filter((c) => !c.pass).map((c) => c.id), ["quorum", "confirmation"]);
  const stale = assess(loadedOf({ global: { M15: { stale: true } } }), { now: NOW }).guards.long;
  assert.equal(stale.checks.find((c) => c.id === "fresh").pass, false, "a stale 15m room never trades");
  const noConfirm = assess(loadedOf({ global: { M15: { action: "WAIT" } } }), { now: NOW }).guards.long;
  assert.equal(noConfirm.checks.find((c) => c.id === "confirmation").pass, false, "a bias alone is no entry");
  const confirm5m = assess(loadedOf({ global: { M15: { action: "WAIT" } }, loaded: { inputs: { calendar: { events: [] }, confirmations: { m5_prophet_r38: { verified: true, buy_confirmed: true } } } } }), { now: NOW }).guards.long;
  assert.equal(confirm5m.checks.find((c) => c.id === "confirmation").pass, true, "a verified 5m confirmation counts");
  const veto = assess(loadedOf({ loaded: { inputs: { calendar: { events: [] }, h1Snapshot: { huds: { prophet: { fields: { t_enc: 4 } } } } } } }), { now: NOW }).guards.long;
  assert.equal(veto.allowed, false, "a strategy veto blocks the side");
  const noLevels = assess(loadedOf({ loaded: { strategy: { ...STRATEGY, atr_h1: null } } }), { now: NOW }).guards.long;
  assert.deepEqual(noLevels.checks.filter((c) => !c.pass).map((c) => c.id), ["levels", "reward"], "no price without a key-level plan");
});

test("the trade: market only at the level, a limit at the pullback otherwise; the target must pay 1.5R", () => {
  const { guards } = assess(loadedOf(), { now: NOW });
  const long = tradeFor("BUY", guards.long.plan, { entryType: "market", target: "tp1" });
  assert.deepEqual([long.action, long.entry, long.stop, long.target, long.tp], ["ENTER_MARKET", 4000, 3993, "tp1", 4030]);
  const short = tradeFor("SELL", guards.short.plan, { entryType: "market", target: "tp1" });
  assert.equal(short.action, "ENTER_LIMIT", "away from the level: a limit at the planned pullback");
  assert.equal(short.target, "tp2", "TP1 pays under 1.5R, so the other target");
  assert.ok(short.rrr >= 1.5);
  assert.equal(tradeFor("BUY", { ...guards.long.plan, rrr: { tp1: 1, tp2: 1.2 } }), null);
});

test("the council answer: validated in plain words; guardrails overrule it; the fallback decides without it", () => {
  const ok = { stance: "buy", bias: "bullish", confidence: 0.66, entry_type: "market", target: "tp2", summary: "Decision BUY, bias bullish: the higher rooms and the 15m room agree at support.", reasons: ["Every room leans up."], risks: ["A late reversal at resistance."], weighed: ["d1", "m15", "nobody"] };
  assert.deepEqual(validateCouncil(ok), { valid: true, errors: [] });
  assert.equal(ok.stance, "BUY");
  assert.deepEqual(ok.weighed, ["D1", "M15"]);
  assert.ok(validateCouncil({ ...ok, summary: "buy_confirmed is true" }).errors.includes("not_natural_language:field_name"));
  assert.ok(validateCouncil({ ...ok, stance: "HOLD" }).errors.includes("stance_invalid"));
  const { guards, quorum } = assess(loadedOf(), { now: NOW });
  const buy = decide({ answer: ok, guards, strategy: STRATEGY, quorum });
  assert.equal(buy.stance, "BUY");
  assert.equal(buy.trade.target, "tp2");
  const sell = decide({ answer: { ...ok, stance: "SELL" }, guards, strategy: STRATEGY, quorum });
  assert.equal(sell.stance, "WAIT", "the council cannot break the guardrails");
  assert.equal(sell.overruled.wanted, "SELL");
  assert.deepEqual(sell.overruled.failed.map((f) => f.check), ["quorum", "confirmation"]);
  assert.equal(decide({ answer: { ...ok, confidence: 0.3 }, guards, strategy: STRATEGY, quorum }).stance, "WAIT", "below the confidence floor");
  assert.equal(decide({ answer: null, guards, strategy: STRATEGY, quorum }).stance, "WAIT", "fallback: the strategy said WAIT");
  const fb = decide({ answer: null, guards, strategy: { ...STRATEGY, decision: "BUY" }, quorum });
  assert.deepEqual([fb.stance, fb.source], ["BUY", "fallback"], "fallback: the strategy's BUY passes every guardrail");
});

test("the evidence carries both sides' plans; the prompt names the guardrails; the record keeps no size", () => {
  const loaded = loadedOf();
  const a = assess(loaded, { now: NOW });
  const ev = councilEvidence({ barClose: CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards, context: {} });
  assert.equal(ev.long.allowed, true);
  assert.equal(ev.long.plan.entry, 4000);
  assert.equal(ev.witnesses.length, 7);
  const text = councilMessages(ev).map((m) => m.content).join("\n");
  assert.match(text, /only when long\.allowed is true/);
  assert.equal(ev.quorum.bullish_share, 1);
  assert.equal(ev.quorum.share_needed_above, 0.5);
  assert.match(text, /weighted_lean is the strength/, "production 13:15: the lean is never read as the quorum");
  const rec = buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, assessment: a, now: NOW });
  assert.equal(rec.source, "fallback");
  assert.match(rec.summary, /^Decision WAIT, bias bullish/);
  assert.doesNotMatch(JSON.stringify(rec), /lot|position_size|volume/i);
});

function aiAnswering(answer) {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, text: request.messages.map((m) => m.content).join("\n") });
      return { choices: [{ message: { content: typeof answer === "function" ? answer(calls.length) : JSON.stringify(answer) }, finish_reason: "stop" }], usage: { total_tokens: 30 } };
    }
  };
}
const BUY_ANSWER = { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "market", target: "tp1", summary: "Decision BUY, bias bullish: every room leans up and the 15m room confirmed at support.", reasons: ["The daily and four-hour rooms lean bullish."], risks: [], weighed: ["D1", "H4", "M15"] };

test("one decision per 15m bar: stored in D1 and KV, sent once, recorded in the ledger once", async () => {
  resetDecisionSchemaCacheForTests(); resetLedgerSchemaCacheForTests();
  const env = { DB: fakeD1(), SIGNAL_CACHE: kv(), AI: aiAnswering(BUY_ANSWER), MODEL_RATE_LIMIT_RETRY_MS: "0" };
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const recordSignal = async (d) => { await ensureLedgerSchema(env.DB); return ingestDecision(env, d, { now: NOW }); };
  const r = await runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW, send, recordSignal, loaded: loadedOf() });
  assert.equal(r.status, "decided", JSON.stringify(r));
  assert.deepEqual([r.stance, r.source, r.ledger], ["BUY", "council", 1]);
  assert.equal(r.decision_key, "OANDA:XAUUSD:15:" + (Date.parse(CLOSE) - 900_000));
  assert.equal(r.latency_seconds, 70);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /DECISION ENGINE · BUY/);
  assert.match(sent[0], /Market BUY at 4000\.00, stop 3993\.00, target TP1 4030\.00/);
  assert.equal(env.AI.calls.length, 1, "one council call");
  assert.match(env.AI.calls[0].text, /AI Decision Council/);
  const again = await runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW, send, recordSignal, loaded: loadedOf() });
  assert.equal(again.status, "already_decided");
  assert.equal(env.AI.calls.length, 1, "a decided bar never spends again");
  const latest = await readLatestDecision(env);
  assert.equal(latest.stance, "BUY");
  assert.ok(env.SIGNAL_CACHE.m.has(DECISION_LATEST_KEY));
  // The next bar, still BUY: decided, not sent again, not a second ledger row while the first is open.
  const next = "2026-11-09T13:30:00.000Z";
  const r2 = await runDecisionEngine(env, { barClose: next, now: Date.parse(next) + 60_000, clock: () => Date.parse(next) + 60_000, send, recordSignal, loaded: loadedOf() });
  assert.deepEqual([r2.stance, r2.telegram.sent, r2.ledger], ["BUY", false, 0]);
  assert.equal((await readDecisions(env)).length, 2);
  assert.ok(SOURCES.includes("decision"));
  const rows = env.DB.raw.prepare("SELECT source, side, entry, stop, tp1, tp2 FROM signal_ledger").all();
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ source: "decision", side: "BUY", entry: 4000, stop: 3993, tp1: 4030, tp2: 4050 }]);
});

test("a model failure or an invalid answer falls back; a plain-words slip gets one correction", async () => {
  resetDecisionSchemaCacheForTests();
  const failing = { DB: fakeD1(), SIGNAL_CACHE: kv(), AI: { run: async () => { throw new Error("model down"); } }, MODEL_RATE_LIMIT_RETRY_MS: "0" };
  const r = await runDecisionEngine(failing, { barClose: CLOSE, now: NOW, clock: () => NOW, loaded: loadedOf() });
  assert.deepEqual([r.status, r.source, r.stance], ["decided", "fallback", "WAIT"]);
  assert.match((await readLatestDecision(failing)).council_note, /model failed/);
  resetDecisionSchemaCacheForTests();
  const slip = aiAnswering((n) => JSON.stringify(n === 1 ? { ...BUY_ANSWER, summary: "buy_confirmed fired" } : BUY_ANSWER));
  const env = { DB: fakeD1(), SIGNAL_CACHE: kv(), AI: slip, MODEL_RATE_LIMIT_RETRY_MS: "0" };
  const r2 = await runDecisionEngine(env, { barClose: CLOSE, now: NOW, clock: () => NOW, loaded: loadedOf() });
  assert.deepEqual([r2.source, r2.stance], ["council", "BUY"]);
  assert.equal(slip.calls.length, 2);
  assert.match(slip.calls[1].text, /reads like code/);
});

test("the kill switch, the sweep fallback and the weekend", async () => {
  assert.equal(decisionEngineEnabled({}), true, "on by default (owner: switch now)");
  assert.equal(decisionEngineEnabled({ DECISION_ENGINE: "off" }), false);
  assert.deepEqual(await runDecisionEngine({ DECISION_ENGINE: "off" }, { barClose: CLOSE }), { status: "disabled" });
  assert.deepEqual(await runPendingDecision({ DB: fakeD1() }, { now: Date.parse(CLOSE) + 60_000 }), { status: "too_soon" });
  assert.deepEqual(await runPendingDecision({ DB: fakeD1() }, { now: Date.parse("2026-11-07T12:10:00Z") }), { status: "market_closed" }, "Saturday");
  resetDecisionSchemaCacheForTests();
  const env = { DB: fakeD1(), SIGNAL_CACHE: kv() };
  const r = await runPendingDecision(env, { now: Date.parse(CLOSE) + 10 * 60_000, loaded: loadedOf() });
  assert.equal(r.status, "decided", "the sweep decides a bar the 15m room did not");
  assert.equal(r.source, "fallback", "no model binding");
  assert.equal(decisionKeyFor("2026-11-09T13:15:30Z"), "OANDA:XAUUSD:15:" + Date.parse("2026-11-09T13:00:00Z"));
  assert.equal(keyCloseMs(decisionKeyFor(CLOSE)), Date.parse(CLOSE));
});

test("Telegram: a new stance is sent, the same stance on the next bar is not; WAIT after WAIT never", async () => {
  const env = { SIGNAL_CACHE: kv() };
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const d = (key, stance) => ({ decision_key: key, stance, bias: "BULLISH", confidence: 0.5, source: "council", bar_close: CLOSE, summary: `Decision ${stance}.`, trade: null, overruled: null });
  assert.equal((await notifyDecision(env, d("a", "WAIT"), send)).sent, false, "the first WAIT is not sent");
  assert.equal((await notifyDecision(env, d("b", "BUY"), send)).sent, true);
  assert.equal((await notifyDecision(env, d("c", "BUY"), send)).sent, false);
  assert.equal((await notifyDecision(env, d("c", "BUY"), send)).reason, "already_handled");
  assert.equal((await notifyDecision(env, d("d", "WAIT"), send)).sent, true, "BUY -> WAIT is a change");
  assert.equal(sent.length, 2);
  assert.match(decisionMessage({ ...d("e", "WAIT"), overruled: { wanted: "SELL", failed: [{ check: "quorum" }] } }), /Guardrail: SELL held back \(quorum\)/);
});

test("the EA signal from the decision: the chosen target, issued at the 15m close, expiring at the next", () => {
  const key = decisionKeyFor(CLOSE);
  const trade = { side: "BUY", action: "ENTER_MARKET", entry: 4000, stop: 3993, target: "tp2", tp: 4050, tp1: 4030, tp2: 4050, rrr: 7.14 };
  const s = eaSignalFromDecision({ decision: { decision_key: key, stance: "BUY", confidence: 0.7, trade }, now: NOW });
  assert.deepEqual([s.signal_id, s.side, s.action, s.entry, s.stop, s.tp1], [key, "BUY", "ENTER_MARKET", 4000, 3993, 4050]);
  assert.equal(s.issued_ms, Date.parse(CLOSE));
  assert.equal(s.expires_ms, Date.parse(CLOSE) + 900_000);
  assert.ok(Object.values(s).every((v) => ["string", "number", "boolean"].includes(typeof v)), "flat");
  assert.equal(eaSignalFromDecision({ decision: { decision_key: key, stance: "WAIT", trade: null } }).side, "NONE");
  assert.equal(eaSignalFromDecision({ decision: { decision_key: key, stance: "BUY", trade: { ...trade, stop: 4010 } } }).side, "NONE", "levels on the wrong side are never sent");
  assert.equal(eaSignalFromDecision({ decision: null }).side, "NONE");
});

test("the market context: the session with day, date and market state; regime; macro drivers; sentiment", () => {
  const mon = sessionAt(Date.parse("2026-11-09T13:20:00Z"));
  assert.deepEqual([mon.day, mon.date, mon.market_open, mon.liquidity], ["Monday", "2026-11-09", true, "high"]);
  assert.deepEqual(mon.active, ["London", "New York"]);
  assert.deepEqual([mon.next_change.to, mon.next_change.at], ["closed", "2026-11-13T22:00:00.000Z"], "the weekly close, Friday 22:00 UTC");
  const sat = sessionAt(Date.parse("2026-11-07T10:00:00Z"));
  assert.deepEqual([sat.day, sat.market_open, sat.liquidity, sat.next_change.at], ["Saturday", false, "closed", "2026-11-08T22:00:00.000Z"]);
  assert.equal(sessionAt(Date.parse("2026-11-09T22:30:00Z")).liquidity, "thin", "after New York, before Tokyo");
  const reg = regimeOf({ huds: { prophet: { fields: { hurst: 0.7, efficiency_ratio: 0.6, kww_zscore: 2.8 } }, kinetic_engine: { fields: { is_chaos: false, entropy: 0.4 } } } }, "high-trending");
  assert.deepEqual([reg.label, reg.character, reg.chaos, reg.stretch_z], ["high-trending", "trending", false, 2.8]);
  assert.equal(regimeOf(null).character, null);
  const macro = macroDriversOf({ gold: { change_24h_percent: 0.8 }, dollar: { change_24h_percent: -0.42 }, oil: { change_24h_percent: 1.1 } });
  assert.deepEqual(macro.change_24h_percent, { gold: 0.8, dollar: -0.42, oil: 1.1, usdt_dominance: null });
  assert.equal(macro.gold_dollar_link, "inverse (usual)");
  assert.equal(macro.lean, 0.84, "a falling dollar pulls gold up");
  assert.deepEqual(sentimentOf({ quorum: { score: 0.42, bias: "BULLISH" }, news: { counts: { bullish: 5, bearish: 2 } } }).headlines, { bullish: 5, bearish: 2, neutral: 0 });
  const fri = { session: sessionAt(Date.parse("2026-11-13T21:00:00Z")), regime: { h1: { stretch_z: -2.6 } }, macro_drivers: macroDriversOf({ dollar: { change_24h_percent: -0.42 } }) };
  const cautions = contextCautions(-1, fri);
  assert.equal(cautions.length, 3, JSON.stringify(cautions));
  assert.match(cautions.join(" | "), /closes for the weekend in 60 minutes/);
  assert.match(cautions.join(" | "), /stretched 2\.6 standard deviations below/);
  assert.match(cautions.join(" | "), /dollar fell 0\.42%/);
  assert.deepEqual(contextCautions(1, { session: mon, regime: { h1: { stretch_z: -2.6 } }, macro_drivers: macro }), [], "with the trade: no caution");
});

test("a closed market never trades; the record and the council carry the market context", () => {
  const loaded = loadedOf();
  const a = assess(loaded, { now: Date.parse("2026-11-07T10:00:00Z") });
  assert.equal(a.guards.long.allowed, false);
  assert.match(a.guards.long.checks[0].detail, /Saturday 2026-11-07 10:00 UTC: the market is closed/);
  const open = assess(loaded, { now: NOW });
  assert.deepEqual(Object.keys(open.market), ["sentiment", "regime", "macro_drivers", "session"]);
  const rec = buildDecisionRecord({ key: decisionKeyFor(CLOSE), barClose: CLOSE, loaded, assessment: open, now: NOW });
  assert.equal(rec.context.market.session.day, "Monday");
  assert.ok(rec.context.market.sentiment && rec.context.market.regime && rec.context.market.macro_drivers);
  const text = councilMessages(councilEvidence({ barClose: CLOSE, cards: open.cards, quorum: open.quorum, guards: open.guards, context: rec.context })).map((m) => m.content).join("\n");
  assert.match(text, /macro drivers/);
  assert.match(text, /"session":\{"day":"Monday"/);
  assert.equal(marketContextOf(loaded, open.quorum, NOW).session.market_open, true);
  const weighted = witnessCards({ global: globalOf(), strategy: STRATEGY, context: { session: sessionAt(NOW), macroLean: 0.84 }, env: { GLOBAL_DECISION_WEIGHTED: "true" } });
  assert.match(weighted.find((c) => c.key === "SESSION").summary, /^Monday 2026-11-09 13:16 UTC, market open, London and New York \(high liquidity\)/);
  assert.equal(weighted.find((c) => c.key === "MACRO_DRIVERS").lean, 0.84);
});
