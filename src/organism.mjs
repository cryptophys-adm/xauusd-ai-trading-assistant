// The XAUUSD organs' DNA for the Cryptophys platform census (owner 2026-11-12: "DNA untuk XAUUSD dan Omega
// dengan auto-register"; ADR-0013, external organs). organism.json at the repository root declares the five
// Workers, the agents that report to the platform kernel (AGENTS binding) and every AI task the Workers run;
// test/organism-dna.test.mjs keeps it equal to the code. The platform's Forge reads it through the RPC
// entrypoint OrganismDna (dna() only): a new agent or AI task in this repository then reaches the platform's
// registries by its census and consensus. This Worker registers nothing itself and can claim nothing the
// platform's external-organ ceiling refuses (tier 1, no council seat, no privileged capability).
import ORGANISM from "../organism.json" with { type: "json" };

export const ORGANISM_SCHEMA = "xauusd-organism.v1";

/** The DNA, as served to the platform: a copy, so no caller can change this module's object. */
const SHA = /^[0-9a-f]{40}$/;
/**
 * The DNA; `deployed` (P5, the platform's field contract) names the organ this Worker is and its deploy, so that
 * organ carries deployed_commit (40-char sha) and deployed_at. Without a valid sha both are omitted ("untracked").
 */
export function organismDna(deployed = null) {
  // agents_inventory (owner 2026-11-15, the platform's field contract): a top-level link the census does not
  // register; the room seats it lists are not kernel agents.
  const organs = JSON.parse(JSON.stringify(ORGANISM.organs));
  const commit = String(deployed?.commit ?? "").toLowerCase();
  const at = Date.parse(deployed?.at ?? "");
  const own = organs.find((o) => o.service === deployed?.service);
  if (own && SHA.test(commit) && Number.isFinite(at)) Object.assign(own, { deployed_commit: commit, deployed_at: new Date(at).toISOString() });
  return { schema: ORGANISM.schema, organs, ...(ORGANISM.agents_inventory ? { agents_inventory: { ...ORGANISM.agents_inventory } } : {}) };
}
