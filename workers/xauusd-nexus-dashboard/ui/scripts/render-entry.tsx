// The page render check's registry (scripts/render-check.mjs bundles this file with esbuild as CommonJS, lightweight-charts
// aliased to scripts/lw-stub.mjs). Each entry is a pure, null-safe view with the fixture of its route: the check renders
// it with renderToStaticMarkup over the fixture, the routes' not_found bodies, each path nulled in turn and each array
// emptied, and fails on a throw, "NaN", "undefined" or "[object Object]" in the markup. A page that joins Intelligence
// (Track C) adds its view and its test/fixtures/nexus-intel/*.json here (C2: the Liquidity page's LiquidityView).
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import lens from "../../../../test/fixtures/nexus-intel/lens.json";
import liquidity from "../../../../test/fixtures/nexus-intel/liquidity.json";
import unavailable from "../../../../test/fixtures/nexus-intel/liquidity-unavailable.json";
import decision from "../../../../test/fixtures/nexus-intel/engine-decision.json";
import { LensHeader, LensView } from "../src/components/LensPanel";
import { LiquidityView } from "../src/pages/Liquidity";

export type Entry = {
  /** The view's name, as the check prints it. */
  name: string;
  /** A pure view of one route's body. */
  View: ComponentType<{ d: any }>;
  /** The route's body (test/fixtures/nexus-intel/*.json). */
  fixture: unknown;
  /** Text the fixture's own render must show (the view rendered its content, not its empty state). */
  shows?: string[];
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
 * The Liquidity page (Track C2) over its reads. /api/liquidity is backend B8's contract (test/fixtures/nexus-intel/
 * liquidity.json, and liquidity-unavailable.json: no recent broker bar), at launch: conditions, card,
 * quorum_with_liquidity and effects.level_moves null. LATER is the page's own stand-in for those four until backends
 * B15-B19 publish theirs (the mockup's "all backend PRs deployed" board); it is not a contract. The clock is the
 * fixture's (lens B's state 2 minutes old).
 */
export const LIQUIDITY_NOW = (liquidity as any).state.at_ms + 2 * 60_000;
export const LATER = {
  conditions: {},
  card: { at_ms: (liquidity as any).state.at_ms, weight: 0.036, lean: 0.6, sweep: "sweep_with" },
  quorum_with_liquidity: { long_share: 0.48, short_share: 0.2, neutral_share: 0.32, share_needed_above: 0.5, met: false },
  effects: { level_moves: [{ at_ms: (liquidity as any).state.at_ms - 3_600_000, side: "BUY", action: "level", outcome: "hit" }] }
};
export const LIQUIDITY_FULL = merged(liquidity, LATER);
/** /api/lens with lens B's intraday weight from Aether at 0.36: the card's weight is min(0.06, 0.036), "0.04 (0.036)". */
export const LENS_AETHER = merged(lens, { liquidity: { weights: { intraday: { weight: 0.36, source: "aether" } } } });
export const LENS_OFF = merged(lens, { switches: { liquidity_enabled: false }, liquidity: { weights: { scalp: { weight: 0, source: "switch_off" }, intraday: { weight: 0, source: "switch_off" }, swing: { weight: 0, source: "switch_off" }, range: { weight: 0, source: "switch_off" } }, facts: null, line: null } });
/**
 * The live mix of 2026-11-23 (the reviewer's 14-day D1 count after B8 went live): every effects list empty but makers,
 * one row whose outcome is "pending" (B8's outcomeOf reads anything not hit/miss/neutral, NULL included, as pending).
 */
export const LIVE_EFFECTS = { effects: { blocks: [], makers: [{ at_ms: (liquidity as any).state.at_ms - 5_400_000, side: "BUY", mode: "scalp", outcome: "pending" }], skips: [], deferrals: [], level_moves: null, pm_actions: [] } };
const PANELS = ["Positioning &amp; Liquidity analyst", "Score against the floor", "Levels on the chart", "Facts, last 24 hours", "Sweeps and outcomes", "Baseline per New York hour of the week", "What it changed in Omega", "In the latest decision"];
const HINT = "Liquidity never opens, sizes or prices an entry.";
const NOT_FOUND = { status: "not_found", reason: "intel_views_off" };

export const VIEWS: Entry[] = [
  { name: "LensView", View: LensView, fixture: lens, shows: ["Lens A · Positioning (CFTC)", "Lens B · Liquidity (broker M1)", "at floor", "fresh", "insufficient"] },
  { name: "LensHeader", View: LensHeader, fixture: lens, shows: ["Intraday mode"] },
  {
    name: "LiquidityView", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: liquidity,
    shows: [...PANELS, HINT, "lens B on", "No LIQUIDITY card yet", "Fills after backend B15 is deployed.", "Fills after backend B19 is deployed.", "Scored after backend B19 is deployed.", "Position Manager actions", "baseline insufficient · 2 of 4 weeks", "backfill done"],
    missing: [NOT_FOUND]
  },
  {
    name: "LiquidityViewUnavailable", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: unavailable,
    shows: [...PANELS, HINT, "lens B off", "No recent broker bars", "No levels yet", "No sweep yet"],
    missing: [NOT_FOUND]
  },
  {
    name: "LiquidityViewLater", View: ({ d }) => <LiquidityView d={d} lens={LENS_AETHER} decision={decision} now={LIQUIDITY_NOW} />, fixture: LIQUIDITY_FULL,
    shows: [...PANELS, HINT, "LIQUIDITY", "0.04", "(0.036)", "Quorum with liquidity", "Level moves"],
    missing: [NOT_FOUND]
  },
  {
    name: "LiquidityViewPendingMaker", View: ({ d }) => <LiquidityView d={d} lens={lens} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, LIVE_EFFECTS),
    shows: ["1 pending", "none in 7 days", "No Position Manager action on a sweep in the last 7 days.", "Fills after backend B19 is deployed."]
  },
  { name: "LiquidityViewLensOff", View: ({ d }) => <LiquidityView d={d} lens={LENS_OFF} decision={decision} now={LIQUIDITY_NOW} />, fixture: merged(liquidity, { state: { on: false } }), shows: ["lens B off", "Omega ignores these levels (lens B off)", "Switched off by the owner."] },
  { name: "LiquidityViewLens", View: ({ d }) => <LiquidityView d={liquidity} lens={d} decision={decision} now={LIQUIDITY_NOW} />, fixture: lens, shows: ["Lens B · Liquidity (broker M1)", "Score against the floor"] },
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
