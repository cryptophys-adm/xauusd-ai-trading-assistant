import test from "node:test";
import assert from "node:assert/strict";
import { bandLevels, liquidityLevels, projectionLevels, sessionLevels, readPlane, setupType, READERS } from "../src/level-readers.mjs";
import { buildKeyLevels } from "../src/key-level-agent.mjs";
import { buildStrategy, tradeLevels } from "../src/strategy-engine.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";

/** A chart plane as chart-plane.mjs emits it, around a price of 4040. */
const plane = (over = {}) => ({
  version: "cryptophys.chart-plane.v1", close: 4040, atr: 6,
  bands: { kww: { ma: 4046, plus_1: 4052, minus_1: 4040, plus_1618: 4055.7, minus_1618: 4036.3, zscore: -1.0 }, ema_114: 4030, vwap: 4044, tva: { mid: 4045, upper: 4070, lower: 4020, period: 150, slope_per_bar: 0.1 } },
  liquidity: {
    fvg: { bull: [{ price: 4039.5, mass: 1.2 }, { price: 4020, mass: 0.1 }], bear: [{ price: 4065, mass: 3 }] },
    whale_zones: [{ role: "support", state: "active", top: 4041, bottom: 4038, hp: 1.4, age_bars: 12 }, { role: "resistance", state: "mitigation", top: 4070, bottom: 4067, hp: null, age_bars: 40 }],
    gabfx: { qm_buy: 4012, qm_sell: null, rbs: 4041, sbr: null },
    profile: { poc: 4050, vah: 4066, val: 4031, lvn_bull: [4035], lvn_bear: [4058], hvn_bull: 4028, hvn_bear: 4062 }
  },
  projection: {
    fib: { direction: "up", high: 4060, low: 4000, warp: 1, levels: { "0.618": 4037.1, "0.786": 4047.2, "0.5": 4030, "1.272": 4076.3, "1.618": 4097.1, "0": 4000, "1": 4060 } },
    cone: { bars: 50, p90: 4110, p10: 3970 },
    trendlines: { resistance: { price_now: 4072 }, support: { price_now: 4033 } },
    pa: { resistance: 4061, support: 4031 }
  },
  session: {
    opens: { year: 2650, month: 3990, week: 4010, day: 4044, asia: 4042, london: 4046, ny_am: 4039, ny_pm: null },
    baselines: { day_open: 4043, week_open: 4011, prev_day_high: 4060, prev_day_low: 4020 },
    profile: { intrabars: "M1", current: { session: "2026-11-06", poc: 4045, vah: 4052, val: 4036 }, previous: null }
  },
  ...over
});

test("the four readers: bands, liquidity, projection and session levels with their base weights", () => {
  const b = bandLevels(plane(), "15");
  assert.deepEqual(b.map((l) => l.label), ["KWW +1.618σ", "KWW −1.618σ", "KWW mean", "EMA 114", "VWAP", "TVA channel top", "TVA channel bottom"]);
  assert.ok(!bandLevels(plane(), "240").some((l) => l.label === "VWAP"), "VWAP only on 15m and 1H");
  const l = liquidityLevels(plane());
  assert.equal(l.find((x) => x.label === "RBS flip level").weight, 1.0);
  assert.equal(l.find((x) => x.label === "whale support zone top").weight, 0.9);
  assert.equal(l.find((x) => x.label === "whale mitigation block (resistance) top").weight, 0.7);
  assert.deepEqual(l.filter((x) => x.kind === "fvg").map((x) => x.weight), [0.84, 0.21, 1.05], "0.7 x the mass, clamped to 0.3..1.5");
  assert.ok(!l.some((x) => /point of control|value area/.test(x.label)), "the TDM value area is read from the HUD already");
  const p = projectionLevels(plane());
  assert.deepEqual(p.filter((x) => x.kind === "fibonacci").map((x) => x.label), ["Fibonacci 0.618 (OTE)", "Fibonacci 0.786 (OTE)", "Fibonacci 0.5", "Fibonacci 1.272 extension", "Fibonacci 1.618 extension"]);
  const s = sessionLevels(plane());
  assert.ok(s.every((x) => x.tf === "D"), "session levels carry the daily timeframe");
  assert.equal(s.find((x) => x.label === "true month open").weight, 1.0);
  assert.equal(s.find((x) => x.label === "session point of control").weight, 0.9);
  assert.ok(!s.some((x) => x.label === "true NY PM open"), "a missing open adds nothing");
  assert.deepEqual(new Set(readPlane(plane(), "15").map((x) => x.reader)), new Set(Object.keys(READERS)));
  assert.deepEqual(readPlane(null, "15"), []);
});

test("the Key Level Agent counts the readers' levels; session levels count once across charts", () => {
  const snap = (tf, computed_at) => ({ timeframe: tf, computed_at, huds: { fabio_amt: { fields: {} } }, chart_plane: plane() });
  const r = buildKeyLevels({ snapshots: { "15": snap("15", "2026-11-06T14:15:00Z"), "60": snap("60", "2026-11-06T14:00:00Z") }, bars: {}, price: 4040, atrH1: 10 });
  assert.ok(r.readers.band.levels >= 13 && r.readers.liquidity.levels > 0 && r.readers.projection.levels > 0);
  const sessionCount = readPlane(plane(), "15").filter((x) => x.reader === "session").length;
  assert.equal(r.readers.session.levels, sessionCount, "the 1H snapshot's session levels are the same values: counted once");
  const z = r.zones.find((x) => x.low <= 4040 && x.high >= 4038);
  assert.ok(z && z.sources >= 3, "the FVG target, the whale zone and the bands stack at 4038-4041");
  assert.ok(z.members.some((m) => m.reader === "liquidity"));
});

test("setup type: a pullback with the trend into liquidity, a stretched sweep into a QM level, or none", () => {
  const cont = setupType({ dir: 1, price: 4040, m15Plane: plane(), near: 3.5 });
  assert.equal(cont.type, "continuation_pullback");
  assert.ok(cont.evidence.some((e) => /OTE/.test(e)) && cont.evidence.some((e) => /FVG/.test(e)));
  const sweep = setupType({ dir: 1, price: 4012, m15Plane: plane({ bands: { kww: { ma: 4046, zscore: -2.1 } } }), near: 3.5 });
  assert.equal(sweep.type, "reversal_sweep");
  assert.ok(sweep.evidence.some((e) => /QM buy/.test(e)));
  assert.equal(setupType({ dir: -1, price: 4040, m15Plane: plane(), near: 3.5 }).type, "none", "a short has no liquidity with it here");
  assert.equal(setupType({ dir: 1, price: 4040, m15Plane: null }).type, "none");
});

test("the strategy's 15m location reads the setup type; the replay inputs keep the chart plane", () => {
  const h1Bars = Array.from({ length: 20 }, (_, i) => ({ open: 4000 + i, high: 4006 + i, low: 3996 + i, close: 4001 + i }));
  // Away from every HUD level: only the chart plane puts price at a location.
  const m15Bars = Array.from({ length: 10 }, () => ({ open: 4040, high: 4041, low: 4039, close: 4040 }));
  const op = (b) => ({ status: "ok", stance: "WAIT", bias: b, confidence: 0.6 });
  const room = (bar_close) => ({ bar_close, openings: ["BULLISH", "BULLISH", "BULLISH"].map(op), conclusion: op(null) });
  const snap = (tf, extra = {}) => ({ timeframe: tf, candle_key: `OANDA:XAUUSD:${tf}:1`, huds: { interstellar_eyes: { fields: { close: 4040 } }, decision_matrix: { fields: { verdict: 1 } } }, ...extra });
  const base = {
    rooms: { D1: room("2026-11-05T22:00:00.000Z"), H4: room("2026-11-06T14:00:00.000Z"), H1: room("2026-11-06T14:00:00.000Z"), M15: { ...room(null), bar_time: "2026-11-06T14:15:00.000Z" } },
    h1Bars, m15Bars, confirmations: { m5_prophet_r38: { buy_confirmed: false, verified: true } }, now: Date.parse("2026-11-06T14:20:00Z")
  };
  const without = buildStrategy({ ...base, h1Snapshot: snap("60"), m15Snapshot: snap("15") });
  assert.equal(without.setup.type, "none");
  const withPlane = buildStrategy({ ...base, h1Snapshot: snap("60"), m15Snapshot: snap("15", { chart_plane: plane() }) });
  assert.equal(withPlane.direction, "LONG");
  assert.equal(withPlane.setup.type, "continuation_pullback");
  assert.equal(withPlane.plan.at_level, true);
  assert.match(withPlane.plan.entry_note, /RBS flip level|FVG|whale/, "the plane's levels stack into the zone price holds at");
  // Where no zone holds price, the setup type itself is the location, named in the entry note.
  const lone = tradeLevels({ dir: 1, price: 4040, levels: [], atrH1: 10, inZone: true, zoneNote: "a pullback with the trend: at an open bullish FVG target" });
  assert.equal(lone.at_level, true);
  assert.match(lone.entry_note, /^a pullback with the trend/);
  assert.equal(withPlane.state, "SETUP_READY", withPlane.headline);
  const slim = slimInputs({ ...base, m15Snapshot: snap("15", { chart_plane: plane() }) });
  assert.equal(slim.m15Snapshot.chart_plane.version, "cryptophys.chart-plane.v1", "the replay sees the same plane");
});
