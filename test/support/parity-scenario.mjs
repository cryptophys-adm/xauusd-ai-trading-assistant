// B7: a fixed parity scenario for today's identities (prophet, gmi, gmi_hud and the Mizan they vouch
// for, on H1 and 15m), run through the real sweep on an in-memory D1 and a Map KV, with a fixed clock.
// test/parity-groups.test.mjs compares its output with test/fixtures/parity-b7-main.json, which was
// generated with this module on main before the field groups existed: the sweep output, the stored
// trust (registry rows, comparisons, the trusted KV lane) and the parity view must stay byte-identical.
// Regenerated once on 2026-11-25 for the approved_at bind fix: on main every promotion stored
// approved_at "24.0", so the scenario's one-time reclassification (its marker is absent here) saw no
// mismatch "after" the approval and restored gmi, gmi_hud, gmi_m15 and gmi_hud_m15, which were revoked
// by real indicator mismatches. They now stay revoked; see test/parity-approved-at.test.mjs PF-8.
import { DatabaseSync } from "node:sqlite";
import { reconcileLocalComputation, reconcileRecentCandles } from "../../src/parity-sweep.mjs";
import { resetSchemaCacheForTests, ensureSchema, registerIdentity, identityOf, listRegistry } from "../../src/parity-registry.mjs";
import { readParityView } from "../../src/parity-view.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
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

function kv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };
}

const H = (c) => c.repeat(64);
const candle = { o: 3950.1, h: 3955.2, l: 3948.0, c: 3953.4, volume: 2103 };
const R38 = { direction: 1, buy_confirmed: true, sell_confirmed: false, buy_high_quality: false, sell_high_quality: false, t_enc: 2, d_enc: -1, structure_subtype: 0 };
const R37 = { direction: 1, d_enc: -1, b_enc: 2, structure_subtype: 0, bull_event: true, bear_event: false };
const GMI = { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false };
const HUD = { ...GMI, cshi_viability: 64, deploy_status: 3, muddy_waters: false, grid_viable: true };
const MIZAN = { source_hash: H("9"), implementation_hash: H("8") };

const record = (engine, timeframe, comparable, hashes, extra = {}) => ({
  engine, timeframe,
  provenance: { ...hashes, ...(engine === "mizan" ? {} : { dependencies: { mizan: MIZAN } }) },
  values: { candle, comparable, diagnostics: { branch: "jma_long", entropy: 0.4 } }, ...extra
});

/**
 * Candle i's twists: which engine differs from TradingView and how. Everything else matches.
 * 0-23 match (24 approve), then a GMI mismatch, an incomplete Prophet, an input mismatch, a HUD
 * mismatch, a missing HUD webhook, an MT5 fallback candle, then matches again.
 */
function twist(i) {
  return ({ 24: "gmi_mismatch", 25: "prophet_incomplete", 26: "input_mismatch", 27: "hud_mismatch", 28: "hud_absent", 29: "fallback" })[i] || null;
}

async function seed(env, key, timeframe, i) {
  const t = twist(i);
  const hooks = {
    prophet_r38: { ...candle, ...R38 },
    prophet_r37_ssot: { ...candle, ...R37 },
    gmi_v12_70: { ...candle, ...GMI, ...(t === "gmi_mismatch" ? { verdict: -3 } : {}), shared_core_status: "ok" },
    ...(t === "hud_absent" ? {} : { gmi_v12_70_hud: { ...candle, ...HUD, ...(t === "hud_mismatch" ? { deploy_status: 2 } : {}) } })
  };
  if (t === "input_mismatch") for (const s of Object.keys(hooks)) hooks[s] = { ...hooks[s], c: 3953.9 };
  for (const [source, payload] of Object.entries(hooks)) await env.WEBHOOK_BUFFER.put("candle:" + key + ":" + source, JSON.stringify(payload));
  const feed = t === "fallback" ? { feed: "mt5_fallback" } : {};
  const r38 = t === "prophet_incomplete" ? { ...R38, t_enc: undefined } : R38;
  const records = {
    mizan: record("mizan", timeframe, {}, MIZAN, feed),
    prophet: record("prophet", timeframe, { prophet_r38: JSON.parse(JSON.stringify(r38)), prophet_r37_ssot: R37 }, { source_hash: H("a"), implementation_hash: H("1") }, feed),
    gmi: record("gmi", timeframe, { gmi_v12_70: GMI }, { source_hash: H("b"), implementation_hash: H("1") }, feed),
    gmi_hud: record("gmi_hud", timeframe, { gmi_v12_70_hud: HUD }, { source_hash: H("c"), implementation_hash: H("2") }, feed)
  };
  for (const [engine, rec] of Object.entries(records)) {
    await registerIdentity(env.DB, identityOf(rec));
    await env.WEBHOOK_BUFFER.put("localcalc-observed:" + key + ":" + engine, JSON.stringify(rec));
  }
}

/** Runs the scenario with a fixed clock; returns everything parity produces, as plain JSON. */
export async function runParityScenario() {
  const RealDate = globalThis.Date;
  let clock = RealDate.parse("2026-11-20T00:00:00Z");
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  globalThis.Date = FixedDate;
  try {
    resetSchemaCacheForTests();
    const env = { DB: d1(), WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv() };
    await ensureSchema(env.DB);
    const reconciles = [];
    const base = RealDate.parse("2026-11-18T00:00:00Z");
    for (const [timeframe, stepMs] of [["60", 3_600_000], ["15", 900_000]]) {
      for (let i = 0; i < 32; i += 1) {
        const key = `OANDA:XAUUSD:${timeframe}:${base + i * stepMs}`;
        await seed(env, key, timeframe, i);
        clock += 60_000;
        reconciles.push([key, await reconcileLocalComputation(env, key)]);
        clock += 1_000;
        // The sweep revisits the candle: a no-op except for an open input mismatch.
        reconciles.push([key, await reconcileLocalComputation(env, key)]);
      }
    }
    // A republished final bar for the input-mismatch candle replaces the open comparison.
    const im = `OANDA:XAUUSD:60:${base + 26 * 3_600_000}`;
    await seed(env, im, "60", 0);
    clock += 60_000;
    reconciles.push([im, await reconcileLocalComputation(env, im)]);
    clock = base + 32 * 3_600_000 + 20 * 60_000;
    const sweep = await reconcileRecentCandles(env, { now: clock });
    const db = env.DB;
    const registry = (await db.prepare("SELECT * FROM engine_parity_registry ORDER BY engine, source_hash, implementation_hash").all()).results;
    const comparisons = (await db.prepare("SELECT * FROM engine_parity_comparisons ORDER BY engine, source_hash, implementation_hash, candle_key").all()).results;
    const view = await readParityView(db, { now: clock, limit: 40 });
    const listed = await listRegistry(db, 200);
    const lane = [...env.WEBHOOK_BUFFER.map.entries()].filter(([k]) => k.startsWith("localcalc:")).sort(([a], [b]) => a.localeCompare(b));
    return JSON.parse(JSON.stringify({ reconciles, sweep, registry, comparisons, view, listed, lane, signal_cache: [...env.SIGNAL_CACHE.map.entries()].sort() }));
  } finally {
    globalThis.Date = RealDate;
  }
}
