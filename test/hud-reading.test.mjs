import test from "node:test";
import assert from "node:assert/strict";
import { readHud, verifiedFields, HUD_IDS, HUD_NAMES } from "../src/hud-reading.mjs";
import { naturalLanguageErrors } from "../src/natural-language.mjs";
import { buildHudSnapshot } from "../local-engines/producer/src/hud-snapshot.mjs";
import { buildH1LocalCalculations } from "../local-engines/producer/src/h1-producer.mjs";

function series(count, minutes, endOpenMs) {
  const step = minutes * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const openMs = endOpenMs - (count - 1 - i) * step;
    const open = 3900 + Math.sin(i / 9) * 15 + i * 0.02;
    const close = open + Math.sin(i / 3) * 3;
    return { time: openMs / 1000, open_time: new Date(openMs).toISOString(), close_time: new Date(openMs + step).toISOString(), open, high: Math.max(open, close) + 1.5, low: Math.min(open, close) - 1.2, close, volume: 1000 + (i % 17) * 40 };
  });
}
const last = Date.parse("2026-11-03T09:00:00Z");
const now = Date.parse("2026-11-03T10:03:00Z");
const bundle = { timeframes: {
  H1: { candles: series(1000, 60, last) }, M15: { candles: series(2000, 15, last + 45 * 60_000) }, M1: { candles: series(3000, 1, last + 59 * 60_000) },
  H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) }, D1: { candles: series(500, 1440, Date.parse("2026-11-01T22:00:00Z")) }, W1: { candles: series(260, 10080, Date.parse("2026-10-25T21:00:00Z")) }
} };
const snapshot = buildHudSnapshot(bundle, { now });
const h1 = buildH1LocalCalculations(bundle, { now });
const approved = { ...h1.records.find(r => r.engine === "prophet").values.comparable, ...h1.records.find(r => r.engine === "gmi").values.comparable };

test("14 HUDs are named; 13 are computed locally and Grid Bot Protocol is declared not computed", () => {
  assert.equal(HUD_IDS.length, 14);
  assert.equal(HUD_NAMES.prophet, "Prophet");
  assert.deepEqual(Object.keys(snapshot.huds).sort(), HUD_IDS.filter(id => id !== "grid_bot_protocol").sort());
  assert.deepEqual(snapshot.not_computed, ["grid_bot_protocol"]);
  assert.equal(snapshot.candle_key, h1.candle_key);
});

test("every computed HUD reads as plain natural language, with no raw codes or tokens", () => {
  for (const id of Object.keys(snapshot.huds)) {
    const reading = readHud(id, { ...snapshot.huds[id], verified: verifiedFields(snapshot.huds[id], approved) });
    assert.equal(reading.available, true, id);
    for (const line of reading.lines) {
      assert.deepEqual(naturalLanguageErrors(line.text), [], `${id}: ${line.text}`);
      assert.doesNotMatch(line.text, /[A-Z]{3,}_[A-Z]|\bBLOCK_|\bundefined\b|\bnull\b|NaN/, `${id}: ${line.text}`);
    }
  }
});

test("verified marks only fields equal to the approved record, and only lines built from them", () => {
  const prophet = snapshot.huds.prophet;
  assert.deepEqual(verifiedFields(prophet, approved).sort(), ["d_enc", "structure_subtype", "t_enc"]);
  const reading = readHud("prophet", { ...prophet, verified: verifiedFields(prophet, approved) });
  assert.equal(reading.lines[0].verified, true, "structure line is verified");
  assert.ok(reading.lines.slice(2).every(l => l.verified === false), "regime and cycle internals stay unverified");
  // A tampered value is never verified.
  const tampered = { ...prophet, fields: { ...prophet.fields, d_enc: prophet.fields.d_enc + 1 } };
  assert.ok(!verifiedFields(tampered, approved).includes("d_enc"));
  // Without an approved record nothing is verified.
  assert.deepEqual(verifiedFields(prophet, null), []);
  assert.ok(readHud("prophet", prophet).lines.every(l => l.verified === false));
});

test("all enum tokens decode to sentences", () => {
  const tokens = {
    r37_funnel: ["NO_ACTIVE_SETUP", "BUY_CONFIRMED", "BUY_WAIT_PRICE", "BUY_WAIT_STRUCTURE", "BUY_WAIT_VOLUME", "BUY_WAIT", "SELL_CONFIRMED", "SELL_WAIT_PRICE", "SELL_WAIT_STRUCTURE", "SELL_WAIT_VOLUME", "SELL_WAIT"].map(gate_status => ({ gate_status })),
    trade_management: ["BULL OB PASS", "BEAR OB PASS", "BLOCK_NO_ACTIVE_BULL_OB", "BLOCK_NO_ACTIVE_BEAR_OB", "BLOCK_NO_QUALIFIED_BULL_OB", "BLOCK_NO_QUALIFIED_BEAR_OB", "BLOCK_TREND_UNRESOLVED"].map(ob_filter_status => ({ ob_filter_status, cycle_intensity: 0 })),
    fabio_amt: ["NO LTF DATA", "BULL SQUEEZE", "BEAR SQUEEZE", "BUY WALL LIMIT", "SELL WALL LIMIT", "BULL ABSORPTION", "BEAR ABSORPTION", "BULLISH CVD DIV", "BEARISH CVD DIV", "BUY CONTROL", "SELL CONTROL", "NEUTRAL"].map(footprint_status => ({ footprint_status })),
    decision_matrix: ["initial", "entropy_trap", "volume_veto", "gabfx_buy", "gabfx_sell", "fabio_m1_buy", "fabio_m1_sell", "fabio_m2_buy", "fabio_m2_sell", "jma_long", "jma_short", "kin_rev_long", "kin_rev_short"].map(branch => ({ branch }))
  };
  for (const [id, cases] of Object.entries(tokens)) {
    for (const fields of cases) {
      const lines = readHud(id, { fields }).lines.map(l => l.text);
      const token = Object.values(fields)[0];
      assert.ok(lines.length > 0, `${id} ${token}`);
      assert.ok(lines.every(t => !t.includes(token) || token === "NEUTRAL"), `${id} must not echo ${token}`);
      assert.ok(lines.every(t => naturalLanguageErrors(t).length === 0), `${id} ${token}: ${lines}`);
    }
  }
  for (const band of ["above_h6", "h5_h6", "h4_h5", "h3_h4", "l3_h3", "l4_l3", "l5_l4", "l6_l5", "below_l6"]) {
    const levels = { h4: 4, h3: 3, l3: 2, l4: 1 };
    const text = readHud("interstellar_eyes", { fields: { close: 3, camarilla: { "60": levels }, band: { "60": band } } }).lines[0].text;
    assert.ok(!text.includes(band) && naturalLanguageErrors(text).length === 0, band);
  }
});

test("unknown or empty HUDs are unavailable, never invented", () => {
  assert.equal(readHud("grid_bot_protocol", { fields: {} }).available, false);
  assert.equal(readHud("not_a_hud", { fields: { foo: 1 } }).available, false);
});
