// The GMI v12.70 engine on the 4H and D1 charts (dyn_ltf intrabars: M5 on 240, M15 on daily).
// Since B4 (2026-11-09) it is the single engine in gmi-core.mjs; this module only re-exports it
// under the names the H4/D1 producer and the HUD snapshot import, so those producers, and the
// Prophet identities that hash them, stay byte-identical.
export { GMI_DEFAULTS, GMI_APPROXIMATIONS, GMI_CHART_MINUTES, intrabarTimeframe, computeGmiOnChart as computeGmiOnHtfChart } from "./gmi-core.mjs";
