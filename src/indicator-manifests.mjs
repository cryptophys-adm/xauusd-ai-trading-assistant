// P2 of RFC_INDICATOR_AGENT_PLATFORM §9 (owner go 2026-11-07): one manifest per indicator agent.
//
// A manifest wraps an existing engine, HUD or desk without changing any hashed file: it names the
// agent, its family, the Pine section it reads (or the builtin it reproduces), the parity identity
// that can approve it, the rooms it speaks in, the subjects outcome scoring records for it, the
// state fields the stuck-state detector watches, and its shadow family. The rosters (HUD_NAMES,
// HUD_IDS in hud-reading.mjs) and the agent families (reputation.mjs) are generated from here;
// GET /api/indicator-agents joins the manifests with the live registry, scorecards, stuck states
// and shadow versions (indicator-registry.mjs).
//
// kind:      engine (a parity-checked local port of a Pine indicator), library (shared code with
//            no webhook of its own), hud (one agent per Pine HUD section), desk (a room agent that
//            reads several sources), moderator.
// reference: pine_ssot (pinescript/ssot, parity through its TradingView alert), pine_candidate
//            (a candidate alert in pinescript/candidates), builtin (a TradingView built-in),
//            none (no comparator: read as not yet calibrated).
// lifecycle: computed false is "not_computed"; otherwise the registry decides (indicator-registry).

export const MANIFEST_VERSION = "cryptophys.indicator-manifest.v1";

const R38 = "pinescript/ssot/The-Prophet-v7.02-R38.txt";
const GMI = "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt";
const MIZAN = "pinescript/ssot/CryptophysMizanLib-uploaded.txt";
const ALL_ROOMS = Object.freeze(["M15", "H1", "H4", "D1"]);
const m = (o) => Object.freeze({ computed: true, rooms: [], scored: [], stuck_prefix: null, shadow_family: null, identity: null, hud_identity: null, reference: "none", ...o });

export const MANIFESTS = Object.freeze([
  // Engines: local ports approved by parity with the TradingView alerts.
  m({ id: "prophet_r38", kind: "engine", name: "Prophet R38", family: "structure", source: { indicator: "Prophet R38", pine: R38 }, reference: "pine_ssot", identity: "prophet", hud_identity: "prophet_hud", scored: ["indicator:prophet_r38"], stuck_prefix: "prophet_r38.", shadow_family: "prophet_r38" }),
  m({ id: "prophet_r37", kind: "engine", name: "Prophet R37 (GMI shared core)", family: "structure", source: { indicator: "GMI v12.70 (embedded Prophet R37)", pine: GMI }, reference: "pine_ssot", identity: "prophet", scored: ["indicator:prophet_r37"], stuck_prefix: "prophet_r37.", shadow_family: "prophet_r37" }),
  m({ id: "gmi_v12_70", kind: "engine", name: "GMI v12.70", family: "trend", source: { indicator: "GMI v12.70", pine: GMI }, reference: "pine_ssot", identity: "gmi", hud_identity: "gmi_hud", scored: ["indicator:gmi_v12_70"], stuck_prefix: "gmi_v12_70.", shadow_family: "gmi_v12_70" }),
  m({ id: "mizan", kind: "library", name: "CryptophysMizanLib", family: "library", source: { indicator: "CryptophysMizanLib", pine: MIZAN }, reference: "pine_ssot", identity: "mizan" }),

  // HUD agents: one per Pine HUD section (owner decision 2026-11-05: agent name = HUD name).
  m({ id: "r37_funnel", kind: "hud", name: "R37 Funnel", family: "structure", source: { indicator: "Prophet R38", pine: R38, section: "funnel_table" }, reference: "pine_ssot", hud_identity: "prophet_hud", rooms: ALL_ROOMS }),
  m({ id: "prophet", kind: "hud", name: "Prophet", family: "structure", source: { indicator: "Prophet R38", pine: R38, section: "hud" }, reference: "pine_ssot", hud_identity: "prophet_hud", rooms: ALL_ROOMS }),
  m({ id: "trade_management", kind: "hud", name: "Trade Management", family: "execution", source: { indicator: "Prophet R38", pine: R38, section: "trade_management_hud" }, reference: "pine_ssot", hud_identity: "gmi_hud", rooms: ALL_ROOMS }),
  m({ id: "interstellar_eyes", kind: "hud", name: "The Interstellar Eyes", family: "levels", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_main col 0" }, rooms: ALL_ROOMS }),
  m({ id: "kinetic_engine", kind: "hud", name: "Kinetic Engine (TVA)", family: "trend", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_main col 7" }, rooms: ALL_ROOMS }),
  m({ id: "fabio_amt", kind: "hud", name: "Fabio AMT Sensors", family: "volume", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_main col 9" }, rooms: ALL_ROOMS }),
  m({ id: "chronos_matrix", kind: "hud", name: "Chronos Matrix", family: "levels", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_aegis top" }, reference: "pine_ssot", hud_identity: "gmi_hud", rooms: ALL_ROOMS }),
  m({ id: "aegis_footprint", kind: "hud", name: "Aegis Footprint Matrix", family: "order flow", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_aegis lower" }, reference: "pine_ssot", hud_identity: "prophet_hud", rooms: ALL_ROOMS }),
  m({ id: "tactical_muscles", kind: "hud", name: "Tactical Muscles", family: "momentum", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_tdm section 1" }, rooms: ALL_ROOMS }),
  m({ id: "macro_aether", kind: "hud", name: "Macro & Aether Sensors", family: "macro", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_tdm section 2" }, rooms: ALL_ROOMS }),
  m({ id: "gabfx_price_action", kind: "hud", name: "GABFX Price Action", family: "price action", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_tdm section 3" }, rooms: ALL_ROOMS }),
  m({ id: "playbook_execution", kind: "hud", name: "Playbook Execution", family: "execution", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_tdm section 4" }, rooms: ALL_ROOMS }),
  m({ id: "decision_matrix", kind: "hud", name: "Decision Matrix", family: "trend", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_tdm section 5" }, reference: "pine_ssot", hud_identity: "gmi_hud", rooms: ALL_ROOMS }),
  m({ id: "grid_bot_protocol", kind: "hud", name: "Grid Bot Protocol", family: "execution", source: { indicator: "GMI v12.70", pine: GMI, section: "hud_tdm section 6" }, computed: false, rooms: ALL_ROOMS }),

  // Desks: room agents that read several sources (src/war-room.mjs, src/timeframe-threads.mjs).
  m({ id: "m15", kind: "desk", name: "15m Desk", family: "timeframe desk", source: { indicator: "Prophet R38, Prophet R37, GMI v12.70 (15m records)" }, reference: "pine_ssot", identity: "prophet", rooms: ["M15"] }),
  m({ id: "h1", kind: "desk", name: "1H Desk", family: "timeframe desk", source: { indicator: "Prophet R38, Prophet R37, GMI v12.70 (1H records)" }, reference: "pine_ssot", identity: "prophet", rooms: ["H1"] }),
  m({ id: "h4", kind: "desk", name: "4H Desk", family: "timeframe desk", source: { indicator: "Prophet R38, Prophet R37, GMI v12.70 (4H records)" }, reference: "pine_ssot", identity: "prophet", rooms: ["H4"] }),
  m({ id: "d1", kind: "desk", name: "D1 Desk", family: "timeframe desk", source: { indicator: "Prophet R38, Prophet R37, GMI v12.70 (D1 records)" }, reference: "pine_ssot", identity: "prophet", rooms: ["D1"] }),
  m({ id: "htf", kind: "desk", name: "Higher-Timeframe Desk", family: "higher timeframe", source: { indicator: "the next higher room's conclusion" }, rooms: ["M15", "H1", "H4"] }),
  m({ id: "news", kind: "desk", name: "News Analyst", family: "fundamentals", source: { indicator: "News Daily" }, rooms: ALL_ROOMS }),
  m({ id: "technical", kind: "desk", name: "Technical Analyst", family: "price action", source: { indicator: "closed candles of the room's chart" }, rooms: ALL_ROOMS }),
  m({ id: "risk", kind: "desk", name: "Risk Manager", family: "risk", source: { indicator: "volatility, confirmations, conflicts" }, rooms: ALL_ROOMS }),
  m({ id: "moderator", kind: "moderator", name: "Moderator", family: "moderator", source: { indicator: "the room's bus, Consensus Discussion and crowd line" }, rooms: ALL_ROOMS })
]);

const byId = new Map(MANIFESTS.map((x) => [x.id, x]));
export const manifestOf = (id) => byId.get(id) ?? null;

/** The HUD roster, in manifest order (hud-reading.mjs HUD_NAMES / HUD_IDS). */
export const HUD_MANIFESTS = Object.freeze(MANIFESTS.filter((x) => x.kind === "hud"));

/** Agent families (reputation.mjs): every HUD, desk and the moderator. */
export const MANIFEST_FAMILIES = Object.freeze(Object.fromEntries(MANIFESTS.filter((x) => x.kind !== "engine" && x.kind !== "library").map((x) => [x.id, x.family])));
