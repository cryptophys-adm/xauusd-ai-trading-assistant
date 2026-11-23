// The page render check's registry (scripts/render-check.mjs bundles this file with esbuild as CommonJS, lightweight-charts
// aliased to scripts/lw-stub.mjs). Each entry is a pure, null-safe view with the fixture of its route: the check renders
// it with renderToStaticMarkup over the fixture, the routes' not_found bodies, each path nulled in turn and each array
// emptied, and fails on a throw, "NaN", "undefined" or "[object Object]" in the markup. A page that joins Intelligence
// (Track C) adds its view and its test/fixtures/nexus-intel/*.json here (C2: the Liquidity page's LiquidityView; C3: the
// Chart patterns page's PatternsView; OM-LEAN: the Omega page's OmegaLeanView and its states).
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import lens from "../../../../test/fixtures/nexus-intel/lens.json";
import liquidity from "../../../../test/fixtures/nexus-intel/liquidity.json";
import unavailable from "../../../../test/fixtures/nexus-intel/liquidity-unavailable.json";
import decision from "../../../../test/fixtures/nexus-intel/engine-decision.json";
import ez1Global from "../../../../test/fixtures/nexus-ez1/conclusion-global.json";
import ez1Overview from "../../../../test/fixtures/nexus-ez1/omega-overview.json";
import omegaLean from "../../../../test/fixtures/nexus-omega/omega-lean-overview.json";
import chartPatterns from "../../../../test/fixtures/nexus-intel/chart-patterns.json";
import strategyAgents from "../../../../test/fixtures/nexus-intel/strategy-agents.json";
import neuronAllocation from "../../../../test/fixtures/nexus-intel/neuron-allocation.json";
import { LensHeader, LensView } from "../src/components/LensPanel";
import { LiquidityView } from "../src/pages/Liquidity";
import { PatternsUnread, PatternsView } from "../src/pages/Patterns";
import { DecisionPlanView } from "../src/components/PlanLadder";
import { OmegaSignalView } from "../src/components/OmegaZone";
import { OmegaLeanView } from "../src/pages/Omega";
import type { Poll } from "../src/lib/usePoll";

export type Entry = {
  /** The view's name, as the check prints it. */
  name: string;
  /** A pure view of one route's body. */
  View: ComponentType<{ d: any }>;
  /** The route's body (test/fixtures/nexus-intel/*.json). */
  fixture: unknown;
  /** Text the fixture's own render must show (the view rendered its content, not its empty state). */
  shows?: string[];
  /** Text the fixture's own render must not show (EZ1: with no zone fields nothing new is drawn). */
  hides?: string[];
  /** Bodies beside the check's own not_found bodies that the route answers with no data. */
  missing?: unknown[];
};

/** A deep merge of plain objects (arrays and values replaced): the fixture with the fields a later backend PR fills. */
export function merged(base: any, add: any): any {
  if (add == null || typeof add !== "object" || Array.isArray(add) || base == null || typeof base !== "object" || Array.isArray(base)) return add === undefined ? base : add;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(add)) out[k] = merged(base[k], v);
  return out;
}

/**
 * The Liquidity page (Track C2) over its reads. /api/liquidity is the contract (test/fixtures/nexus-intel/
 * liquidity.json, and liquidity-unavailable.json: no recent broker bar). Since B15 the fixture carries the LIQUIDITY
 * card and the quorum with liquidity (the latest decision's decision.liquidity), and since B16 conditions;
 * effects.level_moves is still null. LATER is the page's own stand-in for the level moves until backends B17-B19
 * publish theirs (the mockup's "all backend PRs deployed" board), with conditions emptied; it is not a contract. The clock is the fixture's (lens B's state 2 minutes old, the
 * card 13 minutes old).
 */
export const LIQUIDITY_NOW = (liquidity as any).state.at_ms + 2 * 60_000;
export const LATER = {
  conditions: {},
  effects: { level_moves: [{ at_ms: (liquidity as any).state.at_ms - 3_600_000, side: "BUY", action: "level", outcome: "hit" }] }
};
export const LIQUIDITY_FULL = merged(liquidity, LATER);
/** The B15 fields null: the latest decision has no decision.liquidity (the switch off; lens B off, floored or stale; a decision before B15). */
export const NO_CARD = { card: null, quorum_with_liquidity: null };
const CARD = (liquidity as any).card;
/**
 * The card's other shapes, as src/decision-engine.mjs liquidityCard writes them (the fixture's card is the agreeing one):
 * one per lean_reason, a bearish lean, and a stale card (the latest decision 22 minutes old).
 */
const NO_LEAN = { lean: 0, side: "NEUTRAL", agreeing: [] };
export const CARD_REASONS: Record<string, any> = {
  sweep_with_agreeing_witness: CARD,
  no_agreeing_witness: { ...CARD, ...NO_LEAN, lean_reason: "no_agreeing_witness", summary: "A reclaimed sell-side sweep on a tick-volume spike 3 minutes ago on the broker's own bars, but no counting witness leans bullish: no lean. Council only: it never counts in the quorum." },
  sweep_stale: { ...CARD, ...NO_LEAN, sweep: null, sweep_age_min: null, lean_reason: "sweep_stale", summary: "The last reclaimed sweep on the broker's tick volume is more than 15 minutes old: no lean. Council only: it never counts in the quorum." },
  not_reclaimed: { ...CARD, ...NO_LEAN, sweep: null, sweep_age_min: null, lean_reason: "not_reclaimed", summary: "The last sweep on the broker's tick volume did not close back inside: no lean. Council only: it never counts in the quorum." },
  no_sweep: { ...CARD, ...NO_LEAN, sweep: null, sweep_age_min: null, lean_reason: "no_sweep", summary: "No reclaimed sweep on the broker's tick volume in the last 15 minutes: no lean. Council only: it never counts in the quorum." }
};
export const CARD_BEARISH = { ...CARD, lean: -0.6, side: "BEARISH", sweep: "buy_side", sweep_age_min: 6, agreeing: ["M15"], summary: "A reclaimed buy-side sweep on a tick-volume spike 6 minutes ago on the broker's own bars, and 15m War Room leans bearish too: it leans bearish. Council only: it never counts in the quorum." };
export const CARD_STALE = { ...CARD, at_ms: LIQUIDITY_NOW - 22 * 60_000, stale: true };
/** quorum_with_liquidity with neither side's quorum check holding (liquidityQuorum at intraday: 0.5 and a lean of 0.15). */
export const QUORUM_NOT_MET = { score: 0.08, bias: "NEUTRAL", long_share: 0.48, short_share: 0.2, neutral_share: 0.32, share_needed_above: 0.5, quorum_min: 0.5, long_met: false, short_met: false, met: false };
/** /api/lens with lens B's intraday weight from Aether at 0.36 (the lens panel's Aether source; the LIQUIDITY card reads its own weight). */
export const LENS_AETHER = merged(lens, { liquidity: { weights: { intraday: { weight: 0.36, source: "aether" } } } });
export const LENS_OFF = merged(lens, { switches: { liquidity_enabled: false }, liquidity: { weights: { scalp: { weight: 0, source: "switch_off" }, intraday: { weight: 0, source: "switch_off" }, swing: { weight: 0, source: "switch_off" }, range: { weight: 0, source: "switch_off" } }, facts: null, line: null } });
/**
 * The live mix of 2026-11-23 (the reviewer's 14-day D1 count after B8 went live): every effects list empty but makers,
 * one row whose outcome is "pending" (B8's outcomeOf reads anything not hit/miss/neutral, NULL included, as pending).
 */
export const LIVE_EFFECTS = { effects: { blocks: [], makers: [{ at_ms: (liquidity as any).state.at_ms - 5_400_000, side: "BUY", mode: "scalp", outcome: "pending" }], skips: [], deferrals: [], level_moves: null, pm_actions: [] } };
/**
 * The Chart patterns page (Track C3) over its reads. /api/chart-patterns is backend B9's contract
 * (test/fixtures/nexus-intel/chart-patterns.json, byte for byte): two plans (the 15m ascending triangle's pattern_lines
 * plan, armed, with its entry zone; the 1H rectangle top's pattern_inside plan, shadow, without one), and every field a
 * later backend PR fills null. /api/strategy-agents and /api/neuron-allocation are sample bodies built with the routes'
 * own code (strategy-agents.json, neuron-allocation.json). PATTERNS_LATER is the page's own stand-in for the later
 * fields (the mockup's "all backend PRs deployed" board); it is not a contract. The clock is two minutes after the
 * fixture's decision (Monday 15:02 UTC, the market open).
 */
export const PATTERNS_NOW = Date.parse((chartPatterns as any).decision.bar_close) + 2 * 60_000;
const P = chartPatterns as any;
const laterPattern = (p: any) => p.status === "forming" ? {} : { held: true, breakout_bars_ago: 3, bars_since_breakout: 3, horizon_bars: 19, bars_left: 16, ...(p.plan ? { plan: { reach: "continuation" } } : {}) };
export const PATTERNS_LATER = { patterns: P.patterns.map((p: any) => merged(p, laterPattern(p))), seat: { horizon_bars: 19 } };
export const PATTERNS_FULL = merged(P, PATTERNS_LATER);
/** No plan: the latest decision without a trade agent (WAIT) and no pattern agent plan. */
export const PATTERNS_NO_PLAN = merged(P, { decision: { trade_agent: null, council_strategy: null }, patterns: P.patterns.map((p: any) => ({ ...p, plan: null })) });
/** CHART_PATTERNS_MODE off: no pattern and no measured target. */
export const PATTERNS_OFF = merged(P, { mode: "off", patterns: [], far_targets: [] });
const NO_CALIBRATION = { version: null, computed_at: null, base_rate: null, resolved: null, pending: null, patterns: null, by_tf: null, open: null };
const unread = (code: string): Poll => ({ data: null, error: code, loading: false, refresh: () => {}, lastOk: null, lastFail: 1, failures: 1, stale: false, intervalMs: 120_000 });
const PATTERN_PANELS = ["Lines on the chart", "Patterns on this chart", "Measured targets, every chart", "Measured record per chart", "Projection seat", "Pattern agents"];
const PATTERN_HINT = "A plan&#x27;s TP1 is the nearest key zone at 1R or more; its TP2 is the measured target when that lies beyond TP1.";
const patternsView = (props: Record<string, unknown> = {}) => ({ d }: { d: any }) => <PatternsView d={d} agents={strategyAgents} alloc={neuronAllocation} now={PATTERNS_NOW} {...props} />;

const PANELS = ["Positioning &amp; Liquidity analyst", "Score against the floor", "Levels on the chart", "Facts, last 24 hours", "Sweeps and outcomes", "Baseline per New York hour of the week", "What it changed in Omega", "In the latest decision"];
const HINT = "Liquidity never opens, sizes or prices an entry.";
const NOT_FOUND = { status: "not_found", reason: "intel_views_off" };

/**
 * EZ1 (the entry zone, owner-approved mockup 2026-11-23): the Decision card's zone parts over GET /api/conclusion/global
 * (test/fixtures/nexus-ez1/conclusion-global.json: the engine on, its trade's entry_low/entry_high on the feed scale)
 * and the Omega Signal card's over GET /omega/api/overview (omega-overview.json). The variants: the engine off (the
 * strategy plan's band, 2684.30–2685.50 here so the source shows), no zone fields at all, a stale decision, and each
 * of the five planner codes with the code's own detail.
 */
const clone = (v: any) => JSON.parse(JSON.stringify(v));
export const EZ1_ENGINE_OFF = merged({ ...clone(ez1Global), engine: null }, { global: { strategy: { plan: { entry_low: 2684.3, entry_high: 2685.5 } } } });
export function withoutZone(body: any): any {
  const out = clone(body);
  for (const p of [out?.engine?.trade, out?.global?.strategy?.plan]) if (p) { delete p.entry_low; delete p.entry_high; }
  if (out?.engine) delete out.engine.entry_zone_mode;
  if (out?.signal) { delete out.signal.entry_zone_low; delete out.signal.entry_zone_high; delete out.signal.entry_zone_edge; }
  return out;
}
export const EZ1_NO_ZONE = withoutZone(ez1Global);
/** The planner's details as src/omega-engine.mjs writes them (broker scale; invented sample prices). */
export const EZ1_DETAILS: Record<string, string> = {
  limit_in_zone: "2685.32 -> 2684.64",
  limit_zone_edge: JSON.stringify({ plan_entry: 2685.32, edge: 2686.02, away_r_plan: 0.462, away_r_edge: 0.307 }),
  zone_passed: "the entry zone 2684.62-2686.02 is passed",
  zone_tight: "a limit at 2684.68 leaves 0.56 of risk to the plan's stop, under 0.6 (0.5 x the plan's 1.2)",
  zone_rr: "a limit at 2686.02 pays 0.869 R to the target, under 1"
};
export const EZ1_CODE_SHOWS: Record<string, string[]> = {
  limit_in_zone: ["Planner, since", 'data-kind="adjust"', "Limit in the entry zone: the plan&#x27;s level was through price (or inside the stops level); stop and TP1 kept.", "from 2685.32 to 2684.64 · broker"],
  limit_zone_edge: ["Planner, since", 'data-kind="adjust"', "Limit at the zone&#x27;s near edge: the plan&#x27;s level is out of the placement band; stop and TP1 kept.", "plan 2685.32 · 0.462R away → edge 2686.02 · 0.307R away · broker"],
  zone_passed: ["Planner, not entering", 'data-kind="block"', "Refused: price already passed the entry zone.", "the entry zone 2684.62-2686.02 is passed · broker"],
  zone_tight: ["Planner, not entering", 'data-kind="block"', "Refused: zone too tight. A limit inside it keeps under half the plan&#x27;s risk.", "a limit at 2684.68 leaves 0.56 of risk to the plan&#x27;s stop, under 0.6 (0.5 x the plan&#x27;s 1.2) · broker"],
  zone_rr: ["Planner, not entering", 'data-kind="block"', "Refused: R:R below the minimum. A limit inside the zone pays under 1R to TP1.", "a limit at 2686.02 pays 0.869 R to the target, under 1 · broker"]
};
export const ez1Code = (code: string) => merged(clone(ez1Overview), { broker: { planner: { codes: [code], details: { [code]: EZ1_DETAILS[code] } } } });
const EZ1_ZONE_SHOWS = ["Entry zone", "2684.20–2685.60", "· feed scale", "zone · feed scale", "plan 2684.90", "key zone 2683.60–2686.60", "Omega limit", "not available on this page", "near edge", "2685.60", "feed · allowed", "min 1R · feed scale"];
const EZ1_NEW = ["Entry zone", "zone · feed scale", "Omega limit", "EZ1"];

/**
 * OM-LEAN (owner-approved mockup 1795450033-0f25): the Omega page's lean Terminal view (OmegaLeanView: the header, the
 * alert lines, Open & resting, the signal line, Last actions and Details) over GET /omega/api/overview
 * (test/fixtures/nexus-omega/omega-lean-overview.json: a connected demo account, one Omega BUY, one resting BUY_LIMIT,
 * the BUY ENTER_LIMIT signal with limit_in_zone), and each lean state the mockup draws. The clock is the mockup's.
 */
export const OMEGA_NOW = Date.parse("2026-11-19T14:07:05Z");
const OL = omegaLean as any;
const olv = (add: any) => merged(clone(OL), add);
const codes = (c: string, details: Record<string, string> = {}) => ({ broker: { planner: { codes: [c], details } } });
export const OMEGA_LEAN_STATES: Record<string, { fixture: any; shows: string[]; hides?: string[]; details?: boolean }> = {
  OmegaLean: { fixture: OL, shows: ["Connected", "sync 3s", "Example Markets Ltd", "demo", "Active", "Pause entries…", "Kill…", "10,014.00", "−11.40", "+25.40", "52.00 (0.5%)", "2684.88", "22 pts", "risk 1%", "max 2 positions", "daily loss cap 3%", "+0.1%", "prices: broker · chart feed = broker − 0.42", "1 position · 1 limit", "#50128", "Omega", "52.00", "0.5%", "Limit", "#50131", "38.20", "0.4%", "exp 14:20", "2685.32", "2684.62–2686.02", "expires in 8 min", "Omega placed limit #50131 at 2684.64 in the zone; the plan&#x27;s level was through price.", "Limit placed", "Stop set", "Limit filled", "gap 0.02R", "Limit expired", "Details"], hides: ["Market Watch", "Navigator", "Expert Advisor", "ARMED", "LIVE", "Arm live"] },
  OmegaLeanDetails: { fixture: OL, details: true, shows: ["Chart", "M15", "Feed prices (OANDA): broker − 0.42.", "Positions and orders", "Delegate my next manual entries to Omega", "e:1345:BUY", "#50131 resting · expires 14:20 UTC · no council note.", "History 3", "Intents 4", "Journal 6", "Signal", "Risk : reward", "1.49", "68%", "OANDA:XAUUSD:15:1795096800000", "Planner, since 14:06 UTC · 21:06 GMT+7", "Account and stats", "10,025.40", "10,000.00", "Intraday", "+118.30", "Symbol and account", "1:500", "537.00", "Diagnostics", "Show raw state", "9f2c41ab77e0d215", "OmegaExecutor 1.21 · stops by Omega", "US Initial Jobless Claims", "fixed values, not measured", "self_healing_v1", "Charts by TradingView"] },
  OmegaLeanDisconnected: { fixture: olv({ broker: { bridge: { seen: false, synced_age_ms: 240000, terminal_connected: false, trade_allowed: false, terminal_error: "[terminal_error]" }, ...codes("executor_stale").broker } }), shows: ["Disconnected", "last sync 4 min", "as of 14:03 UTC", "Terminal: [terminal_error]", "rows below are as of the last sync", "Omega is not entering: the MT5 terminal has not reported recently, so Omega does not act blind.", "executor_stale"], hides: ["Day realized", "Connected"] },
  OmegaLeanStale: { fixture: olv({ broker: { bridge: { state_age_ms: 95000, terminal_connected: false, trade_allowed: false }, ...codes("executor_stale").broker } }), shows: ["Stale", "terminal state 95 s old", "executor_stale"], hides: ["Disconnected", "Algo off"] },
  OmegaLeanAlgoOff: { fixture: olv({ broker: { bridge: { trade_allowed: false } } }), shows: ["Algo off", "sync 3s", "Algo trading is off in the MT5 terminal: no order can be sent. Turn on Algo Trading in the terminal."], hides: ["Connected"] },
  OmegaLeanPaused: { fixture: olv({ control: { mode: "paused", reason: "[reason]", actor: "owner", at: "2026-11-19T13:10:00Z" }, ...codes("paused") }), shows: ["Paused", "owner, 13:10 UTC: &quot;[reason]&quot;", "Resume", "Kill…", "Omega is not entering: paused. Open positions are still managed."], hides: ["Pause entries…"] },
  OmegaLeanKilled: { fixture: olv({ control: { mode: "killed", reason: "[reason]", actor: "owner", at: "2026-11-19T14:02:00Z" }, signal: { kill: true, kill_source: "omega" }, ...codes("kill") }), shows: ["Killed", "owner, 14:02 UTC: &quot;[reason]&quot;", "Resume", "closing", "Kill switch: every position is being closed and nothing new opens."], hides: ["Kill…", "Pause entries…", "Killed · server"] },
  OmegaLeanKilledServer: { fixture: olv({ signal: { kill: true, kill_source: "env" }, ...codes("kill") }), shows: ["Killed · server", "Server kill switch is on; it overrides this control."] },
  OmegaLeanEngineOff: { fixture: olv({ broker: { engine: { enabled: false }, planner: { codes: ["engine_off"], details: {} } } }), shows: ["Engine off", "Omega is not entering: the engine is switched off. Turn it on with the Engine switch, or in Setup."], hides: ["Engine off · server", "Active<"] },
  OmegaLeanEngineOffServer: { fixture: olv({ broker: { engine: { env_enabled: false }, planner: { codes: ["engine_off"], details: {} } } }), shows: ["Engine off · server", "Omega is not entering: the server switch is off (OMEGA_ENGINE_ENABLED). Only the Worker setting turns it on."], hides: ["Turn it on with the Engine switch"] },
  OmegaLeanDailyLoss: { fixture: olv({ broker: { bridge: { equity: 9700, balance: 9700, day_realized_pl: -300, positions: [], orders: [] }, entry_order: { pending: [] }, planner: { codes: ["daily_loss_limit"], details: {} }, accounts: [{ ...OL.broker.accounts[0], day_pl_pct: -3, upgrade_block_reason: "daily_loss_limit", upgrade_block_until_ms: Date.parse("2026-11-20T00:00:00Z") }] } }), shows: ["9,700.00", "−300.00", "daily loss cap 3% reached, today −3.0%", "upgrades blocked until 00:00 UTC", "Omega is not entering: the daily loss limit is reached: no new entries today.", "daily_loss_limit"] },
  OmegaLeanNothingOpen: { fixture: olv({ signal: { side: "NONE", action: "WAIT" }, broker: { bridge: { equity: 10025.4, positions: [], orders: [] }, entry_order: { pending: [] }, planner: { codes: ["no_side"], details: {} } } }), shows: ["Nothing open or resting.", "last close 12:32 UTC, #77120 +42.80", "WAIT", "Omega is not entering: the Decision Engine says WAIT: there is no BUY or SELL to follow."], hides: ["expires in"] },
  OmegaLeanRefused: { fixture: olv({ broker: { bridge: { orders: [] }, entry_order: { pending: [] }, planner: { codes: ["zone_rr"], details: { zone_rr: "a limit at 2686.02 pays 0.869 R to the target, under 1" } } } }), shows: ["Omega refused it: R:R below the minimum. A limit inside the zone pays under 1R to TP1.", "zone_rr", "1 position"] },
  OmegaLeanBasisUnknown: { fixture: olv({ signal: { feed_basis: 0, feed_basis_known: false } }), details: true, shows: ["prices: broker · basis unknown", "2684.90", "2684.20–2685.60", " feed", "Omega&#x27;s lines at broker prices, the basis is unknown."], hides: ["chart feed = broker", "limit <span class=\"mono\">2685.32"] },
  OmegaLeanLive: { fixture: olv({ broker: { bridge: { trade_mode: "real" }, planner: { codes: ["live_not_armed"], details: {} } } }), shows: ["LIVE", "not armed", "Arm live…", "Omega is not entering: a live account is connected but live trading is not armed (owner only)."], hides: ["demo", "Disarm live"] },
  OmegaLeanLiveArmed: { fixture: olv({ broker: { bridge: { trade_mode: "contest" }, engine: { live_armed: true } } }), shows: ["LIVE", "armed", "Disarm live"], hides: ["not armed", "Arm live…"] },
  OmegaLeanManual: { fixture: olv({ broker: { delegation: { tickets: [50141] }, bridge: { orders: [], positions: [
    { ticket: 50140, symbol: "XAUUSD", side: "BUY", volume: 0.05, open_price: 2685.4, sl: 0, tp: 0, profit: -2.6, opened_ms: OMEGA_NOW - 180000, magic: 0, source: "manual" },
    { ticket: 50141, symbol: "XAUUSD", side: "SELL", volume: 0.05, open_price: 2689.1, sl: 2692.3, tp: 2683.7, profit: 21.5, opened_ms: OMEGA_NOW - 2400000, magic: 0, source: "manual" }] } } }),
    shows: ["2 manual positions · at stops 16.00 + 1 without stop", "16.00 + 1 without stop", "manual", "delegated", "no stop", "Delegate", "Take back", "+21.50", "0.2%"] },
};

export const VIEWS: Entry[] = [
  ...Object.entries(OMEGA_LEAN_STATES).map(([name, v]) => ({ name, View: ({ d }: { d: any }) => <OmegaLeanView d={d} now={OMEGA_NOW} details={v.details} />, fixture: v.fixture, shows: v.shows, hides: v.hides })),
  { name: "EZ1DecisionEngineOn", View: DecisionPlanView, fixture: ez1Global, shows: EZ1_ZONE_SHOWS, hides: ["stale"] },
  { name: "EZ1DecisionStale", View: ({ d }) => <DecisionPlanView d={d} suffix=" · stale 12m" />, fixture: ez1Global, shows: ["Entry zone", "2684.20–2685.60", "· stale 12m"] },
  { name: "EZ1DecisionEngineOff", View: DecisionPlanView, fixture: EZ1_ENGINE_OFF, shows: ["Entry zone", "2684.30–2685.50", "plan 2684.90", "Omega limit"], hides: ["2684.20–2685.60", "EZ1b"] },
  { name: "EZ1DecisionNoZone", View: DecisionPlanView, fixture: EZ1_NO_ZONE, shows: ["2684.90", "min 1R · feed scale"], hides: EZ1_NEW },
  // OM-LEAN: the Signal card's prices on the header's scale (broker = feed + 0.42), the zone once, no basis or EZ1b row.
  { name: "EZ1OmegaSignal", View: OmegaSignalView, fixture: ez1Overview, shows: ["2685.32", "2684.62–2686.02", "2680.82", "2692.02", "14:00:00 UTC · 21:00 GMT+7", "21:07 GMT+7", "in zone · from 2685.32", "near edge · from 2685.32", "zone 2684.62–2686.02"], hides: ["EZ1b", "entry_zone_edge", "broker − feed", "· feed"] },
  { name: "EZ1OmegaSignalNoZone", View: OmegaSignalView, fixture: withoutZone(ez1Overview), shows: ["2685.32"], hides: [">Zone<", "Near edge"] },
  { name: "EZ1OmegaSignalNoBasis", View: OmegaSignalView, fixture: merged(clone(ez1Overview), { signal: { feed_basis: 0, feed_basis_known: false } }), shows: ["2684.90", "2684.20–2685.60", " · feed", "2680.40", "2691.60"] },
  ...Object.keys(EZ1_DETAILS).map((code) => ({ name: `EZ1OmegaWhy_${code}`, View: OmegaSignalView, fixture: ez1Code(code), shows: EZ1_CODE_SHOWS[code] })),
  { name: "LensView", View: LensView, fixture: lens, shows: ["Lens A · Positioning (CFTC)", "Lens B · Liquidity (broker M1)", "at floor", "fresh", "insufficient"] },
  { name: "LensHeader", View: LensHeader, fixture: lens, shows: ["Intraday mode"] },
  {
    name: "LiquidityView", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: liquidity,
    shows: [...PANELS, HINT, "lens B on", "LIQUIDITY", "fresh 13m", "Council only: it never counts toward the quorum.", "0.03", "a tenth of lens B&#x27;s 0.30, at most 0.06", "▲ +0.60 bullish", "▲ sell-side", "3 min ago",
      "fresh sweep, H1 and M15 agree", "sweep_with_agreeing_witness", "made", "14:47 UTC", "lens B state", "14:46 UTC", "Quorum with liquidity", "Informational: the quorum with the LIQUIDITY card added at its weight. No gate reads it.", "▲ 0.67", "+0.17", "▲ long",
      "Fills after backend B19 is deployed.", "Scored after backend B19 is deployed.", "Position Manager actions", "baseline insufficient · 2 of 4 weeks", "backfill done"],
    hides: ["No LIQUIDITY card in the latest decision", "council only", "never counted"],
    missing: [NOT_FOUND]
  },
  {
    name: "LiquidityViewNoCard", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), ...NO_CARD },
    shows: ["No LIQUIDITY card in the latest decision", "None while the switch is off, lens B is off, floored or stale, or the decision came before the card (B15).", "Quorum", "WAIT"],
    hides: ["Quorum with liquidity", "Council only: it never counts toward the quorum."]
  },
  ...Object.entries(CARD_REASONS).filter(([code]) => code !== "sweep_with_agreeing_witness").map(([code, card]) => ({
    name: `LiquidityViewReason_${code}`, View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), card },
    shows: [code, card.sweep ? "3 min ago" : "none", "· 0.00 neutral"], hides: ["▲ +0.60"]
  })),
  // The card and the quorum with liquidity as the varied body, so each of their paths is nulled (the page's variants are capped).
  { name: "LiquidityViewCard", View: ({ d }) => <LiquidityView d={{ ...(liquidity as any), card: d }} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: CARD, shows: ["LIQUIDITY", "fresh sweep, H1 and M15 agree"] },
  { name: "LiquidityViewQuorumWithLiquidity", View: ({ d }) => <LiquidityView d={{ ...(liquidity as any), quorum_with_liquidity: d }} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: (liquidity as any).quorum_with_liquidity, shows: ["Quorum with liquidity", "▲ long"] },
  { name: "LiquidityViewCardBearish", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), card: CARD_BEARISH }, shows: ["▼ −0.60 bearish", "▼ buy-side", "6 min ago", "fresh sweep, M15 agrees"] },
  { name: "LiquidityViewCardStale", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), card: CARD_STALE }, shows: ["stale 22m", "▲ +0.60 bullish", "14:38 UTC"], hides: ["fresh 13m"] },
  { name: "LiquidityViewQuorumNotMet", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), quorum_with_liquidity: QUORUM_NOT_MET }, shows: ["Quorum with liquidity", "▲ 0.48", "+0.08"], hides: ["▲ long"] },
  {
    name: "LiquidityViewUnavailable", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: unavailable,
    shows: [...PANELS, HINT, "lens B off", "No recent broker bars", "No levels yet", "No sweep yet"],
    missing: [NOT_FOUND]
  },
  {
    name: "LiquidityViewLater", View: ({ d }) => <LiquidityView d={d} lens={LENS_AETHER} decision={decision} now={LIQUIDITY_NOW} />, fixture: LIQUIDITY_FULL,
    shows: [...PANELS, HINT, "LIQUIDITY", "Quorum with liquidity", "Level moves"],
    missing: [NOT_FOUND]
  },
  {
    name: "LiquidityViewPendingMaker", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, LIVE_EFFECTS),
    shows: ["1 pending", "none in 7 days", "No Position Manager action on a sweep in the last 7 days.", "Fills after backend B19 is deployed."]
  },
  { name: "LiquidityViewLensOff", View: ({ d }) => <LiquidityView d={d} lens={LENS_OFF} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, { state: { on: false } }), shows: ["lens B off", "Omega ignores these levels (lens B off)", "Switched off by the owner."] },
  { name: "LiquidityViewLens", View: ({ d }) => <LiquidityView d={liquidity} lens={d} decision={decision} now={LIQUIDITY_NOW} />, fixture: lens, shows: ["Lens B · Liquidity (broker M1)", "Score against the floor"] },
  {
    name: "PatternsView", View: patternsView(), fixture: chartPatterns,
    shows: [...PATTERN_PANELS, PATTERN_HINT, "patterns on", "calibration auto", "calibrated 22m ago", "price 4,100.00 · feed scale", "ATR (1H) 2.19",
      "Agent plan", "armed", "Charts by TradingView", "zone 4,098.12–4,098.92", "TP2 of the plan", "No held breakouts yet", "No horizon yet", "No plan reach yet", "No horizon for the seat yet", "No filled mean R yet", "No higher-chart pattern agent yet"],
    missing: [NOT_FOUND]
  },
  { name: "PatternsView1H", View: patternsView({ tf: "60" }), fixture: chartPatterns, shows: ["Inside the pattern", "▼ short", "shadow", "not the measured target", "last 60 closed bars"] },
  { name: "PatternsView4H", View: patternsView({ tf: "240" }), fixture: chartPatterns, shows: ["The agent plans&#x27; lines show on the 15m and 1H charts, where their patterns are.", "pattern agents trade the 15m and 1H charts only"] },
  { name: "PatternsViewDaily", View: patternsView({ tf: "D" }), fixture: chartPatterns, shows: ["(daily) · last 60 closed bars", "inverted descending scallop"] },
  { name: "PatternsViewLater", View: patternsView(), fixture: PATTERNS_FULL, shows: ["Since breakout", "held", "at price (continuation)", "judged on its horizon (19 bars)", "No filled mean R yet"] },
  { name: "PatternsViewModeOff", View: patternsView(), fixture: PATTERNS_OFF, shows: ["patterns off", "Chart patterns off", "Measured record per chart", "Pattern agents"] },
  { name: "PatternsViewNoPlan", View: patternsView(), fixture: PATTERNS_NO_PLAN, shows: ["No agent plan", "The latest decision has no trade agent: no Entry, Stop or TP line."] },
  { name: "PatternsViewNoEntryZone", View: patternsView({ tf: "60" }), fixture: chartPatterns, shows: ["No entry zone yet", "This plan carries no entry_low or entry_high, so the entry zone cannot be drawn."] },
  { name: "PatternsViewCalibrationOff", View: patternsView(), fixture: merged(P, { calibration_mode: "off", calibration: NO_CALIBRATION }), shows: ["calibration off", "No measured record", "Calibration is switched off by the owner: every pattern keeps its default weights."] },
  { name: "PatternsViewNoCalibration", View: patternsView(), fixture: merged(P, { calibration: NO_CALIBRATION }), shows: ["No measured record yet"] },
  { name: "PatternsViewNoCandles", View: patternsView({ tf: "60" }), fixture: merged(P, { charts: { "60": { ohlcv: [] } } }), shows: ["No 1H candles yet", "The chart&#x27;s closed bars come with /api/chart-patterns every 2 minutes."] },
  { name: "PatternsViewMarketClosed", View: patternsView({ now: Date.parse("2026-11-21T15:00:00Z") }), fixture: chartPatterns, shows: ["market closed", "Market closed", "Patterns read closed bars. The next 15m bar closes Sun 18:15 New York · Sun 23:15 UTC"] },
  { name: "PatternsViewIntelOff", View: patternsView(), fixture: NOT_FOUND, shows: ["intel_views_off", "The Intelligence views are off on the AI Worker."] },
  { name: "PatternsViewAgents", View: ({ d }) => <PatternsView d={chartPatterns} agents={d} alloc={neuronAllocation} now={PATTERNS_NOW} />, fixture: strategyAgents, shows: ["Reversal tops and bottoms", "1 held back", "suspended", "double top (Adam &amp; Adam)"] },
  { name: "PatternsViewSeat", View: ({ d }) => <PatternsView d={chartPatterns} agents={strategyAgents} alloc={d} now={PATTERNS_NOW} />, fixture: neuronAllocation, shows: ["shadow", "n 4 / 60"] },
  { name: "PatternsUnread500", View: ({ d }) => <PatternsUnread poll={unread(`/api/chart-patterns 500 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { status: "error", error: "chart_patterns_unavailable" }, shows: ["/api/chart-patterns 500 chart_patterns_unavailable"] },
  { name: "PatternsUnread404", View: ({ d }) => <PatternsUnread poll={unread(`/api/chart-patterns 404 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { error: "Not found" }, shows: ["/api/chart-patterns 404 Not found"] },
  { name: "LiquidityViewDecision", View: ({ d }) => <LiquidityView d={LIQUIDITY_FULL} lens={lens} decision={d} now={LIQUIDITY_NOW} />, fixture: decision, shows: ["Quorum", "WAIT"] }
];

/**
 * The self-test (render-check.mjs --self-test): views that are broken on purpose, one per finding the check must catch.
 * The check has to fail on every one of them; if it passes one, the check itself is broken.
 */
const fixture = { a: 1, b: 2, label: "ready", obj: { k: 1 }, list: [1, 2] };
export const BROKEN: Entry[] = [
  { name: "SelfTestNaN", View: ({ d }) => <span>share {d?.a / d?.b}</span>, fixture },
  { name: "SelfTestUndefined", View: ({ d }) => <span>{`state ${d?.label}`}</span>, fixture },
  { name: "SelfTestObject", View: ({ d }) => <span>{`value ${d?.obj ?? "—"}`}</span>, fixture },
  { name: "SelfTestThrow", View: ({ d }) => <span>{d.list.length} items</span>, fixture }
];

/** One view's static markup. */
export function render(View: ComponentType<{ d: any }>, d: unknown): string {
  return renderToStaticMarkup(createElement(View, { d }));
}
