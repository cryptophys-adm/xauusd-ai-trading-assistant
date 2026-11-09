// The GMI v12.70 engine on the 5m, 15m and 1H charts. Since B4 (2026-11-09) it is the single
// engine in gmi-core.mjs; this module only re-exports it under the names the 5m and 15m producers
// and the HUD snapshot import, so those producers, and the Prophet identities that hash them,
// stay byte-identical.
export { GMI_DEFAULTS, GMI_APPROXIMATIONS, GMI_CHART_MINUTES, computeGmiOnChart } from "./gmi-core.mjs";
