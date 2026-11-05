// Phase C5 scaffold: HUD agent registry (advisory only, behind HUD_AGENTS_ENABLED).

export const HUD_AGENT_IDS = Object.freeze([
  "r37_funnel", "prophet", "trade_management", "interstellar_eyes", "kinetic_engine",
  "fabio_amt", "chronos_matrix", "aegis_footprint", "tactical_muscles", "macro_aether",
  "gabfx_price_action", "playbook_execution", "decision_matrix", "grid_bot_protocol"
]);

export function hudAgentsEnabled(env) {
  return String(env?.HUD_AGENTS_ENABLED ?? "false").trim().toLowerCase() === "true";
}
