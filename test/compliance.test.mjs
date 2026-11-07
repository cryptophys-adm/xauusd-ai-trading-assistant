import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { checkMessage, messageText, chartOfThread, runComplianceChecks, readCompliance, resetComplianceSchemaCacheForTests, CHECKS } from "../src/compliance.mjs";
import { buildDecisionCard, cardLeaks, sanitizeText, sessionOf, FORBIDDEN_KEYS } from "../src/decision-cards.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

const ids = (list) => list.map((v) => v.check).sort();

test("checks: order wording, stance against bias, calibration talk, field names and data scope", () => {
  assert.deepEqual(ids(checkMessage({ agent: "h1", stance: "WAIT", body: { bias: "BEARISH", claim: "No confirmation on this candle, so the room stays flat and waits." } })), []);
  assert.deepEqual(ids(checkMessage({ agent: "h1", stance: "BUY", body: { bias: "BEARISH", claim: "Place a buy limit with a 0.5 lot size." } })), ["order_wording", "stance_bias_conflict"]);
  assert.deepEqual(ids(checkMessage({ agent: "risk", stance: "WAIT", body: { bias: "NEUTRAL", argument: "The parity-verified momentum agrees." } })), ["calibration_talk"]);
  assert.deepEqual(ids(checkMessage({ agent: "technical", stance: "WAIT", body: { bias: "NEUTRAL", claim: "The gmi_dir is 1 and d_enc=2." } })), ["natural_language"]);
  assert.deepEqual(ids(checkMessage({ agent: "supertrend", stance: "WAIT", body: { bias: "BULLISH", claim: "Supertrend is bullish and the Decision Matrix agrees." } })), ["data_scope"]);
  assert.deepEqual(ids(checkMessage({ agent: "moderator", stance: "WAIT", body: { bias: "BULLISH", summary: "Supertrend and the Decision Matrix both lean bullish." } })), [], "only HUD and indicator agents are scoped");
  assert.deepEqual(ids(checkMessage({ agent: "supertrend", stance: "SELL", body: { bias: "BEARISH", claim: "Supertrend flipped bearish on this close." } })), [], "its own name is fine");
  assert.equal(messageText({ summary: "a", reasons: ["b", "c"] }), "a b c");
  assert.deepEqual(CHECKS, ["order_wording", "stance_bias_conflict", "calibration_talk", "natural_language", "data_scope"]);
  assert.equal(chartOfThread("warroom:2026-11-09"), "15");
  assert.equal(chartOfThread("tf:D1"), "1D");
  assert.equal(chartOfThread("news:1"), null);
});

test("the sweep checks each room message once and serves rule breaks per 100 messages", async () => {
  resetComplianceSchemaCacheForTests();
  const db = d1();
  const add = (thread, step, agent, stance, body, bar = "2026-11-09T10:00:00.000Z") => db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, bar_time, ts, stance, confidence, body_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 0.5, ?, 'ok')").run(thread, bar, step, agent, bar, bar, stance, JSON.stringify(body));
  add("tf:H1", "brief", "system", null, { candle_key: "k" });
  add("tf:H1", "open:h1", "h1", "WAIT", { bias: "NEUTRAL", claim: "Flat: nothing is confirmed." });
  add("tf:H1", "open:risk", "risk", "WAIT", { bias: "NEUTRAL", claim: "The verified volatility is high." });
  add("tf:H1", "conclusion", "moderator", "BUY", { bias: "BEARISH", summary: "Decision BUY, bias bearish." });
  add("news:1", "open:news", "news", "WAIT", { bias: "NEUTRAL", claim: "Use a lot size of one." });
  const env = { DB: db };
  const now = Date.parse("2026-11-09T12:00:00Z");
  const first = await runComplianceChecks(env, { now });
  assert.deepEqual([first.checked, first.violations], [3, 2], "the brief and the news thread are not room messages");
  const again = await runComplianceChecks(env, { now });
  assert.deepEqual([again.checked, again.violations], [0, 0], "each message once");
  const view = await readCompliance(env, { days: 7, now });
  assert.equal(view.total.messages, 3);
  assert.equal(view.total.violations, 2);
  const risk = view.agents.find((a) => a.agent === "risk");
  assert.equal(risk.rate_per_100, 100);
  assert.equal(risk.by_check.calibration_talk.count, 1);
});

test("decision cards carry no level, price, plan or size; agent text keeps no price-like number", () => {
  const thread = {
    bar_open: "2026-11-09T13:00:00.000Z", bar_close: "2026-11-09T14:00:00.000Z", candle_key: "OANDA:XAUUSD:60:1", reconvened: false,
    crowd: { weighted_bias: "BEARISH", disagreement: 0.4123, disagreeing_families: ["trend"], weighted_biases: { BEARISH: 0.6 } },
    confirmations: { chart_prophet_r38: { buy_confirmed: false, sell_confirmed: true, source: "the local record" } },
    reasoner_decision: { decision: "SELL", confidence: 0.62, entry_price: 4051.2, stop_loss: 4060, take_profit: 4030, trade_plan: { entry: 4051.2 } },
    conclusion: { stance: "SELL", bias: "BEARISH", confidence: 0.6, summary: "Decision SELL, bias bearish: price rejected 4078.50 twice and holds under 4,070." },
    openings: [{ id: "prophet", status: "ok", stance: "SELL", bias: "BEARISH", confidence: 0.7, claim: "Sell confirmed below 4051 with the stop above $4060." }],
    debate: [{ id: "prophet", status: "ok", stance: "SELL", bias: "BEARISH", confidence: 0.75 }],
    strategy: { plan: { entry: 4051, stop: 4060, tp1: 4030 } }, key_levels: [{ price: 4030 }]
  };
  const card = buildDecisionCard({ chart: "60", thread, outcomes: [{ subject: "agent:prophet", result: "hit", direction: -1 }], compliance: [{ agent: "risk", check_id: "calibration_talk", detail: "verified" }], parity: { prophet: "approved" } });
  assert.deepEqual(cardLeaks(card), []);
  assert.equal(card.h1.decision, "SELL");
  assert.equal(card.agents[0].confidence, 0.75, "the final stance after the Consensus Discussion");
  assert.match(card.agents[0].claim, /below \[level\] with the stop above \[level\]/);
  assert.deepEqual(card.confirmations, { "chart_prophet_r38.buy_confirmed": false, "chart_prophet_r38.sell_confirmed": true });
  assert.equal(card.crowd.disagreement, 0.41);
  assert.equal(card.outcomes["agent:prophet"].result, "hit");
  assert.equal(card.session, "new_york");
  assert.ok(cardLeaks({ ...card, h1: { entry_price: 1 } }).length, "the leak check catches a forbidden key");
  assert.ok(cardLeaks({ ...card, note: "at 4051" }).length, "and a price-like number");
  assert.ok(FORBIDDEN_KEYS.includes("trade_plan"));
  assert.equal(sanitizeText("Held 4,070 and 4078.5"), "Held [level] and [level]");
  assert.equal(sessionOf("2026-11-09T03:00:00Z"), "asia");
});
