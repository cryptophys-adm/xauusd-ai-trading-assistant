// Owner 2026-11-12: "ya kerjakan budget risiko harian dan larangan tumpuk posisi". On the demo account on
// 2026-11-12, four SELL positions stopped out between 23:01 and 00:56 UTC for -42.21 (-4.06 % of the day's
// 1039.42), twice the 2 % daily loss limit: after -10.35 at 23:01 only 10.44 of the day's budget was left,
// yet Omega opened two shorts 13 minutes apart (00:19 at a 13.49 stop, 00:32 at 0.02 lot on an 8.74 stop),
// because the limit only compared the equity with the floor and a second short could join an unprotected one.
import test from "node:test";
import assert from "node:assert/strict";
import { planIntents, openRiskAtStops, isProtected, OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

const ISSUED = Date.parse("2026-11-12T00:15:00Z");
const NOW = ISSUED + 4 * 60_000;
const SYM = { name: "XAUUSD.m", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 3980.0, ask: 3980.2, spread_points: 20 };
const SELL = { side: "SELL", action: "ENTER_MARKET", entry: 3980.02, stop: 3993.51, tp1: 3949.49, issued_ms: ISSUED, expires_ms: ISSUED + 900_000, blackout: false, kill: false, paused: false };
const SETTINGS = { ...OMEGA_DEFAULTS, enabled: true, risk_pct: 2, max_positions: 2, max_daily_loss_pct: 2, adaptive_volatility: false };
const executor = (account, positions = [], sym = SYM) => ({ connected: true, received_ms: NOW - 1000, account: { trade_mode: "demo", currency: "USD", day_start_balance: 1039.42, ...account }, symbol: sym, positions });
const plan = (over = {}) => planIntents({ signal: SELL, control: { mode: "active" }, settings: SETTINGS, now: NOW, engineEnabled: true, ...over });
const codes = (r) => r.notes.map((n) => n.code);
const opens = (r) => r.intents.filter((i) => i.kind === "open");

test("B1. 2026-11-12 00:19 replayed: 10.44 of the day's budget left cannot carry even 0.01 lot at a 13.49 stop", () => {
  const r = plan({ executor: executor({ balance: 1029.07, equity: 1029.07 }) });
  assert.deepEqual(opens(r), []);
  assert.deepEqual(codes(r), ["daily_risk_budget"]);
});

test("B2. the lot is capped by what the day can still lose; with the full budget the risk_pct lot stands", () => {
  // Floor 1039.42 x 0.98 = 1018.63; equity 1039.42 leaves 20.79: 0.01 lot at the 13.51 stop from the bid (13.51) fits, 2 % of equity (0.01) too.
  const full = plan({ executor: executor({ balance: 1039.42, equity: 1039.42 }) });
  assert.deepEqual([opens(full)[0]?.volume, codes(full)], [0.01, []]);
  // A larger account: risk_pct 2 % of 5000 = 100 -> 0.07 lot; the day has lost 70 of its 100 budget -> 30 left -> 0.02 lot.
  const big = plan({ executor: executor({ balance: 4930, equity: 4930, day_start_balance: 5000 }) });
  assert.deepEqual([opens(big)[0]?.volume, codes(big)], [0.02, ["lot_capped_daily_budget"]]);
});

test("B3. 2026-11-12 00:32 replayed: a second short does not join a short whose stop is still above its open price", () => {
  const first = { ticket: 109314885, side: "SELL", symbol: "XAUUSD.m", volume: 0.01, open_price: 3980.01, sl: 3993.51, tp: 3949.49, source: "omega", magic: 920200 };
  const signal = { ...SELL, issued_ms: ISSUED + 900_000, expires_ms: ISSUED + 1_800_000, entry: 3981.43, stop: 3990.17, tp1: 3955.22 };
  const r = plan({ signal, now: ISSUED + 1_080_000, executor: { ...executor({ balance: 1029.07, equity: 1029.07 }, [first]), received_ms: ISSUED + 1_079_000 } });
  assert.deepEqual(opens(r), []);
  assert.ok(codes(r).includes("same_side_unprotected"), JSON.stringify(codes(r)));
  // Once the first short is protected (its stop at or below its open price), a second may open: it
  // risks nothing more, so the budget is the equity above the floor.
  const safe = { ...first, open_price: 3990, sl: 3985 };
  const ok = plan({ signal, now: ISSUED + 1_080_000, executor: { ...executor({ balance: 5000, equity: 5000, day_start_balance: 5000 }, [safe]), received_ms: ISSUED + 1_079_000 } });
  assert.equal(opens(ok).length, 1, JSON.stringify(codes(ok)));
  // The opposite side is not stacking: a BUY position against a SELL signal is closed, as before.
  const buy = { ...first, ticket: 7, side: "BUY", open_price: 3990, sl: 3980 };
  const opp = plan({ executor: executor({ balance: 5000, equity: 5000, day_start_balance: 5000 }, [buy]) });
  assert.deepEqual(opp.intents.map((i) => i.kind), ["close", "open"]);
});

test("B4. the open risk at the stops: from the broker's price, nothing for a protected position, the whole account for a position without a stop", () => {
  const short = { side: "SELL", volume: 0.02, open_price: 3981.38, sl: 3990.17 };
  assert.equal(Math.round(openRiskAtStops([short], SYM) * 100) / 100, 19.94, "(3990.17 - ask 3980.20) x 2 lots of 0.01");
  // A protected short (open 3990, stop 3985, ask 3980.20): only the floating profit it could give back, 4.80 x 2.
  assert.equal(Math.round(openRiskAtStops([{ ...short, open_price: 3990, sl: 3985 }], SYM) * 100) / 100, 9.6);
  assert.equal(openRiskAtStops([{ ...short, sl: null }], SYM), Infinity);
  assert.equal(openRiskAtStops([{ ...short, symbol: "XAGUSD" }], SYM), 0, "another symbol is not valued on this one's price");
  assert.equal(isProtected({ side: "SELL", open_price: 3980, sl: 3980 }), true);
  assert.equal(isProtected({ side: "SELL", open_price: 3980, sl: 3990 }), false);
  assert.equal(isProtected({ side: "BUY", open_price: 3980, sl: 3981 }), true);
  assert.equal(isProtected({ side: "BUY", open_price: 3980 }), false, "no stop is not protected");
  // A position on the other side that would lose 15 at its stop leaves the day 20.79 - 15 = 5.79: no 0.01 lot at 13.51.
  const longAtRisk = { ticket: 8, side: "BUY", symbol: "XAUUSD.m", volume: 0.01, open_price: 3990, sl: 3965, tp: 4010, source: "manual", magic: 0 };
  const r = plan({ executor: executor({ balance: 1039.42, equity: 1039.42 }, [longAtRisk]), settings: { ...SETTINGS, max_positions: 3 } });
  assert.deepEqual([opens(r), codes(r)], [[], ["daily_risk_budget"]], "a manual position is not closed, but its risk counts");
});
