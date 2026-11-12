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
export function organismDna() {
  return { schema: ORGANISM.schema, organs: JSON.parse(JSON.stringify(ORGANISM.organs)) };
}
