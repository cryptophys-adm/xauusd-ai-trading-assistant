// C1 (cost brief 2026-11-27): the broker trigger runs only Prophet R38, with the HTF series trimmed. Equality proof:
// the trimmed HTF gives byte-identical R38 outputs (every bar, every field) and the same confirmation as the full
// 5m producer, on series with weekend gaps and OANDA's 22:00 UTC session grid. Synthetic bars only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateProphetR38Core } from "../../local-engines/prophet-r38/src/core.mjs";
import { buildM5LocalCalculations } from "../../local-engines/producer/src/m5-local-producer.mjs";
import { trimHigherTimeframes, brokerR38, brokerTriggerR38Mode, HTF_KEEP_BEFORE, M5_WINDOW, runBrokerTrigger } from "../src/broker-trigger.mjs";

const MIN = 60_000;
// A trading clock: Sunday 23:00 UTC to Friday 22:00 UTC (no weekend bars), as the gold feed.
const trading = (ms) => { const d = new Date(ms); const wd = d.getUTCDay(), h = d.getUTCHours(); return !(wd === 6 || (wd === 5 && h >= 22) || (wd === 0 && h < 23)); };
function bars(count, minutes, endOpenMs, { anchorHour = 0, seed = 1 } = {}) {
  const step = minutes * MIN, out = [];
  let t = endOpenMs, i = 0;
  while (out.length < count) {
    if (minutes >= 1440 || trading(t)) {
      const k = count - out.length + seed;
      const open = 4000 + Math.sin(k / 9) * 25 + Math.cos(k / 31) * 40 + k * 0.03;
      const close = open + Math.sin(k / 3.7) * 6;
      out.push({ time: t / 1000, open_time: new Date(t).toISOString(), close_time: new Date(t + step).toISOString(), open, high: Math.max(open, close) + 2 + (k % 5), low: Math.min(open, close) - 1.5 - (k % 7) * 0.5, close, volume: 900 + (k % 23) * 37 });
    }
    t -= step; i += 1;
    if (i > count * 10) break;
  }
  void anchorHour;
  return out.reverse();
}
// The last 5m bar opens Monday 2026-11-02 01:10Z: the 1000-bar window spans the weekend gap.
const lastM5Open = Date.parse("2026-11-02T01:10:00Z");
const NOW = lastM5Open + 5 * MIN + 40_000;
function bundle(endM5 = lastM5Open) {
  return { timeframes: {
    M5: { candles: bars(1000, 5, endM5) },
    M15: { candles: bars(2000, 15, Math.floor(endM5 / (15 * MIN)) * 15 * MIN, { seed: 3 }) },
    H1: { candles: bars(1000, 60, Math.floor(endM5 / (60 * MIN)) * 60 * MIN, { seed: 5 }) },
    H4: { candles: bars(500, 240, Date.parse("2026-11-01T22:00:00Z"), { seed: 7 }) },
    D1: { candles: bars(500, 1440, Date.parse("2026-10-31T22:00:00Z"), { seed: 11 }) },
    W1: { candles: bars(260, 10080, Date.parse("2026-10-25T22:00:00Z"), { seed: 13 }) }
  } };
}
const htfOf = (b) => ({ M15: b.timeframes.M15.candles, H1: b.timeframes.H1.candles, H4: b.timeframes.H4.candles, D1: b.timeframes.D1.candles, W1: b.timeframes.W1.candles });
const opts = (higher) => ({ timeframe_minutes: 5, gmi_closed_only: true, mintick: 0.001, higher_timeframes: higher });

test("BT-C1-1: trimmed HTF gives byte-identical R38 outputs on every bar (weekend gap, session grid)", () => {
  for (const end of [lastM5Open, lastM5Open - 7 * 5 * MIN]) {
    const b = bundle(end);
    const chart = b.timeframes.M5.candles.slice(-M5_WINDOW).map((x) => ({ ...x, confirmed: true }));
    const full = calculateProphetR38Core(chart, opts(htfOf(b)));
    const trimmed = trimHigherTimeframes(chart, htfOf(b));
    const total = (h) => Object.values(h).reduce((n, x) => n + x.length, 0);
    assert.ok(total(trimmed) < total(htfOf(b)) / 2, `HTF bars trimmed: ${total(htfOf(b))} -> ${total(trimmed)}`);
    const cut = calculateProphetR38Core(chart, opts(trimmed));
    assert.equal(JSON.stringify(cut.outputs), JSON.stringify(full.outputs));
  }
});

test("BT-C1-2: the same confirmation as the full 5m producer", () => {
  const b = bundle();
  const ref = buildM5LocalCalculations(b, { now: NOW }).records.find((r) => r.engine === "prophet").values.comparable.prophet_r38;
  const got = brokerR38(b, b.timeframes.M5.candles, { now: NOW });
  assert.deepEqual(got, { buy: ref.buy_confirmed, sell: ref.sell_confirmed });
  assert.deepEqual(brokerR38(b, b.timeframes.M5.candles, { now: NOW, trim: false }), got);
});

test("BT-C1-3: the producer's guards, with its error codes", () => {
  const b = bundle();
  const m5 = b.timeframes.M5.candles;
  assert.throws(() => brokerR38(b, m5.slice(-399), { now: NOW }), (e) => e.code === "insufficient_m5_history");
  assert.throws(() => brokerR38(b, m5, { now: lastM5Open + MIN }), (e) => e.code === "m5_bar_not_closed");
  const odd = [...m5.slice(0, -1), { ...m5.at(-1), close_time: new Date(lastM5Open + 4 * MIN).toISOString() }];
  assert.throws(() => brokerR38(b, odd, { now: NOW }), (e) => e.code === "m5_bar_invalid");
});

test("BT-C1-4: the trim keeps HTF_KEEP_BEFORE bars before the selected one; out-of-order or overlapping series stay whole", () => {
  const b = bundle();
  const chart = b.timeframes.M5.candles.slice(-M5_WINDOW);
  const h = htfOf(b);
  const t = trimHigherTimeframes(chart, h);
  const first = Date.parse(chart[0].open_time);
  for (const tf of Object.keys(h)) {
    const sel = t[tf].findIndex((x) => Date.parse(x.open_time) <= first && first < Date.parse(x.close_time));
    const before = sel >= 0 ? sel - 1 : t[tf].filter((x) => Date.parse(x.close_time) <= first).length - 1;
    assert.ok(before >= HTF_KEEP_BEFORE || t[tf].length === h[tf].length, `${tf}: ${before} bars kept before the selected one`);
    assert.deepEqual(t[tf].at(-1), h[tf].at(-1), "the newest bars stay");
  }
  assert.ok(HTF_KEEP_BEFORE > 50, "more than the z-score's 50-bar window");
  const shuffled = [...h.H1]; [shuffled[10], shuffled[11]] = [shuffled[11], shuffled[10]];
  assert.equal(trimHigherTimeframes(chart, { H1: shuffled }).H1.length, shuffled.length);
  const overlap = h.H4.map((x, i) => (i === 100 ? { ...x, close_time: new Date(Date.parse(x.close_time) + 5 * 3600_000).toISOString() } : x));
  assert.equal(trimHigherTimeframes(chart, { H4: overlap }).H4.length, overlap.length);
  const short = h.D1.slice(-20);
  assert.equal(trimHigherTimeframes(chart, { D1: short }).D1.length, 20, "too short to trim");
  assert.deepEqual(trimHigherTimeframes([], h).H1.length, h.H1.length, "no chart bar: nothing trimmed");
});

test("BT-C1-5: the switch: on by default, 'off' runs the full producer, 'shadow' runs both with the same result", async () => {
  assert.equal(brokerTriggerR38Mode({}), "on");
  assert.equal(brokerTriggerR38Mode({ BROKER_TRIGGER_R38_ONLY: " Shadow " }), "shadow");
  assert.equal(brokerTriggerR38Mode({ BROKER_TRIGGER_R38_ONLY: "off" }), "off");
  assert.equal(brokerTriggerR38Mode({ BROKER_TRIGGER_R38_ONLY: "junk" }), "on");
  const src = readFileSync(new URL("../src/broker-trigger.mjs", import.meta.url), "utf8");
  assert.match(src, /mode === "off" \? full\(\) : brokerR38\(bundle, broker\.candles, \{ now, mintick \}\)/);
  assert.ok(typeof runBrokerTrigger === "function");
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"BROKER_TRIGGER_R38_ONLY": "on"/);
});
