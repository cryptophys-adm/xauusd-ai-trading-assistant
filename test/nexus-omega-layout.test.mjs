// The Omega page layout. Before OM-LEAN (owner 2026-11-18, after #444) it was an MT5-terminal imitation: Market Watch
// and the symbol spec in a left column beside the chart, the toolbox below, the risk profile in Setup → Risk profile.
// OM-LEAN (owner-approved mockup 1795450033-0f25, 2026-11-23: "Setuju, bangun (Rekomendasi)") replaces the Terminal
// view with one lean screen; the intents of these tests are kept where their element still exists: the header's dynamic
// broker and DEMO/LIVE, the applied limits, the risk to the stop, the spec (now in Details), Setup's sub-tabs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx", import.meta.url), "utf8");

test("OL1 the lean layout: the header, Open & resting, the signal line, Last actions and one Details; no MT5 dock", () => {
  const order = ["function OmegaHeader(", "function OpenResting(", "function SignalLineView(", "function LastActions(", "function Details("];
  for (const f of order) assert.ok(ui.includes(f), f);
  const term = ui.slice(ui.indexOf("export function OmegaTerminal("), ui.indexOf("/** Derived values with"));
  assert.ok(term.indexOf("<OpenResting") < term.indexOf("<SignalLineView") && term.indexOf("<SignalLineView") < term.indexOf("<LastActions") && term.indexOf("<LastActions") < term.indexOf('id="omega-details-toggle"'), "the four blocks, then Details");
  assert.match(term, /\{open \? <div id="omega-details"><Details /, "Details renders only when opened");
  assert.doesNotMatch(ui, /omega-dock-toggle|lg:grid-cols-\[320px_1fr\]|Left Dock/, "no Market Watch column");
  // The spec stays under Details → Symbol and account (it was under Market Watch), the risk profile stays in Setup.
  const details = ui.slice(ui.indexOf("function Details("), ui.indexOf("export function OmegaTerminal("));
  for (const t of ["Digits / point", "Tick size / value", "Volume min / max / step", "Stops / freeze level", "Leverage / margin", "Margin per lot", "Trade mode"]) assert.ok(details.includes(`>${t}<`), t);
  assert.ok(!details.includes("OmegaProfile"), "the risk profile is not in Details");
});

test("OL2 the header: dynamic broker and demo/LIVE, the applied limits with the daily cap; one engine switch", () => {
  assert.match(ui, /const brokerLabel = account\?\.spec_status === "validated" \? brokerName : "broker unknown";/);
  assert.match(ui, /<span>\{x\.brokerLabel\}<\/span>/);
  assert.match(ui, /\{live \? <b className="font-semibold text-late">LIVE<\/b> : br\.trade_mode === "demo" \? <span className="text-fg-2">demo<\/span> : null\}/, "demo reads demo, never ARMED; every other mode LIVE");
  assert.match(ui, /risk \{pct\(x\.appliedRisk\)\} · max \{x\.appliedPositions \?\? "—"\} positions · /);
  assert.match(ui, /daily loss cap \{pct\(x\.appliedDaily\)\}\{x\.daily\.reached \? " reached" : ""\}/);
  assert.equal((ui.match(/role="switch"/g) || []).length, 1, "the header's Engine switch only (Setup keeps its form checkbox)");
  assert.doesNotMatch(ui, /Algo Trading: \{/, "the old toolbar toggle is gone");
});

test("OL3 positions: the risk to the SL in money and % of equity, or the profit a moved stop locks; no stop is said", () => {
  assert.match(ui, /<span>Risk at stop<\/span>/);
  assert.match(ui, /function riskCell\(r: Risk \| null, sl: unknown, closing: boolean\)/);
  assert.match(ui, /if \(r\.locked\) return <>locked \+\{r\.amount\.toFixed\(2\)\}<\/>;/);
  assert.match(ui, /if \(!\(Number\(sl\) > 0\)\) return <span className="text-fg-2">no stop<\/span>;/);
  assert.match(ui, /const r = riskToSl\(orderAsPosition\(o\), br\);/, "a resting order's risk on its own row");
});

test("OL4 on a phone the rows are cards with their buttons visible; Setup keeps its sub-tabs", () => {
  assert.match(ui, /data-card="position"/);
  assert.match(ui, /data-card="order"/);
  assert.match(ui, /"mono hidden min-h-\[47px\] border-t border-white\/6 px-\[16px\] text-\[12\.5px\]", GRID\)\} data-row="position"/, "the grid row from lg");
  assert.match(ui, /\[\["engine", "Engine"\], \["profile", "Risk profile"\], \["connection", "Connection & EA"\]\]/);
  assert.ok(/\{setupTab === "profile" \? \(\s*<Panel\s*title="Risk profile"/.test(ui), "Risk profile under Setup → Risk profile");
});
