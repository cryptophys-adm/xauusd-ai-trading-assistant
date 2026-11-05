// Phase C5: HUD agent ids, display names and flag. The runner lives in agent-threads.mjs.
export { HUD_IDS as HUD_AGENT_IDS, HUD_NAMES as HUD_AGENT_NAMES } from "./hud-reading.mjs";

export function hudAgentsEnabled(env) {
  return String(env?.HUD_AGENTS_ENABLED ?? "false").trim().toLowerCase() === "true";
}
