// Shared fixtures of the Call for Councils tests (test/cfc-*.test.mjs): the schema production runs over
// node:sqlite, a D1 and a KV stand-in, and seeded Decision Engine trades whose prices must never reach a pack.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { AGENT_IDS } from "../../src/strategy-agents.mjs";
import { LEDGER_SCHEMA_SQL, resetLedgerSchemaCacheForTests, ensureLedgerSchema } from "../../src/signal-ledger.mjs";
import { DECISION_SCHEMA_SQL } from "../../src/decision-engine.mjs";
import { PLAN_LEARNING_SCHEMA_SQL, resetPlanLearningSchemaCacheForTests } from "../../src/plan-learning.mjs";
import { OUTCOME_SCHEMA_SQL } from "../../src/outcome-scoring.mjs";
import { OMEGA_SCHEMA_SQL } from "../../src/omega-broker.mjs";
import { ECON_SCHEMA_SQL } from "../../src/econ-releases.mjs";

export const NOW = Date.UTC(2026, 10, 16, 12, 10, 0);
export const M15 = 15 * 60_000;

export function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of [...LEDGER_SCHEMA_SQL, ...DECISION_SCHEMA_SQL, ...PLAN_LEARNING_SCHEMA_SQL, ...OUTCOME_SCHEMA_SQL, ...OMEGA_SCHEMA_SQL, ...ECON_SCHEMA_SQL]) db.exec(sql);
  return db;
}

/** A D1 stand-in over node:sqlite (bind, first, all, run, batch). */
export function d1(db) {
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map((v) => (v === undefined ? null : v))),
    async run() { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { success: true, results: db.prepare(sql).all(...params) }; }
  });
  return { db, prepare: (sql) => statement(sql), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

export function kv(init = {}) {
  const map = new Map(Object.entries(init));
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, String(v)); }, async delete(k) { map.delete(k); } };
}

/**
 * Seeds `n` resolved Decision Engine trades of an agent: prices in the ledger and the decision (they must not
 * reach the pack), the exits given in turn by `exits` ([ledger, omega] pairs).
 */
export async function seedTrades(env, { agent = "zone_pullback", pattern = null, n = 20, start = NOW - 10 * 86_400_000, exits = [["stop", "sl_plus"]], mode = "intraday", regime = "normal-trending", action = "ENTER_LIMIT", tag = "" } = {}) {
  resetLedgerSchemaCacheForTests();
  await ensureLedgerSchema(env.DB);
  const db = env.DB.db;
  for (let i = 0; i < n; i++) {
    const open = start + i * 4 * M15 + (tag ? 7 * 60_000 : 0) + (pattern ? 3 * 60_000 : 0) + AGENT_IDS.indexOf(agent) * 60_000;
    const key = `OANDA:XAUUSD:15:${open}`;
    const [ledger, omega] = exits[i % exits.length];
    const decision = { decision_key: key, trading_mode: mode, trade: { side: "BUY", action, entry: 4001.25, stop: 3995.5, tp: 4012.75, agent, ...(pattern ? { pattern } : {}) }, context: { regime_1h: regime }, strategy: { atr_h1: 6.5, price: 4001 }, key_levels: [{ price: 4010.37 }] };
    db.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, 'BUY', 0.6, 'council', ?)").run(key, new Date(open + M15).toISOString(), new Date(open + M15 + 60_000).toISOString(), JSON.stringify(decision));
    const r = ledger === "target" ? 1.8 : ledger === "time" ? 0.2 : ledger === "sl_plus" ? 0 : -1;
    const ro = omega === "target" || omega === "trailed_target" ? 1.5 : omega === "sl_plus" ? 0.1 : omega === "time" ? 0.3 : -1;
    db.prepare(`INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, tp2, status, filled_at, closed_at, exit_reason, exit_price, r_tp1, mfe_r, mae_r, bars_held, sl_plus_triggered, trading_mode, entry_action, omega_status, omega_closed_at, omega_exit, r_omega, omega_json, updated_at)
      VALUES (?, 'decision', ?, ?, 'BUY', 4001.25, 3995.5, 4012.75, NULL, 'closed', ?, ?, ?, 3995.5, ?, 0.8, -1, 6, ?, ?, ?, 'closed', ?, ?, ?, ?, ?)`)
      .run(`decision:${key}`, key, new Date(open + M15 + 60_000).toISOString(), new Date(open + 2 * M15).toISOString(), new Date(open + 5 * M15).toISOString(),
        ledger === "sl_plus" ? "stop" : ledger, r, ledger === "sl_plus" ? 1 : 0, mode, action, new Date(open + 5 * M15).toISOString(), omega, ro,
        JSON.stringify({ protected_at: omega === "sl_plus" ? new Date(open + 3 * M15).toISOString() : null, sl_moves: omega === "sl_plus" ? 2 : 0, tp_moves: 0, mfe_r: 0.9, mae_r: -0.7, band: { lo: 3990.11, hi: 4020.33 } }), new Date(NOW).toISOString());
  }
}

export async function seedEnv() {
  const db = database();
  resetLedgerSchemaCacheForTests();
  resetPlanLearningSchemaCacheForTests();
  return { DB: d1(db), SIGNAL_CACHE: kv(), STRATEGY_AGENTS_LIVE: "sweep_reversal,pattern_peaks" };
}
