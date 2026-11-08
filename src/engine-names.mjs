// Canonical engine names (docs/SSOT.md §3, owner request 2026-11-08): a parity registry id
// ("gmi_m15") is shown by its indicator name and its chart timeframe ("GMI v12.70 15m"), with the
// registry id beside it. The Nexus map (ui/src/lib/names.ts) holds the same names; a test keeps
// them equal.

/** Registry base engine id -> indicator name. "prophet" is the single Prophet reading of R38 and R37. */
export const ENGINE_NAMES = Object.freeze({
  mizan: "MizanLib",
  prophet: "Prophet R38 + R37",
  gmi: "GMI v12.70",
  prophet_hud: "Prophet HUD",
  gmi_hud: "GMI HUD"
});

const SUFFIX = /_(m5|m15|h4|d1)$/;
const TIMEFRAMES = Object.freeze({ m5: "5m", m15: "15m", h4: "4H", d1: "D1" });

/** Pure: the chart timeframe of a registry engine id, as the timeframe tabs name it (bare id = 1H). */
export function engineTimeframe(engine) {
  const m = String(engine ?? "").match(SUFFIX);
  return m ? TIMEFRAMES[m[1]] : "1H";
}

/** Pure: the base engine of a registry id ("gmi_m15" -> "gmi"). */
export const engineBase = (engine) => String(engine ?? "").replace(SUFFIX, "");

/** Pure: the indicator name of a registry id, without the timeframe ("gmi_m15" -> "GMI v12.70"). */
export const engineName = (engine) => ENGINE_NAMES[engineBase(engine)] ?? engineBase(engine);

/** Pure: the canonical label of a registry id: name, timeframe and the id ("GMI v12.70 15m (gmi_m15)"). */
export const engineLabel = (engine) => `${engineName(engine)} ${engineTimeframe(engine)} (${engine})`;
