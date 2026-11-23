// V3L's fixture (test/fixtures/ledger-v3-limit/2026-11-23.json, read-only from production D1): the 2026-11-23 Decision
// Engine ledger rows, their engine decisions and the feed's archived 1m bars, every price shifted by a constant. This
// module turns it into what the ledger reads: an in-memory D1 (the migrations, the decision table, omega_settings and
// omega_events), the ledger's bars ({ open_time, close_time, open, high, low, close }) and the 15m bars for the ATR.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { DECISION_SCHEMA_SQL } from "../../src/decision-engine.mjs";
import { LEDGER_SCHEMA_SQL } from "../../src/signal-ledger.mjs";

export const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/ledger-v3-limit/2026-11-23.json", import.meta.url), "utf8"));
const M1 = 60_000, M15 = 15 * M1;
const iso = (ms) => new Date(ms).toISOString();
const key = (k) => `OANDA:XAUUSD:15:${k}`;

/** An in-memory D1 with the repository's migrations and the decision table (the LH1 test's adapter). */
export function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../../migrations/" + name, import.meta.url), "utf8"));
  for (const sql of DECISION_SCHEMA_SQL) db.exec(sql);
  db.exec("CREATE TABLE IF NOT EXISTS omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER, updated_by TEXT, updated_ms INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_ms INTEGER, payload TEXT, result TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS limit_council (id TEXT PRIMARY KEY, kind TEXT NOT NULL, open_id TEXT, ticket INTEGER, bar INTEGER, at_ms INTEGER NOT NULL, status TEXT NOT NULL, choice TEXT, rule TEXT, price REAL, max_move REAL, reason TEXT, council TEXT, facts TEXT, updated_ms INTEGER)");
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
    },
    async batch(list) { for (const s of list) await s.run(); return []; }
  };
}
export const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };

/** The fixture's 1m bars in the ledger's shape, oldest first. */
export function fixtureBars(fx = FIXTURE) {
  return fx.bars_1m.split(";").map((part) => {
    const [i, ohlc] = part.split(":");
    const [o, h, l, c] = ohlc.split(",").map(Number);
    const t = fx.bars_base_ms + Number(i) * M1;
    return { open_time: iso(t), close_time: iso(t + M1), open: o, high: h, low: l, close: c };
  });
}
/** The 15m bars the ATR reads: Friday's last 16, then the complete 15m buckets of the 1m bars. */
export function fixtureM15(fx = FIXTURE, bars = fixtureBars(fx)) {
  const out = fx.m15_before.map(([t, o, h, l, c]) => ({ open_time: iso(t), close_time: iso(t + M15), open: o, high: h, low: l, close: c }));
  const buckets = new Map();
  for (const b of bars) {
    const t = Math.floor(Date.parse(b.open_time) / M15) * M15;
    const g = buckets.get(t);
    if (!g) buckets.set(t, { t, open: b.open, high: b.high, low: b.low, close: b.close, n: 1 });
    else { g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low); g.close = b.close; g.n += 1; }
  }
  for (const g of buckets.values()) if (g.n >= 14) out.push({ open_time: iso(g.t), close_time: iso(g.t + M15), open: g.open, high: g.high, low: g.low, close: g.close });
  return out;
}
const conf = (text) => {
  if (!text) return null;
  const o = {};
  for (const p of String(text).split(",")) { const [id, l, s] = p.split(":"); o[id] = { long: Number(l), short: Number(s) }; }
  return o;
};
const zip = (fields, a) => Object.fromEntries(fields.map((f, i) => [f, a[i]]));
/** The fixture's ledger rows as objects. */
export const fixtureRows = (fx = FIXTURE) => fx.rows.map((r) => zip(fx.rows_fields, r));

/**
 * Seeds `db` with the fixture: the engine decisions (decision_json with what the ledger reads), the ledger rows as they
 * were ingested (omega_status pending, nothing simulated; `stored` true keeps production's v3 columns instead), the Omega
 * settings (`settings` over the fixture's), the settings history (omega_events "settings", entry_order only) and the live
 * entry council's recorded answers (limit_council, `council`).
 */
export async function seed(db, { fx = FIXTURE, settings = {}, stored = false, events = true, council = true, rows: pick = null } = {}) {
  for (const sql of LEDGER_SCHEMA_SQL) db.raw.exec(sql);
  const { ensureLedgerSchema, resetLedgerSchemaCacheForTests } = await import("../../src/signal-ledger.mjs");
  resetLedgerSchemaCacheForTests();
  await ensureLedgerSchema(db);
  const rows = fixtureRows(fx);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const a of fx.decisions) {
    const d = zip(fx.decisions_fields, a);
    const r = byKey.get(d.key);
    const levels = String(d.levels || "").split(",").filter(Boolean).map((z) => { const [low, high] = z.split(":").map(Number); return { low, high }; });
    const trade = d.action ? { side: d.stance, action: d.action, agent: d.agent, ...(r ? { entry: r.entry, stop: r.stop, tp: r.tp1, tp1: r.tp1, tp2: r.tp2, target: "tp1" } : {}), ...(d.entry_low != null ? { entry_low: d.entry_low, entry_high: d.entry_high } : {}) } : null;
    const json = { decision_key: key(d.key), stance: d.stance, decided_at: d.decided_at, trading_mode: d.mode, strategy_execution: d.strategy_execution === 1, quorum: { score: d.power, long_share: d.long_share, short_share: d.short_share }, key_levels: levels, agent_confidence: conf(d.agent_confidence), agent_confidence_prev: conf(d.agent_confidence_prev), trade, ...(d.entry_zone_mode ? { entry_zone_mode: d.entry_zone_mode } : {}) };
    db.raw.prepare("INSERT INTO engine_decisions (decision_key, bar_close, decided_at, stance, confidence, source, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(key(d.key), iso(Number(d.key) + M15), d.decided_at, d.stance, 0.6, "engine", JSON.stringify(json));
  }
  for (const r of rows.filter((x) => !pick || pick.includes(x.key))) {
    db.raw.prepare("INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, tp2, progressive_stop, status, updated_at, trading_mode, entry_action, omega_status) VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'pending')")
      .run(`decision:${key(r.key)}`, key(r.key), r.opened_at, r.side, r.entry, r.stop, r.tp1, r.tp2, r.progressive_stop, r.opened_at, r.trading_mode, r.entry_action);
    if (stored) db.raw.prepare("UPDATE signal_ledger SET omega_status = ?, omega_gate = ?, omega_exit = ?, r_omega = ?, omega_size = ?, omega_filled_at = ?, omega_closed_at = ?, omega_json = ? WHERE id = ?")
      .run(r.v3_status, r.v3_gate, r.v3_exit, r.v3_r, r.v3_size, r.v3_filled_at, r.v3_closed_at, JSON.stringify({ gate: r.v3_status === "skipped" ? null : { size: r.v3_size }, protected_at: r.v3_protected_at }), `decision:${key(r.key)}`);
  }
  const s = { ...fx.settings, ...settings };
  db.raw.prepare("INSERT INTO omega_settings (id, settings, version, updated_by, updated_ms) VALUES (1, ?, 1, 'test', ?)").run(JSON.stringify(s), fx.entry_order_events.at(-1)[0]);
  if (events) for (const [ms, eo] of fx.entry_order_events) db.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'test', 'settings', ?)").run(ms, JSON.stringify({ ...fx.settings, entry_order: eo }));
  if (council) for (const [openId, status, choice, rule, atMs] of fx.entry_council) db.raw.prepare("INSERT INTO limit_council (id, kind, open_id, at_ms, status, choice, rule) VALUES (?, 'entry', ?, ?, ?, ?, ?)").run(`ec:${openId}`, openId, atMs, status, choice, rule);
  return rows;
}

/** The v3 columns of the ledger's decision rows, oldest first. */
export async function v3Of(db) {
  return (await db.prepare("SELECT id, opened_at, side, omega_status, omega_gate, omega_filled_at, omega_closed_at, omega_exit, r_omega, omega_size, omega_json FROM signal_ledger WHERE source = 'decision' ORDER BY opened_at").all()).results;
}
