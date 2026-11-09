import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { computeGmiOnChart } from "../src/gmi-core-tf.mjs";
import { computeGmiOnHtfChart, GMI_CHART_MINUTES, intrabarTimeframe } from "../src/gmi-core-htf.mjs";
import { buildHtfLocalCalculations, htfWebhookCandleKey, HTF_CHARTS } from "../../producer/src/htf-local-producer.mjs";
import { ENGINE_PROVENANCE } from "../../producer/src/provenance.generated.mjs";

/**
 * A synthetic market built from one base path (baseMin bars) and aggregated to every
 * timeframe. H4 and D1 are anchored at 22:00 UTC, as OANDA's 17:00 New York sessions.
 */
function bundleFrom({ endMs, baseMin, days }) {
  const n = Math.floor((days * 1440) / baseMin);
  const startMs = endMs - n * baseMin * 60_000;
  const base = [];
  for (let i = 0; i < n; i++) {
    const t = startMs + i * baseMin * 60_000;
    const o = 3900 + Math.sin(i / 97) * 18 + Math.sin(i / 13) * 3 + i * 0.001;
    const c = o + Math.sin(i / 5) * 0.8;
    base.push({ t, o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 50 + (i % 11) * 7 });
  }
  const anchor22 = 22 * 3600_000;
  const agg = (periodMin, anchor = 0) => {
    const ms = periodMin * 60_000, out = new Map();
    for (const b of base) {
      const open = Math.floor((b.t - anchor) / ms) * ms + anchor;
      const cur = out.get(open);
      if (!cur) out.set(open, { open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, openMs: open, ms });
      else { cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c; cur.volume += b.v; }
    }
    return [...out.values()].filter((b) => b.openMs >= startMs && b.openMs + b.ms <= endMs).map((b) => ({
      time: b.openMs / 1000, open_time: new Date(b.openMs).toISOString(), close_time: new Date(b.openMs + b.ms).toISOString(),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume
    }));
  };
  const tf = { M15: { candles: agg(15) }, H1: { candles: agg(60) }, H4: { candles: agg(240, anchor22 % (240 * 60_000)) }, D1: { candles: agg(1440, anchor22) }, W1: { candles: agg(10080, anchor22) } };
  if (baseMin <= 1) tf.M1 = { candles: agg(1) };
  if (baseMin <= 5) tf.M5 = { candles: agg(5) };
  return { timeframes: tf };
}

test("dyn_ltf: M1 below 240, M5 on H4, M15 on D1; H4 and D1 are supported charts", () => {
  assert.deepEqual(Object.keys(GMI_CHART_MINUTES), ["M5", "M15", "H1", "H4", "D1"]);
  assert.equal(intrabarTimeframe(15), "M1");
  assert.equal(intrabarTimeframe(60), "M1");
  assert.equal(intrabarTimeframe(240), "M5");
  assert.equal(intrabarTimeframe(1440), "M15");
});

test("B4: one GMI engine; the tf and htf modules are re-exports of it, so no copy can drift", async () => {
  const one = await import("../src/gmi-core.mjs");
  assert.equal(computeGmiOnChart, one.computeGmiOnChart);
  assert.equal(computeGmiOnHtfChart, one.computeGmiOnChart);
  assert.equal(GMI_CHART_MINUTES, one.GMI_CHART_MINUTES);
  for (const file of ["gmi-core-tf.mjs", "gmi-core-htf.mjs"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.ok(src.split("\n").filter((l) => l.trim() && !l.startsWith("//")).length === 1, `${file} is one export line`);
  }
});

test("B4 golden outputs: the one engine reproduces the three former modules on every chart", () => {
  // Fingerprints (sha256 of the whole output, first 16 hex) of the H1 core, gmi-core-tf (5m,
  // 15m) and gmi-core-htf (4H, D1) on these synthetic markets, taken before the merge on
  // 2026-11-09. The merge was proven output-identical on 80 bundles across five charts; any later
  // change to the engine that moves an output fails here and must re-earn parity on purpose.
  const fp = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
  const m1 = bundleFrom({ endMs: Date.parse("2026-11-03T10:00:00Z"), baseMin: 1, days: 16 });
  const b5 = bundleFrom({ endMs: Date.parse("2026-11-04T02:00:00Z"), baseMin: 5, days: 60 });
  const b15 = bundleFrom({ endMs: Date.parse("2026-11-04T22:00:00Z"), baseMin: 15, days: 420 });
  const golden = { H1: ["4acf71ea82ec4b41", m1], M5: ["c4accf3d6a0615fa", m1], M15: ["15c1aa6285f2594d", m1], H4: ["ab973b1b7fec6991", b5], D1: ["12aa0c05630ffd11", b15] };
  for (const [chart, [hash, bundle]] of Object.entries(golden)) assert.equal(fp(computeGmiOnChart(bundle, { chart })), hash, chart);
});

test("GMI on H4 reads 5-minute intrabars and on D1 15-minute intrabars", () => {
  const h4End = Date.parse("2026-11-04T02:00:00Z"); // an H4 close of the 22:00-anchored grid
  const h4 = computeGmiOnHtfChart(bundleFrom({ endMs: h4End, baseMin: 5, days: 60 }), { chart: "H4" });
  assert.equal(h4.open_time, new Date(h4End - 4 * 3600_000).toISOString());
  assert.equal(h4.diagnostics.intrabars, 48);
  assert.deepEqual(Object.keys(h4.comparable), ["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"]);
  const d1End = Date.parse("2026-11-04T22:00:00Z");
  const d1 = computeGmiOnHtfChart(bundleFrom({ endMs: d1End, baseMin: 15, days: 340 }), { chart: "D1" });
  assert.equal(d1.open_time, new Date(d1End - 86400_000).toISOString());
  assert.equal(d1.diagnostics.intrabars, 96);
});

test("the H4 and D1 producers key records like the TradingView webhooks (\"240\", \"1D\", bar open)", () => {
  const h4End = Date.parse("2026-11-04T02:00:00Z");
  const now = h4End + 3 * 60_000;
  const h4 = buildHtfLocalCalculations(bundleFrom({ endMs: h4End, baseMin: 5, days: 60 }), { chart: "H4", now });
  const open = h4End - 4 * 3600_000;
  assert.equal(h4.candle_key, `OANDA:XAUUSD:240:${open}`);
  assert.equal(htfWebhookCandleKey("H4", open), h4.candle_key);
  assert.deepEqual(h4.records.map((r) => [r.engine, r.timeframe]), [["mizan", "240"], ["prophet", "240"], ["gmi", "240"]]);
  const prophet = h4.records.find((r) => r.engine === "prophet");
  assert.equal(prophet.provenance.implementation_hash, ENGINE_PROVENANCE.prophet_h4.implementation_hash);
  assert.deepEqual(Object.keys(prophet.values.comparable), ["prophet_r38", "prophet_r37_ssot"]);
  assert.equal(h4.records.find((r) => r.engine === "gmi").provenance.implementation_hash, ENGINE_PROVENANCE.gmi_h4.implementation_hash);

  const d1End = Date.parse("2026-11-04T22:00:00Z");
  const d1 = buildHtfLocalCalculations(bundleFrom({ endMs: d1End, baseMin: 15, days: 340 }), { chart: "D1", now: d1End + 60_000 });
  assert.equal(d1.candle_key, `OANDA:XAUUSD:1D:${d1End - 86400_000}`);
  assert.ok(d1.records.every((r) => r.timeframe === "1D"));
  assert.equal(d1.records.find((r) => r.engine === "gmi").provenance.implementation_hash, ENGINE_PROVENANCE.gmi_d1.implementation_hash);
  assert.deepEqual(Object.keys(HTF_CHARTS), ["H4", "D1"]);
  assert.throws(() => buildHtfLocalCalculations(bundleFrom({ endMs: d1End, baseMin: 15, days: 30 }), { chart: "D1", now: d1End + 60_000 }), /insufficient D1 history/);
});
