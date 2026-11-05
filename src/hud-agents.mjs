// Phase C5 scaffold: HUD agent registry (advisory only, behind HUD_AGENTS_ENABLED).

export const HUD_AGENT_IDS = Object.freeze([
  "r37_funnel", "prophet", "trade_management", "interstellar_eyes", "kinetic_engine",
  "fabio_amt", "chronos_matrix", "aegis_footprint", "tactical_muscles", "macro_aether",
  "gabfx_price_action", "playbook_execution", "decision_matrix", "grid_bot_protocol"
]);

export function hudAgentsEnabled(env) {
  return String(env?.HUD_AGENTS_ENABLED ?? "false").trim().toLowerCase() === "true";
}


export const HUD_AGENT_NAMES = Object.freeze({
  r37_funnel: "R37 Funnel",
  prophet: "Prophet",
  trade_management: "Trade Management",
  interstellar_eyes: "The Interstellar Eyes",
  kinetic_engine: "Kinetic Engine (TVA)",
  fabio_amt: "Fabio AMT Sensors",
  chronos_matrix: "Chronos Matrix",
  aegis_footprint: "Aegis Footprint Matrix",
  tactical_muscles: "Tactical Muscles",
  macro_aether: "Macro & Aether Sensors",
  gabfx_price_action: "GABFX Price Action",
  playbook_execution: "Playbook Execution",
  decision_matrix: "Decision Matrix",
  grid_bot_protocol: "Grid Bot Protocol"
});
