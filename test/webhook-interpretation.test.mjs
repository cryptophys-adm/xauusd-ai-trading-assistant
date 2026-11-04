import test from "node:test";
import assert from "node:assert/strict";
import { interpretWebhooks, interpretWebhookRow } from "../src/webhook-interpretation.mjs";
import { naturalLanguageErrors } from "../src/natural-language.mjs";

// Production candle 2026-11-04 22:00 UTC (OANDA:XAUUSD:60:1793826000000), webhook values as stored.
const PROD = {
  prophetR38: { direction: 0, buy_confirmed: false, sell_confirmed: false, buy_high_quality: false, sell_high_quality: false, t_enc: 3, d_enc: -1, structure_subtype: 0 },
  prophetR37: { direction: 0, d_enc: -1, b_enc: -3, structure_subtype: 0, bull_event: false, bear_event: true },
  gmi: { verdict: 0, gate: -1, gmi_dir: -1, prophet_dir: 0, conflict: true }
};

test("decodes the three alerts of a real candle into plain language", () => {
  const r = interpretWebhooks(PROD);
  assert.equal(r.available, true);
  assert.equal(r.bias, "bearish");
  assert.deepEqual(r.lines.map(l => l.source), ["Prophet R38", "Prophet R37", "GMI v12.70"]);
  assert.match(r.lines[0].text, /no buy or sell confirmation/);
  assert.match(r.lines[0].text, /possible reversal/);
  assert.match(r.lines[0].text, /bearish divergence/);
  assert.match(r.lines[1].text, /bearish confirmation candle/);
  assert.match(r.lines[1].text, /fresh bearish structure event/);
  assert.match(r.lines[2].text, /leans bearish, but the confluence gate found a conflict/);
  assert.match(r.lines[2].text, /wait and observe/);
  assert.match(r.summary, /lean bearish, but no buy or sell signal is confirmed and GMI reports a conflict/);
});

test("a confirmed, agreeing buy reads as a buy", () => {
  const r = interpretWebhooks({
    prophetR38: { direction: 1, buy_confirmed: true, buy_high_quality: true, t_enc: 1, d_enc: 1 },
    prophetR37: { direction: 1, d_enc: 1, b_enc: 3, bull_event: true },
    gmi: { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false }
  });
  assert.equal(r.bias, "bullish");
  assert.match(r.lines[0].text, /confirmed BUY signal .* high-quality filter/);
  assert.match(r.lines[2].text, /all agree on direction/);
  assert.match(r.summary, /point up, with a confirmed buy signal/);
});

test("structure breaks use the Pine subtype names", () => {
  const sub = (d, s) => interpretWebhooks({ prophetR38: { direction: 0, t_enc: 0, d_enc: d, structure_subtype: s } }).lines[0].text;
  assert.match(sub(3, 1), /bull trap/);
  assert.match(sub(-3, 2), /true breakout up/);
  assert.match(sub(-3, 3), /bear trap/);
  assert.match(sub(3, 4), /true breakdown/);
  assert.match(sub(3, 0), /not resolved yet/);
});

test("missing alerts are named; nothing at all says so", () => {
  const partial = interpretWebhooks({ gmi: PROD.gmi });
  assert.deepEqual(partial.missing, ["Prophet R38", "Prophet R37"]);
  assert.match(partial.summary, /The Prophet R38 and Prophet R37 alert has not arrived/);
  const none = interpretWebhookRow({});
  assert.equal(none.available, false);
  assert.equal(none.lines.length, 0);
  assert.match(none.summary, /No TradingView alert has arrived/);
});

test("reads straight from the stored ai_syntheses columns", () => {
  const r = interpretWebhookRow({ prophet_metrics: JSON.stringify({ prophet_r38: PROD.prophetR38, prophet_r37_ssot: PROD.prophetR37 }), gmi_metrics: JSON.stringify(PROD.gmi) });
  assert.equal(r.lines.length, 3);
  assert.equal(r.bias, "bearish");
});

test("every decoded sentence passes the natural-language rule", () => {
  const codes = [-6, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
  for (const t of codes) for (const d of [-3, -1, 0, 1, 3]) for (const s of [0, 1, 2, 3, 4]) {
    const r = interpretWebhooks({
      prophetR38: { direction: Math.sign(t) || 0, t_enc: t, d_enc: d, structure_subtype: s },
      prophetR37: { direction: Math.sign(d), d_enc: d, b_enc: t, structure_subtype: s, bull_event: d > 0, bear_event: d < 0 },
      gmi: { verdict: t, gate: Math.max(-2, Math.min(2, d)), gmi_dir: Math.sign(t), conflict: d === -1 }
    });
    for (const text of [r.summary, ...r.lines.map(l => l.text)]) {
      assert.deepEqual(naturalLanguageErrors(text), [], text);
      assert.doesNotMatch(text, /undefined|null|NaN/, text);
    }
  }
});
