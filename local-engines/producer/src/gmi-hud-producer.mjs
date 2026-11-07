// The gmi_hud local record (RFC_HUD_AGENTS §3, comparator for the Grid Bot Protocol HUD,
// 2026-11-07). A separate parity identity: the approved gmi identity, its PARITY_FIELDS and the
// H1 decision lane are unchanged. The record repeats the five GMI fields the GMI HUD candidate
// alert (source gmi_v12_70_hud) carries, from the H1 gmi record, and adds the Grid Bot Protocol
// fields computed on the same closed H1 bars (grid-bot.mjs) with that record's GMI entropy.
// Not part of any approved implementation hash; its own identity is ENGINE_PROVENANCE.gmi_hud.
import { gridBotFields } from "./grid-bot.mjs";
import { ENGINE_PROVENANCE } from "./provenance.generated.mjs";

/** The H1 window of the HUD snapshot (hud-snapshot.mjs), so both compute on the same bars. */
export const GMI_HUD_WINDOW = 1000;
export const GMI_HUD_FIELDS = Object.freeze(["verdict", "gate", "gmi_dir", "prophet_dir", "conflict", "cshi_viability", "deploy_status", "muddy_waters", "grid_viable"]);

/**
 * The gmi_hud record for the candle of `built` (buildH1LocalCalculations output), or null when the
 * gmi record or its entropy is missing, or the bundle's bars do not end at that candle.
 */
export function buildGmiHudRecord(built, bundle, { mintick = 0.001 } = {}) {
  const gmi = (built?.records || []).find((r) => r?.engine === "gmi");
  const g = gmi?.values?.comparable?.gmi_v12_70;
  const entropy = gmi?.values?.diagnostics?.entropy;
  if (!g || !Number.isFinite(entropy)) return null;
  const openMs = Date.parse(gmi.candle_time);
  const bars = (bundle?.timeframes?.H1?.candles || []).filter((b) => Date.parse(b.open_time) <= openMs).slice(-GMI_HUD_WINDOW);
  if (!bars.length || Date.parse(bars.at(-1).open_time) !== openMs) return null;
  const grid = gridBotFields(bars, { entropy, mintick });
  if (!grid) return null;
  const p = ENGINE_PROVENANCE.gmi_hud;
  return {
    schema_version: gmi.schema_version, symbol: gmi.symbol, timeframe: gmi.timeframe,
    candle_key: gmi.candle_key, candle_time: gmi.candle_time, computed_at: gmi.computed_at,
    engine: "gmi_hud",
    calculation_version: "gmi-v12.70-hud-h1@" + p.implementation_hash.slice(0, 12),
    values: {
      candle: gmi.values.candle,
      comparable: {
        gmi_v12_70_hud: {
          verdict: g.verdict, gate: g.gate, gmi_dir: g.gmi_dir, prophet_dir: g.prophet_dir, conflict: g.conflict,
          cshi_viability: grid.cshi_viability, deploy_status: grid.deploy_status_code, muddy_waters: grid.muddy_waters, grid_viable: grid.grid_viable
        }
      },
      scope_note: "Only comparable.gmi_v12_70_hud fields are parity-checked. HUD parity never enters the H1 decision lane."
    },
    provenance: {
      source: "local-engines/producer gmi hud h1", source_hash: p.source_hash, implementation_hash: p.implementation_hash, files: p.files,
      dependencies: gmi.provenance?.dependencies ?? {}
    }
  };
}
