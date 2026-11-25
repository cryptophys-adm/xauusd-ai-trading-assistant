// B7: comparison cases for compareWithWebhooks without the field-group options. Their outputs on
// main (before B7) are frozen in test/fixtures/parity-b7-compare-main.json.
const candle = { o: 3950.1, h: 3955.2, l: 3948.0, c: 3953.4, volume: 2103 };
const R38 = { direction: 1, buy_confirmed: true, sell_confirmed: false, buy_high_quality: false, sell_high_quality: false, t_enc: 2, d_enc: -1, structure_subtype: 0 };
const R37 = { direction: 1, d_enc: -1, b_enc: 2, structure_subtype: 0, bull_event: true, bear_event: false };
const GMI = { verdict: 3, gate: 2, gmi_dir: 1, prophet_dir: 1, conflict: false };
const HUD = { ...GMI, cshi_viability: 64, deploy_status: 3, muddy_waters: false, grid_viable: true };
const rec = (engine, comparable, extra = {}) => ({ engine, timeframe: "60", values: { candle, comparable, diagnostics: { branch: "jma_long", entropy: 0.4, vah: 3960, val: 3940, zones: { demand: true, x: 1 } } }, ...extra });
const hooks = (over = {}) => ({
  prophet_r38: { ...candle, ...R38, ...(over.prophet_r38 || {}) },
  prophet_r37_ssot: { ...candle, ...R37, ...(over.prophet_r37_ssot || {}) },
  gmi_v12_70: { ...candle, ...GMI, shared_core_status: "ok", ...(over.gmi_v12_70 || {}) },
  gmi_v12_70_hud: { ...candle, ...HUD, ...(over.gmi_v12_70_hud || {}) }
});
const prophet = (over = {}) => rec("prophet", { prophet_r38: { ...R38, ...(over.r38 || {}) }, prophet_r37_ssot: { ...R37, ...(over.r37 || {}) } });

export const COMPARE_CASES = [
  ["prophet match", prophet(), hooks()],
  ["gmi match", rec("gmi", { gmi_v12_70: GMI }), hooks()],
  ["gmi_hud match", rec("gmi_hud", { gmi_v12_70_hud: HUD }), hooks()],
  ["gmi mismatch", rec("gmi", { gmi_v12_70: GMI }), hooks({ gmi_v12_70: { verdict: -3 } })],
  ["gmi tolerance", rec("gmi", { gmi_v12_70: { ...GMI, gate: 2 + 1e-7 } }), hooks()],
  ["prophet input only", prophet(), hooks({ prophet_r38: { c: 3954 }, prophet_r37_ssot: { c: 3954 } })],
  ["prophet input and field", prophet({ r38: { t_enc: 3 } }), hooks({ prophet_r38: { c: 3954 } })],
  ["prophet incomplete local", prophet({ r38: { t_enc: undefined } }), hooks()],
  ["prophet incomplete webhook", prophet(), (() => { const h = hooks(); delete h.prophet_r38.t_enc; return h; })()],
  ["gmi null both", rec("gmi", { gmi_v12_70: { ...GMI, gate: null } }), hooks({ gmi_v12_70: { gate: null } })],
  ["gmi nan", rec("gmi", { gmi_v12_70: { ...GMI, gate: Number.NaN } }), hooks({ gmi_v12_70: { gate: Number.NaN } })],
  ["gmi absent source", rec("gmi", { gmi_v12_70: GMI }), (() => { const h = hooks(); delete h.gmi_v12_70; return h; })()],
  ["mizan no counterpart", rec("mizan", {}), hooks()],
  ["unknown engine", rec("probe_mizan", { probe_mizan_hud: { net_witness: 1, prior_edge: 0.2 } }), hooks()],
  ["no candle", { engine: "gmi", values: { comparable: { gmi_v12_70: GMI } } }, hooks()],
  ["no record", null, hooks()],
  ["gmi string vs number", rec("gmi", { gmi_v12_70: { ...GMI, gate: "2" } }), hooks()]
].map(([name, record, webhooks]) => [name, JSON.parse(JSON.stringify(record)), JSON.parse(JSON.stringify(webhooks))]);
