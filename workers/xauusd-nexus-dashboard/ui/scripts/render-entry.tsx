// The page render check's registry (scripts/render-check.mjs bundles this file with esbuild as CommonJS, lightweight-charts
// aliased to scripts/lw-stub.mjs). Each entry is a pure, null-safe view with the fixture of its route: the check renders
// it with renderToStaticMarkup over the fixture, the routes' not_found bodies, each path nulled in turn and each array
// emptied, and fails on a throw, "NaN", "undefined" or "[object Object]" in the markup. A page that joins Intelligence
// (Track C) adds its view and its test/fixtures/nexus-intel/*.json here (C2: the Liquidity page's LiquidityView; C3: the
// Chart patterns page's PatternsView; ZN1: the Zones page's ZonesView over test/fixtures/nexus-zones/*.json).
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import lens from "../../../../test/fixtures/nexus-intel/lens.json";
import liquidity from "../../../../test/fixtures/nexus-intel/liquidity.json";
import unavailable from "../../../../test/fixtures/nexus-intel/liquidity-unavailable.json";
import decision from "../../../../test/fixtures/nexus-intel/engine-decision.json";
import ez1Global from "../../../../test/fixtures/nexus-ez1/conclusion-global.json";
import ez1Overview from "../../../../test/fixtures/nexus-ez1/omega-overview.json";
import chartPatterns from "../../../../test/fixtures/nexus-intel/chart-patterns.json";
import strategyAgents from "../../../../test/fixtures/nexus-intel/strategy-agents.json";
import neuronAllocation from "../../../../test/fixtures/nexus-intel/neuron-allocation.json";
import { LensHeader, LensView } from "../src/components/LensPanel";
import { LiquidityView } from "../src/pages/Liquidity";
import { PatternsUnread, PatternsView } from "../src/pages/Patterns";
import { DecisionPlanView } from "../src/components/PlanLadder";
import { OmegaSignalView } from "../src/components/OmegaZone";
import { Mt5ChartCanvas } from "../src/pages/Omega";
import { knownFeedBasis } from "../src/lib/entryZone";
import fs1Owner from "../../../../test/fixtures/nexus-fs1/feature-switches.json";
import fs1Viewer from "../../../../test/fixtures/nexus-fs1/feature-switches-viewer.json";
import fs1Revert from "../../../../test/fixtures/nexus-fs1/feature-switches-revert.json";
import fs1Replies from "../../../../test/fixtures/nexus-fs1/post-replies.json";
import fs1Record from "../../../../test/fixtures/nexus-fs1/feature-switches-record.json";
import fs1Hold from "../../../../test/fixtures/nexus-fs1/feature-switches-hold.json";
import zonesHeld from "../../../../test/fixtures/nexus-zones/zones.json";
import zonesLegacy from "../../../../test/fixtures/nexus-zones/zones-legacy.json";
import zonesClear from "../../../../test/fixtures/nexus-zones/zones-clear.json";
import zonesEmpty from "../../../../test/fixtures/nexus-zones/zones-empty.json";
import zonesOffBody from "../../../../test/fixtures/nexus-zones/zones-off.json";
import zonesErrorBody from "../../../../test/fixtures/nexus-zones/zones-error.json";
import zonesSwitches from "../../../../test/fixtures/nexus-zones/feature-switches-held.json";
import { BreakerPanel, ZonesLoading, ZonesUnread, ZonesView } from "../src/pages/Zones";
import { NO_EFFECT_NOTE, breakerOf } from "../src/lib/zones";
import { ConfirmBody, SwitchRowView, SwitchesLoading, SwitchesView, type RowStatus } from "../src/pages/Switches";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { POST_ERRORS, confirmText, rowOf, type Change } from "../src/lib/featureSwitches";
import { PollError } from "../src/components/ui";
import type { Poll } from "../src/lib/usePoll";
import h3fOff from "../../../../test/fixtures/nexus-h3f/feature-switches-off.json";
import h3fOn from "../../../../test/fixtures/nexus-h3f/feature-switches-on.json";
import h3fViewer from "../../../../test/fixtures/nexus-h3f/feature-switches-viewer.json";
import h3fReplies from "../../../../test/fixtures/nexus-h3f/correction-replies.json";
import h3fSession from "../../../../test/fixtures/nexus-h3f/council-session.json";
import h3fWar from "../../../../test/fixtures/nexus-h3f/war-room.json";
import h3fH1 from "../../../../test/fixtures/nexus-h3f/thread-h1.json";
import h3fVerdicts from "../../../../test/fixtures/nexus-h3f/strategy-verdicts.json";
import { ConclusionHero } from "../src/components/ThreadsPanel";
import { Post } from "../src/components/Post";
import { VerdictLine } from "../src/pages/Strategy";
import { CorrectionControl, CorrectionFooter, CorrectionPanel, GateOverride, ROW, type Phase } from "../src/components/Correction";
import { OpinionCard } from "../src/pages/Councils";
import pmOn from "../../../../test/fixtures/nexus-pm-lines/lines-on.json";
import pmOff from "../../../../test/fixtures/nexus-pm-lines/lines-off.json";
import pmHandOff from "../../../../test/fixtures/nexus-pm-lines/lines-hand-off.json";
import pmNew from "../../../../test/fixtures/nexus-pm-lines/lines-new.json";
import pmAfterOn from "../../../../test/fixtures/nexus-pm-lines/lines-after-on.json";
import pmError from "../../../../test/fixtures/nexus-pm-lines/lines-error.json";
import pmReplies from "../../../../test/fixtures/nexus-pm-lines/post-replies.json";
import { PmLinesFrame, PmLinesLoading, PmLinesView, type PmLinesProps } from "../src/components/PmLines";
import { replyResult } from "../src/lib/pmLines";
import { councilOpinionTarget, councilOptionsTarget, emptyDraft, engineTarget, errorOf, gateOf, replyOf, roomConclusionTarget, roomMessageTarget, strategyVerdictTarget, type Draft, type Target } from "../src/lib/corrections";

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
 * card and the quorum with liquidity (the latest decision's decision.liquidity), and since B16 lens B's conditions;
 * effects.level_moves is still null. LATER is the page's own stand-in for the level moves until backends B17-B19
 * publish theirs (the mockup's "all backend PRs deployed" board); it is not a contract. The clock is the fixture's
 * (lens B's state 2 minutes old, the card 13 minutes old).
 */
export const LIQUIDITY_NOW = (liquidity as any).state.at_ms + 2 * 60_000;
export const LATER = {
  effects: { level_moves: [{ at_ms: (liquidity as any).state.at_ms - 3_600_000, side: "BUY", action: "level", outcome: "hit" }] }
};
export const LIQUIDITY_FULL = merged(liquidity, LATER);
/** The B15 fields null: the latest decision has no decision.liquidity (the switch off; lens B off, floored or stale; a decision before B15). */
export const NO_CARD = { card: null, quorum_with_liquidity: null };
const CARD = (liquidity as any).card;
/**
 * Lens B's conditions (B16) in their other shapes, as src/liquidity-lens.mjs liquidityConditions and src/liquidity-view.mjs
 * viewConditions write them: each warning state, unmeasured, an excluded minute in one session, a node at price, the
 * rooms not reading them (lens B off or floored, or LENS_ROOM_LINE brief), stale, and no thresholds (knobs without them).
 */
const COND = (liquidity as any).conditions;
export const COND_WARN = { ...COND, spread: { ...COND.spread, ratio: 2.3, state: "widened" }, depth: { ...COND.depth, vol_pctl_15m: 0.12, state: "thin" }, activity: { ...COND.activity, vol_pctl: 0.97, state: "spike" } };
export const COND_UNMEASURED = { ...COND, spread: { ...COND.spread, ratio: null, state: "unmeasured" }, depth: { ...COND.depth, vol_pctl_15m: null, state: "unmeasured" }, activity: { ...COND.activity, vol_pctl: null, state: "unmeasured" } };
export const COND_EXCLUDED = { ...COND, session: { names: ["London"], overlap: false, liquidity: "normal", excluded: "session_open" }, levels: { inside_node: true, nodes_above: 2, nodes_below: 1, pools_above: 1, pools_below: 0, pools_at: 1 } };
export const COND_OFF = { ...COND, in_rooms: false };
export const COND_BRIEF = { ...COND, in_rooms: false, room_line: "brief" };
export const COND_STALE = { ...COND, at_ms: LIQUIDITY_NOW - 22 * 60_000, stale: true, in_rooms: false };
export const COND_NO_THRESHOLDS = { ...COND, spread: { ...COND.spread, widen: null }, depth: { ...COND.depth, thin_pctl: null }, activity: { ...COND.activity, spike_pctl: null } };
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
  limit_in_zone: ["READY / MANAGING", "adjust", "Limit in the entry zone: the plan&#x27;s level was through price (or inside the stops level); stop and TP1 kept.", "from 2685.32 to 2684.64 · broker"],
  limit_zone_edge: ["READY / MANAGING", "adjust", "Limit at the zone&#x27;s near edge: the plan&#x27;s level is out of the placement band; stop and TP1 kept.", "plan 2685.32 · 0.462R away → edge 2686.02 · 0.307R away · broker"],
  zone_passed: ["NOT ENTERING", "why", "Refused: price already passed the entry zone.", "the entry zone 2684.62-2686.02 is passed · broker"],
  zone_tight: ["NOT ENTERING", "why", "Refused: zone too tight. A limit inside it keeps under half the plan&#x27;s risk.", "a limit at 2684.68 leaves 0.56 of risk to the plan&#x27;s stop, under 0.6 (0.5 x the plan&#x27;s 1.2) · broker"],
  zone_rr: ["NOT ENTERING", "why", "Refused: R:R below the minimum. A limit inside the zone pays under 1R to TP1.", "a limit at 2686.02 pays 0.869 R to the target, under 1 · broker"]
};
export const ez1Code = (code: string) => merged(clone(ez1Overview), { broker: { planner: { codes: [code], details: { [code]: EZ1_DETAILS[code] } } } });
/**
 * Three OM-LEAN fixes kept on the page as before OM-LEAN (#553 reverted): engine_off by which switch is off
 * (broker.engine.env_enabled), and an intent that sets no entry (a modify) with "—" as its Entry, not "Market (Ask)".
 */
const engineOff = (engine: any) => merged(clone(ez1Overview), { broker: { engine, planner: { codes: ["engine_off"], details: {} } } });
export const OMEGA_ENGINE_OFF_SERVER = engineOff({ env_enabled: false, enabled: true });
export const OMEGA_ENGINE_OFF_LOCAL = engineOff({ env_enabled: true, enabled: false });
export const OMEGA_MODIFY_INTENT = merged(clone(ez1Overview), { broker: { intents: [{ id: "i-modify:sl", kind: "modify_sl", side: "BUY", ticket: 4101, sl: 2681.2, created_ms: (ez1Overview as any).broker.intents[0].created_ms, status: "done" }] } });
/**
 * The Omega chart's text (owner 2026-11-23: less cosmetic text on the chart, not a new layout): the chart's overlay and
 * its one scale caption over GET /omega/api/overview (the EZ1 fixture: basis +0.42 known; then the basis unknown). The
 * lines and their labels are drawn on the canvas, which the static render has not got; test/nexus-omega-chart-text.test.mjs
 * pins those.
 */
export const OMEGA_NO_BASIS = merged(clone(ez1Overview), { signal: { feed_basis: 0, feed_basis_known: false } });
export function OmegaChartView({ d }: { d: any }) {
  const br = d?.broker?.bridge ?? {};
  return (
    <Mt5ChartCanvas tf="M15" symbol={br.symbol ?? "XAUUSD"} server={br.server ?? ""} digits={typeof br.digits === "number" ? br.digits : 2} bid={br.bid} ask={br.ask}
      signal={d?.signal ?? null} positions={Array.isArray(br.positions) ? br.positions : []} showBidAsk showPlan showPositions keyZones={[]} showKeyLevels feedBasis={knownFeedBasis(d?.signal)} limit={null} />
  );
}
const OMEGA_CHART_OLD = ["candles, PLAN lines", "(feed ", "basis (intents", "not converted (the basis is unknown)", ">feed<", "broker", "Bid", "Ask", "22 pts", "2684.64"];
const EZ1_ZONE_SHOWS = ["Entry zone", "2684.20–2685.60", "· feed scale", "zone · feed scale", "plan 2684.90", "key zone 2683.60–2686.60", "Omega limit", "not available on this page", "near edge", "2685.60", "feed · allowed", "min 1R · feed scale"];
const EZ1_NEW = ["Entry zone", "zone · feed scale", "Omega limit", "EZ1"];

/**
 * FS1, the Feature switches page (Settings › Feature switches, the owner-reviewed mockup) over GET
 * /omega/api/feature-switches: test/fixtures/nexus-fs1/*.json, the seeded answers of the real registry and store
 * (test/support/nexus-fs1-seed.mjs): the owner's (three overrides), a viewer's (read only), the veto rule's automatic
 * revert, and the POST's replies. The states: the tooltip open, saving, saved (a switch and an Omega setting), each
 * error code, the first load, a failed GET, and each confirm (normal, era, mode evidence, emergency stop, reset).
 */
const FS1_ROW = (key: string, d: any = fs1Owner) => (d as any).switches.find((r: any) => r.key === key);
export const FS1_SAVED_AT = Date.parse("2026-11-25T03:41:00Z");
const fs1Status = (key: string, s: RowStatus) => ({ d }: { d: any }) => <SwitchesView d={d} status={{ [key]: s }} />;
const fs1Unread = (code: string): Poll => ({ data: null, error: code, loading: false, refresh: () => {}, lastOk: null, lastFail: 1, failures: 1, stale: false, intervalMs: 60_000 });
/** One confirm, rendered as the dialog shows it (the row as the varied body). */
const fs1Confirm = (c: (r: any) => Change) => ({ d }: { d: any }) => {
  const r = rowOf(d);
  if (!r) return <p>no row</p>;
  const t = confirmText(r, c(r));
  return <ConfirmDialog options={{ title: t.title, tone: t.tone, confirmLabel: t.confirmLabel, typed: t.typed ?? undefined, body: <ConfirmBody t={t} /> }} onDone={() => {}} />;
};
const FS1_GROUPS = ["Demand and supply zones", "Plans, entries and targets", "Strategy agents and councils", "Trading-mode evidence", "Liquidity lens and calendar", "Knowledge and shadow arms", "Omega engine (owner settings)"];
const FS1_ROW_VIEW = (canControl: boolean, open = false) => ({ d }: { d: any }) => {
  const r = rowOf(d);
  return r ? <SwitchRowView r={r} canControl={canControl} open={open} onTip={() => {}} onChange={() => {}} /> : <p>no row</p>;
};

/**
 * ZN1, the Zones page (Intelligence › Zones, the owner-approved mockup) over GET /api/zones: test/fixtures/nexus-zones/
 * *.json, the seed's real zonesView answers (test/support/nexus-zones-seed.mjs): held (zone_ahead, tp and stop held by the
 * tick of 2026-11-24 07:22 UTC), clear (nothing held), empty (no table yet), off (404) and error (500), with the held
 * state's read-only GET /api/feature-switches for the holds' since and until. ZONES_OWN_TIMES and ZONES_EFFECTIVE are the
 * page's own stand-ins for fields xauusd may add to breaker.held (since, until, effective); they are not a contract.
 */
const ZH = zonesHeld as any;
const heldWith = (extra: Record<string, Record<string, unknown>>) => merged(ZH, { breaker: { held: ZH.breaker.held.map((h: any) => ({ ...h, ...(extra[h.rule] ?? {}) })) } });
export const ZONES_OWN_TIMES = heldWith({ zone_ahead: { since: "2026-11-24T08:00:00.000Z", until: "2026-12-01T08:00:00.000Z" } });
export const ZONES_EFFECTIVE = heldWith({ tp: { effective: false }, stop: { effective: true } });
const zonesUnread = (code: string): Poll => ({ data: null, error: code, loading: false, refresh: () => {}, lastOk: 1, lastFail: 2, failures: 1, stale: false, intervalMs: 120_000 });
const zonesStale: Poll = { data: ZH, error: "/api/zones 500 zones_unavailable", loading: false, refresh: () => {}, lastOk: 1, lastFail: 2, failures: 4, stale: true, intervalMs: 120_000 };
const HELD_SPAN = ["since", "11-24 07:22 UTC · 14:22 GMT+7", "until", "12-01 07:22 UTC · 14:22 GMT+7"];
const ZONES_PANELS = ["Zone breaker", "Readings", "Held back", "Rule arms", "Stances", "Omega attribution"];


/**
 * H3f, the owner's correction control (test/fixtures/nexus-h3f/*.json, the seed's answers of the real Omega route and AI
 * Worker: test/support/nexus-h3f-seed.mjs). The footer slot over each feature-switch read (owner on, owner off, a
 * viewer), the chips after each 200, the popover in every state (Rate, Correct, sending, every error code, the 409 off
 * message, over 500 characters, the phone sheet), and the Call for Councils opinion cards with and without a cited ref.
 */
type H3fReply = { status: number; body: any };
const H3F_REPLIES = h3fReplies as unknown as Record<string, H3fReply>;
export const H3F_ENGINE = engineTarget((ez1Global as any).engine) as Target;
const H3F_ERRORS = Object.entries(H3F_REPLIES).filter(([, r]) => r.status !== 200 && r.status !== 409);
const replyView = (r: any) => replyOf(typeof r?.status === "number" ? r.status : 0, r?.body);
const panelOf = (draft: Draft, phase: Phase, extra: { sheet?: boolean; reply?: any } = {}) => ({ d }: { d: any }) => {
  const r = extra.reply !== undefined ? replyView(d) : null;
  const error = r?.kind === "error" ? errorOf(r.status, r.code) : null;
  return <CorrectionPanel target={H3F_ENGINE} draft={draft} phase={r?.kind === "off" ? "off" : error ? "error" : phase} error={error} sheet={extra.sheet} />;
};
const RATED: Draft = { ...emptyDraft("rate"), rating: "up" };
const CORRECTING: Draft = { tab: "correct", rating: null, category: "invalidation_too_tight", text: "The stop sat inside the noise; it belongs under the sweep low." };
const LONG: Draft = { ...CORRECTING, text: "The stop sat inside the noise of the last swing; it should sit under the sweep low, not above it. ".repeat(6).slice(0, 512) };
/** A host's footer row with the slot at its end (the render check needs markup even when the slot is empty). */
const footer = (gateBody: any, sent: any = null) => (
  <div className="flex flex-wrap items-center gap-2"><span className="eyebrow">1H room</span>
    <CorrectionFooter gate={gateOf(gateBody)} target={H3F_ENGINE} sent={sent} /></div>
);
const opinionView = (gateBody: any, i: number) => ({ d }: { d: any }) => (
  <GateOverride.Provider value={gateOf(gateBody)}><OpinionCard m={d?.messages?.[i] ?? {}} /></GateOverride.Provider>
);
export const H3F_VIEWS: Entry[] = [
  { name: "H3fFooterOwner", View: ({ d }) => footer(d), fixture: h3fOn, shows: ['aria-label="Rate / correct"', 'title="Rate / correct"', 'aria-expanded="false"', "M21 15a2 2 0 0 1-2 2H7l-4 4V5"], hides: ["Sent to the platform"] },
  { name: "H3fFooterOff", View: ({ d }) => footer(d), fixture: h3fOff, shows: ["1H room"], hides: ["Rate / correct"] },
  { name: "H3fFooterViewer", View: ({ d }) => footer(d), fixture: h3fViewer, shows: ["1H room"], hides: ["Rate / correct"] },
  { name: "H3fControlOwner", View: ({ d }) => <GateOverride.Provider value={gateOf(d)}><CorrectionControl target={H3F_ENGINE} /></GateOverride.Provider>, fixture: h3fOn, shows: ['aria-label="Rate / correct"'], hides: ['role="dialog"'] },
  { name: "H3fControlNoTarget", View: ({ d }) => <div>host<GateOverride.Provider value={gateOf(d)}><CorrectionControl target={null} /></GateOverride.Provider></div>, fixture: h3fOn, hides: ["Rate / correct"] },
  ...(["rated", "deduplicated", "price", "secret", "secret_price"] as const).map((k) => ({
    name: `H3fChips_${k}`, View: ({ d }: { d: any }) => { const r = replyView(d); return footer(h3fOn, r.kind === "sent" ? r.sent : null); }, fixture: H3F_REPLIES[k],
    shows: [k === "deduplicated" ? "Already recorded" : "Sent to the platform&#x27;s teaching record", ...(k === "price" || k === "secret_price" ? ["prices masked"] : []), ...(k === "secret" || k === "secret_price" ? ["secret removed"] : []), `title="${H3F_REPLIES[k].body.correction_id}"`],
    hides: [...(k === "deduplicated" ? ["Sent to the platform"] : ["Already recorded"]), ...(k === "rated" || k === "deduplicated" ? ["prices masked", "secret removed"] : [])]
  })),
  { name: "H3fPanelRate", View: panelOf(emptyDraft("rate"), "idle"), fixture: H3F_ENGINE, shows: ["Rate or correct this output", "nexus_engine", "ev:xauusd/engine_decisions/OANDA:XAUUSD:15:1795096800000", "agent:council", "2026-11-19 14:00 UTC · 21:00 GMT+7", "Category, optional", "Send rating", 'disabled=""'], hides: ["What was wrong", 'role="alert"'] },
  { name: "H3fPanelRateUp", View: panelOf(RATED, "idle"), fixture: H3F_ENGINE, shows: ['aria-pressed="true"', "border-ok-fill/50 bg-ok-fill/14 text-ok", "Send rating"], hides: ["bull", "green"] },
  { name: "H3fPanelRateDown", View: panelOf({ ...RATED, rating: "down" }, "idle"), fixture: H3F_ENGINE, shows: ["border-off-fill/55 bg-off-fill/16"], hides: ["bear", "red-"] },
  { name: "H3fPanelCorrect", View: panelOf(CORRECTING, "idle"), fixture: H3F_ENGINE, shows: ["What was wrong", "Prices are masked as [level].", "62/500", "Rating, optional", "Send correction", "Describe the level, do not type it", "Invalidation too tight"], hides: ["Over 500 characters"] },
  { name: "H3fPanelSending", View: panelOf(RATED, "sending"), fixture: H3F_ENGINE, shows: ["Sending…", 'disabled=""'] },
  { name: "H3fPanelOver500", View: panelOf(LONG, "idle"), fixture: H3F_ENGINE, shows: ["512/500", "Over 500 characters: shorten to send.", "text-fault", 'aria-invalid="true"'] },
  { name: "H3fPanelSheet", View: panelOf({ ...CORRECTING, category: "evidence_missing", text: "" }, "idle", { sheet: true }), fixture: H3F_ENGINE, shows: ["rounded-t-[16px]", "h-[44px]", "flex-1", "Send correction"] },
  { name: "H3fPanelSheetRate", View: panelOf(RATED, "idle", { sheet: true }), fixture: H3F_ENGINE, shows: ["rounded-t-[16px]", "Send rating"] },
  { name: "H3fPanelOff", View: panelOf(emptyDraft("rate"), "idle", { reply: true }), fixture: H3F_REPLIES.disabled, shows: ["409 disabled", "Owner corrections are off. Turn them on in", 'href="/#/switches"', "Settings › Feature switches"], hides: ["Send rating"] },
  ...H3F_ERRORS.map(([k, r]) => ({
    name: `H3fError_${k}`, View: panelOf(k.includes("category") || k === "empty" || k.includes("text") || k === "body_too_large" ? CORRECTING : RATED, "idle", { reply: true }), fixture: r,
    shows: ['role="alert"', `${r.status} ${String(r.body.error).replace(/'/g, "&#x27;")}`, errorOf(r.status, r.body.error).words.replace(/'/g, "&#x27;"), ...(r.status === 429 ? ["border-late-fill/35"] : ["border-fault-fill/35"])]
  })),
  { name: "H3fCouncilOwnerCited", View: opinionView(h3fOn, 0), fixture: h3fSession, shows: ["Risk Manager", "evidence (2)", 'aria-label="Rate / correct"'] },
  { name: "H3fCouncilOwnerOwnRef", View: opinionView(h3fOn, 1), fixture: h3fSession, shows: ["Technical Analyst", "evidence (1)", 'aria-label="Rate / correct"'] },
  { name: "H3fCouncilOwnerNoCited", View: opinionView(h3fOn, 2), fixture: h3fSession, shows: ["Projection Agent", 'aria-label="Rate / correct"'], hides: ["evidence ("] },
  { name: "H3fCouncilOwnerMessage", View: opinionView(h3fOn, 3), fixture: h3fSession, shows: ["You", "Which setups were stopped"], hides: ["Rate / correct"] },
  { name: "H3fCouncilViewer", View: opinionView(h3fViewer, 0), fixture: h3fSession, shows: ["Risk Manager", "evidence (2)"], hides: ["Rate / correct"] },
  { name: "H3fCouncilOff", View: opinionView(h3fOff, 0), fixture: h3fSession, shows: ["Risk Manager"], hides: ["Rate / correct"] },
  { name: "H3fCouncilOptions", View: ({ d }) => <div>options<CorrectionFooter gate={gateOf(h3fOn)} target={councilOptionsTarget(d)} sent={null} className={ROW} /></div>, fixture: h3fSession, shows: ['aria-label="Rate / correct"', "justify-end"] },
  ...([["On", h3fOn, true], ["Viewer", h3fViewer, false], ["Off", h3fOff, false]] as const).flatMap(([k, gate, shown]) => [
    { name: `H3fRoomConclusion${k}`, View: ({ d }: { d: any }) => (
      <GateOverride.Provider value={gateOf(gate)}><ConclusionHero c={d?.room?.conclusion} title="15m War Room" waiting="No conclusion this round."
        correction={<CorrectionControl target={roomConclusionTarget(d?.room, "M15")} className={`mt-[12px] ${ROW}`} />} /></GateOverride.Provider>), fixture: h3fWar,
      shows: ["The room leans short", ...(shown ? ['aria-label="Rate / correct"'] : [])], hides: shown ? [] : ["Rate / correct"] },
    { name: `H3fRoomPosts${k}`, View: ({ d }: { d: any }) => (
      <GateOverride.Provider value={gateOf(gate)}>{[...(d?.room?.openings ?? []), ...(d?.room?.debate ?? [])].filter(Boolean).map((m: any, i: number) => (
        <Post key={i} m={m} text={m?.claim ?? m?.argument} correction={<CorrectionControl target={roomMessageTarget(m, d?.room)} />} />))}</GateOverride.Provider>), fixture: h3fWar,
      shows: ["lower high under the session open", ...(shown ? ['aria-label="Rate / correct"'] : [])], hides: shown ? [] : ["Rate / correct"] },
    { name: `H3fVerdict${k}`, View: ({ d }: { d: any }) => <GateOverride.Provider value={gateOf(gate)}><VerdictLine v={d?.verdicts?.zone_pullback} id="zone_pullback" /></GateOverride.Provider>, fixture: h3fVerdicts,
      shows: ["walk-forward pass", ...(shown ? ['aria-label="Rate / correct"'] : [])], hides: shown ? [] : ["Rate / correct"] }
  ]),
  { name: "H3fRoomH1Conclusion", View: ({ d }) => <GateOverride.Provider value={gateOf(h3fOn)}><ConclusionHero c={d?.thread?.conclusion} title="1H War Room" waiting="No conclusion this round."
    correction={<CorrectionControl target={roomConclusionTarget(d?.thread, "H1")} className={`mt-[12px] ${ROW}`} />} /></GateOverride.Provider>, fixture: h3fH1, shows: ['aria-label="Rate / correct"'] }
];

/**
 * C5, the Position Manager lines on the Omega page (test/fixtures/nexus-pm-lines/*.json, the seed's answers of the real
 * readPositionManager, pmLineBreakerTick, setPmLine and the Omega Worker's POST route: test/support/nexus-pm-lines-seed.mjs).
 * Every state of the block: all on, one off by its breaker (owner and viewer), off by the switch only and by both (the
 * button's refusal "also off by the switch"), no closes yet, after the owner's turn-on, the AI Worker's failed read, a
 * failed GET, the confirm box, sending, and each code the POST answers. R is neutral: no bull or bear class anywhere.
 */
type PmReply = { status: number; body: any };
const PM_REPLIES = pmReplies as unknown as Record<string, PmReply>;
const pmView = (props: Partial<PmLinesProps> = {}) => ({ d }: { d: any }) => <PmLinesView d={d} canControl {...props} />;
const pmRefused = ({ d }: { d: any }) => {
  const r = replyResult(Number(d?.status) || 0, d?.body);
  return <PmLinesView d={pmOff} canControl open="pm_fast_cut" error={r.ok ? null : r.error} />;
};
const PM_NO_DIRECTION = ["text-bull", "text-bear", "emerald", "rose-"];
const PM_OFF_SINCE = "off since Mon 23 Nov 16:35 UTC · 23:35 GMT+7";
const pmUnread = (code: string): Poll => ({ data: null, error: code, loading: false, refresh: () => {}, lastOk: null, lastFail: 1, failures: 1, stale: false, intervalMs: 60_000 });
export const PM_VIEWS: Entry[] = [
  { name: "PmLinesAllOn", View: pmView(), fixture: pmOn,
    shows: ["Position Manager lines", "take_profit_weakening", "@1", "Last 15", "vs hold", "Closes", "+0.31R", "+0.12R", "−0.38R", "+0.21R", "+1.12R", "−0.06R", ">23<", ">41<", "text-ok", "tp_further_key_level_beyond"],
    hides: ["Turn back on", "text-fault", "off since", "off by the", ...PM_NO_DIRECTION] },
  { name: "PmLinesBreakerOff", View: pmView(), fixture: pmOff, shows: ["pm_fast_cut", "text-fault", ">off<", "−0.29R", "−0.11R", PM_OFF_SINCE, "Turn back on"], hides: ["off by the", "Refused", ...PM_NO_DIRECTION] },
  { name: "PmLinesBreakerOffViewer", View: pmView({ canControl: false }), fixture: pmOff, shows: [PM_OFF_SINCE, ">off<"], hides: ["Turn back on", "<button"] },
  { name: "PmLinesSwitchOff", View: pmView(), fixture: pmHandOff, shows: ["tp2_target", "off by the", 'href="/#/switches"', ">switch<", PM_OFF_SINCE, "Turn back on"], hides: ["Refused", ...PM_NO_DIRECTION] },
  { name: "PmLinesSwitchOffOnly", View: pmView(), fixture: { ...pmHandOff, lines: (pmHandOff as any).lines.filter((l: any) => l.id !== "pm_fast_cut") }, shows: ["off by the", 'href="/#/switches"'], hides: ["Turn back on", "off since"] },
  { name: "PmLinesAlsoOffBySwitch", View: pmView({ open: "pm_fast_cut", error: (replyResult(PM_REPLIES.off_by_PM_LINES_OFF.status, PM_REPLIES.off_by_PM_LINES_OFF.body) as any).error }), fixture: pmHandOff,
    shows: ["Refused: off_by_PM_LINES_OFF", "also off by the", 'role="alert"', 'href="/#/switches"', "Confirm"], hides: ["@1 back on."] },
  { name: "PmLinesNoClosesYet", View: pmView(), fixture: pmNew, shows: ["take_profit_weakening", "—", ">0<", "text-ok"], hides: ["R<", "Turn back on", "text-fault"] },
  { name: "PmLinesAfterTurnOn", View: pmView({ done: "pm_fast_cut@1" }), fixture: pmAfterOn, shows: ["pm_fast_cut@1 back on.", "+0.31R"], hides: ["off since", "Turn back on", "text-fault"] },
  { name: "PmLinesConfirm", View: pmView({ open: "pm_fast_cut" }), fixture: pmOff, shows: ["glass-inner", "back on?", "pm_fast_cut@1", "Confirm", "Cancel", PM_OFF_SINCE], hides: ["Turn back on", "Sending…", "Refused"] },
  { name: "PmLinesSending", View: pmView({ open: "pm_fast_cut", phase: "sending" }), fixture: pmOff, shows: ["Sending…", 'disabled=""', "Cancel"], hides: ["Confirm<", "Refused"] },
  ...Object.keys(PM_REPLIES).filter((k) => k !== "ok" && k !== "off_by_PM_LINES_OFF").map((k) => ({
    name: `PmLinesRefused_${k}`, View: pmRefused, fixture: PM_REPLIES[k], shows: ["Refused: ", 'role="alert"', "Confirm", PM_OFF_SINCE], hides: ["@1 back on."]
  })),
  { name: "PmLinesRefusedNoBody", View: pmRefused, fixture: { status: 503, body: {} }, shows: ["Refused: HTTP 503", "nothing changed."] },
  { name: "PmLinesRefusedNetwork", View: ({ d }) => <PmLinesView d={pmOff} canControl open="pm_fast_cut" error={String(d?.error ?? "network")} />, fixture: { error: "network" }, shows: ["Refused: network", "no answer from Omega. Nothing changed."] },
  { name: "PmLinesOkReply", View: ({ d }) => { const r = replyResult(Number(d?.status) || 0, d?.body); return <PmLinesView d={pmAfterOn} canControl done={r.ok ? "pm_fast_cut@1" : null} />; }, fixture: PM_REPLIES.ok, shows: ["pm_fast_cut@1 back on."] },
  { name: "PmLinesReadFailed", View: pmView(), fixture: pmError, shows: ["/api/omega/position-manager read failed: D1_ERROR: the database is unavailable", "last ok"], hides: ["Last 15", "No lines yet"] },
  { name: "PmLinesNoLines", View: pmView(), fixture: { status: "ok", lines: [] }, shows: ["No lines yet", "The route sent no Position Manager lines."], hides: ["Last 15"] },
  { name: "PmLinesUnread", View: ({ d }) => <PmLinesFrame><PollError poll={pmUnread(`/api/omega/position-manager 500 ${typeof d?.error === "string" ? d.error : "read failed"}`)} /></PmLinesFrame>, fixture: { error: "internal_error" },
    shows: ["Position Manager lines", "/api/omega/position-manager 500 internal_error", "retry 60s", "Retry now"] },
  { name: "PmLinesLoading", View: () => <PmLinesLoading />, fixture: pmOn, shows: ["Position Manager lines", "animate-pulse"], hides: ["Last 15"] }
];

export const VIEWS: Entry[] = [
  {
    name: "ZonesHeld", View: ({ d }) => <ZonesView d={d} switches={zonesSwitches} />, fixture: zonesHeld,
    shows: [...ZONES_PANELS, ...HELD_SPAN, "Zones", "Intelligence · Z5 · demand and supply zones", "zone readings on", "cryptophys.zones-view.v1", "03:40 UTC · 10:40 GMT+7",
      "checked 11-24 07:22 UTC · 14:22 GMT+7", "Feature switches", "href=\"/#/switches\"", "bg-late-fill", ">clear<", "no hold", "rule:tp_typed", "rule:stop_skip", ">block<",
      "edge +0.059", "own 43% n153 · untyped 37% n86", "+0.15R", "+0.10R vs +0.30R", "+0.05R vs +0.20R", "tripped", "Rule version tp1_kz:on+zone_ahead@1.",
      "30 days · prior 20", "▲</span> demand", "▼</span> supply", "untyped", "from_above", "All readings", ">245<", ">40%<", ">0.62<", ">0.51<", "aria-sort=\"ascending\"",
      "▲ BUY", "▼ SELL", "−0.15R", "75%", "100%", "−0.1 · 0 · +0.4R", "−0.20R", "7 days · 672 decisions", "WAIT", ">24<",
      "intent:level_source_zone", "pm:zone_trail", "−0.009R", "−0.017R", ">advisory<", ">16<", NO_EFFECT_NOTE],
    hides: ["no breaker tick yet", ">0 readings · ", ">0 resolved · ", "sample", "price", "feed scale", "broker scale", "also seen by"],
    missing: [zonesOffBody]
  },
  { name: "ZonesHeldNoSwitches", View: ({ d }) => <ZonesView d={d} switches={null} />, fixture: zonesLegacy, shows: ["bg-late-fill", "rule:tp_typed"], hides: [">since<", ">until<"] },
  { name: "ZonesHeldOwnTimesNoSwitches", View: ({ d }) => <ZonesView d={d} switches={null} />, fixture: zonesHeld, shows: ["bg-late-fill", "rule:tp_typed", ">since<", ">until<"] },
  { name: "ZonesHeldOwnTimes", View: ({ d }) => <ZonesView d={d} switches={zonesSwitches} />, fixture: ZONES_OWN_TIMES, shows: ["11-24 08:00 UTC · 15:00 GMT+7", "12-01 08:00 UTC · 15:00 GMT+7", "12-01 07:22 UTC · 14:22 GMT+7"] },
  { name: "ZonesEffective", View: ({ d }) => <ZonesView d={d} switches={zonesSwitches} />, fixture: ZONES_EFFECTIVE, shows: [`Held: tp joins ZONE_AIM_OFF for the run while Z2b has it on. ${NO_EFFECT_NOTE}`], hides: [`Held: stop joins ZONE_AIM_OFF for the run while Z2b has it on. ${NO_EFFECT_NOTE}`] },
  { name: "ZonesClear", View: ({ d }) => <ZonesView d={d} switches={null} />, fixture: zonesClear,
    shows: [">clear<", "no hold", "n &lt; 30", "— vs —", "n0", "edge +0.059", "0 resolved · 30 days", "Fills once zone_ahead holds a decision back and its setup resolves.", "Fills while a Z2b rule (tp, stop) is on and its plans resolve.", "0 zone-attributed closes · 30 days", "no advisory"],
    hides: ["bg-late-fill", ">tripped<", ">since<"] },
  { name: "ZonesEmpty", View: ({ d }) => <ZonesView d={d} switches={null} />, fixture: zonesEmpty,
    shows: [...ZONES_PANELS, "zone readings on", "no breaker tick yet", "The breaker ticks hourly once ZONE_READINGS is on.", "0 readings · 30 days", "Readings arrive once a decision&#x27;s 8 closed 15m bars are in.",
      "0 decisions · 7 days", "Fills from the Decision Engine&#x27;s records.", "0 zone-attributed closes · 30 days", "Fills when Omega closes a trade a zone placed or managed.", "no advisory"],
    hides: ["Checks", "All readings", "checked "] },
  { name: "ZonesOff", View: ZonesView, fixture: zonesOffBody, shows: ["Zones", "zone readings off", "ZONE_READINGS off · nothing recorded, no hold reaches a decision", "/api/zones 404 · zone_readings_off", "Feature switches", "href=\"/#/switches\""], hides: ["zone readings on", "Zone breaker"] },
  { name: "ZonesUnread500", View: ({ d }) => <ZonesUnread poll={zonesUnread(`/api/zones 500 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: zonesErrorBody, shows: ["/api/zones 500 zones_unavailable", "retry 2m", "last ok", "Retry now", "zone readings on"] },
  { name: "ZonesUnread502", View: ({ d }) => <ZonesUnread poll={zonesUnread(`/api/zones 502 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { error: "proxy_failed" }, shows: ["/api/zones 502 proxy_failed", "Retry now"], hides: ["zone readings on"] },
  { name: "ZonesStale", View: ({ d }) => <ZonesView d={d} switches={zonesSwitches} poll={zonesStale} />, fixture: zonesHeld, shows: ["stale", "Retry now", "Zone breaker", "rule:tp_typed"] },
  { name: "ZonesLoading", View: () => <ZonesLoading />, fixture: zonesHeld, shows: ["Zones", "animate-pulse"], hides: ["zone readings"] },
  { name: "ZonesSortedByN", View: ({ d }) => <ZonesView d={d} initialSort={{ key: "n", dir: "desc" }} />, fixture: zonesHeld, shows: ["aria-sort=\"descending\"", "All readings"] },
  // The breaker and the switches' body as the varied body, so each of their paths is nulled (the page's variants are capped).
  { name: "ZonesBreaker", View: ({ d }) => <BreakerPanel b={breakerOf({ breaker: d }, zonesSwitches)} />, fixture: ZH.breaker, shows: [...HELD_SPAN, "rule:stop_skip", "tripped"] },
  { name: "ZonesSwitches", View: ({ d }) => <ZonesView d={zonesHeld} switches={d} />, fixture: zonesSwitches, shows: [...HELD_SPAN] },

  {
    name: "FS1Owner", View: SwitchesView, fixture: fs1Owner,
    shows: [...FS1_GROUPS, "Feature switches", "Settings · owner", "3 overrides", "as of 03:40 UTC · 10:40 GMT+7", "omega_settings", "role=\"switch\"", "aria-pressed=\"true\"",
      "Reset to config: ENTRY_ZONE_MODE", "Reset to config: CFC_MODE", "Reset to default: change_thresholds", "ZONE_SOURCES_OFF", "LIQUIDITY_WITNESS", "LENS_ROOM_LINE", "CALENDAR_CONTRARIAN",
      "aria-label=\"Emergency stop\"", ">era<", ">ev<", "2026-11-25 02:14 UTC · 09:14 GMT+7", "deploy (wrangler.jsonc)", "OMEGA_DEFAULTS"],
    hides: ["read only", "sample", "provisional", "owner@", ".com", "Reset to config: METRIC_REBUTTAL", "Reset to config: ZONE_PRIORITY", "bull"]
  },
  {
    name: "FS1Viewer", View: SwitchesView, fixture: fs1Viewer,
    shows: [...FS1_GROUPS, "Settings · viewer", "read only", "as of 03:40 UTC · 10:40 GMT+7", "none on", "conf,tpw,limit,skip", "prophet_zone,prophet_best,whale,gabfx,gmi_flag"],
    hides: ["role=\"switch\"", "aria-pressed", "Reset to", "overrides"]
  },
  { name: "FS1Revert", View: SwitchesView, fixture: fs1Revert, shows: ["Automatic revert to classic: since 2026-11-24 08:00 UTC · 15:00 GMT+7, until 2026-12-01 08:00 UTC · 15:00 GMT+7."] },
  { name: "FS1ConfigOnly", View: ({ d }) => <SwitchesView d={d} open="ZONE_AHEAD_MODE" />, fixture: fs1Record,
    shows: ["record is set in the config (wrangler.jsonc) and cannot be set here; the panel sets trend or all.", "Set in the config; not settable here"], hides: ["aria-pressed=\"true\">trend<"] },
  { name: "FS1SavedNote", View: ({ d }) => <SwitchesView d={d} open="ENTRY_ZONE_MODE" status={{ ENTRY_ZONE_MODE: { phase: "saved", at: FS1_SAVED_AT, changed: true, era: false } }} />, fixture: fs1Owner, shows: ["Takes effect within ~30 s."] },
  // Z5: the zone breaker's holds (feature-switches-hold.json, its real tick): the held mark, one tooltip line per hold.
  { name: "FS1ZoneHold", View: ({ d }) => <SwitchesView d={d} open="ZONE_AHEAD_MODE" />, fixture: fs1Hold,
    shows: [">held<", "Held by the zone breaker since 2026-11-24 07:22 UTC · 14:22 GMT+7 until 2026-12-01 07:22 UTC · 14:22 GMT+7 (block): your setting is unchanged."] },
  { name: "FS1ZoneHoldTokens", View: ({ d }) => <SwitchesView d={d} open="ZONE_AIM_OFF" />, fixture: fs1Hold,
    shows: ["tp held by the zone breaker since 2026-11-24 07:22 UTC · 14:22 GMT+7 until 2026-12-01 07:22 UTC · 14:22 GMT+7 (rule:tp_typed): your setting is unchanged.", "stop held by the zone breaker since", "(rule:stop_skip)"],
    hides: ["factor held by"] },
  { name: "FS1RowZoneHold", View: FS1_ROW_VIEW(true, true), fixture: FS1_ROW("ZONE_AIM_OFF", fs1Hold), shows: ["Zone aims", ">held<", "tp held by the zone breaker"] },
  { name: "FS1RowZoneHoldSingle", View: FS1_ROW_VIEW(true, true), fixture: FS1_ROW("ZONE_AHEAD_MODE", fs1Hold), shows: [">held<", "Held by the zone breaker since"] },
  { name: "FS1TipOpen", View: ({ d }) => <SwitchesView d={d} open="CFC_MODE" />, fixture: fs1Owner, shows: ["aria-expanded=\"true\"", "aria-describedby=\"fs-tip-CFC_MODE\"", "2026-11-24 22:05 UTC · 05:05 GMT+7"] },
  { name: "FS1Saving", View: fs1Status("ENTRY_ZONE_MODE", { phase: "saving" }), fixture: fs1Owner, shows: ["saving…", "aria-busy=\"true\""] },
  { name: "FS1Saved", View: fs1Status("ENTRY_ZONE_MODE", { phase: "saved", at: FS1_SAVED_AT, changed: true, era: false }), fixture: fs1Owner, shows: ["saved", "03:41 UTC · 10:41 GMT+7 · owner"], hides: ["· new parity era"] },
  { name: "FS1SavedUnchanged", View: fs1Status("ENTRY_ZONE_MODE", { phase: "saved", at: FS1_SAVED_AT, changed: false, era: false }), fixture: fs1Owner, shows: ["no change"] },
  { name: "FS1SavedOmega", View: fs1Status("change_thresholds", { phase: "saved", at: FS1_SAVED_AT, changed: true, era: true }), fixture: fs1Owner, shows: ["saved", "03:41 UTC · 10:41 GMT+7 · owner · new parity era"] },
  ...POST_ERRORS.map((code) => ({ name: `FS1Failed_${code}`, View: fs1Status("ENTRY_ZONE_MODE", { phase: "failed", error: code }), fixture: fs1Owner, shows: [code, "role=\"alert\""] })),
  { name: "FS1FailedReply", View: ({ d }: { d: any }) => <SwitchesView d={fs1Owner} status={{ ENTRY_ZONE_MODE: { phase: "failed", error: String(d?.error ?? "read failed") } }} />, fixture: (fs1Replies as any).invalid_value, shows: ["invalid_value", "allowed: edge, on, off."] },
  { name: "FS1Loading", View: () => <SwitchesLoading />, fixture: fs1Owner, shows: ["Feature switches", "animate-pulse"] },
  { name: "FS1GetError", View: ({ d }) => <PollError poll={fs1Unread(`/omega/api/feature-switches 502 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { error: "feature_switches_failed" }, shows: ["/omega/api/feature-switches 502 feature_switches_failed", "Retry now"] },
  { name: "FS1ConfirmNormal", View: fs1Confirm(() => ({ value: "off" })), fixture: FS1_ROW("CHART_PATTERNS_MODE"), shows: ["Turn chart patterns off?", "CHART_PATTERNS_MODE: on → off", "Turn off"], hides: ["Starts a new parity era.", "Restarts mode evidence.", "Type the key to confirm"] },
  { name: "FS1ConfirmEra", View: fs1Confirm(() => ({ value: "off" })), fixture: FS1_ROW("reentry_1m"), shows: ["Turn 1m re-entry after a lock stop off?", "reentry_1m: on → off", "Starts a new parity era."] },
  { name: "FS1ConfirmEv", View: fs1Confirm(() => ({ value: "all" })), fixture: FS1_ROW("ZONE_AHEAD_MODE"), shows: ["Set zone-ahead check to all?", "ZONE_AHEAD_MODE: trend → all", "Restarts mode evidence.", "Set"] },
  { name: "FS1ConfirmEmergency", View: fs1Confirm(() => ({ value: "off" })), fixture: FS1_ROW("KEY_LEVEL_ZONE_TYPES"), shows: ["Turn typed key-level zones off?", "KEY_LEVEL_ZONE_TYPES: on → off", "Restarts mode evidence.", "Type the key to confirm", "disabled=\"\""] },
  { name: "FS1ConfirmReset", View: fs1Confirm(() => ({ reset: true })), fixture: FS1_ROW("ENTRY_ZONE_MODE"), shows: ["Reset entry zone to config?", "ENTRY_ZONE_MODE: on → edge", "Reset"] },
  { name: "FS1ConfirmTokens", View: fs1Confirm(() => ({ value: ["tp"] })), fixture: FS1_ROW("ZONE_AIM_OFF"), shows: ["Change zone aims?", "ZONE_AIM_OFF: none → tp", "Save"] },
  // One row as the varied body, so each of its paths is nulled (the page's variants are capped).
  { name: "FS1RowOwner", View: FS1_ROW_VIEW(true), fixture: FS1_ROW("ENTRY_ZONE_MODE"), shows: ["Entry zone", "Reset to config: ENTRY_ZONE_MODE"] },
  { name: "FS1RowTokens", View: FS1_ROW_VIEW(true, true), fixture: FS1_ROW("ZONE_SOURCES_OFF"), shows: ["Zone typing sources", "prophet_zone", "aria-expanded=\"true\""] },
  { name: "FS1RowOmega", View: FS1_ROW_VIEW(true, true), fixture: FS1_ROW("change_thresholds"), shows: ["Change thresholds", "Reset to default: change_thresholds", "2026-11-24 14:30 UTC · 21:30 GMT+7", "An Omega setting"] },
  { name: "FS1RowReadOnly", View: FS1_ROW_VIEW(true, true), fixture: FS1_ROW("METRIC_REBUTTAL"), shows: ["Metric rebuttals", "Read only: shown for information"], hides: ["role=\"switch\""] },
  { name: "FS1RowVeto", View: FS1_ROW_VIEW(false, true), fixture: FS1_ROW("AGENT_VETO_RULE", fs1Revert), shows: ["Strategy-agent veto rule", "Automatic revert to classic"] },

  { name: "EZ1DecisionEngineOn", View: DecisionPlanView, fixture: ez1Global, shows: EZ1_ZONE_SHOWS, hides: ["stale"] },
  { name: "EZ1DecisionStale", View: ({ d }) => <DecisionPlanView d={d} suffix=" · stale 12m" />, fixture: ez1Global, shows: ["Entry zone", "2684.20–2685.60", "· stale 12m"] },
  { name: "EZ1DecisionEngineOff", View: DecisionPlanView, fixture: EZ1_ENGINE_OFF, shows: ["Entry zone", "2684.30–2685.50", "plan 2684.90", "Omega limit"], hides: ["2684.20–2685.60", "EZ1b"] },
  { name: "EZ1DecisionNoZone", View: DecisionPlanView, fixture: EZ1_NO_ZONE, shows: ["2684.90", "min 1R · feed scale"], hides: EZ1_NEW },
  { name: "EZ1OmegaSignal", View: OmegaSignalView, fixture: ez1Overview, shows: ["2684.900", "2684.200–2685.600", "EZ1b · entry_zone_edge", "+0.420", "broker − feed", "14:00:00 UTC · 21:00 GMT+7", "21:07 GMT+7", "in zone · from 2685.32", "near edge · from 2685.32", "zone 2684.62–2686.02"] },
  { name: "EZ1OmegaSignalNoZone", View: OmegaSignalView, fixture: withoutZone(ez1Overview), shows: ["2684.900"], hides: ["Entry zone", "Near edge"] },
  ...Object.keys(EZ1_DETAILS).map((code) => ({ name: `EZ1OmegaWhy_${code}`, View: OmegaSignalView, fixture: ez1Code(code), shows: EZ1_CODE_SHOWS[code] })),
  { name: "OmegaWhyEngineOffServer", View: OmegaSignalView, fixture: OMEGA_ENGINE_OFF_SERVER, shows: ["NOT ENTERING", "The server switch is off (OMEGA_ENGINE_ENABLED). Only the Worker setting turns it on.", "engine_off"], hides: ["Turn it on with Algo Trading"] },
  { name: "OmegaWhyEngineOffLocal", View: OmegaSignalView, fixture: OMEGA_ENGINE_OFF_LOCAL, shows: ["NOT ENTERING", "The engine is switched off. Turn it on with Algo Trading, or in Setup (Engine enabled).", "engine_off"], hides: ["OMEGA_ENGINE_ENABLED"] },
  { name: "OmegaChartCaption", View: OmegaChartView, fixture: ez1Overview, shows: ["prices: feed · MT5 +0.42", "Charts by TradingView", "XAUUSD, M15"], hides: [...OMEGA_CHART_OLD, "not converted"] },
  { name: "OmegaChartCaptionNoBasis", View: OmegaChartView, fixture: OMEGA_NO_BASIS, shows: ["prices: feed · MT5 lines not converted", "Charts by TradingView"], hides: [...OMEGA_CHART_OLD, "MT5 +"] },
  { name: "OmegaModifyIntent", View: OmegaSignalView, fixture: OMEGA_MODIFY_INTENT, shows: ["modify_sl", "SL 2681.20 · broker"], hides: ["Market (Ask)", "market"] },
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
  // Lens B's conditions (B16) in the Facts panel; the conditions as the varied body, so each of their paths is nulled.
  { name: "LiquidityViewConditions", View: ({ d }) => <LiquidityView d={{ ...(liquidity as any), conditions: d }} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: COND,
    shows: ["Spread normal · 1.1× typical", "Depth normal · p41", "Activity normal · p62", "London + New York overlap · liquidity high", "outside a high-volume node · 0 nodes above, 1 below · pools 1 above, 0 below, 0 at price", "intraday mode · baseline insufficient, 2 of 4 weeks", "14:58 UTC", "What the rooms read", "Spread 2× (widened)", "Spread above 2×", "Spike, 95th or more", "Thin, 20th or less", "thresholds of the intraday mode"],
    hides: ["No conditions yet", "stale", "tick volume 62nd", "The rooms are not reading"] },
  { name: "LiquidityViewNoConditions", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: null }, shows: ["No conditions yet", "The AI Worker gives none while lens B has no available facts.", "tick volume 62nd", "as lens B flags them in the intraday mode"], hides: ["What the rooms read", "thresholds of the", "Spread 2×"] },
  { name: "LiquidityViewConditionsWarn", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_WARN }, shows: ["Spread widened · 2.3× typical", "Depth thin · p12", "Activity spike · p97"] },
  { name: "LiquidityViewConditionsUnmeasured", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_UNMEASURED }, shows: ["Spread unmeasured", "Depth unmeasured", "Activity unmeasured"] },
  { name: "LiquidityViewConditionsExcluded", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_EXCLUDED }, shows: ["London · liquidity normal · minute excluded from the baseline (session open)", "inside a high-volume node · 2 nodes above, 1 below · pools 1 above, 0 below, 1 at price"] },
  { name: "LiquidityViewConditionsOff", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_OFF }, shows: ["The rooms are not reading these now: lens B is off or at its floor, or its state is older than 15 minutes."], hides: ["What the rooms read"] },
  { name: "LiquidityViewConditionsBrief", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_BRIEF }, shows: ["The rooms read only lens B&#x27;s brief line, not these conditions (LENS_ROOM_LINE brief)."], hides: ["What the rooms read"] },
  { name: "LiquidityViewConditionsStale", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_STALE }, shows: ["stale 22m", "14:38 UTC"] },
  { name: "LiquidityViewConditionsNoThresholds", View: ({ d }: { d: any }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), conditions: COND_NO_THRESHOLDS }, shows: ["Spread widened", "Volume spike", "as lens B flags them in the intraday mode"], hides: ["thresholds of the", "Spread 2×", "95th or more", "20th or less"] },
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
  { name: "LiquidityViewDecision", View: ({ d }) => <LiquidityView d={LIQUIDITY_FULL} lens={lens} decision={d} now={LIQUIDITY_NOW} />, fixture: decision, shows: ["Quorum", "WAIT"] },
  ...PM_VIEWS,
  ...H3F_VIEWS
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
