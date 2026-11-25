// Z0 fixtures (test/zone-types.test.mjs): a 15m decision around 4000 (1H ATR about 10) with every chart's demand and
// supply boxes (whale zones, the best order blocks, the GABFX points, the 15m GMI flags), and the scenario both trees
// run: the strategy, the assessment, the decision record, the council's evidence and messages, the EA signal, the
// management fields, the public recap and analysis, and the plan learner's rows after one decision. It is written
// against modules passed in, so the same code runs on this tree and on main before Z0 (the pinned hash in the test was
// taken with it on a git-archive of main 74be83c, MS2).

export const CLOSE = "2026-11-20T13:00:00.000Z";
export const NOW = Date.parse(CLOSE) + 70_000;
const M1 = 60_000, M15 = 15 * M1, H1 = 60 * M1;
const iso = (ms) => new Date(ms).toISOString();

/** A chart plane around 4000: a demand whale under price, a supply whale above, GABFX points and bands. */
const plane = (tf) => ({
  version: "cryptophys.chart-plane.v1", close: 4000, atr: tf === "15" ? 4 : 10,
  bands: { kww: { ma: 4004, plus_1618: 4021.5, minus_1618: 3986.5, zscore: -0.4 }, ema_114: 4019.2, vwap: 3999.4, tva: { upper: 4041, lower: 3979.6 } },
  liquidity: {
    fvg: { bull: [{ price: 3996.8, mass: 1.2 }], bear: [{ price: 4020.6, mass: 1 }] },
    whale_zones: tf === "15"
      ? [{ role: "support", state: "active", top: 3999.2, bottom: 3996.4, hp: 1.4, age_bars: 8 }, { role: "resistance", state: "active", top: 4021.4, bottom: 4019.6, hp: 1.1, age_bars: 20 }]
      : tf === "60"
        ? [{ role: "resistance", state: "active", top: 4022, bottom: 4019, hp: 2, age_bars: 6 }, { role: "resistance", state: "mitigation", top: 3982, bottom: 3979, hp: null, age_bars: 30 }]
        : tf === "240" ? [{ role: "support", state: "active", top: 3998, bottom: 3995.5, hp: 1.8, age_bars: 4 }] : [],
    gabfx: tf === "15" ? { rbs: 3997.4, qm_buy: null, sbr: null, qm_sell: 4020.4 } : { rbs: null, qm_buy: null, sbr: null, qm_sell: null },
    profile: { hvn_bull: 3996, hvn_bear: 4021 }
  },
  projection: { pa: { resistance: 4020.2, support: 3980.4 } },
  session: { opens: { day: 3998.6, week: 4019.8 } }
});
const snap = (tf, computedAt) => ({
  timeframe: tf, computed_at: computedAt,
  huds: {
    interstellar_eyes: { fields: { close: 4000, camarilla: tf === "60" ? { "60": { h3: 4020.5, h4: 4041, h5: 4060, l3: 3997, l4: 3980.2, l5: 3960 } } : {} } },
    fabio_amt: { fields: { poc: tf === "60" ? 3997.8 : null, vah: tf === "60" ? 4021.2 : null, val: tf === "60" ? 3980.8 : null } },
    order_blocks: { fields: tf === "60" ? { bull_top: 3999, bull_bottom: 3995, bear_top: 4023, bear_bottom: 4018.5 } : tf === "240" ? { bear_top: 3982.5, bear_bottom: 3978.5 } : {} },
    ...(tf === "15" ? { aegis_footprint: { fields: { in_bull_order_block: true, in_bear_order_block: false, in_bull_mitigation: false, in_bear_mitigation: false } } } : {})
  },
  chart_plane: plane(tf)
});
/** Closed bars of `ms` each up to `end`, oscillating about 4000 with a high-low range near `range`. */
const bars = (n, ms, range, end = Date.parse(CLOSE)) => Array.from({ length: n }, (_, i) => {
  const open = end - (n - i) * ms, mid = 4003 + 6 * Math.sin(i / 3);
  const close = i === n - 1 ? 4000 : mid;
  return { open_time: iso(open), close_time: iso(open + ms), open: mid, high: Math.max(mid, close) + range / 2, low: Math.min(mid, close) - range / 2, close, volume: 100 };
});
const op = (id, bias) => ({ id, status: "ok", stance: "WAIT", bias, confidence: 0.6 });
const room = (biases, barClose) => ({ bar_close: barClose, openings: biases.map((b, i) => op(`a${i}`, b)), conclusion: { status: "ok", stance: "WAIT", bias: null, confidence: 0.6 } });
const bull = ["BULLISH", "BULLISH", "BULLISH", "NEUTRAL"];

/**
 * Z1a: every active Prophet order block of a chart (chart_plane.zones.prophet, local-engines/producer/src/adopt/
 * prophet-ob.mjs's shape), the 4 nearest per side. The 1H holds a high-volume demand block in the demand zone under
 * price, a second demand block where Z0 had no type, and a supply block above, tested 3 times on the 1H bars where the
 * 15m bars never touched it; the 4H holds the supply block its best block already was; the 15m holds none.
 */
export const PROPHET_ZONES = Object.freeze({
  "60": [
    { side: "demand", top: 3998.6, bottom: 3996.2, age_bars: 12, high_volume: true, touches: 3 },
    { side: "demand", top: 3986.4, bottom: 3984.1, age_bars: 40, high_volume: false, touches: 0 },
    { side: "supply", top: 4021.8, bottom: 4019.4, age_bars: 7, high_volume: false, touches: 3 }
  ],
  "240": [{ side: "supply", top: 3982.2, bottom: 3979.2, age_bars: 18, high_volume: false, touches: 0 }],
  "15": [],
  "1D": [{ side: "demand", top: 3961.5, bottom: 3955.5, age_bars: 30, high_volume: true, touches: 2 }]
});
/** The inputs with PROPHET_ZONES in each chart's plane (Z1a). */
export function withProphetZones(inputs) {
  const add = (s) => (s?.chart_plane ? { ...s, chart_plane: { ...s.chart_plane, zones: { prophet: PROPHET_ZONES[s.timeframe].map((z) => ({ ...z })) } } } : s);
  return { ...inputs, h1Snapshot: add(inputs.h1Snapshot), m15Snapshot: add(inputs.m15Snapshot), h4Snapshot: add(inputs.h4Snapshot), d1Snapshot: add(inputs.d1Snapshot) };
}

/**
 * Z1b: GMI's active Aegis validated order blocks of a chart (chart_plane.zones.aegis, local-engines/producer/src/adopt/
 * gmi-zone.mjs's shape), the 4 nearest per side. The 15m holds a demand block at price (where Z0's 15m GMI flag typed
 * the zone), the 1H a demand block with the edges of Prophet's second 1H block (the same block, as the two cores find: it counts once) and a
 * supply block where Z1a had no type, tested twice; the 4H has an empty list; the daily plane has no `aegis` (a chart
 * GMI did not run on).
 */
export const AEGIS_ZONES = Object.freeze({
  "15": [{ side: "demand", top: 3999.6, bottom: 3998.9, age_bars: 6, touches: 1 }],
  "60": [
    { side: "demand", top: 3986.4, bottom: 3984.1, age_bars: 40, touches: 0 },
    { side: "supply", top: 4024.6, bottom: 4023.4, age_bars: 9, touches: 2 }
  ],
  "240": []
});
/** The inputs with AEGIS_ZONES beside the planes' Prophet zones (Z1b). */
export function withAegisZones(inputs) {
  const add = (s) => (s?.chart_plane && AEGIS_ZONES[s.timeframe] ? { ...s, chart_plane: { ...s.chart_plane, zones: { ...(s.chart_plane.zones || {}), aegis: AEGIS_ZONES[s.timeframe].map((z) => ({ ...z })) } } } : s);
  return { ...inputs, h1Snapshot: add(inputs.h1Snapshot), m15Snapshot: add(inputs.m15Snapshot), h4Snapshot: add(inputs.h4Snapshot), d1Snapshot: add(inputs.d1Snapshot) };
}

/**
 * The strategy engine's inputs (loadStrategyInputs' shape); `modes` as given; `prophet` adds Z1a's PROPHET_ZONES;
 * `aegis` adds Z1b's AEGIS_ZONES (with PROPHET_ZONES: Z1b's planes carry both).
 */
export function zoneInputs(modes = undefined, { prophet = false, aegis = false } = {}) {
  if (aegis) return withAegisZones(zoneInputs(modes, { prophet: true }));
  if (prophet) return withProphetZones(zoneInputs(modes));
  return {
    rooms: { D1: room(bull, "2026-11-19T22:00:00.000Z"), H4: room(bull, "2026-11-20T12:00:00.000Z"), H1: room(bull, CLOSE), M15: { ...room(bull, null), bar_time: CLOSE } },
    news: null, confirmations: { m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: true, candle_time: CLOSE } },
    h1Snapshot: snap("60", "2026-11-20T13:00:00Z"), m15Snapshot: snap("15", "2026-11-20T13:00:00Z"), h4Snapshot: snap("240", "2026-11-20T12:00:00Z"), d1Snapshot: snap("1D", "2026-11-19T22:00:00Z"),
    h1Bars: bars(60, H1, 9), m15Bars: bars(60, M15, 3), h4Bars: bars(60, 4 * H1, 16), d1Bars: bars(60, 24 * H1, 30), w1Bars: [],
    h1Chain: null, calendar: { events: [] }, releases: [], patternCalibration: null, m5Price: null,
    ...(modes ? { modes } : {}), now: NOW
  };
}

const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: CLOSE, stale: false });
const global = () => ({ timeframes: [row("D1", 0.5), row("H4", 0.45), row("H1", 0.4), row("M15", 0.35, "BUY"), row("NEWS", 0.2), row("MACRO", 0.1)] });
export const ZONE_ENV = Object.freeze({ MODEL_RATE_LIMIT_RETRY_MS: "0", TRADING_MODE: "intraday", STRATEGY_EXECUTION: "off", STRATEGY_AGENTS_LIVE: "sweep_reversal,breakout_retest,range_fade" });
export const PLAN_COLUMNS = "setup_key, decision_key, agent, pattern, opened_at, decided_at, last_seen_at, decisions, side, entry, stop, tp1, atr_h1, mode, action, at_level, regime, context, status, version, source, rule_version";

/**
 * The scenario. `mods`: { se, de, ea, pp, pa, pl } (strategy-engine, decision-engine, ea-signal, public-projection,
 * public-analysis, plan-learning); `db` and `kv` make a D1 and a KV; `modes` the strategy's modes; `extraColumns` more
 * plan_setups columns to read; `prophet` adds Z1a's PROPHET_ZONES to the charts' planes, `aegis` Z1b's AEGIS_ZONES too.
 */
export async function zoneScenario({ se, de, ea, pp, pa, pl }, { db, kv, modes = undefined, env: extraEnv = {}, extraColumns = "", prophet = false, aegis = false } = {}) {
  const env = { ...ZONE_ENV, ...extraEnv };
  const inputs = zoneInputs(modes, { prophet, aegis });
  const strategy = se.buildStrategy(inputs);
  const loaded = { inputs, strategy, global: global(), correlations: null, regime: "normal-trending" };
  const assessment = de.assess(loaded, { now: NOW, env });
  const key = `OANDA:XAUUSD:15:${Date.parse(CLOSE) - M15}`;
  const record = de.buildDecisionRecord({ key, barClose: CLOSE, loaded, assessment, council: null, now: NOW, env });
  const evidence = de.councilEvidence({ barClose: CLOSE, cards: assessment.cards, quorum: assessment.quorum, guards: assessment.guards });
  const messages = de.councilMessages(evidence);
  const signal = ea.eaSignalFromDecision({ decision: record, now: NOW });
  const management = ea.managementFields(record);
  const recap = pp.publicRecap({ decision_key: key, bar_close: CLOSE, stance: record.stance, bias: record.bias, decision_json: JSON.stringify(record) });
  const analysis = pa.publicAnalysis(strategy.key_levels, { now: NOW });
  // One decision through the engine and the plan learner on a sqlite D1.
  pl.resetPlanLearningSchemaCacheForTests?.(); de.resetDecisionSchemaCacheForTests?.();
  const run = { DB: db(), SIGNAL_CACHE: kv(), AI: { run: async () => { throw new Error("model down"); } }, ...env };
  await run.SIGNAL_CACHE.put(de.TRADING_MODE_KEY, "intraday");
  await de.runDecisionEngine(run, { barClose: CLOSE, now: NOW, clock: () => NOW + 5_000, loaded });
  const stored = run.DB.raw.prepare("SELECT decision_json FROM engine_decisions").get()?.decision_json ?? null;
  await pl.runPlanLearning(run, { now: Date.parse(CLOSE) + 3 * H1, bars: [] });
  const planRows = run.DB.raw.prepare(`SELECT ${PLAN_COLUMNS}${extraColumns} FROM plan_setups ORDER BY setup_key`).all().map((r) => ({ ...r }));
  return { strategy, guards: { long: assessment.guards.long, short: assessment.guards.short }, record, evidence, messages, signal, management, recap, analysis, stored, planRows, run };
}
