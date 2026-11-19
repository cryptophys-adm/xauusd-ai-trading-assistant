// Broker labels follow the connected broker (orchestrator relay, owner 2026-11-18: "label notif alert juga cek ulang
// harus dinamis sesuai dengan brokernya"; the line "Omega Order Executed (Monex)" was hard-coded while the account was
// FxPro). A broker name may appear only in comments (since 2026-11-19 there are no broker presets).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { brokerLabel } from "../src/account-spec.mjs";

const BROKERS = /\b(monex|mifx|fxpro|efxpro|dupoin|valetax|exness)\b/i;
const codeLines = (text) => text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => {
  const t = l.trim();
  return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
});

test("BL1 brokerLabel: the broker the terminal reports (company, else server) once validated, DEMO/LIVE, the broker's symbol; else broker unknown", () => {
  // No list of brokers: any company and any server name, as the terminal reports them (owner 2026-11-19, universal).
  const ex = { server: "AnyBroker-Live3", account: { trade_mode: "demo", company: "Any Broker Markets Ltd" }, symbol: { name: "Au.spot" } };
  assert.equal(brokerLabel(ex, { validated: true }), "Any Broker Markets Ltd (DEMO) · Au.spot");
  assert.equal(brokerLabel({ ...ex, account: { trade_mode: "real" } }, { validated: true }), "AnyBroker-Live3 (LIVE) · Au.spot", "an EA before 1.19 reports no company: the server name as reported");
  assert.equal(brokerLabel(ex, { validated: false }), "broker unknown (DEMO) · Au.spot", "a spec not validated names no broker");
  assert.equal(brokerLabel(null), "broker unknown (?)");
});

test("BL2 no broker name in the server's code outside comments (notifications, events, alerts)", () => {
  const dirs = ["../src/", "../workers/xauusd-omega/src/"];
  const hits = [];
  for (const d of dirs) {
    const root = new URL(d, import.meta.url);
    for (const f of readdirSync(root).filter((x) => /\.(mjs|ts|js)$/.test(x))) {
      for (const [n, l] of codeLines(readFileSync(new URL(f, root), "utf8"))) if (BROKERS.test(l)) hits.push(`${d}${f}:${n}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("BL3 the Omega pages name no broker and offer no broker presets (owner 2026-11-19, universal)", () => {
  const dir = new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url);
  const hits = [];
  for (const f of ["pages/Omega.tsx", "pages/Performance.tsx", "components/ExitConfirmModal.tsx"]) {
    for (const [n, l] of codeLines(readFileSync(new URL(f, dir), "utf8"))) if (BROKERS.test(l) || /XAUUSD\.m\b/.test(l)) hits.push(`${f}:${n}`);
  }
  assert.deepEqual(hits, []);
  const ui = readFileSync(new URL("pages/Omega.tsx", dir), "utf8");
  assert.doesNotMatch(ui, /BROKER_PRESETS|BrokerKey|detectBrokerFromServer/);
  assert.match(ui, /const \[bServer, setBServer\] = useState\(""\)/);
  assert.match(ui, /units_per_usd: units/, "the owner's units per US dollar go with the connection");
});

test("BL4 every Omega Telegram line carries the label", () => {
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  for (const head of ["Omega Order Executed", "Omega Position", "Extended TP Expanded (Runner)", "Omega Intent Rejected"]) {
    assert.ok(new RegExp(`${head.replace(/[()]/g, "\\$&")}[^<]*· \\$\\{label\\}</b>`).test(src), head);
  }
});
