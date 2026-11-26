// Track A PR 5 (orchestrator queue 2026-11-26, A5): a pattern trade's pattern, chart and plan TP2 are recorded on the
// decision's trade, the signal, Omega's entry intents and v4's ledger row, and the Signal Ledger splits the plan R by
// pattern and chart. Recorded only: a trade without a pattern is byte for byte as before, and nothing reaches the EA.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { tradeFor } from "../src/decision-engine.mjs";
import { eaSignalFromDecision, managementFields } from "../src/ea-signal.mjs";
import { planIntents, OMEGA_DEFAULTS, openId } from "../src/omega-engine.mjs";
import { patternBlocks, ledgerView, ensureLedgerSchema, resetLedgerSchemaCacheForTests, PATTERN_COLUMNS } from "../src/signal-ledger.mjs";
import { formatIntentsText } from "../bridge/omega-bridge/src/files.mjs";

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
const PLAN = { entry: 4100, stop: 4095, tp1: 4110, tp2: 4120, risk: 5, rrr: { tp1: 2, tp2: 4 }, at_level: false, agent: "pattern_breakout", setup: "breakout", pattern: "bull_flag", chart: "60" };
const DECISION = (trade) => ({
  decision_key: `OANDA:XAUUSD:15:${ISSUED - 15 * 60_000}`, bar_close: new Date(ISSUED).toISOString(), decided_at: new Date(ISSUED + 60_000).toISOString(), stance: "BUY", confidence: 0.7,
  trade: { side: "BUY", action: "ENTER_LIMIT", entry: 4100, stop: 4095, tp: 4110, tp1: 4110, tp2: 4120, target: "tp1", trigger_required: false, ...trade },
  guardrails: { long: { entry_trigger: { fired: false } }, short: { entry_trigger: { fired: false } } }
});

test("TP5-1 tradeFor: a pattern plan's chart rides with its pattern; valid_until_ms only once a plan carries it; the default agent's trade is as before", () => {
  const t = tradeFor("BUY", PLAN, { entryType: "limit" });
  assert.equal(t.pattern, "bull_flag");
  assert.equal(t.chart, "60");
  assert.ok(!("valid_until_ms" in t));
  assert.equal(tradeFor("BUY", { ...PLAN, valid_until_ms: ISSUED + 3_600_000 }).valid_until_ms, ISSUED + 3_600_000);
  const { pattern, chart, ...noPattern } = PLAN;
  assert.ok(!("chart" in tradeFor("BUY", { ...noPattern, chart: "60" })), "no pattern: no chart");
  const plain = tradeFor("BUY", { ...noPattern, agent: undefined });
  assert.ok(!("chart" in plain) && !("pattern" in plain));
});

test("TP5-2 the signal: trade_pattern, trade_chart and trade_tp2_plan only for a pattern trade; any other signal byte for byte; no key named tp2", () => {
  const without = eaSignalFromDecision({ decision: DECISION({}), now: NOW });
  for (const k of ["trade_pattern", "trade_chart", "trade_tp2_plan"]) assert.ok(!(k in without), k);
  const m = managementFields(DECISION({ pattern: "bull_flag", chart: "60" }));
  assert.deepEqual([m.trade_pattern, m.trade_chart, m.trade_tp2_plan], ["bull_flag", "60", 4120]);
  const withP = eaSignalFromDecision({ decision: DECISION({ pattern: "bull_flag", chart: "60" }), now: NOW });
  const { trade_pattern, trade_chart, trade_tp2_plan, ...rest } = withP;
  assert.deepEqual(rest, without, "only the three keys are new");
  // The EA's own lookup reads `"<key>":`; none of the new keys is or contains a key it reads at a key boundary.
  const json = JSON.stringify(withP);
  assert.ok(!/"tp2":/.test(json) && !/"extended_tp":/.test(json), "no key named tp2 or extended_tp");
  const ea = readFileSync(new URL("../ea/mt5/CryptophysXAUUSD.mq5", import.meta.url), "utf8");
  for (const k of ["trade_pattern", "trade_chart", "trade_tp2_plan"]) assert.ok(!ea.includes(`"${k}"`), `the EA never reads ${k}`);
});

const SIGNAL = {
  side: "BUY", action: "ENTER_MARKET", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, decided_ms: ISSUED + 60_000, expires_ms: ISSUED + 15 * 60_000, blackout: false, kill: false, paused: false,
  feed_basis: 0.2, feed_basis_known: true, key_levels: "", power: 0.4, power_ms: ISSUED, quorum_long_share: 0.7, quorum_short_share: 0.2, veto_long: false, veto_short: false, trading_mode: "intraday", trade_agent: "pattern_breakout"
};
const EXECUTOR = {
  connected: true, received_ms: NOW - 2_000, executor: { version: "1.21" },
  account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4100.1, ask: 4100.3, spread_points: 20 },
  positions: [], orders: []
};
const run = (signal) => planIntents({ signal, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false }, executor: EXECUTOR, now: NOW, engineEnabled: true });

test("TP5-3 Omega's entry intent carries pattern, chart and plan_tp2_feed only for a pattern signal; the bridge writes the same line", () => {
  const plain = run(SIGNAL), withP = run({ ...SIGNAL, trade_pattern: "bull_flag", trade_chart: "60", trade_tp2_plan: 4120 });
  const open = (r) => r.intents.find((i) => i.kind === "open" || i.kind === "place_limit");
  assert.ok(open(plain), JSON.stringify(plain.notes));
  for (const k of ["pattern", "chart", "plan_tp2_feed"]) assert.ok(!(k in open(plain)), k);
  assert.deepEqual([open(withP).pattern, open(withP).chart, open(withP).plan_tp2_feed], ["bull_flag", "60", 4120]);
  const { pattern, chart, plan_tp2_feed, ...rest } = open(withP);
  assert.deepEqual(rest, open(plain), "only the three keys are new");
  assert.equal(formatIntentsText([open(withP)], NOW), formatIntentsText([open(plain)], NOW), "the EA's intents file is unchanged");
});

test("TP5-4 the Signal Ledger: the plan R by pattern and chart, only with the decisions' join; the ALTERs are idempotent", async () => {
  const row = (id, status, r1, r2) => ({ id: `decision:${id}`, source: "decision", status, r_tp1: r1, r_tp2: r2, tp2: 4120, filled_at: status === "closed" ? "x" : null, opened_at: "2026-11-20T11:00:00Z" });
  const items = [row("a", "closed", 2, 4), row("b", "closed", -1, -1), row("c", "closed", 1, 1), { ...row("d", "closed", 1, 1), source: "tv" }];
  const blocks = patternBlocks(items, { a: { pattern: "bull_flag", chart: "60" }, b: { pattern: "bull_flag", chart: "60" }, c: { pattern: "pennant", chart: null }, d: { pattern: "x", chart: "15" } });
  assert.deepEqual(Object.keys(blocks), ["bull_flag@60", "pennant@-"]);
  assert.equal(blocks["bull_flag@60"].signals, 2);
  assert.equal(blocks["bull_flag@60"].closed, 2);
  assert.ok(!("by_pattern" in ledgerView(items, { days: 30 })), "callers without the join: as before");
  assert.ok("by_pattern" in ledgerView(items, { days: 30, patterns: {} }));
  assert.deepEqual([...PATTERN_COLUMNS], ["pattern TEXT", "chart TEXT"]);
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const d1 = { prepare: (sql) => { let p = []; const st = { bind: (...a) => { p = a; return st; }, run: async () => db.prepare(sql).run(...p), all: async () => ({ results: db.prepare(sql).all(...p) }), first: async () => db.prepare(sql).get(...p) ?? null }; return st; } };
  for (let i = 0; i < 2; i += 1) { resetLedgerSchemaCacheForTests(); await ensureLedgerSchema(d1); }
  const cols = db.prepare("PRAGMA table_info(ledger_omega4)").all().map((c) => c.name);
  assert.ok(cols.includes("pattern") && cols.includes("chart"));
});
