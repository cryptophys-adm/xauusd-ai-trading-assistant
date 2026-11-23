// The limit counterfactual reads the decision's EZ1b switch (found by V3L, 2026-11-23): v4's DECISION_SQL does not extract
// `entry_zone_mode`, so the counterfactual's signal never carried `entry_zone_edge` and never rested a limit at the
// zone's near edge as the live limitPlacement does. LIMIT_DECISION_SQL / LIMIT_ZONE_MODE_SQL and withZoneModes add it;
// v4's DECISION_SQL and records are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DECISION_SCHEMA_SQL } from "../src/decision-engine.mjs";
import { DECISION_SQL, decisionFromRow, replayOmega4 } from "../src/ledger-omega4.mjs";
import { LIMIT_DECISION_SQL, LIMIT_ZONE_MODE_SQL, withZoneModes, replayOmegaLimit } from "../src/ledger-omega-limit.mjs";
import { eaSignalFromDecision } from "../src/ea-signal.mjs";
import { OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

const M1 = 60_000, M15 = 15 * M1, C = Date.parse("2026-11-23T04:15:00Z");
const KEY = `OANDA:XAUUSD:15:${C - M15}`;
// The 04:15 case of EZ13: the plan's level 0.353R from price (band 0.35), the zone's top 0.24R.
const DECISION = {
  decision_key: KEY, bar_close: new Date(C).toISOString(), decided_at: new Date(C + 2 * M1).toISOString(), stance: "BUY", confidence: 0.7,
  trade: { side: "BUY", action: "ENTER_LIMIT", entry: 3595.29, stop: 3551.05, tp: 3687.75, tp1: 3687.75, target: "tp1", agent: "zone_pullback", entry_low: 3590.37, entry_high: 3600.21 },
  guardrails: { long: { entry_trigger: null }, short: { entry_trigger: null } },
  quorum: { score: 0.3, long_share: 0.8, short_share: 0.2 }, key_levels: [{ low: 3700, high: 3702 }], agent_confidence: { zone_pullback: { long: 0.85, short: 0.6 } },
  agent_confidence_prev: { zone_pullback: { long: 0.85, short: 0.6 } }, trading_mode: "scalp", strategy_execution: false, entry_zone_mode: "edge",
  context: { regime_1h: "normal-ranging" }, strategy: { atr_h1: 20 }
};
function db() {
  const d = new DatabaseSync(":memory:");
  for (const sql of DECISION_SCHEMA_SQL) d.exec(sql);
  d.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(KEY, DECISION.bar_close, DECISION.decided_at, "BUY", 0.7, "engine", JSON.stringify(DECISION));
  return d;
}

test("LZ1 the counterfactual's decisions carry entry_zone_mode (its own SQL, or v4's joined with LIMIT_ZONE_MODE_SQL); v4's SQL does not", () => {
  const d = db(), since = new Date(C - 3600_000).toISOString();
  const v4 = d.prepare(DECISION_SQL).all(since).map(decisionFromRow);
  assert.equal(v4[0].entry_zone_mode, undefined, "v4's DECISION_SQL: no switch (the bug)");
  assert.equal(eaSignalFromDecision({ decision: v4[0], now: C + 3 * M1 }).entry_zone_edge, undefined);
  const rows = d.prepare(LIMIT_DECISION_SQL).all(since);
  const own = withZoneModes(rows.map(decisionFromRow), rows);
  assert.equal(own[0].entry_zone_mode, "edge");
  const joined = withZoneModes(v4, d.prepare(LIMIT_ZONE_MODE_SQL).all(since));
  assert.deepEqual(joined, own, "the steady state (v4's decisions reused) and the own read agree");
  assert.equal(eaSignalFromDecision({ decision: joined[0], now: C + 3 * M1 }).entry_zone_edge, true);
  // A decision without the switch is left as it is (the same object).
  assert.equal(withZoneModes(v4, [])[0], v4[0]);
  assert.equal(LIMIT_DECISION_SQL.replace(", json_extract(decision_json, '$.entry_zone_mode') AS zone_mode", ""), DECISION_SQL);
});

test("LZ2 the replay: with the switch the limit rests at the zone's edge (EZ1b) and fills; without it, limit_out_of_band; v4 unchanged", () => {
  // Price 3610.7 at the decision, then down through the zone's top within the order's life.
  const fn = (t) => (t < C + 10 * M1 ? 3610.7 : 3598);
  const bars = [];
  for (let t = C - 5 * 3600_000; t < C + 60 * M1; t += M1) { const o = fn(t), c = fn(t + M1); bars.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c }); }
  const d = db(), since = new Date(C - 3600_000).toISOString();
  const v4 = d.prepare(DECISION_SQL).all(since).map(decisionFromRow);
  const fixed = withZoneModes(v4, d.prepare(LIMIT_ZONE_MODE_SQL).all(since));
  const base = { settings: { ...OMEGA_DEFAULTS, enabled: true, max_daily_loss_pct: 6, risk_pct: 3 }, profileAt: () => "aggressive", balanceAt: () => 100000, from: C, to: C + 60 * M1, bars };
  const before = replayOmegaLimit({ ...base, decisions: v4 }).records[KEY];
  const after = replayOmegaLimit({ ...base, decisions: fixed }).records[KEY];
  assert.deepEqual([before.limit_status, before.limit_gate], ["missed", "limit_out_of_band"]);
  assert.ok(["open", "closed"].includes(after.limit_status), `${after.limit_status} ${after.limit_gate}`);
  assert.equal(JSON.parse(after.limit_json).entry_policy.away_r, 0.242, "rested at the zone's top, 0.242R from price");
  assert.deepEqual(replayOmega4({ ...base, decisions: fixed }).records, replayOmega4({ ...base, decisions: v4 }).records, "v4 (the market replay) is the same");
});
