// Content roadmap P1 (docs/RFC_CONTENT_AGENT.md): the public projection of past decisions and the content
// guardian. Nothing is published; these are the rules a future content agent must pass.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { publicRecap, recapLeaks, publicSentences, readPublicProjection, publicDelayHours, DEFAULT_PUBLIC_DELAY_HOURS, PUBLIC_FORBIDDEN_KEYS } from "../src/public-projection.mjs";
import { checkContentDraft, CONTENT_CHECKS } from "../src/content-guardian.mjs";

// A decision shaped like production's (2026-11-13): prices in the summary, the reasons, the guardrail details,
// the pattern bounds, the key levels and the plans.
const decision = (barClose, stance = "SELL") => ({
  bar_close: barClose, stance, confidence: 0.62,
  decision_json: JSON.stringify({
    bar_close: barClose, stance, bias: "BEARISH", confidence: 0.62, source: "council", worker_version: "abc",
    summary: "The decision is to sell. The price is sitting in a key zone between 3870 and 3875, so a limit order at that level fits.",
    reasons: [
      "The daily, four-hour and one-hour analyses each show a strong bearish bias.",
      "Fundamental commentary is hawkish, the dollar is firm and yields are rising. The entry zone and stop are valid.",
      "Support near 3,864.14 failed twice."
    ],
    risks: ["The market closes for the weekend in less than two hours.", "The trade offers more than three times the risk-to-reward."],
    quorum: { score: -0.44, bias: "BEARISH", long_share: 0.2, short_share: 0.8, neutral_share: 0.11, witnesses: 12, weight: 0.72 },
    guardrails: {
      long: { allowed: false, checks: [{ id: "quorum", pass: false, detail: "0% leans bullish" }, { id: "levels", pass: true, detail: "entry price holds at the 3870.32–3875.00 key zone" }] },
      short: { allowed: true, checks: [{ id: "quorum", pass: true, detail: "80% leans bearish" }] }
    },
    chart_patterns: [{ tf: "15", id: "wedge_falling", status: "confirmed", direction: 1, upper: 3865.71, lower: 3864.14, target: 3905.97 }, { tf: "60", id: "rounding_bottom", status: "forming", upper: 4000.73, lower: 3852.58 }, { tf: "60", id: "x", status: "failed" }],
    key_levels: [{ low: 3864, high: 3867 }], strategy_plans: { short: { entry: 3872, stop: 3880, tp1: 3850 } }, trade: { side: "SELL", entry: 3872 }
  })
});

test("a recap carries the stance, bias, quorum shares and pattern names, and no level, plan, order wording or private data", () => {
  const r = publicRecap(decision("2026-11-13T16:00:00.000Z"), { outcome: "hit" });
  assert.deepEqual([r.stance, r.bias, r.session, r.timeframe, r.outcome], ["SELL", "BEARISH", "new_york", "15m", "hit"]);
  assert.deepEqual(r.quorum, { bias: "BEARISH", long_share: 0.2, short_share: 0.8, witnesses: 12 });
  assert.deepEqual(r.patterns, [{ timeframe: "15", pattern: "wedge_falling", status: "confirmed" }, { timeframe: "60", pattern: "rounding_bottom", status: "forming" }]);
  assert.deepEqual(r.reasons, ["The daily, four-hour and one-hour analyses each show a strong bearish bias.", "Fundamental commentary is hawkish, the dollar is firm and yields are rising."]);
  assert.deepEqual(r.risks, ["The market closes for the weekend in less than two hours."]);
  assert.deepEqual(r.held_back, { long: ["quorum"], short: [] }, "check names only, never their details");
  assert.deepEqual(recapLeaks(r), []);
  const json = JSON.stringify(r);
  for (const word of ["3870", "3,864", "summary", "key_levels", "strategy_plans", "entry", "stop", "worker_version", "upper", "target"]) assert.ok(!json.includes(word), word);
  assert.ok(recapLeaks({ a: { entry: 1 } }).length && recapLeaks({ a: "near 3870" }).length && recapLeaks({ a: "set a stop" }).length, "the leak check finds each kind");
  assert.deepEqual(publicSentences("Gold rose. It hit 4012 then fell. Buy now."), ["Gold rose."]);
});

function d1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE engine_decisions (decision_key TEXT PRIMARY KEY, bar_close TEXT, decided_at TEXT, stance TEXT, confidence REAL, source TEXT, decision_json TEXT)");
  const stmt = (sql, params = []) => ({ bind: (...a) => stmt(sql, a), async run() { raw.prepare(sql).run(...params); return {}; }, async first() { return raw.prepare(sql).get(...params) ?? null; }, async all() { return { results: raw.prepare(sql).all(...params) }; } });
  return { raw, prepare: (sql) => stmt(sql) };
}

test("the projection shows only decisions older than the delay, newest first, each scored on the 15m bars", async () => {
  const db = d1();
  const now = Date.parse("2026-11-14T12:00:00Z");
  const put = (iso, stance) => { const d = decision(iso, stance); db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?, ?, ?, ?, ?)").run(iso, d.bar_close, iso, d.stance, d.confidence, "council", d.decision_json); };
  put("2026-11-14T11:00:00.000Z", "SELL"); // inside the delay: never shown
  put("2026-11-13T10:00:00.000Z", "WAIT");
  put("2026-11-13T09:45:00.000Z", "SELL");
  put("2026-11-01T09:45:00.000Z", "SELL"); // older than the window
  const close = Date.parse("2026-11-13T10:00:00.000Z");
  const candles = [];
  for (let i = -20; i <= 4; i++) candles.push({ open: 4000, high: 4001, low: 3999, close: 4000, open_time: new Date(close + (i - 1) * 900_000).toISOString(), close_time: new Date(close + i * 900_000).toISOString() });
  const kv = { async get() { return JSON.stringify({ candles }); } };
  const out = await readPublicProjection({ DB: db, SIGNAL_CACHE: kv }, { now });
  assert.equal(out.delay_hours, DEFAULT_PUBLIC_DELAY_HOURS);
  assert.equal(out.capacity, "education");
  assert.deepEqual(out.recaps.map((r) => r.bar_close), ["2026-11-13T10:00:00.000Z", "2026-11-13T09:45:00.000Z"]);
  assert.equal(out.recaps[0].outcome, "hit", "a quiet WAIT is a hit");
  assert.deepEqual(out.recaps.flatMap((r) => recapLeaks(r)), []);
  const bad = await readPublicProjection({ DB: db, SIGNAL_CACHE: kv, PUBLIC_DELAY_HOURS: "soon" }, { now });
  assert.equal(bad.delay_hours, DEFAULT_PUBLIC_DELAY_HOURS, "a bad value keeps the default");
  const two = await readPublicProjection({ DB: db, SIGNAL_CACHE: kv, PUBLIC_DELAY_HOURS: "2" }, { now });
  assert.equal(two.recaps[0].bar_close, "2026-11-13T10:00:00.000Z");
  assert.ok(!two.recaps.some((r) => r.bar_close === "2026-11-14T11:00:00.000Z"));
});

// RT1 (owner 2026-11-25: "harus realtime", then "Semua sekarang"): the delay may be 0; the leak filter stays in force.
test("RT1 publicDelayHours: 0 is realtime; unset, null, empty, negative or invalid is 24; at most 14 days", () => {
  assert.equal(publicDelayHours({ PUBLIC_DELAY_HOURS: "0" }), 0);
  assert.equal(publicDelayHours({ PUBLIC_DELAY_HOURS: 0 }), 0);
  assert.equal(publicDelayHours({ PUBLIC_DELAY_HOURS: "0.5" }), 0.5);
  assert.equal(publicDelayHours({ PUBLIC_DELAY_HOURS: "24" }), 24, "the rollback");
  for (const v of [undefined, null, "", "  ", "soon", "-1", NaN]) assert.equal(publicDelayHours({ PUBLIC_DELAY_HOURS: v }), 24, String(v));
  assert.equal(publicDelayHours({}), 24);
  assert.equal(publicDelayHours(null), 24);
  assert.equal(publicDelayHours({ PUBLIC_DELAY_HOURS: "9999" }), 24 * 14);
});

test("RT1 with delay 0 the recaps include the newest decision, still pending, with no price, entry, SL, TP or forbidden key", async () => {
  const db = d1();
  const now = Date.parse("2026-11-14T12:00:00Z");
  const put = (iso, stance) => { const d = decision(iso, stance); db.raw.prepare("INSERT INTO engine_decisions VALUES (?, ?, ?, ?, ?, ?, ?)").run(iso, d.bar_close, iso, d.stance, d.confidence, "council", d.decision_json); };
  put("2026-11-14T11:45:00.000Z", "SELL"); // the newest 15m decision, its horizon still open
  put("2026-11-14T11:30:00.000Z", "WAIT");
  put("2026-11-13T10:00:00.000Z", "BUY");
  const close = Date.parse("2026-11-14T11:45:00.000Z");
  const candles = [];
  for (let i = -20; i <= 0; i++) candles.push({ open: 4000, high: 4001, low: 3999, close: 4000, open_time: new Date(close + (i - 1) * 900_000).toISOString(), close_time: new Date(close + i * 900_000).toISOString() });
  const kv = { async get() { return JSON.stringify({ candles }); } };
  const out = await readPublicProjection({ DB: db, SIGNAL_CACHE: kv, PUBLIC_DELAY_HOURS: "0" }, { now });
  assert.equal(out.delay_hours, 0);
  assert.equal(out.until, new Date(now).toISOString());
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.recaps.map((r) => r.bar_close), ["2026-11-14T11:45:00.000Z", "2026-11-14T11:30:00.000Z", "2026-11-13T10:00:00.000Z"], "the owner's intent: the newest decision is public at once");
  const newest = out.recaps[0];
  assert.deepEqual([newest.stance, newest.confidence, newest.outcome], ["SELL", 0.62, "pending"]);
  assert.ok(newest.reasons.length > 0, "its reasons, in plain words");
  assert.deepEqual(out.recaps.flatMap((r) => recapLeaks(r)), []);
  const json = JSON.stringify(out.recaps);
  for (const word of ["3870", "3872", "3875", "3880", "3850", "3,864", "3864", "entry", "stop", "tp1", "take_profit", "strategy_plans", "key_levels", "trade", "upper", "lower", "target", "worker_version"]) assert.ok(!json.includes(word), word);
  for (const key of PUBLIC_FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}":`), key);
});

test("the guardian passes an education recap with its disclaimer and TradingView's attribution", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const text = "Edukasi: kemarin (13 November 2026) sistem membaca tekanan turun pada emas di sesi New York; dolar menguat dan imbal hasil naik. Pola: falling wedge terkonfirmasi di 15 menit. Bukan ajakan jual atau beli. Grafik: TradingView.";
  assert.deepEqual(checkContentDraft({ text, chart: true, decisionTimes: ["2026-11-13T10:00:00Z"], now }), { version: "cryptophys.content-guardian.v1", pass: true, failures: [] });
});

test("the guardian fails each rule on its own", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const base = "Edukasi. Bukan ajakan jual atau beli.";
  const only = (text, opts = {}) => checkContentDraft({ text, now, ...opts }).failures.map((f) => f.check);
  assert.deepEqual(only("Gold rose. Not financial advice."), ["capacity"]);
  assert.deepEqual(only("Edukasi: gold rose."), ["disclaimer"]);
  assert.deepEqual(only(`${base} Profit pasti tiap minggu.`), ["promised_return"]);
  assert.deepEqual(only(`${base} Returns of 10% per month.`), ["promised_return"]);
  assert.deepEqual(only(`${base} Sell now!`), ["instruction"]);
  assert.deepEqual(only(`${base} Pasang SL di bawah support.`), ["instruction", "signal_words"]);
  assert.deepEqual(only(`${base} Support near 3,864 held.`), ["price_level"]);
  assert.deepEqual(only(`${base} Support near 3864 held.`, { allowLevels: true }), [], "levels as commentary only when the owner allows them");
  assert.deepEqual(only(`${base} Saldo naik.`), ["account_data"]);
  assert.deepEqual(only(`${base} Lihat di Nexus.`), ["internal"]);
  assert.deepEqual(only(`${base} key sk-abcdefghijklmnopqrstuvwxyz`), ["secret"]);
  assert.deepEqual(only(base, { chart: true }), ["attribution"]);
  assert.deepEqual(only(base, { decisionTimes: ["2026-11-14T11:00:00Z"] }), ["too_recent"]);
  assert.deepEqual(only(base, { decisionTimes: ["not a date"] }), ["too_recent"], "an unknown time is never treated as old");
  assert.deepEqual(only(`${base} At 14:30 on 2026-11-13 the dollar rose.`), [], "dates and times are not levels");
  assert.deepEqual(only(""), ["capacity"]);
  assert.deepEqual(only(`${base} Entry di area support, SL di bawahnya.`), ["signal_words"]);
  assert.deepEqual(only(`${base} XAUUSD H4 BUY.`), ["signal_words"]);
  assert.deepEqual(only(`${base} Take profit pertama.`), ["signal_words"]);
  assert.deepEqual(only(`${base} Zona permintaan (area beli) dan zona penawaran (area jual).`), [], "a buy or sell zone is information");
  assert.deepEqual(only(`${base} Sistem condong beli.`), []);
  assert.equal(CONTENT_CHECKS.length, 11);
});
