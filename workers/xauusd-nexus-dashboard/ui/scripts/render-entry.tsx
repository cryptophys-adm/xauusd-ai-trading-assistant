// The page render check's registry (scripts/render-check.mjs bundles this file with esbuild as CommonJS, lightweight-charts
// aliased to scripts/lw-stub.mjs). Each entry is a pure, null-safe view with the fixture of its route: the check renders
// it with renderToStaticMarkup over the fixture, the routes' not_found bodies, each path nulled in turn and each array
// emptied, and fails on a throw, "NaN", "undefined" or "[object Object]" in the markup. A page that joins Intelligence
// (Track C) adds its view and its test/fixtures/nexus-intel/*.json here (C2: the Liquidity page's LiquidityView; C3: the
// Chart patterns page's PatternsView; ZN1: the Zones page's ZonesView over test/fixtures/nexus-zones/*.json; C4: the
// Opening range page's OrbView over orb*.json).
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import lens from "../../../../test/fixtures/nexus-intel/lens.json";
import liquidity from "../../../../test/fixtures/nexus-intel/liquidity.json";
import unavailable from "../../../../test/fixtures/nexus-intel/liquidity-unavailable.json";
import levelReadingsOff from "../../../../test/fixtures/nexus-intel/liquidity-level-readings-off.json";
import decision from "../../../../test/fixtures/nexus-intel/engine-decision.json";
import ez1Global from "../../../../test/fixtures/nexus-ez1/conclusion-global.json";
import ez1Overview from "../../../../test/fixtures/nexus-ez1/omega-overview.json";
import chartPatterns from "../../../../test/fixtures/nexus-intel/chart-patterns.json";
import strategyAgents from "../../../../test/fixtures/nexus-intel/strategy-agents.json";
import neuronAllocation from "../../../../test/fixtures/nexus-intel/neuron-allocation.json";
import { LensHeader, LensView } from "../src/components/LensPanel";
import { LEVEL_MOVES_HINT, LiquidityView } from "../src/pages/Liquidity";
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
import orb from "../../../../test/fixtures/nexus-intel/orb.json";
import orbCandles from "../../../../test/fixtures/nexus-intel/orb-candles.json";
import orbDecision from "../../../../test/fixtures/nexus-intel/orb-decision.json";
import orbAgents from "../../../../test/fixtures/nexus-intel/orb-agents.json";
import orbOverlap from "../../../../test/fixtures/nexus-intel/orb-overlap.json";
import orbOverlapCandles from "../../../../test/fixtures/nexus-intel/orb-overlap-candles.json";
import orbOverlapDecision from "../../../../test/fixtures/nexus-intel/orb-overlap-decision.json";
import orbOverlapAgents from "../../../../test/fixtures/nexus-intel/orb-overlap-agents.json";
import orbMismatch from "../../../../test/fixtures/nexus-intel/orb-mismatch.json";
import { OrbUnread, OrbView } from "../src/pages/Orb";
import pmOn from "../../../../test/fixtures/nexus-pm-lines/lines-on.json";
import pmOff from "../../../../test/fixtures/nexus-pm-lines/lines-off.json";
import pmHandOff from "../../../../test/fixtures/nexus-pm-lines/lines-hand-off.json";
import pmNew from "../../../../test/fixtures/nexus-pm-lines/lines-new.json";
import pmAfterOn from "../../../../test/fixtures/nexus-pm-lines/lines-after-on.json";
import pmError from "../../../../test/fixtures/nexus-pm-lines/lines-error.json";
import pmReplies from "../../../../test/fixtures/nexus-pm-lines/post-replies.json";
import { PmLinesFrame, PmLinesLoading, PmLinesView, type PmLinesProps } from "../src/components/PmLines";
import { replyResult } from "../src/lib/pmLines";
import f4Empty from "../../../../test/fixtures/nexus-f4/overview-empty.json";
import f4Fresh from "../../../../test/fixtures/nexus-f4/overview-fresh.json";
import f4Viewer from "../../../../test/fixtures/nexus-f4/overview-viewer.json";
import f4Stale from "../../../../test/fixtures/nexus-f4/overview-stale.json";
import f4Replies from "../../../../test/fixtures/nexus-f4/replies.json";
import { DisconnectDialog, FeedsView, type FeedMsg, type FeedUi } from "../src/pages/Feeds";
import { LOCAL_ERRORS, errorWords as feedErrorWords, replyResult as feedReply } from "../src/lib/feeds";
import os1Pending from "../../../../test/fixtures/nexus-os1/overview-pending.json";
import os1Ok from "../../../../test/fixtures/nexus-os1/overview-ok.json";
import os1Disconnected from "../../../../test/fixtures/nexus-os1/overview-disconnected.json";
import os1NotSeen from "../../../../test/fixtures/nexus-os1/overview-not-seen.json";
import os1NotSeenViewer from "../../../../test/fixtures/nexus-os1/overview-not-seen-viewer.json";
import os1NotSeenSpace from "../../../../test/fixtures/nexus-os1/overview-not-seen-space.json";
import os1NotSeenPlain from "../../../../test/fixtures/nexus-os1/overview-not-seen-plain.json";
import os1Feeds from "../../../../test/fixtures/nexus-os1/overview-feeds.json";
import os1FeedsViewer from "../../../../test/fixtures/nexus-os1/overview-feeds-viewer.json";
import os1Replies from "../../../../test/fixtures/nexus-os1/replies.json";
import { ConnectionMessage, RecoveryHeldChip, RecoveryHeldLine, ServerCheckLine } from "../src/components/OmegaStatus";
import { RECOVERY_HELD_HINT, SERVER_CHECK_HINT, recoveryHeldOf, savedMsg, serverCheckOf } from "../src/lib/omegaStatus";
import { BARS_STOPPED_HINT } from "../src/pages/Feeds";
import cf2Suggestions from "../../../../test/fixtures/nexus-cf2/suggestions.json";
import cf2SuggestionsEmpty from "../../../../test/fixtures/nexus-cf2/suggestions-empty.json";
import cf2SuggestionsOff from "../../../../test/fixtures/nexus-cf2/suggestions-off.json";
import cf2Sessions from "../../../../test/fixtures/nexus-cf2/sessions.json";
import cf2SessionsOff from "../../../../test/fixtures/nexus-cf2/sessions-off.json";
import cf2Running from "../../../../test/fixtures/nexus-cf2/session-running.json";
import cf2Decided from "../../../../test/fixtures/nexus-cf2/session-decided.json";
import cf2Reopened from "../../../../test/fixtures/nexus-cf2/session-reopened.json";
import cf2Archive from "../../../../test/fixtures/nexus-cf2/archive.json";
import cf2ArchivePage1 from "../../../../test/fixtures/nexus-cf2/archive-page1.json";
import cf2ArchiveEmpty from "../../../../test/fixtures/nexus-cf2/archive-empty.json";
import cf2ArchiveOff from "../../../../test/fixtures/nexus-cf2/archive-off.json";
import cf2Replies from "../../../../test/fixtures/nexus-cf2/decide-replies.json";
import { ArchiveUnread, ArchiveView, CouncilHeader, SessionDetailView, SessionsView, SuggestionCard, SuggestionsView, Tabs } from "../src/pages/Councils";
import { archiveOf, chainFor, decideResult, detailOf, sessionsOf, suggestionsOf, type Decision } from "../src/lib/councilArchive";
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
 * liquidity.json; liquidity-unavailable.json: no recent broker bar; liquidity-level-readings-off.json: the seed's answer
 * with LENS_LEVEL_READINGS off, level_moves null and the skip unscored). Since B15 the fixture carries the LIQUIDITY
 * card and the quorum with liquidity (the latest decision's decision.liquidity), since B16 lens B's conditions, and
 * since B19 the skips' outcomes and effects.level_moves. LATER is the page's own stand-in for the level moves until backends B17-B19
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
/** LENS_LEVEL_READINGS on and a skip not scored yet (its outcome still unknown): level moves listed, the skip waits. */
export const SKIP_UNSCORED = { effects: { skips: ((liquidity as any).effects.skips ?? []).map((x: any) => ({ ...x, outcome: null })) } };
/** The texts the page no longer writes since B17-B19 are live (any of them in a render is stale). */
export const PRE_BACKEND = ["B19 is deployed", "B17 is deployed", "B18 is deployed", "Fills after backend B1"];
/** LENS_LEVEL_READINGS off: the level moves' line and the skip's. */
export const READINGS_OFF = "Not recorded: LENS_LEVEL_READINGS is off.";
export const LEVEL_READINGS_OFF = levelReadingsOff;
/**
 * B19's level moves in every outcome (src/liquidity-view.mjs: { at_ms, side, mode, action, outcome }, no price): the
 * fixture's two, a missed ladder lock on a short, a key level lock with no side, mode or known outcome (pending), a
 * neutral one three days back, and one older than the panel's 7 days (not shown).
 */
const LM_AT = (liquidity as any).state.at_ms, HOUR_MS = 3_600_000;
export const LEVEL_MOVES = [
  ...(liquidity as any).effects.level_moves,
  { at_ms: LM_AT - 6 * HOUR_MS, side: "SELL", mode: "scalp", action: "ladder_lock", outcome: "miss" },
  { at_ms: LM_AT - 8 * HOUR_MS, side: null, mode: null, action: "key_level_lock", outcome: "odd" },
  { at_ms: LM_AT - 72 * HOUR_MS, side: "BUY", mode: "intraday", action: "ladder_lock", outcome: "neutral" },
  { at_ms: LM_AT - 216 * HOUR_MS, side: "BUY", mode: "swing", action: "ladder_lock", outcome: "hit" }
];
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

/**
 * The Opening range page (Track C4) over its reads. /api/orb is backend B14's contract (test/fixtures/nexus-intel/
 * orb.json, byte for byte: Tue 24 Nov 10:00 UTC, London live, broken up and retesting, its long plan picked; New York of
 * the day before over, a release inside its range). The other files are the real routes' answers on seeded environments
 * (test/support/nexus-orb-seed.mjs): orb-overlap*.json the mockup's hour (Mon 23 Nov 15:00 UTC, both windows live, New
 * York holding the long side, London's long side invalidated, armed), orb-mismatch.json 16 March 2026 (London silent:
 * the clock mismatch; New York formed, no breakout). The ORB_* variants below are derived from them for the states no
 * seeded hour shows at once; they are not contracts.
 */
const O = orb as any, OV = orbOverlap as any;
const NY_24 = Date.parse("2026-11-24T13:00:00Z");
const NO_PLANS = { long: null, short: null };
const NO_BREAKOUT = { side: null, bar_ms: null, bars_since: null, state: "none" };
/** Tue 24 Nov 08:32 UTC: London's range building (2 of 3 bars), New York's not yet; no plan anywhere. */
export const ORB_FORMING = merged(O, {
  bar_close: "2026-11-24T08:30:00.000Z", overlap: { long: null, short: null },
  sessions: {
    london: { phase: "forming", bars_built: 2, bars_left: 33, status: "not_formed", status_detail: "the first three 15m bars of the session are still coming", high: null, low: null, mid: null, width: null, width_atr: null, breakout: NO_BREAKOUT, edges_in_zones: [], plans: NO_PLANS },
    new_york: { date_ny: "2026-11-24", open_ms: NY_24, range_end_ms: NY_24 + 2_700_000, end_ms: NY_24 + 31_500_000, phase: "forming", bars_built: 0, bars_left: 0, status: "not_formed", status_detail: "the first three 15m bars of the session are still coming", events_in_range: [] }
  }
});
/** The weekend: the market closed, the next range London's on Monday 30 Nov. */
export const ORB_CLOSED = merged(O, { market: { open: false, next_range: { session: "london", open_ms: Date.parse("2026-11-30T08:00:00Z") } } });
/** The agent off (STRATEGY_AGENTS_OFF orb_breakout): no range read, the ORB levels off with it. */
export const ORB_OFF = merged(O, { mode: "off", levels_mode: "off" });
/** The mockup's hour with New York's breakout invalidated too: both sides off, no plan (the UI's state; one range breaks one way). */
export const ORB_BOTH_INVALIDATED = merged(OV, { overlap: { long: null }, sessions: { london: { invalidated: { long: true, short: true } }, new_york: { breakout: { state: "invalidated" }, invalidated: { long: true, short: true }, plans: NO_PLANS } } });
/** London's window over with no breakout: "none by 11:45 NY", "no plan: no breakout". */
export const ORB_NO_BREAKOUT = merged(OV, { overlap: { long: null }, sessions: { london: { phase: "over", bars_left: 0, breakout: NO_BREAKOUT, invalidated: { long: false, short: false } }, new_york: { breakout: NO_BREAKOUT, plans: NO_PLANS } } });
/** New York live with a release inside its range (orb.json's New York is the same state, its window over). */
export const ORB_RANGE_EVENT = merged(OV, { overlap: { long: null }, sessions: { new_york: { status: "range_event", status_detail: "a high-impact release fell inside the range, so the session is not traded", high: null, low: null, mid: null, width: null, width_atr: null, breakout: NO_BREAKOUT, edges_in_zones: [], plans: NO_PLANS, events_in_range: [{ title: "Retail sales", time: "2026-11-23T13:30:00.000Z" }] } } });
/** London's range narrower than the band. */
export const ORB_TOO_NARROW = merged(OV, { sessions: { london: { status: "too_narrow", status_detail: "the range is narrower than the width band", width_atr: 0.2, breakout: NO_BREAKOUT, invalidated: { long: false, short: false } } } });
/** New York broken down and held, its short plan an order at price: the bear side. */
export const ORB_SHORT = merged(OV, { overlap: { long: null, short: "new_york" }, sessions: { new_york: { breakout: { side: "short", state: "held" }, plans: { long: null, short: { entry: 4095.28, stop: 4097.12, tp1: 4090.5, tp2: 4088.1, rrr: 2.6, entry_type: "at_level", lapse_ms: OV.sessions.new_york.end_ms, role: "shadow", picked: false } } } } });
const orbView = (props: Record<string, unknown> = {}) => ({ d }: { d: any }) => <OrbView d={d} agents={orbAgents} decision={orbDecision} candles={orbCandles} {...props} />;
const overlapView = (props: Record<string, unknown> = {}) => ({ d }: { d: any }) => <OrbView d={d} agents={orbOverlapAgents} decision={orbOverlapDecision} candles={orbOverlapCandles} {...props} />;
const ORB_PANELS = ["Sessions", "Ranges on the chart", "Records per session", "Recent sessions", "Where it counted"];
const orbUnread = (code: string): Poll => ({ data: null, error: code, loading: false, refresh: () => {}, lastOk: null, lastFail: 1, failures: 1, stale: false, intervalMs: 60_000 });

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

/**
 * F4, the Data feeds page (Live › Data feeds, #/feeds; test/fixtures/nexus-f4/*.json, the seed's answers of the real Omega
 * routes and AI Worker: test/support/nexus-f4-seed.mjs). Every state of the card: no feed bridge yet, one fresh feed
 * (owner and viewer), a stale feed whose login is sealed to an old key beside a fresh feed with its terminal down and
 * its login cleared, sending, saved, disconnected, each code the POST and DELETE answer and the page's own refusals,
 * and the disconnect's confirm box (a reason required). The feeds-only entries vary every feed path (the overview's are
 * capped). Status tones only: no bull, bear or green; no value attribute on any input; no account data.
 */
type F4Reply = { status: number; body: any };
const F4_REPLIES = f4Replies as unknown as Record<string, F4Reply>;
const esc = (t: string) => t.replace(/'/g, "&#x27;");
const f4Ui = (id: string, u: FeedUi) => ({ [id]: u });
const f4Msg = (r: any, cleared = false): FeedMsg => { const x = feedReply(Number(r?.status) || 0, r?.body); return x.ok ? (cleared ? { kind: "cleared" } : { kind: "saved", version: x.version, server: x.server }) : { kind: "error", code: x.error }; };
const feedsOnly = (base: any) => ({ d }: { d: any }) => <FeedsView d={{ ...base, broker: { ...(base as any).broker, feeds: d?.feeds }, viewer: d?.viewer }} />;
// The panel's own entry animation (framer-motion) is the only style in the markup; the browser sets it through the CSSOM.
const F4_NO_DIRECTION = ["text-bull", "text-bear", "emerald", "green", "rose-", "value=\"", "Balance", "Equity", "balance", "equity"];
const F4_FRESH_SHOWS = ["Data feeds", "oanda", "Data feed (no trading)", ">fresh<", "synced 12s ago", ">connected<", "OANDA-Demo-1", "XAUUSD", "stored · v1", "Fri 27 Nov 04:59 UTC · 11:59 GMT+7", "ccd56eb1e2d15266", "1.9.0", "text-ok"];
const F4_ERROR_FIXTURES: [string, F4Reply, any][] = Object.entries(F4_REPLIES).filter(([, r]) => r.status !== 200).map(([k, r]) => [k, r, k === "kid_mismatch" ? f4Stale : f4Fresh]);
export const F4_VIEWS: Entry[] = [
  { name: "F4Empty", View: FeedsView, fixture: f4Empty, shows: ["Data feeds", "No feed bridge has connected yet", "A feed bridge shows here after its first sync from the VPS.", "owner"], hides: ["Save feed login", "<form", ...F4_NO_DIRECTION] },
  { name: "F4Fresh", View: FeedsView, fixture: f4Fresh,
    shows: [...F4_FRESH_SHOWS, "owner", "Feed login · data only", "Save feed login", ">Disconnect<", 'type="password"', 'autoComplete="new-password"', 'name="login"', 'name="server"', 'placeholder="OANDA-Demo-1"'],
    hides: ["Login sealed to an old key", "Refused", "read only", ...F4_NO_DIRECTION] },
  { name: "F4FreshFeeds", View: feedsOnly(f4Fresh), fixture: { feeds: (f4Fresh as any).broker.feeds, viewer: (f4Fresh as any).viewer }, shows: [...F4_FRESH_SHOWS, "Save feed login"] },
  { name: "F4Viewer", View: FeedsView, fixture: f4Viewer, shows: [...F4_FRESH_SHOWS, "read only"], hides: ["<form", "<input", "<button", "Save feed login", "Disconnect", "Feed login", ...F4_NO_DIRECTION] },
  { name: "F4StaleOldKey", View: FeedsView, fixture: f4Stale,
    shows: [">stale<", "last sync 6 min ago", "Login sealed to an old key", "The feed gets no login until it is entered again.", "stored to an old key · v1", "text-late", "border-late-fill/35", "97f95ff94b0dbbdc",
      "backup", "synced 10s ago", ">not connected<", "text-fault", "disconnected · v1", "Fri 27 Nov 05:06 UTC · 12:06 GMT+7", "Backup-Demo"],
    hides: ["Refused", ...F4_NO_DIRECTION] },
  { name: "F4StaleFeeds", View: feedsOnly(f4Stale), fixture: { feeds: (f4Stale as any).broker.feeds, viewer: (f4Stale as any).viewer }, shows: ["Login sealed to an old key", ">stale<"] },
  { name: "F4StaleViewer", View: ({ d }) => <FeedsView d={{ ...d, viewer: (f4Viewer as any).viewer }} />, fixture: f4Stale, shows: ["Login sealed to an old key", "read only"], hides: ["<form", "<button"] },
  { name: "F4Sending", View: ({ d }) => <FeedsView d={d} ui={f4Ui("oanda", { phase: "sending" })} />, fixture: f4Fresh, shows: ["Encrypting…", 'disabled=""'], hides: ["Save feed login", "Refused"] },
  { name: "F4Saved", View: ({ d }) => <FeedsView d={f4Fresh} ui={f4Ui("oanda", { msg: f4Msg(d) })} />, fixture: F4_REPLIES.stored, shows: [esc("Saved v1 for OANDA-Demo-1; applied at the feed's next sync.")], hides: ["Refused"] },
  { name: "F4Cleared", View: ({ d }) => <FeedsView d={f4Stale} ui={f4Ui("backup", { msg: f4Msg(d, true) })} />, fixture: F4_REPLIES.cleared, shows: ["Disconnected; the feed gets no login from its next sync."], hides: ["Refused"] },
  ...F4_ERROR_FIXTURES.map(([k, r, base]) => {
    const code = String(r.body.error);
    return { name: `F4Error_${k}`, View: ({ d }: { d: any }) => <FeedsView d={base} ui={f4Ui("oanda", { msg: f4Msg(d) })} />, fixture: r,
      shows: ['role="alert"', `Refused: ${esc(code)}`, esc(feedErrorWords(code)), "text-fault",
        ...(k === "feed_bridge_not_seen" ? ["The feed bridge has not synced yet. Start it on the VPS first, then retry."] : []),
        ...(k === "kid_mismatch" ? [esc("The feed's key changed. Reload the page and retry.")] : [])], hides: ["Saved v"] };
  }),
  ...LOCAL_ERRORS.map((code) => ({ name: `F4Local_${code}`, View: ({ d }: { d: any }) => <FeedsView d={f4Fresh} ui={f4Ui("oanda", { msg: { kind: "error", code: String(d?.error ?? code) } })} />, fixture: { error: code },
    shows: ['role="alert"', `Refused: ${code}`, esc(feedErrorWords(code))] })),
  { name: "F4RefusedNoBody", View: ({ d }) => <FeedsView d={f4Fresh} ui={f4Ui("oanda", { msg: f4Msg(d) })} />, fixture: { status: 503, body: {} }, shows: ["Refused: HTTP 503", "Nothing changed."] },
  { name: "F4ViewerMessage", View: ({ d }) => <FeedsView d={f4Viewer} ui={f4Ui("oanda", { msg: f4Msg(d) })} />, fixture: F4_REPLIES.forbidden, shows: ["Refused: forbidden", "A person makes this change, never a service token."], hides: ["<form"] },
  { name: "F4DisconnectDialog", View: ({ d }) => <DisconnectDialog feed={{ bridge_id: typeof d?.bridge_id === "string" ? d.bridge_id : "oanda" }} onDone={() => {}} />, fixture: { bridge_id: "oanda" },
    shows: ["Disconnect the oanda feed?", "Reason (required)", 'aria-required="true"', 'placeholder="e.g. rotate the feed login"', 'disabled=""', ">Disconnect<", "border-fault-fill/40", "Trading is not affected: this is a data feed."], hides: ["Type the key to confirm"] }
];

/**
 * OS1, three backend fields shown (test/fixtures/nexus-os1/*.json, the seed's answers of the real Omega routes and AI
 * Worker: test/support/nexus-os1-seed.mjs). The Omega page's Broker connection card: the server check in each status
 * (none, pending, ok, disconnected, not_seen with a hyphen or a space for the hint, not_seen with no hint, a viewer); the
 * Save's answer with and without the near-match warning; the Last recovery card's hold with and without its cause, and a
 * plain dispatch. The Data feeds card: a feed whose bars stopped, one that never sent a bar, one with a fresh bar (owner
 * and viewer). Each view is framed by its card's title, so a state that shows nothing still renders. Status tones only.
 */
const OS1_NO_DIRECTION = ["text-bull", "text-bear", "emerald", "green", "rose-", "dangerouslySetInnerHTML"];
const OS1_REPLIES = os1Replies as unknown as Record<string, { status: number; body: any }>;
const os1Check = ({ d }: { d: any }) => <section><h2>Broker connection</h2><ServerCheckLine sc={serverCheckOf(d)} /></section>;
const os1Saved = ({ d }: { d: any }) => <section><h2>Broker connection</h2><ConnectionMessage msg={savedMsg(d?.body)} /></section>;
const os1Held = ({ d }: { d: any }) => { const h = recoveryHeldOf(d); return <section><h4>Last recovery</h4><RecoveryHeldChip held={h} /><RecoveryHeldLine held={h} /></section>; };
const os1FeedsOnly = (base: any) => ({ d }: { d: any }) => <FeedsView d={{ ...base, broker: { ...(base as any).broker, feeds: d?.feeds }, viewer: d?.viewer }} />;
const OS1_HELD_HINT = esc(RECOVERY_HELD_HINT), OS1_CHECK_HINT = esc(SERVER_CHECK_HINT);
const os1Exact = (name: string) => `<code class="mono whitespace-pre rounded-sm border border-white/10 bg-black/30 px-1 text-[11.5px] text-slate-100">${name}</code>`;
export const OS1_VIEWS: Entry[] = [
  { name: "OS1ServerCheckNone", View: os1Check, fixture: f4Fresh, shows: ["Broker connection"], hides: ["Server check", "chip"] },
  { name: "OS1ServerCheckPending", View: os1Check, fixture: os1Pending, shows: ["Server check", ">checking server<", "text-late", OS1_CHECK_HINT, esc("Waiting for the terminal's first login on this name.")], hides: ["did you mean", "Check spaces", "text-fault", ...OS1_NO_DIRECTION] },
  { name: "OS1ServerCheckOk", View: os1Check, fixture: os1Ok, shows: [">server seen<", "text-ok", "Logged in on the exact stored server name."], hides: ["did you mean", "text-late", "text-fault", ...OS1_NO_DIRECTION] },
  { name: "OS1ServerCheckDisconnected", View: os1Check, fixture: os1Disconnected, shows: [">disconnected<", "text-off", "Logged in on this name before; not connected now."], hides: ["did you mean", "Check", "check the", "exactly", "text-fault", ...OS1_NO_DIRECTION] },
  { name: "OS1ServerCheckNotSeen", View: os1Check, fixture: os1NotSeen,
    shows: [">server not seen<", "text-fault", esc("The terminal has not logged into a server named exactly 'Placeholder-Live-2'. Check spaces, hyphens and case, then enter the connection again."), `did you mean ${os1Exact("Placeholder-Live 2")}?`], hides: OS1_NO_DIRECTION },
  { name: "OS1ServerCheckNotSeenSpace", View: os1Check, fixture: os1NotSeenSpace, shows: [esc("named exactly 'Placeholder-Live2'"), `did you mean ${os1Exact("Placeholder-Live 2")}?`] },
  { name: "OS1ServerCheckNotSeenPlain", View: os1Check, fixture: os1NotSeenPlain, shows: [">server not seen<", esc("named exactly 'Other-Server'")], hides: ["did you mean"] },
  { name: "OS1ServerCheckNotSeenViewer", View: os1Check, fixture: os1NotSeenViewer, shows: [">server not seen<", `did you mean ${os1Exact("Placeholder-Live 2")}?`], hides: ["<button", "<form", "<input"] },
  { name: "OS1ServerCheckExactHint", View: os1Check, fixture: merged(os1NotSeen, { broker: { server_check: { did_you_mean: " placeholder_LIVE 2" } } }), shows: [`did you mean ${os1Exact(" placeholder_LIVE 2")}?`] },
  { name: "OS1ServerCheckUnknown", View: os1Check, fixture: merged(os1Ok, { broker: { server_check: { status: "later" } } }), shows: ["Broker connection"], hides: ["Server check"] },
  { name: "OS1SaveNearMatch", View: os1Saved, fixture: OS1_REPLIES.near_match,
    shows: ["Saved v1 for Placeholder-Live-2; applied at next bridge sync.", "text-ok", "text-late", esc("A server named 'Placeholder-Live 2' was seen before; the name entered is 'Placeholder-Live-2'. Saved as entered."), `did you mean ${os1Exact("Placeholder-Live 2")}?`],
    hides: ["Refused", ...OS1_NO_DIRECTION] },
  { name: "OS1SaveNearMatchSpace", View: os1Saved, fixture: OS1_REPLIES.near_match_space, shows: ["Saved v1 for Placeholder-Live2; applied at next bridge sync.", esc("the name entered is 'Placeholder-Live2'"), `did you mean ${os1Exact("Placeholder-Live 2")}?`] },
  { name: "OS1SaveNoWarning", View: os1Saved, fixture: OS1_REPLIES.saved, shows: ["Saved v1 for Placeholder-Live 2; applied at next bridge sync.", "text-ok"], hides: ["did you mean", "text-late", "Saved as entered"] },
  { name: "OS1RecoveryHeldCause", View: os1Held, fixture: os1NotSeen,
    shows: [">recovery held<", "text-late", OS1_HELD_HINT, "border-late-fill/35", esc("3 terminal restarts did not reconnect: the terminal has not logged into a server named exactly 'Placeholder-Live-2'."),
      "3 dispatches · connection v1 · server not seen · since Fri 27 Nov 04:51 UTC · 11:51 GMT+7"], hides: OS1_NO_DIRECTION },
  { name: "OS1RecoveryHeldNoCause", View: os1Held, fixture: os1Disconnected, shows: [">recovery held<", "3 terminal restarts did not reconnect; no more restarts until the connection is entered again or the terminal is healthy again.", "3 dispatches · connection v1 · since Fri 27 Nov 04:51 UTC · 11:51 GMT+7"], hides: ["server not seen"] },
  { name: "OS1RecoveryDispatched", View: os1Held, fixture: os1NotSeenSpace, shows: ["Last recovery"], hides: ["recovery held", "dispatches"] },
  { name: "OS1RecoveryNone", View: os1Held, fixture: os1Ok, shows: ["Last recovery"], hides: ["recovery held"] },
  { name: "OS1FeedsStale", View: FeedsView, fixture: os1Feeds,
    shows: ["Bars stopped", esc(BARS_STOPPED_HINT), "Last bar 21 min ago, while the feed keeps syncing.", "Re-enter the feed login below.", "text-late", "border-late-fill/35", ">Last bar<", ">21 min ago<", ">2 min ago<", ">—<", "Save feed login"],
    hides: [">0 s<", ">0s ago<", ...OS1_NO_DIRECTION] },
  { name: "OS1FeedsStaleFeeds", View: os1FeedsOnly(os1Feeds), fixture: { feeds: (os1Feeds as any).broker.feeds, viewer: (os1Feeds as any).viewer }, shows: ["Bars stopped", "Re-enter the feed login below."] },
  { name: "OS1FeedsStaleViewer", View: FeedsView, fixture: os1FeedsViewer, shows: ["Bars stopped", "Last bar 21 min ago, while the feed keeps syncing.", "Re-enter the feed login.", "read only"], hides: ["login below", "<form", "<button", "<input", ...OS1_NO_DIRECTION] }
];

// CF2, the Call for Councils page (test/fixtures/nexus-cf2/*.json: test/support/nexus-cf2-seed.mjs over #677's real code).
export const CF2_NOW = Date.parse("2026-11-28T14:48:00Z");
const CF2_ARCHIVE = archiveOf(cf2Archive);
const CF2_REPLIES = cf2Replies as unknown as Record<string, { status: number; body: any }>;
const CF2_OWNER = { canControl: true, on: true, show: true };
const CF2_VIEWER = { canControl: false, on: true, show: false };
const cf2Sug = (canControl: boolean) => ({ d }: { d: any }) => <SuggestionsView sug={suggestionsOf(d, CF2_NOW)} archive={CF2_ARCHIVE} now={CF2_NOW} canControl={canControl} />;
const cf2Card = (key: string, decision: Decision = "approve") => ({ d }: { d: any }) => {
  const sug = suggestionsOf(cf2Suggestions, CF2_NOW).open[1];
  const r = decideResult(d?.status ?? null, d?.body ?? null, decision, CF2_NOW);
  return <SuggestionCard s={r.suggestion && key !== "session_refused" ? r.suggestion : sug} now={CF2_NOW} canControl state={{ result: r, decision }} />;
};
const cf2Detail = (gate: any, canControl: boolean) => ({ d }: { d: any }) => {
  const chain = chainFor(CF2_ARCHIVE, { sessionId: d?.session?.id ?? null });
  const det = detailOf(d?.session, chain);
  return <GateOverride.Provider value={gate}>{det ? <SessionDetailView d={det} chain={chain} now={CF2_NOW} canControl={canControl} enabled /> : <span>no session</span>}</GateOverride.Provider>;
};
const cf2ArchiveView = (ui: any = {}) => ({ d }: { d: any }) => <ArchiveView a={archiveOf(d)} now={CF2_NOW} ui={ui} />;
const CF2_DECIDE_SHOWS: Record<string, string[]> = {
  already_decided: ["409 already_decided", "It was decided before yours arrived.", 'role="status"', ">rejected<"],
  expired: ["409 expired", "It expired before yours arrived.", ">expired<", "expired, not decided"],
  session_refused: ["409 session_refused", "The session did not start: council sessions are off", "Try again", 'role="alert"'],
  not_found: ["404 not_found", "no longer on the server"], bad_request: ["400 bad_request", "a Nexus bug, not yours"],
  owner_only: ["403 owner_only", "Only the owner decides."], same_origin_only: ["403 same_origin_only", "not sent from this page"]
};
export const CF2_VIEWS: Entry[] = [
  { name: "Cf2SuggestionsOwner", View: cf2Sug(true), fixture: cf2Suggestions,
    shows: ["Open", "soonest expiry first", "execution:recoveries", "expiring", "expires in 42m", "15:30 UTC · 22:30 GMT+7", "expires in 3h 12m", "expires in 11h 05m", "Approve", "Reject", "Evidence", "border-late-fill/30", "bg-late-fill",
      "Recent", "strategy:zone_pullback@intraday|normal-trending", "Recent: 5 expired · 1 aborted · 1 refused · 1 rejected"], hides: ["Accept", "example.com", "Open a session on", "Build the evidence pack"] },
  { name: "Cf2SuggestionsViewer", View: cf2Sug(false), fixture: cf2Suggestions, shows: ["expires in 42m", "only the owner approves or rejects"], hides: [">Approve<", ">Reject<"] },
  { name: "Cf2SuggestionsEmpty", View: cf2Sug(true), fixture: cf2SuggestionsEmpty, shows: ["0 open suggestions", "The flags run once an hour while the market is open.", "No recent topic needs anyone now."] },
  { name: "Cf2SuggestionsOff", View: cf2Sug(true), fixture: cf2SuggestionsOff, shows: ["CFC_MODE off", "No new suggestions and no sessions. The archive stays readable.", "expires in 42m"] },
  { name: "Cf2CardSending", View: ({ d }) => { const x = suggestionsOf(d, CF2_NOW).open[2]; return x ? <SuggestionCard s={x} now={CF2_NOW} canControl state={{ sending: "approve" }} /> : <span>none</span>; }, fixture: cf2Suggestions, shows: ["Approving", 'aria-busy="true"', 'disabled=""', "engine:model"] },
  { name: "Cf2CardApproved", View: ({ d }) => { const x = suggestionsOf(d, CF2_NOW).recent.find((y) => y.status === "approved"); return x ? <SuggestionCard s={x} now={CF2_NOW} canControl /> : <span>none</span>; }, fixture: cf2Suggestions, shows: [">approved<", "approved by owner", "Open session", "12:19 UTC · 19:19 GMT+7"], hides: [">Approve<"] },
  { name: "Cf2CardRejected", View: ({ d }) => { const x = suggestionsOf(d, CF2_NOW).recent.find((y) => y.status === "rejected"); return x ? <SuggestionCard s={x} now={CF2_NOW} canControl /> : <span>none</span>; }, fixture: cf2Suggestions, shows: [">rejected<", "rejected by owner", "No session opened.", "27 Nov 06:40 UTC · 13:40 GMT+7"] },
  { name: "Cf2CardExpired", View: ({ d }) => { const x = suggestionsOf(d, CF2_NOW).recent.find((y) => y.status === "expired"); return x ? <SuggestionCard s={x} now={CF2_NOW} canControl /> : <span>none</span>; }, fixture: cf2Suggestions, shows: [">expired<", "expired, not decided"], hides: [">Approve<", "expires in"] },
  ...Object.keys(CF2_DECIDE_SHOWS).map((k) => ({ name: `Cf2Decide_${k}`, View: cf2Card(k, k === "already_decided" ? "approve" : "approve"), fixture: CF2_REPLIES[k], shows: CF2_DECIDE_SHOWS[k] })),
  { name: "Cf2SessionsOwner", View: ({ d }) => <SessionsView sessions={sessionsOf(d, CF2_NOW)} archive={CF2_ARCHIVE} now={CF2_NOW} details={{ [(cf2Running as any).session.id]: detailOf((cf2Running as any).session) }} />, fixture: cf2Sessions,
    shows: ["Running", "running", "responses", "9/16 calls", "Risk Manager", "responded", "The Interstellar Eyes", "waiting", "not yet", "Ended", ">decided<", ">aborted<", ">closed<", "council", "4 agree", "1 change", "Raise the intraday reward floor", "Skip the first London hour after a range night", "the daily council budget is used up"], hides: ["example.com", "Accept"] },
  { name: "Cf2SessionsOff", View: ({ d }) => <SessionsView sessions={sessionsOf(d, CF2_NOW)} archive={null} now={CF2_NOW} />, fixture: cf2SessionsOff, shows: ["Running", "Ended", ">closed<"] },
  { name: "Cf2DetailDecided", View: cf2Detail(CF2_OWNER, true), fixture: cf2Decided,
    shows: ["Options the council weighed", "council&#x27;s pick", "decided by", "council", "Raise the intraday reward floor", "decision.min_rrr.intraday: 1.5 → 1.7 R", "knob change · shadow test first", "no change", "4 agree · 1 change · 1 disagree · 0 abstain", 'role="img"', "Seat votes", "Opening opinions", "Responses to each other", "Re-open with fresh evidence", ">shadow<", "next shadow", 'aria-label="Rate / correct"'],
    hides: ["Accept", ">Close<", "Write to the agents"] },
  { name: "Cf2DetailViewer", View: cf2Detail(CF2_VIEWER, false), fixture: cf2Decided, shows: ["council&#x27;s pick", "Seat votes"], hides: ["Re-open", "Rate / correct", "Write to the agents"] },
  { name: "Cf2DetailRunning", View: cf2Detail(CF2_OWNER, true), fixture: cf2Running, shows: ["running", "responses", ">Close<", "Write to the agents", "Send"], hides: ["Options the council weighed", "&#x27;s pick"] },
  { name: "Cf2DetailReopened", View: cf2Detail(CF2_OWNER, true), fixture: cf2Reopened, shows: [">closed<", "reopened as", "by owner"], hides: ["example.com"] },
  { name: "Cf2ArchiveActive", View: cf2ArchiveView(), fixture: cf2Archive,
    shows: ["Needs someone", "6 of 6", "Needs you", "In progress", "strategy:zone_pullback@intraday|normal-trending", "in_progress", ">shadow<", "decision.min_rrr.intraday 1.5 → 1.7", "owner", "platform", 'aria-expanded="false"', "Archive: 5 expired · 2 closed · 1 aborted · 1 refused · 1 rejected"],
    hides: ["data:market_feed", "out_of_scope", "Load more", 'id="cfc-archive-list"'] },
  { name: "Cf2ArchiveOpen", View: cf2ArchiveView({ open: true }), fixture: cf2Archive,
    shows: ['aria-expanded="true"', "10 of 10 ended", "data:market_feed", "expired at 12:30 UTC · 19:30 GMT+7", "rejected at 27 Nov 06:40 UTC · 13:40 GMT+7", 'data-line="one"', "out_of_scope", ">refused<", "free:zone-pullback-exits-review", "Status", ">all<"], hides: ["Load more", "example.com"] },
  { name: "Cf2ArchiveOpenExpired", View: cf2ArchiveView({ open: true, filter: "expired" }), fixture: cf2Archive, shows: ["5 of 10 ended", "seat:risk@15"], hides: ["out_of_scope", "risk:london"] },
  { name: "Cf2ArchivePage1", View: cf2ArchiveView({ open: true }), fixture: cf2ArchivePage1, shows: ["Load more", "6 of 16 chains loaded", "in the last 6 loaded of 16"] },
  { name: "Cf2ArchiveEmpty", View: cf2ArchiveView(), fixture: cf2ArchiveEmpty, shows: ["0 chains", "A chain starts when a suggestion is approved, rejected or expires."] },
  { name: "Cf2ArchiveOff", View: cf2ArchiveView(), fixture: cf2ArchiveOff, shows: ["Needs someone", "Archive: 5 expired"] },
  { name: "Cf2Archive404", View: ({ d }) => <ArchiveUnread poll={unread(`/api/council/archive 404 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { error: "Not found" }, shows: ["/api/council/archive 404 Not found", "The archive is not on this Worker yet."] },
  { name: "Cf2Archive503", View: ({ d }) => <ArchiveUnread poll={unread(`/api/council/archive 503 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { status: "error", error: "unavailable" }, shows: ["/api/council/archive 503", ">error<"] },
  { name: "Cf2HeaderOwner", View: ({ d }) => <CouncilHeader mode={d?.mode ?? null} sessions={sessionsOf(d, CF2_NOW)} canControl />, fixture: cf2Sessions, shows: ["CFC_MODE on", "sessions on", "1/4 today", "Turn off"] },
  { name: "Cf2HeaderViewer", View: ({ d }) => <CouncilHeader mode={d?.mode ?? null} sessions={sessionsOf(d, CF2_NOW)} canControl={false} />, fixture: cf2Sessions, shows: ["sessions on", "the owner approves"], hides: ["Turn off", "Turn on"] },
  { name: "Cf2HeaderOff", View: ({ d }) => <CouncilHeader mode={d?.mode ?? null} sessions={sessionsOf(d, CF2_NOW)} canControl />, fixture: cf2SessionsOff, shows: ["CFC_MODE off", "sessions off", "Turn on", 'disabled=""'] },
  { name: "Cf2Tabs", View: ({ d }) => <Tabs tab="archive" open={suggestionsOf(d, CF2_NOW).open.length} running={1} />, fixture: cf2Suggestions, shows: ["Suggestions", "Sessions", "Archive", 'aria-current="page"', ">3<"] },
  { name: "Cf2ConfirmApprove", View: ({ d }) => <ConfirmDialog options={{ title: "Approve this topic?", body: <span className="mono">{d?.topic ?? "—"}</span>, confirmLabel: "Approve", tone: "ok" }} onDone={() => {}} />, fixture: { topic: "strategy:zone_pullback:exits" }, shows: ["Approve this topic?", "border-ok-fill/40", "Approve", "Cancel"] },
  { name: "Cf2ConfirmReject", View: ({ d }) => <ConfirmDialog options={{ title: "Reject this topic?", body: <span className="mono">{d?.topic ?? "—"}</span>, confirmLabel: "Reject", tone: "late" }} onDone={() => {}} />, fixture: { topic: "strategy:zone_pullback:exits" }, shows: ["Reject this topic?", "border-late-fill/40", "Reject"], hides: ["confirm-reason"] }
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
  { name: "FS1Saved", View: fs1Status("ENTRY_ZONE_MODE", { phase: "saved", at: FS1_SAVED_AT, changed: true, era: false }), fixture: fs1Owner, shows: ["saved", "03:41 UTC · 10:41 GMT+7 · owner"], hides: ["· new era"] },
  { name: "FS1SavedUnchanged", View: fs1Status("ENTRY_ZONE_MODE", { phase: "saved", at: FS1_SAVED_AT, changed: false, era: false }), fixture: fs1Owner, shows: ["no change"] },
  { name: "FS1SavedOmega", View: fs1Status("change_thresholds", { phase: "saved", at: FS1_SAVED_AT, changed: true, era: true }), fixture: fs1Owner, shows: ["saved", "03:41 UTC · 10:41 GMT+7 · owner · new era"] },
  ...POST_ERRORS.map((code) => ({ name: `FS1Failed_${code}`, View: fs1Status("ENTRY_ZONE_MODE", { phase: "failed", error: code }), fixture: fs1Owner, shows: [code, "role=\"alert\""] })),
  { name: "FS1FailedReply", View: ({ d }: { d: any }) => <SwitchesView d={fs1Owner} status={{ ENTRY_ZONE_MODE: { phase: "failed", error: String(d?.error ?? "read failed") } }} />, fixture: (fs1Replies as any).invalid_value, shows: ["invalid_value", "allowed: edge, on, off."] },
  { name: "FS1Loading", View: () => <SwitchesLoading />, fixture: fs1Owner, shows: ["Feature switches", "animate-pulse"] },
  { name: "FS1GetError", View: ({ d }) => <PollError poll={fs1Unread(`/omega/api/feature-switches 502 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { error: "feature_switches_failed" }, shows: ["/omega/api/feature-switches 502 feature_switches_failed", "Retry now"] },
  { name: "FS1ConfirmNormal", View: fs1Confirm(() => ({ value: "off" })), fixture: FS1_ROW("CHART_PATTERNS_MODE"), shows: ["Turn chart patterns off?", "CHART_PATTERNS_MODE: on → off", "Turn off"], hides: ["Starts a new era.", "Restarts mode evidence.", "Type the key to confirm"] },
  { name: "FS1ConfirmEra", View: fs1Confirm(() => ({ value: "off" })), fixture: FS1_ROW("reentry_1m"), shows: ["Turn 1m re-entry after a lock stop off?", "reentry_1m: on → off", "Starts a new era."] },
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
      "Level moves", "ladder lock", "key level lock", "past a lens B level", "1 hit", "1 pending", "Position Manager actions",
      "Mon 09:20 NY", "14:20 UTC · 21:20 GMT+7", "Mon 05:00 NY", "10:00 UTC · 17:00 GMT+7", "▼ short", "intraday", LEVEL_MOVES_HINT, "baseline insufficient · 2 of 4 weeks", "backfill done"],
    hides: ["No LIQUIDITY card in the latest decision", "council only", "never counted", "LENS_LEVEL_READINGS", "Not in this answer", ...PRE_BACKEND],
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
  // No level moves here: a long move would also read "▲ long".
  { name: "LiquidityViewQuorumNotMet", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: { ...(liquidity as any), quorum_with_liquidity: QUORUM_NOT_MET, effects: { ...(liquidity as any).effects, level_moves: [] } }, shows: ["Quorum with liquidity", "▲ 0.48", "+0.08"], hides: ["▲ long"] },
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
  // B19's level moves as the varied body, so each move's paths are nulled: grouped by action, each move's time, side,
  // mode and neutral outcome; the empty list reads its own Empty.
  {
    name: "LiquidityViewLevelMoves", View: ({ d }) => <LiquidityView d={merged(liquidity, { effects: { level_moves: d } })} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: LEVEL_MOVES,
    shows: ["ladder lock", "key level lock", "1 hit", "1 miss", "1 neutral", "2 pending", "Mon 03:58 NY", "08:58 UTC · 15:58 GMT+7", "Fri 09:58 NY", "▼ short", "▲ long", "scalp", LEVEL_MOVES_HINT],
    hides: ["2 hit", "swing", "Sat 09:58 NY", "No level move in the last 7 days."]
  },
  {
    name: "LiquidityViewNoLevelMoves", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, { effects: { level_moves: [] } }),
    shows: ["Level moves", "No level move in the last 7 days.", LEVEL_MOVES_HINT], hides: ["ladder lock", "past a lens B level", READINGS_OFF, ...PRE_BACKEND]
  },
  // LENS_LEVEL_READINGS off (the seed's own answer): the level moves' heading and hint, the off line with the way to the
  // switch, the skip not scored with the switch named.
  {
    name: "LiquidityViewLevelReadingsOff", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: levelReadingsOff,
    shows: [...PANELS, "Level moves", LEVEL_MOVES_HINT, READINGS_OFF, 'href="/#/switches"', "Feature switches", "not scored", "LENS_LEVEL_READINGS off", "Position Manager actions"],
    hides: ["ladder lock", "past a lens B level", "No level move in the last 7 days.", "Not scored yet", "Not in this answer", ...PRE_BACKEND],
    missing: [NOT_FOUND]
  },
  // The switch on and a skip whose outcome is not known yet: the level moves listed, the skip waiting, no time invented.
  {
    name: "LiquidityViewSkipUnscored", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, SKIP_UNSCORED),
    shows: ["Not scored yet", "Each skip is scored once its outcome is known.", "ladder lock", "past a lens B level"],
    hides: ["LENS_LEVEL_READINGS", ...PRE_BACKEND]
  },
  {
    name: "LiquidityViewPendingMaker", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, LIVE_EFFECTS),
    shows: ["1 pending", "none in 7 days", "No Position Manager action on a sweep in the last 7 days.", READINGS_OFF], hides: PRE_BACKEND
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
  {
    name: "OrbView", View: orbView(), fixture: orb,
    shows: [...ORB_PANELS, "Opening range", "Intelligence · ORB agent · London and New York · 15m", ">live<", "ORB levels on", "feed scale · ATR (1H) 8.00", "window · 27 bars left", "03:00–03:45 NY", "08:00–08:45 UTC · 15:00–15:45 GMT+7", "11:45 NY",
      "1.25 ATR", "retesting", "2,605.50", "at price", "picked", "range event (high-impact USD 08:30 NY)", "not traded: an event inside the range", "held back", "−0.20R", "stop", "target before entry", "Charts by TradingView", "No strategy pick in the latest decision", "London high", "candidate"],
    hides: ["sample data", "provisional", "armed<", "No ORB setup yet", "undefined"],
    missing: [NOT_FOUND]
  },
  {
    name: "OrbViewOverlap", View: overlapView(), fixture: orbOverlap,
    shows: [...ORB_PANELS, ">armed<", "window · 7 bars left", "window · 27 bars left", "13:00–13:45 UTC · 20:00–20:45 GMT+7", "16:45 NY", "limit at the edge", "4,098.52", "4,096.68", "4,103.60", "4,107.60", "2.8", "holds the side", "▲ long</span> invalidated · no plan", "New York holds the long side",
      "Overlap 08:00–11:45 NY", "invalidated", "no ▼ breakout", "▲ up", "1 bar ago", "held", "Opening range · New York", "62%", "0.47", "0.29", ">chosen<", "under 40%", "Zone pullback", "London high", "New York low", "TP1", "lapsed in profit", "time limit", "lapsed, no fill", "+1.1R", "open", "decision 15:00 UTC · 22:00 GMT+7"],
    hides: ["sample data", "No ORB setup yet", "text-bull\">+", "text-bear\">−"]
  },
  { name: "OrbViewMismatch", View: orbView({ decision: null, candles: null }), fixture: orbMismatch, shows: ["clock mismatch (New York on summer time, London not)", "07:00–07:45 UTC · 14:00–14:45 GMT+7", "ended", "not traded: clock mismatch", "no plan: no breakout yet", "No ORB setup yet", "No session range in the latest decision"] },
  { name: "OrbViewForming", View: orbView(), fixture: ORB_FORMING, shows: ["No ORB setup yet", "London&#x27;s range is building; New York&#x27;s sets at 08:45 NY (13:45 UTC).", "building 2 of 3 bars", "no plan until the range sets at 03:45 NY", "forming"] },
  { name: "OrbViewMarketClosed", View: orbView(), fixture: ORB_CLOSED, shows: ["market closed", "Market closed", "The London range sets Monday 03:45 New York (08:45 UTC, 15:45 GMT+7)."], hides: ["window · 27 bars left"] },
  { name: "OrbViewModeOff", View: orbView(), fixture: ORB_OFF, shows: ["ORB off", "Opening range off", "Switched off by the owner: no range is read and the ORB agent makes no plan.", "ORB levels off", "Records per session"], hides: ["Ranges on the chart"] },
  { name: "OrbViewBothInvalidated", View: overlapView(), fixture: ORB_BOTH_INVALIDATED, shows: ["invalidated · no plan", "No ORB setup yet"] },
  { name: "OrbViewNoBreakout", View: overlapView(), fixture: ORB_NO_BREAKOUT, shows: ["none by 11:45 NY", "no plan: no breakout", "no plan: no breakout yet"] },
  { name: "OrbViewRangeEvent", View: overlapView(), fixture: ORB_RANGE_EVENT, shows: ["range event (high-impact USD 08:30 NY)", "not traded: an event inside the range", "Neither session holds a side yet"] },
  { name: "OrbViewTooNarrow", View: overlapView(), fixture: ORB_TOO_NARROW, shows: ["too narrow", "0.20 ATR", "not traded: the range is too narrow"] },
  { name: "OrbViewShort", View: overlapView(), fixture: ORB_SHORT, shows: ["▼ down", "New York holds the short side", "at price", "4,095.28", "holds the side"] },
  { name: "OrbViewNotArmed", View: ({ d }) => <OrbView d={orbOverlap} agents={orbOverlapAgents} decision={d} candles={orbOverlapCandles} />, fixture: merged(orbOverlapDecision, { decision: { armed: { ids: ["zone_pullback"] } } }), shows: ["not armed: plans are recorded, not traded"], hides: [">armed<"] },
  { name: "OrbViewAuto", View: ({ d }) => <OrbView d={orbOverlap} agents={orbOverlapAgents} decision={d} candles={orbOverlapCandles} />, fixture: merged(orbOverlapDecision, { decision: { armed: { mode: "auto", ids: [] } } }), shows: ["no strategy armed: the best plan of all is picked"] },
  { name: "OrbViewAgents", View: ({ d }) => <OrbView d={orb} agents={d} decision={orbDecision} candles={orbCandles} />, fixture: orbAgents, shows: [">live<"] },
  { name: "OrbViewCandles", View: ({ d }) => <OrbView d={orbOverlap} agents={orbOverlapAgents} decision={orbOverlapDecision} candles={d} />, fixture: orbOverlapCandles, shows: ["last closed bar Mon 23 Nov 15:00 UTC · 22:00 GMT+7"] },
  { name: "OrbViewStale", View: overlapView({ mark: { show: true, dim: true, suffix: " · stale 7m", note: null } }), fixture: orbOverlap, shows: ["Sessions"] },
  { name: "OrbViewIntelOff", View: orbView(), fixture: NOT_FOUND, shows: ["intel_views_off", "The Intelligence views are off on the AI Worker."] },
  { name: "OrbUnread500", View: ({ d }) => <OrbUnread poll={orbUnread(`/api/orb 500 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { status: "error", error: "orb_unavailable" }, shows: ["/api/orb 500 orb_unavailable", "Retry now"] },
  { name: "OrbUnread404", View: ({ d }) => <OrbUnread poll={orbUnread(`/api/orb 404 ${typeof d?.error === "string" ? d.error : "read failed"}`)} />, fixture: { error: "Not found" }, shows: ["/api/orb 404 Not found"] },
  { name: "LiquidityViewDecision", View: ({ d }) => <LiquidityView d={LIQUIDITY_FULL} lens={lens} decision={d} now={LIQUIDITY_NOW} />, fixture: decision, shows: ["Quorum", "WAIT"] },
  ...PM_VIEWS,
  ...F4_VIEWS,
  ...OS1_VIEWS,
  ...H3F_VIEWS,
  ...CF2_VIEWS
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
