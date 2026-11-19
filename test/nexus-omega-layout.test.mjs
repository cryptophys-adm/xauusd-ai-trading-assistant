// The Omega page layout (owner 2026-11-18, after #444: "saya lebih suka tampilan sebelumnya dengan market watch di
// sebelah kiri chart. yang saya minta hanya risk profile yang jangan ditempatkan di bawah market watch"; then
// "header lama, spec tetap di bawah market watch"). The MT5-terminal layout: the old header, Market Watch and the
// symbol spec in a left column beside the chart, the toolbox below. The risk profile lives in Setup → Risk profile.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx", import.meta.url), "utf8");

test("OL1 the MT5 layout: Market Watch and the spec in a left column beside the chart; the old header", () => {
  assert.match(ui, /grid grid-cols-1 lg:grid-cols-\[320px_1fr\]/, "left column beside the chart");
  const dock = ui.slice(ui.indexOf("{/* Left Dock: Market Watch + Contract Spec + Navigator */}"), ui.indexOf("{/* Center / Right MT5 Interactive Candlestick Chart"));
  assert.ok(dock.includes("Symbol Contract Specification") && dock.includes("Navigator"), "the spec and the Navigator stay under Market Watch");
  assert.ok(!dock.includes("OmegaProfile"), "the risk profile is not under Market Watch");
  assert.match(ui, /\{\/\* Top Status Banner \*\/\}/, "the old header");
  assert.ok(!ui.includes('id="omega-status-strip"'), "no replacement strip");
});

test("OL2 the header: dynamic broker and DEMO/LIVE, the profile with the applied risk; algo shown once", () => {
  assert.match(ui, /const brokerLabel = account\?\.spec_status === "validated" \? brokerName : "broker unknown";/);
  assert.match(ui, /\{brokerLabel\} · \{tradeTag\} · \{br\.symbol \|\| "—"\}/);
  assert.match(ui, /\{account\.profile_label\} · \{appliedRisk \?\? "—"\}%/);
  assert.equal((ui.match(/Algo Trading: \{/g) || []).length, 1, "the toolbar toggle only");
});

test("OL3 positions: the risk to the SL in money and % of equity, or the profit a moved stop locks", () => {
  assert.match(ui, /<th[^>]*>Risk @ SL<\/th>/);
  assert.match(ui, /function riskToSl\(p: any, br: any\)/);
  assert.match(ui, /locked \+\{money\(r\.amount, cur\)/);
  assert.match(ui, /SL −\{money\(r\.amount, cur\)[^}]*\} · \{r\.pct\}%/);
});

test("OL4 on a phone the Market Watch column folds above the chart; Setup keeps its sub-tabs", () => {
  assert.match(ui, /id="omega-dock-toggle"/);
  assert.match(ui, /\$\{dockOpen \? "flex" : "hidden"\} flex-col [^`]*lg:flex/);
  assert.match(ui, /\[\["engine", "Engine"\], \["profile", "Risk profile"\], \["connection", "Connection & EA"\]\]/);
  assert.ok(/\{setupTab === "profile" \? \(\s*<Panel\s*title="Risk profile"/.test(ui), "Risk profile under Setup → Risk profile");
});
