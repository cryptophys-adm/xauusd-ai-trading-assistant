// The Omega page layout (owner 2026-11-18: "Asses ulang UI/UX di halaman omega agar lebih user friendly", "setuju,
// lanjutkan rebuild UI omega"): one status strip, Monitor first (the chart at a fixed height), Setup in sub-tabs, and
// the broker named from the connected server only once its spec is validated.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx", import.meta.url), "utf8");

test("OL1 one status strip; the old banner and the Windows title bar are gone", () => {
  assert.match(ui, /id="omega-status-strip"/);
  assert.ok(!ui.includes("Top Status Banner"), "no second status panel");
  assert.ok(!ui.includes("Windows MT5 Application Title Bar"), "no title bar repeating the server");
  assert.ok(!ui.includes("Right Quick Account Readout"), "equity and the day's P&L live in the strip");
});

test("OL2 the broker label is dynamic: from the server, 'broker unknown' until the spec is validated", () => {
  assert.match(ui, /const brokerLabel = br\.server && account\?\.spec_status === "validated"/);
  assert.match(ui, /: "broker unknown";/);
  assert.match(ui, /tradeTag = br\.trade_mode === "real" \? "LIVE" : br\.trade_mode === "demo" \? "DEMO"/);
});

test("OL3 Monitor: the chart is full width at a fixed height (320 px on a phone); the spec dock moved to Setup", () => {
  assert.match(ui, /<div className="flex h-\[320px\] flex-col sm:h-\[460px\]">\s*<Mt5ChartCanvas/);
  assert.ok(!ui.includes("lg:grid-cols-[320px_1fr]"), "no left dock beside the chart");
});

test("OL4 Setup has the sub-tabs Engine, Risk profile, Connection & EA; each panel sits under its tab", () => {
  assert.match(ui, /\[\["engine", "Engine"\], \["profile", "Risk profile"\], \["connection", "Connection & EA"\]\]/);
  for (const [tab, title] of [["engine", "Broker engine"], ["profile", "Risk profile"], ["connection", "Broker connection"], ["connection", "Bridge & terminal"]]) {
    assert.ok(new RegExp(`\\{setupTab === "${tab}" \\? \\(\\s*<Panel\\s*title="${title}"`).test(ui), `${title} under ${tab}`);
  }
});
