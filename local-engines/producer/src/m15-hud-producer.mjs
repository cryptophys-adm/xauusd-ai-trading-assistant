// Phase C2b: 15m HUD producer. Aggregates closed M5 bars into closed M15 candles.
// HUD field computation on M15 follows in a later PR.
import { buildFifteenMinuteCandles } from "../../../src/agent-threads.mjs";

export const HUD_M15_CONTRACT_VERSION = "cryptophys.hud-m15.v1";

export function aggregateM15(bars5m, { limit = 4 } = {}) {
  return buildFifteenMinuteCandles(bars5m, { limit });
}

export function buildM15HudCalculations(bars5m, { now = Date.now(), mintick = 0.001, limit = 4 } = {}) {
  const candles = aggregateM15(bars5m, { limit });
  // Placeholder: HUD fields not yet computed; returns candle list only.
  return candles.map((c) => ({ candle: c, hud: null }));
}
