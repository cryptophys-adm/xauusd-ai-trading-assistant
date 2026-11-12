// Owner 2026-11-12: "semua dikontrol dari omega bukan EA, untuk mode scalping jangan TP berdasarkan RRR
// tapi target di Key Level terdekat, atur SL+ dan Trailing TP juga harus berdasarkan keylevel
// menyesuaikan Bull/Bear Power"; answers: "Bull/Bear power dihasilkan decision engine hasil quorum",
// "Tanpa batas RRR", "Tutup jika Power berbalik".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brokerKeyLevels, powerBand, keyLevelPlan, planIntents, manageIntents, OMEGA_DEFAULTS, POWER_FRESH_MS } from "../src/omega-engine.mjs";
import { guardrailsFor, decide, keyLevelsAround, modeThresholds } from "../src/decision-engine.mjs";
import { managementFields, feedBasis } from "../src/ea-signal.mjs";

const NOW = Date.parse("2026-11-12T10:20:00Z");
const POWER_MS = Date.parse("2026-11-12T10:15:00Z");
const SYM = { name: "XAUUSD.m", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 3920, ask: 3920.2, spread_points: 20 };
// Feed-scale levels; the broker quotes 2.00 above the feed.
const SIGNAL = { side: "NONE", key_levels: "3903:3905,3913:3915,3923:3925,3933:3935", feed_basis: 2, feed_basis_known: true, power: 0.3, power_ms: POWER_MS, m5_source: "broker", m5_ready: false, m5_close_ms: POWER_MS, m5_atr: 3, m5_swing_low: 3918, m5_swing_high: 3921 };
const LONG = { ticket: 7, side: "BUY", volume: 0.02, open_price: 3900, sl: 3890, tp: 3925, source: "omega", magic: 920200 };
const plan = (signal, position = LONG, sym = SYM) => keyLevelPlan({ position, sym, signal, levels: brokerKeyLevels(signal), now: NOW });

test("P1. the key levels move onto the broker's scale by the feed basis, and only with a known basis", () => {
  assert.deepEqual(brokerKeyLevels(SIGNAL).map((z) => [z.low, z.high]), [[3905, 3907], [3915, 3917], [3925, 3927], [3935, 3937]]);
  assert.equal(brokerKeyLevels({ ...SIGNAL, feed_basis_known: false }), null, "no basis, no key-level management");
  assert.equal(brokerKeyLevels({ ...SIGNAL, key_levels: "" }), null);
  assert.deepEqual([powerBand(0.6), powerBand(0.3), powerBand(0.1), powerBand(-0.6), powerBand(null)], ["strong", "normal", "weak", "reversed", "normal"]);
});

test("P2. SL+ steps behind the key levels price passed, by the quorum power", () => {
  // Passed beyond the 3900 entry: 3915-3917 (last) and 3905-3907; buffer max(2 spreads 0.40, 0.1 x 3) = 0.40.
  assert.deepEqual(plan(SIGNAL), { sl: 3914.6, tp: null, band: "normal" }, "normal: behind the last passed level");
  assert.equal(plan({ ...SIGNAL, power: 0.6 }).sl, 3904.6, "strong: behind the level before, room to run");
  assert.equal(plan({ ...SIGNAL, power: 0.1 }).sl, 3917.6, "weak: the tighter of the last level and the 5m swing (3918 - 0.40)");
  assert.equal(plan(SIGNAL, { ...LONG, sl: 3916 }).sl, null, "the stop only moves in the position's favour");
  // Before price passed a key level beyond the entry the stop stays.
  assert.equal(plan(SIGNAL, LONG, { ...SYM, bid: 3906, ask: 3906.2 }).sl, null, "price inside the first level, not past it");
  // A short mirrors it: open 3940, price 3920.2 (ask), passed 3925-3927 and 3935-3937 (wholly below 3940).
  const SHORT = { ...LONG, side: "SELL", open_price: 3940, sl: 3950, tp: 3905 };
  assert.equal(plan({ ...SIGNAL, power: -0.3 }, SHORT).sl, 3927.4, "behind 3925-3927 plus the buffer");
});

test("P3. trailing TP: near the target with a strong power the target moves to the next key level; with a weaker one it stays", () => {
  const nearTp = { ...SYM, bid: 3924, ask: 3924.2 };
  const strong = plan({ ...SIGNAL, power: 0.6 }, LONG, nearTp);
  assert.equal(strong.tp, 3935, "the next key level beyond 3925 (broker scale 3935-3937, its near edge)");
  assert.equal(strong.sl, 3904.6, "the old target less the buffer is too close to price; the strong SL+ stands");
  assert.equal(plan(SIGNAL, LONG, nearTp).tp, null, "normal power: the target stays and is taken");
  assert.equal(plan({ ...SIGNAL, power: 0.6 }, LONG, { ...SYM, bid: 3916, ask: 3916.2 }).tp, null, "far from the target (9.00 > 5.00): no move");
});

test("P4. a reversed power closes a winner; a stale power never does", () => {
  assert.deepEqual(plan({ ...SIGNAL, power: -0.6 }), { close: true, band: "reversed" });
  assert.equal(plan({ ...SIGNAL, power: -0.6 }, LONG, { ...SYM, bid: 3895, ask: 3895.2 }).close, undefined, "a loser is left to its stop");
  assert.equal(plan({ ...SIGNAL, power: -0.6, power_ms: NOW - POWER_FRESH_MS - 1 }).close, undefined, "an old decision's power counts as normal");
});

test("P5. manageIntents: key-level intents replace the 5m trail and the extended target; without key levels they remain", () => {
  const settings = { ...OMEGA_DEFAULTS, enabled: true };
  const withLevels = manageIntents({ positions: [LONG], sym: SYM, settings, signal: { ...SIGNAL, tp2: 3990 }, side: "BUY", now: NOW });
  assert.deepEqual(withLevels.map((i) => [i.id, i.kind, i.sl ?? i.tp ?? null, i.reason]), [["ms:7:k:391460", "modify_sl", 3914.6, "sl_key_level_normal"], ["ps:7:2", "partial_close", null, "tp1_scale_out"]], "no trail_5m, no extended_tp; the 2R scale-out as before");
  const reversed = manageIntents({ positions: [LONG], sym: SYM, settings, signal: { ...SIGNAL, power: -0.7 }, now: NOW });
  assert.deepEqual(reversed.map((i) => [i.id, i.kind, i.reason]), [[`cl:7:pw:${Math.floor(POWER_MS / 60_000)}`, "close", "power_reversal"]]);
  const fallback = manageIntents({ positions: [{ ...LONG, sl: 3900 }], sym: SYM, settings, signal: { ...SIGNAL, feed_basis_known: false, tp2: 3990 }, side: "BUY", now: NOW });
  assert.deepEqual(fallback.map((i) => i.reason), ["trail_5m", "extended_tp"], "no basis: the 5m trail and the extended target as before");
  // The scale-out is unchanged.
  assert.ok(manageIntents({ positions: [{ ...LONG, tp: 3920 }], sym: SYM, settings, signal: SIGNAL, now: NOW }).some((i) => i.reason === "tp1_scale_out"));
});

test("P6. scalp: the entry's target stays at the nearest key level when the adaptive stop widens", () => {
  const signal = { side: "BUY", action: "ENTER_MARKET", entry: 3920.2, stop: 3918, tp1: 3923, issued_ms: NOW - 60_000, expires_ms: NOW + 600_000, blackout: false, kill: false, paused: false, trading_mode: "scalp" };
  const executor = { connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", equity: 10_000, balance: 10_000, day_start_balance: 10_000 }, symbol: { ...SYM, atr_value: 4 }, positions: [] };
  const run = (mode) => planIntents({ signal: { ...signal, trading_mode: mode }, control: { mode: "active" }, settings: { ...OMEGA_DEFAULTS, enabled: true }, executor, now: NOW, engineEnabled: true }).intents[0];
  assert.deepEqual([run("scalp").sl, run("scalp").tp], [3917.2, 3923], "stop widened to 0.75 ATR (3.00), target kept 2.80 away");
  assert.equal(run("intraday").tp, 3924.02, "intraday keeps the plan's reward-to-risk");
});

test("P7. the Decision Engine in scalp: the nearest key level is the target whatever it pays; intraday keeps its minimum", () => {
  assert.equal(modeThresholds("scalp").target, "nearest");
  // Price 4000, ATR 10: the nearest key level ahead of a long is 4006 (0.86R on a 7.00 stop), then 4030.
  const zones = [
    { low: 3995, high: 3998, price: 3996.5, candidate: true, label: "S1" },
    { low: 4006, high: 4007, price: 4006.5, candidate: true, label: "R0" },
    { low: 4030, high: 4032, price: 4031, candidate: true, label: "R1" }
  ];
  const strategy = { decision: "WAIT", direction: "LONG", price: 4000, atr_h1: 10, key_levels: { zones }, plan: { at_level: true } };
  const quorum = { long_share: 0.8, short_share: 0.1, score: 0.6, bias: "BULLISH" };
  const scalp = guardrailsFor(1, { cards: [], quorum, strategy, inputs: {}, env: { TRADING_MODE: "scalp" } });
  const reward = scalp.checks.find((c) => c.id === "reward");
  assert.equal(reward.pass, true, reward.detail);
  assert.match(reward.detail, /nearest key level.*R0.*0\.86R; scalp: no reward-to-risk minimum/);
  assert.equal(scalp.target_rule, "nearest");
  // The council chose tp2; scalp takes the nearest key level.
  const guards = { long: { ...scalp, allowed: true }, short: { allowed: false, checks: [], plan: null } };
  const d = decide({ answer: { stance: "BUY", bias: "BULLISH", confidence: 0.7, entry_type: "limit", target: "tp2" }, guards, quorum });
  assert.deepEqual([d.stance, d.trade.target, d.trade.tp, d.trade.rrr], ["BUY", "tp1", 4006, 0.86]);
  // No key level ahead: a projection is no scalp target.
  const bare = guardrailsFor(1, { cards: [], quorum, strategy: { ...strategy, key_levels: { zones: zones.slice(0, 1) } }, inputs: {}, env: { TRADING_MODE: "scalp" } });
  assert.equal(bare.checks.find((c) => c.id === "reward").pass, false);
  const intraday = guardrailsFor(1, { cards: [], quorum, strategy, inputs: {}, env: { TRADING_MODE: "intraday" } });
  assert.equal(intraday.target_rule, "rrr");
  // The record keeps the candidate zones nearest to price, lowest first.
  assert.deepEqual(keyLevelsAround(strategy, 2), [{ low: 3995, high: 3998 }, { low: 4006, high: 4007 }]);
});

test("P8. the signal carries the power, the key levels and the broker's basis for Omega", () => {
  const decision = { decision_key: "OANDA:XAUUSD:15:1794476700000", stance: "WAIT", trading_mode: "scalp", quorum: { score: -0.73 }, key_levels: [{ low: 3937.06, high: 3941.27 }, { low: 3949.57, high: 3953.93 }] };
  assert.deepEqual(managementFields(decision, { basis: 1.4 }), { trading_mode: "scalp", power: -0.73, power_ms: 1794477600000, key_levels: "3937.06:3941.27,3949.57:3953.93", feed_basis: 1.4, feed_basis_known: true });
  assert.equal(managementFields(decision).feed_basis_known, false);
  // The basis: the broker's M1 close at each feed 5m close, the median of at least 3 matches.
  const feed = [0, 1, 2, 3].map((i) => ({ close_time: new Date(POWER_MS + i * 300_000).toISOString(), close: 3930 + i }));
  const broker = feed.map((c, i) => ({ t: Date.parse(c.close_time) - 60_000, c: c.close + [1.2, 1.5, 9, 1.4][i] }));
  assert.equal(feedBasis(broker, feed), 1.45, "the median resists one bad bar");
  assert.equal(feedBasis(broker.slice(0, 2), feed), null, "too few matches");
});

test("P9. OmegaExecutor no longer moves stops by itself: its local break-even and trailing are off by default", () => {
  const ea = readFileSync(new URL("../ea/mt5/OmegaExecutor.mq5", import.meta.url), "utf8");
  assert.match(ea, /input bool\s+AutoBreakEvenEnabled\s+= false;/);
  assert.match(ea, /input bool\s+TrailingStopEnabled\s+= false;/);
  assert.match(ea, /#property version\s+"1\.11"/);
});
