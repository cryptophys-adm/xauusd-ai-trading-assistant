// Rebuttal targets named by the models (production 2026-11-09: "aegis_footprint_matrix",
// "macro_aether_sensors" and "the kinetic_engine" for aegis_footprint, macro_aether and
// kinetic_engine were lost as rebuts_invalid). Shared by the War Rooms and the Macro War Room.

/** "The Aegis Footprint Matrix" -> "aegis_footprint_matrix": lower case, a leading "the" dropped, non-alphanumerics as "_". */
export const nameSlug = (v) => String(v ?? "").trim().toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Pure: each target as a bus id when its slug is the slug of an agent's id or display name (`nameOf`); others unchanged. */
export function matchRebuts(rebuts, busAgents, nameOf = (id) => String(id)) {
  if (!Array.isArray(rebuts)) return null;
  const bySlug = new Map();
  for (const id of busAgents) { bySlug.set(nameSlug(id), id); bySlug.set(nameSlug(nameOf(id)), id); }
  return rebuts.map((r) => (busAgents.includes(r) ? r : bySlug.get(nameSlug(r)) ?? r));
}
