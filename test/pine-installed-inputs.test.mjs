// Guards the Pine SSOT files against the indicators actually installed in
// TradingView. A TradingView alert name lists the indicator's non-boolean
// input values in declaration order; these lists were read from the live
// alerts (2026-11-03, alert ids 5983742001 and 5975289891) with the trailing
// webhook-secret input removed. If a Pine file's defaults change, this test
// fails until the installed indicator settings are re-checked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const INSTALLED = {
  "pinescript/ssot/The-Prophet-v7.02-R38.txt": {
    title: 'indicator("The Prophet v7.02 (MizanLib Shared Core) · R38", "Prophet R38"',
    inputs: ["13", "34", "55", "6", "top_right", "4", "5", "NO POSITION", "0", "3", "V2", "50", "6", "0.1", "40", "3", "55", "5", "30", "120", "Wick", "0.15", "3", "0.25", "1.5", "0.5", "2", "EDGE", "15", "60", "240", "D", "W"]
  },
  "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt": {
    title: 'indicator("Global Multiverse Interceptor [v12.70 THE SINGULARITY] · R10.1.5 SEPARATE CHRONOS HUD"',
    inputs: ["5", "1.5", "20", "60", "120", "30", "Wick", "0.25", "3", "300", "40", "70", "50", "15", "60", "240", "D", "W", "150", "2", "114", "Daily", "30", "70", "Exchange", "9", "0", "15", "0", "8", "0", "16", "30", "9", "30", "16", "0"]
  }
};

// Displayed form of a Pine default literal (TradingView drops quotes, trailing ".0" and "position." prefixes).
function displayed(literal) {
  let v = literal.trim().replace(/^["']|["']$/g, "");
  if (/^-?\d+\.\d+$/.test(v)) v = String(Number(v));
  return v.replace(/^position\./, "");
}

function nonBoolDefaults(source) {
  const out = [];
  const re = /input\.(int|float|string|source|timeframe|session|price|symbol|text_area)\(\s*((?:"[^"]*"|'[^']*'|[^,)])+)/g;
  for (const m of source.matchAll(re)) out.push(displayed(m[2]));
  return out;
}

for (const [file, expected] of Object.entries(INSTALLED)) {
  test(`${file} matches the installed TradingView indicator`, () => {
    const src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(src.includes(expected.title), "indicator title differs from the installed indicator");
    const defaults = nonBoolDefaults(src);
    assert.equal(defaults.at(-1), "", "last non-bool input must be the webhook secret (empty default)");
    assert.deepEqual(defaults.slice(0, -1), expected.inputs);
    assert.match(src, /import cryptophys\/CryptophysMizanLib\/4 as lib/);
  });
}

// Keys of the webhook messages actually delivered by the installed alerts
// (TradingView alerts log, 2026-11-03 13:00 UTC bar), in emitted order.
const COMMON = ["v", "source", "src", "ticker", "symbol", "timeframe", "tf", "candle_time", "timestamp", "t", "o", "h", "l", "c", "volume"];
const DELIVERED_KEYS = {
  prophet_r38: [...COMMON, "direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype", "secret"],
  prophet_r37_ssot: [...COMMON, "direction", "d_enc", "b_enc", "structure_state", "structure_subtype", "bull_event", "bear_event", "secret"],
  gmi_v12_70: [...COMMON, "verdict", "gate", "gmi_dir", "prophet_dir", "conflict", "shared_core_status", "secret"]
};

function payloadKeys(file, variable) {
  const line = readFileSync(new URL("../" + file, import.meta.url), "utf8").split("\n").find((l) => l.includes(`string ${variable} = `));
  assert.ok(line, `${variable} not found in ${file}`);
  return [...line.matchAll(/\\"([a-z_]+)\\":/g)].map((m) => m[1]);
}

test("Pine webhook payloads emit exactly the keys the installed alerts delivered", () => {
  assert.deepEqual(payloadKeys("pinescript/ssot/The-Prophet-v7.02-R38.txt", "cta_prophet_payload"), DELIVERED_KEYS.prophet_r38);
  assert.deepEqual(payloadKeys("pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt", "cta_core_payload"), DELIVERED_KEYS.prophet_r37_ssot);
  assert.deepEqual(payloadKeys("pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt", "cta_gmi_payload"), DELIVERED_KEYS.gmi_v12_70);
});
