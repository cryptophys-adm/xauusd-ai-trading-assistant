// P2 of RFC_INDICATOR_AGENT_PLATFORM §9: the indicator registry behind GET /api/indicator-agents.
// It joins every manifest (src/indicator-manifests.mjs) with what the system knows about it now:
// its parity identities per chart (engine_parity_registry), its 30-day scorecards (as an indicator
// and as a room agent), its open stuck states and its shadow versions. Read-only; nothing here
// changes a room, a prompt or a decision.
import { MANIFESTS, MANIFEST_VERSION } from "./indicator-manifests.mjs";
import { scorecards, listStuckStates, SCORING_VERSION } from "./outcome-scoring.mjs";
import { reputationOf, REPUTATION_DAYS } from "./reputation.mjs";
import { CANDIDATES } from "./shadow-versions.mjs";

export const INDICATOR_REGISTRY_VERSION = "cryptophys.indicator-registry.v1";

/** Chart of a registry engine id: "prophet" is H1, "prophet_m15" is 15m, and so on. */
const SCOPE_CHART = { "": "H1", _m5: "M5", _m15: "M15", _h4: "H4", _d1: "D1" };
function scopeOf(engine, base) {
  if (engine === base) return "H1";
  const suffix = engine.startsWith(base) ? engine.slice(base.length) : null;
  return suffix != null && suffix in SCOPE_CHART ? SCOPE_CHART[suffix] : null;
}

/**
 * Lifecycle of one manifest:
 *   not_computed  the data is not computed locally;
 *   active        an engine (or library) approved by parity on H1, or a room agent that speaks;
 *   candidate     an engine whose H1 identity is not (or no longer) approved;
 */
export function lifecycleOf(manifest, parity) {
  if (!manifest.computed) return "not_computed";
  if (manifest.kind === "engine" || manifest.kind === "library") {
    return parity.some((p) => p.chart === "H1" && p.status === "approved") ? "active" : "candidate";
  }
  return "active";
}

/** One entry of GET /api/indicator-agents (pure: tested without a database). */
export function registryEntry(manifest, { registryRows = [], cards = [], stuck = [], candidates = CANDIDATES } = {}) {
  const parityFor = (base) => (base ? registryRows.map((r) => ({ ...r, chart: scopeOf(String(r.engine), base) })).filter((r) => r.chart).map((r) => ({ engine: r.engine, chart: r.chart, status: r.status, consecutive_matches: Number(r.consecutive_matches) || 0, updated_at: r.updated_at ?? null })) : []);
  const parity = parityFor(manifest.identity);
  const hudParity = manifest.hud_identity ? parityFor(manifest.hud_identity) : [];
  const card = (subject, timeframe) => cards.find((c) => c.subject === subject && (timeframe == null || c.timeframe === timeframe)) ?? null;
  const asIndicator = manifest.scored.map((subject) => ({ subject, timeframe: "60", ...summary(card(subject, "60")) }));
  const asAgent = manifest.kind === "engine" || manifest.kind === "library" ? [] : [["M15", "15"], ["H1", "60"]]
    .filter(([room]) => manifest.rooms.includes(room))
    .map(([room, tf]) => ({ room, timeframe: tf, ...reputationOf(card("agent:" + manifest.id, tf)) }));
  const stuckOpen = manifest.stuck_prefix ? stuck.filter((s) => s.status === "open" && String(s.field).startsWith(manifest.stuck_prefix)) : [];
  return {
    ...manifest,
    lifecycle: lifecycleOf(manifest, parity),
    parity, hud_parity: hudParity,
    scorecards: { indicator: asIndicator, agent: asAgent },
    stuck_states: stuckOpen.map((s) => ({ field: s.field, candles: s.candles, price_range: s.price_range, atr: s.atr, detected_at: s.detected_at })),
    shadow_versions: manifest.shadow_family ? candidates.filter((c) => c.family === manifest.shadow_family).map((c) => ({ id: c.id, change: c.change })) : []
  };
}

function summary(c) {
  if (!c) return { n: 0, hit_rate: null, wait_accuracy: null, brier: null };
  return { n: c.n, hit_rate: c.directional?.hit_rate ?? null, wait_accuracy: c.wait?.accuracy ?? null, brier: c.brier ?? null };
}

/** GET /api/indicator-agents: every manifest with its live state. */
export async function indicatorAgents(env, { now = Date.now() } = {}) {
  const db = env.DB;
  let registryRows = [];
  try { registryRows = (await db.prepare("SELECT engine, status, consecutive_matches, updated_at FROM engine_parity_registry").all())?.results || []; } catch { registryRows = []; }
  let cards = [];
  try { cards = await scorecards(db, { days: REPUTATION_DAYS, now }); } catch { cards = []; }
  let stuck = [];
  try { stuck = await listStuckStates(db, { limit: 50 }); } catch { stuck = []; }
  const agents = MANIFESTS.map((x) => registryEntry(x, { registryRows, cards, stuck }));
  const counts = {};
  for (const a of agents) counts[a.lifecycle] = (counts[a.lifecycle] || 0) + 1;
  return { version: INDICATOR_REGISTRY_VERSION, manifest_version: MANIFEST_VERSION, scoring_version: SCORING_VERSION, window_days: REPUTATION_DAYS, lifecycle_counts: counts, agents };
}
