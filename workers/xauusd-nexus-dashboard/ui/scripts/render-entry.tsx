// The page render check's registry (scripts/render-check.mjs bundles this file with esbuild as CommonJS, lightweight-charts
// aliased to scripts/lw-stub.mjs). Each entry is a pure, null-safe view with the fixture of its route: the check renders
// it with renderToStaticMarkup over the fixture, the routes' not_found bodies, each path nulled in turn and each array
// emptied, and fails on a throw, "NaN", "undefined" or "[object Object]" in the markup. A page that joins Intelligence
// (Track C) adds its view and its test/fixtures/nexus-intel/*.json here.
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import lens from "../../../../test/fixtures/nexus-intel/lens.json";
import { LensHeader, LensView } from "../src/components/LensPanel";

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

export const VIEWS: Entry[] = [
  { name: "LensView", View: LensView, fixture: lens, shows: ["Lens A · Positioning (CFTC)", "Lens B · Liquidity (broker M1)", "at floor", "fresh", "insufficient"] },
  { name: "LensHeader", View: LensHeader, fixture: lens, shows: ["Intraday mode"] }
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
