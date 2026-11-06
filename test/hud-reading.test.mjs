import test from "node:test";
import assert from "node:assert/strict";
import { readHud, verifiedFields, HUD_IDS, HUD_NAMES, calibrationCounts, calibrationNote, calibratedLines } from "../src/hud-reading.mjs";
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

test("computed from verified bars: only pure bar formulas, and only when the candle's bar is verified", () => {
  const chronos = { fields: { session_london: true, session_new_york: true, daily_cpr: { position: "above_tc", pivot: 4000, bc: 3990, tc: 4010 }, weekly_cpr: { position: "inside", pivot: 3980, bc: 3970, tc: 3990 }, verdict: 3 }, parity: { verdict: "gmi_v12_70.verdict" } };
  const eyes = { fields: { close: 4050, camarilla: { D: { h4: 4100, h3: 4070, l3: 4010, l4: 3990 }, W: { h4: 4200, h3: 4150, l3: 3950, l4: 3900 } }, band: { D: "l3_h3", W: "l3_h3" } } };
  const fabio = { fields: { close: 4050, vah: 4071, val: 3894, poc: 3948, footprint_status: "NEUTRAL" } };

  const withBars = readHud("chronos_matrix", { ...chronos, verified: ["verdict"], bars_verified: true });
  assert.deepEqual(withBars.lines.map(l => [l.verified, l.derived]), [[false, true], [false, true], [false, true], [true, false]], "sessions and both pivot lines are bar formulas; the verdict stays parity verified");
  assert.deepEqual(calibrationCounts(withBars.lines), { verified_lines: 1, derived_lines: 3, total_lines: 4 });
  assert.equal(calibrationNote(calibrationCounts(withBars.lines)), "1 verified by parity, 3 computed from verified bars (of 4 statements)");

  assert.ok(readHud("interstellar_eyes", { ...eyes, bars_verified: true }).lines.every(l => l.derived && !l.verified));
  assert.ok(readHud("fabio_amt", { ...fabio, bars_verified: true }).lines.every(l => !l.derived), "the value area is a GMI volume-profile internal, not a bar formula");

  // Without a verified bar nothing is derived, and the counts fall back to the old two tiers.
  const noBars = readHud("chronos_matrix", { ...chronos, verified: ["verdict"] });
  assert.ok(noBars.lines.every(l => l.derived === false));
  assert.equal(calibratedLines(calibrationCounts(readHud("interstellar_eyes", eyes).lines)), 0);
  assert.equal(calibrationNote({ verified_lines: 0, derived_lines: 0, total_lines: 3 }), "not yet calibrated");
  assert.equal(calibrationNote({ verified_lines: 2, total_lines: 5 }, "x"), "2 verified by parity (of 5 statements)");
});

test("Prophet reads its state: the cycle bias and the setup gate, like the Prophet HUD on TradingView (Prophet audit 2026-11-06)", () => {
  const base = { d_enc: 0, structure_subtype: 0, t_enc: 0 };
  const bull = readHud("prophet", { fields: { ...base, cycle_intensity: 3, gate_status: "BUY_WAIT_STRUCTURE" } });
  assert.ok(bull.lines.some(l => l.text === "Prophet's state: a bullish bias from all three cycles, and a buy setup is waiting for structure confirmation."), bull.lines.map(l => l.text).join(" | "));
  const mixed = readHud("prophet", { fields: { ...base, cycle_intensity: 1, gate_status: "NO_ACTIVE_SETUP" } });
  assert.ok(mixed.lines.some(l => l.text === "Prophet's state: no bias, because the three cycles do not agree, and no buy or sell setup is active."));
  const risk = readHud("prophet", { fields: { ...base, t_enc: 4, cycle_intensity: -3, gate_status: "SELL_CONFIRMED" } });
  assert.ok(risk.lines.some(l => /^Prophet's state: a bearish bias from all three cycles, and the sell setup is confirmed; a risk veto calls for reducing risk\.$/.test(l.text)));
  // Without the setup gate the cycle line stays as it was.
  assert.ok(readHud("prophet", { fields: { ...base, cycle_intensity: 3 } }).lines.some(l => l.text === "On the cycle read, all three Prophet cycles point up."));
  for (const r of [bull, mixed, risk]) for (const l of r.lines) assert.deepEqual(naturalLanguageErrors(l.text), [], l.text);
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

test("Macro & Aether carries every Pine row when the macro series exist, and reads as natural language", () => {
  const macroBundle = { ...bundle, external_series: {
    "TVC:DXY": { H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) } },
    "CRYPTOCAP:USDT": { H4: { candles: series(500, 240, Date.parse("2026-11-03T04:00:00Z")) } },
    "TVC:USOIL": { H1: { candles: series(500, 60, last) } }
  } };
  const f = buildHudSnapshot(macroBundle, { now }).huds.macro_aether.fields;
  for (const key of ["consolidation_gravity", "kinetic_spread", "macro_cycle", "macro_shift", "asset_gravity", "oil_rsi", "q_gravity", "smri", "smr_phase"]) assert.ok(f[key] !== null && f[key] !== undefined, key);
  const lines = readHud("macro_aether", { fields: f }).lines.map(l => l.text);
  assert.ok(lines.length >= 8, lines.join(" | "));
  for (const t of lines) assert.deepEqual(naturalLanguageErrors(t), [], t);
  // Every enum decodes; none is echoed.
  for (const fields of [
    ...["risk_on", "risk_off"].map(macro_cycle => ({ macro_cycle })),
    ...["reversal_due", "stagnant", "accelerating_dollar_up", "accelerating_dollar_down", "neutral"].map(macro_shift => ({ macro_shift, macro_shift_bars_4h: 3 })),
    ...["bias_price_down", "bias_price_up", "neutral"].map(asset_gravity => ({ asset_gravity, oil_rsi: 55 })),
    ...["bullish_pull", "bearish_pull", "balanced"].map(consolidation_gravity => ({ consolidation_gravity, consolidation_gravity_pct: 4 })),
    ...["pull_up", "pull_down", "balanced"].map(q_gravity => ({ q_gravity, q_gravity_pct: 2 })),
    ...["mark_up", "mark_down", "equilibrium"].map(smr_phase => ({ smr_phase, smri: 50 }))
  ]) {
    const text = readHud("macro_aether", { fields }).lines.map(l => l.text);
    const token = Object.values(fields)[0];
    assert.equal(text.length, 1, JSON.stringify(fields));
    assert.ok(!token.includes("_") || !text[0].includes(token), `${token} must not be echoed: ${text[0]}`);
    assert.deepEqual(naturalLanguageErrors(text[0]), [], text[0]);
  }
  // Without the macro series the macro rows are absent, never invented.
  const plain = snapshot.huds.macro_aether.fields;
  assert.equal(plain.macro_cycle, null);
  assert.equal(plain.asset_gravity, null);
});
