// The Position Manager as the broker sees it (owner 2026-11-19, relayed: "prioritas perbaikan karena ini running
// live"): the Telegram line says what reached the broker, a dropped action says why, and every Omega position that
// leaves the book (the broker's take-profit and stop included) is said once with its reason, entry, exit and result.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { actionIdOfIntent, actionMessage, expireStalePositionActions, ensurePositionSchema, resetPositionSchemaCacheForTests, ACTION_TTL_MS } from "../src/position-actions.mjs";
import { positionManagerIntents, planIntents } from "../src/omega-engine.mjs";
import { exitReasonText, exitDealsToAnnounce, exitFacts, exitNoticeMessage, announceExits, EXIT_NOTICE_MAX_AGE_MS } from "../src/position-exit.mjs";
import { bridgeSync, writeSettings, resetOmegaBrokerSchemaForTests, escHtml } from "../src/omega-broker.mjs";
import { resetEaExecutionSchemaForTests } from "../src/ea-execution.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const sym = (bid, extra = {}) => ({ bid, ask: bid + 0.2, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0, ...extra });
const pos = (over = {}) => ({ ticket: 101, side: "SELL", open_price: 3880, sl: 3890, tp: 3870, volume: 0.01, intent_id: "open:1:S", magic: 20251109, comment: "omega", ...over });

test("PB1. a Position Manager intent id maps back to its stored action; any other id does not", () => {
  assert.equal(actionIdOfIntent("pm:101:c:7000"), "pm:101:7000");
  assert.equal(actionIdOfIntent("pm:101:t:7000:2"), "pm:101:7000", "an attempt suffix");
  assert.equal(actionIdOfIntent("d:pm:101:s:7000"), "pm:101:7000", "a delegated position's intent");
  for (const id of ["open:1:S", "cl:101:rev", "ms:101:k:388000", "pm:101:7000", "pm:x:c:1", null]) assert.equal(actionIdOfIntent(id), null, String(id));
});

test("PB2. every action that becomes no intent says why", () => {
  const positions = [pos()];
  const run = (a, s = sym(3876.1), skip = []) => positionManagerIntents({ positions, sym: s, actions: [{ id: "pm:101:1", ticket: 101, rule: "x", ...a }], skipTickets: skip }).dropped.map((d) => d.reason);
  assert.deepEqual(run({ action: "sl", sl: 3895 }), ["the stop is already at or beyond 3895"]);
  assert.deepEqual(run({ action: "sl", sl: 3881 }, sym(3882)), ["the live price leaves no room for a stop at 3881"]);
  assert.match(run({ action: "tp", tp: 3875 })[0], /^a target at 3875 is not further out than the broker's \(3870\)$/);
  assert.deepEqual(run({ action: "close" }, sym(3876.1), [101]), ["another close of this position comes first"]);
  assert.deepEqual(positionManagerIntents({ positions, sym: sym(3876.1), actions: [{ id: "pm:999:1", ticket: 999, action: "close", rule: "cut_loss" }] }).dropped, [{ id: "pm:999:1", reason: "the position is no longer open" }]);
  assert.deepEqual(positionManagerIntents({ positions, sym: {}, actions: [{ id: "pm:101:1", ticket: 101, action: "close" }] }).dropped.map((d) => d.reason), ["no live price from the terminal"]);
  assert.deepEqual(run({ action: "tp", tp: 3862 }), [], "out to TP2: an intent, nothing dropped");
});

test("PB3. under the TP ladder, the held TP2 is a dropped action with its reason (ADR-0020 Amendment 4)", () => {
  const executor = { connected: true, received_ms: 1_000, positions: [pos()], account: { trade_mode: "demo" }, symbol: sym(3876.1) };
  const plan = planIntents({ executor, now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: true }, pmActions: [{ id: "pm:101:7001", ticket: 101, action: "tp", rule: "tp2_target", tp: 3862 }] });
  assert.ok(!plan.intents.some((i) => i.kind === "modify_tp" && String(i.id).startsWith("pm:")));
  assert.deepEqual(plan.pm_dropped, [{ id: "pm:101:7001", reason: "the TP ladder holds the target until the stop locks TP1 (ADR-0020 Amendment 4)" }]);
  // Every plan carries the list, an early stop too.
  assert.deepEqual(planIntents({ executor: null, engineEnabled: true, settings: { enabled: true } }).pm_dropped, []);
});

test("PB4. a pending action older than its time to live is expired once and returned for its line", async () => {
  resetPositionSchemaCacheForTests();
  const db = d1();
  await ensurePositionSchema(db);
  const now = 10_000_000;
  const ins = (id, at, status = "pending") => db.raw.prepare("INSERT INTO position_actions (id, ticket, bar, at_ms, side, pips, action, rule, why, status) VALUES (?, 101, 1, ?, 'SELL', -31, 'close', 'cut_loss', 'cut', ?)").run(id, at, status);
  ins("pm:101:1", now - ACTION_TTL_MS - 1);
  ins("pm:101:2", now - 60_000);
  ins("pm:101:3", now - ACTION_TTL_MS - 1, "applied");
  assert.deepEqual((await expireStalePositionActions(db, { now })).map((r) => r.id), ["pm:101:1"]);
  assert.deepEqual(await expireStalePositionActions(db, { now }), [], "once");
  assert.equal(db.raw.prepare("SELECT status FROM position_actions WHERE id = 'pm:101:2'").get().status, "pending");
});

test("PB5. the exit's reason in plain words, from the deal and Omega's close", () => {
  assert.equal(exitReasonText("tp"), "take-profit hit at the broker");
  assert.equal(exitReasonText("sl", null, -10), "stop-loss hit at the broker");
  assert.equal(exitReasonText("sl", null, 3.2), "stop hit at the broker (a stop locked in profit)");
  assert.equal(exitReasonText("stop_out"), "stop-out by the broker (margin)");
  assert.equal(exitReasonText("manual"), "closed by hand in the terminal");
  assert.equal(exitReasonText("expert", "pm_cut_loss"), "closed by Omega: Position Manager: loss cut");
  assert.equal(exitReasonText("expert", "lean_flip"), "closed by Omega: the quorum's lean flipped");
  assert.equal(exitReasonText("expert", "ladder_tp3_close"), "closed by Omega: ladder tp3 close");
  assert.equal(exitReasonText("expert"), "closed by the EA");
});

test("PB6. which deals make a notice: new, recent, Omega's or delegated, and the position gone", () => {
  const now = 50_000_000;
  const deal = (over) => ({ deal_ticket: 1, position_ticket: 500, side: "SELL", source: "omega", closed_ms: now - 60_000, ...over });
  const pick = (deals, o = {}) => exitDealsToAnnounce(deals, { now, ...o }).map((d) => d.deal_ticket);
  assert.deepEqual(pick([deal()]), [1]);
  assert.deepEqual(pick([deal()], { openTickets: [500] }), [], "a partial exit: the position is still open");
  assert.deepEqual(pick([deal({ source: "manual" })]), [], "a manual position is not Omega's");
  assert.deepEqual(pick([deal({ source: "manual" })], { delegated: [500] }), [1], "unless it was delegated");
  assert.deepEqual(pick([deal({ closed_ms: now - EXIT_NOTICE_MAX_AGE_MS - 1 })]), [], "an old deal (a newly connected terminal's history) says nothing");
  assert.deepEqual(pick([deal(), deal({ deal_ticket: 2 })]), [1], "one notice a position");
  assert.equal(pick(Array.from({ length: 9 }, (_, i) => deal({ deal_ticket: i + 1, position_ticket: 600 + i }))).length, 5, "at most five a sync");
});

test("PB7. the notice: reason, entry, exit, pips and the result over all the position's exits; HTML-safe; no account number", async () => {
  const x = exitFacts({ deal_ticket: 357444852, position_ticket: 363035250, side: "SELL", volume: 0.01, entry_price: 3700.86, exit_price: 3696.29, profit: 4.57, commission: 0, swap: 0, reason: "tp", source: "omega", currency: "USD", closed_ms: 1 });
  assert.deepEqual([x.pips, x.profit, x.net, x.reason], [45.7, 4.57, 4.57, "take-profit hit at the broker"]);
  const msg = exitNoticeMessage(x, "Broker <DEMO> · GOLD");
  assert.match(msg, /^💰 <b>Omega Position Closed · Broker &lt;DEMO&gt; · GOLD<\/b>/);
  assert.match(msg, /Ticket: <code>#363035250<\/code> SELL · <code>0\.01<\/code> lot/);
  assert.match(msg, /Reason: <b>take-profit hit at the broker<\/b>/);
  assert.match(msg, /Entry: <code>3700\.86<\/code> → Exit: <code>3696\.29<\/code> \(\+45\.7 pips\)/);
  assert.match(msg, /Result: <code>\+4\.57 USD<\/code>$/);
  const loss = exitFacts({ deal_ticket: 2, position_ticket: 9, side: "BUY", volume: 0.02, entry_price: 3700, exit_price: 3695, profit: -10, reason: "expert", source: "omega", closed_ms: 1 }, { total: { deals: 2, volume: 0.03, profit: -8, net: -8.4 }, intentReason: "pm_cut_loss" });
  assert.match(exitNoticeMessage(loss), /^🔻 .*\nTicket: <code>#9<\/code> BUY · <code>0\.03<\/code> lot\nReason: <b>closed by Omega: Position Manager: loss cut<\/b>\n.*\(-50 pips\)\nResult: <code>-8 USD<\/code> · net <code>-8\.4<\/code> after commission and swap · over 2 exits$/s);

  // Stored and sent: one omega_events row and one line, with the Omega close's reason looked up.
  const db = d1();
  db.raw.exec("CREATE TABLE ea_deals (deal_ticket INTEGER, position_ticket INTEGER, volume REAL, profit REAL, commission REAL, swap REAL, currency TEXT, closed_ms INTEGER)");
  db.raw.exec("CREATE TABLE omega_intents (id TEXT, kind TEXT, payload TEXT, status TEXT, created_ms INTEGER, updated_ms INTEGER)");
  const now = 90_000_000;
  db.raw.prepare("INSERT INTO ea_deals VALUES (7, 77, 0.01, -3.1, -0.1, 0, 'USD', ?)").run(now - 1000);
  db.raw.prepare("INSERT INTO omega_intents VALUES ('pm:77:c:5', 'close', ?, 'done', 1, 2)").run(JSON.stringify({ kind: "close", ticket: 77, reason: "pm_cut_loss" }));
  const sent = [], logged = [];
  const out = await announceExits(db, [{ deal_ticket: 7, position_ticket: 77, side: "BUY", volume: 0.01, entry_price: 3700, exit_price: 3696.9, profit: -3.1, commission: -0.1, reason: "expert", source: "omega", closed_ms: now - 1000 }],
    { now, label: "L", send: async (t) => sent.push(t), log: async (a, d) => logged.push([a, d]) });
  assert.equal(out.length, 1);
  assert.equal(logged[0][0], "position_closed");
  assert.deepEqual([logged[0][1].ticket, logged[0][1].intent_reason, logged[0][1].net], [77, "pm_cut_loss", -3.2]);
  assert.doesNotMatch(JSON.stringify(logged), /login|account/);
  assert.match(sent[0], /Reason: <b>closed by Omega: Position Manager: loss cut<\/b>/);
});

// The Omega sync end to end, over a sqlite D1, with Telegram captured.
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);
const NOW = Date.parse("2026-11-19T15:30:00Z");
const STATE = (over = {}) => ({
  connected: true, server: "AnyBroker-Demo", received_ms: NOW - 1000,
  account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 3876.1, ask: 3876.3, spread_points: 20 },
  positions: [], ...over
});
async function withTelegram(fn) {
  const sent = [], orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes("api.telegram.org")) sent.push(JSON.parse(init.body).text); return new Response("{}"); };
  try { await fn(sent); } finally { globalThis.fetch = orig; }
  return sent;
}
function env() { resetOmegaBrokerSchemaForTests(); resetPositionSchemaCacheForTests(); resetEaExecutionSchemaForTests(); return { DB: d1(), SIGNAL_CACHE: (() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; })(), OMEGA_ENGINE_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }; }
const sync = (e, over = {}, now = NOW) => bridgeSync(e, { state: STATE(), results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.0.0", ...over }, { now, signal: null });

test("PB8. the sync: a broker take-profit is said once with its numbers; a full close says it from the deal, not twice", async () => {
  const e = env();
  const deal = { deal_ticket: 357444852, position_ticket: 363035250, side: "SELL", volume: 0.01, entry_price: 3700.86, exit_price: 3696.29, profit: 4.57, commission: 0, swap: 0, reason: "tp", source: "omega", opened_ms: NOW - 3_600_000, closed_ms: NOW - 30_000 };
  const sent = await withTelegram(async () => {
    await sync(e, { state: STATE({ deals: [deal] }) });
    await sync(e, { state: STATE({ deals: [deal] }) }, NOW + 5_000);
  });
  const closed = sent.filter((t) => /Omega Position Closed/.test(t));
  assert.equal(closed.length, 1, "once, though the terminal reports the deal on every sync");
  assert.match(closed[0], /#363035250<\/code> SELL[\s\S]*take-profit hit at the broker[\s\S]*3700\.86<\/code> → Exit: <code>3696\.29[\s\S]*\+4\.57 USD/);
  const ev = e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'position_closed'").all();
  assert.equal(ev.length, 1);
  assert.equal(JSON.parse(ev[0].detail).deal_reason, "tp");

  // An Omega close intent's result no longer sends its own "Closed" line: the exit deal says it with the numbers.
  const e2 = env();
  await sync(e2);
  e2.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, created_ms, updated_ms) VALUES ('cl:5:opp', 'close', ?, 'sent', ?, ?)").run(JSON.stringify({ kind: "close", ticket: 5, reason: "opposite" }), NOW, NOW);
  const sent2 = await withTelegram(async () => {
    await sync(e2, { results: [{ id: "cl:5:opp", ok: true, ticket: 5, executed_ms: NOW + 100 }], state: STATE({ deals: [{ ...deal, deal_ticket: 9, position_ticket: 5, reason: "expert", profit: -2 }] }) }, NOW + 1_000);
  });
  assert.equal(sent2.filter((t) => /Omega Position Closed/.test(t)).length, 1);
  assert.match(sent2.find((t) => /Omega Position Closed/.test(t)), /closed by Omega: an opposite signal/);
});

test("PB9. the sync: a Position Manager action is said when the broker answers, or as not applied with the reason", async () => {
  const e = env();
  await sync(e);
  await writeSettings(e, { body: { enabled: true, tp_ladder: true }, actor: "owner" }, { now: NOW });
  const at = NOW - 60_000, bar = Math.floor(at / 300_000);
  const ins = (id, action, extra) => e.DB.raw.prepare(`INSERT INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, council, status) VALUES (?, 101, ?, ?, 'SELL', 37, 3876.3, ?, ?, ?, ?, ?, 'weakening, thesis weakening: fading', 'pending')`)
    .run(id, bar, at, action, extra.rule, extra.sl ?? null, extra.tp ?? null, extra.why);
  ins(`pm:101:${bar}`, "tp", { rule: "tp2_target", tp: 3862, why: "target out to TP2 (the next key level)" });
  const sent = await withTelegram(async () => { await sync(e, { state: STATE({ positions: [pos()] }) }); });
  const line = sent.find((t) => /POSITION MANAGER/.test(t));
  assert.match(line, /#101 SELL · \+37 pips · target to 3862 · NOT applied: the TP ladder holds the target until the stop locks TP1/);
  assert.equal(e.DB.raw.prepare("SELECT status FROM position_actions WHERE id = ?").get(`pm:101:${bar}`).status, "skipped");
  // The same reason for the same ticket and rule a bar later: not said again within the hour (PM PR 2).
  ins(`pm:101:${bar - 1}`, "tp", { rule: "tp2_target", tp: 3862, why: "target out to TP2 (the next key level)" });
  const again = await withTelegram(async () => { await sync(e, { state: STATE({ positions: [pos()] }) }, NOW + 500); });
  assert.equal(again.filter((t) => /POSITION MANAGER/.test(t)).length, 0, "said once an hour");
  assert.equal(e.DB.raw.prepare("SELECT status FROM position_actions WHERE id = ?").get(`pm:101:${bar - 1}`).status, "skipped");

  // A close that reaches the broker: no line at planning, one when the broker answers.
  ins(`pm:101:${bar + 1}`, "close", { rule: "cut_loss", why: "-31 pips and the decision is BUY; the council calls the thesis weakening: loss cut" });
  const planned = await withTelegram(async () => { await sync(e, { state: STATE({ positions: [pos()] }) }, NOW + 1_000); });
  assert.equal(planned.filter((t) => /POSITION MANAGER/.test(t)).length, 0, "planned, not yet at the broker");
  const intentId = e.DB.raw.prepare("SELECT id FROM omega_intents WHERE id LIKE 'pm:101:c:%'").get().id;
  const answered = await withTelegram(async () => { await sync(e, { results: [{ id: intentId, ok: true, ticket: 101, executed_ms: NOW + 1_500 }], state: STATE({ positions: [pos()] }) }, NOW + 2_000); });
  assert.deepEqual(answered.filter((t) => /POSITION MANAGER/.test(t)), [escHtml("XAUUSD POSITION MANAGER · #101 SELL · +37 pips · close · applied at the broker\n-31 pips and the decision is BUY; the council calls the thesis weakening: loss cut\nCouncil: weakening, thesis weakening: fading")]);
});

test("PB10. TP2 with the break-even stop: one modify_sltp on OmegaExecutor 1.18+, never looser or below the entry (ADR-0020 Amendment 6)", () => {
  const positions = [pos()];
  const a = { id: "pm:101:9", ticket: 101, action: "tp", rule: "tp2_breakeven", tp: 3862, sl: 3879.8 };
  const r = positionManagerIntents({ positions, sym: sym(3876.1), actions: [a], sltp: true });
  assert.deepEqual(r.intents.map((i) => [i.id, i.kind, i.sl, i.tp, i.reason]), [["pm:101:t:9", "modify_sltp", 3879.8, 3862, "pm_tp2_breakeven"]]);
  assert.match(positionManagerIntents({ positions, sym: sym(3876.1), actions: [a], sltp: false }).dropped[0].reason, /OmegaExecutor 1\.18/);
  assert.match(positionManagerIntents({ positions, sym: sym(3876.1), actions: [{ ...a, sl: 3880.5 }], sltp: true }).dropped[0].reason, /looser than the broker's or below the entry/);
  assert.match(positionManagerIntents({ positions: [pos({ sl: 3879 })], sym: sym(3876.1), actions: [a], sltp: true }).dropped[0].reason, /looser/);
  // Through the plan under the ladder: the stop-and-target passes (it carries its own protection); a bare TP2 still waits.
  const executor = { connected: true, received_ms: 1_000, positions, account: { trade_mode: "demo" }, symbol: sym(3876.1), executor: { version: "1.20" } };
  const plan = planIntents({ executor, now: 1_000, engineEnabled: true, settings: { enabled: true, tp_ladder: true }, pmActions: [a] });
  assert.ok(plan.intents.some((i) => i.id === "pm:101:t:9" && i.kind === "modify_sltp"));
  assert.match(actionMessage({ ticket: 101, side: "SELL", pips: 37, action: "tp", tp: 3862, sl: 3879.8, why: "w", council: null }), /target to 3862 and stop to 3879\.8 · applied at the broker/);
});

test("PB11. a Position Manager modify_sltp counts as a commanded stop; the owner's own does not", async () => {
  const { commandedStops } = await import("../src/omega-engine.mjs");
  const rows = [
    { payload: { id: "pm:101:t:9", kind: "modify_sltp", ticket: 101, sl: 3879.8, tp: 3862 }, status: "sent" },
    { payload: { id: "manual:mp:101:1", kind: "modify_sltp", ticket: 101, sl: 3895, tp: 3862 }, status: "sent" }
  ];
  assert.deepEqual(commandedStops(rows), { 101: [3879.8] });
});
